/**
 * SuperDirt Launcher - Manages SuperCollider/SuperDirt lifecycle
 * 
 * This module handles:
 * - Detecting if sclang (SuperCollider) is installed
 * - Installing SuperDirt quark if needed
 * - Starting SuperDirt with proper settings
 * - Managing the sclang process lifecycle
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import { platform, homedir } from 'os';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Strudel samples cache directory - matches sample-manager.ts
const STRUDEL_SAMPLES_DIR = join(homedir(), '.local', 'share', 'strudel-samples');

// Note: The startup script is generated dynamically by generateStartupScript()
// to allow customization of port, channels, and orbits

export interface SuperDirtLauncherOptions {
  /** Port for SuperDirt to listen on (default: 57120) */
  port?: number;
  /** Number of audio channels (default: 2) */
  channels?: number;
  /** Number of orbits (default: 12) */
  orbits?: number;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Timeout for startup in milliseconds (default: 30000) */
  startupTimeout?: number;
}

export class SuperDirtLauncher {
  private sclangProcess: ChildProcess | null = null;
  private sclangPid: number | null = null;
  private isRunning = false;
  private options: Required<SuperDirtLauncherOptions>;
  private tempScriptPath: string | null = null;
  private weStartedJack = false;

  constructor(options: SuperDirtLauncherOptions = {}) {
    this.options = {
      port: options.port ?? 57120,
      channels: options.channels ?? 2,
      orbits: options.orbits ?? 12,
      verbose: options.verbose ?? false,
      startupTimeout: options.startupTimeout ?? 30000,
    };
  }

