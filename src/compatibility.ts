import {
  CompatibilityResult,
  CompatVerdict,
  EntityLookup,
  GTS_URI_PREFIX,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_PATHS,
} from './types';
import { Gts } from './gts';

/**
 * Type Schema Evolution Compatibility (GTS spec 0.13 §4.2 - §4.5).
 *
 * Compatibility is defined by accepted-instance-set inclusion (§4.3):
 *
 *   backward: Valid(old) subset-of Valid(new)
 *   forward:  Valid(new) subset-of Valid(old)
 *   full:     Valid(old) == Valid(new)
 *
 * Both directions are therefore the same question asked twice, so the engine
 * implements a single primitive - `subsumes(outer, inner)`, "does `outer`
 * accept every instance `inner` accepts" - and runs it in both directions.
 * Each relation is reported as the tri-state `compatible` / `incompatible` /
 * `unknown`; `unknown` preserves an inconclusive check rather than conflating
 * it with incompatibility.
 */

/**
 * How the engine treats each schema keyword.
 *
 * - `annotation`  - documentation only; never changes Valid(S) (§4.3).
 * - `composition` - folded into the effective schema before comparison.
 * - `modeled`     - compared directly by one of the `compare*` methods.
 * - `unmodeled`   - a real assertion the engine cannot reason about; a
 *                   difference makes the comparison inconclusive (`unknown`).
 * - `narrowing`   - a real assertion whose *presence* the engine can reason
 *                   about even though it cannot compare two present-but-
 *                   different values: adding it strictly shrinks Valid(S)
 *                   relative to not having it at all, removing it strictly
 *                   grows Valid(S), and it does not compose with anything
 *                   else that would change that. Compared by
 *                   `compareNarrowing`, which implements the same
 *                   `added`/`removed`/`changed`/`equal` relation as
 *                   gts-rust's `NARROWING` set (`schema_evolution.rs:831-878`
 *                   - `pattern`, `format`, `multipleOf`): added is
 *                   forward-only, removed is backward-only, a value change on
 *                   both sides is `unknown`, equal values are a no-op.
 *
 * This is the single source of truth. Everything below - what gets stripped,
 * which keywords mean "this level constrains objects", which axis a bound sits
 * on - is derived from it, so a keyword cannot end up classified one way in one
 * place and another way somewhere else. Anything absent from the table is
 * treated as `unmodeled`, which fails closed rather than being ignored.
 */
type KeywordKind = 'annotation' | 'composition' | 'modeled' | 'unmodeled' | 'narrowing';

interface KeywordSpec {
  kind: KeywordKind;
  /** Set when the keyword constrains the object content model at its level. */
  object?: boolean;
  /** Set when the keyword is a numeric bound, naming its axis and whether it excludes the endpoint. */
  bound?: { axis: 'minimum' | 'maximum' | 'length' | 'items'; exclusive: boolean };
  /**
   * Shape a `modeled` keyword's value must have for the engine to reason about
   * it. Schemas are registered without meta-validation, so a value of the wrong
   * shape is possible; when one appears the comparison is inconclusive rather
   * than silently treated as "no constraint".
   */
  shape?: (value: unknown) => boolean;
  /**
   * Where subschemas live under this keyword, so that a walker knows which
   * values are schemas and which are plain data.
   *
   * Without this a walker cannot tell `{properties: {title: {...}}}` - where
   * `title` is a *property name* - from a schema position where `title` is the
   * annotation keyword, and will happily delete user data.
   */
  values?: 'schema' | 'schemaMap' | 'schemaList';
}

const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSchemaValue = (v: unknown) => typeof v === 'boolean' || isObject(v);
const isNumber = (v: unknown) => typeof v === 'number';
const isStringOrStringArray = (v: unknown) =>
  typeof v === 'string' || (Array.isArray(v) && v.every((t) => typeof t === 'string'));

const KEYWORDS: Record<string, KeywordSpec> = {
  // Documentation and identity
  title: { kind: 'annotation' },
  description: { kind: 'annotation' },
  examples: { kind: 'annotation' },
  default: { kind: 'annotation' },
  deprecated: { kind: 'annotation' },
  readOnly: { kind: 'annotation' },
  writeOnly: { kind: 'annotation' },
  $comment: { kind: 'annotation' },
  $id: { kind: 'annotation' },
  $schema: { kind: 'annotation' },
  $defs: { kind: 'annotation', values: 'schemaMap' },
  definitions: { kind: 'annotation', values: 'schemaMap' },
  // Draft-07 treats `format` as an annotation unless assertion is enabled;
  // `GtsStore` enables it (`validateFormats: true` plus `applyGtsFormats`),
  // so a `format` difference genuinely changes Valid(S) and cannot be an
  // `annotation` here. See the `narrowing` kind above.
  format: { kind: 'narrowing' },

  // Folded in by the resolver before anything is compared
  allOf: { kind: 'composition', values: 'schemaList', shape: Array.isArray },
  $ref: { kind: 'composition', shape: (v) => typeof v === 'string' },

  // Compared directly
  type: { kind: 'modeled', shape: isStringOrStringArray },
  enum: { kind: 'modeled', shape: Array.isArray },
  const: { kind: 'modeled' },
  items: { kind: 'modeled', values: 'schema', shape: (v) => isSchemaValue(v) || Array.isArray(v) },
  properties: { kind: 'modeled', object: true, values: 'schemaMap', shape: isObject },
  required: { kind: 'modeled', object: true, shape: (v) => Array.isArray(v) && v.every((n) => typeof n === 'string') },
  additionalProperties: { kind: 'modeled', object: true, values: 'schema', shape: isSchemaValue },
  unevaluatedProperties: { kind: 'modeled', object: true, values: 'schema', shape: isSchemaValue },
  minimum: { kind: 'modeled', bound: { axis: 'minimum', exclusive: false }, shape: isNumber },
  exclusiveMinimum: { kind: 'modeled', bound: { axis: 'minimum', exclusive: true }, shape: isNumber },
  maximum: { kind: 'modeled', bound: { axis: 'maximum', exclusive: false }, shape: isNumber },
  exclusiveMaximum: { kind: 'modeled', bound: { axis: 'maximum', exclusive: true }, shape: isNumber },
  minLength: { kind: 'modeled', bound: { axis: 'length', exclusive: false }, shape: isNumber },
  maxLength: { kind: 'modeled', bound: { axis: 'length', exclusive: false }, shape: isNumber },
  minItems: { kind: 'modeled', bound: { axis: 'items', exclusive: false }, shape: isNumber },
  maxItems: { kind: 'modeled', bound: { axis: 'items', exclusive: false }, shape: isNumber },

  // Real assertions the engine does not model
  oneOf: { kind: 'unmodeled', values: 'schemaList' },
  anyOf: { kind: 'unmodeled', values: 'schemaList' },
  not: { kind: 'unmodeled', values: 'schema' },
  if: { kind: 'unmodeled', values: 'schema' },
  then: { kind: 'unmodeled', values: 'schema' },
  else: { kind: 'unmodeled', values: 'schema' },
  pattern: { kind: 'narrowing' },
  patternProperties: { kind: 'unmodeled', object: true, values: 'schemaMap' },
  propertyNames: { kind: 'unmodeled', object: true, values: 'schema' },
  dependencies: { kind: 'unmodeled', object: true },
  dependentSchemas: { kind: 'unmodeled', object: true, values: 'schemaMap' },
  dependentRequired: { kind: 'unmodeled', object: true },
  multipleOf: { kind: 'narrowing' },
  contains: { kind: 'unmodeled', values: 'schema' },
  additionalItems: { kind: 'unmodeled', values: 'schema' },
  uniqueItems: { kind: 'unmodeled' },
  // Enforced against instances by OP#6 (§9.6), so it is an assertion, not an
  // annotation - even though it shares the `x-gts-` prefix with the type-level
  // keywords that genuinely are metadata.
  'x-gts-ref': { kind: 'unmodeled' },
};

