import {
  GTS,
  GtsStore,
  createJsonEntity,
  isValidGtsID,
  validateGtsID,
  parseGtsID,
  matchIDPattern,
  idToUUID,
  extractID,
} from '../src';
import { MAX_SCHEMA_DEPTH } from '../src/types';
import { XGtsRefValidator } from '../src/x-gts-ref';

describe('GTS Core Operations', () => {
  describe('OP#1 - ID Validation', () => {
    test('validates correct GTS IDs', () => {
      expect(isValidGtsID('gts.vendor.pkg.ns.type.v1~')).toBe(true);
      // v0.7: Single-segment instances are prohibited, must use chained IDs
      expect(isValidGtsID('gts.vendor.pkg.ns.type.v1~vendor.pkg.ns.instance.v1.0')).toBe(true);
      // Chained identifiers per spec section 2.2
      expect(isValidGtsID('gts.x.core.events.type.v1~ven.app._.custom_event.v1~')).toBe(true);
      expect(isValidGtsID('gts.x.core.events.topic.v1~ven.app._.custom_event_topic.v1.2')).toBe(true);
    });

    test('rejects invalid GTS IDs', () => {
      expect(isValidGtsID('invalid')).toBe(false);
      expect(isValidGtsID('GTS.vendor.pkg.ns.type.v1~')).toBe(false);
      expect(isValidGtsID('gts.vendor-pkg.ns.type.v1~')).toBe(false);
      expect(isValidGtsID('gts.vendor.pkg.ns.type')).toBe(false);
    });

    test('rejects single-segment instance IDs (v0.7)', () => {
      // Single-segment instance IDs are prohibited in v0.7
      expect(isValidGtsID('gts.vendor.pkg.ns.type.v1.0')).toBe(false);
      expect(isValidGtsID('gts.vendor.pkg.ns.type.v1.2')).toBe(false);
    });

    test('validateGtsID returns detailed validation result', () => {
      const validResult = validateGtsID('gts.vendor.pkg.ns.type.v1~');
      expect(validResult.ok).toBe(true);
      expect(validResult.valid).toBe(true);
      expect(validResult.error).toBe('');

      const invalidResult = validateGtsID('invalid.id');
      expect(invalidResult.ok).toBe(false);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.error).toContain('Invalid GTS identifier');
    });
  });

  describe('OP#2 - ID Extraction', () => {
    test('extracts GTS ID from instance', () => {
      const instance = {
        gtsId: 'gts.vendor.pkg.ns.type.v1.0',
        name: 'Test Instance',
      };

      const result = extractID(instance);
      expect(result.id).toBe('gts.vendor.pkg.ns.type.v1.0');
      expect(result.is_type_schema).toBe(false);
    });

    test('extracts GTS ID from schema', () => {
      const schema = {
        $id: 'gts.vendor.pkg.ns.type.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {},
      };

      const result = extractID(schema);
      expect(result.id).toBe('gts.vendor.pkg.ns.type.v1~');
      expect(result.is_type_schema).toBe(true);
    });

    test('handles GTS URI prefix', () => {
      const schema = {
        $id: 'gts://gts.vendor.pkg.ns.type.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
      };

      const result = extractID(schema);
      expect(result.id).toBe('gts.vendor.pkg.ns.type.v1~');
      expect(result.is_type_schema).toBe(true);
    });
  });

  describe('OP#3 - ID Parsing', () => {
    test('parses GTS ID into segments', () => {
      const result = parseGtsID('gts.vendor.pkg.ns.type.v1~');
      expect(result.ok).toBe(true);
      expect(result.segments).toHaveLength(1);

      const segment = result.segments[0];
      expect(segment.vendor).toBe('vendor');
      expect(segment.package).toBe('pkg');
      expect(segment.namespace).toBe('ns');
      expect(segment.type).toBe('type');
      expect(segment.verMajor).toBe(1);
      expect(segment.verMinor).toBeUndefined();
      expect(segment.isType).toBe(true);
    });

    test('parses instance ID with minor version', () => {
      const result = parseGtsID('gts.vendor.pkg.ns.type.v1~vendor.pkg.ns.instance.v1.2');
      expect(result.ok).toBe(true);

      const segment = result.segments[1];
      expect(segment.verMajor).toBe(1);
      expect(segment.verMinor).toBe(2);
      expect(segment.isType).toBe(false);
    });

    test('parses chained identifiers', () => {
      const result = parseGtsID('gts.x.core.events.type.v1~ven.app._.custom_event.v1~');
      expect(result.ok).toBe(true);
      expect(result.segments).toHaveLength(2);

      // First segment - base type
      expect(result.segments[0].vendor).toBe('x');
      expect(result.segments[0].package).toBe('core');
      expect(result.segments[0].namespace).toBe('events');
      expect(result.segments[0].type).toBe('type');
      expect(result.segments[0].verMajor).toBe(1);
      expect(result.segments[0].isType).toBe(true);

      // Second segment - derived type
      expect(result.segments[1].vendor).toBe('ven');
      expect(result.segments[1].package).toBe('app');
      expect(result.segments[1].namespace).toBe('_'); // placeholder
      expect(result.segments[1].type).toBe('custom_event');
      expect(result.segments[1].verMajor).toBe(1);
      expect(result.segments[1].isType).toBe(true);
    });
  });

  describe('OP#4 - Pattern Matching', () => {
    test('matches exact patterns', () => {
      const candidate = 'gts.vendor.pkg.ns.type.v1~vendor.pkg.ns.instance.v1.0';
      const pattern = 'gts.vendor.pkg.ns.type.v1~vendor.pkg.ns.instance.v1.0';
      const result = matchIDPattern(candidate, pattern);
      expect(result.match).toBe(true);
    });

    test('matches wildcard patterns', () => {
      const candidate = 'gts.vendor.pkg.ns.type.v1~vendor.pkg.ns.instance.v1.0';
      const pattern = 'gts.vendor.pkg.*';
      const result = matchIDPattern(candidate, pattern);
      expect(result.match).toBe(true);
    });

    test('rejects non-matching patterns', () => {
      const candidate = 'gts.vendor.pkg.ns.type.v1~vendor.pkg.ns.instance.v1.0';
      const pattern = 'gts.other.pkg.*';
      const result = matchIDPattern(candidate, pattern);
      expect(result.match).toBe(false);
    });

    test('matches partial wildcards', () => {
      const candidate = 'gts.vendor.pkg.ns.type.v1~vendor.pkg.ns.instance.v1.0';
      const pattern = 'gts.vendor.pkg.ns.*';
      const result = matchIDPattern(candidate, pattern);
      expect(result.match).toBe(true);
    });
  });

  describe('OP#5 - UUID Generation', () => {
    test('generates deterministic UUID from GTS ID', () => {
      const result1 = idToUUID('gts.vendor.pkg.ns.type.v1~');
      const result2 = idToUUID('gts.vendor.pkg.ns.type.v1~');

      expect(result1.uuid).toBe(result2.uuid);
      expect(result1.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    test('generates different UUIDs for different IDs', () => {
      const result1 = idToUUID('gts.vendor.pkg.ns.type.v1~');
      const result2 = idToUUID('gts.vendor.pkg.ns.type.v2~');

      expect(result1.uuid).not.toBe(result2.uuid);
    });
  });
});

describe('GTS Store Operations', () => {
  let gts: GTS;

  beforeEach(() => {
    gts = new GTS({ validateRefs: false });
  });

  describe('OP#6 - Schema Validation', () => {
    test('validates instance against schema', () => {
      const schema = {
        $id: 'gts.test.pkg.ns.person.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      };

      const validInstance = {
        gtsId: 'gts.test.pkg.ns.person.v1~test.pkg.ns.john.v1.0',
        $schema: 'gts.test.pkg.ns.person.v1~',
        name: 'John Doe',
        age: 30,
      };

      const invalidInstance = {
        gtsId: 'gts.test.pkg.ns.person.v1~test.pkg.ns.jane.v1.1',
        $schema: 'gts.test.pkg.ns.person.v1~',
        age: 30,
      };

      gts.register(schema);
      gts.register(validInstance);
      gts.register(invalidInstance);

      const validResult = gts.validateInstance('gts.test.pkg.ns.person.v1~test.pkg.ns.john.v1.0');
      expect(validResult.ok).toBe(true);

      const invalidResult = gts.validateInstance('gts.test.pkg.ns.person.v1~test.pkg.ns.jane.v1.1');
      expect(invalidResult.ok).toBe(false);
      expect(invalidResult.error).toContain('required');
    });
  });

  describe('OP#7 - Relationship Resolution', () => {
    test('resolves relationships between entities', () => {
      const schema = {
        $id: 'gts.test.pkg.ns.person.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' },
          friend: { $ref: 'gts://gts.test.pkg.ns.person.v1~' },
        },
      };

      const instance = {
        gtsId: 'gts.test.pkg.ns.person.v1~test.pkg.ns.john.v1.0',
        $schema: 'gts.test.pkg.ns.person.v1~',
        name: 'John',
        friend: { $ref: 'gts.test.pkg.ns.person.v1~test.pkg.ns.jane.v1.1' },
      };

      gts.register(schema);
      gts.register(instance);

      const result = gts.resolveRelationships('gts.test.pkg.ns.person.v1~test.pkg.ns.john.v1.0');
      expect(result.relationships).toContain('gts.test.pkg.ns.person.v1~');
      expect(result.brokenReferences).toContain('gts.test.pkg.ns.person.v1~test.pkg.ns.jane.v1.1');
    });
  });

  describe('OP#8 - Compatibility Checking', () => {
    test('reports adding an optional property to an open model as forward-only', () => {
      const schemaV1 = {
        $id: 'gts.test.pkg.ns.person.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      };

      const schemaV2 = {
        $id: 'gts.test.pkg.ns.person.v2~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          email: { type: 'string' },
        },
        required: ['name'],
      };

      gts.register(schemaV1);
      gts.register(schemaV2);

      const result = gts.checkCompatibility('gts.test.pkg.ns.person.v1~', 'gts.test.pkg.ns.person.v2~', 'backward');

      // Spec 0.13 §4.5: the old open schema already accepted arbitrary values
      // under `email`, so the added property schema is not backward compatible.
      expect(result.backward_compatibility).toBe('incompatible');
      expect(result.forward_compatibility).toBe('compatible');
      expect(result.full_compatibility).toBe('incompatible');
    });

    test('reports annotation-only changes as fully compatible', () => {
      const schemaV1 = {
        $id: 'gts.test.pkg.ns.doc.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { name: { type: 'string', description: 'The name' } },
        required: ['name'],
        additionalProperties: false,
      };

      const schemaV2 = {
        $id: 'gts.test.pkg.ns.doc.v2~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { name: { type: 'string', description: 'A better description' } },
        required: ['name'],
        additionalProperties: false,
      };

      gts.register(schemaV1);
      gts.register(schemaV2);

      const result = gts.checkCompatibility('gts.test.pkg.ns.doc.v1~', 'gts.test.pkg.ns.doc.v2~');
      expect(result.full_compatibility).toBe('compatible');
      expect(result.is_fully_compatible).toBe(true);
    });

    test('detects incompatible changes', () => {
      const schemaV1 = {
        $id: 'gts.test.pkg.ns.person.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      };

      const schemaV2 = {
        $id: 'gts.test.pkg.ns.person.v2~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          fullName: { type: 'string' },
        },
        required: ['fullName'],
      };

      gts.register(schemaV1);
      gts.register(schemaV2);

      const result = gts.checkCompatibility('gts.test.pkg.ns.person.v1~', 'gts.test.pkg.ns.person.v2~', 'backward');
      expect(result.is_fully_compatible).toBe(false);
      expect(result.incompatibility_reasons.length).toBeGreaterThan(0);
    });
  });

  describe('OP#12 - derivation form', () => {
    test('an allOf $ref to an unrelated type does not stand in for the chain parent', () => {
      // Only a reference to the chain parent inherits its constraints. Without
      // one, the derived schema has to restate them (ADR-0001 variant 2c), so
      // dropping a required field and opening a closed base must fail.
      gts.register({
        $id: 'gts.test.pkg.ns.strict.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['a', 'b'],
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        additionalProperties: false,
      });
      gts.register({
        $id: 'gts.test.pkg.ns.unrelated.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
      });
      gts.register({
        $id: 'gts.test.pkg.ns.strict.v1~test.pkg._.lax.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
        additionalProperties: true,
        allOf: [{ $ref: 'gts://gts.test.pkg.ns.unrelated.v1~' }],
      });

      expect(gts.validateEntity('gts.test.pkg.ns.strict.v1~test.pkg._.lax.v1~').ok).toBe(false);
    });
  });

  describe('OP#12 - inheritance through a top-level $ref', () => {
    test('a derived type that is exactly its parent via top-level $ref is valid', () => {
      // ADR-0001 leaves the derivation body free; `{$ref: parent}` means
      // "identical to the parent", which trivially satisfies derivation.
      gts.register({
        $id: 'gts.test.pkg.ns.tlbase.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['a', 'b'],
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        additionalProperties: false,
      });
      gts.register({
        $id: 'gts.test.pkg.ns.tlbase.v1~test.pkg._.kid.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        $ref: 'gts://gts.test.pkg.ns.tlbase.v1~',
      });

      expect(gts.validateEntity('gts.test.pkg.ns.tlbase.v1~test.pkg._.kid.v1~').ok).toBe(true);
    });
  });

  describe('OP#9 - a cast succeeds only if its result fits the target', () => {
    beforeEach(() => {
      gts.register({
        $id: 'gts.test.pkg.ns.shape.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
      });
      gts.register({
        $id: 'gts.test.pkg.ns.shape.v2~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'number' } },
      });
    });

    test('fails when the casted value does not satisfy the target type', () => {
      gts.register({ id: 'gts.test.pkg.ns.shape.v1~test.pkg._.bad.v1', a: 'not-a-number' });

      const result = gts.castInstance('gts.test.pkg.ns.shape.v1~test.pkg._.bad.v1', 'gts.test.pkg.ns.shape.v2~');

      expect(result.ok).toBe(false);
      // P6-4: `validateCastResult` now routes through the shared
      // `formatValidationError` (python-jsonschema-style wording), the same
      // one `/validate-json` and `/validate-instance` use, instead of raw
      // Ajv phrasing ("must be number").
      expect(result.error).toMatch(/is not of type 'number'/);
    });

    test('succeeds when the casted value does satisfy the target type', () => {
      gts.register({ id: 'gts.test.pkg.ns.shape.v1~test.pkg._.good.v1', a: 42 });

      const result = gts.castInstance('gts.test.pkg.ns.shape.v1~test.pkg._.good.v1', 'gts.test.pkg.ns.shape.v2~');

      expect(result.ok).toBe(true);
    });
  });

  describe('OP#9 - cast responses name the target consistently', () => {
    test('a failed cast still reports to_type_id', () => {
      const store = new GtsStore({ validateRefs: false });
      store.register(
        createJsonEntity({
          $id: 'gts.test.pkg.ns.castsrc.v1~',
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
        })
      );
      store.register(createJsonEntity({ id: 'gts.test.pkg.ns.castsrc.v1~test.pkg._.item.v1' }));

      // The target type is not registered, so this takes a failure path.
      const result: Record<string, any> = store.castInstance(
        'gts.test.pkg.ns.castsrc.v1~test.pkg._.item.v1',
        'gts.test.pkg.ns.missing.v2~'
      );

      expect(result.ok).toBe(false);
      expect(result.to_type_id).toBe('gts.test.pkg.ns.missing.v2~');
      expect(result).not.toHaveProperty('to_schema_id');
    });
  });

  describe('OP#9 - casting never lands on an abstract type', () => {
    test('rejects a cast whose target is x-gts-abstract, mirroring direct instantiation', () => {
      const store = new GtsStore({ validateRefs: false });
      store.register(
        createJsonEntity({
          $id: 'gts.test.pkg.ns.castabs.v1~',
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
        })
      );
      store.register(
        createJsonEntity({
          $id: 'gts.test.pkg.ns.castabs.v2~',
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          'x-gts-abstract': true,
        })
      );
      store.register(createJsonEntity({ id: 'gts.test.pkg.ns.castabs.v1~test.pkg._.item.v1' }));

      const result: Record<string, any> = store.castInstance(
        'gts.test.pkg.ns.castabs.v1~test.pkg._.item.v1',
        'gts.test.pkg.ns.castabs.v2~'
      );

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/abstract/i);
    });
  });

  describe('OP#9 - Version Casting', () => {
    test('casts instance between compatible versions', () => {
      const schemaV1 = {
        $id: 'gts.test.pkg.ns.person.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      };

      const schemaV2 = {
        $id: 'gts.test.pkg.ns.person.v2~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          email: { type: 'string', default: '' },
        },
        required: ['name'],
      };

      // A document carrying `$schema` is a schema, so an instance identifies
      // its type through the chained `id` instead.
      const instance = {
        id: 'gts.test.pkg.ns.person.v1~test.pkg.ns.john.v1.0',
        name: 'John',
        age: 30,
      };

      gts.register(schemaV1);
      gts.register(schemaV2);
      gts.register(instance);

      const result = gts.castInstance('gts.test.pkg.ns.person.v1~test.pkg.ns.john.v1.0', 'gts.test.pkg.ns.person.v2~');

      expect(result.ok).toBe(true);
      expect(result.result).toBeDefined();
      // The target's default is materialized into the casted instance.
      expect(result.result.email).toBe('');
      expect(result.result.name).toBe('John');
    });

    test('casts to a derived target that pulls its parent in through allOf', () => {
      gts.register({
        $id: 'gts.test.pkg.ns.staff.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, age: { type: 'number' } },
      });
      // Derived types are `allOf: [{$ref: parent}, …]` by construction, so a
      // cast that reads `properties` without resolving the ref sees nothing
      // and drops every value.
      gts.register({
        $id: 'gts.test.pkg.ns.staff.v1~test.pkg._.employee.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        allOf: [
          { $ref: 'gts://gts.test.pkg.ns.staff.v1~' },
          { type: 'object', properties: { dept: { type: 'string', default: 'unassigned' } } },
        ],
      });
      gts.register({ id: 'gts.test.pkg.ns.staff.v1~test.pkg.ns.ann.v1.0', name: 'Ann', age: 41 });

      const result = gts.castInstance(
        'gts.test.pkg.ns.staff.v1~test.pkg.ns.ann.v1.0',
        'gts.test.pkg.ns.staff.v1~test.pkg._.employee.v1~'
      );

      expect(result.ok).toBe(true);
      expect(result.result).toMatchObject({ name: 'Ann', age: 41, dept: 'unassigned' });
    });

    test('casts to a target whose allOf reaches the same shared ancestor through two branches', () => {
      // Diamond-shaped hierarchy: `mid` and `sibling` both compose `ancestor`,
      // and the target composes both `mid` and `sibling`. Flattening the
      // target must revisit `ancestor` at most once so its property survives
      // exactly once - not duplicated, not dropped - regardless of how many
      // paths reach it.
      gts.register({
        $id: 'gts.test.pkg.ns.ancestor.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { shared: { type: 'string', default: 'from-ancestor' } },
      });
      gts.register({
        $id: 'gts.test.pkg.ns.mid.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        allOf: [{ $ref: 'gts://gts.test.pkg.ns.ancestor.v1~' }],
        properties: { fromMid: { type: 'string', default: 'mid' } },
      });
      gts.register({
        $id: 'gts.test.pkg.ns.sibling.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        allOf: [{ $ref: 'gts://gts.test.pkg.ns.ancestor.v1~' }],
        properties: { fromSibling: { type: 'string', default: 'sibling' } },
      });
      gts.register({
        $id: 'gts.test.pkg.ns.diamondtarget.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        allOf: [{ $ref: 'gts://gts.test.pkg.ns.mid.v1~' }, { $ref: 'gts://gts.test.pkg.ns.sibling.v1~' }],
        properties: { direct: { type: 'string', default: 'direct' } },
      });
      gts.register({
        $id: 'gts.test.pkg.ns.diamondsource.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {},
      });
      gts.register({ id: 'gts.test.pkg.ns.diamondsource.v1~test.pkg.ns.item.v1.0' });

      const result = gts.castInstance(
        'gts.test.pkg.ns.diamondsource.v1~test.pkg.ns.item.v1.0',
        'gts.test.pkg.ns.diamondtarget.v1~'
      );

      expect(result.ok).toBe(true);
      expect(result.result).toMatchObject({
        shared: 'from-ancestor',
        fromMid: 'mid',
        fromSibling: 'sibling',
        direct: 'direct',
      });
    });
  });

  describe('OP#9 - nested-property casting resolves the same way the root target does (PR #16 review finding #5)', () => {
    // `performCast` already resolves the ROOT cast target via
    // `resolveSchemaFully`. Nested property schemas used to be handled by a
    // separate, older helper (`effectiveObjectSchema`) that picked only the
    // FIRST `allOf` branch carrying `properties`/`required`, never followed
    // `$ref`, and gated recursion on a literal `propType === 'object'`
    // comparison - so a nested property shaped like
    // `{type:'object', allOf:[{$ref: inner}], additionalProperties:false}`
    // resolved to an EMPTY effective schema, silently deleting the instance's
    // own nested data and reporting the deletion under `removed_properties`
    // as if it were an intentional schema-evolution decision. These use
    // `GtsStore.castInstance` directly (as the "cast responses name the
    // target consistently" suite above does) for the full response shape,
    // since the public `CastResult` deliberately narrows `removed_properties`
    // away.
    test('a nested property that is itself allOf + $ref keeps data the inner schema declares, drops what it does not, and materializes its defaults', () => {
      const store = new GtsStore({ validateRefs: false });
      store.register(
        createJsonEntity({
          $id: 'gts.test.pkg.ns.nestedinner.v1~',
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          required: ['q'],
          properties: { q: { type: 'string' }, defaulted: { type: 'string', default: 'inner-default' } },
          additionalProperties: false,
        })
      );
      store.register(
        createJsonEntity({
          $id: 'gts.test.pkg.ns.nestedtarget.v1~',
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: {
            child: {
              type: 'object',
              allOf: [{ $ref: 'gts://gts.test.pkg.ns.nestedinner.v1~' }],
              additionalProperties: false,
            },
          },
        })
      );
      store.register(
        createJsonEntity({
          id: 'gts.test.pkg.ns.nestedtarget.v1~test.pkg.ns.item.v1.0',
          child: { q: 'kept', extra: 'not-declared' },
        })
      );

      const result: Record<string, any> = store.castInstance(
        'gts.test.pkg.ns.nestedtarget.v1~test.pkg.ns.item.v1.0',
        'gts.test.pkg.ns.nestedtarget.v1~'
      );

      // Note: not asserting `result.ok` here - `additionalProperties: false`
      // declared at the same schema level as an `allOf`/`$ref` is a
      // well-known, orthogonal AJV/JSON-Schema quirk (`additionalProperties`
      // only sees properties declared directly in `properties` at its OWN
      // level, not ones pulled in via a sibling `$ref`) that affects the
      // final `validateCastResult` re-validation regardless of this fix. What
      // this fix is responsible for - the CAST transform itself not silently
      // deleting/dropping nested data - is what these assertions pin down.
      expect(result.casted_entity.child).toMatchObject({ q: 'kept', defaulted: 'inner-default' });
      expect(result.casted_entity.child.extra).toBeUndefined();
      expect(result.removed_properties).toContain('child.extra');
      expect(result.removed_properties).not.toContain('child.q');
    });

    test('a nested property typed as ["object","null"] is still recursed into', () => {
      const store = new GtsStore({ validateRefs: false });
      store.register(
        createJsonEntity({
          $id: 'gts.test.pkg.ns.nestedarrtype.v1~',
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: {
            child: {
              type: ['object', 'null'],
              properties: { q: { type: 'string' } },
              additionalProperties: false,
            },
          },
        })
      );
      store.register(
        createJsonEntity({
          id: 'gts.test.pkg.ns.nestedarrtype.v1~test.pkg.ns.item.v1.0',
          child: { q: 'kept', junk: 1 },
        })
      );

      const result: Record<string, any> = store.castInstance(
        'gts.test.pkg.ns.nestedarrtype.v1~test.pkg.ns.item.v1.0',
        'gts.test.pkg.ns.nestedarrtype.v1~'
      );

      expect(result.ok).toBe(true);
      expect(result.casted_entity.child).toEqual({ q: 'kept' });
      expect(result.removed_properties).toContain('child.junk');
    });

    test('a nested property with no explicit type but properties/additionalProperties is still recursed into', () => {
      const store = new GtsStore({ validateRefs: false });
      store.register(
        createJsonEntity({
          $id: 'gts.test.pkg.ns.nestednotype.v1~',
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: {
            child: {
              properties: { q: { type: 'string' } },
              additionalProperties: false,
            },
          },
        })
      );
      store.register(
        createJsonEntity({
          id: 'gts.test.pkg.ns.nestednotype.v1~test.pkg.ns.item.v1.0',
          child: { q: 'kept', junk: 1 },
        })
      );

      const result: Record<string, any> = store.castInstance(
        'gts.test.pkg.ns.nestednotype.v1~test.pkg.ns.item.v1.0',
        'gts.test.pkg.ns.nestednotype.v1~'
      );

      expect(result.ok).toBe(true);
      expect(result.casted_entity.child).toEqual({ q: 'kept' });
      expect(result.removed_properties).toContain('child.junk');
    });
  });

  describe('OP#10 - Query Execution', () => {
    test('queries entities with patterns', () => {
      gts.register({
        gtsId: 'gts.vendor.pkg1.ns.type.v1~vendor.pkg1.ns.instance.v1.0',
        data: 'test1',
      });
      gts.register({
        gtsId: 'gts.vendor.pkg2.ns.type.v1~vendor.pkg2.ns.instance.v1.0',
        data: 'test2',
      });
      gts.register({
        gtsId: 'gts.other.pkg.ns.type.v1~other.pkg.ns.instance.v1.0',
        data: 'test3',
      });

      const result = gts.query('gts.vendor.*');
      expect(result.count).toBe(2);
      const ids = result.items.map((item: any) => item.gtsId);
      expect(ids).toContain('gts.vendor.pkg1.ns.type.v1~vendor.pkg1.ns.instance.v1.0');
      expect(ids).toContain('gts.vendor.pkg2.ns.type.v1~vendor.pkg2.ns.instance.v1.0');
    });

    test('supports wildcard patterns', () => {
      gts.register({ gtsId: 'gts.a.b.c.d.v1~a.b.c.d.v1.0' });
      gts.register({ gtsId: 'gts.a.b.c.e.v1~a.b.c.e.v1.0' });
      gts.register({ gtsId: 'gts.a.x.c.d.v1~a.x.c.d.v1.0' });

      const result = gts.query('gts.a.b.*');
      expect(result.count).toBe(2);
      const ids = result.items.map((item: any) => item.gtsId);
      expect(ids).toContain('gts.a.b.c.d.v1~a.b.c.d.v1.0');
      expect(ids).toContain('gts.a.b.c.e.v1~a.b.c.e.v1.0');
    });
  });

  describe('OP#11 - Attribute Access', () => {
    test('retrieves attribute values', () => {
      // A bare, un-chained id (no `~`-marked type segment) is a prohibited
      // single-segment instance id per `Gts.parseGtsID` - use the same
      // chained shape as the other instance fixtures in this file.
      const instanceId = 'gts.test.pkg.ns.person.v1~test.pkg.ns.john.v1.0';
      const instance = {
        gtsId: instanceId,
        name: 'John Doe',
        address: {
          city: 'New York',
          country: 'USA',
        },
      };

      gts.register(instance);

      const nameResult = gts.getAttribute(`${instanceId}@name`);
      expect(nameResult.resolved).toBe(true);
      expect(nameResult.value).toBe('John Doe');

      const cityResult = gts.getAttribute(`${instanceId}@address.city`);
      expect(cityResult.resolved).toBe(true);
      expect(cityResult.value).toBe('New York');

      const missingResult = gts.getAttribute(`${instanceId}@missing`);
      expect(missingResult.resolved).toBe(false);
    });
  });

  describe('register() rejects malformed entity ids', () => {
    // A malformed id would otherwise silently break every ancestor-chain
    // computation downstream (`buildSchemaChain` and friends), which then
    // fail open by treating the entity as if it had no ancestors at all -
    // so `register()` must reject it up front, for every entity kind and
    // regardless of `validateRefs`.
    test('rejects a schema id with an extra dot-segment before the version', () => {
      // 5 dot-segments before `v1~` - GTS ids take exactly 4
      // (vendor.package.namespace.type).
      const malformedId = 'gts.x.unit.tr.nestedorphanbug.base.v1~';
      expect(() =>
        gts.register({
          $id: malformedId,
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
        })
      ).toThrow(`Invalid GTS entity id: '${malformedId}'`);
    });

    test('rejects a version missing the leading v', () => {
      const malformedId = 'gts.vendor.pkg.ns.type.1~';
      expect(() =>
        gts.register({
          $id: malformedId,
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
        })
      ).toThrow(`Invalid GTS entity id: '${malformedId}'`);
    });

    test('rejects a chained schema id missing the trailing tilde', () => {
      const malformedId = 'gts.vendor.pkg.ns.type.v1';
      expect(() =>
        gts.register({
          $id: malformedId,
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
        })
      ).toThrow(`Invalid GTS entity id: '${malformedId}'`);
    });

    test('rejects an empty string id', () => {
      // An empty-valued `gtsId` field means no id field was actually
      // detected (`findFirstValidField` requires a non-empty value), so this
      // is the "no id at all" case, not a malformed-but-present id - the
      // instance-side "Unable to detect GTS ID" message applies here rather
      // than the generic "Invalid GTS entity id" message used for a
      // non-empty, ill-formed id.
      expect(() => gts.register({ gtsId: '' })).toThrow(/Unable to detect GTS ID in instance entity/);
    });
  });

  describe('register() accepts anonymous instances by plain UUID (gts-spec §3.7)', () => {
    // §3.7 permits a non-schema instance to be identified by a plain UUID
    // in its `id` field, resolving its schema via a separate `type` field
    // rather than by the id's own GTS-chain shape - register() must accept
    // this shape instead of rejecting it as a malformed GTS id.
    test('accepts a non-schema instance with a plain UUID id and a `type` field', () => {
      const uuidId = '7a1d2f34-5678-49ab-9012-abcdef123456';
      expect(() =>
        gts.register({
          type: 'gts.x.test6anon.events.type.v1~x.commerce.orders.order_placed.v1.0~',
          id: uuidId,
          tenantId: '11111111-2222-3333-8444-555555555555',
          occurredAt: '2025-09-20T18:35:00Z',
          payload: { orderId: 'af0e3c1b-8f1e-4a27-9a9b-b7b9b70c1f01' },
        })
      ).not.toThrow();
    });

    test('still rejects a SCHEMA whose id is a plain UUID (not a valid GTS Type id)', () => {
      // The UUID exception is instance-only - a schema must always carry a
      // well-formed GTS Type ID.
      const uuidId = '7a1d2f34-5678-49ab-9012-abcdef123456';
      expect(() =>
        gts.register({
          $id: uuidId,
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
        })
      ).toThrow(`Invalid GTS entity id: '${uuidId}'`);
    });

    test('still rejects an id that is neither a valid GTS id nor a valid UUID', () => {
      const malformedId = 'not-a-valid-id-at-all';
      expect(() =>
        gts.register({
          gtsId: malformedId,
          name: 'irrelevant',
        })
      ).toThrow(`Invalid GTS entity id: '${malformedId}'`);
    });
  });

  // x-gts-ref combinator tests (oneOf/anyOf/allOf) are in the canonical gts-spec test suite

  describe('OP#12 - Wildcard Validation (v0.7)', () => {
    test('validates wildcard patterns', () => {
      const result = validateGtsID('gts.vendor.pkg.*');
      expect(result.ok).toBe(true);
      expect(result.is_wildcard).toBe(true);
    });

    test('rejects wildcards not at token boundaries', () => {
      expect(isValidGtsID('gts.vendor.pkg.a*')).toBe(false);
      expect(isValidGtsID('gts.vendor.pkg.*a')).toBe(false);
    });

    test('rejects wildcards in middle of chain', () => {
      expect(isValidGtsID('gts.vendor.*.ns.type.v1~')).toBe(false);
    });

    test('allows wildcards at end of chain', () => {
      expect(isValidGtsID('gts.vendor.pkg.ns.type.v1~vendor.*')).toBe(true);
    });
  });

  describe('OP#13 - Schema Detection (v0.7)', () => {
    test('detects schema with $schema field', () => {
      const schema = {
        $id: 'gts.vendor.pkg.ns.type.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
      };
      const result = extractID(schema);
      expect(result.is_type_schema).toBe(true);
    });

    test('does not detect schema without $schema field', () => {
      const notSchema = {
        $id: 'gts.vendor.pkg.ns.type.v1~',
        type: 'object',
        properties: {},
      };
      const result = extractID(notSchema);
      expect(result.is_type_schema).toBe(false);
    });

    test('detects schema with GTS $schema reference', () => {
      const schema = {
        $id: 'gts.vendor.pkg.ns.derived.v1~',
        $schema: 'gts://gts.vendor.pkg.ns.type.v1~',
        type: 'object',
      };
      const result = extractID(schema);
      expect(result.is_type_schema).toBe(true);
    });
  });

  describe('OP#14 - Schema ID Extraction (v0.7)', () => {
    test('extracts type_id from chain for instances without explicit schema field', () => {
      const instance = {
        gtsId: 'gts.vendor.pkg.ns.type.v1~vendor.pkg.ns.instance.v1.0',
        data: 'test',
      };
      const result = extractID(instance);
      // type_id is extracted from the chain
      expect(result.type_id).toBe('gts.vendor.pkg.ns.type.v1~');
    });

    test('extracts type_id from chained instance ID', () => {
      const instance = {
        gtsId: 'gts.vendor.pkg.ns.type.v1~vendor.pkg.ns.instance.v1.0',
        $schema: 'gts.vendor.pkg.ns.type.v1~',
        data: 'test',
      };
      const result = extractID(instance);
      expect(result.type_id).toBe('gts.vendor.pkg.ns.type.v1~');
    });

    test('extracts parent type from derived schema chain', () => {
      const schema = {
        $id: 'gts.x.core.events.type.v1~x.commerce.orders.order_placed.v1.0~',
        $schema: 'gts://gts.x.core.events.type.v1~',
        type: 'object',
      };
      const result = extractID(schema);
      expect(result.type_id).toBe('gts.x.core.events.type.v1~');
    });
  });

  describe('OP#15 - ParseResult Fields (v0.7)', () => {
    test('parseGtsID successfully parses type IDs', () => {
      const result = parseGtsID('gts.vendor.pkg.ns.type.v1~');
      expect(result.ok).toBe(true);
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].isType).toBe(true);
    });

    test('parseGtsID successfully parses wildcard patterns', () => {
      const result = parseGtsID('gts.vendor.pkg.*');
      expect(result.ok).toBe(true);
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].isWildcard).toBe(true);
    });

    test('parseGtsID successfully parses chained instance IDs', () => {
      const result = parseGtsID('gts.vendor.pkg.ns.type.v1~vendor.pkg.ns.instance.v1.0');
      expect(result.ok).toBe(true);
      expect(result.segments).toHaveLength(2);
      expect(result.segments[0].isType).toBe(true);
      expect(result.segments[1].isType).toBe(false);
    });
  });
});

