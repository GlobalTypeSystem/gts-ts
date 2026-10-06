/*
 * Check regex support and traversal bounds before compiling untrusted schemas.
 * Visit schema positions for the declared dialect and Ajv, including inactive
 * branches and local `$ref` targets. Literal data and unknown keywords are
 * visited only through references. Regex checks use regex-engine.ts.
 */

import { MAX_SCHEMA_DEPTH, MAX_SCHEMA_PATHS, EntityContentDepthError } from './types';
import { isPlainSchemaObject } from './json-canonical';
import { compileSafePattern } from './regex-engine';
import { dialectOf, type SchemaDialect } from './schema-dialect';

const SCHEMA_VALUE_KEYWORDS: Record<SchemaDialect, ReadonlySet<string>> = {
  'draft-07': new Set([
    'additionalItems',
    'additionalProperties',
    'contains',
    'else',
    'if',
    'not',
    'propertyNames',
    'then',
  ]),
  '2019-09': new Set([
    'additionalItems',
    'additionalProperties',
    'contains',
    'contentSchema',
    'else',
    'if',
    'not',
    'propertyNames',
    'then',
    'unevaluatedItems',
    'unevaluatedProperties',
  ]),
  '2020-12': new Set([
    'additionalProperties',
    'contains',
    'contentSchema',
    'else',
    'if',
    'not',
    'propertyNames',
    'then',
    'unevaluatedItems',
    'unevaluatedProperties',
  ]),
};
const SCHEMA_ARRAY_KEYWORDS: Record<SchemaDialect, ReadonlySet<string>> = {
  'draft-07': new Set(['allOf', 'anyOf', 'oneOf']),
  '2019-09': new Set(['allOf', 'anyOf', 'oneOf']),
  '2020-12': new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']),
};
// Ajv executes schema-valued `dependencies` even in 2019-09 and 2020-12.
const SCHEMA_MAP_KEYWORDS: Record<SchemaDialect, ReadonlySet<string>> = {
  'draft-07': new Set(['definitions', 'dependencies', 'patternProperties', 'properties']),
  '2019-09': new Set(['$defs', 'dependencies', 'dependentSchemas', 'patternProperties', 'properties']),
  '2020-12': new Set(['$defs', 'dependencies', 'dependentSchemas', 'patternProperties', 'properties']),
};

interface Keywords {
  values: ReadonlySet<string>;
  arrays: ReadonlySet<string>;
  maps: ReadonlySet<string>;
}

function union(sets: Record<SchemaDialect, ReadonlySet<string>>): ReadonlySet<string> {
  return new Set(Object.values(sets).flatMap((set) => [...set]));
}

// Without a supported dialect, check schema keywords from all supported drafts.
const ANY_DIALECT: Keywords = {
  values: union(SCHEMA_VALUE_KEYWORDS),
  arrays: union(SCHEMA_ARRAY_KEYWORDS),
  maps: union(SCHEMA_MAP_KEYWORDS),
};

function keywordsFor(dialectSource: any): Keywords {
  let dialect: SchemaDialect;
  try {
    dialect = dialectOf(dialectSource);
  } catch {
    return ANY_DIALECT;
  }
  return {
    values: SCHEMA_VALUE_KEYWORDS[dialect],
    arrays: SCHEMA_ARRAY_KEYWORDS[dialect],
    maps: SCHEMA_MAP_KEYWORDS[dialect],
  };
}

