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
    let token = store.stage(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object' }));

    // Internal resolution sees it; public reads do not.
    expect(store.get(id)).toBeDefined();
    expect(store.getCommitted(id)).toBeUndefined();

    // Discard leaves nothing behind.
    store.discard(token);
    expect(store.get(id)).toBeUndefined();
    expect(store.getCommitted(id)).toBeUndefined();

    // Commit publishes it.
    token = store.stage(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object' }));
    expect(store.getCommitted(id)).toBeUndefined();
    expect(store.commit(token)).toBe('added');
    expect(store.getCommitted(id)).toBeDefined();
  });

  // Atomic batch publication (regression for the non-atomic commit loop): if a
  // survivor's target was committed with different content after staging, the
  // whole batch publishes nothing rather than committing the dependent against
  // changed content.
  test('commitBatch publishes nothing when a target conflicts with committed content', () => {
    const store = new GtsStore();
    const parent = 'gts.x.tsatomic._.parent.v1~';
    const child = 'gts.x.tsatomic._.child.v1~';
    const cToken = store.stage(
      createJsonEntity({ $id: `gts://${child}`, $schema: DRAFT7, type: 'object', title: 'ok' })
    );
    const pToken = store.stage(
      createJsonEntity({ $id: `gts://${parent}`, $schema: DRAFT7, type: 'object', title: 'staged' })
    );
    // A concurrent writer commits the parent id with different content after staging.
    store.register(createJsonEntity({ $id: `gts://${parent}`, $schema: DRAFT7, type: 'object', title: 'committed' }));

    expect(store.commitBatch([cToken, pToken])).toEqual(['conflict', 'conflict']);
    // Nothing from the batch was published; the parent keeps its committed content.
    expect(store.getCommitted(child)).toBeUndefined();
    expect(store.getCommitted(parent)?.content.title).toBe('committed');
  });

  test('commitBatch publishes the whole set when no target conflicts', () => {
    const store = new GtsStore();
    const idA = 'gts.x.tsatomic2._.a.v1~';
    const idB = 'gts.x.tsatomic2._.b.v1~';
    const a = store.stage(createJsonEntity({ $id: `gts://${idA}`, $schema: DRAFT7, type: 'object', title: 'a' }));
    const b = store.stage(createJsonEntity({ $id: `gts://${idB}`, $schema: DRAFT7, type: 'object', title: 'b' }));
    expect(store.commitBatch([a, b])).toEqual(['added', 'added']);
    expect(store.getCommitted(idA)).toBeDefined();
    expect(store.getCommitted(idB)).toBeDefined();
  });

  test('commitBatch publishes changed content when updates are enabled', () => {
    const store = new GtsStore({ allowEntityUpdates: true });
    const id = 'gts.x.tsatomic3._.updated.v1~';
    store.register(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object', title: 'old' }));
    const token = store.stage(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object', title: 'new' }));

    expect(store.commitBatch([token])).toEqual(['added']);
    expect(store.getCommitted(id)?.content.title).toBe('new');
  });

  test('discarding a staged replacement preserves the committed version', () => {
    const store = new GtsStore({ allowEntityUpdates: true });
    const id = 'gts.x.unit.staging.replace.v1~';
    store.register(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object', title: 'committed' }));

    // Stage a different version, then discard it: the committed one survives.
    const token = store.stage(
      createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object', title: 'staged' })
    );
    expect(store.getCommitted(id)?.content.title).toBe('committed');
    store.discard(token);
    expect(store.getCommitted(id)?.content.title).toBe('committed');
  });

  // Two stages that resolve to the same id must each get their own token, and a
  // commit must never silently overwrite different committed content - it
  // reports a conflict instead. Covers a duplicated id inside one validate=true
  // batch (and, structurally, two concurrent batches racing on the same id).
  test('staging the same id twice yields distinct tokens and commit does not overwrite', () => {
    const store = new GtsStore();
    const id = 'gts.x.unit.staging.dup.v1~';
    const tokenA = store.stage(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object', title: 'a' }));
    const tokenB = store.stage(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object', title: 'b' }));
    expect(tokenA).not.toBe(tokenB);

    expect(store.commit(tokenA)).toBe('added');
    // Committing B (different content for the same id) must conflict, not clobber A.
    expect(store.commit(tokenB)).toBe('conflict');
    expect(store.getCommitted(id)?.content.title).toBe('a');
  });

  test('committing identical staged content twice is unchanged, never a conflict', () => {
    const store = new GtsStore();
    const id = 'gts.x.unit.staging.same.v1~';
    const tokenA = store.stage(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object', title: 'x' }));
    const tokenB = store.stage(createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object', title: 'x' }));
    expect(store.commit(tokenA)).toBe('added');
    expect(store.commit(tokenB)).toBe('unchanged');
  });

  test('discarding one token leaves another staged entry for the same id', () => {
    const store = new GtsStore();
    const id = 'gts.x.unit.staging.iso.v1~';
    const tokenA = store.stage(
      createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object', title: 'keep' })
    );
    const tokenB = store.stage(
      createJsonEntity({ $id: `gts://${id}`, $schema: DRAFT7, type: 'object', title: 'drop' })
    );
    store.discard(tokenB);
    expect(store.commit(tokenA)).toBe('added');
    expect(store.getCommitted(id)?.content.title).toBe('keep');
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
        expect(
          JSON.parse((await server.instance.inject({ method: 'GET', url: `/entities/${ns}.t0.v1~` })).body).ok
        ).toBe(true);
      }
    } finally {
      await server.stop();
    }

    expect(leaks).toBe(0);
  });
});

describe('validate=true batch staging commit integrity', () => {
  const post = (server: GtsServer, url: string, payload: unknown) =>
    server.instance.inject({ method: 'POST', url, payload: payload as any });
  const get = (server: GtsServer, url: string) => server.instance.inject({ method: 'GET', url });

  // A survivor must never be published when a sibling it depends on is itself
  // discarded. Under any-present ref validation, B carries an x-gts-ref to A,
  // and A carries an x-gts-ref to a type that is never registered. Validated
  // against the fully staged set, B passes (A is present) while A fails (its
  // target is missing) - a single-pass implementation would then commit B with
  // a dangling reference to the discarded A. The iterative discard-then-
  // revalidate must reject B too, so neither is retrievable afterwards.
  test('a survivor that depends on a discarded sibling is not committed', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    try {
      const batch = [
        {
          $schema: DRAFT7,
          $id: 'gts://gts.x.tsdep._.a.v1~',
          type: 'object',
          properties: { r: { type: 'string', 'x-gts-ref': 'gts.x.tsdep._.missing.v1~' } },
        },
        {
          $schema: DRAFT7,
          $id: 'gts://gts.x.tsdep._.b.v1~',
          type: 'object',
          properties: { x: { type: 'string', 'x-gts-ref': 'gts.x.tsdep._.a.v1~' } },
        },
      ];
      const body = JSON.parse(
        (await post(server, '/type-schemas?validate=true&gts-ref-validation=any-present', batch)).body
      );
      expect(body.ok).toBe(false);
      expect(body.results[0].ok).toBe(false);
      expect(body.results[1].ok).toBe(false);
      expect(JSON.parse((await get(server, '/entities/gts.x.tsdep._.a.v1~')).body).ok).toBe(false);
      expect(JSON.parse((await get(server, '/entities/gts.x.tsdep._.b.v1~')).body).ok).toBe(false);
    } finally {
      await server.stop();
    }
  });

  // A batch that carries the same $id twice with different content is internally
  // inconsistent, so the atomic publish must keep NEITHER entry (no silent
  // last-wins): the batch is rejected as a whole and nothing is committed.
  test('a conflicting duplicate id within a batch is rejected atomically, not silently overwritten', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    try {
      const batch = [
        { $schema: DRAFT7, $id: 'gts://gts.x.tsdup._.t.v1~', type: 'object', title: 'a' },
        { $schema: DRAFT7, $id: 'gts://gts.x.tsdup._.t.v1~', type: 'object', title: 'b' },
      ];
      const body = JSON.parse((await post(server, '/type-schemas?validate=true', batch)).body);
      expect(body.ok).toBe(false);
      expect(body.results[0].ok).toBe(false);
      expect(body.results[1].ok).toBe(false);
      // All-or-nothing: nothing from the inconsistent batch is published.
      expect(JSON.parse((await get(server, '/entities/gts.x.tsdup._.t.v1~')).body).ok).toBe(false);
    } finally {
      await server.stop();
    }
  });
});
