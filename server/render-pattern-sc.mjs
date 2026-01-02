#!/usr/bin/env node
/**
 * Render a Strudel pattern to WAV using SuperCollider
 * 
 * This creates a temporary SuperCollider script that:
 * 1. Boots the server with our SynthDefs
 * 2. Starts recording to the output file  
 * 3. Listens for OSC messages on port 57120
 * 4. After receiving a "done" message or timeout, stops and saves
 * 
 * Usage:
 *   node render-pattern-sc.mjs <pattern-file> <output.wav> [duration-seconds]
 *   echo 'sound("sbd")' | node render-pattern-sc.mjs - output.wav 5
 */
import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse arguments
const args = process.argv.slice(2);
let patternFile = null;
let outputFile = null;
let duration = 4;
let verbose = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    console.log(`Usage: node render-pattern-sc.mjs [options] <pattern-file> <output.wav> [duration-seconds]

Renders a Strudel pattern to a WAV file using SuperCollider/SuperDirt.

Options:
  --verbose   Show SuperCollider output
  --help      Show this help message

Examples:
  node render-pattern-sc.mjs path/to/pattern.strudel output.wav 10
  echo 'sound("sbd")' | node render-pattern-sc.mjs - output.wav 5

Default duration is 4 seconds.`);
    process.exit(0);
  } else if (arg === '--verbose') {
    verbose = true;
  } else if (!patternFile) {
    patternFile = arg;
  } else if (!outputFile) {
    outputFile = arg;
  } else {
    const parsed = parseFloat(arg);
    if (!isNaN(parsed)) {
      duration = parsed;
    }
  }
}

if (!patternFile || !outputFile) {
  console.error('Usage: node render-pattern-sc.mjs [options] <pattern-file> <output.wav> [duration-seconds]');
  console.error('       node render-pattern-sc.mjs --help  # for more info');
  process.exit(1);
}

// Read pattern code
let code;
if (patternFile === '-') {
  code = readFileSync(0, 'utf-8');
} else {
  const fullPath = resolve(patternFile);
  try {
    code = readFileSync(fullPath, 'utf-8');
    console.log(`Loading pattern from: ${fullPath}`);
  } catch (e) {
    console.error(`Error reading file: ${e.message}`);
    process.exit(1);
  }
}

const outputPath = resolve(outputFile);
console.log(`Output: ${outputPath}`);
console.log(`Duration: ${duration}s`);

// Check for sclang
try {
  execSync('which sclang', { stdio: 'pipe' });
} catch {
  console.error('SuperCollider (sclang) not found. Please install SuperCollider.');
  process.exit(1);
}

// Kill existing SC processes (be careful not to match ourselves)
console.log('Cleaning up existing SuperCollider processes...');
try {
  // Use killall instead of pkill -f to avoid matching our own process
  execSync('killall -9 sclang 2>/dev/null || true; killall -9 scsynth 2>/dev/null || true; sleep 0.5', { stdio: 'ignore' });
} catch { }

// Read our SynthDef code from superdirt-launcher.ts
const launcherPath = resolve(__dirname, 'src/superdirt-launcher.ts');
const launcherCode = readFileSync(launcherPath, 'utf-8');

// Extract SynthDef blocks using a simpler approach
// Find the template literal containing the startup script (starts with `(` and ends with `)`)
const templateMatch = launcherCode.match(/return `\(\n[\s\S]+?\n\)[\s\n]*`;/);
if (!templateMatch) {
  console.error('Could not find startup script template in superdirt-launcher.ts');
  process.exit(1);
}

// Extract the content between the backticks, remove the outer () wrapper
let scTemplate = templateMatch[0]
  .replace(/^return `/, '')
  .replace(/`;$/, '')
  .trim();

// Remove the outer ( and ) 
scTemplate = scTemplate.replace(/^\(/, '').replace(/\)$/, '').trim();

