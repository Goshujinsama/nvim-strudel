/**
 * Node.js-compatible AudioWorklet processors for superdough
 * 
 * This file contains all the processor classes from superdough's worklets.mjs,
 * adapted to work with node-web-audio-api's AudioWorklet implementation.
 * 
 * The processors are registered using the standard Web Audio API registerProcessor() function.
 */

// Utility functions
const clamp = (num, min, max) => Math.min(Math.max(num, min), max);
const mod = (n, m) => ((n % m) + m) % m;
const lerp = (a, b, n) => n * (b - a) + a;
const frac = (x) => x - Math.floor(x);
const _PI = Math.PI;
const blockSize = 128;

// Waveshapes for LFO
const waveshapes = {
  tri(phase, skew = 0.5) {
    const x = 1 - skew;
    if (phase >= skew) {
      return 1 / x - phase / x;
    }
    return phase / skew;
  },
  sine(phase) {
    return Math.sin(Math.PI * 2 * phase) * 0.5 + 0.5;
  },
  ramp(phase) {
    return phase;
  },
  saw(phase) {
    return 1 - phase;
  },
  square(phase, skew = 0.5) {
    if (phase >= skew) {
      return 0;
    }
    return 1;
  },
};
const waveShapeNames = Object.keys(waveshapes);

// Distortion algorithms
const __squash = (x) => x / (1 + x);
const _scurve = (x, k) => ((1 + k) * x) / (1 + k * Math.abs(x));
const _soft = (x, k) => Math.tanh(x * (1 + k));
const _hard = (x, k) => clamp((1 + k) * x, -1, 1);
const _fold = (x, k) => {
  let y = (1 + 0.5 * k) * x;
  const window = mod(y + 1, 4);
  return 1 - Math.abs(window - 2);
};
const _sineFold = (x, k) => Math.sin((Math.PI / 2) * _fold(x, k));
const _cubic = (x, k) => {
  const t = __squash(Math.log1p(k));
  const cubic = (x - (t / 3) * x * x * x) / (1 - t / 3);
  return _soft(cubic, k);
};
const _diode = (x, k, asym = false) => {
  const g = 1 + 2 * k;
  const t = __squash(Math.log1p(k));
  const bias = 0.07 * t;
  const pos = _soft(x + bias, 2 * k);
  const neg = _soft(asym ? bias : -x + bias, 2 * k);
  const y = pos - neg;
  const sech = 1 / Math.cosh(g * bias);
  const sech2 = sech * sech;
  const denom = Math.max(1e-8, (asym ? 1 : 2) * g * sech2);
  return _soft(y / denom, k);
};
const _asym = (x, k) => _diode(x, k, true);
const _chebyshev = (x, k) => {
  const kl = 10 * Math.log1p(k);
  let tnm1 = 1;
  let tnm2 = x;
  let tn;
  let y = 0;
  for (let i = 1; i < 64; i++) {
    if (i < 2) {
      y += i == 0 ? tnm1 : tnm2;
      continue;
    }
    tn = 2 * x * tnm1 - tnm2;
    tnm2 = tnm1;
    tnm1 = tn;
    if (i % 2 === 0) {
      y += Math.min((1.3 * kl) / i, 2) * tn;
    }
  }
  return _soft(y, kl / 20);
};

const distortionAlgorithms = {
  scurve: _scurve,
  soft: _soft,
  hard: _hard,
  cubic: _cubic,
  diode: _diode,
  asym: _asym,
  fold: _fold,
  sinefold: _sineFold,
  chebyshev: _chebyshev,
};
const _algoNames = Object.keys(distortionAlgorithms);

function getDistortionAlgorithm(algo) {
  let index = typeof algo === 'string' ? _algoNames.indexOf(algo) : algo;
  if (index === -1) index = 0;
  const name = _algoNames[index % _algoNames.length];
  return distortionAlgorithms[name];
}

// Fast tanh for ladder filter
function fast_tanh(x) {
  const x2 = x * x;
  return (x * (27.0 + x2)) / (27.0 + 9.0 * x2);
}

// Two-pole filter for DJF
class TwoPoleFilter {
  constructor() {
    this.s0 = 0;
    this.s1 = 0;
  }
  
  update(s, cutoff, resonance = 0, sampleRate) {
    resonance = clamp(resonance, 0, 1);
    cutoff = clamp(cutoff, 0, sampleRate / 2 - 1);
    const c = clamp(2 * Math.sin(cutoff * (_PI / sampleRate)), 0, 1.14);
    const r = Math.pow(0.5, (resonance + 0.125) / 0.125);
    const mrc = 1 - r * c;
    this.s0 = mrc * this.s0 - c * this.s1 + c * s;
    this.s1 = mrc * this.s1 + c * this.s0;
    return this.s1;
  }
}