// Phase 4 - `$id`/`$schema`/`$ref` detection vs. the bogus `$$` aliases
// (spec canonical suite: tests/test_op6_schema_validation.py).
//
// `$$id`/`$$schema`/`$$ref` are an HttpRunner escaping artifact in the
// canonical Python source (HttpRunner unescapes `$$` -> `$` on the wire),
// NOT GTS or JSON Schema keywords. The library currently treats them as
// first-class aliases (see `entityIdFields`/`schemaIdFields` in
// `src/extract.ts`, the `KEYWORDS` table in `src/compatibility.ts`, and the
// `$$id`/`$$schema`/`$$ref` switch cases and lookups in `src/store.ts`).
// The tests below pin the behavior a later phase must produce once those
// aliases are removed; several are expected to fail against today's
// implementation - that is the intended outcome of this authoring step.
describe('Phase 4 - $$ escaping artifacts are not GTS/JSON-Schema keywords', () => {
  describe('canonical: LiteralDoubleDollarIdRejected', () => {
    const content = {
      $$id: 'gts://gts.x.test6.literal_double_dollar.reject.v1~',
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    };

    test('extractID does not treat a literal $$id as the entity id field', () => {
      const result = extractID(content);
      // A real $schema is present, so the document is still a type schema...
      expect(result.is_type_schema).toBe(true);
      // ...but $$id is not a recognized id field, so no entity id is found.
      expect(result.id).toBe('');
      expect(result.selected_entity_field).toBeUndefined();
    });

    test('registering the schema fails with "Unable to detect GTS ID in schema"', () => {
      const gts = new GTS();
      expect(() => gts.register(content)).toThrow(/Unable to detect GTS ID in schema/);
    });
  });

  describe('canonical: DoubleDollarSchemaAndId_TreatedAsInstance', () => {
    const content = {
      $$schema: 'http://json-schema.org/draft-07/schema#',
      $$id: 'gts://gts.x.test6.double_dollar.instance_like.v1~',
      type: 'object',
    };

    test('extractID does not treat a literal $$schema as a schema marker', () => {
      const result = extractID(content);
      // Only a real $schema marks a document as a JSON Schema; $$schema does not.
      expect(result.is_type_schema).toBe(false);
    });

    test('registering fails as an instance with no detectable id', () => {
      const gts = new GTS();
      // Neither $$id nor $$schema are recognized fields, so this is an
      // instance document with no usable id field at all.
      expect(() => gts.register(content)).toThrow(/Unable to detect GTS ID in instance entity/);
    });
  });

  describe('canonical: DoubleDollarSchemaWithRealId_TreatedAsInstance', () => {
    const id = 'gts.x.test6.double_dollar.instance_ok.v1~';
    const content = {
      $$schema: 'http://json-schema.org/draft-07/schema#',
      $id: `gts://${id}`,
      type: 'object',
    };

    test('extractID classifies the document as an instance, not a schema', () => {
      const result = extractID(content);
      expect(result.is_type_schema).toBe(false);
      expect(result.id).toBe(id);
    });

    test('registers successfully and validates as an instance entity', () => {
      const gts = new GTS();
      gts.register(content);
      const validated = gts.validateEntity(id);
      expect(validated.entity_type).toBe('instance');
    });
  });

  describe('canonical: DoubleDollarRefNotMapped', () => {
    const BASE = 'gts.x.test6.dref.base.v1~';
    const DER_REF = 'gts.x.test6.dref.base.v1~x.test6._.der_ref.v1~';
    const DER_DD = 'gts.x.test6.dref_dd.standalone.v1~';
    const INST_REF = 'gts.x.test6.dref.base.v1~x.test6._.der_ref.v1~x.y._.i1.v1.0';
    const INST_DD = 'gts.x.test6.dref_dd.standalone.v1~x.y._.i2.v1.0';

    function setup(): GTS {
      const gts = new GTS();
      gts.register({
        $id: `gts://${BASE}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type', 'base_field'],
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          base_field: { type: 'string' },
        },
      });
      gts.register({
        $id: `gts://${DER_REF}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        allOf: [{ $ref: `gts://${BASE}` }],
      });
      gts.register({
        $id: `gts://${DER_DD}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        // literal double-dollar ref: an HttpRunner-escaping artifact, not $ref
        allOf: [{ $$ref: `gts://${BASE}` }],
      });
      gts.register({ id: INST_REF, type: DER_REF });
      gts.register({ id: INST_DD, type: DER_DD });
      return gts;
    }

    test('control: a real $ref inherits the base_field requirement', () => {
      const gts = setup();
      const result = gts.validateInstance(INST_REF);
      expect(result.ok).toBe(false);
    });

    test('subject: a literal $$ref does NOT inherit the base_field requirement', () => {
      const gts = setup();
      const result = gts.validateInstance(INST_DD);
      // $$ref is an unknown, no-op property here - not JSON Schema $ref - so
      // the derived schema does not inherit the base's `required: [base_field]`.
      expect(result.ok).toBe(true);
    });
  });

  describe('canonical: DoubleDollarRefDerivedSchemaMismatch', () => {
    const BASE = 'gts.x.test6.dref_mismatch.base.v1~';
    const DERIVED = 'gts.x.test6.dref_mismatch.base.v1~x.test6._.literal_dd.v1~';

    test('a derived schema whose only "ref" is a literal $$ref is rejected as incompatible with its GTS base', () => {
      const gts = new GTS();
      gts.register({
        $id: `gts://${BASE}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['base_field'],
        properties: { base_field: { type: 'string' } },
      });
      gts.register({
        $id: `gts://${DERIVED}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        // literal double-dollar ref does not establish inheritance, so the
        // derived schema must restate the base's constraints itself - it
        // does not, so it is incompatible with its GTS-chain base.
        allOf: [{ $$ref: `gts://${BASE}` }],
      });

      const result = gts.validateSchemaAgainstParent(DERIVED);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('base_field');
    });
  });

  describe('explicit schema validation resolves GTS references', () => {
    test('rejects a missing concrete x-gts-ref target reached through a local $ref', () => {
      const gts = new GTS({ validateRefs: false });
      const id = 'gts.x.test12.xrefmissing.holder.v1~';
      gts.register({
        $id: `gts://${id}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { ref: { $ref: '#/definitions/TargetRef' } },
        definitions: {
          TargetRef: {
            type: 'string',
            'x-gts-ref': 'gts.x.test12.xrefmissing.target.v1~',
          },
        },
      });

      const result = gts.validateSchemaAgainstParent(id);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        "x-gts-ref constraint type 'gts.x.test12.xrefmissing.target.v1~' is not registered"
      );
    });

    test('rejects a missing GTS reference target', () => {
      const gts = new GTS({ validateRefs: false });
      const id = 'gts.x.test12.refmissing.host.v1~';
      gts.register({
        $id: `gts://${id}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        allOf: [{ $ref: 'gts://gts.x.test12.refmissing.target.v1~' }],
      });

      const result = gts.validateSchemaAgainstParent(id);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Unresolvable $ref');
    });

    test('rejects a missing derived GTS reference target', () => {
      const gts = new GTS({ validateRefs: false });
      const target = 'gts.x.test12.refpartial.target.v1~';
      const host = 'gts.x.test12.refpartial.host.v1~';
      gts.register({
        $id: `gts://${target}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
      });
      gts.register({
        $id: `gts://${host}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        allOf: [{ $ref: `gts://${target}x.test12._.missing.v1~` }],
      });

      const result = gts.validateSchemaAgainstParent(host);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Unresolvable $ref');
    });
  });

  describe('direct: $$ id/schema/ref are not registered keyword aliases', () => {
    test('extractID never selects $$id as the entity id field, even when it is the only id-shaped key', () => {
      const result = extractID({ $$id: 'gts://gts.x.test6.direct.no_alias.v1~', foo: 'bar' });
      expect(result.selected_entity_field).toBeUndefined();
      expect(result.id).toBe('');
    });

    test('extractID never treats $$schema alone as a schema marker', () => {
      const result = extractID({ $$schema: 'http://json-schema.org/draft-07/schema#', foo: 'bar' });
      expect(result.is_type_schema).toBe(false);
    });
  });
});

