/*
 * GTS identifier references and patterns (gts-spec §9.6, ADR-0007, ADR-0008):
 *
 * - `x-gts-type-ref` constrains a string to a concrete GTS Type Identifier;
 * - `x-gts-instance-ref` constrains it to a concrete GTS Instance Identifier;
 * - `x-gts-pattern-ref` constrains it to a GTS identifier pattern covered by
 *   the operand.
 *
 * The keywords are registered with the schema engine (`schema-engine.ts`) so `not`, `anyOf`, `oneOf` and the
 * other applicators treat a candidate failure like any other assertion. An
 * invalid operand is a schema error instead: it throws {@link GtsSchemaError}
 * while compiling (or, for `/$id`, while resolving the selected type), so no
 * applicator can invert or rescue it. {@link XGtsRefValidator.validateSchema}
 * additionally checks operands at every schema location, including ones no
 * value reaches.
 *
 * Registry lookup applies only to the two entity-reference keywords and is
 * supplied by the caller through {@link GtsRefContext}; `x-gts-pattern-ref`
 * never consults the registry.
 */

import { Gts } from './gts';
import { GtsID, stripUriPrefix, ValidationIssue } from './types';
import { forEachSchemaNode, type Resource } from './schema-walk';
import { canonicalDialectUri, dialectOf, type SchemaDialect } from './schema-dialect';
import { assertSafeSchemaPatterns } from './schema-safety';
import { createSchemaEngine, type SchemaEngine } from './schema-engine';

export const X_GTS_TYPE_REF = 'x-gts-type-ref';
export const X_GTS_INSTANCE_REF = 'x-gts-instance-ref';
export const X_GTS_PATTERN_REF = 'x-gts-pattern-ref';
/** The reserved operand naming the selected leaf GTS Type Schema. */
export const X_GTS_REF_SELF = '/$id';

export type GtsRefKeyword = typeof X_GTS_TYPE_REF | typeof X_GTS_INSTANCE_REF | typeof X_GTS_PATTERN_REF;
export const GTS_REF_KEYWORDS: readonly GtsRefKeyword[] = [X_GTS_TYPE_REF, X_GTS_INSTANCE_REF, X_GTS_PATTERN_REF];
/** The keywords whose candidates are concrete entity identifiers. */
export const ENTITY_REF_KEYWORDS: readonly GtsRefKeyword[] = [X_GTS_TYPE_REF, X_GTS_INSTANCE_REF];

export function isGtsRefKeyword(key: string): key is GtsRefKeyword {
  return (GTS_REF_KEYWORDS as readonly string[]).includes(key);
}

/** A schema error: an operand no applicator can turn into a valid schema (§9.6.3). */
export class GtsSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GtsSchemaError';
  }
}

/**
 * Resolves an operand to the pattern it denotes, or throws
 * {@link GtsSchemaError}. `/$id` resolves to `selectedTypeId` (the selected
 * leaf type, `gts://` stripped), which must be a concrete Type ID. A concrete
 * Instance ID selects no types, so it is an error for `x-gts-type-ref`.
 */
export function resolveRefOperand(keyword: GtsRefKeyword, operand: unknown, selectedTypeId?: string): GtsID {
  if (typeof operand !== 'string') {
    throw new GtsSchemaError(`${keyword} operand must be a string, got ${JSON.stringify(operand) ?? typeof operand}`);
  }
  if (operand === X_GTS_REF_SELF) {
    if (selectedTypeId === undefined) {
      throw new GtsSchemaError(`${keyword} operand '${X_GTS_REF_SELF}' has no selected GTS Type Schema to resolve to`);
    }
    const selected = stripUriPrefix(selectedTypeId);
    if (!Gts.isConcreteGtsID(selected) || !Gts.isType(selected)) {
      throw new GtsSchemaError(
        `${keyword} operand '${X_GTS_REF_SELF}' resolves to '${selected}', which is not a GTS Type Identifier`
      );
    }
    return Gts.parseConcreteID(selected);
  }
  let pattern: GtsID;
  try {
    pattern = Gts.parsePattern(operand);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GtsSchemaError(
      `${keyword} operand '${operand}' must be a GTS identifier, a wildcard pattern or '${X_GTS_REF_SELF}': ${reason}`
    );
  }
  if (keyword === X_GTS_TYPE_REF && !Gts.containsWildcard(operand) && !Gts.isType(operand)) {
    throw new GtsSchemaError(
      `${keyword} operand '${operand}' is a GTS Instance Identifier, which selects no GTS Type Identifiers`
    );
  }
  return pattern;
}

