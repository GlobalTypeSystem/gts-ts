import { adaptLibraryError, createSchemaEngine, type SchemaEngine } from '../src/schema-engine';
import { isValidDateTime, isValidRegex, isValidTimePart } from '../src/gts-format-checkers';

const DIALECTS = {
  'draft-07': 'http://json-schema.org/draft-07/schema#',
  '2019-09': 'https://json-schema.org/draft/2019-09/schema',
  '2020-12': 'https://json-schema.org/draft/2020-12/schema',
} as const;
type Dialect = keyof typeof DIALECTS;
const DIALECT_NAMES = Object.keys(DIALECTS) as Dialect[];
const OPEN_DIALECTS = DIALECT_NAMES.filter((dialect) => dialect !== 'draft-07');

let engine: SchemaEngine;
beforeEach(() => {
  engine = createSchemaEngine({ getSelectedTypeId: () => 'gts.acme.core.events.a.v1~' });
});
const schemaOf = (dialect: Dialect, body: Record<string, unknown>) => ({ $schema: DIALECTS[dialect], ...body });

// ---------------------------------------------------------------------------
// F1: names of Object.prototype members are never "declared" properties
// ---------------------------------------------------------------------------

describe('F1: closed schemas and Object.prototype member names', () => {
  const KEYS = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
  /** JSON.parse creates `__proto__` as an own data property, as a request body would. */
  const dataOf = (keys: string[]) => JSON.parse(`{${keys.map((key) => `${JSON.stringify(key)}:1`).join(',')}}`);

  const closed = (withPatterns: boolean) => ({
    type: 'object',
    properties: { a: {} },
    ...(withPatterns ? { patternProperties: { '^x-': {} } } : {}),
    additionalProperties: false,
  });

  test.each(DIALECT_NAMES.flatMap((dialect) => [true, false].map((withPatterns) => [dialect, withPatterns] as const)))(
    '[%s] additionalProperties:false (patternProperties: %s) rejects every prototype-named key',
    (dialect, withPatterns) => {
      const issues = engine.validate(schemaOf(dialect, closed(withPatterns)), dataOf(KEYS));
      expect(issues.map((issue) => issue.keyword)).toEqual(KEYS.map(() => 'additionalProperties'));
      expect(issues.map((issue) => issue.params.additionalProperty).sort()).toEqual([...KEYS].sort());
      expect(issues.every((issue) => issue.instancePath === '/')).toBe(true);
    }
  );

  test.each(DIALECT_NAMES)('[%s] declared and pattern-matched keys of a closed schema still pass', (dialect) => {
    const schema = schemaOf(dialect, closed(true));
    expect(engine.validate(schema, { a: 1, 'x-y': 2 })).toEqual([]);
    expect(engine.validate(schemaOf(dialect, closed(false)), { a: 1 })).toEqual([]);
  });

  test.each(DIALECT_NAMES)('[%s] additionalProperties:<schema> validates prototype-named keys', (dialect) => {
    const schema = schemaOf(dialect, {
      type: 'object',
      properties: { a: {} },
      patternProperties: { '^x-': {} },
      additionalProperties: { type: 'string' },
    });
    const issues = engine.validate(schema, dataOf(KEYS));
    expect(issues.map((issue) => issue.keyword)).toEqual(KEYS.map(() => 'type'));
    expect(issues.map((issue) => issue.instancePath).sort()).toEqual(KEYS.map((key) => `/${key}`).sort());
  });

  test.each(DIALECT_NAMES)('[%s] properties declared with prototype names are validated', (dialect) => {
    const schema = schemaOf(dialect, {
      type: 'object',
      properties: { constructor: { type: 'string' }, toString: { type: 'string' } },
      additionalProperties: false,
    });
    expect(engine.validate(schema, { constructor: 'a', toString: 'b' })).toEqual([]);
    const issues = engine.validate(schema, { constructor: 1, hasOwnProperty: 'x' });
    expect(issues.map((issue) => [issue.keyword, issue.instancePath])).toEqual([
      ['type', '/constructor'],
      ['additionalProperties', '/'],
    ]);
  });

  test.each(DIALECT_NAMES)('[%s] patternProperties children validate prototype-named keys that match', (dialect) => {
    const schema = schemaOf(dialect, { type: 'object', patternProperties: { '^c': { type: 'string' } } });
    const issues = engine.validate(schema, dataOf(['constructor']));
    expect(issues.map((issue) => [issue.keyword, issue.instancePath])).toEqual([['type', '/constructor']]);
  });

  test.each(OPEN_DIALECTS)('[%s] unevaluatedProperties does not treat prototype names as evaluated', (dialect) => {
    const schema = schemaOf(dialect, {
      type: 'object',
      properties: { a: {} },
      unevaluatedProperties: false,
    });
    const issues = engine.validate(schema, dataOf(KEYS));
    expect(issues.map((issue) => issue.keyword)).toEqual(KEYS.map(() => 'unevaluatedProperties'));
    expect(issues.map((issue) => issue.params.unevaluatedProperty).sort()).toEqual([...KEYS].sort());
  });

  test.each(OPEN_DIALECTS)('[%s] unevaluatedProperties with patternProperties and prototype names', (dialect) => {
    const schema = schemaOf(dialect, {
      type: 'object',
      patternProperties: { '^x-': {} },
      unevaluatedProperties: false,
    });
    const issues = engine.validate(schema, { ...dataOf(KEYS), 'x-ok': 1 });
    expect(issues.map((issue) => issue.params.unevaluatedProperty).sort()).toEqual([...KEYS].sort());
  });
});

