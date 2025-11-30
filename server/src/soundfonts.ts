/**
 * Soundfont loader for Node.js
 * Adapted from @strudel/soundfonts/fontloader.mjs to work with superdough directly
 * This avoids the ESM/CJS compatibility issues with sfumato
 */

import { noteToMidi, freqToMidi, getSoundIndex } from '@strudel/core';
import {
  getAudioContext,
  registerSound,
  getParamADSR,
  getADSRValues,
  getPitchEnvelope,
  getVibratoOscillator,
} from 'superdough';

// Import the GM instrument definitions
import gm from '@strudel/soundfonts/gm.mjs';

const defaultSoundfontUrl = 'https://felixroos.github.io/webaudiofontdata/sound';
let soundfontUrl = defaultSoundfontUrl;

export function setSoundfontUrl(value: string): void {
  soundfontUrl = value;
}

// Cache for loaded fonts
const loadCache: Record<string, Promise<any[]>> = {};

async function loadFont(name: string): Promise<any[]> {
  const cached = loadCache[name];
  if (cached) {
    return cached;
  }
  const load = async () => {
    const url = `${soundfontUrl}/${name}.js`;
    const response = await fetch(url);
    const preset = await response.text();
    // The font files are in format: var _tone_XXXXX = { zones: [...] }
    // We need to extract the object data
    const [, data] = preset.split('={');
    if (!data) {
      throw new Error(`Invalid soundfont format for ${name}`);
    }
    // Use Function constructor instead of eval for slightly better safety
    const fontData = new Function(`return {${data}`)();
    // Return the zones array from the font data
    return fontData.zones || fontData;
  };
  loadCache[name] = load();
  return loadCache[name];
}

// Cache for audio buffers
const bufferCache: Record<string, Promise<{ buffer: AudioBuffer; zone: any }>> = {};

function findZone(preset: any[], pitch: number): any | undefined {
  return preset.find((zone) => {
    return zone.keyRangeLow <= pitch && zone.keyRangeHigh + 1 >= pitch;
  });
}

// Decode base64 audio data to AudioBuffer
async function getBuffer(zone: any, audioContext: AudioContext): Promise<AudioBuffer | undefined> {
  if (zone.sample) {
    console.warn('zone.sample untested!');
    const decoded = atob(zone.sample);
    const buffer = audioContext.createBuffer(1, decoded.length / 2, zone.sampleRate);
    const float32Array = buffer.getChannelData(0);
    let b1: number, b2: number, n: number;
    for (let i = 0; i < decoded.length / 2; i++) {
      b1 = decoded.charCodeAt(i * 2);
      b2 = decoded.charCodeAt(i * 2 + 1);
      if (b1 < 0) b1 = 256 + b1;
      if (b2 < 0) b2 = 256 + b2;
      n = b2 * 256 + b1;
      if (n >= 65536 / 2) n = n - 65536;
      float32Array[i] = n / 65536.0;
    }
    return buffer;
  } else if (zone.file) {
    const datalen = zone.file.length;
    const arraybuffer = new ArrayBuffer(datalen);
    const view = new Uint8Array(arraybuffer);
    const decoded = atob(zone.file);
    for (let i = 0; i < decoded.length; i++) {
      view[i] = decoded.charCodeAt(i);
    }
    return new Promise((resolve) => audioContext.decodeAudioData(arraybuffer, resolve));
  }
  return undefined;
}

async function getFontPitch(name: string, pitch: number, ac: AudioContext): Promise<{ buffer: AudioBuffer; zone: any }> {
  const key = `${name}:::${pitch}`;
  const cached = bufferCache[key];
  if (cached) {
    return cached;
  }
  
  const load = async () => {
    const preset = await loadFont(name);
    if (!preset) {
      throw new Error(`Could not load soundfont ${name}`);
    }
    const zone = findZone(preset, pitch);
    if (!zone) {
      throw new Error(`No soundfont zone found for preset ${name}, pitch ${pitch}`);
    }
    const buffer = await getBuffer(zone, ac);
    if (!buffer) {
      throw new Error(`No soundfont buffer found for preset ${name}, pitch: ${pitch}`);
    }
    return { buffer, zone };
  };
  
  bufferCache[key] = load();
  return bufferCache[key];
}

async function getFontBufferSource(name: string, value: any, ac: AudioContext): Promise<AudioBufferSourceNode> {
  let { note = 'c3', freq } = value;
  let midi: number;
  
  if (freq) {
    midi = freqToMidi(freq);
  } else if (typeof note === 'string') {
    midi = noteToMidi(note);
  } else if (typeof note === 'number') {
    midi = note;
  } else {
    throw new Error(`unexpected "note" type "${typeof note}"`);
  }

  const { buffer, zone } = await getFontPitch(name, midi, ac);
  const src = ac.createBufferSource();
  src.buffer = buffer;
  
  const baseDetune = zone.originalPitch - 100.0 * zone.coarseTune - zone.fineTune;
  const playbackRate = 1.0 * Math.pow(2, (100.0 * midi - baseDetune) / 1200.0);
  src.playbackRate.value = playbackRate;
  
  const loop = zone.loopStart > 1 && zone.loopStart < zone.loopEnd;
  if (loop) {
    src.loop = true;
    src.loopStart = zone.loopStart / zone.sampleRate;
    src.loopEnd = zone.loopEnd / zone.sampleRate;
  }
  
  return src;
}

/**
 * Register all GM soundfont instruments with superdough
 * This makes instruments like gm_piano, gm_violin, etc. available
 */
export function registerSoundfonts(): void {
  // gm is imported as default export from the ESM module
  const gmInstruments = gm as unknown as Record<string, string[]>;
  
  Object.entries(gmInstruments).forEach(([name, fonts]) => {
    registerSound(
      name,
      async (time: number, value: any, onended: () => void) => {
        const [attack, decay, sustain, release] = getADSRValues([
          value.attack,
          value.decay,
          value.sustain,
          value.release,
        ]);

        const { duration } = value;
        const n = getSoundIndex(value.n, fonts.length);
        const font = fonts[n];
        const ctx = getAudioContext();
        
        try {
          const bufferSource = await getFontBufferSource(font, value, ctx);
          bufferSource.start(time);
          
          const envGain = ctx.createGain();
          const node = bufferSource.connect(envGain);
          const holdEnd = time + duration;
          
          getParamADSR((node as any).gain, attack, decay, sustain, release, 0, 0.3, time, holdEnd, 'linear');
          const envEnd = holdEnd + release + 0.01;

          // vibrato
          const vibratoOscillator = getVibratoOscillator(bufferSource.detune, value, time);
          // pitch envelope
          getPitchEnvelope(bufferSource.detune, value, time, holdEnd);

          bufferSource.stop(envEnd);
          
          const stop = (_releaseTime: number) => {};
          
          bufferSource.onended = () => {
            bufferSource.disconnect();
            vibratoOscillator?.stop();
            (node as any).disconnect();
            onended();
          };
          
          return { node: envGain, stop };
        } catch (err) {
          console.warn(`[soundfonts] Failed to play ${name}: ${err instanceof Error ? err.message : err}`);
          onended();
          return { node: undefined, stop: () => {} };
        }
      },
      { type: 'soundfont', prebake: true, fonts },
    );
  });
  
  console.log(`[soundfonts] Registered ${Object.keys(gmInstruments).length} GM instruments`);
}

/**
 * Get the list of available soundfont instrument names
 */
export function getSoundfontNames(): string[] {
  const gmInstruments = gm as unknown as Record<string, string[]>;
  return Object.keys(gmInstruments);
}
