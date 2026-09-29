/**
 * ReDoS-safe `pattern` engine (src/regex-engine.ts): patterns use linear-time
 * RE2 where possible, including common ECMA-262 lookaround idioms split into
 * RE2 checks. Remaining ECMA-262 constructs use the native engine inside a
 * bounded VM execution.
 */

import { GtsStore, createJsonEntity } from '../src';
import { compileSafePattern } from '../src/regex-engine';

/** Every string over `alphabet` up to `maxLength` characters. */
function allStrings(alphabet: string, maxLength: number): string[] {
  const chars = [...alphabet];
  const out: string[] = [''];
  let frontier = [''];
  for (let length = 1; length <= maxLength; length++) {
    frontier = frontier.flatMap((prefix) => chars.map((c) => prefix + c));
    out.push(...frontier);
  }
  return out;
}

/** Time a single match; a generous budget keeps this about blow-up, not micro-timing. */
function elapsedMs(run: () => void): number {
  const start = Date.now();
  run();
  return Date.now() - start;
}

// ISO-8601 duration patterns from gts-spec's examples (trait schemas).
const SPEC_RETENTION = '^P(?!$).+';
const SPEC_DURATION = '^P(?!$)(?:\\d+Y)?(?:\\d+M)?(?:\\d+D)?(?:T(?:\\d+H)?(?:\\d+M)?(?:\\d+S)?)?$';

describe('compileSafePattern', () => {
  describe('lookarounds split into RE2 checks match exactly like ECMA-262', () => {
    const cases: Array<[string, string, number]> = [
      [SPEC_RETENTION, 'PT1x\n', 5],
      [SPEC_DURATION, 'PTYMDHS1', 5],
      ['^(?=.*[A-Z])(?=.*\\d).{3,}$', 'aA1 ', 5],
      ['^(?![0-9])\\w+$', 'a1_-', 5],
      ['^ab(?<=b)c+', 'abcx', 5],
      ['^[a-z0-9-]+(?<!-)$', 'a1-_', 6],
      ['^(?!-)[a-z-]+(?<!-)$', 'ab-', 6],
      ['\\d+(?!\\.)$', '12.a', 6],
      ['^\\p{Lu}(?=\\p{Ll})', 'Aa1\u{1F600}', 5],
      ['^.(?=\u{1F600})..(?<!b)$', 'a\u{1F600}bc', 5],
    ];

    test.each(cases)('%s', (pattern, alphabet, maxLength) => {
      const safe = compileSafePattern(pattern, 'u');
      const native = new RegExp(pattern, 'u');
      const mismatches = allStrings(alphabet, maxLength).filter((s) => safe.test(s) !== native.test(s));
      expect(mismatches).toEqual([]);
    });
  });

  test('accepts the gts-spec example duration patterns with the expected results', () => {
    const retention = compileSafePattern(SPEC_RETENTION, 'u');
    expect(['P90D', 'PT1H', 'P'].map((s) => retention.test(s))).toEqual([true, true, false]);
    const duration = compileSafePattern(SPEC_DURATION, 'u');
    expect(['P1Y2M3DT4H5M6S', 'PT5M', 'P', 'P1W', 'X1D'].map((s) => duration.test(s))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  test.each([
    ['nested quantifier behind a lookahead', '^(?=x)(a+)+$', 'x' + 'a'.repeat(50_000) + '!'],
    ['ambiguous alternation behind a negative lookahead', '^(?!b)(a|a)*$', 'a'.repeat(50_000) + '!'],
    ['nested quantifier before a trailing lookbehind', '^(a+)+(?<!b)$', 'a'.repeat(50_000) + 'b'],
    ['spec duration pattern on a long digit run', SPEC_DURATION, 'P' + '1'.repeat(50_000) + '!'],
  ])('matches %s in linear time (ReDoS immunity)', (_name, pattern, adversarial) => {
    // On the backtracking platform RegExp these inputs would pin a CPU for
    // minutes; split into RE2 checks they resolve immediately.
    const safe = compileSafePattern(pattern, 'u');
    expect(elapsedMs(() => safe.test(adversarial))).toBeLessThan(2000);
  });

  test.each([
    ['a lookaround after a quantifier', '^(a+)+(?=b)', 'abx'],
    ['an unanchored lookaround', 'a(?=b)', 'zabx'],
    ['a lookbehind', '(?<=\\d{3})px', '123pxa'],
    ['a backreference', '^(a+)\\1$', 'aaab'],
    ['a word boundary in a lookahead', '^(?=a\\b)', 'ab!'],
  ])('matches %s with bounded native ECMA-262 semantics', (_name, pattern, alphabet) => {
    const safe = compileSafePattern(pattern, 'u');
    const native = new RegExp(pattern, 'u');
    const mismatches = allStrings(alphabet, 5).filter((s) => safe.test(s) !== native.test(s));
    expect(mismatches).toEqual([]);
  });
});

describe('schema patterns with lookaround', () => {
  test('a spec-style trait pattern with a lookahead validates instances', () => {
    const store = new GtsStore();
    const id = 'gts.x.security.regex.lookahead.v1~';
    store.register(
      createJsonEntity({
        $id: `gts://${id}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'string',
        pattern: SPEC_RETENTION,
      })
    );
    expect(store.validateTransientInstance('P90D', id, null).ok).toBe(true);
    expect(store.validateTransientInstance('P', id, null).ok).toBe(false);
  });

  test('a backtracking ECMA-262 pattern is bounded', () => {
    const store = new GtsStore();
    const id = 'gts.x.security.regex.bounded.v1~';
    store.register(
      createJsonEntity({
        $id: `gts://${id}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'string',
        pattern: '^(a+)+(?=b)',
      })
    );
    const start = Date.now();
    const result = store.validateTransientInstance('a'.repeat(50_000), id, null);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('regular expression match timed out');
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
