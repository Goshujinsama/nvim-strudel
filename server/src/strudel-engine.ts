import { repl } from '@strudel/core/repl.mjs';
import { evalScope } from '@strudel/core/evaluate.mjs';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import { transpiler } from '@strudel/transpiler';
import type { ActiveElement } from './types.js';
import { initOsc, sendHapToSuperDirt, isOscConnected, closeOsc } from './osc-output.js';

// NOTE: Web Audio API polyfill is initialized in index.ts before this module is imported.
// This ensures AudioContext is available before superdough checks for it.

// Import superdough for audio output
import { superdough, registerSynthSounds, registerZZFXSounds, aliasBank, samples as superdoughSamples, getAudioContext } from 'superdough';

// Import our custom soundfont loader (adapted for Node.js)
import { registerSoundfonts, getSoundfontNames } from './soundfonts.js';

// Track different types of sounds separately
const synthSounds: Set<string> = new Set();      // Synth waveforms (sine, saw, etc.)
const sampleBanks: Set<string> = new Set();      // Bank names for .bank() (RolandTR808, etc.)
const loadedSamples: Set<string> = new Set();    // All sample/sound names for s()/sound()

// REPL control functions - these are bound to the engine instance after initialization
// We use a mutable reference so evalScope can access them before the engine exists
const replControls = {
  hush: () => { console.warn('[strudel] hush() called before engine initialized'); },
  setcps: (_cps: number) => { console.warn('[strudel] setcps() called before engine initialized'); },
};

/**
 * Stop all sounds immediately (panic button)
 * This is exposed to user code via evalScope
 */
function hush(): void {
  replControls.hush();
}

/**
 * Set the tempo in cycles per second
 * This is exposed to user code via evalScope
 * @param cps - Cycles per second (e.g., 0.5 = 1 cycle every 2 seconds)
 */
function setcps(cps: number): void {
  replControls.setcps(cps);
}

/**
 * Wrapper around superdough's samples() that tracks loaded sample names.
 * This is exposed to user pattern code so they can load custom samples.
 * 
 * Usage in patterns:
 *   await samples('github:tidalcycles/dirt-samples')
 *   await samples('https://example.com/samples/strudel.json')
 *   await samples({ kick: ['kick.wav'], snare: ['snare.wav'] }, 'https://example.com/samples/')
 */
async function samples(
  source: string | Record<string, any>,
  baseUrl?: string,
  options?: { prebake?: string; tag?: string }
): Promise<void> {
  console.log(`[strudel-engine] Loading samples: ${typeof source === 'string' ? source : 'object'}`);
  
  // Track sample names before loading (no options needed - they're for superdough)
  await trackSampleNames(source, baseUrl);
  
  // Call the real samples() function
  await superdoughSamples(source, baseUrl, options);
  
  console.log(`[strudel-engine] Samples loaded, total available: ${loadedSamples.size}`);
}

/**
 * Track sample names from a sample source (for picker/completions)
 */
async function trackSampleNames(
  source: string | Record<string, any>,
  baseUrl?: string,
  options?: { isBankCollection?: boolean }
): Promise<void> {
  if (typeof source === 'object') {
    // Object source - get keys directly
    for (const key of Object.keys(source)) {
      if (!key.startsWith('_')) {
        loadedSamples.add(key);
      }
    }
  } else if (source.startsWith('github:')) {
    // GitHub source - convert to raw JSON URL and fetch
    const parts = source.replace('github:', '').split('/');
    const user = parts[0];
    const repo = parts[1] || 'samples';
    const branch = parts[2] || 'main';
    const jsonUrl = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/strudel.json`;
    try {
      const response = await fetch(jsonUrl);
      const json = await response.json();
      for (const key of Object.keys(json)) {
        if (!key.startsWith('_')) {
          loadedSamples.add(key);
        }
      }
    } catch (e) {
      console.warn(`[strudel-engine] Could not fetch sample map from ${jsonUrl}`);
    }
  } else if (source.startsWith('shabda:')) {
    // Shabda source - format: shabda:name1,name2:count
    const shabdaUrl = `https://shabda.ndre.gr/${source.slice(7)}.json?strudel=1`;
    try {
      const response = await fetch(shabdaUrl);
      const json = await response.json();
      for (const key of Object.keys(json)) {
        if (!key.startsWith('_')) {
          loadedSamples.add(key);
        }
      }
    } catch (e) {
      console.warn(`[strudel-engine] Could not fetch from shabda: ${source}`);
    }
  } else if (source.includes('.json') || source.startsWith('http')) {
    // JSON URL source - fetch to get sample names
    try {
      const response = await fetch(source);
      const json = await response.json();
      for (const key of Object.keys(json)) {
        if (!key.startsWith('_')) {
          loadedSamples.add(key);
          if (options?.isBankCollection) {
            sampleBanks.add(key);
          }
        }
      }
    } catch (e) {
      console.warn(`[strudel-engine] Could not fetch sample map from ${source}`);
    }
  }
}

