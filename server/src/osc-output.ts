// @ts-ignore - osc has no type definitions
import osc from 'osc';
import { isNote, noteToMidi, midiToFreq } from '@strudel/core/util.mjs';
import { processValueForOsc, isBankSoundfont } from './sample-metadata.js';
import { resolveDrumMachineBankSync, isGmSoundfont, getSoundfontCacheName } from './on-demand-loader.js';
import { captureOscMessage, shouldCaptureOsc } from './file-writer.js';

// Default SuperDirt ports
const OSC_REMOTE_IP = '127.0.0.1';
const OSC_REMOTE_PORT = 57120;

let udpPort: any = null;
let isOpen = false;

// Envelope curve for amplitude ADSR: 0 = linear (better for testing), -2 = exponential (default, better quality)
// Linear (0) matches superdough's WebAudio ramps exactly for comparison testing
// Exponential (-2) sounds more natural and is StrudelDirt's default
let envelopeCurve = -2;

// Clock synchronization
// AudioContext time starts at 0 when created, we need to map it to Unix/NTP time
let audioContextStartTime: number | null = null; // Unix time when AudioContext was created

/**
 * Set the AudioContext start time for clock synchronization
 * Call this once when the AudioContext is created
 */
export function setAudioContextStartTime(unixTimeSeconds: number): void {
  audioContextStartTime = unixTimeSeconds;
  console.log(`[osc] AudioContext start time set: ${unixTimeSeconds.toFixed(3)}`);
}

/**
 * Convert AudioContext time to Unix time in seconds
 */
function audioTimeToUnixTime(audioTime: number): number {
  if (audioContextStartTime === null) {
    // Fallback: assume AudioContext just started
    audioContextStartTime = Date.now() / 1000;
    console.warn('[osc] AudioContext start time not set, using fallback');
  }
  return audioContextStartTime + audioTime;
}

export interface OscConfig {
  remoteIp?: string;
  remotePort?: number;
  /** Envelope curve: 0 = linear (for testing), -2 = exponential (default) */
  envelopeCurve?: number;
}

/**
 * Initialize the OSC UDP port for sending messages to SuperDirt
 */
export function initOsc(config: OscConfig = {}): Promise<void> {
  const remoteIp = config.remoteIp ?? OSC_REMOTE_IP;
  const remotePort = config.remotePort ?? OSC_REMOTE_PORT;
  
  // Set envelope curve if provided
  if (config.envelopeCurve !== undefined) {
    envelopeCurve = config.envelopeCurve;
  }
  
  return new Promise((resolve, reject) => {
    if (udpPort && isOpen) {
      console.log('[osc] Already connected');
      resolve();
      return;
    }

    udpPort = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: 0, // Let the OS assign a port
      remoteAddress: remoteIp,
      remotePort: remotePort,
    });

    udpPort.on('ready', () => {
      isOpen = true;
      console.log(`[osc] Connected - sending to ${remoteIp}:${remotePort}`);
      resolve();
    });

    udpPort.on('error', (e: Error) => {
      console.error('[osc] Error:', e.message);
      reject(e);
    });

    udpPort.on('close', () => {
      isOpen = false;
      console.log('[osc] Connection closed');
    });

    udpPort.open();
  });
}

/**
 * Close the OSC connection
 */
export function closeOsc(): void {
  if (udpPort) {
    udpPort.close();
    udpPort = null;
    isOpen = false;
  }
}

/**
 * Check if OSC is connected
 */
export function isOscConnected(): boolean {
  return isOpen;
}

/**
 * Per-synth gain compensation factors for StrudelDirt synths
 * 
 * StrudelDirt synths have:
 * 1. synthGain = 0.27 applied to all synths
 * 2. Per-synth extra factors (pulse has 0.8, noise has 0.5, supersaw has 1.24)
 * 3. Different oscillator implementations (SawDPW vs WebAudio's native)
 * 
 * These compensation values are empirically tuned based on compare-backends.mjs
 * measurements to achieve <1dB RMS difference from WebAudio output.
 * 
 * The compensation is applied BEFORE the gain^2 curve inversion.
 */
const strudelDirtSynthGainCompensation: Record<string, number> = {
  // Basic waveforms - base compensation 1/0.27 ≈ 3.7
  // Adjusted based on compare-backends.mjs measurements
  'sine': 1 / 0.27 / 1.05,        // Was +0.4dB loud, reduce by 1.05
  'sin': 1 / 0.27 / 1.05,
  'triangle': 1 / 0.27 / 1.05,    // Was +0.4dB loud, reduce by 1.05
  'tri': 1 / 0.27 / 1.05,
  'sawtooth': 1 / 0.27 * 1.93,    // Was -5.7dB quiet, boost by 10^(5.7/20)
  'saw': 1 / 0.27 * 1.93,
  
  // Pulse synth: has extra 0.8 factor in SynthDef (0.27 * 0.8 = 0.216)
  // So base compensation is 1/0.216 ≈ 4.63
  // But square was -7.5dB quiet with 1/0.27, need more boost
  'square': 1 / 0.216 * 1.50,     // Was -7.5dB with 1/0.27, adjusted for 0.216 base + extra
  'sqr': 1 / 0.216 * 1.50,
  'pulse': 1 / 0.216 / 1.16,      // Was +1.3dB loud, reduce by 1.16
  
  // Noise: has extra 0.5 factor in SynthDef (0.27 * 0.5 = 0.135)
  // Base compensation is 1/0.135 ≈ 7.41
  'white': 1 / 0.135,
  'pink': 1 / 0.135,
  'brown': 1 / 0.135,
  
  // Supersaw: has extra 1.24 factor (0.27 * 1.24 = 0.335)
  // Base compensation is 1/0.335 ≈ 2.99
  // Was -3.6dB quiet, need boost by 10^(3.6/20) ≈ 1.51
  'supersaw': 1 / 0.335 * 1.51,
  
  // Superpulse: same as base (0.27)
  'superpulse': 1 / 0.27,
  
  // sbd/sbd2: has 0.3 factor directly, no synthGain
  'sbd': 1 / 0.3,
  'sbd2': 1 / 0.3,
};

/**
 * Get the gain compensation factor for a StrudelDirt synth
 * Returns 1.0 for non-synth sounds (samples)
 */
function getStrudelDirtSynthGainCompensation(soundName: string): number {
  return strudelDirtSynthGainCompensation[soundName] ?? 1.0;
}

/**
 * Get the OSC UDP port for sending additional messages (e.g., sample loading)
 */