/**
 * Where subschemas live under each keyword, derived from `KEYWORDS` so this
 * remains the single source of truth for the position-aware walk instead of
 * a second, divergence-prone copy. Consumed here by `stripSubschemas()` /
 * `hasMalformedKeyword()`, and by `GtsModifiers.scanSubschemas()` (see
 * `modifiers.ts`), which needs the same schema/schemaMap/schemaList
 * classification for its own position-aware walk but has no other reason to
 * depend on the rest of this module's keyword handling.
 */
export const SCHEMA_KEYWORD_POSITIONS: Record<string, 'schema' | 'schemaMap' | 'schemaList'> = Object.fromEntries(
  Object.entries(KEYWORDS)
    .filter(([, spec]) => spec.values !== undefined)
    .map(([key, spec]) => [key, spec.values as 'schema' | 'schemaMap' | 'schemaList'])
);

function keywordKind(key: string): KeywordKind {
  const spec = KEYWORDS[key];
  if (spec) return spec.kind;
  // The remaining `x-gts-*` keywords describe the type, not the instance.
  if (key.startsWith('x-gts-')) return 'annotation';
  // Unrecognised keywords are assumed to constrain something.
  return 'unmodeled';
}

/**
 * True when this schema carries a value the engine cannot read: a keyword of
 * the wrong shape, or a subschema position holding something that is not a
 * schema. Both would otherwise be dropped during resolution and read as
 * "no constraint".
 */
function hasMalformedKeyword(schema: Schema, depth = 0): boolean {
  if (schema === undefined) return false;
  if (typeof schema === 'boolean') return false;
  if (typeof schema !== 'object' || schema === null) return true;
  if (depth > MAX_SCHEMA_DEPTH) return true;

  return Object.entries(schema).some(([key, value]) => {
    const spec = KEYWORDS[key];
    // Annotation-kind content (e.g. `$defs`) is never read for comparison, so
    // its internal shape must not be able to force an inconclusive verdict.
    if (spec?.kind === 'annotation') return false;
    if (spec?.shape && !spec.shape(value)) return true;

    switch (spec?.values) {
      case 'schema':
        return Array.isArray(value)
          ? value.some((v) => hasMalformedKeyword(v, depth + 1))
          : malformedSubschema(value, depth);
      case 'schemaList':
        return !Array.isArray(value) || value.some((v) => hasMalformedKeyword(v, depth + 1));
      case 'schemaMap':
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return true;
        return Object.values(value).some((v) => malformedSubschema(v, depth));
      default:
        return false;
    }
  });
}

function malformedSubschema(value: unknown, depth: number): boolean {
  if (typeof value === 'boolean') return false;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return true;
  return hasMalformedKeyword(value, depth + 1);
}

/**
 * True when this schema contains a local JSON-pointer `$ref`
 * (a string starting with `#`) anywhere reachable through a genuinely
 * compared position - `properties`, `items`, `allOf`, etc, per `KEYWORDS`'
 * `values` metadata. `SchemaResolver.lookupRef()` deliberately never follows
 * local pointers, so a local ref buried under a compared position would
 * otherwise be dropped silently during resolution and read as "no
 * constraint" rather than downgrading the verdict to `unknown`.
 *
 * Annotation-kind positions (e.g. `$defs` itself) are not walked: their
 * content is never compared, so a local ref sitting only inside `$defs` is
 * irrelevant (see `hasMalformedKeyword`'s matching annotation skip above).
 */
function hasUnresolvableLocalRef(schema: Schema, depth = 0): boolean {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  if (depth > MAX_SCHEMA_DEPTH) return false;

  return Object.entries(schema).some(([key, value]) => {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#')) return true;

    const spec = KEYWORDS[key];
    if (spec?.kind === 'annotation') return false;

    switch (spec?.values) {
      case 'schema':
        return Array.isArray(value)
          ? value.some((v) => hasUnresolvableLocalRef(v, depth + 1))
          : hasUnresolvableLocalRef(value, depth + 1);
      case 'schemaList':
        return Array.isArray(value) && value.some((v) => hasUnresolvableLocalRef(v, depth + 1));
      case 'schemaMap':
        return (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          Object.values(value).some((v) => hasUnresolvableLocalRef(v, depth + 1))
        );
      default:
        return false;
    }
  });
}

/** Keywords whose presence means this level says something about object content. */
const OBJECT_KEYWORDS = Object.keys(KEYWORDS).filter((key) => KEYWORDS[key].object);

