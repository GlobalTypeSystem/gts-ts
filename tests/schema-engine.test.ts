import { readFileSync } from 'fs';
import { join } from 'path';
import { compileSchema } from 'json-schema-library';
import {
  adaptLibraryError,
  buildEngineDrafts,
  createSchemaEngine,
  ISSUE_CODE_TABLE,
  type SchemaEngine,
} from '../src/schema-engine';
import { RegexCompilationError } from '../src/regex-engine';
import { attachSourceLocations } from '../src/source-location';
import type { SourceSpan } from '../src/types';

const DIALECTS = {
  'draft-07': 'http://json-schema.org/draft-07/schema#',
  '2019-09': 'https://json-schema.org/draft/2019-09/schema',
  '2020-12': 'https://json-schema.org/draft/2020-12/schema',
} as const;
const DIALECT_NAMES = Object.keys(DIALECTS) as (keyof typeof DIALECTS)[];

let selected: string | undefined;
function makeEngine(): SchemaEngine {
  return createSchemaEngine({ getSelectedTypeId: () => selected });
}
function schemaOf(dialect: keyof typeof DIALECTS, body: Record<string, unknown>): Record<string, unknown> {
  return { $schema: DIALECTS[dialect], ...body };
}

beforeEach(() => {
  selected = undefined;
});

describe('issue adapter: params and instancePath', () => {
  const engine = makeEngine();

  test('type failure maps keyword and params.type', () => {
    const issues = engine.validate(schemaOf('2020-12', { type: 'string' }), 5);
    expect(issues).toHaveLength(1);
    expect(issues[0].keyword).toBe('type');
    expect(issues[0].params).toEqual({ type: 'string' });
    expect(issues[0].instancePath).toBe('/');
    expect(issues[0].schemaPath).toBe('#/type');
    expect(`is not of type '${issues[0].params.type}'`).toBe("is not of type 'string'");
  });

  test('required failure maps params.missingProperty', () => {
    const issues = engine.validate(schemaOf('2020-12', { type: 'object', required: ['a'] }), {});
    expect(issues).toHaveLength(1);
    expect(issues[0].keyword).toBe('required');
    expect(issues[0].params).toEqual({ missingProperty: 'a' });
  });

  test('nested additionalProperties:false reports the parent path', () => {
    const schema = schemaOf('2020-12', {
      type: 'object',
      properties: { o: { type: 'object', additionalProperties: false } },
    });
    const issues = engine.validate(schema, { o: { extra: 1 } });
    expect(issues).toHaveLength(1);
    expect(issues[0].keyword).toBe('additionalProperties');
    expect(issues[0].instancePath).toBe('/o');
    expect(issues[0].params).toEqual({ additionalProperty: 'extra' });
  });

  test('keys with / and ~ are RFC 6901 escaped in the parent path and the key is intact', () => {
    const schema = schemaOf('2020-12', {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { 'x~y': { type: 'object', additionalProperties: false } },
      },
    });
    const slash = engine.validate(
      schemaOf('2020-12', {
        type: 'object',
        properties: { o: { type: 'object', properties: { 'a/b': { type: 'object', additionalProperties: false } } } },
      }),
      { o: { 'a/b': { extra: 1 } } }
    );
    expect(slash[0].instancePath).toBe('/o/a~1b');
    expect(slash[0].params.additionalProperty).toBe('extra');

    const tilde = engine.validate(schema, { q: { 'x~y': { extra: 1 } } });
    expect(tilde[0].instancePath).toBe('/q/x~0y');
    expect(tilde[0].params.additionalProperty).toBe('extra');

    const weirdKey = engine.validate(
      schemaOf('2020-12', { type: 'object', additionalProperties: false, properties: { a: {} } }),
      { 'a/b': 1, 'x~y': 2 }
    );
    expect(weirdKey.map((i) => i.params.additionalProperty).sort()).toEqual(['a/b', 'x~y']);
    expect(weirdKey.every((i) => i.instancePath === '/')).toBe(true);
  });

  test('additionalProperties:false with patternProperties reports the unmatched key', () => {
    const schema = schemaOf('2020-12', {
      type: 'object',
      patternProperties: { '^a': { type: 'string' } },
      additionalProperties: false,
    });
    const issues = engine.validate(schema, { abc: 'ok', zzz: 1 });
    expect(issues).toHaveLength(1);
    expect(issues[0].keyword).toBe('additionalProperties');
    expect(issues[0].params).toEqual({ additionalProperty: 'zzz' });
    expect(issues[0].instancePath).toBe('/');
  });

  test('unevaluatedProperties reports the parent and the property', () => {
    const schema = schemaOf('2020-12', {
      type: 'object',
      properties: { a: { type: 'string' } },
      unevaluatedProperties: false,
    });
    const issues = engine.validate(schema, { a: 'x', top: 1 });
    expect(issues).toHaveLength(1);
    expect(issues[0].keyword).toBe('unevaluatedProperties');
    expect(issues[0].instancePath).toBe('/');
    expect(issues[0].params).toEqual({ unevaluatedProperty: 'top' });
  });

  test('params never carry pointer, schema or value', () => {
    const issues = engine.validate(schemaOf('2020-12', { enum: ['a', 'b'] }), 'c');
    expect(issues[0].keyword).toBe('enum');
    expect(issues[0].params).toEqual({ allowedValues: ['a', 'b'] });
    for (const key of ['pointer', 'schema', 'value']) expect(issues[0].params).not.toHaveProperty(key);
  });

  test('a valid instance yields no issues', () => {
    expect(engine.validate(schemaOf('2020-12', { type: 'string' }), 'ok')).toEqual([]);
  });
});

