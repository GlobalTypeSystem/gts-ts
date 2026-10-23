import { GtsStore, createJsonEntity } from '../src';
import type { SchemaEngine } from '../src/schema-engine';

const DRAFT7 = 'http://json-schema.org/draft-07/schema#';
const PREFIX = 'JSON Schema validation failed:';

const cacheSize = (store: GtsStore): number => ((store as any).engine as SchemaEngine).cacheSize();

const schemaB = (type: string, id = 'gts.x.unit.cache.b.v1~') => ({ $id: `gts://${id}`, $schema: DRAFT7, type });
const idA = 'gts.x.unit.cache.a.v1~';
const instanceId = `${idA}x.unit._.item.v1`;
const schemaA = (id = idA, refId = 'gts.x.unit.cache.b.v1~') => ({
  $id: `gts://${id}`,
  $schema: DRAFT7,
  type: 'object',
  required: ['value'],
  properties: { value: { $ref: `gts://${refId}` } },
});

function setup(config?: ConstructorParameters<typeof GtsStore>[0]): GtsStore {
  const store = new GtsStore({ allowEntityUpdates: true, ...config });
  store.register(createJsonEntity(schemaB('string')));
  store.register(createJsonEntity(schemaA()));
  store.register(createJsonEntity({ id: instanceId, value: 'text' }));
  return store;
}

