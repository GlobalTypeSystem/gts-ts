import { GTS, GtsModifiers } from '../src';

const DRAFT7 = 'http://json-schema.org/draft-07/schema#';

describe('GTS Type Schema Modifiers (spec §9.11)', () => {
  describe('reading the modifiers', () => {
    test('only the literal `true` enables a modifier', () => {
      expect(GtsModifiers.isFinal({ 'x-gts-final': true })).toBe(true);
      expect(GtsModifiers.isFinal({ 'x-gts-final': false })).toBe(false);
      expect(GtsModifiers.isFinal({})).toBe(false);
      // A non-boolean is invalid, and must not be read as truthy.
      expect(GtsModifiers.isFinal({ 'x-gts-final': 'yes' })).toBe(false);

      expect(GtsModifiers.isAbstract({ 'x-gts-abstract': true })).toBe(true);
      expect(GtsModifiers.isAbstract({ 'x-gts-abstract': false })).toBe(false);
      expect(GtsModifiers.isAbstract({})).toBe(false);
    });
  });

  describe('validateDeclaration', () => {
    test('accepts absent, false and true declarations', () => {
      expect(GtsModifiers.validateDeclaration({})).toBeNull();
      expect(GtsModifiers.validateDeclaration({ 'x-gts-final': true })).toBeNull();
      expect(GtsModifiers.validateDeclaration({ 'x-gts-abstract': true })).toBeNull();
      expect(GtsModifiers.validateDeclaration({ 'x-gts-final': true, 'x-gts-abstract': false })).toBeNull();
    });

    test('rejects non-boolean values', () => {
      expect(GtsModifiers.validateDeclaration({ 'x-gts-final': 'yes' })).toContain('x-gts-final');
      expect(GtsModifiers.validateDeclaration({ 'x-gts-abstract': 1 })).toContain('x-gts-abstract');
    });

    test('rejects the meaningless final + abstract combination', () => {
      const error = GtsModifiers.validateDeclaration({ 'x-gts-final': true, 'x-gts-abstract': true });
      expect(error).toMatch(/must not declare both/);
    });
  });

  describe('findMisplacedKeywords', () => {
    test('accepts all four keywords at the document top level', () => {
      expect(
        GtsModifiers.findMisplacedKeywords({
          $$id: 'gts.x.unit.mod.top.v1~',
          type: 'object',
          'x-gts-final': true,
          'x-gts-traits-schema': { type: 'object', properties: { a: { type: 'string' } } },
          'x-gts-traits': { a: 'value' },
        })
      ).toEqual([]);
    });

    test('rejects a modifier nested in an allOf entry', () => {
      const found = GtsModifiers.findMisplacedKeywords({
        type: 'object',
        allOf: [{ $$ref: 'gts://gts.x.unit.mod.base.v1~' }, { type: 'object', 'x-gts-final': true }],
      });
      expect(found).toEqual(['allOf[1]/x-gts-final']);
    });

    test('rejects a keyword nested in a property subschema', () => {
      const found = GtsModifiers.findMisplacedKeywords({
        type: 'object',
        properties: { nested: { type: 'object', 'x-gts-traits': { topicRef: 'x' } } },
      });
      expect(found).toEqual(['properties/nested/x-gts-traits']);
    });

    test('rejects a keyword nested in a definitions entry', () => {
      const found = GtsModifiers.findMisplacedKeywords({
        type: 'object',
        definitions: { Sub: { type: 'object', 'x-gts-abstract': true } },
      });
      expect(found).toEqual(['definitions/Sub/x-gts-abstract']);
    });

    test('reports every misplacement, not just the first', () => {
      const found = GtsModifiers.findMisplacedKeywords({
        type: 'object',
        allOf: [{ 'x-gts-abstract': true }],
        properties: { nested: { 'x-gts-final': true } },
      });
      expect(found).toHaveLength(2);
    });

    test('rejects a keyword nested under contains', () => {
      const found = GtsModifiers.findMisplacedKeywords({
        type: 'array',
        contains: { 'x-gts-final': true },
      });
      expect(found).toEqual(['contains/x-gts-final']);
    });

    test('rejects a keyword nested under propertyNames', () => {
      const found = GtsModifiers.findMisplacedKeywords({
        type: 'object',
        propertyNames: { 'x-gts-final': true },
      });
      expect(found).toEqual(['propertyNames/x-gts-final']);
    });

    test('rejects a keyword nested under additionalItems', () => {
      const found = GtsModifiers.findMisplacedKeywords({
        type: 'array',
        additionalItems: { 'x-gts-final': true },
      });
      expect(found).toEqual(['additionalItems/x-gts-final']);
    });

    test('rejects a keyword nested in a dependencies entry using the schema-dependency form', () => {
      const found = GtsModifiers.findMisplacedKeywords({
        type: 'object',
        dependencies: { n: { 'x-gts-final': true } },
      });
      expect(found).toEqual(['dependencies/n/x-gts-final']);
    });

    test('does not scan a dependencies entry using the property-dependency (array) form', () => {
      const found = GtsModifiers.findMisplacedKeywords({
        type: 'object',
        dependencies: { n: ['a', 'b'] },
      });
      expect(found).toEqual([]);
    });

    test('rejects a keyword nested in a dependentSchemas entry', () => {
      const found = GtsModifiers.findMisplacedKeywords({
        type: 'object',
        dependentSchemas: { creditCard: { 'x-gts-final': true } },
      });
      expect(found).toEqual(['dependentSchemas/creditCard/x-gts-final']);
    });

    test('fails closed when a document is nested too deeply to scan', () => {
      // The recursion guard must not let a subtree through unchecked: a
      // keyword hidden below the limit would otherwise be silently accepted.
      let deep: Record<string, any> = { 'x-gts-final': true };
      for (let i = 0; i < 80; i++) {
        deep = { properties: { nested: deep } };
      }

      const found = GtsModifiers.findMisplacedKeywords({ type: 'object', ...deep });
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]).toMatch(/nesting exceeds/);
    });

    test('does not descend into the values of the top-level keywords', () => {
      // A trait *value* that happens to be keyed like a keyword is ordinary
      // data, and a trait-schema body may legitimately carry x-gts-* members.
      expect(
        GtsModifiers.findMisplacedKeywords({
          type: 'object',
          'x-gts-traits': { 'x-gts-final': 'just a string value' },
          'x-gts-traits-schema': { type: 'object', properties: { 'x-gts-abstract': { type: 'boolean' } } },
        })
      ).toEqual([]);
    });

    test('does not flag a property literally named like a document-level keyword', () => {
      // `x-gts-abstract` here is a *property name* chosen by the schema
      // author, not an occurrence of the keyword - it sits in a data position
      // (a `properties` map key), not a schema position.
      expect(
        GtsModifiers.findMisplacedKeywords({
          type: 'object',
          properties: { 'x-gts-abstract': { type: 'string' } },
        })
      ).toEqual([]);
    });

    test('does not flag a property named like a keyword nested in a definitions/$defs map', () => {
      expect(
        GtsModifiers.findMisplacedKeywords({
          type: 'object',
          definitions: { Sub: { type: 'object', properties: { 'x-gts-final': { type: 'boolean' } } } },
        })
      ).toEqual([]);

      expect(
        GtsModifiers.findMisplacedKeywords({
          type: 'object',
          $defs: { Sub: { type: 'object', properties: { 'x-gts-traits': { type: 'string' } } } },
        })
      ).toEqual([]);
    });
  });
});