describe('params stay plain data', () => {
  const engine = makeEngine();
  test('oneOf with several matches reports branch indexes only', () => {
    const issues = engine.validate(schemaOf('2020-12', { oneOf: [{ type: 'number' }, { minimum: 0 }] }), 3);
    expect(issues).toHaveLength(1);
    expect(issues[0].params).toEqual({ passingSchemas: [0, 1] });
    expect(() => JSON.stringify(issues)).not.toThrow();
  });
  test('uniqueItems reports numeric indexes', () => {
    const issues = engine.validate(schemaOf('2020-12', { uniqueItems: true }), [1, 2, 1]);
    expect(issues[0].params).toEqual({ i: 2, j: 0 });
  });
});

describe('_id blacklist neutralization (library deviation)', () => {
  const engine = makeEngine();
  for (const dialect of DIALECT_NAMES) {
    describe(dialect, () => {
      test('top level closed schema rejects _id', () => {
        const schema = schemaOf(dialect, {
          type: 'object',
          properties: { id: { type: 'string' } },
          additionalProperties: false,
        });
        const issues = engine.validate(schema, { id: 'x', _id: 'y' });
        expect(issues).toHaveLength(1);
        expect(issues[0].params).toEqual({ additionalProperty: '_id' });
      });
      test('nested closed schema rejects _id', () => {
        const schema = schemaOf(dialect, {
          type: 'object',
          properties: { o: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false } },
        });
        const issues = engine.validate(schema, { o: { id: 'x', _id: 'y' } });
        expect(issues).toHaveLength(1);
        expect(issues[0].instancePath).toBe('/o');
      });
      test('closed schema with patternProperties rejects _id', () => {
        const schema = schemaOf(dialect, {
          type: 'object',
          properties: { id: { type: 'string' } },
          patternProperties: { '^x_': { type: 'string' } },
          additionalProperties: false,
        });
        const issues = engine.validate(schema, { id: 'x', _id: 'y' });
        expect(issues).toHaveLength(1);
        expect(issues[0].params).toEqual({ additionalProperty: '_id' });
      });
      test('schema-valued additionalProperties still validates _id', () => {
        const schema = schemaOf(dialect, { type: 'object', additionalProperties: { type: 'string' } });
        expect(engine.validate(schema, { _id: 5 })).toHaveLength(1);
      });
    });
  }

  test('library-global settings are not mutated', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { settings } = require('json-schema-library');
    makeEngine().validate(schemaOf('2020-12', { type: 'object', additionalProperties: false }), { _id: 1 });
    expect(settings.propertyBlacklist).toEqual(['_id']);
  });
});

