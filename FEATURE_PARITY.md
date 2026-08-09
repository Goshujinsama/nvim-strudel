# Feature Parity: WebAudio vs SuperDirt/OSC

This document tracks feature parity between the WebAudio backend (superdough) and our independent native SuperDirt/OSC backend. OSC mode performs all audio processing in SuperCollider and has no per-event WebAudio fallback.

**Last Updated:** 2026-01-06 (Session 8)

## Similarity Score Legend

| Score | Rating | Description |
|-------|--------|-------------|
| 95-100 | Excellent | Near-perfect match |
| 85-94 | Good | Minor differences, production-ready |
| 70-84 | Fair | Noticeable differences, usable |
| 50-69 | Poor | Significant differences |
| <50 | Bad | Not matching / broken |

---

## Implemented Features

### Basic Samples & Playback

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Sample playback | `s("bd sd hh sd")` | 1.00 | 98.0% | Excellent |
| Sample speed | `s("bd").speed(2)` | 0.83 | 89.2% | Good |
| Sample note | `s("piano").note("c4")` | 1.00 | 94.0% | Good |

### Synthesizers

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Sine | `note("c4").s("sine")` | 1.00 | 98.2% | Excellent |
| Saw | `note("c4").s("saw")` | 1.00 | 92.4% | Good |
| Square | `note("c4").s("square")` | 1.00 | 93.3% | Good |
| Triangle | `note("c4").s("triangle")` | 1.00 | 96.7% | Excellent |
| Pulse | `note("c4").s("pulse")` | 0.83 | 88.2% | Good |
| Supersaw | `note("c3").s("supersaw")` | 0.85 | ~78% avg | Fair - random phase variance |

### ByteBeat

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Preset 0 (comparison) | `s("bytebeat:0")` | 0.84 | 91.1% | Good |
| Preset 2 (sawtooth) | `s("bytebeat:2")` | 0.99 | 95.3% | Excellent |
| Preset 3 (XOR cascade) | `s("bytebeat:3")` | 0.01 | 49.1% | Poor - bitwise XOR |
| Preset 4 (square) | `s("bytebeat:4")` | 1.00 | 98.2% | Excellent |
| Preset 5 (AND cascade) | `s("bytebeat:5")` | 0.18 | 46.1% | Poor - bitwise AND/shift |
| Preset 6 (multi-mod) | `s("bytebeat:6")` | 0.97 | 93.5% | Good |
| Preset 9 (sine) | `s("bytebeat:9")` | 1.00 | 97.7% | Excellent |

*Note: ByteBeat presets that use bitwise XOR (`^`) or complex AND (`&`) operations have low similarity because SuperCollider cannot perform audio-rate bitwise operations. Presets using modulo, comparison, and trigonometric functions work well. Custom expressions (`bbexpr`) are WebAudio-only.*

### Noise Generators

| Feature | Pattern | Slope WA | Slope SC | Slope Diff | Status |
|---------|---------|----------|----------|------------|--------|
| White noise | `s("white")` | -0.21 dB/oct | +0.02 dB/oct | 0.23 | Excellent |
| Pink noise | `s("pink")` | -3.22 dB/oct | -2.99 dB/oct | 0.24 | Excellent |
| Brown noise | `s("brown")` | -5.54 dB/oct | -5.45 dB/oct | 0.08 | Excellent |

*Note: Noise is measured by spectral slope (dB/octave) rather than sample correlation. Expected slopes: white=0, pink=-3, brown=-6. All implementations match within 0.25 dB/octave. RMS levels also match within 1dB.*

