import { GTS, attachSourceLocations } from '../src';

const DRAFT7 = 'http://json-schema.org/draft-07/schema#';

function traitHost(baseId: string, traitsSchema: Record<string, any>, traits?: Record<string, any>) {
  return {
    $id: baseId,
    $schema: DRAFT7,
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
    'x-gts-traits-schema': traitsSchema,
    ...(traits ? { 'x-gts-traits': traits } : {}),
  };
}

function kidOf(kidId: string, baseId: string, traits?: Record<string, any>) {
  return {
    $id: kidId,
    $schema: DRAFT7,
    type: 'object',
    allOf: [{ $ref: `gts://${baseId}` }, { type: 'object' }],
    ...(traits ? { 'x-gts-traits': traits } : {}),
  };
}

describe('F2: trait issue pointers', () => {
  test('a root trait error maps to /x-gts-traits (no trailing empty segment)', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.stf.root.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;
    gts.register(
      traitHost(baseId, { type: 'object', properties: { retention: { type: 'string' } }, required: ['retention'] })
    );
    gts.register(kidOf(kidId, baseId));
    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
    const paths = (result.errors ?? []).map((e) => e.instancePath);
    expect(paths).toEqual(['/x-gts-traits']);
  });

  test('a nested trait error maps to /x-gts-traits/<name>', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.stf.nested.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;
    gts.register(traitHost(baseId, { type: 'object', properties: { retention: { type: 'string' } } }));
    gts.register(kidOf(kidId, baseId, { retention: 5 }));
    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
    expect((result.errors ?? []).map((e) => e.instancePath)).toEqual(['/x-gts-traits/retention']);
  });

  test('source location of a root trait error highlights the traits object, not the whole entity', () => {
    const gts = new GTS({ validateRefs: false });
    const baseId = 'gts.x.unit.stf.src.v1~';
    const kidId = `${baseId}x.unit._.kid.v1~`;
    gts.register(
      traitHost(baseId, {
        type: 'object',
        properties: { retention: { type: 'string' }, other: { type: 'string' } },
        required: ['retention'],
      })
    );
    const kid = kidOf(kidId, baseId, { other: 'x' });
    gts.register(kid);
    const result = gts.validateEntity(kidId);
    expect(result.ok).toBe(false);
    const text = JSON.stringify(kid, null, 2);
    const [located] = attachSourceLocations('json', text, 0, result.errors ?? []);
    const span = located.source!.value;
    expect(text.slice(span.offset, span.offset + span.length)).toBe(
      JSON.stringify(kid['x-gts-traits'], null, 2).replace(/\n/g, '\n  ')
    );
    expect(span.length).toBeLessThan(text.length);
  });
});

describe('F4: normalization is skipped for cached compiled schemas', () => {
  function setup() {
    const gts = new GTS({ validateRefs: false });
    const store = (gts as any).store;
    const typeId = 'gts.x.unit.stf.cache.v1~';
    const instId = `${typeId}x.unit.stf.inst.v1`;
    const schema = {
      $id: typeId,
      $schema: DRAFT7,
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    };
    gts.register(schema);
    gts.register({ id: instId });
    const spy = jest.spyOn(store, 'normalizeSchema');
    return { gts, store, typeId, instId, schema, spy };
  }

  test('validateInstance normalizes once across N cached calls', () => {
    const { gts, instId, spy } = setup();
    for (let i = 0; i < 5; i++) expect(gts.validateInstance(instId).ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('validateTransientInstance normalizes once across N cached calls', () => {
    const { gts, typeId, spy } = setup();
    for (let i = 0; i < 5; i++) expect(gts.validateTransientInstance({ id: 'a' }, typeId, null).ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a pool mutation invalidates the cache, so the next call normalizes again', () => {
    const { gts, store, instId, schema, spy } = setup();
    gts.validateInstance(instId);
    gts.validateInstance(instId);
    expect(spy).toHaveBeenCalledTimes(1);
    store.removeEngineSchema(schema.$id);
    gts.validateInstance(instId);
    expect(spy).toHaveBeenCalledTimes(2);
    store.addEngineSchema(store.get(schema.$id));
    const before = spy.mock.calls.length;
    gts.validateInstance(instId);
    gts.validateInstance(instId);
    expect(spy.mock.calls.length - before).toBe(1);
  });

  test('an unsafe pattern is still rejected on first compile and never cached', () => {
    const gts = new GTS({ validateRefs: false });
    const store = (gts as any).store;
    const typeId = 'gts.x.unit.stf.unsafe.v1~';
    const entity = {
      id: typeId,
      isSchema: true,
      content: {
        $id: typeId,
        $schema: DRAFT7,
        type: 'object',
        properties: { a: { type: 'string', pattern: '(?=a)a' } },
      },
    };
    expect(() => store.normalizedRegisteredSchema(entity)).toThrow();
    expect(() => store.normalizedRegisteredSchema(entity)).toThrow();
    expect(store.normalizedSchemaCache.has(typeId)).toBe(false);
  });
});
