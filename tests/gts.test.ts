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
import { MAX_REGEX_EXPANDED_LENGTH } from '../src/regex-profile';
import { GtsSchemaError, X_GTS_REF_SELF, XGtsRefValidator } from '../src/x-gts-ref';

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

  describe('OP#12 - one JSON Schema dialect per derivation hierarchy', () => {
    // The root Type Schema selects the dialect for every descendant in its
    // chained `$id` hierarchy and every transitive `gts://` `$ref` target.
    // Mismatches are rejected explicitly instead of being silently interpreted
    // under whichever Ajv instance happens to compile the effective schema.
    test.each([
      ['unknown', 'https://example.invalid/not-a-json-schema-dialect'],
      ['mistyped', 'https://json-schema.org/draft/2020-21/schema'],
    ])('a schema declaring an %s dialect is rejected', (_label, dialect) => {
      const id = `gts.test.pkg.ns.invalid_dialect_${_label}.v1~`;
      gts.register({ $id: id, $schema: dialect, type: 'object' });

      const result = gts.validateEntity(id);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Unsupported JSON Schema dialect');
    });

    test('a local ref to an embedded resource in another dialect is rejected', () => {
      const id = 'gts.test.pkg.ns.embedded_dialect.v1~';
      gts.register({
        $id: id,
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { legacy: { $ref: '#/$defs/legacy' } },
        $defs: {
          legacy: {
            $id: 'legacy',
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'string',
          },
        },
      });

      const result = gts.validateEntity(id);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('local $ref target');
    });

    test('a draft-07 child deriving via allOf+$ref from a 2020-12 parent is rejected clearly', () => {
      gts.register({
        $id: 'gts.test.pkg.ns.mdparent.v1~',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
      });
      gts.register({
        $id: 'gts.test.pkg.ns.mdparent.v1~test.pkg._.mdchild.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
        allOf: [{ $ref: 'gts://gts.test.pkg.ns.mdparent.v1~' }],
      });

      const schemaResult = gts.validateEntity('gts.test.pkg.ns.mdparent.v1~test.pkg._.mdchild.v1~');
      expect(schemaResult.ok).toBe(false);
      expect(schemaResult.error).toContain('mixes JSON Schema dialects');
    });

    test('an instance of a mixed-dialect child is rejected clearly, not silently invalid', () => {
      gts.register({
        $id: 'gts.test.pkg.ns.mdparent2.v1~',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
      });
      gts.register({
        $id: 'gts.test.pkg.ns.mdparent2.v1~test.pkg._.mdchild2.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
        allOf: [{ $ref: 'gts://gts.test.pkg.ns.mdparent2.v1~' }],
      });
      // An instance that is valid against the child on its own - pre-fix the
      // unresolvable cross-dialect `$ref` made the compile throw and reported
      // this valid instance as invalid with an opaque message.
      gts.register({
        gtsId: 'gts.test.pkg.ns.mdparent2.v1~test.pkg._.mdchild2.v1~test.pkg._.item.v1.0',
        $schema: 'gts.test.pkg.ns.mdparent2.v1~test.pkg._.mdchild2.v1~',
        a: 'ok',
      });

      const result = gts.validateInstance('gts.test.pkg.ns.mdparent2.v1~test.pkg._.mdchild2.v1~test.pkg._.item.v1.0');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('mixes JSON Schema dialects');
    });

    test('a single-dialect chain still validates normally', () => {
      gts.register({
        $id: 'gts.test.pkg.ns.sdparent.v1~',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
      });
      gts.register({
        $id: 'gts.test.pkg.ns.sdparent.v1~test.pkg._.sdchild.v1~',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
        allOf: [{ $ref: 'gts://gts.test.pkg.ns.sdparent.v1~' }],
      });
      gts.register({
        gtsId: 'gts.test.pkg.ns.sdparent.v1~test.pkg._.sdchild.v1~test.pkg._.item.v1.0',
        $schema: 'gts.test.pkg.ns.sdparent.v1~test.pkg._.sdchild.v1~',
        a: 'ok',
      });

      expect(gts.validateInstance('gts.test.pkg.ns.sdparent.v1~test.pkg._.sdchild.v1~test.pkg._.item.v1.0').ok).toBe(
        true
      );
    });

    test('a redeclaration-form child in a different dialect than its root is rejected', () => {
      // The root Type Schema selects one dialect for the complete chained `$id`
      // hierarchy. Re-declaring inherited fields instead of using `$ref` does
      // not permit a descendant to change that dialect.
      gts.register({
        $id: 'gts.test.pkg.ns.rdparent.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
      });
      gts.register({
        $id: 'gts.test.pkg.ns.rdparent.v1~test.pkg._.rdchild.v1~',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
      });
      gts.register({
        gtsId: 'gts.test.pkg.ns.rdparent.v1~test.pkg._.rdchild.v1~test.pkg._.item.v1.0',
        $schema: 'gts.test.pkg.ns.rdparent.v1~test.pkg._.rdchild.v1~',
        a: 'ok',
      });

      const schemaResult = gts.validateEntity('gts.test.pkg.ns.rdparent.v1~test.pkg._.rdchild.v1~');
      const instanceResult = gts.validateInstance(
        'gts.test.pkg.ns.rdparent.v1~test.pkg._.rdchild.v1~test.pkg._.item.v1.0'
      );
      expect(schemaResult.ok).toBe(false);
      expect(schemaResult.error).toContain('derivation chain mixes JSON Schema dialects');
      expect(instanceResult.ok).toBe(false);
      expect(instanceResult.error).toContain('derivation chain mixes JSON Schema dialects');
    });

    test('a dialect mismatch reached transitively through a parent $ref is rejected', () => {
      // Grandparent (draft-07) <- parent (2020-12, allOf+$ref grandparent) <-
      // child (2020-12, allOf+$ref parent). The child's direct `$ref` matches
      // its own dialect, but following the parent's `$ref` composes the
      // draft-07 grandparent into the child's 2020-12 validation, so the
      // mismatch must still be caught.
      gts.register({
        $id: 'gts.test.pkg.ns.tgp.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
      });
      gts.register({
        $id: 'gts.test.pkg.ns.tgp.v1~test.pkg._.tparent.v1~',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
        allOf: [{ $ref: 'gts://gts.test.pkg.ns.tgp.v1~' }],
      });
      gts.register({
        $id: 'gts.test.pkg.ns.tgp.v1~test.pkg._.tparent.v1~test.pkg._.tchild.v1~',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
        allOf: [{ $ref: 'gts://gts.test.pkg.ns.tgp.v1~test.pkg._.tparent.v1~' }],
      });

      const result = gts.validateEntity('gts.test.pkg.ns.tgp.v1~test.pkg._.tparent.v1~test.pkg._.tchild.v1~');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('mixes JSON Schema dialects');
    });

    test('a cross-dialect $ref on an ancestor is rejected even when the descendant does not reference it', () => {
      // Issue C: the ancestor `base` (draft-07) references a 2020-12 schema; the
      // descendant `child` derives by re-declaration and references neither the
      // ancestor nor the 2020-12 target. A leaf-only reference walk accepts the
      // child; validating the whole chain closure must reject it.
      gts.register({
        $id: 'gts.test.pkg.ns.ancforeign.v1~',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { note: { type: 'string' } },
      });
      gts.register({
        $id: 'gts.test.pkg.ns.ancbase.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { ext: { $ref: 'gts://gts.test.pkg.ns.ancforeign.v1~' } },
      });
      gts.register({
        $id: 'gts.test.pkg.ns.ancbase.v1~test.pkg._.ancchild.v1~',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { label: { type: 'string' } },
      });
      gts.register({
        gtsId: 'gts.test.pkg.ns.ancbase.v1~test.pkg._.ancchild.v1~test.pkg._.item.v1.0',
        $schema: 'gts.test.pkg.ns.ancbase.v1~test.pkg._.ancchild.v1~',
        label: 'ok',
      });

      const schemaResult = gts.validateEntity('gts.test.pkg.ns.ancbase.v1~test.pkg._.ancchild.v1~');
      const instanceResult = gts.validateInstance(
        'gts.test.pkg.ns.ancbase.v1~test.pkg._.ancchild.v1~test.pkg._.item.v1.0'
      );
      expect(schemaResult.ok).toBe(false);
      expect(schemaResult.error).toContain('mixes JSON Schema dialects');
      expect(instanceResult.ok).toBe(false);
      expect(instanceResult.error).toContain('mixes JSON Schema dialects');
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

    // Regression for the indexed wildcard lookup: its binary-search prefix
    // used to be cut at a literal string boundary, so a version token in a
    // non-final segment made it miss version-flexible matches that the
    // authoritative `matchIDPattern` scan accepts (a major-only segment
    // matches any minor). The indexed result MUST equal a brute-force linear
    // scan for every pattern, especially these version-flexible ones.
    test('indexed wildcard query matches a linear matchIDPattern scan for version-flexible patterns', () => {
      const store = new GtsStore();
      const ids = [
        'gts.x.pkg.ns.base.v1~x.pkg.ns.item.v1~',
        'gts.x.pkg.ns.base.v1.2~x.pkg.ns.item.v1~',
        'gts.x.pkg.ns.base.v1.5~x.pkg.ns.other.v2~',
        'gts.x.pkg.ns.base.v2~x.pkg.ns.item.v1~',
        'gts.x.pkg.ns.other.v1~x.pkg.ns.item.v1~',
      ];
      for (const id of ids) store.register(createJsonEntity({ $id: `gts://${id}` }));

      const patterns = [
        'gts.x.pkg.ns.base.v1~x.pkg.ns.*',
        'gts.x.pkg.ns.base.v1.2~x.pkg.ns.*',
        'gts.x.pkg.ns.base.v1~x.pkg.ns.item.v1~*',
        'gts.x.pkg.ns.*',
        'gts.x.pkg.ns.base.v2~*',
      ];
      for (const pattern of patterns) {
        const indexed = store.query(pattern).sort();
        const linear = ids.filter((id) => matchIDPattern(id, pattern).match).sort();
        expect(indexed).toEqual(linear);
      }

      // Concretely: the version-flexible first segment must surface BOTH the
      // `v1` and the `v1.2` base entities, which the old prefix dropped.
      expect(store.query('gts.x.pkg.ns.base.v1~x.pkg.ns.*')).toEqual(
        expect.arrayContaining(['gts.x.pkg.ns.base.v1~x.pkg.ns.item.v1~', 'gts.x.pkg.ns.base.v1.2~x.pkg.ns.item.v1~'])
      );
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

  // Reference keyword combinator tests (oneOf/anyOf/allOf) are in the canonical gts-spec test suite

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
    test('rejects a missing concrete x-gts-instance-ref target reached through a local $ref', () => {
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
            'x-gts-instance-ref': 'gts.x.test12.xrefmissing.target.v1~',
          },
        },
      });

      const result = gts.validateSchemaAgainstParent(id);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        "/definitions/TargetRef/x-gts-instance-ref constrains values to 'gts.x.test12.xrefmissing.target.v1~', which is not a registered GTS entity"
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

// Phase 5 - entity-reference traversal shapes
// (spec canonical suite: .gts-spec/tests/test_refimpl_x_gts_ref.py,
// TestCaseXGtsRef_ImplicitObjectAndLocalRef / TestCaseXGtsRef_RootLocalReference).
//
// The reference keywords are Ajv keywords, so they apply wherever the JSON
// Schema engine applies a subschema: without an explicit `type: object`,
// through a local `$ref` into definitions, and through a root `$ref: "#"`.
describe('Phase 5 - entity-reference traversal (implicit object, local $ref, root $ref)', () => {
  describe('canonical: TestCaseXGtsRef_ImplicitObjectAndLocalRef (a) - implicit object', () => {
    // The holder schema never declares `type: "object"` - only `required`,
    // `properties` and `additionalProperties: false` - yet the reference on
    // `properties.ref` must still be enforced.
    function registerHolder(gts: GTS, holderId: string, targetId: string) {
      gts.register({
        $id: `gts://${holderId}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        required: ['id', 'ref'],
        properties: {
          id: { type: 'string' },
          ref: { type: 'string', 'x-gts-instance-ref': targetId },
        },
        additionalProperties: false,
      });
    }

    // Under the default `any-valid` policy the concrete operand must name a
    // registered, valid type, so the target type schema is registered too.
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
      // The referenced type and instance must be registered and valid.
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
          TargetRef: { type: 'string', 'x-gts-instance-ref': targetId },
        },
        additionalProperties: false,
      });
    }

    // See the implicit-object control test above: the operand type must be
    // registered too.
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
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/does not match pattern/);
    });
  });

  describe('canonical: TestCaseXGtsRef_RootLocalReference - recursive $ref: "#" at the root', () => {
    // "A bare $ref: '#' must traverse the complete root schema ... a
    // recursive child points to the root document itself, and the nested
    // reference must still be validated."
    function registerRoot(gts: GTS, rootId: string, targetId: string) {
      gts.register({
        $id: `gts://${rootId}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          id: { type: 'string' },
          link: { type: 'string', 'x-gts-instance-ref': targetId },
          child: { $ref: '#' },
        },
        additionalProperties: false,
      });
    }

    // See the implicit-object control test above: the operand type must be
    // registered too.
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
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/does not match pattern/);
    });

    // Cycle-safety: a recursive `$ref: "#"` gives an unbounded-depth instance
    // shape; a finite recursive shape must still reach the nested reference
    // check (the deep target is registered, so the result is `ok: true`).
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

    // Recursion through `child: { $ref: '#' }` is evaluated by the JSON Schema
    // engine, so a reference nested deeper than MAX_SCHEMA_DEPTH is still
    // checked - here it names an unregistered target and must fail.
    test('a reference nested deeper than MAX_SCHEMA_DEPTH through recursive $ref: "#" is still checked', () => {
      const gts = new GTS();
      const rootId = 'gts.x.test5_rootref_toodeep._.holder.v1~';
      const targetId = 'gts.x.test5_rootref_toodeep._.target.v1~';
      registerRoot(gts, rootId, targetId);
      registerTargetType(gts, targetId);

      let deep: any = { link: `${targetId}x.vendor._.missing.v1` };
      for (let i = 0; i < MAX_SCHEMA_DEPTH + 1; i++) {
        deep = { child: deep };
      }
      gts.register({ id: `${rootId}x.vendor._.deep.v1`, ...deep });

      const start = Date.now();
      const result = gts.validateInstance(`${rootId}x.vendor._.deep.v1`);
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(2000);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found in registry/);
    });
  });

  describe('store hardening', () => {
    test('rejects an over-length schema pattern without registering the schema', () => {
      const store = new GtsStore();
      const id = 'gts.x.security.regex.unsafe.v1~';
      expect(() =>
        store.register(
          createJsonEntity({
            $id: `gts://${id}`,
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'string',
            pattern: 'a'.repeat(MAX_REGEX_EXPANDED_LENGTH + 1),
          })
        )
      ).toThrow(/expanded length above 4096/);
      expect(store.get(id)).toBeUndefined();
    });

    test('does not clobber a registered schema when a replacement trips the safety check', () => {
      // The over-length-pattern replacement is rejected by
      // `assertSafeSchemaPatterns` BEFORE any Ajv call and before `byId` is
      // mutated, so the previously registered content survives intact. (This
      // does NOT reach the Ajv compile-failure catch branch - that path is
      // covered by the test below.)
      const id = 'gts.x.security.regex.rollback.v1~';
      const store = new GtsStore({ allowEntityUpdates: true });
      store.register(
        createJsonEntity({
          $id: `gts://${id}`,
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'string',
          pattern: '^a+$',
        })
      );
      expect(() =>
        store.register(
          createJsonEntity({
            $id: `gts://${id}`,
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'string',
            pattern: 'a'.repeat(MAX_REGEX_EXPANDED_LENGTH + 1),
          })
        )
      ).toThrow(/expanded length above 4096/);
      expect(store.get(id)?.content.pattern).toBe('^a+$');
    });

    test('rolls the engine registration back when a replacement passes the safety check but fails to compile', () => {
      // Exercises the `try { addEngineSchema } catch { removeEngineSchema }` branch:
      // the replacement carries no `pattern`/`patternProperties` (so it clears
      // `assertSafeSchemaPatterns`) but declares an unsupported `$schema`
      // dialect, which makes `addEngineSchema` throw. Registration must NOT throw
      // - the failure is swallowed so the entity is still stored in `byId` -
      // and the aborted engine registration must be rolled back rather than left
      // half-added (`validateSchema` recompiles and surfaces the failure on
      // demand).
      const id = 'gts.x.security.dialect.rollback.v1~';
      const store = new GtsStore({ allowEntityUpdates: true });
      store.register(
        createJsonEntity({
          $id: `gts://${id}`,
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'string',
        })
      );
      expect(() =>
        store.register(
          createJsonEntity({
            $id: `gts://${id}`,
            $schema: 'https://example.com/not-a-json-schema-dialect',
            type: 'string',
          })
        )
      ).not.toThrow();
      // The entity is retained (only the Ajv compile was rolled back).
      expect(store.get(id)?.content.$schema).toBe('https://example.com/not-a-json-schema-dialect');
    });

    test('matches a catastrophic-backtracking pattern in linear time (ReDoS immunity)', () => {
      // `pattern` / `patternProperties` are compiled by Ajv with RE2's
      // linear-time engine, so a classic catastrophic pattern resolves fast on
      // an adversarial input instead of hanging. On the backtracking platform
      // `RegExp` this input would pin a CPU for many seconds; a generous budget
      // keeps the test about algorithmic blow-up (a hang), not micro-timing.
      const store = new GtsStore();
      const id = 'gts.x.security.regex.redos.v1~';
      store.register(
        createJsonEntity({
          $id: `gts://${id}`,
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'string',
          pattern: '(a+)+$',
        })
      );
      const adversarial = 'a'.repeat(50_000) + '!';
      const start = Date.now();
      const result = store.validateTransientInstance(adversarial, id, null);
      const elapsedMs = Date.now() - start;
      // The trailing '!' means it does not match, so validation fails - but the
      // point is that it *returns* quickly rather than backtracking forever.
      expect(result.ok).toBe(false);
      expect(elapsedMs).toBeLessThan(2000);
    });

    test('exposes cloned entries through the store abstraction', () => {
      const store = new GtsStore();
      const id = 'gts.x.query.entries.item.v1~x.query._.instance.v1.0';
      store.register(createJsonEntity({ gtsId: id, value: 1 }));
      const entries = store.entries();
      entries[0][1].content.value = 2;
      expect(store.get(id)?.content.value).toBe(1);
    });
  });
});

