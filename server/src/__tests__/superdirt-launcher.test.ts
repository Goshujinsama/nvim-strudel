/**
 * Tests for SuperDirt launcher
 * 
 * Critical: Ensures SuperCollider symbol literals are properly escaped
 * in the generated startup script. Without proper escaping, sclang
 * fails silently during s.waitForBoot and scsynth never boots.
 * 
 * See commit 78d3049 for the original bug.
 */

import { describe, it, expect } from 'vitest';
import { SuperDirtLauncher } from '../superdirt-launcher.js';

describe('SuperDirtLauncher', () => {
  describe('generateStartupScript', () => {
    // Access the private method for testing
    // We need to create an instance and extract the script
    function getStartupScript(): string {
      const launcher = new SuperDirtLauncher({
        port: 57120,
        channels: 2,
        orbits: 12,
      });
      // Access private method via any cast
      return (launcher as any).generateStartupScript();
    }

    it('should contain properly escaped SuperCollider symbol literals', () => {
      const script = getStartupScript();
      
      // SC symbols must be escaped as \\symbol in the JS template string
      // so they appear as \symbol in the generated SC code
      
      // Check for \lin symbol (used in Env.new)
      expect(script).toContain('\\lin');
      // Make sure it's not the unescaped 'lin' without backslash
      expect(script).not.toMatch(/[^\\]lin\)/);
      
      // Check for \ir symbol (used in SynthDef rate specs)
      expect(script).toContain('\\ir');
      
      // Check for \kr symbol (used in SynthDef rate specs)
      expect(script).toContain('\\kr');
    });

    it('should have matching brackets in EnvGen definitions', () => {
      const script = getStartupScript();
      
      // Find all EnvGen.kr lines and verify they have proper Env.new syntax
      // Pattern: Env.new([levels], [times], \curve)
      const envNewPattern = /Env\.new\(\[[\d\s,]+\],\s*\[[^\]]+\],\s*\\[a-z]+\)/g;
      const matches = script.match(envNewPattern);
      
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThan(0);
    });

    it('should have valid SynthDef rate specifications', () => {
      const script = getStartupScript();
      
      // SynthDef rate specs should be arrays of symbols like [\\ir, \\ir, \\kr, ...]
      // In the generated script, they appear as [\ir, \ir, \kr, ...]
      // Format: }, [\ir, \ir, \kr, ...]).add;
      const rateSpecPattern = /\}, \[\\[ikart]r(?:,\s*\\[ikart]r)*\]\)\.add/g;
      const matches = script.match(rateSpecPattern);
      
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThan(0);
      
      // Verify all current custom rate-spec SynthDefs are represented.
      expect(matches!.length).toBeGreaterThanOrEqual(4);
    });

    it('should not contain unescaped rate symbols', () => {
      const script = getStartupScript();
      
      // These patterns would indicate missing escapes:
      // - ", ir," or ", kr," without backslash
      // - "[ir, " or "[kr, " without backslash
      
      // Check that rate specs aren't bare identifiers
      expect(script).not.toMatch(/\[ir,/);
      expect(script).not.toMatch(/\[kr,/);
      expect(script).not.toMatch(/,\s*ir\]/);
      expect(script).not.toMatch(/,\s*kr\]/);
    });

    it('should configure server options before boot', () => {
      const script = getStartupScript();
      
      // Server options must be set before s.waitForBoot
      const bootIndex = script.indexOf('s.waitForBoot');
      const numBuffersIndex = script.indexOf('s.options.numBuffers');
      const memSizeIndex = script.indexOf('s.options.memSize');
      
      expect(bootIndex).toBeGreaterThan(0);
      expect(numBuffersIndex).toBeGreaterThan(0);
      expect(memSizeIndex).toBeGreaterThan(0);
      
      // Options must come before boot
      expect(numBuffersIndex).toBeLessThan(bootIndex);
      expect(memSizeIndex).toBeLessThan(bootIndex);
    });

    it('should kill existing servers before starting', () => {
      const script = getStartupScript();
      
      // Server.killAll should be at the start
      expect(script).toContain('Server.killAll');
      
      const killAllIndex = script.indexOf('Server.killAll');
      const bootIndex = script.indexOf('s.waitForBoot');
      
      expect(killAllIndex).toBeLessThan(bootIndex);
    });
  });

  describe('static methods', () => {
    it('should have isSclangAvailable method', () => {
      expect(typeof SuperDirtLauncher.isSclangAvailable).toBe('function');
    });

    it('should have isSuperDirtInstalled method', () => {
      expect(typeof SuperDirtLauncher.isSuperDirtInstalled).toBe('function');
    });
  });
});
