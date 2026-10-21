import { GTS, GtsRefValidationMode } from '../src';

const DRAFT7 = 'http://json-schema.org/draft-07/schema#';
const NONE = GtsRefValidationMode.None;

function holder(id: string, ref: any, extra: Record<string, any> = {}) {
  return {
    $id: `gts://${id}`,
    $schema: DRAFT7,
    type: 'object',
    required: ['ref'],
    properties: { ref },
    ...extra,
  };
}

/** Registers `base` and a leaf that restates (does not import) it, and validates the leaf. */
function derive(baseRef: any, leafRef: any, leafExtra?: Record<string, any>) {
  const gts = new GTS();
  const base = 'gts.x.unit.refscope.base.v1~';
  const leaf = `${base}x.unit._.leaf.v1~`;
  gts.register(holder(base, baseRef));
  gts.register(leafExtra ? { ...holder(leaf, leafRef), ...leafExtra } : holder(leaf, leafRef));
  return gts.validateSchema(leaf, NONE);
}

describe('OP#12 - reference scopes of a restated property (§9.6.1, §9.6.2)', () => {
  const T = 'gts.x.unit.refscope.target.v1~';
  const D = `${T}x.unit._.derived.v1~`;

  test.each([
    ['x-gts-type-ref', T, D, true],
    ['x-gts-type-ref', D, T, false],
    ['x-gts-instance-ref', T, `${T}x.unit._.item.v1`, true],
    ['x-gts-pattern-ref', 'gts.x.unit.refscope.*', T, true],
    ['x-gts-pattern-ref', T, 'gts.x.unit.refscope.*', false],
  ])('%s %s -> %s valid=%s', (keyword, baseOperand, leafOperand, valid) => {
    const result = derive({ type: 'string', [keyword]: baseOperand }, { type: 'string', [keyword]: leafOperand });
    expect(result.ok).toBe(valid);
  });

  test('switching between type and instance references is never a narrowing', () => {
    expect(derive({ type: 'string', 'x-gts-type-ref': T }, { type: 'string', 'x-gts-instance-ref': T }).ok).toBe(false);
  });

  test('a negated scope may only grow', () => {
    const not = (operand: string) => ({ not: { type: 'string', 'x-gts-type-ref': operand } });
    expect(derive(not(D), not(T)).ok).toBe(true);
    expect(derive(not(T), not(D)).ok).toBe(false);
  });

  test('/$id resolves to the base on the base side and to the leaf on the leaf side', () => {
    const self = { type: 'string', 'x-gts-type-ref': '/$id' };
    expect(derive(self, self).ok).toBe(true);
    expect(derive(self, { type: 'string', 'x-gts-type-ref': 'gts.x.unit.refscope.*' }).ok).toBe(false);
  });

  test('a value set inside the base scope needs no keyword', () => {
    expect(derive({ type: 'string', 'x-gts-type-ref': T }, { const: D }).ok).toBe(true);
    expect(derive({ type: 'string', 'x-gts-type-ref': T }, { const: 'gts.x.unit.other.v1~' }).ok).toBe(false);
  });

  // Review finding: the restated property drops `type`, so `{ref: 42}`
  // passes the leaf (the keyword ignores non-strings) but not the base.
  test('dropping type next to a reference keyword is a widening', () => {
    const result = derive({ type: 'string', 'x-gts-type-ref': 'gts.*' }, { 'x-gts-type-ref': 'gts.*' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("drops constraint 'type'");
  });

  // Review finding: a leaf that restates the base but omits a constrained
  // property accepts any value for it.
  test('omitting a constrained base property is a widening', () => {
    const result = derive({ type: 'string', 'x-gts-type-ref': 'gts.*' }, undefined, { properties: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Property 'ref' is constrained in base but not restated in derived");
  });

  // Review findings: value sets and `true` that accept 42, which the
  // string-typed base rejects.
  test.each([[{ const: 42 }], [{ enum: [42] }], [true]])('restating the property as %j is a widening', (leafRef) => {
    expect(derive({ type: 'string', 'x-gts-type-ref': 'gts.*' }, leafRef).ok).toBe(false);
  });

  // Review finding: the base scope sits behind a local `$ref` in the base document.
  test('a base scope reached through a local $ref is compared', () => {
    const gts = new GTS();
    const base = 'gts.x.unit.refscope.localbase.v1~';
    const leaf = `${base}x.unit._.leaf.v1~`;
    gts.register(
      holder(
        base,
        { $ref: '#/definitions/Ref' },
        { definitions: { Ref: { type: 'string', 'x-gts-type-ref': 'gts.x.*' } } }
      )
    );
    gts.register(holder(leaf, { type: 'string', 'x-gts-type-ref': 'gts.y.*' }));
    expect(gts.validateSchema(leaf, NONE).ok).toBe(false);

    const narrower = `${base}x.unit._.narrower.v1~`;
    gts.register(holder(narrower, { type: 'string', 'x-gts-type-ref': 'gts.x.unit.*' }));
    expect(gts.validateSchema(narrower, NONE).ok).toBe(true);
  });

  // Review finding: a reference inside an embedded `$id` resource resolves
  // against that resource, not the document root.
  test('a local $ref inside an embedded resource resolves against that resource', () => {
    const gts = new GTS();
    const base = 'gts.x.unit.refscope.embedded.v1~';
    const leaf = `${base}x.unit._.leaf.v1~`;
    gts.register(
      holder(
        base,
        {
          $id: 'inner',
          type: 'object',
          required: ['nested'],
          properties: { nested: { $ref: '#/definitions/Ref' } },
          definitions: { Ref: { type: 'string', 'x-gts-type-ref': 'gts.x.*' } },
        },
        { definitions: { Ref: { type: 'string', 'x-gts-type-ref': 'gts.y.*' } } }
      )
    );
    gts.register(
      holder(leaf, {
        type: 'object',
        required: ['nested'],
        properties: { nested: { type: 'string', 'x-gts-type-ref': 'gts.y.*' } },
      })
    );
    expect(gts.validateSchema(leaf, NONE).ok).toBe(false);
  });

  test('an escaped slash (~1) in a local $ref is part of one pointer segment', () => {
    const gts = new GTS();
    const base = 'gts.x.unit.refscope.encoded.v1~';
    const leaf = `${base}x.unit._.leaf.v1~`;
    gts.register(
      holder(
        base,
        { $ref: '#/definitions/a~1b' },
        { definitions: { 'a/b': { type: 'string', 'x-gts-type-ref': 'gts.x.*' } } }
      )
    );
    gts.register(holder(leaf, { type: 'string', 'x-gts-type-ref': 'gts.y.*' }));
    expect(gts.validateSchema(leaf, NONE).ok).toBe(false);
  });

  test('a percent-encoded slash (%2F) in a local $ref separates pointer segments', () => {
    const gts = new GTS();
    const base = 'gts.x.unit.refscope.percent.v1~';
    const leaf = `${base}x.unit._.leaf.v1~`;
    gts.register(
      holder(
        base,
        { $ref: '#/definitions%2FRef' },
        { definitions: { Ref: { type: 'string', 'x-gts-type-ref': 'gts.x.*' } } }
      )
    );
    gts.register(holder(leaf, { type: 'string', 'x-gts-type-ref': 'gts.y.*' }));
    expect(gts.validateSchema(leaf, NONE).ok).toBe(false);

    const narrower = `${base}x.unit._.narrower.v1~`;
    gts.register(holder(narrower, { type: 'string', 'x-gts-type-ref': 'gts.x.unit.*' }));
    expect(gts.validateSchema(narrower, NONE).ok).toBe(true);
  });

  // Review finding: a diamond of local references must not expand
  // exponentially; on exhausting the path budget the check fails closed.
  test('a diamond-shaped local $ref graph is bounded and fails closed', () => {
    const gts = new GTS();
    const base = 'gts.x.unit.refscope.diamond.v1~';
    const leaf = `${base}x.unit._.leaf.v1~`;
    const definitions: Record<string, any> = { D0: { type: 'string', 'x-gts-type-ref': 'gts.x.*' } };
    for (let i = 1; i <= 20; i++) {
      definitions[`D${i}`] = { allOf: [{ $ref: `#/definitions/D${i - 1}` }, { $ref: `#/definitions/D${i - 1}` }] };
    }
    gts.register(holder(base, { $ref: '#/definitions/D20' }, { definitions }));
    gts.register(holder(leaf, { type: 'string', 'x-gts-type-ref': 'gts.x.*' }));
    const start = Date.now();
    expect(gts.validateSchema(leaf, NONE).ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  // Flattening a parent that conjoins a narrow inherited scope with a wider
  // overlay must keep the narrow scope instead of replacing it.
  test('a wider overlay on the parent does not widen the base the leaf is compared with', () => {
    const gts = new GTS();
    const root = 'gts.x.unit.refscope.root.v1~';
    const middle = `${root}x.unit._.middle.v1~`;
    const leaf = `${middle}x.unit._.leaf.v1~`;
    gts.register(holder(root, { type: 'string', 'x-gts-pattern-ref': T }));
    gts.register({
      $id: `gts://${middle}`,
      $schema: DRAFT7,
      allOf: [
        { $ref: `gts://${root}` },
        { type: 'object', properties: { ref: { type: 'string', 'x-gts-pattern-ref': 'gts.*' } } },
      ],
    });
    gts.register(holder(leaf, { type: 'string', 'x-gts-pattern-ref': 'gts.x.unit.*' }));
    expect(gts.validateSchema(leaf, NONE).ok).toBe(false);
  });
});

describe('OP#6 - registry policy follows the applicators (§9.6.1)', () => {
  const ANY_VALID = GtsRefValidationMode.AnyValid;

  function setup() {
    const gts = new GTS();
    const item = 'gts.x.unit.refpolicy.item.v1~';
    gts.register({ $id: `gts://${item}`, $schema: DRAFT7, type: 'object', required: ['name'] });
    const good = `${item}x.unit._.good.v1`;
    const bad = `${item}x.unit._.bad.v1`;
    gts.register({ id: good, type: item, name: 'good' });
    gts.register({ id: bad, type: item });
    return { gts, item, good, bad };
  }

  function check(gts: GTS, ref: any, value: string) {
    const holderId = `gts.x.unit.refpolicy.h${Math.random().toString(36).slice(2, 8)}.v1~`;
    gts.register({ $id: `gts://${holderId}`, $schema: DRAFT7, type: 'object', properties: { ref } });
    return gts.validateTransientInstance({ ref: value }, holderId, null, ANY_VALID).ok;
  }

  test('an invalid target in a rejected anyOf branch is not a requirement', () => {
    const { gts, item, bad } = setup();
    expect(check(gts, { anyOf: [{ const: bad }, { 'x-gts-instance-ref': item }] }, bad)).toBe(true);
    expect(check(gts, { anyOf: [{ const: 'other' }, { 'x-gts-instance-ref': item }] }, bad)).toBe(false);
  });

  test('not inverts a policy failure like any other candidate failure', () => {
    const { gts, item, good, bad } = setup();
    expect(check(gts, { not: { 'x-gts-instance-ref': item } }, bad)).toBe(true);
    expect(check(gts, { not: { 'x-gts-instance-ref': item } }, good)).toBe(false);
  });

  test('oneOf counts a branch that fails the policy as not matching', () => {
    const { gts, item, bad } = setup();
    expect(check(gts, { oneOf: [{ 'x-gts-instance-ref': item }, { const: bad }] }, bad)).toBe(true);
  });

  test('pattern references never consult the registry', () => {
    const { gts } = setup();
    expect(check(gts, { 'x-gts-pattern-ref': 'gts.x.unit.unregistered.*' }, 'gts.x.unit.unregistered.thing.v1~')).toBe(
      true
    );
  });
});

describe('OP#6 - any-valid through reference cycles (§9.6.1)', () => {
  const item = 'gts.x.unit.refcycle.item.v1~';
  const flip = 'gts.x.unit.refcycle.flip.v1~';
  const holderId = 'gts.x.unit.refcycle.holder.v1~';
  const a = `${item}x.unit._.a.v1`;
  const b = `${item}x.unit._.b.v1`;

  function setup() {
    const gts = new GTS();
    gts.register({
      $id: `gts://${item}`,
      $schema: DRAFT7,
      type: 'object',
      required: ['name'],
      properties: { peer: { 'x-gts-instance-ref': 'gts.x.unit.refcycle.*' } },
    });
    return gts;
  }

  function holder(gts: GTS, properties: Record<string, any>) {
    gts.register({ $id: `gts://${holderId}`, $schema: DRAFT7, type: 'object', properties });
  }

  // Review finding: B is validated while A is in progress, so A is assumed
  // valid. A then fails, and B's success must not be reused.
  test('a success that assumed an in-progress entity valid is discarded when it fails', () => {
    const gts = setup();
    gts.register({ id: a, type: item, peer: b });
    gts.register({ id: b, type: item, name: 'b', peer: a });
    holder(gts, {
      first: { anyOf: [{ 'x-gts-instance-ref': item }, { const: a }] },
      second: { 'x-gts-instance-ref': item },
    });

    expect(gts.validateInstance(b).ok).toBe(false);
    expect(gts.validateTransientInstance({ first: a, second: b }, holderId, null).ok).toBe(false);
  });

  // The same assumption can produce a failure: under `not`, an in-progress
  // entity assumed valid makes the negated reference fail.
  test('a failure that assumed an in-progress entity valid is discarded when it fails', () => {
    const gts = setup();
    gts.register({
      $id: `gts://${flip}`,
      $schema: DRAFT7,
      type: 'object',
      properties: { other: { not: { 'x-gts-instance-ref': item } } },
    });
    const f = `${flip}x.unit._.f.v1`;
    gts.register({ id: a, type: item, peer: f });
    gts.register({ id: f, type: flip, other: a });
    holder(gts, {
      first: { anyOf: [{ 'x-gts-instance-ref': item }, { const: a }] },
      second: { 'x-gts-instance-ref': flip },
    });

    expect(gts.validateInstance(f).ok).toBe(true);
    expect(gts.validateTransientInstance({ first: a, second: f }, holderId, null).ok).toBe(true);
  });

  // Re-validating every result that assumed a failing entity valid repeats
  // whole subtrees; a dense cycle must stay cheap.
  test('a dense cycle of invalid entities settles without repeated subtrees', () => {
    const gts = new GTS();
    gts.register({
      $id: `gts://${item}`,
      $schema: DRAFT7,
      type: 'object',
      required: ['name'],
      properties: { peers: { type: 'array', items: { 'x-gts-instance-ref': item } } },
    });
    const ids = Array.from({ length: 10 }, (_, i) => `${item}x.unit._.e${i}.v1`);
    ids.forEach((id) => gts.register({ id, type: item, peers: ids.filter((other) => other !== id) }));
    const start = Date.now();
    const result = gts.validateInstance(ids[0]);
    expect(result.ok).toBe(false);
    expect(new Set(result.errors?.map((issue) => issue.entityId))).toEqual(new Set([undefined, ...ids.slice(1)]));
    // Each entity's own issues once (a `required` and one per peer), and a
    // message that does not quote every referenced entity's message in turn.
    expect(result.errors!.length).toBeLessThanOrEqual(ids.length * (ids.length + 1));
    expect(result.error.length).toBeLessThan(10_000);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: 'required', entityId: ids[1] })])
    );
    expect(Date.now() - start).toBeLessThan(5000);
  });

  // `p` is valid exactly when `q` is invalid, and `q` exactly when `p` is valid.
  test('a cycle without a consistent verdict fails closed', () => {
    const gts = new GTS();
    const p = 'gts.x.unit.refcycle.p.v1~';
    const q = 'gts.x.unit.refcycle.q.v1~';
    const object = (id: string, properties: Record<string, any>) => ({
      $id: `gts://${id}`,
      $schema: DRAFT7,
      type: 'object',
      properties,
    });
    gts.register(object(p, { other: { not: { 'x-gts-instance-ref': q } } }));
    gts.register(object(q, { back: { 'x-gts-instance-ref': p } }));
    gts.register({ id: `${p}x.unit._.p.v1`, type: p, other: `${q}x.unit._.q.v1` });
    gts.register({ id: `${q}x.unit._.q.v1`, type: q, back: `${p}x.unit._.p.v1` });

    const result = gts.validateInstance(`${p}x.unit._.p.v1`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('has no consistent verdict');
  });

  test('entities that only reference each other are valid', () => {
    const gts = setup();
    gts.register({ id: a, type: item, name: 'a', peer: b });
    gts.register({ id: b, type: item, name: 'b', peer: a });
    holder(gts, { first: { 'x-gts-instance-ref': item }, second: { 'x-gts-instance-ref': item } });

    expect(gts.validateTransientInstance({ first: a, second: b }, holderId, null).ok).toBe(true);
    expect(gts.validateInstance(b).ok).toBe(true);
  });

  // Review finding: the invalid target's own issues were reduced to a string.
  test("an invalid target's structured issues are kept and tagged with its identity", () => {
    const gts = setup();
    gts.register({ id: a, type: item });
    holder(gts, { ref: { 'x-gts-instance-ref': item } });

    const result = gts.validateTransientInstance({ ref: a }, holderId, null);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ instancePath: '/ref', keyword: 'x-gts-instance-ref' }),
      expect.objectContaining({ instancePath: '/', keyword: 'required', entityId: a }),
    ]);
  });

  test('issues keep the identity of the entity they describe through a chain', () => {
    const gts = setup();
    gts.register({ id: a, type: item, name: 'a', peer: b });
    gts.register({ id: b, type: item });
    holder(gts, { ref: { 'x-gts-instance-ref': item } });

    const result = gts.validateTransientInstance({ ref: a }, holderId, null);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instancePath: '/peer', keyword: 'x-gts-instance-ref', entityId: a }),
        expect.objectContaining({ keyword: 'required', entityId: b }),
      ])
    );
  });

  test('an invalid target in a rejected alternative contributes no issues', () => {
    const gts = setup();
    gts.register({ id: a, type: item });
    holder(gts, { ref: { anyOf: [{ 'x-gts-instance-ref': item }, { const: a }] }, count: { type: 'number' } });

    expect(gts.validateTransientInstance({ ref: a }, holderId, null).ok).toBe(true);
    const result = gts.validateTransientInstance({ ref: a, count: 'x' }, holderId, null);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((issue) => issue.entityId !== undefined)).toBe(false);
  });
});

