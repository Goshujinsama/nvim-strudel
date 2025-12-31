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
import { registerSoundfontMetadata } from './sample-metadata.js';

// Import GM instrument definitions to know valid soundfont names
import gm from '@strudel/soundfonts/gm.mjs';

const CACHE_DIR = join(homedir(), '.local', 'share', 'strudel-samples');
const baseCDN = 'https://strudel.b-cdn.net';

// GM soundfont names (gm_piano, gm_violin, etc.)
const gmInstruments = gm as unknown as Record<string, string[]>;
const gmSoundfontNames = new Set(Object.keys(gmInstruments));

// Tidal drum machine aliases: maps short alias (lowercase) -> full name
// Built from tidal-drum-machines-alias.json (which maps full -> alias)
// We invert it and normalize to lowercase for case-insensitive lookup
let drumMachineAliases: Map<string, string> = new Map();
let drumMachineSampleMap: Record<string, string[]> = {};
let drumMachineBaseUrl = '';
let drumMachinesLoaded = false;

// Dirt-Samples from github:tidalcycles/dirt-samples
// This is the main collection of standard Tidal/SuperDirt samples (bd, sd, hh, etc.)
let dirtSampleMap: Record<string, string[]> = {};
let dirtSampleBaseUrl = '';
let dirtSamplesLoaded = false;

// VCSL - Virtual Community Sample Library
// High-quality acoustic instrument samples
let vcslSampleMap: Record<string, string[]> = {};
let vcslSampleBaseUrl = '';
let vcslSamplesLoaded = false;

/**
 * Load tidal drum machines metadata (aliases and sample map)
 * This is called once on first use
 */
async function loadDrumMachineMetadata(): Promise<void> {
  if (drumMachinesLoaded) return;
  
  try {
    // Load the alias file
    const aliasUrl = `${baseCDN}/tidal-drum-machines-alias.json`;
    const aliasResp = await fetch(aliasUrl);
    const aliases = await aliasResp.json() as Record<string, string>;
    
    // Invert: alias.json maps fullName -> shortName, we want shortName -> fullName
    // Also add lowercase variants for case-insensitive lookup
    for (const [fullName, shortName] of Object.entries(aliases)) {
      drumMachineAliases.set(shortName.toLowerCase(), fullName);
      drumMachineAliases.set(shortName, fullName); // Original case too
    }
    
    // Load the sample map
    const sampleUrl = `${baseCDN}/tidal-drum-machines.json`;
    const sampleResp = await fetch(sampleUrl);
    const sampleJson = await sampleResp.json() as Record<string, any>;
    
    drumMachineBaseUrl = sampleJson._base || `${baseCDN}/tidal-drum-machines/machines/`;
    delete sampleJson._base;
    drumMachineSampleMap = sampleJson;
    
    drumMachinesLoaded = true;
    console.log(`[on-demand] Loaded drum machine metadata: ${drumMachineAliases.size} aliases, ${Object.keys(drumMachineSampleMap).length} banks`);
  } catch (err) {
    console.error('[on-demand] Failed to load drum machine metadata:', err);
  }
}

/**
 * Resolve a drum machine bank name (e.g., "tr909" -> "RolandTR909")
 * Returns null if not a drum machine
 */
export async function resolveDrumMachineBank(bankAlias: string): Promise<string | null> {
  await loadDrumMachineMetadata();
  // Try lowercase first (case-insensitive), then original
  return drumMachineAliases.get(bankAlias.toLowerCase()) || 
         drumMachineAliases.get(bankAlias) || 
         null;
}

/**
 * Synchronous version of resolveDrumMachineBank
 * Returns null if metadata hasn't been loaded yet
 * Use this in performance-critical sync code paths (like OSC output)
 */
export function resolveDrumMachineBankSync(bankAlias: string): string | null {
  if (!drumMachinesLoaded) return null;
  return drumMachineAliases.get(bankAlias.toLowerCase()) || 
         drumMachineAliases.get(bankAlias) || 
         null;
}

/**
 * Ensure drum machine metadata is loaded
 * Call this during startup so resolveDrumMachineBankSync works
 */
export async function ensureDrumMachineMetadataLoaded(): Promise<void> {
  await loadDrumMachineMetadata();
}

/**
 * Load Dirt-Samples metadata from github:tidalcycles/dirt-samples
 * This enables on-demand loading of standard Tidal samples (bd, sd, hh, etc.)
 */
