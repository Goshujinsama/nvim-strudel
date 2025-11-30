/**
 * Audio API polyfill for Node.js
 * 
 * This module MUST be imported first, before any other modules that use Web Audio API.
 * It sets up globalThis.AudioContext and adds all the prototype methods that
 * superdough expects (like createReverb).
 * 
 * The key issue: With ESM static imports, all imports are hoisted and resolved
 * BEFORE any code executes. So we can't do:
 * 
 *   import * as nodeWebAudio from 'node-web-audio-api';
 *   Object.assign(globalThis, nodeWebAudio);  // Runs AFTER superdough is loaded!
 *   import { superdough } from 'superdough';  // Already loaded without polyfill
 * 
 * This module exports a function that sets up the polyfill, which we call
 * immediately at the top of strudel-engine.ts.
 */

import * as nodeWebAudio from 'node-web-audio-api';

// Store whether we've initialized
let initialized = false;

/**
 * Initialize the Web Audio API polyfill for Node.js
 * This adds AudioContext and related classes to globalThis,
 * and patches AudioContext.prototype with methods superdough expects.
 */
export function initAudioPolyfill(): void {
  if (initialized) return;
  initialized = true;

  // Add all node-web-audio-api exports to globalThis
  Object.assign(globalThis, nodeWebAudio);

  // Add a minimal `window` object for superdough code that expects it
  // (e.g., reverbGen.mjs assigns to window.filterNode, dspworklet.mjs adds event listener)
  if (typeof (globalThis as any).window === 'undefined') {
    (globalThis as any).window = {
      ...globalThis,
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: () => {},
    };
  } else if (!(globalThis as any).window.addEventListener) {
    // If window exists but doesn't have addEventListener (we set window = globalThis)
    (globalThis as any).window.addEventListener = () => {};
    (globalThis as any).window.removeEventListener = () => {};
    (globalThis as any).window.postMessage = () => {};
  }

  // Add a minimal `document` object for @strudel/core that checks for mousemove
  // This is a stub that does nothing - we don't have a real DOM in Node.js
  if (typeof (globalThis as any).document === 'undefined') {
    (globalThis as any).document = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      createElement: () => ({}),
      body: {},
      head: {},
    };
  }

  // Add CustomEvent for @strudel/core event dispatching
  if (typeof (globalThis as any).CustomEvent === 'undefined') {
    (globalThis as any).CustomEvent = class CustomEvent extends Event {
      detail: any;
      constructor(type: string, options?: { detail?: any }) {
        super(type);
        this.detail = options?.detail;
      }
    };
  }

  console.log('[audio-polyfill] Web Audio API polyfilled for Node.js');

  // Now manually add the prototype methods that superdough's reverb.mjs adds
  // (since reverb.mjs checks for AudioContext at module load time, which happens
  // before our polyfill runs due to ESM import hoisting)
  
  const AudioContext = (globalThis as any).AudioContext;
  if (!AudioContext) {
    console.error('[audio-polyfill] AudioContext not available after polyfill!');
    return;
  }

  // Add adjustLength method (from superdough/reverb.mjs)
  if (!AudioContext.prototype.adjustLength) {
    AudioContext.prototype.adjustLength = function(
      duration: number,
      buffer: AudioBuffer,
      speed = 1,
      offsetAmount = 0
    ): AudioBuffer {
      const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
      const sampleOffset = Math.floor(clamp(offsetAmount, 0, 1) * buffer.length);
      const newLength = buffer.sampleRate * duration;
      const newBuffer = this.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
      
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const oldData = buffer.getChannelData(channel);
        const newData = newBuffer.getChannelData(channel);

        for (let i = 0; i < newLength; i++) {
          let position = (sampleOffset + i * Math.abs(speed)) % oldData.length;
          if (speed < 1) {
            position = position * -1;
          }
          newData[i] = oldData[Math.floor(position)] || 0;
        }
      }
      return newBuffer;
    };
    console.log('[audio-polyfill] Added AudioContext.prototype.adjustLength');
  }

  // Add createReverb method (from superdough/reverb.mjs)
  if (!AudioContext.prototype.createReverb) {
    AudioContext.prototype.createReverb = function(
      duration?: number,
      fade?: number,
      lp?: number,
      dim?: number,
      ir?: AudioBuffer,
      irspeed?: number,
      irbegin?: number
    ): ConvolverNode & { generate: Function; duration?: number; fade?: number; lp?: number; dim?: number; ir?: AudioBuffer; irspeed?: number; irbegin?: number } {
      const convolver = this.createConvolver() as ConvolverNode & {
        generate: Function;
        duration?: number;
        fade?: number;
        lp?: number;
        dim?: number;
        ir?: AudioBuffer;
        irspeed?: number;
        irbegin?: number;
      };
      
      const ctx = this;
      
      convolver.generate = function(
        d = 2,
        fadeIn = 0.1,
        lpFreq = 15000,
        dimFreq = 1000,
        irBuffer?: AudioBuffer,
        irSpeed?: number,
        irBegin?: number
      ) {
        convolver.duration = d;
        convolver.fade = fadeIn;
        convolver.lp = lpFreq;
        convolver.dim = dimFreq;
        convolver.ir = irBuffer;
        convolver.irspeed = irSpeed;
        convolver.irbegin = irBegin;
        
        if (irBuffer) {
          convolver.buffer = ctx.adjustLength(d, irBuffer, irSpeed, irBegin);
        } else {
          // Generate synthetic reverb impulse response
          // This is a simplified version - the original uses reverbGen.mjs
          const sampleRate = ctx.sampleRate;
          const length = Math.floor(sampleRate * d);
          const buffer = ctx.createBuffer(2, length, sampleRate);
          
          for (let channel = 0; channel < 2; channel++) {
            const data = buffer.getChannelData(channel);
            for (let i = 0; i < length; i++) {
              // Exponential decay with random noise
              const t = i / sampleRate;
              const decay = Math.exp(-3 * t / d);
              // Apply fade in
              const fadeEnv = t < fadeIn ? t / fadeIn : 1;
              data[i] = (Math.random() * 2 - 1) * decay * fadeEnv;
            }
          }
          
          // Apply simple lowpass filter effect by averaging nearby samples
          // (This is a very rough approximation of the original)
          if (lpFreq < 20000) {
            for (let channel = 0; channel < 2; channel++) {
              const data = buffer.getChannelData(channel);
              const filterStrength = Math.max(1, Math.floor(20000 / lpFreq));
              for (let i = filterStrength; i < length; i++) {
                let sum = 0;
                for (let j = 0; j < filterStrength; j++) {
                  sum += data[i - j];
                }
                data[i] = sum / filterStrength;
              }
            }
          }
          
          convolver.buffer = buffer;
        }
      };
      
      convolver.generate(duration, fade, lp, dim, ir, irspeed, irbegin);
      return convolver;
    };
    console.log('[audio-polyfill] Added AudioContext.prototype.createReverb');
  }
}

// Export the nodeWebAudio for convenience
export { nodeWebAudio };
