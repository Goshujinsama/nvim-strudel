#!/usr/bin/env node
/**
 * Simple pattern test runner for nvim-strudel
 * 
 * Usage:
 *   node test-pattern.mjs [options] <pattern-file> [duration-seconds]
 * 
 * Options:
 *   --osc              Use OSC output (SuperDirt) instead of WebAudio
 *   --verbose          Enable verbose OSC message logging
 *   --record <path>    Record WebAudio output to WAV file (offline rendering)
 *   --osc-score <path> Capture OSC messages to score file for NRT rendering
 *   --render-nrt       After capturing OSC score, render it to WAV using scsynth -N
 *   --help             Show this help message
 * 
 * Examples:
 *   # Test with WebAudio (default)
 *   node test-pattern.mjs path/to/pattern.strudel 10
 * 
 *   # Test with OSC/SuperDirt (auto-starts SuperCollider/SuperDirt)
 *   node test-pattern.mjs --osc path/to/pattern.strudel 10
 * 
 *   # Record WebAudio to WAV file (offline rendering - faster than real-time)
 *   node test-pattern.mjs --record output.wav path/to/pattern.strudel 10
 * 
 *   # Capture OSC to score file for NRT rendering
 *   node test-pattern.mjs --osc-score score.osc path/to/pattern.strudel 10
 * 
 *   # Capture OSC and automatically render to WAV
 *   node test-pattern.mjs --osc-score score.osc --render-nrt path/to/pattern.strudel 10
 * 
 *   # Pipe pattern code directly
 *   echo 's("bd sd")' | node test-pattern.mjs - 5
 *   echo 's("bd sd")' | node test-pattern.mjs --record output.wav - 5
 * 
 * Default duration is 10 seconds.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, basename } from 'path';

// Parse arguments
const args = process.argv.slice(2);
let patternFile = null;
let duration = 10;
let useOsc = false;
let verbose = false;
let recordPath = null;
let oscScorePath = null;
let renderNrt = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--osc') {
    useOsc = true;
  } else if (arg === '--verbose') {
    verbose = true;
  } else if (arg === '--record') {
    recordPath = args[++i];
    if (!recordPath) {
      console.error('--record requires a file path argument');
      process.exit(1);
    }
  } else if (arg === '--osc-score') {
    oscScorePath = args[++i];
    if (!oscScorePath) {
      console.error('--osc-score requires a file path argument');
      process.exit(1);
    }
  } else if (arg === '--render-nrt') {
    renderNrt = true;
  } else if (arg === '--help' || arg === '-h') {
    console.log(`Usage: node test-pattern.mjs [options] <pattern-file> [duration-seconds]

Options:
  --osc              Use OSC output (SuperDirt) - auto-starts SuperCollider/SuperDirt
  --verbose          Enable verbose OSC message logging
  --record <path>    Record WebAudio output to WAV file (offline rendering)
  --osc-score <path> Capture OSC messages to score file for NRT rendering
  --render-nrt       After capturing OSC score, render it to WAV using scsynth -N
  --help             Show this help message

Examples:
  # Test with WebAudio (default)
  node test-pattern.mjs path/to/pattern.strudel 10

  # Test with OSC/SuperDirt (auto-starts SuperCollider/SuperDirt)
  node test-pattern.mjs --osc path/to/pattern.strudel 10

  # Record WebAudio to WAV file (offline rendering - faster than real-time)
  node test-pattern.mjs --record output.wav path/to/pattern.strudel 10

  # Capture OSC to score file for NRT rendering
  node test-pattern.mjs --osc-score score.osc path/to/pattern.strudel 10

  # Capture OSC and automatically render to WAV
  node test-pattern.mjs --osc-score score.osc --render-nrt path/to/pattern.strudel 10

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

// Import file writer for recording functionality
const { 
  setFileWriteMode, 
  startRecording, 
  stopRecording, 
  renderOscScoreToWav,
  writeWavFile,
} = await import('./dist/file-writer.js');

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

// Determine file write mode
const fileWriteMode = (recordPath && oscScorePath) ? 'both' 
  : recordPath ? 'webaudio'
  : oscScorePath ? 'osc'
  : 'none';

if (fileWriteMode !== 'none') {
  setFileWriteMode(fileWriteMode, {
    webaudioOutputPath: recordPath,
    oscScorePath: oscScorePath,
  });
}

console.log('Creating Strudel engine...');
const engine = new StrudelEngine({ output: useOsc ? 'osc' : 'webaudio' });

// Wait for engine initialization
await new Promise(r => setTimeout(r, 2000));

// Track SuperDirt launcher for cleanup
let superDirtLauncher = null;

// Enable OSC mode if requested (for real-time playback) OR if recording OSC
if (useOsc || oscScorePath) {
  const { setOscDebug, getOscPort } = await import('./dist/osc-output.js');
  
  // Only start SuperDirt if we're doing real-time OSC playback
  if (useOsc) {
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
    const envCurve = process.env.STRUDEL_ENVELOPE_CURVE ? parseFloat(process.env.STRUDEL_ENVELOPE_CURVE) : undefined;
    try {
      const enabled = await engine.enableOsc({
        remoteIp: '127.0.0.1',
        remotePort: 57120,
        envelopeCurve: envCurve,
      });
      if (!enabled) throw new Error('Failed to enable native OSC output');
      enableOscSampleLoading(getOscPort());

      console.log('Native OSC mode enabled - all audio processing is in SuperCollider');
    } catch (e) {
      console.error(`Failed to connect to SuperDirt: ${e.message}`);
      if (superDirtLauncher) superDirtLauncher.stop();
      engine.dispose();
      process.exit(1);
    }
  }
  
  if (verbose) {
    setOscDebug(true);
    console.log('Verbose OSC logging enabled');
  }
}

// Start recording if capturing to file
if (fileWriteMode !== 'none') {
  startRecording();
  console.log(`Recording enabled: ${fileWriteMode} mode`);
}

console.log('Evaluating pattern...');
const result = await engine.eval(code);
if (!result.success) {
  console.error(`Evaluation error: ${result.error}`);
  if (superDirtLauncher) superDirtLauncher.stop();
  engine.dispose();
  process.exit(1);
}

// Build mode description string
const modeStr = useOsc ? 'OSC/SuperDirt' 
  : recordPath ? 'WebAudio (recording)'
  : 'WebAudio';

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

// Stop recording and finalize files
if (fileWriteMode !== 'none') {
  console.log('Finalizing recording...');
  const recordingResult = await stopRecording();
  
  if (recordingResult.oscScoreFile) {
    console.log(`OSC score written: ${recordingResult.oscScoreFile}`);
    
    // Render to WAV using scsynth -N if requested
    if (renderNrt) {
      const wavPath = oscScorePath.replace(/\.osc$/, '.wav');
      console.log(`Rendering OSC score to WAV: ${wavPath}`);
      try {
        await renderOscScoreToWav(recordingResult.oscScoreFile, wavPath, {
          sampleRate: 44100,
          numChannels: 2,
        });
        console.log(`NRT render complete: ${wavPath}`);
      } catch (e) {
        console.error(`NRT render failed: ${e.message}`);
        console.log('You can manually render with:');
        console.log(`  scsynth -N ${recordingResult.oscScoreFile} _ ${wavPath} 44100 WAV int16 -o 2`);
      }
    }
  }
  
  if (recordingResult.webaudioFile) {
    console.log(`WebAudio WAV written: ${recordingResult.webaudioFile}`);
  }
}

engine.dispose();

// Stop SuperDirt if we started it
if (superDirtLauncher) {
  console.log('Stopping SuperDirt...');
  superDirtLauncher.stop();
}

console.log('Done');
process.exit(0);
