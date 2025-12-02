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
 *   --osc                 Use OSC output (SuperDirt) instead of Web Audio
 *   --osc-host <host>     SuperDirt OSC host (default: 127.0.0.1)
 *   --osc-port <port>     SuperDirt OSC port (default: 57120)
 *   --auto-superdirt      Auto-start SuperDirt if sclang available
 *   --superdirt-verbose   Show SuperCollider output
 */

// Step 1: Initialize audio polyfill (static import is OK here since audio-polyfill
// doesn't import superdough)
import { initAudioPolyfill } from './audio-polyfill.js';
initAudioPolyfill();

// Step 2: Now we can safely import modules that depend on Web Audio API
// Using dynamic imports to ensure the polyfill runs first
const { StrudelTcpServer } = await import('./tcp-server.js');
const { StrudelEngine, enableOscSampleLoading } = await import('./strudel-engine.js');
import { SuperDirtLauncher, isJackRunning, startJack } from './superdirt-launcher.js';
import { getOscPort } from './osc-output.js';
import { initSampleManager, setupOscPort } from './sample-manager.js';
import { platform } from 'os';
import type { ServerConfig } from './types.js';

const DEFAULT_PORT = 37812;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_OSC_HOST = '127.0.0.1';
const DEFAULT_OSC_PORT = 57120;

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
} {
  const args = process.argv.slice(2);
  const result = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    useOsc: false,
    oscHost: DEFAULT_OSC_HOST,
    oscPort: DEFAULT_OSC_PORT,
    autoSuperDirt: false,
    superDirtVerbose: false,
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
      case '--auto-superdirt':
        result.autoSuperDirt = true;
        break;
      case '--superdirt-verbose':
        result.superDirtVerbose = true;
        break;
    }
  }

  return result;
}

async function main() {
  const args = parseArgs();
  
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
      
      // On Linux, check/start JACK first
      if (platform() === 'linux') {
        if (!isJackRunning()) {
          console.log('[strudel-server] JACK not running, attempting to start...');
          // Try common audio devices
          if (!startJack('hw:1') && !startJack('hw:0')) {
            console.warn('[strudel-server] Could not auto-start JACK - start it manually');
          }
        }
      }
      
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

  // When using OSC, disable Web Audio output
  if (useOsc) {
    engine.setWebAudioEnabled(false);
    console.log('[strudel-server] Web Audio disabled (OSC mode)');
  } else {
    console.log('[strudel-server] Web Audio output enabled (superdough)');
  }

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

    switch (msg.type) {
      case 'eval': {
        const result = await engine.eval(msg.code);
        if (!result.success) {
          server.send(ws, {
            type: 'error',
            message: result.error || 'Evaluation failed',
          });
        } else {
          const state = engine.getState();
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

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('[strudel-server] Shutting down...');
    engine.dispose();
    await server.stop();
    
    // Stop SuperDirt if we started it
    if (superDirtLauncher) {
      superDirtLauncher.stop();
    }
    
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[strudel-server] Fatal error:', err);
  process.exit(1);
});