/** The bound keywords grouped by axis, for normalized `(value, exclusive)` comparison. */
const BOUND_AXES: Array<{ axis: string; isLower: boolean; keywords: Array<{ key: string; exclusive: boolean }> }> = [
  { axis: 'minimum', isLower: true, keywords: [] },
  { axis: 'maximum', isLower: false, keywords: [] },
  { axis: 'minLength', isLower: true, keywords: [{ key: 'minLength', exclusive: false }] },
  { axis: 'maxLength', isLower: false, keywords: [{ key: 'maxLength', exclusive: false }] },
  { axis: 'minItems', isLower: true, keywords: [{ key: 'minItems', exclusive: false }] },
  { axis: 'maxItems', isLower: false, keywords: [{ key: 'maxItems', exclusive: false }] },
];
for (const [key, spec] of Object.entries(KEYWORDS)) {
  if (spec.bound?.axis === 'minimum') BOUND_AXES[0].keywords.push({ key, exclusive: spec.bound.exclusive });
  if (spec.bound?.axis === 'maximum') BOUND_AXES[1].keywords.push({ key, exclusive: spec.bound.exclusive });
}

/**
 * The JSON-Schema type each bound axis actually constrains - `minimum`/
 * `maximum` only ever apply to numbers, the length axis only to strings, the
 * items axis only to arrays. A value of any other type sails through the
 * bound keyword entirely regardless of its measured "size" (§4.3's own
 * accepted-instance-set definition follows JSON Schema's per-keyword
 * applicability rules), so a schema that doesn't even admit this axis's
 * target type can never be constrained by it.
 */
const AXIS_TARGET_TYPE: Record<string, string> = {
  minimum: 'number',
  maximum: 'number',
  minLength: 'string',
  maxLength: 'string',
  minItems: 'array',
  maxItems: 'array',
};

/** Whether a (possibly unknown) type set could contain the axis's target type. */
function typeSetAdmitsAxis(types: Set<string> | null, target: string): boolean {
  if (types === null) return true; // genuinely unconstrained - the axis might still apply
  if (target === 'number') return types.has('number') || types.has('integer');
  return types.has(target);
}

/**
 * True when a schema declares at least one `patternProperties` pattern.
 * `contentModel()`/`undeclaredSchema()` only look at `properties` and
 * `additionalProperties`/`unevaluatedProperties` - in Draft-07,
 * `additionalProperties` applies only to properties matched by neither
 * `properties` NOR `patternProperties`, so a level closed with
 * `additionalProperties: false` beside a live `patternProperties` map is NOT
 * actually fully closed the way `contentModel()` models it. Precisely
 * modeling which extra property names a regex pattern does or doesn't admit
 * is out of scope for this engine, so `compareObjects` fails closed to
 * `unknown` instead whenever `patternProperties` is in play, per this
 * engine's existing fail-closed convention for keywords it does not fully
 * reason about.
 */
function hasPatternProperties(schema: Schema): boolean {
  const pp = typeof schema === 'object' && schema !== null ? schema.patternProperties : undefined;
  return isObject(pp) && Object.keys(pp).length > 0;
}

/** A schema whose accepted set is everything, used for undeclared properties of an open model. */
const ANY_SCHEMA = true;

type Schema = any;

/** Worst-case combination: incompatible dominates unknown, which dominates compatible. */
function worst(a: CompatVerdict, b: CompatVerdict): CompatVerdict {
  if (a === 'incompatible' || b === 'incompatible') return 'incompatible';
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return 'compatible';
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((k) => k in b && deepEqual(a[k], b[k]));
}

/**
 * Strip annotations so that documentation-only edits compare equal.
 *
 * The walk is position-aware: annotation keywords are only removed where a
 * *schema* is expected. Inside a `properties` map the keys are user-chosen
 * property names, so a property legitimately called `title` or `format` is data
 * and must survive; recursing blindly deleted it and made two schemas that
 * differ only in that property compare as identical.
 */
function stripAnnotations(schema: Schema): Schema {
  if (typeof schema === 'boolean') return schema;
  if (schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(stripAnnotations);

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (keywordKind(key) === 'annotation') continue;
    out[key] = stripSubschemas(key, value);
  }
  return out;
}

/** Applies `stripAnnotations` only to the schema positions under `keyword`. */
function stripSubschemas(keyword: string, value: any): any {
  switch (KEYWORDS[keyword]?.values) {
    case 'schema':
      return stripAnnotations(value);
    case 'schemaList':
      return Array.isArray(value) ? value.map(stripAnnotations) : value;
    case 'schemaMap':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
      return Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, stripAnnotations(sub)]));
    default:
      // Plain data (`const`, `enum`, `required`, `type`, ...) is left alone.
      return value;
  }
}

export function isEmptySchema(schema: Schema): boolean {
  if (schema === true) return true;
  if (typeof schema !== 'object' || schema === null) return false;
  return Object.keys(stripAnnotations(schema)).length === 0;
}

/** The JSON-Schema type name(s) a single fixed value implies, by its JS runtime shape. */
function impliedTypesOf(value: any): string[] {
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array'];
  switch (typeof value) {
    case 'string':
      return ['string'];
    case 'boolean':
      return ['boolean'];
    case 'number':
      return Number.isInteger(value) ? ['number', 'integer'] : ['number'];
    case 'object':
      return ['object'];
    default:
      return [];
  }
}

function typeSet(schema: Schema): Set<string> | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const type = schema.type;
  if (type !== undefined) return new Set(Array.isArray(type) ? type : [type]);

  // No `type` keyword: a `const`/`enum` value set still implies a type - its
  // values ARE that type - even though the schema never states it literally.
  const values = fixedValues(schema);
  if (values === null) return null; // genuinely unconstrained
  const implied = new Set<string>();
  for (const v of values) for (const t of impliedTypesOf(v)) implied.add(t);
  return implied;
}

/** `number` also accepts every `integer`, so widen the accepting side. */
function widenNumeric(types: Set<string>): Set<string> {
  const out = new Set(types);
  if (out.has('number')) out.add('integer');
  return out;
}

/**
 * Intersects two `type` keywords, or returns null when they are disjoint - the
 * conjunction then accepts nothing, and the caller collapses the whole schema
 * to `false` rather than keeping one side and pretending it is satisfiable.
 */
function intersectTypes(a: any, b: any): any | null {
  const setA = new Set<string>(Array.isArray(a) ? a : [a]);
  const setB = new Set<string>(Array.isArray(b) ? b : [b]);

  // `integer` is a subset of `number`, so each side keeps a type the other
  // admits. Widening *both* sides made `number` ∩ `number` yield
  // `['number','integer']`, and the specificity rule below then collapsed it to
  // `integer` - narrowing a type that neither side narrowed.
  const both = [
    ...Array.from(setA).filter((t) => setB.has(t) || (t === 'integer' && setB.has('number'))),
    ...Array.from(setB).filter((t) => t === 'integer' && setA.has('number')),
  ];
  const unique = Array.from(new Set(both));

  if (unique.length === 0) return null;
  return unique.length === 1 ? unique[0] : unique;
}