  /**
   * Check if sclang (SuperCollider) is available on the system
   */
  static isSclangAvailable(): boolean {
    try {
      execSync('which sclang', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if StrudelDirt quark is installed (specifically, not just SuperDirt)
   * StrudelDirt is a fork of SuperDirt with Strudel-specific enhancements
   */
  static isStrudelDirtInstalled(): boolean {
    const home = process.env.HOME || '';
    // StrudelDirt installs as 'StrudelDirt' in the quarks directory
    const strudelDirtPath = join(home, '.local', 'share', 'SuperCollider', 'downloaded-quarks', 'StrudelDirt');
    return existsSync(strudelDirtPath);
  }

  /**
   * Check if regular SuperDirt quark is installed (for fallback)
   */
  static isSuperDirtQuarkInstalled(): boolean {
    const home = process.env.HOME || '';
    const superDirtPath = join(home, '.local', 'share', 'SuperCollider', 'downloaded-quarks', 'SuperDirt');
    return existsSync(superDirtPath);
  }

  /**
   * Check if any SuperDirt variant is installed (StrudelDirt or SuperDirt)
   */
  static isAnyDirtInstalled(): boolean {
    return SuperDirtLauncher.isStrudelDirtInstalled() || SuperDirtLauncher.isSuperDirtQuarkInstalled();
  }

  /**
   * Check if SuperDirt quark is installed (legacy alias)
   * @deprecated Use isAnyDirtInstalled() or isStrudelDirtInstalled() instead
   */
  static isSuperDirtInstalled(): boolean {
    return SuperDirtLauncher.isAnyDirtInstalled();
  }

  /**
   * Install StrudelDirt quark from GitHub (blocking operation)
   * StrudelDirt is a REPLACEMENT for SuperDirt (fork with Strudel-specific features):
   * - supersaw, superpulse, pulse, sawtooth, triangle synths
   * - Filter envelopes (lpenv, hpenv, bpenv)
   * - Juno 60 chorus emulation
   * - Improved gain staging and filter behavior
   * 
   * IMPORTANT: StrudelDirt and SuperDirt cannot coexist - they have duplicate classes.
   * This function will uninstall SuperDirt if present before installing StrudelDirt.
   * 
   * Returns true if successful, false otherwise
   */
  static installStrudelDirt(): boolean {
    // First, uninstall regular SuperDirt if it exists (they cannot coexist)
    if (SuperDirtLauncher.isSuperDirtQuarkInstalled()) {
      console.log('[strudeldirt] Removing standard SuperDirt quark (StrudelDirt replaces it)...');
      try {
        execSync('echo \'Quarks.uninstall("SuperDirt"); 0.exit;\' | sclang', {
          stdio: 'inherit',
          timeout: 60000,
        });
        console.log('[strudeldirt] SuperDirt quark removed');
      } catch (err) {
        console.warn('[strudeldirt] Failed to uninstall SuperDirt via Quarks, removing directory...');
        // Try direct removal if Quarks.uninstall fails
        try {
          const superDirtPath = join(process.env.HOME || '', '.local', 'share', 'SuperCollider', 'downloaded-quarks', 'SuperDirt');
          execSync(`rm -rf "${superDirtPath}"`, { stdio: 'inherit' });
          console.log('[strudeldirt] SuperDirt directory removed');
        } catch (rmErr) {
          console.error('[strudeldirt] Could not remove SuperDirt:', rmErr);
        }
      }
    }

    console.log('[strudeldirt] Installing StrudelDirt quark from GitHub...');
    try {
      // Install StrudelDirt from daslyfe's fork
      // This also installs dependencies (Vowel, etc.)
      execSync('echo \'Quarks.install("https://github.com/daslyfe/StrudelDirt"); 0.exit;\' | sclang', {
        stdio: 'inherit',
        timeout: 180000, // 3 minute timeout (StrudelDirt is larger)
      });
      console.log('[strudeldirt] StrudelDirt quark installed successfully');
      return true;
    } catch (err) {
      console.error('[strudeldirt] Failed to install StrudelDirt:', err);
      // Fall back to regular SuperDirt
      console.log('[strudeldirt] Falling back to standard SuperDirt...');
      return SuperDirtLauncher.installSuperDirtFallback();
    }
  }

  /**
   * Install standard SuperDirt quark as fallback
   */
  private static installSuperDirtFallback(): boolean {
    console.log('[superdirt] Installing SuperDirt quark...');
    try {
      execSync('echo \'Quarks.install("SuperDirt"); 0.exit;\' | sclang', {
        stdio: 'inherit',
        timeout: 120000, // 2 minute timeout
      });
      console.log('[superdirt] SuperDirt quark installed successfully');
      return true;
    } catch (err) {
      console.error('[superdirt] Failed to install SuperDirt:', err);
      return false;
    }
  }

  /**
   * Install SuperDirt quark (legacy alias)
   * @deprecated Use installStrudelDirt() instead
   */
  static installSuperDirt(): boolean {
    return SuperDirtLauncher.installStrudelDirt();
  }

  /**
   * Generate the startup script with current options
   * Includes Strudel sample loading handler for dynamic sample loading
   * and custom SynthDefs for ADSR envelope support
   */
  private generateStartupScript(): string {
    const { port, channels, orbits } = this.options;
    
    // Escape the path for SuperCollider string
    const escapedSamplesDir = STRUDEL_SAMPLES_DIR.replace(/\\/g, '\\\\');
    
    return `(
// Kill any existing servers to ensure clean state
// This is important because server options must be set BEFORE boot
Server.killAll;

// Optimized server settings for heavy sample usage
// MUST be set before boot, otherwise defaults are used
s.options.numBuffers = 1024 * 256;  // 262144 buffers for samples
s.options.memSize = 8192 * 32;      // 256MB memory
s.options.numWireBufs = 128;        // More interconnect buffers
s.options.maxNodes = 1024 * 32;     // 32768 nodes

"Server options configured, booting server...".postln;

s.waitForBoot {
    "*** SuperCollider server booted ***".postln;
    
    // Increase latency to avoid "late" messages
    s.latency = 0.3;
    
    ~dirt = SuperDirt(${channels}, s);
    ~dirt.loadSoundFiles;
    
    // Load Strudel samples cache if it exists
    ~strudelSamplesPath = "${escapedSamplesDir}";
    if(File.exists(~strudelSamplesPath), {
        "Loading Strudel samples from: %".format(~strudelSamplesPath).postln;
        ~dirt.loadSoundFiles(~strudelSamplesPath +/+ "*");
    }, {
        "Strudel samples cache not found (will be created when samples are loaded)".postln;
    });
    
    s.sync;
    ~dirt.start(${port}, 0 ! ${orbits});
    
    // ========================================
    // Strudel Soundfont SynthDefs
    // These loop samples and apply ADSR envelope - used for soundfont instruments
    // Regular samples use the default dirt_sample SynthDefs (no looping)
    // ========================================
    
    (1..SuperDirt.maxSampleNumChannels).do { |sampleNumChannels|
      var name = format("strudel_soundfont_%_%", sampleNumChannels, ${channels});
      
      // Soundfont synth: plays from start then loops in sustain region, with ADSR envelope
      // Matches WebAudio BufferSourceNode loop behavior:
      // 1. Play from buffer start (attack phase)
      // 2. When reaching loopEnd, jump back to loopStart
      // 3. Continue looping within [loopStart, loopEnd] until note ends
      // sfLoopBegin/sfLoopEnd: normalized 0-1 positions for sustain loop region
      // If no loop points (sfLoopBegin == sfLoopEnd == 0), loops entire sample
      SynthDef(name, { |out, bufnum, sustain = 1, begin = 0, end = 1, speed = 1, endSpeed = 1, 
                        freq = 440, pan = 0, sfSustain = 1,
                        sfLoopBegin = 0, sfLoopEnd = 0|
        var sound, rate, phase, numFrames, env, phasorRate;
        var hasLoop, loopStartFrame, loopEndFrame, loopLen;
        var rawPos, loopOffset, modPos;
        
        numFrames = BufFrames.ir(bufnum).max(1);
        
        // Use speed directly - it's already pitch-adjusted
        rate = Line.kr(speed, endSpeed, sfSustain);
        
        // Phasor rate: samples to advance per audio sample
        phasorRate = rate * BufRateScale.ir(bufnum);
        
        // Check if we have valid loop points
        hasLoop = (sfLoopEnd > sfLoopBegin) * (sfLoopEnd > 0);
        
        // Calculate loop positions in frames
        loopStartFrame = sfLoopBegin * numFrames;
        loopEndFrame = sfLoopEnd * numFrames;
        loopLen = (loopEndFrame - loopStartFrame).max(1);
        
        // Simpler approach: use Phasor that counts continuously, then apply modular arithmetic
        // rawPos tracks continuous position (never resets)
        rawPos = Phasor.ar(0, phasorRate, 0, 1e9, 0);
        
        // Calculate how much past loopEndFrame we are (0 before loopEnd)
        loopOffset = (rawPos - loopEndFrame).max(0);
        
        // In loop phase: loopStartFrame + (offset % loopLen)
        // In attack phase: rawPos (when loopOffset is 0)
        modPos = loopStartFrame + (loopOffset % loopLen);
        
        // Select: if in attack phase (rawPos < loopEndFrame), use rawPos; else use modPos
        // We use a soft comparison to avoid artifacts
        phase = Select.ar(hasLoop, [
          // No loop points: simple non-looping playback
          Phasor.ar(0, phasorRate, begin * numFrames, end * numFrames, begin * numFrames),
          // Has loop points: use rawPos until loopEnd, then loop
          // This uses the fact that when rawPos < loopEndFrame, loopOffset = 0
          // and modPos = loopStartFrame, so we need to choose rawPos instead
          Select.ar(rawPos >= loopEndFrame, [
            rawPos,     // Attack phase: play from start  
            modPos      // Loop phase: modular position in loop region
          ])
        ]);
        
        // Use linear interpolation (2) to match WebAudio's simple 2-point interpolation
        // WebAudio uses linear interpolation for pitch-shifted playback, not sinc or cubic
        // (verified by examining Chromium's audio_buffer_source_handler.cc)
        sound = BufRd.ar(
          numChannels: sampleNumChannels,
          bufnum: bufnum,
          phase: phase,
          loop: 0,
          interpolation: 2
        );
        
        // NO internal envelope - StrudelDirt's strudel_envelope module applies ADSR to all sounds
        // This envelope is flat (level=1) and just controls synth duration via doneAction
        // The actual amplitude shaping happens in the strudel_envelope module
        env = EnvGen.kr(
          Env.new([1, 1], [sfSustain + 0.1], \\lin),
          doneAction: 2
        );
        
        sound = sound * env;
        // DirtPan applies Balance2 for stereo, reducing each channel by sqrt(0.5) at center.
        // For mono samples (which get panned to stereo via Pan2), this -3dB is compensated
        // by sqrt(2) gain boost in osc-output.ts when no pan is specified.
        //
        // Stereo soundfont samples need an EXTRA sqrt(2) multiplier here because:
        // - WebAudio only adds a StereoPannerNode when pan is explicitly set
        // - When pan is undefined, WebAudio passes stereo through unchanged (no -3dB)
        // - But SuperDirt always applies DirtPan, even for stereo samples
        // - So soundfonts get an extra -3dB that needs compensation in the synth itself
        //
        // This sqrt(2) in the synth + the sqrt(2) in osc-output.ts (for no-pan case)
        // together cancel out Balance2's -3dB and add the expected center boost.
        sound = DirtPan.ar(sound, ${channels}, pan) * sqrt(2);
        
        Out.ar(out, sound)
      }, [\\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr, \\ir, \\ir, \\ir]).add;
      
      ("Strudel: Added " ++ name).postln;
    };
    
    // ========================================
    // Soundfont Diversion - bypasses SuperDirt's hardcoded sample args
    // SuperDirt's 'sound' module hardcodes the args it passes to sample synths,
    // which means our sfLoopBegin/sfLoopEnd params never reach the synth.
    // This diversion intercepts soundfont instruments and plays them with all params.
    // ========================================
    
    // Set up a diversion for soundfont instruments within the 'sound' module
    // The sound module checks ~diversion.value first - if it returns non-nil, 
    // the module skips its hardcoded args processing.
    // This is different from the event-level ~diversion in defaultParentEvent.
    // We set ~diversion in the soundEvent (returned by getEvent) for our soundfont samples.
    //
    // When SuperDirt loads our samples, we register them with a custom soundEvent
    // that includes the diversion function to pass sfLoopBegin/sfLoopEnd.
    //
    // Alternative approach: Override how the sound module processes soundfont instruments
    // by adding a module that runs BEFORE 'sound' and sets ~diversion for soundfonts.
    ~dirt.addModule('strudel_soundfont_diversion',
      { |dirtEvent|
        // Only for soundfont instruments, set up a diversion that passes all params
        if(~instrument.asString.beginsWith("strudel_soundfont") and: { ~buffer.notNil }, {
          // Instead of setting ~diversion (which requires the sound module to call it),
          // we play the synth directly and set a flag to skip sound module
          var desc = SynthDescLib.global.at(~instrument.asSymbol);
          if(desc.notNil, {
            // Set ~bufnum from ~buffer so msgFunc.valueEnvir finds it
            ~bufnum = ~buffer;
            dirtEvent.sendSynth(~instrument, desc.msgFunc.valueEnvir);
            // IMPORTANT: Set ~buffer to nil so sound module doesn't also play
            ~buffer = nil;
            // Also set ~diversion to skip sound module (belt and suspenders)
            ~diversion = { true };
          });
        });
      },
      { ~instrument.asString.beginsWith("strudel_soundfont") }  // test function
    );
    "*** Soundfont diversion module added (passes sfLoopBegin/sfLoopEnd to synth) ***".postln;
    
    // Note: Module ordering is done later after all modules are added
    // (see orderModules call after strudel_tremolo module)
    
    // Add specs for the loop params
    Spec.add(\\sfLoopBegin, [0, 1]);
    Spec.add(\\sfLoopEnd, [0, 1]);
    Spec.add(\\sfAttack, [0.001, 10, \\exp]);
    Spec.add(\\sfRelease, [0.001, 10, \\exp]);
    Spec.add(\\sfSustain, [0.001, 60, \\exp]);
    
    s.sync;  // Ensure soundfont SynthDefs are registered with server
    "*** Strudel soundfont SynthDefs loaded ***".postln;
    
    // ========================================
    // NOTE: Basic oscillator synths (sine, sawtooth, square, triangle, pulse, supersaw, noise)
    // are provided by StrudelDirt quark. We only define our custom synths here.
    // StrudelDirt synth names: sine, sawtooth, triangle, pulse, supersaw, superpulse, white, pink, brown, sbd2
    // ========================================
    
    s.sync;
    
    // ========================================
    // ZZFX Chip Sound Synth
    // Exact port of ZzFX algorithm from zzfx_fork.mjs
    // https://github.com/KilledByAPixel/ZzFX
    // NO internal envelope - StrudelDirt's strudel_envelope module applies ADSR
    // ========================================
    
    SynthDef(\\strudel_zzfx, { |out, freq = 220, sustain = 1, pan = 0, speed = 1,
                               zshape = 0, zshapeCurve = 1, zslide = 0, zdeltaSlide = 0,
                               zrand = 0, znoise = 0, zmod = 0,
                               zpitchJump = 0, zpitchJumpTime = 0|
      var sound;
      var pi2, sampleRate;
      var freqRadians, slide, deltaSlide, modulation, noise;
      var phase, freqAccum, slideAccum, modPhase, f;
      var waveSin, waveTri, waveSaw, waveTan, waveNoise;
      var sampleIndex;
      
      pi2 = 2pi;
      sampleRate = SampleRate.ir;
      
      // Convert frequency to radians/sample (like ZZFX line 32)
      freqRadians = freq * (1 + (zrand * 2 * Rand(-1, 1))) * pi2 / sampleRate;
      
      // Scale slide params (like ZZFX lines 31, 50)
      slide = zslide * (500 * pi2) / (sampleRate * sampleRate);
      deltaSlide = zdeltaSlide * (500 * pi2) / (sampleRate ** 3);
      
      // modulation *= PI2 / sampleRate
      modulation = zmod * pi2 / sampleRate;
      
      // noise param (for phase jitter)
      noise = znoise;
      
      // Phase accumulator using Integrator for cumulative slide
      slideAccum = Integrator.ar(K2A.ar(deltaSlide), 1) + slide;
      freqAccum = Integrator.ar(slideAccum, 1) + freqRadians;
      
      // Modulation: f = frequency * cos(modulation * tm++)
      modPhase = Phasor.ar(0, modulation, 0, inf);
      f = freqAccum * cos(modPhase);
      
      // Phase with noise jitter
      sampleIndex = Phasor.ar(0, 1, 0, inf);
      phase = Integrator.ar(
        f * (1 - (noise * (1 - (((sin(sampleIndex) + 1) * 1e9) % 2)))),
        1
      );
      
      // ZZFX waveform formulas
      waveSin = sin(phase);
      waveTri = 1 - (4 * abs((phase / pi2).round(1) - (phase / pi2)));
      waveSaw = 1 - (((((2 * phase / pi2) % 2) + 2) % 2));
      waveTan = tan(phase).clip(-1, 1);
      waveNoise = sin(((phase % pi2) ** 3));
      
      // Select waveform based on zshape
      sound = Select.ar(zshape.clip(0, 4), [
        waveSin, waveTri, waveSaw, waveTan, waveNoise
      ]);
      
      // Apply shape curve
      sound = sound.sign * (sound.abs ** zshapeCurve.max(0.01));
      
      // Apply ZZFX base volume (0.25)
      sound = sound * 0.25;
      
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_zzfx".postln;
    
    s.sync;  // Ensure ZZFX SynthDef is registered with server
    "*** Strudel ZZFX SynthDef loaded ***".postln;
    
    // ========================================
    // ByteBeat Synth - 8-bit style procedural audio
    // Implements the 15 built-in presets from superdough
    // Custom expressions (bbexpr) require WebAudio fallback
    // ========================================
    
    SynthDef(\\strudel_bytebeat, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                   bbPreset = 0, bbStartTime = 0|
      var sound, t, tIncr, sampleRate, pi2;
      var preset0, preset1, preset2, preset3, preset4, preset5, preset6, preset7;
      var preset8, preset9, preset10, preset11, preset12, preset13, preset14;
      var presetIdx, rawValue;
      
      pi2 = 2pi;
      sampleRate = SampleRate.ir;
      
      // t increments at: (sampleRate / 256) * freq samples per second
      // This matches superdough's: local_t = (t / (sampleRate / 256)) * freq + initialOffset
      // Since we're in SC, we use Phasor to generate continuous t
      tIncr = freq / (sampleRate / 256);
      t = Phasor.ar(0, tIncr, 0, 1e12, bbStartTime);
      
      // Pre-compute all 15 presets (matching superdough/synth.mjs lines 219-235)
      // Formula: funcValue = preset(t); signal = (funcValue & 255) / 127.5 - 1
      // SC doesn't have bitwise AND for audio rate, so we use mod(256)
      // and round to simulate integer truncation
      
      // Preset 0: '(t%255 >= t/255%255)*255'
      preset0 = ((t % 255) >= ((t / 255) % 255)) * 255;
      
      // Preset 1: '(t*(t*8%60 <= 300)|(-t)*(t*4%512 < 256))+t/400'
      // Complex bitwise OR - approximate with addition
      preset1 = (t * ((t * 8 % 60) <= 300)) + (t.neg * ((t * 4 % 512) < 256)) + (t / 400);
      
      // Preset 2: 't' - simple sawtooth
      preset2 = t;
      
      // Preset 3: 't*(t >> 10^t)' - classic bytebeat
      // >> is integer right shift, ^ is XOR - approximate with division and mod
      preset3 = t * (((t / 1024).floor % 256) * t % 256);
      
      // Preset 4: 't&128' - square wave at 128 boundary
      preset4 = (t % 256) >= 128 * 128;
      
      // Preset 5: 't&t>>8' - classic cascade
      preset5 = (t % 256) * ((t / 256).floor % 256) % 256;
      
      // Preset 6: '((t%255+t%128+t%64+t%32+t%16+t%127.8+t%64.8+t%32.8+t%16.8)/3)'
      preset6 = ((t % 255) + (t % 128) + (t % 64) + (t % 32) + (t % 16) + 
                 (t % 127.8) + (t % 64.8) + (t % 32.8) + (t % 16.8)) / 3;
      
      // Preset 7: '((t%64+t%63.8+t%64.15+t%64.35+t%63.5)/1.25)'
      preset7 = ((t % 64) + (t % 63.8) + (t % 64.15) + (t % 64.35) + (t % 63.5)) / 1.25;
      
      // Preset 8: '(t&(t>>7)-t)' - difference pattern
      preset8 = ((t % 256) * ((t / 128).floor % 256) - t) % 256;
      
      // Preset 9: '(sin(t*PI/128)*127+127)' - sine wave
      preset9 = (sin(t * pi / 128) * 127) + 127;
      
      // Preset 10: '((t^t/2+t+64*(sin((t*PI/64)+(t*PI/32768))+64))%128*2)'
      preset10 = (((t % 256) * ((t / 2).floor % 256) + t + 64 * (sin((t * pi / 64) + (t * pi / 32768)) + 64)) % 128) * 2;
      
      // Preset 11: '((t^t/2+t+64*(cos >> 0))%127.85*2)' - note: 'cos >> 0' is malformed, using cos(t)
      preset11 = (((t % 256) * ((t / 2).floor % 256) + t + 64 * cos(t).floor) % 127.85) * 2;
      
      // Preset 12: '((t^t/2+t+64)%128*2)'
      preset12 = (((t % 256) * ((t / 2).floor % 256) + t + 64) % 128) * 2;
      
      // Preset 13: '(((t * .25)^(t * .25)/100+(t * .25))%128)*2'
      preset13 = ((((t * 0.25) % 256) * (((t * 0.25) / 100).floor % 256) + (t * 0.25)) % 128) * 2;
      
      // Preset 14: '((t^t/2+t+64)%7 * 24)'
      preset14 = (((t % 256) * ((t / 2).floor % 256) + t + 64) % 7) * 24;
      
      // Select preset using index
      presetIdx = bbPreset.clip(0, 14);
      rawValue = SelectX.ar(presetIdx, [
        preset0, preset1, preset2, preset3, preset4, preset5, preset6, preset7,
        preset8, preset9, preset10, preset11, preset12, preset13, preset14
      ]);
      
      // Convert to audio: (value & 255) / 127.5 - 1
      // Use mod 256 instead of bitwise AND
      sound = (rawValue % 256) / 127.5 - 1;
      
      // Apply gain of 0.2 and clip to [-0.4, 0.4] (matches superdough)
      sound = (sound * 0.2).clip(-0.4, 0.4);
      
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_bytebeat".postln;
    
    // ========================================
    // NOTE: Pulse, Supersaw, and Synthesized Bass Drum synths
    // are provided by StrudelDirt quark:
    // - pulse: PWM synth with z1/z2/z3 params
    // - supersaw: Detuned unison sawtooth  
    // - sbd2: Synthesized bass drum
    // ========================================
    
    s.sync;  // Ensure custom synths are registered
    
    // ========================================
    // Strudel Filter Module (for SAMPLES and SYNTHS)
    // Applies HPF/LPF/BPF filtering when strudelHpf/strudelLpf/strudelBpf params are present
    // Uses custom parameter names to avoid triggering SuperDirt's dirt_lpf/dirt_hpf modules
    // This is a single module that handles all filtering, rather than duplicating
    // filter code in every SynthDef
    // 
    // The filter uses 12dB/octave resonant filters (RLPF/RHPF) to match superdough.
    // At extreme values (LPF at 20kHz, HPF at 20Hz), filters are essentially transparent.
    //
    // Filter envelope support:
    // - strudelLpEnv/strudelHpEnv/strudelBpEnv: envelope amount in octaves (can be negative)
    // - strudelLpAttack/strudelHpAttack/strudelBpAttack: attack time
    // - strudelLpDecay/strudelHpDecay/strudelBpDecay: decay time  
    // - strudelLpSustain/strudelHpSustain/strudelBpSustain: sustain level (0-1)
    // - strudelLpRelease/strudelHpRelease/strudelBpRelease: release time
    // - strudelFanchor: anchor point (0=env sweeps up from cutoff, 1=sweeps down, 0.5=centered)
    // ========================================
    
    SynthDef("strudel_filter" ++ ${channels}, { |out, sustain = 1,
                                                 strudelLpf = 20000, strudelHpf = 20,
                                                 strudelLpq = 1, strudelHpq = 1,
                                                 strudelBpf = 0, strudelBpq = 1,
                                                 strudelLpEnv = 0, strudelHpEnv = 0, strudelBpEnv = 0,
                                                 strudelLpAttack = 0.005, strudelLpDecay = 0.14,
                                                 strudelLpSustain = 0, strudelLpRelease = 0.1,
                                                 strudelHpAttack = 0.005, strudelHpDecay = 0.14,
                                                 strudelHpSustain = 0, strudelHpRelease = 0.1,
                                                 strudelBpAttack = 0.005, strudelBpDecay = 0.14,
                                                 strudelBpSustain = 0, strudelBpRelease = 0.1,
                                                 strudelFanchor = 0,
                                                 strudelFtype = 0,
                                                 strudelDjf = -1|
      var signal, rqLpf, rqHpf, rqBpf, lpfFreq, hpfFreq, bpfFreq;
      var lpfEnvFreq, hpfEnvFreq, bpfEnvFreq;
      var ladderRes, ladderFiltered, standardFiltered;
      
      signal = In.ar(out, ${channels});
      
      // DJF (DJ Filter) - crossfade between LPF and HPF
      // djf < 0.49 = lowpass, djf > 0.51 = highpass, 0.49-0.51 = neutral
      // Cutoff formula from superdough: (v * 11)^4
      // strudelDjf = -1 means disabled (default), 0-1 means active
      signal = Select.ar(strudelDjf >= 0, [
        signal,  // DJF disabled - pass through unchanged
        {
          // Calculate v and cutoff based on djf value
          // For lowpass (djf < 0.49): v = djf * 2
          // For highpass (djf > 0.51): v = (djf - 0.5) * 2
          var isLowpass = strudelDjf < 0.49;
          var isHighpass = strudelDjf > 0.51;
          var isNeutral = (strudelDjf >= 0.49) * (strudelDjf <= 0.51);
          var lpV = (strudelDjf * 2).clip(0, 1);
          var hpV = ((strudelDjf - 0.5) * 2).clip(0, 1);
          var lpCut = ((lpV * 11) ** 4).clip(20, 20000);
          var hpCut = ((hpV * 11) ** 4).clip(20, 20000);
          
          // Apply LPF, HPF, or pass through based on djf value
          // Using BLowPass/BHiPass (biquad) to match WebAudio's BiquadFilterNode
          var filteredLp = BLowPass.ar(signal, lpCut, 0.7);
          var filteredHp = BHiPass.ar(signal, hpCut, 0.7);
          
          Select.ar(isLowpass, [
            Select.ar(isHighpass, [signal, filteredHp]),
            filteredLp
          ])
        }.value
      ]);
      
      // Convert Q to rq for SuperCollider filters
      // WebAudio BiquadFilter uses Q directly, SC filters use rq = 1/Q
      // For LPF/HPF using BLowPass/BHiPass: 1/sqrt(Q) mapping reduces resonance gain
      // For BPF: use 1/Q directly (standard reciprocal quality factor)
      rqLpf = (1/strudelLpq.max(0.001).sqrt).clip(0.01, 2);
      rqHpf = (1/strudelHpq.max(0.001).sqrt).clip(0.01, 2);
      rqBpf = (1/strudelBpq.max(0.001)).clip(0.01, 2);
      
      // Base frequencies
      lpfFreq = strudelLpf.clip(20, 20000);
      hpfFreq = strudelHpf.clip(20, 20000);
      bpfFreq = strudelBpf.clip(20, 20000);
      
      // Apply filter envelopes using StrudelUtils.calculateCutoff from StrudelDirt
      // This gives us their tested envelope implementation with proper gate timing
      // StrudelUtils.calculateCutoff(cutoff, anchor, envamt, hold, holdtime, attack, decay, release, cutmin, cutmax)
      // - cutoff: base frequency
      // - anchor: envelope pivot point (0=up from cutoff, 1=down, 0.5=centered)
      // - envamt: envelope amount in octaves
      // - hold: sustain level (0-1)
      // - holdtime: note duration (sustain param)
      // - attack, decay, release: envelope times
      // - cutmin, cutmax: frequency limits
      
      // LPF envelope - use StrudelUtils if envelope is active, otherwise base frequency
      lpfEnvFreq = Select.kr(strudelLpEnv.abs > 0.001, [
        lpfFreq,
        StrudelUtils.calculateCutoff(
          lpfFreq, strudelFanchor, strudelLpEnv,
          strudelLpSustain, sustain,
          strudelLpAttack, strudelLpDecay, strudelLpRelease,
          20, 20000
        )
      ]);
      
      // HPF envelope
      hpfEnvFreq = Select.kr(strudelHpEnv.abs > 0.001, [
        hpfFreq,
        StrudelUtils.calculateCutoff(
          hpfFreq, strudelFanchor, strudelHpEnv,
          strudelHpSustain, sustain,
          strudelHpAttack, strudelHpDecay, strudelHpRelease,
          20, 20000
        )
      ]);
      
      // BPF envelope
      bpfEnvFreq = Select.kr(strudelBpEnv.abs > 0.001, [
        bpfFreq,
        StrudelUtils.calculateCutoff(
          bpfFreq, strudelFanchor, strudelBpEnv,
          strudelBpSustain, sustain,
          strudelBpAttack, strudelBpDecay, strudelBpRelease,
          20, 20000
        )
      ]);
      
      // Apply filters
      // LPF and HPF always applied (with neutral defaults: LPF=20000, HPF=20)
      // strudelFtype: 0 = 12dB/oct (single filter), 1 = 24dB/oct (cascade two filters), 2 = ladder (MoogFF)
      
      // Ladder filter mode (strudelFtype == 2)
      // MoogFF is a Moog-style 24dB/oct lowpass with self-oscillation capability
      // It takes resonance as a value from 0-4 (not rq), so we use Q directly scaled to 0-4
      // The drive/saturation is applied via tanh distortion after the filter
      ladderRes = (strudelLpq * 0.4).clip(0, 4);  // Scale Q (typically 0-10) to MoogFF res (0-4)
      ladderFiltered = MoogFF.ar(signal, lpfEnvFreq, ladderRes);
      // Apply soft saturation similar to superdough's ladder processor
      ladderFiltered = ladderFiltered.tanh;
      
      // Standard filter mode (12dB or 24dB biquad)
      // Using BLowPass (Butterworth biquad) to match WebAudio's BiquadFilterNode
      standardFiltered = BLowPass.ar(signal, lpfEnvFreq, rqLpf);
      standardFiltered = Select.ar(strudelFtype > 0, [
        standardFiltered,
        BLowPass.ar(standardFiltered, lpfEnvFreq, rqLpf)  // Second pass for 24dB slope
      ]);
      
      // Select between ladder and standard filter based on strudelFtype
      signal = Select.ar((strudelFtype >= 2).asInteger, [standardFiltered, ladderFiltered]);
      
      // Using BHiPass (Butterworth biquad) instead of RHPF for better WebAudio parity
      signal = BHiPass.ar(signal, hpfEnvFreq, rqHpf);
      signal = Select.ar((strudelFtype == 1).asInteger, [
        signal,
        BHiPass.ar(signal, hpfEnvFreq, rqHpf)  // Second pass for 24dB slope (only in 24db mode, not ladder)
      ]);
      
      // BPF only applied when strudelBpf > 0 (default is 0 = disabled)
      // Uses envelope-modulated frequency
      // Also cascades when strudelFtype > 0 for 24dB slope
      // Note: SC's BPF has Q-dependent gain characteristics that differ from WebAudio
      // This is an inherent difference - we use the same rq mapping as LPF/HPF
      signal = Select.ar(strudelBpf > 0, [
        signal,
        Select.ar(strudelFtype > 0, [
          BPF.ar(signal, bpfEnvFreq, rqBpf),
          BPF.ar(BPF.ar(signal, bpfEnvFreq, rqBpf), bpfEnvFreq, rqBpf)  // Cascade for 24dB
        ])
      ]);
      
      ReplaceOut.ar(out, signal);
    }, [\\ir, \\ir, \\kr, \\kr, \\kr, \\kr, \\kr, \\kr, \\kr, \\kr, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr]).add;
    "Added: strudel_filter${channels} (with envelope support, BPF, 24dB mode, ladder filter, and DJF)".postln;
    
    // Register the strudel_filter module with SuperDirt
    // This module triggers when strudelLpf, strudelHpf, strudelBpf, or strudelDjf parameters are present
    // and applies our filters INSTEAD of SuperDirt's dirt_lpf/dirt_hpf/dirt_bpf modules
    ~dirt.addModule('strudel_filter',
      { |dirtEvent|
        dirtEvent.sendSynth('strudel_filter' ++ ${channels},
          [
            sustain: ~sustain ? 1,
            strudelLpf: ~strudelLpf ? 20000,
            strudelHpf: ~strudelHpf ? 20,
            strudelLpq: ~strudelLpq ? 1,
            strudelHpq: ~strudelHpq ? 1,
            strudelBpf: ~strudelBpf ? 0,
            strudelBpq: ~strudelBpq ? 1,
            strudelLpEnv: ~strudelLpEnv ? 0,
            strudelHpEnv: ~strudelHpEnv ? 0,
            strudelBpEnv: ~strudelBpEnv ? 0,
            strudelLpAttack: ~strudelLpAttack ? 0.005,
            strudelLpDecay: ~strudelLpDecay ? 0.14,
            strudelLpSustain: ~strudelLpSustain ? 0,
            strudelLpRelease: ~strudelLpRelease ? 0.1,
            strudelHpAttack: ~strudelHpAttack ? 0.005,
            strudelHpDecay: ~strudelHpDecay ? 0.14,
            strudelHpSustain: ~strudelHpSustain ? 0,
            strudelHpRelease: ~strudelHpRelease ? 0.1,
            strudelBpAttack: ~strudelBpAttack ? 0.005,
            strudelBpDecay: ~strudelBpDecay ? 0.14,
            strudelBpSustain: ~strudelBpSustain ? 0,
            strudelBpRelease: ~strudelBpRelease ? 0.1,
            strudelFanchor: ~strudelFanchor ? 0,
            strudelFtype: ~strudelFtype ? 0,
            strudelDjf: ~strudelDjf ? -1,
            out: ~out
          ])
      }, { ~strudelLpf.notNil || ~strudelHpf.notNil || ~strudelBpf.notNil || ~strudelDjf.notNil });
    "*** Strudel filter module registered (with envelope support, BPF, 24dB mode, ladder filter, and DJF) ***".postln;
    
    // ========================================
    // Strudel Tremolo Module (for SAMPLES and SYNTHS)
    // Matches superdough's tremolo implementation with LFO shapes
    // Uses custom parameter names to avoid triggering SuperDirt's dirt_tremolo
    //
    // Parameters:
    // - strudelTremRate: LFO frequency in Hz
    // - strudelTremDepth: modulation depth (0-1, can exceed 1 for clipping effects)
    // - strudelTremSkew: triangle wave skew (0-1, 0.5 = symmetric)
    // - strudelTremPhase: phase offset (0-1)
    // - strudelTremShape: waveform (0=tri, 1=sine, 2=ramp, 3=saw, 4=square)
    //
    // superdough tremolo behavior:
    // - Base gain = max(1 - depth, 0)
    // - LFO adds to base gain with range [0, depth]
    // - Result: amplitude modulates between (1-depth) and 1
    // ========================================
    
    SynthDef("strudel_tremolo" ++ ${channels}, { |out,
                                                  strudelTremRate = 1, strudelTremDepth = 1,
                                                  strudelTremSkew = 0.5, strudelTremPhase = 0,
                                                  strudelTremShape = 0|
      var signal, lfo, phase, baseGain, modGain;
      var triLfo, sineLfo, rampLfo, sawLfo, squareLfo;
      var shapeIdx;
      
      signal = In.ar(out, ${channels});
      
      // Calculate phase with offset
      phase = Phasor.ar(0, strudelTremRate / SampleRate.ir, 0, 1);
      phase = (phase + strudelTremPhase).mod(1);
      
      // Pre-compute all LFO shapes (all are audio rate since phase is audio rate)
      
      // 0: Triangle with skew
      // When phase < skew: ramp up from 0 to 1
      // When phase >= skew: ramp down from 1 to 0
      triLfo = (phase < strudelTremSkew).if(
        phase / strudelTremSkew.max(0.001),
        1 - ((phase - strudelTremSkew) / (1 - strudelTremSkew).max(0.001))
      );
      
      // 1: Sine (0-1 range like superdough)
      sineLfo = (1 + (phase * 2pi).sin) * 0.5;
      
      // 2: Ramp (0 to 1)
      rampLfo = phase;
      
      // 3: Saw (1 to 0)
      sawLfo = 1 - phase;
      
      // 4: Square with skew (duty cycle)
      squareLfo = (phase < strudelTremSkew).if(1, 0);
      
      // Select shape using index
      shapeIdx = strudelTremShape.round.clip(0, 4);
      lfo = SelectX.ar(shapeIdx, [triLfo, sineLfo, rampLfo, sawLfo, squareLfo]);
      
      // Match the worklet ordering exactly: multiply by depth, apply the
      // 1.5 curve, then clamp the modulator to [0, 1].
      lfo = (lfo * strudelTremDepth).max(0).pow(1.5).clip(0, 1);

      // superdough adds the LFO signal to max(1 - depth, 0).
      baseGain = (1 - strudelTremDepth).max(0);
      modGain = baseGain + lfo;
      
      signal = signal * modGain;
      
      ReplaceOut.ar(out, signal);
    }, [\\ir, \\kr, \\kr, \\kr, \\kr, \\kr]).add;
    "Added: strudel_tremolo${channels}".postln;
    
    // Register the strudel_tremolo module with SuperDirt
    ~dirt.addModule('strudel_tremolo',
      { |dirtEvent|
        dirtEvent.sendSynth('strudel_tremolo' ++ ${channels},
          [
            strudelTremRate: ~strudelTremRate ? 1,
            strudelTremDepth: ~strudelTremDepth ? 1,
            strudelTremSkew: ~strudelTremSkew ? 0.5,
            strudelTremPhase: ~strudelTremPhase ? 0,
            strudelTremShape: ~strudelTremShape ? 0,
            out: ~out
          ])
      }, { ~strudelTremRate.notNil });
    "*** Strudel tremolo module registered ***".postln;
    
    s.sync;
    
    // ========================================
    // Convolution Reverb (PartConv-based)
    // Uses prepared spectral buffers for efficient real-time convolution
    // Supports ir (sample name), irspeed (playback rate), irbegin (start offset)
    // ========================================
    
    // Dictionary to store prepared spectral buffers for PartConv
    // Key: "sampleName_speed_begin" (to handle different speed/begin combos)
    // Value: [bufnum, normFactor] - bufnum for spectral data, normFactor for WebAudio-style normalization
    ~strudelIRBuffers = Dictionary.new;
    
    // FFT size for PartConv - larger = more accurate, smaller = less latency
    // 2048 is a good balance (about 42ms latency at 48kHz)
    ~strudelIRFFTSize = 2048;
    
    // Function to prepare an IR buffer for PartConv
    // Returns [spectralBufnum, normFactor], or nil if preparation fails
    // The speed and begin parameters modify the IR before convolution
    ~prepareIRBuffer = { |sampleName, speed = 1, begin = 0|
      var key, origBuffer, origBufnum, numFrames, sampleOffset, newLength;
      var irBuffer, irBufnum, spectralBuffer, spectralBufSize;
      var soundEvent, bufArray, normFactor;
      
      key = (sampleName.asString ++ "_" ++ speed.asString ++ "_" ++ begin.asString).asSymbol;
      
      // Check if already prepared
      if(~strudelIRBuffers[key].notNil, {
        ("Strudel IR: Using cached buffer for " ++ key).postln;
        ~strudelIRBuffers[key];  // Return cached [bufnum, normFactor]
      }, {
        // Look up the sample in SuperDirt's sound library
        soundEvent = ~dirt.soundLibrary.getEvent(sampleName.asSymbol, 0);
        
        if(soundEvent.isNil || soundEvent[\\buffer].isNil, {
          ("Strudel IR: Sample not found: " ++ sampleName).postln;
          nil;
        }, {
          origBufnum = soundEvent[\\buffer];
          origBuffer = Buffer.cachedBufferAt(s, origBufnum);
          
          if(origBuffer.isNil, {
            ("Strudel IR: Buffer not loaded: " ++ sampleName).postln;
            nil;
          }, {
            numFrames = origBuffer.numFrames;
            
            // Apply speed and begin offset (like superdough's adjustLength)
            // begin is 0-1 normalized offset
            sampleOffset = (begin.clip(0, 1) * numFrames).floor.asInteger;
            newLength = (numFrames / speed.abs.max(0.01)).floor.asInteger;
            
            // Create a modified IR buffer if speed != 1 or begin != 0
            // This matches superdough's adjustLength behavior
            if(speed == 1 && begin == 0, {
              // Use original buffer directly - no modification needed
              irBuffer = origBuffer;
            }, {
              // Need to create a modified buffer with speed/begin applied
              // This is done by reading samples at adjusted positions
              var modifiedFrames, modBuffer;
              
              // Calculate new length based on speed
              // speed=2 means play twice as fast = half the length
              modifiedFrames = (numFrames / speed.abs.max(0.01)).floor.asInteger.max(256);
              
              // Allocate a new buffer for the modified IR
              modBuffer = Buffer.alloc(s, modifiedFrames, origBuffer.numChannels);
              s.sync;
              
              // Read the original buffer data and write resampled data
              // Using loadToFloatArray to get the data, modify it, and write back
              origBuffer.loadToFloatArray(action: { |floatArray|
                var newArray, position, idx, leftIdx, rightIdx, frac, leftVal, rightVal;
                var channels = origBuffer.numChannels;
                
                newArray = FloatArray.newClear(modifiedFrames * channels);
                
                // Resample with linear interpolation (like superdough's adjustLength)
                modifiedFrames.do { |i|
                  // Calculate source position: (sampleOffset + i * speed) % origLength
                  // begin is 0-1 offset into the original
                  position = (sampleOffset + (i * speed.abs)) % numFrames;
                  
                  // Handle negative speed (reverse)
                  if(speed < 0, {
                    position = numFrames - 1 - position;
                  });
                  
                  // Linear interpolation between samples
                  leftIdx = position.floor.asInteger;
                  rightIdx = (leftIdx + 1) % numFrames;
                  frac = position - leftIdx;
                  
                  // For each channel
                  channels.do { |ch|
                    leftVal = floatArray[(leftIdx * channels) + ch] ? 0;
                    rightVal = floatArray[(rightIdx * channels) + ch] ? 0;
                    newArray[(i * channels) + ch] = leftVal + ((rightVal - leftVal) * frac);
                  };
                };
                
                // Load the modified data back into the buffer
                modBuffer.loadCollection(newArray);
                s.sync;
                ("Strudel IR: Created modified buffer with speed=" ++ speed ++ " begin=" ++ begin).postln;
              });
              s.sync;
              
              irBuffer = modBuffer;
            });
            
            // Calculate normalization factor similar to WebAudio's ConvolverNode
            // WebAudio divides by sqrt(sum(samples^2)) = RMS * sqrt(numFrames)
            // This is complex to compute without loading buffer data, so we use a fixed
            // empirical factor that works well for typical IRs
            // Value of 2.0 was found to give good results across different IR types
            normFactor = 2.0;
            ("Strudel IR: normFactor for " ++ key ++ " = " ++ normFactor).postln;
            
            // Calculate spectral buffer size for PartConv
            // Formula from SC docs: fftsize/2+1 * (irFrames/fftsize+1).ceil * 2
            spectralBufSize = PartConv.calcBufSize(~strudelIRFFTSize, irBuffer);
            
            // Allocate spectral buffer
            spectralBuffer = Buffer.alloc(s, spectralBufSize, 1, { |buf|
              // Prepare the spectral data
              buf.preparePartConv(irBuffer, ~strudelIRFFTSize);
              s.sync;
              ("Strudel IR: Prepared spectral buffer for " ++ key ++ " (size: " ++ spectralBufSize ++ ")").postln;
            });
            
            // Wait for preparation to complete
            s.sync;
            
            // Cache the spectral buffer and norm factor
            ~strudelIRBuffers[key] = [spectralBuffer.bufnum, normFactor];
            
            [spectralBuffer.bufnum, normFactor];  // Return [bufnum, normFactor]
          });
        });
      });
    };
    
    // Convolution reverb SynthDef using PartConv
    // This is a global effect like SuperDirt's dirt_reverb
    // It reads from a bus and applies convolution with the prepared IR
    // Note: WebAudio's ConvolverNode normalizes the IR by default (normalize=true)
    // which scales the output to match input level. We pass the normFactor as a parameter.
    SynthDef("strudel_convrev" ++ ${channels}, { |out, irBufnum = -1, room = 0.5, irNorm = 1|
      var dry, wet, sig;
      
      // Read the dry signal from the bus
      dry = In.ar(out, ${channels});
      
      // Apply convolution only if we have a valid IR buffer
      // Apply normalization factor to approximate WebAudio's behavior
      wet = Select.ar(irBufnum >= 0, [
        DC.ar(0),  // No IR - silent wet signal
        PartConv.ar(dry, ~strudelIRFFTSize, irBufnum) / irNorm
      ]);
      
      // Mix dry and wet based on room parameter
      // room=0: 100% dry, room=1: 100% wet
      sig = (dry * (1 - room)) + (wet * room);
      
      ReplaceOut.ar(out, sig);
    }, [\\ir, \\ir, \\kr, \\ir]).add;
    "Added: strudel_convrev${channels}".postln;
    
    // Register the strudel_convrev module with SuperDirt
    // This module triggers when strudelIR parameter is present
    ~dirt.addModule('strudel_convrev',
      { |dirtEvent|
        var irData, irBufnum, irNorm, irName, irSpeed, irBegin;
        
        irName = ~strudelIR;
        irSpeed = ~strudelIRSpeed ? 1;
        irBegin = ~strudelIRBegin ? 0;
        
        // Prepare the IR buffer (cached after first preparation)
        // Returns [bufnum, normFactor] or nil
        irData = ~prepareIRBuffer.value(irName, irSpeed, irBegin);
        
        if(irData.notNil, {
          irBufnum = irData[0];
          irNorm = irData[1];
          dirtEvent.sendSynth('strudel_convrev' ++ ${channels},
            [
              irBufnum: irBufnum,
              irNorm: irNorm,
              room: ~room ? 0.5,
              out: ~out
            ]);
        });
      }, { ~strudelIR.notNil });
    "*** Strudel convolution reverb module registered ***".postln;
    
    // Update module ordering to include convrev
    ~dirt.orderModules([
        'strudel_soundfont_diversion',
        'sound', 'vowel', 'shape', 'hpf', 'bpf', 'crush', 'coarse', 'lpf',
        'pshift', 'envelope', 'grenvelo', 'tremolo', 'phaser', 'waveloss',
        'squiz', 'fshift', 'triode', 'krush', 'octer', 'ring', 'distort',
        'spectral-delay', 'spectral-freeze', 'spectral-comb', 'spectral-smear',
        'spectral-scram', 'spectral-binshift', 'spectral-hbrick', 'spectral-lbrick',
        'spectral-conformer', 'spectral-enhance', 'dj-filter', 'compressor',
        'strudel_tremolo',
        'strudel_filter',
        'strudel_convrev',  // Convolution reverb after other effects
        'out_to', 'map_from'
    ]);
    "*** Module order updated (includes strudel_convrev) ***".postln;
    
    s.sync;
    
    // ========================================
    // OSC Handlers
    // ========================================
    
    // OSC handler for dynamic sample loading from Strudel
    // When new samples are downloaded, the server sends this message
    // After loading, sends confirmation back to the server
    OSCdef(\\strudelLoadSamples, { |msg|
        var path, replyPort;
        path = msg[1].asString;
        // Use SC's if() syntax - the ? operator doesn't work like JS ternary
        replyPort = if(msg[2].notNil, { msg[2].asInteger }, { 0 });
        "Strudel: Loading samples from %".format(path).postln;
        ~dirt.loadSoundFiles(path);
        "Strudel: Samples loaded".postln;
        // Send confirmation back to the server if reply port was provided
        if(replyPort > 0, {
            NetAddr("127.0.0.1", replyPort).sendMsg('/strudel/samplesLoaded', path);
            "Strudel: Sent load confirmation to port %".format(replyPort).postln;
        });
    }, '/strudel/loadSamples');
    
    // Native panic: free and recreate every orbit's synth group so hush does
    // not depend on a WebAudio context reset.
    OSCdef(\\strudelHush, {
        ~dirt.orbits.do { |orbit| orbit.freeSynths };
    }, '/strudel/hush');
    "*** Strudel native hush handler registered: /strudel/hush ***".postln;

    // OSC handler for Strudel synths - bypasses SuperDirt entirely
    // This avoids double envelope application from dirt_envelope
    // Message format: /strudel/synth synthName, param1, value1, param2, value2, ...
    OSCdef(\\strudelSynth, { |msg|
        var synthName, args, synth, time, latency;
        synthName = msg[1].asSymbol;
        
        // Parse args as key-value pairs starting from msg[2]
        args = [];
        forBy(2, msg.size - 1, 2, { |i|
            if(msg[i].notNil && msg[i+1].notNil, {
                args = args ++ [msg[i].asSymbol, msg[i+1]];
            });
        });
        
        // Schedule synth with small latency for timing accuracy
        latency = 0.05;
        SystemClock.sched(latency, {
            Synth(synthName, args);
            nil;
        });
    }, '/strudel/synth');
    "*** Strudel synth OSC handler registered: /strudel/synth ***".postln;
    
    "*** SuperDirt listening on port ${port} ***".postln;
    "*** Strudel OSC handler registered: /strudel/loadSamples ***".postln;
    "*** Ready for OSC messages ***".postln;
};
)
`;
  }

  /**
   * Start SuperDirt
   * Returns a promise that resolves when SuperDirt is ready
   * On Linux, automatically starts JACK if not running
   */
  async start(): Promise<boolean> {
    if (this.isRunning) {
      console.log('[superdirt] Already running');
      return true;
    }

    if (!SuperDirtLauncher.isSclangAvailable()) {
      console.error('[superdirt] sclang not found - install SuperCollider first');
      return false;
    }

    // On Linux, SuperDirt requires JACK - start it if not running
    if (platform() === 'linux') {
      if (!isJackRunning()) {
        console.log('[superdirt] JACK not running, attempting to start...');
        // Try common audio devices
        let result = startJack('hw:1');
        if (!result.started) {
          result = startJack('hw:0');
        }
        if (result.started) {
          this.weStartedJack = result.weStartedIt;
          console.log('[superdirt] JACK started successfully');
        } else {
          console.error('[superdirt] Could not start JACK - SuperDirt requires JACK on Linux');
          console.error('[superdirt] Please start JACK manually: jack_control start');
          return false;
        }
      } else {
        console.log('[superdirt] JACK is running');
      }
    }

    // Check/install StrudelDirt quark (or fall back to SuperDirt)
    // Also handle the broken state where both are installed (causes duplicate class errors)
    const hasStrudelDirt = SuperDirtLauncher.isStrudelDirtInstalled();
    const hasSuperDirt = SuperDirtLauncher.isSuperDirtQuarkInstalled();
    
    if (hasStrudelDirt && hasSuperDirt) {
      // Broken state - both installed, need to remove SuperDirt
      // We MUST remove via filesystem because sclang can't compile with duplicate classes
      console.log('[strudeldirt] Both StrudelDirt and SuperDirt are installed (conflict)');
      console.log('[strudeldirt] Removing SuperDirt directory to resolve duplicate class errors...');
      const superDirtPath = join(process.env.HOME || '', '.local', 'share', 'SuperCollider', 'downloaded-quarks', 'SuperDirt');
      try {
        execSync(`rm -rf "${superDirtPath}"`, { stdio: 'inherit' });
        console.log('[strudeldirt] SuperDirt directory removed successfully');
      } catch (rmErr) {
        console.error('[strudeldirt] Could not remove SuperDirt - please remove manually:', superDirtPath);
        return false;
      }
    } else if (!hasStrudelDirt) {
      console.log('[strudeldirt] StrudelDirt quark not found, installing...');
      if (!SuperDirtLauncher.installStrudelDirt()) {
        return false;
      }
    }

    // Write startup script to temp file
    const script = this.generateStartupScript();
    this.tempScriptPath = join(tmpdir(), `superdirt_${Date.now()}.scd`);
    writeFileSync(this.tempScriptPath, script);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.error('[superdirt] Startup timeout - SuperDirt may not be ready');
        resolve(false);
      }, this.options.startupTimeout);

      console.log('[superdirt] Starting sclang...');
      
      this.sclangProcess = spawn('sclang', [this.tempScriptPath!], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Don't detach - sclang should die when parent dies
        detached: false,
      });
      
      // On Unix, set up parent death signal so sclang dies if we crash
      // This uses prctl(PR_SET_PDEATHSIG) on Linux via a workaround
      if (process.platform !== 'win32' && this.sclangProcess.pid) {
        // Store PID for cleanup tracking
        this.sclangPid = this.sclangProcess.pid;
      }

      let stdoutBuffer = '';

      this.sclangProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdoutBuffer += text;
        
        if (this.options.verbose) {
          process.stdout.write(`[sclang] ${text}`);
        }

        // Check for ready signal
        if (text.includes('Ready for OSC messages')) {
          clearTimeout(timeout);
          this.isRunning = true;
          console.log('[superdirt] SuperDirt is ready!');
          resolve(true);
        }

        // Check for common errors
        if (text.includes('ERROR') || text.includes('Exception')) {
          console.error('[superdirt] Error detected in sclang output');
        }
      });

      this.sclangProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        // sclang outputs a lot to stderr that isn't actually errors
        if (this.options.verbose) {
          process.stderr.write(`[sclang:err] ${text}`);
        }
      });

      this.sclangProcess.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[superdirt] Failed to start sclang:', err.message);
        resolve(false);
      });

      this.sclangProcess.on('exit', (code, signal) => {
        clearTimeout(timeout);
        this.isRunning = false;
        this.cleanup();
        
        if (code !== 0 && code !== null) {
          console.log(`[superdirt] sclang exited with code ${code}`);
        } else if (signal) {
          console.log(`[superdirt] sclang killed by signal ${signal}`);
        }
      });
    });
  }

  /**
   * Stop SuperDirt and cleanup
   * Also stops JACK if we started it
   * This method is synchronous to work properly in signal handlers
   */
  stop(): void {
    console.log('[superdirt] stop() called, weStartedJack:', this.weStartedJack);
    
    if (this.sclangProcess) {
      console.log('[superdirt] Stopping sclang (PID:', this.sclangPid, ')...');
      
      // Kill sclang process
      try {
        this.sclangProcess.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
      
      // Also kill any child processes (scsynth is spawned by sclang)
      if (this.sclangPid && process.platform !== 'win32') {
        try {
          // Kill any child processes (scsynth)
          execSync(`pkill -P ${this.sclangPid} 2>/dev/null || true`, { stdio: 'ignore', timeout: 2000 });
        } catch {
          // Ignore errors
        }
        
        // Force kill sclang by PID
        try {
          execSync(`kill -9 ${this.sclangPid} 2>/dev/null || true`, { stdio: 'ignore', timeout: 2000 });
        } catch {
          // Ignore
        }
      }
    }
    
    // Kill ALL sclang and scsynth processes (not just ours)
    // This ensures nothing is keeping JACK alive
    if (process.platform !== 'win32') {
      try {
        execSync('pkill -9 sclang 2>/dev/null || true', { stdio: 'ignore', timeout: 2000 });
      } catch {
        // Ignore
      }
      try {
        execSync('pkill -9 scsynth 2>/dev/null || true', { stdio: 'ignore', timeout: 2000 });
      } catch {
        // Ignore
      }
      
      // Wait a moment for processes to die before stopping JACK
      // JACK won't stop if clients are still connected
      try {
        execSync('sleep 0.5', { stdio: 'ignore', timeout: 2000 });
      } catch {
        // Ignore
      }
    }
    
    this.cleanup();
    this.isRunning = false;
    this.sclangProcess = null;
    this.sclangPid = null;
    
    // Stop JACK if we started it
    if (this.weStartedJack) {
      console.log('[superdirt] Stopping JACK (we started it)...');
      stopJack();
      this.weStartedJack = false;
    } else {
      console.log('[superdirt] Not stopping JACK (we did not start it)');
    }
  }

  /**
   * Check if SuperDirt is currently running
   */
  isActive(): boolean {
    return this.isRunning && this.sclangProcess !== null && !this.sclangProcess.killed;
  }

  /**
   * Cleanup temp files
   */
  private cleanup(): void {
    if (this.tempScriptPath && existsSync(this.tempScriptPath)) {
      try {
        unlinkSync(this.tempScriptPath);
      } catch {
        // Ignore cleanup errors
      }
      this.tempScriptPath = null;
    }
  }
}

