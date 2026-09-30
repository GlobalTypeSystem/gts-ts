/*
 * ReDoS-safe regex engine for JSON Schema `pattern` / `patternProperties`.
 *
 * Schemas are registered from untrusted input and Ajv compiles their `pattern`
 * keywords with the platform `RegExp` — a backtracking engine that is
 * vulnerable to catastrophic backtracking (ReDoS, CWE-1333). A source-length
 * bound (`MAX_REGEX_LEN`) caps how much text an attacker can hand the compiler
 * but does NOT bound match time on a backtracking engine, so a short pattern
 * such as `(a+)+$` can still hang validation.
 *
 * Patterns supported by RE2 are matched with `re2-wasm`, whose matching time
 * is guaranteed linear. Common anchored lookaround idioms are split into RE2
 * checks so they retain exact ECMA-262 semantics without backtracking.
 *
 * JSON Schema requires the rest of ECMA-262 as well, including arbitrary
 * lookarounds and backreferences. Those patterns use V8's native `RegExp`
 * inside a bounded `node:vm` execution. The VM timeout interrupts catastrophic
 * backtracking while preserving the platform's exact ECMA-262 behavior. This
 * is the same synchronous timeout mechanism used by the established
 * `super-regex` package. `MAX_REGEX_LEN` remains a cheap compilation cap.
 */

import { Script, createContext, type Context } from 'node:vm';
import { RE2 } from 're2-wasm';
import { parse, type AstNode as RegexAstNode } from 'regjsparser';

const PARSE_FEATURES = { lookbehind: true, namedGroups: true, unicodePropertyEscape: true } as const;
type AstNode = RegexAstNode<typeof PARSE_FEATURES>;

/** The subset of `RegExp` Ajv uses for `pattern` / `patternProperties`. */
interface PatternMatcher {
  test(input: string): boolean;
  toString(): string;
}

const NATIVE_MATCH_TIMEOUT_MS = 250;
const NATIVE_TEST_SCRIPT = new Script('result = regex.test(input)');

class BoundedNativePattern implements PatternMatcher {
  private readonly regex: RegExp;
  private readonly state: { regex: RegExp; input: string; result: boolean };
  private readonly context: Context;

  constructor(pattern: string, flags: string) {
    this.regex = new RegExp(pattern, flags);
    this.state = { regex: this.regex, input: '', result: false };
    this.context = createContext(this.state);
  }

  test(input: string): boolean {
    this.state.input = input;
    this.state.result = false;
    try {
      NATIVE_TEST_SCRIPT.runInContext(this.context, { timeout: NATIVE_MATCH_TIMEOUT_MS });
      return this.state.result;
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new Error('regular expression match timed out');
      }
      throw error;
    }
  }

  toString(): string {
    return this.regex.toString();
  }
}

type LookaroundBehavior = 'lookahead' | 'negativeLookahead' | 'lookbehind' | 'negativeLookbehind';

interface SplitLookaround {
  /**
   * Where the lookaround sits: this many code points after the start of the
   * input (prefix lookarounds) or before its end (suffix lookarounds).
   */
  codePoints: number;
  fromEnd: boolean;
  ahead: boolean;
  negative: boolean;
  matcher: RE2;
}

function withUnicode(flags: string): string {
  // RE2 requires unicode mode; Ajv already compiles patterns in `u` mode.
  return flags.includes('u') ? flags : `${flags}u`;
}

function compileRe2(pattern: string, flags: string): RE2 {
  return new RE2(pattern, withUnicode(flags));
}

function isLookaround(node: AstNode): node is AstNode & { behavior: LookaroundBehavior; body: AstNode[] } {
  if (node.type !== 'group') return false;
  const behavior = (node as { behavior: string }).behavior;
  return (
    behavior === 'lookahead' ||
    behavior === 'negativeLookahead' ||
    behavior === 'lookbehind' ||
    behavior === 'negativeLookbehind'
  );
}

/** A single-code-point atom: literal, `.`, class, class escape or property escape. */
function isFixedWidthAtom(node: AstNode): boolean {
  return (
    node.type === 'value' ||
    node.type === 'dot' ||
    node.type === 'characterClass' ||
    node.type === 'characterClassEscape' ||
    node.type === 'unicodePropertyEscape'
  );
}

function isAnchor(node: AstNode | undefined, kind: 'start' | 'end'): boolean {
  return node !== undefined && node.type === 'anchor' && (node as { kind: string }).kind === kind;
}

/** True if any anchor of the given kinds occurs anywhere inside `nodes`. */
function containsAnchor(nodes: readonly AstNode[], kinds: readonly string[]): boolean {
  for (const node of nodes) {
    if (node.type === 'anchor' && kinds.includes((node as { kind: string }).kind)) return true;
    const body = (node as { body?: unknown }).body;
    if (node.type !== 'characterClass' && Array.isArray(body) && containsAnchor(body as AstNode[], kinds)) {
      return true;
    }
  }
  return false;
}

