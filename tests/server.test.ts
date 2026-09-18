import { GtsServer } from '../src/server/server';

const DRAFT7 = 'http://json-schema.org/draft-07/schema#';

describe('HTTP connection lifecycle', () => {
  test('closes responses to bound idle file descriptors', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const response = await server.instance.inject({ method: 'GET', url: '/health' });

    expect(response.headers.connection).toBe('close');

    await server.stop();
  });
});

describe('POST /type-schemas', () => {
  test('rejects a type_id that does not end with the required "~" (spec 2.1 / 11.1 Rule C.1)', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

    const response = await server.instance.inject({
      method: 'POST',
      url: '/type-schemas',
      payload: {
        // Missing the trailing '~' that a GTS Type Identifier must have.
        type_id: 'gts.x.unit.srv.notype.v1',
        type_schema: { $schema: DRAFT7, type: 'object' },
      },
    });

    expect(response.statusCode).toBe(422);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/type_id/);

    await server.stop();
  });

  test('accepts a well-formed type_id ending with "~"', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

    const response = await server.instance.inject({
      method: 'POST',
      url: '/type-schemas',
      payload: {
        type_id: 'gts.x.unit.srv.goodtype.v1~',
        type_schema: { $schema: DRAFT7, type: 'object' },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);

    await server.stop();
  });
});

describe('malformed registered schemas do not crash validation into an HTTP 500 (PR #16 review finding #4)', () => {
  // Schemas are registered without meta-validation, so a literal `null` in a
  // schema position (e.g. `properties: {a: null}`, or `allOf: [{...}, null]`)
  // can reach `resolveSchemaFully`/`extractOverlay` later, when some other
  // type derives from it and is validated. Reading `.type`/`['$ref']` off
  // that `null` used to throw an uncaught `TypeError`, which Fastify turned
  // into an unhandled 500.
  test('a null in a properties position is a clean validation failure, not a 500', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const baseId = 'gts.x.unit.srv.nullprop.v1~';

    const registerResponse = await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: {
        $id: baseId,
        $schema: DRAFT7,
        'x-gts-traits-schema': { type: 'object', properties: { a: null } },
      },
    });
    expect(registerResponse.statusCode).toBe(200);

    const derivedId = `${baseId}x.unit._.kid.v1~`;
    const registerDerived = await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: { $id: derivedId, $schema: DRAFT7, allOf: [{ $ref: `gts://${baseId}` }] },
    });
    expect(registerDerived.statusCode).toBe(200);

    const validateEntityResponse = await server.instance.inject({
      method: 'POST',
      url: '/validate-entity',
      payload: { entity_id: derivedId },
    });
    expect(validateEntityResponse.statusCode).not.toBe(500);
    const entityBody = JSON.parse(validateEntityResponse.body);
    expect(entityBody.ok).toBe(false);

    const validateTypeResponse = await server.instance.inject({
      method: 'POST',
      url: '/validate-type-schema',
      payload: { type_id: derivedId },
    });
    expect(validateTypeResponse.statusCode).not.toBe(500);
    const typeBody = JSON.parse(validateTypeResponse.body);
    expect(typeBody.ok).toBe(false);

    await server.stop();
  });

  test('a null inside allOf is a no-op, not a 500', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const baseId = 'gts.x.unit.srv.nullallof.v1~';

    const registerBase = await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: { $id: baseId, $schema: DRAFT7, type: 'object' },
    });
    expect(registerBase.statusCode).toBe(200);

    const derivedId = `${baseId}x.unit._.kid.v1~`;
    const registerDerived = await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: { $id: derivedId, $schema: DRAFT7, allOf: [{ $ref: `gts://${baseId}` }, null] },
    });
    expect(registerDerived.statusCode).toBe(200);

    const validateEntityResponse = await server.instance.inject({
      method: 'POST',
      url: '/validate-entity',
      payload: { entity_id: derivedId },
    });
    // The malformed `null` branch is treated as a no-op rather than a crash;
    // it does not otherwise affect a chain that is valid without it.
    expect(validateEntityResponse.statusCode).not.toBe(500);
    const entityBody = JSON.parse(validateEntityResponse.body);
    expect(entityBody.ok).toBe(true);

    await server.stop();
  });
});

describe('POST /entities?validate=true rolls back a parent-incompatibility rejection (review finding R1)', () => {
  // `store.register()` runs before the parent-compatibility gate (it must,
  // since the gate looks the entity up by id), so a 422 here used to leave
  // the schema fully committed: retrievable via GET /entities/{id} and
  // derivable by other schemas. The store must undo the registration before
  // returning the rejection.
  test('a schema rejected for base-incompatibility is not retrievable afterwards', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const baseId = 'gts.x.unit.srv.parentgate.v1~';
    const derivedId = `${baseId}x.unit._.kid.v1~`;

    const registerBase = await server.instance.inject({
      method: 'POST',
      url: '/entities?validate=true',
      payload: {
        $id: `gts://${baseId}`,
        $schema: DRAFT7,
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string' } },
      },
    });
    expect(registerBase.statusCode).toBe(200);

    // Adds a property the base does not declare while the base closes itself
    // with `additionalProperties: false` - an incompatible derivation.
    const registerDerived = await server.instance.inject({
      method: 'POST',
      url: '/entities?validate=true',
      payload: {
        $id: `gts://${derivedId}`,
        $schema: DRAFT7,
        type: 'object',
        properties: { b: { type: 'string' } },
      },
    });
    expect(registerDerived.statusCode).toBe(422);
    const derivedBody = JSON.parse(registerDerived.body);
    expect(derivedBody.ok).toBe(false);

    const getDerived = await server.instance.inject({
      method: 'GET',
      url: `/entities/${encodeURIComponent(derivedId)}`,
    });
    // Phase 6 convention correction: .gts-spec/tests/openapi.json declares
    // only 200/422 for `GET /entities/{gts_id}` (no 404), and the canonical
    // `_assert_not_stored` helper (test_op6_schema_validation.py:2333)
    // requires 200 + `ok:false` for a missing id - so a missing/rolled-back
    // entity is now reported as 200 with `ok:false` rather than 404.
    expect(getDerived.statusCode).toBe(200);
    expect(JSON.parse(getDerived.body).ok).toBe(false);

    await server.stop();
  });
});