async function loadDirtSamplesMetadata(): Promise<void> {
  if (dirtSamplesLoaded) return;

  try {
    const jsonUrl = 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/strudel.json';
    const response = await fetch(jsonUrl);
    const json = await response.json() as Record<string, any>;

    dirtSampleBaseUrl = json._base || 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/';
    delete json._base;
    dirtSampleMap = json;

    dirtSamplesLoaded = true;
    console.log(`[on-demand] Loaded Dirt-Samples metadata: ${Object.keys(dirtSampleMap).length} banks`);
  } catch (err) {
    console.error('[on-demand] Failed to load Dirt-Samples metadata:', err);
  }
}

/**
 * Ensure Dirt-Samples metadata is loaded
 */
export async function ensureDirtSamplesMetadataLoaded(): Promise<void> {
  await loadDirtSamplesMetadata();
}

/**
 * Check if a bank name is a Dirt-Samples bank (bd, sd, hh, etc.)
 */
export function isDirtSamplesBank(bankName: string): boolean {
  return dirtSamplesLoaded && bankName in dirtSampleMap;
}

/**
 * Get Dirt-Samples bank info for downloading
 */
export async function getDirtSamplesBankInfo(bankName: string): Promise<{ source: Record<string, string[]>; baseUrl: string } | null> {
  await loadDirtSamplesMetadata();

  const samples = dirtSampleMap[bankName];
  if (!samples) return null;

  return {
    source: { [bankName]: samples },
    baseUrl: dirtSampleBaseUrl,
  };
}

/**
 * Load VCSL metadata from strudel CDN
 * This enables on-demand loading of VCSL acoustic samples
 */
async function loadVcslMetadata(): Promise<void> {
  if (vcslSamplesLoaded) return;

  try {
    const jsonUrl = `${baseCDN}/vcsl.json`;
    const response = await fetch(jsonUrl);
    const json = await response.json() as Record<string, any>;

    vcslSampleBaseUrl = `${baseCDN}/VCSL/`;
    delete json._base;
    vcslSampleMap = json;

    vcslSamplesLoaded = true;
    console.log(`[on-demand] Loaded VCSL metadata: ${Object.keys(vcslSampleMap).length} banks`);
  } catch (err) {
    console.error('[on-demand] Failed to load VCSL metadata:', err);
  }
}

/**
 * Check if a bank name is a VCSL bank
 */
export function isVcslBank(bankName: string): boolean {
  return vcslSamplesLoaded && bankName in vcslSampleMap;
}

/**
 * Get VCSL bank info for downloading
 */
export async function getVcslBankInfo(bankName: string): Promise<{ source: Record<string, string[]>; baseUrl: string } | null> {
  await loadVcslMetadata();

  const samples = vcslSampleMap[bankName];
  if (!samples) return null;

  return {
    source: { [bankName]: samples },
    baseUrl: vcslSampleBaseUrl,
  };
}

/**
 * Get drum machine bank info for downloading
 * @param fullBankName The full bank name like "RolandTR909_bd"
 */
export async function getDrumMachineBankInfo(fullBankName: string): Promise<{ source: Record<string, string[]>; baseUrl: string } | null> {
  await loadDrumMachineMetadata();
  
  const samples = drumMachineSampleMap[fullBankName];
  if (!samples) return null;
  
  return {
    source: { [fullBankName]: samples },
    baseUrl: drumMachineBaseUrl,
  };
}

/**
 * Check if a combined bank+sound name is a drum machine (e.g., "tr909bd", "TR909_sd")
 */
export async function isDrumMachineSound(combinedName: string): Promise<{ fullBankName: string; isValid: boolean } | null> {
  await loadDrumMachineMetadata();
  
  // Try to find a matching alias prefix
  // Common patterns: "tr909bd", "tr909_bd", "TR909bd", "TR909_bd"
  for (const [alias, fullName] of drumMachineAliases.entries()) {
    // Check if combinedName starts with this alias (case-insensitive)
    const aliasLower = alias.toLowerCase();
    const combinedLower = combinedName.toLowerCase();
    
    if (combinedLower.startsWith(aliasLower)) {
      // Extract the sound part (bd, sd, hh, etc.)
      let soundPart = combinedName.slice(alias.length);
      // Remove leading underscore if present
      if (soundPart.startsWith('_')) soundPart = soundPart.slice(1);
      
      if (soundPart) {
        // Full bank name in the sample map is like "RolandTR909_bd"
        const fullBankName = `${fullName}_${soundPart}`;
        const isValid = fullBankName in drumMachineSampleMap;
        return { fullBankName, isValid };
      }
    }
  }
  
  return null;
}

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
 * Register soundfont metadata from cached files
 * This enables proper note -> n + speed conversion for OSC output
 */