describe('reference operands at schema locations (§9.6.3)', () => {
  const validator = new XGtsRefValidator();

  test('keyword-shaped keys in literal data are not operands', () => {
    expect(
      validator.validateSchema({
        default: { 'x-gts-type-ref': 'not-a-gts-id' },
        const: { 'x-gts-instance-ref': 'gts.x.unit.xref.annotation.v1~x.unit._.a.v1~' },
        examples: [{ 'x-gts-pattern-ref': 42 }],
      })
    ).toHaveLength(0);

    const gts = new GTS();
    const id = 'gts.x.unit.xref.annotation_holder.v1~';
    gts.register({
      $id: `gts://${id}`,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          default: { 'x-gts-type-ref': 'not-a-gts-id' },
          const: { 'x-gts-ref': 'gts.x.unit.xref.annotation.v1~' },
          examples: [{ 'x-gts-pattern-ref': 42 }],
        },
      },
    });
    expect(gts.validateSchemaAgainstParent(id).ok).toBe(true);
  });

  test('checks the schema of a property named like a keyword', () => {
    const errors = validator.validateSchema({
      properties: { 'x-gts-type-ref': { type: 'string', 'x-gts-type-ref': 'not-a-gts-id' } },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].fieldPath).toBe('/properties/x-gts-type-ref/x-gts-type-ref');
    expect(errors[0].keyword).toBe('x-gts-type-ref');
  });

  test('reserves /$id and rejects every other pointer', () => {
    const schema = (operand: string) => ({
      $id: 'gts://gts.x.unit.xref.self.v1~',
      properties: { link: { type: 'string', 'x-gts-type-ref': operand } },
    });
    expect(validator.validateSchema(schema(X_GTS_REF_SELF))).toHaveLength(0);
    for (const pointer of ['/x-gts-traits-schema/constraintType', '/missing', '/$id/', './$id']) {
      const errors = validator.validateSchema(schema(pointer));
      expect(errors).toHaveLength(1);
      expect(errors[0].reason).toContain("must be a GTS identifier, a wildcard pattern or '/$id'");
    }
  });

  test('a concrete Instance ID operand is an error only for x-gts-type-ref', () => {
    const operand = 'gts.x.unit.xref.target.v1~x.unit._.item.v1';
    const schema = (keyword: string) => ({ properties: { link: { [keyword]: operand } } });
    expect(validator.validateSchema(schema('x-gts-instance-ref'))).toHaveLength(0);
    expect(validator.validateSchema(schema('x-gts-type-ref'))[0].reason).toContain('selects no GTS Type Identifiers');
  });

  test.each([
    ['2019-09', 'https://json-schema.org/draft/2019-09/schema'],
    ['2020-12', 'https://json-schema.org/draft/2020-12/schema'],
  ])('checks operands in unused definitions under %s', (_name, dialect) => {
    const errors = validator.validateSchema({
      $schema: dialect,
      definitions: { Unused: { 'x-gts-pattern-ref': 'gts.vendor*' } },
    });
    expect(errors.map((error) => error.fieldPath)).toEqual(['/definitions/Unused/x-gts-pattern-ref']);
  });

  test('checks operands reached only through a local $ref into literal data, located at their declaration', () => {
    const errors = validator.validateSchema({
      $ref: '#/x-data',
      'x-data': { not: { 'x-gts-type-ref': 'invalid' } },
    });
    expect(errors.map((error) => error.fieldPath)).toEqual(['/x-data/not/x-gts-type-ref']);

    // The reported pointer is escaped (`/` as `~1`, `~` as `~0`).
    const escaped = validator.validateSchema({
      $ref: '#/x~1data~0',
      'x/data~': { not: { 'x-gts-type-ref': 'invalid' } },
    });
    expect(escaped.map((error) => error.fieldPath)).toEqual(['/x~1data~0/not/x-gts-type-ref']);
  });

  test('validateInstance reports a schema error before evaluating data', () => {
    expect(() =>
      validator.validateInstance({}, { type: 'object', definitions: { Unused: { 'x-gts-type-ref': 'invalid' } } })
    ).toThrow(GtsSchemaError);
    expect(() =>
      validator.validateInstance({}, { type: 'object', properties: { a: { 'x-gts-type-ref': X_GTS_REF_SELF } } })
    ).toThrow(GtsSchemaError);
  });
});