describe('POST /cast reports three-valued compatibility verdicts (spec 0.13 §9.2)', () => {
  // Phase 1 - this is the httprunner canonical case
  // `TestCaseTestOp9Cast_DistinctDialects` (test_op9_version_casting.py:566)
  // transcribed directly at the HTTP layer, because the verdict fields it
  // asserts (`body.backward_compatibility` etc.) are only observable there:
  // The verdicts are computed independently of whether the instance transform
  // itself succeeds - a successful cast must not by itself imply
  // compatibility - and are normalised in `GtsStore.castInstance()` so every
  // response carries all three, failures included.
  test('casting across distinct declared dialects reports unknown for all three verdicts even though the cast itself succeeds', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const oldTypeId = 'gts.x.unit.srvdialectcast.event.v1.0~';
    const newTypeId = 'gts.x.unit.srvdialectcast.event.v1.1~';
    const instanceId = `${oldTypeId}x.unit._.source.v1`;

    const registerOld = await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: {
        $id: `gts://${oldTypeId}`,
        $schema: 'https://json-schema.org/draft-07/schema',
        type: 'object',
        properties: { status: { type: 'string' } },
      },
    });
    expect(registerOld.statusCode).toBe(200);

    const registerNew = await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: {
        $id: `gts://${newTypeId}`,
        $schema: 'http://json-schema.org/draft/2020-12/schema#',
        type: 'object',
        properties: { status: { type: 'string' } },
      },
    });
    expect(registerNew.statusCode).toBe(200);

    const registerInstance = await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: { id: instanceId, type: oldTypeId, status: 'active' },
    });
    expect(registerInstance.statusCode).toBe(200);

    const castResponse = await server.instance.inject({
      method: 'POST',
      url: '/cast',
      payload: { instance_id: instanceId, to_type_id: newTypeId },
    });
    expect(castResponse.statusCode).toBe(200);
    const body = JSON.parse(castResponse.body);

    expect(body.casted_entity.status).toBe('active');
    expect(body.backward_compatibility).toBe('unknown');
    expect(body.forward_compatibility).toBe('unknown');
    expect(body.full_compatibility).toBe('unknown');

    await server.stop();
  });

  // Review finding P1-R1: the failure paths of `GtsStore.castInstance()` used
  // to omit the three verdict fields entirely (`JSON.stringify` drops
  // `undefined`), so a client testing `body.full_compatibility === 'unknown'`
  // saw `false`. Spec 0.13 section 9.2 requires all three on every response.
  test('reports unknown verdicts when the instance does not exist', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

    const castResponse = await server.instance.inject({
      method: 'POST',
      url: '/cast',
      payload: {
        instance_id: 'gts.x.unit.srvcastmissing.event.v1.0~x.unit._.nope.v1',
        to_type_id: 'gts.x.unit.srvcastmissing.event.v1.1~',
      },
    });
    const body = JSON.parse(castResponse.body);

    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
    expect(body.backward_compatibility).toBe('unknown');
    expect(body.forward_compatibility).toBe('unknown');
    expect(body.full_compatibility).toBe('unknown');

    await server.stop();
  });

  test('reports unknown verdicts when the cast target type is not registered', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const typeId = 'gts.x.unit.srvcastnotarget.event.v1.0~';
    const instanceId = `${typeId}x.unit._.source.v1`;

    const registerType = await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: {
        $id: `gts://${typeId}`,
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { status: { type: 'string' } },
      },
    });
    expect(registerType.statusCode).toBe(200);

    const registerInstance = await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: { id: instanceId, type: typeId, status: 'active' },
    });
    expect(registerInstance.statusCode).toBe(200);

    const castResponse = await server.instance.inject({
      method: 'POST',
      url: '/cast',
      payload: {
        instance_id: instanceId,
        to_type_id: 'gts.x.unit.srvcastnotarget.event.v9.9~',
      },
    });
    const body = JSON.parse(castResponse.body);

    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
    expect(body.backward_compatibility).toBe('unknown');
    expect(body.forward_compatibility).toBe('unknown');
    expect(body.full_compatibility).toBe('unknown');

    await server.stop();
  });
});