// ---------------------------------------------------------------------------
// F3: format assertions of the former ajv-formats 3.0.1 `full` mode
// ---------------------------------------------------------------------------

/**
 * Accept/reject samples recorded from ajv-formats 3.0.1 (`full` mode). `date-time`, `time` and
 * `regex` are GTS overrides (ADR-0005) and are listed separately below.
 */
const LONG_LOCAL_PART = `${'a'.repeat(65)}@example.com`;
const AJV_FORMAT_SAMPLES: Record<string, { valid: unknown[]; invalid: unknown[] }> = {
  date: {
    valid: ['2020-02-29', '2021-12-31'],
    invalid: ['', '2021-02-29', '2021-13-01', '2021-1-01', 'nope', '2021-01-01T00:00:00Z'],
  },
  'iso-time': {
    valid: ['10:00:00', '10:00:00Z', '10:00:00.5+01:00', '10:00:00+0100', '23:59:60Z'],
    invalid: ['', '25:00:00', '10:00', '10:00:00+24:00', '23:59:60+05:00'],
  },
  'iso-date-time': {
    valid: ['2020-01-01T10:00:00', '2020-01-01 10:00:00Z', '2020-01-01t10:00:00+01:00'],
    invalid: ['', '2020-01-01', '2020-01-01T25:00:00', '2020-01-01T10:00:00T'],
  },
  duration: { valid: ['P1Y2M3DT4H5M6S', 'P1W', 'PT1S', 'P1D'], invalid: ['', 'P', 'P1W1D', 'PT', 'P1YT'] },
  uri: { valid: ['http://a.b', 'urn:isbn:0451450523', 'mailto:a@b.c'], invalid: ['', 'a', '//x', 'http://a b'] },
  'uri-reference': { valid: ['', '/a/b', '#frag', 'http://x', 'a/b?c'], invalid: ['http://a b', '\\x'] },
  'uri-template': { valid: ['', 'http://x/{id}', '{+path}/here{?x,y}'], invalid: ['{', 'a b', '{a b}'] },
  url: {
    valid: ['http://example.com', 'ftp://foo.bar/x'],
    invalid: ['https://a.b/c?d', '', 'example.com', 'http://localhost', 'http://10.0.0.1', 'mailto:a@b.c'],
  },
  email: {
    valid: ['a@b.co', 'first.last@example.com', LONG_LOCAL_PART],
    invalid: ['', 'a@b', '"quoted"@x.com', 'a@[127.0.0.1]', '@x.com', 'a@@b.com'],
  },
  hostname: { valid: ['example.com', 'a', 'a-b.c.'], invalid: ['', '-a.com', 'a..b', 'a b'] },
  ipv4: { valid: ['127.0.0.1'], invalid: ['', '256.1.1.1', '01.1.1.1', '1.1.1'] },
  ipv6: { valid: ['::1', '2001:db8::1'], invalid: ['', '1::2::3', ':::'] },
  uuid: {
    valid: ['123e4567-e89b-12d3-a456-426614174000', 'urn:uuid:123e4567-e89b-12d3-a456-426614174000'],
    invalid: ['', '123e4567e89b12d3a456426614174000'],
  },
  'json-pointer': { valid: ['', '/a/b', '/a~0~1'], invalid: ['#/a', 'a', '/a~2'] },
  'json-pointer-uri-fragment': { valid: ['#', '#/a/b%20c'], invalid: ['', '/a', '#a'] },
  'relative-json-pointer': { valid: ['0', '1/a', '2#'], invalid: ['', '-1', '/a', '01'] },
  byte: { valid: ['', 'dGVzdA==', 'YWJj'], invalid: ['abc', '@@@@', 'dGVzdA='] },
  password: { valid: ['', 'anything'], invalid: [] },
  binary: { valid: ['', 'anything'], invalid: [] },
  // number formats apply to numbers only; every other instance type is ignored
  int32: { valid: [0, -2147483648, 2147483647, 'not a number', null], invalid: [2147483648, 1.5, -2147483649] },
  int64: { valid: [0, 9007199254740991, 'not a number'], invalid: [1.5] },
  float: { valid: [1.5, 0, 'not a number'], invalid: [] },
  double: { valid: [1e300, 'not a number'], invalid: [] },
};

