import { GTS } from '../src';

const DRAFT7 = 'http://json-schema.org/draft-07/schema#';

/**
 * OP#13 - trait merge and completeness (spec §9.7.5, ADR-0002/0003/0004).
 *
 * The document-level trait keywords always sit at the schema top level, so the
 * helpers below place them there rather than inside the `allOf` overlay.
 */
function baseType(id: string, topLevel: Record<string, any> = {}) {
  return {
    $id: id,
    $schema: DRAFT7,
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
    ...topLevel,
  };
}

function derivedType(id: string, baseId: string, topLevel: Record<string, any> = {}) {
  return {
    $id: id,
    $schema: DRAFT7,
    type: 'object',
    allOf: [{ $ref: `gts://${baseId}` }, { type: 'object' }],
    ...topLevel,
  };
}

describe('OP#13 - trait value merge is RFC 7396 JSON Merge Patch', () => {
  test('null deletes an inherited value, and the schema default re-applies', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.nulldef.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          properties: { retention: { type: 'string', default: 'P7D' } },
          required: ['retention'],
        },
        'x-gts-traits': { retention: 'P30D' },
      })
    );
    gts.register(derivedType(kidId, baseId, { 'x-gts-traits': { retention: null } }));

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });

  test('null deleting a required trait with no default fails for a concrete type', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.nullreq.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          properties: { topicRef: { type: 'string' } },
          required: ['topicRef'],
        },
        'x-gts-traits': { topicRef: 'events' },
      })
    );
    gts.register(derivedType(kidId, baseId, { 'x-gts-traits': { topicRef: null } }));

    expect(gts.validateEntity(kidId).ok).toBe(false);
  });

  test('object-valued traits merge recursively, preserving keys the descendant omits', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.nested.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          properties: {
            routing: {
              type: 'object',
              properties: { topic: { type: 'string' }, partitionKey: { type: 'string' } },
              required: ['topic', 'partitionKey'],
            },
          },
          required: ['routing'],
        },
        'x-gts-traits': { routing: { topic: 'events', partitionKey: 'userId' } },
      })
    );
    // Overrides only `topic`; `partitionKey` must survive or `required` fails.
    gts.register(derivedType(kidId, baseId, { 'x-gts-traits': { routing: { topic: 'orders' } } }));

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });

  test('arrays replace wholesale rather than concatenating', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.arr.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    // maxItems 3 admits the base value and the descendant value, but not a
    // concatenation of the two - so passing proves replacement.
    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          properties: { tags: { type: 'array', items: { type: 'string' }, maxItems: 3 } },
          required: ['tags'],
        },
        'x-gts-traits': { tags: ['a', 'b', 'c'] },
      })
    );
    gts.register(derivedType(kidId, baseId, { 'x-gts-traits': { tags: ['only'] } }));

    expect(gts.validateEntity(baseId).ok).toBe(true);
    expect(gts.validateEntity(kidId).ok).toBe(true);
  });

  test('a descendant may restate an inherited value idempotently', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.idem.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          properties: { retention: { type: 'string' } },
          required: ['retention'],
        },
        'x-gts-traits': { retention: 'P30D' },
      })
    );
    gts.register(derivedType(kidId, baseId, { 'x-gts-traits': { retention: 'P30D' } }));

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });
});

describe('OP#13 - locking is `const`, not a bespoke immutability rule (ADR-0004)', () => {
  const schemaWithLock = {
    type: 'object',
    properties: { indexed: { type: 'boolean', const: true }, topicRef: { type: 'string' } },
    required: ['indexed'],
  };

  test('a descendant overriding a const-locked trait fails', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.lock.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(baseType(baseId, { 'x-gts-traits-schema': schemaWithLock, 'x-gts-traits': { indexed: true } }));
    gts.register(derivedType(kidId, baseId, { 'x-gts-traits': { indexed: false } }));

    expect(gts.validateEntity(kidId).ok).toBe(false);
  });

  test('a descendant may freely override a trait that is not locked', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.free.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': schemaWithLock,
        'x-gts-traits': { indexed: true, topicRef: 'audit' },
      })
    );
    gts.register(derivedType(kidId, baseId, { 'x-gts-traits': { topicRef: 'notification' } }));

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });
});

describe('OP#13 - completeness is keyed on x-gts-abstract (ADR-0003)', () => {
  const requiresPriority = {
    'x-gts-traits-schema': {
      type: 'object',
      properties: { priority: { type: 'integer' } },
      required: ['priority'],
    },
  };

  test('a concrete type with an unresolved required trait fails', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.concrete.v1~';
    gts.register(baseType(baseId, requiresPriority));

    expect(gts.validateEntity(baseId).ok).toBe(false);
  });

  test('an abstract type with the same unresolved trait passes', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.abstract.v1~';
    gts.register(baseType(baseId, { ...requiresPriority, 'x-gts-abstract': true }));

    expect(gts.validateEntity(baseId).ok).toBe(true);
  });

  test('abstract completeness preserves a required key inside const data', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.abstractconst.v1~';
    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: { config: { const: { required: ['a'] } } },
          required: ['unresolved'],
        },
        'x-gts-traits': { config: { required: ['a'] } },
      })
    );

    expect(gts.validateEntity(baseId).ok).toBe(true);
  });

  test('abstract completeness preserves the schema of a property named required', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.abstractrequired.v1~';
    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: { required: { type: 'string' } },
          required: ['unresolved'],
        },
        'x-gts-traits': { required: 42 },
      })
    );

    expect(gts.validateEntity(baseId).ok).toBe(false);
  });

  test('a concrete descendant of an abstract base must close the gap', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.closegap.v1~';
    const openKid = `${baseId}x.unit._.open.v1~`;
    const closedKid = `${baseId}x.unit._.closed.v1~`;

    gts.register(baseType(baseId, { ...requiresPriority, 'x-gts-abstract': true }));
    gts.register(derivedType(openKid, baseId));
    gts.register(derivedType(closedKid, baseId, { 'x-gts-traits': { priority: 5 } }));

    expect(gts.validateEntity(openKid).ok).toBe(false);
    expect(gts.validateEntity(closedKid).ok).toBe(true);
  });

  test('a trait-schema default satisfies the completeness check', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.default.v1~';
    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          properties: { priority: { type: 'integer', default: 3 } },
          required: ['priority'],
        },
      })
    );

    expect(gts.validateEntity(baseId).ok).toBe(true);
  });
});

