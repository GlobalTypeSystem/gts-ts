/*
 * Dialect-aware traversal of schema locations (gts-spec §9.6.3, §11.0).
 *
 * Visits the schema positions the declared dialect and Ajv define, including
 * definitions, inactive branches and `x-gts-traits-schema`. Literal data
 * (`const`, `enum`, `default`, `examples`, `x-gts-traits`), property names and
 * unknown keywords are visited only when a local `$ref` makes them a schema
 * position. Shared by the regex safety check and the GTS keyword checks so
 * both agree on what a schema location is. Mirrors gts-rust
 * `for_each_schema_node`.
 */

import { MAX_SCHEMA_DEPTH, MAX_SCHEMA_PATHS, EntityContentDepthError } from './types';
import { isPlainSchemaObject } from './json-canonical';
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
// The 2019-09 and 2020-12 meta-schemas retain `definitions` and
// `dependencies` as schema positions, and Ajv applies both in every dialect.
const SCHEMA_MAP_KEYWORDS: Record<SchemaDialect, ReadonlySet<string>> = {
  'draft-07': new Set(['definitions', 'dependencies', 'patternProperties', 'properties']),
  '2019-09': new Set(['$defs', 'definitions', 'dependencies', 'dependentSchemas', 'patternProperties', 'properties']),
  '2020-12': new Set(['$defs', 'definitions', 'dependencies', 'dependentSchemas', 'patternProperties', 'properties']),
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

/** A subschema whose `$id` starts a new resource (not a draft-07 `#anchor`). */
export function isEmbeddedResource(value: any): boolean {
  return typeof value.$id === 'string' && value.$id !== '' && !value.$id.startsWith('#');
}

// Keys under which Ajv does not let an `$id` change the resolution scope of a
// JSON Pointer (ajv/lib/compile/index.ts).
const PREVENT_SCOPE_CHANGE = new Set(['properties', 'patternProperties', 'enum', 'dependencies', 'definitions']);

/**
 * Resolve a local pointer and return its target and resource, following Ajv's
 * embedded `$id` scopes. A local pointer that names no value returns null.
 * External refs return undefined; anchors are skipped because their schema
 * positions are already visited.
 */
export function resolveLocalRef(
  root: any,
  resource: Resource,
  ref: unknown
): { target: unknown; resource: Resource; path: string } | null | undefined {
  if (typeof ref !== 'string') return undefined;
  const hash = ref.indexOf('#');
  const base = hash < 0 ? ref : ref.slice(0, hash);
  const scope: Resource | undefined =
    base === '' || base === resource.schema.$id ? resource : base === root.$id ? { schema: root, path: '' } : undefined;
  if (scope === undefined) return undefined;
  // Decode before splitting: `%2F` separates segments; `~1` is a literal slash.
  let fragment: string;
  try {
    fragment = hash < 0 ? '' : decodeURIComponent(ref.slice(hash + 1));
  } catch {
    return null;
  }
  if (fragment === '') return { target: scope.schema, resource: scope, path: scope.path };
  if (!fragment.startsWith('/')) return undefined;
  let target: any = scope.schema;
  let path = scope.path;
  let targetResource = scope;
  for (const escaped of fragment.slice(1).split('/')) {
    const segment = escaped.replace(/~1/g, '/').replace(/~0/g, '~');
    if (target === null || typeof target !== 'object' || !Object.prototype.hasOwnProperty.call(target, segment)) {
      return null;
    }
    target = target[segment];
    path = pointer(path, segment);
    if (!PREVENT_SCOPE_CHANGE.has(segment) && isPlainSchemaObject(target) && isEmbeddedResource(target)) {
      targetResource = { schema: target, path };
    }
  }
  return { target, resource: targetResource, path };
}

/** A schema resource (the document or an embedded `$id` subschema) and its JSON Pointer. */
export interface Resource {
  schema: any;
  path: string;
}

function isSchemaValue(value: unknown): boolean {
  return typeof value === 'boolean' || isPlainSchemaObject(value);
}

/**
 * Called once for every schema object with its JSON Pointer (`''` for the
 * root) and the resource its local `$ref`s resolve against.
 */
export type SchemaNodeVisitor = (node: Record<string, any>, path: string, resource: Resource) => void;

function pointer(path: string, segment: string | number): string {
  return `${path}/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

/** Schema locations that declare schemas for reuse or for other types, without applying them. */
const DECLARATION_KEYWORDS = new Set(['$defs', 'definitions', 'x-gts-traits-schema']);

function pushSubschemas(
  schema: Record<string, unknown>,
  path: string,
  keywords: Keywords,
  push: (subschema: unknown, path: string) => void,
  declarations: boolean = true
): void {
  for (const [key, value] of Object.entries(schema)) {
    if (!declarations && DECLARATION_KEYWORDS.has(key)) continue;
    const keyPath = pointer(path, key);
    if (keywords.values.has(key) || key === 'x-gts-traits-schema') {
      push(value, keyPath);
    } else if (keywords.arrays.has(key) && Array.isArray(value)) {
      value.forEach((item, index) => push(item, pointer(keyPath, index)));
    } else if (keywords.maps.has(key) && isPlainSchemaObject(value)) {
      // Array-valued `dependencies` entries are property lists, not schemas.
      for (const [name, child] of Object.entries(value)) {
        if (!Array.isArray(child)) push(child, pointer(keyPath, name));
      }
    } else if (key === 'items') {
      if (Array.isArray(value)) value.forEach((item, index) => push(item, pointer(keyPath, index)));
      else push(value, keyPath);
    }
  }
}

/**
 * Visits every schema object reachable from `root` once, failing closed beyond
 * {@link MAX_SCHEMA_DEPTH} or {@link MAX_SCHEMA_PATHS}. `dialectSource`
 * supplies the dialect; synthesized trait schemas use their host type.
 * `onInvalidRef` receives each local `$ref` whose target is missing or is not
 * a schema (an object or a boolean). `from` starts the walk at subschemas of
 * `root` that lie in `resource` instead of at `root`, and visits only the
 * locations that apply to an instance there: declarations (`definitions`,
 * `$defs`, `x-gts-traits-schema`) are visited only through a `$ref`. Their
 * own pointers are reported as `''`.
 */
export function forEachSchemaNode(
  root: unknown,
  visit: SchemaNodeVisitor,
  dialectSource: unknown = root,
  onInvalidRef?: (path: string, ref: string) => void,
  from?: { subschemas: unknown[]; resource: Resource }
): void {
  const keywords = keywordsFor(dialectSource);
  const stack: Array<{ value: any; path: string; depth: number; resource: Resource }> = from
    ? from.subschemas.map((value) => ({ value, path: '', depth: 0, resource: from.resource }))
    : [{ value: root, path: '', depth: 0, resource: { schema: root, path: '' } }];
  const seen = new WeakSet<object>();
  let paths = 0;
  while (stack.length > 0) {
    const { value, path, depth, resource: enclosing } = stack.pop()!;
    if (!isPlainSchemaObject(value) || seen.has(value)) continue;
    if (depth > MAX_SCHEMA_DEPTH) throw new EntityContentDepthError();
    if (++paths > MAX_SCHEMA_PATHS) throw new Error(`Schema exceeds the ${MAX_SCHEMA_PATHS} path safety limit`);
    seen.add(value);
    const resource = value !== root && isEmbeddedResource(value) ? { schema: value, path } : enclosing;
    visit(value, path, resource);
    pushSubschemas(
      value,
      path,
      keywords,
      (subschema, subpath) => stack.push({ value: subschema, path: subpath, depth: depth + 1, resource }),
      from === undefined
    );
    // References make their targets schema positions, even under unknown keywords.
    const reference = resolveLocalRef(root, resource, value.$ref);
    // Ajv compiles a reference to a scalar or an array permissively, so such a
    // target must be reported rather than silently accepting the subtree.
    if (reference === null || (reference !== undefined && !isSchemaValue(reference.target))) {
      onInvalidRef?.(pointer(path, '$ref'), value.$ref);
    } else if (reference !== undefined) {
      // Located where the target is declared, so diagnostics point at it.
      stack.push({ value: reference.target, path: reference.path, depth: depth + 1, resource: reference.resource });
    }
  }
}

const ANY_VALUE_KEYWORDS = new Set([
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
  'x-gts-traits-schema',
]);
const ANY_LIST_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const ANY_MAP_KEYWORDS = new Set(['$defs', 'definitions', 'dependentSchemas', 'properties', 'patternProperties']);

export function escapeJsonPointerSegment(segment: string | number): string {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Calls `visit` for each direct subschema of `schema` under any supported
 * dialect, without following references. For callers that drive their own
 * recursion; use {@link forEachSchemaNode} to visit every schema location.
 */
export function visitJsonSubschemas(schema: any, path: string, visit: (subschema: any, path: string) => void): void {
  for (const [key, value] of Object.entries(schema)) {
    const nestedPath = `${path}/${escapeJsonPointerSegment(key)}`;
    if (ANY_VALUE_KEYWORDS.has(key)) {
      visit(value, nestedPath);
    } else if (ANY_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${nestedPath}/${index}`));
    } else if (ANY_MAP_KEYWORDS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, childSchema] of Object.entries(value)) {
        visit(childSchema, `${nestedPath}/${escapeJsonPointerSegment(name)}`);
      }
    } else if (key === 'items') {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${nestedPath}/${index}`));
      } else {
        visit(value, nestedPath);
      }
    } else if (key === 'dependencies' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, dependency] of Object.entries(value)) {
        if (!Array.isArray(dependency)) {
          visit(dependency, `${nestedPath}/${escapeJsonPointerSegment(name)}`);
        }
      }
    }
  }
}