describe('OP#12 - restated properties compared as whole schemas', () => {
  // Review finding: a type behind a local `$ref` is not dropped.
  test('a type reached through a local $ref is kept', () => {
    const gts = new GTS();
    const base = 'gts.x.unit.refscope.localtype.v1~';
    const leaf = `${base}x.unit._.leaf.v1~`;
    gts.register(holder(base, { type: 'string' }));
    gts.register(holder(leaf, { $ref: '#/definitions/String' }, { definitions: { String: { type: 'string' } } }));
    expect(gts.validateSchema(leaf, NONE).ok).toBe(true);
  });

  // Review finding: equal property schemas are equal even when their
  // reference constraints are not modeled.
  test('an identical restatement with an unmodeled reference constraint is compatible', () => {
    const ref = { oneOf: [{ 'x-gts-type-ref': 'gts.*' }, { 'x-gts-type-ref': 'gts.x.*' }] };
    expect(derive(ref, ref).ok).toBe(true);
    expect(derive({ anyOf: [{ 'x-gts-type-ref': 'gts.*' }, { const: 1 }] }, ref).ok).toBe(false);
  });

  // Review finding: counterexamples are evaluated under the document's dialect.
  test('a counterexample is confirmed under the dialect of the compared documents', () => {
    const D2020 = 'https://json-schema.org/draft/2020-12/schema';
    const anyArray = { type: 'array', contains: false, minContains: 0 };
    const restated = (dialect: string) => {
      const gts = new GTS();
      const base = 'gts.x.unit.refscope.dialect.v1~';
      const leaf = `${base}x.unit._.leaf.v1~`;
      const ref = { type: ['string', 'array'], 'x-gts-type-ref': 'gts.*' };
      gts.register({ ...holder(base, { ...ref, anyOf: [{ type: 'string' }, anyArray] }), $schema: dialect });
      gts.register({ ...holder(leaf, ref), $schema: dialect });
      return gts.validateSchema(leaf, NONE);
    };
    // Draft-07 has no `minContains`, so `contains: false` rejects `[]`.
    expect(restated(DRAFT7).error).toContain('accepts values the base rejects');
    expect(restated(D2020).error).not.toContain('accepts values the base rejects');
  });
});
