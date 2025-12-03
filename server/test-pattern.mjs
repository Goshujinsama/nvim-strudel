#!/usr/bin/env node
/**
 * Simple pattern test runner for nvim-strudel
 * 
 * Usage:
 *   node test-pattern.mjs <pattern-file> [duration-seconds]
 *   node test-pattern.mjs path/to/pattern.strudel 10
 * 
 * Or pipe pattern code directly:
 *   echo 's("bd sd")' | node test-pattern.mjs - 5
 * 
 * Default duration is 10 seconds.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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

const { StrudelEngine } = await import('./dist/strudel-engine.js');

// Parse arguments
const args = process.argv.slice(2);
let patternFile = args[0];
let duration = parseInt(args[1]) || 10;

if (!patternFile) {
  console.error('Usage: node test-pattern.mjs <pattern-file> [duration-seconds]');
  console.error('       node test-pattern.mjs - [duration-seconds]  # read from stdin');
  process.exit(1);
}

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

console.log('Evaluating pattern...');
try {
  await engine.eval(code);
} catch (e) {
  console.error(`Evaluation error: ${e.message}`);
  engine.dispose();
  process.exit(1);
}

console.log(`Playing for ${duration} seconds...`);
engine.play();

// Play for specified duration
await new Promise(r => setTimeout(r, duration * 1000));

console.log('Stopping...');
engine.stop();
engine.dispose();

console.log('Done');
process.exit(0);
