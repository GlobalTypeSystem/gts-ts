/*
 * Resource-exhaustion guards for untrusted schema documents.
 *
 * Schemas are registered without JSON Schema meta-validation, so an
 * attacker-controlled document can carry an adversarially long `pattern` /
 * `patternProperties` regex or an adversarially large `$ref`/`allOf` DAG. This
 * check runs before any such document is compiled or walked. Extracted from
 * `store.ts` to keep the security seam self-contained and testable (parallels
 * the dedicated safety checks in the sibling implementations).
 *
 * Matching-time protection lives in regex-engine.ts. The `MAX_REGEX_LEN` bound
 * below is a cheap compilation cap; Ajv owns schema-location and syntax validation.
 */

import { MAX_REGEX_LEN, MAX_SCHEMA_DEPTH, MAX_SCHEMA_PATHS, EntityContentDepthError } from './types';
import { isPlainSchemaObject } from './json-canonical';
import { visitJsonSubschemas } from './x-gts-ref';

/**
 * Throw if `root` carries a `pattern`/`patternProperties` regex longer than
 * {@link MAX_REGEX_LEN}, nests deeper than {@link MAX_SCHEMA_DEPTH}, or expands
 * to more than {@link MAX_SCHEMA_PATHS} subschema paths. Fails closed: a
 * document that trips a bound is rejected rather than partially processed.
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
      if (pattern.length > MAX_REGEX_LEN) {
        throw new Error(`Regular expression pattern exceeds the ${MAX_REGEX_LEN} character safety limit`);
      }
    }
    visitJsonSubschemas(value, '', (subschema) => stack.push({ value: subschema, depth: depth + 1 }));
  }
}