/**
 * Why `value` does not satisfy the keyword's resolved operand, or `null`.
 * Entity references require a concrete identifier of their kind in
 * M(operand); pattern references require a pattern covered by the operand
 * (§10). Spelling is checked as given: no trimming, case folding, or `gts://`
 * stripping.
 */
export function refValueViolation(keyword: GtsRefKeyword, operand: GtsID, value: string): string | null {
  if (keyword === X_GTS_PATTERN_REF) {
    let pattern: GtsID;
    try {
      pattern = Gts.parsePattern(value);
    } catch {
      return `Value '${value}' is not a valid GTS identifier pattern`;
    }
    return Gts.patternCovers(operand, pattern) ? null : `Pattern '${value}' is not covered by '${operand.id}'`;
  }
  let id: GtsID;
  try {
    id = Gts.parseConcreteID(value);
  } catch {
    return `Value '${value}' is not a valid GTS identifier`;
  }
  const wantType = keyword === X_GTS_TYPE_REF;
  if (Gts.isType(value) !== wantType) {
    const [actual, required] = wantType ? ['Instance', 'Type'] : ['Type', 'Instance'];
    return `Value '${value}' is a GTS ${actual} Identifier, but ${keyword} requires a GTS ${required} Identifier`;
  }
  return Gts.idMatchesPattern(id, operand) ? null : `Value '${value}' does not match pattern '${operand.id}'`;
}

/** Validation-time inputs of the reference keywords. */
export interface GtsRefContext {
  /** The selected leaf GTS Type Schema that `/$id` names. */
  selectedTypeId?: string;
  /**
   * Registry policy for entity-reference candidates (`gts-ref-validation`):
   * why `value` names no acceptable entity, or `null`. Omitted: no lookup.
   */
  referenceViolation?: (value: string) => string | null;
}

/** Applicators that can fail without a failing reference keyword beneath them (`not`, `oneOf`, ...). */
const COMPOSITION_KEYWORDS = new Set(['not', 'oneOf', 'anyOf', 'if', 'contains']);

