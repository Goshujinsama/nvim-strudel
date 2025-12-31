/*
  Strudel Custom SynthDefs for SuperDirt
  
  These SynthDefs provide proper ADSR envelope support for sample playback.
  SuperDirt's default sample player doesn't support sustained envelopes because
  samples stop when they reach their end.
  
  These synths loop the sample while applying an ADSR envelope, allowing
  soundfonts and other samples to have proper attack/decay/sustain/release.
  
  To install: Run this in SuperCollider after SuperDirt is booted.
  Or add to your startup.scd after SuperDirt.start
  
  Usage: The nvim-strudel server will automatically send 'instrument' parameter
  pointing to these synths when ADSR envelopes are used.
*/

(
var numChannels = ~dirt.numChannels;

// Generic sample player with attack/release envelope and looping
// Works with any sample buffer - just override 'instrument' param
(1..SuperDirt.maxSampleNumChannels).do { |sampleNumChannels|
  var name = format("strudel_loop_%_%", sampleNumChannels, numChannels);
  
  SynthDef(name, { |out, bufnum, sustain = 1, speed = 1, freq = 440, pan = 0,
                    attack = 0.001, release = 0.01, begin = 0, end = 1,
                    gain = 1, amp = 0.4|
    var sound, rate, phase, frames, env, holdTime;
    
    rate = speed * (freq / 60.midicps) * BufRateScale.ir(bufnum);
    frames = BufFrames.ir(bufnum);
    
    // Hold time is sustain minus attack and release
    holdTime = max(0.001, sustain - attack - release);
    
    // Linen envelope: attack -> hold at 1 -> release
    env = EnvGen.ar(
      Env.linen(attack, holdTime, release, 1, \sin),
      doneAction: 2
    );
    
    // Loop through sample using Phasor for seamless looping
    phase = Phasor.ar(0, rate * BufSampleRate.ir(bufnum) / SampleRate.ir,
                      begin * frames, end * frames, begin * frames);
    
    sound = BufRd.ar(sampleNumChannels, bufnum, phase, loop: 1, interpolation: 4);
    sound = sound * env * amp * pow(gain, 4);
    
    Out.ar(out, DirtPan.ar(sound, numChannels, pan));
  }, [\ir, \ir, \ir, \ir, \ir, \kr, \ir, \ir, \ir, \ir, \kr, \kr]).add;
  
  ("Added: " ++ name).postln;
};

// Full ADSR version with decay and sustain level
(1..SuperDirt.maxSampleNumChannels).do { |sampleNumChannels|
  var name = format("strudel_adsr_%_%", sampleNumChannels, numChannels);
  
  SynthDef(name, { |out, bufnum, sustain = 1, speed = 1, freq = 440, pan = 0,
                    attack = 0.01, decay = 0.1, sustainLevel = 0.8, release = 0.1,
                    begin = 0, end = 1, gain = 1, amp = 0.4|
    var sound, rate, phase, frames, env;
    
    rate = speed * (freq / 60.midicps) * BufRateScale.ir(bufnum);
    frames = BufFrames.ir(bufnum);
    
    // ADSR envelope
    // The 'sustain' param here is total note duration, not sustain level
    // We use Env.adsr with a gate that opens for the sustain duration
    env = EnvGen.ar(
      Env.adsr(attack, decay, sustainLevel, release, 1, -4),
      gate: Trig.kr(1, max(0.01, sustain - release)),
      doneAction: 2
    );
    
    // Loop through sample
    phase = Phasor.ar(0, rate * BufSampleRate.ir(bufnum) / SampleRate.ir,
                      begin * frames, end * frames, begin * frames);
    
    sound = BufRd.ar(sampleNumChannels, bufnum, phase, loop: 1, interpolation: 4);
    sound = sound * env * amp * pow(gain, 4);
    
    Out.ar(out, DirtPan.ar(sound, numChannels, pan));
  }, [\ir, \ir, \ir, \ir, \ir, \kr, \ir, \ir, \ir, \ir, \ir, \ir, \kr, \kr]).add;
  
  ("Added: " ++ name).postln;
};

// =============================================================================
// Oscillator Synths (sine, sawtooth, square, triangle)
// These match superdough's basic waveform synths for OSC-only operation
// =============================================================================

// Sine wave oscillator
SynthDef(\strudel_sine, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                           attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                           gain = 1, amp = 0.4, lpf = 20000, hpf = 0, lpq = 1, hpq = 1|
  var sound, env, holdTime;
  
  // Envelope: attack -> hold -> release
  holdTime = max(0.001, sustain - attack - release);
  env = EnvGen.ar(
    Env.linen(attack, holdTime, release, 1, \sin),
    doneAction: 2
  );
  
  // Basic sine oscillator
  sound = SinOsc.ar(freq * speed);
  
  // Apply filters
  sound = LPF.ar(sound, lpf.clip(20, 20000));
  sound = HPF.ar(sound, hpf.clip(20, 20000));
  
  // Apply envelope and gain
  sound = sound * env * amp * pow(gain, 4);
  
  Out.ar(out, DirtPan.ar(sound, numChannels, pan));
}, [\ir, \ir, \ir, \kr, \ir, \ir, \ir, \ir, \ir, \kr, \kr, \kr, \kr, \kr, \kr]).add;
"Added: strudel_sine".postln;