describe('OP#13 - boolean trait schemas (ADR-0002)', () => {
  test('`false` permits a descendant that declares no traits', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.false.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(baseType(baseId, { 'x-gts-traits-schema': false }));
    gts.register(derivedType(kidId, baseId));

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });

  test('`false` rejects a descendant that declares an object trait schema', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.falseschema.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(baseType(baseId, { 'x-gts-traits-schema': false }));
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-traits-schema': { type: 'object', properties: { retention: { type: 'string' } } },
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(false);
  });

  test('`false` rejects any descendant that declares traits', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.falsetr.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(baseType(baseId, { 'x-gts-traits-schema': false }));
    gts.register(derivedType(kidId, baseId, { 'x-gts-traits': { retention: 'P30D' } }));

    expect(gts.validateEntity(kidId).ok).toBe(false);
  });

  test('`false` rejects traits on an abstract descendant too', () => {
    // Prohibition bans traits across the whole subtree; it is not a
    // completeness rule, so the abstract exemption must not bypass it.
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.falseabs.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(baseType(baseId, { 'x-gts-traits-schema': false }));
    gts.register(derivedType(kidId, baseId, { 'x-gts-abstract': true, 'x-gts-traits': { retention: 'P30D' } }));

    expect(gts.validateEntity(kidId).ok).toBe(false);
  });

  test('`true` permits arbitrary traits', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.true.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(baseType(baseId, { 'x-gts-traits-schema': true }));
    gts.register(derivedType(kidId, baseId, { 'x-gts-traits': { anything: 42, other: 'value' } }));

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });

  test('an array-shaped `x-gts-traits-schema` is rejected as malformed', () => {
    // A JSON Schema subschema must be an object or a boolean; an array is
    // neither. `typeof [] === 'object'` lets it slip past a naive object
    // check, and Ajv would otherwise silently treat it as a permissive
    // object-shaped schema with no recognized keywords.
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.arrayschema.v1~';

    gts.register(baseType(baseId, { 'x-gts-traits-schema': [1, 2], 'x-gts-traits': { anything: 'whatever' } }));

    const result = gts.validateEntity(baseId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/x-gts-traits-schema.*must be an object subschema or a boolean/);
  });

  test('a string-shaped `x-gts-traits-schema` is rejected as malformed too', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.stringschema.v1~';

    gts.register(baseType(baseId, { 'x-gts-traits-schema': 'not-a-schema' }));

    const result = gts.validateEntity(baseId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/x-gts-traits-schema.*must be an object subschema or a boolean/);
  });

  test('trait values with no trait-schema anywhere in the chain are rejected', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.noschema.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(baseType(baseId));
    gts.register(derivedType(kidId, baseId, { 'x-gts-traits': { retention: 'P30D' } }));

    expect(gts.validateEntity(kidId).ok).toBe(false);
  });
});

