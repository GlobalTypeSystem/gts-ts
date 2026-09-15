import { GTS } from '../src';

/**
 * Phase 2 - JSON Schema format assertions (ADR-0005, README §9.2).
 *
 * OP#6 and OP#13 MUST enforce `uuid`, `email`, `date-time`, `date`, `time`,
 * `uri`, `hostname`, `ipv4`, `ipv6` and `regex` (ECMA 262 dialect) as
 * *assertions*, not annotations, on string values.
 *
 * `src/store.ts` currently constructs its Ajv instance with
 * `validateFormats: false` and never registers `ajv-formats`, so today every
 * assertion below that expects an *invalid*-format value to be REJECTED is
 * expected to FAIL - that is the intended, precise signal for the next
 * (implementation) step. Assertions that expect a *valid*-format value to be
 * ACCEPTED currently pass, but pass vacuously: no format checking happens at
 * all right now, so an accept-path assertion proves nothing about format
 * enforcement by itself - it is included only so the table stays complete and
 * regressions are caught once format assertions are wired in.
 *
 * Both OP#6 (`GtsStore.validateInstance`, `src/store.ts:238`) and OP#13
 * (`GtsStore.validateSchemaTraits`, `src/store.ts:1133`) compile schemas
 * through the *same* `this.ajv` instance constructed once in the
 * `GtsStore` constructor (`src/store.ts:50-58`) - there is only one Ajv
 * instance per store, not a separate one for instance vs. trait validation.
 * The two describe blocks below exist to prove that empirically rather than
 * assume it: if the implementation step ever diverges the two paths, one of
 * these blocks would start failing while the other passes.
 */

const DRAFT7 = 'http://json-schema.org/draft-07/schema#';

/**
 * Canonical `_STANDARD_FORMATS` table, ported verbatim from
 * `.gts-spec/tests/test_op6_schema_validation.py:842-859` (OP#6) and mirrored
 * by `_STANDARD_TRAIT_FORMATS` in
 * `.gts-spec/tests/test_op13_schema_traits_validation.py:5001-5017` (OP#13) -
 * the two fixture tables are identical in content.
 *
 * Two rows deliberately encode requirements STRICTER than `ajv-formats`'
 * defaults, so the implementation step cannot satisfy this table by merely
 * calling `addFormats(ajv)`:
 *  - `timeValueOffset`: draft-07 `time` format requires the timezone offset;
 *    `ajv-formats` treats it as optional, so `"10:30:00"` (no offset) must
 *    still be rejected here.
 *  - `dateTimeValueT`: `"2011-07-22T10:30:00"` (no timezone) must be
 *    rejected for the same reason, applied to `date-time`.
 * Two more rows assert offset *bounds* (`+25:00` is not a valid UTC offset)
 * for both `date-time` and `time`, which a naive offset-presence-only check
 * would not catch.
 */
const STANDARD_FORMATS: ReadonlyArray<[field: string, format: string, valid: string, invalid: string]> = [
  ['uuidValue', 'uuid', '550e8400-e29b-41d4-a716-446655440000', 'not-a-uuid'],
  ['emailValue', 'email', 'user@example.com', 'not-an-email'],
  ['dateTimeValue', 'date-time', '2008-10-12T10:30:00Z', '2008-10-12 10:30:00Z'],
  // Stricter than ajv-formats: no timezone offset must be rejected.
  ['dateTimeValueT', 'date-time', '2011-07-22T10:30:00Z', '2011-07-22T10:30:00'],
  ['dateTimeFracValue', 'date-time', '2025-06-19T10:30:00.123Z', '2025-06-19T10:30:61.123Z'],
  // Stricter than a naive offset-presence check: offset hour 25 is out of bounds.
  ['dateTimeTZValue', 'date-time', '2027-04-26T10:30:00+01:00', '2027-04-26T10:30:00+25:00'],
  ['dateValue', 'date', '2025-01-15', '2025-13-40'],
  // Stricter than ajv-formats: draft-07 `time` requires the offset, ajv-formats treats it as optional.
  ['timeValueOffset', 'time', '10:30:00Z', '10:30:00'],
  ['timeValueOverflow', 'time', '10:30:00Z', '10:00:61Z'],
  ['timeValueFracZ', 'time', '10:30:00.123Z', '10:00:61.123Z'],
  // Stricter than a naive offset-presence check: offset hour 25 is out of bounds.
  ['timeValueTZ', 'time', '10:30:00+01:00', '10:30:00+25:00'],
  ['uriValue', 'uri', 'https://example.com/resource', '://not-a-uri'],
  ['hostnameValue', 'hostname', 'example.com', 'not a hostname'],
  ['ipv4Value', 'ipv4', '192.168.1.1', '999.999.999.999'],
  ['ipv6Value', 'ipv6', '2001:db8::1', 'not-an-ipv6-address'],
  ['regexValue', 'regex', '^[A-Za-z0-9]+$', '[unclosed'],
];

