/*
 * ReDoS / resource-exhaustion guards for untrusted schema documents.
 *
 * Schemas are registered without JSON Schema meta-validation, so an
 * attacker-controlled document can carry a catastrophic-backtracking `pattern`
 * / `patternProperties` regex or an adversarially large `$ref`/`allOf` DAG.
 * This check runs before any such document is compiled or walked. Extracted
 * from `store.ts` to keep the security seam self-contained and testable
 * (parallels the dedicated safety checks in the sibling implementations).
 */

import safeRegex from 'safe-regex2';
import { MAX_SCHEMA_DEPTH, MAX_SCHEMA_PATHS, EntityContentDepthError } from './types';
import { isPlainSchemaObject } from './json-canonical';
import { visitJsonSubschemas } from './x-gts-ref';

/**
 * Throw if `root` contains an unsafe regular expression, nests deeper than
 * {@link MAX_SCHEMA_DEPTH}, or expands to more than {@link MAX_SCHEMA_PATHS}
 * subschema paths. Fails closed: a document that trips a bound is rejected
 * rather than partially processed.
 */
export function assertSafeSchemaPatterns(root: unknown): void {
  const stack: Array<{ value: any; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let paths = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (!isPlainSchemaObject(value) || seen.has(value)) continue;
    if (depth > MAX_SCHEMA_DEPTH) throw new EntityContentDepthError();
    if (++paths > MAX_SCHEMA_PATHS) throw new Error(`Schema exceeds the ${MAX_SCHEMA_PATHS} path safety limit`);
    seen.add(value);
    const patterns = [
      ...(typeof value.pattern === 'string' ? [value.pattern] : []),
      ...(isPlainSchemaObject(value.patternProperties) ? Object.keys(value.patternProperties) : []),
    ];
    for (const pattern of patterns) {
      if (!safeRegex(pattern)) throw new Error(`Unsafe regular expression pattern: ${pattern}`);
    }
    visitJsonSubschemas(value, '', (subschema) => stack.push({ value: subschema, depth: depth + 1 }));
  }
}