// Phase 5 - `x-gts-ref` traversal gaps
// (spec canonical suite: .gts-spec/tests/test_refimpl_x_gts_ref.py,
// TestCaseXGtsRef_ImplicitObjectAndLocalRef / TestCaseXGtsRef_RootLocalReference).
//
// `XGtsRefValidator.visitInstance` (src/x-gts-ref.ts) only recurses into
// `schema.properties` when `schema.type === 'object'` is explicitly declared,
// and it has no `$ref` handling at all - so it neither follows a local
// JSON-pointer `$ref` into `definitions` nor a root `$ref: "#"`. Each `it`
// below is expected to fail against today's implementation; the paired
// "control" case pins the same traversal shape with a *correct* reference,
// which passes today - but vacuously, since the validator does not visit
// that path at all yet, not because it checked and approved the value. A
// later phase must make the control case pass for the right reason.
describe('Phase 5 - x-gts-ref traversal gaps (implicit object, local $ref, root $ref)', () => {
  describe('canonical: TestCaseXGtsRef_ImplicitObjectAndLocalRef (a) - implicit object', () => {
    // The holder schema never declares `type: "object"` - only `required`,
    // `properties` and `additionalProperties: false` - yet x-gts-ref on
    // `properties.ref` must still be enforced (gts-spec: "the point is that
    // x-gts-ref enforcement must not depend on an explicit type: object
    // declaration").
    function registerHolder(gts: GTS, holderId: string, targetId: string) {
      gts.register({
        $id: `gts://${holderId}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        required: ['id', 'ref'],
        properties: {
          id: { type: 'string' },
          ref: { type: 'string', 'x-gts-ref': targetId },
        },
        additionalProperties: false,
      });
    }

    // The x-gts-ref registry-existence check (src/x-gts-ref.ts) only engages
    // once the referenced *type* itself is registered in the store - an
    // unregistered type prefix is treated as a foreign/documentation
    // namespace and the check is skipped entirely (see the comment above
    // the `this.store.get(pattern)` gate). Registering only an *instance*
    // under the target prefix (as this test previously did, without ever
    // registering `targetId` itself) never engages that gate, so the
    // assertion below would pass identically whether or not enforcement
    // works. Register the target type schema too, so the control actually
    // pins the enforcement it claims to.
    function registerTargetType(gts: GTS, targetId: string) {
      gts.register({
        $id: `gts://${targetId}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { id: { type: 'string' } },
      });
    }

    test('control: a correctly-prefixed ref through an implicit-object schema validates', () => {
      const gts = new GTS();
      const holderId = 'gts.x.test5_implicit_ctl._.holder.v1~';
      const targetId = 'gts.x.test5_implicit_ctl._.target.v1~';
      registerHolder(gts, holderId, targetId);
      // The x-gts-ref registry-existence check requires the referenced
      // entity to actually be registered (see OP#13 tests and
      // `TestCaseXGtsRef_PrefixAndSelfRef` in the canonical suite, which
      // register the referenced capability before validating a good
      // reference to it), so register the target's type schema and the
      // referenced instance here too.
      registerTargetType(gts, targetId);
      gts.register({ id: `${targetId}x.vendor._.good.v1` });
      gts.register({
        id: `${holderId}x.vendor._.good.v1`,
        ref: `${targetId}x.vendor._.good.v1`,
      });
      const result = gts.validateInstance(`${holderId}x.vendor._.good.v1`);
      expect(result.ok).toBe(true);
    });

    test('a correctly-prefixed ref through an implicit-object schema is rejected when the target instance is not registered (registry-existence check actually engages)', () => {
      const gts = new GTS();
      const holderId = 'gts.x.test5_implicit_ctl_neg._.holder.v1~';
      const targetId = 'gts.x.test5_implicit_ctl_neg._.target.v1~';
      registerHolder(gts, holderId, targetId);
      // The type is registered, but the referenced instance is not - this
      // must fail the registry-existence check, proving that check is
      // actually reachable through the implicit-object traversal shape.
      registerTargetType(gts, targetId);
      gts.register({
        id: `${holderId}x.vendor._.good.v1`,
        ref: `${targetId}x.vendor._.nonexistent.v1`,
      });
      const result = gts.validateInstance(`${holderId}x.vendor._.good.v1`);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found in registry/);
    });

    test('a mis-prefixed ref through an implicit-object schema is rejected', () => {
      const gts = new GTS();
      const holderId = 'gts.x.test5_implicit._.holder.v1~';
      const targetId = 'gts.x.test5_implicit._.target.v1~';
      registerHolder(gts, holderId, targetId);
      gts.register({
        id: `${holderId}x.vendor._.bad.v1`,
        ref: 'gts.x.test5_implicit._.other_target.v1~x.vendor._.bad.v1',
      });
      const result = gts.validateInstance(`${holderId}x.vendor._.bad.v1`);
      // TODO(phase-5): fails today - visitInstance only recurses into
      // schema.properties when schema.type === 'object' is explicit, so the
      // implicit-object holder's `ref` property is never visited and no
      // x-gts-ref error is ever produced (result.ok is true today).
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/does not match pattern/);
    });
  });

  describe('canonical: TestCaseXGtsRef_ImplicitObjectAndLocalRef (b) - local $ref into definitions', () => {
    function registerHolder(gts: GTS, holderId: string, targetId: string) {
      gts.register({
        $id: `gts://${holderId}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['id', 'ref'],
        properties: {
          id: { type: 'string' },
          ref: { $ref: '#/definitions/TargetRef' },
        },
        definitions: {
          TargetRef: { type: 'string', 'x-gts-ref': targetId },
        },
        additionalProperties: false,
      });
    }

    // See the implicit-object control test above: registering only an
    // *instance* under the target prefix never engages the registry-
    // existence gate (`store.get(pattern)`), because the gate keys off the
    // target *type* being registered - so the type schema must be
    // registered too for this control to pin real enforcement.
    function registerTargetType(gts: GTS, targetId: string) {
      gts.register({
        $id: `gts://${targetId}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { id: { type: 'string' } },
      });
    }

    test('control: a correctly-prefixed ref through a local $ref into definitions validates', () => {
      const gts = new GTS();
      const holderId = 'gts.x.test5_localref_ctl._.holder.v1~';
      const targetId = 'gts.x.test5_localref_ctl._.target.v1~';
      registerHolder(gts, holderId, targetId);
      // See the implicit-object control test above: the referenced entity
      // must actually be registered for the registry-existence check.
      registerTargetType(gts, targetId);
      gts.register({ id: `${targetId}x.vendor._.good.v1` });
      gts.register({
        id: `${holderId}x.vendor._.good.v1`,
        ref: `${targetId}x.vendor._.good.v1`,
      });
      const result = gts.validateInstance(`${holderId}x.vendor._.good.v1`);
      expect(result.ok).toBe(true);
    });

    test('a correctly-prefixed ref reached only through a local $ref into definitions is rejected when the target instance is not registered (registry-existence check actually engages)', () => {
      const gts = new GTS();
      const holderId = 'gts.x.test5_localref_ctl_neg._.holder.v1~';
      const targetId = 'gts.x.test5_localref_ctl_neg._.target.v1~';
      registerHolder(gts, holderId, targetId);
      // The type is registered, but the referenced instance is not.
      registerTargetType(gts, targetId);
      gts.register({
        id: `${holderId}x.vendor._.good.v1`,
        ref: `${targetId}x.vendor._.nonexistent.v1`,
      });
      const result = gts.validateInstance(`${holderId}x.vendor._.good.v1`);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found in registry/);
    });

    test('a mis-prefixed ref reached only through a local $ref into definitions is rejected', () => {
      const gts = new GTS();
      const holderId = 'gts.x.test5_localref._.holder.v1~';
      const targetId = 'gts.x.test5_localref._.target.v1~';
      registerHolder(gts, holderId, targetId);
      gts.register({
        id: `${holderId}x.vendor._.bad.v1`,
        ref: 'gts.x.test5_localref._.other_target.v1~x.vendor._.bad.v1',
      });
      const result = gts.validateInstance(`${holderId}x.vendor._.bad.v1`);
      // TODO(phase-5): fails today - visitInstance has no `$ref` handling at
      // all, so `properties.ref` = `{ $ref: '#/definitions/TargetRef' }`
      // is never resolved into the `TargetRef` definition that actually
      // carries `x-gts-ref` (result.ok is true today).
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/does not match pattern/);
    });
  });

  describe('canonical: TestCaseXGtsRef_RootLocalReference - recursive $ref: "#" at the root', () => {
    // "A bare $ref: '#' must traverse the complete root schema ... a
    // recursive child points to the root document itself, and the nested
    // x-gts-ref must still be validated."
    function registerRoot(gts: GTS, rootId: string, targetId: string) {
      gts.register({
        $id: `gts://${rootId}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          id: { type: 'string' },
          link: { type: 'string', 'x-gts-ref': targetId },
          child: { $ref: '#' },
        },
        additionalProperties: false,
      });
    }

    // See the implicit-object control test above: registering only an
    // *instance* under the target prefix never engages the registry-
    // existence gate (`store.get(pattern)`), because the gate keys off the
    // target *type* being registered - so the type schema must be
    // registered too for this control to pin real enforcement.
    function registerTargetType(gts: GTS, targetId: string) {
      gts.register({
        $id: `gts://${targetId}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { id: { type: 'string' } },
      });
    }

    test('control: a correctly-prefixed nested link through a root $ref: "#" validates', () => {
      const gts = new GTS();
      const rootId = 'gts.x.test5_rootref_ctl._.holder.v1~';
      const targetId = 'gts.x.test5_rootref_ctl._.target.v1~';
      registerRoot(gts, rootId, targetId);
      // See the implicit-object control test above: the referenced entity
      // must actually be registered for the registry-existence check.
      registerTargetType(gts, targetId);
      gts.register({ id: `${targetId}x.vendor._.good.v1` });
      gts.register({
        id: `${rootId}x.vendor._.good.v1`,
        child: { link: `${targetId}x.vendor._.good.v1` },
      });
      const result = gts.validateInstance(`${rootId}x.vendor._.good.v1`);
      expect(result.ok).toBe(true);
    });

    test('a correctly-prefixed nested link through a root $ref: "#" is rejected when the target instance is not registered (registry-existence check actually engages)', () => {
      const gts = new GTS();
      const rootId = 'gts.x.test5_rootref_ctl_neg._.holder.v1~';
      const targetId = 'gts.x.test5_rootref_ctl_neg._.target.v1~';
      registerRoot(gts, rootId, targetId);
      // The type is registered, but the referenced instance is not.
      registerTargetType(gts, targetId);
      gts.register({
        id: `${rootId}x.vendor._.good.v1`,
        child: { link: `${targetId}x.vendor._.nonexistent.v1` },
      });
      const result = gts.validateInstance(`${rootId}x.vendor._.good.v1`);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found in registry/);
    });

    test('a mis-prefixed nested link reached only through a root $ref: "#" is rejected', () => {
      const gts = new GTS();
      const rootId = 'gts.x.test5_rootref._.holder.v1~';
      const targetId = 'gts.x.test5_rootref._.target.v1~';
      registerRoot(gts, rootId, targetId);
      gts.register({
        id: `${rootId}x.vendor._.bad.v1`,
        child: { link: 'gts.x.test5_rootref._.other_target.v1~x.vendor._.bad.v1' },
      });
      const result = gts.validateInstance(`${rootId}x.vendor._.bad.v1`);
      // TODO(phase-5): fails today for the same reason as the local-$ref
      // case above - visitInstance never follows `$ref`, so `child`'s
      // nested `link` (reachable only by re-entering the root schema via
      // `$ref: "#"`) is never visited (result.ok is true today).
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/does not match pattern/);
    });

    // Cycle-safety: a recursive `$ref: "#"` gives an unbounded-depth instance
    // shape. This test was ORIGINALLY written before `$ref` following
    // existed, and only asserted "does not hang" - a VACUOUS pass, since
    // the pre-Phase-5 validator satisfied it by never attempting the
    // recursive traversal in the first place. Now that `visitInstance`
    // actually follows `$ref: "#"` (bounded by `MAX_SCHEMA_DEPTH` /
    // `MAX_SCHEMA_PATHS`, src/types.ts), this is strengthened to assert the
    // real behavior: a *finite*, well-under-budget recursive shape must
    // still traverse correctly and reach the nested x-gts-ref check (proven
    // by registering the deep target and expecting `ok: true`, not merely
    // "some result came back").
    test('a self-referential root schema traverses correctly (finite depth, well under budget)', () => {
      const gts = new GTS();
      const rootId = 'gts.x.test5_rootref_cycle._.holder.v1~';
      const targetId = 'gts.x.test5_rootref_cycle._.target.v1~';
      registerRoot(gts, rootId, targetId);
      // See the control test above: the target type must be registered too
      // for the registry-existence check to actually engage.
      registerTargetType(gts, targetId);
      gts.register({ id: `${targetId}x.vendor._.deep.v1` });
      gts.register({
        id: `${rootId}x.vendor._.deep.v1`,
        // Nest several levels through the recursive `child: { $ref: '#' }`
        // shape to exercise repeated re-entry into the root schema.
        child: { child: { child: { child: { link: `${targetId}x.vendor._.deep.v1` } } } },
      });
      const start = Date.now();
      const result = gts.validateInstance(`${rootId}x.vendor._.deep.v1`);
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(2000);
      expect(result.ok).toBe(true);
    });

    // The genuine cycle-safety case the test above could not yet exercise:
    // an instance nested deeper than `MAX_SCHEMA_DEPTH` through the
    // recursive `child: { $ref: '#' }` shape. This must fail closed with a
    // bounded error - not hang, and not silently stop traversing and report
    // no violation - the same contract `resolveTraitSchemaRefs` /
    // `resolveSchemaFully` (src/store.ts) already guarantee for their own
    // $ref/allOf recursion.
    test('an instance nested deeper than MAX_SCHEMA_DEPTH through recursive $ref: "#" fails closed with a bounded error, not a hang', () => {
      const gts = new GTS();
      const rootId = 'gts.x.test5_rootref_toodeep._.holder.v1~';
      const targetId = 'gts.x.test5_rootref_toodeep._.target.v1~';
      registerRoot(gts, rootId, targetId);
      gts.register({ id: `${targetId}x.vendor._.deep.v1` });

      // Build an instance nested one level deeper than MAX_SCHEMA_DEPTH
      // through the recursive `child` shape.
      let deep: any = { link: `${targetId}x.vendor._.deep.v1` };
      for (let i = 0; i < MAX_SCHEMA_DEPTH + 1; i++) {
        deep = { child: deep };
      }
      gts.register({ id: `${rootId}x.vendor._.deep.v1`, ...deep });

      const start = Date.now();
      const result = gts.validateInstance(`${rootId}x.vendor._.deep.v1`);
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(2000);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(new RegExp(`nests deeper than ${MAX_SCHEMA_DEPTH} levels`));
    });
  });
});

