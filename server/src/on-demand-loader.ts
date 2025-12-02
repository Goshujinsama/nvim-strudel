/**
 * On-Demand Sample/Soundfont Loader
 * 
 * Analyzes pattern code to detect which samples/soundfonts are needed,
 * checks if they're already cached, and loads only the missing ones.
 * This keeps initial startup fast while ensuring sounds are ready when needed.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadSoundfontForSuperDirt, isSoundfontCached } from './soundfont-loader.js';
import { loadSamples, isBankCached, notifySuperDirtLoadSamples, getCacheDir } from './sample-manager.js';

// Import GM instrument definitions to know valid soundfont names
import gm from '@strudel/soundfonts/gm.mjs';

const CACHE_DIR = join(homedir(), '.local', 'share', 'strudel-samples');

// GM soundfont names (gm_piano, gm_violin, etc.)
const gmInstruments = gm as unknown as Record<string, string[]>;
const gmSoundfontNames = new Set(Object.keys(gmInstruments));

// Common Strudel CDN sample banks that we know about
const knownCdnBanks: Record<string, { source: string; baseUrl: string }> = {
  // Piano samples
  'piano': { source: 'https://strudel.b-cdn.net/piano.json', baseUrl: 'https://strudel.b-cdn.net/piano/' },
  
  // VCSL instruments - these have sub-banks like 'glockenspiel', 'marimba', etc.
  // We'll handle VCSL specially since it's a collection
  
  // Mridangam
  'mridangam': { source: 'https://strudel.b-cdn.net/mridangam.json', baseUrl: 'https://strudel.b-cdn.net/mrid/' },
  
  // Common dirt samples
  'casio': { source: { casio: ['casio/high.wav', 'casio/low.wav', 'casio/noise.wav'] } as any, baseUrl: 'https://strudel.b-cdn.net/Dirt-Samples/' },
  'jazz': { 
    source: { jazz: ['jazz/000_BD.wav', 'jazz/001_CB.wav', 'jazz/002_FX.wav', 'jazz/003_HH.wav', 'jazz/004_OH.wav', 'jazz/005_P1.wav', 'jazz/006_P2.wav', 'jazz/007_SN.wav'] } as any, 
    baseUrl: 'https://strudel.b-cdn.net/Dirt-Samples/' 
  },
  'metal': {
    source: { metal: ['metal/000_0.wav', 'metal/001_1.wav', 'metal/002_2.wav', 'metal/003_3.wav', 'metal/004_4.wav', 'metal/005_5.wav', 'metal/006_6.wav', 'metal/007_7.wav', 'metal/008_8.wav', 'metal/009_9.wav'] } as any,
    baseUrl: 'https://strudel.b-cdn.net/Dirt-Samples/'
  },
};

// Track what's currently being loaded to avoid duplicate requests
const loadingPromises = new Map<string, Promise<boolean>>();

/**
 * Extract sample/sound names from pattern code
 * Looks for patterns like:
 *   s("bd sd")
 *   sound("piano")
 *   s("gm_piano")
 *   .s("hh")
 *   note("c4").s("piano")
 */
