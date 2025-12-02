// Long-running test to catch gradual degradation
import { initAudioPolyfill } from './dist/audio-polyfill.js';
initAudioPolyfill();

const { StrudelEngine } = await import('./dist/strudel-engine.js');

console.log('Creating engine...');
const engine = new StrudelEngine();
await new Promise(r => setTimeout(r, 3000));

const code = `
const __midicps = d => Math.pow(2, (d-69)/12) * 440
const midicps = register('midicps', p => p.add(0).fmap(__midicps))
const pull = register('pull', (k, p) => p.fmap(e => e[k]))
const lph = register('lph', (h, p) => p.lpf(p.pull('note').midicps().mul(reify(h))))
setcps(200/(4*60))
const root = 2
all(p => p.mul(postgain(0.7)))

$: note("<[3@7 <-3 6>] [2@7 0]>/2".add(root + 12*6)).s("gm_voice_oohs:3").legato(1)
  .adsr("0.7:2.5:0:2.5").lph(tri.slow(9).range(2,8)).shape(0.7)
  .tremolosync(16).tremoloshape("tri").tremoloskew(0.1).postgain(0.5)
  .apply(p => stack(...[-1,1].map(x => p.add(note("0.12".mul(x))).pan((x*0.4+1)*0.5))))
  .mask("<1 [1@7 0] 1 1 1 1 1 1>/4")
`;

await engine.eval(code);
engine.play();

console.log('Playing for 3 minutes - monitoring every 10s...\n');
console.log('Time    | Heap MB | RSS MB  | External MB');
console.log('--------|---------|---------|------------');

for (let i = 0; i < 18; i++) {  // 3 minutes
  await new Promise(r => setTimeout(r, 10000));
  const mem = process.memoryUsage();
  const time = `${Math.floor((i+1)*10/60)}:${String((i+1)*10 % 60).padStart(2,'0')}`;
  console.log(`${time}    | ${String(Math.round(mem.heapUsed/1024/1024)).padStart(7)} | ${String(Math.round(mem.rss/1024/1024)).padStart(7)} | ${String(Math.round(mem.external/1024/1024)).padStart(7)}`);
}

engine.stop();
engine.dispose();
process.exit(0);
