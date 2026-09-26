/*
 * JSON canonicalization, hashing and safe deep-cloning helpers shared by the
 * store. Extracted from `store.ts` so these pure, dependency-light utilities
 * are independently testable and the store module stays focused on registry
 * behavior (a step toward the module seams gts-rust uses).
 */

import { createHash } from 'crypto';
import { JsonEntity, JsonObject, JsonValue, MAX_SCHEMA_DEPTH, EntityContentDepthError } from './types';

/**
 * True when `value` is safe to read schema keywords off (`.type`, `['$ref']`,
 * etc). Schemas are registered without meta-validation, so a registered
 * document can contain a literal `null` (or any other non-object) in a
 * position where a schema object is expected - e.g. `properties: {a: null}` or
 * `allOf: [{...}, null]`. Every traversal that walks into such a position must
 * check this first, rather than reading a property straight off the value: a
 * `null`/non-object entry in a schema position is malformed/no-op data, not a
 * crash.
 */
export function isPlainSchemaObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON serialization with object keys emitted in sorted order,
 * recursively. `JSON.stringify` preserves insertion order, so two entities
 * with equal content but differently-ordered keys would serialize
 * differently - sorting keys makes the serialization stable so equal content
 * always produces an equal string. Mirrors gts-go's reliance on Go's
 * `encoding/json` sorting map keys.
 */
export function canonicalJson(value: JsonValue, depth: number = 0): string {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new EntityContentDepthError();
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A stable SHA-256 hash of an entity's content, used to distinguish an
 * idempotent re-submission (identical content) from a conflicting update
 * (changed content) without a deep structural comparison. Mirrors gts-go's
 * `contentHash`.
 */
export function contentHash(content: JsonObject): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/**
 * Structure-preserving deep clone that tolerates cycles (via a `seen`
 * WeakMap), used to hand callers isolated copies of registered content so they
 * cannot mutate the store's state through a returned reference.
 */
export function cloneJsonValue<T>(value: T, seen: WeakMap<object, any> = new WeakMap()): T {
  if (value === null || typeof value !== 'object') return value;
  const existing = seen.get(value as object);
  if (existing !== undefined) return existing;
  const clone: any = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value as object, clone);
  for (const key of Object.keys(value as object)) {
    Object.defineProperty(clone, key, {
      value: cloneJsonValue((value as any)[key], seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return clone;
}

/** Deep-clone an entity, including a fresh copy of its `references` set. */
export function cloneJsonEntity(entity: JsonEntity): JsonEntity {
  return {
    ...entity,
    content: cloneJsonValue(entity.content),
    references: new Set(entity.references),
  };
}