describe('x-gts-ref keyword', () => {
  const engine = makeEngine();
  const ref = (pattern: string) => schemaOf('2020-12', { type: 'string', 'x-gts-ref': pattern });
  const idA = 'gts.acme.core.events.a.v1~';
  const idB = 'gts.acme.core.events.b.v1~';

  test('passes and fails on pattern', () => {
    expect(engine.validate(ref('gts.acme.core.events.*'), idA)).toEqual([]);
    const issues = engine.validate(ref(idA), idB);
    expect(issues).toHaveLength(1);
    expect(issues[0].keyword).toBe('x-gts-ref');
    expect(issues[0].message).toContain('does not match pattern');
    expect(issues[0].params).toEqual({ pattern: idA });
  });

  test('non-string data is ignored', () => {
    expect(engine.validate(ref(idA), 5)).toEqual([expect.objectContaining({ keyword: 'type' })]);
  });

  test('works inside oneOf / anyOf / not', () => {
    const oneOf = schemaOf('2020-12', {
      oneOf: [
        { type: 'string', 'x-gts-ref': idA },
        { type: 'string', 'x-gts-ref': idB },
      ],
    });
    expect(engine.validate(oneOf, idA)).toEqual([]);
    expect(engine.validate(oneOf, idB)).toEqual([]);
    expect(engine.validate(oneOf, 'gts.acme.core.events.c.v1~').length).toBeGreaterThan(0);

    const anyOf = schemaOf('2019-09', { anyOf: [{ 'x-gts-ref': idA }, { 'x-gts-ref': idB }] });
    expect(engine.validate(anyOf, idB)).toEqual([]);
    expect(engine.validate(anyOf, 'gts.acme.core.events.c.v1~').length).toBeGreaterThan(0);

    const not = schemaOf('draft-07' as never, { not: { 'x-gts-ref': idA } });
    (not as Record<string, unknown>).$schema = DIALECTS['draft-07'];
    expect(engine.validate(not, idA).length).toBeGreaterThan(0);
    expect(engine.validate(not, idB)).toEqual([]);
  });

  test('/$id resolves through getSelectedTypeId on every call', () => {
    const schema = ref('/$id');
    selected = undefined;
    expect(engine.validate(schema, idB)).toEqual([]);
    selected = idA;
    expect(engine.validate(schema, idA)).toEqual([]);
    expect(engine.validate(schema, idB)).toHaveLength(1);
    selected = idB;
    expect(engine.validate(schema, idB)).toEqual([]);
  });

  test('works in every dialect', () => {
    for (const dialect of DIALECT_NAMES) {
      const schema = schemaOf(dialect, { type: 'string', 'x-gts-ref': idA });
      expect(engine.validate(schema, idA)).toEqual([]);
      expect(engine.validate(schema, idB)).toHaveLength(1);
    }
  });
});