describe('OP#13 - the effective trait schema must stay satisfiable', () => {
  test('a descendant may narrow an inherited trait', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.narrow.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': { type: 'object', properties: { retention: { type: 'string' } } },
        'x-gts-abstract': true,
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-traits-schema': { type: 'object', properties: { retention: { type: 'string', maxLength: 8 } } },
        'x-gts-abstract': true,
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });

  test('a descendant redeclaring a trait with a disjoint type fails, even when abstract', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.conflict.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          required: ['retention'],
          properties: { retention: { type: 'string' } },
        },
        'x-gts-abstract': true,
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-traits-schema': { type: 'object', properties: { retention: { type: 'integer' } } },
        'x-gts-abstract': true,
      })
    );

    // Satisfiability is a property of the composed schema, so the abstract
    // exemption (which covers completeness only) does not hide it. The base
    // branch requires `retention`, so `allOf` semantics make it mandatory
    // overall even though the descendant branch does not restate `required`.
    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be satisfied/);
  });

  test('a redeclared trait with a disjoint type is unsatisfiable even though the property is optional in every branch', () => {
    // Neither branch requires `retention` - but gts-rust's own
    // `declared_schema`/`check_accepted_set_inclusion` never gates on
    // required-ness: redeclaring `retention` replaces its base declaration
    // wholesale, and `Valid(descendant) subset-of Valid(ancestor)` fails once
    // any instance carrying `retention` as an integer is admitted by the
    // descendant conjunct but rejected by the ancestor's `string` conjunct.
    // (An earlier round of this refactor gated this check on required-ness
    // and asserted `ok: true` here; that gate was an unfaithful divergence
    // from gts-rust and has been removed - see ADR/session notes.)
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.optconflict.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': { type: 'object', properties: { retention: { type: 'string' } } },
        'x-gts-abstract': true,
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-traits-schema': { type: 'object', properties: { retention: { type: 'integer' } } },
        'x-gts-abstract': true,
      })
    );

    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be satisfied|not a valid narrowing/);
  });

  test('sibling allOf branches may reference the same trait schema', () => {
    // Cycle detection tracks the active recursion path; two siblings pointing
    // at one common trait schema is reuse, not recursion.
    const gts = new GTS({ validateRefs: false });
    const commonId = 'gts.x.unit.tr.common.v1~';
    const baseId = 'gts.x.unit.tr.siblings.v1~';

    gts.register(baseType(commonId, { type: 'object', properties: { k: { type: 'string' } } }));
    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { allOf: [{ $ref: `gts://${commonId}` }, { $ref: `gts://${commonId}` }] },
      })
    );

    expect(gts.validateEntity(baseId).ok).toBe(true);
  });

  test('a genuinely recursive trait schema is still rejected', () => {
    const gts = new GTS({ validateRefs: false });
    const selfId = 'gts.x.unit.tr.selfref.v1~';

    gts.register(baseType(selfId, { 'x-gts-traits-schema': { $ref: `gts://${selfId}` } }));

    expect(gts.validateEntity(selfId).ok).toBe(false);
  });

  test('abstract types are not exempt from an impossible const across the chain', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.constclash.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', required: ['k'], properties: { k: { const: 'a' } } },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', properties: { k: { const: 'b' } } },
      })
    );

    // The base branch requires `k`, so `allOf` semantics make it mandatory
    // overall even though the descendant branch does not restate `required`.
    // The message now comes from the declared-schema accepted-set-inclusion
    // check (gts-rust's `check_accepted_set_inclusion`, reused here via
    // `GtsCompatibility.compareSchemas`) rather than the old bespoke
    // `findValueConflict` walker, so the wording changed from "no value
    // satisfies" to this check's own "not a valid narrowing" phrasing - the
    // rejected outcome is unchanged.
    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a valid narrowing/);
  });

  test('a crossed const across the chain is unsatisfiable even though the property is optional in every branch', () => {
    // Neither branch requires `k` - but as with the disjoint-type case above,
    // gts-rust's accepted-set-inclusion check compares the declared schema of
    // every property either side declares, regardless of required-ness: the
    // descendant conjunct's `const: 'b'` is not included in the ancestor
    // conjunct's `const: 'a'`, so inclusion fails.
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.optconstclash.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', properties: { k: { const: 'a' } } },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', properties: { k: { const: 'b' } } },
      })
    );

    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
  });

  test('abstract types are not exempt from crossed bounds across the chain', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.boundclash.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          required: ['n'],
          properties: { n: { type: 'integer', minimum: 10 } },
        },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', properties: { n: { type: 'integer', maximum: 5 } } },
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(false);
  });

  test('exclusive and inclusive bounds that cross are detected', () => {
    // `exclusiveMinimum: 10` and `maximum: 10` share no value; comparing raw
    // minimum against raw maximum missed it.
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.exclbound.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', required: ['n'], properties: { n: { exclusiveMinimum: 10 } } },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', required: ['n'], properties: { n: { maximum: 10 } } },
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(false);
  });

  test('bounds that merely narrow are still satisfiable', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.okbound.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', properties: { n: { minimum: 0, maximum: 100 } } },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', properties: { n: { minimum: 10, maximum: 20 } } },
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });

  test('a genuine cross-branch bound crossing on a required property is still rejected', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.genuinecrossing.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          required: ['score'],
          properties: { score: { type: 'number', minimum: 60 } },
        },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', properties: { score: { type: 'number', maximum: 50 } } },
      })
    );

    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be satisfied/);
  });

  test('defaults nested under an object trait are materialized', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.nesteddefault.v1~';

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          required: ['routing'],
          properties: {
            routing: {
              type: 'object',
              required: ['topic'],
              properties: { topic: { type: 'string', default: 'orders' } },
            },
          },
        },
        'x-gts-traits': { routing: {} },
      })
    );

    expect(gts.validateEntity(baseId).ok).toBe(true);
  });

  test('an optional trait object with a partly-defaulted subtree stays absent', () => {
    // ADR-0003 licenses materializing declared defaults, not inventing values.
    // Conjuring an absent *optional* object validates a subtree the author never
    // supplied, which rejected a type that is legitimately silent there.
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.optsubtree.v1~';

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          properties: {
            routing: {
              type: 'object',
              required: ['topic', 'partitionKey'],
              properties: { topic: { type: 'string', default: 'orders' }, partitionKey: { type: 'string' } },
            },
          },
        },
        'x-gts-traits': {},
      })
    );

    expect(gts.validateEntity(baseId).ok).toBe(true);
  });

  test('a required trait object is materialized from its subtree defaults', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.reqsubtree.v1~';

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          required: ['routing'],
          properties: {
            routing: {
              type: 'object',
              required: ['topic'],
              properties: { topic: { type: 'string', default: 'orders' } },
            },
          },
        },
        'x-gts-traits': {},
      })
    );

    expect(gts.validateEntity(baseId).ok).toBe(true);
  });

  test('a required trait object whose subtree cannot be completed still fails', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.reqgap.v1~';

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          required: ['routing'],
          properties: {
            routing: {
              type: 'object',
              required: ['topic', 'key'],
              properties: { topic: { type: 'string', default: 'orders' }, key: { type: 'string' } },
            },
          },
        },
        'x-gts-traits': {},
      })
    );

    expect(gts.validateEntity(baseId).ok).toBe(false);
  });

  test('a closed descendant trait-schema must not orphan a required ancestor trait', () => {
    // `retention` is required on the base branch, so it's guaranteed present
    // overall - the closed descendant branch that doesn't restate it really
    // does reject every value, unlike the merely-optional case covered below.
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.orphan.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          required: ['retention'],
          properties: { retention: { type: 'string' } },
        },
        'x-gts-abstract': true,
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          additionalProperties: false,
          properties: { topicRef: { type: 'string' } },
        },
        'x-gts-abstract': true,
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(false);
  });

  test('restating the ancestor trait makes the closed descendant valid', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.restate.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': { type: 'object', properties: { retention: { type: 'string' } } },
        'x-gts-abstract': true,
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          additionalProperties: false,
          properties: { retention: { type: 'string' }, topicRef: { type: 'string' } },
        },
        'x-gts-abstract': true,
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });

  test('a closed descendant that drops a merely-optional ancestor trait is unsatisfiable', () => {
    // Intentional semantic flip (this refactor): the closed-branch orphan
    // check is NOT gated on required-ness, matching gts-rust and this
    // codebase's own OP#12 `compareOverlayToBase` precedent - an `allOf`
    // branch is evaluated independently, so a closed branch that never
    // restates `retention` rejects every value the base branch allows for
    // it, regardless of whether `retention` happens to be required anywhere.
    // (Before this refactor, the now-removed `findUnsatisfiableTrait` only
    // flagged this when the property was `requiredAnywhere`, so this case
    // used to report `ok: true`.)
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.optorphan.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': { type: 'object', properties: { retention: { type: 'string' } } },
        'x-gts-abstract': true,
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          additionalProperties: false,
          properties: { topicRef: { type: 'string' } },
        },
        'x-gts-abstract': true,
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(false);
  });

  test('a conflict between two allOf branches within one trait-schema level is caught before concretization', () => {
    // This used to be a genuine, faithfully-ported gts-rust limitation:
    // `validate_trait_schema_compatibility` (ported here as
    // `validateTraitChainSatisfiability`'s declared-schema-fold +
    // accepted-set-inclusion loop) only compared *consecutive chain levels*
    // (`chain[0..i]` vs `chain[0..i+1]`), never a single level's OWN internal
    // `allOf` composition - so `branchA`'s `const: 'a'` was silently
    // overwritten by `branchB`'s `const: 'b'` (declared_schema's fold is
    // last-branch-wins, see `absorbProperty`) before any comparison ever
    // re-examined it, leaving the conflict latent at this abstract level.
    // `validateTraitChainSatisfiability` now additionally decomposes each
    // chain level's own `allOf` into its constituent branches (`allOf`
    // nesting is associative) and runs the identical prefix-narrowing check
    // across THEM too (`flattenAllOfBranches` + `checkNarrowingStep`), so
    // this exact shape - two allOf branches disagreeing on the same
    // property, ONE level of the chain, no descendant needed - is now caught
    // even though this base type is abstract (satisfiability is checked
    // regardless of the completeness exemption; see the class-level doc
    // comment on `validateTraitChainSatisfiability`).
    const gts = new GTS({ validateRefs: false });
    // A GTS id has exactly 4 dot-segments (vendor.package.namespace.type)
    // before the version - `nestedconflict.a`/`.b` as a 5th segment is
    // malformed, so the disambiguator is folded into the type token instead.
    const commonAId = 'gts.x.unit.tr.nestedconflicta.v1~';
    const commonBId = 'gts.x.unit.tr.nestedconflictb.v1~';
    const baseId = 'gts.x.unit.tr.nestedconflict.v1~';

    gts.register(baseType(commonAId, { type: 'object', required: ['k'], properties: { k: { const: 'a' } } }));
    gts.register(baseType(commonBId, { type: 'object', required: ['k'], properties: { k: { const: 'b' } } }));
    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          allOf: [{ allOf: [{ $ref: `gts://${commonAId}` }] }, { allOf: [{ $ref: `gts://${commonBId}` }] }],
        },
      })
    );

    const result = gts.validateEntity(baseId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be satisfied/);
  });

  test('a conflict nested inside an optional property still makes the schema unsatisfiable', () => {
    // Neither branch requires `x` itself at the outer level - but, as with
    // the top-level disjoint-type/const cases above, gts-rust's
    // accepted-set-inclusion check does not gate on required-ness anywhere in
    // the recursion: it compares the schema declared for every property name
    // either side declares, at every depth, so `x`'s own optionality does not
    // shield the `a: string` vs `a: number` conflict nested inside it.
    // (An earlier round of this refactor asserted `ok: true` here on the
    // theory that AJV validates `{}` against `allOf: [base, kid]` regardless
    // of what conflicts exist inside an absent optional property - true for
    // JSON Schema *instance* validation, but not the question gts-rust's
    // trait-chain *satisfiability* check answers.)
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.optnested.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: {
            x: {
              type: 'object',
              required: ['a'],
              additionalProperties: false,
              properties: { a: { type: 'string' } },
            },
          },
        },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: {
            x: { type: 'object', required: ['a'], properties: { a: { type: 'number' } } },
          },
        },
      })
    );

    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
  });

  test('a closed sub-schema nested inside a descendant branch its own allOf still orphans a required ancestor trait', () => {
    // `retention` is required on the base branch, so it's guaranteed present
    // overall. The descendant does not close its own top-level branch, but
    // its own `allOf` nests a closed sub-schema (the shape a `$ref`-to-
    // reusable-trait-schema produces) that never restates `retention` - that
    // nested closed node still constrains the very same object instance
    // once `allOf` is flattened, so it must be caught just like a directly
    // closed branch would be.
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.nestedorphan.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          required: ['retention'],
          properties: { retention: { type: 'string' } },
        },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          allOf: [{ additionalProperties: false, properties: { topicRef: { type: 'string' } } }],
        },
      })
    );

    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
    // Wording changed with this refactor's move to `compareOverlayToBase`
    // (its own closed-branch-orphan message), but the outcome - and the
    // fact that a *nested* closed branch is still caught - is unchanged.
    expect(result.error).toMatch(/excluded by additionalProperties: false/);
  });

  test('a closed branch nested one level inside a shared property still orphans a required ancestor field', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.nestedorphanbug.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          required: ['config'],
          properties: {
            config: { type: 'object', required: ['field'], properties: { field: { type: 'string' } } },
          },
        },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: {
            config: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      })
    );

    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/excluded by additionalProperties: false/);
  });

  test('restating the orphaned nested field alongside the closed branch keeps it satisfiable', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.nestedorphanbugrestate.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          required: ['config'],
          properties: {
            config: { type: 'object', required: ['field'], properties: { field: { type: 'string' } } },
          },
        },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: {
            config: {
              type: 'object',
              properties: { field: { type: 'string' } },
              additionalProperties: false,
            },
          },
        },
      })
    );

    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(true);
  });

  test('a closed branch two levels deep inside nested property values still orphans a required ancestor field', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.nestedorphanbugdeep.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          required: ['config'],
          properties: {
            config: {
              type: 'object',
              required: ['nested'],
              properties: {
                nested: { type: 'object', required: ['field'], properties: { field: { type: 'string' } } },
              },
            },
          },
        },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: {
            config: {
              type: 'object',
              properties: {
                nested: { type: 'object', properties: {}, additionalProperties: false },
              },
            },
          },
        },
      })
    );

    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/excluded by additionalProperties: false/);
  });

  test('a descendant narrowing an inherited trait keeps the ancestor default', () => {
    // The base declares `retention`'s `default`; the descendant narrows the
    // same property with `maxLength` but does not repeat the default. Real
    // `allOf` semantics combine both branches' constraints on one property,
    // so the default must still materialize - losing it here would then fail
    // completeness on a trait the schema itself already answered.
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.narrowdefault.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          required: ['retention'],
          properties: { retention: { type: 'string', default: 'p30d' } },
        },
        'x-gts-abstract': true,
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-traits-schema': { type: 'object', properties: { retention: { type: 'string', maxLength: 8 } } },
        'x-gts-abstract': true,
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });

  test("a descendant's own default overrides the ancestor's default for the same property", () => {
    // Both the base and the descendant declare a `default` for `retention`.
    // `allOf` semantics still require a single materialized value, and the
    // descendant's own declaration is the one that must win - matching the
    // descendant-overrides-ancestor convention used everywhere else (e.g.
    // `x-gts-traits`'s RFC 7396 merge). The descendant also constrains the
    // property with a `maxLength` that only its own (shorter) default value
    // satisfies, so this is a black-box check: if the ancestor's longer
    // default won instead, the materialized value would violate `maxLength`
    // and validation would report an error rather than succeed. (Uses
    // `maxLength` rather than `pattern`: `pattern` is a JSON Schema
    // "unmodeled" keyword for `GtsCompatibility.compareSchemas`'s
    // subsumption engine - introducing one where the ancestor has none makes
    // that comparison `unknown`, which the satisfiability gate added by this
    // refactor now fails closed on. `maxLength` is a modeled bound keyword,
    // so tightening it stays `compatible` and does not trip that gate.)
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.defaultoverride.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          required: ['retention'],
          properties: { retention: { type: 'string', default: 'ANCESTOR-DEFAULT' } },
        },
        'x-gts-abstract': true,
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          properties: { retention: { type: 'string', default: 'short', maxLength: 5 } },
        },
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });

  test("a descendant's own default overrides the ancestor's default one level deeper (nested object property)", () => {
    // Same conflict as above, but the property carrying the conflicting
    // defaults (`q`) sits one level under a required object property (`p`),
    // exercising the fix through `applyTraitDefaults`'s recursion into a
    // required-but-absent object's subtree defaults. Uses `maxLength` rather
    // than `pattern` for the same reason as the test above - see its comment.
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.nesteddefaultoverride.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          required: ['p'],
          properties: {
            p: {
              type: 'object',
              required: ['q'],
              properties: { q: { type: 'string', default: 'ANCESTOR-DEFAULT' } },
            },
          },
        },
        'x-gts-abstract': true,
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          properties: {
            p: {
              type: 'object',
              properties: { q: { type: 'string', default: 'short', maxLength: 5 } },
            },
          },
        },
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });
});