// Initialize the Strudel scope with all the goodies
// Include our samples() wrapper so users can load custom samples in their patterns
// Also expose hush() and setcps() for REPL-level control from user code
await evalScope(
  core,
  mini,
  tonal,
  import('@strudel/core'),
  { samples, hush, setcps }, // Expose our wrappers to user code
);

// Register stub visualizer methods on Pattern.prototype
// These are no-ops in Node.js since we can't render to a canvas
// But we need them so code using visualizers doesn't crash
const visualizerMethods = [
  'pianoroll',
  'punchcard', 
  'wordfall',
  'spiral',
  'pitchwheel',
  'draw',
  'onPaint',
  'animate',
  'scope',
];

// Use core.Pattern to ensure we modify the same class that s() and other
// functions use (ESM can treat different import paths as different modules)
const Pattern = (core as any).Pattern;
const silence = (core as any).silence;
const PatternProto = Pattern.prototype as any;

for (const method of visualizerMethods) {
  if (!PatternProto[method]) {
    // Return 'this' to allow chaining
    PatternProto[method] = function() { return this; };
  }
}
console.log('[strudel-engine] Visualizer stubs registered (pianoroll, punchcard, etc.)');

// Register .p() and .q() methods for labeled pattern syntax (gtr: s("bd"))
// These are normally injected by the REPL, but we need them before first eval
// pPatterns will be populated by the REPL's own injectPatternMethods later
if (!PatternProto.p) {
  PatternProto.p = function(id: string) {
    // The REPL will override this with its own implementation that stores patterns
    // This stub just allows the syntax to work on first eval
    return this;
  };
}
if (!PatternProto.q) {
  PatternProto.q = function(_id: string) {
    return silence;
  };
}
// Also add d1-d9 and p1-p9 getters for convenience
for (let i = 1; i < 10; i++) {
  const di = `d${i}`;
  const pi = `p${i}`;
  const qi = `q${i}`;
  if (!Object.getOwnPropertyDescriptor(PatternProto, di)) {
    Object.defineProperty(PatternProto, di, {
      get() { return this.p(i); },
      configurable: true,
    });
  }
  if (!Object.getOwnPropertyDescriptor(PatternProto, pi)) {
    Object.defineProperty(PatternProto, pi, {
      get() { return this.p(i); },
      configurable: true,
    });
  }
  if (!PatternProto[qi]) {
    PatternProto[qi] = silence;
  }
}
console.log('[strudel-engine] Pattern label methods registered (.p(), .q(), .d1-.d9, .p1-.p9)');

// Initialize superdough synth sounds
await registerSynthSounds();
// Add synth sound names - these are waveform synthesizers
const synthWaveforms = ['sine', 'sawtooth', 'square', 'triangle', 'saw', 'tri'];
const noiseTypes = ['white', 'pink', 'brown'];
[...synthWaveforms, ...noiseTypes].forEach(s => {
  synthSounds.add(s);
  loadedSamples.add(s);
});
console.log('[strudel-engine] Synth sounds registered (sine, sawtooth, square, triangle)');

// Register ZZFX chip sounds (retro/chiptune style)
await registerZZFXSounds();
console.log('[strudel-engine] ZZFX sounds registered (chip sounds)');