describe('re2js regex overrides', () => {
  const engine = makeEngine();
  for (const dialect of DIALECT_NAMES) {
    test(`pattern and patternProperties match via re2js (${dialect})`, () => {
      const p = schemaOf(dialect, { type: 'string', pattern: '^[a-z]+$' });
      expect(engine.validate(p, 'abc')).toEqual([]);
      const bad = engine.validate(p, 'ABC');
      expect(bad[0].keyword).toBe('pattern');
      expect(bad[0].params).toEqual({ pattern: '^[a-z]+$' });

      const pp = schemaOf(dialect, { type: 'object', patternProperties: { '^n_': { type: 'number' } } });
      expect(engine.validate(pp, { n_a: 1 })).toEqual([]);
      expect(engine.validate(pp, { n_a: 'x' })).toHaveLength(1);
    });
  }

  test('propertyNames with pattern uses re2js', () => {
    const schema = schemaOf('2020-12', { type: 'object', propertyNames: { pattern: '^[a-z]+$' } });
    expect(engine.validate(schema, { abc: 1 })).toEqual([]);
    expect(engine.validate(schema, { ABC: 1 }).length).toBeGreaterThan(0);
  });

  test('format: regex checks the GTS profile', () => {
    const schema = schemaOf('2020-12', { type: 'string', format: 'regex' });
    expect(engine.validate(schema, '^[a-z]+$')).toEqual([]);
    expect(engine.validate(schema, '(?=a)b').length).toBeGreaterThan(0);
  });

  test('out-of-profile pattern is rejected with RegexCompilationError wording', () => {
    const schema = schemaOf('2020-12', { type: 'string', pattern: '(?=a)b' });
    const errors = engine.validateSchemaDocument(schema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('Unsupported regular expression');
    expect(() => engine.compile(schema)).toThrow(RegexCompilationError);
  });

  test('out-of-profile patternProperties key is rejected', () => {
    const schema = schemaOf('2020-12', { type: 'object', patternProperties: { '(?=a)b': {} } });
    expect(engine.validateSchemaDocument(schema).length).toBeGreaterThan(0);
  });
});

describe('GTS date-time / time formats', () => {
  const engine = makeEngine();
  const dt = schemaOf('2020-12', { type: 'string', format: 'date-time' });
  const tm = schemaOf('2020-12', { type: 'string', format: 'time' });

  test('offsets are mandatory', () => {
    expect(engine.validate(dt, '2008-10-12T10:30:00Z')).toEqual([]);
    expect(engine.validate(dt, '2008-10-12T10:30:00+02:00')).toEqual([]);
    expect(engine.validate(dt, '2008-10-12T10:30:00')).toHaveLength(1);
    expect(engine.validate(dt, '2008-10-12 10:30:00Z')).toHaveLength(1);
    expect(engine.validate(tm, '10:30:00Z')).toEqual([]);
    expect(engine.validate(tm, '10:30:00')).toHaveLength(1);
    expect(engine.validate(tm, '10:30:00+25:00')).toHaveLength(1);
  });

  test('issue keyword is format with the format param', () => {
    const issues = engine.validate(dt, 'nope');
    expect(issues[0].keyword).toBe('format');
    expect(issues[0].params).toEqual({ format: 'date-time' });
  });

  test('library formats still apply', () => {
    const email = schemaOf('2020-12', { type: 'string', format: 'email' });
    expect(engine.validate(email, 'a@b.co')).toEqual([]);
    expect(engine.validate(email, 'nope')).toHaveLength(1);
  });
});

describe('remote $ref pool', () => {
  test('chained gts:// remotes with #/$defs fragment', () => {
    for (const dialect of DIALECT_NAMES) {
      const engine = makeEngine();
      const defs = dialect === 'draft-07' ? 'definitions' : '$defs';
      engine.addEngineSchema(
        schemaOf(dialect, { $id: 'gts://gts.acme.core.base.v1~', [defs]: { name: { type: 'string' } } }),
        'gts.acme.core.base.v1~'
      );
      engine.addEngineSchema(
        schemaOf(dialect, {
          $id: 'gts://gts.acme.core.mid.v1~',
          type: 'object',
          properties: { n: { $ref: `gts://gts.acme.core.base.v1~#/${defs}/name` } },
        }),
        'gts.acme.core.mid.v1~'
      );
      const root = schemaOf(dialect, {
        $id: 'gts://gts.acme.core.top.v1~',
        allOf: [{ $ref: 'gts://gts.acme.core.mid.v1~' }],
      });
      expect(engine.validate(root, { n: 'x' })).toEqual([]);
      const bad = engine.validate(root, { n: 5 });
      expect(bad).toHaveLength(1);
      expect(bad[0].keyword).toBe('type');
      expect(bad[0].instancePath).toBe('/n');
    }
  });

  test('removeEngineSchema and refreshEngineForKey update the pool', () => {
    const engine = makeEngine();
    const target = schemaOf('2020-12', { $id: 'gts://gts.acme.core.t.v1~', type: 'string' });
    const root = schemaOf('2020-12', { $ref: 'gts://gts.acme.core.t.v1~' });
    engine.addEngineSchema(target, 'gts.acme.core.t.v1~');
    expect(engine.validate(root, 5)).toHaveLength(1);
    engine.refreshEngineForKey(
      'gts.acme.core.t.v1~',
      schemaOf('2020-12', { $id: 'gts://gts.acme.core.t.v1~', type: 'number' })
    );
    expect(engine.validate(root, 5)).toEqual([]);
    engine.removeEngineSchema('gts.acme.core.t.v1~');
    expect(() => engine.compile(root)).toThrow();
    engine.refreshEngineForKey('gts.acme.core.t.v1~', undefined);
  });

  test('does not mutate the schemas it is given', () => {
    const engine = makeEngine();
    const target = schemaOf('2020-12', { $id: 'gts://gts.acme.core.t.v1~', type: 'string' });
    const copy = JSON.parse(JSON.stringify(target));
    engine.addEngineSchema(target, 'gts.acme.core.t.v1~');
    engine.validate(schemaOf('2020-12', { $ref: 'gts://gts.acme.core.t.v1~' }), 'x');
    expect(target).toEqual(copy);
  });

  test('unresolved $ref throws a raw error at compile time', () => {
    const engine = makeEngine();
    const schema = schemaOf('2020-12', { $ref: 'gts://gts.acme.core.missing.v1~' });
    let message = '';
    try {
      engine.compile(schema);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message.startsWith('JSON Schema validation failed:')).toBe(false);
  });

  test('an unresolved $ref inside a reached remote also throws at compile time', () => {
    const engine = makeEngine();
    engine.addEngineSchema(
      schemaOf('2020-12', { $id: 'gts://gts.acme.core.broken.v1~', $ref: 'gts://gts.acme.core.nowhere.v1~' }),
      'gts.acme.core.broken.v1~'
    );
    expect(() => engine.compile(schemaOf('2020-12', { $ref: 'gts://gts.acme.core.broken.v1~' }))).toThrow(
      /Invalid \$ref/
    );
    // an unrelated schema is not affected by the broken pool entry
    expect(engine.validate(schemaOf('2020-12', { type: 'string' }), 'x')).toEqual([]);
  });

  test('two engines do not share remote schemas', () => {
    const a = makeEngine();
    const b = makeEngine();
    a.addEngineSchema(
      schemaOf('2020-12', { $id: 'gts://gts.acme.core.only.v1~', type: 'string' }),
      'gts.acme.core.only.v1~'
    );
    const root = schemaOf('2020-12', { $ref: 'gts://gts.acme.core.only.v1~' });
    expect(a.validate(root, 'x')).toEqual([]);
    expect(() => b.compile(root)).toThrow();
  });
});

describe('validateSchemaDocument', () => {
  const engine = makeEngine();
  test('reports schemaErrors for an invalid schema', () => {
    const issues = engine.validateSchemaDocument(schemaOf('2020-12', { type: 'object', properties: 5 }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].keyword).toBe('schema');
  });
  test('returns nothing for a valid schema in every dialect', () => {
    for (const dialect of DIALECT_NAMES) {
      expect(engine.validateSchemaDocument(schemaOf(dialect, { type: 'string' }))).toEqual([]);
    }
  });
  test('an unsupported dialect throws', () => {
    expect(() => engine.compile({ $schema: 'http://example.com/x', type: 'string' })).toThrow(/dialect/);
  });
});

describe('issue code table', () => {
  const drafts = buildEngineDrafts(() => selected);
  const runtimeCodes = (dialect: keyof typeof DIALECTS): string[] => Object.keys(drafts[dialect].errors);

  test.each(DIALECT_NAMES)('has a row for every runtime error code of the %s draft', (dialect) => {
    const codes = runtimeCodes(dialect);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.filter((code) => !(code in ISSUE_CODE_TABLE))).toEqual([]);
  });

  test('has no stale row: every row names a code of some runtime errors map', () => {
    const known = new Set(DIALECT_NAMES.flatMap(runtimeCodes));
    expect(Object.keys(ISSUE_CODE_TABLE).filter((code) => !known.has(code))).toEqual([]);
    expect(ISSUE_CODE_TABLE['x-gts-ref']).toBeDefined();
  });

  test('an unmapped code fails', () => {
    expect(() =>
      adaptLibraryError({ type: 'error', code: 'made-up-error', message: 'x', data: { pointer: '#/a' } } as never)
    ).toThrow(/unmapped/i);
  });

  test('every table row has the required fields', () => {
    for (const [code, row] of Object.entries(ISSUE_CODE_TABLE)) {
      expect(['string', 'function']).toContain(typeof row.keyword);
      expect(['pointer', 'parent']).toContain(row.path);
      expect(typeof row.params).toBe('object');
      expect(code.length).toBeGreaterThan(0);
    }
  });
});

