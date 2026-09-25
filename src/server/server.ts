import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { GTS, createJsonEntity, EntityConflictError, EntityContentDepthError, GtsRefValidationMode } from '../index';
import { XGtsRefValidator } from '../x-gts-ref';
import {
  ServerConfig,
  EntityResponse,
  OperationResult,
  ListResult,
  ValidateIDParams,
  MatchPatternParams,
  ValidateInstanceBody,
  ResolveRelationshipsParams,
  CompatibilityParams,
  CastBody,
  QueryParams,
  ValidateTypeSchemaBody,
  ValidateEntityBody,
  ValidateJsonResult,
} from './types';
import * as gts from '../index';
import { PACKAGE_VERSION } from '../version';

function parseGtsRefValidationMode(value: unknown): GtsRefValidationMode | null {
  if (value === undefined) return GtsRefValidationMode.AnyValid;
  const modes = Object.values(GtsRefValidationMode) as unknown[];
  return modes.includes(value) ? (value as GtsRefValidationMode) : null;
}

export class GtsServer {
  private fastify: FastifyInstance;
  private store: GTS;
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
    this.store = new GTS({ validateRefs: false, allowEntityUpdates: config.allowEntityUpdates ?? false });

    this.fastify = Fastify({
      logger:
        config.verbose > 0
          ? {
              level: config.verbose >= 2 ? 'debug' : 'info',
            }
          : false,
      // find-my-way (Fastify's router) defaults `maxParamLength` to 100,
      // which caps every `:param` route segment - including `:gts_type` on
      // `POST /validate-json/:gts_type`. GTS chained identifiers have no
      // length cap in the grammar (src/gts.ts), so a realistic multi-segment
      // chained id (well over 100 chars) would 404 at the router before ever
      // reaching the handler, outside the documented 200/422 contract
      // (P6-1). 2048 comfortably covers deep chains while still bounding
      // pathological input. Set via `routerOptions` (not the deprecated
      // top-level `maxParamLength`) per Fastify 5's router-options move.
      routerOptions: {
        maxParamLength: 2048,
      },
      forceCloseConnections: true,
    });