test('validateInstance reports a $ref to another resource as a schema error', () => {
  const leaf = {
    $id: 'gts://gts.x.probe._.base.v1~x.probe._.leaf.v1~',
    allOf: [{ $ref: 'gts://gts.x.probe._.base.v1~' }],
    properties: { r: { type: 'string', 'x-gts-type-ref': 'gts.x.probe._.base.v1~' } },
  };
  expect(() => new XGtsRefValidator().validateInstance({ r: 'gts.x.other._.t.v1~' }, leaf)).toThrow(GtsSchemaError);
});

// P5-R2 - a `$ref` that does not resolve to a usable schema must fail closed:
// the subtree behind it cannot be shown to satisfy its reference keywords.
describe('P5-R2 - $ref resolution fails closed instead of silently skipping the subtree', () => {
  const validator = new XGtsRefValidator();
  const targetRef = { type: 'string', 'x-gts-type-ref': 'gts.x.probe._.target.v1~', default: 'example-default' };

  test('a $ref pointing at a nonexistent location in the schema fails closed', () => {
    expect(() =>
      validator.validateInstance(
        { ref: 'totally-not-a-gts-id' },
        { type: 'object', properties: { ref: { $ref: '#/definitions/Nope' } }, definitions: { TargetRef: targetRef } }
      )
    ).toThrow(/#\/definitions\/Nope/);
  });

  test('a $ref pointing at a non-schema value (e.g. into a "default") fails closed', () => {
    expect(() =>
      validator.validateInstance(
        { ref: 'totally-not-a-gts-id' },
        {
          type: 'object',
          properties: { ref: { $ref: '#/definitions/TargetRef/default' } },
          definitions: { TargetRef: targetRef },
        }
      )
    ).toThrow();
  });

  test('a $ref pointing at an array (e.g. a "oneOf" list itself, not an element) fails closed', () => {
    expect(() =>
      validator.validateInstance(
        { ref: 'totally-not-a-gts-id' },
        {
          type: 'object',
          properties: { ref: { $ref: '#/oneOf' } },
          oneOf: [{ type: 'string' }, { type: 'number' }],
        }
      )
    ).toThrow();
  });

  test('a regular expression outside the GTS profile is rejected before any data is evaluated', () => {
    expect(() =>
      validator.validateInstance(
        { ref: 'gts.x.probe._.target.v1~' },
        { properties: { ref: { type: 'string', pattern: '^(?=gts)', 'x-gts-type-ref': 'gts.*' } } }
      )
    ).toThrow();
  });
});

describe('reference keywords under JSON Schema applicators', () => {
  const validator = new XGtsRefValidator();
  const target = 'gts.x.unit.xref.array_target.v1~';

  test('uses additionalItems after Draft-07 tuple items', () => {
    const errors = validator.validateInstance(['tuple-prefix', 'gts.x.unit.xref.other.v1~'], {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'array',
      items: [{ type: 'string' }],
      additionalItems: { type: 'string', 'x-gts-type-ref': target },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].fieldPath).toBe('/1');
    expect(errors[0].keyword).toBe('x-gts-type-ref');
  });

  test('uses items only after Draft 2020-12 prefixItems', () => {
    const errors = validator.validateInstance(['tuple-prefix', 'gts.x.unit.xref.other.v1~'], {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'array',
      prefixItems: [{ type: 'string' }],
      items: { type: 'string', 'x-gts-type-ref': target },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].fieldPath).toBe('/1');
  });

  test('not inverts a candidate failure, never a schema error', () => {
    const schema = { properties: { ref: { not: { 'x-gts-type-ref': target } } } };
    expect(validator.validateInstance({ ref: 'gts.x.unit.xref.other.v1~' }, schema)).toHaveLength(0);
    expect(() =>
      validator.validateInstance({ ref: 'x' }, { properties: { ref: { not: { 'x-gts-type-ref': 'bad' } } } })
    ).toThrow(GtsSchemaError);
  });

  test('a pattern-ref value must be covered by the operand', () => {
    const schema = { properties: { scope: { 'x-gts-pattern-ref': 'gts.x.core.resources.resource.*' } } };
    expect(validator.validateInstance({ scope: 'gts.x.core.resources.resource.v1~' }, schema)).toHaveLength(0);
    const errors = validator.validateInstance({ scope: 'gts.x.core.resources.*' }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0].keyword).toBe('x-gts-pattern-ref');
  });

  // Review finding: an applicator rejected because a reference keyword
  // matched has no failing reference keyword of its own.
  test('reports an applicator that a matching reference keyword makes fail', () => {
    const oneOf = { oneOf: [{ 'x-gts-type-ref': 'gts.*' }, { 'x-gts-type-ref': 'gts.x.*' }] };
    const errors = validator.validateInstance({ ref: target }, { properties: { ref: oneOf } });
    expect(errors).toEqual([expect.objectContaining({ fieldPath: '/ref', value: target })]);
    expect(errors[0].keyword).toBeUndefined();
    expect(validator.validateInstance(target, { not: { 'x-gts-type-ref': 'gts.*' } })).toHaveLength(1);
    expect(validator.validateInstance(target, { not: { not: { 'x-gts-type-ref': 'gts.y.*' } } })).toHaveLength(1);
  });

  // Review finding: a schema of reference keywords and applicators only
  // that rejects the value must report it, whatever the polarity.
  test.each([
    ['mixed polarity', { not: { anyOf: [{ 'x-gts-type-ref': 'gts.x.*' }, { not: { 'x-gts-type-ref': 'gts.y.*' } }] } }],
    [
      'oneOf through a local $ref',
      { oneOf: [{ $ref: '#/definitions/R' }, {}], definitions: { R: { 'x-gts-type-ref': 'gts.*' } } },
    ],
    [
      'not through a local $ref',
      { not: { $ref: '#/definitions/R' }, definitions: { R: { 'x-gts-type-ref': 'gts.*' } } },
    ],
    ['a reference condition selecting a false branch', { if: { 'x-gts-type-ref': 'gts.*' }, then: false }],
  ])('reports a rejection by applicators over reference keywords: %s', (_name, schema) => {
    expect(validator.acceptor(schema)(target)).toBe(false);
    expect(validator.validateInstance(target, schema)).toHaveLength(1);
  });

  test('reports too many items matching a reference keyword', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      contains: { 'x-gts-type-ref': 'gts.*' },
      minContains: 0,
      maxContains: 0,
    };
    expect(validator.validateInstance([target], schema)).toHaveLength(1);
  });

  // Review finding: a reference error at one array item does not explain an
  // applicator failure at another.
  test('reports an applicator failure at each instance location', () => {
    const oneOf = { oneOf: [{ 'x-gts-type-ref': 'gts.*' }, { 'x-gts-type-ref': 'gts.x.*' }] };
    const errors = validator.validateInstance(['bad', target], { items: oneOf });
    expect(errors.some((error) => error.fieldPath === '/0')).toBe(true);
    expect(errors.some((error) => error.fieldPath === '/1' && error.keyword === undefined)).toBe(true);
  });

  // Review finding: a declaration is not a constraint until a `$ref` uses it.
  test.each([
    ['definitions', { not: { type: 'string', definitions: { Unused: { 'x-gts-type-ref': 'gts.*' } } } }],
    [
      '$defs',
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        not: { type: 'string', $defs: { Unused: { 'x-gts-type-ref': 'gts.*' } } },
      },
    ],
    [
      'x-gts-traits-schema',
      { not: { type: 'string', 'x-gts-traits-schema': { properties: { t: { 'x-gts-type-ref': 'gts.*' } } } } },
    ],
  ])('does not count an unused declaration in %s', (_name, schema) => {
    expect(validator.validateInstance('ordinary', schema)).toEqual([]);
  });

  test('counts a declaration a local $ref uses', () => {
    const nested = { not: { $ref: '#/not/definitions/R', definitions: { R: { 'x-gts-type-ref': 'gts.*' } } } };
    expect(validator.validateInstance(target, nested)).toHaveLength(1);
    const root = { not: { $ref: '#/$defs/R' }, $defs: { R: { 'x-gts-type-ref': 'gts.*' } } };
    expect(validator.validateInstance(target, root)).toHaveLength(1);
  });

  test('does not report an applicator without reference keywords', () => {
    expect(validator.validateInstance(target, { oneOf: [{ type: 'string' }, { minLength: 1 }] })).toEqual([]);
    expect(validator.validateInstance(target, { not: { type: 'string' } })).toEqual([]);
    // Literal data that looks like a schema is not one.
    expect(validator.validateInstance({}, { oneOf: [{ const: { 'x-gts-type-ref': 'gts.*' } }, true, true] })).toEqual(
      []
    );
    // Ordinary failures beside a satisfied reference keyword.
    const ref = { 'x-gts-type-ref': 'gts.*' };
    expect(
      validator.validateInstance({ ref: target, n: 2 }, { properties: { ref, n: { oneOf: [true, true] } } })
    ).toEqual([]);
    expect(validator.validateInstance({ ref: target, n: 1 }, { properties: { ref, n: { type: 'string' } } })).toEqual(
      []
    );
  });

  // Review finding: the reusable Ajv instances registered the schema's `$id`.
  test('validates copies of a schema with the same $id', () => {
    const schema = { $id: `gts://${target}`, 'x-gts-type-ref': 'gts.*' };
    expect(validator.validateInstance(target, schema)).toEqual([]);
    expect(validator.validateInstance(target, JSON.parse(JSON.stringify(schema)))).toEqual([]);
    expect(validator.validateInstance('x', JSON.parse(JSON.stringify(schema)))).toHaveLength(1);
  });
});