describe('x-gts-ref schema existence traversal', () => {
  const missingStore = { get: () => undefined };

  test('does not interpret annotation data as a nested schema', () => {
    const errors = new XGtsRefValidator(missingStore).validateSchemaRefExistence({
      default: { 'x-gts-ref': 'not-a-gts-id' },
      const: { 'x-gts-ref': 'gts.x.unit.xref.annotation.v1~' },
      examples: [{ 'x-gts-ref': 42 }],
    });

    expect(errors).toHaveLength(0);

    const gts = new GTS();
    const id = 'gts.x.unit.xref.annotation_holder.v1~';
    gts.register({
      $id: `gts://${id}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          default: { 'x-gts-ref': 'not-a-gts-id' },
          const: { 'x-gts-ref': 'gts.x.unit.xref.annotation.v1~' },
          examples: [{ 'x-gts-ref': 42 }],
        },
      },
    });
    expect(gts.validateSchemaAgainstParent(id).ok).toBe(true);
  });

  test('checks the schema of a property named x-gts-ref', () => {
    const schema = {
      properties: {
        'x-gts-ref': {
          type: 'string',
          'x-gts-ref': 'gts.x.unit.xref.property.v1~',
        },
      },
    };
    const validator = new XGtsRefValidator(missingStore);
    expect(validator.validateSchema(schema)).toHaveLength(0);
    const errors = validator.validateSchemaRefExistence(schema);

    expect(errors).toHaveLength(1);
    expect(errors[0].fieldPath).toBe('properties/x-gts-ref/x-gts-ref');
  });

  test('checks a concrete constraint type resolved through a relative pointer', () => {
    const constraintType = 'gts.x.unit.xref.relative_target.v1~';
    const schema = {
      'x-gts-traits-schema': {
        constraintType,
        properties: {
          link: { type: 'string', 'x-gts-ref': '/x-gts-traits-schema/constraintType' },
        },
      },
    };
    const validator = new XGtsRefValidator(missingStore);
    const errors = validator.validateSchemaRefExistence(schema);

    expect(errors).toHaveLength(1);
    expect(errors[0].refPattern).toBe(constraintType);
  });

  test('rejects a relative constraint pointer that resolves nowhere', () => {
    const errors = new XGtsRefValidator(missingStore).validateSchemaRefExistence({
      properties: {
        link: { type: 'string', 'x-gts-ref': '/missing' },
      },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/does not resolve to a string/);
  });

  test('rejects a relative constraint pointer that resolves to a non-string', () => {
    const errors = new XGtsRefValidator(missingStore).validateSchemaRefExistence({
      examples: ['not-a-constraint-type'],
      properties: {
        link: { type: 'string', 'x-gts-ref': '/examples' },
      },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/does not resolve to a string/);
  });
});

// P5-R2 - `visitInstance` (src/x-gts-ref.ts) must fail closed when a
// `$ref` it is asked to follow does not resolve to a usable schema, rather
// than silently `return`ing and reporting no violation. Two distinct
// failure modes are covered: the pointer resolves nowhere at all
// (`resolveSchemaRef` returns `null`), and the pointer resolves to
// something that exists but is not usable as a schema (a non-object, such
// as a `default` value or an array entry).
//
// These exercise `XGtsRefValidator` directly (not through `GTS.register` /
// `store.validateInstance`) because Ajv itself eagerly resolves every
// `$ref` at schema-compile time and would reject a genuinely dangling
// pointer before `XGtsRefValidator` ever ran - the bug this finding is
// about lives in `XGtsRefValidator`'s own, independent local-pointer
// resolution (`resolveSchemaRef`), which is what `validateInstance` calls
// directly, unit-style, in these tests.
describe('P5-R2 - $ref resolution fails closed instead of silently skipping the subtree', () => {
  test('a $ref pointing at a nonexistent location in the schema fails closed, not silently open', () => {
    const errors = new XGtsRefValidator().validateInstance(
      { ref: 'totally-not-a-gts-id' },
      {
        type: 'object',
        properties: { ref: { $ref: '#/definitions/Nope' } },
        definitions: {
          TargetRef: { type: 'string', 'x-gts-ref': 'gts.x.probe._.target.v1~' },
        },
      }
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/Cannot resolve \$ref '#\/definitions\/Nope' for x-gts-ref traversal/);
    expect(errors[0].refPattern).toBe('');
  });

  test('a $ref pointing at a non-schema value (e.g. into a "default") fails closed, not silently open', () => {
    const errors = new XGtsRefValidator().validateInstance(
      { ref: 'totally-not-a-gts-id' },
      {
        type: 'object',
        properties: { ref: { $ref: '#/definitions/TargetRef/default' } },
        definitions: {
          TargetRef: {
            type: 'string',
            default: 'example-default',
            'x-gts-ref': 'gts.x.probe._.target.v1~',
          },
        },
      }
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(
      /Cannot resolve \$ref '#\/definitions\/TargetRef\/default' for x-gts-ref traversal/
    );
    expect(errors[0].refPattern).toBe('');
  });

  test('a $ref pointing at an array (e.g. a "oneOf" list itself, not an element) fails closed, not silently open', () => {
    const errors = new XGtsRefValidator().validateInstance(
      { ref: 'totally-not-a-gts-id' },
      {
        type: 'object',
        properties: { ref: { $ref: '#/oneOf' } },
        oneOf: [{ type: 'string' }, { type: 'number' }],
      }
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/Cannot resolve \$ref '#\/oneOf' for x-gts-ref traversal/);
    expect(errors[0].refPattern).toBe('');
  });
});

describe('entity content hash caching', () => {
  test('hashes unique entries lazily and caches the stored hash after re-submission', () => {
    const store = new GtsStore();
    const id = 'gts.x.unit.hash.cache.v1~x.unit._.item.v1';
    store.register(createJsonEntity({ id, value: 'same' }));

    expect(store['contentHashes'].has(id)).toBe(false);

    store.register(createJsonEntity({ value: 'same', id }));
    const cached = store['contentHashes'].get(id);
    expect(cached).toBeDefined();

    store.register(createJsonEntity({ id, value: 'same' }));
    expect(store['contentHashes'].get(id)).toBe(cached);
  });

  test('does not add an identical schema to Ajv twice', () => {
    const store = new GtsStore();
    const content = {
      $id: 'gts://gts.x.unit.hash.schema.v1~',
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
    };
    const addSchema = jest.spyOn(store['ajv'], 'addSchema');

    store.register(createJsonEntity(content));
    store.register(createJsonEntity({ type: 'object', $schema: content.$schema, $id: content.$id }));

    expect(addSchema).toHaveBeenCalledTimes(1);
  });

  test('revalidates references for identical content', () => {
    const store = new GtsStore({ validateRefs: true });
    const targetId = 'gts.x.unit.hash.target.v1~';
    const hostId = 'gts.x.unit.hash.host.v1~';
    const target = createJsonEntity({ $id: `gts://${targetId}`, $schema: 'http://json-schema.org/draft-07/schema#' });
    const host = createJsonEntity({
      $id: `gts://${hostId}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      $ref: `gts://${targetId}`,
    });

    store.register(target);
    store.register(host);
    store.unregister(targetId);

    expect(() => store.register(createJsonEntity(host.content))).toThrow(`Unresolved reference: ${targetId}`);
  });
});