/** GTS overrides (ADR-0005): the offset is mandatory, `regex` follows the GTS regex profile. */
const GTS_FORMAT_SAMPLES: Record<string, { valid: string[]; invalid: string[] }> = {
  'date-time': {
    valid: ['2020-01-01T10:00:00Z', '2020-01-01T10:00:00.5+01:00'],
    invalid: ['', '2020-01-01T10:00:00', '2020-01-01 10:00:00Z', '2020-02-30T10:00:00Z'],
  },
  time: { valid: ['10:00:00Z', '10:00:00+01:00'], invalid: ['', '10:00:00', '25:00:00Z'] },
  regex: { valid: ['^a+$', '[a-z]{2,3}'], invalid: ['(?<=a)b', '\\1(a)'] },
};

describe('F3: format assertions match the former ajv-formats full mode', () => {
  const cases = DIALECT_NAMES.flatMap((dialect) =>
    [...Object.entries(AJV_FORMAT_SAMPLES), ...Object.entries(GTS_FORMAT_SAMPLES)].map(
      ([format, samples]) => [dialect, format, samples] as const
    )
  );

  test.each(cases)('[%s] format %s accepts and rejects the recorded samples', (dialect, format, samples) => {
    const schema = schemaOf(dialect, { format });
    for (const value of samples.valid) {
      expect({ value, issues: engine.validate(schema, value) }).toEqual({ value, issues: [] });
    }
    for (const value of samples.invalid) {
      const issues = engine.validate(schema, value);
      expect({ value, count: issues.length }).toEqual({ value, count: 1 });
      expect(issues[0].keyword).toBe('format');
      expect(issues[0].params).toEqual({ format });
      expect(issues[0].instancePath).toBe('/');
    }
  });

  test('the empty string fails every string format whose ajv-formats pattern rejects it', () => {
    const rejecting = [
      'date',
      'url',
      'email',
      'uuid',
      'duration',
      'uri',
      'hostname',
      'ipv4',
      'ipv6',
      'date-time',
      'time',
    ];
    for (const format of rejecting) {
      expect(engine.validate(schemaOf('2020-12', { format }), '')).toHaveLength(1);
    }
  });

  test('the samples cover every format ajv-formats 3.0.1 full mode registers', () => {
    const ajvFullFormats = [
      'binary',
      'byte',
      'date',
      'date-time',
      'double',
      'duration',
      'email',
      'float',
      'hostname',
      'int32',
      'int64',
      'ipv4',
      'ipv6',
      'iso-date-time',
      'iso-time',
      'json-pointer',
      'json-pointer-uri-fragment',
      'password',
      'regex',
      'relative-json-pointer',
      'time',
      'uri',
      'uri-reference',
      'uri-template',
      'url',
      'uuid',
    ];
    const covered = [...Object.keys(AJV_FORMAT_SAMPLES), ...Object.keys(GTS_FORMAT_SAMPLES)].sort();
    expect(covered).toEqual(ajvFullFormats);
  });

  test('format checkers are plain functions over the instance (GTS overrides unchanged)', () => {
    expect(isValidDateTime('2020-01-01T10:00:00')).toBe(false);
    expect(isValidTimePart('10:00:00')).toBe(false);
    expect(isValidRegex('^a+$')).toBe(true);
  });

  test('non-string values are ignored by string formats', () => {
    for (const value of [1, true, null, {}, []]) {
      expect(engine.validate(schemaOf('2020-12', { format: 'uuid' }), value)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// F6: Ajv-shaped schemaPath
// ---------------------------------------------------------------------------

describe('F6: schemaPath is the erroring node location plus the keyword', () => {
  const pathsOf = (dialect: Dialect, body: Record<string, unknown>, data: unknown) =>
    engine.validate(schemaOf(dialect, body), data).map((issue) => [issue.schemaPath, issue.instancePath]);

  test.each(DIALECT_NAMES)('[%s] nested property type and root minLength', (dialect) => {
    expect(pathsOf(dialect, { properties: { x: { type: 'string' } } }, { x: 1 })).toEqual([
      ['#/properties/x/type', '/x'],
    ]);
    expect(pathsOf(dialect, { minLength: 3 }, 'ab')).toEqual([['#/minLength', '/']]);
    expect(pathsOf(dialect, { properties: { a: { properties: { b: { maximum: 1 } } } } }, { a: { b: 2 } })).toEqual([
      ['#/properties/a/properties/b/maximum', '/a/b'],
    ]);
  });

  test.each(DIALECT_NAMES)('[%s] items', (dialect) => {
    expect(pathsOf(dialect, { type: 'array', items: { type: 'string' } }, ['a', 1])).toEqual([['#/items/type', '/1']]);
  });

  test.each(OPEN_DIALECTS.filter((dialect) => dialect === '2020-12'))('[%s] prefixItems', (dialect) => {
    expect(pathsOf(dialect, { prefixItems: [{ type: 'string' }, { type: 'number' }] }, ['a', 'b'])).toEqual([
      ['#/prefixItems/1/type', '/1'],
    ]);
  });

  test.each(['draft-07', '2019-09'] as const)('[%s] tuple items', (dialect) => {
    expect(pathsOf(dialect, { items: [{ type: 'string' }, { type: 'number' }] }, ['a', 'b'])).toEqual([
      ['#/items/1/type', '/1'],
    ]);
  });

  test.each(DIALECT_NAMES)('[%s] $ref to a local definition reports the definition location', (dialect) => {
    const defs = dialect === 'draft-07' ? 'definitions' : '$defs';
    const body = { properties: { a: { $ref: `#/${defs}/s` } }, [defs]: { s: { type: 'string' } } };
    expect(pathsOf(dialect, body, { a: 1 })).toEqual([[`#/${defs}/s/type`, '/a']]);
  });

  test.each(DIALECT_NAMES)('[%s] closed schema, required, and a false subschema', (dialect) => {
    expect(
      pathsOf(dialect, { properties: { o: { type: 'object', additionalProperties: false } } }, { o: { x: 1 } })
    ).toEqual([['#/properties/o/additionalProperties', '/o']]);
    expect(pathsOf(dialect, { required: ['a'] }, {})).toEqual([['#/required', '/']]);
    expect(pathsOf(dialect, { properties: { a: false } }, { a: 1 })).toEqual([['#/properties/a/false schema', '/a']]);
  });

  test.each(DIALECT_NAMES)('[%s] patternProperties child: escaped schema location and instance path', (dialect) => {
    const body = { patternProperties: { '^a/b': { type: 'string' }, '^t~': { type: 'string' } } };
    expect(pathsOf(dialect, body, { 'a/b': 1, 't~x': 2 })).toEqual([
      ['#/patternProperties/^a~1b/type', '/a~1b'],
      ['#/patternProperties/^t~0/type', '/t~0x'],
    ]);
  });

  test.each(DIALECT_NAMES)('[%s] properties names are escaped in the schema location', (dialect) => {
    expect(pathsOf(dialect, { properties: { 'a/b': { type: 'string' } } }, { 'a/b': 1 })).toEqual([
      ['#/properties/a~1b/type', '/a~1b'],
    ]);
  });

  test.each(DIALECT_NAMES)('[%s] a $ref to an escaped property location still resolves', (dialect) => {
    const body = {
      properties: { 'a/b': { type: 'string' }, c: { $ref: '#/properties/a~1b' } },
    };
    expect(engine.validate(schemaOf(dialect, body), { 'a/b': 'ok', c: 'ok' })).toEqual([]);
    expect(pathsOf(dialect, body, { c: 1 })).toEqual([['#/properties/a~1b/type', '/c']]);
  });

  test.each(DIALECT_NAMES)('[%s] x-gts-ref', (dialect) => {
    const issues = engine.validate(
      schemaOf(dialect, { properties: { r: { 'x-gts-ref': 'gts.acme.core.events.a.v1~' } } }),
      { r: 'gts.acme.core.events.b.v1~' }
    );
    expect(issues.map((issue) => [issue.schemaPath, issue.instancePath, issue.keyword])).toEqual([
      ['#/properties/r/x-gts-ref', '/r', 'x-gts-ref'],
    ]);
  });

  test.each(DIALECT_NAMES)('[%s] format errors', (dialect) => {
    expect(pathsOf(dialect, { properties: { id: { format: 'uuid' } } }, { id: 'nope' })).toEqual([
      ['#/properties/id/format', '/id'],
    ]);
  });

  test.each(OPEN_DIALECTS)('[%s] unevaluatedProperties', (dialect) => {
    expect(pathsOf(dialect, { properties: { a: {} }, unevaluatedProperties: false }, { b: 1 })).toEqual([
      ['#/unevaluatedProperties', '/'],
    ]);
  });

  test('a library error without a recorded node location falls back to #', () => {
    const issue = adaptLibraryError({ type: 'error', code: 'type-error', message: 'm', data: { pointer: '#/a' } });
    expect(issue.schemaPath).toBe('#/type');
    expect(issue.instancePath).toBe('/a');
  });

  test('schema document errors keep the schema keyword and the pointer to the offending keyword', () => {
    const issues = engine.validateSchemaDocument(schemaOf('2020-12', { properties: { 'a/b': { minLength: 'x' } } }));
    expect(issues).toHaveLength(1);
    expect(issues[0].schemaPath).toBe('#');
    expect(issues[0].instancePath).toBe('/properties/a~1b/minLength');
  });
});

// ---------------------------------------------------------------------------
// F7 / N2: unambiguous, escaped paths
// ---------------------------------------------------------------------------

describe('F7: instance paths carry escaped segments (no ambiguity)', () => {
  const colliding = {
    type: 'object',
    properties: {
      a: { type: 'object', properties: { b: { type: 'string' } } },
      'a/b': { type: 'string' },
    },
  };

  test.each(DIALECT_NAMES)('[%s] a key "a/b" next to a nested a.b is reported at /a~1b', (dialect) => {
    const issues = engine.validate(schemaOf(dialect, colliding), { a: { b: 'ok' }, 'a/b': 1 });
    expect(issues.map((issue) => [issue.keyword, issue.instancePath])).toEqual([['type', '/a~1b']]);
  });

  test.each(DIALECT_NAMES)('[%s] the nested value is still reported at /a/b', (dialect) => {
    const issues = engine.validate(schemaOf(dialect, colliding), { a: { b: 1 }, 'a/b': 'ok' });
    expect(issues.map((issue) => issue.instancePath)).toEqual(['/a/b']);
  });

  test.each(DIALECT_NAMES)('[%s] keys with ~ are escaped as ~0', (dialect) => {
    const schema = schemaOf(dialect, {
      properties: { 'x~y': { type: 'string' }, 't~1': { type: 'string' } },
    });
    const issues = engine.validate(schema, { 'x~y': 1, 't~1': 2 });
    expect(issues.map((issue) => issue.instancePath)).toEqual(['/x~0y', '/t~01']);
  });

  test.each(DIALECT_NAMES)('[%s] additionalProperties:<schema> and patternProperties escape the key', (dialect) => {
    const schema = schemaOf(dialect, {
      patternProperties: { '^p': { type: 'string' } },
      additionalProperties: { type: 'number' },
    });
    const issues = engine.validate(schema, { 'p/1': 1, 'q~/2': 'x' });
    expect(issues.map((issue) => issue.instancePath).sort()).toEqual(['/p~11', '/q~0~12']);
  });

  test.each(DIALECT_NAMES)('[%s] parent mode: escaped parents and an escaped offending key', (dialect) => {
    const schema = schemaOf(dialect, {
      properties: { 'a/b': { properties: { 'c~d': { additionalProperties: false } } } },
    });
    const issues = engine.validate(schema, { 'a/b': { 'c~d': { 'e/f': 1 } } });
    expect(issues.map((issue) => [issue.instancePath, issue.params.additionalProperty])).toEqual([
      ['/a~1b/c~0d', 'e/f'],
    ]);
  });

  test.each(OPEN_DIALECTS)('[%s] unevaluatedProperties escapes keys and nested paths', (dialect) => {
    const flat = engine.validate(schemaOf(dialect, { unevaluatedProperties: false }), { 'a/b': 1 });
    expect(flat.map((issue) => [issue.instancePath, issue.params.unevaluatedProperty])).toEqual([['/', 'a/b']]);
    const nested = engine.validate(schemaOf(dialect, { properties: { o: { unevaluatedProperties: false } } }), {
      o: { 'x~y': 1 },
    });
    expect(nested.map((issue) => [issue.instancePath, issue.params.unevaluatedProperty])).toEqual([['/o', 'x~y']]);
    const typed = engine.validate(
      schemaOf(dialect, { unevaluatedProperties: { properties: { n: { type: 'string' } } } }),
      { 'a/b': { n: 1 } }
    );
    expect(typed.map((issue) => issue.instancePath)).toEqual(['/a~1b/n']);
  });

  test('adaptLibraryError: root, parent of a root child, and a pointer-less error', () => {
    const base = { type: 'error', message: 'm' } as const;
    const at = (pointer: string | undefined, code: string) =>
      adaptLibraryError({ ...base, code, data: pointer === undefined ? {} : { pointer } }).instancePath;
    expect(at('#', 'type-error')).toBe('/');
    expect(at(undefined, 'type-error')).toBe('/');
    expect(at('#/a~1b/0', 'type-error')).toBe('/a~1b/0');
    expect(at('#/a', 'no-additional-properties-error')).toBe('/');
    expect(at('#/a~1b/c~0d', 'no-additional-properties-error')).toBe('/a~1b');
    expect(at('#', 'no-additional-properties-error')).toBe('/');
  });

  test('unique-items and unevaluated-items params are unescaped indexes', () => {
    const issue = adaptLibraryError({
      type: 'error',
      code: 'unique-items-error',
      message: 'm',
      data: { pointer: '#/l/2', duplicatePointer: '#/l/0' },
    });
    expect(issue.params).toEqual({ i: 2, j: 0 });
    expect(issue.instancePath).toBe('/l');
  });
});

describe('N2: patternProperties child schema paths are pointer-escaped', () => {
  test.each(DIALECT_NAMES)('[%s] a schema error inside a pattern with / and ~', (dialect) => {
    const schema = schemaOf(dialect, { patternProperties: { '^a/b~': { minLength: 'x' } } });
    const issues = engine.validateSchemaDocument(schema);
    expect(issues).toHaveLength(1);
    expect(issues[0].instancePath).toBe('/patternProperties/^a~1b~0/minLength');
  });
});

// ---------------------------------------------------------------------------
// N1: remote (host) schema errors are filtered by identity, not by position
// ---------------------------------------------------------------------------

describe('N1: root schema errors are told apart from remote host errors', () => {
  const bad = (id: string, body: Record<string, unknown>) => ({
    $schema: DIALECTS['2020-12'],
    $id: `gts://${id}`,
    ...body,
  });

  test('only the root document errors are reported while the pool holds an invalid schema', () => {
    engine.addEngineSchema(bad('host.one.v1~', { properties: { h: { minLength: 'host' } } }), 'host.one.v1~');
    engine.addEngineSchema(bad('host.two.v1~', { properties: { g: { maxLength: 'host' } } }), 'host.two.v1~');
    const issues = engine.validateSchemaDocument(schemaOf('2020-12', { properties: { r: { minItems: 'root' } } }));
    expect(issues.map((issue) => issue.instancePath)).toEqual(['/properties/r/minItems']);
    expect(issues[0].message).toContain("Keyword 'minItems'");
  });

  test('a valid root document reports nothing even when the pool has invalid schemas', () => {
    engine.addEngineSchema(bad('host.one.v1~', { properties: { h: { minLength: 'host' } } }), 'host.one.v1~');
    expect(engine.validateSchemaDocument(schemaOf('2020-12', { type: 'object' }))).toEqual([]);
    expect(engine.validate(schemaOf('2020-12', { type: 'object' }), {})).toEqual([]);
  });

  test('a root with several errors keeps all of them, host errors dropped', () => {
    engine.addEngineSchema(bad('host.one.v1~', { properties: { h: { minLength: 'host' } } }), 'host.one.v1~');
    const issues = engine.validateSchemaDocument(
      schemaOf('2020-12', { properties: { a: { minLength: 'x' }, b: { maxLength: 'y' } } })
    );
    expect(issues.map((issue) => issue.instancePath).sort()).toEqual([
      '/properties/a/minLength',
      '/properties/b/maxLength',
    ]);
  });
});