/** The finite value set a schema pins down via `const` / `enum`, or null if unconstrained. */
function fixedValues(schema: Schema): any[] | null {
  if (typeof schema !== 'object' || schema === null) return null;
  if ('const' in schema) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum;
  return null;
}

type ContentModel = 'open' | 'closed' | 'partial';

/** Whether a keyword value is a schema (not `undefined`/`true`/an effectively-empty schema). */
function isRestrictiveSchema(value: Schema | undefined): boolean {
  return value !== undefined && value !== true && !isEmptySchema(value);
}

function contentModel(schema: Schema): ContentModel {
  if (typeof schema !== 'object' || schema === null) return 'open';
  const ap = schema.additionalProperties;
  const up = schema.unevaluatedProperties;
  if (ap === false || up === false) return 'closed';
  // `additionalProperties: true` evaluates every property `properties` /
  // `patternProperties` did not already evaluate, so `unevaluatedProperties`
  // never applies to anything - the level is fully open regardless of what
  // `unevaluatedProperties` says (2019-09+ `unevaluatedProperties` semantics).
  if (ap === true) return 'open';
  if (isRestrictiveSchema(ap) || isRestrictiveSchema(up)) return 'partial';
  return 'open';
}

/**
 * The schema an undeclared property must satisfy, or null when the level
 * rejects undeclared properties outright.
 */
function undeclaredSchema(schema: Schema): Schema | null {
  const model = contentModel(schema);
  if (model === 'closed') return null;
  if (model === 'open') return ANY_SCHEMA;
  const ap = schema.additionalProperties;
  const up = schema.unevaluatedProperties;
  const apRestrictive = isRestrictiveSchema(ap);
  const upRestrictive = isRestrictiveSchema(up);
  if (apRestrictive && upRestrictive) return mergeSchemas(ap, up);
  return apRestrictive ? ap : up;
}

/** Conjunction of two schemas, used to flatten `allOf` and `$ref` into one effective schema. */
function mergeSchemas(a: Schema, b: Schema): Schema {
  if (a === false || b === false) return false;
  const left = a === true || a === undefined ? {} : a;
  const right = b === true || b === undefined ? {} : b;
  if (typeof left !== 'object' || typeof right !== 'object') return left;

  const out: Record<string, any> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (!(key in out)) {
      out[key] = value;
      continue;
    }
    const current = out[key];
    switch (key) {
      case 'required':
        out[key] = Array.from(new Set([...(current || []), ...(value as any[])]));
        break;
      case 'properties': {
        const merged: Record<string, any> = { ...current };
        for (const [prop, propSchema] of Object.entries(value as Record<string, any>)) {
          merged[prop] = prop in merged ? mergeSchemas(merged[prop], propSchema) : propSchema;
        }
        out[key] = merged;
        break;
      }
      case 'additionalProperties':
      case 'unevaluatedProperties':
        if (current === false || value === false) out[key] = false;
        else if (current === true || current === undefined) out[key] = value;
        else if (value === true) out[key] = current;
        else out[key] = mergeSchemas(current, value);
        break;
      case 'type': {
        const intersection = intersectTypes(current, value);
        // Disjoint types across `allOf` branches: the conjunction is the
        // unsatisfiable schema, which accepts no instance at all.
        if (intersection === null) return false;
        out[key] = intersection;
        break;
      }
      case 'enum':
        // Schemas are registered without meta-validation, so a branch may carry
        // a malformed keyword. Keep the left-hand value rather than throwing;
        // the divergence then surfaces through the normal comparison.
        if (Array.isArray(current) && Array.isArray(value)) {
          out[key] = current.filter((x) => value.some((y) => deepEqual(x, y)));
        }
        break;
      case 'items':
        out[key] = mergeSchemas(current, value);
        break;
      case 'minimum':
      case 'exclusiveMinimum':
      case 'minLength':
      case 'minItems':
        if (typeof current === 'number' && typeof value === 'number') {
          out[key] = Math.max(current, value);
        }
        break;
      case 'maximum':
      case 'exclusiveMaximum':
      case 'maxLength':
      case 'maxItems':
        if (typeof current === 'number' && typeof value === 'number') {
          out[key] = Math.min(current, value);
        }
        break;
      default:
        // Keep the left-hand value; unmodeled divergence surfaces as `unknown`.
        break;
    }
  }
  return out;
}

/**
 * Resolves a schema to its effective form at one level: `$ref` targets and
 * `allOf` branches are merged in, per §4.4 ("classify the level from the
 * resolved effective schema"). Nested subschemas stay unresolved and are
 * resolved lazily when they are compared.
 */
class SchemaResolver {
  private unresolved = false;
  private exhausted = false;

  // Bounds the total number of `$ref` follows and `allOf` branch recursions
  // this resolver may take across its whole lifetime (one top-level
  // `subsumes()` call and every nested comparison made through it), on top
  // of `MAX_SCHEMA_DEPTH`'s per-chain-depth bound. A diamond-shaped `allOf`/
  // `$ref` DAG (level N reaching both level N-1 and N-2, which themselves
  // both reach a shared ancestor) revisits the same ref from multiple
  // sibling branches; with no cross-branch cache (see the removed
  // `resolvedRefCache` - caching resolved ref content by id is unsound here,
  // since a diamond ancestor can legitimately be reached at different
  // depths and `resolve()`'s own depth-based bailout must be evaluated
  // fresh each time), each revisit re-resolves the entire subtree beneath
  // it, compounding multiplicatively per level. Counted the same way as
  // `resolveTraitSchemaRefs`'s budget in `store.ts` and bailing out the same
  // way this class already bails out on `MAX_SCHEMA_DEPTH` - marking the
  // affected branch unresolved, which `finalize()` downgrades to `unknown`
  // - rather than throwing: nothing upstream of `compareSchemas()` (e.g.
  // `validateTraitChainSatisfiability` in `store.ts`) currently catches an
  // exception from this path, and an inconclusive verdict is this class's
  // own established convention for "part of the schema could not be
  // resolved" (see the depth bailout just below and this class's doc
  // comment).
  private pathCount = 0;