/**
 * Regression coverage for PR #16 review finding #3 (blocking) / @gs-layer
 * thread 32: a chain with exactly one `x-gts-traits-schema` level never
 * entered `validateTraitChainSatisfiability`'s between-level loop at all
 * (`for (let i = 1; i < traitSchemas.length; i++)`), so a self-contradictory
 * single-level schema was never checked. All three exact repro cases from
 * the review must now be rejected.
 */
describe('OP#13 - a single-level x-gts-traits-schema is checked for internal satisfiability', () => {
  function singleLevel(id: string, traitsSchema: any) {
    return () => {
      const gts = new GTS({ validateRefs: false });
      gts.register(baseType(id, { 'x-gts-abstract': true, 'x-gts-traits-schema': traitsSchema }));
      return gts.validateEntity(id);
    };
  }

  test('disjoint const across allOf branches at a single level is unsatisfiable', () => {
    const validate = singleLevel('gts.x.unit.tr.single1const.v1~', {
      allOf: [{ properties: { k: { const: 'a' } } }, { properties: { k: { const: 'b' } } }],
    });
    const result = validate();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be satisfied/);
  });

  test('disjoint type across allOf branches at a single level is unsatisfiable', () => {
    const validate = singleLevel('gts.x.unit.tr.single1type.v1~', {
      allOf: [{ properties: { n: { type: 'string' } } }, { properties: { n: { type: 'number' } } }],
    });
    const result = validate();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be satisfied/);
  });

  test('crossed exclusive/inclusive bounds across allOf branches at a single level are unsatisfiable', () => {
    const validate = singleLevel('gts.x.unit.tr.single1bound.v1~', {
      allOf: [{ properties: { n: { exclusiveMinimum: 10 } } }, { properties: { n: { maximum: 10 } } }],
    });
    const result = validate();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be satisfied/);
  });

  test('a genuinely satisfiable single-level trait schema with multiple allOf branches is still accepted', () => {
    // Control for the three cases above: `type` is restated in full by the
    // second branch (matching this codebase's existing "a restated property
    // replaces its declaration wholesale" convention - see `absorbProperty`),
    // so this is a real, conflict-free narrowing and must not be rejected.
    const validate = singleLevel('gts.x.unit.tr.single1ok.v1~', {
      allOf: [{ properties: { n: { type: 'number' } } }, { properties: { n: { type: 'number', minimum: 5 } } }],
    });
    const result = validate();
    expect(result.ok).toBe(true);
  });
});

/**
 * Regression coverage for PR #16 review finding #2 (blocking): a compatibility
 * verdict of `unknown` (the engine does not model this keyword) was treated
 * identically to a proven `incompatible`, hard-rejecting any descendant
 * trait-schema narrowing that merely used a keyword outside the `KEYWORDS`
 * table - even GTS's own `x-gts-ref`.
 */
