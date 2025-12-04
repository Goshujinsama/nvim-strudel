// Type declarations for Strudel packages
// These packages don't have built-in TypeScript types

declare module '@strudel/core' {
  export const controls: any;
  export function register(name: string, fn: any): any;
  export function evalScope(...args: any[]): Promise<any>;
  export function noteToMidi(note: string, defaultOctave?: number): number;
  export function freqToMidi(freq: number): number;
  export function midiToFreq(midi: number): number;
  export function getSoundIndex(n: number | undefined, length: number): number;
}

declare module '@strudel/core/pattern.mjs' {
  export class Pattern {
    static prototype: any;
    constructor(query: any);
    withValue(fn: (value: any) => any): Pattern;
    withState(fn: (state: any) => any): Pattern;
    fmap(fn: (value: any) => any): Pattern;
  }
  export const silence: Pattern;
  export function register(name: string, fn: any): any;
  export function reify(thing: any): Pattern;
  export function stack(...patterns: Pattern[]): Pattern;
  export function isPattern(thing: any): boolean;
}

declare module '@strudel/core/util.mjs' {
  export function isNote(name: string): boolean;
  export function isNoteWithOctave(name: string): boolean;
  export function noteToMidi(note: string, defaultOctave?: number): number;
  export function midiToFreq(midi: number): number;
  export function freqToMidi(freq: number): number;
}

declare module '@strudel/core/repl.mjs' {
  export interface ReplOptions {
    defaultOutput?: (hap: any, deadline: number, duration: number, cps: number, t: number) => Promise<void>;
    onEvalError?: (err: Error) => void;
    beforeEval?: (opts: { code: string }) => Promise<void>;
    beforeStart?: () => void;
    afterEval?: (opts: { code: string; pattern: any; meta: any }) => void;
    getTime: () => number;
    transpiler?: any;
    onToggle?: (started: boolean) => void;
    editPattern?: (pattern: any) => any;
    onUpdateState?: (state: any) => void;
    sync?: boolean;
    setInterval?: (fn: () => void, ms: number) => NodeJS.Timeout;
    clearInterval?: (id: NodeJS.Timeout) => void;
    id?: string;
    mondo?: boolean;
  }

  export interface Repl {
    scheduler: {
      now: () => number;
      cps: number;
    };
    evaluate: (code: string, autostart?: boolean) => Promise<any>;
    start: () => void;
    stop: () => void;
    pause: () => void;
    setCps: (cps: number) => void;
    setPattern: (pattern: any, autostart?: boolean) => Promise<any>;
    setCode: (code: string) => void;
    toggle: () => void;
    state: any;
  }

  export function repl(options: ReplOptions): Repl;
  export function getTrigger(opts: { getTime: () => number; defaultOutput: any }): any;
}

declare module '@strudel/core/evaluate.mjs' {
  export const strudelScope: Record<string, any>;
  export function evalScope(...args: any[]): Promise<any[]>;
  export function evaluate(code: string, transpiler?: any, transpilerOptions?: any): Promise<{
    mode: string;
    pattern: any;
    meta: any;
  }>;
}

declare module '@strudel/transpiler' {
  export function transpiler(input: string, options?: {
    wrapAsync?: boolean;
    addReturn?: boolean;
    emitMiniLocations?: boolean;
    emitWidgets?: boolean;
    id?: string;
  }): {
    output: string;
    miniLocations?: number[][];
    widgets?: any[];
  };
  export function registerWidgetType(type: string): void;
  export function registerLanguage(type: string, config: any): void;
  export function getWidgetID(widgetConfig: any): string;
}

declare module '@strudel/mini' {
  export function mini(strings: TemplateStringsArray, ...args: any[]): any;
  export function patternifyAST(ast: any, code: string, onEnter?: any, offset?: number): any;
}

declare module '@strudel/tonal' {
  export function note(n: string): any;
  export function scale(name: string): any;
  // Add more as needed
}

declare module '@strudel/webaudio' {
  export function webaudioOutput(options?: any): any;
  export function getAudioContext(): any;
}

declare module 'superdough' {
  export function superdough(value: any, t: number, hapDuration: number, cps?: number, cycle?: number): Promise<void>;
  export function samples(source: string | object, base?: string, options?: object): Promise<void>;
  export function registerSynthSounds(): Promise<void>;
  export function registerZZFXSounds(): Promise<void>;
  export function aliasBank(url: string): Promise<void>;
  export function soundAlias(from: string, to: string): void;
  export function initAudio(): Promise<void>;
  export function initAudioOnFirstClick(): Promise<void>;
  export function registerSound(key: string, onTrigger: Function, data?: object): void;
  export function getAudioContext(): AudioContext;
  export function getADSRValues(values: any[]): [number, number, number, number];
  export function getParamADSR(
    param: AudioParam, 
    attack: number, 
    decay: number, 
    sustain: number, 
    release: number, 
    min: number, 
    max: number, 
    time: number, 
    holdEnd: number, 
    curve?: string
  ): void;
  export function getPitchEnvelope(detune: AudioParam, value: any, time: number, holdEnd: number): void;
  export function getVibratoOscillator(detune: AudioParam, value: any, time: number): OscillatorNode | null;
}

declare module '@strudel/soundfonts/gm.mjs' {
  const gm: Record<string, string[]>;
  export default gm;
}

declare module 'superdough/audioContext.mjs' {
  export function getAudioContext(): AudioContext;
  export function setAudioContext(ctx: AudioContext): void;
  export const audioContext: AudioContext | null;
}

declare module '@strudel/midi' {
  // MIDI output - adds .midi() method to Pattern
  export function midi(outputName?: string): any;
  export function enableWebMidi(): Promise<void>;
  // MIDI input - allows receiving MIDI messages as patterns
  export function midin(options?: { channel?: number }): any;
}