// Register GM soundfont instruments (gm_piano, gm_violin, etc.)
registerSoundfonts();
// Add soundfont names to the samples list
getSoundfontNames().forEach(name => {
  loadedSamples.add(name);
});
console.log(`[strudel-engine] Soundfonts registered: ${getSoundfontNames().length} GM instruments`);

// Load sample packs (same as Strudel web UI defaults)
// See: https://codeberg.org/uzu/strudel/src/branch/main/website/src/repl/prebake.mjs
console.log('[strudel-engine] Loading sample packs...');

const baseCDN = 'https://strudel.b-cdn.net';

// Load samples in parallel for faster startup
const sampleLoaders: Promise<void>[] = [
  // Salamander Grand Piano - CC-by Alexander Holm
  samples(`${baseCDN}/piano.json`, `${baseCDN}/piano/`).then(() => 
    console.log('[strudel-engine] Loaded: piano')),
  
  // VCSL - Virtual Community Sample Library - CC0
  samples(`${baseCDN}/vcsl.json`, `${baseCDN}/VCSL/`).then(() => 
    console.log('[strudel-engine] Loaded: VCSL (instruments)')),
  
  // Tidal Drum Machines - TR808, TR909, etc. - these are BANKS
  // We need to track these as bank collections for the .bank() function
  (async () => {
    await trackSampleNames(
      `${baseCDN}/tidal-drum-machines.json`,
      `${baseCDN}/tidal-drum-machines/machines/`,
      { isBankCollection: true }
    );
    await superdoughSamples(
      `${baseCDN}/tidal-drum-machines.json`,
      `${baseCDN}/tidal-drum-machines/machines/`
    );
    // Also load the bank alias file for short names like "Linn" -> "AkaiLinn"
    // and track the alias short names for the picker
    const aliasUrl = `${baseCDN}/tidal-drum-machines-alias.json`;
    await aliasBank(aliasUrl);
    // Fetch alias file to track short names for picker
    try {
      const resp = await fetch(aliasUrl);
      const aliases = await resp.json() as Record<string, string>;
      // aliases maps full name -> short name, we want the short names
      for (const shortName of Object.values(aliases)) {
        sampleBanks.add(shortName);
      }
      console.log(`[strudel-engine] Loaded: tidal-drum-machines (with ${Object.keys(aliases).length} aliases)`);
    } catch (e) {
      console.log('[strudel-engine] Loaded: tidal-drum-machines (aliases failed to load)');
    }
  })(),
  
  // Mridangam samples
  samples(`${baseCDN}/mridangam.json`, `${baseCDN}/mrid/`).then(() => 
    console.log('[strudel-engine] Loaded: mridangam')),
  
  // Misc samples from Dirt-Samples
  samples(
    {
      casio: ['casio/high.wav', 'casio/low.wav', 'casio/noise.wav'],
      crow: ['crow/000_crow.wav', 'crow/001_crow2.wav', 'crow/002_crow3.wav', 'crow/003_crow4.wav'],
      insect: [
        'insect/000_everglades_conehead.wav',
        'insect/001_robust_shieldback.wav', 
        'insect/002_seashore_meadow_katydid.wav',
      ],
      wind: [
        'wind/000_wind1.wav', 'wind/001_wind10.wav', 'wind/002_wind2.wav', 'wind/003_wind3.wav',
        'wind/004_wind4.wav', 'wind/005_wind5.wav', 'wind/006_wind6.wav', 'wind/007_wind7.wav',
        'wind/008_wind8.wav', 'wind/009_wind9.wav',
      ],
      jazz: [
        'jazz/000_BD.wav', 'jazz/001_CB.wav', 'jazz/002_FX.wav', 'jazz/003_HH.wav',
        'jazz/004_OH.wav', 'jazz/005_P1.wav', 'jazz/006_P2.wav', 'jazz/007_SN.wav',
      ],
      metal: [
        'metal/000_0.wav', 'metal/001_1.wav', 'metal/002_2.wav', 'metal/003_3.wav',
        'metal/004_4.wav', 'metal/005_5.wav', 'metal/006_6.wav', 'metal/007_7.wav',
        'metal/008_8.wav', 'metal/009_9.wav',
      ],
      east: [
        'east/000_nipon_wood_block.wav', 'east/001_ohkawa_mute.wav', 'east/002_ohkawa_open.wav',
        'east/003_shime_hi.wav', 'east/004_shime_hi_2.wav', 'east/005_shime_mute.wav',
        'east/006_taiko_1.wav', 'east/007_taiko_2.wav', 'east/008_taiko_3.wav',
      ],
      space: [
        'space/000_0.wav', 'space/001_1.wav', 'space/002_11.wav', 'space/003_12.wav',
        'space/004_13.wav', 'space/005_14.wav', 'space/006_15.wav', 'space/007_16.wav',
        'space/008_17.wav', 'space/009_18.wav', 'space/010_2.wav', 'space/011_3.wav',
        'space/012_4.wav', 'space/013_5.wav', 'space/014_6.wav', 'space/015_7.wav',
        'space/016_8.wav', 'space/017_9.wav',
      ],
      numbers: [
        'numbers/0.wav', 'numbers/1.wav', 'numbers/2.wav', 'numbers/3.wav', 'numbers/4.wav',
        'numbers/5.wav', 'numbers/6.wav', 'numbers/7.wav', 'numbers/8.wav',
      ],
    },
    `${baseCDN}/Dirt-Samples/`,
  ).then(() => console.log('[strudel-engine] Loaded: Dirt-Samples (misc)')),
  
  // Also load the github dirt-samples for additional sounds
  samples('github:tidalcycles/dirt-samples').then(() => 
    console.log('[strudel-engine] Loaded: github:tidalcycles/dirt-samples')),
];