describe('GET /openapi', () => {
  test('documents every route actually registered on the server', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    await server.instance.ready();

    // Fastify (v5) does not expose a plain list-of-routes API: `printRoutes()`
    // only returns a pretty-printed tree, and `hasRoute()` checks one route
    // at a time. So this list is hard-coded and MUST be kept in sync with the
    // `this.fastify.get/post(...)` calls in `GtsServer.registerRoutes()`
    // (src/server/server.ts). Each entry is cross-checked against
    // `hasRoute()` below, so a stale entry here fails the test rather than
    // silently drifting from the real route table.
    const registeredRoutes: Array<{ method: 'GET' | 'POST'; url: string; openApiPath: string }> = [
      { method: 'GET', url: '/health', openApiPath: '/health' },
      { method: 'GET', url: '/entities', openApiPath: '/entities' },
      { method: 'POST', url: '/entities', openApiPath: '/entities' },
      { method: 'GET', url: '/entities/:id', openApiPath: '/entities/{id}' },
      { method: 'POST', url: '/entities/bulk', openApiPath: '/entities/bulk' },
      { method: 'POST', url: '/type-schemas', openApiPath: '/type-schemas' },
      { method: 'GET', url: '/validate-id', openApiPath: '/validate-id' },
      { method: 'POST', url: '/extract-id', openApiPath: '/extract-id' },
      { method: 'GET', url: '/parse-id', openApiPath: '/parse-id' },
      { method: 'GET', url: '/match-id-pattern', openApiPath: '/match-id-pattern' },
      { method: 'GET', url: '/uuid', openApiPath: '/uuid' },
      { method: 'POST', url: '/validate-instance', openApiPath: '/validate-instance' },
      { method: 'GET', url: '/resolve-relationships', openApiPath: '/resolve-relationships' },
      { method: 'GET', url: '/compatibility', openApiPath: '/compatibility' },
      { method: 'POST', url: '/cast', openApiPath: '/cast' },
      { method: 'GET', url: '/query', openApiPath: '/query' },
      { method: 'GET', url: '/attr', openApiPath: '/attr' },
      { method: 'POST', url: '/validate-type-schema', openApiPath: '/validate-type-schema' },
      { method: 'POST', url: '/validate-entity', openApiPath: '/validate-entity' },
      { method: 'GET', url: '/openapi', openApiPath: '/openapi' },
    ];

    for (const route of registeredRoutes) {
      expect(server.instance.hasRoute({ method: route.method, url: route.url })).toBe(true);
    }

    const response = await server.instance.inject({ method: 'GET', url: '/openapi' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    const paths = body.paths;

    for (const route of registeredRoutes) {
      expect(paths).toHaveProperty(route.openApiPath);
    }

    // Regression: the reported version must track package.json, not a
    // hard-coded literal that can drift from the published version.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(body.info.version).toBe(require('../package.json').version);

    await server.stop();
  });

  test('documents conflict responses for entity and type-schema registration', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const response = await server.instance.inject({ method: 'GET', url: '/openapi' });
    const paths = JSON.parse(response.body).paths;

    for (const path of ['/entities', '/type-schemas']) {
      expect(paths[path].post.responses['409']).toEqual({
        description: 'Entity conflict',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/OperationResult' },
          },
        },
      });
    }

    await server.stop();
  });
});

