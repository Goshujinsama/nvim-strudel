#!/usr/bin/env node
/**
 * Compare audio output between WebAudio and SuperCollider backends
 * 
 * Usage:
 *   node compare-backends.mjs [pattern] [duration]
 *   node compare-backends.mjs --all              # Run all default test patterns
 *   node compare-backends.mjs "s('bd sd')" 2     # Test specific pattern
 * 
 * Examples:
 *   node compare-backends.mjs --all
 *   node compare-backends.mjs 'note("c4").s("saw").release(0.01)' 2
 *   node compare-backends.mjs 's("bd sd hh sd")' 4
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, 'tmp');
const PYTHON_VENV = join(__dirname, '.venv', 'bin', 'python');
const COMPARE_SCRIPT = join(__dirname, 'compare-audio.py');

// Default test patterns for --all mode
const DEFAULT_PATTERNS = [
  { name: 'sine', pattern: 'note("c4").s("sine").release(0.01)', duration: 2 },
  { name: 'saw', pattern: 'note("c4").s("saw").release(0.01)', duration: 2 },
  { name: 'square', pattern: 'note("c4").s("square").release(0.01)', duration: 2 },
  { name: 'triangle', pattern: 'note("c4").s("triangle").release(0.01)', duration: 2 },
  { name: 'white', pattern: 's("white").release(0.01)', duration: 2 },
  { name: 'pink', pattern: 's("pink").release(0.01)', duration: 2 },
  { name: 'brown', pattern: 's("brown").release(0.01)', duration: 2 },
  { name: 'saw-lpf', pattern: 'note("c4").s("saw").lpf(500).release(0.01)', duration: 2 },
  { name: 'white-hpf', pattern: 's("white").hpf(2000).release(0.01)', duration: 2 },
];

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) {
    mkdirSync(TMP_DIR, { recursive: true });
  }
}

function killSuperCollider() {
  try {
    execSync('pkill -f "sclang|scsynth" 2>/dev/null', { stdio: 'ignore' });
  } catch (e) {
    // Ignore errors - process may not exist
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function renderWebAudio(pattern, outputPath, duration) {
  const patternFile = join(TMP_DIR, 'pattern-wa.strudel');
  writeFileSync(patternFile, pattern);
  
  try {
    execSync(
      `node render-pattern.mjs "${patternFile}" "${outputPath}" ${duration}`,
      { cwd: __dirname, stdio: 'pipe', timeout: 60000 }
    );
    return true;
  } catch (e) {
    console.error(`  WebAudio render failed: ${e.message}`);
    return false;
  } finally {
    try { unlinkSync(patternFile); } catch (e) {}
  }
}

async function renderSuperCollider(pattern, outputPath, duration) {
  const patternFile = join(TMP_DIR, 'pattern-sc.strudel');
  writeFileSync(patternFile, pattern);
  
  // Kill any existing SC processes
  killSuperCollider();
  await sleep(2000);
  
  try {
    execSync(
      `node render-pattern-sc.mjs "${patternFile}" "${outputPath}" ${duration}`,
      { cwd: __dirname, stdio: 'pipe', timeout: 120000 }
    );
    return true;
  } catch (e) {
    console.error(`  SuperCollider render failed: ${e.message}`);
    return false;
  } finally {
    try { unlinkSync(patternFile); } catch (e) {}
    killSuperCollider();
  }
}

function parseComparisonOutput(output) {
  // Extract key metrics from compare-audio.py output
  const rmsMatch = output.match(/RMS \(dB\)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+([+-]?[\d.]+)/);
  const peakMatch = output.match(/Peak \(dB\)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+([+-]?[\d.]+)/);
  const similarityMatch = output.match(/Similarity Score:\s+([\d.]+)/);
  
  if (!rmsMatch && !peakMatch && !similarityMatch) {
    return null; // No valid data found
  }
  
  return {
    success: true,
    waRms: rmsMatch ? parseFloat(rmsMatch[1]) : null,
    scRms: rmsMatch ? parseFloat(rmsMatch[2]) : null,
    rmsDiff: rmsMatch ? parseFloat(rmsMatch[3]) : null,
    waPeak: peakMatch ? parseFloat(peakMatch[1]) : null,
    scPeak: peakMatch ? parseFloat(peakMatch[2]) : null,
    peakDiff: peakMatch ? parseFloat(peakMatch[3]) : null,
    similarity: similarityMatch ? parseFloat(similarityMatch[1]) : null,
    fullOutput: output,
  };
}

function compareAudio(waFile, scFile) {
  // Check if Python venv exists
  const pythonCmd = existsSync(PYTHON_VENV) ? PYTHON_VENV : 'python3';
  const cmd = `"${pythonCmd}" "${COMPARE_SCRIPT}" "${waFile}" "${scFile}" --align --trim`;
  
  try {
    const output = execSync(cmd, { 
      cwd: __dirname, 
      encoding: 'utf-8', 
      timeout: 30000,
      shell: '/bin/bash',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    return parseComparisonOutput(output) || { success: false, error: 'No metrics found in output' };
  } catch (e) {
    // compare-audio.py exits with non-zero codes to indicate comparison results:
    //   exit 0 = files are similar
    //   exit 1 = issues detected (differences found)
    //   exit 2 = files are very different
    // The stdout still contains valid comparison data, so parse it
    if (e.stdout) {
      const output = e.stdout.toString();
      const result = parseComparisonOutput(output);
      if (result) {
        return result;
      }
    }
    
    // Real error (e.g., file not found, Python crash)
    return { 
      success: false, 
      error: e.message, 
      stderr: e.stderr?.toString() 
    };
  }
}

async function testPattern(name, pattern, duration) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${name}`);
  console.log(`Pattern: ${pattern}`);
  console.log(`Duration: ${duration}s`);
  console.log('='.repeat(60));
  
  const waFile = join(TMP_DIR, `${name}-wa.wav`);
  const scFile = join(TMP_DIR, `${name}-sc.wav`);
  
  // Render WebAudio
  process.stdout.write('  Rendering WebAudio... ');
  const waSuccess = await renderWebAudio(pattern, waFile, duration);
  console.log(waSuccess ? 'OK' : 'FAILED');
  if (!waSuccess) return { name, success: false, error: 'WebAudio render failed' };
  
  // Render SuperCollider
  process.stdout.write('  Rendering SuperCollider... ');
  const scSuccess = await renderSuperCollider(pattern, scFile, duration);
  console.log(scSuccess ? 'OK' : 'FAILED');
  if (!scSuccess) return { name, success: false, error: 'SuperCollider render failed' };
  
  // Compare
  process.stdout.write('  Comparing... ');
  const result = compareAudio(waFile, scFile);
  console.log(result.success ? 'OK' : 'FAILED');
  
  if (result.success) {
    console.log(`\n  Results:`);
    console.log(`    RMS:  WA=${result.waRms?.toFixed(1)}dB  SC=${result.scRms?.toFixed(1)}dB  Diff=${result.rmsDiff >= 0 ? '+' : ''}${result.rmsDiff?.toFixed(1)}dB`);
    console.log(`    Peak: WA=${result.waPeak?.toFixed(1)}dB  SC=${result.scPeak?.toFixed(1)}dB  Diff=${result.peakDiff >= 0 ? '+' : ''}${result.peakDiff?.toFixed(1)}dB`);
    console.log(`    Similarity: ${result.similarity?.toFixed(1)}/100`);
  }
  
  return { name, ...result };
}

async function main() {
  const args = process.argv.slice(2);
  
  ensureTmpDir();
  
  let patterns = [];
  
  if (args.length === 0 || args[0] === '--all') {
    // Run all default patterns
    patterns = DEFAULT_PATTERNS;
  } else if (args[0] === '--help' || args[0] === '-h') {
    console.log(`
Usage:
  node compare-backends.mjs [options]
  node compare-backends.mjs <pattern> [duration]

Options:
  --all       Run all default test patterns
  --help, -h  Show this help message

Examples:
  node compare-backends.mjs --all
  node compare-backends.mjs 'note("c4").s("saw").release(0.01)' 2
  node compare-backends.mjs 's("bd sd hh sd")' 4
`);
    process.exit(0);
  } else {
    // Single pattern mode
    const pattern = args[0];
    const duration = parseFloat(args[1]) || 2;
    patterns = [{ name: 'custom', pattern, duration }];
  }
  
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         WebAudio vs SuperCollider Backend Comparison       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nTesting ${patterns.length} pattern(s)...`);
  
  const results = [];
  for (const { name, pattern, duration } of patterns) {
    const result = await testPattern(name, pattern, duration);
    results.push(result);
  }
  
  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log('\nPattern          RMS Diff    Peak Diff   Similarity');
  console.log('-'.repeat(55));
  
  for (const r of results) {
    if (r.success) {
      const rmsDiff = r.rmsDiff >= 0 ? `+${r.rmsDiff.toFixed(1)}` : r.rmsDiff.toFixed(1);
      const peakDiff = r.peakDiff >= 0 ? `+${r.peakDiff.toFixed(1)}` : r.peakDiff.toFixed(1);
      console.log(
        `${r.name.padEnd(16)} ${rmsDiff.padStart(8)}dB  ${peakDiff.padStart(8)}dB   ${r.similarity?.toFixed(1).padStart(5)}/100`
      );
    } else {
      console.log(`${r.name.padEnd(16)} FAILED: ${r.error}`);
    }
  }
  
  // Check if all patterns are within acceptable tolerance
  const rmsDiffs = results.filter(r => r.success && r.rmsDiff != null).map(r => r.rmsDiff);
  if (rmsDiffs.length > 0) {
    const avgRmsDiff = rmsDiffs.reduce((a, b) => a + b, 0) / rmsDiffs.length;
    const maxRmsVariance = Math.max(...rmsDiffs) - Math.min(...rmsDiffs);
    
    console.log('\n' + '-'.repeat(55));
    console.log(`Average RMS diff: ${avgRmsDiff >= 0 ? '+' : ''}${avgRmsDiff.toFixed(1)}dB`);
    console.log(`RMS variance: ${maxRmsVariance.toFixed(1)}dB (max spread between patterns)`);
    
    if (maxRmsVariance <= 1.0) {
      console.log('\n✓ All patterns are well-matched (variance ≤ 1dB)');
    } else {
      console.log('\n⚠ Some patterns may need adjustment (variance > 1dB)');
    }
  }
  
  // Cleanup
  killSuperCollider();
}

main().catch(console.error);