// Extract just the SynthDef sections (everything between "SynthDef" and ".add;")
const synthDefBlocks = [];
const synthDefRegex = /SynthDef\([^)]+\)\s*\.add;/gs;
const fullSynthDefRegex = /\/\/[^\n]*\n\s*SynthDef\([\s\S]*?\.add;/g;

// Actually, let's extract everything from the first SynthDef comment to the last .add;
const synthDefStart = scTemplate.indexOf('// Strudel Soundfont SynthDefs');
const synthDefEnd = scTemplate.lastIndexOf('.add;') + 5;

if (synthDefStart === -1 || synthDefEnd < synthDefStart) {
  console.error('Could not extract SynthDef code');
  process.exit(1);
}

let synthDefCode = scTemplate.substring(synthDefStart, synthDefEnd);

// Replace template variables
synthDefCode = synthDefCode
  .replace(/\$\{channels\}/g, '2')

// Process escape sequences: the TypeScript source has \\symbol which should become \symbol in SC
// When we read it as a raw string, we get \\symbol, so we need to convert \\\\ to \\
synthDefCode = synthDefCode
  .replace(/\\\\/g, '\\');

// Create a temporary SC script for recording
const tmpDir = mkdtempSync(join(tmpdir(), 'strudel-render-'));
const scScriptPath = join(tmpDir, 'render.scd');

// Create a full SC script that loads SuperDirt and records
// NOTE: We use fork{} inside waitForBoot to enable .wait and s.sync calls
// (these require running inside a Routine context)
// NOTE: Do NOT use outer () wrapper - sclang doesn't auto-execute code blocks in files
// 
// Synchronization protocol:
// 1. SC boots, loads SuperDirt and SynthDefs, prints "Ready for OSC"
// 2. Node.js sees this, then starts sending pattern events
// 3. SC waits for "start" file to appear (Node.js creates it when pattern starts)
// 4. SC starts recording
// 5. SC waits for duration, then stops recording and exits
const startFlagPath = join(tmpDir, 'start.flag').replace(/\\/g, '/');
const scScript = `
// Strudel Pattern Renderer with Recording
// Auto-generated script

// Server configuration
Server.killAll;
s.options.sampleRate = 48000;
s.options.numOutputBusChannels = 2;
s.options.numBuffers = 1024 * 64;
s.options.memSize = 8192 * 16;
s.options.maxNodes = 1024 * 8;

s.waitForBoot {
    "Server booted".postln;
    
    // fork creates a Routine so we can use .wait and s.sync
    fork {
        // Start SuperDirt
        ~dirt = SuperDirt(2, s);
        ~dirt.loadSoundFiles;
        s.sync;
        ~dirt.start(57120, [0, 0]);
        "SuperDirt started on port 57120".postln;
        
        // Add our custom SynthDefs
        ${synthDefCode}
        
        s.sync;
        "SynthDefs loaded".postln;
        
        // Small delay to ensure everything is ready
        0.5.wait;
        
        "Ready for OSC".postln;
        
        // Wait for start flag file (created by Node.js when pattern starts playing)
        "Waiting for start signal...".postln;
        while { File.exists("${startFlagPath}").not } {
            0.05.wait;
        };
        "Start signal received".postln;
        
        // Start recording
        s.record("${outputPath.replace(/\\/g, '/').replace(/"/g, '\\"')}");
        "Recording started".postln;
        
        // Wait for the render duration + buffer for decay
        ${duration + 1}.wait;
        
        // Stop recording
        s.stopRecording;
        "Recording stopped".postln;
        
        // Give time for file to be written
        1.wait;
        
        "Exiting".postln;
        0.exit;
    };
};
`;

writeFileSync(scScriptPath, scScript);
if (verbose) console.log(`Created SC script: ${scScriptPath}`);

// Start SuperCollider
console.log('Starting SuperCollider...');
const scProcess = spawn('sclang', [scScriptPath], {
  stdio: 'pipe',  // Always pipe so we can detect ready
});

// Wait for SC to be ready by watching for "Ready for OSC" message
let scReady = false;
let scOutput = '';

const readyPromise = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    if (!scReady) {
      console.error('Timeout waiting for SuperCollider to be ready');
      console.error('SC Output:', scOutput.slice(-2000));
      reject(new Error('SC timeout'));
    }
  }, 30000);  // 30 second timeout
  
  scProcess.stdout?.on('data', (data) => {
    const text = data.toString();
    scOutput += text;
    if (verbose) process.stdout.write(text);
    
    if (text.includes('Ready for OSC') && !scReady) {
      scReady = true;
      clearTimeout(timeout);
      console.log('SuperCollider ready');
      resolve();
    }
  });
  
  scProcess.stderr?.on('data', (data) => {
    const text = data.toString();
    scOutput += text;
    if (verbose) process.stderr.write(text);
  });
  
  scProcess.on('error', (err) => {
    clearTimeout(timeout);
    reject(err);
  });
  
  scProcess.on('exit', (code) => {
    if (!scReady) {
      clearTimeout(timeout);
      reject(new Error(`SC exited with code ${code} before becoming ready`));
    }
  });
});

