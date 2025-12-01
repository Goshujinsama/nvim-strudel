#!/usr/bin/env node
/**
 * LSP server for Strudel mini-notation
 * Provides completions, hover, diagnostics, signature help, and code actions
 */

// IMPORTANT: Patch console.log BEFORE importing @strudel/mini
// @strudel/core prints "🌀 @strudel/core loaded 🌀" to stdout on import,
// which corrupts the LSP JSON-RPC protocol. We redirect it to stderr.
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  // Redirect to stderr to avoid corrupting LSP protocol
  console.error(...args);
};

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  CompletionItem,
  CompletionItemKind,
  Hover,
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  TextEdit,
  MarkupKind,
} from 'vscode-languageserver/node.js';

import { TextDocument } from 'vscode-languageserver-textdocument';

// Dynamic import for @strudel/mini to ensure console.log patch runs first
// @ts-ignore - @strudel/mini has no type declarations
const { parse: parseMini, getLeaves: getMiniLeaves } = await import('@strudel/mini');

// Restore console.log after imports (connection.console.log goes to the right place anyway)
console.log = originalLog;

// Create connection using stdio
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Dynamic sample list - will be populated from engine
let dynamicSamples: string[] = [];
let dynamicBanks: string[] = [];

// Default sample names (fallback when not connected to engine)
const DEFAULT_SAMPLE_NAMES = [
  // Drums
  'bd', 'sd', 'hh', 'oh', 'cp', 'mt', 'ht', 'lt', 'rim', 'cb', 'cr', 'rd', 'sh', 'tb', 'perc', 'misc', 'fx',
  // Piano
  'piano',
  // Synths
  'sine', 'saw', 'square', 'triangle', 'sawtooth', 'tri', 'white', 'pink', 'brown',
  // Misc samples
  'casio', 'jazz', 'metal', 'east', 'space', 'wind', 'insect', 'crow', 'numbers', 'mridangam',
  // Instruments from VCSL
  'violin', 'viola', 'cello', 'bass', 'flute', 'oboe', 'clarinet', 'bassoon',
  'trumpet', 'horn', 'trombone', 'tuba', 'glockenspiel', 'xylophone', 'vibraphone',
];

// Note names
const NOTE_NAMES = [
  'c', 'd', 'e', 'f', 'g', 'a', 'b',
  'cs', 'ds', 'fs', 'gs', 'as', // sharps
  'db', 'eb', 'gb', 'ab', 'bb', // flats
];

// Octaves
const OCTAVES = ['0', '1', '2', '3', '4', '5', '6', '7', '8'];

// Scale names
const SCALE_NAMES = [
  'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'aeolian', 'ionian',
  'harmonicMinor', 'melodicMinor', 'pentatonic', 'blues', 'chromatic',
  'wholetone', 'diminished', 'augmented', 'bebop', 'hungarian', 'spanish',
];

// Voicing mode names (used with .mode() function)
// Format: "mode" or "mode:anchor" e.g., "above:c3"
const VOICING_MODES = [
  'above', 'below', 'between', 'duck', 'root', 'rootless',
];

// Effects/modifiers in mini-notation
const MINI_OPERATORS = [
  { label: '*', detail: 'Speed up (fast)', documentation: 'Multiply speed: bd*2 plays twice as fast' },
  { label: '/', detail: 'Slow down', documentation: 'Divide speed: bd/2 plays twice as slow' },
  { label: '!', detail: 'Replicate', documentation: 'Repeat element: bd!3 plays bd three times' },
  { label: '?', detail: 'Degrade/maybe', documentation: 'Random chance: bd? sometimes plays' },
  { label: '@', detail: 'Weight', documentation: 'Set duration weight: bd@2 takes twice as long' },
  { label: '~', detail: 'Rest/silence', documentation: 'Silent step' },
  { label: '<>', detail: 'Alternate', documentation: 'Alternate between patterns each cycle' },
  { label: '[]', detail: 'Subsequence', documentation: 'Group elements into subsequence' },
  { label: '{}', detail: 'Polyrhythm', documentation: 'Play patterns in parallel with different lengths' },
  { label: '(,)', detail: 'Euclidean rhythm', documentation: 'Euclidean distribution: bd(3,8) = 3 hits over 8 steps' },
  { label: ':', detail: 'Sample index', documentation: 'Select sample variant: bd:2' },
  { label: ',', detail: 'Parallel', documentation: 'Play patterns in parallel: bd, hh' },
  { label: '|', detail: 'Random choice', documentation: 'Random choice: bd | sd' },
];

// Function signatures with parameters
interface FunctionSignature {
  name: string;
  detail: string;
  documentation: string;
  signatures: {
    label: string;
    documentation?: string;
    parameters: { label: string; documentation: string }[];
  }[];
}