/**
 * Canonical ECMA 262 regex fixtures, ported verbatim from
 * `.gts-spec/tests/test_op6_schema_validation.py:943-966` (OP#6) - the OP#13
 * mirror at `test_op13_schema_traits_validation.py:5120-5140` uses a subset
 * (drops `optional_escaped_slash` and `unmatched_paren`), reproduced below as
 * `REGEX_ECMA262_TRAIT_VALID` / `REGEX_ECMA262_TRAIT_INVALID`.
 */
const REGEX_ECMA262_VALID: ReadonlyArray<[label: string, pattern: string]> = [
  ['anchored_class', '^[A-Za-z0-9]+$'],
  ['shorthand_bounded', '\\d{3}-\\d{4}'],
  ['group_alternation', '(foo|bar)+'],
  ['range_bounded', '[a-z]{1,3}'],
  ['optional_escaped_slash', '^(https?):\\/\\/'],
  ['lazy_quantifier', 'a.*?b'],
  ['nested_groups', '(a(b)?c)*'],
  ['class_shorthand', '[\\s\\S]*'],
  ['escaped_metachar', '\\(\\d+\\)'],
];

const REGEX_ECMA262_INVALID: ReadonlyArray<[label: string, pattern: string]> = [
  ['unterminated_class', '[unclosed'],
  ['unterminated_group', '(unclosed'],
  ['reversed_quantifier', 'a{3,2}'],
  ['trailing_backslash', '\\'],
  ['leading_quantifier', '*abc'],
  ['unmatched_paren', 'a)'],
  ['dangling_quantifier', 'a**'],
];

const REGEX_ECMA262_TRAIT_VALID: ReadonlyArray<[label: string, pattern: string]> = [
  ['anchored_class', '^[A-Za-z0-9]+$'],
  ['shorthand_bounded', '\\d{3}-\\d{4}'],
  ['group_alternation', '(foo|bar)+'],
  ['range_bounded', '[a-z]{1,3}'],
  ['nested_groups', '(a(b)?c)*'],
  ['class_shorthand', '[\\s\\S]*'],
];

const REGEX_ECMA262_TRAIT_INVALID: ReadonlyArray<[label: string, pattern: string]> = [
  ['unterminated_class', '[unclosed'],
  ['unterminated_group', '(unclosed'],
  ['reversed_quantifier', 'a{3,2}'],
  ['trailing_backslash', '\\'],
  ['leading_quantifier', '*abc'],
  ['dangling_quantifier', 'a**'],
];

function standardFormatProperties(rows: ReadonlyArray<[string, string, string, string]> = STANDARD_FORMATS) {
  return Object.fromEntries(rows.map(([field, format]) => [field, { type: 'string', format }]));
}

function standardFormatValues(rows: ReadonlyArray<[string, string, string, string]> = STANDARD_FORMATS) {
  return Object.fromEntries(rows.map(([field, , valid]) => [field, valid]));
}

