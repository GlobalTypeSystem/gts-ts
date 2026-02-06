export const GTS_PREFIX = 'gts.';
export const GTS_URI_PREFIX = 'gts://';
export const MAX_ID_LENGTH = 1024;

export interface GtsIDSegment {
  num: number;
  offset: number;
  segment: string;
  vendor: string;
  package: string;
  namespace: string;
  type: string;
  verMajor: number;
  verMinor?: number;
  isType: boolean;
  isWildcard: boolean;
}

export interface GtsID {
  id: string;
  segments: GtsIDSegment[];
}

export interface ValidationResult {
  id: string;
  ok: boolean;
  valid?: boolean;
  error: string;
  is_wildcard?: boolean;
}

export interface ParseResult {
  ok: boolean;
  segments: GtsIDSegment[];
  error?: string;
  is_schema?: boolean;
  is_wildcard?: boolean;
}

export interface MatchResult {
  match: boolean;
  pattern: string;
  candidate: string;
  error?: string;
}

export interface UUIDResult {
  id: string;
  uuid: string;
  error?: string;
}

export interface ExtractResult {
  id: string;
  schema_id: string | null;
  selected_entity_field?: string;
  selected_schema_id_field?: string;
  is_schema: boolean;
  error?: string;
}

export interface AttributeResult {
  path: string;
  resolved: boolean;
  value?: any;
  error?: string;
}

export interface QueryResult {
  query: string;
  count: number;
  items: any[];
  error?: string;
  limit?: number;
}

export interface RelationshipResult {
  id: string;
  relationships: string[];
  brokenReferences: string[];
  error?: string;
}

export interface CompatibilityResult {
  from: string;
  to: string;
  old: string;
  new: string;
  direction: string;
  added_properties: string[];
  removed_properties: string[];
  changed_properties: Array<Record<string, string>>;
  is_fully_compatible: boolean;
  is_backward_compatible: boolean;
  is_forward_compatible: boolean;
  incompatibility_reasons: string[];
  backward_errors: string[];
  forward_errors: string[];
}

export interface CastResult {
  ok: boolean;
  fromId: string;
  toId: string;
  result?: any;
  error?: string;
}

export interface GtsConfig {
  validateRefs: boolean;
  strictMode: boolean;
}

export interface JsonEntity {
  id: string;
  schemaId: string | null;
  content: Record<string, any>;
  isSchema: boolean;
  references: Set<string>;
}

export class InvalidGtsIDError extends Error {
  constructor(
    public gtsId: string,
    public cause?: string
  ) {
    super(cause ? `Invalid GTS identifier: ${gtsId}: ${cause}` : `Invalid GTS identifier: ${gtsId}`);
    this.name = 'InvalidGtsIDError';
  }
}

export class InvalidSegmentError extends Error {
  constructor(
    public num: number,
    public offset: number,
    public segment: string,
    public cause?: string
  ) {
    super(
      cause
        ? `Invalid GTS segment #${num} @ offset ${offset}: '${segment}': ${cause}`
        : `Invalid GTS segment #${num} @ offset ${offset}: '${segment}'`
    );
    this.name = 'InvalidSegmentError';
  }
}
