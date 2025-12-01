/**
 * Shared TypeScript types for strudel-server
 */

/** Message from Neovim client to server */
export interface EvalMessage {
  type: 'eval';
  code: string;
  bufnr?: number;
}

export interface ControlMessage {
  type: 'play' | 'pause' | 'stop' | 'hush';
}

export interface GetSamplesMessage {
  type: 'getSamples';
}

export interface GetSoundsMessage {
  type: 'getSounds';
}

export interface GetBanksMessage {
  type: 'getBanks';
}

export interface QueryVisualizationMessage {
  type: 'queryVisualization';
  cycles?: number; // How many cycles to query (default 2)
  smooth?: boolean; // If true, smooth scrolling (playhead at left edge)
}

export type ClientMessage = EvalMessage | ControlMessage | GetSamplesMessage | GetSoundsMessage | GetBanksMessage | QueryVisualizationMessage;

/** Source location in the editor */
export interface SourceLocation {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/** Active element with source location */
export interface ActiveElement extends SourceLocation {
  value?: string;
}

/** Message from server to Neovim client */
export interface ActiveMessage {
  type: 'active';
  elements: ActiveElement[];
  cycle: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  line?: number;
  column?: number;
}

export interface StatusMessage {
  type: 'status';
  playing: boolean;
  cycle: number;
  cps: number;
}

export interface SamplesMessage {
  type: 'samples';
  samples: string[];
}

export interface SoundsMessage {
  type: 'sounds';
  sounds: string[];
}

export interface BanksMessage {
  type: 'banks';
  banks: string[];
}

/** Visualization event (single note/sound occurrence) */
export interface VisualizationEvent {
  start: number;  // 0-1 normalized position within display window
  end: number;    // 0-1 normalized position
  active: boolean; // Currently sounding
  note?: number;  // MIDI note number (for melodic content)
}

/** Visualization track with events */
export interface VisualizationTrack {
  name: string;
  events: VisualizationEvent[];
}

/** Visualization data for pianoroll/punchcard display */
export interface VisualizationMessage {
  type: 'visualization';
  cycle: number;       // Current cycle number
  phase: number;       // 0-1 position within current cycle
  tracks: VisualizationTrack[];
  displayCycles: number; // How many cycles are shown
  // Note mode data (for braille pianoroll)
  noteRange?: {
    min: number;  // Lowest MIDI note
    max: number;  // Highest MIDI note
  };
  notes?: VisualizationEvent[]; // All note events (flat, for note mode)
}

export type ServerMessage = ActiveMessage | ErrorMessage | StatusMessage | SamplesMessage | SoundsMessage | BanksMessage | VisualizationMessage;

/** Server configuration */
export interface ServerConfig {
  port: number;
  host: string;
}
