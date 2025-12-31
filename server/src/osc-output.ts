// @ts-ignore - osc has no type definitions
import osc from 'osc';
import { processValueForOsc, isBankSoundfont } from './sample-metadata.js';
import { resolveDrumMachineBankSync } from './on-demand-loader.js';

// Default SuperDirt ports
const OSC_REMOTE_IP = '127.0.0.1';
const OSC_REMOTE_PORT = 57120;

let udpPort: any = null;
let isOpen = false;

// Clock synchronization
// AudioContext time starts at 0 when created, we need to map it to Unix/NTP time
let audioContextStartTime: number | null = null; // Unix time when AudioContext was created

/**
 * Parse a note name like "c4", "d#5", "eb3" into a MIDI note number
 * Returns undefined if the string is not a valid note name
 */
function parseNoteName(name: string): number | undefined {
  const match = name.toLowerCase().match(/^([a-g])([#bs]?)(-?\d+)?$/);
  if (!match) return undefined;
  
  const noteMap: Record<string, number> = {
    'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11,
  };
  
  let note = noteMap[match[1]];
  if (note === undefined) return undefined;
  
  if (match[2] === '#' || match[2] === 's') note += 1;  // 's' is also used for sharp
  else if (match[2] === 'b') note -= 1;
  
  const octave = match[3] ? parseInt(match[3], 10) : 4;
  return (octave + 1) * 12 + note;
}

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

/**
 * Initialize the OSC UDP port for sending messages to SuperDirt
 */
export function initOsc(remoteIp = OSC_REMOTE_IP, remotePort = OSC_REMOTE_PORT): Promise<void> {
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
 * Synth sounds that have SuperDirt SynthDefs
 * These can be routed to OSC instead of requiring Web Audio
 */
const oscSynthSounds = new Set([
  'sine', 'sawtooth', 'saw', 'square', 'triangle', 'tri',
  'white', 'pink', 'brown'
]);

/**
 * Check if a sound name is a synth that can be played via OSC
 */
export function isSynthSoundForOsc(soundName: string): boolean {
  return oscSynthSounds.has(soundName);
}

/**
 * Get the OSC UDP port for sending additional messages (e.g., sample loading)
 */
export function getOscPort(): any {
  return udpPort;
}

/**
 * Convert superdough-style gain to SuperDirt gain
 * 
 * superdough uses linear gain (default 0.8, pattern gain applied directly)
 * SuperDirt uses: amp = 0.4 * gain^4
 * 
 * To match volumes, we invert SuperDirt's curve:
 * If we want output level L, we need: 0.4 * gain^4 = L
 * So: gain = (L / 0.4)^0.25 = (2.5 * L)^0.25
 */
function convertGainForSuperDirt(superdoughGain: number): number {
  // superdough default gain is 0.8, so scale relative to that
  const targetLevel = superdoughGain;
  // Invert SuperDirt's gain curve: amp = 0.4 * gain^4
  // gain = (targetLevel / 0.4)^0.25
  return Math.pow(targetLevel / 0.4, 0.25);
}

/**
 * Calculate ADSR values matching Strudel's getADSRValues behavior
 * Returns [attack, decay, sustain, release] with proper defaults
 */
function getADSRValues(
  attack?: number,
  decay?: number, 
  sustain?: number,
  release?: number
): [number, number, number, number] {
  const envmin = 0.001;
  const releaseMin = 0.01;
  const envmax = 1;
  
  // If no params set, return defaults
  if (attack == null && decay == null && sustain == null && release == null) {
    return [envmin, envmin, envmax, releaseMin];
  }
  
  // Calculate sustain level based on which params are set
  // (matching Strudel's behavior)
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
function hapToOscArgs(hap: any, cps: number): any[] {
  const rawValue = hap.value || {};
  const begin = hap.wholeOrPart?.()?.begin?.valueOf?.() ?? 0;
  const duration = hap.duration?.valueOf?.() ?? 1;
  const delta = duration / cps;

  // Process the value for pitched samples (converts note/freq to n + speed)
  const processedValue = processValueForOsc(rawValue);

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
  
  // Handle tremolo parameter mapping
  // Strudel uses: tremolo (Hz) or tremolosync (cycles), tremolodepth, tremoloskew, tremolophase, tremoloshape
  // SuperDirt uses: tremolorate (Hz), tremolodepth
  if (controls.tremolosync != null) {
    // tremolosync is in cycles, convert to Hz using cps
    controls.tremolorate = controls.tremolosync * cps;
    delete controls.tremolosync;
  } else if (controls.tremolo != null) {
    // tremolo is already in Hz
    controls.tremolorate = controls.tremolo;
    delete controls.tremolo;
  }
  
  // If tremolo is active but tremolodepth not specified, default to 1 (matching superdough)
  // SuperDirt defaults to 0.5, but superdough defaults to 1
  if (controls.tremolorate != null && controls.tremolodepth == null) {
    controls.tremolodepth = 1;
  }
  
  // Note: tremoloskew, tremolophase, tremoloshape are Strudel-specific and not supported by SuperDirt
  // They will be passed through but ignored
  
  // Handle phaser parameter mapping
  // Strudel uses: phaserrate, phaserdepth
  // SuperDirt uses the same names, so no translation needed
  
  // Handle synth sounds (oscillators)
  // These use our custom strudel_* SynthDefs instead of sample playback
  const synthSoundMap: Record<string, string> = {
    'sine': 'strudel_sine',
    'sawtooth': 'strudel_sawtooth',
    'saw': 'strudel_saw',
    'square': 'strudel_square',
    'triangle': 'strudel_triangle',
    'tri': 'strudel_tri',
    'white': 'strudel_white',
    'pink': 'strudel_pink',
    'brown': 'strudel_brown',
  };
  
  const soundName = controls.s || controls.sound;
  const synthInstrument = soundName ? synthSoundMap[soundName] : undefined;
  
  if (synthInstrument) {
    // For synth sounds, replace 's' with our SynthDef name
    // SuperDirt will look for a SynthDef with this name when it's not a sample bank
    controls.s = synthInstrument;
    delete controls.sound; // Remove alias if present
    
    // Synth sounds use freq instead of sample playback
    // If note is specified, convert to freq (superdough uses MIDI note numbers or note names)
    if (controls.note !== undefined && controls.freq === undefined) {
      // Convert note to MIDI number, then to frequency
      let midiNote: number;
      if (typeof controls.note === 'number') {
        midiNote = controls.note;
      } else if (typeof controls.note === 'string') {
        // Parse note name like "c4", "d#5", "eb3"
        const parsed = parseNoteName(controls.note);
        midiNote = parsed !== undefined ? parsed : 60;
      } else {
        midiNote = 60;
      }
      controls.freq = 440 * Math.pow(2, (midiNote - 69) / 12);
    } else if (controls.freq === undefined) {
      // Default to middle C
      controls.freq = 261.63;
    }
    
    // Set sustain to note duration for proper envelope
    controls.sustain = delta;
    
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
    
    // Use custom parameter names (sfAttack, sfRelease, sfSustain) to avoid
    // SuperDirt's internal parameter handling which overrides standard names
    if (controls.sfAttack == null) controls.sfAttack = controls.attack ?? 0.01;
    if (controls.sfRelease == null) controls.sfRelease = controls.release ?? 0.1;
    // sfSustain controls how long the note plays (use note duration from pattern)
    // Note: Strudel's 'sustain' param is the sustain LEVEL (0-1), not duration!
    // We always use delta (note duration) for sfSustain
    if (controls.sfSustain == null) controls.sfSustain = delta;
    
    // IMPORTANT: Delete standard envelope params so SuperDirt's core modules
    // don't apply their own envelope on top of our custom SynthDef's envelope.
    // Without this, sustain=0 (sustain LEVEL) causes SuperDirt to mute the sound.
    delete controls.attack;
    delete controls.decay;
    delete controls.sustain;
    delete controls.release;
    
    // speed is critical - without it SuperDirt passes invalid value and synth is silent
    if (controls.speed == null) controls.speed = 1;
    
    // Match superdough's soundfont gain compensation
    // In superdough, samples use getParamADSR with max gain 1.0 (sampler.mjs:315)
    // while soundfonts use max gain 0.3 (fontloader.mjs:163)
    // This compensates for soundfont samples being normalized louder than Dirt-Samples
    // Apply BEFORE converting to SuperDirt gain curve
    controls.gain = controls.gain * 0.3;
  }
  
  // Now convert gain to SuperDirt's gain curve (applies to all sounds)
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
  if (!udpPort || !isOpen) {
    // Silently skip if OSC not connected
    return;
  }

  try {
    const args = hapToOscArgs(hap, cps);
    
    // Convert AudioContext time to Unix time for OSC timetag
    const unixTargetTime = audioTimeToUnixTime(targetTime);
    
    // Create OSC timetag (seconds offset from now)
    // osc.timeTag(n) creates a timetag n seconds from now
    const now = Date.now() / 1000;
    const secondsFromNow = unixTargetTime - now;
    
    if (oscDebug) {
      // Just dump key args
      const argsObj: Record<string, any> = {};
      for (let i = 0; i < args.length; i += 2) {
        if (args[i]?.value && args[i+1]) {
          argsObj[args[i].value] = args[i+1].value;
        }
      }
      const speedStr = argsObj.speed?.toFixed?.(4) || argsObj.speed;
      const noteStr = argsObj.note !== undefined ? ` note=${argsObj.note}` : '';
      const freqStr = argsObj.freq !== undefined ? ` freq=${argsObj.freq?.toFixed?.(1)}` : '';
      const sustainStr = argsObj.sustain !== undefined ? ` sustain=${argsObj.sustain?.toFixed?.(3)}` : '';
      const tremStr = argsObj.tremolorate !== undefined ? ` tremolorate=${argsObj.tremolorate?.toFixed?.(2)} tremolodepth=${argsObj.tremolodepth}` : '';
      const envStr = argsObj.attack !== undefined ? ` attack=${argsObj.attack?.toFixed?.(3)} release=${argsObj.release?.toFixed?.(3)}` : '';
      const sfEnvStr = argsObj.sfSustain !== undefined ? ` sfAttack=${argsObj.sfAttack?.toFixed?.(3)} sfRelease=${argsObj.sfRelease?.toFixed?.(3)} sfSustain=${argsObj.sfSustain?.toFixed?.(3)}` : '';
      const instrStr = argsObj.instrument ? ` instrument=${argsObj.instrument}` : '';
      const orbitStr = argsObj.orbit !== undefined ? ` orbit=${argsObj.orbit}` : ' orbit=MISSING';
      const cutoffStr = argsObj.cutoff !== undefined ? ` cutoff=${argsObj.cutoff?.toFixed?.(0)}` : '';
      const shapeStr = argsObj.shape !== undefined ? ` shape=${argsObj.shape?.toFixed?.(2)}` : '';
      console.log(`[osc] SEND: s=${argsObj.s} n=${argsObj.n}${orbitStr} speed=${speedStr}${freqStr}${sustainStr}${noteStr}${cutoffStr}${shapeStr}${tremStr}${envStr}${sfEnvStr}${instrStr} gain=${argsObj.gain?.toFixed?.(2)} t+${secondsFromNow.toFixed(3)}s`);
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
