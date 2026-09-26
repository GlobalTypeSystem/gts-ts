/**
 * Unit tests for the focused modules extracted from the store during the
 * structure/idiomaticity refactor (prefix helpers, JSON canonicalization,
 * dialect detection, schema-ref validation, ReDoS safety, and the typed
 * pattern/compatibility-diagnostic helpers). These cover the seams directly,
 * so a regression in one is localized rather than only surfacing through the
 * larger store/server suites.
 */

import {
  GTS,
  Gts,
  GTS_URI_PREFIX,
  MAX_SCHEMA_DEPTH,
  hasUriPrefix,
  stripUriPrefix,
  verdictFromDiagnostics,
  validateSchemaIdentityAndRefs,
  validateSchemaRefs,
  EntityContentDepthError,
  type CompatibilityDiagnostic,
} from '../src';
import {
  canonicalJson,
  contentHash,
  cloneJsonValue,
  cloneJsonEntity,
  isPlainSchemaObject,
} from '../src/json-canonical';
import { dialectOf, canonicalDialectUri } from '../src/schema-dialect';
import { assertSafeSchemaPatterns } from '../src/schema-safety';

describe('prefix helpers', () => {
  it('detects and strips the gts:// URI prefix', () => {
    const id = 'gts.x.core.people.person.v1~';
    expect(hasUriPrefix(GTS_URI_PREFIX + id)).toBe(true);
    expect(hasUriPrefix(id)).toBe(false);
    expect(stripUriPrefix(GTS_URI_PREFIX + id)).toBe(id);
  });

  it('leaves a value without the prefix unchanged', () => {
    expect(stripUriPrefix('gts.x.core.people.person.v1~')).toBe('gts.x.core.people.person.v1~');
    expect(stripUriPrefix('#/$defs/foo')).toBe('#/$defs/foo');
  });
});

describe('json canonicalization', () => {
  it('sorts object keys so equal content hashes equally regardless of order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(contentHash({ b: 1, a: 2 })).toBe(contentHash({ a: 2, b: 1 }));
  });

  it('distinguishes different content', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('throws on content nested past the depth bound', () => {
    let deep: any = 0;
    for (let i = 0; i <= MAX_SCHEMA_DEPTH + 1; i++) deep = { next: deep };
    expect(() => canonicalJson(deep)).toThrow(EntityContentDepthError);
  });

  it('deep-clones without sharing references and tolerates cycles', () => {
    const original: any = { nested: { list: [1, 2] } };
    original.self = original;
    const clone = cloneJsonValue(original);
    expect(clone).not.toBe(original);
    expect(clone.nested).not.toBe(original.nested);
    expect(clone.self).toBe(clone);
    clone.nested.list.push(3);
    expect(original.nested.list).toEqual([1, 2]);
  });

  it('clones an entity with an independent references set', () => {
    const entity = {
      id: 'gts.x.core.people.person.v1~',
      schemaId: null,
      content: { a: 1 },
      isSchema: true,
      references: new Set(['gts.x.core.people.other.v1~']),
    };
    const clone = cloneJsonEntity(entity);
    clone.references.add('gts.x.core.people.new.v1~');
    expect(entity.references.size).toBe(1);
    expect(clone.content).not.toBe(entity.content);
  });

  it('guards schema-object reads', () => {
    expect(isPlainSchemaObject({})).toBe(true);
    expect(isPlainSchemaObject(null)).toBe(false);
    expect(isPlainSchemaObject([])).toBe(false);
    expect(isPlainSchemaObject('x')).toBe(false);
  });
});

describe('dialect detection', () => {
  it('defaults to draft-07 when $schema is absent', () => {
    expect(dialectOf({})).toBe('draft-07');
  });

  it('classifies supported dialects', () => {
    expect(dialectOf({ $schema: 'http://json-schema.org/draft-07/schema#' })).toBe('draft-07');
    expect(dialectOf({ $schema: 'https://json-schema.org/draft/2019-09/schema' })).toBe('2019-09');
    expect(dialectOf({ $schema: 'https://json-schema.org/draft/2020-12/schema' })).toBe('2020-12');
  });

  it('rejects an unsupported or spoofed dialect host', () => {
    expect(() => dialectOf({ $schema: 'https://evil.example/draft-07/schema' })).toThrow();
    expect(() => dialectOf({ $schema: 'not-a-uri' })).toThrow();
    expect(() => dialectOf({ $schema: '' })).toThrow();
  });

  it('round-trips a dialect to its canonical URI bucket', () => {
    expect(dialectOf({ $schema: canonicalDialectUri('2020-12') })).toBe('2020-12');
    expect(dialectOf({ $schema: canonicalDialectUri('2019-09') })).toBe('2019-09');
    expect(dialectOf({ $schema: canonicalDialectUri('draft-07') })).toBe('draft-07');
  });
});