const STRUDEL_FUNCTIONS: FunctionSignature[] = [
  {
    name: 's',
    detail: 'Sound/sample',
    documentation: 'Play a sound or sample',
    signatures: [{
      label: 's(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Mini-notation pattern of sample names, e.g., "bd sd hh"' }],
    }],
  },
  {
    name: 'sound',
    detail: 'Sound/sample (alias for s)',
    documentation: 'Play a sound or sample',
    signatures: [{
      label: 'sound(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Mini-notation pattern of sample names' }],
    }],
  },
  {
    name: 'n',
    detail: 'Note number',
    documentation: 'Set note by MIDI number or pattern',
    signatures: [{
      label: 'n(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of MIDI note numbers, e.g., "0 2 4 7"' }],
    }],
  },
  {
    name: 'note',
    detail: 'Note name',
    documentation: 'Set note by name',
    signatures: [{
      label: 'note(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of note names, e.g., "c4 e4 g4"' }],
    }],
  },
  {
    name: 'fast',
    detail: 'Speed up pattern',
    documentation: 'Speed up the pattern by a factor',
    signatures: [{
      label: 'fast(factor)',
      parameters: [{ label: 'factor', documentation: 'Speed multiplier (2 = twice as fast)' }],
    }],
  },
  {
    name: 'slow',
    detail: 'Slow down pattern',
    documentation: 'Slow down the pattern by a factor',
    signatures: [{
      label: 'slow(factor)',
      parameters: [{ label: 'factor', documentation: 'Speed divisor (2 = twice as slow)' }],
    }],
  },
  {
    name: 'gain',
    detail: 'Volume',
    documentation: 'Set the volume/gain',
    signatures: [{
      label: 'gain(amount)',
      parameters: [{ label: 'amount', documentation: 'Volume level (0-1, can go higher for boost)' }],
    }],
  },
  {
    name: 'pan',
    detail: 'Stereo pan',
    documentation: 'Set stereo panning',
    signatures: [{
      label: 'pan(position)',
      parameters: [{ label: 'position', documentation: 'Pan position (0 = left, 0.5 = center, 1 = right)' }],
    }],
  },
  {
    name: 'speed',
    detail: 'Playback speed',
    documentation: 'Change sample playback speed (affects pitch)',
    signatures: [{
      label: 'speed(rate)',
      parameters: [{ label: 'rate', documentation: 'Playback rate (1 = normal, 2 = octave up, 0.5 = octave down, negative = reverse)' }],
    }],
  },
  {
    name: 'lpf',
    detail: 'Low-pass filter',
    documentation: 'Apply a low-pass filter',
    signatures: [{
      label: 'lpf(frequency)',
      parameters: [{ label: 'frequency', documentation: 'Cutoff frequency in Hz (e.g., 1000)' }],
    }, {
      label: 'lpf(frequency, resonance)',
      parameters: [
        { label: 'frequency', documentation: 'Cutoff frequency in Hz' },
        { label: 'resonance', documentation: 'Filter resonance (Q factor)' },
      ],
    }],
  },
  {
    name: 'hpf',
    detail: 'High-pass filter',
    documentation: 'Apply a high-pass filter',
    signatures: [{
      label: 'hpf(frequency)',
      parameters: [{ label: 'frequency', documentation: 'Cutoff frequency in Hz (e.g., 200)' }],
    }, {
      label: 'hpf(frequency, resonance)',
      parameters: [
        { label: 'frequency', documentation: 'Cutoff frequency in Hz' },
        { label: 'resonance', documentation: 'Filter resonance (Q factor)' },
      ],
    }],
  },
  {
    name: 'bpf',
    detail: 'Band-pass filter',
    documentation: 'Apply a band-pass filter',
    signatures: [{
      label: 'bpf(frequency)',
      parameters: [{ label: 'frequency', documentation: 'Center frequency in Hz' }],
    }, {
      label: 'bpf(frequency, resonance)',
      parameters: [
        { label: 'frequency', documentation: 'Center frequency in Hz' },
        { label: 'resonance', documentation: 'Filter resonance (Q factor, affects bandwidth)' },
      ],
    }],
  },
  {
    name: 'delay',
    detail: 'Delay effect',
    documentation: 'Add a delay/echo effect',
    signatures: [{
      label: 'delay(amount)',
      parameters: [{ label: 'amount', documentation: 'Delay wet/dry mix (0-1)' }],
    }, {
      label: 'delay(amount, time, feedback)',
      parameters: [
        { label: 'amount', documentation: 'Wet/dry mix (0-1)' },
        { label: 'time', documentation: 'Delay time in cycles (e.g., 0.5)' },
        { label: 'feedback', documentation: 'Feedback amount (0-1)' },
      ],
    }],
  },
  {
    name: 'room',
    detail: 'Reverb',
    documentation: 'Add reverb effect',
    signatures: [{
      label: 'room(size)',
      parameters: [{ label: 'size', documentation: 'Room size / reverb amount (0-1)' }],
    }],
  },
  {
    name: 'crush',
    detail: 'Bitcrush',
    documentation: 'Apply bitcrusher effect',
    signatures: [{
      label: 'crush(bits)',
      parameters: [{ label: 'bits', documentation: 'Bit depth (1-16, lower = more crushed)' }],
    }],
  },
  {
    name: 'coarse',
    detail: 'Sample rate reduction',
    documentation: 'Reduce sample rate for lo-fi effect',
    signatures: [{
      label: 'coarse(amount)',
      parameters: [{ label: 'amount', documentation: 'Reduction factor (higher = more aliasing)' }],
    }],
  },
  {
    name: 'vowel',
    detail: 'Vowel filter',
    documentation: 'Apply vowel formant filter',
    signatures: [{
      label: 'vowel(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of vowels: a, e, i, o, u' }],
    }],
  },
  {
    name: 'euclid',
    detail: 'Euclidean rhythm',
    documentation: 'Apply Euclidean rhythm distribution',
    signatures: [{
      label: 'euclid(pulses, steps)',
      parameters: [
        { label: 'pulses', documentation: 'Number of pulses/hits' },
        { label: 'steps', documentation: 'Total number of steps' },
      ],
    }, {
      label: 'euclid(pulses, steps, rotation)',
      parameters: [
        { label: 'pulses', documentation: 'Number of pulses/hits' },
        { label: 'steps', documentation: 'Total number of steps' },
        { label: 'rotation', documentation: 'Rotation offset' },
      ],
    }],
  },
  {
    name: 'every',
    detail: 'Apply every N cycles',
    documentation: 'Apply a function every N cycles',
    signatures: [{
      label: 'every(n, function)',
      parameters: [
        { label: 'n', documentation: 'Number of cycles' },
        { label: 'function', documentation: 'Function to apply, e.g., rev or fast(2)' },
      ],
    }],
  },
  {
    name: 'rev',
    detail: 'Reverse',
    documentation: 'Reverse the pattern',
    signatures: [{
      label: 'rev()',
      parameters: [],
    }],
  },
  {
    name: 'jux',
    detail: 'Juxtapose',
    documentation: 'Apply function to right channel only',
    signatures: [{
      label: 'jux(function)',
      parameters: [{ label: 'function', documentation: 'Function to apply to right channel' }],
    }],
  },
  {
    name: 'stack',
    detail: 'Stack patterns',
    documentation: 'Play multiple patterns simultaneously',
    signatures: [{
      label: 'stack(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to play in parallel' }],
    }],
  },
  {
    name: 'cat',
    detail: 'Concatenate',
    documentation: 'Play patterns in sequence',
    signatures: [{
      label: 'cat(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to play in sequence' }],
    }],
  },
  {
    name: 'sometimes',
    detail: 'Apply sometimes (50%)',
    documentation: 'Apply function with 50% probability',
    signatures: [{
      label: 'sometimes(function)',
      parameters: [{ label: 'function', documentation: 'Function to sometimes apply' }],
    }],
  },
  {
    name: 'often',
    detail: 'Apply often (75%)',
    documentation: 'Apply function with 75% probability',
    signatures: [{
      label: 'often(function)',
      parameters: [{ label: 'function', documentation: 'Function to often apply' }],
    }],
  },
  {
    name: 'rarely',
    detail: 'Apply rarely (25%)',
    documentation: 'Apply function with 25% probability',
    signatures: [{
      label: 'rarely(function)',
      parameters: [{ label: 'function', documentation: 'Function to rarely apply' }],
    }],
  },
  {
    name: 'almostAlways',
    detail: 'Apply almost always (90%)',
    documentation: 'Apply function with 90% probability',
    signatures: [{
      label: 'almostAlways(function)',
      parameters: [{ label: 'function', documentation: 'Function to almost always apply' }],
    }],
  },
  {
    name: 'almostNever',
    detail: 'Apply almost never (10%)',
    documentation: 'Apply function with 10% probability',
    signatures: [{
      label: 'almostNever(function)',
      parameters: [{ label: 'function', documentation: 'Function to almost never apply' }],
    }],
  },
  {
    name: 'bank',
    detail: 'Sample bank',
    documentation: 'Set the sample bank (drum machine)',
    signatures: [{
      label: 'bank(name)',
      parameters: [{ label: 'name', documentation: 'Bank name, e.g., "RolandTR808" or "TR808"' }],
    }],
  },
  {
    name: 'scale',
    detail: 'Musical scale',
    documentation: 'Quantize notes to a scale',
    signatures: [{
      label: 'scale(name)',
      parameters: [{ label: 'name', documentation: 'Scale name, e.g., "major", "minor", "dorian"' }],
    }],
  },
  {
    name: 'struct',
    detail: 'Structure',
    documentation: 'Apply rhythmic structure from another pattern',
    signatures: [{
      label: 'struct(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Boolean pattern for rhythm, e.g., "t f t f"' }],
    }],
  },
  {
    name: 'mask',
    detail: 'Mask pattern',
    documentation: 'Mask pattern with boolean pattern',
    signatures: [{
      label: 'mask(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Boolean pattern to mask with' }],
    }],
  },
  {
    name: 'clip',
    detail: 'Clip duration',
    documentation: 'Multiply event duration',
    signatures: [{
      label: 'clip(factor)',
      parameters: [{ label: 'factor', documentation: 'Duration multiplier (1 = full, 0.5 = half)' }],
    }],
  },
  {
    name: 'attack',
    detail: 'Attack time',
    documentation: 'Set envelope attack time',
    signatures: [{
      label: 'attack(time)',
      parameters: [{ label: 'time', documentation: 'Attack time in seconds' }],
    }],
  },
  {
    name: 'decay',
    detail: 'Decay time',
    documentation: 'Set envelope decay time',
    signatures: [{
      label: 'decay(time)',
      parameters: [{ label: 'time', documentation: 'Decay time in seconds' }],
    }],
  },
  {
    name: 'sustain',
    detail: 'Sustain level',
    documentation: 'Set envelope sustain level',
    signatures: [{
      label: 'sustain(level)',
      parameters: [{ label: 'level', documentation: 'Sustain level (0-1)' }],
    }],
  },
  {
    name: 'release',
    detail: 'Release time',
    documentation: 'Set envelope release time',
    signatures: [{
      label: 'release(time)',
      parameters: [{ label: 'time', documentation: 'Release time in seconds' }],
    }],
  },
  {
    name: 'begin',
    detail: 'Sample start',
    documentation: 'Set sample playback start position',
    signatures: [{
      label: 'begin(position)',
      parameters: [{ label: 'position', documentation: 'Start position (0-1, 0 = beginning)' }],
    }],
  },
  {
    name: 'end',
    detail: 'Sample end',
    documentation: 'Set sample playback end position',
    signatures: [{
      label: 'end(position)',
      parameters: [{ label: 'position', documentation: 'End position (0-1, 1 = end)' }],
    }],
  },
  {
    name: 'cut',
    detail: 'Cut group',
    documentation: 'Stop other sounds in same cut group (like hi-hat choke)',
    signatures: [{
      label: 'cut(group)',
      parameters: [{ label: 'group', documentation: 'Cut group number' }],
    }],
  },
  {
    name: 'chop',
    detail: 'Chop sample',
    documentation: 'Chop sample into N parts for granular effects',
    signatures: [{
      label: 'chop(parts)',
      parameters: [{ label: 'parts', documentation: 'Number of parts to chop into' }],
    }],
  },
  {
    name: 'slice',
    detail: 'Slice sample',
    documentation: 'Slice sample and select which slice to play',
    signatures: [{
      label: 'slice(total, which)',
      parameters: [
        { label: 'total', documentation: 'Total number of slices' },
        { label: 'which', documentation: 'Pattern of slice indices to play' },
      ],
    }],
  },
  {
    name: 'loopAt',
    detail: 'Loop at cycles',
    documentation: 'Adjust sample speed to loop over N cycles',
    signatures: [{
      label: 'loopAt(cycles)',
      parameters: [{ label: 'cycles', documentation: 'Number of cycles for the loop' }],
    }],
  },
  {
    name: 'fit',
    detail: 'Fit to cycle',
    documentation: 'Fit sample to event duration',
    signatures: [{
      label: 'fit()',
      parameters: [],
    }],
  },
  {
    name: 'striate',
    detail: 'Striate',
    documentation: 'Granular time-stretch effect',
    signatures: [{
      label: 'striate(parts)',
      parameters: [{ label: 'parts', documentation: 'Number of parts to striate into' }],
    }],
  },
  {
    name: 'orbit',
    detail: 'Effect bus',
    documentation: 'Route to effect bus (for shared effects)',
    signatures: [{
      label: 'orbit(bus)',
      parameters: [{ label: 'bus', documentation: 'Effect bus number (0-11)' }],
    }],
  },
  // REPL control functions
  {
    name: 'hush',
    detail: 'Stop all sounds',
    documentation: 'Emergency stop - silences all sounds immediately (panic button)',
    signatures: [{
      label: 'hush()',
      parameters: [],
    }],
  },
  {
    name: 'setcps',
    detail: 'Set tempo',
    documentation: 'Set the tempo in cycles per second. 1 = 1 cycle per second, 0.5 = 1 cycle every 2 seconds',
    signatures: [{
      label: 'setcps(cps)',
      parameters: [{ label: 'cps', documentation: 'Cycles per second (e.g., 0.5 for half speed, 2 for double speed)' }],
    }],
  },
  // Time modifiers
  {
    name: 'early',
    detail: 'Shift earlier',
    documentation: 'Shift pattern earlier in time by the given amount',
    signatures: [{
      label: 'early(amount)',
      parameters: [{ label: 'amount', documentation: 'Amount to shift earlier (in cycles)' }],
    }],
  },
  {
    name: 'late',
    detail: 'Shift later',
    documentation: 'Shift pattern later in time by the given amount',
    signatures: [{
      label: 'late(amount)',
      parameters: [{ label: 'amount', documentation: 'Amount to shift later (in cycles)' }],
    }],
  },
  {
    name: 'ply',
    detail: 'Multiply events',
    documentation: 'Multiply each event in the pattern, subdividing it',
    signatures: [{
      label: 'ply(factor)',
      parameters: [{ label: 'factor', documentation: 'Number of times to subdivide each event' }],
    }],
  },
  {
    name: 'segment',
    detail: 'Segment pattern',
    documentation: 'Sample the pattern at a fixed number of segments per cycle',
    signatures: [{
      label: 'segment(n)',
      parameters: [{ label: 'n', documentation: 'Number of segments per cycle' }],
    }],
  },
  {
    name: 'iter',
    detail: 'Iterate pattern',
    documentation: 'Shift the pattern by 1/n each cycle, cycling through variations',
    signatures: [{
      label: 'iter(n)',
      parameters: [{ label: 'n', documentation: 'Number of iterations before repeating' }],
    }],
  },
  {
    name: 'iterBack',
    detail: 'Iterate backwards',
    documentation: 'Like iter but shifts in the opposite direction',
    signatures: [{
      label: 'iterBack(n)',
      parameters: [{ label: 'n', documentation: 'Number of iterations before repeating' }],
    }],
  },
  {
    name: 'palindrome',
    detail: 'Palindrome',
    documentation: 'Play pattern forwards then backwards',
    signatures: [{
      label: 'palindrome()',
      parameters: [],
    }],
  },
  {
    name: 'compress',
    detail: 'Compress time',
    documentation: 'Compress pattern into a portion of the cycle',
    signatures: [{
      label: 'compress(start, end)',
      parameters: [
        { label: 'start', documentation: 'Start position (0-1)' },
        { label: 'end', documentation: 'End position (0-1)' },
      ],
    }],
  },
  {
    name: 'zoom',
    detail: 'Zoom into pattern',
    documentation: 'Zoom into a portion of the pattern',
    signatures: [{
      label: 'zoom(start, end)',
      parameters: [
        { label: 'start', documentation: 'Start position (0-1)' },
        { label: 'end', documentation: 'End position (0-1)' },
      ],
    }],
  },
  {
    name: 'linger',
    detail: 'Linger on portion',
    documentation: 'Only play the first portion of the pattern, looping it',
    signatures: [{
      label: 'linger(fraction)',
      parameters: [{ label: 'fraction', documentation: 'Fraction of pattern to loop (e.g., 0.25 = first quarter)' }],
    }],
  },
  {
    name: 'fastGap',
    detail: 'Fast with gap',
    documentation: 'Speed up pattern but leave a gap, maintaining cycle length',
    signatures: [{
      label: 'fastGap(factor)',
      parameters: [{ label: 'factor', documentation: 'Speed factor' }],
    }],
  },
  {
    name: 'inside',
    detail: 'Apply inside',
    documentation: 'Apply function inside a time span (speed up, apply, slow down)',
    signatures: [{
      label: 'inside(factor, function)',
      parameters: [
        { label: 'factor', documentation: 'Time compression factor' },
        { label: 'function', documentation: 'Function to apply' },
      ],
    }],
  },
  {
    name: 'outside',
    detail: 'Apply outside',
    documentation: 'Apply function outside a time span (slow down, apply, speed up)',
    signatures: [{
      label: 'outside(factor, function)',
      parameters: [
        { label: 'factor', documentation: 'Time expansion factor' },
        { label: 'function', documentation: 'Function to apply' },
      ],
    }],
  },
  {
    name: 'cpm',
    detail: 'Cycles per minute',
    documentation: 'Set pattern speed in cycles per minute',
    signatures: [{
      label: 'cpm(n)',
      parameters: [{ label: 'n', documentation: 'Cycles per minute' }],
    }],
  },
  {
    name: 'swing',
    detail: 'Swing feel',
    documentation: 'Apply swing timing to pattern',
    signatures: [{
      label: 'swing(amount)',
      parameters: [{ label: 'amount', documentation: 'Swing amount (0-1)' }],
    }],
  },
  {
    name: 'swingBy',
    detail: 'Swing by division',
    documentation: 'Apply swing at specific subdivision',
    signatures: [{
      label: 'swingBy(amount, division)',
      parameters: [
        { label: 'amount', documentation: 'Swing amount' },
        { label: 'division', documentation: 'Subdivision to swing' },
      ],
    }],
  },
  {
    name: 'hurry',
    detail: 'Hurry up',
    documentation: 'Speed up pattern and also speed up sample playback',
    signatures: [{
      label: 'hurry(factor)',
      parameters: [{ label: 'factor', documentation: 'Speed factor (affects both pattern and samples)' }],
    }],
  },
  // Signals (continuous patterns)
  {
    name: 'saw',
    detail: 'Sawtooth signal',
    documentation: 'Continuous sawtooth wave pattern (0 to 1 over each cycle)',
    signatures: [{
      label: 'saw',
      documentation: 'Use with .range() to set output range: saw.range(0, 100)',
      parameters: [],
    }],
  },
  {
    name: 'sine',
    detail: 'Sine signal',
    documentation: 'Continuous sine wave pattern (oscillates 0 to 1)',
    signatures: [{
      label: 'sine',
      documentation: 'Use with .range() to set output range: sine.range(200, 2000)',
      parameters: [],
    }],
  },
  {
    name: 'cosine',
    detail: 'Cosine signal',
    documentation: 'Continuous cosine wave pattern (like sine but phase-shifted)',
    signatures: [{
      label: 'cosine',
      documentation: 'Use with .range() to set output range: cosine.range(0, 1)',
      parameters: [],
    }],
  },
  {
    name: 'tri',
    detail: 'Triangle signal',
    documentation: 'Continuous triangle wave pattern',
    signatures: [{
      label: 'tri',
      documentation: 'Use with .range() to set output range: tri.range(0, 1)',
      parameters: [],
    }],
  },
  {
    name: 'square',
    detail: 'Square signal',
    documentation: 'Continuous square wave pattern (alternates between 0 and 1)',
    signatures: [{
      label: 'square',
      documentation: 'Use with .range() to set output range: square.range(0, 1)',
      parameters: [],
    }],
  },
  {
    name: 'rand',
    detail: 'Random signal',
    documentation: 'Continuous random pattern (new random value each cycle)',
    signatures: [{
      label: 'rand',
      documentation: 'Use with .range() to set output range: rand.range(0, 100)',
      parameters: [],
    }],
  },
  {
    name: 'perlin',
    detail: 'Perlin noise',
    documentation: 'Smooth continuous random pattern using Perlin noise',
    signatures: [{
      label: 'perlin',
      documentation: 'Use with .range() to set output range: perlin.range(0, 1)',
      parameters: [],
    }],
  },
  {
    name: 'irand',
    detail: 'Integer random',
    documentation: 'Random integer pattern',
    signatures: [{
      label: 'irand(max)',
      parameters: [{ label: 'max', documentation: 'Maximum value (exclusive)' }],
    }],
  },
  {
    name: 'brand',
    detail: 'Binary random',
    documentation: 'Random binary pattern (0 or 1)',
    signatures: [{
      label: 'brand',
      parameters: [],
    }],
  },
  // Random modifiers
  {
    name: 'choose',
    detail: 'Choose random',
    documentation: 'Randomly choose from a list of values each cycle',
    signatures: [{
      label: 'choose(values...)',
      parameters: [{ label: 'values', documentation: 'Values to choose from' }],
    }, {
      label: 'choose([values])',
      parameters: [{ label: 'values', documentation: 'Array of values to choose from' }],
    }],
  },
  {
    name: 'wchoose',
    detail: 'Weighted choose',
    documentation: 'Randomly choose with weights',
    signatures: [{
      label: 'wchoose([[value, weight], ...])',
      parameters: [{ label: 'pairs', documentation: 'Array of [value, weight] pairs' }],
    }],
  },
  {
    name: 'chooseCycles',
    detail: 'Choose for N cycles',
    documentation: 'Choose a random value and keep it for N cycles',
    signatures: [{
      label: 'chooseCycles(n, values...)',
      parameters: [
        { label: 'n', documentation: 'Number of cycles to keep the choice' },
        { label: 'values', documentation: 'Values to choose from' },
      ],
    }],
  },
  {
    name: 'degradeBy',
    detail: 'Degrade by amount',
    documentation: 'Randomly remove events with given probability',
    signatures: [{
      label: 'degradeBy(amount)',
      parameters: [{ label: 'amount', documentation: 'Probability of removing each event (0-1)' }],
    }],
  },
  {
    name: 'degrade',
    detail: 'Degrade 50%',
    documentation: 'Randomly remove 50% of events',
    signatures: [{
      label: 'degrade()',
      parameters: [],
    }],
  },
  {
    name: 'undegradeBy',
    detail: 'Undegrade by amount',
    documentation: 'Randomly keep events with given probability (opposite of degradeBy)',
    signatures: [{
      label: 'undegradeBy(amount)',
      parameters: [{ label: 'amount', documentation: 'Probability of keeping each event (0-1)' }],
    }],
  },
  {
    name: 'sometimesBy',
    detail: 'Sometimes by amount',
    documentation: 'Apply function with given probability',
    signatures: [{
      label: 'sometimesBy(amount, function)',
      parameters: [
        { label: 'amount', documentation: 'Probability (0-1)' },
        { label: 'function', documentation: 'Function to sometimes apply' },
      ],
    }],
  },
  {
    name: 'someCycles',
    detail: 'Some cycles',
    documentation: 'Apply function on some cycles (50% probability per cycle)',
    signatures: [{
      label: 'someCycles(function)',
      parameters: [{ label: 'function', documentation: 'Function to apply on some cycles' }],
    }],
  },
  {
    name: 'someCyclesBy',
    detail: 'Some cycles by amount',
    documentation: 'Apply function on some cycles with given probability',
    signatures: [{
      label: 'someCyclesBy(amount, function)',
      parameters: [
        { label: 'amount', documentation: 'Probability per cycle (0-1)' },
        { label: 'function', documentation: 'Function to apply' },
      ],
    }],
  },
  {
    name: 'never',
    detail: 'Never apply',
    documentation: 'Never apply the function (0% probability)',
    signatures: [{
      label: 'never(function)',
      parameters: [{ label: 'function', documentation: 'Function to never apply' }],
    }],
  },
  {
    name: 'always',
    detail: 'Always apply',
    documentation: 'Always apply the function (100% probability)',
    signatures: [{
      label: 'always(function)',
      parameters: [{ label: 'function', documentation: 'Function to always apply' }],
    }],
  },
  // Pattern factories
  {
    name: 'seq',
    detail: 'Sequence',
    documentation: 'Alias for cat - play patterns in sequence',
    signatures: [{
      label: 'seq(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to play in sequence' }],
    }],
  },
  {
    name: 'silence',
    detail: 'Silence',
    documentation: 'A silent pattern - produces no events',
    signatures: [{
      label: 'silence',
      parameters: [],
    }],
  },
  {
    name: 'run',
    detail: 'Run sequence',
    documentation: 'Create a pattern of numbers from 0 to n-1',
    signatures: [{
      label: 'run(n)',
      parameters: [{ label: 'n', documentation: 'Number of steps (0 to n-1)' }],
    }],
  },
  {
    name: 'arrange',
    detail: 'Arrange patterns',
    documentation: 'Arrange patterns over multiple cycles',
    signatures: [{
      label: 'arrange([cycles, pattern], ...)',
      parameters: [{ label: 'pairs', documentation: 'Array of [numCycles, pattern] pairs' }],
    }],
  },
  {
    name: 'polymeter',
    detail: 'Polymeter',
    documentation: 'Play patterns with different lengths simultaneously',
    signatures: [{
      label: 'polymeter(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns of different lengths' }],
    }],
  },
  {
    name: 'polymeterSteps',
    detail: 'Polymeter with steps',
    documentation: 'Polymeter with specified step counts',
    signatures: [{
      label: 'polymeterSteps(steps, pattern1, pattern2, ...)',
      parameters: [
        { label: 'steps', documentation: 'Number of steps per cycle' },
        { label: 'patterns', documentation: 'Patterns to polymetrically combine' },
      ],
    }],
  },
  {
    name: 'binary',
    detail: 'Binary pattern',
    documentation: 'Create pattern from binary number',
    signatures: [{
      label: 'binary(n)',
      parameters: [{ label: 'n', documentation: 'Number to convert to binary pattern' }],
    }],
  },
  {
    name: 'binaryN',
    detail: 'Binary with length',
    documentation: 'Create pattern from binary number with specified length',
    signatures: [{
      label: 'binaryN(bits, n)',
      parameters: [
        { label: 'bits', documentation: 'Number of bits (pattern length)' },
        { label: 'n', documentation: 'Number to convert' },
      ],
    }],
  },
  // Tonal functions
  {
    name: 'transpose',
    detail: 'Transpose',
    documentation: 'Transpose notes by semitones',
    signatures: [{
      label: 'transpose(semitones)',
      parameters: [{ label: 'semitones', documentation: 'Number of semitones to transpose' }],
    }],
  },
  {
    name: 'scaleTranspose',
    detail: 'Scale transpose',
    documentation: 'Transpose within the current scale',
    signatures: [{
      label: 'scaleTranspose(steps)',
      parameters: [{ label: 'steps', documentation: 'Number of scale steps to transpose' }],
    }],
  },
  {
    name: 'rootNotes',
    detail: 'Root notes',
    documentation: 'Get root notes of chords',
    signatures: [{
      label: 'rootNotes(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of chord names' }],
    }],
  },
  {
    name: 'chord',
    detail: 'Chord',
    documentation: 'Play a chord by name',
    signatures: [{
      label: 'chord(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of chord names, e.g., "C Am F G" or "Cm7 Fmaj7"' }],
    }],
  },
  {
    name: 'mode',
    detail: 'Scale mode',
    documentation: 'Set the scale mode for note interpretation',
    signatures: [{
      label: 'mode(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of mode names, e.g., "major minor dorian"' }],
    }],
  },
  {
    name: 'voicing',
    detail: 'Chord voicing',
    documentation: 'Set chord voicing style',
    signatures: [{
      label: 'voicing(style)',
      parameters: [{ label: 'style', documentation: 'Voicing style, e.g., "default", "lefthand", "open", "drop2"' }],
    }],
  },
  {
    name: 'voicings',
    detail: 'Chord voicings',
    documentation: 'Define custom chord voicings',
    signatures: [{
      label: 'voicings(dictionary)',
      parameters: [{ label: 'dictionary', documentation: 'Voicing dictionary object' }],
    }],
  },
  {
    name: 'anchor',
    detail: 'Voicing anchor',
    documentation: 'Set the anchor note for chord voicings',
    signatures: [{
      label: 'anchor(note)',
      parameters: [{ label: 'note', documentation: 'Anchor note, e.g., "c3"' }],
    }],
  },
  {
    name: 'octave',
    detail: 'Octave',
    documentation: 'Set the octave for notes',
    signatures: [{
      label: 'octave(n)',
      parameters: [{ label: 'n', documentation: 'Octave number (e.g., 3, 4, 5)' }],
    }],
  },
  // More effects
  {
    name: 'distort',
    detail: 'Distortion',
    documentation: 'Apply distortion effect',
    signatures: [{
      label: 'distort(amount)',
      parameters: [{ label: 'amount', documentation: 'Distortion amount (0-1)' }],
    }],
  },
  {
    name: 'shape',
    detail: 'Wave shaping',
    documentation: 'Apply wave shaping distortion',
    signatures: [{
      label: 'shape(amount)',
      parameters: [{ label: 'amount', documentation: 'Shaping amount (0-1)' }],
    }],
  },
  {
    name: 'tremolo',
    detail: 'Tremolo',
    documentation: 'Apply tremolo (amplitude modulation) effect',
    signatures: [{
      label: 'tremolo(depth, rate)',
      parameters: [
        { label: 'depth', documentation: 'Tremolo depth (0-1)' },
        { label: 'rate', documentation: 'Tremolo rate in Hz' },
      ],
    }],
  },
  {
    name: 'phaser',
    detail: 'Phaser',
    documentation: 'Apply phaser effect',
    signatures: [{
      label: 'phaser(depth, rate)',
      parameters: [
        { label: 'depth', documentation: 'Phaser depth (0-1)' },
        { label: 'rate', documentation: 'Phaser rate' },
      ],
    }],
  },
  {
    name: 'squiz',
    detail: 'Squiz',
    documentation: 'Apply squiz effect (pitch-based distortion)',
    signatures: [{
      label: 'squiz(amount)',
      parameters: [{ label: 'amount', documentation: 'Squiz amount' }],
    }],
  },
  {
    name: 'waveloss',
    detail: 'Wave loss',
    documentation: 'Drop samples for lo-fi effect',
    signatures: [{
      label: 'waveloss(amount)',
      parameters: [{ label: 'amount', documentation: 'Amount of samples to drop' }],
    }],
  },
  {
    name: 'delaytime',
    detail: 'Delay time',
    documentation: 'Set delay time',
    signatures: [{
      label: 'delaytime(time)',
      parameters: [{ label: 'time', documentation: 'Delay time in cycles' }],
    }],
  },
  {
    name: 'delayfeedback',
    detail: 'Delay feedback',
    documentation: 'Set delay feedback amount',
    signatures: [{
      label: 'delayfeedback(amount)',
      parameters: [{ label: 'amount', documentation: 'Feedback amount (0-1)' }],
    }],
  },
  {
    name: 'size',
    detail: 'Reverb size',
    documentation: 'Set reverb room size',
    signatures: [{
      label: 'size(amount)',
      parameters: [{ label: 'amount', documentation: 'Room size (0-1)' }],
    }],
  },
  {
    name: 'velocity',
    detail: 'Velocity',
    documentation: 'Set note velocity (for MIDI/instruments)',
    signatures: [{
      label: 'velocity(amount)',
      parameters: [{ label: 'amount', documentation: 'Velocity (0-1)' }],
    }],
  },
  {
    name: 'amp',
    detail: 'Amplitude',
    documentation: 'Set amplitude (alias for gain)',
    signatures: [{
      label: 'amp(amount)',
      parameters: [{ label: 'amount', documentation: 'Amplitude level' }],
    }],
  },
  // More utility functions
  {
    name: 'range',
    detail: 'Range',
    documentation: 'Map pattern values to a range',
    signatures: [{
      label: 'range(min, max)',
      parameters: [
        { label: 'min', documentation: 'Minimum output value' },
        { label: 'max', documentation: 'Maximum output value' },
      ],
    }],
  },
  {
    name: 'cps',
    detail: 'Get/set CPS',
    documentation: 'Get or set cycles per second as a pattern',
    signatures: [{
      label: 'cps(value)',
      parameters: [{ label: 'value', documentation: 'Cycles per second' }],
    }],
  },
  {
    name: 'off',
    detail: 'Off',
    documentation: 'Layer a time-shifted and modified copy of the pattern',
    signatures: [{
      label: 'off(amount, function)',
      parameters: [
        { label: 'amount', documentation: 'Time offset' },
        { label: 'function', documentation: 'Function to apply to offset copy' },
      ],
    }],
  },
  {
    name: 'layer',
    detail: 'Layer',
    documentation: 'Layer multiple functions over the pattern',
    signatures: [{
      label: 'layer(function1, function2, ...)',
      parameters: [{ label: 'functions', documentation: 'Functions to layer' }],
    }],
  },
  {
    name: 'superimpose',
    detail: 'Superimpose',
    documentation: 'Play pattern with a modified copy on top',
    signatures: [{
      label: 'superimpose(function)',
      parameters: [{ label: 'function', documentation: 'Function to apply to superimposed copy' }],
    }],
  },
  {
    name: 'stut',
    detail: 'Stutter',
    documentation: 'Stutter effect - repeat with decay',
    signatures: [{
      label: 'stut(times, decay, time)',
      parameters: [
        { label: 'times', documentation: 'Number of repeats' },
        { label: 'decay', documentation: 'Volume decay per repeat' },
        { label: 'time', documentation: 'Time between repeats' },
      ],
    }],
  },
  {
    name: 'echo',
    detail: 'Echo',
    documentation: 'Echo effect - repeat with delay',
    signatures: [{
      label: 'echo(times, time, feedback)',
      parameters: [
        { label: 'times', documentation: 'Number of echoes' },
        { label: 'time', documentation: 'Delay time' },
        { label: 'feedback', documentation: 'Feedback amount' },
      ],
    }],
  },
  {
    name: 'when',
    detail: 'When',
    documentation: 'Apply function when condition is true',
    signatures: [{
      label: 'when(condition, function)',
      parameters: [
        { label: 'condition', documentation: 'Boolean pattern or function' },
        { label: 'function', documentation: 'Function to apply when true' },
      ],
    }],
  },
  {
    name: 'while',
    detail: 'While',
    documentation: 'Play pattern while condition is true, otherwise silence',
    signatures: [{
      label: 'while(condition)',
      parameters: [{ label: 'condition', documentation: 'Boolean pattern' }],
    }],
  },
  {
    name: 'firstOf',
    detail: 'First of N',
    documentation: 'Apply function only on the first of every N cycles',
    signatures: [{
      label: 'firstOf(n, function)',
      parameters: [
        { label: 'n', documentation: 'Cycle interval' },
        { label: 'function', documentation: 'Function to apply on first cycle' },
      ],
    }],
  },
  {
    name: 'lastOf',
    detail: 'Last of N',
    documentation: 'Apply function only on the last of every N cycles',
    signatures: [{
      label: 'lastOf(n, function)',
      parameters: [
        { label: 'n', documentation: 'Cycle interval' },
        { label: 'function', documentation: 'Function to apply on last cycle' },
      ],
    }],
  },
  {
    name: 'chunk',
    detail: 'Chunk',
    documentation: 'Divide pattern into chunks and apply function to one chunk per cycle',
    signatures: [{
      label: 'chunk(n, function)',
      parameters: [
        { label: 'n', documentation: 'Number of chunks' },
        { label: 'function', documentation: 'Function to apply to current chunk' },
      ],
    }],
  },
  {
    name: 'arp',
    detail: 'Arpeggio',
    documentation: 'Arpeggiate chords',
    signatures: [{
      label: 'arp(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Arpeggio pattern (e.g., "up", "down", "updown")' }],
    }],
  },
  // Pattern combinators
  {
    name: 'fastcat',
    detail: 'Fast concatenate',
    documentation: 'Concatenate patterns, each taking one cycle (alias for cat)',
    signatures: [{
      label: 'fastcat(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to concatenate' }],
    }],
  },
  {
    name: 'slowcat',
    detail: 'Slow concatenate',
    documentation: 'Concatenate patterns, each pattern plays for one cycle in sequence',
    signatures: [{
      label: 'slowcat(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to concatenate' }],
    }],
  },
  {
    name: 'randcat',
    detail: 'Random concatenate',
    documentation: 'Randomly choose between patterns each cycle',
    signatures: [{
      label: 'randcat(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to randomly choose from' }],
    }],
  },
  {
    name: 'pure',
    detail: 'Pure value',
    documentation: 'Create a pattern from a single value',
    signatures: [{
      label: 'pure(value)',
      parameters: [{ label: 'value', documentation: 'Value to create pattern from' }],
    }],
  },
  {
    name: 'reify',
    detail: 'Reify pattern',
    documentation: 'Convert a value to a pattern if it is not already',
    signatures: [{
      label: 'reify(value)',
      parameters: [{ label: 'value', documentation: 'Value or pattern' }],
    }],
  },
  // Math operations
  {
    name: 'add',
    detail: 'Add',
    documentation: 'Add a value or pattern to the current pattern',
    signatures: [{
      label: 'add(value)',
      parameters: [{ label: 'value', documentation: 'Value to add' }],
    }],
  },
  {
    name: 'sub',
    detail: 'Subtract',
    documentation: 'Subtract a value or pattern from the current pattern',
    signatures: [{
      label: 'sub(value)',
      parameters: [{ label: 'value', documentation: 'Value to subtract' }],
    }],
  },
  {
    name: 'mul',
    detail: 'Multiply',
    documentation: 'Multiply the current pattern by a value or pattern',
    signatures: [{
      label: 'mul(value)',
      parameters: [{ label: 'value', documentation: 'Value to multiply by' }],
    }],
  },
  {
    name: 'div',
    detail: 'Divide',
    documentation: 'Divide the current pattern by a value or pattern',
    signatures: [{
      label: 'div(value)',
      parameters: [{ label: 'value', documentation: 'Value to divide by' }],
    }],
  },
  // Juxtapose variations
  {
    name: 'juxBy',
    detail: 'Juxtapose by amount',
    documentation: 'Apply function to right channel with adjustable stereo width',
    signatures: [{
      label: 'juxBy(amount, function)',
      parameters: [
        { label: 'amount', documentation: 'Stereo width (0-1, 0.5 = half width)' },
        { label: 'function', documentation: 'Function to apply to right channel' },
      ],
    }],
  },
  // Envelope shortcuts
  {
    name: 'ad',
    detail: 'Attack-Decay envelope',
    documentation: 'Set attack and decay times',
    signatures: [{
      label: 'ad(attack, decay)',
      parameters: [
        { label: 'attack', documentation: 'Attack time in seconds' },
        { label: 'decay', documentation: 'Decay time in seconds' },
      ],
    }],
  },
  {
    name: 'adsr',
    detail: 'ADSR envelope',
    documentation: 'Set full ADSR envelope',
    signatures: [{
      label: 'adsr(attack, decay, sustain, release)',
      parameters: [
        { label: 'attack', documentation: 'Attack time' },
        { label: 'decay', documentation: 'Decay time' },
        { label: 'sustain', documentation: 'Sustain level (0-1)' },
        { label: 'release', documentation: 'Release time' },
      ],
    }],
  },
  {
    name: 'ar',
    detail: 'Attack-Release envelope',
    documentation: 'Set attack and release times (no sustain)',
    signatures: [{
      label: 'ar(attack, release)',
      parameters: [
        { label: 'attack', documentation: 'Attack time in seconds' },
        { label: 'release', documentation: 'Release time in seconds' },
      ],
    }],
  },
  // Duration and timing
  {
    name: 'dur',
    detail: 'Duration',
    documentation: 'Set event duration in cycles',
    signatures: [{
      label: 'dur(cycles)',
      parameters: [{ label: 'cycles', documentation: 'Duration in cycles' }],
    }],
  },
  {
    name: 'legato',
    detail: 'Legato',
    documentation: 'Set note legato (overlap/gap between notes)',
    signatures: [{
      label: 'legato(value)',
      parameters: [{ label: 'value', documentation: 'Legato value (1 = full duration, <1 = gap, >1 = overlap)' }],
    }],
  },
  {
    name: 'nudge',
    detail: 'Nudge timing',
    documentation: 'Shift events in time by a small amount',
    signatures: [{
      label: 'nudge(seconds)',
      parameters: [{ label: 'seconds', documentation: 'Time offset in seconds' }],
    }],
  },
  {
    name: 'unit',
    detail: 'Time unit',
    documentation: 'Set the time unit for speed calculations',
    signatures: [{
      label: 'unit(type)',
      parameters: [{ label: 'type', documentation: 'Unit type: "r" (rate), "c" (cycle), "s" (seconds)' }],
    }],
  },
  // Gate and hold
  {
    name: 'gate',
    detail: 'Gate',
    documentation: 'Set gate time (note on duration)',
    signatures: [{
      label: 'gate(value)',
      parameters: [{ label: 'value', documentation: 'Gate time (0-1)' }],
    }],
  },
  {
    name: 'hold',
    detail: 'Hold',
    documentation: 'Hold/sustain the sound',
    signatures: [{
      label: 'hold(value)',
      parameters: [{ label: 'value', documentation: 'Hold time' }],
    }],
  },
  // Synth parameters
  {
    name: 'freq',
    detail: 'Frequency',
    documentation: 'Set frequency in Hz directly',
    signatures: [{
      label: 'freq(hz)',
      parameters: [{ label: 'hz', documentation: 'Frequency in Hz' }],
    }],
  },
  {
    name: 'noise',
    detail: 'Noise',
    documentation: 'Add noise to the sound',
    signatures: [{
      label: 'noise(amount)',
      parameters: [{ label: 'amount', documentation: 'Noise amount (0-1)' }],
    }],
  },
  {
    name: 'detune',
    detail: 'Detune',
    documentation: 'Detune the sound in semitones',
    signatures: [{
      label: 'detune(semitones)',
      parameters: [{ label: 'semitones', documentation: 'Detune amount in semitones' }],
    }],
  },
  {
    name: 'unison',
    detail: 'Unison',
    documentation: 'Add unison voices for thicker sound',
    signatures: [{
      label: 'unison(voices)',
      parameters: [{ label: 'voices', documentation: 'Number of unison voices' }],
    }],
  },
  // FM synthesis
  {
    name: 'fm',
    detail: 'FM amount',
    documentation: 'Set FM synthesis modulation amount',
    signatures: [{
      label: 'fm(amount)',
      parameters: [{ label: 'amount', documentation: 'FM modulation amount' }],
    }],
  },
  {
    name: 'fmi',
    detail: 'FM index',
    documentation: 'Set FM modulation index',
    signatures: [{
      label: 'fmi(index)',
      parameters: [{ label: 'index', documentation: 'FM modulation index' }],
    }],
  },
  {
    name: 'fmh',
    detail: 'FM harmonic',
    documentation: 'Set FM modulator harmonic ratio',
    signatures: [{
      label: 'fmh(ratio)',
      parameters: [{ label: 'ratio', documentation: 'Harmonic ratio of modulator' }],
    }],
  },
  // Vibrato
  {
    name: 'vib',
    detail: 'Vibrato',
    documentation: 'Add vibrato effect',
    signatures: [{
      label: 'vib(depth)',
      parameters: [{ label: 'depth', documentation: 'Vibrato depth' }],
    }],
  },
  {
    name: 'vibrato',
    detail: 'Vibrato (full)',
    documentation: 'Add vibrato with rate control',
    signatures: [{
      label: 'vibrato(depth, rate)',
      parameters: [
        { label: 'depth', documentation: 'Vibrato depth' },
        { label: 'rate', documentation: 'Vibrato rate in Hz' },
      ],
    }],
  },
  // Leslie effect
  {
    name: 'leslie',
    detail: 'Leslie speaker',
    documentation: 'Apply Leslie speaker effect (rotating speaker)',
    signatures: [{
      label: 'leslie(amount)',
      parameters: [{ label: 'amount', documentation: 'Leslie effect amount' }],
    }],
  },
  // Wavetable
  {
    name: 'wt',
    detail: 'Wavetable',
    documentation: 'Use wavetable synthesis',
    signatures: [{
      label: 'wt(table)',
      parameters: [{ label: 'table', documentation: 'Wavetable name or number' }],
    }],
  },
  // Pattern manipulation
  {
    name: 'within',
    detail: 'Within',
    documentation: 'Apply function to a portion of the pattern',
    signatures: [{
      label: 'within(start, end, function)',
      parameters: [
        { label: 'start', documentation: 'Start position (0-1)' },
        { label: 'end', documentation: 'End position (0-1)' },
        { label: 'function', documentation: 'Function to apply' },
      ],
    }],
  },
  {
    name: 'focus',
    detail: 'Focus',
    documentation: 'Focus on a portion of the pattern',
    signatures: [{
      label: 'focus(start, end)',
      parameters: [
        { label: 'start', documentation: 'Start position (0-1)' },
        { label: 'end', documentation: 'End position (0-1)' },
      ],
    }],
  },
  {
    name: 'contrast',
    detail: 'Contrast',
    documentation: 'Apply different functions based on a boolean pattern',
    signatures: [{
      label: 'contrast(trueFunc, falseFunc, boolPattern)',
      parameters: [
        { label: 'trueFunc', documentation: 'Function when true' },
        { label: 'falseFunc', documentation: 'Function when false' },
        { label: 'boolPattern', documentation: 'Boolean pattern' },
      ],
    }],
  },
  // Scramble and shuffle
  {
    name: 'scramble',
    detail: 'Scramble',
    documentation: 'Randomly rearrange pattern segments',
    signatures: [{
      label: 'scramble(n)',
      parameters: [{ label: 'n', documentation: 'Number of segments' }],
    }],
  },
  {
    name: 'shuffle',
    detail: 'Shuffle',
    documentation: 'Shuffle pattern segments (same random order each cycle)',
    signatures: [{
      label: 'shuffle(n)',
      parameters: [{ label: 'n', documentation: 'Number of segments' }],
    }],
  },
  {
    name: 'bite',
    detail: 'Bite',
    documentation: 'Slice and rearrange pattern segments',
    signatures: [{
      label: 'bite(n, pattern)',
      parameters: [
        { label: 'n', documentation: 'Number of segments' },
        { label: 'pattern', documentation: 'Pattern of segment indices' },
      ],
    }],
  },
  // Inhabit
  {
    name: 'inhabit',
    detail: 'Inhabit',
    documentation: 'Map pattern values to other patterns',
    signatures: [{
      label: 'inhabit(mapping)',
      parameters: [{ label: 'mapping', documentation: 'Object mapping values to patterns' }],
    }],
  },
  // Weave
  {
    name: 'weave',
    detail: 'Weave',
    documentation: 'Weave patterns together with time offsets',
    signatures: [{
      label: 'weave(subdivisions, patterns...)',
      parameters: [
        { label: 'subdivisions', documentation: 'Number of subdivisions' },
        { label: 'patterns', documentation: 'Patterns to weave' },
      ],
    }],
  },
  {
    name: 'weaveWith',
    detail: 'Weave with function',
    documentation: 'Weave with a function applied at each step',
    signatures: [{
      label: 'weaveWith(subdivisions, function, patterns...)',
      parameters: [
        { label: 'subdivisions', documentation: 'Number of subdivisions' },
        { label: 'function', documentation: 'Function to apply' },
        { label: 'patterns', documentation: 'Patterns to weave' },
      ],
    }],
  },
  // Spin and stripe
  {
    name: 'spin',
    detail: 'Spin',
    documentation: 'Layer pattern with itself, rotated in stereo',
    signatures: [{
      label: 'spin(n)',
      parameters: [{ label: 'n', documentation: 'Number of rotations' }],
    }],
  },
  {
    name: 'stripe',
    detail: 'Stripe',
    documentation: 'Apply function in stripes across the pattern',
    signatures: [{
      label: 'stripe(n)',
      parameters: [{ label: 'n', documentation: 'Number of stripes' }],
    }],
  },
  // Reset
  {
    name: 'reset',
    detail: 'Reset',
    documentation: 'Reset pattern when triggered',
    signatures: [{
      label: 'reset(trigger)',
      parameters: [{ label: 'trigger', documentation: 'Trigger pattern' }],
    }],
  },
  {
    name: 'resetCycles',
    detail: 'Reset cycles',
    documentation: 'Reset pattern after N cycles',
    signatures: [{
      label: 'resetCycles(n)',
      parameters: [{ label: 'n', documentation: 'Number of cycles before reset' }],
    }],
  },
  // Set
  {
    name: 'set',
    detail: 'Set',
    documentation: 'Set control values from an object pattern',
    signatures: [{
      label: 'set(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of {control: value} objects' }],
    }],
  },
  // MIDI
  {
    name: 'ccn',
    detail: 'CC number',
    documentation: 'Set MIDI CC number',
    signatures: [{
      label: 'ccn(number)',
      parameters: [{ label: 'number', documentation: 'MIDI CC number (0-127)' }],
    }],
  },
  {
    name: 'ccv',
    detail: 'CC value',
    documentation: 'Set MIDI CC value',
    signatures: [{
      label: 'ccv(value)',
      parameters: [{ label: 'value', documentation: 'MIDI CC value (0-127)' }],
    }],
  },
  {
    name: 'midichan',
    detail: 'MIDI channel',
    documentation: 'Set MIDI channel',
    signatures: [{
      label: 'midichan(channel)',
      parameters: [{ label: 'channel', documentation: 'MIDI channel (0-15)' }],
    }],
  },
  {
    name: 'midiport',
    detail: 'MIDI port',
    documentation: 'Set MIDI output port',
    signatures: [{
      label: 'midiport(port)',
      parameters: [{ label: 'port', documentation: 'MIDI port name' }],
    }],
  },
  // Color/visualization
  {
    name: 'color',
    detail: 'Color',
    documentation: 'Set color for visualization',
    signatures: [{
      label: 'color(value)',
      parameters: [{ label: 'value', documentation: 'Color value (CSS color or pattern)' }],
    }],
  },
  // Utility
  {
    name: 'log',
    detail: 'Log',
    documentation: 'Log pattern values to console for debugging',
    signatures: [{
      label: 'log()',
      parameters: [],
    }],
  },
  {
    name: 'apply',
    detail: 'Apply',
    documentation: 'Apply a function to the pattern',
    signatures: [{
      label: 'apply(function)',
      parameters: [{ label: 'function', documentation: 'Function to apply' }],
    }],
  },
  {
    name: 'all',
    detail: 'All',
    documentation: 'Apply function to all events',
    signatures: [{
      label: 'all(function)',
      parameters: [{ label: 'function', documentation: 'Function to apply to all events' }],
    }],
  },
  // Press
  {
    name: 'press',
    detail: 'Press',
    documentation: 'Compress events to the first half of their timespan',
    signatures: [{
      label: 'press()',
      parameters: [],
    }],
  },
  {
    name: 'pressBy',
    detail: 'Press by',
    documentation: 'Compress events by a specified amount',
    signatures: [{
      label: 'pressBy(amount)',
      parameters: [{ label: 'amount', documentation: 'Compression amount (0-1)' }],
    }],
  },
  // Pick functions for sample selection
  {
    name: 'pickF',
    detail: 'Pick with function',
    documentation: 'Pick samples using a function',
    signatures: [{
      label: 'pickF(function)',
      parameters: [{ label: 'function', documentation: 'Function to determine sample selection' }],
    }],
  },
  {
    name: 'pickOut',
    detail: 'Pick out',
    documentation: 'Pick samples cycling through indices',
    signatures: [{
      label: 'pickOut(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of sample indices' }],
    }],
  },
  {
    name: 'pickRestart',
    detail: 'Pick restart',
    documentation: 'Pick samples, restarting on each cycle',
    signatures: [{
      label: 'pickRestart()',
      parameters: [],
    }],
  },
  // Granular
  {
    name: 'granular',
    detail: 'Granular',
    documentation: 'Apply granular synthesis',
    signatures: [{
      label: 'granular(options)',
      parameters: [{ label: 'options', documentation: 'Granular synthesis options' }],
    }],
  },
];

