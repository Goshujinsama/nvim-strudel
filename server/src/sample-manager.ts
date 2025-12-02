/**
 * SampleManager - Downloads, converts, and caches Strudel samples for SuperDirt
 * 
 * Strudel samples are often MP3/OGG hosted on CDNs, but SuperDirt only supports
 * WAV/AIF formats. This manager:
 * 1. Downloads samples from URLs
 * 2. Converts them to WAV using ffmpeg
 * 3. Caches them in a SuperDirt-compatible folder structure
 * 4. Notifies SuperDirt to load new sample banks
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, createWriteStream, readdirSync } from 'fs';
import { join, basename, extname } from 'path';
import { homedir } from 'os';
import { pipeline } from 'stream/promises';

// @ts-ignore - osc has no type definitions
import osc from 'osc';

const CACHE_DIR = join(homedir(), '.local', 'share', 'strudel-samples');
const SUPERDIRT_PORT = 57120;

// Supported input formats (will be converted to WAV)
const CONVERTIBLE_FORMATS = ['.mp3', '.ogg', '.m4a', '.flac', '.webm'];
// Native SuperDirt formats (no conversion needed)
const NATIVE_FORMATS = ['.wav', '.aif', '.aiff', '.aifc'];

let oscPort: any = null;

/**
 * Initialize the sample manager
 * Creates cache directory and sets up OSC connection
 */
export async function initSampleManager(): Promise<void> {
  // Create cache directory
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    console.log(`[sample-manager] Created cache directory: ${CACHE_DIR}`);
  }

  // Check for ffmpeg
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    console.log('[sample-manager] ffmpeg found');
  } catch {
    console.warn('[sample-manager] ffmpeg not found - MP3/OGG samples will not work');
    console.warn('[sample-manager] Install ffmpeg: sudo pacman -S ffmpeg (Arch) or apt install ffmpeg (Debian)');
  }

  console.log(`[sample-manager] Initialized, cache: ${CACHE_DIR}`);
}

/**
 * Set up OSC port for sending commands to SuperDirt
 */
export function setupOscPort(port: any): void {
  oscPort = port;
}

/**
 * Download a file from URL to local path
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  
  const fileStream = createWriteStream(destPath);
  // @ts-ignore - ReadableStream to Node stream
  await pipeline(response.body as any, fileStream);
}

/**
 * Convert audio file to WAV using ffmpeg
 */
function convertToWav(inputPath: string, outputPath: string): void {
  // -y: overwrite output, -i: input, -ar: sample rate, -ac: channels
  execSync(`ffmpeg -y -i "${inputPath}" -ar 44100 -ac 2 "${outputPath}"`, {
    stdio: 'ignore',
  });
}

/**
 * Parse a Strudel sample source and download/cache the samples
 * Returns the local path where samples are stored
 * 
 * Supports:
 * - JSON URLs: https://strudel.b-cdn.net/piano.json
 * - GitHub sources: github:tidalcycles/dirt-samples
 * - Object sources: { kick: ['kick.wav'], snare: ['snare.wav'] }
 */