// ---------------------------------------------------------------------------
// OP#6 - POST /validate-json and POST /validate-json/{gts_type}
//
// Canonical source: .gts-spec/tests/test_op6_schema_validation.py (18 cases,
// starting at :2346 for auto-detection, :2547 for explicit-type, :2780 for
// body-shape). Neither route is registered on `GtsServer` yet
// (src/server/server.ts only wires OP#1-#12 minus this "op6json" pair), so
// every test below currently 404s. TODO(phase-6): register
// `POST /validate-json` and `POST /validate-json/{gts_type}`; both must
// return `ValidateJsonResult` (`ok`, `id`, `type_id`, `is_type_schema`,
// `error` — all five required per .gts-spec/tests/openapi.json) and MUST NOT
// register anything (transient validation per spec commit ab1287e).
//
// Helpers below mirror .gts-spec/tests/helpers/http_run_helpers.py::register
// and the file-local `_raw_json_schema` / `_assert_not_stored` helpers.
describe('POST /validate-json (OP#6 transient JSON validation)', () => {
  async function registerSchema(server: GtsServer, wireId: string, body: Record<string, unknown>): Promise<void> {
    const response = await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: { $id: wireId, $schema: DRAFT7, ...body },
    });
    expect(response.statusCode).toBe(200);
  }

  function rawJsonSchema(typeId: string, requiredField = 'name'): Record<string, unknown> {
    return {
      $id: `gts://${typeId}`,
      $schema: DRAFT7,
      type: 'object',
      required: [requiredField],
      properties: { [requiredField]: { type: 'string' } },
      additionalProperties: false,
    };
  }

  // The canonical `_assert_not_stored` helper (test_op6_schema_validation.py:
  // 2333) expects `GET /entities/{id}` to return `200` with `body.ok ===
  // false` for a never-registered id. Phase 6 convention correction: this is
  // also what .gts-spec/tests/openapi.json actually declares for
  // `GET /entities/{gts_id}` (only 200/422, no 404), so `GtsServer` was
  // changed to match - see the "POST /entities?validate=true rolls back..."
  // test above, which now asserts the same `200` + `ok:false` shape.
  async function assertNotStored(server: GtsServer, gtsId: string): Promise<void> {
    const response = await server.instance.inject({ method: 'GET', url: `/entities/${gtsId}` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).ok).toBe(false);
  }

  describe('auto-detection (schema vs. instance)', () => {
    // Classification reuses `GtsExtractor.extractID` (src/extract.ts), whose
    // `is_type_schema` result already matches the `ValidateJsonResult`
    // field name 1:1 (see notes in the manifest for detail).
    test('AutoBaseSchema: a base schema validates without registration and is not stored', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const gtsId = 'gts.x.test6json._.auto_base.v1~';

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json',
        payload: rawJsonSchema(gtsId),
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(true);
      expect(body.is_type_schema).toBe(true);

      await assertNotStored(server, gtsId);
      await server.stop();
    });

    test('AutoInvalidSchema: a structurally invalid transient schema is rejected, not stored', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const gtsId = 'gts.x.test6json._.invalid_schema.v1~';

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json',
        payload: { $id: `gts://${gtsId}`, $schema: DRAFT7, type: 1 },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(false);
      expect(body.is_type_schema).toBe(true);
      expect(body.error).toMatch(/JSON Schema validation failed/);

      await assertNotStored(server, gtsId);
      await server.stop();
    });

    test('AutoDerivedSchema: a derived schema with a registered parent validates and is not stored', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const baseId = 'gts.x.test6json._.derived_base.v1~';
      const derivedId = 'gts.x.test6json._.derived_base.v1~x.test6json._.derived.v1~';

      await registerSchema(server, `gts://${baseId}`, {
        type: 'object',
        properties: { base: { type: 'string' } },
      });

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json',
        payload: {
          $id: `gts://${derivedId}`,
          $schema: DRAFT7,
          type: 'object',
          allOf: [{ $ref: `gts://${baseId}` }],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(true);
      expect(body.is_type_schema).toBe(true);

      await assertNotStored(server, derivedId);
      await server.stop();
    });

    test('AutoDerivedSchemaMissingParent: a derived schema whose parent is unregistered is rejected', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const derivedId = 'gts.x.test6json._.missing_base.v1~x.test6json._.derived.v1~';

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json',
        payload: { $id: `gts://${derivedId}`, $schema: DRAFT7, type: 'object' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(false);
      expect(body.is_type_schema).toBe(true);
      expect(body.error).toMatch(/Parent GTS Type Schema not found/);

      await server.stop();
    });

    test('AutoInstance: a valid transient instance is classified via its declared type and not stored', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const typeId = 'gts.x.test6json._.auto_instance.v1~';
      const instanceId = `${typeId}x.test6json._.item.v1`;

      await registerSchema(server, `gts://${typeId}`, {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      });

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json',
        payload: { id: instanceId, type: typeId, name: 'valid' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(true);
      expect(body.is_type_schema).toBe(false);

      await assertNotStored(server, instanceId);
      await server.stop();
    });

    test('AutoInvalidInstance: an instance failing its declared type schema is rejected and not stored', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const typeId = 'gts.x.test6json._.auto_invalid.v1~';
      const instanceId = `${typeId}x.test6json._.item.v1`;

      await registerSchema(server, `gts://${typeId}`, {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      });

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json',
        payload: { id: instanceId, type: typeId, name: 1 },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(false);
      expect(body.is_type_schema).toBe(false);
      expect(body.error).toMatch(/is not of type 'string'/);

      await assertNotStored(server, instanceId);
      await server.stop();
    });

    test('AutoIdlessInstance: an instance without an id still validates against its declared type', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const typeId = 'gts.x.test6json._.idless.v1~';

      await registerSchema(server, `gts://${typeId}`, {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      });

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json',
        payload: { type: typeId, name: 'valid' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(true);
      expect(body.is_type_schema).toBe(false);

      await server.stop();
    });

    test('AutoInstanceMissingType: a document with neither a schema marker nor a declared type is rejected', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json',
        payload: { id: 'gts.x.test6json._.no_type.v1' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(false);
      expect(body.is_type_schema).toBe(false);
      expect(body.error).toMatch(/Unable to determine instance type/);

      await server.stop();
    });
  });

  describe('explicit type (POST /validate-json/{gts_type})', () => {
    // None of these 9 cases have a counterpart in gts-rust's
    // `GtsJsonValidator` (json_validation.rs) — that validator has no
    // explicit-type parameter at all. The path-parameter route, the
    // schema-vs-instance-on-this-route rule, and the "declared type must
    // match path type" rule are entirely new surface area for phase 6.
    test('ExplicitType: a matching instance validates against the explicit base type and is not stored', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const typeId = 'gts.x.test6json._.explicit.v1~';
      const instanceId = `${typeId}x.test6json._.item.v1`;

      await registerSchema(server, `gts://${typeId}`, {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      });

      const response = await server.instance.inject({
        method: 'POST',
        url: `/validate-json/${typeId}`,
        payload: { id: instanceId, name: 'valid' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(true);
      expect(body.is_type_schema).toBe(false);
      expect(body.type_id).toBe(typeId);

      await assertNotStored(server, instanceId);
      await server.stop();
    });

    test('ExplicitTypeInvalidInstance: a non-matching, id-less instance is rejected against the explicit type', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const typeId = 'gts.x.test6json._.explicit_invalid.v1~';

      await registerSchema(server, `gts://${typeId}`, {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      });

      const response = await server.instance.inject({
        method: 'POST',
        url: `/validate-json/${typeId}`,
        payload: { name: 1 },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(false);
      expect(body.is_type_schema).toBe(false);
      expect(body.error).toMatch(/is not of type 'string'/);

      await server.stop();
    });

    test('ExplicitDerivedType: an instance validates against an explicit derived type', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const baseId = 'gts.x.test6json._.explicit_derived.v1~';
      const childId = `${baseId}x.test6json._.child.v1~`;

      await registerSchema(server, `gts://${baseId}`, {
        type: 'object',
        required: ['base'],
        properties: { base: { type: 'string' } },
      });
      await registerSchema(server, `gts://${childId}`, {
        type: 'object',
        allOf: [{ $ref: `gts://${baseId}` }],
        required: ['child'],
        properties: { child: { type: 'string' } },
      });

      const response = await server.instance.inject({
        method: 'POST',
        url: `/validate-json/${childId}`,
        payload: { base: 'base', child: 'child' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(true);
      expect(body.type_id).toBe(childId);

      await server.stop();
    });

    test('ExplicitSchemaWithoutEmbeddedIdentity: a type registered via /type-schemas (no embedded $id) still validates by path', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const typeId = 'gts.x.test6json._.external_identity.v1~';

      const registerResponse = await server.instance.inject({
        method: 'POST',
        url: '/type-schemas',
        payload: {
          type_id: typeId,
          type_schema: { properties: { prop: { type: 'string' } } },
        },
      });
      expect(registerResponse.statusCode).toBe(200);
      expect(JSON.parse(registerResponse.body).ok).toBe(true);

      const validResponse = await server.instance.inject({
        method: 'POST',
        url: `/validate-json/${typeId}`,
        payload: { prop: 'valid' },
      });
      expect(validResponse.statusCode).toBe(200);
      const validBody = JSON.parse(validResponse.body);
      expect(validBody.ok).toBe(true);
      expect(validBody.type_id).toBe(typeId);

      const invalidResponse = await server.instance.inject({
        method: 'POST',
        url: `/validate-json/${typeId}`,
        payload: { prop: 1 },
      });
      expect(invalidResponse.statusCode).toBe(200);
      const invalidBody = JSON.parse(invalidResponse.body);
      expect(invalidBody.ok).toBe(false);
      expect(invalidBody.error).toMatch(/is not of type 'string'/);

      await server.stop();
    });

    test('MalformedExplicitType: a path segment that is not a GTS Type Identifier at all is rejected', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json/not-a-gts-type',
        payload: { name: 'valid' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/Invalid GTS Type Schema ID/);

      await server.stop();
    });

    test('UnknownExplicitType: a well-formed but unregistered GTS Type Identifier is rejected', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json/gts.x.test6json._.unknown.v1~',
        payload: { name: 'valid' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/GTS Type Schema not found/);

      await server.stop();
    });

    test('ExplicitNonSchemaType: a syntactically valid GTS instance ID (no trailing "~") is rejected as a type', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json/gts.x.test6json._.not_schema.v1',
        payload: { name: 'valid' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/must be GTS Type schema/);

      await server.stop();
    });

    test('ExplicitTypeMismatch: a body whose declared "type" conflicts with the path type is rejected', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const expectedId = 'gts.x.test6json._.expected.v1~';
      const declaredId = 'gts.x.test6json._.declared.v1~';

      await registerSchema(server, `gts://${expectedId}`, {
        type: 'object',
        properties: { name: { type: 'string' } },
      });
      await registerSchema(server, `gts://${declaredId}`, {
        type: 'object',
        properties: { name: { type: 'string' } },
      });

      const response = await server.instance.inject({
        method: 'POST',
        url: `/validate-json/${expectedId}`,
        payload: { type: declaredId, name: 'valid' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/does not match path type/);

      await server.stop();
    });

    test('ExplicitTypeRejectsSchema: a schema-shaped body on the explicit-type route is rejected, not stored', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const pathTypeId = 'gts.x.test6json._.schema_path.v1~';
      const rejectedSchemaId = 'gts.x.test6json._.rejected_schema.v1~';

      await registerSchema(server, `gts://${pathTypeId}`, {
        type: 'object',
        properties: { name: { type: 'string' } },
      });

      const response = await server.instance.inject({
        method: 'POST',
        url: `/validate-json/${pathTypeId}`,
        payload: rawJsonSchema(rejectedSchemaId),
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/only accepts instance JSON/);

      await assertNotStored(server, rejectedSchemaId);
      await server.stop();
    });
  });

  describe('body shape', () => {
    test('NonObjectBody: a JSON array request body is a 422 contract violation, not a 200 with ok:false', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json',
        payload: ['not', 'an', 'object'],
      });

      expect(response.statusCode).toBe(422);

      await server.stop();
    });
  });

  describe('transient semantics (spec commit ab1287e)', () => {
    test('validating an otherwise-valid base schema never registers it, even implicitly for later lookups', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const gtsId = 'gts.x.test6json._.transient_check.v1~';

      const validateResponse = await server.instance.inject({
        method: 'POST',
        url: '/validate-json',
        payload: rawJsonSchema(gtsId),
      });
      expect(validateResponse.statusCode).toBe(200);
      expect(JSON.parse(validateResponse.body).ok).toBe(true);

      await assertNotStored(server, gtsId);

      const listResponse = await server.instance.inject({ method: 'GET', url: '/entities' });
      expect(listResponse.statusCode).toBe(200);
      const listBody = JSON.parse(listResponse.body);
      expect(listBody.items).not.toContain(gtsId);

      await server.stop();
    });
  });

  describe('ValidateJsonResult contract shape (all five fields required, per openapi.json)', () => {
    test('a successful validation response carries all five fields, not merely truthy ones', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
      const gtsId = 'gts.x.test6json._.contract_ok.v1~';

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json',
        payload: rawJsonSchema(gtsId),
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      for (const field of ['ok', 'id', 'type_id', 'is_type_schema', 'error']) {
        expect(body).toHaveProperty(field);
      }
      expect(body.ok).toBe(true);
      expect(body.error).toBeNull();

      await server.stop();
    });

    test('a failed validation response also carries all five fields', async () => {
      const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

      const response = await server.instance.inject({
        method: 'POST',
        url: '/validate-json',
        payload: { id: 'gts.x.test6json._.contract_fail.v1' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      for (const field of ['ok', 'id', 'type_id', 'is_type_schema', 'error']) {
        expect(body).toHaveProperty(field);
      }
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');

      await server.stop();
    });
  });
});