interface Probe {
  code: string;
  label?: string;
  dialects?: (keyof typeof DIALECTS)[];
  schema: Record<string, unknown>;
  data: unknown;
  instancePath?: string;
  /** Expected `schemaPath` (as Ajv 8 reports it); `schemaPaths` when it differs per dialect. */
  schemaPath?: string;
  schemaPaths?: Partial<Record<keyof typeof DIALECTS, string>>;
  omitParams?: string[];
}
const probes: Probe[] = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'adapter-probes.json'), 'utf8'));

/** Codes no schema can make the library emit as a validation issue (verified against 11.6.14), with the reason. */
const NOT_PROBED: Record<string, string> = {
  'additional-properties-error': 'never emitted by any keyword (only no-additional-properties-error is)',
  'contains-any-error': 'never emitted',
  'contains-array-error': 'never emitted',
  'contains-error': 'unreachable: a plain miss is contains-min-error (minContains defaults to 1)',
  'forbidden-property-error': 'never emitted',
  'format-idn-hostname-error': 'only emitted by formats the draft does not enable by default',
  'format-ipv4-leading-zero-error': 'only emitted by formats the draft does not enable by default',
  'format-ipv6-leading-zero-error': 'only emitted by formats the draft does not enable by default',
  'format-iri-error': 'only emitted by formats the draft does not enable by default',
  'format-iri-reference-error': 'only emitted by formats the draft does not enable by default',
  'min-items-one-error': 'draftEditor only',
  'min-length-one-error': 'draftEditor only',
  'missing-array-item-error': 'never emitted',
  'missing-one-of-declarator-error': 'oneOfProperty declarator error with a schema-style pointer',
  'missing-one-of-property-error': 'oneOfProperty declarator error',
  'one-of-property-error': 'oneOfProperty declarator error',
  'pattern-properties-error': 'never emitted (patternProperties emits no-additional-properties-error)',
  'ref-error': 'an unresolved $ref throws at compile time (throwOnInvalidRef)',
  'undefined-value-error': 'never emitted',
  'unknown-property-error': 'never emitted',
  'value-not-empty-error': 'never emitted',
  'all-of-error': 'never emitted: an allOf failure surfaces as the inner errors (probed as type-error inside allOf)',
  'schema-error': 'covered by the validateSchemaDocument test below, not a validation probe',
  'schema-warning': 'annotation, never an issue',
  'deprecated-warning': 'annotation, never an issue',
  'unknown-keyword-warning': 'annotation, never an issue',
  'unknown-format-warning': 'annotation, never an issue',
};

