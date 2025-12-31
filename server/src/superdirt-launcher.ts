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
    
    "*** Strudel soundfont SynthDefs loaded ***".postln;
    
    // ========================================
    // Oscillator Synths (sine, sawtooth, square, triangle, noise)
    // These match superdough's basic waveform synths for OSC-only operation
    // ========================================
    
    // Sine wave oscillator
    SynthDef(\\strudel_sine, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                               attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                               gain = 1, amp = 0.4, lpf = 20000, hpf = 0|
      var sound, env, holdTime;
      holdTime = max(0.001, sustain - attack - release);
      env = EnvGen.ar(Env.linen(attack, holdTime, release, 1, \\sin), doneAction: 2);
      sound = SinOsc.ar(freq * speed);
      sound = LPF.ar(sound, lpf.clip(20, 20000));
      sound = HPF.ar(sound, hpf.clip(20, 20000));
      sound = sound * env * amp * pow(gain, 4);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr, \\kr, \\kr, \\kr]).add;
    "Added: strudel_sine".postln;
    
    // Sawtooth wave oscillator
    SynthDef(\\strudel_sawtooth, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                   attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                                   gain = 1, amp = 0.4, lpf = 20000, hpf = 0|
      var sound, env, holdTime;
      holdTime = max(0.001, sustain - attack - release);
      env = EnvGen.ar(Env.linen(attack, holdTime, release, 1, \\sin), doneAction: 2);
      sound = Saw.ar(freq * speed);
      sound = LPF.ar(sound, lpf.clip(20, 20000));
      sound = HPF.ar(sound, hpf.clip(20, 20000));
      sound = sound * env * amp * pow(gain, 4);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr, \\kr, \\kr, \\kr]).add;
    "Added: strudel_sawtooth".postln;
    
    // Alias for sawtooth (superdough uses 'saw')
    SynthDef(\\strudel_saw, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                              attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                              gain = 1, amp = 0.4, lpf = 20000, hpf = 0|
      var sound, env, holdTime;
      holdTime = max(0.001, sustain - attack - release);
      env = EnvGen.ar(Env.linen(attack, holdTime, release, 1, \\sin), doneAction: 2);
      sound = Saw.ar(freq * speed);
      sound = LPF.ar(sound, lpf.clip(20, 20000));
      sound = HPF.ar(sound, hpf.clip(20, 20000));
      sound = sound * env * amp * pow(gain, 4);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr, \\kr, \\kr, \\kr]).add;
    "Added: strudel_saw".postln;
    
    // Square wave oscillator
    SynthDef(\\strudel_square, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                 attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                                 gain = 1, amp = 0.4, lpf = 20000, hpf = 0|
      var sound, env, holdTime;
      holdTime = max(0.001, sustain - attack - release);
      env = EnvGen.ar(Env.linen(attack, holdTime, release, 1, \\sin), doneAction: 2);
      sound = Pulse.ar(freq * speed, 0.5);
      sound = LPF.ar(sound, lpf.clip(20, 20000));
      sound = HPF.ar(sound, hpf.clip(20, 20000));
      sound = sound * env * amp * pow(gain, 4);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr, \\kr, \\kr, \\kr]).add;
    "Added: strudel_square".postln;
    
    // Triangle wave oscillator
    SynthDef(\\strudel_triangle, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                   attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                                   gain = 1, amp = 0.4, lpf = 20000, hpf = 0|
      var sound, env, holdTime;
      holdTime = max(0.001, sustain - attack - release);
      env = EnvGen.ar(Env.linen(attack, holdTime, release, 1, \\sin), doneAction: 2);
      sound = LFTri.ar(freq * speed);
      sound = LPF.ar(sound, lpf.clip(20, 20000));
      sound = HPF.ar(sound, hpf.clip(20, 20000));
      sound = sound * env * amp * pow(gain, 4);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr, \\kr, \\kr, \\kr]).add;
    "Added: strudel_triangle".postln;
    
    // Alias for triangle (superdough uses 'tri')
    SynthDef(\\strudel_tri, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                              attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                              gain = 1, amp = 0.4, lpf = 20000, hpf = 0|
      var sound, env, holdTime;
      holdTime = max(0.001, sustain - attack - release);
      env = EnvGen.ar(Env.linen(attack, holdTime, release, 1, \\sin), doneAction: 2);
      sound = LFTri.ar(freq * speed);
      sound = LPF.ar(sound, lpf.clip(20, 20000));
      sound = HPF.ar(sound, hpf.clip(20, 20000));
      sound = sound * env * amp * pow(gain, 4);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr, \\kr, \\kr, \\kr]).add;
    "Added: strudel_tri".postln;
    
    // White noise generator
    SynthDef(\\strudel_white, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                                gain = 1, amp = 0.4, lpf = 20000, hpf = 0|
      var sound, env, holdTime;
      holdTime = max(0.001, sustain - attack - release);
      env = EnvGen.ar(Env.linen(attack, holdTime, release, 1, \\sin), doneAction: 2);
      sound = WhiteNoise.ar;
      sound = LPF.ar(sound, lpf.clip(20, 20000));
      sound = HPF.ar(sound, hpf.clip(20, 20000));
      sound = sound * env * amp * pow(gain, 4);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr, \\kr, \\kr, \\kr]).add;
    "Added: strudel_white".postln;
    
    // Pink noise generator
    SynthDef(\\strudel_pink, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                               attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                               gain = 1, amp = 0.4, lpf = 20000, hpf = 0|
      var sound, env, holdTime;
      holdTime = max(0.001, sustain - attack - release);
      env = EnvGen.ar(Env.linen(attack, holdTime, release, 1, \\sin), doneAction: 2);
      sound = PinkNoise.ar;
      sound = LPF.ar(sound, lpf.clip(20, 20000));
      sound = HPF.ar(sound, hpf.clip(20, 20000));
      sound = sound * env * amp * pow(gain, 4);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr, \\kr, \\kr, \\kr]).add;
    "Added: strudel_pink".postln;
    
    // Brown noise generator
    SynthDef(\\strudel_brown, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                                gain = 1, amp = 0.4, lpf = 20000, hpf = 0|
      var sound, env, holdTime;
      holdTime = max(0.001, sustain - attack - release);
      env = EnvGen.ar(Env.linen(attack, holdTime, release, 1, \\sin), doneAction: 2);
      sound = BrownNoise.ar;
      sound = LPF.ar(sound, lpf.clip(20, 20000));
      sound = HPF.ar(sound, hpf.clip(20, 20000));
      sound = sound * env * amp * pow(gain, 4);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr, \\kr, \\kr, \\kr]).add;
    "Added: strudel_brown".postln;
    
    "*** Strudel oscillator SynthDefs loaded ***".postln;
    
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
 * IMPORTANT: The jackdbus daemon process may exist without the JACK server being started.
 * We need to check if the JACK server is actually running and accepting connections.
 */
export function isJackRunning(): boolean {
  if (platform() !== 'linux') {
    return true; // Assume OK on non-Linux
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
 */
export function startJack(device = 'hw:0'): { started: boolean; weStartedIt: boolean } {
  if (platform() !== 'linux') {
    return { started: true, weStartedIt: false };
  }

  if (isJackRunning()) {
    console.log('[jack] JACK is already running');
    return { started: true, weStartedIt: false };
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