describe('x-gts-final / x-gts-abstract enforcement through the registry', () => {
  const base = (id: string, extra: Record<string, any> = {}) => ({
    $id: id,
    $schema: DRAFT7,
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
    ...extra,
  });

  const derived = (id: string, baseRef: string, extra: Record<string, any> = {}) => ({
    $id: id,
    $schema: DRAFT7,
    type: 'object',
    allOf: [{ $ref: `gts://${baseRef}` }, { type: 'object' }],
    ...extra,
  });

  test('a final base cannot be extended', () => {
    const gts = new GTS({ validateRefs: false });
    gts.register(base('gts.x.unit.fa.fin.v1~', { 'x-gts-final': true }));
    gts.register(derived('gts.x.unit.fa.fin.v1~x.unit._.kid.v1~', 'gts.x.unit.fa.fin.v1~'));

    const result = gts.validateEntity('gts.x.unit.fa.fin.v1~x.unit._.kid.v1~');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/final/);
  });

  test('finality does not propagate to siblings of the final type', () => {
    const gts = new GTS({ validateRefs: false });
    gts.register(base('gts.x.unit.fa.sib.v1~'));
    gts.register(derived('gts.x.unit.fa.sib.v1~x.unit._.fin.v1~', 'gts.x.unit.fa.sib.v1~', { 'x-gts-final': true }));
    gts.register(derived('gts.x.unit.fa.sib.v1~x.unit._.other.v1~', 'gts.x.unit.fa.sib.v1~'));

    expect(gts.validateEntity('gts.x.unit.fa.sib.v1~x.unit._.other.v1~').ok).toBe(true);
  });

  test('a mid-chain final type blocks its own descendants', () => {
    const gts = new GTS({ validateRefs: false });
    gts.register(base('gts.x.unit.fa.mid.v1~'));
    gts.register(derived('gts.x.unit.fa.mid.v1~x.unit._.m.v1~', 'gts.x.unit.fa.mid.v1~', { 'x-gts-final': true }));
    gts.register(
      derived('gts.x.unit.fa.mid.v1~x.unit._.m.v1~x.unit._.leaf.v1~', 'gts.x.unit.fa.mid.v1~x.unit._.m.v1~')
    );

    expect(gts.validateEntity('gts.x.unit.fa.mid.v1~x.unit._.m.v1~x.unit._.leaf.v1~').ok).toBe(false);
  });

  test('x-gts-final: false is a no-op', () => {
    const gts = new GTS({ validateRefs: false });
    gts.register(base('gts.x.unit.fa.nofin.v1~', { 'x-gts-final': false }));
    gts.register(derived('gts.x.unit.fa.nofin.v1~x.unit._.kid.v1~', 'gts.x.unit.fa.nofin.v1~'));

    expect(gts.validateEntity('gts.x.unit.fa.nofin.v1~x.unit._.kid.v1~').ok).toBe(true);
  });

  test('an abstract type rejects direct instances but allows derivation', () => {
    const gts = new GTS({ validateRefs: false });
    gts.register(base('gts.x.unit.fa.abs.v1~', { 'x-gts-abstract': true }));
    gts.register(derived('gts.x.unit.fa.abs.v1~x.unit._.concrete.v1~', 'gts.x.unit.fa.abs.v1~'));

    // Derivation from an abstract base is exactly what it is for.
    expect(gts.validateEntity('gts.x.unit.fa.abs.v1~x.unit._.concrete.v1~').ok).toBe(true);

    gts.register({ id: 'gts.x.unit.fa.abs.v1~x.unit._.direct.v1' });
    const direct = gts.validateInstance('gts.x.unit.fa.abs.v1~x.unit._.direct.v1');
    expect(direct.ok).toBe(false);
    expect(direct.error).toMatch(/abstract/);

    // An instance of the concrete derived type is fine.
    gts.register({ id: 'gts.x.unit.fa.abs.v1~x.unit._.concrete.v1~x.unit._.ok.v1' });
    expect(gts.validateInstance('gts.x.unit.fa.abs.v1~x.unit._.concrete.v1~x.unit._.ok.v1').ok).toBe(true);
  });

  test('an abstract type rejects a combined anonymous instance', () => {
    const gts = new GTS({ validateRefs: false });
    gts.register(base('gts.x.unit.fa.anon.v1~', { 'x-gts-abstract': true }));
    const anonId = 'gts.x.unit.fa.anon.v1~c1d2e3f4-5678-4abc-8def-aabbccddeeff';
    gts.register({ id: anonId, type: 'gts.x.unit.fa.anon.v1~' });

    expect(gts.validateInstance(anonId).ok).toBe(false);
  });

  test('validateEntity enforces keyword placement, like registration does', () => {
    // §9.11.5: placement is always enforced on the explicit validation
    // endpoints, so /validate-type-schema must not accept what
    // /entities?validate=true rejects.
    const gts = new GTS({ validateRefs: false });
    gts.register({
      $id: 'gts.x.unit.fa.place.v1~',
      $schema: DRAFT7,
      type: 'object',
      allOf: [{ type: 'object', 'x-gts-abstract': true }],
    });

    const result = gts.validateEntity('gts.x.unit.fa.place.v1~');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/top level/);
  });

  test('a malformed modifier declaration is rejected synchronously at registration, not only at validateEntity', () => {
    // §9.11.1 unqualifiedly requires registration itself to reject this - the
    // CLI's only ingestion path is `register()`, which never called
    // `validateEntity()`, so this must fail here rather than needing a
    // separate validation step to be caught.
    const gts = new GTS({ validateRefs: false });

    expect(() => gts.register(base('gts.x.unit.fa.bad2.v1~', { 'x-gts-final': true, 'x-gts-abstract': true }))).toThrow(
      /must not declare both/
    );
  });
});

