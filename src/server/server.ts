import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { GTS, createJsonEntity } from '../index';
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
} from './types';
import * as gts from '../index';

export class GtsServer {
  private fastify: FastifyInstance;
  private store: GTS;
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
    this.store = new GTS({ validateRefs: false });

    this.fastify = Fastify({
      logger:
        config.verbose > 0
          ? {
              level: config.verbose >= 2 ? 'debug' : 'info',
            }
          : false,
    });

    this.setupMiddleware();
    this.registerRoutes();
  }

  private setupMiddleware(): void {
    // Enable CORS manually
    this.fastify.addHook('onRequest', async (_request, reply) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    });

    // Handle OPTIONS requests
    this.fastify.options('*', async (_request, reply) => {
      reply.status(204).send();
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
    this.fastify.post('/schemas', this.handleAddSchema.bind(this));

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
    reply: FastifyReply
  ): Promise<EntityResponse> {
    const entity = this.store.get(request.params.id);

    if (!entity) {
      reply.code(404);
      throw new Error(`Entity not found: ${request.params.id}`);
    }

    return {
      id: request.params.id,
      content: entity,
    };
  }

  private async handleAddEntity(
    request: FastifyRequest<{
      Body: any;
      Querystring: { validate?: string; validation?: string };
    }>,
    reply: FastifyReply
  ): Promise<OperationResult> {
    try {
      const content = request.body;
      const validate = request.query.validate === 'true' || request.query.validation === 'true';
      const entity = createJsonEntity(content);

      // Strict validation for schemas when validate=true
      if (validate && entity.isSchema) {
        const validationError = this.validateSchemaStrict(content);
        if (validationError) {
          reply.code(422);
          return {
            ok: false,
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
            return {
              ok: false,
              error: 'Instance must have a valid GTS ID or type field',
            };
          }
        }
      }

      if (!entity.id) {
        return {
          ok: false,
          error: 'Unable to extract GTS ID from entity',
        };
      }

      // Validate schema with x-gts-ref if it's a schema
      // x-gts-ref validation always returns 422 on failure (not just when validate=true)
      if (entity.isSchema) {
        const xGtsRefValidator = new XGtsRefValidator(this.store['store']);
        const xGtsRefErrors = xGtsRefValidator.validateSchema(content);
        if (xGtsRefErrors.length > 0) {
          const errorMsgs = xGtsRefErrors.map((err) => `${err.fieldPath}: ${err.reason}`).join('; ');
          reply.code(422);
          return {
            ok: false,
            error: `x-gts-ref validation failed: ${errorMsgs}`,
          };
        }
      }

      // Register the entity
      this.store.register(content);

      // Validate instance if requested
      if (validate && !entity.isSchema) {
        const result = this.store.validateInstance(entity.id);
        if (!result.ok) {
          return {
            ok: false,
            error: result.error,
          };
        }
      }

      return {
        ok: true,
        id: entity.id,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private validateSchemaStrict(content: any): string | null {
    // Check for $id or $$id
    const schemaId = content['$id'] || content['$$id'];
    if (!schemaId) {
      return 'Schema must have a $id or $$id field';
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

    // Check $ref or $$ref
    const ref = obj['$ref'] || obj['$$ref'];
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
      if (key === '$ref' || key === '$$ref') continue;
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

  private async handleAddSchema(request: FastifyRequest<{ Body: any }>, reply: FastifyReply): Promise<OperationResult> {
    return this.handleAddEntity(request as any, reply);
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
        ver_major: seg.verMajor,
        ver_minor: seg.verMinor ?? null,
        is_type: seg.isType,
      })) || [];

    // is_schema: true if ends with ~ and not a wildcard ending with ~*
    const isSchema = id.endsWith('~') && !isWildcard;

    return {
      id,
      ok: result.ok,
      segments,
      error: result.error || '',
      is_schema: isSchema,
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
    request: FastifyRequest<{ Body: ValidateInstanceBody }>,
    reply: FastifyReply
  ): Promise<any> {
    const { instance_id } = request.body;

    if (!instance_id) {
      reply.code(400);
      throw new Error('Missing required field: instance_id');
    }

    return this.store.validateInstance(instance_id);
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
    const { old_schema_id, new_schema_id, mode = 'full' } = request.query;

    if (!old_schema_id || !new_schema_id) {
      reply.code(400);
      throw new Error('Missing required parameters: old_schema_id, new_schema_id');
    }

    // Call the store's checkCompatibility directly to get the correct response format
    return this.store['store'].checkCompatibility(old_schema_id, new_schema_id, mode);
  }

  // OP#9 - Cast
  private async handleCast(request: FastifyRequest<{ Body: CastBody }>, reply: FastifyReply): Promise<any> {
    const { instance_id, to_schema_id } = request.body;

    if (!instance_id || !to_schema_id) {
      reply.code(400);
      throw new Error('Missing required fields: instance_id, to_schema_id');
    }

    // Call the store's castInstance directly to get the correct response format
    return this.store['store'].castInstance(instance_id, to_schema_id);
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

    return this.store['store'].getAttribute(gtsId, path);
  }

  // OpenAPI Specification
  private async handleOpenAPI(): Promise<any> {
    return {
      openapi: '3.0.0',
      info: {
        title: 'GTS Server',
        version: '0.1.0',
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
          },
        },
      },
      '/validate-id': {
        get: {
          summary: 'Validate a GTS ID',
          operationId: 'validateID',
          parameters: [
            {
              name: 'id',
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
    };
  }

  private getOpenAPIComponents(): any {
    return {
      schemas: {
        OperationResult: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
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
