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
  private isRunning = false;
  private options: Required<SuperDirtLauncherOptions>;
  private tempScriptPath: string | null = null;

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
   */
  private generateStartupScript(): string {
    const { port, channels, orbits } = this.options;
    
    // Escape the path for SuperCollider string
    const escapedSamplesDir = STRUDEL_SAMPLES_DIR.replace(/\\/g, '\\\\');
    
    return `(
// Optimized server settings for heavy sample usage
s.options.numBuffers = 1024 * 256;  // 262144 buffers for samples
s.options.memSize = 8192 * 32;      // 256MB memory
s.options.numWireBufs = 128;        // More interconnect buffers
s.options.maxNodes = 1024 * 32;     // 32768 nodes

s.waitForBoot {
    "*** SuperCollider server booted ***".postln;
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
    
    // OSC handler for dynamic sample loading from Strudel
    // When new samples are downloaded, the server sends this message
    OSCdef(\\strudelLoadSamples, { |msg|
        var path = msg[1].asString;
        "Strudel: Loading samples from %".format(path).postln;
        ~dirt.loadSoundFiles(path);
        "Strudel: Samples loaded".postln;
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
      });

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
   */
  stop(): void {
    if (this.sclangProcess) {
      console.log('[superdirt] Stopping sclang...');
      
      // Try graceful shutdown first
      this.sclangProcess.kill('SIGTERM');
      
      // Force kill after timeout
      setTimeout(() => {
        if (this.sclangProcess && !this.sclangProcess.killed) {
          console.log('[superdirt] Force killing sclang...');
          this.sclangProcess.kill('SIGKILL');
        }
      }, 2000);
    }
    
    this.cleanup();
    this.isRunning = false;
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
 * Check if JACK is running (Linux only)
 * Tries multiple detection methods: jack_control (DBus), jack_lsp, and process check
 */
export function isJackRunning(): boolean {
  if (platform() !== 'linux') {
    return true; // Assume OK on non-Linux
  }
  
  // Method 1: Try jack_control (DBus) - most reliable on modern systems
  try {
    const result = execSync('jack_control status 2>&1', { timeout: 5000 }).toString();
    if (result.includes('started')) {
      return true;
    }
  } catch {
    // jack_control not available or failed
  }
  
  // Method 2: Try jack_lsp (classic method)
  try {
    execSync('jack_lsp', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    // jack_lsp not available or JACK not running
  }
  
  // Method 3: Check if jackd or jackdbus process is running
  try {
    const result = execSync('pgrep -x "jackd|jackdbus" 2>/dev/null', { timeout: 5000 }).toString();
    if (result.trim()) {
      return true;
    }
  } catch {
    // No JACK process found
  }
  
  return false;
}

/**
 * Start JACK with default settings (Linux only)
 * Prefers jack_control (DBus) if available, falls back to jackd
 */
export function startJack(device = 'hw:0'): boolean {
  if (platform() !== 'linux') {
    return true;
  }

  if (isJackRunning()) {
    console.log('[jack] JACK is already running');
    return true;
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
        return true;
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
      return true;
    } else {
      console.error('[jack] JACK failed to start');
      return false;
    }
  } catch (err) {
    console.error('[jack] Failed to start JACK:', err);
    return false;
  }
}