/**
 * gts-spec v0.13.3, commit 40c6a67 ("spec: reject unknown x-gts schema
 * keywords"): "GTS schema validation MUST reject schema keywords with the
 * `x-gts-` prefix that are not defined by this specification, at the
 * document root or in any subschema. [...] This rule applies to schema
 * keywords, not instance property names or keys in literal data such as
 * `examples`, `default`, or `const`."
 *
 * Canonical suite: tests/test_op6_schema_validation.py, cases
 * TestCaseUnknown_TopLevelRejected (:2152), TestCaseUnknown_InsidePropertiesRejected
 * (:2179), TestCaseUnknown_InsideDefsRejected (:2205), TestCaseUnknown_InsideAllOfRejected
 * (:2231), TestCaseUnknown_TraitsTypoRejected (:2272), TestCaseUnknown_RefTypoRejected
 * (:2298) — all exercised at HTTP level via `POST /entities?validate=true` expecting 422.
 *
 * `checkTypeSchemaRules(content, id, { enforceGuards: true })` is the exact choke
 * point the HTTP layer calls for that request (see src/server/server.ts:177,
 * `enforceGuards: validate`) and the one `validateEntity()` calls too
 * (src/store.ts:955), so it is the right library-level surface to pin this at:
 * it is observable without spinning up the HTTP server, and any implementation
 * that satisfies the canonical suite necessarily makes these assertions pass.
 *
 * TODO(phase-3): none of the "rejected" rows below currently fail registration —
 * `checkTypeSchemaRules` has no allowlist check for x-gts-* keyword names yet
 * (it only validates the four known DOCUMENT_LEVEL_KEYWORDS' placement via
 * `GtsModifiers.findMisplacedKeywords`, and validates `x-gts-final`/`x-gts-abstract`
 * value shape via `GtsModifiers.validateDeclaration`). Implementing this needs:
 * (1) a `SUPPORTED_X_GTS_KEYWORDS` allowlist (the five names: x-gts-abstract,
 * x-gts-final, x-gts-traits, x-gts-traits-schema, x-gts-ref) exported from
 * src/modifiers.ts alongside `DOCUMENT_LEVEL_KEYWORDS`; (2) a walker that visits
 * every schema position (top level plus everything `GtsModifiers`' private
 * `scan`/`scanSubschemas` already visits for placement checking - the same
 * `SCHEMA_KEYWORD_POSITIONS` table drives both) and flags any `x-gts-*` key not
 * in the allowlist; (3) wiring that into `checkTypeSchemaRules` so both the
 * HTTP `validate=true` path and `validateEntity()` enforce it. Until then, every
 * `expect(result).not.toBeNull()` below fails because `result` is `null`.
 */