  constructor(private store: EntityLookup) {}

  /** True when any `$ref` encountered so far could not be resolved. */
  get hadUnresolvedRef(): boolean {
    return this.unresolved;
  }

  /**
   * True when this resolver's whole-lifetime path budget (`MAX_SCHEMA_PATHS`)
   * has been exhausted. Unlike `hadUnresolvedRef`, this signals that the two
   * sides of an in-flight `subsumes()` call may have been resolved to
   * different depths purely because of when the budget ran out - not because
   * they actually differ - so a caller must not compare the resulting
   * effective schemas at all once this is set; see `subsumes()`.
   */
  get isBudgetExhausted(): boolean {
    return this.exhausted;
  }

  resolve(schema: Schema, depth = 0): Schema {
    if (schema === false) return false;
    if (schema === true || schema === undefined || schema === null) return {};
    if (typeof schema !== 'object') return {};
    // Bailing out here leaves part of the schema uninspected. Recording it as
    // an unresolved reference makes `finalize()` downgrade the verdict to
    // `unknown`, instead of returning {} which reads as "no constraints".
    if (depth > MAX_SCHEMA_DEPTH) {
      this.unresolved = true;
      return {};
    }
    if (this.pathCount > MAX_SCHEMA_PATHS) {
      this.unresolved = true;
      this.exhausted = true;
      return {};
    }

    const { allOf, $ref, ...rest } = schema as Record<string, any>;
    let effective: Schema = rest;

    const ref = $ref;
    if (typeof ref === 'string') {
      this.pathCount++;
      if (this.pathCount > MAX_SCHEMA_PATHS) this.exhausted = true;
      const target = this.pathCount > MAX_SCHEMA_PATHS ? null : this.lookupRef(ref);
      if (target === null) {
        this.unresolved = true;
      } else {
        effective = mergeSchemas(this.resolve(target, depth + 1), effective);
      }
    }

    if (Array.isArray(allOf)) {
      for (const branch of allOf) {
        this.pathCount++;
        if (this.pathCount > MAX_SCHEMA_PATHS) {
          this.unresolved = true;
          this.exhausted = true;
          break;
        }
        effective = mergeSchemas(effective, this.resolve(branch, depth + 1));
      }
    }

    return effective;
  }

  private lookupRef(ref: string): Schema | null {
    // Local pointers are not followed; they are left to the unmodeled check.
    if (ref.startsWith('#')) return null;

    const id = ref.startsWith(GTS_URI_PREFIX) ? ref.substring(GTS_URI_PREFIX.length) : ref;
    if (!Gts.isValidGtsID(id)) return null;

    const entity = this.store.get(id);
    if (!entity || !entity.isSchema || !entity.content) return null;
    return entity.content;
  }
}

type Bound = { value: number; exclusive: boolean };
type BoundAxis = { axis: string; isLower: boolean; keywords: Array<{ key: string; exclusive: boolean }> };

/** The effective bound on one axis as `(value, exclusive)`, or null when unconstrained. */
function readBound(schema: Schema, axis: BoundAxis): Bound | null {
  const candidates: Bound[] = [];
  for (const { key, exclusive } of axis.keywords) {
    if (typeof schema?.[key] === 'number') candidates.push({ value: schema[key], exclusive });
  }
  if (candidates.length === 0) return null;

  // Both forms present: the tighter one wins, matching `allOf` conjunction.
  return candidates.reduce((strictest, candidate) =>
    isAtLeastAsStrict(candidate, strictest, axis.isLower) ? candidate : strictest
  );
}

function isAtLeastAsStrict(candidate: Bound, reference: Bound, isLower: boolean): boolean {
  if (candidate.value === reference.value) {
    // At the same value, excluding the endpoint is the stricter constraint.
    return candidate.exclusive || !reference.exclusive;
  }
  return isLower ? candidate.value > reference.value : candidate.value < reference.value;
}

/**
 * The number a fixed value contributes on a given bound axis: the value
 * itself for `minimum`/`maximum`, or its `.length` for the length/items axes.
 * Null when the value's type does not fit the axis (e.g. a string enum member
 * measured against `minimum`), so the caller can fail closed.
 */
function measureForAxis(value: any, axis: BoundAxis): number | null {
  if (axis.axis === 'minimum' || axis.axis === 'maximum') {
    return typeof value === 'number' ? value : null;
  }
  if (axis.axis === 'minLength' || axis.axis === 'maxLength') {
    return typeof value === 'string' ? value.length : null;
  }
  if (axis.axis === 'minItems' || axis.axis === 'maxItems') {
    return Array.isArray(value) ? value.length : null;
  }
  return null;
}

/** Whether a measured value satisfies a `(value, exclusive, isLower)` bound. */
function satisfiesBound(measure: number, bound: Bound, isLower: boolean): boolean {
  return isLower
    ? bound.exclusive
      ? measure > bound.value
      : measure >= bound.value
    : bound.exclusive
      ? measure < bound.value
      : measure <= bound.value;
}

/**
 * Describes a lower/upper bound pair that no value can satisfy once every
 * subschema is composed, or null when the bounds are consistent.
 *
 * Shared with the OP#13 trait satisfiability check so that both use the same
 * normalized `(value, exclusive)` comparison; comparing raw `minimum` against
 * raw `maximum` misses `exclusiveMinimum: 10` against `maximum: 10`.
 */
export function findCrossedBound(subSchemas: Schema[]): string | null {
  for (const [lowerIndex, upperIndex] of [
    [0, 1],
    [2, 3],
    [4, 5],
  ]) {
    const lowerAxis = BOUND_AXES[lowerIndex];
    const upperAxis = BOUND_AXES[upperIndex];
    let lower: Bound | null = null;
    let upper: Bound | null = null;

    for (const sub of subSchemas) {
      if (typeof sub !== 'object' || sub === null) continue;
      const l = readBound(sub, lowerAxis);
      if (l && (lower === null || isAtLeastAsStrict(l, lower, true))) lower = l;
      const u = readBound(sub, upperAxis);
      if (u && (upper === null || isAtLeastAsStrict(u, upper, false))) upper = u;
    }

    if (lower && upper) {
      const crossed =
        lower.value > upper.value || (lower.value === upper.value && (lower.exclusive || upper.exclusive));
      if (crossed) {
        return `${lowerAxis.axis} ${lower.exclusive ? '>' : '>='} ${lower.value} cannot hold together with ${upperAxis.axis} ${upper.exclusive ? '<' : '<='} ${upper.value}`;
      }
    }
  }
  return null;
}