describe('schema $id / $ref validation', () => {
  it('accepts a well-formed gts:// $id with a local $ref', () => {
    expect(
      validateSchemaIdentityAndRefs({
        $id: 'gts://gts.x.core.people.person.v1~',
        properties: { a: { $ref: '#/$defs/a' } },
      })
    ).toBeNull();
  });

  it('rejects a plain gts. $id without the URI form', () => {
    expect(validateSchemaIdentityAndRefs({ $id: 'gts.x.core.people.person.v1~' })).toMatch(
      /must use gts:\/\/ URI format/
    );
  });

  it('rejects a wildcard in $id', () => {
    expect(validateSchemaIdentityAndRefs({ $id: 'gts://gts.x.core.*' })).toMatch(/cannot contain wildcards/);
  });

  it('flags invalid gts:// and plain-gts $ref forms', () => {
    expect(validateSchemaRefs({ $ref: 'gts://gts.x.core.*' }, '')).toEqual([
      'Invalid $ref at $ref: wildcards are not allowed in $ref',
    ]);
    expect(validateSchemaRefs({ $ref: 'gts.x.core.people.person.v1~' }, '')).toEqual([
      'Invalid $ref at $ref: GTS references must use gts:// URI format',
    ]);
    expect(validateSchemaRefs({ $ref: 'https://example.com/x' }, '')).toEqual([
      'Invalid $ref at $ref: external HTTP references are not allowed',
    ]);
  });

  it('fails closed on adversarially deep nesting rather than overflowing', () => {
    let deep: any = { $ref: '#' };
    for (let i = 0; i <= MAX_SCHEMA_DEPTH + 2; i++) deep = { properties: { child: deep } };
    const errors = validateSchemaRefs(deep, '');
    expect(errors.some((e) => e.includes(`nests deeper than ${MAX_SCHEMA_DEPTH}`))).toBe(true);
  });
});

describe('schema safety (ReDoS / resource bounds)', () => {
  it('accepts a benign pattern', () => {
    expect(() => assertSafeSchemaPatterns({ type: 'string', pattern: '^[a-z]+$' })).not.toThrow();
  });

  it('rejects a catastrophic-backtracking pattern', () => {
    expect(() => assertSafeSchemaPatterns({ type: 'string', pattern: '(a+)+$' })).toThrow(/Unsafe regular expression/);
  });

  it('rejects unsafe patternProperties keys', () => {
    expect(() => assertSafeSchemaPatterns({ patternProperties: { '(a+)+$': {} } })).toThrow(
      /Unsafe regular expression/
    );
  });
});

describe('typed pattern parsing', () => {
  it('parses a concrete identifier as a non-wildcard pattern', () => {
    const pattern = Gts.parsePattern('gts.x.core.people.person.v1~');
    expect(pattern.hasWildcard).toBe(false);
    expect(pattern.id).toBe('gts.x.core.people.person.v1~');
    expect(pattern.segments.length).toBeGreaterThan(0);
  });

  it('parses a trailing wildcard and flags it', () => {
    const pattern = Gts.parsePattern('gts.x.core.people.person.v1~*');
    expect(pattern.hasWildcard).toBe(true);
  });

  it('exposes a single wildcard-detection predicate', () => {
    expect(Gts.containsWildcard('gts.x.*')).toBe(true);
    expect(Gts.containsWildcard('gts.x.core.people.person.v1~')).toBe(false);
  });

  it('throws on a malformed pattern', () => {
    expect(() => Gts.parsePattern('gts.x.core.people.person.v1~a*')).toThrow();
  });
});

describe('compatibility diagnostics', () => {
  it('derives the full verdict as a pure reading of all diagnostics', () => {
    expect(verdictFromDiagnostics([])).toBe('compatible');
    const unknown: CompatibilityDiagnostic[] = [{ direction: 'backward', verdict: 'unknown', message: 'x' }];
    expect(verdictFromDiagnostics(unknown)).toBe('unknown');
    const mixed: CompatibilityDiagnostic[] = [
      { direction: 'backward', verdict: 'unknown', message: 'x' },
      { direction: 'forward', verdict: 'incompatible', message: 'y' },
    ];
    expect(verdictFromDiagnostics(mixed)).toBe('incompatible');
  });

  it('recovers a single directional verdict when a direction is given', () => {
    const diagnostics: CompatibilityDiagnostic[] = [
      { direction: 'backward', verdict: 'unknown', message: 'x' },
      { direction: 'forward', verdict: 'incompatible', message: 'y' },
    ];
    expect(verdictFromDiagnostics(diagnostics, 'backward')).toBe('unknown');
    expect(verdictFromDiagnostics(diagnostics, 'forward')).toBe('incompatible');
    // A direction with no diagnostics is compatible.
    expect(verdictFromDiagnostics([{ direction: 'forward', verdict: 'incompatible', message: 'y' }], 'backward')).toBe(
      'compatible'
    );
  });

  it('keeps CompatibilityResult verdicts recoverable from its diagnostics (documented invariant)', () => {
    // A closed model adding an optional property: backward-compatible,
    // forward-incompatible - a case that exercises all three verdicts at once.
    const gts = new GTS({ validateRefs: false });
    const draft7 = 'http://json-schema.org/draft-07/schema#';
    const oldId = 'gts.x.unit.diag.case.v1.0~';
    const newId = 'gts.x.unit.diag.case.v1.1~';
    gts.register({
      $id: oldId,
      $schema: draft7,
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
    gts.register({
      $id: newId,
      $schema: draft7,
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      additionalProperties: false,
    });

    const result = gts.checkCompatibility(oldId, newId);
    expect(result.backward_compatibility).toBe(verdictFromDiagnostics(result.diagnostics, 'backward'));
    expect(result.forward_compatibility).toBe(verdictFromDiagnostics(result.diagnostics, 'forward'));
    expect(result.full_compatibility).toBe(verdictFromDiagnostics(result.diagnostics));
    // Every diagnostic is attributed to a direction and carries a message.
    for (const d of result.diagnostics) {
      expect(['backward', 'forward']).toContain(d.direction);
      expect(d.message.length).toBeGreaterThan(0);
    }
  });
});
