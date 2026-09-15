export const GTS_PREFIX = 'gts.';
export const GTS_URI_PREFIX = 'gts://';
export const MAX_ID_LENGTH = 1024;

/**
 * Recursion bound shared by every walker over schema documents.
 *
 * The limit exists to stop pathological or cyclic input, never to decide a
 * result. Whatever hits it must fail closed - report the finding, or mark the
 * comparison inconclusive - and must never return a value that reads as
 * "unconstrained", which would turn a bailout into a silent pass.
 */
export const MAX_SCHEMA_DEPTH = 64;

/**
 * Bounds the total number of `$ref` follows and `allOf` branch recursions a
 * schema walker may take across one top-level call, independent of
 * `MAX_SCHEMA_DEPTH` (which only bounds how deep a single chain goes, not how
 * many root-to-leaf paths a diamond-shaped `allOf`/`$ref` DAG can have). Path
 * count doubles per level in a symmetric diamond, so a modest depth well
 * inside `MAX_SCHEMA_DEPTH` can already reach millions of paths, which makes
 * naive per-path resolution/comparison exponential even though depth alone
 * stays small. 10,000 is generously above any realistic legitimate schema
 * hierarchy (expected to be a handful of levels deep with little to no
 * branching) while guaranteeing the walk completes in well under a second
 * even in the worst case.
 */
export const MAX_SCHEMA_PATHS = 10_000;

export interface GtsIDSegment {
  num: number;
  offset: number;
  segment: string;
  vendor: string;
  package: string;
  namespace: string;
  type: string;
  /**
   * The parsed major version, or `undefined` when the segment carries no
   * explicit version at all (e.g. a bare wildcard token). Mirrors gts-rust's
   * `ver_major: Option<u32>` so an unspecified major and a genuine `v0` stay
   * distinguishable - do not default this to `0` for "no version given".
   */
  verMajor?: number;
  verMinor?: number;
  isType: boolean;
  isWildcard: boolean;
  isUuidTail: boolean;
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
  is_type_schema?: boolean;
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
  type_id: string | null;
  selected_entity_field?: string;
  selected_type_id_field?: string;
  is_type_schema: boolean;
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

/** Tri-state compatibility verdict (GTS spec 0.13 §4.3). */
export type CompatVerdict = 'compatible' | 'incompatible' | 'unknown';

export interface CompatibilityResult {
  old: string;
  new: string;
  backward_compatibility: CompatVerdict;
  forward_compatibility: CompatVerdict;
  full_compatibility: CompatVerdict;
  from: string;
  to: string;
  direction: string;
  /**
   * @deprecated Always empty since 0.4.0. Compatibility is decided by comparing
   * accepted-instance sets (§4.3) rather than by diffing properties, so the
   * engine no longer produces a property diff. Slated for removal.
   */
  added_properties: string[];
  /** @deprecated Always empty since 0.4.0. See {@link CompatibilityResult.added_properties}. */
  removed_properties: string[];
  /** @deprecated Always empty since 0.4.0. See {@link CompatibilityResult.added_properties}. */
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
  /**
   * Three-valued directional/full compatibility verdicts for the two type
   * schemas involved in the cast, from the same `GtsCompatibility` machinery
   * `/compatibility` uses. Computed independently of whether `ok` is true -
   * a successful transform does not by itself establish compatibility, and
   * an incompatible pair can still cast and validate cleanly.
   */
  backward_compatibility: CompatVerdict;
  forward_compatibility: CompatVerdict;
  full_compatibility: CompatVerdict;
}

export interface GtsConfig {
  validateRefs: boolean;
  strictMode: boolean;
  /**
   * Permits re-registering an entity with different content. When `false`
   * (default), changing the content of an already-registered entity is
   * rejected with an {@link EntityConflictError} while identical
   * re-submissions stay idempotent. Mirrors gts-go's
   * `RegistryConfig.AllowEntityUpdates` (`--allow-entity-updates`).
   */
  allowEntityUpdates: boolean;
}

/**
 * The read-only registry surface that the compatibility engine and the
 * `x-gts-ref` validator need - entity lookup by identifier, nothing more.
 *
 * They depend on this instead of on `GtsStore` so that the dependency stays
 * one-way: the registry may reach into those modules, and they only need to
 * look entities up. `GtsStore` satisfies this structurally, so no call site
 * changes and no import cycle.
 */
export interface EntityLookup {
  get(id: string): JsonEntity | undefined;
}

export interface JsonEntity {
  id: string;
  schemaId: string | null;
  content: Record<string, any>;
  isSchema: boolean;
  references: Set<string>;
}

/**
 * Thrown when an entity is already registered under the same id with
 * different content and entity updates are not allowed
 * ({@link GtsConfig.allowEntityUpdates} is `false`). Callers can surface this
 * as an HTTP `409 Conflict`. Mirrors gts-go's `EntityConflictError`.
 */
export class EntityConflictError extends Error {
  constructor(public entityId: string) {
    super(`Entity '${entityId}' is already registered with different content`);
    this.name = 'EntityConflictError';
  }
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
