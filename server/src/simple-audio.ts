/**
 * Simple audio output for testing without SuperCollider
 * Uses system audio players (aplay, paplay, ffplay, etc.)
 * 
 * NOTE: This is for basic testing only. For proper live coding,
 * use SuperCollider with SuperDirt which provides low-latency
 * sample triggering with effects.
 */

// @ts-ignore - play-sound has no types
import playSound from 'play-sound';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const player = playSound({});

// Map sample names to file paths
// These are placeholder sounds - for real use, download dirt-samples
const sampleMap: Record<string, string[]> = {};

// Try to find some system sounds to use as placeholders
const systemSounds = [
  '/usr/share/sounds/alsa/Front_Center.wav',
  '/usr/share/sounds/freedesktop/stereo/bell.oga',
  '/usr/share/sounds/freedesktop/stereo/complete.oga',
];

let enabled = false;
let sampleDir = '';

/**
 * Initialize simple audio with a samples directory
 */
export function initSimpleAudio(samplesPath?: string): boolean {
  if (samplesPath && existsSync(samplesPath)) {
    sampleDir = samplesPath;
    console.log(`[simple-audio] Using samples from: ${sampleDir}`);
    enabled = true;
    return true;
  }

  // Try to find a working system sound
  for (const sound of systemSounds) {
    if (existsSync(sound)) {
      sampleMap['bd'] = [sound];
      sampleMap['sd'] = [sound];
      sampleMap['hh'] = [sound];
      console.log(`[simple-audio] Using system sound: ${sound}`);
      enabled = true;
      return true;
    }
  }

  console.log('[simple-audio] No samples found - audio disabled');
  console.log('[simple-audio] For proper audio, start SuperCollider with SuperDirt');
  enabled = false;
  return false;
}

/**
 * Play a sample by name
 */
export function playSample(name: string, n: number = 0): void {
  if (!enabled) return;

  // Check sample map first
  const samples = sampleMap[name];
  if (samples && samples.length > 0) {
    const idx = n % samples.length;
    const file = samples[idx];
    
    player.play(file, (err: Error | null) => {
      if (err) {
        console.error(`[simple-audio] Error playing ${name}:`, err.message);
      }
    });
    return;
  }

  // Try to find in sample directory
  if (sampleDir) {
    const samplePath = join(sampleDir, name);
    if (existsSync(samplePath)) {
      // List files in directory
      const fs = require('fs');
      const files = fs.readdirSync(samplePath)
        .filter((f: string) => f.endsWith('.wav') || f.endsWith('.mp3') || f.endsWith('.ogg'))
        .sort();
      
      if (files.length > 0) {
        const idx = n % files.length;
        const file = join(samplePath, files[idx]);
        
        player.play(file, (err: Error | null) => {
          if (err) {
            console.error(`[simple-audio] Error playing ${name}:`, err.message);
          }
        });
      }
    }
  }
}

/**
 * Check if simple audio is enabled
 */
export function isSimpleAudioEnabled(): boolean {
  return enabled;
}

/**
 * Disable simple audio
 */
export function disableSimpleAudio(): void {
  enabled = false;
}
