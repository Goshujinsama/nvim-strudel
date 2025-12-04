#!/usr/bin/env node
/**
 * Simple pattern test runner for nvim-strudel
 * 
 * Usage:
 *   node test-pattern.mjs [options] <pattern-file> [duration-seconds]
 * 
 * Options:
 *   --osc           Use OSC output (SuperDirt) instead of WebAudio
 *   --verbose       Enable verbose OSC message logging
 *   --help          Show this help message
 * 
 * Examples:
 *   # Test with WebAudio (default)
 *   node test-pattern.mjs path/to/pattern.strudel 10
 * 
 *   # Test with OSC/SuperDirt (auto-starts SuperCollider/SuperDirt)
 *   node test-pattern.mjs --osc path/to/pattern.strudel 10
 * 
 *   # Test with OSC and verbose logging
 *   node test-pattern.mjs --osc --verbose path/to/pattern.strudel 10
 * 
 *   # Pipe pattern code directly
 *   echo 's("bd sd")' | node test-pattern.mjs - 5
 *   echo 's("bd sd")' | node test-pattern.mjs --osc - 5
 * 
 * Default duration is 10 seconds.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Parse arguments
const args = process.argv.slice(2);
let patternFile = null;
let duration = 10;
let useOsc = false;
let verbose = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--osc') {
    useOsc = true;
  } else if (arg === '--verbose') {
    verbose = true;
  } else if (arg === '--help' || arg === '-h') {
    console.log(`Usage: node test-pattern.mjs [options] <pattern-file> [duration-seconds]

Options:
  --osc           Use OSC output (SuperDirt) - auto-starts SuperCollider/SuperDirt
  --verbose       Enable verbose OSC message logging
  --help          Show this help message

Examples:
  # Test with WebAudio (default)
  node test-pattern.mjs path/to/pattern.strudel 10

  # Test with OSC/SuperDirt (auto-starts SuperCollider/SuperDirt)
  node test-pattern.mjs --osc path/to/pattern.strudel 10

  # Test with OSC and verbose logging
  node test-pattern.mjs --osc --verbose path/to/pattern.strudel 10

  # Pipe pattern code directly
  echo 's("bd sd")' | node test-pattern.mjs - 5

Default duration is 10 seconds.`);
    process.exit(0);
  } else if (!patternFile) {
    patternFile = arg;
  } else {
    const parsed = parseInt(arg);
    if (!isNaN(parsed)) {
      duration = parsed;
    }
  }
}

if (!patternFile) {
  console.error('Usage: node test-pattern.mjs [options] <pattern-file> [duration-seconds]');
  console.error('       node test-pattern.mjs --help  # for more info');
  process.exit(1);
}

// Kill any existing strudel-server processes
try {
  execSync('pkill -f "node.*strudel-server\\|node.*dist/index.js" 2>/dev/null || true', { stdio: 'ignore' });
  // Give processes time to die
  await new Promise(r => setTimeout(r, 500));
} catch (e) {
  // Ignore errors - no processes to kill
}

// Initialize audio polyfill BEFORE importing engine
import { initAudioPolyfill } from './dist/audio-polyfill.js';
initAudioPolyfill();

const { StrudelEngine, enableOscSampleLoading } = await import('./dist/strudel-engine.js');

// Read pattern code
let code;
if (patternFile === '-') {
  // Read from stdin
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

console.log('Creating Strudel engine...');
const engine = new StrudelEngine();

// Wait for engine initialization
await new Promise(r => setTimeout(r, 2000));

// Track SuperDirt launcher for cleanup
let superDirtLauncher = null;

// Enable OSC mode if requested
if (useOsc) {
  const { initOsc, setOscDebug, getOscPort } = await import('./dist/osc-output.js');
  const { SuperDirtLauncher } = await import('./dist/superdirt-launcher.js');
  
  // Check if SuperCollider is available
  if (!SuperDirtLauncher.isSclangAvailable()) {
    console.error('SuperCollider (sclang) not found. Please install SuperCollider first.');
    console.error('On Arch Linux: sudo pacman -S supercollider');
    console.error('On Ubuntu/Debian: sudo apt install supercollider');
    engine.dispose();
    process.exit(1);
  }
  
  // Start SuperDirt
  console.log('Starting SuperCollider/SuperDirt...');
  superDirtLauncher = new SuperDirtLauncher({ verbose });
  
  try {
    await superDirtLauncher.start();
    console.log('SuperDirt started successfully');
  } catch (e) {
    console.error(`Failed to start SuperDirt: ${e.message}`);
    engine.dispose();
    process.exit(1);
  }
  
  // Initialize OSC connection
  console.log('Initializing OSC connection to SuperDirt...');
  try {
    await initOsc('127.0.0.1', 57120);
    const oscPort = getOscPort();
    enableOscSampleLoading(oscPort);
    engine.enableOsc('127.0.0.1', 57120);
    
    if (verbose) {
      setOscDebug(true);
      console.log('Verbose OSC logging enabled');
    }
    
    console.log('OSC mode enabled - sending to SuperDirt on port 57120');
  } catch (e) {
    console.error(`Failed to connect to SuperDirt: ${e.message}`);
    if (superDirtLauncher) superDirtLauncher.stop();
    engine.dispose();
    process.exit(1);
  }
}

console.log('Evaluating pattern...');
const result = await engine.eval(code);
if (!result.success) {
  console.error(`Evaluation error: ${result.error}`);
  if (superDirtLauncher) superDirtLauncher.stop();
  engine.dispose();
  process.exit(1);
}

const modeStr = useOsc ? 'OSC/SuperDirt' : 'WebAudio';
console.log(`Playing for ${duration} seconds via ${modeStr}...`);
const started = engine.play();
if (!started) {
  console.error('No pattern to play');
  if (superDirtLauncher) superDirtLauncher.stop();
  engine.dispose();
  process.exit(1);
}

// Play for specified duration
await new Promise(r => setTimeout(r, duration * 1000));

console.log('Stopping...');
engine.stop();
engine.dispose();

// Stop SuperDirt if we started it
if (superDirtLauncher) {
  console.log('Stopping SuperDirt...');
  superDirtLauncher.stop();
}

console.log('Done');
process.exit(0);