describe('compiled schema cache', () => {
  test('stays bounded over 5,000 repeated validateInstance calls', () => {
    const store = setup();
    expect(store.validateInstance(instanceId).ok).toBe(true);
    const afterFirst = cacheSize(store);
    expect(afterFirst).toBe(1);
    for (let i = 0; i < 5000; i++) store.validateInstance(instanceId);
    expect(cacheSize(store)).toBe(afterFirst);
    expect(store.validateInstance(instanceId).ok).toBe(true);
  });

  test('replacing a referenced schema invalidates the dependent', () => {
    const store = setup();
    expect(store.validateInstance(instanceId).ok).toBe(true);
    expect(cacheSize(store)).toBe(1);
    store.register(createJsonEntity(schemaB('integer')));
    expect(cacheSize(store)).toBe(0);
    expect(store.validateInstance(instanceId).ok).toBe(false);
    expect(cacheSize(store)).toBe(1);
  });

  test('unregistering a referenced schema fails unresolved $ref (prefix once on schema validation)', () => {
    const store = setup();
    expect(store.validateInstance(instanceId).ok).toBe(true);
    expect(cacheSize(store)).toBe(1);
    store.unregister('gts.x.unit.cache.b.v1~');
    expect(cacheSize(store)).toBe(0);
    const result = store.validateInstance(instanceId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not resolve \$ref/);
    expect(cacheSize(store)).toBe(0);
    // Schema validation of the dependent reports the same failure with the store prefix, once.
    const schemaResult = store.validateSchemaDocument(schemaA(), idA);
    expect(schemaResult.ok).toBe(false);
    expect(schemaResult.error.startsWith(PREFIX)).toBe(true);
    expect(schemaResult.error.split(PREFIX).length - 1).toBe(1);
    expect(cacheSize(store)).toBe(0);
  });

  test('stage then discard restores the original referenced schema', () => {
    const store = setup();
    expect(store.validateInstance(instanceId).ok).toBe(true);
    const token = store.stage(createJsonEntity(schemaB('integer')));
    expect(cacheSize(store)).toBe(0);
    expect(store.validateInstance(instanceId).ok).toBe(false);
    expect(cacheSize(store)).toBe(1);
    store.discard(token);
    expect(cacheSize(store)).toBe(0);
    expect(store.validateInstance(instanceId).ok).toBe(true);
    expect(cacheSize(store)).toBe(1);
  });

  test('stage then commit uses the committed referenced schema', () => {
    const store = setup();
    expect(store.validateInstance(instanceId).ok).toBe(true);
    const token = store.stage(createJsonEntity(schemaB('integer')));
    expect(store.validateInstance(instanceId).ok).toBe(false);
    store.commit(token);
    expect(cacheSize(store)).toBe(0);
    expect(store.validateInstance(instanceId).ok).toBe(false);
    expect(cacheSize(store)).toBe(1);
  });

  test('transient, derived and document validation never grow the cache', () => {
    const store = setup();
    expect(cacheSize(store)).toBe(0);

    expect(store.validateTransientSchema(schemaA(), idA).ok).toBe(true);
    expect(cacheSize(store)).toBe(0);
    expect(store.validateSchemaDocument(schemaB('string'), 'gts.x.unit.cache.b.v1~').ok).toBe(true);
    expect(cacheSize(store)).toBe(0);
    expect(store.validateCastResult(schemaB('string'), 'text')).toBeNull();
    expect(cacheSize(store)).toBe(0);

    const baseId = 'gts.x.unit.cache.traits.v1~';
    const derivedId = `${baseId}x.unit._.derived.v1~`;
    store.register(
      createJsonEntity({
        $id: `gts://${baseId}`,
        $schema: DRAFT7,
        type: 'object',
        'x-gts-traits-schema': { type: 'object', properties: { n: { type: 'integer' } } },
      })
    );
    store.register(
      createJsonEntity({
        $id: `gts://${derivedId}`,
        $schema: DRAFT7,
        type: 'object',
        allOf: [{ $ref: `gts://${baseId}` }, { type: 'object' }],
        'x-gts-traits': { n: 1 },
      })
    );
    expect(store.validateSchemaAgainstParent(derivedId).ok).toBe(true);
    expect(cacheSize(store)).toBe(0);
  });

  test('two stores keep independent caches and outcomes', () => {
    const one = setup();
    const two = setup();
    expect(one.validateInstance(instanceId).ok).toBe(true);
    expect(cacheSize(one)).toBe(1);
    expect(cacheSize(two)).toBe(0);
    two.register(createJsonEntity(schemaB('integer')));
    expect(two.validateInstance(instanceId).ok).toBe(false);
    expect(cacheSize(two)).toBe(1);
    expect(one.validateInstance(instanceId).ok).toBe(true);
    expect(cacheSize(one)).toBe(1);
  });

  test('staging, committing and discarding an instance keep both caches warm', () => {
    const store = setup();
    const spy = jest.spyOn(store as any, 'normalizeSchema');
    expect(store.validateInstance(instanceId).ok).toBe(true);
    const calls = spy.mock.calls.length;
    expect(cacheSize(store)).toBe(1);

    const otherId = `${idA}x.unit._.other.v1`;
    const t1 = store.stage(createJsonEntity({ id: otherId, value: 'a' }));
    expect(cacheSize(store)).toBe(1);
    store.discard(t1);
    expect(cacheSize(store)).toBe(1);
    const t2 = store.stage(createJsonEntity({ id: otherId, value: 'b' }));
    store.commit(t2);
    expect(cacheSize(store)).toBe(1);

    expect(store.validateInstance(instanceId).ok).toBe(true);
    expect(store.validateInstance(otherId).ok).toBe(true);
    expect(spy.mock.calls.length).toBe(calls);
    expect(cacheSize(store)).toBe(1);
  });

  test('engine removeEngineSchema reports whether a pool entry was removed', () => {
    const engine = (setup() as any).engine as SchemaEngine;
    expect(engine.removeEngineSchema('gts.x.unit.cache.absent.v1~')).toBe(false);
    expect(engine.removeEngineSchema('gts.x.unit.cache.b.v1~')).toBe(true);
    expect(engine.removeEngineSchema('gts.x.unit.cache.b.v1~')).toBe(false);
  });

  test('unregistering a referenced schema clears the cache', () => {
    const store = setup();
    expect(store.validateInstance(instanceId).ok).toBe(true);
    expect(cacheSize(store)).toBe(1);
    store.unregister('gts.x.unit.cache.b.v1~');
    expect(cacheSize(store)).toBe(0);
  });
});
