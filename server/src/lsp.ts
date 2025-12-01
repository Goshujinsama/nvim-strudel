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
  // === AUTO-GENERATED FROM STRUDEL JSDOC ===
  {
    name: 'wtenv',
    detail: 'Amount of envelope applied wavetable oscillator\'s position e',
    documentation: 'Amount of envelope applied wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtenv(amount)',
      parameters: [
        { label: 'amount', documentation: 'between 0 and 1' }
      ],
    }],
  },
  {
    name: 'wtattack',
    detail: 'Attack time of the wavetable oscillator\'s position envelope',
    documentation: 'Attack time of the wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtattack(time)',
      parameters: [
        { label: 'time', documentation: 'attack time in seconds' }
      ],
    }],
  },
  {
    name: 'wtdecay',
    detail: 'Decay time of the wavetable oscillator\'s position envelope',
    documentation: 'Decay time of the wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtdecay(time)',
      parameters: [
        { label: 'time', documentation: 'decay time in seconds' }
      ],
    }],
  },
  {
    name: 'wtsustain',
    detail: 'Sustain time of the wavetable oscillator\'s position envelope',
    documentation: 'Sustain time of the wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtsustain(gain)',
      parameters: [
        { label: 'gain', documentation: 'sustain level (0 to 1)' }
      ],
    }],
  },
  {
    name: 'wtrelease',
    detail: 'Release time of the wavetable oscillator\'s position envelope',
    documentation: 'Release time of the wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtrelease(time)',
      parameters: [
        { label: 'time', documentation: 'release time in seconds' }
      ],
    }],
  },
  {
    name: 'wtrate',
    detail: 'Rate of the LFO for the wavetable oscillator\'s position',
    documentation: 'Rate of the LFO for the wavetable oscillator\'s position',
    signatures: [{
      label: 'wtrate(rate)',
      parameters: [
        { label: 'rate', documentation: 'rate in hertz' }
      ],
    }],
  },
  {
    name: 'wtsync',
    detail: 'cycle synced rate of the LFO for the wavetable oscillator\'s ',
    documentation: 'cycle synced rate of the LFO for the wavetable oscillator\'s position',
    signatures: [{
      label: 'wtsync(rate)',
      parameters: [
        { label: 'rate', documentation: 'rate in cycles' }
      ],
    }],
  },
  {
    name: 'wtdepth',
    detail: 'Depth of the LFO for the wavetable oscillator\'s position',
    documentation: 'Depth of the LFO for the wavetable oscillator\'s position',
    signatures: [{
      label: 'wtdepth(depth)',
      parameters: [
        { label: 'depth', documentation: 'depth of modulation' }
      ],
    }],
  },
  {
    name: 'wtshape',
    detail: 'Shape of the LFO for the wavetable oscillator\'s position',
    documentation: 'Shape of the LFO for the wavetable oscillator\'s position',
    signatures: [{
      label: 'wtshape(shape)',
      parameters: [
        { label: 'shape', documentation: 'Shape of the lfo (0, 1, 2, ..)' }
      ],
    }],
  },
  {
    name: 'wtdc',
    detail: 'DC offset of the LFO for the wavetable oscillator\'s position',
    documentation: 'DC offset of the LFO for the wavetable oscillator\'s position',
    signatures: [{
      label: 'wtdc(dcoffset)',
      parameters: [
        { label: 'dcoffset', documentation: 'dc offset. set to 0 for unipolar' }
      ],
    }],
  },
  {
    name: 'wtskew',
    detail: 'Skew of the LFO for the wavetable oscillator\'s position',
    documentation: 'Skew of the LFO for the wavetable oscillator\'s position',
    signatures: [{
      label: 'wtskew(skew)',
      parameters: [
        { label: 'skew', documentation: 'How much to bend the LFO shape' }
      ],
    }],
  },
  {
    name: 'warp',
    detail: 'Amount of warp (alteration of the waveform) to apply to the ',
    documentation: 'Amount of warp (alteration of the waveform) to apply to the wavetable oscillator .',
    signatures: [{
      label: 'warp(amount)',
      parameters: [
        { label: 'amount', documentation: 'Warp of the wavetable from 0 to 1' }
      ],
    }],
  },
  {
    name: 'warpattack',
    detail: 'Attack time of the wavetable oscillator\'s warp envelope',
    documentation: 'Attack time of the wavetable oscillator\'s warp envelope',
    signatures: [{
      label: 'warpattack(time)',
      parameters: [
        { label: 'time', documentation: 'attack time in seconds' }
      ],
    }],
  },
  {
    name: 'warpdecay',
    detail: 'Decay time of the wavetable oscillator\'s warp envelope',
    documentation: 'Decay time of the wavetable oscillator\'s warp envelope',
    signatures: [{
      label: 'warpdecay(time)',
      parameters: [
        { label: 'time', documentation: 'decay time in seconds' }
      ],
    }],
  },
  {
    name: 'warpsustain',
    detail: 'Sustain time of the wavetable oscillator\'s warp envelope',
    documentation: 'Sustain time of the wavetable oscillator\'s warp envelope',
    signatures: [{
      label: 'warpsustain(gain)',
      parameters: [
        { label: 'gain', documentation: 'sustain level (0 to 1)' }
      ],
    }],
  },
  {
    name: 'warprelease',
    detail: 'Release time of the wavetable oscillator\'s warp envelope',
    documentation: 'Release time of the wavetable oscillator\'s warp envelope',
    signatures: [{
      label: 'warprelease(time)',
      parameters: [
        { label: 'time', documentation: 'release time in seconds' }
      ],
    }],
  },
  {
    name: 'warprate',
    detail: 'Rate of the LFO for the wavetable oscillator\'s warp',
    documentation: 'Rate of the LFO for the wavetable oscillator\'s warp',
    signatures: [{
      label: 'warprate(rate)',
      parameters: [
        { label: 'rate', documentation: 'rate in hertz' }
      ],
    }],
  },
  {
    name: 'warpdepth',
    detail: 'Depth of the LFO for the wavetable oscillator\'s warp',
    documentation: 'Depth of the LFO for the wavetable oscillator\'s warp',
    signatures: [{
      label: 'warpdepth(depth)',
      parameters: [
        { label: 'depth', documentation: 'depth of modulation' }
      ],
    }],
  },
  {
    name: 'warpshape',
    detail: 'Shape of the LFO for the wavetable oscillator\'s warp',
    documentation: 'Shape of the LFO for the wavetable oscillator\'s warp',
    signatures: [{
      label: 'warpshape(shape)',
      parameters: [
        { label: 'shape', documentation: 'Shape of the lfo (0, 1, 2, ..)' }
      ],
    }],
  },
  {
    name: 'warpdc',
    detail: 'DC offset of the LFO for the wavetable oscillator\'s warp',
    documentation: 'DC offset of the LFO for the wavetable oscillator\'s warp',
    signatures: [{
      label: 'warpdc(dcoffset)',
      parameters: [
        { label: 'dcoffset', documentation: 'dc offset. set to 0 for unipolar' }
      ],
    }],
  },
  {
    name: 'warpskew',
    detail: 'Skew of the LFO for the wavetable oscillator\'s warp',
    documentation: 'Skew of the LFO for the wavetable oscillator\'s warp',
    signatures: [{
      label: 'warpskew(skew)',
      parameters: [
        { label: 'skew', documentation: 'How much to bend the LFO shape' }
      ],
    }],
  },
  {
    name: 'warpmode',
    detail: 'Type of warp (alteration of the waveform) to apply to the wa',
    documentation: 'Type of warp (alteration of the waveform) to apply to the wavetable oscillator. The current options are: none, asym, bendp, bendm, bendmp, sync, quant, fold, pwm, orbit, spin, chaos, primes, binary, brownian, reciprocal, wormhole, logistic, sigmoid, fractal, flip .',
    signatures: [{
      label: 'warpmode(mode)',
      parameters: [
        { label: 'mode', documentation: 'Warp mode' }
      ],
    }],
  },
  {
    name: 'wtphaserand',
    detail: 'Amount of randomness of the initial phase of the wavetable o',
    documentation: 'Amount of randomness of the initial phase of the wavetable oscillator.',
    signatures: [{
      label: 'wtphaserand(amount)',
      parameters: [
        { label: 'amount', documentation: 'Randomness of the initial phase. Between 0 (not random) and 1 (fully random)' }
      ],
    }],
  },
  {
    name: 'warpenv',
    detail: 'Amount of envelope applied wavetable oscillator\'s position e',
    documentation: 'Amount of envelope applied wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'warpenv(amount)',
      parameters: [
        { label: 'amount', documentation: 'between 0 and 1' }
      ],
    }],
  },
  {
    name: 'warpsync',
    detail: 'cycle synced rate of the LFO for the wavetable warp position',
    documentation: 'cycle synced rate of the LFO for the wavetable warp position',
    signatures: [{
      label: 'warpsync(rate)',
      parameters: [
        { label: 'rate', documentation: 'rate in cycles' }
      ],
    }],
  },
  {
    name: 'source',
    detail: 'Define a custom webaudio node to use as a sound source',
    documentation: 'Define a custom webaudio node to use as a sound source.',
    signatures: [{
      label: 'source(getSource)',
      parameters: [
        { label: 'getSource', documentation: '* @synonyms src' }
      ],
    }],
  },
  {
    name: 'accelerate',
    detail: 'A pattern of numbers that speed up (or slow down) samples wh',
    documentation: 'A pattern of numbers that speed up (or slow down) samples while they play. Currently only supported by osc / superdirt.',
    signatures: [{
      label: 'accelerate(amount)',
      parameters: [
        { label: 'amount', documentation: 'acceleration.' }
      ],
    }],
  },
  {
    name: 'postgain',
    detail: 'Gain applied after all effects have been processed',
    documentation: 'Gain applied after all effects have been processed. .',
    signatures: [{
      label: 'postgain()',
      parameters: [

      ],
    }],
  },
  {
    name: 'fmenv',
    detail: 'Ramp type of fm envelope',
    documentation: 'Ramp type of fm envelope. Exp might be a bit broken.. . . . . ._',
    signatures: [{
      label: 'fmenv(type)',
      parameters: [
        { label: 'type', documentation: 'lin | exp' }
      ],
    }],
  },
  {
    name: 'fmattack',
    detail: 'Attack time for the FM envelope: time it takes to reach maxi',
    documentation: 'Attack time for the FM envelope: time it takes to reach maximum modulation . . ._',
    signatures: [{
      label: 'fmattack(time)',
      parameters: [
        { label: 'time', documentation: 'attack time' }
      ],
    }],
  },
  {
    name: 'fmwave',
    detail: 'Waveform of the fm modulator)',
    documentation: 'Waveform of the fm modulator).).',
    signatures: [{
      label: 'fmwave(wave)',
      parameters: [
        { label: 'wave', documentation: 'waveform' }
      ],
    }],
  },
  {
    name: 'fmdecay',
    detail: 'Decay time for the FM envelope: seconds until the sustain le',
    documentation: 'Decay time for the FM envelope: seconds until the sustain level is reached after the attack phase. . . . ._',
    signatures: [{
      label: 'fmdecay(time)',
      parameters: [
        { label: 'time', documentation: 'decay time' }
      ],
    }],
  },
  {
    name: 'fmsustain',
    detail: 'Sustain level for the FM envelope: how much modulation is ap',
    documentation: 'Sustain level for the FM envelope: how much modulation is applied after the decay phase . . . ._',
    signatures: [{
      label: 'fmsustain(level)',
      parameters: [
        { label: 'level', documentation: 'sustain level' }
      ],
    }],
  },
  {
    name: 'chorus',
    detail: 'mix control for the chorus effect',
    documentation: 'mix control for the chorus effect',
    signatures: [{
      label: 'chorus(chorus)',
      parameters: [
        { label: 'chorus', documentation: 'mix amount between 0 and 1' }
      ],
    }],
  },
  {
    name: 'bpq',
    detail: 'Sets the **b**and-**p**ass **q**-factor (resonance)',
    documentation: 'Sets the **b**and-**p**ass **q**-factor (resonance). / // currently an alias of \'bandq\' https://codeberg.org/uzu/strudel/issues/496 // [\'bpq\'], export const { bandq, bpq } =; /** A pattern of numbers from 0 to 1. Skips the beginning of each sample, e.g. `0.25` to cut off the first quarter from each sample.',
    signatures: [{
      label: 'bpq(q, amount)',
      parameters: [
        { label: 'q', documentation: 'q factor' },
        { label: 'amount', documentation: 'between 0 and 1, where 1 is the length of the sample' }
      ],
    }],
  },
  {
    name: 'loop',
    detail: 'Loops the sample',
    documentation: 'Loops the sample. Note that the tempo of the loop is not synced with the cycle tempo. To change the loop region, use loopBegin / loopEnd.',
    signatures: [{
      label: 'loop(on)',
      parameters: [
        { label: 'on', documentation: 'If 1, the sample is looped' }
      ],
    }],
  },
  {
    name: 'loopBegin',
    detail: 'Begin to loop at a specific point in the sample (inbetween `',
    documentation: 'Begin to loop at a specific point in the sample (inbetween `begin` and `end`). Note that the loop point must be inbetween `begin` and `end`, and before `loopEnd`! Note: Samples starting with wt_ will automatically loop! (wt = wavetable) .._',
    signatures: [{
      label: 'loopBegin(time)',
      parameters: [
        { label: 'time', documentation: 'between 0 and 1, where 1 is the length of the sample' }
      ],
    }],
  },
  {
    name: 'loopEnd',
    detail: 'End the looping section at a specific point in the sample (i',
    documentation: 'End the looping section at a specific point in the sample (inbetween `begin` and `end`). Note that the loop point must be inbetween `begin` and `end`, and after `loopBegin`! .._',
    signatures: [{
      label: 'loopEnd(time)',
      parameters: [
        { label: 'time', documentation: 'between 0 and 1, where 1 is the length of the sample' }
      ],
    }],
  },
  {
    name: 'tremolosync',
    detail: 'Modulate the amplitude of a sound with a continuous waveform',
    documentation: 'Modulate the amplitude of a sound with a continuous waveform).',
    signatures: [{
      label: 'tremolosync(cycles)',
      parameters: [
        { label: 'cycles', documentation: 'modulation speed in cycles' }
      ],
    }],
  },
  {
    name: 'tremolodepth',
    detail: 'Depth of amplitude modulation)',
    documentation: 'Depth of amplitude modulation).',
    signatures: [{
      label: 'tremolodepth(depth)',
      parameters: [
        { label: 'depth', documentation: '* @example' }
      ],
    }],
  },
  {
    name: 'tremoloskew',
    detail: 'Alter the shape of the modulation waveform',
    documentation: 'Alter the shape of the modulation waveform',
    signatures: [{
      label: 'tremoloskew(amount)',
      parameters: [
        { label: 'amount', documentation: 'between 0 & 1, the shape of the waveform' }
      ],
    }],
  },
  {
    name: 'tremolophase',
    detail: 'Alter the phase of the modulation waveform',
    documentation: 'Alter the phase of the modulation waveform',
    signatures: [{
      label: 'tremolophase(offset)',
      parameters: [
        { label: 'offset', documentation: 'the offset in cycles of the modulation' }
      ],
    }],
  },
  {
    name: 'tremoloshape',
    detail: 'Shape of amplitude modulation',
    documentation: 'Shape of amplitude modulation',
    signatures: [{
      label: 'tremoloshape(shape)',
      parameters: [
        { label: 'shape', documentation: 'tri | square | sine | saw | ramp' }
      ],
    }],
  },
  {
    name: 'drive',
    detail: 'Filter overdrive for supported filter types)',
    documentation: 'Filter overdrive for supported filter types).',
    signatures: [{
      label: 'drive(amount)',
      parameters: [
        { label: 'amount', documentation: '* @example' }
      ],
    }],
  },
  {
    name: 'duckorbit',
    detail: 'Modulate the amplitude of an orbit to create a "sidechain" l',
    documentation: 'Modulate the amplitude of an orbit to create a "sidechain" like effect. Can be applied to multiple orbits with the \':\' mininotation, e.g. `` $:). $: $:). $: $:',
    signatures: [{
      label: 'duckorbit(orbit)',
      parameters: [
        { label: 'orbit', documentation: 'target orbit' }
      ],
    }],
  },
  {
    name: 'duckdepth',
    detail: 'The amount of ducking applied to target orbit Can vary acros',
    documentation: 'The amount of ducking applied to target orbit Can vary across orbits with the \':\' mininotation, e.g. ``. Note: this requires first applying the effect to multiple orbits with e.g. ``.).,) $:). $: $:',
    signatures: [{
      label: 'duckdepth(depth)',
      parameters: [
        { label: 'depth', documentation: 'depth of modulation from 0 to 1' }
      ],
    }],
  },
  {
    name: 'duckonset',
    detail: 'The time required for the ducked to reach their lowest volum',
    documentation: 'The time required for the ducked to reach their lowest volume. Can be used to prevent clicking or for creative rhythmic effects. Can vary across orbits with the \':\' mininotation, e.g. ``. Note: this requires first applying the effect to multiple orbits with e.g. ``. // Clicks sound: duckerWithClick: // No clicks sound: duckerWithoutClick: // Rhythmic noise: // used rhythmically with 0.3 onset below hhat: ducker:',
    signatures: [{
      label: 'duckonset(time)',
      parameters: [
        { label: 'time', documentation: 'The onset time in seconds' }
      ],
    }],
  },
  {
    name: 'duckattack',
    detail: 'The time required for the ducked to return to their normal v',
    documentation: 'The time required for the ducked to return to their normal volume. Can vary across orbits with the \':\' mininotation, e.g. ``. Note: this requires first applying the effect to multiple orbits with e.g. ``. sound:). ducker: moreduck:). lessduck: ducker:',
    signatures: [{
      label: 'duckattack(time)',
      parameters: [
        { label: 'time', documentation: 'The attack time in seconds' }
      ],
    }],
  },
  {
    name: 'byteBeatExpression',
    detail: 'Create byte beats with custom expressions\')',
    documentation: 'Create byte beats with custom expressions\')',
    signatures: [{
      label: 'byteBeatExpression(byteBeatExpression)',
      parameters: [
        { label: 'byteBeatExpression', documentation: 'bitwise expression for creating bytebeat' }
      ],
    }],
  },
  {
    name: 'byteBeatStartTime',
    detail: 'Create byte beats with custom expressions)',
    documentation: 'Create byte beats with custom expressions).)._',
    signatures: [{
      label: 'byteBeatStartTime(byteBeatStartTime)',
      parameters: [
        { label: 'byteBeatStartTime', documentation: 'in samples (t)' }
      ],
    }],
  },
  {
    name: 'channels',
    detail: 'Allows you to set the output channels on the interface',
    documentation: 'Allows you to set the output channels on the interface',
    signatures: [{
      label: 'channels(channels)',
      parameters: [
        { label: 'channels', documentation: 'pattern the output channels' }
      ],
    }],
  },
  {
    name: 'pw',
    detail: 'Controls the pulsewidth of the pulse oscillator)',
    documentation: 'Controls the pulsewidth of the pulse oscillator).',
    signatures: [{
      label: 'pw(pulsewidth)',
      parameters: [
        { label: 'pulsewidth', documentation: '* @example' }
      ],
    }],
  },
  {
    name: 'pwrate',
    detail: 'Controls the lfo rate for the pulsewidth of the pulse oscill',
    documentation: 'Controls the lfo rate for the pulsewidth of the pulse oscillator).',
    signatures: [{
      label: 'pwrate(rate)',
      parameters: [
        { label: 'rate', documentation: '* @example' }
      ],
    }],
  },
  {
    name: 'pwsweep',
    detail: 'Controls the lfo sweep for the pulsewidth of the pulse oscil',
    documentation: 'Controls the lfo sweep for the pulsewidth of the pulse oscillator).',
    signatures: [{
      label: 'pwsweep(sweep)',
      parameters: [
        { label: 'sweep', documentation: '* @example' }
      ],
    }],
  },
  {
    name: 'phasersweep',
    detail: 'The frequency sweep range of the lfo for the phaser effect',
    documentation: 'The frequency sweep range of the lfo for the phaser effect. Defaults to 2000). .',
    signatures: [{
      label: 'phasersweep(phasersweep)',
      parameters: [
        { label: 'phasersweep', documentation: 'most useful values are between 0 and 4000' }
      ],
    }],
  },
  {
    name: 'phasercenter',
    detail: 'The center frequency of the phaser in HZ',
    documentation: 'The center frequency of the phaser in HZ. Defaults to 1000). .',
    signatures: [{
      label: 'phasercenter(centerfrequency)',
      parameters: [
        { label: 'centerfrequency', documentation: 'in HZ' }
      ],
    }],
  },
  {
    name: 'phaserdepth',
    detail: 'The amount the signal is affected by the phaser effect',
    documentation: 'The amount the signal is affected by the phaser effect. Defaults to 0.75). . / // also a superdirt control export const { phaserdepth, phd, phasdp } =; /** Choose the channel the pattern is sent to in superdirt',
    signatures: [{
      label: 'phaserdepth(depth, channel)',
      parameters: [
        { label: 'depth', documentation: 'number between 0 and 1' },
        { label: 'channel', documentation: 'channel number' }
      ],
    }],
  },
  {
    name: 'lpenv',
    detail: 'Sets the lowpass filter envelope modulation depth',
    documentation: 'Sets the lowpass filter envelope modulation depth. . . . .',
    signatures: [{
      label: 'lpenv(modulation)',
      parameters: [
        { label: 'modulation', documentation: 'depth of the lowpass filter envelope between 0 and _n_' }
      ],
    }],
  },
  {
    name: 'hpenv',
    detail: 'Sets the highpass filter envelope modulation depth',
    documentation: 'Sets the highpass filter envelope modulation depth. . . . .',
    signatures: [{
      label: 'hpenv(modulation)',
      parameters: [
        { label: 'modulation', documentation: 'depth of the highpass filter envelope between 0 and _n_' }
      ],
    }],
  },
  {
    name: 'bpenv',
    detail: 'Sets the bandpass filter envelope modulation depth',
    documentation: 'Sets the bandpass filter envelope modulation depth. . . . .',
    signatures: [{
      label: 'bpenv(modulation)',
      parameters: [
        { label: 'modulation', documentation: 'depth of the bandpass filter envelope between 0 and _n_' }
      ],
    }],
  },
  {
    name: 'lpattack',
    detail: 'Sets the attack duration for the lowpass filter envelope',
    documentation: 'Sets the attack duration for the lowpass filter envelope. . . . .',
    signatures: [{
      label: 'lpattack(attack)',
      parameters: [
        { label: 'attack', documentation: 'time of the filter envelope' }
      ],
    }],
  },
  {
    name: 'hpattack',
    detail: 'Sets the attack duration for the highpass filter envelope',
    documentation: 'Sets the attack duration for the highpass filter envelope. . . . .',
    signatures: [{
      label: 'hpattack(attack)',
      parameters: [
        { label: 'attack', documentation: 'time of the highpass filter envelope' }
      ],
    }],
  },
  {
    name: 'bpattack',
    detail: 'Sets the attack duration for the bandpass filter envelope',
    documentation: 'Sets the attack duration for the bandpass filter envelope. . . . .',
    signatures: [{
      label: 'bpattack(attack)',
      parameters: [
        { label: 'attack', documentation: 'time of the bandpass filter envelope' }
      ],
    }],
  },
  {
    name: 'lpdecay',
    detail: 'Sets the decay duration for the lowpass filter envelope',
    documentation: 'Sets the decay duration for the lowpass filter envelope. . . . .',
    signatures: [{
      label: 'lpdecay(decay)',
      parameters: [
        { label: 'decay', documentation: 'time of the filter envelope' }
      ],
    }],
  },
  {
    name: 'hpdecay',
    detail: 'Sets the decay duration for the highpass filter envelope',
    documentation: 'Sets the decay duration for the highpass filter envelope. . . . . .',
    signatures: [{
      label: 'hpdecay(decay)',
      parameters: [
        { label: 'decay', documentation: 'time of the highpass filter envelope' }
      ],
    }],
  },
  {
    name: 'bpdecay',
    detail: 'Sets the decay duration for the bandpass filter envelope',
    documentation: 'Sets the decay duration for the bandpass filter envelope. . . . . .',
    signatures: [{
      label: 'bpdecay(decay)',
      parameters: [
        { label: 'decay', documentation: 'time of the bandpass filter envelope' }
      ],
    }],
  },
  {
    name: 'lpsustain',
    detail: 'Sets the sustain amplitude for the lowpass filter envelope',
    documentation: 'Sets the sustain amplitude for the lowpass filter envelope. . . . . .',
    signatures: [{
      label: 'lpsustain(sustain)',
      parameters: [
        { label: 'sustain', documentation: 'amplitude of the lowpass filter envelope' }
      ],
    }],
  },
  {
    name: 'hpsustain',
    detail: 'Sets the sustain amplitude for the highpass filter envelope',
    documentation: 'Sets the sustain amplitude for the highpass filter envelope. . . . . .',
    signatures: [{
      label: 'hpsustain(sustain)',
      parameters: [
        { label: 'sustain', documentation: 'amplitude of the highpass filter envelope' }
      ],
    }],
  },
  {
    name: 'bpsustain',
    detail: 'Sets the sustain amplitude for the bandpass filter envelope',
    documentation: 'Sets the sustain amplitude for the bandpass filter envelope. . . . . .',
    signatures: [{
      label: 'bpsustain(sustain)',
      parameters: [
        { label: 'sustain', documentation: 'amplitude of the bandpass filter envelope' }
      ],
    }],
  },
  {
    name: 'lprelease',
    detail: 'Sets the release time for the lowpass filter envelope',
    documentation: 'Sets the release time for the lowpass filter envelope. . . . . . .',
    signatures: [{
      label: 'lprelease(release)',
      parameters: [
        { label: 'release', documentation: 'time of the filter envelope' }
      ],
    }],
  },
  {
    name: 'hprelease',
    detail: 'Sets the release time for the highpass filter envelope',
    documentation: 'Sets the release time for the highpass filter envelope. . . . . . .',
    signatures: [{
      label: 'hprelease(release)',
      parameters: [
        { label: 'release', documentation: 'time of the highpass filter envelope' }
      ],
    }],
  },
  {
    name: 'bprelease',
    detail: 'Sets the release time for the bandpass filter envelope',
    documentation: 'Sets the release time for the bandpass filter envelope. . . . . . .',
    signatures: [{
      label: 'bprelease(release)',
      parameters: [
        { label: 'release', documentation: 'time of the bandpass filter envelope' }
      ],
    }],
  },
  {
    name: 'ftype',
    detail: 'Sets the filter type',
    documentation: 'Sets the filter type. The ladder filter is more aggressive. More types might be added in the future. . . . .',
    signatures: [{
      label: 'ftype(type)',
      parameters: [
        { label: 'type', documentation: '12db (0), ladder (1), or 24db (2)' }
      ],
    }],
  },
  {
    name: 'fanchor',
    detail: 'controls the center of the filter envelope',
    documentation: 'controls the center of the filter envelope. 0 is unipolar positive, .5 is bipolar, 1 is unipolar negative .',
    signatures: [{
      label: 'fanchor(center)',
      parameters: [
        { label: 'center', documentation: '0 to 1' }
      ],
    }],
  },
  {
    name: 'vibmod',
    detail: 'Sets the vibrato depth in semitones',
    documentation: 'Sets the vibrato depth in semitones. Only has an effect if `vibrato` | `vib` | `v` is is also set . ._ // change the vibrato frequency with ":" . ._',
    signatures: [{
      label: 'vibmod(depth)',
      parameters: [
        { label: 'depth', documentation: 'of vibrato (in semitones)' }
      ],
    }],
  },
  {
    name: 'hpq',
    detail: 'Controls the **h**igh-**p**ass **q**-value',
    documentation: 'Controls the **h**igh-**p**ass **q**-value.',
    signatures: [{
      label: 'hpq(q)',
      parameters: [
        { label: 'q', documentation: 'resonance factor between 0 and 50' }
      ],
    }],
  },
  {
    name: 'lpq',
    detail: 'Controls the **l**ow-**p**ass **q**-value',
    documentation: 'Controls the **l**ow-**p**ass **q**-value. / // currently an alias of \'resonance\' https://codeberg.org/uzu/strudel/issues/496 export const { resonance, lpq } =; /** DJ filter, below 0.5 is low pass filter, above is high pass filter.).',
    signatures: [{
      label: 'lpq(q, cutoff)',
      parameters: [
        { label: 'q', documentation: 'resonance factor between 0 and 50' },
        { label: 'cutoff', documentation: 'below 0.5 is low pass filter, above is high pass filter' }
      ],
    }],
  },
  {
    name: 'delayspeed',
    detail: 'Sets the time of the delay effect',
    documentation: 'Sets the time of the delay effect.).',
    signatures: [{
      label: 'delayspeed(delayspeed)',
      parameters: [
        { label: 'delayspeed', documentation: 'controls the pitch of the delay feedback' }
      ],
    }],
  },
  {
    name: 'delaysync',
    detail: 'Sets the time of the delay effect in cycles',
    documentation: 'Sets the time of the delay effect in cycles.)',
    signatures: [{
      label: 'delaysync(cycles)',
      parameters: [
        { label: 'cycles', documentation: 'delay length in cycles' }
      ],
    }],
  },
  {
    name: 'lock',
    detail: 'Specifies whether delaytime is calculated relative to cps',
    documentation: 'Specifies whether delaytime is calculated relative to cps.',
    signatures: [{
      label: 'lock(enable)',
      parameters: [
        { label: 'enable', documentation: 'When set to 1, delaytime is a direct multiple of a cycle.' }
      ],
    }],
  },
  {
    name: 'spread',
    detail: 'Set the stereo pan spread for supported oscillators',
    documentation: 'Set the stereo pan spread for supported oscillators',
    signatures: [{
      label: 'spread(spread)',
      parameters: [
        { label: 'spread', documentation: 'between 0 and 1' }
      ],
    }],
  },
  {
    name: 'dry',
    detail: 'Set dryness of reverb',
    documentation: 'Set dryness of reverb. See `room` and `size` for more information about reverb.").',
    signatures: [{
      label: 'dry(dry)',
      parameters: [
        { label: 'dry', documentation: '0 = wet, 1 = dry' }
      ],
    }],
  },
  {
    name: 'pattack',
    detail: 'Attack time of pitch envelope',
    documentation: 'Attack time of pitch envelope.',
    signatures: [{
      label: 'pattack(time)',
      parameters: [
        { label: 'time', documentation: 'time in seconds' }
      ],
    }],
  },
  {
    name: 'pdecay',
    detail: 'Decay time of pitch envelope',
    documentation: 'Decay time of pitch envelope.',
    signatures: [{
      label: 'pdecay(time)',
      parameters: [
        { label: 'time', documentation: 'time in seconds' }
      ],
    }],
  },
  {
    name: 'prelease',
    detail: 'Release time of pitch envelope ',
    documentation: 'Release time of pitch envelope . // to hear the pitch release .',
    signatures: [{
      label: 'prelease(time)',
      parameters: [
        { label: 'time', documentation: 'time in seconds' }
      ],
    }],
  },
  {
    name: 'penv',
    detail: 'Amount of pitch envelope',
    documentation: 'Amount of pitch envelope. Negative values will flip the envelope. If you don\'t set other pitch envelope controls, `pattack:.2` will be the default. .',
    signatures: [{
      label: 'penv(semitones)',
      parameters: [
        { label: 'semitones', documentation: 'change in semitones' }
      ],
    }],
  },
  {
    name: 'pcurve',
    detail: 'Curve of envelope',
    documentation: 'Curve of envelope. Defaults to linear. exponential is good for kicks . . .',
    signatures: [{
      label: 'pcurve(type)',
      parameters: [
        { label: 'type', documentation: '0 = linear, 1 = exponential' }
      ],
    }],
  },
  {
    name: 'panchor',
    detail: 'Sets the range anchor of the envelope: - anchor 0: range = [',
    documentation: 'Sets the range anchor of the envelope: - anchor 0: range = [note, note + penv] - anchor 1: range = [note - penv, note] If you don\'t set an anchor, the value will default to the psustain value.',
    signatures: [{
      label: 'panchor(anchor)',
      parameters: [
        { label: 'anchor', documentation: 'anchor offset' }
      ],
    }],
  },
  {
    name: 'lrate',
    detail: 'Rate of modulation / rotation for leslie effect / // TODO: t',
    documentation: 'Rate of modulation / rotation for leslie effect / // TODO: the rate seems to "lag" (in the example, 1 will be fast) export const { lrate } =; /** Physical size of the cabinet in meters. Be careful, it might be slightly larger than your computer. Affects the Doppler amount (pitch warble)',
    signatures: [{
      label: 'lrate(rate, meters)',
      parameters: [
        { label: 'rate', documentation: '6.7 for fast, 0.7 for slow' },
        { label: 'meters', documentation: 'somewhere between 0 and 1' }
      ],
    }],
  },
  {
    name: 'label',
    detail: 'Sets the displayed text for an event on the pianoroll',
    documentation: 'Sets the displayed text for an event on the pianoroll',
    signatures: [{
      label: 'label(label)',
      parameters: [
        { label: 'label', documentation: 'text to display' }
      ],
    }],
  },
  {
    name: 'roomlp',
    detail: 'Reverb lowpass starting frequency (in hertz)',
    documentation: 'Reverb lowpass starting frequency (in hertz). When this property is changed, the reverb will be recaculated, so only change this sparsely..',
    signatures: [{
      label: 'roomlp(frequency)',
      parameters: [
        { label: 'frequency', documentation: 'between 0 and 20000hz' }
      ],
    }],
  },
  {
    name: 'roomdim',
    detail: 'Reverb lowpass frequency at -60dB (in hertz)',
    documentation: 'Reverb lowpass frequency at -60dB (in hertz). When this property is changed, the reverb will be recaculated, so only change this sparsely..',
    signatures: [{
      label: 'roomdim(frequency)',
      parameters: [
        { label: 'frequency', documentation: 'between 0 and 20000hz' }
      ],
    }],
  },
  {
    name: 'roomfade',
    detail: 'Reverb fade time (in seconds)',
    documentation: 'Reverb fade time (in seconds). When this property is changed, the reverb will be recaculated, so only change this sparsely..',
    signatures: [{
      label: 'roomfade(seconds)',
      parameters: [
        { label: 'seconds', documentation: 'for the reverb to fade' }
      ],
    }],
  },
  {
    name: 'iresponse',
    detail: 'Sets the sample to use as an impulse response for the reverb',
    documentation: 'Sets the sample to use as an impulse response for the reverb.',
    signatures: [{
      label: 'iresponse(sample)',
      parameters: [
        { label: 'sample', documentation: 'to use as an impulse response' }
      ],
    }],
  },
  {
    name: 'irspeed',
    detail: 'Sets speed of the sample for the impulse response',
    documentation: 'Sets speed of the sample for the impulse response. $:).',
    signatures: [{
      label: 'irspeed(speed)',
      parameters: [
        { label: 'speed', documentation: '* @example' }
      ],
    }],
  },
  {
    name: 'irbegin',
    detail: 'Sets the beginning of the IR response sample $:)',
    documentation: 'Sets the beginning of the IR response sample $:).',
    signatures: [{
      label: 'irbegin(begin)',
      parameters: [
        { label: 'begin', documentation: 'between 0 and 1' }
      ],
    }],
  },
  {
    name: 'roomsize',
    detail: 'Sets the room size of the reverb, see `room`',
    documentation: 'Sets the room size of the reverb, see `room`. When this property is changed, the reverb will be recaculated, so only change this sparsely.. / // TODO: find out why : // // .. does not work. Is it because room is only one effect? export const { roomsize, size, sz, rsize } =; // [\'sagogo\'], // [\'sclap\'], // [\'sclaves\'], // [\'scrash\'], /** (Deprecated) Wave shaping distortion. WARNING: can suddenly get unpredictably loud. Please use distort instead, which has a more predictable response curve second option in optional array syntax (ex: ".9:.5") applies a postgain to the output',
    signatures: [{
      label: 'roomsize(size, distortion)',
      parameters: [
        { label: 'size', documentation: 'between 0 and 10' },
        { label: 'distortion', documentation: 'between 0 and 1' }
      ],
    }],
  },
  {
    name: 'distortvol',
    detail: 'Postgain for waveshaping distortion',
    documentation: 'Postgain for waveshaping distortion.',
    signatures: [{
      label: 'distortvol(volume)',
      parameters: [
        { label: 'volume', documentation: 'linear postgain of the distortion' }
      ],
    }],
  },
  {
    name: 'distorttype',
    detail: 'Type of waveshaping distortion to apply',
    documentation: 'Type of waveshaping distortion to apply. . .) .',
    signatures: [{
      label: 'distorttype(type)',
      parameters: [
        { label: 'type', documentation: 'type of distortion to apply' }
      ],
    }],
  },
  {
    name: 'compressor',
    detail: 'Dynamics Compressor',
    documentation: 'Dynamics Compressor. The params are `` More info [here](https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode?retiredLocale=de#instance_properties) .',
    signatures: [{
      label: 'compressor()',
      parameters: [

      ],
    }],
  },
  {
    name: 'stretch',
    detail: 'Changes the speed of sample playback, i',
    documentation: 'Changes the speed of sample playback, i.e. a cheap way of changing pitch.',
    signatures: [{
      label: 'stretch(factor)',
      parameters: [
        { label: 'factor', documentation: '-inf to inf, negative numbers play the sample backwards.' }
      ],
    }],
  },
  {
    name: 'density',
    detail: 'Noise crackle density)',
    documentation: 'Noise crackle density)',
    signatures: [{
      label: 'density(density)',
      parameters: [
        { label: 'density', documentation: 'between 0 and x' }
      ],
    }],
  },
  {
    name: 'duration',
    detail: 'Sets the duration of the event in cycles',
    documentation: 'Sets the duration of the event in cycles. Similar to clip / legato, it also cuts samples off at the end if they exceed the duration.',
    signatures: [{
      label: 'duration(seconds)',
      parameters: [
        { label: 'seconds', documentation: '>= 0' }
      ],
    }],
  },
  {
    name: 'midicmd',
    detail: 'MIDI command: Sends a MIDI command message',
    documentation: 'MIDI command: Sends a MIDI command message.',
    signatures: [{
      label: 'midicmd(command)',
      parameters: [
        { label: 'command', documentation: 'MIDI command' }
      ],
    }],
  },
  {
    name: 'control',
    detail: 'MIDI control: Sends a MIDI control change message',
    documentation: 'MIDI control: Sends a MIDI control change message.',
    signatures: [{
      label: 'control(MIDI, MIDI)',
      parameters: [
        { label: 'MIDI', documentation: 'control number (0-127)' },
        { label: 'MIDI', documentation: 'controller value (0-127)' }
      ],
    }],
  },
  {
    name: 'nrpnn',
    detail: 'MIDI NRPN non-registered parameter number: Sends a MIDI NRPN',
    documentation: 'MIDI NRPN non-registered parameter number: Sends a MIDI NRPN non-registered parameter number message.',
    signatures: [{
      label: 'nrpnn(nrpnn)',
      parameters: [
        { label: 'nrpnn', documentation: 'MIDI NRPN non-registered parameter number (0-127)' }
      ],
    }],
  },
  {
    name: 'nrpv',
    detail: 'MIDI NRPN non-registered parameter value: Sends a MIDI NRPN ',
    documentation: 'MIDI NRPN non-registered parameter value: Sends a MIDI NRPN non-registered parameter value message.',
    signatures: [{
      label: 'nrpv(nrpv)',
      parameters: [
        { label: 'nrpv', documentation: 'MIDI NRPN non-registered parameter value (0-127)' }
      ],
    }],
  },
  {
    name: 'progNum',
    detail: 'MIDI program number: Sends a MIDI program change message',
    documentation: 'MIDI program number: Sends a MIDI program change message.',
    signatures: [{
      label: 'progNum(program)',
      parameters: [
        { label: 'program', documentation: 'MIDI program number (0-127)' }
      ],
    }],
  },
  {
    name: 'sysex',
    detail: 'MIDI sysex: Sends a MIDI sysex message',
    documentation: 'MIDI sysex: Sends a MIDI sysex message.',
    signatures: [{
      label: 'sysex(id, data)',
      parameters: [
        { label: 'id', documentation: 'Sysex ID' },
        { label: 'data', documentation: 'Sysex data' }
      ],
    }],
  },
  {
    name: 'sysexid',
    detail: 'MIDI sysex ID: Sends a MIDI sysex identifier message',
    documentation: 'MIDI sysex ID: Sends a MIDI sysex identifier message.',
    signatures: [{
      label: 'sysexid(id)',
      parameters: [
        { label: 'id', documentation: 'Sysex ID' }
      ],
    }],
  },
  {
    name: 'sysexdata',
    detail: 'MIDI sysex data: Sends a MIDI sysex message',
    documentation: 'MIDI sysex data: Sends a MIDI sysex message.',
    signatures: [{
      label: 'sysexdata(data)',
      parameters: [
        { label: 'data', documentation: 'Sysex data' }
      ],
    }],
  },
  {
    name: 'midibend',
    detail: 'MIDI pitch bend: Sends a MIDI pitch bend message',
    documentation: 'MIDI pitch bend: Sends a MIDI pitch bend message.).',
    signatures: [{
      label: 'midibend(midibend)',
      parameters: [
        { label: 'midibend', documentation: 'MIDI pitch bend (-1 - 1)' }
      ],
    }],
  },
  {
    name: 'miditouch',
    detail: 'MIDI key after touch: Sends a MIDI key after touch message',
    documentation: 'MIDI key after touch: Sends a MIDI key after touch message.).',
    signatures: [{
      label: 'miditouch(miditouch)',
      parameters: [
        { label: 'miditouch', documentation: 'MIDI key after touch (0-1)' }
      ],
    }],
  },
  {
    name: 'oschost',
    detail: 'The host to send open sound control messages to',
    documentation: 'The host to send open sound control messages to. Requires running the OSC bridge.;',
    signatures: [{
      label: 'oschost(oschost)',
      parameters: [
        { label: 'oschost', documentation: 'e.g. \'localhost\'' }
      ],
    }],
  },
  {
    name: 'oscport',
    detail: 'The port to send open sound control messages to',
    documentation: 'The port to send open sound control messages to. Requires running the OSC bridge.;',
    signatures: [{
      label: 'oscport(oscport)',
      parameters: [
        { label: 'oscport', documentation: 'e.g. 57120' }
      ],
    }],
  },
  {
    name: 'as',
    detail: 'Sets properties in a batch',
    documentation: 'Sets properties in a batch. "c:.5 a:1 f:.25 e:.8". "{0@2 0.25 0 0.5 .3 .5}%8".',
    signatures: [{
      label: 'as(mapping)',
      parameters: [
        { label: 'mapping', documentation: 'the control names that are set' }
      ],
    }],
  },
  {
    name: 'scrub',
    detail: 'Allows you to scrub an audio file like a tape loop by passin',
    documentation: 'Allows you to scrub an audio file like a tape loop by passing values that represents the position in the audio file in the optional array syntax ex: "0.5:2", the second value controls the speed of playback;)',
    signatures: [{
      label: 'scrub()',
      parameters: [

      ],
    }],
  },
  {
    name: 'euclidish',
    detail: 'A \'euclid\' variant with an additional parameter that morphs ',
    documentation: 'A \'euclid\' variant with an additional parameter that morphs the resulting rhythm from 0 (no morphing) to 1 (completely \'even\'). For example `` would be the same as ``, and `` would be the same as ``. `` would have a groove somewhere between. Inspired by the work of Malcom Braff.) .)',
    signatures: [{
      label: 'euclidish(pulses, steps, groove)',
      parameters: [
        { label: 'pulses', documentation: 'the number of onsets' },
        { label: 'steps', documentation: 'the number of steps to fill' },
        { label: 'groove', documentation: 'exists between the extremes of 0 (straight euclidian) and 1 (straight pulse)' }
      ],
    }],
  },
  {
    name: 'round',
    detail: 'Assumes a numerical pattern',
    documentation: 'Assumes a numerical pattern. Returns a new pattern with all values rounded to the nearest integer.).',
    signatures: [{
      label: 'round()',
      parameters: [

      ],
    }],
  },
  {
    name: 'floor',
    detail: 'Assumes a numerical pattern',
    documentation: 'Assumes a numerical pattern. Returns a new pattern with all values set to their mathematical floor. E.g. `3.7` replaced with to `3`, and `-4.2` replaced with `-5`.)',
    signatures: [{
      label: 'floor()',
      parameters: [

      ],
    }],
  },
  {
    name: 'ceil',
    detail: 'Assumes a numerical pattern',
    documentation: 'Assumes a numerical pattern. Returns a new pattern with all values set to their mathematical ceiling. E.g. `3.2` replaced with `4`, and `-4.2` replaced with `-4`.)',
    signatures: [{
      label: 'ceil()',
      parameters: [

      ],
    }],
  },
  {
    name: 'rangex',
    detail: 'Assumes a numerical pattern, containing unipolar values in t',
    documentation: 'Assumes a numerical pattern, containing unipolar values in the range 0 .. 1 Returns a new pattern with values scaled to the given min/max range, following an exponential curve. .)',
    signatures: [{
      label: 'rangex()',
      parameters: [

      ],
    }],
  },
  {
    name: 'range2',
    detail: 'Assumes a numerical pattern, containing bipolar values in th',
    documentation: 'Assumes a numerical pattern, containing bipolar values in the range -1 .. 1 Returns a new pattern with values scaled to the given min/max range. .)',
    signatures: [{
      label: 'range2()',
      parameters: [

      ],
    }],
  },
  {
    name: 'ratio',
    detail: 'Allows dividing numbers via list notation using ":"',
    documentation: 'Allows dividing numbers via list notation using ":". Returns a new pattern with just numbers. .',
    signatures: [{
      label: 'ratio()',
      parameters: [

      ],
    }],
  },
  {
    name: 'invert',
    detail: 'Swaps 1s and 0s in a binary pattern',
    documentation: 'Swaps 1s and 0s in a binary pattern.)',
    signatures: [{
      label: 'invert()',
      parameters: [

      ],
    }],
  },
  {
    name: 'echoWith',
    detail: 'Superimpose and offset multiple times, applying the given fu',
    documentation: 'Superimpose and offset multiple times, applying the given function each time. "<0 [2 4]>" . => p.) .',
    signatures: [{
      label: 'echoWith(times, time, func)',
      parameters: [
        { label: 'times', documentation: 'how many times to repeat' },
        { label: 'time', documentation: 'cycle offset between iterations' },
        { label: 'func', documentation: 'function to apply, given the pattern and the iteration index' }
      ],
    }],
  },
  {
    name: 'plyWith',
    detail: 'The plyWith function repeats each event the given number of ',
    documentation: 'The plyWith function repeats each event the given number of times, applying the given function to each event.\n "<0 [2 4]>" . => p.) .',
    signatures: [{
      label: 'plyWith(factor, func)',
      parameters: [
        { label: 'factor', documentation: 'how many times to repeat' },
        { label: 'func', documentation: 'function to apply, given the pattern' }
      ],
    }],
  },
  {
    name: 'plyForEach',
    detail: 'The plyForEach function repeats each event the given number ',
    documentation: 'The plyForEach function repeats each event the given number of times, applying the given function to each event. This version of ply uses the iteration index as an argument to the function, similar to echoWith. "<0 [2 4]>" . => p.) .',
    signatures: [{
      label: 'plyForEach(factor, func)',
      parameters: [
        { label: 'factor', documentation: 'how many times to repeat' },
        { label: 'func', documentation: 'function to apply, given the pattern and the iteration index' }
      ],
    }],
  },
  {
    name: 'repeatCycles',
    detail: 'Repeats each cycle the given number of times',
    documentation: 'Repeats each cycle the given number of times.).',
    signatures: [{
      label: 'repeatCycles()',
      parameters: [

      ],
    }],
  },
  {
    name: 'fastChunk',
    detail: 'Like `chunk`, but the cycles of the source pattern aren\'t re',
    documentation: 'Like `chunk`, but the cycles of the source pattern aren\'t repeated for each set of chunks. "<0 8> 1 2 3 4 5 6 7" .). .',
    signatures: [{
      label: 'fastChunk()',
      parameters: [

      ],
    }],
  },
  {
    name: 'chunkInto',
    detail: 'Like `chunk`, but the function is applied to a looped subcyc',
    documentation: 'Like `chunk`, but the function is applied to a looped subcycle of the source pattern.) .',
    signatures: [{
      label: 'chunkInto()',
      parameters: [

      ],
    }],
  },
  {
    name: 'chunkBackInto',
    detail: 'Like `chunkInto`, but moves backwards through the chunks',
    documentation: 'Like `chunkInto`, but moves backwards through the chunks.) .',
    signatures: [{
      label: 'chunkBackInto()',
      parameters: [

      ],
    }],
  },
  {
    name: 'ribbon',
    detail: 'Loops the pattern inside an `offset` for `cycles`',
    documentation: 'Loops the pattern inside an `offset` for `cycles`. If you think of the entire span of time in cycles as a ribbon, you can cut a single piece and loop it. // Looping a portion of randomness). // rhythm generator',
    signatures: [{
      label: 'ribbon(offset, cycles)',
      parameters: [
        { label: 'offset', documentation: 'start point of loop in cycles' },
        { label: 'cycles', documentation: 'loop length in cycles' }
      ],
    }],
  },
  {
    name: 'tag',
    detail: 'Tags each Hap with an identifier',
    documentation: 'Tags each Hap with an identifier. Good for filtering. The function populates Hap.context.tags (Array). / Pattern.prototype.tag = function (tag) { return this. => ({ ...ctx, tags: (ctx.tags || []). })); }; /** Filters haps using the given function',
    signatures: [{
      label: 'tag(tag, test)',
      parameters: [
        { label: 'tag', documentation: 'anything unique' },
        { label: 'test', documentation: 'function to test Hap' }
      ],
    }],
  },
  {
    name: 'filterWhen',
    detail: 'Filters haps by their begin time',
    documentation: 'Filters haps by their begin time',
    signatures: [{
      label: 'filterWhen(test)',
      parameters: [
        { label: 'test', documentation: 'function to test Hap.whole.begin' }
      ],
    }],
  },
  {
    name: 'stepcat',
    detail: '\'Concatenates\' patterns like `fastcat`, but proportional to ',
    documentation: '\'Concatenates\' patterns like `fastcat`, but proportional to a number of steps per cycle. The steps can either be inferred from the pattern, or provided as a [length, pattern] pair. Has the alias `timecat`. // the same as "e3@3 g3". // the same as "bd sd cp hh hh".',
    signatures: [{
      label: 'stepcat()',
      parameters: [

      ],
    }],
  },
  {
    name: 'onTriggerTime',
    detail: 'make something happen on event time uses browser timeout whi',
    documentation: 'make something happen on event time uses browser timeout which is innacurate for audio tasks => {console.}) / Pattern.prototype.onTriggerTime = function (func) { return this. => { const diff = targetTime - currentTime; window. => {; }, diff * 1000); }, false); }; /** Works the same as slice, but changes the playback speed of each slice to match the duration of its step. .',
    signatures: [{
      label: 'onTriggerTime()',
      parameters: [

      ],
    }],
  },
  {
    name: 'loopAtCps',
    detail: 'Makes the sample fit the given number of cycles and cps valu',
    documentation: 'Makes the sample fit the given number of cycles and cps value, by changing the speed. Please note that at some point cps will be given by a global clock and this function will be deprecated/removed. / // TODO - global cps clock export const { loopAtCps, loopatcps } = { return _; }); /** exposes a custom value at query time. basically allows mutating state without evaluation',
    signatures: [{
      label: 'loopAtCps()',
      parameters: [

      ],
    }],
  },
  {
    name: 'xfade',
    detail: 'Cross-fades between left and right from 0 to 1: - 0 = (full ',
    documentation: 'Cross-fades between left and right from 0 to 1: - 0 = (full left, no right) - .5 = (both equal) - 1 = (no left, full right), "<0 .25 .5 .75 1>",)',
    signatures: [{
      label: 'xfade()',
      parameters: [

      ],
    }],
  },
  {
    name: 'beat',
    detail: 'creates a structure pattern from divisions of a cycle especi',
    documentation: 'creates a structure pattern from divisions of a cycle especially useful for creating rhythms / const __beat = (join) => (t, div, pat) => { t =; div =; const b = t.; const e = t.; return =>._)); }; export const { beat } = => x.), ); export const _morph = (from, to, by) => { by =; const dur =; const positions = (list) => { const result = []; for (const [pos, value] of list.) { if (value) { result., value]); } } return result; }; const arcs = => { const b = by.; const e = b.; return new; },,, ); function { const cycle = state.span.begin.; const cycleArc = state.span.; const result = []; for (const whole of arcs) { const part = whole.; if (part !== undefined) { result. => x.), part. => x.), true, ), ); } } return result; } return new; }; /** Takes two binary rhythms represented as lists of 1s and 0s, and a number between 0 and 1 that morphs between them. The two lists should contain the same number of true values. ) // slowly morph between the rhythms ) )',
    signatures: [{
      label: 'beat()',
      parameters: [

      ],
    }],
  },
  {
    name: 'inhabitmod',
    detail: 'The same as `inhabit`, but if you pick a number greater than',
    documentation: 'The same as `inhabit`, but if you pick a number greater than the size of the list, it wraps around, rather than sticking at the maximum value. For example, if you pick the fifth pattern of a list of three, you\'ll get the second one.',
    signatures: [{
      label: 'inhabitmod(pat)',
      parameters: [
        { label: 'pat', documentation: '* @param {*} xs' }
      ],
    }],
  },
  {
    name: 'mousex',
    detail: 'The mouse\'s x position value ranges from 0 to 1',
    documentation: 'The mouse\'s x position value ranges from 0 to 1.). / /** The mouse\'s y position value ranges from 0 to 1.). / let _mouseY = 0, _mouseX = 0; if (typeof window !== \'undefined\') { //document.onmousemove = (e) => { document. => { _mouseY = e.clientY / document.body.clientHeight; _mouseX = e.clientX / document.body.clientWidth; }); } export const mousey = => _mouseY); export const mouseY = => _mouseY); export const mousex = => _mouseX); export const mouseX = => _mouseX); // random signals const xorwise = (x) => { const a = (x << 13) ^ x; const b = (a >> 17) ^ a; return (b << 5) ^ b; }; // stretch 300 cycles over the range of [0,2**29 == 536870912) then apply the xorshift algorithm const _frac = (x) => x - Math.; const timeToIntSeed = (x) => * 536870912)); const intSeedToRand = (x) => (x % 536870912) / 536870912; const timeToRand = (x) => Math.)); const timeToRandsPrime = (seed, n) => { const result = []; // eslint-disable-next-line for (let i = 0; i < n; ++i) { result.); seed =; } return result; }; const timeToRands = (t, n) =>, n); /** / /** A discrete pattern of numbers from 0 to n-1). //',
    signatures: [{
      label: 'mousex()',
      parameters: [

      ],
    }],
  },
  {
    name: 'brandBy',
    detail: 'A continuous pattern of 0 or 1 (binary random), with a proba',
    documentation: 'A continuous pattern of 0 or 1 (binary random), with a probability for the value being 1)',
    signatures: [{
      label: 'brandBy(probability)',
      parameters: [
        { label: 'probability', documentation: '- a number between 0 and 1' }
      ],
    }],
  },
  {
    name: 'berlin',
    detail: 'Generates a continuous pattern of [berlin noise](conceived b',
    documentation: 'Generates a continuous pattern of [berlin noise](conceived by Jame Coyne and Jade Rowland as a joke but turned out to be surprisingly cool and useful, like perlin noise but with sawtooth waves), in the range 0..1. // ascending arpeggios)).',
    signatures: [{
      label: 'berlin()',
      parameters: [

      ],
    }],
  },
  {
    name: 'undegrade',
    detail: 'Inverse of `degrade`: Randomly removes 50% of events from th',
    documentation: 'Inverse of `degrade`: Randomly removes 50% of events from the pattern. Shorthand for `.` Events that would be removed by degrade are let through by undegrade and vice versa (see second example)., x => x. )',
    signatures: [{
      label: 'undegrade()',
      parameters: [

      ],
    }],
  },
  {
    name: 'whenKey',
    detail: 'Do something on a keypress, or array of keypresses [Key name',
    documentation: 'Do something on a keypress, or array of keypresses [Key name reference](https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_key_values)").).)',
    signatures: [{
      label: 'whenKey()',
      parameters: [

      ],
    }],
  },
  {
    name: 'keyDown',
    detail: 'returns true when a key or array of keys is held [Key name r',
    documentation: 'returns true when a key or array of keys is held [Key name reference](https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_key_values)"),")])',
    signatures: [{
      label: 'keyDown()',
      parameters: [

      ],
    }],
  },
  {
    name: 'addVoicings',
    detail: 'Adds a new custom voicing dictionary',
    documentation: 'Adds a new custom voicing dictionary. "<C^7 A7 Dm7 G7>".',
    signatures: [{
      label: 'addVoicings(name, dictionary, range)',
      parameters: [
        { label: 'name', documentation: 'identifier for the voicing dictionary' },
        { label: 'dictionary', documentation: 'maps chord symbol to possible voicings' },
        { label: 'range', documentation: 'min, max note' }
      ],
    }],
  },

  // === ALIASES (lowercase versions) ===
  {
    name: 'chunkbackinto',
    detail: 'Alias for chunkBackInto',
    documentation: 'Lowercase alias for chunkBackInto. See chunkBackInto for full documentation.',
    signatures: [{
      label: 'chunkbackinto(...)',
      parameters: [],
    }],
  },
  {
    name: 'chunkinto',
    detail: 'Alias for chunkInto',
    documentation: 'Lowercase alias for chunkInto. See chunkInto for full documentation.',
    signatures: [{
      label: 'chunkinto(...)',
      parameters: [],
    }],
  },
  {
    name: 'echowith',
    detail: 'Alias for echoWith',
    documentation: 'Lowercase alias for echoWith. See echoWith for full documentation.',
    signatures: [{
      label: 'echowith(...)',
      parameters: [],
    }],
  },
  {
    name: 'fastchunk',
    detail: 'Alias for fastChunk',
    documentation: 'Lowercase alias for fastChunk. See fastChunk for full documentation.',
    signatures: [{
      label: 'fastchunk(...)',
      parameters: [],
    }],
  },
  {
    name: 'fastgap',
    detail: 'Alias for fastGap',
    documentation: 'Lowercase alias for fastGap. See fastGap for full documentation.',
    signatures: [{
      label: 'fastgap(...)',
      parameters: [],
    }],
  },
  {
    name: 'iterback',
    detail: 'Alias for iterBack',
    documentation: 'Lowercase alias for iterBack. See iterBack for full documentation.',
    signatures: [{
      label: 'iterback(...)',
      parameters: [],
    }],
  },
  {
    name: 'juxby',
    detail: 'Alias for juxBy',
    documentation: 'Lowercase alias for juxBy. See juxBy for full documentation.',
    signatures: [{
      label: 'juxby(...)',
      parameters: [],
    }],
  },
  {
    name: 'loopat',
    detail: 'Alias for loopAt',
    documentation: 'Lowercase alias for loopAt. See loopAt for full documentation.',
    signatures: [{
      label: 'loopat(...)',
      parameters: [],
    }],
  },
  {
    name: 'loopatcps',
    detail: 'Alias for loopAtCps',
    documentation: 'Lowercase alias for loopAtCps. See loopAtCps for full documentation.',
    signatures: [{
      label: 'loopatcps(...)',
      parameters: [],
    }],
  },

  // === SHORT PARAMETER NAMES ===
  {
    name: 'and',
    detail: 'Bitwise AND',
    documentation: 'Shorthand for bitwise AND.',
    signatures: [{
      label: 'and(value)',
      parameters: [{ label: 'value', documentation: 'Bitwise AND value' }],
    }],
  },
  {
    name: 'att',
    detail: 'Attack',
    documentation: 'Shorthand for attack.',
    signatures: [{
      label: 'att(value)',
      parameters: [{ label: 'value', documentation: 'Attack value' }],
    }],
  },
  {
    name: 'bor',
    detail: 'Bitwise OR',
    documentation: 'Shorthand for bitwise OR.',
    signatures: [{
      label: 'bor(value)',
      parameters: [{ label: 'value', documentation: 'Bitwise OR value' }],
    }],
  },
  {
    name: 'bp',
    detail: 'Bandpass filter',
    documentation: 'Shorthand for bandpass filter.',
    signatures: [{
      label: 'bp(value)',
      parameters: [{ label: 'value', documentation: 'Bandpass filter value' }],
    }],
  },
  {
    name: 'bpa',
    detail: 'Bandpass attack',
    documentation: 'Shorthand for bandpass attack.',
    signatures: [{
      label: 'bpa(value)',
      parameters: [{ label: 'value', documentation: 'Bandpass attack value' }],
    }],
  },
  {
    name: 'bpd',
    detail: 'Bandpass decay',
    documentation: 'Shorthand for bandpass decay.',
    signatures: [{
      label: 'bpd(value)',
      parameters: [{ label: 'value', documentation: 'Bandpass decay value' }],
    }],
  },
  {
    name: 'bpe',
    detail: 'Bandpass env',
    documentation: 'Shorthand for bandpass env.',
    signatures: [{
      label: 'bpe(value)',
      parameters: [{ label: 'value', documentation: 'Bandpass env value' }],
    }],
  },
  {
    name: 'bpr',
    detail: 'Bandpass release',
    documentation: 'Shorthand for bandpass release.',
    signatures: [{
      label: 'bpr(value)',
      parameters: [{ label: 'value', documentation: 'Bandpass release value' }],
    }],
  },
  {
    name: 'bps',
    detail: 'Bandpass sustain',
    documentation: 'Shorthand for bandpass sustain.',
    signatures: [{
      label: 'bps(value)',
      parameters: [{ label: 'value', documentation: 'Bandpass sustain value' }],
    }],
  },
  {
    name: 'ch',
    detail: 'Channel',
    documentation: 'Shorthand for channel.',
    signatures: [{
      label: 'ch(value)',
      parameters: [{ label: 'value', documentation: 'Channel value' }],
    }],
  },
  {
    name: 'ctf',
    detail: 'Cutoff frequency',
    documentation: 'Shorthand for cutoff frequency.',
    signatures: [{
      label: 'ctf(value)',
      parameters: [{ label: 'value', documentation: 'Cutoff frequency value' }],
    }],
  },
  {
    name: 'dec',
    detail: 'Decay',
    documentation: 'Shorthand for decay.',
    signatures: [{
      label: 'dec(value)',
      parameters: [{ label: 'value', documentation: 'Decay value' }],
    }],
  },
  {
    name: 'det',
    detail: 'Detune',
    documentation: 'Shorthand for detune.',
    signatures: [{
      label: 'det(value)',
      parameters: [{ label: 'value', documentation: 'Detune value' }],
    }],
  },
  {
    name: 'dfb',
    detail: 'Delay feedback',
    documentation: 'Shorthand for delay feedback.',
    signatures: [{
      label: 'dfb(value)',
      parameters: [{ label: 'value', documentation: 'Delay feedback value' }],
    }],
  },
  {
    name: 'djf',
    detail: 'DJ filter',
    documentation: 'Shorthand for DJ filter.',
    signatures: [{
      label: 'djf(value)',
      parameters: [{ label: 'value', documentation: 'DJ filter value' }],
    }],
  },
  {
    name: 'ds',
    detail: 'Delay send',
    documentation: 'Shorthand for delay send.',
    signatures: [{
      label: 'ds(value)',
      parameters: [{ label: 'value', documentation: 'Delay send value' }],
    }],
  },
  {
    name: 'dt',
    detail: 'Delay time',
    documentation: 'Shorthand for delay time.',
    signatures: [{
      label: 'dt(value)',
      parameters: [{ label: 'value', documentation: 'Delay time value' }],
    }],
  },
  {
    name: 'e',
    detail: 'Euclidean pattern',
    documentation: 'Shorthand for euclidean pattern.',
    signatures: [{
      label: 'e(value)',
      parameters: [{ label: 'value', documentation: 'Euclidean pattern value' }],
    }],
  },
  {
    name: 'eq',
    detail: 'Equalizer',
    documentation: 'Shorthand for equalizer.',
    signatures: [{
      label: 'eq(value)',
      parameters: [{ label: 'value', documentation: 'Equalizer value' }],
    }],
  },
  {
    name: 'eqt',
    detail: 'EQ type',
    documentation: 'Shorthand for EQ type.',
    signatures: [{
      label: 'eqt(value)',
      parameters: [{ label: 'value', documentation: 'EQ type value' }],
    }],
  },
  {
    name: 'fft',
    detail: 'FFT analysis',
    documentation: 'Shorthand for FFT analysis.',
    signatures: [{
      label: 'fft(value)',
      parameters: [{ label: 'value', documentation: 'FFT analysis value' }],
    }],
  },
  {
    name: 'gap',
    detail: 'Gap/rest',
    documentation: 'Shorthand for gap/rest.',
    signatures: [{
      label: 'gap(value)',
      parameters: [{ label: 'value', documentation: 'Gap/rest value' }],
    }],
  },
  {
    name: 'gat',
    detail: 'Gate',
    documentation: 'Shorthand for gate.',
    signatures: [{
      label: 'gat(value)',
      parameters: [{ label: 'value', documentation: 'Gate value' }],
    }],
  },
  {
    name: 'gt',
    detail: 'Greater than',
    documentation: 'Shorthand for greater than.',
    signatures: [{
      label: 'gt(value)',
      parameters: [{ label: 'value', documentation: 'Greater than value' }],
    }],
  },
  {
    name: 'gte',
    detail: 'Greater than or equal',
    documentation: 'Shorthand for greater than or equal.',
    signatures: [{
      label: 'gte(value)',
      parameters: [{ label: 'value', documentation: 'Greater than or equal value' }],
    }],
  },
  {
    name: 'h',
    detail: 'Harmonic',
    documentation: 'Shorthand for harmonic.',
    signatures: [{
      label: 'h(value)',
      parameters: [{ label: 'value', documentation: 'Harmonic value' }],
    }],
  },
  {
    name: 'hp',
    detail: 'Highpass filter',
    documentation: 'Shorthand for highpass filter.',
    signatures: [{
      label: 'hp(value)',
      parameters: [{ label: 'value', documentation: 'Highpass filter value' }],
    }],
  },
  {
    name: 'hpa',
    detail: 'Highpass attack',
    documentation: 'Shorthand for highpass attack.',
    signatures: [{
      label: 'hpa(value)',
      parameters: [{ label: 'value', documentation: 'Highpass attack value' }],
    }],
  },
  {
    name: 'hpd',
    detail: 'Highpass decay',
    documentation: 'Shorthand for highpass decay.',
    signatures: [{
      label: 'hpd(value)',
      parameters: [{ label: 'value', documentation: 'Highpass decay value' }],
    }],
  },
  {
    name: 'hpe',
    detail: 'Highpass env',
    documentation: 'Shorthand for highpass env.',
    signatures: [{
      label: 'hpe(value)',
      parameters: [{ label: 'value', documentation: 'Highpass env value' }],
    }],
  },
  {
    name: 'hpr',
    detail: 'Highpass release',
    documentation: 'Shorthand for highpass release.',
    signatures: [{
      label: 'hpr(value)',
      parameters: [{ label: 'value', documentation: 'Highpass release value' }],
    }],
  },
  {
    name: 'hps',
    detail: 'Highpass sustain',
    documentation: 'Shorthand for highpass sustain.',
    signatures: [{
      label: 'hps(value)',
      parameters: [{ label: 'value', documentation: 'Highpass sustain value' }],
    }],
  },
  {
    name: 'hsl',
    detail: 'HSL color',
    documentation: 'Shorthand for HSL color.',
    signatures: [{
      label: 'hsl(value)',
      parameters: [{ label: 'value', documentation: 'HSL color value' }],
    }],
  },
  {
    name: 'id',
    detail: 'Identity',
    documentation: 'Shorthand for identity.',
    signatures: [{
      label: 'id(value)',
      parameters: [{ label: 'value', documentation: 'Identity value' }],
    }],
  },
  {
    name: 'inv',
    detail: 'Invert',
    documentation: 'Shorthand for invert.',
    signatures: [{
      label: 'inv(value)',
      parameters: [{ label: 'value', documentation: 'Invert value' }],
    }],
  },
  {
    name: 'ir',
    detail: 'Impulse response',
    documentation: 'Shorthand for impulse response.',
    signatures: [{
      label: 'ir(value)',
      parameters: [{ label: 'value', documentation: 'Impulse response value' }],
    }],
  },
  {
    name: 'lfo',
    detail: 'Low frequency oscillator',
    documentation: 'Shorthand for low frequency oscillator.',
    signatures: [{
      label: 'lfo(value)',
      parameters: [{ label: 'value', documentation: 'Low frequency oscillator value' }],
    }],
  },
  {
    name: 'lp',
    detail: 'Lowpass filter',
    documentation: 'Shorthand for lowpass filter.',
    signatures: [{
      label: 'lp(value)',
      parameters: [{ label: 'value', documentation: 'Lowpass filter value' }],
    }],
  },
  {
    name: 'lpa',
    detail: 'Lowpass attack',
    documentation: 'Shorthand for lowpass attack.',
    signatures: [{
      label: 'lpa(value)',
      parameters: [{ label: 'value', documentation: 'Lowpass attack value' }],
    }],
  },
  {
    name: 'lpd',
    detail: 'Lowpass decay',
    documentation: 'Shorthand for lowpass decay.',
    signatures: [{
      label: 'lpd(value)',
      parameters: [{ label: 'value', documentation: 'Lowpass decay value' }],
    }],
  },
  {
    name: 'lpe',
    detail: 'Lowpass env',
    documentation: 'Shorthand for lowpass env.',
    signatures: [{
      label: 'lpe(value)',
      parameters: [{ label: 'value', documentation: 'Lowpass env value' }],
    }],
  },
  {
    name: 'lpr',
    detail: 'Lowpass release',
    documentation: 'Shorthand for lowpass release.',
    signatures: [{
      label: 'lpr(value)',
      parameters: [{ label: 'value', documentation: 'Lowpass release value' }],
    }],
  },
  {
    name: 'lps',
    detail: 'Lowpass sustain',
    documentation: 'Shorthand for lowpass sustain.',
    signatures: [{
      label: 'lps(value)',
      parameters: [{ label: 'value', documentation: 'Lowpass sustain value' }],
    }],
  },
  {
    name: 'lt',
    detail: 'Less than',
    documentation: 'Shorthand for less than.',
    signatures: [{
      label: 'lt(value)',
      parameters: [{ label: 'value', documentation: 'Less than value' }],
    }],
  },
  {
    name: 'lte',
    detail: 'Less than or equal',
    documentation: 'Shorthand for less than or equal.',
    signatures: [{
      label: 'lte(value)',
      parameters: [{ label: 'value', documentation: 'Less than or equal value' }],
    }],
  },
  {
    name: 'm',
    detail: 'Mode/midi',
    documentation: 'Shorthand for mode/midi.',
    signatures: [{
      label: 'm(value)',
      parameters: [{ label: 'value', documentation: 'Mode/midi value' }],
    }],
  },
  {
    name: 'mod',
    detail: 'Modulation',
    documentation: 'Shorthand for modulation.',
    signatures: [{
      label: 'mod(value)',
      parameters: [{ label: 'value', documentation: 'Modulation value' }],
    }],
  },
  {
    name: 'ne',
    detail: 'Not equal',
    documentation: 'Shorthand for not equal.',
    signatures: [{
      label: 'ne(value)',
      parameters: [{ label: 'value', documentation: 'Not equal value' }],
    }],
  },
  {
    name: 'net',
    detail: 'Network',
    documentation: 'Shorthand for network.',
    signatures: [{
      label: 'net(value)',
      parameters: [{ label: 'value', documentation: 'Network value' }],
    }],
  },
  {
    name: 'or',
    detail: 'Bitwise OR',
    documentation: 'Shorthand for bitwise OR.',
    signatures: [{
      label: 'or(value)',
      parameters: [{ label: 'value', documentation: 'Bitwise OR value' }],
    }],
  },
  {
    name: 'ph',
    detail: 'Phase',
    documentation: 'Shorthand for phase.',
    signatures: [{
      label: 'ph(value)',
      parameters: [{ label: 'value', documentation: 'Phase value' }],
    }],
  },
  {
    name: 'phc',
    detail: 'Phaser center',
    documentation: 'Shorthand for phaser center.',
    signatures: [{
      label: 'phc(value)',
      parameters: [{ label: 'value', documentation: 'Phaser center value' }],
    }],
  },
  {
    name: 'phd',
    detail: 'Phaser depth',
    documentation: 'Shorthand for phaser depth.',
    signatures: [{
      label: 'phd(value)',
      parameters: [{ label: 'value', documentation: 'Phaser depth value' }],
    }],
  },
  {
    name: 'phs',
    detail: 'Phaser sweep',
    documentation: 'Shorthand for phaser sweep.',
    signatures: [{
      label: 'phs(value)',
      parameters: [{ label: 'value', documentation: 'Phaser sweep value' }],
    }],
  },
  {
    name: 'pm',
    detail: 'Phase modulation',
    documentation: 'Shorthand for phase modulation.',
    signatures: [{
      label: 'pm(value)',
      parameters: [{ label: 'value', documentation: 'Phase modulation value' }],
    }],
  },
  {
    name: 'pow',
    detail: 'Power',
    documentation: 'Shorthand for power.',
    signatures: [{
      label: 'pow(value)',
      parameters: [{ label: 'value', documentation: 'Power value' }],
    }],
  },
  {
    name: 'pr',
    detail: 'Pattern reference',
    documentation: 'Shorthand for pattern reference.',
    signatures: [{
      label: 'pr(value)',
      parameters: [{ label: 'value', documentation: 'Pattern reference value' }],
    }],
  },
  {
    name: 'ref',
    detail: 'Reference',
    documentation: 'Shorthand for reference.',
    signatures: [{
      label: 'ref(value)',
      parameters: [{ label: 'value', documentation: 'Reference value' }],
    }],
  },
  {
    name: 'rel',
    detail: 'Release',
    documentation: 'Shorthand for release.',
    signatures: [{
      label: 'rel(value)',
      parameters: [{ label: 'value', documentation: 'Release value' }],
    }],
  },
  {
    name: 'rib',
    detail: 'Ribbon controller',
    documentation: 'Shorthand for ribbon controller.',
    signatures: [{
      label: 'rib(value)',
      parameters: [{ label: 'value', documentation: 'Ribbon controller value' }],
    }],
  },
  {
    name: 'rlp',
    detail: 'Resonant lowpass',
    documentation: 'Shorthand for resonant lowpass.',
    signatures: [{
      label: 'rlp(value)',
      parameters: [{ label: 'value', documentation: 'Resonant lowpass value' }],
    }],
  },
  {
    name: 'seg',
    detail: 'Segment',
    documentation: 'Shorthand for segment.',
    signatures: [{
      label: 'seg(value)',
      parameters: [{ label: 'value', documentation: 'Segment value' }],
    }],
  },
  {
    name: 'src',
    detail: 'Source',
    documentation: 'Shorthand for source.',
    signatures: [{
      label: 'src(value)',
      parameters: [{ label: 'value', documentation: 'Source value' }],
    }],
  },
  {
    name: 'sus',
    detail: 'Sustain',
    documentation: 'Shorthand for sustain.',
    signatures: [{
      label: 'sus(value)',
      parameters: [{ label: 'value', documentation: 'Sustain value' }],
    }],
  },
  {
    name: 'sz',
    detail: 'Size',
    documentation: 'Shorthand for size.',
    signatures: [{
      label: 'sz(value)',
      parameters: [{ label: 'value', documentation: 'Size value' }],
    }],
  },
  {
    name: 'uid',
    detail: 'Unique id',
    documentation: 'Shorthand for unique id.',
    signatures: [{
      label: 'uid(value)',
      parameters: [{ label: 'value', documentation: 'Unique id value' }],
    }],
  },
  {
    name: 'v',
    detail: 'Velocity/value',
    documentation: 'Shorthand for velocity/value.',
    signatures: [{
      label: 'v(value)',
      parameters: [{ label: 'value', documentation: 'Velocity/value value' }],
    }],
  },
  {
    name: 'val',
    detail: 'Value',
    documentation: 'Shorthand for value.',
    signatures: [{
      label: 'val(value)',
      parameters: [{ label: 'value', documentation: 'Value value' }],
    }],
  },
  {
    name: 'zip',
    detail: 'Zip patterns together',
    documentation: 'Shorthand for zip patterns together.',
    signatures: [{
      label: 'zip(value)',
      parameters: [{ label: 'value', documentation: 'Zip patterns together value' }],
    }],
  },

  // === EFFECTS ===
  {
    name: 'compose',
    detail: 'Compose functions together',
    documentation: 'Compose functions together.',
    signatures: [{
      label: 'compose(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'compressSpan',
    detail: 'Compress time span',
    documentation: 'Compress time span.',
    signatures: [{
      label: 'compressSpan(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'compressorAttack',
    detail: 'Compressor attack time',
    documentation: 'Compressor attack time.',
    signatures: [{
      label: 'compressorAttack(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'compressorKnee',
    detail: 'Compressor knee',
    documentation: 'Compressor knee.',
    signatures: [{
      label: 'compressorKnee(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'compressorRatio',
    detail: 'Compressor ratio',
    documentation: 'Compressor ratio.',
    signatures: [{
      label: 'compressorRatio(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'compressorRelease',
    detail: 'Compressor release time',
    documentation: 'Compressor release time.',
    signatures: [{
      label: 'compressorRelease(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'compressspan',
    detail: 'Compress time span',
    documentation: 'Compress time span.',
    signatures: [{
      label: 'compressspan(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'delayfb',
    detail: 'Delay feedback',
    documentation: 'Delay feedback.',
    signatures: [{
      label: 'delayfb(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'delayt',
    detail: 'Delay time',
    documentation: 'Delay time.',
    signatures: [{
      label: 'delayt(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'dist',
    detail: 'Distortion effect',
    documentation: 'Distortion effect.',
    signatures: [{
      label: 'dist(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'duck',
    detail: 'Ducking/sidechain compression',
    documentation: 'Ducking/sidechain compression.',
    signatures: [{
      label: 'duck(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'freeze',
    detail: 'Freeze/granular freeze effect',
    documentation: 'Freeze/granular freeze effect.',
    signatures: [{
      label: 'freeze(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'fshift',
    detail: 'Frequency shift',
    documentation: 'Frequency shift.',
    signatures: [{
      label: 'fshift(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'fshiftnote',
    detail: 'Frequency shift by note',
    documentation: 'Frequency shift by note.',
    signatures: [{
      label: 'fshiftnote(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'fshiftphase',
    detail: 'Frequency shift phase',
    documentation: 'Frequency shift phase.',
    signatures: [{
      label: 'fshiftphase(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'morph',
    detail: 'Morph between patterns',
    documentation: 'Morph between patterns.',
    signatures: [{
      label: 'morph(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'phaserrate',
    detail: 'Phaser rate',
    documentation: 'Phaser rate.',
    signatures: [{
      label: 'phaserrate(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'ring',
    detail: 'Ring modulation',
    documentation: 'Ring modulation.',
    signatures: [{
      label: 'ring(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'ringdf',
    detail: 'Ring modulator dry/wet',
    documentation: 'Ring modulator dry/wet.',
    signatures: [{
      label: 'ringdf(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'ringf',
    detail: 'Ring modulator frequency',
    documentation: 'Ring modulator frequency.',
    signatures: [{
      label: 'ringf(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },

  // === OTHER STRUDEL FUNCTIONS (minimal documentation) ===
  {
    name: 'activeLabel',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'activeLabel(...)',
      parameters: [],
    }],
  },
  {
    name: 'analyze',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'analyze(...)',
      parameters: [],
    }],
  },
  {
    name: 'applyN',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'applyN(...)',
      parameters: [],
    }],
  },
  {
    name: 'arpWith',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'arpWith(...)',
      parameters: [],
    }],
  },
  {
    name: 'backgroundImage',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'backgroundImage(...)',
      parameters: [],
    }],
  },
  {
    name: 'band',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'band(...)',
      parameters: [],
    }],
  },
  {
    name: 'bandf',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'bandf(...)',
      parameters: [],
    }],
  },
  {
    name: 'bandq',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'bandq(...)',
      parameters: [],
    }],
  },
  {
    name: 'base64ToUnicode',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'base64ToUnicode(...)',
      parameters: [],
    }],
  },
  {
    name: 'bbexpr',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'bbexpr(...)',
      parameters: [],
    }],
  },
  {
    name: 'bbst',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'bbst(...)',
      parameters: [],
    }],
  },
  {
    name: 'berlinWith',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'berlinWith(...)',
      parameters: [],
    }],
  },
  {
    name: 'bind',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'bind(...)',
      parameters: [],
    }],
  },
  {
    name: 'binshift',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'binshift(...)',
      parameters: [],
    }],
  },
  {
    name: 'bjork',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'bjork(...)',
      parameters: [],
    }],
  },
  {
    name: 'blshift',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'blshift(...)',
      parameters: [],
    }],
  },
  {
    name: 'brak',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'brak(...)',
      parameters: [],
    }],
  },
  {
    name: 'brshift',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'brshift(...)',
      parameters: [],
    }],
  },
  {
    name: 'bxor',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'bxor(...)',
      parameters: [],
    }],
  },
  {
    name: 'bypass',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'bypass(...)',
      parameters: [],
    }],
  },
  {
    name: 'calculateSteps',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'calculateSteps(...)',
      parameters: [],
    }],
  },
  {
    name: 'channel',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'channel(...)',
      parameters: [],
    }],
  },
  {
    name: 'chooseIn',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'chooseIn(...)',
      parameters: [],
    }],
  },
  {
    name: 'chooseInWith',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'chooseInWith(...)',
      parameters: [],
    }],
  },
  {
    name: 'chooseOut',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'chooseOut(...)',
      parameters: [],
    }],
  },
  {
    name: 'chooseWith',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'chooseWith(...)',
      parameters: [],
    }],
  },
  {
    name: 'chunkBack',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'chunkBack(...)',
      parameters: [],
    }],
  },
  {
    name: 'chunkback',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'chunkback(...)',
      parameters: [],
    }],
  },
  {
    name: 'clamp',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'clamp(...)',
      parameters: [],
    }],
  },
  {
    name: 'code2hash',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'code2hash(...)',
      parameters: [],
    }],
  },
  {
    name: 'comb',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'comb(...)',
      parameters: [],
    }],
  },
  {
    name: 'constant',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'constant(...)',
      parameters: [],
    }],
  },
  {
    name: 'contract',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'contract(...)',
      parameters: [],
    }],
  },
  {
    name: 'ctlNum',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'ctlNum(...)',
      parameters: [],
    }],
  },
  {
    name: 'ctranspose',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'ctranspose(...)',
      parameters: [],
    }],
  },
  {
    name: 'curve',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'curve(...)',
      parameters: [],
    }],
  },
  {
    name: 'cutoff',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'cutoff(...)',
      parameters: [],
    }],
  },
  {
    name: 'cycleToSeconds',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'cycleToSeconds(...)',
      parameters: [],
    }],
  },
  {
    name: 'degradeByWith',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'degradeByWith(...)',
      parameters: [],
    }],
  },
  {
    name: 'degree',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'degree(...)',
      parameters: [],
    }],
  },
  {
    name: 'deltaSlide',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'deltaSlide(...)',
      parameters: [],
    }],
  },
  {
    name: 'dict',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'dict(...)',
      parameters: [],
    }],
  },
  {
    name: 'dictionary',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'dictionary(...)',
      parameters: [],
    }],
  },
  {
    name: 'drawLine',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'drawLine(...)',
      parameters: [],
    }],
  },
  {
    name: 'drop',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'drop(...)',
      parameters: [],
    }],
  },
  {
    name: 'eish',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'eish(...)',
      parameters: [],
    }],
  },
  {
    name: 'enhance',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'enhance(...)',
      parameters: [],
    }],
  },
  {
    name: 'euclidRot',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'euclidRot(...)',
      parameters: [],
    }],
  },
  {
    name: 'euclidrot',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'euclidrot(...)',
      parameters: [],
    }],
  },
  {
    name: 'expand',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'expand(...)',
      parameters: [],
    }],
  },
  {
    name: 'expression',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'expression(...)',
      parameters: [],
    }],
  },
  {
    name: 'extend',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'extend(...)',
      parameters: [],
    }],
  },
  {
    name: 'fadeInTime',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'fadeInTime(...)',
      parameters: [],
    }],
  },
  {
    name: 'fadeOutTime',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'fadeOutTime(...)',
      parameters: [],
    }],
  },
  {
    name: 'fadeTime',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'fadeTime(...)',
      parameters: [],
    }],
  },
  {
    name: 'filter',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'filter(...)',
      parameters: [],
    }],
  },
  {
    name: 'flatten',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'flatten(...)',
      parameters: [],
    }],
  },
  {
    name: 'fmrelease',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'fmrelease(...)',
      parameters: [],
    }],
  },
  {
    name: 'fmvelocity',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'fmvelocity(...)',
      parameters: [],
    }],
  },
  {
    name: 'focusSpan',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'focusSpan(...)',
      parameters: [],
    }],
  },
  {
    name: 'focusspan',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'focusspan(...)',
      parameters: [],
    }],
  },
  {
    name: 'fractionalArgs',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'fractionalArgs(...)',
      parameters: [],
    }],
  },
  {
    name: 'frameRate',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'frameRate(...)',
      parameters: [],
    }],
  },
  {
    name: 'frames',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'frames(...)',
      parameters: [],
    }],
  },
  {
    name: 'freqToMidi',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'freqToMidi(...)',
      parameters: [],
    }],
  },
  {
    name: 'fromBipolar',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'fromBipolar(...)',
      parameters: [],
    }],
  },
  {
    name: 'func',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'func(...)',
      parameters: [],
    }],
  },
  {
    name: 'grow',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'grow(...)',
      parameters: [],
    }],
  },
  {
    name: 'harmonic',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'harmonic(...)',
      parameters: [],
    }],
  },
  {
    name: 'hash2code',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'hash2code(...)',
      parameters: [],
    }],
  },
  {
    name: 'hbrick',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'hbrick(...)',
      parameters: [],
    }],
  },
  {
    name: 'hcutoff',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'hcutoff(...)',
      parameters: [],
    }],
  },
  {
    name: 'hours',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'hours(...)',
      parameters: [],
    }],
  },
  {
    name: 'hresonance',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'hresonance(...)',
      parameters: [],
    }],
  },
  {
    name: 'hsla',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'hsla(...)',
      parameters: [],
    }],
  },
  {
    name: 'imag',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'imag(...)',
      parameters: [],
    }],
  },
  {
    name: 'kcutoff',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'kcutoff(...)',
      parameters: [],
    }],
  },
  {
    name: 'keep',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'keep(...)',
      parameters: [],
    }],
  },
  {
    name: 'keepif',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'keepif(...)',
      parameters: [],
    }],
  },
  {
    name: 'krush',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'krush(...)',
      parameters: [],
    }],
  },
  {
    name: 'lbrick',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'lbrick(...)',
      parameters: [],
    }],
  },
  {
    name: 'listRange',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'listRange(...)',
      parameters: [],
    }],
  },
  {
    name: 'logger',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'logger(...)',
      parameters: [],
    }],
  },
  {
    name: 'loopb',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'loopb(...)',
      parameters: [],
    }],
  },
  {
    name: 'loope',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'loope(...)',
      parameters: [],
    }],
  },
  {
    name: 'lsize',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'lsize(...)',
      parameters: [],
    }],
  },
  {
    name: 'mapArgs',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'mapArgs(...)',
      parameters: [],
    }],
  },
  {
    name: 'midi2note',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'midi2note(...)',
      parameters: [],
    }],
  },
  {
    name: 'midiToFreq',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'midiToFreq(...)',
      parameters: [],
    }],
  },
  {
    name: 'midimap',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'midimap(...)',
      parameters: [],
    }],
  },
  {
    name: 'mini',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'mini(...)',
      parameters: [],
    }],
  },
  {
    name: 'mini2ast',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'mini2ast(...)',
      parameters: [],
    }],
  },
  {
    name: 'miniAllStrings',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'miniAllStrings(...)',
      parameters: [],
    }],
  },
  {
    name: 'minify',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'minify(...)',
      parameters: [],
    }],
  },
  {
    name: 'minutes',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'minutes(...)',
      parameters: [],
    }],
  },
  {
    name: 'mtranspose',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'mtranspose(...)',
      parameters: [],
    }],
  },
  {
    name: 'noteToMidi',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'noteToMidi(...)',
      parameters: [],
    }],
  },
  {
    name: 'numeralArgs',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'numeralArgs(...)',
      parameters: [],
    }],
  },
  {
    name: 'octaveR',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'octaveR(...)',
      parameters: [],
    }],
  },
  {
    name: 'octaves',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'octaves(...)',
      parameters: [],
    }],
  },
  {
    name: 'octer',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'octer(...)',
      parameters: [],
    }],
  },
  {
    name: 'octersub',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'octersub(...)',
      parameters: [],
    }],
  },
  {
    name: 'octersubsub',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'octersubsub(...)',
      parameters: [],
    }],
  },
  {
    name: 'offset',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'offset(...)',
      parameters: [],
    }],
  },
  {
    name: 'overgain',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'overgain(...)',
      parameters: [],
    }],
  },
  {
    name: 'overshape',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'overshape(...)',
      parameters: [],
    }],
  },
  {
    name: 'pace',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pace(...)',
      parameters: [],
    }],
  },
  {
    name: 'pairs',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pairs(...)',
      parameters: [],
    }],
  },
  {
    name: 'panorient',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'panorient(...)',
      parameters: [],
    }],
  },
  {
    name: 'panspan',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'panspan(...)',
      parameters: [],
    }],
  },
  {
    name: 'pansplay',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pansplay(...)',
      parameters: [],
    }],
  },
  {
    name: 'panwidth',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'panwidth(...)',
      parameters: [],
    }],
  },
  {
    name: 'partials',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'partials(...)',
      parameters: [],
    }],
  },
  {
    name: 'patt',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'patt(...)',
      parameters: [],
    }],
  },
  {
    name: 'patternifyAST',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'patternifyAST(...)',
      parameters: [],
    }],
  },
  {
    name: 'pdec',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pdec(...)',
      parameters: [],
    }],
  },
  {
    name: 'perlinWith',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'perlinWith(...)',
      parameters: [],
    }],
  },
  {
    name: 'phasdp',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'phasdp(...)',
      parameters: [],
    }],
  },
  {
    name: 'pick',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pick(...)',
      parameters: [],
    }],
  },
  {
    name: 'pickReset',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pickReset(...)',
      parameters: [],
    }],
  },
  {
    name: 'pickSqueeze',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pickSqueeze(...)',
      parameters: [],
    }],
  },
  {
    name: 'pickmod',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pickmod(...)',
      parameters: [],
    }],
  },
  {
    name: 'pickmodF',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pickmodF(...)',
      parameters: [],
    }],
  },
  {
    name: 'pickmodOut',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pickmodOut(...)',
      parameters: [],
    }],
  },
  {
    name: 'pickmodReset',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pickmodReset(...)',
      parameters: [],
    }],
  },
  {
    name: 'pickmodRestart',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pickmodRestart(...)',
      parameters: [],
    }],
  },
  {
    name: 'pickmodSqueeze',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pickmodSqueeze(...)',
      parameters: [],
    }],
  },
  {
    name: 'pitchJump',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pitchJump(...)',
      parameters: [],
    }],
  },
  {
    name: 'pitchJumpTime',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'pitchJumpTime(...)',
      parameters: [],
    }],
  },
  {
    name: 'polyTouch',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'polyTouch(...)',
      parameters: [],
    }],
  },
  {
    name: 'polyrhythm',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'polyrhythm(...)',
      parameters: [],
    }],
  },
  {
    name: 'prel',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'prel(...)',
      parameters: [],
    }],
  },
  {
    name: 'psus',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'psus(...)',
      parameters: [],
    }],
  },
  {
    name: 'psustain',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'psustain(...)',
      parameters: [],
    }],
  },
  {
    name: 'randrun',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'randrun(...)',
      parameters: [],
    }],
  },
  {
    name: 'rate',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'rate(...)',
      parameters: [],
    }],
  },
  {
    name: 'rdim',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'rdim(...)',
      parameters: [],
    }],
  },
  {
    name: 'real',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'real(...)',
      parameters: [],
    }],
  },
  {
    name: 'repeatTime',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'repeatTime(...)',
      parameters: [],
    }],
  },
  {
    name: 'replicate',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'replicate(...)',
      parameters: [],
    }],
  },
  {
    name: 'resonance',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'resonance(...)',
      parameters: [],
    }],
  },
  {
    name: 'rfade',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'rfade(...)',
      parameters: [],
    }],
  },
  {
    name: 'rotate',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'rotate(...)',
      parameters: [],
    }],
  },
  {
    name: 'rsize',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'rsize(...)',
      parameters: [],
    }],
  },
  {
    name: 'scaleTrans',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'scaleTrans(...)',
      parameters: [],
    }],
  },
  {
    name: 'scram',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'scram(...)',
      parameters: [],
    }],
  },
  {
    name: 'seconds',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'seconds(...)',
      parameters: [],
    }],
  },
  {
    name: 'semitone',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'semitone(...)',
      parameters: [],
    }],
  },
  {
    name: 'seqPLoop',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'seqPLoop(...)',
      parameters: [],
    }],
  },
  {
    name: 'sequence',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'sequence(...)',
      parameters: [],
    }],
  },
  {
    name: 'sequenceP',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'sequenceP(...)',
      parameters: [],
    }],
  },
  {
    name: 'shrink',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'shrink(...)',
      parameters: [],
    }],
  },
  {
    name: 'shrinklist',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'shrinklist(...)',
      parameters: [],
    }],
  },
  {
    name: 'signal',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'signal(...)',
      parameters: [],
    }],
  },
  {
    name: 'slide',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'slide(...)',
      parameters: [],
    }],
  },
  {
    name: 'slowChunk',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'slowChunk(...)',
      parameters: [],
    }],
  },
  {
    name: 'slowcatPrime',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'slowcatPrime(...)',
      parameters: [],
    }],
  },
  {
    name: 'slowchunk',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'slowchunk(...)',
      parameters: [],
    }],
  },
  {
    name: 'smear',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'smear(...)',
      parameters: [],
    }],
  },
  {
    name: 'sol2note',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'sol2note(...)',
      parameters: [],
    }],
  },
  {
    name: 'songPtr',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'songPtr(...)',
      parameters: [],
    }],
  },
  {
    name: 'sparsity',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'sparsity(...)',
      parameters: [],
    }],
  },
  {
    name: 'speak',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'speak(...)',
      parameters: [],
    }],
  },
  {
    name: 'splice',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'splice(...)',
      parameters: [],
    }],
  },
  {
    name: 'splitAt',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'splitAt(...)',
      parameters: [],
    }],
  },
  {
    name: 'squeeze',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'squeeze(...)',
      parameters: [],
    }],
  },
  {
    name: 'stackBy',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'stackBy(...)',
      parameters: [],
    }],
  },
  {
    name: 'stackCentre',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'stackCentre(...)',
      parameters: [],
    }],
  },
  {
    name: 'stackLeft',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'stackLeft(...)',
      parameters: [],
    }],
  },
  {
    name: 'stackRight',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'stackRight(...)',
      parameters: [],
    }],
  },
  {
    name: 'steady',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'steady(...)',
      parameters: [],
    }],
  },
  {
    name: 'stepalt',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'stepalt(...)',
      parameters: [],
    }],
  },
  {
    name: 'steps',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'steps(...)',
      parameters: [],
    }],
  },
  {
    name: 'stepsPerOctave',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'stepsPerOctave(...)',
      parameters: [],
    }],
  },
  {
    name: 'strans',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'strans(...)',
      parameters: [],
    }],
  },
  {
    name: 'stringifyValues',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'stringifyValues(...)',
      parameters: [],
    }],
  },
  {
    name: 'stutWith',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'stutWith(...)',
      parameters: [],
    }],
  },
  {
    name: 'stutwith',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'stutwith(...)',
      parameters: [],
    }],
  },
  {
    name: 'sustainpedal',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'sustainpedal(...)',
      parameters: [],
    }],
  },
  {
    name: 'take',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'take(...)',
      parameters: [],
    }],
  },
  {
    name: 'timeCat',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'timeCat(...)',
      parameters: [],
    }],
  },
  {
    name: 'timecat',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'timecat(...)',
      parameters: [],
    }],
  },
  {
    name: 'toBipolar',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'toBipolar(...)',
      parameters: [],
    }],
  },
  {
    name: 'tokenizeNote',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'tokenizeNote(...)',
      parameters: [],
    }],
  },
  {
    name: 'tour',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'tour(...)',
      parameters: [],
    }],
  },
  {
    name: 'trans',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'trans(...)',
      parameters: [],
    }],
  },
  {
    name: 'triode',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'triode(...)',
      parameters: [],
    }],
  },
  {
    name: 'tsdelay',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'tsdelay(...)',
      parameters: [],
    }],
  },
  {
    name: 'unicodeToBase64',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'unicodeToBase64(...)',
      parameters: [],
    }],
  },
  {
    name: 'uniq',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'uniq(...)',
      parameters: [],
    }],
  },
  {
    name: 'uniqsort',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'uniqsort(...)',
      parameters: [],
    }],
  },
  {
    name: 'uniqsortr',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'uniqsortr(...)',
      parameters: [],
    }],
  },
  {
    name: 'valueToMidi',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'valueToMidi(...)',
      parameters: [],
    }],
  },
  {
    name: 'vmod',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'vmod(...)',
      parameters: [],
    }],
  },
  {
    name: 'voice',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'voice(...)',
      parameters: [],
    }],
  },
  {
    name: 'voicingAlias',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'voicingAlias(...)',
      parameters: [],
    }],
  },
  {
    name: 'warpatt',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'warpatt(...)',
      parameters: [],
    }],
  },
  {
    name: 'warpdec',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'warpdec(...)',
      parameters: [],
    }],
  },
  {
    name: 'warprel',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'warprel(...)',
      parameters: [],
    }],
  },
  {
    name: 'warpsus',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'warpsus(...)',
      parameters: [],
    }],
  },
  {
    name: 'wavetablePhaseRand',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'wavetablePhaseRand(...)',
      parameters: [],
    }],
  },
  {
    name: 'wavetablePosition',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'wavetablePosition(...)',
      parameters: [],
    }],
  },
  {
    name: 'wavetableWarp',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'wavetableWarp(...)',
      parameters: [],
    }],
  },
  {
    name: 'wavetableWarpMode',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'wavetableWarpMode(...)',
      parameters: [],
    }],
  },
  {
    name: 'wchooseCycles',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'wchooseCycles(...)',
      parameters: [],
    }],
  },
  {
    name: 'withValue',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'withValue(...)',
      parameters: [],
    }],
  },
  {
    name: 'wrandcat',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'wrandcat(...)',
      parameters: [],
    }],
  },
  {
    name: 'wtatt',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'wtatt(...)',
      parameters: [],
    }],
  },
  {
    name: 'wtdec',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'wtdec(...)',
      parameters: [],
    }],
  },
  {
    name: 'wtrel',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'wtrel(...)',
      parameters: [],
    }],
  },
  {
    name: 'wtsus',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'wtsus(...)',
      parameters: [],
    }],
  },
  {
    name: 'xsdelay',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'xsdelay(...)',
      parameters: [],
    }],
  },
  {
    name: 'zcrush',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'zcrush(...)',
      parameters: [],
    }],
  },
  {
    name: 'zdelay',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'zdelay(...)',
      parameters: [],
    }],
  },
  {
    name: 'zipWith',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'zipWith(...)',
      parameters: [],
    }],
  },
  {
    name: 'zmod',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'zmod(...)',
      parameters: [],
    }],
  },
  {
    name: 'znoise',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'znoise(...)',
      parameters: [],
    }],
  },
  {
    name: 'zoomArc',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'zoomArc(...)',
      parameters: [],
    }],
  },
  {
    name: 'zoomarc',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'zoomarc(...)',
      parameters: [],
    }],
  },
  {
    name: 'zrand',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'zrand(...)',
      parameters: [],
    }],
  },
  {
    name: 'zzfx',
    detail: 'Strudel function',
    documentation: 'Strudel function. See strudel.cc for documentation.',
    signatures: [{
      label: 'zzfx(...)',
      parameters: [],
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
