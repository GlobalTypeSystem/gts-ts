import { GTS, isValidGtsID, validateGtsID, parseGtsID, matchIDPattern, idToUUID, extractID } from '../src';

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
      expect(result.is_schema).toBe(false);
    });

    test('extracts GTS ID from schema', () => {
      const schema = {
        $$id: 'gts.vendor.pkg.ns.type.v1~',
        $$schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {},
      };

      const result = extractID(schema);
      expect(result.id).toBe('gts.vendor.pkg.ns.type.v1~');
      expect(result.is_schema).toBe(true);
    });

    test('handles GTS URI prefix', () => {
      const schema = {
        $id: 'gts://gts.vendor.pkg.ns.type.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
      };

      const result = extractID(schema);
      expect(result.id).toBe('gts.vendor.pkg.ns.type.v1~');
      expect(result.is_schema).toBe(true);
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
        $$id: 'gts.test.pkg.ns.person.v1~',
        $$schema: 'http://json-schema.org/draft-07/schema#',
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
        $$id: 'gts.test.pkg.ns.person.v1~',
        $$schema: 'http://json-schema.org/draft-07/schema#',
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
    test('checks backward compatibility', () => {
      const schemaV1 = {
        $$id: 'gts.test.pkg.ns.person.v1~',
        $$schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      };

      const schemaV2 = {
        $$id: 'gts.test.pkg.ns.person.v2~',
        $$schema: 'http://json-schema.org/draft-07/schema#',
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
      expect(result.is_fully_compatible).toBe(true);
    });

    test('detects incompatible changes', () => {
      const schemaV1 = {
        $$id: 'gts.test.pkg.ns.person.v1~',
        $$schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      };

      const schemaV2 = {
        $$id: 'gts.test.pkg.ns.person.v2~',
        $$schema: 'http://json-schema.org/draft-07/schema#',
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

  describe('OP#9 - Version Casting', () => {
    test('casts instance between compatible versions', () => {
      const schemaV1 = {
        $$id: 'gts.test.pkg.ns.person.v1~',
        $$schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      };

      const schemaV2 = {
        $$id: 'gts.test.pkg.ns.person.v2~',
        $$schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          email: { type: 'string', default: '' },
        },
        required: ['name'],
      };

      const instance = {
        gtsId: 'gts.test.pkg.ns.person.v1~test.pkg.ns.john.v1.0',
        $schema: 'gts.test.pkg.ns.person.v1~',
        name: 'John',
        age: 30,
      };

      gts.register(schemaV1);
      gts.register(schemaV2);
      gts.register(instance);

      const result = gts.castInstance('gts.test.pkg.ns.person.v1~test.pkg.ns.john.v1.0', 'gts.test.pkg.ns.person.v2~');

      expect(result.ok).toBe(true);
      expect(result.result).toBeDefined();
      expect(result.result.gtsId).toContain('v2');
      expect(result.result.email).toBe('');
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
      const instance = {
        gtsId: 'gts.test.pkg.ns.person.v1.0',
        name: 'John Doe',
        address: {
          city: 'New York',
          country: 'USA',
        },
      };

      gts.register(instance);

      const nameResult = gts.getAttribute('gts.test.pkg.ns.person.v1.0@name');
      expect(nameResult.resolved).toBe(true);
      expect(nameResult.value).toBe('John Doe');

      const cityResult = gts.getAttribute('gts.test.pkg.ns.person.v1.0@address.city');
      expect(cityResult.resolved).toBe(true);
      expect(cityResult.value).toBe('New York');

      const missingResult = gts.getAttribute('gts.test.pkg.ns.person.v1.0@missing');
      expect(missingResult.resolved).toBe(false);
    });
  });

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
      expect(result.is_schema).toBe(true);
    });

    test('does not detect schema without $schema field', () => {
      const notSchema = {
        $id: 'gts.vendor.pkg.ns.type.v1~',
        type: 'object',
        properties: {},
      };
      const result = extractID(notSchema);
      expect(result.is_schema).toBe(false);
    });

    test('detects schema with GTS $schema reference', () => {
      const schema = {
        $id: 'gts.vendor.pkg.ns.derived.v1~',
        $schema: 'gts://gts.vendor.pkg.ns.type.v1~',
        type: 'object',
      };
      const result = extractID(schema);
      expect(result.is_schema).toBe(true);
    });
  });

  describe('OP#14 - Schema ID Extraction (v0.7)', () => {
    test('extracts schema_id from chain for instances without explicit schema field', () => {
      const instance = {
        gtsId: 'gts.vendor.pkg.ns.type.v1~vendor.pkg.ns.instance.v1.0',
        data: 'test',
      };
      const result = extractID(instance);
      // v0.7: schema_id is extracted from the chain
      expect(result.schema_id).toBe('gts.vendor.pkg.ns.type.v1~');
    });

    test('extracts schema_id from chained instance ID', () => {
      const instance = {
        gtsId: 'gts.vendor.pkg.ns.type.v1~vendor.pkg.ns.instance.v1.0',
        $schema: 'gts.vendor.pkg.ns.type.v1~',
        data: 'test',
      };
      const result = extractID(instance);
      expect(result.schema_id).toBe('gts.vendor.pkg.ns.type.v1~');
    });

    test('extracts parent type from derived schema chain', () => {
      const schema = {
        $id: 'gts.x.core.events.type.v1~x.commerce.orders.order_placed.v1.0~',
        $schema: 'gts://gts.x.core.events.type.v1~',
        type: 'object',
      };
      const result = extractID(schema);
      expect(result.schema_id).toBe('gts.x.core.events.type.v1~');
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