/**
 * Check if JACK server is running and accepting connections (Linux only)
 *
 * With PipeWire, JACK is provided by PipeWire. We should:
 * 1. First check if PipeWire is running (provides JACK interface)
 * 2. Then check if traditional JACK server is running
 *
 * IMPORTANT: The jackdbus daemon process may exist without the JACK server being started.
 * We need to check if the JACK server is actually running and accepting connections.
 */
export function isJackRunning(): boolean {
  if (platform() !== 'linux') {
    return true; // Assume OK on non-Linux
  }

  // Method 0: Check for PipeWire first (provides JACK interface on modern systems)
  // PipeWire runs even without jackdbus and provides libjack compatibility
  try {
    // Check if pw-cli works - if it does, PipeWire is running and provides JACK
    const pwInfo = execSync('pw-cli info 0 2>/dev/null', { stdio: 'pipe', timeout: 5000 }).toString();
    if (pwInfo.includes('PipeWire') && pwInfo.includes('version')) {
      console.log('[jack] PipeWire detected (provides JACK interface)');
      return true;
    }
  } catch {
    // pw-cli failed or PipeWire not running
  }

  // Method 1: Try jack_lsp - this actually connects to the JACK server
  // If JACK isn't running or accepting connections, this will fail
  // This is the most reliable method but jack_lsp may not be installed
  try {
    execSync('jack_lsp 2>/dev/null', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    // jack_lsp failed or not installed
  }

  // Method 2: Use jack_control status (DBus)
  // This reports the actual server state, not just if jackdbus daemon is running
  // Output format: "--- status\nstarted" or "--- status\nstopped"
  try {
    const result = execSync('jack_control status 2>&1', { timeout: 5000 }).toString();
    // Check for "started" on its own line (not just anywhere in output)
    if (result.split('\n').some(line => line.trim() === 'started')) {
      return true;
    }
    // If we got a valid response with "stopped", JACK is definitely not running
    if (result.split('\n').some(line => line.trim() === 'stopped')) {
      return false;
    }
  } catch {
    // jack_control not available or failed
  }

  // Method 3: Check if jackd process is running (not jackdbus)
  // jackdbus is just the DBus service daemon, it can run without JACK server started
  try {
    const result = execSync('pgrep -x jackd 2>/dev/null', { timeout: 5000 }).toString();
    if (result.trim()) {
      return true;
    }
  } catch {
    // No jackd process found
  }

  return false;
}

/**
 * Start JACK with default settings (Linux only)
 * Prefers jack_control (DBus) if available, falls back to jackd
 * Returns { started: boolean, weStartedIt: boolean }
 *
 * IMPORTANT: On systems with PipeWire, we should NOT try to start a separate JACK server.
 * PipeWire provides a JACK-compatible interface and applications should connect to it directly.
 * We detect PipeWire via pw-cli and skip starting traditional JACK.
 */
export function startJack(device = 'hw:0'): { started: boolean; weStartedIt: boolean } {
  if (platform() !== 'linux') {
    return { started: true, weStartedIt: false };
  }

  if (isJackRunning()) {
    console.log('[jack] JACK is already running');
    return { started: true, weStartedIt: false };
  }

  // Check if PipeWire is running - if so, we can't start traditional JACK
  // Applications should connect to PipeWire's JACK interface via libjack
  try {
    execSync('pw-cli info 0 2>/dev/null', { stdio: 'pipe', timeout: 5000 });
    console.log('[jack] PipeWire is running - cannot start traditional JACK server');
    console.log('[jack] Applications should use libjack to connect to PipeWire');
    return { started: true, weStartedIt: false };
  } catch {
    // PipeWire not running, proceed to start traditional JACK
  }

  console.log('[jack] Attempting to start JACK...');
  
  // Method 1: Try jack_control (DBus) - preferred method
  try {
    // First check if jack_control is available
    execSync('which jack_control', { stdio: 'ignore' });
    
    // Configure ALSA driver
    execSync(`jack_control ds alsa`, { stdio: 'ignore' });
    execSync(`jack_control dps device ${device}`, { stdio: 'ignore' });
    execSync(`jack_control dps rate 48000`, { stdio: 'ignore' });
    execSync(`jack_control dps period 1024`, { stdio: 'ignore' });
    
    // Start JACK
    const result = execSync('jack_control start 2>&1', { timeout: 10000 }).toString();
    if (!result.includes('error') && !result.includes('Error')) {
      // Wait a moment and verify
      execSync('sleep 1');
      if (isJackRunning()) {
        console.log('[jack] JACK started via DBus');
        return { started: true, weStartedIt: true };
      }
    }
  } catch {
    // jack_control failed, try direct jackd
  }
  
  // Method 2: Try starting jackd directly
  try {
    const jackd = spawn('jackd', ['-d', 'alsa', '-d', device, '-r', '48000', '-p', '1024'], {
      detached: true,
      stdio: 'ignore',
    });
    
    jackd.unref();
    
    // Wait a moment for JACK to start
    execSync('sleep 1');
    
    if (isJackRunning()) {
      console.log('[jack] JACK started via jackd');
      return { started: true, weStartedIt: true };
    } else {
      console.error('[jack] JACK failed to start');
      return { started: false, weStartedIt: false };
    }
  } catch (err) {
    console.error('[jack] Failed to start JACK:', err);
    return { started: false, weStartedIt: false };
  }
}

/**
 * Stop JACK (Linux only)
 * Use jack_control if available, otherwise pkill jackd
 * This is synchronous to ensure JACK is stopped before process exits
 */
export function stopJack(): void {
  if (platform() !== 'linux') {
    return;
  }

  // Check if JACK is actually running before trying to stop
  let jackRunning = false;
  try {
    const result = execSync('jack_control status 2>&1', { timeout: 5000 }).toString();
    jackRunning = result.split('\n').some(line => line.trim() === 'started');
    console.log('[jack] Current status:', jackRunning ? 'started' : 'stopped');
  } catch {
    // If we can't check status, assume it might be running
    jackRunning = true;
  }
  
  if (!jackRunning) {
    console.log('[jack] JACK is not running, nothing to stop');
    return;
  }

  console.log('[jack] Stopping JACK...');
  
  // Try up to 3 times with a small delay between attempts
  // JACK might not stop immediately if clients are disconnecting
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execSync('jack_control stop 2>&1', { timeout: 10000, stdio: 'pipe' });
      
      // Small delay then verify it stopped
      execSync('sleep 0.3', { stdio: 'ignore', timeout: 2000 });
      
      const result = execSync('jack_control status 2>&1', { timeout: 5000 }).toString();
      if (result.split('\n').some(line => line.trim() === 'stopped')) {
        console.log('[jack] JACK stopped via DBus (attempt', attempt + ')');
        return;
      }
      console.log('[jack] jack_control stop attempt', attempt, '- still running, retrying...');
    } catch (err) {
      console.log('[jack] jack_control stop attempt', attempt, 'failed:', err);
    }
    
    // Wait before retry
    if (attempt < 3) {
      try {
        execSync('sleep 0.5', { stdio: 'ignore', timeout: 2000 });
      } catch {
        // Ignore
      }
    }
  }
  
  // Fallback: Kill jackd directly (if running standalone, not via DBus)
  console.log('[jack] DBus stop failed, trying pkill jackd...');
  try {
    execSync('pkill -x jackd 2>/dev/null || true', { stdio: 'ignore', timeout: 5000 });
    console.log('[jack] Sent kill signal to jackd');
  } catch {
    // Ignore errors
  }
  
  // Final status check
  try {
    const result = execSync('jack_control status 2>&1', { timeout: 5000 }).toString();
    const stillRunning = result.split('\n').some(line => line.trim() === 'started');
    if (stillRunning) {
      console.error('[jack] WARNING: JACK is still running after stop attempts!');
    } else {
      console.log('[jack] JACK stopped');
    }
  } catch {
    // Ignore
  }
}