export function getOscPort(): any {
  return udpPort;
}

/** Stop all active native SuperCollider voices without touching WebAudio. */
export function sendHushToSuperDirt(): void {
  if (!udpPort || !isOpen) return;
  udpPort.send({ address: '/strudel/hush', args: [] });
}

/**
 * Convert superdough-style gain to StrudelDirt gain
 * 
 * superdough uses linear gain (default varies by sound type)
 * 
 * StrudelDirt's dirt_gate applies: gain = StrudelUtils.gainCurve(gain) = gain^2
 * 
 * To match volumes, we invert the gain^2 curve: gain = L^0.5
 * Per-synth compensation is applied separately via getStrudelDirtSynthGainCompensation()
 */
function convertGainForSuperDirt(superdoughGain: number): number {
  // Invert StrudelDirt's gain^2 curve: gain = targetLevel^0.5
  return Math.pow(superdoughGain, 0.5);
}

/**
 * Calculate ADSR values matching superdough's getADSRValues behavior
 * Returns [attack, decay, sustain, release] with proper defaults
 * 
 * @param attack - Attack time in seconds
 * @param decay - Decay time in seconds
 * @param sustain - Sustain level (0-1)
 * @param release - Release time in seconds
 * @param defaultValues - Default values if no params specified [attack, decay, sustain, release]
 */
function getADSRValues(
  attack?: number,
  decay?: number, 
  sustain?: number,
  release?: number,
  defaultValues: [number, number, number, number] = [0.001, 0.001, 1, 0.01]
): [number, number, number, number] {
  const envmin = 0.001;
  const releaseMin = 0.01;
  const envmax = 1;
  
  // If no params set, return defaults
  if (attack == null && decay == null && sustain == null && release == null) {
    return defaultValues;
  }
  
  // Calculate sustain level based on which params are set
  // (matching superdough's behavior)
  let sustainLevel: number;
  if (sustain != null) {
    sustainLevel = sustain;
  } else if ((attack != null && decay == null) || (attack == null && decay == null)) {
    sustainLevel = envmax;
  } else {
    sustainLevel = envmin;
  }
  
  return [
    Math.max(attack ?? 0, envmin),
    Math.max(decay ?? 0, envmin),
    Math.min(sustainLevel, envmax),
    Math.max(release ?? 0, releaseMin)
  ];
}

/**
 * Convert a hap value to SuperDirt OSC message arguments
 * Based on @strudel/osc's parseControlsFromHap
 */
const tremoloShapeIndices: Record<string, number> = {
  tri: 0,
  sine: 1,
  ramp: 2,
  saw: 3,
  square: 4,
};

function wrapUnitPhase(value: number): number {
  return ((value % 1) + 1) % 1;
}