function visitSubschemas(
  schema: Record<string, unknown>,
  keywords: Keywords,
  visit: (subschema: unknown) => void
): void {
  for (const [key, value] of Object.entries(schema)) {
    if (keywords.values.has(key) || key === 'x-gts-traits-schema') {
      visit(value);
    } else if (keywords.arrays.has(key) && Array.isArray(value)) {
      value.forEach(visit);
    } else if (keywords.maps.has(key) && isPlainSchemaObject(value)) {
      // Array-valued `dependencies` entries are property lists, not schemas.
      Object.values(value).forEach((child) => Array.isArray(child) || visit(child));
    } else if (key === 'items') {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }
}

/** A subschema whose `$id` starts a new resource (not a draft-07 `#anchor`). */
function isEmbeddedResource(value: any): boolean {
  return typeof value.$id === 'string' && value.$id !== '' && !value.$id.startsWith('#');
}

// Keys under which Ajv does not let an `$id` change the resolution scope of a
// JSON Pointer (ajv/lib/compile/index.ts).
const PREVENT_SCOPE_CHANGE = new Set(['properties', 'patternProperties', 'enum', 'dependencies', 'definitions']);

/**
 * Resolve a local pointer and return its target and resource, following Ajv's
 * embedded `$id` scopes. External refs return undefined; anchors are skipped
 * because their schema positions are already visited.
 */
function resolveLocalRef(root: any, resource: any, ref: unknown): { target: unknown; resource: any } | undefined {
  if (typeof ref !== 'string') return undefined;
  const hash = ref.indexOf('#');
  const base = hash < 0 ? ref : ref.slice(0, hash);
  const scope = base === '' || base === resource.$id ? resource : base === root.$id ? root : undefined;
  if (scope === undefined) return undefined;
  // Decode before splitting: `%2F` separates segments; `~1` is a literal slash.
  let fragment: string;
  try {
    fragment = hash < 0 ? '' : decodeURIComponent(ref.slice(hash + 1));
  } catch {
    return undefined;
  }
  if (fragment === '') return { target: scope, resource: scope };
  if (!fragment.startsWith('/')) return undefined;
  let target: any = scope;
  let targetResource: any = scope;
  for (const escaped of fragment.slice(1).split('/')) {
    const segment = escaped.replace(/~1/g, '/').replace(/~0/g, '~');
    if (target === null || typeof target !== 'object' || !Object.prototype.hasOwnProperty.call(target, segment)) {
      return undefined;
    }
    target = target[segment];
    if (!PREVENT_SCOPE_CHANGE.has(segment) && isPlainSchemaObject(target) && isEmbeddedResource(target)) {
      targetResource = target;
    }
  }
  return { target, resource: targetResource };
}

/**
 * Reject unsupported schema patterns or traversal beyond {@link MAX_SCHEMA_DEPTH}
 * or {@link MAX_SCHEMA_PATHS}.
 *
 * `dialectSource` supplies the dialect; synthesized trait schemas use their host type.
 */
export function assertSafeSchemaPatterns(root: unknown, dialectSource: unknown = root): void {
  const keywords = keywordsFor(dialectSource);
  const stack: Array<{ value: any; depth: number; resource: any }> = [{ value: root, depth: 0, resource: root }];
  const seen = new WeakSet<object>();
  let paths = 0;
  while (stack.length > 0) {
    const { value, depth, resource: enclosing } = stack.pop()!;
    if (!isPlainSchemaObject(value) || seen.has(value)) continue;
    if (depth > MAX_SCHEMA_DEPTH) throw new EntityContentDepthError();
    if (++paths > MAX_SCHEMA_PATHS) throw new Error(`Schema exceeds the ${MAX_SCHEMA_PATHS} path safety limit`);
    seen.add(value);
    const patterns = [
      ...(typeof value.pattern === 'string' ? [value.pattern] : []),
      ...(isPlainSchemaObject(value.patternProperties) ? Object.keys(value.patternProperties) : []),
    ];
    for (const pattern of patterns) {
      compileSafePattern(pattern, 'u');
    }
    const resource = value !== root && isEmbeddedResource(value) ? value : enclosing;
    const push = (subschema: unknown) => stack.push({ value: subschema, depth: depth + 1, resource });
    visitSubschemas(value, keywords, push);
    // References make their targets schema positions, even under unknown keywords.
    const reference = resolveLocalRef(root, resource, value.$ref);
    if (reference !== undefined) {
      stack.push({ value: reference.target, depth: depth + 1, resource: reference.resource });
    }
  }
}