describe('unknown x-gts-* keyword rejection (gts-spec 0.13.3, commit 40c6a67)', () => {
  const gts = () => new GTS({ validateRefs: false });

  // Rows required by the canonical suite: top level, properties, definitions,
  // allOf, and the two near-miss typos of supported keyword names.
  interface RejectedRow {
    name: string;
    content: Record<string, any>;
  }

  const REQUIRED_REJECTED_ROWS: RejectedRow[] = [
    {
      name: 'unknown keyword at the document top level (TestCaseUnknown_TopLevelRejected)',
      content: {
        type: 'object',
        'x-gts-bogus': true,
        properties: { id: { type: 'string' } },
      },
    },
    {
      name: 'unknown keyword inside a properties subschema (TestCaseUnknown_InsidePropertiesRejected)',
      content: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          widget: { type: 'string', 'x-gts-widget': 'dropdown' },
        },
      },
    },
    {
      name: 'unknown keyword inside a definitions entry (TestCaseUnknown_InsideDefsRejected)',
      content: {
        type: 'object',
        properties: { id: { type: 'string' } },
        definitions: {
          Sub: { type: 'object', 'x-gts-experimental': true },
        },
      },
    },
    {
      name: 'unknown keyword inside an allOf branch (TestCaseUnknown_InsideAllOfRejected)',
      content: {
        type: 'object',
        allOf: [{ $$ref: 'gts://gts.x.testext.allof.base.v1~' }, { type: 'object', 'x-gts-policy': 'strict' }],
      },
    },
    {
      // Near-miss typo of x-gts-traits (singular). Must not be silently
      // treated as a synonym: that would drop the author's intended trait
      // values rather than fail loudly.
      name: 'x-gts-trait, a typo of x-gts-traits (TestCaseUnknown_TraitsTypoRejected)',
      content: {
        type: 'object',
        'x-gts-trait': { retention: 'P30D' },
        properties: { id: { type: 'string' } },
      },
    },
    {
      // Near-miss typo of x-gts-ref.
      name: 'x-gts-reference, a typo of x-gts-ref (TestCaseUnknown_RefTypoRejected)',
      content: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ownerRef: { type: 'string', 'x-gts-reference': 'gts.*' },
        },
      },
    },
  ];

  // Additional positions the spec text ("at the document root or in any
  // subschema") implies but the canonical suite does not name explicitly.
  // These are defensive, not required by the six target cases; they mirror
  // the positions the existing `findMisplacedKeywords` suite above already
  // exercises for the *known* document-level keywords (contains,
  // propertyNames, additionalItems, dependencies, dependentSchemas), which
  // means `GtsModifiers`'s private walker already visits them - reusing the
  // same walk for the allowlist check should cover these for free.
  const DEFENSIVE_REJECTED_ROWS: RejectedRow[] = [
    {
      name: 'unknown keyword inside a $defs entry (2019-09+ dialect analogue of definitions)',
      content: {
        type: 'object',
        properties: { id: { type: 'string' } },
        $defs: {
          Sub: { type: 'object', 'x-gts-experimental': true },
        },
      },
    },
    {
      name: 'unknown keyword inside an anyOf branch',
      content: {
        type: 'object',
        anyOf: [{ type: 'object', 'x-gts-policy': 'strict' }],
      },
    },
    {
      name: 'unknown keyword inside a oneOf branch',
      content: {
        type: 'object',
        oneOf: [{ type: 'object', 'x-gts-policy': 'strict' }],
      },
    },
    {
      name: 'unknown keyword inside patternProperties',
      content: {
        type: 'object',
        patternProperties: { '^x_': { type: 'string', 'x-gts-widget': 'dropdown' } },
      },
    },
  ];

  test.each(REQUIRED_REJECTED_ROWS)('rejects: $name', ({ content }) => {
    const result = gts().checkTypeSchemaRules(content, undefined, { enforceGuards: true });
    expect(result).not.toBeNull();
  });

  test.each(DEFENSIVE_REJECTED_ROWS)('rejects (defensive, not a named canonical case): $name', ({ content }) => {
    const result = gts().checkTypeSchemaRules(content, undefined, { enforceGuards: true });
    expect(result).not.toBeNull();
  });

  // Positive control mirroring TestCaseSupportedExtensions_Accepted (:2099):
  // all five *supported* x-gts-* keywords, in valid (top-level or x-gts-ref's
  // property-level) positions, must keep registering cleanly. This pins the
  // rejection direction above to the *unknown keyword name*, not to the
  // x-gts-* prefix wholesale - an implementation that rejected every x-gts-*
  // occurrence indiscriminately would pass every row above but fail this one.
  //
  // NOTE: this assertion is vacuously true today (nothing is rejected yet, so
  // of course `result` is null), but it stops being vacuous the moment the
  // phase-3 allowlist check exists - if the allowlist were ever satisfied by
  // simply blocking every x-gts-* keyword, this test starts failing.
  test('accepts all five supported x-gts-* keywords in valid positions (positive control)', () => {
    const result = gts().checkTypeSchemaRules(
      {
        type: 'object',
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: { retention: { type: 'string' } },
        },
        properties: {
          id: { type: 'string' },
          ownerRef: { type: 'string', 'x-gts-ref': 'gts.*' },
        },
      },
      undefined,
      { enforceGuards: true }
    );
    expect(result).toBeNull();

    const derivedResult = gts().checkTypeSchemaRules(
      {
        type: 'object',
        'x-gts-final': true,
        'x-gts-traits': { retention: 'P30D' },
        allOf: [{ $$ref: 'gts://gts.x.testext.supported.base.v1~' }],
      },
      undefined,
      { enforceGuards: true }
    );
    expect(derivedResult).toBeNull();
  });

  // Answers the "non-x-gts vendor extension" question posed by the task: a
  // plain `x-*` keyword that does NOT carry the `x-gts-` prefix is ordinary
  // JSON Schema vendor-extension territory and MUST stay accepted - the spec
  // text scopes the new rule explicitly to "schema keywords with the x-gts-
  // prefix". The canonical suite (tests/test_op6_schema_validation.py) has no
  // schema using a bare `x-foo`/`x-widget` keyword anywhere, so this is purely
  // a scoping guard against an over-broad implementation, not a pin of
  // existing suite behavior.
  //
  // This assertion is genuinely non-vacuous even today: `checkTypeSchemaRules`
  // already reaches this content and returns null, and it must keep doing so
  // once the allowlist check lands.
  test('accepts a non-x-gts vendor extension keyword (x-widget) at top level and nested', () => {
    const result = gts().checkTypeSchemaRules(
      {
        type: 'object',
        'x-widget': 'anything',
        properties: {
          id: { type: 'string' },
          note: { type: 'string', 'x-foo': 'bar' },
        },
      },
      undefined,
      { enforceGuards: true }
    );
    expect(result).toBeNull();
  });

  // Answers the "literal data, not schema keywords" carve-out from the spec
  // text: a value that happens to be *named* like an unsupported x-gts-*
  // keyword, but appears inside literal instance-shaped data (a `const`/
  // `default`/`examples` value, or a `properties` map key naming a field),
  // must not be flagged - it is data, not a schema keyword occurrence. Mirrors
  // the existing `findMisplacedKeywords` tests
  // ('does not flag a property literally named like a document-level keyword').
  test('does not flag a property literally named like an unsupported x-gts-* keyword', () => {
    const result = gts().checkTypeSchemaRules(
      {
        type: 'object',
        properties: { 'x-gts-bogus': { type: 'string' } },
      },
      undefined,
      { enforceGuards: true }
    );
    expect(result).toBeNull();
  });

  // NOTE: this one is vacuous in a stronger sense than the rest of this file's
  // "already passes" rows - `default`/`examples` carry no `values: 'schema' |
  // 'schemaList' | 'schemaMap'` entry in compatibility.ts's KEYWORDS table, so
  // neither the current code nor a future allowlist walker built on the same
  // `SCHEMA_KEYWORD_POSITIONS` table (as this file's notes above argue it
  // should be) would ever descend into them. Kept here anyway to document the
  // spec's explicit carve-out in executable form, not to catch a regression.
  test('does not flag an unsupported-looking key inside a const/default/examples literal value', () => {
    const result = gts().checkTypeSchemaRules(
      {
        type: 'object',
        properties: {
          sample: {
            type: 'object',
            default: { 'x-gts-bogus': true },
            examples: [{ 'x-gts-bogus': true }],
          },
        },
      },
      undefined,
      { enforceGuards: true }
    );
    expect(result).toBeNull();
  });
});