describe('issue adapter probes: every code against real library error data', () => {
  const dialectsOf = (probe: Probe) => probe.dialects ?? DIALECT_NAMES;
  const run = (probe: Probe, dialect: keyof typeof DIALECTS) => {
    const draft = buildEngineDrafts(() => selected)[dialect];
    const root = compileSchema(schemaOf(dialect, probe.schema), { drafts: [draft] });
    const errors = root.validate(probe.data).errors;
    const raw = errors.find((error) => error.code === probe.code);
    return { errors, raw };
  };
  const cases = probes.flatMap((probe) =>
    dialectsOf(probe).map((dialect) => ({
      name: `${probe.code}${probe.label ? ` (${probe.label})` : ''} [${dialect}]`,
      probe,
      dialect,
    }))
  );

  test('every table code is probed or listed as not probed, never both', () => {
    const probed = new Set(probes.map((probe) => probe.code));
    const rows = Object.keys(ISSUE_CODE_TABLE);
    expect(rows.filter((code) => !probed.has(code) && !(code in NOT_PROBED))).toEqual([]);
    expect(rows.filter((code) => probed.has(code) && code in NOT_PROBED)).toEqual([]);
    expect(Object.keys(NOT_PROBED).filter((code) => !(code in ISSUE_CODE_TABLE))).toEqual([]);
  });

  test.each(cases)('$name: produces its code; params keys and instancePath match the table', ({ probe, dialect }) => {
    selected = 'gts.acme.core.events.a.v1~';
    const { raw } = run(probe, dialect);
    expect(raw).toBeDefined();
    const row = ISSUE_CODE_TABLE[probe.code];
    const issue = adaptLibraryError(raw!);
    const expectedKeys = Object.keys(row.params).filter((key) => !(probe.omitParams ?? []).includes(key));
    expect(Object.keys(issue.params).sort()).toEqual(expectedKeys.sort());
    expect(issue.instancePath).toBe(probe.instancePath ?? '/');
    expect(issue.instancePath.startsWith('#')).toBe(false);
    expect(typeof issue.keyword).toBe('string');
    expect(issue.schemaPath).toBe(probe.schemaPaths?.[dialect] ?? probe.schemaPath);
  });

  test('schema-error (validateSchemaDocument) maps to keyword schema with the library message and a pointer path', () => {
    const engine = makeEngine();
    const issues = engine.validateSchemaDocument(schemaOf('2020-12', { properties: { a: { minLength: 'x' } } }));
    expect(issues).toHaveLength(1);
    expect(issues[0].keyword).toBe('schema');
    expect(issues[0].instancePath).toBe('/properties/a/minLength');
    expect(issues[0].message).toContain("Keyword 'minLength' must be a number");
    expect(issues[0].params).toEqual({});
  });

  test('draft-07 dependencies reports keyword dependencies; 2019-09+ reports dependentRequired', () => {
    const engine = makeEngine();
    const data = { a: 1 };
    const d7 = engine.validate(schemaOf('draft-07', { dependencies: { a: ['b'] } }), data);
    const d19 = engine.validate(schemaOf('2019-09', { dependentRequired: { a: ['b'] } }), data);
    expect(d7.map((i) => i.keyword)).toEqual(['dependencies']);
    expect(d19.map((i) => i.keyword)).toEqual(['dependentRequired']);
    expect(d7[0].params).toEqual({ missingProperty: 'b' });
  });

  test('a type list stays an array in params.type (as Ajv reports it)', () => {
    const issues = makeEngine().validate(schemaOf('2020-12', { type: ['string', 'number'] }), true);
    expect(issues[0].params).toEqual({ type: ['string', 'number'] });
  });
});

