import { GTS, CompatVerdict } from '../src';

const DRAFT7 = 'http://json-schema.org/draft-07/schema#';

/**
 * Table-driven transcription of GTS spec 0.13 §4.5, "Type Schema Evolution
 * Compatibility Rules".
 *
 * Each row states a single change between two successive definitions of one
 * type identity and the verdict the spec gives for each relation. These are
 * pinned here rather than left to the gts-spec conformance suite alone: the
 * suite needs Python and a running server, and the rules below are the part of
 * 0.13 most likely to be silently broken by a refactor of the subsumption
 * engine (0.12 gave the opposite answer for several of these rows).
 */
interface Row {
  change: string;
  old: Record<string, any>;
  new: Record<string, any>;
  backward: CompatVerdict;
  forward: CompatVerdict;
  full: CompatVerdict;
}

const OPEN = {};
const CLOSED = { additionalProperties: false };

const ROWS: Row[] = [
  {
    change: 'updating description/examples',
    old: { required: ['a'], properties: { a: { type: 'string', description: 'first' } }, ...CLOSED },
    new: {
      required: ['a'],
      properties: { a: { type: 'string', description: 'second', examples: ['x'] } },
      ...CLOSED,
    },
    backward: 'compatible',
    forward: 'compatible',
    full: 'compatible',
  },
  {
    change: 'adding optional property (open model)',
    old: { required: ['a'], properties: { a: { type: 'string' } }, ...OPEN },
    new: { required: ['a'], properties: { a: { type: 'string' }, b: { type: 'string' } }, ...OPEN },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'adding optional property (closed model)',
    old: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string' }, b: { type: 'string' } }, ...CLOSED },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'adding new required property (open model)',
    old: { required: ['a'], properties: { a: { type: 'string' } }, ...OPEN },
    new: { required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } }, ...OPEN },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'adding new required property (closed model)',
    old: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    new: { required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'removing optional property (open model)',
    old: { required: ['a'], properties: { a: { type: 'string' }, b: { type: 'string' } }, ...OPEN },
    new: { required: ['a'], properties: { a: { type: 'string' } }, ...OPEN },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'removing optional property (closed model)',
    old: { required: ['a'], properties: { a: { type: 'string' }, b: { type: 'string' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'removing required property definition (open model)',
    old: { required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } }, ...OPEN },
    new: { required: ['a'], properties: { a: { type: 'string' } }, ...OPEN },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'removing required property definition (closed model)',
    old: { required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'closing an open object',
    old: { required: ['a'], properties: { a: { type: 'string' } }, ...OPEN },
    new: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'opening a closed object',
    old: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string' } }, additionalProperties: true },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'widening a schema-valued unevaluatedProperties to fully open',
    old: {
      required: ['a'],
      properties: { a: { type: 'string' } },
      unevaluatedProperties: { type: 'string' },
    },
    new: { required: ['a'], properties: { a: { type: 'string' } }, ...OPEN },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'changing required property to optional',
    old: { required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string' }, b: { type: 'string' } }, ...CLOSED },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'changing optional property to required',
    old: { required: ['a'], properties: { a: { type: 'string' }, b: { type: 'string' } }, ...CLOSED },
    new: { required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'adding new enum value',
    old: { required: ['a'], properties: { a: { type: 'string', enum: ['x', 'y'] } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', enum: ['x', 'y', 'z'] } }, ...CLOSED },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'removing enum value',
    old: { required: ['a'], properties: { a: { type: 'string', enum: ['x', 'y', 'z'] } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', enum: ['x', 'y'] } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'changing a const value',
    old: { required: ['a'], properties: { a: { type: 'string', const: 'A' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', const: 'B' } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'widening numeric type (integer -> number)',
    old: { required: ['a'], properties: { a: { type: 'integer' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'number' } }, ...CLOSED },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'narrowing numeric type (number -> integer)',
    old: { required: ['a'], properties: { a: { type: 'number' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'integer' } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'relaxing constraints (increasing max)',
    old: { required: ['a'], properties: { a: { type: 'string', maxLength: 10 } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', maxLength: 100 } }, ...CLOSED },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'tightening constraints (decreasing max)',
    old: { required: ['a'], properties: { a: { type: 'string', maxLength: 100 } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', maxLength: 10 } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'dropping maxLength for an enum whose members are all within it',
    old: { required: ['a'], properties: { a: { type: 'string', maxLength: 100 } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', enum: ['gold', 'platinum'] } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'dropping maxLength for an enum with a member outside it',
    old: { required: ['a'], properties: { a: { type: 'string', maxLength: 5 } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', enum: ['short', 'way-too-long-value'] } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'renaming property',
    old: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    new: { required: ['b'], properties: { b: { type: 'string' } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'changing property type (incompatible)',
    old: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'number' } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  // Phase 1 (spec 0.13 §9.2, mirrors gts-rust `check_value_set_compatibility` /
  // `accepted_value_set` in schema_evolution.rs): removing or adding the
  // `enum`/`const` value-set constraint entirely (not merely widening or
  // narrowing an already-present enum, which the rows above already cover)
  // must be directional, exactly like a bound relaxing or tightening.
  {
    change: 'removing an enum constraint entirely (spec §9.2 value-set removal)',
    old: { required: ['a'], properties: { a: { type: 'string', enum: ['x', 'y'] } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'adding an enum constraint where none existed (spec §9.2 value-set addition)',
    old: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', enum: ['x', 'y'] } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  // `const` and `enum` are the same value-set axis (gts-rust `accepted_value_set`
  // treats them as one set), so replacing one with a widening/narrowing form of
  // the other must give the same directional verdict as a pure enum change.
  {
    change: 'replacing a const with a superset enum (const/enum are one value set)',
    old: { required: ['a'], properties: { a: { type: 'string', const: 'x' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', enum: ['x', 'y'] } }, ...CLOSED },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'replacing an enum with a narrower const (const/enum are one value set)',
    old: { required: ['a'], properties: { a: { type: 'string', enum: ['x', 'y'] } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', const: 'x' } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'removing a const constraint entirely (const/enum are one value set)',
    old: { required: ['a'], properties: { a: { type: 'string', const: 'x' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  // P2-R1: `format` is a real assertion once assertions are enabled
  // (`GtsStore` sets `validateFormats: true` and applies GTS's own formats),
  // so it must be classified `narrowing`, not `annotation` - it cannot be
  // dropped from `Valid(S)` reasoning as mere documentation. Mirrors
  // gts-rust's `NARROWING` set (`schema_evolution.rs:831-878`), which treats
  // `format` exactly like `pattern`/`multipleOf`: added is forward-only,
  // removed is backward-only, a changed value on both sides is undecidable,
  // and equal values are a no-op.
  {
    change: 'adding a format constraint where none existed (format is narrowing, not annotation)',
    old: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', format: 'email' } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'removing a format constraint entirely (format is narrowing, not annotation)',
    old: { required: ['a'], properties: { a: { type: 'string', format: 'email' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'changing a format value (narrowing keywords cannot compare two present values)',
    old: { required: ['a'], properties: { a: { type: 'string', format: 'email' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', format: 'uuid' } }, ...CLOSED },
    backward: 'unknown',
    forward: 'unknown',
    full: 'unknown',
  },
  {
    change: 'restating the same format value is a no-op',
    old: { required: ['a'], properties: { a: { type: 'string', format: 'email' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', format: 'email' } }, ...CLOSED },
    backward: 'compatible',
    forward: 'compatible',
    full: 'compatible',
  },
  // Applying the same `narrowing` reasoning to `multipleOf`, kept `unmodeled`
  // before this fix only because no test pinned the added/removed cases
  // (see `KEYWORDS`'s doc comment).
  {
    change: 'adding a multipleOf constraint where none existed',
    old: { required: ['a'], properties: { a: { type: 'integer' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'integer', multipleOf: 2 } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'removing a multipleOf constraint entirely',
    old: { required: ['a'], properties: { a: { type: 'integer', multipleOf: 2 } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'integer' } }, ...CLOSED },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'changing a multipleOf value (narrowing keywords cannot compare two present values)',
    old: { required: ['a'], properties: { a: { type: 'integer', multipleOf: 2 } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'integer', multipleOf: 3 } }, ...CLOSED },
    backward: 'unknown',
    forward: 'unknown',
    full: 'unknown',
  },
  {
    change: 'restating the same multipleOf value (including an equivalent spelling) is a no-op',
    old: { required: ['a'], properties: { a: { type: 'integer', multipleOf: 2 } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'integer', multipleOf: 2.0 } }, ...CLOSED },
    backward: 'compatible',
    forward: 'compatible',
    full: 'compatible',
  },
  // `pattern` was already `unmodeled` (see the dedicated tests below for the
  // `changed`/const-carve-out cases), but no case pinned bare added/removed/
  // equal without a `const`/`enum` in play; add them now that `pattern`
  // shares the same `narrowing` handling as `format`/`multipleOf`.
  {
    change: 'adding a pattern constraint where none existed',
    old: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', pattern: '^[a-z]+$' } }, ...CLOSED },
    backward: 'incompatible',
    forward: 'compatible',
    full: 'incompatible',
  },
  {
    change: 'removing a pattern constraint entirely',
    old: { required: ['a'], properties: { a: { type: 'string', pattern: '^[a-z]+$' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string' } }, ...CLOSED },
    backward: 'compatible',
    forward: 'incompatible',
    full: 'incompatible',
  },
  {
    change: 'restating the same pattern value is a no-op',
    old: { required: ['a'], properties: { a: { type: 'string', pattern: '^[a-z]+$' } }, ...CLOSED },
    new: { required: ['a'], properties: { a: { type: 'string', pattern: '^[a-z]+$' } }, ...CLOSED },
    backward: 'compatible',
    forward: 'compatible',
    full: 'compatible',
  },
];

describe('OP#8 - Type Schema Evolution Compatibility (spec 0.13 §4.5)', () => {
  ROWS.forEach((row, index) => {
    test(`${row.change}: backward=${row.backward}, forward=${row.forward}, full=${row.full}`, () => {
      const gts = new GTS({ validateRefs: false });
      const oldId = `gts.x.unit.compat.case${index}.v1.0~`;
      const newId = `gts.x.unit.compat.case${index}.v1.1~`;

      gts.register({ $id: oldId, $schema: DRAFT7, type: 'object', ...row.old });
      gts.register({ $id: newId, $schema: DRAFT7, type: 'object', ...row.new });

      const result = gts.checkCompatibility(oldId, newId);

      expect({
        backward: result.backward_compatibility,
        forward: result.forward_compatibility,
        full: result.full_compatibility,
      }).toEqual({ backward: row.backward, forward: row.forward, full: row.full });
    });
  });
});

describe('OP#8 - inconclusive checks report `unknown`', () => {
  test('a differing unmodeled assertion is unknown, not incompatible', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.unknown.pattern.v1.0~';
    const newId = 'gts.x.unit.unknown.pattern.v1.1~';

    // `pattern` is a real constraint the engine does not model, so it cannot
    // decide inclusion either way.
    gts.register({
      $id: oldId,
      $schema: DRAFT7,
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string', pattern: '^foo' } },
      additionalProperties: false,
    });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string', pattern: '^bar' } },
      additionalProperties: false,
    });

    const result = gts.checkCompatibility(oldId, newId);

    expect(result.backward_compatibility).toBe('unknown');
    expect(result.forward_compatibility).toBe('unknown');
    expect(result.full_compatibility).toBe('unknown');
    // `unknown` is not evidence of incompatibility, but it is not a pass either.
    expect(result.is_fully_compatible).toBe(false);
  });

  test('a const already matching the old pattern lets the new schema drop it, forward-compatibly', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.unknown.patternconst.v1.0~';
    const newId = 'gts.x.unit.unknown.patternconst.v1.1~';

    // `pattern` is still compared by exact equality in general (see the test
    // above), but a `const`/`enum` value the new schema pins down that
    // already satisfies the old pattern makes dropping the pattern itself
    // harmless from the "does everything new could ever hold also satisfy
    // old" angle - i.e. forward compatibility, `subsumes(oldSchema,
    // newSchema)`. (Backward asks the opposite question - "does everything
    // old could ever hold also satisfy new" - and stays `incompatible`
    // here regardless of this fix, because narrowing to one `const` value
    // legitimately excludes strings old admitted.)
    gts.register({
      $id: oldId,
      $schema: DRAFT7,
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string', pattern: '^[a-z]+$' } },
      additionalProperties: false,
    });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string', const: 'hello' } },
      additionalProperties: false,
    });

    const result = gts.checkCompatibility(oldId, newId);

    expect(result.forward_compatibility).toBe('compatible');
    expect(result.backward_compatibility).toBe('incompatible');
  });

  test('a const that demonstrably violates the old pattern is a proven incompatibility, not merely unknown', () => {
    // Unlike a keyword divergence the engine genuinely cannot evaluate either
    // way (which stays `unknown`), a concrete `const` value tested against a
    // valid `pattern` regex and found NOT to match is a demonstrated
    // conflict: `new` admits a value `old` provably rejects. Mirrors the
    // fixed-value carve-outs `compareBounds`/`compareFixedValues` already use
    // elsewhere to turn a provable case into a definitive verdict instead of
    // falling through to the generic unmodeled-keyword `unknown`.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.unknown.patternconstbad.v1.0~';
    const newId = 'gts.x.unit.unknown.patternconstbad.v1.1~';

    gts.register({
      $id: oldId,
      $schema: DRAFT7,
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string', pattern: '^[a-z]+$' } },
      additionalProperties: false,
    });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string', const: 'HELLO' } },
      additionalProperties: false,
    });

    const result = gts.checkCompatibility(oldId, newId);

    expect(result.forward_compatibility).toBe('incompatible');
    expect(result.is_fully_compatible).toBe(false);
  });

  test('an unresolvable type identifier is unknown rather than incompatible', () => {
    const gts = new GTS({ validateRefs: false });

    const result = gts.checkCompatibility('gts.x.unit.unknown.missing.v1.0~', 'gts.x.unit.unknown.missing.v1.1~');

    expect(result.backward_compatibility).toBe('unknown');
    expect(result.forward_compatibility).toBe('unknown');
    expect(result.full_compatibility).toBe('unknown');
    // One reason per missing side, each reported once.
    expect(result.incompatibility_reasons).toEqual([
      'Old type schema not found: gts.x.unit.unknown.missing.v1.0~',
      'New type schema not found: gts.x.unit.unknown.missing.v1.1~',
    ]);
  });

  test('a bound that is present but not numeric is unknown', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.unknown.bound.v1.0~';
    const newId = 'gts.x.unit.unknown.bound.v1.1~';

    gts.register({
      $id: oldId,
      $schema: DRAFT7,
      type: 'object',
      properties: { a: { type: 'string', maxLength: 10 } },
      additionalProperties: false,
    });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      properties: { a: { type: 'string', maxLength: 'ten' } },
      additionalProperties: false,
    });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('unknown');
  });
});

describe('OP#8 - malformed schemas degrade instead of throwing', () => {
  // Schemas are registered without JSON Schema meta-validation, so the engine
  // has to survive keywords of the wrong shape.
  test('a non-array enum reached through allOf does not crash the check', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.malformed.enum.v1.0~';
    const newId = 'gts.x.unit.malformed.enum.v1.1~';

    gts.register({
      $id: oldId,
      $schema: DRAFT7,
      type: 'object',
      allOf: [{ properties: { a: { enum: ['x'] } } }, { properties: { a: { enum: 'not-an-array' } } }],
    });
    gts.register({ $id: newId, $schema: DRAFT7, type: 'object', properties: { a: { enum: ['x', 'y'] } } });

    expect(() => gts.checkCompatibility(oldId, newId)).not.toThrow();
  });

  test('a non-array enum makes the comparison inconclusive, not unconstrained', () => {
    // `fixedValues()` only recognises array enums, so a malformed one used to
    // read as "this schema pins nothing down" and compared as compatible.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.malformed.enumshape.v1.0~';
    const newId = 'gts.x.unit.malformed.enumshape.v1.1~';

    gts.register({ $id: oldId, $schema: DRAFT7, type: 'string', enum: 'open' });
    gts.register({ $id: newId, $schema: DRAFT7, type: 'string' });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('unknown');
  });

  test('a modeled keyword of the wrong shape makes the comparison inconclusive', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.malformed.reqshape.v1.0~';
    const newId = 'gts.x.unit.malformed.reqshape.v1.1~';

    gts.register({ $id: oldId, $schema: DRAFT7, type: 'object', required: 'a', properties: { a: {} } });
    gts.register({ $id: newId, $schema: DRAFT7, type: 'object', required: ['a'], properties: { a: {} } });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('unknown');
  });

  test('a schema that cannot be compared at all reports unknown', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.malformed.cyclic.v1.0~';
    const newId = 'gts.x.unit.malformed.cyclic.v1.1~';

    const cyclic: any = { $id: oldId, $schema: DRAFT7, type: 'object', properties: {} };
    cyclic.properties.self = cyclic; // a structure JSON could never carry

    gts.register(cyclic);
    gts.register({ $id: newId, $schema: DRAFT7, type: 'object', properties: { self: { type: 'string' } } });

    const result = gts.checkCompatibility(oldId, newId);
    expect(['unknown', 'incompatible']).toContain(result.full_compatibility);
  });
});

describe('OP#8 - assertions that are not annotations', () => {
  test('a differing x-gts-ref pattern is not treated as documentation', () => {
    // x-gts-ref is enforced against instances by OP#6, so two schemas whose
    // reference patterns accept disjoint targets do not accept the same
    // instances - the engine must not strip it along with the other x-gts-*.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.xref.evt.v1.0~';
    const newId = 'gts.x.unit.xref.evt.v1.1~';

    gts.register({
      $id: oldId,
      $schema: DRAFT7,
      type: 'object',
      properties: { ref: { type: 'string', 'x-gts-ref': 'gts.x.unit.alpha.*' } },
    });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      properties: { ref: { type: 'string', 'x-gts-ref': 'gts.x.unit.beta.*' } },
    });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('unknown');
  });

  test('an identical x-gts-ref still compares as compatible', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.xrefsame.evt.v1.0~';
    const newId = 'gts.x.unit.xrefsame.evt.v1.1~';
    const body = {
      type: 'object',
      properties: { ref: { type: 'string', 'x-gts-ref': 'gts.x.unit.alpha.*' } },
      additionalProperties: false,
    };

    gts.register({ $id: oldId, $schema: DRAFT7, ...body });
    gts.register({ $id: newId, $schema: DRAFT7, ...body });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('compatible');
  });
});

describe('OP#8 - unresolvable references fail closed', () => {
  test('a local JSON pointer the engine cannot follow reports unknown', () => {
    // Both documents look identical once `$ref` is dropped and `definitions`
    // is stripped, but the pointed-at subschemas differ.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.localref.t.v1.0~';
    const newId = 'gts.x.unit.localref.t.v1.1~';

    gts.register({
      $id: oldId,
      $schema: DRAFT7,
      type: 'object',
      definitions: { T: { type: 'string' } },
      $ref: '#/definitions/T',
    });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      definitions: { T: { type: 'number' } },
      $ref: '#/definitions/T',
    });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('unknown');
  });

  test('a $ref to an unregistered GTS type reports unknown', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.deadref.t.v1.0~';
    const newId = 'gts.x.unit.deadref.t.v1.1~';

    gts.register({ $id: oldId, $schema: DRAFT7, type: 'object', properties: { a: { type: 'string' } } });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      properties: { a: { type: 'string' } },
      allOf: [{ $ref: 'gts://gts.x.unit.deadref.absent.v1~' }],
    });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('unknown');
  });

  test('a local $ref nested under `properties`, reached via a shared $defs entry, is not silently skipped', () => {
    // Both documents are byte-identical once `$defs` is stripped (both use
    // the exact same `properties: { x: { $ref: '#/$defs/T' } }`), so the
    // `deepEqual` fast path in `subsumes()` must not be allowed to fire
    // before the local ref nested under `properties.x` - whose target
    // genuinely differs between the two schemas - is accounted for.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.localref.nested.v1.0~';
    const newId = 'gts.x.unit.localref.nested.v1.1~';

    gts.register({
      $id: oldId,
      $schema: DRAFT7,
      type: 'object',
      $defs: { T: { type: 'string' } },
      properties: { x: { $ref: '#/$defs/T' } },
    });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      $defs: { T: { type: 'number' } },
      properties: { x: { $ref: '#/$defs/T' } },
    });

    const result = gts.checkCompatibility(oldId, newId);
    expect(result.backward_compatibility).toBe('unknown');
    expect(result.forward_compatibility).toBe('unknown');
  });

  test('a genuinely ref-free, identical schema still takes the deepEqual fast path', () => {
    // Regression guard for the fix above: schemas with no local `$ref`
    // anywhere must still be recognised as trivially compatible.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.norefidentical.t.v1.0~';
    const newId = 'gts.x.unit.norefidentical.t.v1.1~';
    const body = { type: 'object', properties: { x: { type: 'string' } } };

    gts.register({ $id: oldId, $schema: DRAFT7, ...body });
    gts.register({ $id: newId, $schema: DRAFT7, ...body });

    const result = gts.checkCompatibility(oldId, newId);
    expect(result.backward_compatibility).toBe('compatible');
    expect(result.forward_compatibility).toBe('compatible');
  });
});

describe('OP#8 - $defs content is documentation, never compared', () => {
  test('malformed content inside $defs does not force an otherwise-comparable pair to unknown', () => {
    // `$defs` is annotation-kind (stripped before comparison), so a malformed
    // value inside it - a number where a schema/boolean belongs - must not
    // make an otherwise identical, otherwise well-formed comparison
    // inconclusive: the engine never reads that content for the verdict.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.defsmalformed.t.v1.0~';
    const newId = 'gts.x.unit.defsmalformed.t.v1.1~';
    const body = { type: 'object', $defs: { Note: 1 }, properties: { a: { type: 'string' } } };

    gts.register({ $id: oldId, $schema: DRAFT7, ...body });
    gts.register({ $id: newId, $schema: DRAFT7, ...body });

    const result = gts.checkCompatibility(oldId, newId);
    expect(result.backward_compatibility).toBe('compatible');
    expect(result.forward_compatibility).toBe('compatible');
  });

  test('a genuinely malformed keyword in a compared position still forces unknown', () => {
    // Narrow-scope guard: the annotation skip in `hasMalformedKeyword` must
    // only cover annotation-kind keywords like `$defs`; a malformed value in
    // a real, compared position (`properties`) must still degrade to unknown.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.propsmalformed.t.v1.0~';
    const newId = 'gts.x.unit.propsmalformed.t.v1.1~';

    gts.register({ $id: oldId, $schema: DRAFT7, type: 'object', properties: { a: 'not-a-schema' } });
    gts.register({ $id: newId, $schema: DRAFT7, type: 'object', properties: { a: { type: 'string' } } });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('unknown');
  });
});

describe('OP#8 - contradictory allOf branches are unsatisfiable', () => {
  test('disjoint types across allOf collapse to a schema accepting nothing', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.disjoint.t.v1.0~';
    const newId = 'gts.x.unit.disjoint.t.v1.1~';

    gts.register({ $id: oldId, $schema: DRAFT7, allOf: [{ type: 'string' }, { type: 'number' }] });
    gts.register({ $id: newId, $schema: DRAFT7, type: 'string' });

    const result = gts.checkCompatibility(oldId, newId);
    // Valid(old) is empty, so it is included in Valid(new) but not vice versa.
    expect(result.backward_compatibility).toBe('compatible');
    expect(result.forward_compatibility).toBe('incompatible');
    expect(result.full_compatibility).toBe('incompatible');
  });
});

describe('OP#8 - inclusive and exclusive bounds are the same axis', () => {
  const register = (gts: GTS, id: string, bound: Record<string, number>) =>
    gts.register({
      $id: id,
      $schema: DRAFT7,
      type: 'object',
      properties: { n: { type: 'number', ...bound } },
      additionalProperties: false,
    });

  test('tightening minimum:0 to exclusiveMinimum:0 is forward compatible only', () => {
    const gts = new GTS({ validateRefs: false });
    register(gts, 'gts.x.unit.bounds.excl.v1.0~', { minimum: 0 });
    register(gts, 'gts.x.unit.bounds.excl.v1.1~', { exclusiveMinimum: 0 });

    const result = gts.checkCompatibility('gts.x.unit.bounds.excl.v1.0~', 'gts.x.unit.bounds.excl.v1.1~');
    // `x > 0` is a strict subset of `x >= 0`.
    expect(result.forward_compatibility).toBe('compatible');
    expect(result.backward_compatibility).toBe('incompatible');
  });

  test('relaxing exclusiveMaximum:10 to maximum:10 is backward compatible only', () => {
    const gts = new GTS({ validateRefs: false });
    register(gts, 'gts.x.unit.bounds.incl.v1.0~', { exclusiveMaximum: 10 });
    register(gts, 'gts.x.unit.bounds.incl.v1.1~', { maximum: 10 });

    const result = gts.checkCompatibility('gts.x.unit.bounds.incl.v1.0~', 'gts.x.unit.bounds.incl.v1.1~');
    expect(result.backward_compatibility).toBe('compatible');
    expect(result.forward_compatibility).toBe('incompatible');
  });

  test('the same bound expressed identically stays fully compatible', () => {
    const gts = new GTS({ validateRefs: false });
    register(gts, 'gts.x.unit.bounds.same.v1.0~', { exclusiveMinimum: 5 });
    register(gts, 'gts.x.unit.bounds.same.v1.1~', { exclusiveMinimum: 5 });

    expect(
      gts.checkCompatibility('gts.x.unit.bounds.same.v1.0~', 'gts.x.unit.bounds.same.v1.1~').full_compatibility
    ).toBe('compatible');
  });
});

describe('OP#8 - a bound only constrains the type it targets (PR #16 review recommended fix)', () => {
  // `minimum`/`maximum` only ever apply to numbers, and `minLength` only
  // ever applies to strings - a schema that never admits the axis's target
  // type cannot be constrained by it at all, so comparing across the two is
  // not a real conflict.
  test('a number-only schema compares backward compatible against a schema that only adds minLength', () => {
    const gts = new GTS({ validateRefs: false });
    gts.register({
      $id: 'gts.x.unit.boundtype.numvslen.v1.0~',
      $schema: DRAFT7,
      type: 'object',
      properties: { n: { type: 'number' } },
      additionalProperties: false,
    });
    gts.register({
      $id: 'gts.x.unit.boundtype.numvslen.v1.1~',
      $schema: DRAFT7,
      type: 'object',
      properties: { n: { minLength: 3 } },
      additionalProperties: false,
    });

    const result = gts.checkCompatibility('gts.x.unit.boundtype.numvslen.v1.0~', 'gts.x.unit.boundtype.numvslen.v1.1~');
    // `minLength:3` does not reject numbers at all, so every number the old
    // schema admits is still admitted by the new one.
    expect(result.backward_compatibility).toBe('compatible');
  });

  test('a string-only schema compares backward compatible against a schema that only adds a numeric minimum', () => {
    const gts = new GTS({ validateRefs: false });
    gts.register({
      $id: 'gts.x.unit.boundtype.strvsmin.v1.0~',
      $schema: DRAFT7,
      type: 'object',
      properties: { n: { type: 'string' } },
      additionalProperties: false,
    });
    gts.register({
      $id: 'gts.x.unit.boundtype.strvsmin.v1.1~',
      $schema: DRAFT7,
      type: 'object',
      properties: { n: { minimum: 5 } },
      additionalProperties: false,
    });

    const result = gts.checkCompatibility('gts.x.unit.boundtype.strvsmin.v1.0~', 'gts.x.unit.boundtype.strvsmin.v1.1~');
    expect(result.backward_compatibility).toBe('compatible');
  });

  test('a genuine minimum conflict between two number schemas is still correctly detected', () => {
    // Control: the type gate must not blind the check to a real conflict
    // when both sides actually admit the axis's target type.
    const gts = new GTS({ validateRefs: false });
    gts.register({
      $id: 'gts.x.unit.boundtype.realconflict.v1.0~',
      $schema: DRAFT7,
      type: 'object',
      properties: { n: { type: 'number' } },
      additionalProperties: false,
    });
    gts.register({
      $id: 'gts.x.unit.boundtype.realconflict.v1.1~',
      $schema: DRAFT7,
      type: 'object',
      properties: { n: { type: 'number', minimum: 5 } },
      additionalProperties: false,
    });

    const result = gts.checkCompatibility(
      'gts.x.unit.boundtype.realconflict.v1.0~',
      'gts.x.unit.boundtype.realconflict.v1.1~'
    );
    // The new schema now rejects numbers below 5, which the old schema
    // admitted - a genuine backward incompatibility.
    expect(result.backward_compatibility).toBe('incompatible');
  });
});

describe('OP#8 - the keyword table is the single source of truth', () => {
  test('unevaluatedProperties closes a type, on every code path that reads it', () => {
    // It was previously honoured by contentModel() but invisible to the object
    // guard and to the unmodeled catch-all, so closing a type this way read as
    // fully compatible in both directions.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.unevald.t.v1.0~';
    const newId = 'gts.x.unit.unevald.t.v1.1~';

    gts.register({ $id: oldId, $schema: DRAFT7, type: 'object', properties: { a: { type: 'string' } } });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      properties: { a: { type: 'string' } },
      unevaluatedProperties: false,
    });

    const result = gts.checkCompatibility(oldId, newId);
    expect(result.backward_compatibility).toBe('incompatible');
    expect(result.forward_compatibility).toBe('compatible');
  });

  test('additionalProperties: true makes the level open even alongside a schema-valued unevaluatedProperties', () => {
    // unevaluatedProperties only applies to properties that properties /
    // patternProperties / additionalProperties did not already evaluate.
    // additionalProperties: true evaluates every remaining property, so
    // unevaluatedProperties can never actually apply here - the level is
    // fully open, not partially restricted by unevaluatedProperties's schema.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.apalwaysopen.t.v1.0~';
    const newId = 'gts.x.unit.apalwaysopen.t.v1.1~';

    gts.register({ $id: oldId, $schema: DRAFT7, type: 'object', properties: {} });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      properties: {},
      additionalProperties: true,
      unevaluatedProperties: { type: 'number' },
    });

    const result = gts.checkCompatibility(oldId, newId);
    expect(result.forward_compatibility).toBe('compatible');
  });

  test('an unrecognised keyword fails closed to unknown rather than being ignored', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.newkw.t.v1.0~';
    const newId = 'gts.x.unit.newkw.t.v1.1~';

    gts.register({ $id: oldId, $schema: DRAFT7, type: 'string', 'x-some-future-assertion': 'a' });
    gts.register({ $id: newId, $schema: DRAFT7, type: 'string', 'x-some-future-assertion': 'b' });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('unknown');
  });
});

describe('OP#8 - the walker distinguishes schema positions from data', () => {
  test('a property whose name matches an annotation keyword is not stripped', () => {
    // Inside `properties` the keys are user-chosen names. Treating `title` as
    // the annotation keyword deleted the property and made the two schemas
    // normalize to the same thing.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.datakw.t.v1.0~';
    const newId = 'gts.x.unit.datakw.t.v1.1~';

    gts.register({ $id: oldId, $schema: DRAFT7, type: 'object', properties: { title: { type: 'string' } } });
    gts.register({ $id: newId, $schema: DRAFT7, type: 'object', properties: { title: { type: 'number' } } });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('incompatible');
  });

  test('annotations are still stripped where a schema is expected', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.datakw.ann.v1.0~';
    const newId = 'gts.x.unit.datakw.ann.v1.1~';

    gts.register({
      $id: oldId,
      $schema: DRAFT7,
      type: 'object',
      properties: { a: { type: 'string', title: 'One' } },
      additionalProperties: false,
    });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      properties: { a: { type: 'string', title: 'Two' } },
      additionalProperties: false,
    });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('compatible');
  });

  test('restating the same type across allOf branches does not narrow it', () => {
    // `number` intersected with `number` must stay `number`; widening both
    // sides collapsed it to `integer`.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.restate.t.v1.0~';
    const newId = 'gts.x.unit.restate.t.v1.1~';

    gts.register({ $id: oldId, $schema: DRAFT7, allOf: [{ type: 'number' }, { type: 'number' }] });
    gts.register({ $id: newId, $schema: DRAFT7, type: 'number' });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('compatible');
  });

  test.each([
    ['a non-array allOf', { type: 'object', allOf: { type: 'string' } }],
    ['a non-string $ref', { type: 'object', $ref: 123 }],
    ['a property schema that is not a schema', { type: 'object', properties: { name: 1 } }],
  ])('%s makes the comparison inconclusive', (_label, body) => {
    // These are dropped during resolution, so without an explicit check they
    // read as "no constraint" and compare as compatible.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.badcomp.t.v1.0~';
    const newId = 'gts.x.unit.badcomp.t.v1.1~';

    gts.register({ $id: oldId, $schema: DRAFT7, ...(body as Record<string, any>) });
    gts.register({ $id: newId, $schema: DRAFT7, type: 'object' });

    expect(gts.checkCompatibility(oldId, newId).full_compatibility).toBe('unknown');
  });
});

describe('OP#8 - identifiers and reference resolution', () => {
  test('accepts gts:// URI form for either identifier', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.uri.evt.v1.0~';
    const newId = 'gts.x.unit.uri.evt.v1.1~';

    const body = {
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    };
    gts.register({ $id: oldId, $schema: DRAFT7, ...body });
    gts.register({ $id: newId, $schema: DRAFT7, ...body });

    const result = gts.checkCompatibility(`gts://${oldId}`, `gts://${newId}`);

    expect(result.full_compatibility).toBe('compatible');
    expect(result.old).toBe(oldId);
    expect(result.new).toBe(newId);
  });

  test('a widened $ref target makes the containing type backward-only compatible', () => {
    const gts = new GTS({ validateRefs: false });

    gts.register({
      $id: 'gts.x.unit.ref.target.v1.0~',
      $schema: DRAFT7,
      type: 'object',
      required: ['code'],
      properties: { code: { type: 'string', enum: ['a', 'b'] } },
    });
    gts.register({
      $id: 'gts.x.unit.ref.target.v1.1~',
      $schema: DRAFT7,
      type: 'object',
      required: ['code'],
      properties: { code: { type: 'string', enum: ['a', 'b', 'c'] } },
    });
    gts.register({
      $id: 'gts.x.unit.ref.holder.v1.0~',
      $schema: DRAFT7,
      type: 'object',
      required: ['detail'],
      properties: { detail: { $ref: 'gts://gts.x.unit.ref.target.v1.0~' } },
    });
    gts.register({
      $id: 'gts.x.unit.ref.holder.v1.1~',
      $schema: DRAFT7,
      type: 'object',
      required: ['detail'],
      properties: { detail: { $ref: 'gts://gts.x.unit.ref.target.v1.1~' } },
    });

    const result = gts.checkCompatibility('gts.x.unit.ref.holder.v1.0~', 'gts.x.unit.ref.holder.v1.1~');

    // The verdict follows the effective resolved schemas, not the identifiers.
    expect(result.backward_compatibility).toBe('compatible');
    expect(result.forward_compatibility).toBe('incompatible');
  });
});

describe('OP#8 - SchemaResolver.resolve() is bounded by a path-count budget', () => {
  // `SchemaResolver.resolve()` does not cache resolved `$ref` targets across
  // sibling `allOf` branches: a diamond ancestor reached through more than
  // one path is re-resolved from scratch every time (caching by target id is
  // unsound here - the same ancestor can legitimately be reached at
  // different depths, and `resolve()`'s own `MAX_SCHEMA_DEPTH` bailout must
  // be evaluated fresh at each). Without a cache, a diamond-shaped `allOf`/
  // `$ref` graph makes `resolve()` itself - independent of anything
  // downstream - cost time exponential in the number of root-to-leaf paths
  // through it. `resolve()` counts every `$ref` follow and `allOf` branch
  // recursion against the same shared `MAX_SCHEMA_PATHS` budget (10,000)
  // `resolveTraitSchemaRefs` uses, and bails out the same way this class
  // already bails out on `MAX_SCHEMA_DEPTH`: marking the affected branch
  // unresolved so the verdict fails closed to `unknown`, never a false
  // `compatible` *or* a false, definitive `incompatible`.

  const baseType = (id: string, extra: Record<string, unknown> = {}) => ({
    $id: id,
    $schema: DRAFT7,
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
    ...extra,
  });

  test('a chain where every level doubles its composition paths is rejected fast, not with a multi-second/OOM resolve', () => {
    // Each level's `allOf` is `[{$ref: prev}, {$ref: prev}]` - the same
    // ancestor referenced twice - so composition paths double exactly once
    // per level. 12 levels alone (2^12 = 4096 branch points, each also
    // following a `$ref`) already clears the 10,000-path budget, so this
    // stays small and fast even though, pre-fix, this exact shape measured
    // in the tens of seconds by 30 levels.
    const gts = new GTS({ validateRefs: false });

    const prev = 'gts.x.unit.compatpathbudget.a0.v1~';
    gts.register(baseType(prev));

    const DEPTH = 12;
    let cur = prev;
    for (let i = 1; i <= DEPTH; i++) {
      const next = `gts.x.unit.compatpathbudget.a${i}.v1~`;
      gts.register(baseType(next, { allOf: [{ $ref: `gts://${cur}` }, { $ref: `gts://${cur}` }] }));
      cur = next;
    }

    const start = Date.now();
    const result = gts.checkCompatibility(cur, cur);
    const elapsedMs = Date.now() - start;

    // Fail-closed: budget exhaustion must downgrade to `unknown`, never a
    // false, definitive `incompatible` - a schema compared with itself can
    // never genuinely be incompatible with itself.
    expect(result.backward_compatibility).toBe('unknown');
    expect(result.forward_compatibility).toBe('unknown');
    // Well under a second - this must fail fast, not hang.
    expect(elapsedMs).toBeLessThan(500);
  });

  test('a legitimate, well under-budget doubling chain still resolves to a genuine compatible verdict', () => {
    // Control for the guard above, using the same doubling shape at a depth
    // (8 levels, 256 paths) nowhere near the 10,000-path budget.
    const gts = new GTS({ validateRefs: false });

    const prev = 'gts.x.unit.compatpathbudgetok.a0.v1~';
    gts.register(baseType(prev));

    const DEPTH = 8;
    let cur = prev;
    for (let i = 1; i <= DEPTH; i++) {
      const next = `gts.x.unit.compatpathbudgetok.a${i}.v1~`;
      gts.register(baseType(next, { allOf: [{ $ref: `gts://${cur}` }, { $ref: `gts://${cur}` }] }));
      cur = next;
    }

    const start = Date.now();
    const result = gts.checkCompatibility(cur, cur);
    const elapsedMs = Date.now() - start;

    expect(result.backward_compatibility).toBe('compatible');
    expect(result.forward_compatibility).toBe('compatible');
    expect(elapsedMs).toBeLessThan(500);
  });

  test('a legitimate, realistic two-ancestor diamond chain resolves correctly and quickly', () => {
    // Control using the shape a real derivation hierarchy would actually
    // take: level i's `allOf` reaches both level i-1 and level i-2. This
    // grows far more slowly than the doubling shape above (it follows
    // Fibonacci-rate growth in composition paths, not 2^n), so a
    // meaningfully large hierarchy (14 levels) still resolves to a genuine
    // answer well within the path budget.
    const gts = new GTS({ validateRefs: false });

    const prevA = 'gts.x.unit.compatdiamondok.a0.v1~';
    const prevB = 'gts.x.unit.compatdiamondok.b0.v1~';
    gts.register(baseType(prevA, { properties: { id: { type: 'string' }, p0: { type: 'string' } } }));
    gts.register(baseType(prevB, { properties: { id: { type: 'string' }, q0: { type: 'string' } } }));

    const DEPTH = 14;
    let a = prevA;
    let b = prevB;
    for (let i = 1; i <= DEPTH; i++) {
      const next = `gts.x.unit.compatdiamondok.a${i}.v1~`;
      gts.register(baseType(next, { allOf: [{ $ref: `gts://${a}` }, { $ref: `gts://${b}` }] }));
      b = a;
      a = next;
    }

    const start = Date.now();
    const result = gts.checkCompatibility(a, a);
    const elapsedMs = Date.now() - start;

    expect(result.backward_compatibility).toBe('compatible');
    expect(result.forward_compatibility).toBe('compatible');
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe('OP#8 - patternProperties makes a closed model inconclusive (PR #16 review recommended fix)', () => {
  // In Draft-07, `additionalProperties` applies only to properties matched by
  // neither `properties` nor `patternProperties` - so a level closed with
  // `additionalProperties: false` beside a live `patternProperties` map is
  // NOT actually fully closed the way `contentModel()` would otherwise model
  // it. Two schemas differing only in whether a pattern-matching property is
  // ALSO restated under `properties` are truly identical in what they
  // accept, but without this fix the engine reported them `incompatible`.
  test('restating a pattern-matching property under properties is inconclusive, not incompatible', () => {
    const gts = new GTS({ validateRefs: false });
    gts.register({
      $id: 'gts.x.unit.patternprops.implicit.v1~',
      $schema: DRAFT7,
      type: 'object',
      patternProperties: { '^x-': { type: 'string' } },
      additionalProperties: false,
    });
    gts.register({
      $id: 'gts.x.unit.patternprops.explicit.v1~',
      $schema: DRAFT7,
      type: 'object',
      properties: { 'x-extra': { type: 'string' } },
      patternProperties: { '^x-': { type: 'string' } },
      additionalProperties: false,
    });

    const result = gts.checkCompatibility(
      'gts.x.unit.patternprops.implicit.v1~',
      'gts.x.unit.patternprops.explicit.v1~'
    );

    expect(result.backward_compatibility).toBe('unknown');
    expect(result.forward_compatibility).toBe('unknown');
  });

  test('a schema without patternProperties still compares normally against a plain closed model', () => {
    const gts = new GTS({ validateRefs: false });
    gts.register({
      $id: 'gts.x.unit.patternprops.plaina.v1~',
      $schema: DRAFT7,
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
    gts.register({
      $id: 'gts.x.unit.patternprops.plainb.v1~',
      $schema: DRAFT7,
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      additionalProperties: false,
    });

    const result = gts.checkCompatibility('gts.x.unit.patternprops.plaina.v1~', 'gts.x.unit.patternprops.plainb.v1~');
    // A genuinely closed model with no patternProperties still reports a
    // real, definitive verdict - the new gate must not blur real cases.
    // (`new` admits an extra `b` property that `old`'s closed model rejects,
    // so `new` is not forward-compatible with `old`.)
    expect(result.forward_compatibility).toBe('incompatible');
  });
});

// Phase 1 - spec 0.13 §9.2: "when the compared schemas declare different JSON
// Schema dialects, backward, forward and full compatibility MUST all be
// `unknown`. Equivalent URI spellings of the same dialect MUST be treated as
// the same dialect." Mirrors gts-rust `schema_evolution.rs`:
// `canonical_dialect` (strips a trailing `#` and the `http(s)://` scheme
// before comparing) and `check_inclusion`, where a `DialectChanged` finding is
// one of only two `is_inconclusive` findings, so
// `CompatibilityVerdict::from_diagnostics` yields `Unknown` and
// `CompatibilityVerdict::full` propagates it.
//
// Canonical cases: `TestCaseTestOp8Compatibility_DistinctDialects`
// (test_op8_compatibility_checking.py:1726) and its neighbouring
// `dialect_equivalent` case (same file, immediately above); gts-rust pin:
// gts/src/schema_evolution_test.rs:825-896.
describe('OP#8 - declared JSON Schema dialect equivalence and mismatch (spec 0.13 §9.2)', () => {
  // TODO(phase-1): `src/compatibility.ts` treats `$schema` purely as an
  // annotation (see the `$schema: { kind: 'annotation' }` entry in the
  // `KEYWORDS` table) and never compares the two declared dialects at all.
  // Implementing this requires: (1) reading `$schema` off each side's raw
  // registered content (not just the flattened/walked schema, since $schema
  // is a document-level keyword), (2) a `canonicalDialect()` normalizer that
  // strips a trailing `#` and the `http`/`https` scheme before comparing, and
  // (3) forcing backward/forward/full to `unknown` whenever the canonical
  // dialects differ, before (or regardless of) any other structural
  // comparison - mirroring gts-rust's `DialectChanged` being inconclusive.
  test('schemas declaring different JSON Schema dialects are unknown across all three verdicts, even when otherwise identical', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.dialectchanged.event.v1.0~';
    const newId = 'gts.x.unit.dialectchanged.event.v1.1~';

    gts.register({ $id: oldId, $schema: 'https://json-schema.org/draft-07/schema', type: 'string' });
    gts.register({ $id: newId, $schema: 'http://json-schema.org/draft/2020-12/schema#', type: 'string' });

    const result = gts.checkCompatibility(oldId, newId);

    expect(result.backward_compatibility).toBe('unknown');
    expect(result.forward_compatibility).toBe('unknown');
    expect(result.full_compatibility).toBe('unknown');
  });

  test('a genuine dialect change is unknown, not incompatible, even when the schemas would otherwise be provably incompatible', () => {
    // Without the dialect gate, this pair is a plain provable incompatibility
    // (adding a new required property to a closed model - see the
    // "adding new required property (closed model)" row above). The dialect
    // gate must take priority and report `unknown`, not let the structural
    // comparison run and report `incompatible`.
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.dialectstrict.event.v1.0~';
    const newId = 'gts.x.unit.dialectstrict.event.v1.1~';

    gts.register({
      $id: oldId,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
    gts.register({
      $id: newId,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      additionalProperties: false,
    });

    const result = gts.checkCompatibility(oldId, newId);

    expect(result.backward_compatibility).toBe('unknown');
    expect(result.forward_compatibility).toBe('unknown');
    expect(result.full_compatibility).toBe('unknown');
  });

  test('equivalent dialect URI spellings (scheme and trailing "#") are the same dialect and do not force unknown', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.dialectequiv.event.v1.0~';
    const newId = 'gts.x.unit.dialectequiv.event.v1.1~';

    // Same dialect (Draft-07), spelled with the `http` scheme and no trailing
    // `#` on `old`, and the `https` scheme with a trailing `#` on `new` - the
    // canonical `dialect_equivalent` case pins the `http`/`https` half of
    // this; the trailing `#` half is the other normalization gts-rust's
    // `canonical_dialect()` performs, so both are asserted together here.
    gts.register({ $id: oldId, $schema: 'http://json-schema.org/draft-07/schema', type: 'string' });
    gts.register({ $id: newId, $schema: 'https://json-schema.org/draft-07/schema#', type: 'string' });

    const result = gts.checkCompatibility(oldId, newId);

    // Not "unknown": the dialect gate must not fire for equivalent spellings,
    // so the identical-schema comparison proceeds and decides normally.
    expect(result.backward_compatibility).toBe('compatible');
    expect(result.forward_compatibility).toBe('compatible');
    expect(result.full_compatibility).toBe('compatible');
  });
});

// Phase 1 - spec 0.13 §9.2 / gts-rust `schema_cast.rs`: `GtsEntityCastResult`
// carries `backward_compatibility` / `forward_compatibility` /
// `full_compatibility` verdict fields computed by `cast()` (@131-136) BEFORE
// the instance transform runs, and `undecided()` / `undecided_with_direction()`
// default all three to `Unknown`. A successful cast (the instance transforms
// and validates) does not by itself imply any of the three verdicts.
//
// Canonical cases: `TestCaseTestOp9Cast_EnumRemoved` / `_EnumAdded` /
// `_DistinctDialects` / `_AllOfHiddenConstraintVisible`
// (test_op9_version_casting.py:532-659), all of which assert
// `body.backward_compatibility` / `body.forward_compatibility` /
// `body.full_compatibility` string verdicts on the `/cast` response.
describe('OP#9 - cast reports three-valued compatibility verdicts (spec 0.13 §9.2)', () => {
  // TODO(phase-1): `GtsStore.castInstance()` / `GTS.castInstanceRaw()` only
  // return boolean `is_backward_compatible` / `is_forward_compatible` /
  // `is_fully_compatible` flags (see the shape asserted in the "structural
  // gap" note below) - there is no `backward_compatibility` /
  // `forward_compatibility` / `full_compatibility` string-verdict field at
  // all, and no way for a cast to report `unknown` (a dialect mismatch during
  // cast currently reports `is_backward_compatible: true` /
  // `is_forward_compatible: true`, i.e. compatible, and cannot report
  // `unknown`). This needs `GtsEntityCastResult`-equivalent three-valued
  // fields wired from the same `GtsCompatibility` verdict machinery
  // `checkCompatibility()` already exposes, computed independently of whether
  // the instance transform itself succeeds.
  test('a successful cast does not by itself establish compatibility: a dialect mismatch stays unknown across all three verdicts', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.castdialect.event.v1.0~';
    const newId = 'gts.x.unit.castdialect.event.v1.1~';
    const instanceId = `${oldId}x.unit._.source.v1`;

    gts.register({
      $id: oldId,
      $schema: 'https://json-schema.org/draft-07/schema',
      type: 'object',
      properties: { status: { type: 'string' } },
    });
    gts.register({
      $id: newId,
      $schema: 'http://json-schema.org/draft/2020-12/schema#',
      type: 'object',
      properties: { status: { type: 'string' } },
    });
    gts.register({ id: instanceId, type: oldId, status: 'active' });

    const result = gts.castInstanceRaw(instanceId, newId);

    // The cast itself succeeds (the instance transforms and validates)...
    expect(result.casted_entity.status).toBe('active');
    // ...but that success must not be read as compatibility: the differing
    // declared dialects make all three verdicts unknown, not compatible.
    expect(result.backward_compatibility).toBe('unknown');
    expect(result.forward_compatibility).toBe('unknown');
    expect(result.full_compatibility).toBe('unknown');
  });

  test('removing an enum on cast reports compatible/incompatible/incompatible, matching checkCompatibility', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.castenumremoved.event.v1.0~';
    const newId = 'gts.x.unit.castenumremoved.event.v1.1~';
    const instanceId = `${oldId}x.unit._.instance.v1`;

    gts.register({
      $id: oldId,
      $schema: DRAFT7,
      type: 'object',
      required: ['status'],
      properties: { status: { allOf: [{ type: 'string', enum: ['active', 'inactive'] }] } },
    });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      required: ['status'],
      properties: { status: { allOf: [{ type: 'string' }] } },
    });
    gts.register({ id: instanceId, type: oldId, status: 'active' });

    const result = gts.castInstanceRaw(instanceId, newId);

    expect(result.casted_entity.status).toBe('active');
    expect(result.backward_compatibility).toBe('compatible');
    expect(result.forward_compatibility).toBe('incompatible');
    expect(result.full_compatibility).toBe('incompatible');
  });

  test('adding an enum on cast reports incompatible/compatible/incompatible, matching checkCompatibility', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.castenumadded.event.v1.0~';
    const newId = 'gts.x.unit.castenumadded.event.v1.1~';
    const instanceId = `${oldId}x.unit._.instance.v1`;

    gts.register({
      $id: oldId,
      $schema: DRAFT7,
      type: 'object',
      required: ['status'],
      properties: { status: { allOf: [{ type: 'string' }] } },
    });
    gts.register({
      $id: newId,
      $schema: DRAFT7,
      type: 'object',
      required: ['status'],
      properties: { status: { allOf: [{ type: 'string', enum: ['active', 'inactive'] }] } },
    });
    gts.register({ id: instanceId, type: oldId, status: 'active' });

    const result = gts.castInstanceRaw(instanceId, newId);

    expect(result.casted_entity.status).toBe('active');
    expect(result.backward_compatibility).toBe('incompatible');
    expect(result.forward_compatibility).toBe('compatible');
    expect(result.full_compatibility).toBe('incompatible');
  });
});

// Phase 1 - spec 0.13 §9.2 / gts-rust `classify_object_levels`: a constraint
// restated only inside an `allOf` branch of the target schema must still be
// honored as part of the target's effective (intersected) closure - it is not
// "hidden" just because it is not a top-level keyword.
//
// Canonical case: `TestCaseTestOp9Cast_AllOfHiddenConstraintVisible`
// (test_op9_version_casting.py:625); gts-rust pin:
// gts/src/schema_evolution_test.rs:1548-1637.
describe('OP#9 - a constraint visible only through an allOf branch is honored (spec 0.13 §9.2)', () => {
  test('an allOf-composed minLength intersection tightens the effective bound, so backward compatibility is incompatible', () => {
    const gts = new GTS({ validateRefs: false });
    const oldId = 'gts.x.unit.allofhidden.event.v1.0~';
    const newId = 'gts.x.unit.allofhidden.event.v1.1~';

    gts.register({
      $id: oldId,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 } },
    });
    // The two allOf branches restate `name` with different minLength bounds;
    // the effective (intersected) constraint is minLength: 5, tightening
    // old's minLength: 1.
    gts.register({
      $id: newId,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      allOf: [
        { properties: { name: { type: 'string', minLength: 1 } } },
        { properties: { name: { type: 'string', minLength: 5 } } },
      ],
    });

    const result = gts.checkCompatibility(oldId, newId);

    expect(result.backward_compatibility).toBe('incompatible');
  });
});