describe('OP#13 - trait narrowing via an unmodeled keyword is not a satisfiability failure', () => {
  function narrow(id: string, kidId: string, baseProperty: any, kidProperty: any) {
    return () => {
      const gts = new GTS({ validateRefs: false });
      gts.register(
        baseType(id, {
          'x-gts-abstract': true,
          'x-gts-traits-schema': { type: 'object', properties: { v: baseProperty } },
        })
      );
      gts.register(
        derivedType(kidId, id, {
          'x-gts-abstract': true,
          'x-gts-traits-schema': { type: 'object', properties: { v: kidProperty } },
        })
      );
      return gts.validateEntity(kidId);
    };
  }

  test('adding pattern in a descendant is accepted, not rejected as unsatisfiable', () => {
    const validate = narrow(
      'gts.x.unit.tr.unmodpattern.v1~',
      'gts.x.unit.tr.unmodpattern.v1~x.unit._.kid.v1~',
      { type: 'string' },
      { type: 'string', pattern: '^a' }
    );
    expect(validate().ok).toBe(true);
  });

  test('adding multipleOf in a descendant is accepted, not rejected as unsatisfiable', () => {
    const validate = narrow(
      'gts.x.unit.tr.unmodmultipleof.v1~',
      'gts.x.unit.tr.unmodmultipleof.v1~x.unit._.kid.v1~',
      { type: 'integer' },
      { type: 'integer', multipleOf: 2 }
    );
    expect(validate().ok).toBe(true);
  });

  test('adding a vendor x-* keyword in a descendant is accepted, not rejected as unsatisfiable', () => {
    const validate = narrow(
      'gts.x.unit.tr.unmodvendor.v1~',
      'gts.x.unit.tr.unmodvendor.v1~x.unit._.kid.v1~',
      { type: 'string' },
      { type: 'string', 'x-vendor-thing': 1 }
    );
    expect(validate().ok).toBe(true);
  });

  test('adding x-gts-ref in a descendant is accepted, not rejected as unsatisfiable', () => {
    const patternSchemaId = 'gts.x.unit.trunmodxref.pattern.v1~';
    const gts = new GTS({ validateRefs: false });
    gts.register(baseType(patternSchemaId));

    const baseId = 'gts.x.unit.tr.unmodxref.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;
    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', properties: { v: { type: 'string' } } },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: { v: { type: 'string', 'x-gts-ref': patternSchemaId } },
        },
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });

  test('a genuine incompatible narrowing (widening maximum) is still correctly rejected', () => {
    const validate = narrow(
      'gts.x.unit.tr.unmodwidenmax.v1~',
      'gts.x.unit.tr.unmodwidenmax.v1~x.unit._.kid.v1~',
      { type: 'number', maximum: 10 },
      { type: 'number', maximum: 20 }
    );
    const result = validate();
    expect(result.ok).toBe(false);
  });

  test('a genuine incompatible narrowing (conflicting const) is still correctly rejected', () => {
    const validate = narrow(
      'gts.x.unit.tr.unmodconstconflict.v1~',
      'gts.x.unit.tr.unmodconstconflict.v1~x.unit._.kid.v1~',
      { type: 'string', const: 'a' },
      { type: 'string', const: 'b' }
    );
    const result = validate();
    expect(result.ok).toBe(false);
  });
});

/**
 * `validateTraitChainSatisfiability`'s declared-schema-fold +
 * accepted-set-inclusion check (§9.7.5) is a faithful TS port of gts-rust's
 * `schema_traits::validate_trait_schema_compatibility`, which in turn calls
 * `schema_derivation::validate_derivation` - so every fixture below is a
 * direct 2-level trait-schema-chain translation of a scenario from
 * gts-rust's own `schema_derivation_test.rs`, with the same expected
 * pass/fail outcome. `x-gts-abstract: true` on both levels keeps these tests
 * focused purely on satisfiability, independent of the separate completeness
 * check (§9.7.5's "descendants close the gaps").
 */