function registerSoundfontFromCache(name: string): void {
  const bankDir = join(CACHE_DIR, name);
  if (!existsSync(bankDir)) return;
  
  const files = readdirSync(bankDir).filter(f => f.endsWith('.wav'));
  if (files.length > 0) {
    registerSoundfontMetadata(name, files);
  }
}

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
 * Extract bank names and their associated sound names from pattern code
 * Looks for patterns like:
 *   .bank("tr909") - with preceding .s("bd")
 *   bank("tr808").s("bd sd")
 *   s("bd").bank("tr909")
 */
export function extractBankUsage(code: string): Array<{ bank: string; sounds: string[] }> {
  const results: Array<{ bank: string; sounds: string[] }> = [];
  
  // Match bank("...") and try to find associated s() calls
  const bankPattern = /\.?bank\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  
  let match;
  while ((match = bankPattern.exec(code)) !== null) {
    const bankName = match[1];
    const bankPos = match.index;
    
    // Look for s("...") or sound("...") nearby (within ~100 chars before or after)
    const searchStart = Math.max(0, bankPos - 100);
    const searchEnd = Math.min(code.length, bankPos + match[0].length + 100);
    const searchArea = code.slice(searchStart, searchEnd);
    
    const soundPatterns = [
      /\bs\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
      /\.s\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    ];
    
    const sounds: string[] = [];
    for (const sp of soundPatterns) {
      let sm;
      while ((sm = sp.exec(searchArea)) !== null) {
        const content = sm[1];
        const tokens = content.split(/[\s\[\]<>*\/,]+/);
        for (const token of tokens) {
          const name = token.split(':')[0].trim();
          if (name && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            sounds.push(name);
          }
        }
      }
    }
    
    if (sounds.length > 0) {
      results.push({ bank: bankName, sounds });
    }
  }
  
  return results;
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
 * Load a drum machine bank for SuperDirt
 * @param fullBankName The full bank name like "RolandTR909_bd"
 */
async function loadDrumMachineBank(fullBankName: string): Promise<boolean> {
  const bankInfo = await getDrumMachineBankInfo(fullBankName);
  if (!bankInfo) {
    console.log(`[on-demand] Unknown drum machine bank: ${fullBankName}`);
    return false;
  }
  
  try {
    const { bankNames } = await loadSamples(bankInfo.source, bankInfo.baseUrl);
    if (bankNames.length > 0) {
      console.log(`[on-demand] Loaded drum machine bank: ${fullBankName}`);
      // Don't notify here - we'll do a single notify after all loads complete
      return true;
    }
    return false;
  } catch (err) {
    console.error(`[on-demand] Failed to load drum machine bank ${fullBankName}:`, err);
    return false;
  }
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
    // Still need to register metadata for soundfonts if not already registered
    if (isGmSoundfont(name)) {
      registerSoundfontFromCache(name);
    }
    return true;
  }
  
  console.log(`[on-demand] Loading ${name}...`);
  
  const loadPromise = (async () => {
    try {
      if (isGmSoundfont(name)) {
        // Load GM soundfont
        const fonts = gmInstruments[name];
        if (fonts && fonts.length > 0) {
          // Pass all font variants - loadSoundfontForSuperDirt will pick the best one
          const success = await loadSoundfontForSuperDirt(name, fonts);
          if (success) {
            console.log(`[on-demand] Loaded soundfont: ${name}`);
            // Register metadata for note -> n + speed conversion
            registerSoundfontFromCache(name);
            // Don't notify here - we'll do a single notify after all loads complete
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
          // Don't notify here - we'll do a single notify after all loads complete
          return true;
        }
        return false;
      } else {
        // Check if it's a drum machine sound (e.g., "tr909bd")
        const drumInfo = await isDrumMachineSound(name);
        if (drumInfo?.isValid) {
          // Check if already cached
          if (isBankCached(drumInfo.fullBankName)) {
            console.log(`[on-demand] Drum machine ${drumInfo.fullBankName} already cached`);
            return true;
          }
          return await loadDrumMachineBank(drumInfo.fullBankName);
        }

        // Check if it's a Dirt-Samples bank (bd, sd, hh, sn, cp, etc.)
        const dirtBankInfo = await getDirtSamplesBankInfo(name);
        if (dirtBankInfo) {
          try {
            const { bankNames } = await loadSamples(dirtBankInfo.source, dirtBankInfo.baseUrl);
            if (bankNames.length > 0) {
              console.log(`[on-demand] Loaded Dirt-Samples bank: ${name}`);
              return true;
            }
          } catch (err) {
            console.error(`[on-demand] Failed to load Dirt-Samples bank ${name}:`, err);
          }
          return false;
        }

        // Check if it's a VCSL bank (timpani, recorder_alto_sus, etc.)
        const vcslBankInfo = await getVcslBankInfo(name);
        if (vcslBankInfo) {
          try {
            const { bankNames } = await loadSamples(vcslBankInfo.source, vcslBankInfo.baseUrl);
            if (bankNames.length > 0) {
              console.log(`[on-demand] Loaded VCSL bank: ${name}`);
              return true;
            }
          } catch (err) {
            console.error(`[on-demand] Failed to load VCSL bank ${name}:`, err);
          }
          return false;
        }

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
  const loaded: string[] = [];
  
  // Extract direct sound names (s("bd"), sound("piano"), etc.)
  const soundNames = extractSoundNames(code);
  
  // Extract bank() usage (bank("tr909").s("bd"))
  const bankUsage = extractBankUsage(code);
  
  console.log(`[on-demand] Detected sounds: ${Array.from(soundNames).join(', ') || '(none)'}`);
  if (bankUsage.length > 0) {
    console.log(`[on-demand] Detected banks: ${bankUsage.map(b => `${b.bank}(${b.sounds.join(',')})`).join(', ')}`);
  }
  
  // Ensure sample metadata is loaded before checking sound names
  await Promise.all([
    loadDirtSamplesMetadata(),
    loadVcslMetadata(),
  ]);

  // For cached soundfonts, ensure metadata is registered (needed for OSC note->n+speed)
  for (const name of soundNames) {
    if (isGmSoundfont(name) && isSoundCached(name)) {
      registerSoundfontFromCache(name);
    }
  }

  // Load direct sound names (GM soundfonts, known CDN banks, Dirt-Samples, and VCSL)
  const directNeedsLoading = Array.from(soundNames).filter(name => {
    // Skip if already cached
    if (isSoundCached(name)) return false;
    // Load GM soundfonts, known CDN banks, Dirt-Samples banks, or VCSL banks
    return isGmSoundfont(name) || isKnownCdnBank(name) || isDirtSamplesBank(name) || isVcslBank(name);
  });
  
  if (directNeedsLoading.length > 0) {
    console.log(`[on-demand] Need to load direct sounds: ${directNeedsLoading.join(', ')}`);
    const directResults = await Promise.all(
      directNeedsLoading.map(async name => {
        const success = await loadSound(name);
        return success ? name : null;
      })
    );
    loaded.push(...directResults.filter((n): n is string => n !== null));
  }
  
  // Load drum machine banks from bank() usage
  for (const { bank, sounds } of bankUsage) {
    // Resolve the bank alias to full name (e.g., "tr909" -> "RolandTR909")
    const fullBankPrefix = await resolveDrumMachineBank(bank);
    if (!fullBankPrefix) {
      console.log(`[on-demand] Unknown bank alias: ${bank}`);
      continue;
    }
    
    // Load each sound in the bank
    for (const sound of sounds) {
      const fullBankName = `${fullBankPrefix}_${sound}`;
      
      // Check if already cached
      if (isBankCached(fullBankName)) {
        console.log(`[on-demand] ${fullBankName} already cached`);
        continue;
      }
      
      // Load the drum machine bank
      const success = await loadDrumMachineBank(fullBankName);
      if (success) {
        loaded.push(fullBankName);
      }
    }
  }
  
  if (loaded.length > 0) {
    console.log(`[on-demand] Loaded ${loaded.length} sounds: ${loaded.join(', ')}`);
  } else {
    console.log('[on-demand] All sounds already cached or not loadable');
  }
  
  // Always notify SuperDirt to load samples when we detected sounds that need it
  // This ensures cached soundfonts are loaded even if they weren't newly downloaded
  const soundfontsDetected = Array.from(soundNames).filter(name => isGmSoundfont(name));
  if (soundfontsDetected.length > 0 || loaded.length > 0) {
    notifySuperDirtLoadSamples(getCacheDir(), 0);
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