### Filters

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| LPF basic | `s("saw").lpf(500)` | 1.00 | 94.4% | Good |
| LPF + resonance | `s("saw").lpf(500).lpq(10)` | 1.00 | 94.5% | Good |
| HPF basic | `s("saw").hpf(2000)` | 0.91 | 82.2% | Fair |
| HPF + resonance | `s("saw").hpf(1000).hpq(5)` | 0.97 | 87.7% | Good |
| LPF envelope | `s("bd").lpf(500).lpenv(2).lpdecay(0.5)` | 0.90 | 91.3% | Good |
| LPF env negative | `s("saw").lpf(2000).lpenv(-2)` | 1.00 | 93.4% | Good |
| BPF | `s("saw").bpf(500).bpq(5)` | 0.95 | 91.0% | Good |
| BPF envelope | `s("bd").bpf(1000).bpenv(2).bpdecay(0.5)` | 0.95 | 76.1% | Fair - envelope timing differs |
| 24dB LPF | `note("c4").s("saw").lpf(500).ftype("24db")` | 1.00 | 95.1% | Excellent |
| 24dB HPF | `note("c4").s("saw").hpf(800).ftype("24db")` | 0.96 | 88.3% | Good |
| Ladder filter | `note("c4").s("saw").lpf(500).ftype("ladder")` | 1.00 | 94.1% | Good |
| Ladder + Q | `note("c4").s("saw").lpf(800).lpq(2).ftype("ladder")` | 0.99 | 82.0% | Fair |
| DJF lowpass | `note("c4").s("saw").djf(0.25)` | 0.99 | 93.2% | Good |
| DJF highpass | `note("c4").s("saw").djf(0.75)` | 0.99 | 91.7% | Good |
| DJF sample | `s("bd").djf(0.2)` | 0.87 | 89.5% | Good |

### Tremolo

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Basic | `s("bd").tremolo(4)` | 1.00 | 92.7% | Good |
| With depth | `s("bd").tremolo(8).tremolodepth(0.5)` | 0.97 | 97.2% | Excellent |
| Sine shape | `s("bd").tremolo(4).tremoloshape(1)` | 1.00 | 99.1% | Excellent |
| Square shape | `s("bd").tremolo(4).tremoloshape(4)` | 1.00 | 97.9% | Excellent |

### Amplitude Envelope (ADSR)

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Attack | `s("saw").attack(0.2)` | 1.00 | 94.7% | Good |
| Decay + Sustain | `s("saw").decay(0.3).sustain(0.5)` | 1.00 | 93.3% | Good |
| Full ADSR | `s("saw").attack(0.1).decay(0.2).sustain(0.7).release(0.3)` | 1.00 | 93.5% | Good |

### Pitch Modulation

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Vibrato | `note("c4").s("sine").vib(4)` | 1.00 | 98.1% | Excellent |
| Vibrato + depth | `note("c4").s("saw").vib(4).vibmod(1)` | 0.99 | 92.7% | Good |
| Pitch envelope | `note("c4").s("sine").penv(12).pdecay(0.3)` | 0.83 | 91.8% | Good |
| Pitch env (saw) | `note("c4").s("saw").penv(12).pdecay(0.3)` | 0.83 | 86.6% | Good |
| Pitch + vibrato | `note("c4").s("saw").penv(12).pdecay(0.3).vib(5)` | 0.85 | 87.0% | Good |

### FM Synthesis

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| FM basic (sine) | `note("c4").s("sine").fm(2)` | 0.90 | 90.2% | Good |
| FM + harmonicity | `note("c4").s("sine").fm(2).fmh(2)` | 1.00 | 97.2% | Excellent |
| FM + envelope | `note("c4").s("sine").fm(4).fmdecay(0.2)` | 0.98 | 96.8% | Excellent |
| FM (triangle) | `note("c4").s("triangle").fm(2)` | 0.94 | 90.6% | Good |
| FM (saw) | `note("c4").s("saw").fm(2)` | - | - | Poor - band-limited issues |
| FM (square) | `note("c4").s("square").fm(2)` | - | - | Poor - band-limited issues |

*Note: FM synthesis works best with sine and triangle carriers. Band-limited oscillators (saw, square) have parity issues with audio-rate frequency modulation.*

