/*
 * GTS identifier references and patterns (gts-spec §9.6, ADR-0007, ADR-0008):
 *
 * - `x-gts-type-ref` constrains a string to a concrete GTS Type Identifier;
 * - `x-gts-instance-ref` constrains it to a concrete GTS Instance Identifier;
 * - `x-gts-pattern-ref` constrains it to a GTS identifier pattern covered by
 *   the operand.
 *
 * The keywords are registered with Ajv so `not`, `anyOf`, `oneOf` and the
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

import type AjvCore from 'ajv/dist/core';
import type { DataValidateFunction, ErrorObject } from 'ajv/dist/types';
import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import { Gts } from './gts';
import { GtsID, stripUriPrefix } from './types';
import { forEachSchemaNode, type Resource } from './schema-walk';
import { dialectOf } from './schema-dialect';
import { createLinearRegExp } from './regex-engine';
import { applyGtsFormats } from './formats';
import { assertSafeSchemaPatterns } from './schema-safety';

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

/**
 * Registers the three reference keywords on `ajv`. `getContext` is read on
 * every evaluation, so one compiled schema serves every selected type and
 * reference policy. Registry results take part in applicator evaluation like
 * any other assertion: a rejected `anyOf` branch adds no requirement.
 */
export function applyGtsRefKeywords(ajv: AjvCore, getContext: () => GtsRefContext): void {
  for (const keyword of GTS_REF_KEYWORDS) {
    ajv.addKeyword({
      keyword,
      errors: true,
      compile(operand: unknown) {
        const literal = operand === X_GTS_REF_SELF ? undefined : resolveRefOperand(keyword, operand);
        const validate: DataValidateFunction = (data: unknown): boolean => {
          if (typeof data !== 'string') return true;
          const context = getContext();
          const pattern = literal ?? resolveRefOperand(keyword, operand, context.selectedTypeId);
          let reason = refValueViolation(keyword, pattern, data);
          if (reason === null && keyword !== X_GTS_PATTERN_REF) {
            reason = context.referenceViolation?.(data) ?? null;
          }
          if (reason === null) return true;
          validate.errors = [{ keyword, message: reason, params: { operand } }];
          return false;
        };
        return validate;
      },
    });
  }
}

/** Applicators that can fail without a failing reference keyword beneath them (`not`, `oneOf`, ...). */
const COMPOSITION_KEYWORDS = new Set(['not', 'oneOf', 'anyOf', 'if', 'contains']);

/** The subschemas of the failed applicator `error` whose results decide it. */
function applicatorSubschemas(error: ErrorObject): unknown[] {
  const parent = error.parentSchema;
  if (!parent || typeof parent !== 'object') return [];
  if (error.keyword === 'if') return [parent.if, parent[String(error.params?.failingKeyword)]];
  const value = parent[error.keyword];
  return Array.isArray(value) ? value : [value];
}

/** Whether `error` lies at `ancestor`'s instance location or below it. */
function isAtOrBelow(error: ErrorObject, ancestor: ErrorObject): boolean {
  return error.instancePath === ancestor.instancePath || error.instancePath.startsWith(`${ancestor.instancePath}/`);
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
  private ajvs: Map<string, AjvCore> = new Map();
  private context: GtsRefContext = {};

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
   * any schema location, even one no value reaches (§9.6.3), and rejects
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
    const ajv = this.ajvFor(schema);
    const validate = ajv.compile(schema);
    const previous = this.context;
    this.context = { selectedTypeId: selected };
    let errors: ErrorObject[];
    try {
      if (validate(instance)) return [];
      errors = validate.errors ?? [];
    } finally {
      this.context = previous;
    }
    // An applicator can fail with no failing reference keyword beneath it
    // (`not` around a match, `oneOf` with several). Its failure is reported
    // when a subschema deciding it reaches a reference keyword through the
    // schema locations it applies - local `$ref`s followed; literal data such
    // as `const`, and declarations no `$ref` uses, not.
    const composed = errors.filter((error) => COMPOSITION_KEYWORDS.has(error.keyword));
    let involved: ErrorObject[] = [];
    if (composed.length > 0) {
      const resources = new Map<object, Resource>();
      forEachSchemaNode(schema, (node, _path, resource) => resources.set(node, resource));
      involved = composed.filter((error) => {
        let reaches = false;
        forEachSchemaNode(
          schema,
          (node) => (reaches ||= GTS_REF_KEYWORDS.some((keyword) => keyword in node)),
          schema,
          undefined,
          {
            subschemas: applicatorSubschemas(error),
            resource: (error.parentSchema && resources.get(error.parentSchema)) || { schema, path: '' },
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
      .map((error) =>
        isGtsRefKeyword(error.keyword)
          ? {
              keyword: error.keyword as GtsRefKeyword,
              fieldPath: `${instancePath}${error.instancePath}` || '/',
              value: error.data,
              refPattern: typeof error.params?.operand === 'string' ? error.params.operand : '',
              reason: error.message ?? 'reference validation failed',
            }
          : {
              fieldPath: `${instancePath}${error.instancePath}` || '/',
              value: error.data,
              refPattern: '',
              reason: `${error.keyword}: ${error.message ?? 'validation failed'} (with reference keywords)`,
            }
      );
  }

  /**
   * Whether `schema` accepts `value`, with reference keywords checked
   * structurally (no registry) and `/$id` naming `selectedTypeId`. Used to
   * confirm counterexamples when comparing schemas. Throws on a schema error.
   */
  accepts(value: unknown, schema: any, selectedTypeId?: string, dialectSource: any = schema): boolean {
    if (typeof schema === 'boolean') return schema;
    assertSafeSchemaPatterns(schema, dialectSource);
    // An identity would register the fragment as a resource of its own.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { $id, $schema, ...fragment } = schema;
    const validate = this.ajvFor(dialectSource).compile(fragment);
    const previous = this.context;
    this.context = { selectedTypeId };
    try {
      return validate(value) as boolean;
    } finally {
      this.context = previous;
    }
  }

  private ajvFor(schema: any): AjvCore {
    let dialect = 'draft-07';
    try {
      dialect = dialectOf(schema);
    } catch {
      // Schemas without a supported `$schema` are checked as Draft-07.
    }
    let ajv = this.ajvs.get(dialect);
    if (!ajv) {
      // The store's engine configuration: GTS formats and the linear-time
      // regex profile, so this API never runs a backtracking regex.
      // `addUsedSchema: false`: a compiled `$id` is not registered, so
      // another copy of the same schema still compiles.
      const options = {
        strict: false,
        validateSchema: false,
        addUsedSchema: false,
        allErrors: true,
        verbose: true,
        validateFormats: true,
        code: { regExp: createLinearRegExp },
      };
      ajv =
        dialect === '2020-12' ? new Ajv2020(options) : dialect === '2019-09' ? new Ajv2019(options) : new Ajv(options);
      applyGtsFormats(ajv);
      applyGtsRefKeywords(ajv, () => this.context);
      this.ajvs.set(dialect, ajv);
    }
    return ajv;
  }
}