class SubsumptionChecker {
  private resolver: SchemaResolver;

  constructor(store: EntityLookup) {
    this.resolver = new SchemaResolver(store);
  }

  /**
   * A reference the resolver could not follow (a local JSON pointer, or a GTS
   * identifier that is not registered) means part of the schema was never
   * compared. Any `compatible` reached under that condition is downgraded to
   * `unknown` so the check fails closed rather than passing on the strength of
   * the fragment that happened to be visible.
   */
  private finalize(verdict: CompatVerdict): CompatVerdict {
    return this.resolver.hadUnresolvedRef && verdict === 'compatible' ? 'unknown' : verdict;
  }

  /** Verdict for `Valid(inner) subset-of Valid(outer)`. */
  subsumes(outerRaw: Schema, innerRaw: Schema, depth = 0): CompatVerdict {
    if (depth > MAX_SCHEMA_DEPTH) return 'unknown';

    // Checked on the raw documents: `resolve()` drops `allOf` / `$ref`, so a
    // malformed composition keyword would be invisible afterwards.
    if (hasMalformedKeyword(outerRaw) || hasMalformedKeyword(innerRaw)) return 'unknown';

    // A local `$ref` in a compared position is never followed by the
    // resolver (see `lookupRef`), so it must downgrade the verdict here,
    // before the `deepEqual` fast-path below can return `compatible` on the
    // strength of two schemas that normalize identically once `$defs` -
    // where the ref's actual target content lives - is stripped away.
    if (hasUnresolvableLocalRef(outerRaw) || hasUnresolvableLocalRef(innerRaw)) return 'unknown';

    const outer = this.resolver.resolve(outerRaw, depth);
    const inner = this.resolver.resolve(innerRaw, depth);

    // Once the resolver's whole-lifetime path budget has run out, `outer` and
    // `inner` may have been cut off at different points purely because of
    // resolution order (`subsumes()` always resolves `outerRaw` first), not
    // because they actually differ. Comparing them further would report a
    // false, definitive verdict; `finalize()` only rescues `compatible`, so a
    // budget-exhausted `incompatible` would otherwise slip through as real.
    // Bail out to `unknown` immediately, before any comparison runs.
    if (this.resolver.isBudgetExhausted) return 'unknown';

    if (inner === false) return this.finalize('compatible'); // accepts nothing, trivially included
    if (outer === false) return 'incompatible';
    if (isEmptySchema(outer)) return this.finalize('compatible'); // accepts everything

    const outerNorm = stripAnnotations(outer);
    const innerNorm = stripAnnotations(inner);
    if (deepEqual(outerNorm, innerNorm)) return this.finalize('compatible');

    let verdict: CompatVerdict = 'compatible';
    verdict = worst(verdict, this.compareTypes(outerNorm, innerNorm));
    verdict = worst(verdict, this.compareFixedValues(outerNorm, innerNorm));
    verdict = worst(verdict, this.compareBounds(outerNorm, innerNorm));
    verdict = worst(verdict, this.compareObjects(outerNorm, innerNorm, depth));
    verdict = worst(verdict, this.compareArrays(outerNorm, innerNorm, depth));
    verdict = worst(verdict, this.compareNarrowing(outerNorm, innerNorm));
    verdict = worst(verdict, this.compareUnmodeled(outerNorm, innerNorm));

    return this.finalize(verdict);
  }

  private compareTypes(outer: Schema, inner: Schema): CompatVerdict {
    const outerTypes = typeSet(outer);
    if (outerTypes === null) return 'compatible'; // outer accepts any type
    const innerTypes = typeSet(inner);
    if (innerTypes === null) return 'incompatible'; // inner accepts types outer rejects

    const accepted = widenNumeric(outerTypes);
    return Array.from(innerTypes).every((t) => accepted.has(t)) ? 'compatible' : 'incompatible';
  }

  private compareFixedValues(outer: Schema, inner: Schema): CompatVerdict {
    const outerValues = fixedValues(outer);
    if (outerValues === null) return 'compatible'; // outer does not pin values down
    const innerValues = fixedValues(inner);
    if (innerValues === null) return 'incompatible'; // inner admits values outside outer's set

    return innerValues.every((v) => outerValues.some((o) => deepEqual(o, v))) ? 'compatible' : 'incompatible';
  }

  private compareBounds(outer: Schema, inner: Schema): CompatVerdict {
    // The inclusive and exclusive forms constrain the same axis, so they are
    // normalized to (value, exclusive) before being compared. Without this,
    // `minimum: 0` and `exclusiveMinimum: 0` look like unrelated keywords even
    // though `x > 0` is a strict subset of `x >= 0`.
    for (const axis of BOUND_AXES) {
      // A bound only ever constrains the type it targets (numbers for
      // minimum/maximum, strings for length, arrays for items). If `inner`
      // cannot even admit that type, no instance it accepts is ever measured
      // on this axis, so the axis simply does not apply here - `{type:
      // 'number'}` vs `{minLength:3}` is not a nonsensical conflict, it is
      // two constraints on disjoint value spaces.
      if (!typeSetAdmitsAxis(typeSet(inner), AXIS_TARGET_TYPE[axis.axis])) continue;

      const outerBound = readBound(outer, axis);
      if (outerBound === null) continue; // outer constrains nothing on this axis
      const innerBound = readBound(inner, axis);
      if (innerBound === null) {
        // Not bounded directly, but a pinned-down value set (`const`/`enum`)
        // is itself a bound: if every value it admits already satisfies
        // outer's bound on this axis, inner cannot escape it either.
        const innerValues = fixedValues(inner);
        if (innerValues === null || innerValues.length === 0) return 'incompatible';
        const measures = innerValues.map((v) => measureForAxis(v, axis));
        if (measures.some((m) => m === null)) return 'incompatible';
        const allSatisfy = (measures as number[]).every((m) => satisfiesBound(m, outerBound, axis.isLower));
        if (!allSatisfy) return 'incompatible';
        continue; // inner is unbounded here, but its fixed values are all within outer's bound
      }

      if (!isAtLeastAsStrict(innerBound, outerBound, axis.isLower)) return 'incompatible';
    }

    return 'compatible';
  }

