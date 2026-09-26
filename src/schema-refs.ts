/*
 * Structural `$id` / `$ref` validation for GTS Type Schemas.
 *
 * This logic lives in the library (not in the HTTP handler) so it is
 * unit-testable and shared across every entry point, mirroring gts-rust's
 * `schema_refs.rs` and the "handlers stay thin - logic goes in the library"
 * rule the reference implementations follow. Every walk here is bounded by
 * {@link MAX_SCHEMA_DEPTH}: the input is attacker-controlled JSON, so an
 * adversarially deep document must fail closed with a finding rather than
 * overflow the stack.
 */

import { Gts } from './gts';
import {
  GTS_PREFIX,
  JSON_SCHEMA_HOST,
  JsonObject,
  JsonValue,
  MAX_SCHEMA_DEPTH,
  hasUriPrefix,
  stripUriPrefix,
} from './types';

/**
 * Validate a Type Schema's top-level `$id` and every embedded `$ref`, returning
 * the first violation message or `null` when the document is well-formed.
 *
 * Behavior (and the exact wording of each message) matches the contract the
 * conformance suite exercises via `POST /entities?validate=true`.
 */
export function validateSchemaIdentityAndRefs(content: unknown): string | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return 'Unable to detect GTS ID in schema';
  }
  // `content` is an untrusted request body (`unknown`); once narrowed to a
  // non-null, non-array object it is treated as a JSON object.
  const schema = content as JsonObject;

  const schemaId = schema['$id'];
  if (!schemaId) {
    return 'Unable to detect GTS ID in schema';
  }

  if (typeof schemaId === 'string') {
    let normalizedId = schemaId;
    if (hasUriPrefix(normalizedId)) {
      normalizedId = stripUriPrefix(normalizedId);
    } else if (normalizedId.startsWith(GTS_PREFIX)) {
      // Plain gts. prefix without gts:// is not allowed for JSON Schema $id
      return 'Schema $id with GTS identifier must use gts:// URI format (e.g., gts://gts.vendor.pkg.ns.type.v1~)';
    } else {
      return 'Schema $id must be a valid GTS identifier with gts:// URI format';
    }

    if (normalizedId.includes('*')) {
      return 'Schema $id cannot contain wildcards';
    }

    if (!Gts.isValidGtsID(normalizedId)) {
      return `Schema $id is not a valid GTS identifier: ${normalizedId}`;
    }
  }

  const refErrors = validateSchemaRefs(schema, '');
  return refErrors.length > 0 ? refErrors[0] : null;
}

/**
 * Collect every invalid `$ref` in a schema document. Recursion is bounded by
 * {@link MAX_SCHEMA_DEPTH}; a document that nests deeper is reported as a
 * finding rather than walked further.
 */
export function validateSchemaRefs(obj: JsonValue, path: string, depth: number = 0): string[] {
  const errors: string[] = [];

  if (!obj || typeof obj !== 'object') {
    return errors;
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    errors.push(`Invalid $ref at ${path || '/'}: schema nests deeper than ${MAX_SCHEMA_DEPTH} levels`);
    return errors;
  }

  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => errors.push(...validateSchemaRefs(item, `${path}[${idx}]`, depth + 1)));
    return errors;
  }

  const node: JsonObject = obj;

  const ref = node['$ref'];
  if (typeof ref === 'string') {
    const refPath = path ? `${path}/$ref` : '$ref';

    if (ref.startsWith('#')) {
      // OK - local ref
    } else if (hasUriPrefix(ref)) {
      // gts:// URI is allowed - validate the GTS ID
      const normalizedRef = stripUriPrefix(ref);
      if (normalizedRef.includes('*')) {
        errors.push(`Invalid $ref at ${refPath}: wildcards are not allowed in $ref`);
      } else if (!Gts.isValidGtsID(normalizedRef)) {
        errors.push(`Invalid $ref at ${refPath}: ${normalizedRef} is not a valid GTS identifier`);
      }
    } else if (ref.startsWith(GTS_PREFIX)) {
      // Plain gts. prefix without gts:// is not allowed
      errors.push(`Invalid $ref at ${refPath}: GTS references must use gts:// URI format`);
    } else if (ref.startsWith('http://') || ref.startsWith('https://')) {
      // External HTTP refs are not allowed (except json-schema.org for $schema)
      if (!ref.includes(JSON_SCHEMA_HOST)) {
        errors.push(`Invalid $ref at ${refPath}: external HTTP references are not allowed`);
      }
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref') continue;
    const nestedPath = path ? `${path}/${key}` : key;
    errors.push(...validateSchemaRefs(value, nestedPath, depth + 1));
  }

  return errors;
}