// ============================================================================
// Shape Processor - Waveshaping distortion with postgain
// ============================================================================
class ShapeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'shape', defaultValue: 0 },
      { name: 'postgain', defaultValue: 1 },
    ];
  }

  constructor() {
    super();
    this.started = false;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || !input[0]) {
      if (this.started) return false;
      return true;
    }
    this.started = true;

    let shape = parameters.shape[0];
    shape = shape < 1 ? shape : 1.0 - 4e-10;
    shape = (2.0 * shape) / (1.0 - shape);
    const postgain = Math.max(0.001, Math.min(1, parameters.postgain[0]));

    for (let n = 0; n < blockSize; n++) {
      for (let i = 0; i < input.length; i++) {
        if (output[i] && input[i]) {
          output[i][n] = (((1 + shape) * input[i][n]) / (1 + shape * Math.abs(input[i][n]))) * postgain;
        }
      }
    }
    return true;
  }
}

// ============================================================================
// Coarse Processor - Sample rate reduction
// ============================================================================
class CoarseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'coarse', defaultValue: 1 }];
  }

  constructor() {
    super();
    this.started = false;
    this.lastSample = [0, 0];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || !input[0]) {
      if (this.started) return false;
      return true;
    }
    this.started = true;

    let coarse = parameters.coarse[0] ?? 0;
    coarse = Math.max(1, coarse);
    
    for (let n = 0; n < blockSize; n++) {
      for (let i = 0; i < input.length; i++) {
        if (output[i] && input[i]) {
          if (n % coarse === 0) {
            this.lastSample[i] = input[i][n];
          }
          output[i][n] = this.lastSample[i];
        }
      }
    }
    return true;
  }
}

// ============================================================================
// Crush Processor - Bit crushing
// ============================================================================
class CrushProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'crush', defaultValue: 0 }];
  }

  constructor() {
    super();
    this.started = false;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || !input[0]) {
      if (this.started) return false;
      return true;
    }
    this.started = true;

    let crush = parameters.crush[0] ?? 8;
    crush = Math.max(1, crush);

    for (let n = 0; n < blockSize; n++) {
      for (let i = 0; i < input.length; i++) {
        if (output[i] && input[i]) {
          const x = Math.pow(2, crush - 1);
          output[i][n] = Math.round(input[i][n] * x) / x;
        }
      }
    }
    return true;
  }
}

// ============================================================================
// DJF Processor - DJ-style filter
// ============================================================================
class DJFProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'value', defaultValue: 0.5 }];
  }

  constructor() {
    super();
    this.started = false;
    this.filters = [new TwoPoleFilter(), new TwoPoleFilter()];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || !input[0]) return true;
    this.started = true;

    const value = clamp(parameters.value[0], 0, 1);
    let filterType = 'none';
    let cutoff;
    let v = 1;
    
    if (value > 0.51) {
      filterType = 'hipass';
      v = (value - 0.5) * 2;
    } else if (value < 0.49) {
      filterType = 'lopass';
      v = value * 2;
    }
    cutoff = Math.pow(v * 11, 4);

    for (let i = 0; i < input.length; i++) {
      for (let n = 0; n < blockSize; n++) {
        if (output[i] && input[i]) {
          if (filterType === 'none') {
            output[i][n] = input[i][n];
          } else {
            this.filters[i].update(input[i][n], cutoff, 0.1, sampleRate);
            if (filterType === 'lopass') {
              output[i][n] = this.filters[i].s1;
            } else if (filterType === 'hipass') {
              output[i][n] = input[i][n] - this.filters[i].s1;
            } else {
              output[i][n] = input[i][n];
            }
          }
        }
      }
    }
    return true;
  }
}

