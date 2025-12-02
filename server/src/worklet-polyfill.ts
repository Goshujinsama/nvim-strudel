/**
 * AudioWorklet Polyfill for Node.js
 * 
 * This module intercepts superdough's addModule() calls and loads our Node.js-compatible
 * worklet processors instead of the browser-bundled versions.
 * 
 * The approach:
 * 1. Patch AudioWorklet.prototype.addModule() globally
 * 2. Load our worklets-node.js file instead of superdough's blob/data URLs
 * 3. node-web-audio-api's real AudioWorkletNode handles the actual DSP
 */

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Track whether we've already loaded our worklets for a context
const loadedContexts = new WeakSet<any>();

// Store the worklet path globally so patched addModule can access it
let workletPath: string;

/**
 * Initialize the AudioWorklet polyfill
 * This patches AudioWorklet.prototype.addModule to load our Node.js-compatible worklets
 */
export function initWorkletPolyfill(): void {
  const AudioContext = (globalThis as any).AudioContext;
  if (!AudioContext) {
    console.warn('[worklet-polyfill] AudioContext not available, skipping worklet polyfill');
    return;
  }

  // Path to our Node.js-compatible worklets
  workletPath = path.join(__dirname, 'worklets-node.js');
  
  // Check if the worklet file exists
  if (!fs.existsSync(workletPath)) {
    console.error('[worklet-polyfill] worklets-node.js not found at:', workletPath);
    console.error('[worklet-polyfill] Make sure to build the worklets-node.js file');
    return;
  }

  // Get the AudioWorklet class from a temporary context
  const tempCtx = new AudioContext();
  const AudioWorkletProto = Object.getPrototypeOf(tempCtx.audioWorklet);
  tempCtx.close?.();
  
  // Store the original addModule
  const originalAddModule = AudioWorkletProto.addModule;
  
  // Patch addModule on the prototype so ALL contexts get the patched version
  AudioWorkletProto.addModule = async function(moduleUrl: string): Promise<void> {
    const urlStr = String(moduleUrl);
    
    // Debug logging
    console.log('[worklet-polyfill] addModule called with:', urlStr.slice(0, 100) + (urlStr.length > 100 ? '...' : ''));
    
    // Check if this is superdough's worklets
    // Superdough's worklet URL is typically a blob: or data: URL from the ?audioworklet bundler transform
    const isSuperdoughWorklet = 
      urlStr.startsWith('blob:') || 
      urlStr.startsWith('data:') ||
      urlStr.includes('worklets');
    
    // Get the context this audioWorklet belongs to
    const ctx = (this as any)._context || this;
    
    if (isSuperdoughWorklet && !loadedContexts.has(ctx)) {
      console.log('[worklet-polyfill] Intercepting worklet load, using Node.js-compatible version');
      loadedContexts.add(ctx);
      try {
        // Load our Node.js-compatible worklets instead
        await originalAddModule.call(this, workletPath);
        console.log('[worklet-polyfill] Successfully loaded worklets-node.js');
        return;
      } catch (err) {
        console.error('[worklet-polyfill] Failed to load worklets-node.js:', err);
        throw err;
      }
    }
    
    // Already loaded or not a superdough worklet - skip or try original
    if (loadedContexts.has(ctx) && isSuperdoughWorklet) {
      // Already loaded our worklets, skip duplicate load
      console.log('[worklet-polyfill] Skipping duplicate worklet load');
      return;
    }
    
    // For other worklets, try the original
    return originalAddModule.call(this, moduleUrl);
  };
  
  console.log('[worklet-polyfill] AudioWorklet addModule() patched for Node.js');
  console.log('[worklet-polyfill] Using worklets from:', workletPath);
}
