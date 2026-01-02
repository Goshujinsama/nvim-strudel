// @ts-ignore - osc has no type definitions
import osc from 'osc';
import { processValueForOsc, isBankSoundfont } from './sample-metadata.js';
import { resolveDrumMachineBankSync } from './on-demand-loader.js';
import { captureOscMessage, shouldCaptureOsc } from './file-writer.js';

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
  'white', 'pink', 'brown',
  // ZZFX chip sounds
  'zzfx', 'z_sine', 'z_sawtooth', 'z_triangle', 'z_square', 'z_tan', 'z_noise'
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
 * SuperDirt's dirt_gate applies: amp = amp * gain^4 (where amp=1 by default)
 * 
 * To match volumes, we invert SuperDirt's gain^4 curve:
 * If we want output level L, we need: gain^4 = L
 * So: gain = L^0.25
 */
function convertGainForSuperDirt(superdoughGain: number): number {
  // Invert SuperDirt's gain^4 curve: gain = targetLevel^0.25
  return Math.pow(superdoughGain, 0.25);
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
  
  // Track if we should skip gain conversion (for synths that handle their own gain)
  let skipGainConversion = false;
  
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
    // ZZFX chip sounds - all use strudel_zzfx with different zshape
    'zzfx': 'strudel_zzfx',
    'z_sine': 'strudel_zzfx',
    'z_sawtooth': 'strudel_zzfx',
    'z_triangle': 'strudel_zzfx',
    'z_square': 'strudel_zzfx',
    'z_tan': 'strudel_zzfx',
    'z_noise': 'strudel_zzfx',
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
      } else if (typeof controls.note === 'string') {
        // Parse note name like "c4", "d#5", "eb3"
        const parsed = parseNoteName(controls.note);
        midiNote = parsed !== undefined ? parsed : 60;
      } else {
        midiNote = 60;
      }
      controls.freq = 440 * Math.pow(2, (midiNote - 69) / 12);
    } else if (controls.freq === undefined) {
      // Default frequency: MIDI note 36 (C2 = 65.41 Hz)
      // This matches superdough's synth.mjs default: note: o = 36
      // All synths (including ZZFX) use the same default
      controls.freq = 65.41;  // C2 - superdough default for all synths
    }
    
    // Handle ZZFX-specific parameters
    if (synthInstrument === 'strudel_zzfx') {
      // For ZZFX, Strudel's 'sustain' param is the envelope sustain LEVEL (0-1)
      // We need to pass it as 'sustainLevel' to the SynthDef
      // The note duration (delta) goes to 'sustain' (the time parameter)
      if (controls.sustain !== undefined) {
        controls.sustainLevel = controls.sustain;
      }
      controls.sustain = delta;  // Note duration for envelope timing
      
      // Set zshape based on sound name (0=sin, 1=tri, 2=saw, 3=tan, 4=noise)
      if (controls.zshape === undefined && soundName) {
        controls.zshape = zzfxShapeMap[soundName] ?? 0;
      }
      // For z_square, use saw (shape 2) with shapeCurve 0 to get square-ish wave
      if (soundName === 'z_square' && controls.zshapeCurve === undefined) {
        controls.zshapeCurve = 0;
      }
      
      // ZZFX uses linear gain (volume * sustainLevel), not SuperDirt's gain^4 curve
      // Pass the raw pattern gain as zgain for linear application in SynthDef
      // We set SuperDirt's gain to 1 so its gain module doesn't affect volume
      controls.zgain = controls.gain ?? 0.8;
      controls.gain = 1.0;  // Neutral gain for SuperDirt (1^4 = 1)
      skipGainConversion = true;  // Don't apply convertGainForSuperDirt
      
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
    } else {
      // For non-ZZFX synths (sine, saw, etc.)
      
      // Apply superdough's oscillator gain reduction (0.3) here instead of in SynthDef
      // This matches synth.mjs: const g = gainNode(0.3);
      // The gain will then go through convertGainForSuperDirt() for the gain^4 curve
      controls.gain = (controls.gain ?? 0.8) * 0.3;
      
      // Calculate ADSR values matching superdough's getADSRValues behavior
      // This ensures sustainLevel is set correctly based on which params are specified
      // IMPORTANT: Check rawValue.sustain BEFORE we overwrite controls.sustain with delta
      const patternSustainLevel = typeof rawValue.sustain === 'number' ? rawValue.sustain : undefined;
      const [envAttack, envDecay, envSustainLevel, envRelease] = getADSRValues(
        controls.attack,
        controls.decay,
        patternSustainLevel,  // sustain LEVEL from pattern (0-1), not duration
        controls.release
      );
      
      // Calculate hold time: duration - attack - decay (release extends past)
      const holdTime = Math.max(0.001, delta - envAttack - envDecay);
      
      // Use our custom strudelEnv* params to avoid triggering SuperDirt's dirt_envelope
      // This gives us consistent ADSR behavior for both synths and samples
      controls.strudelEnvAttack = envAttack;
      controls.strudelEnvDecay = envDecay;
      controls.strudelEnvSustainLevel = envSustainLevel;
      controls.strudelEnvRelease = envRelease;
      controls.strudelEnvHold = holdTime;
      
      // Now set sustain to note duration (for SynthDef timing)
      // This controls how long the synth runs before doneAction frees it
      controls.sustain = delta;
      
      // Delete standard envelope params to prevent SuperDirt's dirt_envelope from triggering
      delete controls.attack;
      delete controls.decay;
      delete controls.release;
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
  } else if (!synthInstrument) {
    // Regular samples (not synths, not soundfonts)
    // If attack/release are specified, use our strudel_adsr module instead of dirt_envelope
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
      
      // Calculate hold time: duration - attack - decay (release extends past)
      const holdTime = Math.max(0.001, delta - envAttack - envDecay);
      
      // Use our custom strudelEnv* params to trigger strudel_adsr module
      controls.strudelEnvAttack = envAttack;
      controls.strudelEnvDecay = envDecay;
      controls.strudelEnvSustainLevel = envSustainLevel;
      controls.strudelEnvRelease = envRelease;
      controls.strudelEnvHold = holdTime;
      
      // Delete standard envelope params to prevent dirt_envelope from triggering
      delete controls.attack;
      delete controls.decay;
      delete controls.sustain;
      delete controls.release;
    }
  }
  
  // Now convert gain to SuperDirt's gain curve (applies to most sounds)
  // Skip for ZZFX which handles its own linear gain via zgain
  if (!skipGainConversion) {
    controls.gain = convertGainForSuperDirt(controls.gain);
  }

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
      // Show our strudel ADSR params (strudelEnv*) instead of old attack/decay/release
      const strudelEnvStr = argsObj.strudelEnvAttack !== undefined ? 
        ` env(A=${argsObj.strudelEnvAttack?.toFixed?.(3)} D=${argsObj.strudelEnvDecay?.toFixed?.(3)} S=${argsObj.strudelEnvSustainLevel?.toFixed?.(2)} R=${argsObj.strudelEnvRelease?.toFixed?.(3)} H=${argsObj.strudelEnvHold?.toFixed?.(3)})` : '';
      const sfEnvStr = argsObj.sfSustain !== undefined ? ` sfAttack=${argsObj.sfAttack?.toFixed?.(3)} sfRelease=${argsObj.sfRelease?.toFixed?.(3)} sfSustain=${argsObj.sfSustain?.toFixed?.(3)}` : '';
      const instrStr = argsObj.instrument ? ` instrument=${argsObj.instrument}` : '';
      const orbitStr = argsObj.orbit !== undefined ? ` orbit=${argsObj.orbit}` : ' orbit=MISSING';
      const cutoffStr = argsObj.cutoff !== undefined ? ` cutoff=${argsObj.cutoff?.toFixed?.(0)}` : '';
      const shapeStr = argsObj.shape !== undefined ? ` shape=${argsObj.shape?.toFixed?.(2)}` : '';
      const zshapeStr = argsObj.zshape !== undefined ? ` zshape=${argsObj.zshape}` : '';
      const zgainStr = argsObj.zgain !== undefined ? ` zgain=${argsObj.zgain?.toFixed?.(2)}` : '';
      const sustainLevelStr = argsObj.sustainLevel !== undefined ? ` sustainLevel=${argsObj.sustainLevel?.toFixed?.(2)}` : '';
      const ampStr = argsObj.amp !== undefined ? ` amp=${argsObj.amp?.toFixed?.(2)}` : '';
      console.log(`[osc] SEND: s=${argsObj.s} n=${argsObj.n}${orbitStr} speed=${speedStr}${freqStr}${sustainStr}${sustainLevelStr}${noteStr}${cutoffStr}${shapeStr}${zshapeStr}${zgainStr}${tremStr}${strudelEnvStr}${sfEnvStr}${instrStr} gain=${argsObj.gain?.toFixed?.(2)}${ampStr} t+${secondsFromNow.toFixed(3)}s`);
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
