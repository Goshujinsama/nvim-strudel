/**
 * Web Audio output for strudel-server using node-web-audio-api
 * This allows playing samples and synths natively in Node.js
 * without requiring SuperCollider/SuperDirt
 */

import * as nodeWebAudio from 'node-web-audio-api';

// Polyfill globalThis with Web Audio API classes
// This allows superdough to work in Node.js
Object.assign(globalThis, nodeWebAudio);

// Create audio context with playback latency hint for stability
let audioContext: InstanceType<typeof nodeWebAudio.AudioContext> | null = null;

/**
 * Initialize the Web Audio context
 */
export function initWebAudio(): InstanceType<typeof nodeWebAudio.AudioContext> {
  if (audioContext) {
    return audioContext;
  }

  // Use playback latency hint for more stable audio on Linux
  audioContext = new nodeWebAudio.AudioContext({ 
    latencyHint: 'playback' 
  });
  
  console.log(`[webaudio] AudioContext created (state: ${audioContext.state}, sampleRate: ${audioContext.sampleRate})`);
  
  return audioContext;
}

/**
 * Get the current audio context
 */
export function getAudioContext(): InstanceType<typeof nodeWebAudio.AudioContext> | null {
  return audioContext;
}

/**
 * Close the audio context
 */
export async function closeWebAudio(): Promise<void> {
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
    console.log('[webaudio] AudioContext closed');
  }
}

/**
 * Play a simple test tone
 */
export function playTestTone(frequency = 440, duration = 0.2): void {
  if (!audioContext) {
    console.error('[webaudio] AudioContext not initialized');
    return;
  }

  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  
  gain.gain.value = 0.2;
  osc.connect(gain);
  gain.connect(audioContext.destination);
  
  osc.frequency.value = frequency;
  osc.type = 'sine';
  
  const now = audioContext.currentTime;
  osc.start(now);
  osc.stop(now + duration);
  
  console.log(`[webaudio] Test tone: ${frequency}Hz for ${duration}s`);
}
