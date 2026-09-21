import { GTS, GtsRefValidationMode, ValidationIssue } from '../src';

function issueAt(result: { errors: ValidationIssue[] }, entityIndex: number, instancePath: string): ValidationIssue {
  const issue = result.errors.find(
    (candidate) => candidate.entityIndex === entityIndex && candidate.instancePath === instancePath
  );
  expect(issue).toBeDefined();
  return issue!;
}

function expectSource(text: string, issue: ValidationIssue, value: string, key: string): void {
  expect(issue.source).toBeDefined();
  const source = issue.source!;
  expect(text.slice(source.value.offset, source.value.offset + source.value.length)).toBe(value);
  expect(text.slice(source.key!.offset, source.key!.offset + source.key!.length)).toBe(key);
  const prefix = text.slice(0, source.value.offset);
  const expectedLineOffset = prefix.lastIndexOf('\n') + 1;
  const expectedLine = prefix.split('\n').length - 1;
  expect(source.value.line).toBe(expectedLine);
  expect(source.value.lineOffset).toBe(expectedLineOffset);
  expect(source.value.column).toBe(source.value.offset - expectedLineOffset);
  expect(source.value.offset).toBe(source.value.lineOffset + source.value.column);
}

describe('source-aware file validation', () => {
  test('locates a schema error without putting the filename in the message', () => {
    const text = `{
  "$id": "gts://gts.x.unit.location.schema.v1~",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "name": { "type": 42 }
  }
}`;

    const result = new GTS().registerAndValidateText(text, 'jsonc');
    const issue = issueAt(result, 0, '/properties/name/type');

    expect(result.ok).toBe(false);
    expect(issue.message).not.toContain('private-schema-name.jsonc');
    expectSource(text, issue, '42', '"type"');
  });

  test('locates an instance error without putting the filename in the message', () => {
    const gts = new GTS();
    const typeId = 'gts.x.unit.location.instance.v1~';
    gts.register({
      $id: `gts://${typeId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { name: { type: 'string' } },
    });
    const text = `{
  "id": "${typeId}x.unit._.one.v1",
  "type": "${typeId}",
  "name": 42
}`;

    const result = gts.registerAndValidateText(text, 'json');
    const issue = issueAt(result, 0, '/name');

    expect(result.ok).toBe(false);
    expect(issue.message).not.toContain('private-instance-name.json');
    expectSource(text, issue, '42', '"name"');
  });

  test('points a missing-required-property error at the containing object with no key', () => {
    const gts = new GTS();
    const typeId = 'gts.x.unit.location.required.v1~';
    gts.register({
      $id: `gts://${typeId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    const text = `{
  "id": "${typeId}x.unit._.one.v1",
  "type": "${typeId}"
}`;

    const result = gts.registerAndValidateText(text, 'jsonc');
    const issue = issueAt(result, 0, '/');

    expect(result.ok).toBe(false);
    expect(issue.keyword).toBe('required');
    expect(issue.source).toBeDefined();
    expect(issue.source!.key).toBeUndefined();
    expect(text.slice(issue.source!.value.offset, issue.source!.value.offset + issue.source!.value.length)).toBe(text);
  });

  test('locates YAML values and keys with the same source contract', () => {
    const gts = new GTS();
    const typeId = 'gts.x.unit.location.yaml.v1~';
    gts.register({
      $id: `gts://${typeId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { name: { type: 'string' } },
    });
    const text = `id: ${typeId}x.unit._.one.v1
type: ${typeId}
name: 42
`;

    const result = gts.registerAndValidateText(text, 'yaml');
    const issue = issueAt(result, 0, '/name');

    expect(result.ok).toBe(false);
    expectSource(text, issue, '42', 'name');
    expect(issue.message).not.toContain('private-name.yaml');
  });

  test('preserves escaped property segments in x-gts-ref locations', () => {
    const gts = new GTS();
    const typeId = 'gts.x.unit.location.pointer.v1~';
    const property = 'a.b/c~d';
    gts.register({
      $id: `gts://${typeId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { [property]: { type: 'string', 'x-gts-ref': 'gts.x.unit.expected.type.v1~' } },
    });
    const text = `{
  "id": "${typeId}x.unit._.one.v1",
  "type": "${typeId}",
  "${property}": "gts.x.unit.actual.type.v1~"
}`;

    const result = gts.registerAndValidateText(text, 'json', GtsRefValidationMode.None);
    const issue = issueAt(result, 0, '/a.b~1c~0d');

    expect(result.ok).toBe(false);
    expectSource(text, issue, '"gts.x.unit.actual.type.v1~"', `"${property}"`);
  });

  test('preserves escaped property segments in derivation locations', () => {
    const gts = new GTS();
    const baseId = 'gts.x.unit.location.pointerbase.v1~';
    const derivedId = `${baseId}x.unit._.pointerchild.v1~`;
    const property = 'a.b/c~d';
    gts.register({
      $id: `gts://${baseId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { [property]: { type: 'string' } },
    });
    const text = `{
  "$id": "gts://${derivedId}",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": { "${property}": { "type": "number" } }
}`;

    const result = gts.registerAndValidateText(text, 'json');
    const issue = issueAt(result, 0, '/properties/a.b~1c~0d');

    expect(result.ok).toBe(false);
    expectSource(text, issue, '{ "type": "number" }', `"${property}"`);
  });

  test('reports parse positions without putting the filename in the message', () => {
    const text = '{\n  "id": nope\n}';
    const result = new GTS().registerAndValidateText(text, 'jsonc');
    const issue = result.errors[0];

    expect(result.ok).toBe(false);
    expect(issue.keyword).toBe('parse');
    expect(issue.message).not.toContain('private-parse-name.jsonc');
    expect(issue.source!.value.offset).toBeGreaterThan(0);
    expect(issue.source!.value.line).toBe(1);
    expect(issue.source!.value.offset).toBe(issue.source!.value.lineOffset + issue.source!.value.column);
  });

  test('distinguishes same-path and different-path errors in schema entries two and three', () => {
    const text = `[
  {
    "$id": "gts://gts.x.unit.location.schema_array_one.v1~",
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": { "name": { "type": "string" } }
  },
  {
    "$id": "gts://gts.x.unit.location.schema_array_two.v1~",
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "name": { "type": 42 },
      "age": { "type": "integer", "minimum": "zero" }
    }
  },
  {
    "$id": "gts://gts.x.unit.location.schema_array_three.v1~",
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": "name",
    "properties": {
      "name": { "type": false },
      "active": { "type": "boolean", "maximum": "high" }
    }
  }
]`;

    const result = new GTS().registerAndValidateText(text, 'jsonc');
    const secondSameProperty = issueAt(result, 1, '/properties/name/type');
    const thirdSameProperty = issueAt(result, 2, '/properties/name/type');
    const secondDifferentProperty = issueAt(result, 1, '/properties/age/minimum');
    const thirdDifferentKey = issueAt(result, 2, '/required');

    expect(result.ok).toBe(false);
    expect(result.entities[0].result.ok).toBe(true);
    expect(result.entities[1].result.ok).toBe(false);
    expect(result.entities[2].result.ok).toBe(false);
    expectSource(text, secondSameProperty, '42', '"type"');
    expectSource(text, thirdSameProperty, 'false', '"type"');
    expectSource(text, secondDifferentProperty, '"zero"', '"minimum"');
    expectSource(text, thirdDifferentKey, '"name"', '"required"');
    expect(secondSameProperty.source!.value.offset).not.toBe(thirdSameProperty.source!.value.offset);
    expect(result.errors.every((issue) => !issue.message.includes('schemas.jsonc'))).toBe(true);
  });

  test('rejects repeated entity IDs before registering a text batch', () => {
    const gts = new GTS({ allowEntityUpdates: true });
    const id = 'gts.x.unit.location.duplicate.v1~';
    const text = `[
  { "$id": "gts://${id}", "$schema": "http://json-schema.org/draft-07/schema#", "type": "string" },
  { "$id": "gts://${id}", "$schema": "http://json-schema.org/draft-07/schema#", "type": "number" }
]`;

    const result = gts.registerAndValidateText(text, 'json');
    const first = issueAt(result, 0, '/$id');
    const second = issueAt(result, 1, '/$id');

    expect(result.ok).toBe(false);
    expect(result.entities.map((entry) => entry.result.ok)).toEqual([false, false]);
    expect(first).toMatchObject({ keyword: 'registration', message: `Duplicate entity id in text payload: '${id}'` });
    expect(second).toMatchObject({ keyword: 'registration', message: `Duplicate entity id in text payload: '${id}'` });
    expect(gts.get(id)).toBeUndefined();
    expectSource(text, first, `"gts://${id}"`, '"$id"');
    expectSource(text, second, `"gts://${id}"`, '"$id"');
  });

  test('distinguishes same-path and different-path errors in instance entries two and three', () => {
    const gts = new GTS();
    const typeId = 'gts.x.unit.location.instance_array.v1~';
    gts.register({
      $id: `gts://${typeId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        active: { type: 'boolean' },
      },
    });
    const text = `[
  {
    "id": "${typeId}x.unit._.one.v1",
    "type": "${typeId}",
    "name": "valid",
    "age": 10,
    "active": true
  },
  {
    "id": "${typeId}x.unit._.two.v1",
    "type": "${typeId}",
    "name": 42,
    "age": "old",
    "active": false
  },
  {
    "id": "${typeId}x.unit._.three.v1",
    "type": "${typeId}",
    "name": false,
    "age": 20,
    "active": "yes"
  }
]`;

    const result = gts.registerAndValidateText(text, 'json');
    const secondSameProperty = issueAt(result, 1, '/name');
    const thirdSameProperty = issueAt(result, 2, '/name');
    const secondDifferentProperty = issueAt(result, 1, '/age');
    const thirdDifferentProperty = issueAt(result, 2, '/active');

    expect(result.ok).toBe(false);
    expect(result.entities[0].result.ok).toBe(true);
    expect(result.entities[1].result.ok).toBe(false);
    expect(result.entities[2].result.ok).toBe(false);
    expectSource(text, secondSameProperty, '42', '"name"');
    expectSource(text, thirdSameProperty, 'false', '"name"');
    expectSource(text, secondDifferentProperty, '"old"', '"age"');
    expectSource(text, thirdDifferentProperty, '"yes"', '"active"');
    expect(secondSameProperty.source!.value.offset).not.toBe(thirdSameProperty.source!.value.offset);
    expect(result.errors.every((issue) => !issue.message.includes('instances.json'))).toBe(true);
  });
});