/** Code-unit index after the first `codePoints` code points of `input`. */
function offsetFromStart(input: string, codePoints: number): number {
  let index = 0;
  for (let i = 0; i < codePoints && index < input.length; i++) {
    index += (input.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return index;
}

/** Code-unit index before the last `codePoints` code points of `input`. */
function offsetFromEnd(input: string, codePoints: number): number {
  let index = input.length;
  for (let i = 0; i < codePoints && index > 0; i++) {
    const low = input.charCodeAt(index - 1);
    const isPair =
      index >= 2 &&
      low >= 0xdc00 &&
      low <= 0xdfff &&
      input.charCodeAt(index - 2) >= 0xd800 &&
      input.charCodeAt(index - 2) <= 0xdbff;
    index -= isPair ? 2 : 1;
  }
  return index;
}

/** Compile a lookaround body for testing at a cut point, or null if it can't be split out. */
function compileLookaround(
  term: AstNode & { behavior: LookaroundBehavior; body: AstNode[] },
  flags: string,
  codePoints: number,
  fromEnd: boolean
): SplitLookaround | null {
  const ahead = term.behavior === 'lookahead' || term.behavior === 'negativeLookahead';
  // A lookahead body is tested at the start of the input after the cut, a
  // lookbehind body at the end of the input before it; assertions that would
  // observe context across the cut can't be split out.
  if (containsAnchor(term.body, ahead ? ['start', 'boundary', 'not-boundary'] : ['end', 'boundary', 'not-boundary'])) {
    return null;
  }
  const body = term.raw.slice(ahead ? 3 : 4, -1); // "(?=" / "(?!" vs "(?<=" / "(?<!"
  let matcher: RE2;
  try {
    matcher = compileRe2(ahead ? `^(?:${body})` : `(?:${body})$`, flags);
  } catch {
    return null; // e.g. a nested lookaround or a backreference
  }
  const negative = term.behavior === 'negativeLookahead' || term.behavior === 'negativeLookbehind';
  return { codePoints, fromEnd, ahead, negative, matcher };
}

/**
 * Split top-level lookarounds that sit at a fixed offset from the start
 * (after `^` and single-code-point atoms) or from the end (before single-code-
 * point atoms and a final `$`) into separate RE2 checks. Returns null when the
 * pattern has no such lookarounds or anything else RE2 can't compile.
 *
 * Correctness: in every match of an anchored pattern, each such lookaround is
 * evaluated at the same, fixed position, so the pattern matches iff the
 * pattern with those lookarounds removed matches AND each lookaround's
 * condition holds at its position.
 */
function compileSplitLookarounds(pattern: string, flags: string): PatternMatcher | null {
  if (flags.includes('m') || flags.includes('v')) return null;
  let root: AstNode;
  try {
    root = parse(pattern, withUnicode(flags), PARSE_FEATURES);
  } catch {
    return null;
  }
  if (root.type !== 'alternative') return null;
  const terms = root.body as AstNode[];
  const lookarounds: SplitLookaround[] = [];
  const removed: Array<[number, number]> = [];

  // Prefix: ^ atom* (lookaround | atom)*
  let prefixEnd = 0;
  if (isAnchor(terms[0], 'start')) {
    let width = 0;
    let i = 1;
    for (; i < terms.length; i++) {
      const term = terms[i];
      if (isLookaround(term)) {
        const split = compileLookaround(term, flags, width, false);
        if (!split) return null;
        lookarounds.push(split);
        removed.push(term.range);
      } else if (isFixedWidthAtom(term)) {
        width++;
      } else {
        break;
      }
    }
    prefixEnd = i;
  }

  // Suffix: (lookaround | atom)* atom* $, not overlapping the prefix.
  const last = terms.length - 1;
  if (last >= prefixEnd && isAnchor(terms[last], 'end')) {
    let width = 0;
    for (let i = last - 1; i >= prefixEnd; i--) {
      const term = terms[i];
      if (isLookaround(term)) {
        const split = compileLookaround(term, flags, width, true);
        if (!split) return null;
        lookarounds.push(split);
        removed.push(term.range);
      } else if (isFixedWidthAtom(term)) {
        width++;
      } else {
        break;
      }
    }
  }
  if (lookarounds.length === 0) return null;

  let rest = '';
  let cursor = 0;
  for (const [start, end] of removed.sort((a, b) => a[0] - b[0])) {
    rest += pattern.slice(cursor, start);
    cursor = end;
  }
  rest += pattern.slice(cursor);
  let main: RE2;
  try {
    main = compileRe2(rest, flags);
  } catch {
    return null; // a lookaround or backreference elsewhere in the pattern
  }

  const source = `/${pattern}/${flags}`;
  return {
    test(input: string): boolean {
      if (!main.test(input)) return false;
      for (const lookaround of lookarounds) {
        const cut = lookaround.fromEnd
          ? offsetFromEnd(input, lookaround.codePoints)
          : offsetFromStart(input, lookaround.codePoints);
        const holds = lookaround.matcher.test(lookaround.ahead ? input.slice(cut) : input.slice(0, cut));
        if (holds === lookaround.negative) return false;
      }
      return true;
    },
    toString: () => source,
  };
}

/**
 * Compile a JSON Schema `pattern` with bounded matching time; see the module
 * comment. RE2 is preferred, with native ECMA-262 as the bounded fallback.
 */
export function compileSafePattern(pattern: string, flags: string): PatternMatcher {
  try {
    return compileRe2(pattern, flags) as unknown as PatternMatcher;
  } catch {
    const split = compileSplitLookarounds(pattern, flags);
    if (split) return split;
    return new BoundedNativePattern(pattern, withUnicode(flags));
  }
}

/**
 * Factory passed to Ajv's `code.regExp` option. Ajv invokes it as a plain call
 * (`regExp(pattern, flags)`, no `new`) and uses only `test` and `toString`.
 *
 * Ajv's `RegExpEngine` type also requires a `code` string that reconstructs the
 * engine when Ajv emits standalone validation modules.
 */
export const createLinearRegExp: ((pattern: string, flags: string) => RegExp) & {
  code: string;
} = Object.assign((pattern: string, flags: string): RegExp => compileSafePattern(pattern, flags) as RegExp, {
  code: '(function(p,f){return require("@globaltypesystem/gts-ts/dist/regex-engine").createLinearRegExp(p,f)})',
});
