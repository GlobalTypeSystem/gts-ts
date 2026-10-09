/**
 * Shared engine for schema patterns, regex formats and compatibility checks.
 * GTS profile expressions (gts-spec §11.0.1) compile unchanged with re2js:
 * linear-time matching, reference RE2 semantics, no declared deviations.
 */
import { RE2JS, RE2JSSyntaxException } from 're2js';
import { regexProfileViolation } from './regex-profile';

/** An expression is malformed, or outside the GTS profile or its bounds. */
export class RegexCompilationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegexCompilationError';
  }
}

/** The subset of `RegExp` Ajv uses for `pattern` / `patternProperties`. */
export interface SafePattern {
  /** True when the expression matches anywhere in `input`. */
  test(input: string): boolean;
  toString(): string;
}

/** Quote `source` for an error message, shortened if long. */
function excerpt(source: string): string {
  const codePoints = Array.from(source.slice(0, 129));
  return codePoints.length > 64 ? `/${codePoints.slice(0, 64).join('')}.../` : `/${source}/`;
}

/**
 * Check profile membership without compilation; throw {@link RegexCompilationError}
 * for expressions outside the profile or its bounds.
 */
export function assertRegexProfile(source: string): void {
  const violation = regexProfileViolation(source);
  if (violation !== undefined) {
    throw new RegexCompilationError(`Unsupported regular expression ${excerpt(source)}: ${violation}`);
  }
}

/**
 * Compile a GTS profile expression with re2js. Flags may be empty or `u`;
 * matching uses code points, is case-sensitive, with multiline and dot-all off.
 * Unsupported expressions throw {@link RegexCompilationError}; engine errors propagate.
 */
export function compileSafePattern(pattern: string, flags = 'u'): SafePattern {
  if (flags !== '' && flags !== 'u') throw new Error(`Unsupported regular expression flags: ${flags}`);
  assertRegexProfile(pattern);
  let compiled: RE2JS;
  try {
    compiled = RE2JS.compile(pattern);
  } catch (error) {
    // Profile membership passed; compilation errors are engine failures.
    if (error instanceof RE2JSSyntaxException) {
      throw new Error(`Regular expression engine failed on ${excerpt(pattern)}: ${error.message}`);
    }
    throw error;
  }
  const source = `/${pattern}/${flags}`;
  return {
    test: (input: string) => compiled.test(input),
    toString: () => source,
  };
}

/** Ajv calls this factory without `new` and uses its matcher's test method. */
export const createLinearRegExp: ((pattern: string, flags: string) => RegExp) & {
  code: string;
} = Object.assign((pattern: string, flags: string): RegExp => compileSafePattern(pattern, flags) as RegExp, {
  code: '(function(p,f){return require("@globaltypesystem/gts-ts/dist/regex-engine").createLinearRegExp(p,f)})',
});