// Common typos and their corrections
const TYPO_CORRECTIONS: Record<string, string> = {
  // Sample typos
  'db': 'bd',
  'ds': 'sd',
  'kick': 'bd',
  'snare': 'sd',
  'hihat': 'hh',
  'openhat': 'oh',
  'clap': 'cp',
  'cowbell': 'cb',
  'crash': 'cr',
  'ride': 'rd',
  // Note typos
  'cf': 'c',
  'ef': 'e',
  'bf': 'b',
  // Function typos
  'sounds': 'sound',
  'notes': 'note',
  'filters': 'lpf',
  'lowpass': 'lpf',
  'highpass': 'hpf',
  'bandpass': 'bpf',
  'reverb': 'room',
  'echo': 'delay',
  'volume': 'gain',
  'reverse': 'rev',
};

/**
 * Get all available samples (dynamic + defaults merged)
 * Always includes default samples as a baseline, adds dynamic samples on top
 */
function getAllSamples(): string[] {
  if (dynamicSamples.length > 0) {
    // Merge defaults with dynamic, removing duplicates
    const combined = new Set([...DEFAULT_SAMPLE_NAMES, ...dynamicSamples]);
    return Array.from(combined);
  }
  return DEFAULT_SAMPLE_NAMES;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

/**
 * Find similar words for typo suggestions
 */
function findSimilar(word: string, candidates: string[], maxDistance = 2): string[] {
  const lowerWord = word.toLowerCase();
  
  // Check explicit typo corrections first
  if (TYPO_CORRECTIONS[lowerWord]) {
    return [TYPO_CORRECTIONS[lowerWord]];
  }
  
  // Find candidates within edit distance
  const similar: { word: string; distance: number }[] = [];
  for (const candidate of candidates) {
    const distance = levenshtein(lowerWord, candidate.toLowerCase());
    if (distance <= maxDistance && distance > 0) {
      similar.push({ word: candidate, distance });
    }
  }
  
  // Sort by distance and return top matches
  return similar
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(s => s.word);
}

/**
 * Mini-notation parse result
 */
interface MiniParseResult {
  success: boolean;
  leaves?: Array<{
    type_: string;
    source_: string;
    location_: {
      start: { offset: number; line: number; column: number };
      end: { offset: number; line: number; column: number };
    };
  }>;
  error?: {
    message: string;
    location?: {
      start: { offset: number; line: number; column: number };
      end: { offset: number; line: number; column: number };
    };
    expected?: string[];
    found?: string;
  };
}

/**
 * Parse mini-notation using @strudel/mini parser
 * The parser expects the string WITH quotes, so we add them
 */
function parseMiniNotation(content: string): MiniParseResult {
  // Wrap content in quotes for the parser (it expects the full quoted string)
  const quotedContent = `"${content.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  
  try {
    // Use parse() directly to get the PEG.js error with location if it fails
    parseMini(quotedContent);
    
    // If parse succeeded, get the leaves (atoms) for further analysis
    const leaves = getMiniLeaves(quotedContent);
    return { success: true, leaves };
  } catch (e: any) {
    // Check if it's a PEG.js SyntaxError with location
    if (e && e.location) {
      return {
        success: false,
        error: {
          message: e.message,
          location: e.location,
          expected: e.expected?.map((exp: any) => {
            if (exp.type === 'literal') return `'${exp.text}'`;
            if (exp.description) return exp.description;
            return String(exp);
          }),
          found: e.found,
        },
      };
    }
    
    // Try to extract location from error message: "[mini] parse error at line X column Y:"
    const locMatch = e.message?.match(/line (\d+)(?: column (\d+))?/);
    if (locMatch) {
      const line = parseInt(locMatch[1], 10);
      const column = locMatch[2] ? parseInt(locMatch[2], 10) : 1;
      return {
        success: false,
        error: {
          message: e.message.replace(/^\[mini\] parse error at line \d+(?: column \d+)?:\s*/, ''),
          location: {
            start: { offset: 0, line, column },
            end: { offset: 0, line, column: column + 1 },
          },
        },
      };
    }
    
    // Generic error
    return {
      success: false,
      error: { message: e.message || 'Unknown parse error' },
    };
  }
}

// Store diagnostics with their data for code actions
interface DiagnosticData {
  type: 'unknown_sample' | 'unbalanced_bracket' | 'unknown_function';
  word?: string;
  suggestions?: string[];
}

const diagnosticDataMap = new Map<string, Map<string, DiagnosticData>>();

connection.onInitialize((params: InitializeParams): InitializeResult => {
  connection.console.log('Strudel LSP initializing...');
  
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: ['"', "'", ' ', ':', '(', '.', ','],
        resolveProvider: true,
      },
      hoverProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
        retriggerCharacters: [','],
      },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix],
      },
    },
  };
});

connection.onInitialized(() => {
  connection.console.log('Strudel LSP initialized');
  
  // Connect to engine and load samples
  connectToEngine();
});

/**
 * TCP client state for engine connection
 */
let engineSocket: import('net').Socket | null = null;
let engineBuffer = '';
let stopWatching: (() => void) | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

/**
 * Connect to the engine via TCP and request samples
 * Uses state file to get connection info, watches for engine restarts
 */
async function connectToEngine() {
  const net = await import('net');
  const { readEngineState, watchEngineState, isEngineRunning } = await import('./engine-state.js');
  
  // Function to attempt connection
  const tryConnect = (state: { port: number; pid: number }) => {
    if (engineSocket) {
      engineSocket.destroy();
      engineSocket = null;
    }
    
    connection.console.log(`Connecting to engine on port ${state.port}...`);
    
    const socket = net.createConnection({ port: state.port, host: '127.0.0.1' }, () => {
      connection.console.log('Connected to engine');
      engineSocket = socket;
      
      // Request samples, banks, and sounds
      socket.write(JSON.stringify({ type: 'getSamples' }) + '\n');
      socket.write(JSON.stringify({ type: 'getBanks' }) + '\n');
      socket.write(JSON.stringify({ type: 'getSounds' }) + '\n');
    });
    
    socket.on('data', (data) => {
      engineBuffer += data.toString();
      
      // Process newline-delimited JSON messages
      let newlineIndex;
      while ((newlineIndex = engineBuffer.indexOf('\n')) !== -1) {
        const line = engineBuffer.slice(0, newlineIndex);
        engineBuffer = engineBuffer.slice(newlineIndex + 1);
        
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            handleEngineMessage(msg);
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    });
    
    socket.on('error', (err) => {
      connection.console.log(`Engine connection error: ${err.message}`);
      engineSocket = null;
    });
    
    socket.on('close', () => {
      connection.console.log('Engine connection closed');
      engineSocket = null;
      engineBuffer = '';
    });
  };
  
  // Handle messages from engine
  const handleEngineMessage = (msg: any) => {
    switch (msg.type) {
      case 'samples':
        dynamicSamples = msg.samples || [];
        connection.console.log(`Received ${dynamicSamples.length} samples from engine`);
        // Re-validate all open documents
        documents.all().forEach(doc => validateDocument(doc));
        break;
      case 'banks':
        dynamicBanks = msg.banks || [];
        connection.console.log(`Received ${dynamicBanks.length} banks from engine`);
        // Re-validate all open documents
        documents.all().forEach(doc => validateDocument(doc));
        break;
      case 'sounds':
        // Could store synth sounds too if needed
        connection.console.log(`Received ${msg.sounds?.length || 0} sounds from engine`);
        break;
    }
  };
  
  // Initial connection attempt
  const state = readEngineState();
  if (state && isEngineRunning(state) && state.port > 0) {
    tryConnect(state);
  } else {
    connection.console.log('Engine not running, waiting for it to start...');
  }
  
  // Watch for engine starting/restarting
  stopWatching = watchEngineState((newState) => {
    if (newState && isEngineRunning(newState) && newState.port > 0) {
      // Clear any pending reconnect
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      
      // Small delay to let engine fully initialize
      reconnectTimer = setTimeout(() => {
        tryConnect(newState);
      }, 500);
    } else if (!newState) {
      connection.console.log('Engine stopped');
      if (engineSocket) {
        engineSocket.destroy();
        engineSocket = null;
      }
    }
  });
}

/**
 * Find if position is inside a mini-notation string (inside quotes)
 */
function findMiniNotationContext(document: TextDocument, position: Position): { inMini: boolean; content: string; startOffset: number } | null {
  const text = document.getText();
  const offset = document.offsetAt(position);
  
  // Look backwards for opening quote
  let quoteStart = -1;
  let quoteChar = '';
  for (let i = offset - 1; i >= 0; i--) {
    const char = text[i];
    if (char === '"' || char === "'") {
      // Check if escaped
      if (i > 0 && text[i - 1] === '\\') continue;
      quoteStart = i;
      quoteChar = char;
      break;
    }
    // Stop at newline or semicolon (likely not in same string)
    if (char === '\n' || char === ';') break;
  }
  
  if (quoteStart === -1) return null;
  
  // Look forward for closing quote
  let quoteEnd = -1;
  for (let i = offset; i < text.length; i++) {
    const char = text[i];
    if (char === quoteChar) {
      // Check if escaped
      if (i > 0 && text[i - 1] === '\\') continue;
      quoteEnd = i;
      break;
    }
    if (char === '\n') break;
  }
  
  if (quoteEnd === -1) return null;
  
  const content = text.slice(quoteStart + 1, quoteEnd);
  return { inMini: true, content, startOffset: quoteStart + 1 };
}

/**
 * Get current word at position
 */
function getCurrentWord(text: string, offset: number): string {
  let start = offset;
  let end = offset;
  
  // Go backwards to find word start
  while (start > 0 && /[a-zA-Z0-9_]/.test(text[start - 1])) {
    start--;
  }
  
  // Go forward to find word end
  while (end < text.length && /[a-zA-Z0-9_]/.test(text[end])) {
    end++;
  }
  
  return text.slice(start, end);
}

/**
 * Find function call context at position
 */
function findFunctionContext(text: string, offset: number): { name: string; paramIndex: number } | null {
  let depth = 0;
  let paramIndex = 0;
  
  // Go backwards to find function name
  for (let i = offset - 1; i >= 0; i--) {
    const char = text[i];
    
    if (char === ')') {
      depth++;
    } else if (char === '(') {
      if (depth === 0) {
        // Found opening paren, now find function name
        let nameEnd = i;
        let nameStart = i - 1;
        while (nameStart >= 0 && /[a-zA-Z0-9_]/.test(text[nameStart])) {
          nameStart--;
        }
        nameStart++;
        
        if (nameStart < nameEnd) {
          const name = text.slice(nameStart, nameEnd);
          return { name, paramIndex };
        }
        return null;
      }
      depth--;
    } else if (char === ',' && depth === 0) {
      paramIndex++;
    } else if (char === '\n' || char === ';') {
      break;
    }
  }
  
  return null;
}

connection.onCompletion((params): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  
  const text = document.getText();
  const offset = document.offsetAt(params.position);
  
  // Check if we're inside a mini-notation string
  const miniContext = findMiniNotationContext(document, params.position);
  
  const items: CompletionItem[] = [];
  
  if (miniContext?.inMini) {
    // Inside mini-notation - suggest samples and notes
    const localOffset = offset - miniContext.startOffset;
    const beforeCursor = miniContext.content.slice(0, localOffset);
    
    // Check if after a colon (sample index)
    if (beforeCursor.endsWith(':')) {
      // Suggest sample indices
      for (let i = 0; i < 16; i++) {
        items.push({
          label: String(i),
          kind: CompletionItemKind.Value,
          detail: `Sample variant ${i}`,
          sortText: String(i).padStart(2, '0'),
        });
      }
      return items;
    }
    
    // Suggest samples
    const samples = getAllSamples();
    for (const sample of samples) {
      items.push({
        label: sample,
        kind: CompletionItemKind.Value,
        detail: 'Sample',
        documentation: `Play ${sample} sound`,
      });
    }
    
    // Suggest notes with octaves
    for (const note of NOTE_NAMES) {
      for (const octave of OCTAVES) {
        items.push({
          label: `${note}${octave}`,
          kind: CompletionItemKind.Value,
          detail: 'Note',
          documentation: `Note ${note.toUpperCase()}${octave}`,
          sortText: `1${note}${octave}`, // Sort notes after samples
        });
      }
    }
    
    // Suggest mini-notation operators
    for (const op of MINI_OPERATORS) {
      items.push({
        label: op.label,
        kind: CompletionItemKind.Operator,
        detail: op.detail,
        documentation: op.documentation,
        sortText: `2${op.label}`, // Sort operators last
      });
    }
  } else {
    // Outside mini-notation - suggest Strudel functions
    
    // Check if we're after a dot (method call)
    const beforeCursor = text.slice(Math.max(0, offset - 50), offset);
    const afterDot = beforeCursor.match(/\.\s*([a-zA-Z]*)$/);
    
    for (const func of STRUDEL_FUNCTIONS) {
      items.push({
        label: func.name,
        kind: CompletionItemKind.Function,
        detail: func.detail,
        documentation: {
          kind: MarkupKind.Markdown,
          value: `${func.documentation}\n\n\`\`\`javascript\n${func.signatures[0].label}\n\`\`\``,
        },
        insertText: afterDot ? `${func.name}($1)` : `${func.name}($1)`,
        insertTextFormat: 2, // Snippet
      });
    }
    
    // Suggest scales
    for (const scale of SCALE_NAMES) {
      items.push({
        label: scale,
        kind: CompletionItemKind.Enum,
        detail: 'Scale',
        documentation: `${scale} scale`,
      });
    }
    
    // Suggest banks if typing .bank(
    if (beforeCursor.includes('.bank(')) {
      const banks = dynamicBanks.length > 0 ? dynamicBanks : ['RolandTR808', 'RolandTR909', 'RolandTR707'];
      for (const bank of banks) {
        items.push({
          label: bank,
          kind: CompletionItemKind.Module,
          detail: 'Sample bank',
          documentation: `Use ${bank} drum machine samples`,
        });
      }
    }
  }
  
  return items;
});