/** Resolves a JSON Pointer (`#` prefix optional) in `document`, or `undefined`. */
function pointerTarget(document: any, pointer: string): any {
  const raw = pointer.replace(/^#/, '');
  if (raw === '') return document;
  let current = document;
  for (const segment of raw.slice(1).split('/')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return current;
}

/**
 * The schema node at an engine schema location. The engine repeats the
 * enclosing location for `then`/`else` subschemas (`#/p/a/p/a/then`), so a
 * location made of a doubled prefix also resolves through its first half.
 */
function schemaAt(schema: any, location: string): any {
  const direct = pointerTarget(schema, location);
  if (direct !== undefined) return direct;
  const segments = location.replace(/^#/, '').split('/').slice(1);
  const half = segments.length / 2;
  if (!Number.isInteger(half) || segments.slice(0, half).join('/') !== segments.slice(half).join('/')) return undefined;
  return pointerTarget(schema, `/${segments.slice(0, half).join('/')}`);
}

/** The schema node holding the keyword `issue` reports (its `schemaPath` minus the keyword). */
function parentSchemaOf(issue: ValidationIssue, schema: any): any {
  return schemaAt(schema, issue.schemaPath.slice(0, issue.schemaPath.lastIndexOf('/')));
}

/**
 * The engine reports no `if` failure: a failing `then`/`else` branch reports
 * its own issues. Each such issue stands for an `if` failure of the innermost
 * node with an `if` it lies under, located at that node's `if`.
 */
function conditionalIssue(issue: ValidationIssue, schema: any): ValidationIssue | undefined {
  const segments = issue.schemaPath.split('/');
  for (let index = segments.length - 2; index > 0; index--) {
    if (!['if', 'then', 'else'].includes(segments[index])) continue;
    const location = segments.slice(0, index).join('/');
    const node = schemaAt(schema, location);
    if (node && typeof node === 'object' && 'if' in node) {
      return { ...issue, keyword: 'if', schemaPath: `${location}/if` };
    }
  }
  return undefined;
}

/** The subschemas of the failed applicator `issue` (declared in `parent`) whose results decide it. */
function applicatorSubschemas(issue: ValidationIssue, parent: any): unknown[] {
  if (!parent || typeof parent !== 'object') return [];
  if (issue.keyword === 'if') return [parent.if, parent.then, parent.else];
  const value = parent[issue.keyword];
  return Array.isArray(value) ? value : [value];
}

/** The engine reports the instance root as `/`; reference results use `''`. */
const instancePathOf = (issue: ValidationIssue): string => (issue.instancePath === '/' ? '' : issue.instancePath);

/** Whether `issue` lies at `ancestor`'s instance location or below it. */
function isAtOrBelow(issue: ValidationIssue, ancestor: ValidationIssue): boolean {
  const path = instancePathOf(issue);
  const ancestorPath = instancePathOf(ancestor);
  return path === ancestorPath || path.startsWith(`${ancestorPath}/`);
}

/** A reference keyword violation or schema error, located in the instance or schema. */
export interface XGtsRefValidationError {
  /**
   * The keyword responsible; absent for a failed applicator whose subschemas
   * use reference keywords, or a general failure to check references.
   */
  keyword?: GtsRefKeyword;
  fieldPath: string;
  value: any;
  refPattern: string;
  reason: string;
}

/** Every reference operand declared at a schema location of `schema`, with its location. */
export function declaredRefOperands(
  schema: unknown,
  dialectSource: unknown = schema,
  onInvalidRef?: (path: string, ref: string) => void
): Array<{ keyword: GtsRefKeyword; operand: unknown; path: string }> {
  const declared: Array<{ keyword: GtsRefKeyword; operand: unknown; path: string }> = [];
  forEachSchemaNode(
    schema,
    (node, path) => {
      for (const keyword of GTS_REF_KEYWORDS) {
        if (keyword in node) declared.push({ keyword, operand: node[keyword], path: `${path}/${keyword}` });
      }
    },
    dialectSource,
    onInvalidRef
  );
  return declared;
}

/**
 * Checks GTS reference keywords without a registry.
 *
 * - {@link validateSchema} reports invalid operands at every schema location,
 *   including definitions, inactive branches, local `$ref` targets and
 *   `x-gts-traits-schema` (§9.6.3).
 * - {@link validateInstance} reports reference violations of an instance
 *   under the JSON Schema applicators of the schema's dialect, including
 *   failures of applicators whose subschemas use reference keywords.
 */
export class XGtsRefValidator {
  private context: GtsRefContext = {};
  // The store's engine configuration: GTS formats and the linear-time regex
  // profile, so this API never runs a backtracking regex.
  private readonly engine: SchemaEngine = createSchemaEngine({ getRefContext: () => this.context });

  /**
   * Operand errors in `schema`, and local `$ref`s that name no schema. `/$id`
   * resolves to `selectedTypeId`, by default the `$id` of `rootSchema` (or of
   * `schema` itself).
   */
  validateSchema(
    schema: any,
    schemaPath: string = '',
    rootSchema: any = schema,
    selectedTypeId?: string
  ): XGtsRefValidationError[] {
    const selected = selectedTypeId ?? (typeof rootSchema?.$id === 'string' ? rootSchema.$id : undefined);
    const errors: XGtsRefValidationError[] = [];
    let declared: ReturnType<typeof declaredRefOperands>;
    try {
      // A local `$ref` that names no schema hides its subtree from these
      // checks, so it fails closed.
      declared = declaredRefOperands(schema, rootSchema, (path, ref) =>
        errors.push({
          fieldPath: `${schemaPath}${path}`,
          value: ref,
          refPattern: '',
          reason: `Cannot resolve $ref '${ref}' to a schema`,
        })
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return [{ fieldPath: schemaPath || '/', value: schema, refPattern: '', reason }];
    }
    for (const { keyword, operand, path } of declared) {
      try {
        resolveRefOperand(keyword, operand, selected);
      } catch (error) {
        errors.push({
          keyword,
          fieldPath: `${schemaPath}${path}`,
          value: operand,
          refPattern: typeof operand === 'string' ? operand : '',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return errors;
  }

  /**
   * Reference violations of `instance` against `schema`, without registry
   * lookup: failing reference keywords, and failures of applicators (`not`,
   * `oneOf`, ...) whose subschemas use reference keywords. Failures of the
   * other keywords are not reported. `/$id` resolves to `selectedTypeId`, by
   * default `schema.$id`.
   * Throws {@link GtsSchemaError} when the schema has an invalid operand at
   * any schema location, even one no value reaches (§9.6.3), or a `$ref` to
   * another resource (there is no registry to resolve it), and rejects
   * regular expressions outside the GTS profile before compiling (§11.0.1).
   */
  validateInstance(
    instance: any,
    schema: any,
    instancePath: string = '',
    selectedTypeId?: string
  ): XGtsRefValidationError[] {
    const selected = selectedTypeId ?? (typeof schema?.$id === 'string' ? schema.$id : undefined);
    const schemaErrors = this.validateSchema(schema, '', schema, selected);
    if (schemaErrors.length > 0) {
      throw new GtsSchemaError(schemaErrors.map((error) => `${error.fieldPath}: ${error.reason}`).join('; '));
    }
    assertSafeSchemaPatterns(schema);
    const validate = this.compile(schema);
    const previous = this.context;
    this.context = { selectedTypeId: selected };
    let issues: ValidationIssue[];
    try {
      issues = validate(instance);
    } finally {
      this.context = previous;
    }
    if (issues.length === 0) return [];
    const conditions = new Set<string>();
    const errors = issues.flatMap((issue) => {
      if (isGtsRefKeyword(issue.keyword) || COMPOSITION_KEYWORDS.has(issue.keyword)) return [issue];
      const condition = conditionalIssue(issue, schema);
      if (condition === undefined) return [issue];
      const key = `${condition.instancePath}\n${condition.schemaPath}`;
      if (conditions.has(key)) return [];
      conditions.add(key);
      return [condition];
    });
    // An applicator can fail with no failing reference keyword beneath it
    // (`not` around a match, `oneOf` with several). Its failure is reported
    // when a subschema deciding it reaches a reference keyword through the
    // schema locations it applies - local `$ref`s followed; literal data such
    // as `const`, and declarations no `$ref` uses, not.
    const composed = errors.filter((error) => COMPOSITION_KEYWORDS.has(error.keyword));
    let involved: ValidationIssue[] = [];
    if (composed.length > 0) {
      const resources = new Map<object, Resource>();
      forEachSchemaNode(schema, (node, _path, resource) => resources.set(node, resource));
      involved = composed.filter((error) => {
        const parent = parentSchemaOf(error, schema);
        let reaches = false;
        forEachSchemaNode(
          schema,
          (node) => (reaches ||= GTS_REF_KEYWORDS.some((keyword) => keyword in node)),
          schema,
          undefined,
          {
            subschemas: applicatorSubschemas(error, parent),
            resource: (parent && typeof parent === 'object' && resources.get(parent)) || { schema, path: '' },
          }
        );
        return reaches;
      });
    }
    const reported = [...errors.filter((error) => isGtsRefKeyword(error.keyword)), ...involved];
    // An applicator whose failure a reported failure beneath it, at the same
    // instance location or below, already explains adds nothing.
    return errors
      .filter(
        (error) =>
          reported.includes(error) &&
          (isGtsRefKeyword(error.keyword) ||
            !reported.some((other) => other.schemaPath.startsWith(`${error.schemaPath}/`) && isAtOrBelow(other, error)))
      )
      .map((error) => {
        const fieldPath = `${instancePath}${instancePathOf(error)}` || '/';
        const value = pointerTarget(instance, instancePathOf(error));
        return isGtsRefKeyword(error.keyword)
          ? {
              keyword: error.keyword as GtsRefKeyword,
              fieldPath,
              value,
              refPattern: typeof error.params?.operand === 'string' ? error.params.operand : '',
              reason: error.message || 'reference validation failed',
            }
          : {
              fieldPath,
              value,
              refPattern: '',
              reason: `${error.keyword}: ${error.message || 'validation failed'} (with reference keywords)`,
            };
      });
  }

  /**
   * Compiles `schema` once into a test of whether it accepts a value, with
   * reference keywords checked structurally (no registry) and `/$id` naming
   * `selectedTypeId`. Used to confirm counterexamples when comparing
   * schemas. Throws on a schema error.
   */
  acceptor(schema: any, selectedTypeId?: string, dialectSource: any = schema): (value: unknown) => boolean {
    if (typeof schema === 'boolean') return () => schema;
    assertSafeSchemaPatterns(schema, dialectSource);
    // An identity would register the fragment as a resource of its own.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { $id, $schema, ...fragment } = schema;
    const validate = this.compile(fragment, dialectSource);
    return (value) => {
      const previous = this.context;
      this.context = { selectedTypeId };
      try {
        return validate(value).length === 0;
      } finally {
        this.context = previous;
      }
    };
  }

  /**
   * Compiles `schema` in the dialect of `dialectSource` (Draft-07 when it
   * declares no supported `$schema`); a `$ref` to another resource is a
   * schema error.
   */
  private compile(schema: any, dialectSource: any = schema): (data: unknown) => ValidationIssue[] {
    let dialect: SchemaDialect = 'draft-07';
    try {
      dialect = dialectOf(dialectSource);
    } catch {
      // Schemas without a supported `$schema` are checked as Draft-07.
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { $schema, ...rest } = schema;
    const source = { $schema: canonicalDialectUri(dialect), ...rest };
    try {
      const compiled = this.engine.compile(source);
      return (data) => compiled.validate(data);
    } catch (error) {
      if (error instanceof GtsSchemaError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const ref = /\$ref[^']*'([^']*)'/.exec(message);
      if (ref === null) throw error;
      throw new GtsSchemaError(`Cannot resolve $ref '${ref[1]}' without a registry`);
    }
  }
}
