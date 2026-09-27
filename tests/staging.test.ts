import { GtsStore, createJsonEntity } from '../src';
import { GtsServer } from '../src/server/server';

const DRAFT7 = 'http://json-schema.org/draft-07/schema#';

describe('store staging isolation', () => {
  // The core invariant that keeps an unvalidated entity from ever being
  // observed: a staged entity is visible to internal validation (`get`) but
  // invisible to public reads (`getCommitted`) until `commit`, and `discard`
  // removes it without ever touching committed state.
  test('a staged entity is invisible to public reads until committed', () => {
    const store = new GtsStore();
    const id = 'gts.x.unit.staging.pending.v1~';
    store.stage(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object' }));

    // Internal resolution sees it; public reads do not.
    expect(store.get(id)).toBeDefined();
    expect(store.getCommitted(id)).toBeUndefined();

    // Discard leaves nothing behind.
    store.discard(id);
    expect(store.get(id)).toBeUndefined();
    expect(store.getCommitted(id)).toBeUndefined();

    // Commit publishes it.
    store.stage(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object' }));
    expect(store.getCommitted(id)).toBeUndefined();
    store.commit(id);
    expect(store.getCommitted(id)).toBeDefined();
  });

  test('discarding a staged replacement preserves the committed version', () => {
    const store = new GtsStore({ allowEntityUpdates: true });
    const id = 'gts.x.unit.staging.replace.v1~';
    store.register(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object', title: 'committed' }));

    // Stage a different version, then discard it: the committed one survives.
    store.stage(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object', title: 'staged' }));
    expect(store.getCommitted(id)?.content.title).toBe('committed');
    store.discard(id);
    expect(store.getCommitted(id)?.content.title).toBe('committed');
  });
});

describe('validate=true batch staging never exposes uncommitted entities (concurrent reads)', () => {
  // Node is single-threaded, but this fires the batch POST and many GET probes
  // for the deliberately-invalid entry as concurrent in-flight requests and
  // asserts the invalid entry is never observable at any point. Repeated over
  // several cycles.
  test('a concurrent reader never sees the invalid entry during a validated batch', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const cycles = 10;
    const probesPerCycle = 20;
    const validPerBatch = 80;
    let leaks = 0;

    try {
      for (let cycle = 0; cycle < cycles; cycle++) {
        const ns = `gts.x.tsconc${cycle}._`;
        const invalidId = `${ns}.invalid.v1~`;
        const batch = [
          ...Array.from({ length: validPerBatch }, (_unused, i) => ({
            $schema: DRAFT7,
            $id: `gts://${ns}.t${i}.v1~`,
            type: 'object',
            properties: { p: { type: 'string' } },
          })),
          {
            $schema: DRAFT7,
            $id: `gts://${invalidId}`,
            type: 'object',
            properties: { a: { $ref: `gts://${ns}.never.v1~` } },
          },
        ];

        const getInvalid = () => server.instance.inject({ method: 'GET', url: `/entities/${invalidId}` });
        const post = server.instance.inject({ method: 'POST', url: '/type-schemas?validate=true', payload: batch });
        const probes = Array.from({ length: probesPerCycle }, () => getInvalid());

        const [postResponse, ...probeResponses] = await Promise.all([post, ...probes]);

        const body = JSON.parse(postResponse.body);
        expect(body.ok).toBe(false);
        for (const response of probeResponses) {
          if (JSON.parse(response.body).ok === true) leaks++;
        }

        // Final committed state: invalid absent, a valid entry present.
        expect(JSON.parse((await getInvalid()).body).ok).toBe(false);
        expect(JSON.parse((await server.instance.inject({ method: 'GET', url: `/entities/${ns}.t0.v1~` })).body).ok).toBe(
          true
        );
      }
    } finally {
      await server.stop();
    }

    expect(leaks).toBe(0);
  });
});
