import { RE2JS, RE2JSSyntaxException } from 're2js';
import { GtsStore, createJsonEntity } from '../src';
import { compileSafePattern, RegexCompilationError } from '../src/regex-engine';
import { assertSafeSchemaPatterns } from '../src/schema-safety';
import * as profile from '../src/regex-profile';
import { regexProfileViolation } from '../src/regex-profile';

const DIALECT = 'http://json-schema.org/draft-07/schema#';
const DRAFT_2019 = 'https://json-schema.org/draft/2019-09/schema';
const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema';
const STRESS = '^(?:(a|aa)+$|a+!$)';
const UNSUPPORTED = 'a(?=b)';

function register(body: Record<string, unknown>, dialect = DIALECT): { store: GtsStore; id: string } {
  const store = new GtsStore();
  const id = 'gts.x.security.regex.safe.v1~';
  store.register(createJsonEntity({ $id: `gts://${id}`, $schema: dialect, ...body }));
  return { store, id };
}

describe('GTS regex profile membership', () => {
  // Keep membership cases aligned with gts-go's TestSafeRegexpEngine_ProfileMembership.
  const supported = [
    '',
    'abc',
    'é😀',
    '^[A-Za-z0-9]+$',
    '[^abc]',
    '(foo|bar)+',
    '(?:ab)+',
    '[a-z]{1,3}',
    'a{3}',
    'a{2,}',
    'a{0}',
    'a{0,0}',
    'a{1000}',
    '(a(b)?c)*',
    'a.*?b',
    'a*?b+?c??d{1,2}?e{2,}?f{2}?',
    '\\(x\\)\\.\\*',
    '\\\\C',
    '\\n\\r\\t\\f\\v',
    '\\x41',
    '\\d\\D\\w\\W\\s\\S',
    '^a.c$',
    '(a*)*b',
    '(a+)+$',
    '^(a|aa)+$',
    '^(?:(a|aa)+$|a+!$)',
    '\\^\\$\\\\\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\/',
    'a|',
    '|',
    '()',
    '(?:)*',
    'a/b',
    '#&~ ',
    // Classes: '-' first or last, escaped '-' and ']', shorthands, '^' not first.
    '[-a]',
    '[a-]',
    '[^-a]',
    '[\\-\\]]',
    '[\\d\\s\\w\\D\\S\\W]',
    '[\\w-]',
    '[a^]',
    '[\\x00-\\x7F]',
    '[😀é]',
    '[\\/\\[]',
    '[&]',
    '[a&b~c]',
    // At the common support bounds.
    'a{1000,}',
    '(?:a{10}){100}',
    '(?:a{0}){500}',
    '(?:a*){500}',
    'a{1000}'.repeat(4) + 'a'.repeat(72), // expanded length 4096
    'a'.repeat(4096),
    'é'.repeat(4096),
    '😀'.repeat(4096), // code points, not UTF-16 units
    '('.repeat(profile.MAX_REGEX_GROUP_DEPTH) + 'a' + ')'.repeat(profile.MAX_REGEX_GROUP_DEPTH),
    '(?:'.repeat(profile.MAX_REGEX_GROUP_DEPTH) + 'a' + ')'.repeat(profile.MAX_REGEX_GROUP_DEPTH),
    // Class ranges compare code points, not UTF-16 units.
    '[\ue000-😀]',
    '\u0000',
  ];
  test.each(supported)('supports %j', (pattern) => {
    expect(regexProfileViolation(pattern)).toBeUndefined();
    expect(() => compileSafePattern(pattern)).not.toThrow();
  });

  const unsupported = [
    // Malformed in ECMA-262 `u` and RE2.
    '[',
    '[unclosed',
    '(unclosed',
    'a)',
    'a{3,2}',
    '\\',
    '*abc',
    'a**',
    // ECMA-262 `u` only.
    'a(?=b)',
    'a(?!b)',
    '(?<=a)b',
    '(?<!a)b',
    '^(a+)\\1$',
    '^(?<w>a)\\k<w>$',
    '\\' + 'u0041',
    '\\cA',
    '\\0',
    '[\\b]',
    // RE2 only.
    '\\Qx.y\\E',
    '(?U)a+',
    '(?i)abc',
    '(?s).',
    '(?m)^a',
    'abc\\z',
    '\\Aabc',
    '\\x{41}',
    '[[:alpha:]]',
    '\\C',
    '(?P<n>a)',
    '\\pL',
    'a{01}',
    'a{,2}',
    'a{',
    'a{2',
    '}',
    ']',
    'a{2}{3}',
    'a???',
    // Neither.
    '(?>a+)b',
    'a++b',
    '\\e',
    '\\x4',
    '\\xZZ',
    '\\-',
    // Accepted by both but excluded by the draft.
    '(?i:a)b',
    '(?<w>a)',
    '^\\p{L}+$',
    '\\ba\\b',
    '\\B',
    // Assertions are not quantifiable in ECMA-262 `u`.
    '^*',
    '$+',
    'a^{2}',
    // Ambiguous class spellings and nested classes.
    '[]',
    '[^]',
    '[]a]',
    '[a[]',
    '[a&&b]',
    '[a--b]',
    '[a~~b]',
    '[a-b-c]',
    '[\\d-z]',
    '[a-\\d]',
    '[\\s-a]',
    '[a-\\S]',
    '[z-a]',
    '[--]',
    // Beyond the common support bounds.
    'a{1001}',
    '(?:a{1000}){2}',
    '(?:a{1000,}){2}',
    '(?:a{2}){501}',
    'a{99999999999999999999}',
    'a{1000}'.repeat(4) + 'a'.repeat(73), // expanded length 4097
    'a'.repeat(4097),
    '😀'.repeat(4097),
    '(?:ab){1000}',
    '(?:a*){1000}',
    '(?:a{0}){1000}', // expanded length 6006, 6006, 8006
    '\\w{1000}\\w{1000}\\w{100}',
    '('.repeat(profile.MAX_REGEX_GROUP_DEPTH + 1) + 'a' + ')'.repeat(profile.MAX_REGEX_GROUP_DEPTH + 1),
    '('.repeat(100000) + ')'.repeat(100000),
    // Unpaired surrogates; the profile is defined over Unicode scalar values.
    '\ud800',
    'a\udc00',
    '[\ud800]',
    '\udbff\udbff',
    '[😀-\ue000]',
  ];
  test.each(unsupported)('rejects %j', (pattern) => {
    expect(regexProfileViolation(pattern)).toEqual(expect.any(String));
    expect(() => compileSafePattern(pattern)).toThrow(RegexCompilationError);
  });

  test('reports the reason and a shortened excerpt', () => {
    expect(() => compileSafePattern('a(?=b)')).toThrow(
      'Unsupported regular expression /a(?=b)/: unsupported group construct at offset 2'
    );
    expect(() => compileSafePattern('a'.repeat(5000))).toThrow(/\/a{64}\.\.\.\/: expanded length above 4096/);
  });

  test('accepts only the u flag, as a programming error otherwise', () => {
    expect(() => compileSafePattern('a', 'u')).not.toThrow();
    for (const flags of ['g', 'i', 'iu', 'm', 's']) {
      expect(() => compileSafePattern('a', flags)).toThrow(/flags/);
      expect(() => compileSafePattern('a', flags)).not.toThrow(RegexCompilationError);
    }
  });
});