describe('instancePath adapter feeds source locations (attachSourceLocations)', () => {
  const engine = makeEngine();
  const spanText = (text: string, span: SourceSpan | undefined): string =>
    span === undefined ? '' : text.slice(span.offset, span.offset + span.length);
  /** Text of the key span, else of the value span, of the first issue. */
  const located = (format: 'json' | 'yaml', text: string, schema: Record<string, unknown>, data: unknown) => {
    const issues = attachSourceLocations(format, text, 0, engine.validate(schemaOf('2020-12', schema), data));
    expect(issues).toHaveLength(1);
    const source = issues[0].source;
    expect(source).toBeDefined();
    return { issue: issues[0], text: spanText(text, source?.key ?? source?.value) };
  };

  const nested = {
    type: 'object',
    properties: { o: { type: 'object', additionalProperties: false } },
  };

  test('nested additionalProperties:false: parent path, offending key span (JSON)', () => {
    const text = '{"o":{"extra":1}}';
    const { issue, text: span } = located('json', text, nested, JSON.parse(text));
    expect(issue.instancePath).toBe('/o');
    expect(issue.params.additionalProperty).toBe('extra');
    expect(span).toBe('"extra"');
    expect(issue.source?.key?.offset).toBe(text.indexOf('"extra"'));
  });

  test('nested additionalProperties:false: parent path, offending key span (YAML)', () => {
    const text = 'o:\n  extra: 1\n';
    const { issue, text: span } = located('yaml', text, nested, { o: { extra: 1 } });
    expect(issue.instancePath).toBe('/o');
    expect(issue.params.additionalProperty).toBe('extra');
    expect(span).toBe('extra');
    expect(issue.source?.key?.offset).toBe(text.indexOf('extra'));
  });

  test.each([
    ['a/b', '/a~1b'],
    ['x~y', '/x~0y'],
  ])('parent key %s is escaped and still locates the nested extra key', (parentKey, path) => {
    const schema = { type: 'object', properties: { [parentKey]: { type: 'object', additionalProperties: false } } };
    const jsonText = JSON.stringify({ [parentKey]: { extra: 1 } });
    const json = located('json', jsonText, schema, JSON.parse(jsonText));
    expect(json.issue.instancePath).toBe(path);
    expect(json.issue.params.additionalProperty).toBe('extra');
    expect(json.text).toBe('"extra"');
    expect(json.issue.source?.key?.offset).toBe(jsonText.indexOf('"extra"'));

    const yamlText = `"${parentKey}":\n  extra: 1\n`;
    const yaml = located('yaml', yamlText, schema, { [parentKey]: { extra: 1 } });
    expect(yaml.issue.instancePath).toBe(path);
    expect(yaml.text).toBe('extra');
    expect(yaml.issue.source?.key?.offset).toBe(yamlText.indexOf('extra'));
  });

  test.each(['a/b', 'x~y'])('an extra key named %s is reported intact and located', (extraKey) => {
    const jsonText = JSON.stringify({ o: { [extraKey]: 1 } });
    const json = located('json', jsonText, nested, JSON.parse(jsonText));
    expect(json.issue.instancePath).toBe('/o');
    expect(json.issue.params.additionalProperty).toBe(extraKey);
    expect(json.text).toBe(JSON.stringify(extraKey));

    const yamlText = `o:\n  "${extraKey}": 1\n`;
    const yaml = located('yaml', yamlText, nested, { o: { [extraKey]: 1 } });
    expect(yaml.issue.params.additionalProperty).toBe(extraKey);
    expect(yaml.text).toBe(`"${extraKey}"`);
  });

  test('additionalProperties:false with patternProperties: the unmatched key is reported and located', () => {
    const schema = {
      type: 'object',
      properties: {
        o: { type: 'object', patternProperties: { '^a': { type: 'string' } }, additionalProperties: false },
      },
    };
    const jsonText = '{"o":{"abc":"ok","zzz":1}}';
    const json = located('json', jsonText, schema, JSON.parse(jsonText));
    expect(json.issue.instancePath).toBe('/o');
    expect(json.issue.params.additionalProperty).toBe('zzz');
    expect(json.text).toBe('"zzz"');

    const yamlText = 'o:\n  abc: ok\n  zzz: 1\n';
    const yaml = located('yaml', yamlText, schema, { o: { abc: 'ok', zzz: 1 } });
    expect(yaml.issue.params.additionalProperty).toBe('zzz');
    expect(yaml.text).toBe('zzz');
  });
});
