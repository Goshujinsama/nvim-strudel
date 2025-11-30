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

export type ClientMessage = EvalMessage | ControlMessage | GetSamplesMessage | GetSoundsMessage | GetBanksMessage;

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

export type ServerMessage = ActiveMessage | ErrorMessage | StatusMessage | SamplesMessage | SoundsMessage | BanksMessage;

/** Server configuration */
export interface ServerConfig {
  port: number;
  host: string;
}