connection.onCompletionResolve((item): CompletionItem => {
  // Add more detail on resolve if needed
  return item;
});

connection.onSignatureHelp((params): SignatureHelp | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  
  const text = document.getText();
  const offset = document.offsetAt(params.position);
  
  // Find function context
  const funcContext = findFunctionContext(text, offset);
  if (!funcContext) return null;
  
  // Find matching function
  const func = STRUDEL_FUNCTIONS.find(f => f.name === funcContext.name);
  if (!func) return null;
  
  // Build signature help
  const signatures: SignatureInformation[] = func.signatures.map(sig => {
    const params: ParameterInformation[] = sig.parameters.map(p => ({
      label: p.label,
      documentation: {
        kind: MarkupKind.Markdown,
        value: p.documentation,
      },
    }));
    
    return {
      label: sig.label,
      documentation: sig.documentation || func.documentation,
      parameters: params,
    };
  });
  
  // Select best signature based on parameter count
  let activeSignature = 0;
  for (let i = 0; i < func.signatures.length; i++) {
    if (func.signatures[i].parameters.length > funcContext.paramIndex) {
      activeSignature = i;
      break;
    }
  }
  
  return {
    signatures,
    activeSignature,
    activeParameter: Math.min(funcContext.paramIndex, func.signatures[activeSignature]?.parameters.length - 1 || 0),
  };
});

