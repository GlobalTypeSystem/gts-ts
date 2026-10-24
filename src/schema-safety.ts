/*
 * Check regex support before compiling untrusted schemas. Every schema
 * position the shared walker visits (schema-walk.ts) is checked, including
 * inactive branches and local `$ref` targets. Regex checks use regex-engine.ts.
 */

import { isPlainSchemaObject } from './json-canonical';
import { compileSafePattern } from './regex-engine';
import { forEachSchemaNode } from './schema-walk';

/**
 * Reject unsupported schema patterns or traversal beyond the shared depth and
 * path limits.
 *
 * `dialectSource` supplies the dialect; synthesized trait schemas use their host type.
 */
export function assertSafeSchemaPatterns(root: unknown, dialectSource: unknown = root): void {
  forEachSchemaNode(
    root,
    (value) => {
      const patterns = [
        ...(typeof value.pattern === 'string' ? [value.pattern] : []),
        ...(isPlainSchemaObject(value.patternProperties) ? Object.keys(value.patternProperties) : []),
      ];
      for (const pattern of patterns) {
        compileSafePattern(pattern, 'u');
      }
    },
    dialectSource
  );
}