describe('Phase 2 - ADR-0005 JSON Schema format assertions', () => {
  describe('OP#6 - instance validation enforces standard formats (test_op6_schema_validation.py:873)', () => {
    const TYPE_ID = 'gts.x.unit.fmt6.standard.v1~';

    function setup() {
      const gts = new GTS();
      gts.register({
        $id: TYPE_ID,
        $schema: DRAFT7,
        type: 'object',
        required: STANDARD_FORMATS.map(([field]) => field),
        properties: standardFormatProperties(),
      });
      return gts;
    }

    test('accepts an instance whose fields all carry valid standard-format values', () => {
      // NOTE: passes vacuously today - with validateFormats disabled and no
      // format registered, this instance would validate even if every field
      // were nonsense. It only becomes a meaningful assertion once format
      // checking is wired in and the reject-path tests below also pass.
      const gts = setup();
      const id = `${TYPE_ID}x.unit._.valid_all.v1.0`;
      gts.register({ gtsId: id, $schema: TYPE_ID, ...standardFormatValues() });

      const result = gts.validateInstance(id);
      expect(result.ok).toBe(true);
    });

    test.each(STANDARD_FORMATS)(
      'rejects an instance with an invalid %s (format: %s)',
      (field, _format, _valid, invalid) => {
        const gts = setup();
        const id = `${TYPE_ID}x.unit._.invalid_${field.toLowerCase()}.v1.0`;
        gts.register({
          gtsId: id,
          $schema: TYPE_ID,
          ...standardFormatValues(),
          [field]: invalid,
        });

        const result = gts.validateInstance(id);
        expect(result.ok).toBe(false);
      }
    );
  });

  describe('OP#6 - regex format asserts the ECMA 262 dialect (test_op6_schema_validation.py:968)', () => {
    const TYPE_ID = 'gts.x.unit.fmt6.regexecma.v1~';

    function setup() {
      const gts = new GTS();
      gts.register({
        $id: TYPE_ID,
        $schema: DRAFT7,
        type: 'object',
        required: ['regexValue'],
        properties: { regexValue: { type: 'string', format: 'regex' } },
      });
      return gts;
    }

    test.each(REGEX_ECMA262_VALID)('accepts a valid ECMA 262 regex (%s)', (label, pattern) => {
      // NOTE: passes vacuously today - see the block-level comment above.
      const gts = setup();
      const id = `${TYPE_ID}x.unit._.valid_${label}.v1.0`;
      gts.register({ gtsId: id, $schema: TYPE_ID, regexValue: pattern });

      const result = gts.validateInstance(id);
      expect(result.ok).toBe(true);
    });

    test.each(REGEX_ECMA262_INVALID)('rejects a string that is not a valid ECMA 262 regex (%s)', (label, pattern) => {
      const gts = setup();
      const id = `${TYPE_ID}x.unit._.invalid_${label}.v1.0`;
      gts.register({ gtsId: id, $schema: TYPE_ID, regexValue: pattern });

      const result = gts.validateInstance(id);
      expect(result.ok).toBe(false);
    });
  });

  describe('OP#6 - uuid format rejects GTS ids (test_op6_schema_validation.py:1043)', () => {
    const TYPE_ID = 'gts.x.unit.fmt6.uuid.v1~';

    test('rejects a GTS id string in a field constrained by format: uuid', () => {
      // A GTS chained identifier (`gts.<...>.v1~<...>.v1.0`) is a different
      // shape from RFC 4122 UUID and MUST be rejected by `format: uuid` -
      // this matters because GTS ids and UUIDs are easy to conflate, and a
      // format checker that is merely "any non-empty string" would let this
      // slip through.
      const gts = new GTS();
      gts.register({
        $id: TYPE_ID,
        $schema: DRAFT7,
        type: 'object',
        required: ['uuidValue'],
        properties: { uuidValue: { type: 'string', format: 'uuid' } },
      });

      const id = `${TYPE_ID}x.unit._.gts_id.v1.0`;
      gts.register({
        gtsId: id,
        $schema: TYPE_ID,
        uuidValue: `${TYPE_ID}550e8400-e29b-41d4-a716-446655440000`,
      });

      const result = gts.validateInstance(id);
      expect(result.ok).toBe(false);
    });
  });

  describe('OP#13 - trait validation enforces standard formats (test_op13_schema_traits_validation.py: TestCaseOp13_TraitsInvalid_StandardFormats)', () => {
    const BASE_ID = 'gts.x.unit.fmt13.standard.v1~';

    function baseType() {
      return {
        $id: BASE_ID,
        $schema: DRAFT7,
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
        'x-gts-traits-schema': {
          type: 'object',
          additionalProperties: false,
          properties: standardFormatProperties(),
        },
      };
    }

    function derivedType(id: string, traits: Record<string, unknown>) {
      return {
        $id: id,
        $schema: DRAFT7,
        type: 'object',
        allOf: [{ $ref: `gts://${BASE_ID}` }, { type: 'object' }],
        'x-gts-traits': traits,
      };
    }

    test('accepts a derived type whose traits all carry valid standard-format values', () => {
      // NOTE: passes vacuously today - see the block-level comment above; it
      // proves the trait-validation path compiles at all, not that it
      // enforces formats.
      const gts = new GTS({ validateRefs: false });
      gts.register(baseType());
      const id = `${BASE_ID}x.unit._.valid_all.v1~`;
      gts.register(derivedType(id, standardFormatValues()));

      const result = gts.validateSchemaAgainstParent(id);
      expect(result.ok).toBe(true);
    });

    test.each(STANDARD_FORMATS)(
      'rejects a derived type with an invalid trait %s (format: %s)',
      (field, _format, _valid, invalid) => {
        const gts = new GTS({ validateRefs: false });
        gts.register(baseType());
        const id = `${BASE_ID}x.unit._.invalid_${field.toLowerCase()}.v1~`;
        gts.register(derivedType(id, { ...standardFormatValues(), [field]: invalid }));

        const result = gts.validateSchemaAgainstParent(id);
        expect(result.ok).toBe(false);
      }
    );
  });

  describe('OP#13 - trait regex format asserts the ECMA 262 dialect (test_op13_schema_traits_validation.py: TestCaseOp13_Traits_RegexEcma262)', () => {
    const BASE_ID = 'gts.x.unit.fmt13.regexecma.v1~';

    function baseType() {
      return {
        $id: BASE_ID,
        $schema: DRAFT7,
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
        'x-gts-traits-schema': {
          type: 'object',
          additionalProperties: false,
          properties: { regexValue: { type: 'string', format: 'regex' } },
        },
      };
    }

    function derivedType(id: string, regexValue: string) {
      return {
        $id: id,
        $schema: DRAFT7,
        type: 'object',
        allOf: [{ $ref: `gts://${BASE_ID}` }, { type: 'object' }],
        'x-gts-traits': { regexValue },
      };
    }

    test.each(REGEX_ECMA262_TRAIT_VALID)('accepts a valid ECMA 262 regex trait (%s)', (label, pattern) => {
      // NOTE: passes vacuously today - see the block-level comment above.
      const gts = new GTS({ validateRefs: false });
      gts.register(baseType());
      const id = `${BASE_ID}x.unit._.valid_${label}.v1~`;
      gts.register(derivedType(id, pattern));

      const result = gts.validateSchemaAgainstParent(id);
      expect(result.ok).toBe(true);
    });

    test.each(REGEX_ECMA262_TRAIT_INVALID)(
      'rejects a trait value that is not a valid ECMA 262 regex (%s)',
      (label, pattern) => {
        const gts = new GTS({ validateRefs: false });
        gts.register(baseType());
        const id = `${BASE_ID}x.unit._.invalid_${label}.v1~`;
        gts.register(derivedType(id, pattern));

        const result = gts.validateSchemaAgainstParent(id);
        expect(result.ok).toBe(false);
      }
    );
  });
});
