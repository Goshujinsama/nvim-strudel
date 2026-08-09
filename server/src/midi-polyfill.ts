/**
 * Web MIDI API Polyfill for Node.js
 * 
 * Implements the Web MIDI API using node-midi (RtMidi) so that the 'webmidi' package
 * (used by @strudel/midi) works in Node.js.
 * 
 * This polyfill must be initialized BEFORE importing @strudel/midi or the webmidi package.
 */

import { Input, Output } from 'midi';

// Track all MIDIAccess instances for cleanup
const allMidiAccess: Set<NodeMIDIAccess> = new Set();

/**
 * Polyfill for MIDIOutput (Web MIDI API)
 */
class NodeMIDIOutput {
  private output: any;
  private portIndex: number;
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string = 'node-midi';
  readonly version: string = '1.0.0';
  readonly type: 'output' = 'output';
  readonly state: 'connected' | 'disconnected' = 'connected';
  readonly connection: 'open' | 'closed' | 'pending' = 'closed';

  constructor(portIndex: number, name: string) {
    this.output = new Output();
    this.portIndex = portIndex;
    this.id = `output-${portIndex}`;
    this.name = name;
  }

  open(): Promise<NodeMIDIOutput> {
    if ((this as any).connection !== 'open') {
      this.output.openPort(this.portIndex);
      (this as any).connection = 'open';
    }
    return Promise.resolve(this);
  }

  close(): Promise<NodeMIDIOutput> {
    if ((this as any).connection === 'open') {
      this.output.closePort();
      (this as any).connection = 'closed';
    }
    return Promise.resolve(this);
  }

  send(data: number[] | Uint8Array, timestamp?: number): void {
    if ((this as any).connection !== 'open') {
      this.output.openPort(this.portIndex);
      (this as any).connection = 'open';
    }
    // Convert Uint8Array to regular array if needed
    const arr = Array.isArray(data) ? data : Array.from(data);
    this.output.sendMessage(arr);
  }

  clear(): void {
    // No-op - node-midi doesn't have a clear method
  }

  /**
   * Internal cleanup - close port and release RtMidi resources
   */
  _dispose(): void {
    if ((this as any).connection === 'open') {
      this.output.closePort();
      (this as any).connection = 'closed';
    }
  }
}

/**
 * Polyfill for MIDIInput (Web MIDI API)
 */
class NodeMIDIInput {
  private input: any;
  private portIndex: number;
  private _onmidimessage: ((event: any) => void) | null = null;
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string = 'node-midi';
  readonly version: string = '1.0.0';
  readonly type: 'input' = 'input';
  readonly state: 'connected' | 'disconnected' = 'connected';
  readonly connection: 'open' | 'closed' | 'pending' = 'closed';

  constructor(portIndex: number, name: string) {
    this.input = new Input();
    this.portIndex = portIndex;
    this.id = `input-${portIndex}`;
    this.name = name;
    
    // Set up the message handler on construction
    // It will forward messages to onmidimessage if set
    this.input.on('message', (deltaTime: number, message: number[]) => {
      if (this._onmidimessage) {
        this._onmidimessage({
          data: new Uint8Array(message),
          timeStamp: performance.now(),
          // Add dataBytes for @strudel/midi compatibility
          dataBytes: message.slice(1),
        });
      }
    });
  }

  // Getter/setter for onmidimessage that auto-opens the port
  get onmidimessage(): ((event: any) => void) | null {
    return this._onmidimessage;
  }

  set onmidimessage(handler: ((event: any) => void) | null) {
    this._onmidimessage = handler;
    // Auto-open the port when a handler is set (per Web MIDI API spec)
    if (handler && (this as any).connection !== 'open') {
      this.open();
    }
  }

  open(): Promise<NodeMIDIInput> {
    if ((this as any).connection !== 'open') {
      this.input.openPort(this.portIndex);
      this.input.ignoreTypes(false, false, false);
      (this as any).connection = 'open';
    }
    return Promise.resolve(this);
  }

  close(): Promise<NodeMIDIInput> {
    if ((this as any).connection === 'open') {
      this.input.closePort();
      (this as any).connection = 'closed';
    }
    return Promise.resolve(this);
  }

