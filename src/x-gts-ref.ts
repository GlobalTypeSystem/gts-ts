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

import { ValidationIssue } from './types';
import { forEachSchemaNode, type Resource } from './schema-walk';
import {
  declaredRefOperands,
  GTS_REF_KEYWORDS,
  GtsRefContext,
  GtsRefKeyword,
  GtsSchemaError,
  isGtsRefKeyword,
  resolveRefOperand,
} from './ref-keywords';
import { canonicalDialectUri, dialectOf, type SchemaDialect } from './schema-dialect';
import { assertSafeSchemaPatterns } from './schema-safety';
import { createSchemaEngine, type SchemaEngine } from './schema-engine';

/** Applicators that can fail without a failing reference keyword beneath them (`not`, `oneOf`, ...). */
const COMPOSITION_KEYWORDS = new Set(['not', 'oneOf', 'anyOf', 'if', 'contains']);

const CONDITIONAL_KEYWORDS = new Set(['if', 'then', 'else']);
/** Keywords whose members are named by the schema author, not by JSON Schema. */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

/** Resolves a JSON Pointer (`#` prefix optional) in `document` through own properties only, or `undefined`. */
function pointerTarget(document: any, pointer: string): any {
  const raw = pointer.replace(/^#/, '');
  if (raw === '') return document;
  let current = document;
  for (const escaped of raw.slice(1).split('/')) {
    const segment = escaped.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
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
    if (!CONDITIONAL_KEYWORDS.has(segments[index])) continue;
    // A property or definition named `if` / `then` / `else` is not a conditional.
    if (SCHEMA_MAP_KEYWORDS.has(segments[index - 1])) continue;
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

/**
 * The message for `XGtsRefValidator.validateSchema` errors. Errors without a
 * reference keyword (a local `$ref` that names no schema, a schema past the
 * walk's limits) are schema errors, not reference failures.
 */
export function refSchemaErrorMessage(errors: XGtsRefValidationError[]): string {
  const describe = (list: XGtsRefValidationError[]) => list.map((err) => `${err.fieldPath}: ${err.reason}`).join('; ');
  const general = errors.filter((err) => err.keyword === undefined);
  const references = errors.filter((err) => err.keyword !== undefined);
  return [
    general.length > 0 ? `Invalid schema: ${describe(general)}` : '',
    references.length > 0 ? `GTS reference validation failed: ${describe(references)}` : '',
  ]
    .filter(Boolean)
    .join('; ');
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
  // Built on first use: `validateSchema` (run on every store validation)
  // needs no engine, and building one is expensive.
  private engineInstance: SchemaEngine | undefined;

  // The store's engine configuration: GTS formats and the linear-time regex
  // profile, so this API never runs a backtracking regex.
  private get engine(): SchemaEngine {
    return (this.engineInstance ??= createSchemaEngine({ getRefContext: () => this.context }));
  }

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
