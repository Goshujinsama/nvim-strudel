#!/usr/bin/env node
/**
 * LSP server for Strudel mini-notation
 * Provides completions, hover, and diagnostics for mini-notation strings
 */

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
} from 'vscode-languageserver/node.js';

import { TextDocument } from 'vscode-languageserver-textdocument';

// Create connection using stdio
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Sample names available in Strudel (common ones)
const SAMPLE_NAMES = [
  // Drums
  'bd', 'sd', 'hh', 'oh', 'cp', 'mt', 'ht', 'lt', 'rim', 'cb', 'cr', 'rd',
  // Tidal drum machines
  'tr808', 'tr909', 'dm',
  // Piano
  'piano',
  // Synths
  'sine', 'saw', 'square', 'triangle', 'sawtooth',
  // Misc
  'casio', 'jazz', 'metal', 'east', 'space', 'wind', 'insect', 'crow',
  'numbers', 'mridangam',
  // Instruments from VCSL
  'violin', 'viola', 'cello', 'bass', 'flute', 'oboe', 'clarinet', 'bassoon',
  'trumpet', 'horn', 'trombone', 'tuba',
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
  'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian',
  'harmonicMinor', 'melodicMinor', 'pentatonic', 'blues', 'chromatic',
  'wholetone', 'diminished', 'augmented',
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
];

// Common Strudel functions
const STRUDEL_FUNCTIONS = [
  { name: 's', detail: 'Sound/sample', documentation: 'Play a sound: s("bd sd")' },
  { name: 'n', detail: 'Note', documentation: 'Set note number: n("0 2 4 7")' },
  { name: 'note', detail: 'Note name', documentation: 'Set note by name: note("c4 e4 g4")' },
  { name: 'sound', detail: 'Sound/sample', documentation: 'Play a sound (alias for s)' },
  { name: 'fast', detail: 'Speed up', documentation: 'Speed up pattern: fast(2)' },
  { name: 'slow', detail: 'Slow down', documentation: 'Slow down pattern: slow(2)' },
  { name: 'rev', detail: 'Reverse', documentation: 'Reverse pattern' },
  { name: 'jux', detail: 'Juxtapose', documentation: 'Apply function to one channel' },
  { name: 'stack', detail: 'Stack patterns', documentation: 'Play patterns simultaneously' },
  { name: 'cat', detail: 'Concatenate', documentation: 'Play patterns in sequence' },
  { name: 'gain', detail: 'Volume', documentation: 'Set volume: gain(0.8)' },
  { name: 'pan', detail: 'Stereo pan', documentation: 'Set pan: pan(0.5)' },
  { name: 'speed', detail: 'Playback speed', documentation: 'Change playback speed' },
  { name: 'crush', detail: 'Bitcrush', documentation: 'Bitcrusher effect' },
  { name: 'delay', detail: 'Delay effect', documentation: 'Add delay' },
  { name: 'room', detail: 'Reverb', documentation: 'Add reverb' },
  { name: 'lpf', detail: 'Low-pass filter', documentation: 'Low-pass filter: lpf(1000)' },
  { name: 'hpf', detail: 'High-pass filter', documentation: 'High-pass filter: hpf(200)' },
  { name: 'vowel', detail: 'Vowel filter', documentation: 'Vowel formant filter: vowel("a e i o u")' },
  { name: 'euclidRot', detail: 'Euclidean rotation', documentation: 'Euclidean rhythm with rotation' },
  { name: 'euclid', detail: 'Euclidean rhythm', documentation: 'Euclidean rhythm: euclid(3,8)' },
  { name: 'struct', detail: 'Structure', documentation: 'Apply rhythmic structure' },
  { name: 'mask', detail: 'Mask', documentation: 'Mask pattern with another' },
  { name: 'every', detail: 'Every N cycles', documentation: 'Apply function every N cycles' },
  { name: 'sometimes', detail: 'Sometimes', documentation: 'Apply function sometimes' },
  { name: 'rarely', detail: 'Rarely', documentation: 'Apply function rarely' },
  { name: 'often', detail: 'Often', documentation: 'Apply function often' },
  { name: 'almostAlways', detail: 'Almost always', documentation: 'Apply function almost always' },
  { name: 'almostNever', detail: 'Almost never', documentation: 'Apply function almost never' },
];

connection.onInitialize((params: InitializeParams): InitializeResult => {
  connection.console.log('Strudel LSP initializing...');
  
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: ['"', "'", ' ', ':', '(', '.'],
        resolveProvider: false,
      },
      hoverProvider: true,
    },
  };
});