  private compareObjects(outer: Schema, inner: Schema, depth: number): CompatVerdict {
    const outerProps: Record<string, any> = outer.properties || {};
    const innerProps: Record<string, any> = inner.properties || {};
    // Derived from the keyword table, so a keyword that affects the content
    // model - `unevaluatedProperties`, say - cannot be honoured by
    // `contentModel()` while being invisible to this guard.
    const constrainsObjects = OBJECT_KEYWORDS.some((key) => key in outer || key in inner);
    if (!constrainsObjects) return 'compatible';

    // `patternProperties` changes which property names `additionalProperties`
    // actually governs, in a way this engine does not model precisely - see
    // `hasPatternProperties`. Failing closed here, before either side's
    // content model is read, avoids a false `incompatible` on an undeclared
    // property this engine cannot tell is actually covered by a pattern.
    if (hasPatternProperties(outer) || hasPatternProperties(inner)) return 'unknown';

    // Outer may not demand a property the inner schema allows to be absent.
    const outerRequired: string[] = outer.required || [];
    const innerRequired = new Set<string>(inner.required || []);
    for (const name of outerRequired) {
      if (!innerRequired.has(name)) return 'incompatible';
    }

    let verdict: CompatVerdict = 'compatible';

    const outerUndeclared = undeclaredSchema(outer);
    const innerUndeclared = undeclaredSchema(inner);

    const names = new Set([...Object.keys(outerProps), ...Object.keys(innerProps)]);
    for (const name of names) {
      const innerPropSchema = name in innerProps ? innerProps[name] : innerUndeclared;
      // The inner schema cannot carry this property at all - nothing to check.
      if (innerPropSchema === null) continue;

      const outerPropSchema = name in outerProps ? outerProps[name] : outerUndeclared;
      if (outerPropSchema === null) return 'incompatible';

      verdict = worst(verdict, this.subsumes(outerPropSchema, innerPropSchema, depth + 1));
      if (verdict === 'incompatible') return verdict;
    }

    // Property names declared by neither schema.
    if (innerUndeclared !== null) {
      if (outerUndeclared === null) return 'incompatible';
      verdict = worst(verdict, this.subsumes(outerUndeclared, innerUndeclared, depth + 1));
    }

    return verdict;
  }

  private compareArrays(outer: Schema, inner: Schema, depth: number): CompatVerdict {
    if (!('items' in outer) && !('items' in inner)) return 'compatible';
    const outerItems = outer.items;
    const innerItems = inner.items;
    // Tuple-form `items` is not modeled.
    if (Array.isArray(outerItems) || Array.isArray(innerItems)) {
      return deepEqual(outerItems, innerItems) ? 'compatible' : 'unknown';
    }
    return this.subsumes(
      outerItems === undefined ? ANY_SCHEMA : outerItems,
      innerItems === undefined ? ANY_SCHEMA : innerItems,
      depth + 1
    );
  }

  private compareUnmodeled(outer: Schema, inner: Schema): CompatVerdict {
    // Every keyword either side declares that the engine does not compare
    // directly. `keywordKind` classifies unrecognised keywords as `unmodeled`,
    // so a keyword nobody has thought about yet fails closed to `unknown`
    // rather than being silently ignored.
    const keys = new Set([...Object.keys(outer), ...Object.keys(inner)]);
    for (const key of keys) {
      if (keywordKind(key) !== 'unmodeled') continue;
      if (deepEqual(outer[key], inner[key])) continue;
      return 'unknown';
    }

    return 'compatible';
  }

  /**
   * Compares the `narrowing` keywords (`format`, `pattern`, `multipleOf`):
   * the engine can reason about *presence* even though it cannot compare two
   * present-but-different values against each other. Mirrors gts-rust's
   * `check_narrowing_constraints` (`schema_evolution.rs:831-878`).
   *
   * - absent on `outer`                    - outer imposes nothing here,
   *                                           regardless of `inner`: compatible.
   * - present on `outer`, absent on `inner` - outer narrows relative to inner,
   *                                           so `inner` (unconstrained here)
   *                                           can hold instances `outer`
   *                                           rejects: incompatible, unless a
   *                                           pinned-down value set on `inner`
   *                                           (`const`/`enum`) demonstrably
   *                                           already satisfies outer's
   *                                           `pattern` (mirrors the
   *                                           `compareBounds` fixed-value
   *                                           carve-out).
   * - present on both, equal values         - no change: compatible.
   * - present on both, different values     - inclusion is undecidable
   *                                           without evaluating the two
   *                                           values against each other:
   *                                           unknown.
   */
  private compareNarrowing(outer: Schema, inner: Schema): CompatVerdict {
    let verdict: CompatVerdict = 'compatible';

    for (const [key, spec] of Object.entries(KEYWORDS)) {
      if (spec.kind !== 'narrowing') continue;
      if (!(key in outer)) continue; // outer imposes nothing on this axis

      const innerHas = key in inner;
      if (innerHas && deepEqual(outer[key], inner[key])) continue; // identical - no change

      // `pattern` is otherwise judged by presence alone like the other
      // narrowing keywords, but a pinned-down value set (`const`/`enum`) that
      // already matches outer's pattern satisfies it just as much as
      // restating (or keeping) the pattern would.
      if (key === 'pattern' && typeof outer.pattern === 'string') {
        const innerValues = fixedValues(inner);
        if (innerValues !== null && innerValues.length > 0 && innerValues.every((v) => typeof v === 'string')) {
          let regex: RegExp | null = null;
          try {
            regex = new RegExp(outer.pattern);
          } catch {
            regex = null;
          }
          if (regex !== null) {
            if (innerValues.every((v) => regex!.test(v))) continue;
            // Every inner value is a concrete string and at least one of them
            // demonstrably fails outer's pattern - a real, proven conflict,
            // not merely inconclusive narrowing.
            verdict = worst(verdict, 'incompatible');
            continue;
          }
        }
      }

      verdict = worst(verdict, innerHas ? 'unknown' : 'incompatible');
    }

    return verdict;
  }
}

