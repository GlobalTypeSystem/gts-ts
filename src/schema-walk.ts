/*
 * Dialect-aware traversal of schema locations (gts-spec §9.6.3, §11.0).
 *
 * Visits the schema positions the declared dialect and the schema engine define, including
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
// The schema engine compiles schema-valued `dependencies` in every dialect, and both `$defs` and
// `definitions` (it does not tie either keyword to a dialect). `contentSchema` is an annotation
// the engine never evaluates, so it is not traversed.
const SCHEMA_MAP_KEYWORDS: Record<SchemaDialect, ReadonlySet<string>> = {
  'draft-07': new Set(['$defs', 'definitions', 'dependencies', 'patternProperties', 'properties']),
  '2019-09': new Set(['$defs', 'definitions', 'dependencies', 'dependentSchemas', 'patternProperties', 'properties']),
  '2020-12': new Set(['$defs', 'definitions', 'dependencies', 'dependentSchemas', 'patternProperties', 'properties']),
};
// The schema engine resolves `$recursiveRef` (2019-09) and `$dynamicRef` (2020-12) like `$ref` for
// their initial target: a JSON Pointer, the resource itself, or an anchor.
const SCHEMA_REF_KEYWORDS: Record<SchemaDialect, ReadonlySet<string>> = {
  'draft-07': new Set(['$ref']),
  '2019-09': new Set(['$ref', '$recursiveRef']),
  '2020-12': new Set(['$ref', '$dynamicRef']),
};

interface Keywords {
  values: ReadonlySet<string>;
  arrays: ReadonlySet<string>;
  maps: ReadonlySet<string>;
  refs: ReadonlySet<string>;
}

function union(sets: Record<SchemaDialect, ReadonlySet<string>>): ReadonlySet<string> {
  return new Set(Object.values(sets).flatMap((set) => [...set]));
}

// Without a supported dialect, check schema keywords from all supported drafts.
const ANY_DIALECT: Keywords = {
  values: union(SCHEMA_VALUE_KEYWORDS),
  arrays: union(SCHEMA_ARRAY_KEYWORDS),
  maps: union(SCHEMA_MAP_KEYWORDS),
  refs: union(SCHEMA_REF_KEYWORDS),
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
    refs: SCHEMA_REF_KEYWORDS[dialect],
  };
}

/** A subschema whose `$id` starts a new resource (not a draft-07 `#anchor`). */
export function isEmbeddedResource(value: any): boolean {
  return typeof value.$id === 'string' && value.$id !== '' && !value.$id.startsWith('#');
}

// Keys under which an `$id` does not change the resolution scope of a JSON Pointer.
const PREVENT_SCOPE_CHANGE = new Set(['properties', 'patternProperties', 'enum', 'dependencies', 'definitions']);

/**
 * The resource a local reference resolves in, and its decoded fragment. A
 * malformed fragment returns null; a reference to another resource returns
 * undefined.
 */
function localFragment(
  root: any,
  resource: Resource,
  ref: unknown
): { scope: Resource; fragment: string } | null | undefined {
  if (typeof ref !== 'string') return undefined;
  const hash = ref.indexOf('#');
  const base = hash < 0 ? ref : ref.slice(0, hash);
  const scope: Resource | undefined =
    base === '' || base === resource.schema.$id ? resource : base === root.$id ? { schema: root, path: '' } : undefined;
  if (scope === undefined) return undefined;
  // Decode before splitting: `%2F` separates segments; `~1` is a literal slash.
  try {
    return { scope, fragment: hash < 0 ? '' : decodeURIComponent(ref.slice(hash + 1)) };
  } catch {
    return null;
  }
}

/** A value in a document, its JSON Pointer, and the resource its local references resolve in. */
interface Located {
  target: unknown;
  resource: Resource;
  path: string;
}

/**
 * Resolve a local pointer and return its target and resource, following
 * embedded `$id` scopes. A local pointer that names no value returns null.
 * External refs and anchors return undefined.
 */
