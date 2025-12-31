#!/usr/bin/env node
/**
 * strudel-server - Backend server for nvim-strudel
 * Provides TCP connection for Neovim and runs Strudel pattern evaluation
 * Audio output via Web Audio (superdough) or OSC to SuperCollider/SuperDirt
 * 
 * IMPORTANT: Audio polyfill must be initialized BEFORE importing superdough.
 * We use dynamic imports to ensure proper ordering.
 * 
 * Command-line arguments:
 *   --port <port>         TCP server port (default: 37812)
 *   --host <host>         TCP server host (default: 127.0.0.1)
 *   --osc                 Use OSC output (SuperDirt) - auto-starts SuperDirt if available
 *   --osc-host <host>     SuperDirt OSC host (default: 127.0.0.1)
 *   --osc-port <port>     SuperDirt OSC port (default: 57120)
 *   --no-auto-superdirt   Don't auto-start SuperDirt (assumes it's already running)
 *   --superdirt-verbose   Show SuperCollider output
 *   --log <path>          Write logs to file
 *   --log-level <level>   Minimum log level: debug, info, warn, error (default: debug)
 */

import * as fs from 'fs';

// Step 1: Initialize audio polyfill (static import is OK here since audio-polyfill
// doesn't import superdough)
import { initAudioPolyfill } from './audio-polyfill.js';
initAudioPolyfill();

// Step 2: Now we can safely import modules that depend on Web Audio API
// Using dynamic imports to ensure the polyfill runs first
const { StrudelTcpServer } = await import('./tcp-server.js');
const { StrudelEngine, enableOscSampleLoading } = await import('./strudel-engine.js');
import { SuperDirtLauncher } from './superdirt-launcher.js';
import { getOscPort } from './osc-output.js';
import { initSampleManager, setupOscPort } from './sample-manager.js';
import type { ServerConfig } from './types.js';

const DEFAULT_PORT = 37812;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_OSC_HOST = '127.0.0.1';
const DEFAULT_OSC_PORT = 57120;

// Logging infrastructure
let logFile: fs.WriteStream | null = null;
let logLevel: 'debug' | 'info' | 'warn' | 'error' = 'debug';
const LOG_LEVELS: Record<string, number> = { debug: 1, info: 2, warn: 3, error: 4 };

function initLogging(logPath: string, level: string): void {
  logLevel = (level as typeof logLevel) || 'debug';
  
  // Ensure parent directory exists
  const dir = logPath.substring(0, logPath.lastIndexOf('/'));
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  logFile = fs.createWriteStream(logPath, { flags: 'a' });
  logFile.write(`\n--- Strudel server session started: ${new Date().toISOString()} ---\n`);
  console.log(`[strudel-server] Logging to: ${logPath}`);
}

function closeLogging(): void {
  if (logFile) {
    logFile.write(`--- Session ended: ${new Date().toISOString()} ---\n`);
    logFile.end();
    logFile = null;
  }
}

function writeLog(level: string, msg: string): void {
  if (!logFile) return;
  if (LOG_LEVELS[level] < LOG_LEVELS[logLevel]) return;
  
  const timestamp = new Date().toISOString().substring(11, 19);
  logFile.write(`[${timestamp}] [${level.toUpperCase()}] ${msg}\n`);
}

