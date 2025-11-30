import * as nodeWebAudio from 'node-web-audio-api';
Object.assign(globalThis, nodeWebAudio);

console.log('Before superdough import:');
console.log('AudioContext.prototype.createReverb:', typeof AudioContext.prototype.createReverb);

// Import superdough which should add createReverb
import { getAudioContext } from 'superdough';

console.log('After superdough import:');
console.log('AudioContext.prototype.createReverb:', typeof AudioContext.prototype.createReverb);

const ctx = getAudioContext();
console.log('ctx.createReverb:', typeof ctx.createReverb);
console.log('ctx.constructor.name:', ctx.constructor.name);
console.log('ctx.constructor.prototype.createReverb:', typeof ctx.constructor.prototype.createReverb);