export function resolveLocalRef(root: any, resource: Resource, ref: unknown): Located | null | undefined {
  const local = localFragment(root, resource, ref);
  if (!local) return local;
  const { scope, fragment } = local;
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

/** The anchor a local reference names (`#name`), or undefined for any other reference. */
function localAnchor(root: any, resource: Resource, ref: unknown): string | undefined {
  const local = localFragment(root, resource, ref);
  return local && local.fragment !== '' && !local.fragment.startsWith('/') ? local.fragment : undefined;
}

/** Keywords whose values are literal data, never schemas or keywords. */
const LITERAL_KEYWORDS = new Set(['const', 'enum', 'default', 'examples', 'x-gts-traits']);
/** Keywords whose values map names (which may spell keywords) to schemas. */
const NAME_MAP_KEYWORDS = union(SCHEMA_MAP_KEYWORDS);

/** The anchors `object` declares: `$anchor`, `$dynamicAnchor`, and a draft-07 `$id` fragment. */
function declaredAnchors(object: Record<string, unknown>): string[] {
  const anchors = [object.$anchor, object.$dynamicAnchor].filter((name): name is string => typeof name === 'string');
  const id = typeof object.$id === 'string' ? object.$id : '';
  const hash = id.indexOf('#');
  if (hash >= 0) {
    try {
      const fragment = decodeURIComponent(id.slice(hash + 1));
      if (fragment !== '' && !fragment.startsWith('/')) anchors.push(fragment);
    } catch {
      // A malformed fragment declares no anchor.
    }
  }
  return anchors;
}

/**
 * Every object in `root` that declares an anchor, by name, wherever it sits
 * outside literal data: the engine resolves a `$dynamicAnchor` even under an
 * unknown keyword. Anchors of every resource are included, so a reference
 * may name more targets here than the engine resolves it to, never fewer.
 */
function anchorIndex(root: unknown): Map<string, Located[]> {
  const index = new Map<string, Located[]>();
  // `names`: the object maps names to schemas, so none of its keys is a keyword.
  const stack: Array<Located & { names: boolean }> = [
    { target: root, path: '', resource: { schema: root, path: '' }, names: false },
  ];
  let visited = 0;
  while (stack.length > 0) {
    const { target, path, resource: enclosing, names } = stack.pop()!;
    if (target === null || typeof target !== 'object') continue;
    if (++visited > MAX_SCHEMA_PATHS) throw new Error(`Schema exceeds the ${MAX_SCHEMA_PATHS} path safety limit`);
    if (Array.isArray(target)) {
      target.forEach((item, i) =>
        stack.push({ target: item, path: pointer(path, i), resource: enclosing, names: false })
      );
      continue;
    }
    const object = target as Record<string, unknown>;
    const resource = !names && object !== root && isEmbeddedResource(object) ? { schema: object, path } : enclosing;
    if (!names) {
      for (const name of declaredAnchors(object)) {
        index.set(name, [...(index.get(name) ?? []), { target: object, resource, path }]);
      }
    }
    for (const [key, child] of Object.entries(object)) {
      if (!names && LITERAL_KEYWORDS.has(key)) continue;
      stack.push({ target: child, path: pointer(path, key), resource, names: !names && NAME_MAP_KEYWORDS.has(key) });
    }
  }
  return index;
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

export function escapeJsonPointerSegment(segment: string | number): string {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointer(path: string, segment: string | number): string {
  return `${path}/${escapeJsonPointerSegment(segment)}`;
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
  let anchors: Map<string, Located[]> | undefined;
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
    for (const keyword of keywords.refs) {
      const ref = value[keyword];
      const reference = resolveLocalRef(root, resource, ref);
      // Ajv compiles a reference to a scalar or an array permissively, so such a
      // target must be reported rather than silently accepting the subtree.
      if (reference === null || (reference !== undefined && !isSchemaValue(reference.target))) {
        onInvalidRef?.(pointer(path, keyword), ref);
        continue;
      }
      const name = reference === undefined ? localAnchor(root, resource, ref) : undefined;
      const targets =
        reference !== undefined ? [reference] : name !== undefined ? (anchors ??= anchorIndex(root)).get(name) : [];
      // Located where the target is declared, so diagnostics point at it.
      for (const target of targets ?? []) {
        stack.push({ value: target.target, path: target.path, depth: depth + 1, resource: target.resource });
      }
    }
  }
}

/**
 * Calls `visit` for each direct subschema of `schema` under any supported
 * dialect, without following references. For callers that drive their own
 * recursion; use {@link forEachSchemaNode} to visit every schema location.
 */
export function visitJsonSubschemas(schema: any, path: string, visit: (subschema: any, path: string) => void): void {
  pushSubschemas(schema, path, ANY_DIALECT, visit);
}
