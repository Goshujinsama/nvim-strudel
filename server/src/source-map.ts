import type { ActiveElement, SourceLocation } from './types.js';

/**
 * Tracks source code positions to pattern events
 * This is critical for accurate visualization in the editor
 */
export class SourceMap {
  private locations: Map<string, SourceLocation> = new Map();

  /**
   * Register a source location for a pattern element
   */
  register(id: string, location: SourceLocation): void {
    this.locations.set(id, location);
  }

  /**
   * Get the source location for an element
   */
  get(id: string): SourceLocation | undefined {
    return this.locations.get(id);
  }

  /**
   * Clear all registered locations
   */
  clear(): void {
    this.locations.clear();
  }

  /**
   * Convert a hap (Strudel event) to an active element with source location
   * This is a placeholder - the real implementation will depend on how
   * Strudel exposes source location information
   */
  hapToActiveElement(hap: any): ActiveElement | null {
    // Strudel haps may have location info attached
    // This needs to be implemented based on actual Strudel API
    const location = hap.context?.locations?.[0];
    
    if (location) {
      return {
        startLine: location.start.line,
        startCol: location.start.column,
        endLine: location.end.line,
        endCol: location.end.column,
        value: hap.value?.s || String(hap.value),
      };
    }

    return null;
  }
}