// Sawtooth wave oscillator
SynthDef(\strudel_sawtooth, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                               attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                               gain = 1, amp = 0.4, lpf = 20000, hpf = 0, lpq = 1, hpq = 1|
  var sound, env, holdTime;
  
  holdTime = max(0.001, sustain - attack - release);
  env = EnvGen.ar(
    Env.linen(attack, holdTime, release, 1, \sin),
    doneAction: 2
  );
  
  // Sawtooth oscillator (band-limited)
  sound = Saw.ar(freq * speed);
  
  // Apply filters
  sound = LPF.ar(sound, lpf.clip(20, 20000));
  sound = HPF.ar(sound, hpf.clip(20, 20000));
  
  sound = sound * env * amp * pow(gain, 4);
  
  Out.ar(out, DirtPan.ar(sound, numChannels, pan));
}, [\ir, \ir, \ir, \kr, \ir, \ir, \ir, \ir, \ir, \kr, \kr, \kr, \kr, \kr, \kr]).add;
"Added: strudel_sawtooth".postln;

// Alias for sawtooth (superdough uses 'saw')
SynthDef(\strudel_saw, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                          attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                          gain = 1, amp = 0.4, lpf = 20000, hpf = 0, lpq = 1, hpq = 1|
  var sound, env, holdTime;
  
  holdTime = max(0.001, sustain - attack - release);
  env = EnvGen.ar(
    Env.linen(attack, holdTime, release, 1, \sin),
    doneAction: 2
  );
  
  sound = Saw.ar(freq * speed);
  sound = LPF.ar(sound, lpf.clip(20, 20000));
  sound = HPF.ar(sound, hpf.clip(20, 20000));
  sound = sound * env * amp * pow(gain, 4);
  
  Out.ar(out, DirtPan.ar(sound, numChannels, pan));
}, [\ir, \ir, \ir, \kr, \ir, \ir, \ir, \ir, \ir, \kr, \kr, \kr, \kr, \kr, \kr]).add;
"Added: strudel_saw".postln;

// Square wave oscillator
SynthDef(\strudel_square, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                             attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                             gain = 1, amp = 0.4, lpf = 20000, hpf = 0, lpq = 1, hpq = 1|
  var sound, env, holdTime;
  
  holdTime = max(0.001, sustain - attack - release);
  env = EnvGen.ar(
    Env.linen(attack, holdTime, release, 1, \sin),
    doneAction: 2
  );
  
  // Square wave (pulse with 50% duty cycle)
  sound = Pulse.ar(freq * speed, 0.5);
  
  sound = LPF.ar(sound, lpf.clip(20, 20000));
  sound = HPF.ar(sound, hpf.clip(20, 20000));
  sound = sound * env * amp * pow(gain, 4);
  
  Out.ar(out, DirtPan.ar(sound, numChannels, pan));
}, [\ir, \ir, \ir, \kr, \ir, \ir, \ir, \ir, \ir, \kr, \kr, \kr, \kr, \kr, \kr]).add;
"Added: strudel_square".postln;

// Triangle wave oscillator
SynthDef(\strudel_triangle, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                               attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                               gain = 1, amp = 0.4, lpf = 20000, hpf = 0, lpq = 1, hpq = 1|
  var sound, env, holdTime;
  
  holdTime = max(0.001, sustain - attack - release);
  env = EnvGen.ar(
    Env.linen(attack, holdTime, release, 1, \sin),
    doneAction: 2
  );
  
  // Triangle wave using LFTri (not band-limited but sounds better for triangle)
  sound = LFTri.ar(freq * speed);
  
  sound = LPF.ar(sound, lpf.clip(20, 20000));
  sound = HPF.ar(sound, hpf.clip(20, 20000));
  sound = sound * env * amp * pow(gain, 4);
  
  Out.ar(out, DirtPan.ar(sound, numChannels, pan));
}, [\ir, \ir, \ir, \kr, \ir, \ir, \ir, \ir, \ir, \kr, \kr, \kr, \kr, \kr, \kr]).add;
"Added: strudel_triangle".postln;

