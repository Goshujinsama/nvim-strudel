import { describe, expect, it } from 'vitest';
import { hapToOscArgs } from '../osc-output.js';

function hap(value: Record<string, unknown>, begin = 0.125, duration = 1) {
  return {
    value,
    wholeOrPart: () => ({ begin: { valueOf: () => begin } }),
    duration: { valueOf: () => duration },
  };
}

function argsToControls(args: Array<{ value: unknown }>): Record<string, unknown> {
  const controls: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 2) {
    controls[String(args[index].value)] = args[index + 1].value;
  }
  return controls;
}

describe('native OSC control translation', () => {
  it('maps symbolic tremolo shape and preserves cycle-locked phase', () => {
    const controls = argsToControls(hapToOscArgs(hap({
      s: 'bd',
      tremolosync: 16,
      tremoloshape: 'tri',
      tremoloskew: 0.1,
      tremolophase: 0.25,
    }), 0.5));

    expect(controls.strudelTremRate).toBe(8);
    expect(controls.strudelTremShape).toBe(0);
    expect(controls.strudelTremSkew).toBeCloseTo(0.1);
    expect(controls.strudelTremPhase).toBeCloseTo(0.25);
    expect(controls.tremolosync).toBeUndefined();
    expect(controls.tremoloshape).toBeUndefined();
  });

  it('maps every documented symbolic tremolo shape', () => {
    const shapes = { tri: 0, sine: 1, ramp: 2, saw: 3, square: 4 };
    for (const [shape, expected] of Object.entries(shapes)) {
      const controls = argsToControls(hapToOscArgs(hap({
        s: 'bd',
        tremolo: 4,
        tremoloshape: shape,
      }), 1));
      expect(controls.strudelTremShape).toBe(expected);
    }
  });

  it('rejects unknown symbolic tremolo shapes instead of sending strings to SynthDefs', () => {
    expect(() => hapToOscArgs(hap({
      s: 'bd',
      tremolo: 4,
      tremoloshape: 'unknown',
    }), 1)).toThrow('Unknown tremolo shape');
  });

  it('keeps each soundfont event group alive through its independent release', () => {
    const controls = argsToControls(hapToOscArgs(hap({
      s: 'gm_voice_oohs',
      speed: 0.5,
      attack: 0.7,
      decay: 2.5,
      sustain: 0,
      release: 2.5,
    }, 0, 1), 0.5));

    // delta = duration / cps = 2 seconds, followed by a 2.5-second release.
    expect(controls.sustain).toBe(2);
    expect(controls.release).toBe(2.5);
    expect(controls.curve).toBe(0);
    expect(controls.sfSustain).toBeCloseTo(4.51);
    // Dirt divides rate-unit duration by speed. Compensating here prevents its
    // event gate from reverting to the short natural sample duration.
    expect(Number(controls.unitDuration) / Number(controls.speed)).toBeCloseTo(4.51);
  });
});