// Wrap console methods to also write to log file
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = (...args: any[]) => {
  originalConsoleLog(...args);
  writeLog('info', args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
};

console.warn = (...args: any[]) => {
  originalConsoleWarn(...args);
  writeLog('warn', args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
};

console.error = (...args: any[]) => {
  originalConsoleError(...args);
  writeLog('error', args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
};

// Export for other modules to use
export function serverLog(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void {
  writeLog(level, msg);
  if (level === 'debug' && LOG_LEVELS[level] >= LOG_LEVELS[logLevel]) {
    originalConsoleLog(`[debug] ${msg}`);
  }
}

/**
 * Parse command-line arguments
 */
function parseArgs(): {
  port: number;
  host: string;
  useOsc: boolean;
  oscHost: string;
  oscPort: number;
  autoSuperDirt: boolean;
  superDirtVerbose: boolean;
  logPath: string | null;
  logLevel: string;
} {
  const args = process.argv.slice(2);
  const result = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    useOsc: false,
    oscHost: DEFAULT_OSC_HOST,
    oscPort: DEFAULT_OSC_PORT,
    autoSuperDirt: true, // Default to true, --osc will use this
    superDirtVerbose: false,
    logPath: null as string | null,
    logLevel: 'debug',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--port':
        result.port = parseInt(args[++i], 10);
        break;
      case '--host':
        result.host = args[++i];
        break;
      case '--osc':
        result.useOsc = true;
        break;
      case '--osc-host':
        result.oscHost = args[++i];
        break;
      case '--osc-port':
        result.oscPort = parseInt(args[++i], 10);
        break;
      case '--no-auto-superdirt':
        result.autoSuperDirt = false;
        break;
      case '--superdirt-verbose':
        result.superDirtVerbose = true;
        break;
      case '--auto-superdirt':
        result.autoSuperDirt = true;
        break;
      case '--log':
        result.logPath = args[++i];
        break;
      case '--log-level':
        result.logLevel = args[++i];
        break;
    }
  }

  return result;
}

async function main() {
  const args = parseArgs();
  
  // Initialize logging if requested
  if (args.logPath) {
    initLogging(args.logPath, args.logLevel);
  }
  
  const config: ServerConfig = {
    port: args.port,
    host: args.host,
  };

  const useOsc = args.useOsc;
  const oscHost = args.oscHost;
  const oscPort = args.oscPort;
  const autoSuperDirt = args.autoSuperDirt;
  const superDirtVerbose = args.superDirtVerbose;

  console.log('[strudel-server] Starting server...');

  // Auto-start SuperDirt if requested and OSC mode is enabled
  let superDirtLauncher: SuperDirtLauncher | null = null;
  
  if (autoSuperDirt && useOsc) {
    if (SuperDirtLauncher.isSclangAvailable()) {
      console.log('[strudel-server] Auto-starting SuperDirt...');
      
      // SuperDirtLauncher.start() handles JACK startup internally on Linux
      superDirtLauncher = new SuperDirtLauncher({
        port: oscPort,
        verbose: superDirtVerbose,
        startupTimeout: 45000, // SuperDirt can take a while to load samples
      });
      
      const started = await superDirtLauncher.start();
      if (!started) {
        console.warn('[strudel-server] SuperDirt failed to start - falling back to Web Audio');
        superDirtLauncher = null;
      }
    } else {
      console.log('[strudel-server] sclang not found - SuperDirt auto-start disabled');
      console.log('[strudel-server] Install SuperCollider to use SuperDirt: https://supercollider.github.io/');
    }
  }

  const server = new StrudelTcpServer(config);
  const engine = new StrudelEngine();

  // Define shutdown function early so it can be used by message handlers
  // IMPORTANT: Signal handlers must be synchronous because Node.js doesn't wait
  // for async operations before exiting. We use synchronous cleanup here.
  let isShuttingDown = false;
  
  const shutdownSync = (reason?: string) => {
    if (isShuttingDown) return; // Prevent double shutdown
    isShuttingDown = true;
    
    console.log(`[strudel-server] Shutting down${reason ? ` (${reason})` : ''}...`);
    
    // Stop SuperDirt FIRST (synchronously stops JACK if we started it)
    // This MUST happen before process.exit() or JACK will be orphaned
    if (superDirtLauncher) {
      try {
        console.log('[strudel-server] Stopping SuperDirt and JACK...');
        superDirtLauncher.stop();
      } catch (e) {
        console.error('[strudel-server] Error stopping SuperDirt:', e);
      }
    }
    
    try {
      engine.dispose();
    } catch (e) {
      // Ignore errors during disposal
    }
    
    try {
      server.stopSync();
    } catch (e) {
      // Ignore errors during stop
    }
    
    // Close log file
    closeLogging();
    
    console.log('[strudel-server] Shutdown complete');
    process.exit(0);
  };

  // Web Audio is always enabled for synth sounds (sine, sawtooth, square, triangle)
  // These only work via superdough, not SuperDirt OSC
  // When OSC is also enabled, sample sounds go to both (SuperDirt for better quality)
  console.log('[strudel-server] Web Audio output enabled (superdough - required for synth sounds)');

  // Enable OSC output to SuperDirt if requested
  if (useOsc) {
    // If we auto-started SuperDirt, wait a moment for it to fully initialize
    if (superDirtLauncher?.isActive()) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    const oscEnabled = await engine.enableOsc(oscHost, oscPort);
    if (oscEnabled) {
      console.log(`[strudel-server] OSC output enabled -> ${oscHost}:${oscPort}`);
      
      // Enable sample downloading/caching for SuperDirt
      // This hooks into the samples() function to also download for SuperDirt
      const port = getOscPort();
      if (port) {
        enableOscSampleLoading(port);
        console.log('[strudel-server] OSC sample loading enabled');
        console.log('[strudel-server] Samples/soundfonts will be loaded on-demand when patterns use them');
      }
    } else {
      console.log('[strudel-server] OSC output failed (SuperDirt not running?)');
      if (useOsc && !superDirtLauncher?.isActive()) {
        console.error('[strudel-server] ERROR: OSC mode but SuperDirt not available!');
      }
    }
  }

  // Forward active elements to all clients
  engine.onActive((elements, cycle) => {
    server.broadcast({
      type: 'active',
      elements,
      cycle,
    });
  });

  // Forward visualization requests to all clients (when code uses pianoroll/punchcard)
  engine.onVisualizationRequest(() => {
    server.broadcast({
      type: 'enableVisualization',
    });
  });

  // Handle client messages
  server.onMessage(async (msg, ws) => {
    console.log('[strudel-server] Received message:', msg.type);
    serverLog('debug', `Message received: ${msg.type}`);

    switch (msg.type) {
      case 'eval': {
        serverLog('debug', `Eval code (${msg.code?.length || 0} chars): ${msg.code?.substring(0, 200)}...`);
        const result = await engine.eval(msg.code);
        serverLog('debug', `Eval result: success=${result.success}, error=${result.error || 'none'}`);
        if (!result.success) {
          serverLog('warn', `Eval error: ${result.error}`);
          server.send(ws, {
            type: 'error',
            message: result.error || 'Evaluation failed',
          });
        } else {
          const state = engine.getState();
          serverLog('debug', `Eval success, state: playing=${state.playing}, cps=${state.cps}`);
          server.send(ws, {
            type: 'status',
            ...state,
          });
        }
        break;
      }

      case 'play': {
        const started = engine.play();
        if (!started) {
          server.send(ws, {
            type: 'error',
            message: 'No pattern to play - evaluate code first',
          });
        }
        server.broadcast({
          type: 'status',
          ...engine.getState(),
        });
        break;
      }

      case 'pause':
        engine.pause();
        server.broadcast({
          type: 'status',
          ...engine.getState(),
        });
        break;

      case 'stop':
        engine.stop();
        server.broadcast({
          type: 'status',
          ...engine.getState(),
        });
        break;

      case 'hush':
        engine.hush();
        server.broadcast({
          type: 'status',
          ...engine.getState(),
        });
        break;

      case 'getSamples':
        server.send(ws, {
          type: 'samples',
          samples: engine.getSamples(),
        });
        break;

      case 'getSounds':
        server.send(ws, {
          type: 'sounds',
          sounds: engine.getSounds(),
        });
        break;

      case 'getBanks':
        server.send(ws, {
          type: 'banks',
          banks: engine.getBanks(),
        });
        break;

      case 'queryVisualization': {
        const vizData = engine.queryVisualization(msg.cycles || 2, msg.smooth !== false);
        if (vizData) {
          server.send(ws, {
            type: 'visualization',
            ...vizData,
          });
        }
        break;
      }

      case 'shutdown':
        console.log('[strudel-server] Received shutdown request from client');
        shutdownSync('client request');
        break;
    }
  });

  // Start the server
  try {
    await server.start();
    // Update state file with the actual port
    engine.setPort(config.port);
  } catch (err) {
    console.error('[strudel-server] Failed to start:', err);
    process.exit(1);
  }

  // Shutdown when all clients disconnect (e.g., Neovim quits)
  server.onAllClientsDisconnected(() => {
    console.log('[strudel-server] All clients disconnected, shutting down...');
    shutdownSync('all clients disconnected');
  });

  // Register signal handlers
  process.on('SIGINT', () => shutdownSync('SIGINT'));
  process.on('SIGTERM', () => shutdownSync('SIGTERM'));
  process.on('SIGHUP', () => shutdownSync('SIGHUP'));
  
  // Handle uncaught errors to prevent orphaned processes
  process.on('uncaughtException', (err) => {
    console.error('[strudel-server] Uncaught exception:', err);
    shutdownSync('uncaughtException');
  });
  
  process.on('unhandledRejection', (reason) => {
    console.error('[strudel-server] Unhandled rejection:', reason);
    // Don't exit on unhandled rejections, just log them
  });
  
  // Last-resort cleanup on exit (in case signal handlers didn't run)
  process.on('exit', (code) => {
    if (!isShuttingDown && superDirtLauncher) {
      console.log('[strudel-server] Exit handler: cleaning up SuperDirt/JACK...');
      try {
        superDirtLauncher.stop();
      } catch {
        // Ignore
      }
    }
  });
}

main().catch((err) => {
  console.error('[strudel-server] Fatal error:', err);
  process.exit(1);
});
