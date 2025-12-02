// Test with many simultaneous voices
import { initAudioPolyfill } from './dist/audio-polyfill.js';
initAudioPolyfill();

const { StrudelEngine } = await import('./dist/strudel-engine.js');

console.log('Creating engine...');
const engine = new StrudelEngine();
await new Promise(r => setTimeout(r, 2000));

// Pattern with many overlapping voices (like in worklet_test.strudel)
// The .apply() creates 2 copies, combined with long legato = many active nodes
console.log('\nTesting pattern with many overlapping voices...');

await engine.eval(`
s("sine").legato(4).fast(8)
  .apply(p => stack(
    p,
    p.add(note(0.1)),
    p.add(note(-0.1)),
    p.add(note(7)),
    p.add(note(12))
  ))
`);

engine.play();

// Monitor for 15 seconds
for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const mem = process.memoryUsage();
  console.log(`${i+1}s - Memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
}

engine.stop();
console.log('\nDone');
engine.dispose();
process.exit(0);