describe('GET /openapi documents the new /validate-json routes', () => {
  test('both POST /validate-json and POST /validate-json/{gts_type} appear in the route table and the OpenAPI document', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    await server.instance.ready();

    const newRoutes: Array<{ method: 'POST'; url: string; openApiPath: string }> = [
      { method: 'POST', url: '/validate-json', openApiPath: '/validate-json' },
      {
        // Fastify v5's `hasRoute()` matches find-my-way semantics: it parses
        // its `url` argument for literal `:`/`*` segments rather than
        // dispatching a request, so a dynamic route can only be probed by its
        // literal pattern - a concrete path such as
        // `/validate-json/gts.x.a.b.c.v1~` always returns false, however the
        // route was registered. See fastify's Migration-Guide-V5 ("hasRoute()
        // now matches the behavior of find-my-way"). The route's real
        // dispatch behavior is covered by the `.inject()` tests above.
        method: 'POST',
        url: '/validate-json/:gts_type',
        openApiPath: '/validate-json/{gts_type}',
      },
    ];

    for (const route of newRoutes) {
      expect(server.instance.hasRoute({ method: route.method, url: route.url })).toBe(true);
    }

    const response = await server.instance.inject({ method: 'GET', url: '/openapi' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    for (const route of newRoutes) {
      expect(body.paths).toHaveProperty(route.openApiPath);
    }

    await server.stop();
  });
});

// ---------------------------------------------------------------------------
// Phase 6 review findings (post-conformance): each of these was found by
// review after `make e2e` was already 485/485 - the canonical suite cannot
// catch a regression in any of them, so they are asserted here instead.
describe('Phase 6 review findings', () => {
  const DRAFT7 = 'http://json-schema.org/draft-07/schema#';

  test('P6-1: a chained GTS Type Identifier well over 100 chars does not 404 at the router', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

    // 108 characters - find-my-way's default `maxParamLength` is 100, and
    // GTS chained identifiers have no length cap in the grammar (src/gts.ts).
    const longTypeId =
      'gts.acme.platform.billing.invoice.v1~acme.eu.regional.invoice_adjustment.v2~acme.eu.regional.credit_note.v3~';
    expect(longTypeId.length).toBeGreaterThan(100);

    const response = await server.instance.inject({
      method: 'POST',
      url: `/validate-json/${longTypeId}`,
      payload: { name: 'valid' },
    });

    // Must reach the handler and get the documented ValidateJsonResult
    // shape (200/422 only, per openapi.json) - not a bare router 404.
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    for (const field of ['ok', 'id', 'type_id', 'is_type_schema', 'error']) {
      expect(body).toHaveProperty(field);
    }
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/GTS Type Schema not found/);

    await server.stop();
  });

  test('P6-2/P6-3: a $schema-less type registered via /type-schemas is authoritatively a schema, not a heuristic-derived instance', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const typeId = 'gts.acme.pkg.ns.order.v1~';

    const registerResponse = await server.instance.inject({
      method: 'POST',
      url: '/type-schemas',
      payload: {
        type_id: typeId,
        type_schema: { properties: { customerName: { type: 'string' } }, required: ['customerName'] },
      },
    });
    expect(registerResponse.statusCode).toBe(200);
    const registerBody = JSON.parse(registerResponse.body);
    expect(registerBody.ok).toBe(true);
    // The bug: this used to report `false` because `isSchema` was derived
    // from `GtsExtractor.isJsonSchema`'s `$schema`-keyword shape heuristic,
    // which a schema-less document like this one always fails.
    expect(registerBody.is_type_schema).toBe(true);

    // A body that violates the registered schema's actual constraints is
    // still rejected (the schema's own keywords are enforced) ...
    const invalidResponse = await server.instance.inject({
      method: 'POST',
      url: `/validate-json/${typeId}`,
      payload: { notCustomerName: 'whatever' },
    });
    expect(invalidResponse.statusCode).toBe(200);
    const invalidBody = JSON.parse(invalidResponse.body);
    expect(invalidBody.ok).toBe(false);
    expect(invalidBody.error).toMatch(/must have required property 'customerName'/);

    await server.stop();
  });

  test('P6-2/P6-3: /validate-json/{gts_type} rejects an existing non-schema entity as a type (the former existence-only bypass)', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const instanceLikeTypeId = 'gts.acme.pkg.ns.plainobject.v1~';

    // Registered via plain /entities (not /type-schemas) with no $schema
    // keyword - `GtsExtractor.isJsonSchema` classifies this as a non-schema,
    // and nothing here overrides that classification.
    const registerResponse = await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: { $id: instanceLikeTypeId, note: 'not a schema at all', amount: 42 },
    });
    expect(registerResponse.statusCode).toBe(200);
    expect(JSON.parse(registerResponse.body).is_type_schema).toBe(false);

    const response = await server.instance.inject({
      method: 'POST',
      url: `/validate-json/${instanceLikeTypeId}`,
      payload: { totallyUnrelatedField: 'whatever' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/is not a GTS Type Schema/);

    await server.stop();
  });

  test('P6-3: a $schema-less /type-schemas-registered type can be used as a chain parent in a derived transient schema via /validate-json', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const parentId = 'gts.acme.pkg.ns.p6p3parent.v1~';
    const childId = `${parentId}acme.pkg.ns.p6p3child.v1~`;

    const registerResponse = await server.instance.inject({
      method: 'POST',
      url: '/type-schemas',
      payload: {
        type_id: parentId,
        type_schema: { properties: { base: { type: 'string' } }, required: ['base'] },
      },
    });
    expect(registerResponse.statusCode).toBe(200);
    expect(JSON.parse(registerResponse.body).is_type_schema).toBe(true);

    // Before the fix, `validateTransientSchema`'s own parent-entity check
    // (`parentEntity.isSchema`) rejected this parent with "Parent entity is
    // not a schema" - contradicting the explicit-route accommodation for
    // the exact same kind of entity.
    const response = await server.instance.inject({
      method: 'POST',
      url: '/validate-json',
      payload: {
        $schema: DRAFT7,
        $id: childId,
        allOf: [{ $ref: `gts://${parentId}` }],
        properties: { base: { type: 'string' }, child: { type: 'string' } },
        required: ['base', 'child'],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(body.is_type_schema).toBe(true);
    expect(body.error).toBeNull();

    await server.stop();
  });

  test('P6-4: /validate-instance and /validate-json report the identical failure with identical wording', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const typeId = 'gts.acme.pkg.ns.p6four.v1~';
    const instanceId = `${typeId}acme.pkg.ns.p6four_item.v1`;

    await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: {
        $id: typeId,
        $schema: DRAFT7,
        type: 'object',
        properties: { name: { type: 'string' } },
      },
    });
    await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: { id: instanceId, type: typeId, name: 1 },
    });

    const viResponse = await server.instance.inject({
      method: 'POST',
      url: '/validate-instance',
      payload: { instance_id: instanceId },
    });
    const viBody = JSON.parse(viResponse.body);
    expect(viBody.ok).toBe(false);

    const vjResponse = await server.instance.inject({
      method: 'POST',
      url: `/validate-json/${typeId}`,
      payload: { name: 1 },
    });
    const vjBody = JSON.parse(vjResponse.body);
    expect(vjBody.ok).toBe(false);

    // Both endpoints must use the same Ajv-error-to-string convention.
    expect(viBody.error).toBe(vjBody.error);
    expect(viBody.error).toMatch(/is not of type 'string'/);

    await server.stop();
  });

  test('P6-5: an empty, malformed, or oversized JSON body on /validate-json* normalizes to 422 HTTPValidationError, not a raw FST_ERR_CTP_* envelope', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

    const empty = await server.instance.inject({
      method: 'POST',
      url: '/validate-json',
      payload: '',
      headers: { 'content-type': 'application/json' },
    });
    expect(empty.statusCode).toBe(422);
    expect(JSON.parse(empty.body)).toHaveProperty('detail');

    const malformed = await server.instance.inject({
      method: 'POST',
      url: '/validate-json',
      payload: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(malformed.statusCode).toBe(422);
    expect(JSON.parse(malformed.body)).toHaveProperty('detail');

    const big = await server.instance.inject({
      method: 'POST',
      url: '/validate-json',
      payload: JSON.stringify({ big: 'x'.repeat(6 * 1024 * 1024) }),
      headers: { 'content-type': 'application/json' },
    });
    expect(big.statusCode).toBe(422);
    expect(JSON.parse(big.body)).toHaveProperty('detail');

    // Scoping check: another route's malformed-body shape must be untouched.
    const otherRoute = await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(otherRoute.statusCode).toBe(400);
    expect(JSON.parse(otherRoute.body).code).toBe('FST_ERR_CTP_INVALID_JSON_BODY');

    await server.stop();
  });

  test('P6-5: an unmatched sub-path under /validate-json* also returns the documented 422 shape, not a generic 404', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

    const response = await server.instance.inject({
      method: 'POST',
      url: '/validate-json/a/b',
      payload: { name: 'valid' },
    });
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body)).toHaveProperty('detail');

    // Scoping check: an unrelated unmatched route keeps the default 404 shape.
    const unrelated = await server.instance.inject({ method: 'GET', url: '/does-not-exist' });
    expect(unrelated.statusCode).toBe(404);
    expect(JSON.parse(unrelated.body)).toEqual({
      message: 'Route GET:/does-not-exist not found',
      error: 'Not Found',
      statusCode: 404,
    });

    await server.stop();
  });

  test('P6-6: a root-level validation failure reports "/ ..." rather than a leading-space, path-less message', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const typeId = 'gts.acme.pkg.ns.p6six.v1~';

    await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: {
        $id: typeId,
        $schema: DRAFT7,
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      },
    });

    const response = await server.instance.inject({
      method: 'POST',
      url: `/validate-json/${typeId}`,
      payload: { name: 'ok', extra: 'nope' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('/ must NOT have additional properties');

    await server.stop();
  });

  test('P6-7: multiple simultaneous validation failures are all reported, not only the first', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const typeId = 'gts.acme.pkg.ns.p6seven.v1~';

    await server.instance.inject({
      method: 'POST',
      url: '/entities',
      payload: {
        $id: typeId,
        $schema: DRAFT7,
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
      },
    });

    const response = await server.instance.inject({
      method: 'POST',
      url: `/validate-json/${typeId}`,
      payload: { a: 1, b: 'x' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/\/a is not of type 'string'/);
    expect(body.error).toMatch(/\/b is not of type 'number'/);

    await server.stop();
  });
});

