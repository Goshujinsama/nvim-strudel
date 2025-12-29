import { repl } from '@strudel/core/repl.mjs';
import { evalScope } from '@strudel/core/evaluate.mjs';
import { Pattern, silence } from '@strudel/core/pattern.mjs';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import { transpiler } from '@strudel/transpiler';
import type { ActiveElement, VisualizationEvent } from './types.js';
import { initOsc, sendHapToSuperDirt, isOscConnected, closeOsc, setAudioContextStartTime } from './osc-output.js';
import { writeEngineState, clearEngineState } from './engine-state.js';
import { loadSamples as loadSamplesForSuperDirt, initSampleManager, notifySuperDirtLoadSamples, setupOscPort } from './sample-manager.js';
import { loadSoundsForCode, ensureDrumMachineMetadataLoaded } from './on-demand-loader.js';
import { registerBankMetadata } from './sample-metadata.js';

// NOTE: Web Audio API polyfill is initialized in index.ts before this module is imported.
// This ensures AudioContext is available before superdough checks for it.

// Import superdough for audio output
import { superdough, registerSynthSounds, registerZZFXSounds, aliasBank, samples as superdoughSamples, getAudioContext } from 'superdough';

// Import our custom soundfont loader (adapted for Node.js)
import { registerSoundfonts, getSoundfontNames } from './soundfonts.js';

// Import the worklet loader and cleanup function
import { loadNodeWorklets, cancelScheduledDisconnects } from './audio-polyfill.js';

// Initialize MIDI polyfill BEFORE importing @strudel/midi
// This provides navigator.requestMIDIAccess using node-midi (RtMidi)
import { initMidiPolyfill, closeMidi } from './midi-polyfill.js';
initMidiPolyfill();

// MIDI support - now safe to import since we've polyfilled Web MIDI API
let strudelMidi: typeof import('@strudel/midi') | null = null;
try {
  strudelMidi = await import('@strudel/midi');
  console.log('[strudel-engine] MIDI module loaded');
} catch (err) {
  console.log('[strudel-engine] MIDI support not available:', err instanceof Error ? err.message : err);
}

// Track different types of sounds separately
const synthSounds: Set<string> = new Set();      // Synth waveforms (sine, saw, etc.)
const sampleBanks: Set<string> = new Set();      // Bank names for .bank() (RolandTR808, etc.)
const loadedSamples: Set<string> = new Set();    // All sample/sound names for s()/sound()

// Maximum active elements to prevent unbounded memory growth between broadcasts
// At 50ms broadcast interval and typical patterns, 500 should be more than enough
const MAX_ACTIVE_ELEMENTS = 500;

// Flag to enable SuperDirt sample downloading (set by engine when OSC mode is active)
let oscModeEnabled = false;
let oscPortRef: any = null;

/**
 * Enable OSC mode for sample loading
 * When enabled, samples() will also download and cache for SuperDirt
 */
export function enableOscSampleLoading(oscPort: any): void {
  oscModeEnabled = true;
  oscPortRef = oscPort;
  setupOscPort(oscPort);
  initSampleManager().catch(err => {
    console.error('[strudel-engine] Failed to init sample manager:', err);
  });
}

// REPL control functions - these are bound to the engine instance after initialization
// We use a mutable reference so evalScope can access them before the engine exists
const replControls = {
  hush: () => { console.warn('[strudel] hush() called before engine initialized'); },
  setcps: (_cps: number) => { console.warn('[strudel] setcps() called before engine initialized'); },
  requestVisualization: () => { console.warn('[strudel] visualization requested before engine initialized'); },
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
  
  // If OSC mode is enabled, also download samples for SuperDirt
  if (oscModeEnabled) {
    try {
      console.log('[strudel-engine] Downloading samples for SuperDirt...');
      const { bankPath, bankNames } = await loadSamplesForSuperDirt(source, baseUrl);
      if (bankNames.length > 0) {
        console.log(`[strudel-engine] SuperDirt samples ready: ${bankNames.join(', ')}`);
        // Notify SuperDirt to reload samples
        notifySuperDirtLoadSamples(bankPath);
      }
    } catch (err) {
      console.error('[strudel-engine] Failed to load samples for SuperDirt:', err);
      // Continue anyway - WebAudio samples will still work
    }
  }
  
  // Call the real samples() function for WebAudio
  await superdoughSamples(source, baseUrl, options);
  
  console.log(`[strudel-engine] Samples loaded, total available: ${loadedSamples.size}`);
}