export class GtsCompatibility {
  /**
   * The dialect a `$schema` value names, with the spellings that carry no
   * semantic content stripped: a trailing `#` and the URI scheme. All four
   * spellings of the Draft-07 URI are in common use, and a respelling is not
   * a dialect change. Mirrors gts-rust `canonical_dialect`
   * (`schema_evolution.rs:1763`).
   */
  static canonicalDialect(declared: string): string {
    const body = declared.endsWith('#') ? declared.slice(0, -1) : declared;
    return body.replace(/^https?:\/\//, '');
  }

  /**
   * Compares two schema documents directly (rather than by identifier) and
   * reports both evolution relations.
   *
   * A genuine change of *declared* dialect (an omitted `$schema` is read as
   * "whatever the other side declares", per spec §11 - GTS is
   * dialect-agnostic) makes this checker unable to compare the two documents
   * under one stable set of keyword semantics, so both relations are
   * reported `unknown` rather than compared at all. Mirrors gts-rust making
   * `CompatibilityFinding::DialectChanged` one of only two `is_inconclusive`
   * findings (`schema_evolution.rs:~218`), so `from_diagnostics` (`~:87`)
   * yields `Unknown`.
   */
  static compareSchemas(
    store: EntityLookup,
    oldSchema: Schema,
    newSchema: Schema
  ): { backward: CompatVerdict; forward: CompatVerdict } {
    const oldDialect = isObject(oldSchema) && typeof oldSchema.$schema === 'string' ? oldSchema.$schema : undefined;
    const newDialect = isObject(newSchema) && typeof newSchema.$schema === 'string' ? newSchema.$schema : undefined;
    if (
      oldDialect !== undefined &&
      newDialect !== undefined &&
      this.canonicalDialect(oldDialect) !== this.canonicalDialect(newDialect)
    ) {
      return { backward: 'unknown', forward: 'unknown' };
    }

    return {
      backward: new SubsumptionChecker(store).subsumes(newSchema, oldSchema),
      forward: new SubsumptionChecker(store).subsumes(oldSchema, newSchema),
    };
  }

  static checkCompatibility(
    store: EntityLookup,
    oldId: string,
    newId: string,
    _mode: 'backward' | 'forward' | 'full' = 'full'
  ): CompatibilityResult {
    const normalizedOld = this.normalizeId(oldId);
    const normalizedNew = this.normalizeId(newId);

    const oldEntity = store.get(normalizedOld);
    const newEntity = store.get(normalizedNew);

    const missing: string[] = [];
    if (!oldEntity) missing.push(`Old type schema not found: ${oldId}`);
    else if (!oldEntity.isSchema) missing.push(`Old entity is not a type schema: ${oldId}`);
    if (!newEntity) missing.push(`New type schema not found: ${newId}`);
    else if (!newEntity.isSchema) missing.push(`New entity is not a type schema: ${newId}`);

    if (missing.length > 0) {
      // The check cannot be performed, which is inconclusive rather than incompatible.
      return this.buildResult(normalizedOld, normalizedNew, 'unknown', 'unknown', missing, missing);
    }

    const oldSchema = oldEntity!.content;
    const newSchema = newEntity!.content;

    try {
      // backward: Valid(old) subset-of Valid(new); forward: Valid(new) subset-of Valid(old).
      const { backward, forward } = this.compareSchemas(store, oldSchema, newSchema);

      return this.buildResult(
        normalizedOld,
        normalizedNew,
        backward,
        forward,
        backward === 'compatible' ? [] : [`Backward compatibility is ${backward}`],
        forward === 'compatible' ? [] : [`Forward compatibility is ${forward}`]
      );
    } catch (error) {
      // Schemas are registered without meta-validation, so a malformed document
      // can reach the engine. That makes the check inconclusive - it must not
      // take the caller down with it.
      const reason = `Compatibility check failed: ${error instanceof Error ? error.message : String(error)}`;
      return this.buildResult(normalizedOld, normalizedNew, 'unknown', 'unknown', [reason], []);
    }
  }

  private static normalizeId(id: string): string {
    return id.startsWith(GTS_URI_PREFIX) ? id.substring(GTS_URI_PREFIX.length) : id;
  }

  /** Full compatibility holds only when both directions hold (§4.3). Shared
   * with `GtsStore.castInstance()` so `/cast`'s three-valued verdicts are
   * derived from the same rule as `/compatibility`'s. */
  static fullVerdict(backward: CompatVerdict, forward: CompatVerdict): CompatVerdict {
    if (backward === 'incompatible' || forward === 'incompatible') return 'incompatible';
    if (backward === 'unknown' || forward === 'unknown') return 'unknown';
    return 'compatible';
  }

  private static buildResult(
    oldId: string,
    newId: string,
    backward: CompatVerdict,
    forward: CompatVerdict,
    backwardErrors: string[],
    forwardErrors: string[]
  ): CompatibilityResult {
    const full = this.fullVerdict(backward, forward);

    return {
      old: oldId,
      new: newId,
      backward_compatibility: backward,
      forward_compatibility: forward,
      full_compatibility: full,
      from: oldId,
      to: newId,
      direction: this.inferDirection(oldId, newId),
      added_properties: [],
      removed_properties: [],
      changed_properties: [],
      is_fully_compatible: full === 'compatible',
      is_backward_compatible: backward === 'compatible',
      is_forward_compatible: forward === 'compatible',
      // A reason that applies to both directions is reported once.
      incompatibility_reasons: Array.from(new Set([...backwardErrors, ...forwardErrors])),
      backward_errors: backwardErrors,
      forward_errors: forwardErrors,
    };
  }

  /**
   * Classifies the version step between two identifiers as
   * `upgrade` / `downgrade` / `same` / `unknown`.
   *
   * Shared by OP#8 and OP#9 so the `direction` field means the same thing on
   * `GET /compatibility` and `POST /cast`.
   */
  static inferDirection(fromId: string, toId: string): string {
    try {
      const fromGtsId = Gts.parseGtsID(fromId);
      const toGtsId = Gts.parseGtsID(toId);

      if (!fromGtsId.segments.length || !toGtsId.segments.length) {
        return 'unknown';
      }

      const fromSeg = fromGtsId.segments[fromGtsId.segments.length - 1];
      const toSeg = toGtsId.segments[toGtsId.segments.length - 1];

      if ((fromSeg.verMajor ?? 0) < (toSeg.verMajor ?? 0)) return 'upgrade';
      if ((fromSeg.verMajor ?? 0) > (toSeg.verMajor ?? 0)) return 'downgrade';
      if ((fromSeg.verMinor || 0) < (toSeg.verMinor || 0)) return 'upgrade';
      if ((fromSeg.verMinor || 0) > (toSeg.verMinor || 0)) return 'downgrade';

      return 'same';
    } catch {
      return 'unknown';
    }
  }
}