// Alias for triangle (superdough uses 'tri')
SynthDef(\strudel_tri, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                          attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                          gain = 1, amp = 0.4, lpf = 20000, hpf = 0, lpq = 1, hpq = 1|
  var sound, env, holdTime;
  
  holdTime = max(0.001, sustain - attack - release);
  env = EnvGen.ar(
    Env.linen(attack, holdTime, release, 1, \sin),
    doneAction: 2
  );
  
  sound = LFTri.ar(freq * speed);
  sound = LPF.ar(sound, lpf.clip(20, 20000));
  sound = HPF.ar(sound, hpf.clip(20, 20000));
  sound = sound * env * amp * pow(gain, 4);
  
  Out.ar(out, DirtPan.ar(sound, numChannels, pan));
}, [\ir, \ir, \ir, \kr, \ir, \ir, \ir, \ir, \ir, \kr, \kr, \kr, \kr, \kr, \kr]).add;
"Added: strudel_tri".postln;

// =============================================================================
// Noise generators (white, pink, brown)
// =============================================================================

SynthDef(\strudel_white, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                            attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                            gain = 1, amp = 0.4, lpf = 20000, hpf = 0|
  var sound, env, holdTime;
  
  holdTime = max(0.001, sustain - attack - release);
  env = EnvGen.ar(
    Env.linen(attack, holdTime, release, 1, \sin),
    doneAction: 2
  );
  
  sound = WhiteNoise.ar;
  sound = LPF.ar(sound, lpf.clip(20, 20000));
  sound = HPF.ar(sound, hpf.clip(20, 20000));
  sound = sound * env * amp * pow(gain, 4);
  
  Out.ar(out, DirtPan.ar(sound, numChannels, pan));
}, [\ir, \ir, \ir, \kr, \ir, \ir, \ir, \ir, \ir, \kr, \kr, \kr, \kr]).add;
"Added: strudel_white".postln;

SynthDef(\strudel_pink, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                           attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                           gain = 1, amp = 0.4, lpf = 20000, hpf = 0|
  var sound, env, holdTime;
  
  holdTime = max(0.001, sustain - attack - release);
  env = EnvGen.ar(
    Env.linen(attack, holdTime, release, 1, \sin),
    doneAction: 2
  );
  
  sound = PinkNoise.ar;
  sound = LPF.ar(sound, lpf.clip(20, 20000));
  sound = HPF.ar(sound, hpf.clip(20, 20000));
  sound = sound * env * amp * pow(gain, 4);
  
  Out.ar(out, DirtPan.ar(sound, numChannels, pan));
}, [\ir, \ir, \ir, \kr, \ir, \ir, \ir, \ir, \ir, \kr, \kr, \kr, \kr]).add;
"Added: strudel_pink".postln;

SynthDef(\strudel_brown, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                            attack = 0.001, decay = 0.05, sustainLevel = 0.8, release = 0.1,
                            gain = 1, amp = 0.4, lpf = 20000, hpf = 0|
  var sound, env, holdTime;
  
  holdTime = max(0.001, sustain - attack - release);
  env = EnvGen.ar(
    Env.linen(attack, holdTime, release, 1, \sin),
    doneAction: 2
  );
  
  sound = BrownNoise.ar;
  sound = LPF.ar(sound, lpf.clip(20, 20000));
  sound = HPF.ar(sound, hpf.clip(20, 20000));
  sound = sound * env * amp * pow(gain, 4);
  
  Out.ar(out, DirtPan.ar(sound, numChannels, pan));
}, [\ir, \ir, \ir, \kr, \ir, \ir, \ir, \ir, \ir, \kr, \kr, \kr, \kr]).add;
"Added: strudel_brown".postln;

"".postln;
"Strudel SynthDefs loaded!".postln;
"Available synths:".postln;
"  strudel_loop_N_M   - attack/release envelope with looping".postln;
"  strudel_adsr_N_M   - full ADSR envelope with looping".postln;
"  strudel_sine       - sine wave oscillator".postln;
"  strudel_sawtooth   - sawtooth wave oscillator".postln;
"  strudel_saw        - alias for sawtooth".postln;
"  strudel_square     - square wave oscillator".postln;
"  strudel_triangle   - triangle wave oscillator".postln;
"  strudel_tri        - alias for triangle".postln;
"  strudel_white      - white noise".postln;
"  strudel_pink       - pink noise".postln;
"  strudel_brown      - brown noise".postln;
"".postln;
"These will be used automatically when synth sounds are played.".postln;
)