// Wait for all samples to load, but don't fail if some don't load
await Promise.allSettled(sampleLoaders);
console.log('[strudel-engine] Sample loading complete!');



/**
 * Strudel pattern evaluation engine
 * Uses the actual Strudel REPL for pattern evaluation and scheduling
 */
export class StrudelEngine {
  private repl: ReturnType<typeof repl> | null = null;
  private playing = false;
  private cycle = 0;
  private cps = 1;
  private onActiveCallback: ((elements: ActiveElement[], cycle: number) => void) | null = null;
  private activeElements: ActiveElement[] = [];
  private broadcastTimer: NodeJS.Timeout | null = null;
  private oscEnabled = false;
  private webAudioEnabled = true; // Enable by default
  private currentCode = ''; // Store current code for offset->line/col conversion
  private lastEvalError: string | null = null; // Track eval errors

  constructor() {
    this.initRepl();
    
    // Bind REPL control functions so they work from user code
    replControls.hush = () => this.hush();
    replControls.setcps = (cps: number) => this.setCps(cps);
    
    console.log('[strudel-engine] Engine initialized');
    
    // Log audio context state
    const ctx = getAudioContext();
    console.log(`[strudel-engine] AudioContext: ${ctx.state}, ${ctx.sampleRate}Hz`);
  }

