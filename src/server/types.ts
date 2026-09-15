export interface ServerConfig {
  host: string;
  port: number;
  verbose: number;
  path?: string;
}

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

export interface TypeSchemaRegisterBody {
  type_id: string;
  type_schema: Record<string, any>;
}

export interface ValidateEntityBody {
  entity_id?: string;
  gts_id?: string;
}
