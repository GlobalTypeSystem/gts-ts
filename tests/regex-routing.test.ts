import { GtsStore, createJsonEntity } from '../src';
import { RegexCompilationError, compileSafePattern } from '../src/regex-engine';

const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema';
const PROBE = '^gtsprobe[0-9]+$';
const PROBE_KEY = '^gtskey[0-9]+$';

function schema(name: string, extra: Record<string, unknown>) {
  return { $schema: DRAFT_2020, $id: `gts://gts.acme.demo.rt.${name}.v1~`, type: 'object', ...extra };
}
function typeId(name: string) {
  return `gts.acme.demo.rt.${name}.v1~`;
}
function validate(s: Record<string, any>, name: string, content: unknown) {
  const store = new GtsStore();
  store.register(createJsonEntity(s));
  return store.validateTransientInstance(content, typeId(name), null, 'none');
}

describe('regex routing through re2js', () => {
  const nativeRegExp = globalThis.RegExp;
  let recorded: string[] = [];

  beforeEach(() => {
    recorded = [];
    globalThis.RegExp = new Proxy(nativeRegExp, {
      construct(target, args, newTarget) {
        recorded.push(String(args[0]));
        return Reflect.construct(target, args, newTarget);
      },
    });
  });
  afterEach(() => {
    globalThis.RegExp = nativeRegExp;
  });

  const noProbeRecorded = () => recorded.filter((source) => source.includes('gtsprobe') || source.includes('gtskey'));

  test('positive control: a deliberate new RegExp is recorded', () => {
    new RegExp(PROBE);
    expect(noProbeRecorded()).toContain(PROBE);
  });

  test('pattern accepts and rejects without a native RegExp', () => {
    const s = schema('pat', { properties: { code: { type: 'string', pattern: PROBE } } });
    expect(validate(s, 'pat', { code: 'gtsprobe12' }).ok).toBe(true);
    expect(validate(s, 'pat', { code: 'nope' }).ok).toBe(false);
    expect(noProbeRecorded()).toEqual([]);
  });

  test('patternProperties routes through re2js', () => {
    const s = schema('pprops', { patternProperties: { [PROBE_KEY]: { type: 'integer' } } });
    expect(validate(s, 'pprops', { gtskey1: 1 }).ok).toBe(true);
    expect(validate(s, 'pprops', { gtskey1: 'x' }).ok).toBe(false);
    expect(noProbeRecorded()).toEqual([]);
  });

  test('propertyNames routes through re2js', () => {
    const s = schema('pnames', { propertyNames: { pattern: PROBE_KEY } });
    expect(validate(s, 'pnames', { gtskey1: 1 }).ok).toBe(true);
    expect(validate(s, 'pnames', { other: 1 }).ok).toBe(false);
    expect(noProbeRecorded()).toEqual([]);
  });

  test('format: regex values route through re2js', () => {
    const s = schema('fmt', { properties: { re: { type: 'string', format: 'regex' } } });
    expect(validate(s, 'fmt', { re: PROBE }).ok).toBe(true);
    expect(validate(s, 'fmt', { re: '(?=gtsprobe)x' }).ok).toBe(false);
    expect(noProbeRecorded()).toEqual([]);
  });

  test('additionalProperties: false next to patternProperties', () => {
    const s = schema('addl', { patternProperties: { [PROBE_KEY]: { type: 'integer' } }, additionalProperties: false });
    expect(validate(s, 'addl', { gtskey1: 1 }).ok).toBe(true);
    expect(validate(s, 'addl', { gtskey1: 1, extra: 2 }).ok).toBe(false);
    expect(noProbeRecorded()).toEqual([]);
  });

  test('unevaluatedProperties: false next to patternProperties', () => {
    const s = schema('uneval', {
      patternProperties: { [PROBE_KEY]: { type: 'integer' } },
      unevaluatedProperties: false,
    });
    expect(validate(s, 'uneval', { gtskey1: 1 }).ok).toBe(true);
    expect(validate(s, 'uneval', { gtskey1: 1, extra: 2 }).ok).toBe(false);
    expect(noProbeRecorded()).toEqual([]);
  });

  describe('out-of-profile patterns are rejected with RegexCompilationError wording', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['pattern', { properties: { a: { type: 'string', pattern: '(?=a)b' } } }],
      ['patternProperties', { patternProperties: { '(?=a)b': { type: 'string' } } }],
      ['propertyNames', { propertyNames: { pattern: '(?=a)b' } }],
    ];
    test.each(cases)('%s', (name, extra) => {
      const s = schema(`oop${name}`, extra);
      const result = new GtsStore().validateSchemaDocument(s, typeId(`oop${name}`));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Unsupported regular expression/);
    });

    test('format: regex value', () => {
      const s = schema('oopfmt', { properties: { re: { type: 'string', format: 'regex' } } });
      const result = validate(s, 'oopfmt', { re: '(?=a)b' });
      expect(result.ok).toBe(false);
    });

    test('RegexCompilationError is the thrown type', () => {
      expect(() => compileSafePattern('(?=a)b')).toThrow(RegexCompilationError);
    });
  });

  test('catastrophic backtracking pattern runs in linear time', () => {
    const s = schema('cat', { properties: { v: { type: 'string', pattern: '^(a+)+$' } } });
    const started = Date.now();
    const result = validate(s, 'cat', { v: `${'a'.repeat(5000)}b` });
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
