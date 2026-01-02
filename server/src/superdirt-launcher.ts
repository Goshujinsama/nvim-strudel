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
   * Check if SuperDirt quark is installed
   */
  static isSuperDirtInstalled(): boolean {
    const home = process.env.HOME || '';
    const quarksPath = join(home, '.local', 'share', 'SuperCollider', 'downloaded-quarks', 'SuperDirt');
    return existsSync(quarksPath);
  }

  /**
   * Install SuperDirt quark (blocking operation)
   * Returns true if successful, false otherwise
   */
  static installSuperDirt(): boolean {
    console.log('[superdirt] Installing SuperDirt quark...');
    try {
      // This can take a while as it downloads from GitHub
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
      
      // Soundfont synth: loops sample with ADSR envelope
      // NOTE: We use custom parameter names (sfAttack, sfRelease, sfSustain) to avoid
      // SuperDirt's internal parameter handling which overrides standard names
      SynthDef(name, { |out, bufnum, sustain = 1, begin = 0, end = 1, speed = 1, endSpeed = 1, 
                        freq = 440, pan = 0, sfAttack = 0.01, sfRelease = 0.1, sfSustain = 1|
        var sound, rate, phase, numFrames, env, holdTime, phasorRate;
        
        numFrames = max(BufFrames.ir(bufnum), 1);
        
        // Use speed directly - it's already pitch-adjusted
        rate = Line.kr(speed, endSpeed, sfSustain);
        
        // Phasor rate: samples to advance per audio sample
        phasorRate = rate * BufRateScale.ir(bufnum);
        
        // Loop through sample using Phasor
        phase = Phasor.ar(0, phasorRate, begin * numFrames, end * numFrames, begin * numFrames);
        
        sound = BufRd.ar(
          numChannels: sampleNumChannels,
          bufnum: bufnum,
          phase: phase,
          loop: 1,
          interpolation: 4
        );
        
        // ADSR envelope using our custom params
        holdTime = max(0.001, sfSustain - sfAttack - sfRelease);
        env = EnvGen.kr(
          Env.linen(sfAttack, holdTime, sfRelease, 1, \\sin),
          doneAction: 2
        );
        
        sound = sound * env;
        sound = DirtPan.ar(sound, ${channels}, pan);
        
        Out.ar(out, sound)
      }, [\\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr, \\ir, \\ir, \\ir]).add;
      
      ("Strudel: Added " ++ name).postln;
    };
    
    s.sync;  // Ensure soundfont SynthDefs are registered with server
    "*** Strudel soundfont SynthDefs loaded ***".postln;
    
    // ========================================
    // Oscillator Synths (sine, sawtooth, square, triangle, noise)
    // These match superdough's basic waveform synths for OSC-only operation
    // ========================================
    
    // Sine wave oscillator (pure tone)
    // Uses strudelEnv* params for ADSR envelope to avoid SuperDirt's dirt_envelope
    // superdough defaults: attack=0.001, decay=0.05, sustain=0.6 (level), release=0.01
    // 'sustain' param here is the note duration (set by osc-output.ts)
    SynthDef(\\strudel_sine, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                               cutoff = 20000, hcutoff = 20,
                               strudelEnvAttack = 0.001, strudelEnvDecay = 0.001,
                               strudelEnvSustainLevel = 1, strudelEnvRelease = 0.01,
                               strudelEnvHold = 1|
      var sound, env;
      // ADSR envelope with linear curves to match superdough
      env = EnvGen.ar(
        Env.new(
          [0, 1, strudelEnvSustainLevel, strudelEnvSustainLevel, 0],
          [strudelEnvAttack, strudelEnvDecay, strudelEnvHold, strudelEnvRelease],
          \\lin
        ),
        doneAction: 2
      );
      sound = SinOsc.ar(freq * speed) * env;
      // Conditional filtering: only apply when user sets explicit values
      sound = Select.ar(cutoff < 20000, [sound, LPF.ar(sound, cutoff.clip(20, 20000))]);
      sound = Select.ar(hcutoff > 20, [sound, HPF.ar(sound, hcutoff.clip(20, 20000))]);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\kr, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir]).add;
    "Added: strudel_sine".postln;
    
    // Sawtooth wave oscillator
    // Uses strudelEnv* params for ADSR envelope to avoid SuperDirt's dirt_envelope
    // RMS compensation: SC's Saw.ar has lower RMS than Web Audio's normalized sawtooth
    // due to band-limiting. Factor of 2.0 matches RMS levels between the two backends.
    SynthDef(\\strudel_sawtooth, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                   cutoff = 20000, hcutoff = 20,
                                   strudelEnvAttack = 0.001, strudelEnvDecay = 0.001,
                                   strudelEnvSustainLevel = 1, strudelEnvRelease = 0.01,
                                   strudelEnvHold = 1|
      var sound, env;
      env = EnvGen.ar(
        Env.new(
          [0, 1, strudelEnvSustainLevel, strudelEnvSustainLevel, 0],
          [strudelEnvAttack, strudelEnvDecay, strudelEnvHold, strudelEnvRelease],
          \\lin
        ),
        doneAction: 2
      );
      sound = Saw.ar(freq * speed) * 2.0 * env;  // RMS compensation for band-limited Saw
      sound = Select.ar(cutoff < 20000, [sound, LPF.ar(sound, cutoff.clip(20, 20000))]);
      sound = Select.ar(hcutoff > 20, [sound, HPF.ar(sound, hcutoff.clip(20, 20000))]);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\kr, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir]).add;
    "Added: strudel_sawtooth".postln;
    
    // Alias for sawtooth (superdough uses 'saw')
    // Uses strudelEnv* params for ADSR envelope to avoid SuperDirt's dirt_envelope
    SynthDef(\\strudel_saw, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                              cutoff = 20000, hcutoff = 20,
                              strudelEnvAttack = 0.001, strudelEnvDecay = 0.001,
                              strudelEnvSustainLevel = 1, strudelEnvRelease = 0.01,
                              strudelEnvHold = 1|
      var sound, env;
      env = EnvGen.ar(
        Env.new(
          [0, 1, strudelEnvSustainLevel, strudelEnvSustainLevel, 0],
          [strudelEnvAttack, strudelEnvDecay, strudelEnvHold, strudelEnvRelease],
          \\lin
        ),
        doneAction: 2
      );
      sound = Saw.ar(freq * speed) * 2.0 * env;  // RMS compensation for band-limited Saw
      sound = Select.ar(cutoff < 20000, [sound, LPF.ar(sound, cutoff.clip(20, 20000))]);
      sound = Select.ar(hcutoff > 20, [sound, HPF.ar(sound, hcutoff.clip(20, 20000))]);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\kr, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir]).add;
    "Added: strudel_saw".postln;
    
    // Square wave oscillator
    // Uses strudelEnv* params for ADSR envelope to avoid SuperDirt's dirt_envelope
    // RMS compensation: SC's Pulse.ar has lower RMS than Web Audio's normalized square
    SynthDef(\\strudel_square, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                 cutoff = 20000, hcutoff = 20,
                                 strudelEnvAttack = 0.001, strudelEnvDecay = 0.001,
                                 strudelEnvSustainLevel = 1, strudelEnvRelease = 0.01,
                                 strudelEnvHold = 1|
      var sound, env;
      env = EnvGen.ar(
        Env.new(
          [0, 1, strudelEnvSustainLevel, strudelEnvSustainLevel, 0],
          [strudelEnvAttack, strudelEnvDecay, strudelEnvHold, strudelEnvRelease],
          \\lin
        ),
        doneAction: 2
      );
      sound = Pulse.ar(freq * speed, 0.5) * 1.9 * env;  // RMS compensation for band-limited Pulse
      sound = Select.ar(cutoff < 20000, [sound, LPF.ar(sound, cutoff.clip(20, 20000))]);
      sound = Select.ar(hcutoff > 20, [sound, HPF.ar(sound, hcutoff.clip(20, 20000))]);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\kr, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir]).add;
    "Added: strudel_square".postln;
    
    // Triangle wave oscillator
    // Uses strudelEnv* params for ADSR envelope to avoid SuperDirt's dirt_envelope
    SynthDef(\\strudel_triangle, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                   cutoff = 20000, hcutoff = 20,
                                   strudelEnvAttack = 0.001, strudelEnvDecay = 0.001,
                                   strudelEnvSustainLevel = 1, strudelEnvRelease = 0.01,
                                   strudelEnvHold = 1|
      var sound, env;
      env = EnvGen.ar(
        Env.new(
          [0, 1, strudelEnvSustainLevel, strudelEnvSustainLevel, 0],
          [strudelEnvAttack, strudelEnvDecay, strudelEnvHold, strudelEnvRelease],
          \\lin
        ),
        doneAction: 2
      );
      sound = LFTri.ar(freq * speed) * env;
      sound = Select.ar(cutoff < 20000, [sound, LPF.ar(sound, cutoff.clip(20, 20000))]);
      sound = Select.ar(hcutoff > 20, [sound, HPF.ar(sound, hcutoff.clip(20, 20000))]);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\kr, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir]).add;
    "Added: strudel_triangle".postln;
    
    // Alias for triangle (superdough uses 'tri')
    // Uses strudelEnv* params for ADSR envelope to avoid SuperDirt's dirt_envelope
    SynthDef(\\strudel_tri, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                              cutoff = 20000, hcutoff = 20,
                              strudelEnvAttack = 0.001, strudelEnvDecay = 0.001,
                              strudelEnvSustainLevel = 1, strudelEnvRelease = 0.01,
                              strudelEnvHold = 1|
      var sound, env;
      env = EnvGen.ar(
        Env.new(
          [0, 1, strudelEnvSustainLevel, strudelEnvSustainLevel, 0],
          [strudelEnvAttack, strudelEnvDecay, strudelEnvHold, strudelEnvRelease],
          \\lin
        ),
        doneAction: 2
      );
      sound = LFTri.ar(freq * speed) * env;
      sound = Select.ar(cutoff < 20000, [sound, LPF.ar(sound, cutoff.clip(20, 20000))]);
      sound = Select.ar(hcutoff > 20, [sound, HPF.ar(sound, hcutoff.clip(20, 20000))]);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\kr, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir]).add;
    "Added: strudel_tri".postln;
    
    // White noise generator
    // Uses strudelEnv* params for ADSR envelope to avoid SuperDirt's dirt_envelope
    SynthDef(\\strudel_white, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                cutoff = 20000, hcutoff = 20,
                                strudelEnvAttack = 0.001, strudelEnvDecay = 0.001,
                                strudelEnvSustainLevel = 1, strudelEnvRelease = 0.01,
                                strudelEnvHold = 1|
      var sound, env;
      env = EnvGen.ar(
        Env.new(
          [0, 1, strudelEnvSustainLevel, strudelEnvSustainLevel, 0],
          [strudelEnvAttack, strudelEnvDecay, strudelEnvHold, strudelEnvRelease],
          \\lin
        ),
        doneAction: 2
      );
      sound = WhiteNoise.ar * env;
      sound = Select.ar(cutoff < 20000, [sound, LPF.ar(sound, cutoff.clip(20, 20000))]);
      sound = Select.ar(hcutoff > 20, [sound, HPF.ar(sound, hcutoff.clip(20, 20000))]);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\kr, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir]).add;
    "Added: strudel_white".postln;
    
    // Pink noise generator - Paul Kellet algorithm to match superdough
    // Uses strudelEnv* params for ADSR envelope to avoid SuperDirt's dirt_envelope
    // Superdough uses 6 IIR filters + delayed sample, summed and scaled by 0.11
    // Each filter: y[n] = feedback * y[n-1] + input_gain * x[n]
    // Use FOS.ar(in, a0, a1, b1) = a0*x[n] + a1*x[n-1] + b1*y[n-1]
    SynthDef(\\strudel_pink, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                               cutoff = 20000, hcutoff = 20,
                               strudelEnvAttack = 0.001, strudelEnvDecay = 0.001,
                               strudelEnvSustainLevel = 1, strudelEnvRelease = 0.01,
                               strudelEnvHold = 1|
      var sound, white, env;
      var b0, b1, b2, b3, b4, b5, b6;
      env = EnvGen.ar(
        Env.new(
          [0, 1, strudelEnvSustainLevel, strudelEnvSustainLevel, 0],
          [strudelEnvAttack, strudelEnvDecay, strudelEnvHold, strudelEnvRelease],
          \\lin
        ),
        doneAction: 2
      );
      // Paul Kellet pink noise filter (matches superdough exactly)
      // FOS.ar(in, a0, a1, b1): y[n] = a0*x[n] + a1*x[n-1] + b1*y[n-1]
      white = WhiteNoise.ar;
      b0 = FOS.ar(white, 0.0555179, 0, 0.99886);
      b1 = FOS.ar(white, 0.0750759, 0, 0.99332);
      b2 = FOS.ar(white, 0.153852, 0, 0.969);
      b3 = FOS.ar(white, 0.3104856, 0, 0.8665);
      b4 = FOS.ar(white, 0.5329522, 0, 0.55);
      b5 = FOS.ar(white, -0.016898, 0, -0.7616);
      b6 = Delay1.ar(white * 0.115926);  // b6 = previous white sample
      sound = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + (white * 0.5362)) * 0.11 * env;
      sound = Select.ar(cutoff < 20000, [sound, LPF.ar(sound, cutoff.clip(20, 20000))]);
      sound = Select.ar(hcutoff > 20, [sound, HPF.ar(sound, hcutoff.clip(20, 20000))]);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\kr, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir]).add;
    "Added: strudel_pink".postln;
    
    // Brown noise generator - matches superdough algorithm exactly
    // Uses strudelEnv* params for ADSR envelope to avoid SuperDirt's dirt_envelope
    // Superdough: c[m] = (a + 0.02 * b) / 1.02, a = c[m]
    // This is: y[n] = (1/1.02) * y[n-1] + (0.02/1.02) * x[n]
    //        = 0.9804 * y[n-1] + 0.0196 * x[n]
    // Use FOS.ar(in, a0, a1, b1): y[n] = a0*x[n] + a1*x[n-1] + b1*y[n-1]
    SynthDef(\\strudel_brown, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                cutoff = 20000, hcutoff = 20,
                                strudelEnvAttack = 0.001, strudelEnvDecay = 0.001,
                                strudelEnvSustainLevel = 1, strudelEnvRelease = 0.01,
                                strudelEnvHold = 1|
      var sound, env;
      env = EnvGen.ar(
        Env.new(
          [0, 1, strudelEnvSustainLevel, strudelEnvSustainLevel, 0],
          [strudelEnvAttack, strudelEnvDecay, strudelEnvHold, strudelEnvRelease],
          \\lin
        ),
        doneAction: 2
      );
      // Superdough brown noise: y[n] = 0.9804 * y[n-1] + 0.0196 * x[n]
      sound = FOS.ar(WhiteNoise.ar, 0.0196, 0, 0.9804) * env;
      sound = Select.ar(cutoff < 20000, [sound, LPF.ar(sound, cutoff.clip(20, 20000))]);
      sound = Select.ar(hcutoff > 20, [sound, HPF.ar(sound, hcutoff.clip(20, 20000))]);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\kr, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir]).add;
    "Added: strudel_brown".postln;
    
    s.sync;  // Ensure oscillator SynthDefs are registered with server
    "*** Strudel oscillator SynthDefs loaded ***".postln;
    
    // ========================================
    // ZZFX Chip Sound Synth
    // Exact port of ZzFX algorithm from zzfx_fork.mjs
    // https://github.com/KilledByAPixel/ZzFX
    // Uses strudelEnv* params for ADSR envelope (like other synths)
    // to avoid double-envelope from SuperDirt's dirt_gate
    // ========================================
    
    SynthDef(\\strudel_zzfx, { |out, freq = 220, sustain = 1, pan = 0, speed = 1,
                               cutoff = 20000, hcutoff = 20,
                               strudelEnvAttack = 0.001, strudelEnvDecay = 0.001,
                               strudelEnvSustainLevel = 1, strudelEnvRelease = 0.01,
                               strudelEnvHold = 1,
                               zshape = 0, zshapeCurve = 1, zslide = 0, zdeltaSlide = 0,
                               zrand = 0, znoise = 0, zmod = 0,
                               zpitchJump = 0, zpitchJumpTime = 0|
      var sound, env;
      var pi2, sampleRate;
      var freqRadians, slide, deltaSlide, modulation, noise;
      var phase, freqAccum, slideAccum, modPhase, f;
      var waveSin, waveTri, waveSaw, waveTan, waveNoise;
      var sampleIndex;
      
      pi2 = 2pi;
      sampleRate = SampleRate.ir;
      
      // Convert frequency to radians/sample (like ZZFX line 32)
      // frequency *= ((1 + randomness*2*random - randomness) * PI2) / sampleRate
      freqRadians = freq * (1 + (zrand * 2 * Rand(-1, 1))) * pi2 / sampleRate;
      
      // Scale slide params (like ZZFX lines 31, 50)
      // slide *= (500 * PI2) / sampleRate / sampleRate
      slide = zslide * (500 * pi2) / (sampleRate * sampleRate);
      // deltaSlide *= (500 * PI2) / sampleRate^3
      deltaSlide = zdeltaSlide * (500 * pi2) / (sampleRate ** 3);
      
      // modulation *= PI2 / sampleRate
      modulation = zmod * pi2 / sampleRate;
      
      // noise param (for phase jitter)
      noise = znoise;
      
      // Phase accumulator using Integrator for cumulative slide
      // ZZFX: frequency += slide += deltaSlide (each sample)
      // slideAccum accumulates deltaSlide each sample
      slideAccum = Integrator.ar(K2A.ar(deltaSlide), 1) + slide;
      // freqAccum accumulates slideAccum each sample, starting from freqRadians  
      freqAccum = Integrator.ar(slideAccum, 1) + freqRadians;
      
      // Modulation: f = frequency * cos(modulation * tm++)
      modPhase = Phasor.ar(0, modulation, 0, inf);
      f = freqAccum * cos(modPhase);
      
      // Phase with noise jitter (ZZFX line 102):
      // t += f - f * noise * (1 - (((sin(i) + 1) * 1e9) % 2))
      // The noise term creates random phase jitter
      sampleIndex = Phasor.ar(0, 1, 0, inf);
      phase = Integrator.ar(
        f * (1 - (noise * (1 - (((sin(sampleIndex) + 1) * 1e9) % 2)))),
        1
      );
      
      // ZZFX waveform formulas (exact from zzfx_fork.mjs lines 60-68):
      // shape 0: sin(t)
      waveSin = sin(phase);
      
      // shape 1: 1 - 4 * abs(round(t/2π) - t/2π)
      // Note: SC's .round needs argument for integer rounding
      waveTri = 1 - (4 * abs((phase / pi2).round(1) - (phase / pi2)));
      
      // shape 2: 1 - ((((2*t/2π) % 2) + 2) % 2)
      waveSaw = 1 - (((((2 * phase / pi2) % 2) + 2) % 2));
      
      // shape 3: max(min(tan(t), 1), -1)
      waveTan = tan(phase).clip(-1, 1);
      
      // shape 4: sin((t % 2π)^3)
      waveNoise = sin(((phase % pi2) ** 3));
      
      // Select waveform based on zshape
      sound = Select.ar(zshape.clip(0, 4), [
        waveSin,    // 0
        waveTri,    // 1
        waveSaw,    // 2
        waveTan,    // 3
        waveNoise   // 4
      ]);
      
      // Apply shape curve (ZZFX line 75): sign(s) * abs(s)^shapeCurve
      sound = sound.sign * (sound.abs ** zshapeCurve.max(0.01));
      
      // Use strudelEnv* params for ADSR envelope (matching other synths)
      // This avoids double-envelope from SuperDirt's dirt_gate
      env = EnvGen.ar(
        Env.new(
          [0, 1, strudelEnvSustainLevel, strudelEnvSustainLevel, 0],
          [strudelEnvAttack, strudelEnvDecay, strudelEnvHold, strudelEnvRelease],
          \\lin  // ZZFX uses linear envelope segments
        ),
        doneAction: 2
      );
      
      // Apply ZZFX base volume (0.25) and envelope
      // Pattern gain is handled via SuperDirt's gain (after convertGainForSuperDirt)
      sound = sound * env * 0.25;
      
      // Apply filters (only when explicitly set)
      sound = Select.ar(cutoff < 20000, [sound, LPF.ar(sound, cutoff.clip(20, 20000))]);
      sound = Select.ar(hcutoff > 20, [sound, HPF.ar(sound, hcutoff.clip(20, 20000))]);
      
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\kr, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir,
        \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir]).add;
    "Added: strudel_zzfx".postln;
    
    s.sync;  // Ensure ZZFX SynthDef is registered with server
    "*** Strudel ZZFX SynthDef loaded ***".postln;
    
    // ========================================
    // Strudel ADSR Envelope Module (for SAMPLES only)
    // Synths have built-in envelopes, but samples use SuperDirt's sample SynthDefs
    // This module applies ADSR envelope to samples when strudelEnv* params are present
    // Uses custom parameter names to avoid triggering SuperDirt's dirt_envelope
    // ========================================
    
    SynthDef("strudel_adsr" ++ ${channels}, { |out, strudelEnvAttack = 0.001, strudelEnvDecay = 0.001, 
                                               strudelEnvSustainLevel = 1, strudelEnvRelease = 0.01,
                                               strudelEnvHold = 1|
      var signal, env;
      signal = In.ar(out, ${channels});
      // ADSR envelope with linear curves to match superdough
      // Levels: 0 -> 1 (attack) -> sustainLevel (decay) -> sustainLevel (hold) -> 0 (release)
      env = EnvGen.ar(
        Env.new(
          [0, 1, strudelEnvSustainLevel, strudelEnvSustainLevel, 0],
          [strudelEnvAttack, strudelEnvDecay, strudelEnvHold, strudelEnvRelease],
          \\lin
        )
      );
      ReplaceOut.ar(out, signal * env);
    }, [\\ir, \\ir, \\ir, \\ir, \\ir, \\ir]).add;
    "Added: strudel_adsr${channels}".postln;
    
    // Register the strudel_adsr module with SuperDirt (for samples)
    // This module triggers when strudelEnvAttack parameter is present
    // and applies our ADSR envelope INSTEAD of SuperDirt's dirt_envelope
    ~dirt.addModule('strudel_adsr',
      { |dirtEvent|
        dirtEvent.sendSynth('strudel_adsr' ++ ${channels},
          [
            strudelEnvAttack: ~strudelEnvAttack,
            strudelEnvDecay: ~strudelEnvDecay,
            strudelEnvSustainLevel: ~strudelEnvSustainLevel,
            strudelEnvRelease: ~strudelEnvRelease,
            strudelEnvHold: ~strudelEnvHold,
            out: ~out
          ])
      }, { ~strudelEnvAttack.notNil });
    "*** Strudel ADSR module registered (for samples) ***".postln;
    
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

    // Check/install SuperDirt quark
    if (!SuperDirtLauncher.isSuperDirtInstalled()) {
      console.log('[superdirt] SuperDirt quark not found, installing...');
      if (!SuperDirtLauncher.installSuperDirt()) {
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
