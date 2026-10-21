/*
 * Accepted-set reasoning for the GTS reference keywords (gts-spec §9.6.1
 * "Derivation and evolution", §9.6.2, §4). Used by OP#12 (derivation) and
 * OP#8 (evolution) to decide whether every string one schema accepts through
 * its reference constraints is accepted by another.
 *
 * A property schema's reference constraints are read as a conjunction of
 * clauses taken from the schema itself and its `allOf`, `anyOf` and `not`
 * applicators:
 *
 * - an atom: one keyword with a resolved operand (`/$id` resolved in the
 *   context of the schema that holds it);
 * - a union: an `anyOf` whose every branch is an atom;
 * - a negation: a `not` around an atom, optionally restricted to strings;
 * - literal values from `const` / `enum`, and `type: 'string'`.
 *
 * The keywords accept every non-string, so clause inclusion also accounts for
 * which side rejects non-strings.
 *
 * Inclusion is proven only from these shapes; anything else involving a
 * reference keyword is `unknown`, and callers must not read it as proof.
 * Registry contents never prove inclusion (§9.6.1).
 */

import { Gts } from './gts';
import { GtsID } from './types';
import {
  GTS_REF_KEYWORDS,
  GtsRefKeyword,
  isGtsRefKeyword,
  refValueViolation,
  resolveRefOperand,
  X_GTS_PATTERN_REF,
} from './x-gts-ref';

/** One reference keyword with its resolved operand. */
export interface RefAtom {
  keyword: GtsRefKeyword;
  pattern: GtsID;
}

export type RefClause =
  | { op: 'atom'; atom: RefAtom }
  /** `stringOnly` when every branch has `type: 'string'`, so the union rejects non-strings. */
  | { op: 'any'; atoms: RefAtom[]; stringOnly: boolean }
  /** `not: {type?: 'string', <keyword>: operand}`; `stringOnly` when `type: 'string'` is present. */
  | { op: 'not'; atom: RefAtom; stringOnly: boolean }
  | { op: 'values'; values: unknown[] }
  /** `type: 'string'`: only strings are accepted. */
  | { op: 'strings' }
  | { op: 'unknown'; reason: string };

const APPLICATORS = ['allOf', 'anyOf', 'oneOf', 'not'];

/** Whether `schema` uses a reference keyword itself or through `allOf`/`anyOf`/`oneOf`/`not`. */
export function usesRefKeywords(schema: unknown, depth = 0): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 64) return false;
  const object = schema as Record<string, unknown>;
  if (GTS_REF_KEYWORDS.some((keyword) => keyword in object)) return true;
  return APPLICATORS.some((key) => {
    const value = object[key];
    return Array.isArray(value)
      ? value.some((branch) => usesRefKeywords(branch, depth + 1))
      : usesRefKeywords(value, depth + 1);
  });
}