describe('OP#13 - trait-chain satisfiability mirrors gts-rust schema_derivation_test.rs', () => {
  function traitChain(baseId: string, kidId: string, baseProperty: any, kidProperty: any) {
    return () => {
      const gts = new GTS({ validateRefs: false });
      gts.register(
        baseType(baseId, {
          'x-gts-abstract': true,
          'x-gts-traits-schema': { type: 'object', properties: { v: baseProperty } },
        })
      );
      gts.register(
        derivedType(kidId, baseId, {
          'x-gts-abstract': true,
          'x-gts-traits-schema': { type: 'object', properties: { v: kidProperty } },
        })
      );
      return gts.validateEntity(kidId);
    };
  }

  test('test_compatible_tightening: a tighter maxLength is satisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rusttighten.v1~',
      'gts.x.unit.tr.rusttighten.v1~x.unit._.kid.v1~',
      { type: 'string', maxLength: 100 },
      { type: 'string', maxLength: 50 }
    );
    expect(validate().ok).toBe(true);
  });

  test('test_incompatible_loosening_max_length: a looser maxLength is unsatisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustloosenmaxlen.v1~',
      'gts.x.unit.tr.rustloosenmaxlen.v1~x.unit._.kid.v1~',
      { type: 'string', maxLength: 100 },
      { type: 'string', maxLength: 200 }
    );
    expect(validate().ok).toBe(false);
  });

  test('test_incompatible_loosening_maximum: a looser maximum is unsatisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustloosenmax.v1~',
      'gts.x.unit.tr.rustloosenmax.v1~x.unit._.kid.v1~',
      { type: 'integer', maximum: 100 },
      { type: 'integer', maximum: 200 }
    );
    expect(validate().ok).toBe(false);
  });

  test('test_incompatible_loosening_minimum: a looser minimum is unsatisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustloosenmin.v1~',
      'gts.x.unit.tr.rustloosenmin.v1~x.unit._.kid.v1~',
      { type: 'integer', minimum: 10 },
      { type: 'integer', minimum: 5 }
    );
    expect(validate().ok).toBe(false);
  });

  test('test_enum_expansion_fails: widening an enum is unsatisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustenumwiden.v1~',
      'gts.x.unit.tr.rustenumwiden.v1~x.unit._.kid.v1~',
      { type: 'string', enum: ['a', 'b'] },
      { type: 'string', enum: ['a', 'b', 'c'] }
    );
    expect(validate().ok).toBe(false);
  });

  test('test_enum_subset_ok: narrowing to an enum subset is satisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustenumsubset.v1~',
      'gts.x.unit.tr.rustenumsubset.v1~x.unit._.kid.v1~',
      { type: 'string', enum: ['a', 'b', 'c'] },
      { type: 'string', enum: ['a'] }
    );
    expect(validate().ok).toBe(true);
  });

  test('test_omitting_bounds_without_enum_or_const_still_fails: dropping a bound with no replacement is unsatisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustdropbound.v1~',
      'gts.x.unit.tr.rustdropbound.v1~x.unit._.kid.v1~',
      { type: 'string', maxLength: 100 },
      { type: 'string' }
    );
    expect(validate().ok).toBe(false);
  });

  test('test_enum_tightening_allows_omitting_bounds: an enum within the inherited maxLength is satisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustenumtighten.v1~',
      'gts.x.unit.tr.rustenumtighten.v1~x.unit._.kid.v1~',
      { type: 'string', maxLength: 100 },
      { type: 'string', enum: ['gold', 'platinum'] }
    );
    expect(validate().ok).toBe(true);
  });

  // Direct translation of gts-rust's `test_const_tightening_allows_omitting_
  // bounds_and_pattern`: the base declares both `maxLength` and `pattern`,
  // the descendant declares only a `const` that already satisfies both -
  // `compareBounds`'s fixed-value carve-out covers the `maxLength` half,
  // and `compareUnmodeled`'s `pattern`-specific carve-out covers the
  // `pattern` half.
  test('test_const_tightening_allows_omitting_bounds_and_pattern: a const within the inherited maxLength and pattern is satisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustconsttighten.v1~',
      'gts.x.unit.tr.rustconsttighten.v1~x.unit._.kid.v1~',
      { type: 'string', maxLength: 100, pattern: '^[a-z]+$' },
      { type: 'string', const: 'hello' }
    );
    expect(validate().ok).toBe(true);
  });

  test('test_const_implies_type: a const narrowing a type-only ancestor is satisfiable', () => {
    // `retention` (via the `v` property) declares no `type`, only `const:
    // 'P30D'` - whose value IS a string, so it plainly narrows the
    // ancestor's `type: 'string'` even though the descendant never restates
    // `type` literally.
    const validate = traitChain(
      'gts.x.unit.tr.constimpliestype.v1~',
      'gts.x.unit.tr.constimpliestype.v1~x.unit._.kid.v1~',
      { type: 'string' },
      { const: 'P30D' }
    );
    expect(validate().ok).toBe(true);
  });

  test('test_enum_implies_type: an enum narrowing a type-only ancestor is satisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.enumimpliestype.v1~',
      'gts.x.unit.tr.enumimpliestype.v1~x.unit._.kid.v1~',
      { type: 'string' },
      { enum: ['a', 'b'] }
    );
    expect(validate().ok).toBe(true);
  });

  test('test_const_implied_type_conflict_still_fails: a const of the wrong runtime type is not a valid narrowing', () => {
    // Negative control: 42 is a number, not a string, so this is a genuine
    // type conflict - the fix must derive the const's own implied type
    // rather than unconditionally accepting any const/enum as compatible.
    const validate = traitChain(
      'gts.x.unit.tr.constimpliedtypeconflict.v1~',
      'gts.x.unit.tr.constimpliedtypeconflict.v1~x.unit._.kid.v1~',
      { type: 'string' },
      { const: 42 }
    );
    expect(validate().ok).toBe(false);
  });

  test('test_const_tightening_violates_pattern_still_fails: a const that does not match the inherited pattern is unsatisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustconsttightenbadpattern.v1~',
      'gts.x.unit.tr.rustconsttightenbadpattern.v1~x.unit._.kid.v1~',
      { type: 'string', maxLength: 100, pattern: '^[a-z]+$' },
      { type: 'string', const: 'HELLO' }
    );
    expect(validate().ok).toBe(false);
  });

  test('test_enum_tightening_allows_omitting_pattern: an enum whose members all match the inherited pattern is satisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustenumtightenpattern.v1~',
      'gts.x.unit.tr.rustenumtightenpattern.v1~x.unit._.kid.v1~',
      { type: 'string', pattern: '^[a-z]+$' },
      { type: 'string', enum: ['gold', 'platinum'] }
    );
    expect(validate().ok).toBe(true);
  });

  test('test_enum_tightening_allows_omitting_numeric_bounds: an enum within the inherited minimum/maximum is satisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustenumtightennum.v1~',
      'gts.x.unit.tr.rustenumtightennum.v1~x.unit._.kid.v1~',
      { type: 'integer', minimum: 0, maximum: 100 },
      { type: 'integer', enum: [1, 5, 10] }
    );
    expect(validate().ok).toBe(true);
  });

  test('test_enum_tightening_still_rejects_out_of_bound_values: an enum with a member outside the inherited maxLength is unsatisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustenumtightenviolate.v1~',
      'gts.x.unit.tr.rustenumtightenviolate.v1~x.unit._.kid.v1~',
      { type: 'string', maxLength: 5 },
      { type: 'string', enum: ['short', 'way-too-long-value'] }
    );
    expect(validate().ok).toBe(false);
  });

  test('test_derived_const_must_be_in_base_enum: a const inside the base enum is satisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustconstinenum.v1~',
      'gts.x.unit.tr.rustconstinenum.v1~x.unit._.kid.v1~',
      { type: 'string', enum: ['active', 'inactive'] },
      { type: 'string', const: 'active' }
    );
    expect(validate().ok).toBe(true);
  });

  test('test_derived_const_must_be_in_base_enum: a const outside the base enum is unsatisfiable', () => {
    const validate = traitChain(
      'gts.x.unit.tr.rustconstnotinenum.v1~',
      'gts.x.unit.tr.rustconstnotinenum.v1~x.unit._.kid.v1~',
      { type: 'string', enum: ['active', 'inactive'] },
      { type: 'string', const: 'deleted' }
    );
    expect(validate().ok).toBe(false);
  });

  test('test_property_disabled_fails: disabling an ancestor-declared property is unsatisfiable', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.rustdisableprop.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', properties: { x: { type: 'string' } } },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': { type: 'object', properties: { x: false } },
      })
    );

    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disables a property/);
  });

  test('test_additional_properties_false_blocks_new_prop: a closed ancestor rejects a new descendant property', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.rustapclosednew.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: false,
        },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'string' } },
        },
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(false);
  });

  test('test_additional_properties_inherited_via_allof_not_loosening: omitting additionalProperties inherits ancestor closedness', () => {
    // The descendant conjunct omits `additionalProperties` entirely (rather
    // than explicitly declaring it `true`), so `mergeAdditionalPropertiesConstraint`
    // folds forward the ancestor's closed constraint rather than reopening
    // it - not loosening.
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.tr.rustapinherited.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;

    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: false,
        },
      })
    );
    gts.register(
      derivedType(kidId, baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          properties: { a: { type: 'string' } },
        },
      })
    );

    expect(gts.validateEntity(kidId).ok).toBe(true);
  });

  test('a malformed base id no longer hides the ancestor chain and silently passes trait validation (regression)', () => {
    // Regression for the `buildSchemaChain` fail-open bug: a malformed base
    // id (5 dot-segments before `v1~` instead of the required 4) used to
    // make `buildSchemaChain` throw internally and get caught by a bare
    // `catch { return [schemaId] }`, silently truncating the chain to a
    // single element with no ancestors - so every trait-schema/parent
    // constraint on the (now-invisible) base type was skipped and
    // `validateEntity` wrongly reported `ok: true`. `register()` now rejects
    // the malformed id outright, so the entity never enters the store.
    const gts = new GTS({ validateRefs: false });
    const malformedBaseId = 'gts.x.unit.tr.nestedorphanbug.base.v1~';

    const traitsSchema = {
      type: 'object',
      required: ['config'],
      properties: {
        config: {
          type: 'object',
          required: ['field'],
          properties: { field: { type: 'string' } },
        },
      },
    };
    const kidTraitsSchema = {
      type: 'object',
      properties: { config: { type: 'object', properties: {}, additionalProperties: false } },
    };

    expect(() =>
      gts.register(baseType(malformedBaseId, { 'x-gts-abstract': true, 'x-gts-traits-schema': traitsSchema }))
    ).toThrow(`Invalid GTS entity id: '${malformedBaseId}'`);

    // The identical trait-schema content, on a well-formed 4-segment base id,
    // correctly detects the same nested conflict and returns `ok: false` -
    // confirming the fix only closes the id-well-formedness hole and does
    // not affect the underlying nested-orphan detection logic itself.
    const wellFormedBaseId = 'gts.x.unit.tr.nestedorphanbug.v1~';
    const wellFormedKidId = `${wellFormedBaseId}x.unit._.kid.v1~`;

    gts.register(baseType(wellFormedBaseId, { 'x-gts-abstract': true, 'x-gts-traits-schema': traitsSchema }));
    gts.register(
      derivedType(wellFormedKidId, wellFormedBaseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': kidTraitsSchema,
      })
    );

    expect(gts.validateEntity(wellFormedKidId).ok).toBe(false);
  });
});