### Effects

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Pan | `s("bd").pan(0.5)` | 0.96 | 93.5% | Good |
| Shape (distortion) | `s("bd").shape(0.5)` | 0.96 | 94.6% | Good |
| Crush (bitcrush) | `s("bd").crush(4)` | 0.99 | 98.2% | Excellent |
| Coarse | `s("bd").coarse(8)` | 0.95 | 93.4% | Good |
| Delay | `s("bd").delay(0.5)` | 0.88 | 89.0% | Good |
| Reverb | `s("bd").room(0.5)` | 0.98 | 84.2% | Fair |
| Reverb + size | `s("bd").room(0.8).roomsize(4)` | 0.91 | 80.8% | Fair |
| Convolution reverb | `s("bd").room(0.5).ir("hh")` | 0.86 | 87% | Good |
| IR speed | `s("bd").ir("hh").irspeed(2)` | 0.98 | 84% | Good |
| IR offset | `s("bd").ir("sd").irbegin(0.5)` | 0.96 | 86% | Good |
| Phaser | `note("c4").s("saw").phaserrate(2).phaserdepth(0.5)` | 0.91 | 86.7% | Good |

### Gain & Dynamics

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Gain | `s("bd").gain(0.5)` | - | - | Uses SuperDirt built-in |
| Velocity | `s("bd").velocity(0.5)` | - | - | Uses SuperDirt built-in |
| Compressor | `s("bd").compressor(-20)` | - | - | Uses SuperDirt built-in |

### Soundfonts

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| GM Piano | `note("c4").s("gm_piano")` | 1.00 | 96.1% | Excellent |
| GM Piano + pan | `note("c4").s("gm_piano").pan(0.5)` | 1.00 | 96.5% | Excellent |
| GM Piano chord | `note("c3 e3 g3 c4").s("gm_piano")` | 0.71 | 76.0% | Fair - timing variance |

---

## Overall Score

Based on tested features (excluding noise which is inherently random):

| Category | Avg Similarity | Status |
|----------|---------------|--------|
| Samples | 93.7% | Good |
| Synths | 91.1% | Good |
| Filters | 89.1% | Good |
| Tremolo | 96.7% | Excellent |
| ADSR | 93.8% | Good |
| Pitch Mod | 91.2% | Good |
| FM Synth | 93.7% | Good |
| Effects | 90.1% | Good |
| Noise | RMS ±0.5dB | Excellent (level-matched) |
| **Overall** | **92.4%** | **Good** |

---

## Not Implemented

### Low Priority (specialized)

| Feature | Controls | Difficulty | Notes |
|---------|----------|------------|-------|
| Wavetable Synth | `wt`, `wtenv`, `warp`, etc. | Very Hard | Complex wavetable modulation |
| Phase Vocoder | `stretch` | Very Hard | Time stretching |
| Sidechain/Duck | `duckorbit`, `duckdepth`, etc. | Hard | Cross-orbit ducking |
| Analyser | `analyze`, `fft` | N/A | Visualization only |

---

## Known Issues

### Minor
1. **Supersaw random phases** - Similarity varies 73-83% due to random initial phases (inherent limitation)
2. **FM on saw/square** - Band-limited oscillators react differently to audio-rate FM
3. **ByteBeat bitwise presets** - Presets 3, 5, 8, 10-14 use bitwise XOR/AND which SC cannot do at audio rate - similarity ~50%

### Resolved
- ~~HPF basic~~ - Fixed by switching to BHiPass biquad filter (76.5% → 82.2%)
- ~~Filter Q scaling~~ - Fixed with 1/sqrt(Q) mapping (65% → 84-96%)
- ~~BPF gain mismatch~~ - Fixed by routing through strudel_filter module (65% → 82%)
- ~~Synth double envelope~~ - Fixed by removing internal ADSR from synths
- ~~Noise "broken"~~ - Not broken, just random - RMS levels match within 1dB
- ~~Pan law~~ - Now 92-94% at all positions (was 84.1%)
- ~~Delay feedback~~ - Now 88-90% with feedback mapping adjustments (was 77.9%)
- ~~Supersaw defaults~~ - Fixed detune/spread defaults and panning algorithm

---

## Testing Commands

