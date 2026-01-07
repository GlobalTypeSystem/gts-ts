export interface ServerConfig {
  host: string;
  port: number;
  verbose: number;
  path?: string;
}

export interface EntityResponse {
  id: string;
  content: any;
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
  old_schema_id: string;
  new_schema_id: string;
  mode?: 'backward' | 'forward' | 'full';
}

export interface CastBody {
  instance_id: string;
  to_schema_id: string;
}

export interface QueryParams {
  expr: string;
  limit?: number;
}

export interface AttributeParams {
  gts_id: string;
  path: string;
}