  /**
   * Internal cleanup - close port, remove listeners, and release RtMidi resources
   */
  _dispose(): void {
    this._onmidimessage = null;
    if ((this as any).connection === 'open') {
      this.input.closePort();
      (this as any).connection = 'closed';
    }
    // Remove all event listeners from the RtMidi input
    this.input.removeAllListeners('message');
  }
}

/**
 * Polyfill for MIDIAccess (Web MIDI API)
 */
class NodeMIDIAccess {
  readonly inputs: Map<string, NodeMIDIInput>;
  readonly outputs: Map<string, NodeMIDIOutput>;
  readonly sysexEnabled: boolean = false;
  onstatechange: ((event: any) => void) | null = null;

  constructor() {
    this.inputs = new Map();
    this.outputs = new Map();

    // Scan for MIDI outputs
    const outputScanner = new Output();
    const outputCount = outputScanner.getPortCount();
    for (let i = 0; i < outputCount; i++) {
      const name = outputScanner.getPortName(i);
      const output = new NodeMIDIOutput(i, name);
      this.outputs.set(output.id, output);
    }
    outputScanner.closePort();

    // Scan for MIDI inputs
    const inputScanner = new Input();
    const inputCount = inputScanner.getPortCount();
    for (let i = 0; i < inputCount; i++) {
      const name = inputScanner.getPortName(i);
      const input = new NodeMIDIInput(i, name);
      this.inputs.set(input.id, input);
    }
    inputScanner.closePort();

    console.log(`[midi-polyfill] Found ${this.outputs.size} MIDI outputs, ${this.inputs.size} MIDI inputs`);
    if (this.outputs.size > 0) {
      console.log(`[midi-polyfill] Outputs: ${Array.from(this.outputs.values()).map(o => o.name).join(', ')}`);
    }
    
    // Track this instance for cleanup
    allMidiAccess.add(this);
  }

  /**
   * Internal cleanup - dispose all ports
   */
  _dispose(): void {
    for (const input of this.inputs.values()) {
      (input as any)._dispose();
    }
    for (const output of this.outputs.values()) {
      (output as any)._dispose();
    }
    this.inputs.clear();
    this.outputs.clear();
    allMidiAccess.delete(this);
  }
}

/**
 * Initialize the Web MIDI API polyfill for Node.js
 * Must be called before importing @strudel/midi or webmidi package
 */
export function initMidiPolyfill(): void {
  // Check if we're in a real browser
  const isRealBrowser = typeof window !== 'undefined' && 
                        typeof document !== 'undefined' && 
                        typeof document.createElement === 'function' &&
                        document.createElement('div')?.tagName === 'DIV';
  
  if (isRealBrowser) {
    console.log('[midi-polyfill] Browser detected, skipping polyfill');
    return;
  }

  // Check if already polyfilled
  if (typeof navigator !== 'undefined' && 
      typeof (navigator as any).requestMIDIAccess === 'function' &&
      (navigator as any).__midiPolyfilled) {
    console.log('[midi-polyfill] Already initialized');
    return;
  }

  console.log('[midi-polyfill] Initializing Web MIDI API polyfill for Node.js');

  // Create navigator if it doesn't exist
  if (typeof navigator === 'undefined') {
    (globalThis as any).navigator = {};
  }

  // Create performance.now if it doesn't exist
  if (typeof performance === 'undefined') {
    (globalThis as any).performance = {
      now: () => Date.now(),
    };
  }

  // Implement navigator.requestMIDIAccess
  (globalThis as any).navigator.requestMIDIAccess = async (options?: { sysex?: boolean }): Promise<NodeMIDIAccess> => {
    return new NodeMIDIAccess();
  };

  // Mark as polyfilled
  (globalThis as any).navigator.__midiPolyfilled = true;
}

/**
 * Clean up MIDI resources
 * Call this when shutting down the server to release all RtMidi ports
 */
export function closeMidi(): void {
  console.log(`[midi-polyfill] Closing ${allMidiAccess.size} MIDI access instances...`);
  for (const access of allMidiAccess) {
    (access as any)._dispose();
  }
  allMidiAccess.clear();
  console.log('[midi-polyfill] All MIDI ports closed');
}