describe('OP#13 - a diamond-shaped x-gts-traits-schema chain is bounded by a path-count budget', () => {
  // `resolveTraitSchemaRefs` does not memoize `$ref` resolution across
  // sibling `allOf` branches (a diamond ancestor is re-resolved from scratch
  // every time a different path reaches it): a schema compiler like Ajv
  // walks the resulting inlined schema by structure, not by object identity,
  // so even a memoized-but-still-inlined tree would still be exponential to
  // compile and, worse, exponential for Ajv's *compiled validator* to run on
  // every subsequent `validateEntity()` call. Rather than chase that
  // algorithmic cost, `resolveTraitSchemaRefs` counts every `$ref` follow and
  // `allOf` branch recursion against a shared, generous `MAX_SCHEMA_PATHS`
  // budget (10,000) and fails fast and loud once a trait-schema graph has
  // too many composition paths to be worth resolving - the same "bounded
  // rejection instead of a full algorithmic fix" already used elsewhere in
  // this file for `MAX_SCHEMA_DEPTH`.

  test('a chain where every level doubles its composition paths exceeds the budget and fails fast, not with a hang', () => {
    // Each level's `x-gts-traits-schema` is `{allOf: [{$ref: prev}, {$ref:
    // prev}]}` - the same ancestor referenced twice - so the number of
    // composition paths doubles exactly once per level. 12 levels already
    // clears the 10,000-path budget (2^12 = 4096 branch points, each also
    // following a `$ref`, comfortably exceeds it well before the chain
    // bottoms out), so this test stays small, fast, and nowhere near a size
    // that could hang or OOM the test runner even without the guard.
    const gts = new GTS({ validateRefs: false });

    const prev = 'gts.x.unit.pathbudget.a0.v1~';
    gts.register(baseType(prev, { 'x-gts-traits-schema': { type: 'object', properties: { p0: { type: 'string' } } } }));

    const DEPTH = 12;
    let cur = prev;
    for (let i = 1; i <= DEPTH; i++) {
      const next = `gts.x.unit.pathbudget.a${i}.v1~`;
      gts.register(
        baseType(next, {
          'x-gts-traits-schema': { allOf: [{ $ref: `gts://${cur}` }, { $ref: `gts://${cur}` }] },
        })
      );
      cur = next;
    }

    const start = Date.now();
    const result = gts.validateEntity(cur);
    const elapsedMs = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too many composition paths/);
    expect(result.error).toMatch(/exceeds 10000/);
    // Well under a second - this must fail fast, not hang.
    expect(elapsedMs).toBeLessThan(500);
  });

  test('a legitimate, shallow (well under-budget) diamond chain still resolves and validates correctly', () => {
    // Control for the guard above: a modest, realistic diamond - the same
    // "two immediate ancestors" shape real derivation hierarchies use - must
    // not be rejected by the new budget.
    const gts = new GTS({ validateRefs: false });

    const prevA = 'gts.x.unit.pathbudgetok.a0.v1~';
    const prevB = 'gts.x.unit.pathbudgetok.b0.v1~';
    gts.register(
      baseType(prevA, { 'x-gts-traits-schema': { type: 'object', properties: { p0: { type: 'string' } } } })
    );
    gts.register(
      baseType(prevB, { 'x-gts-traits-schema': { type: 'object', properties: { q0: { type: 'string' } } } })
    );

    const DEPTH = 6;
    let a = prevA;
    let b = prevB;
    for (let i = 1; i <= DEPTH; i++) {
      const next = `gts.x.unit.pathbudgetok.a${i}.v1~`;
      gts.register(
        baseType(next, {
          allOf: [{ $ref: `gts://${a}` }, { $ref: `gts://${b}` }],
          'x-gts-traits-schema': { allOf: [{ $ref: `gts://${a}` }, { $ref: `gts://${b}` }] },
        })
      );
      b = a;
      a = next;
    }

    const start = Date.now();
    const result = gts.validateEntity(a);
    const elapsedMs = Date.now() - start;

    // No `x-gts-traits` value was supplied, so completeness fails (the base
    // ancestors' trait properties, and the entity's own `id`, are never
    // satisfied) - that failure is expected and orthogonal to this test.
    // What matters is that resolution actually ran to that verdict instead
    // of being rejected by the path-count budget.
    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/too many composition paths/);
    expect(result.error).not.toMatch(/nests deeper than/);
    expect(elapsedMs).toBeLessThan(500);
  });

  test('a legitimate, non-branching trait-schema chain resolves correctly and quickly regardless of depth', () => {
    // Control for the guard's depth-independence: a purely linear chain (no
    // `allOf` branching at all) never accumulates more than one composition
    // path per level, so it must sail through the 10,000-path budget
    // regardless of how deep it goes. Depth is kept within `MAX_SCHEMA_DEPTH`
    // (64) - `resolveTraitSchemaRefs` recurses through a referenced entity's
    // whole content (not only its `x-gts-traits-schema`), so its own
    // depth-per-level cost is a separate, pre-existing property of this
    // walker, unrelated to (and unchanged by) the path-count budget this
    // test guards.
    const gts = new GTS({ validateRefs: false });

    const prev = 'gts.x.unit.linearchain.a0.v1~';
    gts.register(baseType(prev, { 'x-gts-traits-schema': { type: 'object', properties: { p0: { type: 'string' } } } }));

    const DEPTH = 15;
    let cur = prev;
    for (let i = 1; i <= DEPTH; i++) {
      const next = `gts.x.unit.linearchain.a${i}.v1~`;
      gts.register(
        baseType(next, {
          'x-gts-traits-schema': { allOf: [{ $ref: `gts://${cur}` }] },
        })
      );
      cur = next;
    }

    const start = Date.now();
    const result = gts.validateEntity(cur);
    const elapsedMs = Date.now() - start;

    expect(result.error).not.toMatch(/too many composition paths/);
    expect(result.error).not.toMatch(/nests deeper than/);
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe('OP#13 - x-gts-ref is enforced against materialized trait values (§9.6)', () => {
  test('a materialized trait value that violates x-gts-ref fails completeness', () => {
    const gts = new GTS({ validateRefs: false });
    const topicSchemaId = 'gts.x.unit.trxrefbad.topic.v1~';
    gts.register(baseType(topicSchemaId));

    const baseId = 'gts.x.unit.trxrefbad.base.v1~';
    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          required: ['topicRef'],
          properties: { topicRef: { type: 'string', 'x-gts-ref': topicSchemaId } },
        },
        'x-gts-traits': { topicRef: 'not-a-valid-gts-ref-at-all' },
      })
    );

    const result = gts.validateEntity(baseId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/x-gts-ref/);
  });

  test('a materialized trait value that matches x-gts-ref passes completeness', () => {
    const gts = new GTS({ validateRefs: false });
    const topicSchemaId = 'gts.x.unit.trxrefgood.topic.v1~';
    gts.register(baseType(topicSchemaId));

    const baseId = 'gts.x.unit.trxrefgood.base.v1~';
    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          required: ['topicRef'],
          properties: { topicRef: { type: 'string', 'x-gts-ref': topicSchemaId } },
        },
        // A registered entity id that matches the x-gts-ref pattern is a valid
        // reference value; the schema's own id qualifies.
        'x-gts-traits': { topicRef: topicSchemaId },
      })
    );

    expect(gts.validateEntity(baseId).ok).toBe(true);
  });

  test('a materialized trait value matching x-gts-ref FAILS completeness when the referenced entity is not registered (reconciled: issue #107)', () => {
    // Previously this pinned the opposite behavior: `x-gts-traits` values
    // were treated as schema-level example/default data documenting a
    // type's shape, not live references, so only GTS-ID pattern/format
    // validity was enforced and registry existence was deliberately skipped
    // (the referenced entity below was "deliberately never registered").
    // gts-spec v0.13.3 issue #107 reverses that rationale: a syntactically
    // valid, correctly-prefixed `x-gts-traits` value that names an
    // unregistered entity must now fail validation, matching the canonical
    // conformance case `TestCaseOp13_TraitRef_TopicRefNonexistent`. This is
    // not gated on `validateRefs` (still `false` here, the same
    // configuration the server uses) - that option only governs the
    // separate live-reference checks elsewhere.
    //
    // The registry-existence check only fires once the referenced type
    // itself is registered (an x-gts-ref naming a wholly unregistered/
    // foreign namespace is documentation, not a live reference - see
    // `TestCaseOp13_TraitsValid_AllResolved` et al in the canonical suite,
    // which reference `gts.x.core.events.topic.v1~` without ever
    // registering it and still expect success), so `topicSchemaId` must be
    // registered here for this test to actually exercise the check.
    const gts = new GTS({ validateRefs: false });
    const topicSchemaId = 'gts.x.unit.trxrefunreg.topic.v1~';
    gts.register(baseType(topicSchemaId));

    const baseId = 'gts.x.unit.trxrefunreg.base.v1~';
    gts.register(
      baseType(baseId, {
        'x-gts-traits-schema': {
          type: 'object',
          required: ['topicRef'],
          properties: { topicRef: { type: 'string', 'x-gts-ref': topicSchemaId } },
        },
        'x-gts-traits': { topicRef: `${topicSchemaId}x.unit._.orders.v1` },
      })
    );

    const result = gts.validateEntity(baseId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found in registry/);
  });

  test('an abstract type with an unresolved x-gts-ref-constrained trait is still exempt', () => {
    const gts = new GTS({ validateRefs: false });
    const topicSchemaId = 'gts.x.unit.trxrefabs.topic.v1~';
    gts.register(baseType(topicSchemaId));

    const baseId = 'gts.x.unit.trxrefabs.base.v1~';
    gts.register(
      baseType(baseId, {
        'x-gts-abstract': true,
        'x-gts-traits-schema': {
          type: 'object',
          required: ['topicRef'],
          properties: { topicRef: { type: 'string', 'x-gts-ref': topicSchemaId } },
        },
      })
    );

    expect(gts.validateEntity(baseId).ok).toBe(true);
  });
});