connection.onHover((params): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  
  const text = document.getText();
  const offset = document.offsetAt(params.position);
  const word = getCurrentWord(text, offset);
  
  if (!word) return null;
  
  const samples = getAllSamples();
  
  // Check samples
  if (samples.includes(word)) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${word}** - Sample\n\nPlay the ${word} sound.\n\n\`\`\`javascript\ns("${word}")\n\`\`\``,
      },
    };
  }
  
  // Check notes (strip octave)
  const noteBase = word.replace(/[0-9]/g, '');
  if (NOTE_NAMES.includes(noteBase)) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${word}** - Note\n\nMusical note ${noteBase.toUpperCase()}${word.replace(/[^0-9]/g, '')}.\n\n\`\`\`javascript\nnote("${word}")\n\`\`\``,
      },
    };
  }
  
  // Check functions
  const func = STRUDEL_FUNCTIONS.find(f => f.name === word);
  if (func) {
    const sigExamples = func.signatures.map(s => s.label).join('\n');
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${func.name}** - ${func.detail}\n\n${func.documentation}\n\n\`\`\`javascript\n${sigExamples}\n\`\`\``,
      },
    };
  }
  
  // Check scales
  if (SCALE_NAMES.includes(word)) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${word}** - Scale\n\nMusical scale.\n\n\`\`\`javascript\n.scale("${word}")\n\`\`\``,
      },
    };
  }
  
  // Check mini operators
  const op = MINI_OPERATORS.find(o => o.label === word || o.label.includes(word));
  if (op) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${op.label}** - ${op.detail}\n\n${op.documentation}`,
      },
    };
  }
  
  // Check banks
  if (dynamicBanks.includes(word)) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${word}** - Sample Bank\n\nDrum machine sample bank.\n\n\`\`\`javascript\n.bank("${word}")\n\`\`\``,
      },
    };
  }
  
  return null;
});