console.log('Waiting for SuperCollider to boot...');
try {
  await readyPromise;
} catch (e) {
  console.error(`SuperCollider failed: ${e.message}`);
  scProcess.kill();
  process.exit(1);
}

// Now start our pattern and send OSC
console.log('Initializing Strudel engine...');

import { initAudioPolyfill } from './dist/audio-polyfill.js';
initAudioPolyfill();

const { StrudelEngine, enableOscSampleLoading } = await import('./dist/strudel-engine.js');
const { initOsc, getOscPort, setOscDebug } = await import('./dist/osc-output.js');

// Enable OSC debug logging when verbose
if (verbose) {
  setOscDebug(true);
}

const engine = new StrudelEngine();
await new Promise(r => setTimeout(r, 2000));

// Initialize OSC
console.log('Connecting to SuperCollider via OSC...');
let oscPort;
try {
  await initOsc('127.0.0.1', 57120);
  oscPort = getOscPort();
  enableOscSampleLoading(oscPort);
  engine.enableOsc('127.0.0.1', 57120);
  engine.setWebAudioEnabled(false);
} catch (e) {
  console.error(`Failed to connect: ${e.message}`);
  scProcess.kill();
  process.exit(1);
}

// Evaluate pattern WITHOUT autostart - we control when playback begins
console.log('Evaluating pattern...');
const result = await engine.eval(code, false);  // autostart = false
if (!result.success) {
  console.error(`Evaluation error: ${result.error}`);
  scProcess.kill();
  process.exit(1);
}

// Start playback first, THEN signal SC to start recording
// This ensures audio is flowing when recording begins
console.log(`Playing for ${duration} seconds...`);
const playStartTime = Date.now();
engine.play();

// Small delay for first OSC messages to be in flight
await new Promise(r => setTimeout(r, 50));

// Create start flag file to signal SC to begin recording
writeFileSync(startFlagPath, 'start');
console.log('Signaled SC to start recording...');

// Wait for playback duration exactly
await new Promise(r => setTimeout(r, duration * 1000));

// Stop playback
const actualPlayTime = (Date.now() - playStartTime) / 1000;
console.log(`Stopping playback... (actual play time: ${actualPlayTime.toFixed(2)}s)`);
engine.stop();
engine.dispose();

// Wait for SC to finish recording and exit
console.log('Waiting for SuperCollider to finish...');
await new Promise((resolve) => {
  const timeout = setTimeout(() => {
    console.log('Timeout waiting for SC, killing...');
    scProcess.kill('SIGTERM');
    resolve();
  }, 10000);
  
  scProcess.on('exit', () => {
    clearTimeout(timeout);
    resolve();
  });
});

// Clean up temp files
try {
  unlinkSync(scScriptPath);
} catch { }

// Verify output file
if (existsSync(outputPath)) {
  const stats = await import('fs').then(fs => fs.promises.stat(outputPath));
  console.log(`Success! Output: ${outputPath} (${(stats.size / 1024).toFixed(1)} KB)`);
} else {
  console.error('Warning: Output file was not created');
  process.exit(1);
}

process.exit(0);