export async function loadSamples(
  source: string | Record<string, any>,
  baseUrl?: string
): Promise<{ bankPath: string; bankNames: string[] }> {
  let sampleMap: Record<string, string[]> = {};
  let sampleBaseUrl = baseUrl || '';

  if (typeof source === 'string') {
    if (source.startsWith('github:')) {
      // GitHub source - convert to raw JSON URL
      const parts = source.replace('github:', '').split('/');
      const user = parts[0];
      const repo = parts[1] || 'samples';
      const branch = parts[2] || 'main';
      const jsonUrl = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/strudel.json`;
      
      const response = await fetch(jsonUrl);
      const json = await response.json() as Record<string, any>;
      
      sampleBaseUrl = json._base || `https://raw.githubusercontent.com/${user}/${repo}/${branch}/`;
      sampleMap = json;
      delete sampleMap._base;
    } else if (source.includes('.json') || source.startsWith('http')) {
      // JSON URL source
      const response = await fetch(source);
      const json = await response.json() as Record<string, any>;
      
      sampleBaseUrl = json._base || baseUrl || source.replace(/\/[^/]+\.json$/, '/');
      sampleMap = json;
      delete sampleMap._base;
    }
  } else {
    // Object source
    sampleMap = source;
  }

  const bankNames: string[] = [];
  
  // Process each sample bank
  for (const [bankName, samples] of Object.entries(sampleMap)) {
    if (bankName.startsWith('_')) continue; // Skip metadata keys
    
    const bankDir = join(CACHE_DIR, bankName);
    
    // Check if bank already exists and has files
    if (existsSync(bankDir)) {
      const existingFiles = readdirSync(bankDir).filter(f => 
        NATIVE_FORMATS.includes(extname(f).toLowerCase())
      );
      if (existingFiles.length > 0) {
        console.log(`[sample-manager] Bank '${bankName}' already cached (${existingFiles.length} files)`);
        bankNames.push(bankName);
        continue;
      }
    }
    
    mkdirSync(bankDir, { recursive: true });
    
    // Handle different sample formats
    let sampleFiles: string[] = [];
    
    if (Array.isArray(samples)) {
      sampleFiles = samples;
    } else if (typeof samples === 'object') {
      // Keyed by note name (e.g., { A0: 'A0v8.mp3', C1: 'C1v8.mp3' })
      sampleFiles = Object.values(samples);
    }
    
    console.log(`[sample-manager] Downloading bank '${bankName}' (${sampleFiles.length} files)...`);
    
    let fileIndex = 0;
    for (const file of sampleFiles) {
      if (typeof file !== 'string') continue;
      
      const fileUrl = file.startsWith('http') ? file : sampleBaseUrl + file;
      const ext = extname(file).toLowerCase();
      const needsConversion = CONVERTIBLE_FORMATS.includes(ext);
      
      // SuperDirt expects files like 000_name.wav, 001_name.wav, etc.
      const paddedIndex = String(fileIndex).padStart(3, '0');
      const baseName = basename(file, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
      const destFileName = `${paddedIndex}_${baseName}.wav`;
      const destPath = join(bankDir, destFileName);
      
      try {
        if (needsConversion) {
          // Download to temp file, then convert
          const tempPath = join(bankDir, `_temp${ext}`);
          await downloadFile(fileUrl, tempPath);
          convertToWav(tempPath, destPath);
          // Remove temp file
          execSync(`rm "${tempPath}"`);
        } else if (NATIVE_FORMATS.includes(ext)) {
          // Direct download for WAV/AIF
          await downloadFile(fileUrl, destPath);
        } else {
          console.warn(`[sample-manager] Unsupported format: ${file}`);
          continue;
        }
        fileIndex++;
      } catch (err) {
        console.error(`[sample-manager] Failed to process ${file}:`, err);
      }
    }
    
    if (fileIndex > 0) {
      console.log(`[sample-manager] Bank '${bankName}' ready (${fileIndex} files)`);
      bankNames.push(bankName);
    }
  }

  return { bankPath: CACHE_DIR, bankNames };
}

/**
 * Notify SuperDirt to load samples from the cache directory
 * Sends an OSC message that triggers the custom handler in SuperDirt
 */
export function notifySuperDirtLoadSamples(path: string = CACHE_DIR): void {
  if (!oscPort) {
    console.warn('[sample-manager] OSC not connected, cannot notify SuperDirt');
    return;
  }

  try {
    oscPort.send({
      address: '/strudel/loadSamples',
      args: [{ type: 's', value: path + '/*' }],
    });
    console.log(`[sample-manager] Notified SuperDirt to load samples from: ${path}`);
  } catch (err) {
    console.error('[sample-manager] Failed to notify SuperDirt:', err);
  }
}

/**
 * Get the cache directory path
 */
export function getCacheDir(): string {
  return CACHE_DIR;
}

/**
 * Check if a sample bank exists in the cache
 */
export function isBankCached(bankName: string): boolean {
  const bankDir = join(CACHE_DIR, bankName);
  if (!existsSync(bankDir)) return false;
  
  const files = readdirSync(bankDir).filter(f => 
    NATIVE_FORMATS.includes(extname(f).toLowerCase())
  );
  return files.length > 0;
}

/**
 * Get all cached bank names
 */
export function getCachedBanks(): string[] {
  if (!existsSync(CACHE_DIR)) return [];
  
  return readdirSync(CACHE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => isBankCached(name));
}

/**
 * Load the default Strudel sample packs for SuperDirt
 * This downloads and converts the same samples that the web UI uses
 * Call this after OSC mode is enabled
 */
export async function loadDefaultSamplesForSuperDirt(): Promise<number> {
  console.log('[sample-manager] Loading default Strudel samples for SuperDirt...');
  
  const baseCDN = 'https://strudel.b-cdn.net';
  
  // List of default sample packs to download (same as strudel-engine.ts startup)
  const samplePacks: Array<{ source: string | Record<string, any>; baseUrl?: string; name: string }> = [
    // Salamander Grand Piano
    { source: `${baseCDN}/piano.json`, baseUrl: `${baseCDN}/piano/`, name: 'piano' },
    
    // VCSL - Virtual Community Sample Library
    { source: `${baseCDN}/vcsl.json`, baseUrl: `${baseCDN}/VCSL/`, name: 'VCSL' },
    
    // Mridangam
    { source: `${baseCDN}/mridangam.json`, baseUrl: `${baseCDN}/mrid/`, name: 'mridangam' },
    
    // Tidal Drum Machines (TR-808, TR-909, etc.)
    { source: `${baseCDN}/tidal-drum-machines.json`, baseUrl: `${baseCDN}/tidal-drum-machines/machines/`, name: 'drum-machines' },
    
    // Dirt-Samples misc
    {
      source: {
        casio: ['casio/high.wav', 'casio/low.wav', 'casio/noise.wav'],
        crow: ['crow/000_crow.wav', 'crow/001_crow2.wav', 'crow/002_crow3.wav', 'crow/003_crow4.wav'],
        jazz: [
          'jazz/000_BD.wav', 'jazz/001_CB.wav', 'jazz/002_FX.wav', 'jazz/003_HH.wav',
          'jazz/004_OH.wav', 'jazz/005_P1.wav', 'jazz/006_P2.wav', 'jazz/007_SN.wav',
        ],
        metal: [
          'metal/000_0.wav', 'metal/001_1.wav', 'metal/002_2.wav', 'metal/003_3.wav',
          'metal/004_4.wav', 'metal/005_5.wav', 'metal/006_6.wav', 'metal/007_7.wav',
          'metal/008_8.wav', 'metal/009_9.wav',
        ],
        east: [
          'east/000_nipon_wood_block.wav', 'east/001_ohkawa_mute.wav', 'east/002_ohkawa_open.wav',
          'east/003_shime_hi.wav', 'east/004_shime_hi_2.wav', 'east/005_shime_mute.wav',
          'east/006_taiko_1.wav', 'east/007_taiko_2.wav', 'east/008_taiko_3.wav',
        ],
      },
      baseUrl: `${baseCDN}/Dirt-Samples/`,
      name: 'dirt-misc',
    },
    
    // GitHub Dirt-Samples
    { source: 'github:tidalcycles/dirt-samples', name: 'dirt-samples' },
  ];
  
  const results = await Promise.allSettled(
    samplePacks.map(async ({ source, baseUrl, name }) => {
      try {
        const { bankNames } = await loadSamples(source, baseUrl);
        console.log(`[sample-manager] Loaded ${name}: ${bankNames.length} banks`);
        return bankNames;
      } catch (err) {
        console.error(`[sample-manager] Failed to load ${name}:`, err);
        return [];
      }
    })
  );
  
  // Count total banks loaded
  const totalBanks = results
    .filter((r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled')
    .reduce((sum, r) => sum + r.value.length, 0);
  
  console.log(`[sample-manager] Default samples loaded: ${totalBanks} banks total`);
  
  // Notify SuperDirt to load all samples from cache
  notifySuperDirtLoadSamples(CACHE_DIR);
  
  return totalBanks;
}

/**
 * Generate SuperCollider code snippet for the startup.scd
 * This adds an OSC handler for dynamically loading samples
 */
export function generateSuperDirtStartupCode(): string {
  return `
// Strudel sample loading handler
// Add this to your SuperDirt startup.scd after ~dirt = SuperDirt(...)

// Load strudel samples cache on startup
~strudelSamplesPath = "${CACHE_DIR}";
if(File.exists(~strudelSamplesPath), {
  "Loading Strudel samples from: %".format(~strudelSamplesPath).postln;
  ~dirt.loadSoundFiles(~strudelSamplesPath +/+ "*");
});

// OSC handler for dynamic sample loading
OSCdef(\\strudelLoadSamples, { |msg|
  var path = msg[1].asString;
  "Strudel: Loading samples from %".format(path).postln;
  ~dirt.loadSoundFiles(path);
}, '/strudel/loadSamples');

"Strudel OSC handler registered: /strudel/loadSamples".postln;
`;
}