/**
 * Track sample names from a sample source (for picker/completions)
 * Also registers metadata for pitched sample banks (for OSC output)
 */
async function trackSampleNames(
  source: string | Record<string, any>,
  baseUrl?: string,
  options?: { isBankCollection?: boolean }
): Promise<void> {
  if (typeof source === 'object') {
    // Object source - get keys directly and register metadata
    for (const [key, value] of Object.entries(source)) {
      if (!key.startsWith('_')) {
        loadedSamples.add(key);
        // Register metadata for this bank
        registerBankMetadata(key, value);
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
      const json = await response.json() as Record<string, any>;
      for (const [key, value] of Object.entries(json)) {
        if (!key.startsWith('_')) {
          loadedSamples.add(key);
          registerBankMetadata(key, value);
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
      const json = await response.json() as Record<string, any>;
      for (const [key, value] of Object.entries(json)) {
        if (!key.startsWith('_')) {
          loadedSamples.add(key);
          registerBankMetadata(key, value);
        }
      }
    } catch (e) {
      console.warn(`[strudel-engine] Could not fetch from shabda: ${source}`);
    }
  } else if (source.includes('.json') || source.startsWith('http')) {
    // JSON URL source - fetch to get sample names and metadata
    try {
      const response = await fetch(source);
      const json = await response.json() as Record<string, any>;
      for (const [key, value] of Object.entries(json)) {
        if (!key.startsWith('_')) {
          loadedSamples.add(key);
          if (options?.isBankCollection) {
            sampleBanks.add(key);
          }
          registerBankMetadata(key, value);
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
const scopeModules: any[] = [
  core,
  mini,
  tonal,
  import('@strudel/core'),
  { samples, hush, setcps }, // Expose our wrappers to user code
];

// Add MIDI module to scope if it loaded successfully
if (strudelMidi) {
  scopeModules.push(strudelMidi);
}

await evalScope(...scopeModules);

// Register stub visualizer methods on Pattern.prototype
// These are no-ops in Node.js since we can't render to a canvas
// But we need them so code using visualizers doesn't crash
// When called, they trigger a visualization request to the client
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

// The @strudel/core package has TWO Pattern classes:
// 1. Pattern from pattern.mjs (source file) - used by repl.mjs
// 2. Pattern from dist/index.mjs (bundle) - used by s() and other functions
// We need to set .p() on BOTH to ensure it works everywhere
const PatternProto = Pattern.prototype as any;
const BundledPatternProto = (core as any).Pattern.prototype;

for (const method of visualizerMethods) {
  if (!PatternProto[method]) {
    // Request visualization and return 'this' to allow chaining
    PatternProto[method] = function() { 
      replControls.requestVisualization();
      return this; 
    };
  }
}
console.log('[strudel-engine] Visualizer stubs registered (pianoroll, punchcard, etc.)');

// Register .p() and .q() methods for labeled pattern syntax (gtr: s("bd"))
// These are normally injected by the REPL, but we need them before first eval
// pPatterns will be populated by the REPL's own injectPatternMethods later
// Set .p() and .q() on both Pattern prototypes
// The REPL's injectPatternMethods will set the real .p() on PatternProto (source Pattern)
// We make BundledPatternProto delegate to PatternProto so it uses the same .p()

// First, set up stubs on the source Pattern (REPL will override these)
if (!PatternProto.p) {
  PatternProto.p = function(id: string) {
    return this;
  };
}
if (!PatternProto.q) {
  PatternProto.q = function(_id: string) {
    return silence;
  };
}

// Make the bundled Pattern delegate .p() and .q() to the source Pattern
// This way, when REPL sets PatternProto.p, it affects both Pattern classes
Object.defineProperty(BundledPatternProto, 'p', {
  get() { return PatternProto.p; },
  configurable: true
});
Object.defineProperty(BundledPatternProto, 'q', {
  get() { return PatternProto.q; },
  configurable: true
});
// Also add d1-d9 and p1-p9 getters for convenience (on both Pattern prototypes)
for (let i = 1; i < 10; i++) {
  const di = `d${i}`;
  const pi = `p${i}`;
  const qi = `q${i}`;

  // Source Pattern
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

  // Bundled Pattern - delegate to source Pattern (use this.p(i) which delegates correctly)
  if (!Object.getOwnPropertyDescriptor(BundledPatternProto, di)) {
    Object.defineProperty(BundledPatternProto, di, {
      get() { return this.p(i); },
      configurable: true,
    });
  }
  if (!Object.getOwnPropertyDescriptor(BundledPatternProto, pi)) {
    Object.defineProperty(BundledPatternProto, pi, {
      get() { return this.p(i); },
      configurable: true,
    });
  }
  if (!BundledPatternProto[qi]) {
    BundledPatternProto[qi] = silence;
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
    
    // Also ensure drum machine metadata is loaded for OSC bank name resolution
    await ensureDrumMachineMetadataLoaded();
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
console.log(`[strudel-engine] Available: ${loadedSamples.size} samples, ${sampleBanks.size} banks`);

// Note: State file is written by setPort() after server starts listening
// It only contains connection info (pid, port), not samples/banks
// LSP connects via TCP to get samples/banks



/**
 * Strudel pattern evaluation engine
 * Uses the actual Strudel REPL for pattern evaluation and scheduling
 */
export class StrudelEngine {
  private repl: ReturnType<typeof repl> | null = null;
  private playing = false;  // True when not stopped (true for both play and pause)
  private paused = false;   // True when paused
  private isPausing = false; // Flag to distinguish pause from stop in onToggle
  private pausedAtCycle = 0; // Cycle position when paused (for visualization)
  private cycle = 0;
  private cps = 1;
  private onActiveCallback: ((elements: ActiveElement[], cycle: number) => void) | null = null;
  private onVisualizationRequestCallback: (() => void) | null = null;
  private activeElements: ActiveElement[] = [];
  private broadcastTimer: NodeJS.Timeout | null = null;
  private oscEnabled = false;
  private webAudioEnabled = true; // Enable by default
  private currentCode = ''; // Store current code for offset->line/col conversion
  private lastEvalError: string | null = null; // Track eval errors
  private serverPort = 0; // Track the server port for state file

  constructor() {
    this.initRepl();
    
    // Bind REPL control functions so they work from user code
    replControls.hush = () => this.hush();
    replControls.setcps = (cps: number) => this.setCps(cps);
    replControls.requestVisualization = () => this.requestVisualization();
    
    console.log('[strudel-engine] Engine initialized');
    
    // Log audio context state and load worklets
    const ctx = getAudioContext();
    console.log(`[strudel-engine] AudioContext: ${ctx.state}, ${ctx.sampleRate}Hz`);
    
    // Record when the AudioContext was created for OSC timing synchronization
    // AudioContext.currentTime starts at 0, so the start time is now minus currentTime
    const audioContextStartTime = Date.now() / 1000 - ctx.currentTime;
    setAudioContextStartTime(audioContextStartTime);
    
    // Load our Node.js-compatible worklets onto the audio context
    loadNodeWorklets(ctx).catch(err => {
      console.error('[strudel-engine] Failed to load worklets:', err);
    });
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

        // Determine the sound name to check if it's a synth
        const soundName = hap.value?.s || '';
        const isSynthSound = synthSounds.has(soundName);

        // Routing logic:
        // - Synth sounds (sine, sawtooth, etc.) -> Web Audio only (SuperDirt doesn't have these)
        // - Sample sounds when OSC connected -> OSC only (avoid double-playing)
        // - Sample sounds when OSC not connected -> Web Audio
        const useWebAudioForThis = this.webAudioEnabled && (isSynthSound || !this.oscEnabled || !isOscConnected());
        const useOscForThis = this.oscEnabled && isOscConnected() && !isSynthSound;

        // Play sound via superdough (Web Audio)
        if (useWebAudioForThis) {
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

        // Send to SuperDirt via OSC for sample sounds
        // Pass 't' (target time in AudioContext seconds) for proper scheduling
        if (useOscForThis) {
          sendHapToSuperDirt(hap, t, cps);
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
            // Cap active elements to prevent unbounded memory growth
            if (this.activeElements.length >= MAX_ACTIVE_ELEMENTS) {
              return;
            }

            for (let i = 0; i < locations.length; i++) {
              // Stop if we hit the cap
              if (this.activeElements.length >= MAX_ACTIVE_ELEMENTS) {
                break;
              }

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
        console.log(`[strudel-engine] onToggle: ${started ? 'Started' : 'Paused/Stopped'}`);
        
        if (started) {
          this.playing = true;
          this.paused = false;
          this.startBroadcasting();
        } else {
          // Check if this was a pause or stop
          if (this.isPausing) {
            this.paused = true;
            // pausedAtCycle already captured in pause() before repl.pause()
            // playing stays true
            // Keep broadcasting so pianoroll maintains playhead position
            this.isPausing = false;
          } else {
            // It's a stop
            this.playing = false;
            this.paused = false;
            this.stopBroadcasting();
          }
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
      
      // If OSC mode is enabled, load any missing sounds on-demand before eval
      if (oscModeEnabled) {
        const loadedSounds = await loadSoundsForCode(code);
        if (loadedSounds.length > 0) {
          console.log(`[strudel-engine] On-demand loaded for OSC: ${loadedSounds.join(', ')}`);
        }
      }
      
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
    console.log('[strudel-engine] play() called, repl:', !!this.repl, 'code:', !!this.currentCode);
    if (!this.repl) return false;
    if (!this.currentCode) {
      console.log('[strudel-engine] No pattern to play - evaluate code first');
      return false;
    }
    console.log('[strudel-engine] Calling repl.start()...');
    this.repl.start();
    console.log('[strudel-engine] repl.start() returned');
    return true;
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (!this.repl) return;
    // Capture cycle position BEFORE pausing, as scheduler may reset
    const scheduler = (this.repl as any)?.scheduler;
    this.pausedAtCycle = scheduler?.now?.() || this.cycle;
    this.isPausing = true; // Flag so onToggle knows this is a pause
    this.repl.pause();
  }

  /**
   * Stop playback and reset
   */
  stop(): void {
    if (!this.repl) return;
    this.repl.stop();
    this.cycle = 0;
    // Cancel scheduled worklet disconnects (cleanup any lingering worklets)
    cancelScheduledDisconnects();
  }

  /**
   * Hush - stop everything and silence all sounds immediately
   * This is the panic button - silences everything
   */
  hush(): void {
    if (!this.repl) return;
    this.repl.stop();
    this.cycle = 0;
    
    // Cancel scheduled worklet disconnects and disconnect immediately
    cancelScheduledDisconnects();
    
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
   * Register callback for visualization requests (when code uses pianoroll/punchcard)
   */
  onVisualizationRequest(callback: () => void): void {
    this.onVisualizationRequestCallback = callback;
  }

  /**
   * Trigger visualization request callback (called when pianoroll/punchcard is used in code)
   */
  requestVisualization(): void {
    if (this.onVisualizationRequestCallback) {
      this.onVisualizationRequestCallback();
    }
  }

  /**
   * Get current playback state
   */
  getState(): { playing: boolean; paused: boolean; cycle: number; cps: number } {
    return {
      playing: this.playing,
      paused: this.paused,
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
   * Query the current pattern for visualization data
   * Returns haps grouped by track (sound/note name) for the display window
   * Also includes note-level data for braille pianoroll mode
   * @param displayCycles Number of cycles to show in the visualization
   * @param smooth If true, window scrolls smoothly with playhead at left edge
   */
  queryVisualization(displayCycles = 2, smooth = true): {
    cycle: number;
    phase: number;
    playheadPosition: number; // 0-1, where the playhead is in the display window
    tracks: { name: string; events: VisualizationEvent[] }[];
    displayCycles: number;
    noteRange?: { min: number; max: number };
    notes?: VisualizationEvent[];
  } | null {
    if (!this.repl) return null;

    const state = (this.repl as any).state;
    const pattern = state?.pattern;
    if (!pattern) return null;

    const scheduler = (this.repl as any).scheduler;
    // Use pausedAtCycle when paused, otherwise get current from scheduler
    const currentCycle = this.paused 
      ? this.pausedAtCycle 
      : (scheduler?.now?.() || 0);
    const phase = currentCycle % 1;

    // Query window: 
    // - smooth=true: playhead starts at left, moves to 1/3, then stays there while pattern scrolls
    // - smooth=false: window starts at cycle boundary (original behavior)
    const playheadLockPosition = 1/3; // Playhead locks at 1/3 of the display width
    const scrollThreshold = displayCycles * playheadLockPosition;
    
    let windowStart: number;
    let playheadPosition: number; // 0-1 position in display window
    
    if (!smooth) {
      // Original behavior: snap to cycle boundaries
      windowStart = Math.floor(currentCycle);
      playheadPosition = phase / displayCycles;
    } else if (currentCycle < scrollThreshold) {
      // Early phase: window at 0, playhead moves from left toward 1/3
      windowStart = 0;
      playheadPosition = currentCycle / displayCycles;
    } else {
      // Scrolling phase: playhead stays at 1/3, pattern scrolls
      windowStart = currentCycle - scrollThreshold;
      playheadPosition = playheadLockPosition;
    }
    const windowEnd = windowStart + displayCycles;

    try {
      const haps = pattern.queryArc(windowStart, windowEnd);

      // Group haps by track name (sound or note)
      const trackMap = new Map<string, VisualizationEvent[]>();
      
      // Also collect all notes for braille mode
      const allNotes: VisualizationEvent[] = [];
      let minNote = Infinity;
      let maxNote = -Infinity;

      for (const hap of haps) {
        // Get track name from the hap value
        let trackName = 'unknown';
        let midiNote: number | undefined;
        
        if (hap.value) {
          if (typeof hap.value === 'string') {
            trackName = hap.value;
            // Try to parse as note name (e.g., "c4", "d#5")
            midiNote = this.noteNameToMidi(hap.value);
          } else if (hap.value.s) {
            trackName = hap.value.s;
          }
          
          // Extract note/pitch information
          if (hap.value.note !== undefined) {
            if (typeof hap.value.note === 'number') {
              midiNote = hap.value.note;
              trackName = this.midiToNoteName(hap.value.note);
            } else if (typeof hap.value.note === 'string') {
              midiNote = this.noteNameToMidi(hap.value.note);
              trackName = hap.value.note;
            }
          }
          if (hap.value.n !== undefined && midiNote === undefined) {
            // 'n' is often a sample index, but can be a note
            if (typeof hap.value.n === 'number' && hap.value.n >= 0 && hap.value.n <= 127) {
              midiNote = hap.value.n;
              trackName = `n${hap.value.n}`;
            }
          }
        }

        // Normalize times to 0-1 within display window
        // Use hap.part for visualization (the actual triggering time, not the full sustain duration)
        const hapStart = hap.part.begin.valueOf();
        const hapEnd = hap.part.end.valueOf();

        const normalizedStart = (hapStart - windowStart) / displayCycles;
        const normalizedEnd = (hapEnd - windowStart) / displayCycles;

        // Check if this hap is currently active AND the active portion is visible in the window
        // This prevents spurious highlights from notes that are mostly outside the visible area
        const isActive = currentCycle >= hapStart && currentCycle < hapEnd &&
                         normalizedStart < 1 && normalizedEnd > 0;

        // Skip events that are completely outside the visible window
        if (normalizedEnd <= 0 || normalizedStart >= 1) {
          continue;
        }

        const event: VisualizationEvent = {
          start: Math.max(0, normalizedStart),
          end: Math.min(1, normalizedEnd),
          active: isActive,
          note: midiNote,
        };

        if (!trackMap.has(trackName)) {
          trackMap.set(trackName, []);
        }
        trackMap.get(trackName)!.push(event);
        
        // Track note range for braille mode
        if (midiNote !== undefined) {
          allNotes.push(event);
          minNote = Math.min(minNote, midiNote);
          maxNote = Math.max(maxNote, midiNote);
        }
      }

      // Convert map to array of tracks, sorted by name
      const tracks = Array.from(trackMap.entries())
        .map(([name, events]) => ({ name, events }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const result: {
        cycle: number;
        phase: number;
        playheadPosition: number;
        tracks: { name: string; events: VisualizationEvent[] }[];
        displayCycles: number;
        noteRange?: { min: number; max: number };
        notes?: VisualizationEvent[];
      } = {
        cycle: currentCycle,
        phase,
        playheadPosition,
        tracks,
        displayCycles,
      };
      
      // Include note data if we have any
      if (allNotes.length > 0 && minNote !== Infinity) {
        result.noteRange = { min: minNote, max: maxNote };
        result.notes = allNotes;
      }

      return result;
    } catch (err) {
      console.error('[strudel-engine] Error querying visualization:', err);
      return null;
    }
  }

  /**
   * Convert MIDI note number to note name (e.g., 60 -> "C4")
   */
  private midiToNoteName(midi: number): string {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const octave = Math.floor(midi / 12) - 1;
    const note = noteNames[midi % 12];
    return `${note}${octave}`;
  }

  /**
   * Convert note name to MIDI number (e.g., "C4" -> 60, "c4" -> 60)
   */
  private noteNameToMidi(name: string): number | undefined {
    const match = name.match(/^([a-gA-G])([#b]?)(-?\d+)?$/);
    if (!match) return undefined;
    
    const noteMap: Record<string, number> = {
      'c': 0, 'C': 0,
      'd': 2, 'D': 2,
      'e': 4, 'E': 4,
      'f': 5, 'F': 5,
      'g': 7, 'G': 7,
      'a': 9, 'A': 9,
      'b': 11, 'B': 11,
    };
    
    let note = noteMap[match[1]];
    if (note === undefined) return undefined;
    
    if (match[2] === '#') note += 1;
    else if (match[2] === 'b') note -= 1;
    
    const octave = match[3] ? parseInt(match[3], 10) : 4;
    return (octave + 1) * 12 + note;
  }

  /**
   * Set the server port and write state file
   * Called by the TCP server after it starts listening
   */
  setPort(port: number): void {
    this.serverPort = port;
    // Write state file with connection info only
    writeEngineState({
      pid: process.pid,
      port: this.serverPort,
    });
    console.log(`[strudel-engine] State file written (port: ${port})`);
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    this.stop();
    this.disableOsc();
    closeMidi(); // Clean up MIDI ports to prevent RtMidi port leak
    clearEngineState();
    console.log('[strudel-engine] Disposed');
  }
}
