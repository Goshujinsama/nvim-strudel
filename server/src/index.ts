#!/usr/bin/env node
/**
 * strudel-server - Backend server for strudel.nvim
 * Provides TCP connection for Neovim and runs Strudel pattern evaluation
 * Audio output via Web Audio (superdough) or OSC to SuperCollider/SuperDirt
 * 
 * IMPORTANT: Audio polyfill must be initialized BEFORE importing superdough.
 * We use dynamic imports to ensure proper ordering.
 */

// Step 1: Initialize audio polyfill (static import is OK here since audio-polyfill
// doesn't import superdough)
import { initAudioPolyfill } from './audio-polyfill.js';
initAudioPolyfill();

// Step 2: Now we can safely import modules that depend on Web Audio API
// Using dynamic imports to ensure the polyfill runs first
const { StrudelTcpServer } = await import('./tcp-server.js');
const { StrudelEngine } = await import('./strudel-engine.js');
import type { ServerConfig } from './types.js';

const DEFAULT_PORT = 37812;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_OSC_HOST = '127.0.0.1';
const DEFAULT_OSC_PORT = 57120;

async function main() {
  const config: ServerConfig = {
    port: parseInt(process.env.STRUDEL_PORT || String(DEFAULT_PORT), 10),
    host: process.env.STRUDEL_HOST || DEFAULT_HOST,
  };

  const useOsc = process.env.STRUDEL_USE_OSC === '1';
  const oscHost = process.env.STRUDEL_OSC_HOST || DEFAULT_OSC_HOST;
  const oscPort = parseInt(process.env.STRUDEL_OSC_PORT || String(DEFAULT_OSC_PORT), 10);

  console.log('[strudel-server] Starting server...');

  const server = new StrudelTcpServer(config);
  const engine = new StrudelEngine();

  // Web Audio is enabled by default
  console.log('[strudel-server] Web Audio output enabled (superdough)');

  // Optionally enable OSC output to SuperDirt
  if (useOsc) {
    const oscEnabled = await engine.enableOsc(oscHost, oscPort);
    if (oscEnabled) {
      console.log(`[strudel-server] OSC output enabled -> ${oscHost}:${oscPort}`);
    } else {
      console.log('[strudel-server] OSC output failed (SuperDirt not running?)');
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
            playing: state.playing,
            cycle: state.cycle,
            cps: state.cps,
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
    }
  });

  // Start the server
  try {
    await server.start();
  } catch (err) {
    console.error('[strudel-server] Failed to start:', err);
    process.exit(1);
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('[strudel-server] Shutting down...');
    engine.dispose();
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[strudel-server] Fatal error:', err);
  process.exit(1);
});
