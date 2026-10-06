export const GTS_PREFIX = 'gts.';
export const GTS_URI_PREFIX = 'gts://';
export const MAX_ID_LENGTH = 1024;

/**
 * Host that every supported JSON Schema meta-schema (`$schema`) URI lives
 * under. Centralized so dialect checks do not scatter the literal - mirrors
 * the prefix-constant discipline gts-rust enforces via its `gts-dylint` lint
 * and gts-dotnet's `GtsConstants`.
 */
export const JSON_SCHEMA_HOST = 'json-schema.org';

/**
 * A JSON value, modelled as a recursive union rather than `any`. Prefer this
 * (or `unknown` plus a guard) over `any` for parsed-JSON positions so the
 * compiler keeps checking the untrusted data that flows through validation.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object - the shape every registered entity's `content` takes. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Whether `value` carries the `gts://` URI prefix that JSON Schema `$id`/`$ref`
 * fields use to embed a GTS identifier (gts-spec §3.4).
 */
export function hasUriPrefix(value: string): boolean {
  return value.startsWith(GTS_URI_PREFIX);
}

/**
 * Strip a leading `gts://` URI prefix if present, returning the bare GTS
 * identifier. A single choke point for the prefix so the length offset is
 * never hardcoded (`.substring(6)` / `.slice(6)`) at call sites.
 */
export function stripUriPrefix(value: string): string {
  return hasUriPrefix(value) ? value.slice(GTS_URI_PREFIX.length) : value;
}

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

/**
 * A parsed GTS *pattern* - an identifier that may contain a single trailing
 * `*` wildcard, used for matching rather than as an entity identity.
 *
 * Modelled as a distinct type (rather than folding wildcards into {@link GtsID}
 * behind boolean segment flags) so pattern-only concerns do not leak into the
 * identity type and callers can branch on {@link GtsPattern.hasWildcard}
 * instead of re-scanning the raw string for `*`. Mirrors gts-rust's separate
 * `GtsIdPattern`.
 */
export interface GtsPattern {
  id: string;
  segments: GtsIDSegment[];
  /** Whether the pattern contains a `*` wildcard token. */
  hasWildcard: boolean;
}

export interface SourceSpan {
  offset: number;
  length: number;
  line: number;
  column: number;
  lineOffset: number;
}

export interface ValidationIssueSource {
  value: SourceSpan;
  key?: SourceSpan;
}

export interface ValidationIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
  data?: unknown;
  entityId?: string;
  entityIndex?: number;
  source?: ValidationIssueSource;
}

export interface ValidationResult {
  id: string;
  ok: boolean;
  valid?: boolean;
  error: string;
  is_wildcard?: boolean;
  errors?: ValidationIssue[];
}

/**
 * Serialization format of a GTS text payload. The client is responsible for
 * mapping its own file extensions (or content type) to one of these values;
 * the library never receives a file path or name so it cannot leak one.
 */
export type GtsTextFormat = 'json' | 'jsonc' | 'yaml';

export interface GtsTextParseResult {
  ok: boolean;
  content?: unknown;
  entities: JsonEntity[];
  error?: string;
  errors?: ValidationIssue[];
}

export interface GtsEntityValidationResult {
  entityIndex: number;
  id: string;
  isSchema: boolean;
  result: ValidationResult;
}

export interface GtsTextValidationResult {
  ok: boolean;
  entities: GtsEntityValidationResult[];
  errors: ValidationIssue[];
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

/** Which subset relation a diagnostic pertains to. */
export type CompatDirection = 'backward' | 'forward';

/**
 * A single piece of evidence behind a non-`compatible` verdict, modelled after
 * gts-rust's `CompatibilityDiagnostic`. Structured (direction + verdict +
 * message) rather than a bare string so callers can filter/group findings
 * without parsing prose.
 */
export interface CompatibilityDiagnostic {
  direction: CompatDirection;
  verdict: CompatVerdict;
  message: string;
}

/**
 * Derive a verdict from diagnostics - the TS analogue of gts-rust's
 * `CompatibilityVerdict::from_diagnostics`, keeping the verdict a pure reading
 * of its evidence (no `incompatible` sitting next to an empty diagnostic list).
 * `incompatible` dominates `unknown`, which dominates `compatible`; no matching
 * diagnostic means `compatible`.
 *
 * Pass `direction` to recover a single directional verdict
 * (`backward`/`forward`) by considering only that direction's diagnostics;
 * omit it to recover the full verdict, which spans both directions and equals
 * {@link CompatibilityResult.full_compatibility}.
 */
export function verdictFromDiagnostics(
  diagnostics: CompatibilityDiagnostic[],
  direction?: CompatDirection
): CompatVerdict {
  let verdict: CompatVerdict = 'compatible';
  for (const d of diagnostics) {
    if (direction !== undefined && d.direction !== direction) continue;
    if (d.verdict === 'incompatible') return 'incompatible';
    if (d.verdict === 'unknown') verdict = 'unknown';
  }
  return verdict;
}

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
  /**
   * Structured evidence for the two directional verdicts, superseding the
   * deprecated `*_properties` arrays (gts-rust parity). Kept consistent with
   * the verdicts above: `backward_compatibility` equals
   * `verdictFromDiagnostics(diagnostics, 'backward')`,
   * `forward_compatibility` the `'forward'` variant, and
   * `full_compatibility` equals `verdictFromDiagnostics(diagnostics)` with no
   * direction. Empty when both directions are `compatible`.
   */
  diagnostics: CompatibilityDiagnostic[];
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
export const GtsRefValidationMode = {
  None: 'none',
  AnyPresent: 'any-present',
  AnyValid: 'any-valid',
} as const;

export type GtsRefValidationMode = (typeof GtsRefValidationMode)[keyof typeof GtsRefValidationMode];

export interface EntityLookup {
  get(id: string): JsonEntity | undefined;
  getAll?(): JsonEntity[];
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

export class EntityContentDepthError extends Error {
  constructor() {
    super(`Entity content nests deeper than ${MAX_SCHEMA_DEPTH} levels and cannot be compared safely`);
    this.name = 'EntityContentDepthError';
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
