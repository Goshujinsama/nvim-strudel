/**
 * Soundfont Loader for SuperDirt
 * 
 * Downloads WebAudioFont JS files, extracts base64-encoded audio data,
 * converts to WAV, and saves in SuperDirt-compatible format.
 * 
 * Each soundfont contains zones that map MIDI note ranges to audio samples.
 * We extract each zone and save as individual WAV files.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Import GM instrument definitions
import gm from '@strudel/soundfonts/gm.mjs';

const CACHE_DIR = join(homedir(), '.local', 'share', 'strudel-samples');
const SOUNDFONT_URL = 'https://felixroos.github.io/webaudiofontdata/sound';

interface SoundfontZone {
  keyRangeLow: number;
  keyRangeHigh: number;
  originalPitch: number;
  file?: string;  // base64-encoded audio (usually MP3)
  sample?: string; // alternative format
  sampleRate: number;
  loopStart?: number;
  loopEnd?: number;
  coarseTune: number;
  fineTune: number;
}

/**
 * Check if ffmpeg is available
 */
function hasFFmpeg(): boolean {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Download and parse a soundfont JS file
 */
async function downloadSoundfont(fontName: string): Promise<SoundfontZone[]> {
  const url = `${SOUNDFONT_URL}/${fontName}.js`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const text = await response.text();
    
    // Parse the JS file format: var _tone_XXXXX = { zones: [...] }
    // Find the first '=' followed by '{' to locate the object start
    const match = text.match(/=\s*\{/);
    if (!match) {
      throw new Error('Invalid soundfont format');
    }
    
    // Extract just the object part (starting from '{')
    const objectStart = match.index! + match[0].indexOf('{');
    const objectText = text.slice(objectStart);
    
    // Use Function constructor to evaluate the JS object
    const fontData = new Function(`return ${objectText}`)();
    
    return fontData.zones || [];
  } catch (err) {
    console.error(`[soundfont-loader] Failed to download ${fontName}:`, err);
    return [];
  }
}

/**
 * Convert base64 audio data to WAV file
 */
function base64ToWav(base64Data: string, outputPath: string): boolean {
  try {
    // Decode base64 to binary
    const binaryData = Buffer.from(base64Data, 'base64');
    
    // Write to temp file (it's usually MP3)
    const tempPath = outputPath.replace('.wav', '.tmp.mp3');
    writeFileSync(tempPath, binaryData);
    
    // Convert to WAV using ffmpeg
    execSync(`ffmpeg -y -i "${tempPath}" -ar 44100 -ac 2 "${outputPath}" 2>/dev/null`, {
      stdio: 'ignore',
    });
    
    // Remove temp file
    try {
      execSync(`rm "${tempPath}"`, { stdio: 'ignore' });
    } catch {}
    
    return true;
  } catch (err) {
    console.error(`[soundfont-loader] Failed to convert:`, err);
    return false;
  }
}

/**
 * Load a single soundfont instrument for SuperDirt
 * @param instrumentName The GM instrument name (e.g., "gm_piano")
 * @param fontName The specific font variant to use (e.g., "0000_JCLive_sf2_file")
 */
export async function loadSoundfontForSuperDirt(
  instrumentName: string,
  fontName: string
): Promise<boolean> {
  const bankDir = join(CACHE_DIR, instrumentName);
  
  // Check if already cached
  if (existsSync(bankDir)) {
    const files = readdirSync(bankDir).filter(f => f.endsWith('.wav'));
    if (files.length > 0) {
      console.log(`[soundfont-loader] ${instrumentName} already cached (${files.length} files)`);
      return true;
    }
  }
  
  if (!hasFFmpeg()) {
    console.warn('[soundfont-loader] ffmpeg not found - cannot convert soundfonts');
    return false;
  }
  
  console.log(`[soundfont-loader] Downloading ${instrumentName} (${fontName})...`);
  
  const zones = await downloadSoundfont(fontName);
  if (zones.length === 0) {
    console.error(`[soundfont-loader] No zones found for ${fontName}`);
    return false;
  }
  
  mkdirSync(bankDir, { recursive: true });
  
  let savedCount = 0;
  
  for (const zone of zones) {
    if (!zone.file) continue;
    
    // Use the center pitch of the zone's range for the filename
    const centerPitch = Math.floor((zone.keyRangeLow + zone.keyRangeHigh) / 2);
    const paddedIndex = String(savedCount).padStart(3, '0');
    const outputPath = join(bankDir, `${paddedIndex}_note${centerPitch}.wav`);
    
    if (base64ToWav(zone.file, outputPath)) {
      savedCount++;
    }
  }
  
  if (savedCount > 0) {
    console.log(`[soundfont-loader] ${instrumentName}: saved ${savedCount} samples`);
    return true;
  }
  
  return false;
}

/**
 * Load all GM soundfonts for SuperDirt
 * This downloads and converts all 125+ GM instruments
 */
export async function loadAllSoundfontsForSuperDirt(): Promise<number> {
  const gmInstruments = gm as unknown as Record<string, string[]>;
  let loadedCount = 0;
  
  console.log(`[soundfont-loader] Loading ${Object.keys(gmInstruments).length} GM instruments...`);
  
  // Process instruments in batches to avoid overwhelming the system
  const instruments = Object.entries(gmInstruments);
  const batchSize = 5;
  
  for (let i = 0; i < instruments.length; i += batchSize) {
    const batch = instruments.slice(i, i + batchSize);
    
    await Promise.all(
      batch.map(async ([name, fonts]) => {
        // Use the first font variant (usually the best quality)
        const fontName = fonts[0];
        if (fontName) {
          const success = await loadSoundfontForSuperDirt(name, fontName);
          if (success) loadedCount++;
        }
      })
    );
    
    // Small delay between batches to be nice to the server
    if (i + batchSize < instruments.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  console.log(`[soundfont-loader] Loaded ${loadedCount}/${instruments.length} instruments`);
  return loadedCount;
}

/**
 * Check if a soundfont is already cached
 */
export function isSoundfontCached(instrumentName: string): boolean {
  const bankDir = join(CACHE_DIR, instrumentName);
  if (!existsSync(bankDir)) return false;
  
  const files = readdirSync(bankDir).filter(f => f.endsWith('.wav'));
  return files.length > 0;
}

/**
 * Get list of cached soundfont names
 */
export function getCachedSoundfonts(): string[] {
  const gmInstruments = gm as unknown as Record<string, string[]>;
  return Object.keys(gmInstruments).filter(name => isSoundfontCached(name));
}