describe('configurable entity update mode (mirrors gts-go --allow-entity-updates)', () => {
  // By default the registry protects its state: an identical re-submission is
  // idempotent, but changing the content of an already-registered id is a
  // conflict (HTTP 409). `--allow-entity-updates` opts into replacement.
  const schema = {
    $id: 'gts://gts.x.unit.srv.updmode.v1~',
    $schema: DRAFT7,
    type: 'object',
    properties: { name: { type: 'string' } },
  };
  const schemaChanged = {
    ...schema,
    properties: { name: { type: 'integer' } },
  };

  const postEntity = (server: GtsServer, payload: unknown) =>
    server.instance.inject({ method: 'POST', url: '/entities', payload: payload as any });

  test('an identical re-submission stays idempotent (200)', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

    expect((await postEntity(server, schema)).statusCode).toBe(200);
    expect((await postEntity(server, schema)).statusCode).toBe(200);

    await server.stop();
  });

  test('a changed re-submission is rejected with 409 and the original content is preserved', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });

    expect((await postEntity(server, schema)).statusCode).toBe(200);

    const conflict = await postEntity(server, schemaChanged);
    expect(conflict.statusCode).toBe(409);
    const conflictBody = JSON.parse(conflict.body);
    expect(conflictBody.ok).toBe(false);
    expect(conflictBody.error).toMatch(/already registered with different content/);

    // The previously-registered content must be untouched.
    const get = await server.instance.inject({
      method: 'GET',
      url: `/entities/${encodeURIComponent('gts.x.unit.srv.updmode.v1~')}`,
    });
    const stored = JSON.parse(get.body);
    expect(stored.content.properties.name.type).toBe('string');

    await server.stop();
  });

  test('--allow-entity-updates replaces the changed entity (200)', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0, allowEntityUpdates: true });

    expect((await postEntity(server, schema)).statusCode).toBe(200);
    expect((await postEntity(server, schemaChanged)).statusCode).toBe(200);

    const get = await server.instance.inject({
      method: 'GET',
      url: `/entities/${encodeURIComponent('gts.x.unit.srv.updmode.v1~')}`,
    });
    const stored = JSON.parse(get.body);
    expect(stored.content.properties.name.type).toBe('integer');

    await server.stop();
  });

  test('replacing a schema refreshes Ajv references used by dependent schemas', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0, allowEntityUpdates: true });
    const targetId = 'gts.x.unit.srv.updtarget.v1~';
    const hostId = 'gts.x.unit.srv.updhost.v1~';
    const instanceId = `${hostId}x.unit._.item.v1`;

    await postEntity(server, { $id: `gts://${targetId}`, $schema: DRAFT7, type: 'string' });
    await postEntity(server, {
      $id: `gts://${hostId}`,
      $schema: DRAFT7,
      type: 'object',
      required: ['value'],
      properties: { value: { $ref: `gts://${targetId}` } },
    });
    await postEntity(server, { $id: `gts://${targetId}`, $schema: DRAFT7, type: 'integer' });
    await postEntity(server, { id: instanceId, value: 42 });

    const response = await server.instance.inject({
      method: 'POST',
      url: '/validate-instance',
      payload: { instance_id: instanceId },
    });
    expect(JSON.parse(response.body).ok).toBe(true);

    await server.stop();
  });

  test('POST /type-schemas is likewise conflict-protected', async () => {
    const server = new GtsServer({ host: '127.0.0.1', port: 0, verbose: 0 });
    const typeId = 'gts.x.unit.srv.updschema.v1~';

    const first = await server.instance.inject({
      method: 'POST',
      url: '/type-schemas',
      payload: { type_id: typeId, type_schema: { $schema: DRAFT7, type: 'object' } },
    });
    expect(first.statusCode).toBe(200);

    const changed = await server.instance.inject({
      method: 'POST',
      url: '/type-schemas',
      payload: { type_id: typeId, type_schema: { $schema: DRAFT7, type: 'string' } },
    });
    expect(changed.statusCode).toBe(409);

    await server.stop();
  });
});