export function hapToOscArgs(hap: any, cps: number): any[] {
  const rawValue = hap.value || {};
  const begin = hap.wholeOrPart?.()?.begin?.valueOf?.() ?? 0;
  const duration = hap.duration?.valueOf?.() ?? 1;
  const delta = duration / cps;

  // Handle soundfont variants: s("gm_piano:11") sets n=11 which selects the variant
  // We need to rewrite to s=gm_piano_v11 before processValueForOsc modifies n
  let valueToProcess = rawValue;
  const rawSoundName = rawValue.s || rawValue.sound;
  if (rawSoundName && isGmSoundfont(rawSoundName) && typeof rawValue.n === 'number' && rawValue.n > 0) {
    // Rewrite sound name to include variant, clear n so it's set by pitch
    const cacheName = getSoundfontCacheName(rawSoundName, rawValue.n);
    valueToProcess = { ...rawValue, s: cacheName };
    delete valueToProcess.n;  // Let processValueForOsc set n based on pitch
  }

  // Process the value for pitched samples (converts note/freq to n + speed)
  const processedValue = processValueForOsc(valueToProcess);

  // Start with processed values, then apply defaults for missing fields
  const controls: Record<string, any> = {
    ...processedValue,
    cps,
    cycle: begin,
    delta,
  };
  
  // Convert gain to match superdough volume levels
  // superdough default is 0.8, pattern can override
  // Note: soundfont gain compensation (0.3 factor) is applied later for soundfonts
  let superdoughGain = controls.gain ?? 0.8;
  controls.gain = superdoughGain; // Store raw gain, convert later after soundfont check
  
  // Ensure 'n' defaults to 0 if not specified (first sample in bank)
  if (controls.n === undefined) {
    controls.n = 0;
  }
  
  // Ensure 'speed' defaults to 1 if not specified
  if (controls.speed === undefined) {
    controls.speed = 1;
  }
  
  // Ensure 'orbit' defaults to 0 if not specified (required by SuperDirt)
  if (controls.orbit === undefined) {
    controls.orbit = 0;
  }
  
  // Set amp to 1 to match superdough's gain behavior
  // SuperDirt's default amp is 0.4 (for headroom), but superdough applies gain linearly
  // without this reduction. Setting amp=1 ensures our gain conversion produces matching levels.
  if (controls.amp === undefined) {
    controls.amp = 1;
  }

  // Handle bank prefix - maps Strudel bank aliases to full SuperDirt bank names
  // e.g., bank="tr909" + s="bd" -> s="RolandTR909_bd"
  if (controls.bank && controls.s) {
    const bankAlias = String(controls.bank);
    const sound = String(controls.s);

    // Try to resolve drum machine alias (tr909 -> RolandTR909)
    const fullBankName = resolveDrumMachineBankSync(bankAlias);

    if (!fullBankName) {
      // Unknown bank alias - warn and use sound as-is
      console.warn(`[osc] Unknown bank "${bankAlias}" - valid banks include: TR808, TR909, Linn, DMX, etc. Using sound "${sound}" without bank prefix.`);
    } else if (sound.startsWith(bankAlias + '_')) {
      // Strudel already prefixed with alias (e.g., s="tr909_sd" with bank="tr909")
      // Replace alias prefix with full bank name: tr909_sd -> RolandTR909_sd
      controls.s = fullBankName + '_' + sound.slice(bankAlias.length + 1);
    } else if (sound.startsWith(fullBankName + '_')) {
      // Already has full bank prefix (e.g., s="RolandTR909_bd" with bank="RolandTR909")
      // Keep as-is
    } else {
      // Sound doesn't have bank prefix, add it
      controls.s = `${fullBankName}_${sound}`;
    }
    delete controls.bank; // Don't send bank to SuperDirt
  }

  // Handle roomsize -> size alias
  if (controls.roomsize) {
    controls.size = controls.roomsize;
  }

  // Handle speed adjustment for unit=c
  if (controls.unit === 'c' && controls.speed != null) {
    controls.speed = controls.speed / cps;
  }
  
  // Handle tremolo parameter mapping. Strudel accepts symbolic LFO shapes,
  // while SynthDef controls must be numeric. superdough also phase-locks the
  // LFO to cycle time; preserve that instead of restarting phase at every hap.
  const tremoloSync = controls.tremolosync;
  if (tremoloSync != null) {
    controls.strudelTremRate = Number(tremoloSync) * cps;
    delete controls.tremolosync;
  } else if (controls.tremolo != null) {
    controls.strudelTremRate = Number(controls.tremolo);
    delete controls.tremolo;
  }

  if (controls.strudelTremRate != null && controls.tremolodepth == null) {
    controls.strudelTremDepth = 1;
  } else if (controls.tremolodepth != null) {
    controls.strudelTremDepth = controls.tremolodepth;
    delete controls.tremolodepth;
  }

  if (controls.tremoloskew != null) {
    controls.strudelTremSkew = controls.tremoloskew;
    delete controls.tremoloskew;
  } else if (controls.strudelTremRate != null) {
    controls.strudelTremSkew = controls.tremoloshape != null ? 0.5 : 1;
  }

  if (controls.tremoloshape != null) {
    const rawShape = controls.tremoloshape;
    if (typeof rawShape === 'string') {
      const shape = tremoloShapeIndices[rawShape.toLowerCase()];
      if (shape === undefined) {
        throw new Error(`Unknown tremolo shape "${rawShape}"`);
      }
      controls.strudelTremShape = shape;
    } else {
      controls.strudelTremShape = Math.max(0, Math.min(4, Math.floor(Number(rawShape))));
    }
    delete controls.tremoloshape;
  }

  if (controls.strudelTremRate != null) {
    const explicitPhase = Number(controls.tremolophase ?? 0);
    const cycleTimeSeconds = begin / cps;
    controls.strudelTremPhase = wrapUnitPhase(
      cycleTimeSeconds * Number(controls.strudelTremRate) + explicitPhase,
    );
  }
  delete controls.tremolophase;
  
  // Delete any remaining tremolorate that might conflict with SuperDirt's module
  if (controls.tremolorate != null) {
    delete controls.tremolorate;
  }
  
  // Handle phaser parameter mapping
  // Strudel uses: phaserrate, phaserdepth
  // SuperDirt uses the same names, so no translation needed
  
  // Handle delay wet/send level mapping
  // SuperDirt's CombL delay reads the full dry signal and multiplies output by delayAmp
  // WebAudio sends signal*delay to the delay, so the wet level is pre-applied
  // The CombL approach causes more energy accumulation with feedback
  // Empirically, SC's delay output is about 12dB louder, so we reduce the send
  if (controls.delay != null) {
    controls.delay = controls.delay * 0.25;  // -12dB adjustment to match WebAudio
  }
  
  // Handle delay feedback mapping
  // SuperDirt's CombL uses decay time: decayTime = log2(-60dB) / log2(feedback) * delayTime
  // This accumulates more energy than WebAudio's simple feedback multiplier
  // Empirical adjustment: feedback^2.0 reduces SC's buildup to match WebAudio
  if (controls.delayfeedback != null) {
    const feedback = Math.min(Math.abs(controls.delayfeedback), 0.995);
    controls.delayfeedback = Math.pow(feedback, 2.0);
  }
  
  // Handle convolution reverb (ir parameter)
  // When ir is specified, we use our strudel_convrev module instead of SuperDirt's dirt_reverb
  // ir: sample name to use as impulse response
  // irspeed: playback speed of IR (default 1)
  // irbegin: start offset into IR (0-1, default 0)
  if (controls.ir != null) {
    controls.strudelIR = controls.ir;
    delete controls.ir;
    
    if (controls.irspeed != null) {
      controls.strudelIRSpeed = controls.irspeed;
      delete controls.irspeed;
    }
    
    if (controls.irbegin != null) {
      controls.strudelIRBegin = controls.irbegin;
      delete controls.irbegin;
    }
  }

  
  // Handle synth sounds (oscillators)
  // StrudelDirt provides these synths directly - no strudel_* prefix needed
  // For our custom synths (zzfx, bytebeat), we still use strudel_* prefix
  const synthSoundMap: Record<string, string> = {
    // Basic waveforms - StrudelDirt provides these directly
    'sine': 'sine',
    'sin': 'sine',            // alias
    'sawtooth': 'sawtooth',
    'saw': 'sawtooth',        // alias (StrudelDirt uses 'sawtooth')
    'square': 'pulse',        // StrudelDirt uses pulse with width=0.5 for square
    'sqr': 'pulse',           // alias
    'triangle': 'triangle',
    'tri': 'triangle',        // alias (StrudelDirt uses 'triangle')
    // Noise types - StrudelDirt provides these
    'white': 'white',
    'pink': 'pink',
    'brown': 'brown',
    // Extended synths - StrudelDirt provides these
    'pulse': 'pulse',         // pulse wave with PWM (z1=width, z2=modspeed, z3=moddepth)
    'supersaw': 'supersaw',   // unison detuned saws (uses supersaw1-10 internally)
    'superpulse': 'superpulse', // unison detuned pulses
    'sbd': 'sbd2',            // synthesized bass drum (StrudelDirt uses sbd2)
    'sbd2': 'sbd2',           // direct alias
    // ZZFX chip sounds - our custom synth (not in StrudelDirt)
    'zzfx': 'strudel_zzfx',
    'z_sine': 'strudel_zzfx',
    'z_sawtooth': 'strudel_zzfx',
    'z_triangle': 'strudel_zzfx',
    'z_square': 'strudel_zzfx',
    'z_tan': 'strudel_zzfx',
    'z_noise': 'strudel_zzfx',
    // ByteBeat - our custom synth (not in StrudelDirt)
    'bytebeat': 'strudel_bytebeat',
  };
  
  // ZZFX shape mapping: sound name -> zshape value (0-4)
  // Matches superdough's wave shapes: 0=sin, 1=tri, 2=saw, 3=tan, 4=noise
  const zzfxShapeMap: Record<string, number> = {
    'zzfx': 0,        // default to sine
    'z_sine': 0,
    'z_triangle': 1,
    'z_sawtooth': 2,
    'z_square': 2,    // ZZFX doesn't have square, use saw with shapeCurve=0
    'z_tan': 3,
    'z_noise': 4,
  };
  
  const soundName = controls.s || controls.sound;
  const synthInstrument = soundName ? synthSoundMap[soundName] : undefined;
  
  if (synthInstrument) {
    // For synth sounds, we need to tell SuperDirt to use our SynthDef
    // Setting 'instrument' explicitly tells SuperDirt which SynthDef to use
    // We also set 's' to the synth name for compatibility
    controls.s = synthInstrument;
    controls.instrument = synthInstrument;  // Explicitly set instrument
    delete controls.sound; // Remove alias if present
    
    // Synth sounds use freq instead of sample playback
    // If note is specified, convert to freq (superdough uses MIDI note numbers or note names)
    if (controls.note !== undefined && controls.freq === undefined) {
      // Convert note to MIDI number, then to frequency
      let midiNote: number;
      if (typeof controls.note === 'number') {
        midiNote = controls.note;
      } else if (typeof controls.note === 'string' && isNote(controls.note)) {
        // Parse note name like "c4", "d#5", "eb3" using @strudel/core
        midiNote = noteToMidi(controls.note);
      } else {
        midiNote = 60;
      }
      controls.freq = midiToFreq(midiNote);
    } else if (controls.freq === undefined) {
      // Default frequency depends on synth type
      if (synthInstrument === 'sbd2') {
        // sbd2 uses MIDI note 29 (F1 ≈ 43.65 Hz) as default
        // This matches superdough's getFrequencyFromValue(value, 29)
        controls.freq = 43.65;  // F1 - superdough default for sbd
      } else {
        // Other synths use MIDI note 36 (C2 = 65.41 Hz)
        // This matches superdough's synth.mjs default: note: o = 36
        controls.freq = 65.41;  // C2 - superdough default for all synths
      }
    }
    
    // Handle ZZFX-specific parameters
    if (synthInstrument === 'strudel_zzfx') {
      // Set zshape based on sound name (0=sin, 1=tri, 2=saw, 3=tan, 4=noise)
      if (controls.zshape === undefined && soundName) {
        controls.zshape = zzfxShapeMap[soundName] ?? 0;
      }
      // For z_square, use saw (shape 2) with shapeCurve 0 to get square-ish wave
      if (soundName === 'z_square' && controls.zshapeCurve === undefined) {
        controls.zshapeCurve = 0;
      }
      
      // Map Strudel ZZFX params to our SynthDef params
      // These match the param names from superdough/zzfx.mjs
      if (controls.slide !== undefined && controls.zslide === undefined) {
        controls.zslide = controls.slide;
      }
      if (controls.deltaSlide !== undefined && controls.zdeltaSlide === undefined) {
        controls.zdeltaSlide = controls.deltaSlide;
      }
      if (controls.curve !== undefined && controls.zshapeCurve === undefined) {
        controls.zshapeCurve = controls.curve;
      }
      if (controls.pitchJump !== undefined && controls.zpitchJump === undefined) {
        controls.zpitchJump = controls.pitchJump;
      }
      if (controls.pitchJumpTime !== undefined && controls.zpitchJumpTime === undefined) {
        controls.zpitchJumpTime = controls.pitchJumpTime;
      }
      // znoise, zmod, zrand are passed through as-is (already prefixed with z)
      
      // ZZFX has 0.25 volume baked into the SynthDef, so DON'T apply the 0.3 multiplier
      // that regular synths use. Just use the raw pattern gain.
      // (The 0.25 is roughly equivalent to the 0.3 in other synths)
      controls.gain = controls.gain ?? 0.8;
    } else if (synthInstrument === 'strudel_bytebeat') {
      // ByteBeat - 8-bit procedural audio generator
      // Uses 15 built-in preset expressions from superdough
      // Custom bbexpr requires WebAudio fallback (not supported in SC)
      
      // If bbexpr is specified, we can't handle it in SC - log warning
      if (controls.bbexpr !== undefined) {
        console.warn('[osc] ByteBeat custom expressions (bbexpr) not supported in SuperCollider backend. Use a preset number instead.');
        // Fall through anyway, will use default preset
        delete controls.bbexpr;
      }
      
      // Handle preset selection:
      // s("bytebeat:N") where N is the preset number (0-14)
      // The 'n' control specifies which preset to use
      const presetNum = controls.n ?? 0;
      controls.bbPreset = Math.floor(Math.abs(presetNum)) % 15;
      
      // Handle byteBeatStartTime (bbst) - start offset in samples
      if (controls.bbst !== undefined) {
        controls.bbStartTime = controls.bbst;
        delete controls.bbst;
      }
      
      // ByteBeat uses 440 Hz as default frequency (like superdough)
      // The frequency controls the t increment rate
      if (controls.freq === undefined && controls.note === undefined) {
        controls.freq = 440;
      }
      
      // ByteBeat has its own gain (0.2) baked into the SynthDef
      // like ZZFX, don't apply the 0.3 multiplier
      controls.gain = controls.gain ?? 0.8;
    } else if (synthInstrument === 'pulse') {
      // Pulse wave synth with PWM - StrudelDirt version
      // StrudelDirt uses z1/z2/z3 params: z1=width, z2=modspeed, z3=moddepth
      // Map superdough's pw/pwrate/pwsweep to StrudelDirt's z1/z2/z3
      if (controls.pw !== undefined && controls.z1 === undefined) {
        controls.z1 = controls.pw;
      }
      if (controls.pwrate !== undefined && controls.z2 === undefined) {
        controls.z2 = controls.pwrate;
      }
      if (controls.pwsweep !== undefined && controls.z3 === undefined) {
        controls.z3 = controls.pwsweep;
      }
      // For square wave emulation, set z1=0.5 (50% duty cycle) if not specified
      if (soundName === 'square' || soundName === 'sqr') {
        controls.z1 = controls.z1 ?? 0.5;
      }
      
      // Apply standard synth gain reduction
      controls.gain = (controls.gain ?? 0.8) * 0.3;
    } else if (synthInstrument === 'supersaw') {
      // Supersaw synth - StrudelDirt version
      // StrudelDirt uses unison, spread, detune (same as superdough)
      if (controls.unison !== undefined) controls.unison = controls.unison;
      if (controls.spread !== undefined) controls.spread = controls.spread;
      if (controls.detune !== undefined) controls.detune = controls.detune;
      
      // Apply standard synth gain reduction
      controls.gain = (controls.gain ?? 0.8) * 0.3;
    } else if (synthInstrument === 'sbd2') {
      // Synthesized bass drum - StrudelDirt version (sbd2)
      // StrudelDirt uses z1/z2/z3/z4 params
      // z1 = decay offset, z2 = volume ratio, z3 = knock decay, z4 = pitch env depth
      // Map superdough's sbd params to StrudelDirt's z1-z4
      if (controls.decay !== undefined && controls.z1 === undefined) {
        controls.z1 = controls.decay;
      }
      // z2, z3, z4 are StrudelDirt-specific, pass through if set
      
      // sbd does NOT apply the 0.3 gain reduction that regular oscillators use
      controls.gain = controls.gain ?? 0.8;
    } else {
      // For other synths (sine, saw, square, triangle, noise variants)
      // Apply superdough's oscillator gain reduction (0.3) here instead of in SynthDef
      // This matches synth.mjs: const g = gainNode(0.3);
      // The gain will then go through convertGainForSuperDirt() for the gain^4 curve
      controls.gain = (controls.gain ?? 0.8) * 0.3;
    }
    
    // Common envelope handling for most synths (ZZFX, pulse, supersaw, basic oscillators)
    // sbd2 has its own built-in envelope and doesn't use strudel_envelope params
    if (synthInstrument !== 'sbd2') {
      // Calculate ADSR values matching superdough's getADSRValues behavior
      // This ensures sustainLevel is set correctly based on which params are specified
      // IMPORTANT: Check rawValue.sustain BEFORE we overwrite controls.sustain with delta
      // 
      // Synth defaults from superdough/synth.mjs line 44-48:
      //   [0.001, 0.05, 0.6, 0.01] = [attack, decay, sustain, release]
      // This means synths have a quick attack, 50ms decay to 60% sustain level
      const patternSustainLevel = typeof rawValue.sustain === 'number' ? rawValue.sustain : undefined;
      const [envAttack, envDecay, envSustainLevel, envRelease] = getADSRValues(
        controls.attack,
        controls.decay,
        patternSustainLevel,  // sustain LEVEL from pattern (0-1), not duration
        controls.release,
        [0.001, 0.05, 0.6, 0.01]  // synth defaults from superdough
      );
      
      // Use StrudelDirt's strudel_envelope module (standard params)
      // strudel_envelope uses Env.adsr with:
      //   attackTime: attack
      //   decayTime: decay  
      //   sustainLevel: hold (0-1 value, NOT a duration!)
      //   releaseTime: release
      //   gate: Trig.ar(1, holdtime) where holdtime comes from ~sustain
      controls.attack = envAttack;
      controls.decay = envDecay;
      controls.hold = envSustainLevel;  // This is sustainLevel (0-1), NOT holdTime!
      controls.release = envRelease;
      // Envelope curve: 0 = linear (testing), -2 = exponential (default)
      // 0 = linear (for testing), -2 = exponential (default, better quality)
      controls.curve = envelopeCurve;
      // sustain becomes holdtime in the synth (gate duration before release)
      // DirtEvent.sc calculates: totalDuration = sustain + release
      controls.sustain = delta;
    } else {
      // sbd uses its own decay param for amplitude envelope
      // Just set sustain for SynthDef timing
      controls.sustain = delta;
      // Keep decay, pdecay, penv, clip - they're used by the sbd SynthDef
    }
    
    // Delete note since we've converted to freq
    delete controls.note;
    delete controls.n; // Synths don't use sample index
  }
  
  // Handle soundfont instruments
  // Soundfonts need looping + ADSR envelope, so we use our custom strudel_soundfont synth
  // Regular samples use the default dirt_sample synth (no looping)
  const bankName = controls.s || controls.sound;
  // Check if it's a soundfont: either registered as such OR starts with 'gm_' (GM soundfonts)
  const isSoundfont = bankName && (isBankSoundfont(bankName) || bankName.startsWith('gm_'));
  if (isSoundfont) {
    // Use our custom soundfont synth that loops and applies ADSR
    // Soundfont samples are stereo (converted by ffmpeg with -ac 2)
    controls.instrument = 'strudel_soundfont_2_2';
    
    // Pass through loop points for sample-accurate sustain looping
    // These come from processValueForOsc via calculateNAndSpeed
    // loopBegin/loopEnd are normalized 0-1 positions within the sample
    if (controls.loopBegin !== undefined && controls.loopEnd !== undefined) {
      controls.sfLoopBegin = controls.loopBegin;
      controls.sfLoopEnd = controls.loopEnd;
      delete controls.loopBegin;
      delete controls.loopEnd;
    }
    
    // Calculate ADSR envelope values matching superdough's getADSRValues behavior
    // This ensures soundfonts use StrudelDirt's strudel_envelope module
    const patternSustainLevel = typeof rawValue.sustain === 'number' ? rawValue.sustain : undefined;
    const [envAttack, envDecay, envSustainLevel, envRelease] = getADSRValues(
      controls.attack,
      controls.decay,
      patternSustainLevel,
      controls.release
    );
    
    // Use StrudelDirt's strudel_envelope module (standard params)
    // hold = sustainLevel (0-1), NOT holdTime!
    controls.attack = envAttack;
    controls.decay = envDecay;
    controls.hold = envSustainLevel;
    controls.release = envRelease;
    // Keep the dry soundfont source alive through the downstream envelope's
    // release stage. Previously it freed after delta + 0.1 and cut long tails.
    controls.sfSustain = delta + envRelease + 0.01;
    // Envelope curve: 0 = linear (testing), -2 = exponential (default)
    controls.curve = envelopeCurve;
    controls.sustain = delta;
    
    // speed is critical - without it SuperDirt passes invalid value and synth is silent
    if (controls.speed == null) controls.speed = 1;
    
    // Match superdough's soundfont gain compensation
    // In superdough, samples use getParamADSR with max gain 1.0 (sampler.mjs:315)
    // while soundfonts use max gain 0.3 (fontloader.mjs:163)
    // This compensates for soundfont samples being normalized louder than Dirt-Samples
    // Apply BEFORE converting to SuperDirt gain curve
    controls.gain = controls.gain * 0.3;
  } else if (!synthInstrument) {
    // Regular samples (not synths, not soundfonts)
    // If attack/release are specified, use StrudelDirt's strudel_envelope module
    // This gives us consistent linear ADSR behavior matching superdough
    if (rawValue.attack !== undefined || rawValue.release !== undefined || 
        rawValue.decay !== undefined || rawValue.sustain !== undefined) {
      // Calculate ADSR values matching superdough's getADSRValues behavior
      const patternSustainLevel = typeof rawValue.sustain === 'number' ? rawValue.sustain : undefined;
      const [envAttack, envDecay, envSustainLevel, envRelease] = getADSRValues(
        controls.attack,
        controls.decay,
        patternSustainLevel,
        controls.release
      );
      
      // Use StrudelDirt's strudel_envelope module (standard params)
      // hold = sustainLevel (0-1), NOT holdTime!
      controls.attack = envAttack;
      controls.decay = envDecay;
      controls.hold = envSustainLevel;
      controls.release = envRelease;
      // Envelope curve: 0 = linear (testing), -2 = exponential (default)
      controls.curve = envelopeCurve;
      controls.sustain = delta;
    }
  }
  
  // Pan compensation for SuperDirt's equal-power panning
  // 
  // SuperDirt always applies DirtPan using Pan2, which uses equal-power panning.
  // At center (pan=0.5), Pan2 reduces each channel by sqrt(0.5) ≈ 0.707 (-3dB)
  // to maintain constant power when summed.
  //
  // superdough/WebAudio only applies a StereoPannerNode when pan is explicitly set.
  // When pan is not specified, no panner is added and the signal passes through unchanged.
  //
  // This means:
  // - No pan specified: superdough = full level, SuperDirt = -3dB → we need to boost by sqrt(2)
  // - Pan specified: both use equal-power panning → levels match
  //
  // The compensation factor is sqrt(2) ≈ 1.414 for the center position.
  // For other pan positions, the compensation gradually decreases to 1.0 at hard left/right.
  //
  // NOTE: ZZFX synths are excluded from pan compensation because their gain staging
  // is already calibrated differently (0.25 baked in vs 0.3 for regular synths).
  // Empirically, ZZFX without pan compensation matches better.
  //
  // All sounds using DirtPan (samples, synths, soundfonts) get the -3dB reduction
  // at center and need sqrt(2) compensation when no pan is specified.
  const isZZFX = synthSoundMap[soundName]?.includes('zzfx');
  if (rawValue.pan === undefined && !isZZFX) {
    // No pan specified - SuperDirt will center with -3dB, compensate with sqrt(2)
    controls.gain = controls.gain * Math.SQRT2;
  }
  
  // Convert filter parameters to strudel* prefixed names
  // This avoids triggering SuperDirt's built-in dirt_lpf/dirt_hpf modules, which
  // would apply ADDITIONAL filtering on top of our strudel_filter module.
  // Using strudel* params ensures only our module handles filtering (consistent 12 dB/oct slope).
  // This applies to all sounds: synths, samples, and soundfonts.
  if (controls.cutoff !== undefined) {
    controls.strudelLpf = controls.cutoff;
    delete controls.cutoff;
  }
  if (controls.hcutoff !== undefined) {
    controls.strudelHpf = controls.hcutoff;
    delete controls.hcutoff;
  }
  if (controls.resonance !== undefined) {
    controls.strudelLpq = controls.resonance;
    delete controls.resonance;
  }
  if (controls.hresonance !== undefined) {
    controls.strudelHpq = controls.hresonance;
    delete controls.hresonance;
  }
  // Also handle lpf/hpf aliases that superdough uses
  if (controls.lpf !== undefined && controls.strudelLpf === undefined) {
    controls.strudelLpf = controls.lpf;
    delete controls.lpf;
  }
  if (controls.hpf !== undefined && controls.strudelHpf === undefined) {
    controls.strudelHpf = controls.hpf;
    delete controls.hpf;
  }
  if (controls.lpq !== undefined && controls.strudelLpq === undefined) {
    controls.strudelLpq = controls.lpq;
    delete controls.lpq;
  }
  if (controls.hpq !== undefined && controls.strudelHpq === undefined) {
    controls.strudelHpq = controls.hpq;
    delete controls.hpq;
  }
  
  // Handle bandpass filter - redirect to our strudel_filter module
  // bandf/bandq are Strudel's BPF parameters
  if (controls.bandf !== undefined && controls.strudelBpf === undefined) {
    controls.strudelBpf = controls.bandf;
    delete controls.bandf;
  }
  if (controls.bandq !== undefined && controls.strudelBpq === undefined) {
    controls.strudelBpq = controls.bandq;
    delete controls.bandq;
  }
  if (controls.bpf !== undefined && controls.strudelBpf === undefined) {
    controls.strudelBpf = controls.bpf;
    delete controls.bpf;
  }
  if (controls.bpq !== undefined && controls.strudelBpq === undefined) {
    controls.strudelBpq = controls.bpq;
    delete controls.bpq;
  }
  
  // Handle filter envelope parameters for lowpass filter
  // superdough uses: lpenv (amount in octaves), lpattack, lpdecay, lpsustain, lprelease, fanchor
  // If any ADSR param is set but lpenv is not, default lpenv to 1 (matches superdough behavior)
  const hasLpADSR = controls.lpattack !== undefined || controls.lpdecay !== undefined || 
                     controls.lpsustain !== undefined || controls.lprelease !== undefined;
  if (hasLpADSR && controls.lpenv === undefined) {
    controls.lpenv = 1;  // Default envelope amount when ADSR is specified
  }
  
  if (controls.lpenv !== undefined) {
    controls.strudelLpEnv = controls.lpenv;
    delete controls.lpenv;
  }
  if (controls.lpattack !== undefined) {
    controls.strudelLpAttack = controls.lpattack;
    delete controls.lpattack;
  }
  if (controls.lpdecay !== undefined) {
    controls.strudelLpDecay = controls.lpdecay;
    delete controls.lpdecay;
  }
  if (controls.lpsustain !== undefined) {
    controls.strudelLpSustain = controls.lpsustain;
    delete controls.lpsustain;
  }
  if (controls.lprelease !== undefined) {
    controls.strudelLpRelease = controls.lprelease;
    delete controls.lprelease;
  }
  
  // Handle filter envelope parameters for highpass filter
  // superdough uses: hpenv (amount in octaves), hpattack, hpdecay, hpsustain, hprelease
  // If any ADSR param is set but hpenv is not, default hpenv to 1 (matches superdough behavior)
  const hasHpADSR = controls.hpattack !== undefined || controls.hpdecay !== undefined || 
                     controls.hpsustain !== undefined || controls.hprelease !== undefined;
  if (hasHpADSR && controls.hpenv === undefined) {
    controls.hpenv = 1;  // Default envelope amount when ADSR is specified
  }
  
  if (controls.hpenv !== undefined) {
    controls.strudelHpEnv = controls.hpenv;
    delete controls.hpenv;
  }
  if (controls.hpattack !== undefined) {
    controls.strudelHpAttack = controls.hpattack;
    delete controls.hpattack;
  }
  if (controls.hpdecay !== undefined) {
    controls.strudelHpDecay = controls.hpdecay;
    delete controls.hpdecay;
  }
  if (controls.hpsustain !== undefined) {
    controls.strudelHpSustain = controls.hpsustain;
    delete controls.hpsustain;
  }
  if (controls.hprelease !== undefined) {
    controls.strudelHpRelease = controls.hprelease;
    delete controls.hprelease;
  }
  
  // Handle filter envelope parameters for bandpass filter
  // superdough uses: bpenv (amount in octaves), bpattack, bpdecay, bpsustain, bprelease
  // If any ADSR param is set but bpenv is not, default bpenv to 1 (matches superdough behavior)
  const hasBpADSR = controls.bpattack !== undefined || controls.bpdecay !== undefined || 
                     controls.bpsustain !== undefined || controls.bprelease !== undefined;
  if (hasBpADSR && controls.bpenv === undefined) {
    controls.bpenv = 1;  // Default envelope amount when ADSR is specified
  }
  
  if (controls.bpenv !== undefined) {
    controls.strudelBpEnv = controls.bpenv;
    delete controls.bpenv;
  }
  if (controls.bpattack !== undefined) {
    controls.strudelBpAttack = controls.bpattack;
    delete controls.bpattack;
  }
  if (controls.bpdecay !== undefined) {
    controls.strudelBpDecay = controls.bpdecay;
    delete controls.bpdecay;
  }
  if (controls.bpsustain !== undefined) {
    controls.strudelBpSustain = controls.bpsustain;
    delete controls.bpsustain;
  }
  if (controls.bprelease !== undefined) {
    controls.strudelBpRelease = controls.bprelease;
    delete controls.bprelease;
  }
  
  // Filter anchor point (0-1, where envelope pivots around cutoff frequency)
  if (controls.fanchor !== undefined) {
    controls.strudelFanchor = controls.fanchor;
    delete controls.fanchor;
  }
  
  // Filter type: '12db' (default), '24db' (cascade two filters), or 'ladder' (Moog-style)
  if (controls.ftype !== undefined) {
    if (controls.ftype === '24db') {
      controls.strudelFtype = 1;  // 24dB mode - cascade filters
    } else if (controls.ftype === 'ladder') {
      controls.strudelFtype = 2;  // Ladder mode - MoogFF filter
    } else {
      controls.strudelFtype = 0;  // 12dB mode (default)
    }
    delete controls.ftype;
  }
  
  // DJF (DJ Filter) - crossfades between lowpass and highpass
  // djf < 0.5 = lowpass, djf > 0.5 = highpass, djf = 0.5 = neutral
  // We pass this directly to the filter module as strudelDjf
  if (controls.djf !== undefined) {
    controls.strudelDjf = controls.djf;
    delete controls.djf;
  }
  
  // FM synthesis parameters
  // fm is an alias for fmi (modulation index) - convert to fmi for synths
  // fmi, fmh, fmattack, fmdecay, fmsustain, fmrelease pass through directly
  if (controls.fm !== undefined) {
    controls.fmi = controls.fm;
    delete controls.fm;
  }
  
  // FM envelope smart defaults (matches superdough's getADSRValues behavior)
  // When only some envelope params are set, others get smart defaults:
  // - If only decay is set -> sustain defaults to 0.001 (AD envelope)
  // - If only attack is set -> sustain defaults to 1 (AS envelope)
  // - Otherwise sustain defaults to 1 (full sustain)
  if (controls.fmi !== undefined && controls.fmi > 0) {
    const fmA = controls.fmattack;
    const fmD = controls.fmdecay;
    const fmS = controls.fmsustain;
    const fmR = controls.fmrelease;
    
    // Only apply smart defaults if some params are set but sustain is not
    if (fmS === undefined && (fmA !== undefined || fmD !== undefined || fmR !== undefined)) {
      // Match superdough: if attack is set but decay is not, sustain = 1
      // Otherwise (decay set, or nothing set), sustain = 0.001
      if ((fmA !== undefined && fmD === undefined) || (fmA === undefined && fmD === undefined)) {
        controls.fmsustain = 1;
      } else {
        controls.fmsustain = 0.001;  // AD-style envelope when decay is set
      }
    }
    
    // Default attack to 0.001 (minimum) if not set but other params are
    if (fmA === undefined && (fmD !== undefined || fmR !== undefined)) {
      controls.fmattack = 0.001;
    }
    
    // Default release to 0.01 (minimum) if not set but other params are  
    if (fmR === undefined && (fmA !== undefined || fmD !== undefined)) {
      controls.fmrelease = 0.01;
    }
  }
  
  // Apply per-synth gain compensation for StrudelDirt synths
  // Use the ORIGINAL sound name (before mapping) for compensation lookup
  // This ensures 'square' gets square compensation even though it maps to 'pulse'
  const synthGainComp = soundName ? getStrudelDirtSynthGainCompensation(soundName) : 1.0;
  if (synthGainComp !== 1.0) {
    controls.gain = controls.gain * synthGainComp;
  }
  
  // Convert gain to StrudelDirt's gain curve (gain^2)
  controls.gain = convertGainForSuperDirt(controls.gain);

  // Flatten to array of [key, value, key, value, ...]
  const args: any[] = [];
  for (const [key, val] of Object.entries(controls)) {
    if (val !== undefined && val !== null) {
      args.push({ type: 's', value: key });

      // Determine OSC type
      if (typeof val === 'number') {
        args.push({ type: 'f', value: val });
      } else if (typeof val === 'string') {
        args.push({ type: 's', value: val });
      } else {
        args.push({ type: 's', value: String(val) });
      }
    }
  }

  return args;
}