    this.setupMiddleware();
    this.registerRoutes();
  }

  /**
   * The underlying Fastify instance, exposed read-only so tests can exercise
   * routes via `.inject()` without opening a real network listener.
   */
  public get instance(): FastifyInstance {
    return this.fastify;
  }

  private setupMiddleware(): void {
    // Enable CORS manually
    this.fastify.addHook('onRequest', async (_request, reply) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      // The conformance client leaves one keep-alive socket idle per case, so
      // close responses explicitly to stay below the default macOS fd limit.
      // This intentionally favors bounded descriptors over connection reuse.
      reply.header('Connection', 'close');
    });

    // Handle OPTIONS requests
    this.fastify.options('*', async (_request, reply) => {
      reply.status(204).send();
    });

    // P6-5: `guardJsonBody` is a `preHandler`, so it only ever runs after
    // Fastify's own JSON body parser has already succeeded - an empty body,
    // malformed JSON, or an oversized body never reaches it at all, and
    // instead surfaces Fastify's own `FST_ERR_CTP_*` envelope
    // (`{statusCode, code, error, message}`) at 400/413, never the
    // documented `422 HTTPValidationError` shape (`.gts-spec/tests/
    // openapi.json` declares only 200/422 for `/validate-json` and
    // `/validate-json/{gts_type}`). Normalize those cases here, scoped to
    // just the `/validate-json*` routes so no other route's error shape
    // changes.
    this.fastify.setErrorHandler((error, request, reply) => {
      const code = (error as { code?: string }).code;
      const isBodyParsingError = typeof code === 'string' && code.startsWith('FST_ERR_CTP_');
      if (isBodyParsingError && request.url.startsWith('/validate-json')) {
        reply.code(422).send({
          detail: [
            {
              loc: ['body'],
              msg: 'Request body must be a JSON object',
              type: 'type_error.object',
            },
          ],
        });
        return;
      }
      reply.send(error);
    });

    // P6-5 (trailing-slash case): `/validate-json` and
    // `/validate-json/{gts_type}` are the only routes registered under this
    // prefix, so any other path under it (a trailing slash, an extra
    // segment, etc.) is still a request "to" this route family per the
    // spec's contract (200/422 only, no 404) - not a generic unmatched
    // route. Scoped to the `/validate-json` prefix; every other unmatched
    // route keeps Fastify's default 404 shape below.
    this.fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/validate-json')) {
        reply.code(422).send({
          detail: [
            {
              loc: ['body'],
              msg: 'Request body must be a JSON object',
              type: 'type_error.object',
            },
          ],
        });
        return;
      }
      reply.code(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: 'Not Found',
        statusCode: 404,
      });
    });
  }

  private registerRoutes(): void {
    // Health check
    this.fastify.get('/health', async () => ({
      status: 'ok',
      timestamp: new Date().toISOString(),
    }));

    // Entity management
    this.fastify.get('/entities', this.handleGetEntities.bind(this));
    this.fastify.get('/entities/:id', this.handleGetEntity.bind(this));
    this.fastify.post('/entities', this.handleAddEntity.bind(this));
    this.fastify.post('/entities/bulk', this.handleAddEntities.bind(this));
    this.fastify.post('/type-schemas', this.handleAddTypeSchemas.bind(this));

    // OP#1 - Validate ID
    this.fastify.get('/validate-id', this.handleValidateID.bind(this));

    // OP#2 - Extract ID
    this.fastify.post('/extract-id', this.handleExtractID.bind(this));

    // OP#3 - Parse ID
    this.fastify.get('/parse-id', this.handleParseID.bind(this));

    // OP#4 - Match ID Pattern
    this.fastify.get('/match-id-pattern', this.handleMatchIDPattern.bind(this));

    // OP#5 - UUID
    this.fastify.get('/uuid', this.handleUUID.bind(this));

    // OP#6 - Validate Instance
    this.fastify.post('/validate-instance', this.handleValidateInstance.bind(this));

    // OP#7 - Resolve Relationships
    this.fastify.get('/resolve-relationships', this.handleResolveRelationships.bind(this));

    // OP#8 - Compatibility
    this.fastify.get('/compatibility', this.handleCompatibility.bind(this));

    // OP#9 - Cast
    this.fastify.post('/cast', this.handleCast.bind(this));

    // OP#10 - Query
    this.fastify.get('/query', this.handleQuery.bind(this));

    // OP#11 - Attribute Access
    this.fastify.get('/attr', this.handleAttribute.bind(this));

    // OP#12 - Validate Type Schema
    this.fastify.post('/validate-type-schema', this.handleValidateTypeSchema.bind(this));

    // OP#12 - Validate Entity (unified)
    this.fastify.post('/validate-entity', this.handleValidateEntity.bind(this));

    // OP#6 - Validate JSON (transient, spec commit ab1287e): auto-detected
    // schema-vs-instance and explicit-type variants. Neither route may
    // register anything, so both share the same non-object-body guard
    // (route-level `preHandler`, not handler logic) rather than the
    // register-then-validate path `POST /entities` uses.
    this.fastify.post<{ Body: Record<string, unknown> }>(
      '/validate-json',
      { preHandler: this.guardJsonBody.bind(this) },
      this.handleValidateJson.bind(this)
    );
    this.fastify.post<{ Params: { gts_type: string }; Body: Record<string, unknown> }>(
      '/validate-json/:gts_type',
      { preHandler: this.guardJsonBody.bind(this) },
      this.handleValidateJsonExplicit.bind(this)
    );

    // OpenAPI spec
    this.fastify.get('/openapi', this.handleOpenAPI.bind(this));
  }

  // Entity Management Handlers
  private async handleGetEntities(
    request: FastifyRequest<{ Querystring: { limit?: string } }>,
    _reply: FastifyReply
  ): Promise<ListResult> {
    let limit = parseInt(request.query.limit || '100', 10);
    if (limit < 1) limit = 1;
    if (limit > 1000) limit = 1000;

    const items = this.store['store']
      .getAll()
      .slice(0, limit)
      .map((e) => e.id);

    return {
      count: items.length,
      items,
    };
  }

  private async handleGetEntity(
    request: FastifyRequest<{ Params: { id: string } }>,
    _reply: FastifyReply
  ): Promise<EntityResponse> {
    const entity = this.store.get(request.params.id);

    // .gts-spec/tests/openapi.json declares only 200 and 422 for
    // `GET /entities/{gts_id}` (no 404), and the canonical `_assert_not_stored`
    // helper (.gts-spec/tests/test_op6_schema_validation.py:2333, used by 8 of
    // the 18 OP#6 `/validate-json` conformance cases) asserts `status_code ==
    // 200` and `body.ok == false` for a missing id. A 404 here would make
    // every one of those cases unpassable, so a missing entity is reported
    // as a 200 with `ok: false` rather than an HTTP-level 404.
    if (!entity) {
      return {
        id: request.params.id,
        ok: false,
        content: null,
        error: `Entity not found: ${request.params.id}`,
      };
    }

    return {
      id: request.params.id,
      ok: true,
      content: entity,
    };
  }

  private async handleAddEntity(
    request: FastifyRequest<{
      Body: any;
      Querystring: { validate?: string; validation?: string; 'gts-ref-validation'?: string };
    }>,
    reply: FastifyReply
  ): Promise<OperationResult> {
    try {
      const content = request.body;
      const validate = request.query.validate === 'true' || request.query.validation === 'true';
      const refValidation = parseGtsRefValidationMode(request.query['gts-ref-validation']);
      if (refValidation === null) {
        reply.code(422);
        return { ok: false, error: 'gts-ref-validation must be one of: none, any-present, any-valid' };
      }
      const entity = createJsonEntity(content);

      // §9.11.1 - a malformed modifier declaration is always rejected: the
      // document cannot be interpreted, so there is nothing to register.
      // The guards beyond that are gated on `validate` per §9.11.5.
      const ruleError = entity.isSchema
        ? this.store.checkTypeSchemaRules(content, entity.id, { enforceGuards: validate })
        : validate
          ? this.store.checkInstanceRules(entity.schemaId)
          : null;
      if (ruleError) {
        reply.code(422);
        return { ok: false, is_type_schema: entity.isSchema, error: ruleError };
      }

      if (validate && entity.isSchema) {
        const validationError = this.validateSchemaStrict(content);
        if (validationError) {
          reply.code(422);
          return {
            ok: false,
            is_type_schema: true,
            error: validationError,
          };
        }
      }

      // Strict validation for instances when validate=true
      if (validate && !entity.isSchema) {
        // Check if entity has recognizable GTS fields
        if (!entity.id || !gts.isValidGtsID(entity.id)) {
          // Check if there's a valid type field
          const hasValidType = entity.schemaId && gts.isValidGtsID(entity.schemaId);
          if (!hasValidType) {
            reply.code(422);
            // No id-shaped field was detected at all - distinct from an id
            // that was present but malformed/untyped.
            if (!entity.id) {
              return {
                ok: false,
                is_type_schema: false,
                error: 'Unable to detect GTS ID in instance entity',
              };
            }
            return {
              ok: false,
              is_type_schema: false,
              error: 'Instance must have a valid GTS ID or type field',
            };
          }
        }
      }

      if (!entity.id) {
        // No id-shaped field was detected at all (as opposed to one that was
        // present but malformed, which `store.register()` rejects later with
        // "Invalid GTS entity id").
        reply.code(422);
        return {
          ok: false,
          is_type_schema: entity.isSchema,
          error: entity.isSchema ? 'Unable to detect GTS ID in schema' : 'Unable to detect GTS ID in instance entity',
        };
      }

      // Validate schema with x-gts-ref if it's a schema
      // x-gts-ref validation always returns 422 on failure (not just when validate=true)
      if (entity.isSchema) {
        const xGtsRefValidator = new XGtsRefValidator(this.store.asEntityLookup());
        const xGtsRefErrors = xGtsRefValidator.validateSchema(content);
        if (xGtsRefErrors.length > 0) {
          const errorMsgs = xGtsRefErrors.map((err) => `${err.fieldPath}: ${err.reason}`).join('; ');
          reply.code(422);
          return {
            ok: false,
            is_type_schema: true,
            error: `x-gts-ref validation failed: ${errorMsgs}`,
          };
        }
      }

      // Validate instance if requested
      if (validate && !entity.isSchema) {
        // A valid GTS instance id does not guarantee a resolvable type: a
        // base-type-shaped id (e.g. `gts.a.b.c.type.v1~`) used as an instance
        // is a valid GTS id yet carries no chained type, and no explicit type
        // field was found either. `schemaId` is `string | null`, so assert
        // nothing here - reject with a clear error instead of passing `null`
        // down to surface as the opaque "GTS Type Schema not found: null".
        if (!entity.schemaId) {
          reply.code(422);
          return {
            ok: false,
            is_type_schema: false,
            error: `Unable to determine GTS Type for instance '${entity.id}'`,
          };
        }
        const result = this.store.validateTransientInstance(content, entity.schemaId, entity.id, refValidation);
        if (!result.ok) {
          reply.code(422);
          return {
            ok: false,
            is_type_schema: false,
            error: result.error,
          };
        }
      }

      // Register the entity
      const previous = this.store.register(content);

      // A derived schema (chained `$id`) must be compatible with its GTS
      // chain parent - e.g. it cannot drop a `required` field the parent
      // declares. A literal `$$ref`/`$$id`/`$$schema` establishes no
      // inheritance at all (they are not JSON Schema keywords), so a schema
      // that relies on one for derivation must restate the parent's
      // constraints itself or be rejected here.
      if (validate && entity.isSchema) {
        // `validateSchemaAgainstParent` looks the entity up by id (via
        // `store.get`), so it can only run post-registration - unlike
        // `validateSchemaStrict` and the x-gts-ref checks above. If it
        // rejects, roll back the `store.register()` above (both the `byId`
        // index and the Ajv schema entry) so a 422 response restores any
        // previous entity rather than deleting or replacing it.
        const parentResult = this.store.validateSchemaAgainstParent(entity.id, refValidation);
        if (!parentResult.ok) {
          this.store.rollbackRegistration(entity.id, previous);
          reply.code(422);
          return {
            ok: false,
            is_type_schema: true,
            error: `Derived schema is not compatible with base: ${parentResult.error}`,
          };
        }
      }

      return {
        ok: true,
        id: entity.id,
        is_type_schema: entity.isSchema,
        type_id: entity.schemaId,
      };
    } catch (error) {
      // A changed re-registration is a conflict, while content too deeply
      // nested to compare safely is an unprocessable entity. Other errors keep
      // the default status.
      if (error instanceof EntityConflictError) {
        reply.code(409);
      } else if (error instanceof EntityContentDepthError) {
        reply.code(422);
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private validateSchemaStrict(content: any): string | null {
    // Check for $id
    const schemaId = content['$id'];
    if (!schemaId) {
      return 'Unable to detect GTS ID in schema';
    }

    // Normalize the ID
    let normalizedId = schemaId;
    if (typeof normalizedId === 'string') {
      // Check if it starts with gts:// prefix
      if (normalizedId.startsWith('gts://')) {
        normalizedId = normalizedId.substring(6);
      } else if (normalizedId.startsWith('gts.')) {
        // Plain gts. prefix without gts:// is not allowed for JSON Schema $id
        return 'Schema $id with GTS identifier must use gts:// URI format (e.g., gts://gts.vendor.pkg.ns.type.v1~)';
      } else {
        // Non-GTS $id is not allowed
        return 'Schema $id must be a valid GTS identifier with gts:// URI format';
      }

      // Check for wildcards in schema ID
      if (normalizedId.includes('*')) {
        return 'Schema $id cannot contain wildcards';
      }

      // Validate the GTS ID
      if (!gts.isValidGtsID(normalizedId)) {
        return `Schema $id is not a valid GTS identifier: ${normalizedId}`;
      }
    }

    // Validate $ref fields
    const refErrors = this.validateSchemaRefs(content, '');
    if (refErrors.length > 0) {
      return refErrors[0];
    }

    return null;
  }

  private validateSchemaRefs(obj: any, path: string): string[] {
    const errors: string[] = [];

    if (!obj || typeof obj !== 'object') {
      return errors;
    }

    // Check $ref
    const ref = obj['$ref'];
    if (typeof ref === 'string') {
      const refPath = path ? `${path}/$ref` : '$ref';

      // Local refs (#/...) are allowed
      if (ref.startsWith('#')) {
        // OK - local ref
      } else if (ref.startsWith('gts://')) {
        // gts:// URI is allowed - validate the GTS ID
        const normalizedRef = ref.substring(6);

        // Check for wildcards
        if (normalizedRef.includes('*')) {
          errors.push(`Invalid $ref at ${refPath}: wildcards are not allowed in $ref`);
        } else if (!gts.isValidGtsID(normalizedRef)) {
          errors.push(`Invalid $ref at ${refPath}: ${normalizedRef} is not a valid GTS identifier`);
        }
      } else if (ref.startsWith('gts.')) {
        // Plain gts. prefix without gts:// is not allowed
        errors.push(`Invalid $ref at ${refPath}: GTS references must use gts:// URI format`);
      } else if (ref.startsWith('http://') || ref.startsWith('https://')) {
        // External HTTP refs are not allowed (except json-schema.org for $schema)
        if (!ref.includes('json-schema.org')) {
          errors.push(`Invalid $ref at ${refPath}: external HTTP references are not allowed`);
        }
      }
    }

    // Recurse into nested objects
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$ref') continue;
      if (value && typeof value === 'object') {
        const nestedPath = path ? `${path}/${key}` : key;
        if (Array.isArray(value)) {
          value.forEach((item, idx) => {
            if (item && typeof item === 'object') {
              errors.push(...this.validateSchemaRefs(item, `${nestedPath}[${idx}]`));
            }
          });
        } else {
          errors.push(...this.validateSchemaRefs(value, nestedPath));
        }
      }
    }

    return errors;
  }

  private async handleAddEntities(
    request: FastifyRequest<{ Body: any[] }>,
    _reply: FastifyReply
  ): Promise<OperationResult> {
    try {
      const entities = request.body;

      if (!Array.isArray(entities)) {
        return {
          ok: false,
          error: 'Request body must be an array of entities',
        };
      }

      const registered: string[] = [];
      const errors: string[] = [];

      for (const content of entities) {
        try {
          const entity = createJsonEntity(content);

          // The bulk endpoint has no `validate` switch, so it applies the same
          // always-on rules as POST /entities and none of the gated guards.
          const declarationError = entity.isSchema
            ? this.store.checkTypeSchemaRules(content, entity.id, { enforceGuards: false })
            : null;
          if (declarationError) {
            errors.push(declarationError);
            continue;
          }

          if (entity.id) {
            this.store.register(content);
            registered.push(entity.id);
          } else {
            errors.push('Unable to extract GTS ID from entity');
          }
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      return {
        ok: errors.length === 0,
        registered,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Register a batch of GTS Type Schemas. The request body is a JSON array of
  // GTS Type Schema objects; each entry's GTS Type Identifier is derived from
  // its embedded $id (there is no external type_id field). The response is an
  // aggregate { ok, results: [...] } body where the top-level ok is true only
  // when every entry registered successfully.
  private async handleAddTypeSchemas(
    request: FastifyRequest<{ Body: any }>,
    reply: FastifyReply
  ): Promise<OperationResult> {
    const schemas = request.body;
    if (!Array.isArray(schemas)) {
      reply.code(422);
      return { ok: false, error: 'Request body must be a JSON array of GTS Type Schemas' };
    }

    const results: Array<{ ok: boolean; type_id: string | null; error?: string }> = [];
    for (const schema of schemas) {
      results.push(await this.registerTypeSchema(schema, request));
    }

    return {
      ok: results.every((r) => r.ok),
      results,
    };
  }

  // Registers a single GTS Type Schema, deriving its GTS Type Identifier from
  // the embedded $id, and returns a per-item result.
  private async registerTypeSchema(
    schema: any,
    request: FastifyRequest<{ Body: any }>
  ): Promise<{ ok: boolean; type_id: string | null; error?: string }> {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return { ok: false, type_id: null, error: 'GTS Type Schema entry must be a JSON object' };
    }

    if (typeof schema['$schema'] !== 'string' || schema['$schema'].length === 0) {
      return { ok: false, type_id: null, error: 'GTS Type Schema must contain a top-level $schema field' };
    }

    const embeddedId = schema['$id'];
    if (typeof embeddedId !== 'string' || !embeddedId.startsWith('gts://')) {
      return { ok: false, type_id: null, error: 'GTS Type Schema must contain a top-level $id in gts:// form' };
    }

    const typeId = embeddedId.slice('gts://'.length);
    if (!gts.isValidGtsID(typeId) || !typeId.endsWith('~')) {
      return { ok: false, type_id: typeId, error: `Invalid GTS Type Schema $id: '${embeddedId}'` };
    }

    // Reuse the single-entity registration path (x-gts-ref checks, modifier
    // rules, store.register) via a throwaway reply that swallows status codes;
    // per-entry outcomes are surfaced through the aggregate `results` instead.
    const fakeReply = { code: () => fakeReply } as unknown as FastifyReply;
    const result = await this.handleAddEntity({ ...request, body: { ...schema }, query: {} } as any, fakeReply);
    if (result.ok) {
      return { ok: true, type_id: typeId };
    }
    return { ok: false, type_id: typeId, error: result.error };
  }

  // OP#1 - Validate ID
  private async handleValidateID(
    request: FastifyRequest<{ Querystring: ValidateIDParams }>,
    reply: FastifyReply
  ): Promise<any> {
    // Support both 'gts_id' (test spec) and 'id' (fallback)
    const id = request.query.gts_id || request.query.id;

    if (!id) {
      reply.code(400);
      throw new Error('Missing required parameter: gts_id or id');
    }

    return gts.validateGtsID(id);
  }

  // OP#2 - Extract ID
  private async handleExtractID(request: FastifyRequest<{ Body: any }>, _reply: FastifyReply): Promise<any> {
    // The body itself is the content
    return gts.extractID(request.body);
  }

  // OP#3 - Parse ID
  private async handleParseID(
    request: FastifyRequest<{ Querystring: { gts_id?: string; id?: string } }>,
    reply: FastifyReply
  ): Promise<any> {
    const id = request.query.gts_id || request.query.id;

    if (!id) {
      reply.code(400);
      throw new Error('Missing required parameter: gts_id or id');
    }

    const result = gts.parseGtsID(id);
    const isWildcard = id.includes('*');

    // Convert segments to match test format (snake_case)
    const segments =
      result.segments?.map((seg) => ({
        vendor: seg.vendor,
        package: seg.package,
        namespace: seg.namespace,
        type: seg.type,
        ver_major: seg.verMajor ?? null,
        ver_minor: seg.verMinor ?? null,
        is_type: seg.isType,
      })) || [];

    // is_type_schema: true if ends with ~ and not a wildcard ending with ~*
    const isTypeSchema = id.endsWith('~') && !isWildcard;

    // is_type: whether the identifier names a GTS Type rather than an instance,
    // taken from the rightmost segment (a UUID tail or a well-known instance
    // segment makes it an instance).
    const lastSegment = result.segments?.[result.segments.length - 1];
    const isType = lastSegment ? lastSegment.isType : isTypeSchema;

    return {
      id,
      ok: result.ok,
      segments,
      error: result.error || '',
      is_type: isType,
      is_type_schema: isTypeSchema,
      is_wildcard: isWildcard,
    };
  }

  // OP#4 - Match ID Pattern
  private async handleMatchIDPattern(
    request: FastifyRequest<{ Querystring: MatchPatternParams }>,
    reply: FastifyReply
  ): Promise<any> {
    const { pattern, candidate } = request.query;

    if (!pattern || !candidate) {
      reply.code(400);
      throw new Error('Missing required parameters: pattern, candidate');
    }

    return gts.matchIDPattern(candidate, pattern);
  }

  // OP#5 - UUID
  private async handleUUID(
    request: FastifyRequest<{ Querystring: { gts_id?: string; id?: string } }>,
    reply: FastifyReply
  ): Promise<any> {
    const id = request.query.gts_id || request.query.id;

    if (!id) {
      reply.code(400);
      throw new Error('Missing required parameter: gts_id or id');
    }

    return gts.idToUUID(id);
  }

  // OP#6 - Validate Instance
  private async handleValidateInstance(
    request: FastifyRequest<{ Body: ValidateInstanceBody; Querystring: { 'gts-ref-validation'?: string } }>,
    reply: FastifyReply
  ): Promise<any> {
    const { instance_id } = request.body;
    const refValidation = parseGtsRefValidationMode(request.query['gts-ref-validation']);

    if (refValidation === null) {
      reply.code(422);
      return { ok: false, error: 'gts-ref-validation must be one of: none, any-present, any-valid' };
    }
    if (!instance_id) {
      reply.code(400);
      throw new Error('Missing required field: instance_id');
    }

    return this.store.validateInstance(instance_id, refValidation);
  }

  // OP#7 - Resolve Relationships
  private async handleResolveRelationships(
    request: FastifyRequest<{ Querystring: ResolveRelationshipsParams }>,
    reply: FastifyReply
  ): Promise<any> {
    const { gts_id } = request.query;

    if (!gts_id) {
      reply.code(400);
      throw new Error('Missing required parameter: gts_id');
    }

    return this.store.resolveRelationships(gts_id);
  }

  // OP#8 - Compatibility
  private async handleCompatibility(
    request: FastifyRequest<{ Querystring: CompatibilityParams }>,
    reply: FastifyReply
  ): Promise<any> {
    const { old_type_id, new_type_id, mode = 'full' } = request.query;

    if (!old_type_id || !new_type_id) {
      reply.code(400);
      throw new Error('Missing required parameters: old_type_id, new_type_id');
    }

    return this.store.checkCompatibility(old_type_id, new_type_id, mode);
  }

  // OP#9 - Cast
  private async handleCast(request: FastifyRequest<{ Body: CastBody }>, reply: FastifyReply): Promise<any> {
    const { instance_id, to_type_id } = request.body;

    if (!instance_id || !to_type_id) {
      reply.code(400);
      throw new Error('Missing required fields: instance_id, to_type_id');
    }

    // Call the store's castInstance directly to get the correct response format
    return this.store.castInstanceRaw(instance_id, to_type_id);
  }

  // OP#10 - Query
  private async handleQuery(request: FastifyRequest<{ Querystring: QueryParams }>, reply: FastifyReply): Promise<any> {
    const { expr, limit } = request.query;

    if (!expr) {
      reply.code(400);
      throw new Error('Missing required parameter: expr');
    }

    const queryLimit = limit !== undefined ? Number(limit) : 100;
    const result = this.store.query(expr, queryLimit);

    // Tests expect 'results' not 'items', 'error' field first if present, and 'limit' field always
    const response: any = {};

    if (result.error) {
      response.error = result.error;
    } else {
      response.error = '';
    }

    response.count = result.count;
    response.limit = queryLimit;
    response.results = result.items;

    return response;
  }

  // OP#11 - Attribute Access
  private async handleAttribute(
    request: FastifyRequest<{ Querystring: { gts_with_path?: string; gts_id?: string; path?: string } }>,
    reply: FastifyReply
  ): Promise<any> {
    // Handle both formats: gts_with_path or separate gts_id + path
    let gtsId: string;
    let path: string;

    if (request.query.gts_with_path) {
      // Split on @ symbol to extract gts_id and path
      const parts = request.query.gts_with_path.split('@');
      if (parts.length !== 2) {
        // If no @ symbol, treat the whole thing as gts_id with empty path
        // This will result in resolved=false
        gtsId = request.query.gts_with_path;
        path = '';
      } else {
        gtsId = parts[0];
        path = parts[1];
      }
    } else if (request.query.gts_id && request.query.path) {
      gtsId = request.query.gts_id;
      path = request.query.path;
    } else {
      reply.code(400);
      throw new Error('Missing required parameters: gts_with_path or (gts_id, path)');
    }

    return this.store.getAttributeAt(gtsId, path);
  }

  // OP#12 - Validate Type Schema
  private async handleValidateTypeSchema(
    request: FastifyRequest<{ Body: ValidateTypeSchemaBody; Querystring: { 'gts-ref-validation'?: string } }>,
    reply: FastifyReply
  ): Promise<any> {
    const { type_id } = request.body;
    const refValidation = parseGtsRefValidationMode(request.query['gts-ref-validation']);
    if (refValidation === null) {
      reply.code(422);
      return { ok: false, error: 'gts-ref-validation must be one of: none, any-present, any-valid' };
    }
    if (!type_id) {
      return { ok: false, error: 'Missing required field: type_id' };
    }
    const parentResult = this.store.validateSchemaAgainstParent(type_id, refValidation);
    if (!parentResult.ok) {
      return {
        ...parentResult,
        error: `Derived schema is not compatible with base: ${parentResult.error}`,
      };
    }
    return parentResult;
  }

  // OP#12 - Validate Entity (unified)
  private async handleValidateEntity(
    request: FastifyRequest<{ Body: ValidateEntityBody; Querystring: { 'gts-ref-validation'?: string } }>,
    reply: FastifyReply
  ): Promise<any> {
    const id = request.body.entity_id || request.body.gts_id;
    const refValidation = parseGtsRefValidationMode(request.query['gts-ref-validation']);
    if (refValidation === null) {
      reply.code(422);
      return { ok: false, error: 'gts-ref-validation must be one of: none, any-present, any-valid' };
    }
    if (!id) {
      return { ok: false, error: 'Missing required field: entity_id or gts_id' };
    }

    return this.store.validateEntity(id, refValidation);
  }

  // OP#6 - Validate JSON: route-level body-shape guard shared by both
  // `/validate-json` and `/validate-json/{gts_type}`. `ValidateJsonResult`'s
  // `ok:false` shape only makes sense for an object body it could classify
  // (schema vs. instance); a non-object body (e.g. a JSON array) is a
  // contract violation of the request itself, reported as `422` with an
  // `HTTPValidationError`-shaped body per `.gts-spec/tests/openapi.json`,
  // not as a `200` with `ok:false`.
  private async guardJsonBody(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      reply.code(422).send({
        detail: [
          {
            loc: ['body'],
            msg: 'Request body must be a JSON object',
            type: 'type_error.object',
          },
        ],
      });
    }
  }

  // OP#6 - POST /validate-json: auto-detect whether the transient body is a
  // GTS Type Schema or an instance (reusing `GtsExtractor.extractID`'s own
  // `is_type_schema` classification, per Phase 4) and validate it without
  // registering anything (spec commit ab1287e).
  private async handleValidateJson(
    request: FastifyRequest<{ Body: Record<string, unknown> }>,
    _reply: FastifyReply
  ): Promise<ValidateJsonResult> {
    const content = request.body;
    const extracted = gts.extractID(content);
    const id = extracted.id || null;

    if (extracted.is_type_schema) {
      if (!id) {
        return {
          ok: false,
          id: null,
          type_id: extracted.type_id,
          is_type_schema: true,
          error: 'Unable to detect GTS ID in schema',
        };
      }
      const result = this.store.validateTransientSchema(content, id);
      return {
        ok: result.ok,
        id,
        type_id: extracted.type_id,
        is_type_schema: true,
        error: result.ok ? null : result.error,
      };
    }

    const typeId = extracted.type_id;
    if (!typeId) {
      return {
        ok: false,
        id,
        type_id: null,
        is_type_schema: false,
        error: 'Unable to determine instance type',
      };
    }

    const result = this.store.validateTransientInstance(content, typeId, id);
    return {
      ok: result.ok,
      id,
      type_id: typeId,
      is_type_schema: false,
      error: result.ok ? null : result.error,
    };
  }

  // OP#6 - POST /validate-json/{gts_type}: validate transient instance JSON
  // against an explicit, path-supplied GTS Type Identifier. This route has no
  // gts-rust counterpart at all (`gts-cli/src/json_validation.rs` is a CLI
  // folder scanner with no type parameter) - every error string and the
  // mismatch/schema-rejection rule below are designed from the canonical
  // case text (`.gts-spec/tests/test_op6_schema_validation.py:2547+`) rather
  // than ported from a reference implementation.
  private async handleValidateJsonExplicit(
    request: FastifyRequest<{ Params: { gts_type: string }; Body: Record<string, unknown> }>,
    _reply: FastifyReply
  ): Promise<ValidateJsonResult> {
    const pathType = decodeURIComponent(request.params.gts_type);
    const content = request.body;

    // A well-formed GTS Type Identifier MUST end with `~` (§2.1/§11.1 Rule
    // C.1, mirroring `registerTypeSchema` above). Unlike that handler,
    // the two ways a path segment can fail this are reported with distinct
    // messages here: a string that is not GTS-shaped at all ("not-a-gts-
    // type") versus one that is a syntactically ordinary GTS identifier but
    // names an instance, not a type (no trailing `~`) - the canonical suite
    // asserts different error text for each
    // (`TestCaseOp6ValidateJson_MalformedExplicitType` vs.
    // `_ExplicitNonSchemaType`).
    if (!pathType.endsWith('~')) {
      if (!pathType.startsWith('gts.')) {
        return {
          ok: false,
          id: null,
          type_id: null,
          is_type_schema: false,
          error: `Invalid GTS Type Schema ID: '${pathType}'`,
        };
      }
      return {
        ok: false,
        id: null,
        type_id: null,
        is_type_schema: false,
        error: `'${pathType}' must be GTS Type schema, not an instance identifier (missing trailing '~')`,
      };
    }
    if (!gts.isValidGtsID(pathType)) {
      return {
        ok: false,
        id: null,
        type_id: null,
        is_type_schema: false,
        error: `Invalid GTS Type Schema ID: '${pathType}'`,
      };
    }

    // Existence AND `isSchema` check (P6-2/P6-3). A GTS Type Schema registered
    // via `POST /type-schemas` carries a canonical embedded `$id`/`$schema`,
    // so it is classified as a schema at registration; this guards against a
    // junk document with zero schema keywords compiling here as a
    // constraint-free schema that would accept anything.
    const isRegisteredSchema = this.store.isRegisteredSchema(pathType);
    if (isRegisteredSchema === undefined) {
      return {
        ok: false,
        id: null,
        type_id: pathType,
        is_type_schema: false,
        error: `GTS Type Schema not found: ${pathType}`,
      };
    }
    if (!isRegisteredSchema) {
      return {
        ok: false,
        id: null,
        type_id: pathType,
        is_type_schema: false,
        error: `Entity '${pathType}' is not a GTS Type Schema`,
      };
    }

    const extracted = gts.extractID(content);
    const id = extracted.id || null;

    // This route only accepts instance JSON - a schema-shaped body (per the
    // same `is_type_schema` classification `/validate-json` uses) is
    // rejected outright, transiently (nothing is ever registered here).
    if (extracted.is_type_schema) {
      return {
        ok: false,
        id,
        type_id: pathType,
        is_type_schema: true,
        error: `POST /validate-json/{gts_type} only accepts instance JSON, not a Type Schema`,
      };
    }

    // A body that declares its own `type` (directly, or via a chained id)
    // must agree with the path type rather than silently overriding it.
    if (extracted.type_id && extracted.type_id !== pathType) {
      return {
        ok: false,
        id,
        type_id: pathType,
        is_type_schema: false,
        error: `Declared type '${extracted.type_id}' does not match path type '${pathType}'`,
      };
    }

    const result = this.store.validateTransientInstance(content, pathType, id);
    return {
      ok: result.ok,
      id,
      type_id: pathType,
      is_type_schema: false,
      error: result.ok ? null : result.error,
    };
  }

  // OpenAPI Specification
  private async handleOpenAPI(): Promise<any> {
    return {
      openapi: '3.0.0',
      info: {
        title: 'GTS Server',
        version: PACKAGE_VERSION,
        description: 'GTS (Global Type System) HTTP API',
      },
      servers: [
        {
          url: `http://${this.config.host}:${this.config.port}`,
          description: 'GTS Server',
        },
      ],
      paths: this.getOpenAPIPaths(),
      components: this.getOpenAPIComponents(),
    };
  }

  private getOpenAPIPaths(): any {
    return {
      '/health': {
        get: {
          summary: 'Check server liveness',
          operationId: 'health',
          responses: {
            200: {
              description: 'Server status',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string' },
                      timestamp: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/entities': {
        get: {
          summary: 'Get all entities in the registry',
          operationId: 'getEntities',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              description: 'Maximum number of entities to return',
              schema: { type: 'integer', default: 100, minimum: 1, maximum: 1000 },
            },
          ],
          responses: {
            200: {
              description: 'List of entity IDs',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      count: { type: 'integer' },
                      items: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          summary: 'Add a new entity',
          operationId: 'addEntity',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          responses: {
            200: {
              description: 'Operation result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OperationResult' },
                },
              },
            },
            409: {
              description: 'Entity conflict',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OperationResult' },
                },
              },
            },
          },
        },
      },
      '/entities/{id}': {
        get: {
          summary: 'Get a single entity by its GTS ID',
          operationId: 'getEntity',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'GTS ID of the entity',
              schema: { type: 'string' },
            },
          ],
          responses: {
            // .gts-spec/tests/openapi.json declares only 200/422 for this
            // operation (no 404) - a missing id is reported as 200 with
            // `ok: false` (see `GtsServer.handleGetEntity`).
            200: {
              description: 'The entity, or ok:false when the id is not registered',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      ok: { type: 'boolean' },
                      content: { type: 'object', nullable: true },
                      error: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/entities/bulk': {
        post: {
          summary: 'Add multiple entities in a single call',
          operationId: 'addEntities',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'array', items: { type: 'object' } },
              },
            },
          },
          responses: {
            200: {
              description: 'Bulk operation result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      registered: { type: 'array', items: { type: 'string' } },
                      errors: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['ok'],
                  },
                },
              },
            },
          },
        },
      },
      '/type-schemas': {
        post: {
          summary: 'Register a batch of GTS Type Schemas',
          operationId: 'addTypeSchemas',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { type: 'object' },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Aggregate batch registration result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OperationResult' },
                },
              },
            },
          },
        },
      },
      '/validate-id': {
        get: {
          summary: 'Validate a GTS ID',
          operationId: 'validateID',
          parameters: [
            {
              name: 'gts_id',
              in: 'query',
              required: true,
              description: 'GTS ID to validate',
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: {
              description: 'Validation result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ValidationResult' },
                },
              },
            },
          },
        },
      },
      '/extract-id': {
        post: {
          summary: 'Extract the GTS ID implied by an entity body',
          operationId: 'extractID',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          responses: {
            200: {
              description: 'Extraction result',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
      '/parse-id': {
        get: {
          summary: 'Parse a GTS ID into its component segments',
          operationId: 'parseID',
          parameters: [
            {
              name: 'gts_id',
              in: 'query',
              required: true,
              description: 'GTS ID to parse',
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: {
              description: 'Parsed segments',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      ok: { type: 'boolean' },
                      segments: { type: 'array', items: { type: 'object' } },
                      error: { type: 'string' },
                      is_type: { type: 'boolean' },
                      is_type_schema: { type: 'boolean' },
                      is_wildcard: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/match-id-pattern': {
        get: {
          summary: 'Check whether a candidate GTS ID matches a wildcard pattern',
          operationId: 'matchIDPattern',
          parameters: [
            {
              name: 'pattern',
              in: 'query',
              required: true,
              description: 'GTS ID pattern, possibly containing wildcards',
              schema: { type: 'string' },
            },
            {
              name: 'candidate',
              in: 'query',
              required: true,
              description: 'Candidate GTS ID to test against the pattern',
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: {
              description: 'Match result',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
      '/uuid': {
        get: {
          summary: 'Derive the deterministic UUID for a GTS ID',
          operationId: 'idToUUID',
          parameters: [
            {
              name: 'gts_id',
              in: 'query',
              required: true,
              description: 'GTS ID to derive the UUID from',
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: {
              description: 'UUID result',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
      '/validate-instance': {
        post: {
          summary: 'Validate a registered instance against its type schema',
          operationId: 'validateInstance',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { instance_id: { type: 'string' } },
                  required: ['instance_id'],
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Validation result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ValidationResult' },
                },
              },
            },
          },
        },
      },
      '/resolve-relationships': {
        get: {
          summary: 'Resolve the relationships declared by an entity',
          operationId: 'resolveRelationships',
          parameters: [
            {
              name: 'gts_id',
              in: 'query',
              required: true,
              description: 'GTS ID of the entity',
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: {
              description: 'Resolved relationships',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
      '/compatibility': {
        get: {
          summary: 'Check compatibility between two type schema versions',
          operationId: 'checkCompatibility',
          parameters: [
            {
              name: 'old_type_id',
              in: 'query',
              required: true,
              description: 'GTS Type ID of the earlier version',
              schema: { type: 'string' },
            },
            {
              name: 'new_type_id',
              in: 'query',
              required: true,
              description: 'GTS Type ID of the later version',
              schema: { type: 'string' },
            },
            {
              name: 'mode',
              in: 'query',
              description: 'Compatibility mode',
              schema: { type: 'string', default: 'full' },
            },
          ],
          responses: {
            200: {
              description: 'Compatibility result',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
      '/cast': {
        post: {
          summary: 'Cast a registered instance to another type',
          operationId: 'cast',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    instance_id: { type: 'string' },
                    to_type_id: { type: 'string' },
                  },
                  required: ['instance_id', 'to_type_id'],
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Cast result',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
      '/query': {
        get: {
          summary: 'Query entities using GTS query language',
          operationId: 'query',
          parameters: [
            {
              name: 'expr',
              in: 'query',
              required: true,
              description: 'Query expression',
              schema: { type: 'string' },
            },
            {
              name: 'limit',
              in: 'query',
              description: 'Maximum number of results',
              schema: { type: 'integer' },
            },
          ],
          responses: {
            200: {
              description: 'Query results',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/QueryResult' },
                },
              },
            },
          },
        },
      },
      '/attr': {
        get: {
          summary: 'Resolve an attribute path on an entity',
          operationId: 'getAttribute',
          parameters: [
            {
              name: 'gts_with_path',
              in: 'query',
              description: "Combined 'gts_id@path' reference",
              schema: { type: 'string' },
            },
            {
              name: 'gts_id',
              in: 'query',
              description: 'GTS ID of the entity (used together with `path`)',
              schema: { type: 'string' },
            },
            {
              name: 'path',
              in: 'query',
              description: 'Attribute path within the entity (used together with `gts_id`)',
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: {
              description: 'Attribute resolution result',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
      '/validate-type-schema': {
        post: {
          summary: "Validate a registered type schema against its parent's constraints",
          operationId: 'validateTypeSchema',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { type_id: { type: 'string' } },
                  required: ['type_id'],
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Validation result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ValidationResult' },
                },
              },
            },
          },
        },
      },
      '/validate-entity': {
        post: {
          summary: 'Validate a registered entity (schema or instance) uniformly',
          operationId: 'validateEntity',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    entity_id: { type: 'string' },
                    gts_id: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Validation result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ValidationResult' },
                },
              },
            },
          },
        },
      },
      '/validate-json': {
        post: {
          summary: 'Validate transient JSON as a GTS instance or Type Schema (auto-detected, nothing is registered)',
          operationId: 'validateJson',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          responses: {
            200: {
              description: 'Validation result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ValidateJsonResult' },
                },
              },
            },
            422: {
              description: 'Request body is not a JSON object',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HTTPValidationError' },
                },
              },
            },
          },
        },
      },
      '/validate-json/{gts_type}': {
        post: {
          summary: 'Validate transient JSON against an explicit GTS Type Schema (nothing is registered)',
          operationId: 'validateJsonAsType',
          parameters: [
            {
              name: 'gts_type',
              in: 'path',
              required: true,
              description: 'GTS Type Identifier to validate the body against',
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          responses: {
            200: {
              description: 'Validation result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ValidateJsonResult' },
                },
              },
            },
            422: {
              description: 'Request body is not a JSON object',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HTTPValidationError' },
                },
              },
            },
          },
        },
      },
      '/openapi': {
        get: {
          summary: 'Get the OpenAPI specification for this server',
          operationId: 'getOpenAPISpec',
          responses: {
            200: {
              description: 'OpenAPI 3.0 document',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
    };
  }

  private getOpenAPIComponents(): any {
    return {
      schemas: {
        OperationResult: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        ValidationResult: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            ok: { type: 'boolean' },
            valid: { type: 'boolean' },
            error: { type: 'string' },
          },
          required: ['id', 'ok'],
        },
        QueryResult: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            count: { type: 'integer' },
            items: { type: 'array', items: { type: 'string' } },
            error: { type: 'string' },
          },
          required: ['query', 'count', 'items'],
        },
        // Per .gts-spec/tests/openapi.json: all five fields are required and
        // id/type_id/error are nullable rather than merely optional.
        ValidateJsonResult: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string', nullable: true },
            type_id: { type: 'string', nullable: true },
            is_type_schema: { type: 'boolean' },
            error: { type: 'string', nullable: true },
          },
          required: ['ok', 'id', 'type_id', 'is_type_schema', 'error'],
        },
        ValidationError: {
          type: 'object',
          properties: {
            loc: { type: 'array', items: { type: 'string' } },
            msg: { type: 'string' },
            type: { type: 'string' },
          },
          required: ['loc', 'msg', 'type'],
        },
        HTTPValidationError: {
          type: 'object',
          properties: {
            detail: { type: 'array', items: { $ref: '#/components/schemas/ValidationError' } },
          },
        },
      },
    };
  }

  public async start(): Promise<void> {
    try {
      const address = await this.fastify.listen({
        port: this.config.port,
        host: this.config.host,
      });
      console.log(`GTS server listening on ${address}`);
    } catch (err) {
      console.error('Error starting server:', err);
      process.exit(1);
    }
  }

  public async stop(): Promise<void> {
    await this.fastify.close();
  }
}