connection.onInitialized(() => {
  connection.console.log('Strudel LSP initialized');
});

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
      for (let i = 0; i < 10; i++) {
        items.push({
          label: String(i),
          kind: CompletionItemKind.Value,
          detail: `Sample variant ${i}`,
        });
      }
      return items;
    }
    
    // Suggest samples
    for (const sample of SAMPLE_NAMES) {
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
      });
    }
  } else {
    // Outside mini-notation - suggest Strudel functions
    for (const func of STRUDEL_FUNCTIONS) {
      items.push({
        label: func.name,
        kind: CompletionItemKind.Function,
        detail: func.detail,
        documentation: func.documentation,
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
  }
  
  return items;
});

connection.onHover((params): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  
  const text = document.getText();
  const offset = document.offsetAt(params.position);
  const word = getCurrentWord(text, offset);
  
  if (!word) return null;
  
  // Check samples
  if (SAMPLE_NAMES.includes(word)) {
    return {
      contents: {
        kind: 'markdown',
        value: `**${word}** - Sample\n\nPlay the ${word} sound.\n\nUsage: \`s("${word}")\``,
      },
    };
  }
  
  // Check notes (strip octave)
  const noteBase = word.replace(/[0-9]/g, '');
  if (NOTE_NAMES.includes(noteBase)) {
    return {
      contents: {
        kind: 'markdown',
        value: `**${word}** - Note\n\nMusical note ${noteBase.toUpperCase()}.\n\nUsage: \`note("${word}")\``,
      },
    };
  }
  
  // Check functions
  const func = STRUDEL_FUNCTIONS.find(f => f.name === word);
  if (func) {
    return {
      contents: {
        kind: 'markdown',
        value: `**${func.name}** - ${func.detail}\n\n${func.documentation}`,
      },
    };
  }
  
  // Check scales
  if (SCALE_NAMES.includes(word)) {
    return {
      contents: {
        kind: 'markdown',
        value: `**${word}** - Scale\n\nMusical scale.\n\nUsage: \`.scale("${word}")\``,
      },
    };
  }
  
  // Check mini operators
  const op = MINI_OPERATORS.find(o => o.label === word);
  if (op) {
    return {
      contents: {
        kind: 'markdown',
        value: `**${op.label}** - ${op.detail}\n\n${op.documentation}`,
      },
    };
  }
  
  return null;
});

/**
 * Validate mini-notation and produce diagnostics
 */
async function validateDocument(document: TextDocument): Promise<void> {
  const text = document.getText();
  const diagnostics: Diagnostic[] = [];
  
  // Find all quoted strings and try to parse as mini-notation
  const stringRegex = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let match;
  
  while ((match = stringRegex.exec(text)) !== null) {
    const content = match[2];
    const startOffset = match.index + 1; // Skip opening quote
    
    // Skip empty strings
    if (!content.trim()) continue;
    
    // Skip strings that look like paths or URLs
    if (content.includes('/') && (content.startsWith('http') || content.startsWith('.'))) continue;
    
    // Try to parse as mini-notation using dynamic import
    try {
      // We can't easily import the ESM mini parser here, so we do basic validation
      // Check for unbalanced brackets
      const brackets = { '[': ']', '{': '}', '(': ')', '<': '>' };
      const stack: string[] = [];
      
      for (let i = 0; i < content.length; i++) {
        const char = content[i];
        if (Object.keys(brackets).includes(char)) {
          stack.push(char);
        } else if (Object.values(brackets).includes(char)) {
          const expected = stack.pop();
          if (!expected || brackets[expected as keyof typeof brackets] !== char) {
            const pos = document.positionAt(startOffset + i);
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              range: Range.create(pos, Position.create(pos.line, pos.character + 1)),
              message: `Unbalanced bracket: unexpected '${char}'`,
              source: 'strudel',
            });
          }
        }
      }
      
      // Report unclosed brackets
      if (stack.length > 0) {
        const pos = document.positionAt(startOffset + content.length);
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: Range.create(pos, pos),
          message: `Unclosed bracket: '${stack[stack.length - 1]}'`,
          source: 'strudel',
        });
      }
      
      // Check for unknown samples (warning only)
      const words = content.split(/[\s\[\]\{\}\(\)<>:*\/!?@~,]+/).filter(w => w && !/^[0-9.]+$/.test(w));
      for (const word of words) {
        // Skip if it looks like a note
        if (/^[a-g][sb]?[0-9]?$/i.test(word)) continue;
        // Skip if it's a known sample
        if (SAMPLE_NAMES.includes(word.toLowerCase())) continue;
        // Skip common words/operators
        if (['x', 't', 'r', '-'].includes(word)) continue;
        
        // Find position of this word in content
        const wordIndex = content.indexOf(word);
        if (wordIndex !== -1) {
          const pos = document.positionAt(startOffset + wordIndex);
          diagnostics.push({
            severity: DiagnosticSeverity.Hint,
            range: Range.create(pos, Position.create(pos.line, pos.character + word.length)),
            message: `Unknown sample or note: '${word}' (may still work if loaded)`,
            source: 'strudel',
          });
        }
      }
    } catch (err) {
      // Parse error - add diagnostic
      const pos = document.positionAt(startOffset);
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: Range.create(pos, Position.create(pos.line, pos.character + content.length)),
        message: `Mini-notation parse error: ${err instanceof Error ? err.message : String(err)}`,
        source: 'strudel',
      });
    }
  }
  
  connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

// Validate on open and change
documents.onDidOpen((event) => {
  validateDocument(event.document);
});

documents.onDidChangeContent((event) => {
  validateDocument(event.document);
});

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();

console.error('[strudel-lsp] Server started');