function atomOf(keyword: GtsRefKeyword, operand: unknown, selfId: string | undefined): RefAtom | string {
  try {
    return { keyword, pattern: resolveRefOperand(keyword, operand, selfId) };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The atom a schema object holds when it is exactly one reference keyword, optionally with `type`. */
function soleAtom(
  schema: unknown,
  selfId: string | undefined
): { atom: RefAtom; stringOnly: boolean } | string | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const keys = Object.keys(schema);
  const refKeys = keys.filter(isGtsRefKeyword);
  const object = schema as Record<string, unknown>;
  const typeOk = !('type' in object) || object.type === 'string';
  if (refKeys.length !== 1 || !typeOk || keys.some((key) => key !== 'type' && !isGtsRefKeyword(key))) {
    return undefined;
  }
  const atom = atomOf(refKeys[0], object[refKeys[0]], selfId);
  return typeof atom === 'string' ? atom : { atom, stringOnly: object.type === 'string' };
}

/**
 * The reference clauses of a property schema, with `/$id` naming `selfId`.
 * Literal `const`/`enum` values are included so a value-only schema can prove
 * inclusion in a reference scope.
 */
export function refClauses(schema: unknown, selfId: string | undefined, depth = 0): RefClause[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  if (depth > 64) return [{ op: 'unknown', reason: 'reference constraints nest too deeply' }];
  const object = schema as Record<string, unknown>;
  const clauses: RefClause[] = [];
  for (const keyword of GTS_REF_KEYWORDS) {
    if (!(keyword in object)) continue;
    const atom = atomOf(keyword, object[keyword], selfId);
    clauses.push(typeof atom === 'string' ? { op: 'unknown', reason: atom } : { op: 'atom', atom });
  }
  const type = object.type;
  if (type === 'string' || (Array.isArray(type) && type.length > 0 && type.every((t) => t === 'string'))) {
    clauses.push({ op: 'strings' });
  }
  if ('const' in object) clauses.push({ op: 'values', values: [object.const] });
  if (Array.isArray(object.enum)) clauses.push({ op: 'values', values: object.enum });
  if (Array.isArray(object.allOf)) {
    for (const branch of object.allOf) clauses.push(...refClauses(branch, selfId, depth + 1));
  }
  if (Array.isArray(object.anyOf) && object.anyOf.some((branch) => usesRefKeywords(branch))) {
    const branches = object.anyOf.map((branch) => soleAtom(branch, selfId));
    const atoms = branches.filter((branch): branch is { atom: RefAtom; stringOnly: boolean } => {
      return typeof branch === 'object';
    });
    clauses.push(
      atoms.length === branches.length
        ? {
            op: 'any',
            atoms: atoms.map((branch) => branch.atom),
            stringOnly: atoms.every((branch) => branch.stringOnly),
          }
        : { op: 'unknown', reason: 'anyOf mixes reference keywords with other constraints' }
    );
  }
  if (Array.isArray(object.oneOf) && object.oneOf.some((branch) => usesRefKeywords(branch))) {
    clauses.push({ op: 'unknown', reason: 'oneOf with reference keywords is not compared' });
  }
  if (usesRefKeywords(object.not)) {
    const negated = soleAtom(object.not, selfId);
    clauses.push(
      typeof negated === 'object'
        ? { op: 'not', atom: negated.atom, stringOnly: negated.stringOnly }
        : { op: 'unknown', reason: 'not with reference keywords and other constraints is not compared' }
    );
  }
  return clauses;
}

/** Whether every string `inner` accepts, `outer` accepts too (§10 coverage, kind-filtered). */
export function atomIncludes(outer: RefAtom, inner: RefAtom): boolean {
  // Type and instance references select disjoint kinds; for one kind,
  // coverage of the unfiltered selections proves inclusion.
  return outer.keyword === inner.keyword && Gts.patternCovers(outer.pattern, inner.pattern);
}

/** Whether the atom accepts `value` (keywords constrain strings only). */
export function atomAdmits(atom: RefAtom, value: unknown): boolean {
  return typeof value !== 'string' || refValueViolation(atom.keyword, atom.pattern, value) === null;
}

/** Whether `not: {type?: string, <atom>}` accepts `value`. */
function negationAdmits(clause: { atom: RefAtom; stringOnly: boolean }, value: unknown): boolean {
  if (typeof value !== 'string') return clause.stringOnly;
  return refValueViolation(clause.atom.keyword, clause.atom.pattern, value) !== null;
}

/**
 * Whether the conjunction `derived` is proven to imply `base`: every value
 * the derived clauses accept, the base clause accepts. `false` means not
 * proven, not disproven.
 */
/** Whether a clause rejects every non-string value. */
function rejectsNonStrings(clause: RefClause): boolean {
  switch (clause.op) {
    case 'strings':
      return true;
    case 'any':
      return clause.stringOnly;
    case 'not':
      // `not: {<keyword>}` without `type` rejects the non-strings the keyword accepts.
      return !clause.stringOnly;
    case 'values':
      return clause.values.every((value) => typeof value === 'string');
    default:
      return false;
  }
}

/** Whether a clause only constrains values the comparison's other rules already compare. */
export function isComparedElsewhere(clause: RefClause): boolean {
  return clause.op === 'values' || clause.op === 'strings';
}

export function clauseImplied(derived: RefClause[], base: RefClause): boolean {
  if (rejectsNonStrings(base) && !derived.some(rejectsNonStrings)) return false;
  const values = derived.filter((clause) => clause.op === 'values') as Array<{ values: unknown[] }>;
  const valuesWithin = (admits: (value: unknown) => boolean) => values.some((clause) => clause.values.every(admits));
  switch (base.op) {
    case 'atom':
      return (
        derived.some(
          (clause) =>
            (clause.op === 'atom' && atomIncludes(base.atom, clause.atom)) ||
            (clause.op === 'any' && clause.atoms.every((atom) => atomIncludes(base.atom, atom)))
        ) || valuesWithin((value) => atomAdmits(base.atom, value))
      );
    case 'any':
      return (
        derived.some(
          (clause) =>
            (clause.op === 'atom' && base.atoms.some((atom) => atomIncludes(atom, clause.atom))) ||
            (clause.op === 'any' && clause.atoms.every((inner) => base.atoms.some((atom) => atomIncludes(atom, inner))))
        ) || valuesWithin((value) => base.atoms.some((atom) => atomAdmits(atom, value)))
      );
    case 'not':
      // Valid(not C) ⊆ Valid(not A) iff Valid(A) ⊆ Valid(C).
      return (
        derived.some(
          (clause) =>
            clause.op === 'not' && atomIncludes(clause.atom, base.atom) && (!clause.stringOnly || base.stringOnly)
        ) || valuesWithin((value) => negationAdmits(base, value))
      );
    case 'values':
    case 'strings':
      // Compared by the callers' own `const`/`enum`/`type` rules.
      return true;
    case 'unknown':
      return false;
  }
}

/**
 * The base reference clauses the derived property schema is not proven to
 * satisfy, as messages. `baseSelf` / `derivedSelf` resolve `/$id` in each
 * schema's own context (§9.6.1).
 */
export function unprovenRefClauses(
  derived: unknown,
  base: unknown,
  derivedSelf: string | undefined,
  baseSelf: string | undefined
): string[] {
  const baseClauses = refClauses(base, baseSelf).filter((clause) => !isComparedElsewhere(clause));
  if (baseClauses.length === 0) return [];
  const derivedClauses = refClauses(derived, derivedSelf);
  const unproven: string[] = [];
  for (const clause of baseClauses) {
    if (clauseImplied(derivedClauses, clause)) continue;
    unproven.push(describeClause(clause));
  }
  return unproven;
}

export function describeClause(clause: RefClause): string {
  switch (clause.op) {
    case 'atom':
      return `${clause.atom.keyword} '${clause.atom.pattern.id}'`;
    case 'any':
      return `anyOf [${clause.atoms.map((atom) => `${atom.keyword} '${atom.pattern.id}'`).join(', ')}]`;
    case 'not':
      return `not ${clause.atom.keyword} '${clause.atom.pattern.id}'`;
    case 'values':
      return `values ${JSON.stringify(clause.values)}`;
    case 'strings':
      return "type 'string'";
    case 'unknown':
      return clause.reason;
  }
}

/**
 * Strings that may separate two schemas: completions of every operand the
 * clauses mention (the operand itself, an instance and a derived type under a
 * concrete Type ID, and the shortest completions of a wildcard), plus their
 * literal values. Not exhaustive - an empty or unhelpful list proves nothing.
 * Mirrors gts-rust `EntityScope::witnesses`.
 */
export function witnessCandidates(clauses: RefClause[]): unknown[] {
  const candidates = new Set<string>();
  const add = (atom: RefAtom) => {
    const spelling = atom.pattern.id;
    if (atom.keyword === X_GTS_PATTERN_REF) candidates.add(spelling);
    for (const token of ['a', 'z']) {
      const instance = `${token}.${token}.${token}.${token}.v0`;
      const derived = `${instance}~`;
      if (!spelling.endsWith('*')) {
        candidates.add(spelling);
        if (spelling.endsWith('~')) {
          candidates.add(spelling + instance);
          candidates.add(spelling + derived);
        }
        continue;
      }
      const stem = spelling.slice(0, -1);
      for (const completion of [
        derived,
        `${token}.${token}.${token}.v0~`,
        `${token}.${token}.v0~`,
        `${token}.v0~`,
        'v0~',
        '0~',
      ]) {
        const asType = stem + completion;
        candidates.add(asType.replace(/~$/, ''));
        candidates.add(asType + instance);
        candidates.add(asType);
        if (atom.keyword === X_GTS_PATTERN_REF) candidates.add(asType + '*');
      }
    }
  };
  for (const clause of clauses) {
    if (clause.op === 'atom' || clause.op === 'not') add(clause.atom);
    else if (clause.op === 'any') clause.atoms.forEach(add);
    else if (clause.op === 'values') {
      for (const value of clause.values) if (typeof value === 'string') candidates.add(value);
    }
  }
  // Non-strings separate a scope that rejects them from one that does not.
  return [...[...candidates].filter((candidate) => Gts.isValidGtsID(candidate)), null, 0, false, [], {}];
}