/**
 * Validate document and produce diagnostics
 */
async function validateDocument(document: TextDocument): Promise<void> {
  const text = document.getText();
  const diagnostics: Diagnostic[] = [];
  const docData = new Map<string, DiagnosticData>();
  
  const samples = getAllSamples();
  const functionNames = STRUDEL_FUNCTIONS.map(f => f.name);
  
  // Find all quoted strings and validate mini-notation
  const stringRegex = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let match;
  
  // Functions whose string arguments should NOT be validated as mini-notation samples
  // These take bank names, scale names, or other non-sample identifiers
  const nonSampleArgFunctions = ['bank', 'scale', 'mode', 'voicing', 'chord', 'struct', 'mask'];
  
  while ((match = stringRegex.exec(text)) !== null) {
    const content = match[2];
    const stringStartOffset = match.index; // Position of opening quote
    const contentStartOffset = match.index + 1; // Skip opening quote
    
    // Skip empty strings
    if (!content.trim()) continue;
    
    // Skip strings that look like paths or URLs
    if (content.includes('/') && (content.startsWith('http') || content.startsWith('.') || content.startsWith('github:'))) continue;
    
    // Skip strings that are clearly not mini-notation (contain common code patterns)
    if (content.includes('function') || content.includes('=>') || content.includes('return')) continue;
    
    // Check if this string is an argument to a function that doesn't take sample names
    // Look backwards from the quote to find the function call pattern: .funcName( or funcName(
    const beforeString = text.slice(Math.max(0, stringStartOffset - 50), stringStartOffset);
    const funcCallMatch = beforeString.match(/\.?(\w+)\s*\(\s*$/);
    if (funcCallMatch && nonSampleArgFunctions.includes(funcCallMatch[1])) {
      // This is an argument to bank(), scale(), etc. - skip sample validation
      continue;
    }
    
    // Parse using @strudel/mini for proper AST-based validation
    const parseResult = parseMiniNotation(content);
    
    if (!parseResult.success && parseResult.error) {
      // Report parser error with accurate location
      const error = parseResult.error;
      
      // Calculate position in document
      // Parser location is 1-indexed and includes the quote we added, so subtract 1 from column
      let errorOffset: number;
      if (error.location) {
        // Parser offset includes the quote char we wrapped, so subtract 1
        // But we want to point to the document position, so use contentStartOffset
        errorOffset = contentStartOffset + Math.max(0, error.location.start.offset - 1);
      } else {
        errorOffset = contentStartOffset;
      }
      
      const pos = document.positionAt(errorOffset);
      const endOffset = error.location 
        ? contentStartOffset + Math.max(0, error.location.end.offset - 1)
        : errorOffset + 1;
      const endPos = document.positionAt(Math.min(endOffset, stringStartOffset + match[0].length - 1));
      
      const range = Range.create(pos, endPos);
      const key = `${range.start.line}:${range.start.character}`;
      
      // Clean up the error message
      let message = error.message;
      if (error.expected && error.found !== undefined) {
        const expectedStr = error.expected.slice(0, 5).join(', ');
        const more = error.expected.length > 5 ? `, ... (${error.expected.length - 5} more)` : '';
        message = `Syntax error: expected ${expectedStr}${more} but found ${error.found === null ? 'end of input' : `'${error.found}'`}`;
      }
      
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range,
        message,
        source: 'strudel',
        code: 'parse-error',
      });
      
      docData.set(key, { type: 'unbalanced_bracket' });
    }
    
    // If parsing succeeded, validate the leaves (atoms) for unknown samples
    if (parseResult.success && parseResult.leaves) {
      for (const leaf of parseResult.leaves) {
        if (leaf.type_ !== 'atom') continue;
        
        const word = leaf.source_;
        
        // Skip if it looks like a note (with or without octave)
        if (/^[a-g][sb]?[0-9]?$/i.test(word)) continue;
        
        // Skip numbers and rests
        if (/^[0-9.-]+$/.test(word) || word === '~') continue;
        
        // Skip if it's a known sample
        if (samples.some(s => s.toLowerCase() === word.toLowerCase())) continue;
        
        // Skip if it's a known bank (banks can appear as sample prefixes)
        if (dynamicBanks.some(b => b.toLowerCase() === word.toLowerCase())) continue;
        
        // Skip common mini-notation atoms
        if (['x', 't', 'f', 'r', '-', '_'].includes(word.toLowerCase())) continue;
        
        // Skip if it looks like a variable reference
        if (/^[A-Z]/.test(word)) continue;
        
        // Skip voicing modes (used with .mode() like "above:c3", "below:c4")
        if (VOICING_MODES.includes(word.toLowerCase())) continue;
        
        // Skip scale names (used with .scale())
        if (SCALE_NAMES.includes(word.toLowerCase())) continue;
        
        // Calculate position in document
        // leaf.location_.start.offset is relative to the quoted string, subtract 1 for the quote we added
        const wordOffset = contentStartOffset + Math.max(0, leaf.location_.start.offset - 1);
        const wordEndOffset = contentStartOffset + Math.max(0, leaf.location_.end.offset - 1);
        
        const pos = document.positionAt(wordOffset);
        const endPos = document.positionAt(wordEndOffset);
        const range = Range.create(pos, endPos);
        const key = `${range.start.line}:${range.start.character}`;
        
        // Find similar samples for suggestion
        const suggestions = findSimilar(word, samples);
        
        const diagnostic: Diagnostic = {
          severity: suggestions.length > 0 ? DiagnosticSeverity.Warning : DiagnosticSeverity.Hint,
          range,
          message: suggestions.length > 0
            ? `Unknown sample '${word}'. Did you mean: ${suggestions.join(', ')}?`
            : `Unknown sample '${word}' (may work if loaded dynamically)`,
          source: 'strudel',
          code: 'unknown-sample',
        };
        
        diagnostics.push(diagnostic);
        docData.set(key, { type: 'unknown_sample', word, suggestions });
      }
    } else if (!parseResult.success) {
      // Fallback: if parsing failed, still try to identify unknown samples with simple regex
      // This helps users even when there are syntax errors
      const words = content.split(/[\s\[\]\{\}\(\)<>:*\/!?@~,|]+/).filter(w => w && !/^[0-9.-]+$/.test(w));
      for (const word of words) {
        // Skip if it looks like a note
        if (/^[a-g][sb]?[0-9]?$/i.test(word)) continue;
        // Skip if it's a known sample
        if (samples.some(s => s.toLowerCase() === word.toLowerCase())) continue;
        // Skip if it's a known bank
        if (dynamicBanks.some(b => b.toLowerCase() === word.toLowerCase())) continue;
        // Skip common words/operators
        if (['x', 't', 'f', 'r', '-', '_'].includes(word.toLowerCase())) continue;
        // Skip if it looks like a variable reference
        if (/^[A-Z]/.test(word)) continue;
        // Skip voicing modes and scale names
        if (VOICING_MODES.includes(word.toLowerCase())) continue;
        if (SCALE_NAMES.includes(word.toLowerCase())) continue;
        
        // Find position of this word in content
        const wordIndex = content.indexOf(word);
        if (wordIndex !== -1) {
          const pos = document.positionAt(contentStartOffset + wordIndex);
          const range = Range.create(pos, Position.create(pos.line, pos.character + word.length));
          const key = `${range.start.line}:${range.start.character}`;
          
          // Skip if we already reported this location
          if (docData.has(key)) continue;
          
          // Find similar samples for suggestion
          const suggestions = findSimilar(word, samples);
          
          const diagnostic: Diagnostic = {
            severity: suggestions.length > 0 ? DiagnosticSeverity.Warning : DiagnosticSeverity.Hint,
            range,
            message: suggestions.length > 0
              ? `Unknown sample '${word}'. Did you mean: ${suggestions.join(', ')}?`
              : `Unknown sample '${word}' (may work if loaded dynamically)`,
            source: 'strudel',
            code: 'unknown-sample',
          };
          
          diagnostics.push(diagnostic);
          docData.set(key, { type: 'unknown_sample', word, suggestions });
        }
      }
    }
  }
  
  // Check function calls outside strings
  const funcCallRegex = /\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  while ((match = funcCallRegex.exec(text)) !== null) {
    const funcName = match[1];
    const funcStart = match.index + 1; // After the dot
    
    // Skip if known function
    if (functionNames.includes(funcName)) continue;
    // Skip common method names
    if (['then', 'catch', 'map', 'filter', 'forEach', 'reduce', 'log', 'error', 'warn'].includes(funcName)) continue;
    
    const suggestions = findSimilar(funcName, functionNames);
    
    if (suggestions.length > 0) {
      const pos = document.positionAt(funcStart);
      const range = Range.create(pos, Position.create(pos.line, pos.character + funcName.length));
      const key = `${range.start.line}:${range.start.character}`;
      
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range,
        message: `Unknown function '${funcName}'. Did you mean: ${suggestions.join(', ')}?`,
        source: 'strudel',
        code: 'unknown-function',
      });
      
      docData.set(key, { type: 'unknown_function', word: funcName, suggestions });
    }
  }
  
  diagnosticDataMap.set(document.uri, docData);
  connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  
  const actions: CodeAction[] = [];
  const docData = diagnosticDataMap.get(document.uri);
  
  for (const diagnostic of params.context.diagnostics) {
    if (diagnostic.source !== 'strudel') continue;
    
    const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}`;
    const data = docData?.get(key);
    
    if (data?.suggestions && data.suggestions.length > 0) {
      for (const suggestion of data.suggestions) {
        actions.push({
          title: `Replace with '${suggestion}'`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          isPreferred: data.suggestions.indexOf(suggestion) === 0,
          edit: {
            changes: {
              [params.textDocument.uri]: [
                TextEdit.replace(diagnostic.range, suggestion),
              ],
            },
          },
        });
      }
    }
  }
  
  return actions;
});

// Validate on open and change
documents.onDidOpen((event) => {
  validateDocument(event.document);
});

documents.onDidChangeContent((event) => {
  validateDocument(event.document);
});

documents.onDidClose((event) => {
  diagnosticDataMap.delete(event.document.uri);
});

// Cleanup on shutdown
connection.onShutdown(() => {
  if (stopWatching) {
    stopWatching();
    stopWatching = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (engineSocket) {
    engineSocket.destroy();
    engineSocket = null;
  }
});

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();

console.error('[strudel-lsp] Server started');