// Phase 5 - trait-ref registry existence
// (spec canonical suite: .gts-spec/tests/test_op13_schema_traits_validation.py,
// TestCaseOp13_TraitRef_TopicRefNonexistent - "the regression scenario
// described in issue #107").
//
// This is new behavior with no gts-rust reference to port: gts-rust's
// `validate_trait_values` / `XGtsRefValidator` (schema_traits.rs,
// x_gts_ref.rs) check only GTS-ID shape/pattern for trait values, never
// registry presence. `validateSchemaTraits` in src/store.ts explicitly
// mirrors that today - see the comment directly above its
// `new XGtsRefValidator().validateInstance(materialized, effectiveSchema)`
// call (no `store` argument passed) - and the pre-existing test in the
// describe block directly above this one, 'a materialized trait value
// matching x-gts-ref passes completeness even when the referenced entity is
// not registered' (tests/traits.test.ts:1836), asserts exactly the opposite
// of the canonical case below. That existing test is NOT modified here per
// the phase-5 test-authoring rules (existing tests are never weakened,
// skipped or rewritten in this step); it is flagged here as contradicting
// the canonical behavior and will need to be reconciled once
// registry-existence checking is implemented - most likely by
// updating/removing it in the same change that makes the
// `TODO(phase-5)` test below pass.
describe('OP#13 - x-gts-ref trait values require a registered referent (canonical: TraitRef_TopicRefNonexistent, issue #107)', () => {
  test('control: a trait ref value with valid syntax, correct prefix, and a REGISTERED referent passes', () => {
    const gts = new GTS({ validateRefs: false });
    const topicTypeId = 'gts.x.test5.trefexist_ctl.topic.v1~';
    gts.register(baseType(topicTypeId));
    const topicInstanceId = `${topicTypeId}x.test5._.orders.v1.0`;
    gts.register({ id: topicInstanceId, type: topicTypeId });

    const eventBaseId = 'gts.x.test5.trefexist_ctl.event.v1~';
    gts.register(
      baseType(eventBaseId, {
        'x-gts-traits-schema': {
          type: 'object',
          properties: { topicRef: { type: 'string', 'x-gts-ref': topicTypeId } },
        },
      })
    );

    const derivedGoodId = `${eventBaseId}x.test5._.order_placed_good.v1~`;
    gts.register(derivedType(derivedGoodId, eventBaseId, { 'x-gts-traits': { topicRef: topicInstanceId } }));

    const result = gts.validateEntity(derivedGoodId);
    expect(result.ok).toBe(true);
  });

  test('a trait ref value that is syntactically valid and correctly prefixed, but NOT registered, fails validation', () => {
    const gts = new GTS({ validateRefs: false });
    const topicTypeId = 'gts.x.test5.trefnonexist.topic.v1~';
    gts.register(baseType(topicTypeId));

    const eventBaseId = 'gts.x.test5.trefnonexist.event.v1~';
    gts.register(
      baseType(eventBaseId, {
        'x-gts-traits-schema': {
          type: 'object',
          properties: { topicRef: { type: 'string', 'x-gts-ref': topicTypeId } },
        },
      })
    );

    // Never registered - well-formed and correctly prefixed, but absent from
    // the store.
    const nonexistentTopicId = `${topicTypeId}x.test5._.nonexistent_topic.v12.0`;
    const derivedBadId = `${eventBaseId}x.test5._.order_placed_bad.v1~`;
    gts.register(derivedType(derivedBadId, eventBaseId, { 'x-gts-traits': { topicRef: nonexistentTopicId } }));

    const result = gts.validateEntity(derivedBadId);
    // TODO(phase-5): fails today - `validateSchemaTraits` in src/store.ts
    // calls `new XGtsRefValidator().validateInstance(...)` with no `store`
    // argument, so only GTS-ID pattern validity is checked, never registry
    // presence (result.ok is true today). The store itself has full access
    // at that call site (`this.get(...)` is used throughout the same
    // method), so passing `this` the way the instance-side check at
    // src/store.ts:264 already does should be sufficient to add the check.
    expect(result.ok).toBe(false);
  });
});

describe("OP#13 - trait schemas use their root type's dialect", () => {
  const DRAFT2020 = 'https://json-schema.org/draft/2020-12/schema';

  // A trait subschema carries no `$schema` of its own, so it inherits the
  // dialect of the Type Schema that declares it. Compiling a 2020-12 trait
  // schema using `prefixItems` under draft-07 would silently ignore the keyword.
  const traitType = (id: string, pair: unknown[]) => ({
    $id: id,
    $schema: DRAFT2020,
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
    'x-gts-traits-schema': {
      type: 'object',
      properties: { pair: { type: 'array', prefixItems: [{ type: 'string' }] } },
    },
    'x-gts-traits': { pair },
  });

  test('a 2020-12 prefixItems trait constraint rejects a non-conforming value', () => {
    const gts = new GTS({ validateRefs: false });
    const id = 'gts.x.unit.tr.dialectbad.v1~';
    gts.register(traitType(id, [42]));

    const result = gts.validateEntity(id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('trait validation');
  });

  test('a 2020-12 prefixItems trait constraint accepts a conforming value', () => {
    const gts = new GTS({ validateRefs: false });
    const id = 'gts.x.unit.tr.dialectok.v1~';
    gts.register(traitType(id, ['ok']));

    expect(gts.validateEntity(id).ok).toBe(true);
  });

  test('an embedded trait resource cannot declare a different dialect', () => {
    const gts = new GTS({ validateRefs: false });
    const id = 'gts.x.unit.tr.resourcedialect.v1~';
    gts.register({
      $id: id,
      $schema: DRAFT2020,
      type: 'object',
      'x-gts-traits-schema': {
        $id: 'https://example.com/gts/legacy-traits',
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
      },
    });

    const result = gts.validateEntity(id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('differs from host dialect');
  });

  test('a draft-07 child cannot inherit a 2020-12 trait schema through a mixed-dialect chain', () => {
    const gts = new GTS({ validateRefs: false });
    const parentId = 'gts.x.unit.tr.inheriteddialect.v1~';
    const childId = `${parentId}x.unit._.child.v1~`;
    gts.register(traitType(parentId, []));
    gts.register({
      $id: childId,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
      'x-gts-traits': { pair: [42] },
    });

    const result = gts.validateEntity(childId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('derivation chain mixes JSON Schema dialects');
  });

  test('a 2020-12 child cannot inherit a draft-07 tuple trait schema through a mixed-dialect chain', () => {
    const gts = new GTS({ validateRefs: false });
    const parentId = 'gts.x.unit.tr.inheritedtuple.v1~';
    const childId = `${parentId}x.unit._.child.v1~`;
    gts.register({
      $id: parentId,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
      'x-gts-traits-schema': {
        type: 'object',
        properties: { pair: { type: 'array', items: [{ type: 'string' }] } },
      },
    });
    gts.register({
      $id: childId,
      $schema: DRAFT2020,
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
      'x-gts-traits': { pair: ['ok'] },
    });

    const result = gts.validateEntity(childId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('derivation chain mixes JSON Schema dialects');
  });
});
