/*
 * Linear-time regex engine for JSON Schema `pattern` / `patternProperties`.
 *
 * Schemas are registered from untrusted input and Ajv compiles their `pattern`
 * keywords with the platform `RegExp` — a backtracking engine that is
 * vulnerable to catastrophic backtracking (ReDoS, CWE-1333). A source-length
 * bound (`MAX_REGEX_LEN`) caps how much text an attacker can hand the compiler
 * but does NOT bound match time on a backtracking engine, so a short pattern
 * such as `(a+)+$` can still hang validation.
 *
 * Ajv's `code.regExp` option lets us swap the engine used for `pattern`
 * matching to RE2 (via `re2-wasm`), whose guaranteed linear-time matching makes
 * catastrophic backtracking impossible. This is the same class of protection
 * the sibling implementations get at runtime — gts-go via `regexp2`'s
 * `MatchTimeout` and gts-python via the `regex` module's match `timeout` — but
 * achieved by construction so validation stays synchronous. `MAX_REGEX_LEN` is
 * retained purely as a cheap resource cap.
 *
 * Trade-off: RE2 does not support ECMA-262 lookaround (`(?=`, `(?!`, `(?<=`,
 * `(?<!`) or backreferences, so a `pattern` that uses them is rejected when the
 * schema is compiled rather than registering. Regex *format* validation (the
 * `regex` string format) is unaffected and still accepts those constructs.
 */

import { RE2 } from 're2-wasm';

/**
 * Factory passed to Ajv's `code.regExp` option. Ajv invokes it as a plain call
 * (`regExp(pattern, flags)`, no `new`), so this wraps the `RE2` constructor.
 * RE2 requires unicode mode and Ajv already compiles patterns in `u` mode by
 * default, so the flag is ensured to be present.
 *
 * Ajv's `RegExpEngine` type also requires a `code` string that reconstructs the
 * engine when Ajv emits standalone validation modules; it mirrors the runtime
 * factory below using `re2-wasm` directly so it carries no dependency on this
 * package's own build layout.
 */
export const createLinearRegExp: ((pattern: string, flags: string) => RegExp) & {
  code: string;
} = Object.assign(
  (pattern: string, flags: string): RegExp => {
    const unicodeFlags = flags.includes('u') ? flags : `${flags}u`;
    return new RE2(pattern, unicodeFlags) as unknown as RegExp;
  },
  {
    code: '(function(p,f){return new (require("re2-wasm").RE2)(p, f.includes("u")?f:f+"u")})',
  }
);