export function extractSoundNames(code: string): Set<string> {
  const sounds = new Set<string>();
  
  // Match s("...") or sound("...") - captures the content inside quotes
  // Handles both single and double quotes, and template literals
  const patterns = [
    /\bs\s*\(\s*["'`]([^"'`]+)["'`]/g,           // s("bd sd")
    /\.s\s*\(\s*["'`]([^"'`]+)["'`]/g,           // .s("piano")
    /\bsound\s*\(\s*["'`]([^"'`]+)["'`]/g,       // sound("piano")
    /\.sound\s*\(\s*["'`]([^"'`]+)["'`]/g,       // .sound("piano")
  ];
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const content = match[1];
      // Split on whitespace to get individual sound names (mini-notation)
      // Also handle common mini-notation: bd*4, [bd sd], <bd sd>, bd:2
      const tokens = content.split(/[\s\[\]<>*\/,]+/);
      for (const token of tokens) {
        // Remove sample index (bd:2 -> bd)
        const name = token.split(':')[0].trim();
        if (name && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          sounds.add(name);
        }
      }
    }
  }
  
  return sounds;
}

/**
 * Check if a sound name is a GM soundfont
 */
export function isGmSoundfont(name: string): boolean {
  return gmSoundfontNames.has(name);
}

/**
 * Check if a sound name is a known CDN sample bank
 */
export function isKnownCdnBank(name: string): boolean {
  return name in knownCdnBanks;
}

/**
 * Check if a sound is already cached and ready
 */
export function isSoundCached(name: string): boolean {
  if (isGmSoundfont(name)) {
    return isSoundfontCached(name);
  }
  return isBankCached(name);
}

/**
 * Load a single sound on-demand
 * Returns true if loaded (or already cached), false if failed
 */
async function loadSound(name: string): Promise<boolean> {
  // Check if already loading
  const existing = loadingPromises.get(name);
  if (existing) {
    return existing;
  }
  
  // Check if already cached
  if (isSoundCached(name)) {
    console.log(`[on-demand] ${name} already cached`);
    return true;
  }
  
  console.log(`[on-demand] Loading ${name}...`);
  
  const loadPromise = (async () => {
    try {
      if (isGmSoundfont(name)) {
        // Load GM soundfont
        const fonts = gmInstruments[name];
        if (fonts && fonts[0]) {
          const success = await loadSoundfontForSuperDirt(name, fonts[0]);
          if (success) {
            console.log(`[on-demand] Loaded soundfont: ${name}`);
            notifySuperDirtLoadSamples(getCacheDir());
            return true;
          }
        }
        return false;
      } else if (isKnownCdnBank(name)) {
        // Load known CDN bank
        const bankInfo = knownCdnBanks[name];
        const { bankNames } = await loadSamples(bankInfo.source, bankInfo.baseUrl);
        if (bankNames.length > 0) {
          console.log(`[on-demand] Loaded CDN bank: ${name}`);
          notifySuperDirtLoadSamples(getCacheDir());
          return true;
        }
        return false;
      } else {
        // Unknown sound - might be a built-in synth or already loaded by strudel-engine
        // We don't need to do anything for these
        console.log(`[on-demand] ${name} is not a known downloadable sound (might be synth or pre-loaded)`);
        return true; // Don't block on unknown sounds
      }
    } catch (err) {
      console.error(`[on-demand] Failed to load ${name}:`, err);
      return false;
    } finally {
      loadingPromises.delete(name);
    }
  })();
  
  loadingPromises.set(name, loadPromise);
  return loadPromise;
}

/**
 * Analyze code and load any missing sounds before evaluation
 * Returns the names of sounds that were loaded
 */
export async function loadSoundsForCode(code: string): Promise<string[]> {
  const soundNames = extractSoundNames(code);
  
  if (soundNames.size === 0) {
    return [];
  }
  
  console.log(`[on-demand] Detected sounds in code: ${Array.from(soundNames).join(', ')}`);
  
  // Filter to only sounds we need to load (not cached)
  const needsLoading = Array.from(soundNames).filter(name => {
    // Only try to load GM soundfonts and known CDN banks
    // Other sounds (synths, pre-loaded samples) don't need loading
    return (isGmSoundfont(name) || isKnownCdnBank(name)) && !isSoundCached(name);
  });
  
  if (needsLoading.length === 0) {
    console.log('[on-demand] All sounds already cached');
    return [];
  }
  
  console.log(`[on-demand] Need to load: ${needsLoading.join(', ')}`);
  
  // Load all needed sounds in parallel
  const results = await Promise.all(
    needsLoading.map(async name => {
      const success = await loadSound(name);
      return success ? name : null;
    })
  );
  
  const loaded = results.filter((name): name is string => name !== null);
  
  if (loaded.length > 0) {
    console.log(`[on-demand] Loaded ${loaded.length} sounds: ${loaded.join(', ')}`);
  }
  
  return loaded;
}

/**
 * Get list of all available GM soundfont names
 */
export function getAvailableSoundfontNames(): string[] {
  return Array.from(gmSoundfontNames).sort();
}

/**
 * Get list of all known CDN bank names
 */
export function getKnownCdnBankNames(): string[] {
  return Object.keys(knownCdnBanks).sort();
}