describe('entity content identity', () => {
  test('does not retain caller-owned or returned content', () => {
    const gts = new GTS();
    const id = 'gts.x.unit.hash.mutable.v1~x.unit._.item.v1';
    const content = { id, value: 1 };
    gts.register(content);
    content.value = 2;
    gts.get(id).value = 3;

    expect(gts.get(id).value).toBe(1);
    expect(() => gts.register({ id, value: 2 })).toThrow(/already registered with different content/);
  });

  test('returns defensive copies from store collections', () => {
    const store = new GtsStore();
    const id = 'gts.x.unit.hash.mutable_conflict.v1~x.unit._.item.v1';
    store.register(createJsonEntity({ id, value: 1 }));
    const all = store.getAll();
    all[0].content.value = 2;
    all[0].references.add('gts.x.unit.hash.other.v1~');

    expect(store.get(id)?.content.value).toBe(1);
    expect(store.get(id)?.references.size).toBe(0);
  });

  test('does not add an identical schema to the engine pool twice', () => {
    const store = new GtsStore();
    const content = {
      $id: 'gts://gts.x.unit.hash.schema.v1~',
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
    };
    // Phase 3: Ajv internals replaced by the engine-neutral pool seam (`engine.addEngineSchema`).
    const addSchema = jest.spyOn(store['engine'], 'addEngineSchema');

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