describe('GTS reference (RE2) matching', () => {
  // RE2 semantics: `.` excludes only LF; `\s` is [\t\n\f\r ]; `\d` and `\w` are ASCII.
  test.each([
    ['abc', ['abc', 'xabcx'], ['ab', 'a-b-c']],
    ['^abc$', ['abc'], ['ABC', 'x\nabc\ny', 'abc\n', 'x\nabc']],
    ['', ['', 'abc'], []],
    ['^[^0-9]+$', ['abc', 'a\nb'], ['a1', '']],
    ['^a+?b??c{1,2}?$', ['ac', 'abcc', 'aabc'], ['a', 'bc', 'accc']],
    ['^\\(a\\.b\\)\\*$', ['(a.b)*'], ['(axb)*']],
    ['^\\t\\n\\r\\f\\v$', ['\t\n\r\f\v'], ['\t\n\r\f']],
    ['^\\x41$', ['A'], ['a', 'x41']],
    ['^\\d$', ['0', '9'], ['a', '١']],
    ['^\\D$', ['a', '١'], ['0']],
    ['^\\w$', ['a', 'Z', '0', '_'], ['-', 'é']],
    ['^\\W$', ['-', 'é'], ['a', '_']],
    ['^\\s$', [' ', '\t', '\n', '\f', '\r'], ['', 'a', '\v', ' ', ' ', '﻿', '\u0085']],
    ['^\\S$', ['a', '\v', ' ', '﻿', '😀'], [' ', '\t', '\n']],
    ['^[\\s]$', [' ', '\r'], ['a', '\v']],
    ['^[^\\s]$', ['a', '\v'], [' ', '\r']],
    ['^[^\\S]$', [' '], ['a', ' ']],
    ['^[\\s\\S]$', ['a', '\n', '\r', ' ', ' ', '😀'], ['']],
    ['^[^\\s\\S]$', [], ['a', '\n', ' ']],
    ['^[a\\x26\\x26b]$', ['&', 'a'], ['c']],
    ['(^)*a', ['a', 'ba'], []],
    ['^.$', ['a', ' ', '\t', '\r', ' ', ' ', '\u0085', '😀', 'é'], ['', '\n', 'ab', '😀😀']],
    ['^.{2}$', ['ab', '😀a'], ['😀']],
    ['^[^a]$', ['😀', '\n'], ['a', '😀😀']],
    ['^[😀é]$', ['😀', 'é'], ['😀é']],
    ['^[\\-\\]\\[\\\\^]+$', ['-]', '[\\^'], ['a']],
    ['^a{1000}$', ['a'.repeat(1000)], ['a'.repeat(1001)]],
  ] as const)('%j', (pattern, matches, nonMatches) => {
    const compiled = compileSafePattern(pattern);
    for (const input of matches) expect([input, compiled.test(input)]).toEqual([input, true]);
    for (const input of nonMatches) expect([input, compiled.test(input)]).toEqual([input, false]);
  });

  test.each(['^(a+)+$', '^(a|aa)+$', '^a*a*a*b$', '(a*)*b'])('%s is linear on a backtracking attack', (pattern) => {
    const start = Date.now();
    expect(compileSafePattern(pattern).test('a'.repeat(50_000) + '!')).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('completes a thousand successful matches without a per-match timeout', () => {
    const { store, id } = register({
      type: 'object',
      properties: { values: { type: 'array', items: { pattern: STRESS } } },
    });
    const start = Date.now();
    expect(store.validateTransientInstance({ values: Array(1000).fill('a'.repeat(64) + '!') }, id, null).ok).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('not rejects a matching string after the expensive alternative', () => {
    const { store, id } = register({ type: 'string', not: { pattern: STRESS } });
    expect(store.validateTransientInstance('a'.repeat(64) + '!', id, null).ok).toBe(false);
    expect(store.validateTransientInstance('b', id, null).ok).toBe(true);
  });
});

describe('engine failures', () => {
  afterEach(() => jest.restoreAllMocks());

  test('propagate from compilation instead of becoming unsupported syntax', () => {
    jest.spyOn(RE2JS, 'compile').mockImplementation(() => {
      throw new RangeError('engine exhausted');
    });
    expect(() => compileSafePattern('a')).toThrow(RangeError);
  });

  test('escape not when the format regex check itself fails', () => {
    const { store, id } = register({ type: 'string', not: { format: 'regex' } });
    jest.spyOn(profile, 'regexProfileViolation').mockImplementation(() => {
      throw new RangeError('checker exhausted');
    });
    const result = store.validateTransientInstance('abc', id, null);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('checker exhausted');
  });

  test('do not affect format regex, which checks the profile without compiling', () => {
    const compile = jest.spyOn(RE2JS, 'compile');
    const { store, id } = register({ type: 'string', not: { format: 'regex' } });
    expect(store.validateTransientInstance(UNSUPPORTED, id, null).ok).toBe(true);
    expect(store.validateTransientInstance('abc', id, null).ok).toBe(false);
    expect(compile).not.toHaveBeenCalled();
  });

  test('report an engine that rejects a profile expression as an engine failure', () => {
    jest.spyOn(RE2JS, 'compile').mockImplementation(() => {
      throw new RE2JSSyntaxException('missing feature', 'a');
    });
    expect(() => compileSafePattern('a')).toThrow(/engine failed/);
    expect(() => compileSafePattern('a')).not.toThrow(RegexCompilationError);
  });

  test('fail pattern validation that not would otherwise invert', () => {
    // Ajv reuses a compiled expression per pattern, so wrap matchers up front.
    let failing = false;
    const compile = RE2JS.compile.bind(RE2JS);
    jest.spyOn(RE2JS, 'compile').mockImplementation((pattern, flags) => {
      const compiled = compile(pattern, flags);
      const test = compiled.test.bind(compiled);
      jest.spyOn(compiled, 'test').mockImplementation((input) => {
        if (failing) throw new RangeError('match failed');
        return test(input);
      });
      return compiled;
    });
    const { store, id } = register({ type: 'string', not: { pattern: '^a$' } });
    expect(store.validateTransientInstance('b', id, null).ok).toBe(true);
    failing = true;
    const result = store.validateTransientInstance('b', id, null);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('match failed');
  });
});

describe('schema regex support checks', () => {
  test.each([
    { not: { pattern: UNSUPPORTED } },
    { if: false, then: { pattern: UNSUPPORTED } },
    { anyOf: [true, { pattern: UNSUPPORTED }] },
    { definitions: { unused: { pattern: UNSUPPORTED } } },
    { patternProperties: { [UNSUPPORTED]: true } },
    { 'x-gts-traits-schema': { properties: { value: { pattern: UNSUPPORTED } } } },
  ])('rejects unsupported patterns even in inactive schema positions: %j', (body) => {
    expect(() => register({ type: 'object', ...body })).toThrow(/regular expression/i);
  });

  test('does not interpret literal data as schema patterns', () => {
    const literal = { pattern: UNSUPPORTED };
    const { store, id } = register({
      type: 'object',
      default: literal,
      examples: [literal],
      customAnnotation: literal,
      properties: { pattern: { type: 'string' }, c: { const: literal }, e: { enum: [literal] } },
    });
    expect(store.validateTransientInstance({ pattern: UNSUPPORTED, c: literal, e: literal }, id, null).ok).toBe(true);
  });

  test.each([
    ['(?:abc)', true],
    ['a{1000}', true],
    ['(?i:abc)', false],
    ['\\Qx.y\\E', false],
    ['(?U)a+', false],
    ['\\C', false],
    ['a(?=b)', false],
    ['(a)\\1', false],
    ['a{1001}', false],
  ] as const)('format regex and matching accept the same syntax: %s', (value, expected) => {
    const { store, id } = register({ type: 'string', format: 'regex' });
    expect(store.validateTransientInstance(value, id, null).ok).toBe(expected);
    const compiles = (() => {
      try {
        compileSafePattern(value, 'u');
        return true;
      } catch {
        return false;
      }
    })();
    expect(compiles).toBe(expected);
  });
});

describe('dialect-aware schema positions', () => {
  const unsupported = { pattern: UNSUPPORTED };

  test.each([
    ['prefixItems', { prefixItems: [unsupported] }, DIALECT, DRAFT_2020],
    ['dependentSchemas', { dependentSchemas: { x: unsupported } }, DIALECT, DRAFT_2019],
    ['$defs', { $defs: { x: unsupported } }, DIALECT, DRAFT_2020],
    ['unevaluatedProperties', { unevaluatedProperties: unsupported }, DIALECT, DRAFT_2019],
  ])('%s is an annotation in one dialect and a schema in another', (_keyword, body, ignoring, defining) => {
    expect(() => register({ type: 'object', ...body }, ignoring)).not.toThrow();
    expect(() => register({ type: 'object', ...body }, defining)).toThrow(RegexCompilationError);
  });

  test('checks dependencies under 2020-12 because Ajv executes it', () => {
    expect(() => register({ type: 'object', dependencies: { x: unsupported } }, DRAFT_2020)).toThrow(
      RegexCompilationError
    );
  });

  test('checks an unknown keyword only when a reference reaches it', () => {
    expect(() => register({ type: 'object', customSchemas: { unused: unsupported } })).not.toThrow();
    expect(() =>
      register({
        type: 'object',
        anyOf: [true, { $ref: '#/customSchemas/unused' }],
        customSchemas: { unused: unsupported },
      })
    ).toThrow(RegexCompilationError);
  });

  test.each([
    ['a percent-encoded separator', '#/customSchemas%2Funused', { customSchemas: { unused: unsupported } }],
    ['an escaped slash in a key', '#/customSchemas~1unused', { 'customSchemas/unused': unsupported }],
    ['a percent-encoded escaped slash', '#/customSchemas%7E1unused', { 'customSchemas/unused': unsupported }],
  ])('decodes %s in a reference before reading the pointer', (_name, ref, body) => {
    expect(() => register({ type: 'object', anyOf: [true, { $ref: ref }], ...body })).toThrow(RegexCompilationError);
  });

  test('does not treat an escaped slash as a separator', () => {
    expect(() =>
      register({
        type: 'object',
        anyOf: [true, { $ref: '#/customSchemas~1unused' }],
        customSchemas: { unused: unsupported },
      })
    ).not.toThrow(RegexCompilationError);
  });

  test('follows recursive references without looping', () => {
    const { store, id } = register({
      type: 'object',
      $ref: '#/definitions/node',
      definitions: { node: { type: 'object', properties: { next: { $ref: '#/definitions/node' } } } },
    });
    expect(store.validateTransientInstance({ next: { next: {} } }, id, null).ok).toBe(true);
  });

  test('resolves a fragment against the enclosing embedded resource', () => {
    const embedded = (ref: string) => ({
      $schema: DIALECT,
      custom: unsupported,
      properties: {
        inner: { $id: 'https://example.com/inner', other: unsupported, anyOf: [true, { $ref: ref }] },
      },
    });
    expect(() => assertSafeSchemaPatterns(embedded('#/other'))).toThrow(RegexCompilationError);
    expect(() => assertSafeSchemaPatterns(embedded('#/custom'))).not.toThrow();
  });

  test('resolves a pointer that crosses an embedded $id within that resource', () => {
    // Ajv resolves `#/target` inside `inner`, where the reference sits.
    const inner = (target: unknown) => ({
      $id: 'inner',
      custom: { $ref: '#/target' },
      target,
    });
    const body = (innerTarget: unknown, rootTarget: unknown) => ({
      type: 'object',
      definitions: { inner: inner(innerTarget) },
      target: rootTarget,
      anyOf: [true, { $ref: '#/definitions/inner/custom' }],
    });
    expect(() => register(body(unsupported, { pattern: 'a' }))).toThrow(RegexCompilationError);
    expect(() => register(body({ pattern: 'a' }, unsupported))).not.toThrow();
  });

  test('checks a synthesized trait schema under its host dialect', () => {
    const traitSchema = { type: 'object', properties: { value: { prefixItems: [unsupported] } } };
    expect(() => assertSafeSchemaPatterns(traitSchema, { $schema: DIALECT })).not.toThrow();
    expect(() => assertSafeSchemaPatterns(traitSchema, { $schema: DRAFT_2020 })).toThrow(RegexCompilationError);

    const { store, id } = register({ type: 'object', 'x-gts-traits-schema': traitSchema });
    expect(store.validateSchema(id).ok).toBe(true);
  });
});
