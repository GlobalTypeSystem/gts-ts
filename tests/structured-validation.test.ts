import { GTS, parseGtsText, parseGtsTextContent } from '../src';

describe('structured validation results', () => {
  test('adds Ajv issues without changing the legacy error string', () => {
    const gts = new GTS();
    const typeId = 'gts.x.unit.structured.instance.v1~';
    const instanceId = `${typeId}x.unit._.invalid.v1`;
    gts.register({
      $id: `gts://${typeId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    gts.register({ id: instanceId, type: typeId, name: 42 });

    const result = gts.validateInstance(instanceId);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("is not of type 'string'");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instancePath: '/name', keyword: 'type', params: { type: 'string' } }),
      ])
    );
  });

  test('preserves __proto__ property constraints while normalizing schemas', () => {
    const gts = new GTS();
    const typeId = 'gts.x.unit.structured.proto.v1~';
    gts.register({
      $id: `gts://${typeId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: JSON.parse('{"__proto__":{"type":"string"}}'),
    });

    const result = gts.validateTransientInstance(JSON.parse('{"__proto__":42}'), typeId, null);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ instancePath: '/__proto__' })]));
  });

  test('meta-validates a registered schema with structured issues', () => {
    const gts = new GTS();
    const typeId = 'gts.x.unit.structured.meta.v1~';
    gts.register({
      $id: `gts://${typeId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { name: { type: 42 } },
    });

    const result = gts.validateSchema(typeId);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('JSON Schema validation failed');
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ instancePath: '/properties/name/type' })])
    );
  });

  test.each(['https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema'])(
    'meta-validates the %s dialect',
    (dialect) => {
      const gts = new GTS();
      const suffix = dialect.includes('2020-12') ? 'draft2020' : 'draft2019';
      const typeId = `gts.x.unit.structured.${suffix}.v1~`;
      gts.register({
        $id: `gts://${typeId}`,
        $schema: dialect,
        type: 'array',
        prefixItems: [{ type: 'string' }],
      });

      expect(gts.validateSchema(typeId).ok).toBe(true);
    }
  );

  test('uses Draft 2020-12 assertions for instance validation', () => {
    const gts = new GTS();
    const typeId = 'gts.x.unit.structured.prefixitems.v1~';
    const instanceId = `${typeId}x.unit._.invalid.v1`;
    gts.register({
      $id: `gts://${typeId}`,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        values: { type: 'array', prefixItems: [{ type: 'string' }] },
      },
    });
    gts.register({ id: instanceId, type: typeId, values: [42] });

    const result = gts.validateInstance(instanceId);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ instancePath: '/values/0' })]));
  });

  test('returns structured x-gts-ref declaration errors', () => {
    const gts = new GTS();
    const typeId = 'gts.x.unit.structured.xref.v1~';
    gts.register({
      $id: `gts://${typeId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { link: { type: 'string', 'x-gts-ref': '/unsupported' } },
    });

    const result = gts.validateSchema(typeId);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instancePath: '/properties/link/x-gts-ref', keyword: 'x-gts-ref' }),
      ])
    );
  });

  test('reports derivation issues at the derived property path', () => {
    const gts = new GTS();
    const baseId = 'gts.x.unit.structured.derivation.v1~';
    const derivedId = `${baseId}x.unit._.child.v1~`;
    gts.register({
      $id: `gts://${baseId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { level: { type: 'integer', maximum: 10 } },
    });
    gts.register({
      $id: `gts://${derivedId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      allOf: [{ $ref: `gts://${baseId}` }, { type: 'object', properties: { level: { type: 'integer', maximum: 20 } } }],
    });

    const result = gts.validateSchema(derivedId);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instancePath: '/allOf/1/properties/level', keyword: 'x-gts-schema' }),
      ])
    );
  });

  test("propagates a transitively invalid type's structured issues to instance validation", () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.structured.txbase.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;
    const instanceId = `${kidId}x.unit._.item.v1`;
    gts.register({
      $id: `gts://${baseId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      additionalProperties: false,
    });
    // A derivation-incompatible type: drops the required `b` and reopens the
    // closed content model. `validateSchema(kidId)` fails with structured
    // derivation issues; those must not be dropped when an instance of the type
    // is validated and its transitive type check fails.
    gts.register({
      $id: `gts://${kidId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
      additionalProperties: true,
    });
    gts.register({ id: instanceId, type: kidId, a: 'x' });

    const result = gts.validateInstance(instanceId);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Instance type 'gts.x.unit.structured.txbase.v1~x.unit._.kid.v1~' is invalid");
    // The derived type's own structured issues are carried through, not dropped.
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: 'x-gts-schema', params: { property: 'b' } })])
    );
  });

  test("propagates an invalid schema $ref dependency's structured issues", () => {
    const gts = new GTS({ validateRefs: false });
    const depBaseId = 'gts.x.unit.structured.depbase.v1~';
    const depId = `${depBaseId}x.unit._.dep.v1~`;
    const hostId = 'gts.x.unit.structured.host.v1~';
    gts.register({
      $id: `gts://${depBaseId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      additionalProperties: false,
    });
    // Derivation-incompatible dependency schema (drops required `b`).
    gts.register({
      $id: `gts://${depId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
      additionalProperties: true,
    });
    // A host schema whose body $refs the invalid dependency.
    gts.register({
      $id: `gts://${hostId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { link: { $ref: `gts://${depId}` } },
    });

    const result = gts.validateSchema(hostId);

    expect(result.ok).toBe(false);
    expect(result.error).toContain(`Referenced type '${depId}' is invalid`);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: 'x-gts-schema', params: { property: 'b' } })])
    );
  });
});

describe('GTS file parsing', () => {
  test('parses JSONC with comments and trailing commas', () => {
    const result = parseGtsText('{ // comment\n "id": "gts.x.unit.parse.type.v1~x.unit._.item.v1",\n}', 'jsonc');

    expect(result.ok).toBe(true);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe('gts.x.unit.parse.type.v1~x.unit._.item.v1');
  });

  test('rejects JSONC extensions in strict JSON mode', () => {
    const text = '{ // comment\n "id": "gts.x.unit.parse.type.v1~x.unit._.strict.v1",\n}';

    expect(parseGtsText(text, 'json').ok).toBe(false);
    expect(parseGtsText(text, 'jsonc').ok).toBe(true);
  });

  test('parses YAML by explicit format', () => {
    expect(parseGtsTextContent('id: gts.x.unit.parse.type.v1~x.unit._.yaml.v1', 'yaml')).toEqual({
      id: 'gts.x.unit.parse.type.v1~x.unit._.yaml.v1',
    });
  });

  test('returns a parse error without throwing from parseGtsText', () => {
    const result = parseGtsText('{ nope', 'jsonc');

    expect(result.ok).toBe(false);
    expect(result.entities).toEqual([]);
    expect(result.error).toContain('JSONC parse error');
  });
});