/**
 * Send a hap (event) to SuperDirt via OSC with proper timing
 * @param hap The hap (event) from Strudel
 * @param targetTime The target time in AudioContext seconds when this should play
 * @param cps Cycles per second (tempo)
 */
let oscDebug = false; // Set to true for debugging

export function setOscDebug(enabled: boolean): void {
  oscDebug = enabled;
}

export function sendHapToSuperDirt(hap: any, targetTime: number, cps: number): void {
  if (oscDebug) {
    console.log(`[osc] sendHapToSuperDirt called, hap.value:`, JSON.stringify(hap.value));
  }
  
  try {
    const args = hapToOscArgs(hap, cps);
    
    // Capture OSC message for file output if recording is enabled
    // This happens regardless of whether real-time OSC is connected
    if (shouldCaptureOsc()) {
      captureOscMessage(targetTime, '/dirt/play', args);
    }
    
    // Skip real-time sending if OSC not connected
    if (!udpPort || !isOpen) {
      return;
    }
    
    // Convert AudioContext time to Unix time for OSC timetag
    const unixTargetTime = audioTimeToUnixTime(targetTime);
    
    // Create OSC timetag (seconds offset from now)
    // osc.timeTag(n) creates a timetag n seconds from now
    const now = Date.now() / 1000;
    const secondsFromNow = unixTargetTime - now;
    
    // Build argsObj for routing and debug logging
    const argsObj: Record<string, any> = {};
    for (let i = 0; i < args.length; i += 2) {
      if (args[i]?.value && args[i+1]) {
        argsObj[args[i].value] = args[i+1].value;
      }
    }
    
    if (oscDebug) {
      // Just dump key args
      const speedStr = argsObj.speed?.toFixed?.(4) || argsObj.speed;
      const noteStr = argsObj.note !== undefined ? ` note=${argsObj.note}` : '';
      const freqStr = argsObj.freq !== undefined ? ` freq=${argsObj.freq?.toFixed?.(1)}` : '';
      const sustainStr = argsObj.sustain !== undefined ? ` sustain=${argsObj.sustain?.toFixed?.(3)}` : '';
      const tremStr = argsObj.strudelTremRate !== undefined
        ? ` trem=${argsObj.strudelTremRate?.toFixed?.(2)}` +
          ` depth=${argsObj.strudelTremDepth}` +
          ` shape=${argsObj.strudelTremShape}` +
          ` phase=${argsObj.strudelTremPhase?.toFixed?.(3)}`
        : '';
      const sfEnvStr = argsObj.sfSustain !== undefined ? ` sfSustain=${argsObj.sfSustain?.toFixed?.(3)}` : '';
      const sfLoopStr = argsObj.sfLoopBegin !== undefined ? ` loop=${argsObj.sfLoopBegin?.toFixed?.(4)}-${argsObj.sfLoopEnd?.toFixed?.(4)}` : '';
      const instrStr = argsObj.instrument ? ` instrument=${argsObj.instrument}` : '';
      const orbitStr = argsObj.orbit !== undefined ? ` orbit=${argsObj.orbit}` : ' orbit=MISSING';
      // Show strudel filter params (strudelLpf/Hpf) instead of old cutoff/hcutoff
      const lpfStr = argsObj.strudelLpf !== undefined ? ` lpf=${argsObj.strudelLpf?.toFixed?.(0)}` : '';
      const hpfStr = argsObj.strudelHpf !== undefined ? ` hpf=${argsObj.strudelHpf?.toFixed?.(0)}` : '';
      const lpqStr = argsObj.strudelLpq !== undefined ? ` lpq=${argsObj.strudelLpq?.toFixed?.(2)}` : '';
      const hpqStr = argsObj.strudelHpq !== undefined ? ` hpq=${argsObj.strudelHpq?.toFixed?.(2)}` : '';
      const shapeStr = argsObj.shape !== undefined ? ` shape=${argsObj.shape?.toFixed?.(2)}` : '';
      const zshapeStr = argsObj.zshape !== undefined ? ` zshape=${argsObj.zshape}` : '';
      const zgainStr = argsObj.zgain !== undefined ? ` zgain=${argsObj.zgain?.toFixed?.(2)}` : '';
      const sustainLevelStr = argsObj.sustainLevel !== undefined ? ` sustainLevel=${argsObj.sustainLevel?.toFixed?.(2)}` : '';
      const ampStr = argsObj.amp !== undefined ? ` amp=${argsObj.amp?.toFixed?.(2)}` : '';
      // Show filter envelope params if present
      const lpEnvStr = argsObj.strudelLpEnv !== undefined ? ` lpenv=${argsObj.strudelLpEnv} lpdecay=${argsObj.strudelLpDecay?.toFixed?.(2)}` : '';
      const hpEnvStr = argsObj.strudelHpEnv !== undefined ? ` hpenv=${argsObj.strudelHpEnv}` : '';
      // Show envelope curve for debugging
      const curveStr = argsObj.curve !== undefined ? ` curve=${argsObj.curve}` : '';
      const attackStr = argsObj.attack !== undefined ? ` attack=${argsObj.attack?.toFixed?.(3)}` : '';
      const releaseStr = argsObj.release !== undefined ? ` release=${argsObj.release?.toFixed?.(3)}` : '';
      console.log(`[osc] SEND: s=${argsObj.s} n=${argsObj.n}${orbitStr} speed=${speedStr}${freqStr}${sustainStr}${sustainLevelStr}${noteStr}${attackStr}${releaseStr}${curveStr}${lpfStr}${lpEnvStr}${lpqStr}${hpfStr}${hpEnvStr}${hpqStr}${shapeStr}${zshapeStr}${zgainStr}${tremStr}${sfEnvStr}${sfLoopStr}${instrStr} gain=${argsObj.gain?.toFixed?.(2)}${ampStr} t+${secondsFromNow.toFixed(3)}s`);
    }
    
    // Send as OSC bundle with timetag for precise scheduling
    // SuperDirt will schedule the sound to play at the specified time
    const bundle = {
      timeTag: osc.timeTag(secondsFromNow),
      packets: [{
        address: '/dirt/play',
        args,
      }]
    };

    udpPort.send(bundle);
  } catch (err) {
    console.error('[osc] Error sending hap:', err);
  }
}

/**
 * Send a simple test sound to verify connection
 */
export function sendTestSound(): void {
  if (!udpPort || !isOpen) {
    console.error('[osc] Not connected');
    return;
  }

  const args = [
    { type: 's', value: 's' },
    { type: 's', value: 'bd' },
    { type: 's', value: 'cps' },
    { type: 'f', value: 1 },
    { type: 's', value: 'delta' },
    { type: 'f', value: 1 },
    { type: 's', value: 'cycle' },
    { type: 'f', value: 0 },
  ];

  udpPort.send({
    address: '/dirt/play',
    args,
  });
  
  console.log('[osc] Test sound sent (bd)');
}