  /**
   * Enable/disable Web Audio output (superdough)
   */
  setWebAudioEnabled(enabled: boolean): void {
    this.webAudioEnabled = enabled;
    console.log(`[strudel-engine] Web Audio ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Check if Web Audio is enabled
   */
  isWebAudioEnabled(): boolean {
    return this.webAudioEnabled;
  }

  /**
   * Enable OSC output to SuperDirt
   * Call this to send audio to SuperCollider/SuperDirt
   */
  async enableOsc(host = '127.0.0.1', port = 57120): Promise<boolean> {
    try {
      await initOsc(host, port);
      this.oscEnabled = true;
      console.log('[strudel-engine] OSC output enabled');
      return true;
    } catch (err) {
      console.error('[strudel-engine] Failed to enable OSC:', err);
      return false;
    }
  }

  /**
   * Disable OSC output
   */
  disableOsc(): void {
    closeOsc();
    this.oscEnabled = false;
    console.log('[strudel-engine] OSC output disabled');
  }

  /**
   * Check if OSC is enabled and connected
   */
  isOscEnabled(): boolean {
    return this.oscEnabled && isOscConnected();
  }

  /**
   * Convert a byte offset to line/column (1-based)
   */
  private offsetToLineCol(offset: number): { line: number; column: number } {
    const lines = this.currentCode.split('\n');
    let currentOffset = 0;
    
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const lineLength = lines[lineIndex].length + 1; // +1 for newline
      if (currentOffset + lineLength > offset) {
        return {
          line: lineIndex + 1, // 1-based
          column: offset - currentOffset + 1, // 1-based
        };
      }
      currentOffset += lineLength;
    }
    
    // Fallback to end of file
    return { line: lines.length, column: (lines[lines.length - 1]?.length || 0) + 1 };
  }

  private initRepl() {
    // Use AudioContext time for synchronization with superdough
    const getTime = () => {
      return getAudioContext().currentTime;
    };

    // Pre-calculate line offsets for faster offset->line/col conversion
    let lineOffsets: number[] = [];
    
    // Fast offset to line/col using pre-calculated offsets
    const fastOffsetToLineCol = (offset: number): { line: number; column: number } => {
      // Binary search for the line
      let low = 0, high = lineOffsets.length - 1;
      while (low < high) {
        const mid = Math.floor((low + high + 1) / 2);
        if (lineOffsets[mid] <= offset) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      return {
        line: low + 1, // 1-based
        column: offset - lineOffsets[low] + 1, // 1-based
      };
    };

    this.repl = repl({
      transpiler, // Use the official Strudel transpiler for proper source location tracking
      onEvalError: (err: Error) => {
        // Capture eval errors so we can return them from eval()
        this.lastEvalError = err.message;
        console.error('[strudel-engine] Eval error:', err.message);
      },
      // Type says async but we return synchronously for tight timing - this is fine
      // The Web Audio API handles the actual scheduling via absoluteTime
      defaultOutput: async (hap: any, deadline: number, duration: number, cps: number, t: number): Promise<void> => {
        // IMPORTANT: Don't await superdough - fire and forget for tight timing
        // The Web Audio API handles scheduling internally via absoluteTime
        
        // Play sound via superdough (Web Audio)
        if (this.webAudioEnabled) {
          // Use the absolute time 't' directly - this is what strudel's webaudio.mjs does
          // The 't' parameter is the precise target time for this event
          // See: https://github.com/tidalcycles/strudel/pull/1004
          // Fire and forget - don't await, let Web Audio handle the timing
          superdough(hap.value, t, duration, cps, hap.whole?.begin?.valueOf()).catch((err) => {
            // Only log errors for debugging, and do it asynchronously
            const sound = hap.value?.s || hap.value?.note || '?';
            console.warn(`[strudel-engine] Audio error for "${sound}": ${err instanceof Error ? err.message : err}`);
          });
        }
        
        // Also send to SuperDirt via OSC if enabled
        if (this.oscEnabled && isOscConnected()) {
          sendHapToSuperDirt(hap, deadline, cps);
        }
        
        // Defer visualization work to avoid blocking audio scheduling
        // Use setImmediate to run after current I/O events
        const locations = hap.context?.locations;
        if (locations && locations.length > 0) {
          const value = typeof hap.value === 'object' 
            ? (hap.value.s || hap.value.note || '?') 
            : String(hap.value);
          
          // Capture locations and process in next tick
          setImmediate(() => {
            for (let i = 0; i < locations.length; i++) {
              const loc = locations[i];
              if (typeof loc.start === 'number' && typeof loc.end === 'number') {
                const startPos = fastOffsetToLineCol(loc.start);
                const endPos = fastOffsetToLineCol(loc.end);
                this.activeElements.push({
                  startLine: startPos.line,
                  startCol: startPos.column,
                  endLine: endPos.line,
                  endCol: endPos.column,
                  value,
                });
              } else if (loc.start?.line && loc.end?.line) {
                this.activeElements.push({
                  startLine: loc.start.line,
                  startCol: loc.start.column,
                  endLine: loc.end.line,
                  endCol: loc.end.column,
                  value,
                });
              }
            }
          });
        }
      },
      getTime,
      onToggle: (started: boolean) => {
        this.playing = started;
        console.log(`[strudel-engine] ${started ? 'Started' : 'Stopped'}`);
        
        // Start/stop broadcast timer
        if (started) {
          this.startBroadcasting();
        } else {
          this.stopBroadcasting();
        }
      },
      onUpdateState: (state: any) => {
        this.cycle = this.repl?.scheduler?.now?.() || 0;
      },
      beforeEval: async () => {
        // Clear active elements before new eval
        this.activeElements = [];
        // Pre-calculate line offsets for fast offset->line/col conversion
        lineOffsets = [0];
        for (let i = 0; i < this.currentCode.length; i++) {
          if (this.currentCode[i] === '\n') {
            lineOffsets.push(i + 1);
          }
        }
      },
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (id: NodeJS.Timeout) => clearInterval(id),
    });
  }
  
  private startBroadcasting() {
    if (this.broadcastTimer) return;
    
    this.broadcastTimer = setInterval(() => {
      if (this.onActiveCallback && this.activeElements.length > 0) {
        const cycle = this.repl?.scheduler?.now?.() || this.cycle;
        this.onActiveCallback([...this.activeElements], cycle);
        this.activeElements = [];
      }
    }, 50); // 20fps updates
  }
  
  private stopBroadcasting() {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    // Send empty elements to clear visualization
    if (this.onActiveCallback) {
      this.onActiveCallback([], this.cycle);
    }
    this.activeElements = [];
  }

  /**
   * Evaluate Strudel code and create a pattern
   */
  async eval(code: string): Promise<{ success: boolean; error?: string }> {
    if (!this.repl) {
      return { success: false, error: 'REPL not initialized' };
    }

    try {
      // Store the code for offset->line/col conversion
      this.currentCode = code;
      // Clear any previous eval error
      this.lastEvalError = null;
      
      console.log('[strudel-engine] Evaluating code:', code.substring(0, 100) + (code.length > 100 ? '...' : ''));
      
      await this.repl.evaluate(code, true);
      
      // Check if an error was captured via onEvalError callback
      if (this.lastEvalError) {
        return { success: false, error: this.lastEvalError };
      }
      
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[strudel-engine] Eval error:', message);
      return { success: false, error: message };
    }
  }

  /**
   * Start playback
   * @returns true if playback started, false if no pattern to play
   */
  play(): boolean {
    if (!this.repl) return false;
    if (!this.currentCode) {
      console.log('[strudel-engine] No pattern to play - evaluate code first');
      return false;
    }
    this.repl.start();
    return true;
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (!this.repl) return;
    this.repl.pause();
  }

  /**
   * Stop playback and reset
   */
  stop(): void {
    if (!this.repl) return;
    this.repl.stop();
    this.stopBroadcasting();
    this.cycle = 0;
  }

  /**
   * Hush - stop everything and silence all sounds immediately
   * This is the panic button - silences everything
   */
  hush(): void {
    if (!this.repl) return;
    this.repl.stop();
    this.stopBroadcasting();
    this.cycle = 0;
    
    // Clear any pending audio by suspending and resuming the audio context
    const ctx = getAudioContext();
    if (ctx.state === 'running') {
      ctx.suspend().then(() => {
        ctx.resume();
        console.log('[strudel-engine] Audio context reset (hush)');
      });
    }
    
    console.log('[strudel-engine] Hush!');
  }

  /**
   * Register callback for active elements
   */
  onActive(callback: (elements: ActiveElement[], cycle: number) => void): void {
    this.onActiveCallback = callback;
  }

  /**
   * Get current playback state
   */
  getState(): { playing: boolean; cycle: number; cps: number } {
    return {
      playing: this.playing,
      cycle: this.repl?.scheduler?.now?.() || this.cycle,
      cps: this.repl?.scheduler?.cps || this.cps,
    };
  }

  /**
   * Set cycles per second (tempo)
   */
  setCps(cps: number): void {
    this.cps = cps;
    this.repl?.setCps(cps);
  }

  /**
   * Get all loaded sample/sound names (for s() / sound())
   */
  getSamples(): string[] {
    return Array.from(loadedSamples).sort();
  }

  /**
   * Get synth sound names (sine, saw, square, etc.)
   */
  getSounds(): string[] {
    return Array.from(synthSounds).sort();
  }

  /**
   * Get sample bank names (for .bank())
   */
  getBanks(): string[] {
    return Array.from(sampleBanks).sort();
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    this.stop();
    this.disableOsc();
    console.log('[strudel-engine] Disposed');
  }
}
