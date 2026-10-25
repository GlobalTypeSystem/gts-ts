/*
 * The GTS reference keywords and their operand and value rules (gts-spec §9.6,
 * ADR-0008), shared by the schema engine (`schema-engine.ts`) and the
 * registry-free validator (`x-gts-ref.ts`). Imports neither, so the keyword
 * names are defined whichever of them loads first.
 */

import { Gts } from './gts';
import { GtsID, stripUriPrefix } from './types';
import { forEachSchemaNode } from './schema-walk';

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
 * Throws {@link GtsSchemaError} for the first literal operand (not `/$id`)
 * declared in `schema` that the reference keywords would reject while
 * compiling. Lets a schema pool refuse a schema whose compilation would fail.
 */
export function assertLiteralRefOperands(schema: unknown): void {
  for (const { keyword, operand } of declaredRefOperands(schema)) {
    if (operand !== X_GTS_REF_SELF) resolveRefOperand(keyword, operand);
  }
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
