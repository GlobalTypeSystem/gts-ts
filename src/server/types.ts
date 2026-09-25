export interface ServerConfig {
  host: string;
  port: number;
  verbose: number;
  path?: string;
  /**
   * Permits re-registering an entity with different content. When `false`
   * (default), a changed re-registration is rejected with HTTP `409 Conflict`
   * while identical re-submissions stay idempotent. Wired from the
   * `--allow-entity-updates` CLI flag.
   */
  allowEntityUpdates?: boolean;
  /**
   * Maximum accepted request body size, in bytes. Defaults to
   * {@link DEFAULT_BODY_LIMIT_BYTES}. Bounds memory a single request can force
   * the server to buffer (Fastify reads the whole body before the handler
   * runs), including the bulk `POST /entities/bulk` and `POST /type-schemas`
   * routes that accept arrays.
   */
  bodyLimit?: number;
}

/**
 * Default request body cap (1 MiB) - the same limit Fastify applies when
 * unset, made explicit so the bound is visible and adjustable rather than an
 * implicit framework default.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

export interface EntityResponse {
  id: string;
  ok: boolean;
  content: any;
  error?: string;
}

/**
 * OP#6 `POST /validate-json` / `POST /validate-json/{gts_type}` response
 * shape. Per `.gts-spec/tests/openapi.json`'s `ValidateJsonResult`, all five
 * fields are required and `id`/`type_id`/`error` are nullable - never
 * simply omitted.
 */
export interface ValidateJsonResult {
  ok: boolean;
  id: string | null;
  type_id: string | null;
  is_type_schema: boolean;
  error: string | null;
}

export interface OperationResult {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

export interface ListResult {
  count: number;
  items: string[];
}

export interface ValidateIDParams {
  gts_id?: string;
  id?: string;
}

export interface ExtractIDBody {
  content: any;
  schemaContent?: any;
}

export interface ParseIDParams {
  id: string;
}

export interface MatchPatternParams {
  pattern: string;
  candidate: string;
}

export interface UUIDParams {
  id: string;
}

export interface ValidateInstanceBody {
  instance_id: string;
}

export interface ResolveRelationshipsParams {
  gts_id: string;
}

export interface CompatibilityParams {
  old_type_id?: string;
  new_type_id?: string;
  mode?: 'backward' | 'forward' | 'full';
}

export interface CastBody {
  instance_id: string;
  to_type_id: string;
}

export interface QueryParams {
  expr: string;
  limit?: number;
}

export interface AttributeParams {
  gts_id: string;
  path: string;
}

export interface ValidateTypeSchemaBody {
  type_id: string;
}

export interface ValidateEntityBody {
  entity_id?: string;
  gts_id?: string;
}