// ============================================================================
// Ladder Processor - Moog-style ladder filter
// ============================================================================
class LadderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 500 },
      { name: 'q', defaultValue: 1 },
      { name: 'drive', defaultValue: 0.69 },
    ];
  }

  constructor() {
    super();
    this.started = false;
    this.p0 = [0, 0];
    this.p1 = [0, 0];
    this.p2 = [0, 0];
    this.p3 = [0, 0];
    this.p32 = [0, 0];
    this.p33 = [0, 0];
    this.p34 = [0, 0];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || !input[0]) {
      if (this.started) return false;
      return true;
    }
    this.started = true;

    const resonance = parameters.q[0];
    const drive = clamp(Math.exp(parameters.drive[0]), 0.1, 2000);

    let cutoff = parameters.frequency[0];
    cutoff = (cutoff * 2 * _PI) / sampleRate;
    cutoff = cutoff > 1 ? 1 : cutoff;

    const k = Math.min(8, resonance * 0.13);
    let makeupgain = (1 / drive) * Math.min(1.75, 1 + k);

    for (let n = 0; n < blockSize; n++) {
      for (let i = 0; i < input.length; i++) {
        if (output[i] && input[i]) {
          const out = this.p3[i] * 0.360891 + this.p32[i] * 0.41729 + 
                     this.p33[i] * 0.177896 + this.p34[i] * 0.0439725;

          this.p34[i] = this.p33[i];
          this.p33[i] = this.p32[i];
          this.p32[i] = this.p3[i];

          this.p0[i] += (fast_tanh(input[i][n] * drive - k * out) - fast_tanh(this.p0[i])) * cutoff;
          this.p1[i] += (fast_tanh(this.p0[i]) - fast_tanh(this.p1[i])) * cutoff;
          this.p2[i] += (fast_tanh(this.p1[i]) - fast_tanh(this.p2[i])) * cutoff;
          this.p3[i] += (fast_tanh(this.p2[i]) - fast_tanh(this.p3[i])) * cutoff;

          output[i][n] = out * makeupgain;
        }
      }
    }
    return true;
  }
}

// ============================================================================
// Distort Processor - Various distortion algorithms
// ============================================================================
class DistortProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'distort', defaultValue: 0 },
      { name: 'postgain', defaultValue: 1 },
    ];
  }

  constructor(options) {
    super();
    this.started = false;
    this.algorithm = getDistortionAlgorithm(options?.processorOptions?.algorithm ?? 0);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || !input[0]) {
      if (this.started) return false;
      return true;
    }
    this.started = true;

    for (let n = 0; n < blockSize; n++) {
      const postgain = clamp(parameters.postgain[n] ?? parameters.postgain[0], 0.001, 1);
      const shape = Math.expm1(parameters.distort[n] ?? parameters.distort[0]);
      for (let ch = 0; ch < input.length; ch++) {
        if (output[ch] && input[ch]) {
          const x = input[ch][n];
          output[ch][n] = postgain * this.algorithm(x, shape);
        }
      }
    }
    return true;
  }
}

// ============================================================================
// LFO Processor - Low frequency oscillator for modulation
// ============================================================================
class LFOProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'begin', defaultValue: 0 },
      { name: 'time', defaultValue: 0 },
      { name: 'end', defaultValue: 0 },
      { name: 'frequency', defaultValue: 0.5 },
      { name: 'skew', defaultValue: 0.5 },
      { name: 'depth', defaultValue: 1 },
      { name: 'phaseoffset', defaultValue: 0 },
      { name: 'shape', defaultValue: 0 },
      { name: 'curve', defaultValue: 1 },
      { name: 'dcoffset', defaultValue: 0 },
      { name: 'min', defaultValue: 0 },
      { name: 'max', defaultValue: 1 },
    ];
  }

  constructor() {
    super();
    this.phase = null;
  }

  process(inputs, outputs, parameters) {
    const begin = parameters.begin[0];
    if (currentTime >= parameters.end[0]) return false;
    if (currentTime <= begin) return true;

    const output = outputs[0];
    const frequency = parameters.frequency[0];
    const time = parameters.time[0];
    const depth = parameters.depth[0];
    const skew = parameters.skew[0];
    const phaseoffset = parameters.phaseoffset[0];
    const curve = parameters.curve[0];
    const dcoffset = parameters.dcoffset[0];
    const min = parameters.min[0];
    const max = parameters.max[0];
    const shapeIdx = Math.floor(parameters.shape[0]);
    const shapeName = waveShapeNames[shapeIdx] || 'sine';

    const blockLen = output[0]?.length ?? 0;

    if (this.phase === null) {
      this.phase = mod(time * frequency + phaseoffset, 1);
    }
    
    const dt = frequency / sampleRate;
    for (let n = 0; n < blockLen; n++) {
      for (let i = 0; i < output.length; i++) {
        if (output[i]) {
          let modval = (waveshapes[shapeName](this.phase, skew) + dcoffset) * depth;
          modval = Math.pow(modval, curve);
          output[i][n] = clamp(modval, min, max);
        }
      }
      this.phase += dt;
      if (this.phase > 1.0) this.phase -= 1;
    }
    return true;
  }
}

// ============================================================================
// Register all processors
// ============================================================================
registerProcessor('shape-processor', ShapeProcessor);
registerProcessor('coarse-processor', CoarseProcessor);
registerProcessor('crush-processor', CrushProcessor);
registerProcessor('djf-processor', DJFProcessor);
registerProcessor('ladder-processor', LadderProcessor);
registerProcessor('distort-processor', DistortProcessor);
registerProcessor('lfo-processor', LFOProcessor);

// Log registration
console.log('[worklets-node] Registered processors: shape, coarse, crush, djf, ladder, distort, lfo');