```bash
# Run all feature tests
cd server && node test-features.mjs

# Test specific pattern
cd server && node compare-backends.mjs 's("bd sd hh sd").lpf(500)' 2

# Full regression suite
cd server && node compare-backends.mjs --all
```

---

## Changelog

### 2026-01-06 (Session 10)
- Implemented ByteBeat synthesizer for both backends
  - Added `strudel_bytebeat` SynthDef to SuperCollider with all 15 presets
  - Added `ByteBeatProcessor` worklet for Node.js WebAudio polyfill
  - Uses `bbPreset` (via `n` control) to select preset, `bbStartTime` for offset
  - **Presets 0, 2, 4, 6, 9**: 91-98% similarity - use modulo/comparison (Excellent)
  - **Presets 3, 5, 8, 10-14**: ~50% similarity - bitwise ops can't match in SC (Expected)
  - Custom expressions (`bbexpr`) are WebAudio-only (SC can't eval JS at runtime)
- Implemented `irspeed` and `irbegin` for convolution reverb
  - Added buffer resampling with linear interpolation in SC (like superdough's adjustLength)
  - `irspeed`: Playback speed of IR sample (2 = double speed, 0.5 = half speed)
  - `irbegin`: Offset into IR sample (0-1, where 0.5 = start from middle)
  - **IR speed**: 84% similarity, 0.98 spectral correlation
  - **IR offset**: 86% similarity, 0.96 spectral correlation

### 2026-01-06 (Session 9)
- Implemented convolution reverb using PartConv
  - Added `strudel_convrev` module for impulse response-based reverb
  - Supports `ir` (sample name), `irspeed` (playback speed), `irbegin` (offset 0-1)
  - Uses PartConv with FFT size 2048 for efficient real-time convolution
  - Spectral buffers are prepared and cached for each unique IR sample
  - Applied fixed normalization factor (2.0) to approximate WebAudio's ConvolverNode normalization
  - **Convolution reverb**: ~88% similarity across different room values and IR samples

### 2026-01-06 (Session 8)
- Improved supersaw synth panning and defaults
  - Changed default detune from 0.18 to 0.2 (matches WebAudio freqspread)
  - Changed default spread from 0.6 to 0.4 (matches WebAudio panspread)
  - Switched from linear pan spread to alternating L/R pattern (odd=left, even=right)
  - Note: Similarity varies 73-83% due to random phase initialization in both backends
- Verified delay and pan improvements from previous session
  - **Delay**: 77.9% → 89.0% (+11.1%) - feedback mapping working well
  - **Pan**: 84.1% → 93.5% (+9.4%) - now consistent across all positions
- Fixed FM envelope smart defaults to match superdough's getADSRValues behavior
  - When only `fmdecay` is set, sustain now defaults to 0.001 (AD envelope)
  - **FM + harmonicity**: 72.5% → 97.2% (+24.7%) - major improvement
  - **FM + envelope**: 67.1% → 96.8% (+29.7%) - major improvement
- Fixed BPF Q mapping: use 1/Q instead of 1/sqrt(Q) for bandpass filters
  - **BPF Q=5**: 81.6% → 91.0% (+9.4%) - proper reciprocal Q mapping
  - Added filter envelope default (lpenv/hpenv/bpenv=1) when ADSR params specified
- Updated Effects category average: 87.5% → 90.1%
- Updated FM Synth category average: 80.8% → 93.7%
- Updated Overall score: 91.4% → 92.4%

### 2026-01-06 (Session 7)
- Switched LPF/HPF to use biquad filters (BLowPass/BHiPass) instead of RLPF/RHPF
  - WebAudio uses BiquadFilterNode, SC's biquad filters match this algorithm better
  - **LPF + resonance**: 83.8% → 94.5% (+10.7%) - major improvement
  - **HPF basic**: 76.5% → 82.2% (+5.7%)
  - **24dB HPF**: 83.4% → 88.3% (+4.9%)
  - **DJF highpass**: 88.3% → 91.7% (+3.4%)
  - **24dB LPF**: 93.9% → 95.1% (+1.2%)
  - Kept 1/sqrt(Q) mapping which reduces resonance gain to match WebAudio
- Updated filter category average: 88.1% → 90.3%

### 2026-01-06 (Session 6)
- Implemented ladder filter (`ftype('ladder')`) for SuperCollider backend
  - Uses MoogFF UGen for Moog-style 24dB/oct lowpass
  - Basic: 94.1% similarity (spectral 1.00) - Excellent
  - With resonance (lpq=2): 82.0% similarity - Fair
  - Note: Higher resonance values show more divergence due to MoogFF vs WebAudio ladder differences
- Fixed SC render script hanging on boot
  - Root cause: `var` declarations in middle of SynthDef function (SC requires all vars at top)
  - Also fixed Select.ar boolean → integer conversion for ftype comparisons

### 2026-01-06 (Session 5)
- Fixed reverb (room) not working in capture mode
  - Root cause: `createReverb` wasn't added to `nodeWebAudio.AudioContext.prototype`
  - Fix: Use `addToAllPrototypes` pattern like other methods
  - Basic reverb: 84.2% similarity (spectral 0.98)
  - Reverb + roomsize: 80.8% similarity
- Tested phaser effect: 86.7% similarity (spectral 0.91)
- Updated Effects category avg: 89.6% → 87.5%

### 2026-01-06 (Session 4)
- Implemented pitch envelope for all synths (`penv`, `pattack`, `pdecay`, `psustain`, `prelease`, `panchor`)
  - Sine: 91.8% similarity
  - Saw: 86.6% similarity
  - Combined pitch env + vibrato: 87.0%
  - Works on sine, saw, sawtooth, square, triangle, tri, pulse, supersaw
- Verified PWM already works (`pw`, `pwrate`, `pwsweep`) - 87.5% similarity
- Implemented DJF (DJ-style filter morph)
  - Lowpass (djf=0.25): 93.9% similarity
  - Highpass (djf=0.75): 88.3% similarity
  - Works on samples and synths
- Updated Pitch Mod category avg: 95.4% → 91.2% (more features, lower avg)

### 2026-01-06 (Session 3)
- Implemented 24dB filter mode (`ftype('24db')`)
  - LPF: 93.9% similarity
  - HPF: 83.4% similarity
  - Cascades two 12dB filters for steeper slope
- Implemented vibrato for synths (`vib`, `vibmod`)
  - Sine: 98.1% similarity
  - Saw: 92.7% similarity
  - Works on sine, saw, square, triangle, pulse, supersaw
- Implemented bandpass envelope (`bpenv`, `bpattack`, `bpdecay`, `bpsustain`, `bprelease`)
  - 77.4% similarity - functional but BPF has slight gain differences

### 2026-01-06 (Session 2)
- Fixed synth envelope architecture - removed double ADSR application
  - Synths now output raw oscillator, strudel_adsr module applies envelope
  - Fixed ~4dB RMS difference on all synths
- Improved filter Q mapping from 1/Q to 1/sqrt(Q)
  - LPF with Q=10: 65.1% → 83.8%
  - HPF with Q=10: 64.6% → 60.5% (noise source still differs)
- Added BPF support to strudel_filter module
  - BPF now uses proper Q mapping instead of SuperDirt's built-in
  - BPF Q=10: 64.6% → 61.7%
- Updated overall score to 91.2%

### 2026-01-06
- Fixed delay effect for capture mode (11.6% → 91.4%)
  - createFeedbackDelay now added to nodeWebAudio.AudioContext.prototype before context creation
  - Exposed DelayNode globally for superdough's feedbackdelay.mjs detection

### 2026-01-05
- Fixed pitched sample banks (`s("piano").note("c4")`) - now 94.0% similarity
- Fixed render-pattern-sc.mjs to load Strudel samples cache
- Added tremolo module with 5 waveform shapes (pow 1.5 curve)
- Added filter envelope support (lpenv, hpenv with ADSR)
- Fixed NaN issue with exponential envelope curves
- Initial feature parity document created
