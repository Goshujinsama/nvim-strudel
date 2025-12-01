/**
 * Shared state file for engine-LSP communication
 * 
 * The engine writes connection info (pid, port) to a JSON file.
 * The LSP reads this file to know how to connect to the engine via TCP.
 * Samples/banks/sounds are requested via TCP, not stored in the state file.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Engine state structure - connection info only */
export interface EngineState {
  pid: number;
  port: number;
  timestamp: number;
  version: string;
}

/**
 * Get the state file directory (cross-platform)
 * - Linux: ~/.local/state/strudel/
 * - macOS: ~/Library/Application Support/strudel/
 * - Windows: %LOCALAPPDATA%/strudel/
 */
function getStateDir(): string {
  const platform = os.platform();
  
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'strudel');
  } else if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'strudel');
  } else {
    // Linux and others - follow XDG spec
    const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    return path.join(stateHome, 'strudel');
  }
}

/** Get the full path to the state file */
export function getStateFilePath(): string {
  return path.join(getStateDir(), 'engine-state.json');
}

/**
 * Write engine state to the shared file
 * Called by the engine on startup
 */
export function writeEngineState(state: Omit<EngineState, 'timestamp' | 'version'>): void {
  const stateDir = getStateDir();
  const statePath = getStateFilePath();
  
  // Ensure directory exists
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  
  const fullState: EngineState = {
    ...state,
    timestamp: Date.now(),
    version: '1.0.0',
  };
  
  // Write atomically by writing to temp file then renaming
  const tempPath = `${statePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(fullState, null, 2));
  fs.renameSync(tempPath, statePath);
}

/**
 * Read engine state from the shared file
 * Returns null if file doesn't exist or is invalid
 */
export function readEngineState(): EngineState | null {
  const statePath = getStateFilePath();
  
  try {
    if (!fs.existsSync(statePath)) {
      return null;
    }
    
    const content = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(content) as EngineState;
    
    // Validate structure - just need pid and port
    if (!state.pid || typeof state.port !== 'number') {
      return null;
    }
    
    return state;
  } catch (e) {
    return null;
  }
}

/**
 * Check if the engine process is still running
 */
export function isEngineRunning(state: EngineState): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(state.pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Clear the state file (called on engine shutdown)
 */
export function clearEngineState(): void {
  const statePath = getStateFilePath();
  try {
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  } catch (e) {
    // Ignore errors during cleanup
  }
}

/**
 * Watch the state file for changes
 * Returns a function to stop watching
 */
export function watchEngineState(
  callback: (state: EngineState | null) => void,
  options?: { debounceMs?: number }
): () => void {
  const statePath = getStateFilePath();
  const stateDir = getStateDir();
  const debounceMs = options?.debounceMs ?? 100;
  
  let debounceTimer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  
  const handleChange = () => {
    // Debounce rapid changes
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      const state = readEngineState();
      callback(state);
    }, debounceMs);
  };
  
  // Ensure directory exists before watching
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  
  try {
    // Watch the directory (more reliable than watching the file directly)
    watcher = fs.watch(stateDir, (eventType, filename) => {
      if (filename === 'engine-state.json') {
        handleChange();
      }
    });
    
    watcher.on('error', (err) => {
      console.warn('[engine-state] Watch error:', err);
    });
  } catch (e) {
    console.warn('[engine-state] Could not start watching:', e);
  }
  
  // Return cleanup function
  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    if (watcher) {
      watcher.close();
    }
  };
}

/**
 * Poll for state file changes (fallback if fs.watch doesn't work)
 * Returns a function to stop polling
 */
export function pollEngineState(
  callback: (state: EngineState | null) => void,
  intervalMs = 2000
): () => void {
  let lastTimestamp = 0;
  
  const poll = () => {
    const state = readEngineState();
    if (state && state.timestamp !== lastTimestamp) {
      lastTimestamp = state.timestamp;
      callback(state);
    } else if (!state && lastTimestamp !== 0) {
      // State file was removed
      lastTimestamp = 0;
      callback(null);
    }
  };
  
  // Initial read
  poll();
  
  const timer = setInterval(poll, intervalMs);
  
  return () => {
    clearInterval(timer);
  };
}
