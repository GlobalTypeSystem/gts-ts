import { createHash } from 'crypto';
import Ajv from 'ajv';
import { applyGtsFormats } from './formats';
import {
  GtsConfig,
  JsonEntity,
  ValidationResult,
  EntityConflictError,
  GTS_URI_PREFIX,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_PATHS,
} from './types';
import { Gts } from './gts';
import { GtsExtractor } from './extract';
import { XGtsRefValidator } from './x-gts-ref';
import { GtsCompatibility, findCrossedBound, isEmptySchema } from './compatibility';
import { GtsModifiers } from './modifiers';

interface ResolvedSchema {
  properties: Record<string, any>;
  required: string[];
  additionalProperties?: boolean;
  type?: string | string[];
}

/**
 * Keywords that describe an object level's structure rather than the value
 * constraints of a single property - gts-rust's `STRUCTURAL_KEYWORDS`
 * (`schema_derivation.rs`), used by `declaredTraitSchema`/`absorbProperty` to
 * decide which keywords a restated property replaces wholesale versus which
 * ones compose across `allOf` branches.
 */
const TRAIT_STRUCTURAL_KEYWORDS = ['properties', 'required', 'additionalProperties'];

/**
 * True when `value` is safe to read schema keywords off (`.type`, `['$ref']`,
 * etc). Schemas are registered without meta-validation (`validateSchema:
 * false` above), so a registered document can contain a literal `null` (or
 * any other non-object) in a position where a schema object is expected -
 * e.g. `properties: {a: null}` or `allOf: [{...}, null]`. Every traversal
 * that walks into such a position must check this first, rather than reading
 * a property straight off the value: a `null`/non-object entry in a schema
 * position is malformed/no-op data, not a crash.
 */
function isPlainSchemaObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON serialization with object keys emitted in sorted order,
 * recursively. `JSON.stringify` preserves insertion order, so two entities
 * with equal content but differently-ordered keys would serialize
 * differently - sorting keys makes the serialization stable so equal content
 * always produces an equal string. Mirrors gts-go's reliance on Go's
 * `encoding/json` sorting map keys.
 */
function canonicalJson(value: any): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A stable SHA-256 hash of an entity's content, used to distinguish an
 * idempotent re-submission (identical content) from a conflicting update
 * (changed content) without a deep structural comparison. Mirrors gts-go's
 * `contentHash`.
 */
function contentHash(content: Record<string, any>): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export class GtsStore {
  private byId: Map<string, JsonEntity> = new Map();
  private config: GtsConfig;
  private ajv: Ajv;

  constructor(config?: Partial<GtsConfig>) {
    this.config = {
      validateRefs: config?.validateRefs ?? false,
      strictMode: config?.strictMode ?? false,
      allowEntityUpdates: config?.allowEntityUpdates ?? false,
    };

    this.ajv = new Ajv({
      strict: false,
      validateSchema: false,
      addUsedSchema: false,
      loadSchema: this.loadSchema.bind(this),
      validateFormats: true, // ADR-0005: uuid/email/date-time/... are assertions, not annotations.
      // P6-7: without this, `validate.errors` only ever has one entry, even
      // when several keywords fail, making every caller's `.join('; ')`
      // framing (`formatValidationError`'s call sites) dead code that
      // silently drops every failure but the first. Multiple simultaneous
      // failures are common (e.g. two properties of the wrong type at
      // once), so a caller only ever seeing the first is a real gap, not a
      // documented limitation worth keeping.
      allErrors: true,
    });
    // ADR-0005 format assertions (uuid, email, date-time, date, time, uri,
    // hostname, ipv4, ipv6, regex), shared by OP#6 (validateInstance) and
    // OP#13 (validateSchemaTraits) since both compile against this.ajv.
    applyGtsFormats(this.ajv);
  }

  private async loadSchema(uri: string): Promise<any> {
    const normalizedUri = uri.startsWith(GTS_URI_PREFIX) ? uri.substring(GTS_URI_PREFIX.length) : uri;

    if (Gts.isValidGtsID(normalizedUri)) {
      const entity = this.get(normalizedUri);
      if (entity && entity.isSchema) {
        return entity.content;
      }
    }
    throw new Error(`Unresolvable GTS reference: ${uri}`);
  }

  register(entity: JsonEntity): void {
    // A malformed entity id would silently break every ancestor-chain
    // computation downstream (`buildSchemaChain` and friends), which then
    // fail open by treating the entity as if it had no ancestors at all -
    // so, like the modifier-declaration check below, this MUST be rejected
    // unconditionally at registration time, regardless of `validateRefs` or
    // any other config. A SCHEMA must always carry a well-formed GTS Type
    // ID. A non-schema INSTANCE may instead be an "anonymous instance"
    // (gts-spec §3.7): identified by a plain UUID, with schema resolution
    // carried by its own `type` field rather than by the id's GTS-chain
    // shape - so a plain UUID id is accepted for instances only.
    const hasValidId = Gts.isValidGtsID(entity.id) || (!entity.isSchema && Gts.isUuid(entity.id));
    if (!hasValidId) {
      // An empty id means no `$id`/id-shaped field was found at all (the
      // extractor never returns an empty value from a present field), which
      // is a different failure than a non-empty, ill-formed id - callers
      // (and the canonical conformance suite) distinguish "no id was ever
      // detected" from "an id was given but is malformed".
      if (!entity.id) {
        throw new Error(
          entity.isSchema ? 'Unable to detect GTS ID in schema' : 'Unable to detect GTS ID in instance entity'
        );
      }
      throw new Error(`Invalid GTS entity id: '${entity.id}'`);
    }

    // Protect registry state: unless entity updates are allowed, re-registering
    // an id with *different* content is rejected (EntityConflictError, surfaced
    // as HTTP 409), while an identical re-submission stays idempotent. The
    // check runs before any mutation below so the previously-registered content
    // is preserved on rejection. Mirrors gts-go's registerLocked conflict gate.
    const previous = this.byId.get(entity.id);
    const replacing = previous && contentHash(previous.content) !== contentHash(entity.content);
    if (replacing && !this.config.allowEntityUpdates) {
      throw new EntityConflictError(entity.id);
    }

    if (this.config.validateRefs) {
      for (const ref of entity.references) {
        if (!this.byId.has(ref)) {
          throw new Error(`Unresolved reference: ${ref}`);
        }
      }
    }

    // A malformed modifier declaration (mutually-exclusive x-gts-final +
    // x-gts-abstract, or a non-boolean value) "MUST be rejected during schema
    // registration" (§9.11.1) unconditionally - unlike the placement/guard
    // checks in `checkTypeSchemaRules`'s `enforceGuards` branch, this part
    // does not depend on `validateEntity`/HTTP-only enforcement, so it has to
    // run here to cover every entry point (library, CLI, HTTP).
    if (entity.isSchema && entity.content) {
      const declarationError = this.checkTypeSchemaRules(entity.content, entity.id, { enforceGuards: false });
      if (declarationError) {
        throw new Error(declarationError);
      }
    }

    if (replacing && previous.isSchema) {
      this.ajv.removeSchema(entity.id);
    }
    this.byId.set(entity.id, entity);

    // If this is a schema, add it to AJV for reference resolution
    if (entity.isSchema && entity.content) {
      try {
        const normalizedSchema = this.normalizeSchema(entity.content);
        // Set $id to the GTS ID if not already set
        if (!normalizedSchema.$id) {
          normalizedSchema.$id = entity.id;
        }
        this.ajv.addSchema(normalizedSchema, entity.id);
      } catch (err) {
        // Ignore errors adding schema - it might already exist or be invalid
      }
    }
  }

  get(id: string): JsonEntity | undefined {
    return this.byId.get(id);
  }

  /**
   * Roll back a `register()` call. Some post-registration gates (e.g.
   * `validateSchemaAgainstParent`) can only run once the entity is looked up
   * by id, so a caller that rejects the entity after registering it must undo
   * both the `byId` index and the Ajv schema entry to avoid leaving the store
   * in an inconsistent, "rejected but still retrievable" state.
   */
  unregister(id: string): void {
    const entity = this.byId.get(id);
    if (!entity) {
      return;
    }
    this.byId.delete(id);
    if (entity.isSchema) {
      try {
        this.ajv.removeSchema(id);
      } catch (err) {
        // Ignore errors removing schema - mirrors the best-effort addSchema above.
      }
    }
  }

  getAll(): JsonEntity[] {
    return Array.from(this.byId.values());
  }

  query(pattern: string, limit?: number): string[] {
    const results: string[] = [];
    const maxResults = limit ?? Number.MAX_SAFE_INTEGER;

    for (const [id] of this.byId) {
      if (results.length >= maxResults) break;

      const matchResult = Gts.matchIDPattern(id, pattern);
      if (matchResult.match) {
        results.push(id);
      }
    }

    return results;
  }

  validateInstance(gtsId: string): ValidationResult {
    return this.validateInstanceTransitive(gtsId, new Set(), new Map());
  }

  private validateInstanceTransitive(
    gtsId: string,
    visiting: Set<string>,
    completed: Map<string, ValidationResult>
  ): ValidationResult {
    const key = `instance:${gtsId}`;
    const cached = completed.get(key);
    if (cached) return cached;
    if (visiting.has(key)) return { id: gtsId, ok: true, valid: true, error: '' };

    visiting.add(key);
    const referencedIds = new Set<string>();
    const localResult = this.validateInstanceLocal(gtsId, referencedIds);
    if (!localResult.ok) {
      visiting.delete(key);
      completed.set(key, localResult);
      return localResult;
    }

    let objId = gtsId;
    if (Gts.isValidGtsID(gtsId)) objId = Gts.parseGtsID(gtsId).id;
    const obj = this.get(objId)!;
    const typeResult = this.validateSchemaTransitive(obj.schemaId!, visiting, completed);
    if (!typeResult.ok) {
      const result = {
        id: gtsId,
        ok: false,
        valid: false,
        error: `Instance type '${obj.schemaId}' is invalid: ${typeResult.error}`,
      };
      visiting.delete(key);
      completed.set(key, result);
      return result;
    }

    for (const dependencyId of referencedIds) {
      const dependencyResult = this.validateEntityTransitive(dependencyId, visiting, completed);
      if (!dependencyResult.ok) {
        const result = {
          id: gtsId,
          ok: false,
          valid: false,
          error: `Referenced entity '${dependencyId}' is invalid: ${dependencyResult.error}`,
        };
        visiting.delete(key);
        completed.set(key, result);
        return result;
      }
    }

    visiting.delete(key);
    completed.set(key, localResult);
    return localResult;
  }

  private validateInstanceLocal(gtsId: string, referencedIds?: Set<string>): ValidationResult {
    try {
      let objId: string = gtsId;
      if (Gts.isValidGtsID(gtsId)) {
        const gid = Gts.parseGtsID(gtsId);
        objId = gid.id;
      }

      const obj = this.get(objId);
      if (!obj) {
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: `Entity not found: ${gtsId}`,
        };
      }

      if (!obj.schemaId) {
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: `No schema found for instance: ${gtsId}`,
        };
      }

      const schemaEntity = this.get(obj.schemaId);
      if (!schemaEntity) {
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: `Schema not found: ${obj.schemaId}`,
        };
      }

      if (!schemaEntity.isSchema) {
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: `Entity '${obj.schemaId}' is not a schema`,
        };
      }

      // §9.11.3 item 2 - the rightmost type in the chain must be instantiable
      if (GtsModifiers.isAbstract(schemaEntity.content)) {
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: `Type '${obj.schemaId}' is abstract and cannot be directly instantiated`,
        };
      }

      const validate = this.ajv.compile(this.normalizeSchema(schemaEntity.content));
      const isValid = validate(obj.content);

      if (!isValid) {
        // P6-4: routed through the same `formatValidationError` the
        // transient `/validate-json` paths use, so `/validate-instance` and
        // `/validate-json` report the identical failure with the identical
        // wording instead of two different Ajv-error-to-string conventions.
        const errors = validate.errors?.map((e) => this.formatValidationError(e)).join('; ') || 'Validation failed';
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: errors,
        };
      }

      // Validate x-gts-ref constraints
      const xGtsRefValidator = new XGtsRefValidator(this);
      const xGtsRefErrors = xGtsRefValidator.validateInstance(obj.content, schemaEntity.content);
      if (xGtsRefErrors.length > 0) {
        const errorMsgs = xGtsRefErrors.map((err) => err.reason).join('; ');
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: `x-gts-ref validation failed: ${errorMsgs}`,
        };
      }
      for (const dependencyId of xGtsRefValidator.getReferencedIds()) {
        referencedIds?.add(dependencyId);
      }

      return {
        id: gtsId,
        ok: true,
        valid: true,
        error: '',
      };
    } catch (error) {
      return {
        id: gtsId,
        ok: false,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * OP#6 `POST /validate-json` (transient JSON validation, spec commit
   * ab1287e) - validates `content` against the already-registered type
   * `typeId` WITHOUT requiring `content` itself to be registered as an
   * instance (unlike `validateInstance` above, which looks an already-
   * registered instance up by id). Used by both the auto-detection and the
   * explicit-type `/validate-json` routes, neither of which may register
   * anything.
   *
   * Checks `schemaEntity.isSchema` (P6-2/P6-3): before registration-time
   * stamping was fixed, a type registered via `POST /type-schemas` with no
   * embedded `$schema`/root-type keyword was misclassified as a non-schema
   * by `GtsExtractor.isJsonSchema` (it keyed off document shape alone), so
   * this check was deliberately left out to accommodate
   * `TestCaseOp6ValidateJson_ExplicitSchemaWithoutEmbeddedIdentity`. Now that
   * `POST /type-schemas` stamps `isSchema` from the caller's declared
   * `type_id` intent instead, the check is safe to enforce uniformly here
   * too - closing the same junk-document-compiles-as-schema hole for the
   * auto-detect route that P6-2/P6-3 closed for the explicit-type route.
   */
  validateTransientInstance(content: any, typeId: string, resultId: string | null): ValidationResult {
    const id = resultId ?? '';
    try {
      const schemaEntity = this.get(typeId);
      if (!schemaEntity) {
        return { id, ok: false, error: `GTS Type Schema not found: ${typeId}` };
      }
      if (!schemaEntity.isSchema) {
        return { id, ok: false, error: `Entity '${typeId}' is not a GTS Type Schema` };
      }

      // §9.11.3 item 2 - the rightmost type in the chain must be instantiable.
      if (GtsModifiers.isAbstract(schemaEntity.content)) {
        return {
          id,
          ok: false,
          error: `Type '${typeId}' is abstract and cannot be directly instantiated`,
        };
      }

      const validate = this.ajv.compile(this.normalizeSchema(schemaEntity.content));
      const isValid = validate(content);

      if (!isValid) {
        const errors = validate.errors?.map((e) => this.formatValidationError(e)).join('; ') || 'Validation failed';
        return { id, ok: false, error: errors };
      }

      const xGtsRefValidator = new XGtsRefValidator(this);
      const xGtsRefErrors = xGtsRefValidator.validateInstance(content, schemaEntity.content);
      if (xGtsRefErrors.length > 0) {
        const errorMsgs = xGtsRefErrors.map((err) => err.reason).join('; ');
        return { id, ok: false, error: `x-gts-ref validation failed: ${errorMsgs}` };
      }

      return { id, ok: true, error: '' };
    } catch (error) {
      return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Formats one Ajv validation error. Mirrors the canonical conformance
   * suite's reference validator (Python `jsonschema`) wording for the
   * `type` keyword - `"<path> is not of type '<expected>'"` - rather than
   * Ajv's own `"<path> must be <expected>"`, since
   * `test_op6_schema_validation.py` asserts against that exact phrase
   * (`assert_contains("body.error", "is not of type 'string'")`).
   */
  private formatValidationError(e: import('ajv').ErrorObject): string {
    if (e.keyword === 'type') {
      const types = Array.isArray(e.params?.type) ? e.params.type : [e.params?.type];
      const typeList = types.map((t: string) => `'${t}'`).join(', ');
      return `${e.instancePath || 'value'} is not of type ${typeList}`;
    }
    if (e.keyword === 'required') {
      return `${e.instancePath || '/'} must have required property '${(e.params as any)?.missingProperty}'`;
    }
    // P6-6: the root-level path (an empty `instancePath`) must fall back to
    // '/' here too, matching the `required` branch above - otherwise a
    // root-level failure (e.g. `additionalProperties` on the document
    // itself) renders as a leading-space, path-less
    // " must NOT have additional properties" instead of "/ must NOT have
    // additional properties".
    return `${e.instancePath || '/'} ${e.message}`;
  }

  private normalizeSchema(schema: any): any {
    return this.normalizeSchemaRecursive(schema);
  }

  private normalizeSchemaRecursive(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.normalizeSchemaRecursive(item));
    }

    const normalized: any = {};

    for (const [key, value] of Object.entries(obj)) {
      // Strip x-gts-ref so Ajv never sees the unknown keyword
      if (key === 'x-gts-ref') continue;

      const newKey = key;
      let newValue = value;

      // Recursively normalize nested objects
      if (value && typeof value === 'object') {
        newValue = this.normalizeSchemaRecursive(value);
      }

      normalized[newKey] = newValue;
    }

    // Clean up combinator arrays: remove subschemas that were x-gts-ref-only (now empty after stripping)
    for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(normalized[combinator])) {
        normalized[combinator] = normalized[combinator].filter((_sub: any, idx: number) => {
          const original = (obj as any)[combinator]?.[idx];
          const isXGtsRefOnly =
            original &&
            typeof original === 'object' &&
            !Array.isArray(original) &&
            Object.keys(original).length === 1 &&
            original['x-gts-ref'] !== undefined;
          return !isXGtsRefOnly;
        });
        if (normalized[combinator].length === 0) {
          delete normalized[combinator];
        }
      }
    }

    // Normalize $id values
    if (normalized['$id'] && typeof normalized['$id'] === 'string') {
      if (normalized['$id'].startsWith(GTS_URI_PREFIX)) {
        normalized['$id'] = normalized['$id'].substring(GTS_URI_PREFIX.length);
      }
    }

    // Normalize $ref values
    if (normalized['$ref'] && typeof normalized['$ref'] === 'string') {
      if (normalized['$ref'].startsWith(GTS_URI_PREFIX)) {
        normalized['$ref'] = normalized['$ref'].substring(GTS_URI_PREFIX.length);
      }
    }

    return normalized;
  }

  resolveRelationships(gtsId: string): any {
    const seen = new Set<string>();
    return this.buildSchemaGraphNode(gtsId, seen);
  }

  private buildSchemaGraphNode(gtsId: string, seen: Set<string>): any {
    const node: any = {
      id: gtsId,
    };

    // Check for cycles
    if (seen.has(gtsId)) {
      return node;
    }
    seen.add(gtsId);

    // Get the entity from store
    const entity = this.get(gtsId);
    if (!entity) {
      node.errors = ['Entity not found'];
      return node;
    }

    // Process GTS references found in the entity
    const refs = this.extractGtsReferences(entity.content);
    const nodeRefs: any = {};

    for (const ref of refs) {
      // Skip self-references
      if (ref.id === gtsId) {
        continue;
      }
      // Skip JSON Schema meta-schema references
      if (this.isJsonSchemaUrl(ref.id)) {
        continue;
      }
      // Recursively build node for this reference
      nodeRefs[ref.sourcePath] = this.buildSchemaGraphNode(ref.id, seen);
    }

    if (Object.keys(nodeRefs).length > 0) {
      node.refs = nodeRefs;
    }

    // Process schema ID if present
    if (entity.schemaId) {
      if (!this.isJsonSchemaUrl(entity.schemaId)) {
        node.schema_id = this.buildSchemaGraphNode(entity.schemaId, seen);
      }
    } else if (!entity.isSchema) {
      // Instance without schema ID is an error
      node.errors = node.errors || [];
      node.errors.push('Schema not recognized');
    }

    return node;
  }

  private extractGtsReferences(content: any): Array<{ id: string; sourcePath: string }> {
    const refs: Array<{ id: string; sourcePath: string }> = [];
    const seen = new Set<string>();

    const walkAndCollectRefs = (node: any, path: string) => {
      if (node === null || node === undefined) {
        return;
      }

      // Check if current node is a GTS ID string
      if (typeof node === 'string') {
        if (Gts.isValidGtsID(node)) {
          const sourcePath = path || 'root';
          const key = `${node}|${sourcePath}`;
          if (!seen.has(key)) {
            refs.push({ id: node, sourcePath });
            seen.add(key);
          }
        }
        return;
      }

      // Recurse into object
      if (typeof node === 'object' && !Array.isArray(node)) {
        for (const [k, v] of Object.entries(node)) {
          const nextPath = path ? `${path}.${k}` : k;
          walkAndCollectRefs(v, nextPath);
        }
        return;
      }

      // Recurse into array
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          const nextPath = path ? `${path}[${i}]` : `[${i}]`;
          walkAndCollectRefs(node[i], nextPath);
        }
      }
    };

    walkAndCollectRefs(content, '');
    return refs;
  }

  private isJsonSchemaUrl(s: string): boolean {
    return (s.startsWith('http://') || s.startsWith('https://')) && s.includes('json-schema.org');
  }

  /**
   * OP#9 requires the cast response to report `backward_compatibility`,
   * `forward_compatibility` and `full_compatibility` on every response,
   * including failures (gts-spec 0.13 README section 9.2). The early-return
   * paths below - entity not found, schema not found, abstract target - cannot
   * derive a verdict, so they are normalised to `unknown` here rather than in
   * each caller: `GTS.castInstance()`, `GTS.castInstanceRaw()`, the CLI and
   * `POST /cast` all funnel through this one choke point, so a failure path
   * added later inherits the defaults automatically. Mirrors gts-rust
   * `schema_cast.rs::undecided()`.
   */
  castInstance(instanceId: string, toSchemaId: string): any {
    const result = this.castInstanceInner(instanceId, toSchemaId);
    return {
      ...result,
      backward_compatibility: result.backward_compatibility ?? 'unknown',
      forward_compatibility: result.forward_compatibility ?? 'unknown',
      full_compatibility: result.full_compatibility ?? 'unknown',
    };
  }

  private castInstanceInner(instanceId: string, toSchemaId: string): any {
    try {
      // Get instance entity
      const instanceEntity = this.get(instanceId);
      if (!instanceEntity) {
        return {
          instance_id: instanceId,
          to_type_id: toSchemaId,
          ok: false,
          error: `Entity not found: ${instanceId}`,
        };
      }

      // Get target schema
      const toSchema = this.get(toSchemaId);
      if (!toSchema) {
        return {
          instance_id: instanceId,
          to_type_id: toSchemaId,
          ok: false,
          error: `Schema not found: ${toSchemaId}`,
        };
      }

      // Determine source schema
      let fromSchemaId: string;
      let fromSchema: any;
      if (instanceEntity.isSchema) {
        // Not allowed to cast directly from a schema
        return {
          instance_id: instanceId,
          to_type_id: toSchemaId,
          ok: false,
          error: 'Source must be an instance, not a schema',
        };
      } else {
        // Casting an instance - need to find its schema
        fromSchemaId = instanceEntity.schemaId!;
        if (!fromSchemaId) {
          return {
            instance_id: instanceId,
            to_type_id: toSchemaId,
            ok: false,
            error: `Schema not found for instance: ${instanceId}`,
          };
        }
        // Don't try to get a JSON Schema URL as a GTS entity
        if (fromSchemaId.startsWith('http://') || fromSchemaId.startsWith('https://')) {
          return {
            instance_id: instanceId,
            to_type_id: toSchemaId,
            ok: false,
            error: `Cannot cast instance with schema ${fromSchemaId}`,
          };
        }
        fromSchema = this.get(fromSchemaId);
        if (!fromSchema) {
          return {
            instance_id: instanceId,
            to_type_id: toSchemaId,
            ok: false,
            error: `Schema not found: ${fromSchemaId}`,
          };
        }
      }

      // Get content
      const instanceContent = instanceEntity.content;
      const fromSchemaContent = fromSchema.content;
      const toSchemaContent = toSchema.content;

      // A cast that lands on an abstract type would produce an instance the
      // registry could never accept directly (§9.11.3), so reject it here
      // too rather than only at direct instantiation/validation time.
      if (GtsModifiers.isAbstract(toSchemaContent)) {
        return {
          instance_id: instanceId,
          to_type_id: toSchemaId,
          ok: false,
          error: `Cannot cast to abstract type: ${toSchemaId}`,
        };
      }

      // Perform the cast
      return this.performCast(
        instanceId,
        fromSchemaId,
        toSchemaId,
        instanceContent,
        fromSchemaContent,
        toSchemaContent
      );
    } catch (error) {
      return {
        instance_id: instanceId,
        to_type_id: toSchemaId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private performCast(
    fromInstanceId: string,
    fromSchemaId: string,
    toSchemaId: string,
    fromInstanceContent: any,
    fromSchemaContent: any,
    toSchemaContent: any
  ): any {
    // Flatten target schema to merge allOf. `resolveSchemaFully` is the
    // visited-set-protected implementation already used elsewhere in this
    // file; reusing it here avoids a third divergent "flatten a schema" copy
    // and its exponential blowup on diamond-shaped multi-parent hierarchies.
    const targetSchema = this.resolveSchemaFully(toSchemaContent);

    // Determine direction
    // The direction is a property of the two type schemas. Deriving it from
    // the instance identifier compares the instance's own version against the
    // target type and gets the answer wrong.
    const direction = GtsCompatibility.inferDirection(fromSchemaId, toSchemaId);

    // Determine which is old/new based on direction
    let oldSchema: any;
    let newSchema: any;
    switch (direction) {
      case 'upgrade':
        oldSchema = fromSchemaContent;
        newSchema = toSchemaContent;
        break;
      case 'downgrade':
        oldSchema = toSchemaContent;
        newSchema = fromSchemaContent;
        break;
      default:
        oldSchema = fromSchemaContent;
        newSchema = toSchemaContent;
        break;
    }

    // Check evolution compatibility between the two type schemas (spec §4.2).
    // This is computed independently of whether the instance transform below
    // succeeds - a cast that transforms and validates cleanly is not thereby
    // "compatible", and one whose target rejects the transformed instance is
    // not thereby "incompatible": they answer different questions. Mirrors
    // gts-rust `schema_cast.rs::cast()` (`:131-136`), which computes the
    // three verdicts before attempting the cast.
    const { backward, forward } = GtsCompatibility.compareSchemas(this, oldSchema, newSchema);
    const full = GtsCompatibility.fullVerdict(backward, forward);
    const isBackward = backward === 'compatible';
    const isForward = forward === 'compatible';
    const backwardErrors = isBackward ? [] : [`Backward compatibility is ${backward}`];
    const forwardErrors = isForward ? [] : [`Forward compatibility is ${forward}`];

    // Apply casting rules to transform the instance
    const { casted, added, removed, incompatibilityReasons } = this.castInstanceToSchema(
      this.deepCopy(fromInstanceContent),
      targetSchema,
      ''
    );

    // The cast succeeds only if its result satisfies the target type.
    let isFullyCompatible = false;
    if (casted) {
      const validationError = this.validateCastResult(toSchemaContent, casted);
      if (validationError) {
        incompatibilityReasons.push(validationError);
      } else {
        isFullyCompatible = true;
      }
    }

    return {
      from: fromInstanceId,
      to: toSchemaId,
      old: fromInstanceId,
      new: toSchemaId,
      direction,
      added_properties: this.deduplicate(added),
      removed_properties: this.deduplicate(removed),
      changed_properties: [],
      is_fully_compatible: isFullyCompatible,
      is_backward_compatible: isBackward,
      is_forward_compatible: isForward,
      // Three-valued verdicts from the same `GtsCompatibility` machinery
      // `/compatibility` uses, distinct from the booleans above: those
      // report cast success (`is_fully_compatible`) and directional
      // compatibility collapsed to a boolean, neither of which can express
      // `unknown` (e.g. a declared-dialect mismatch).
      backward_compatibility: backward,
      forward_compatibility: forward,
      full_compatibility: full,
      incompatibility_reasons: incompatibilityReasons,
      backward_errors: backwardErrors,
      forward_errors: forwardErrors,
      casted_entity: casted,
      instance_id: fromInstanceId,
      to_type_id: toSchemaId,
      ok: isFullyCompatible,
      error: isFullyCompatible ? '' : incompatibilityReasons.join('; '),
    };
  }

  private castInstanceToSchema(
    instance: any,
    schema: any,
    basePath: string
  ): { casted: any; added: string[]; removed: string[]; incompatibilityReasons: string[] } {
    const added: string[] = [];
    const removed: string[] = [];
    const incompatibilityReasons: string[] = [];

    if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
      incompatibilityReasons.push('Instance must be an object for casting');
      return { casted: null, added, removed, incompatibilityReasons };
    }

    const targetProps = schema.properties || {};
    const required = new Set<string>(schema.required || []);
    const additional = schema.additionalProperties !== false;

    // Start from current values
    const result = this.deepCopy(instance);

    // 1) Ensure required properties exist (fill defaults if provided)
    for (const reqProp of Array.from(required)) {
      if (!(reqProp in result)) {
        const propSchema = targetProps[reqProp as string];
        if (propSchema && propSchema.default !== undefined) {
          result[reqProp as string] = this.deepCopy(propSchema.default);
          const path = this.buildPath(basePath, reqProp as string);
          added.push(path);
        } else {
          const path = this.buildPath(basePath, reqProp as string);
          incompatibilityReasons.push(`Missing required property '${path}' and no default is defined`);
        }
      }
    }

    // 2) For optional properties with defaults, set if missing
    for (const [prop, propSchema] of Object.entries(targetProps)) {
      if (required.has(prop)) {
        continue;
      }
      if (!(prop in result)) {
        const ps = propSchema as any;
        if (ps.default !== undefined) {
          result[prop] = this.deepCopy(ps.default);
          const path = this.buildPath(basePath, prop);
          added.push(path);
        }
      }
    }

    // 2.5) Update const values to match target schema (for GTS ID fields)
    for (const [prop, propSchema] of Object.entries(targetProps)) {
      const ps = propSchema as any;
      if (ps.const !== undefined) {
        const constVal = ps.const;
        const existingVal = result[prop];
        if (typeof constVal === 'string' && typeof existingVal === 'string') {
          // Only update if both are GTS IDs and they differ
          if (Gts.isValidGtsID(constVal) && Gts.isValidGtsID(existingVal)) {
            if (existingVal !== constVal) {
              result[prop] = constVal;
            }
          }
        }
      }
    }

    // 3) Remove properties not in target schema when additionalProperties is false
    if (!additional) {
      for (const prop of Object.keys(result)) {
        if (!(prop in targetProps)) {
          delete result[prop];
          const path = this.buildPath(basePath, prop);
          removed.push(path);
        }
      }
    }

    // 4) Recurse into nested object properties
    for (const [prop, propSchema] of Object.entries(targetProps)) {
      const val = result[prop];
      if (val === undefined) {
        continue;
      }
      const ps = propSchema as any;

      // Handle nested objects. `resolveSchemaFully` - the same, already-
      // correct resolver used for the root cast target above - is used here
      // too, so a nested property whose schema is `{type:'object', allOf:
      // [{$ref: inner}], additionalProperties:false}` gets the ref's
      // properties/defaults, instead of an empty effective schema that
      // silently deletes the instance's own nested data. Whether to recurse
      // is decided from the RESOLVED schema's actual shape - `type` naming
      // `'object'` (directly or in a `type` array), or the mere presence of
      // `properties`/`required`/`additionalProperties` - rather than a
      // literal `propType === 'object'` string comparison, which misses
      // `type: ['object','null']` and schemas that constrain objects without
      // ever stating `type` at all.
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const nestedSchema = this.resolveSchemaFully(ps);
        if (this.describesObjectShape(nestedSchema)) {
          const nestedResult = this.castInstanceToSchema(val, nestedSchema, this.buildPath(basePath, prop));
          result[prop] = nestedResult.casted;
          added.push(...nestedResult.added);
          removed.push(...nestedResult.removed);
          incompatibilityReasons.push(...nestedResult.incompatibilityReasons);
        }
      }

      // Handle arrays of objects
      if (Array.isArray(val)) {
        const itemsSchema = ps?.items;
        if (isPlainSchemaObject(itemsSchema)) {
          const nestedSchema = this.resolveSchemaFully(itemsSchema);
          if (this.describesObjectShape(nestedSchema)) {
            const newList: any[] = [];
            for (let idx = 0; idx < val.length; idx++) {
              const item = val[idx];
              if (item && typeof item === 'object' && !Array.isArray(item)) {
                const nestedResult = this.castInstanceToSchema(
                  item,
                  nestedSchema,
                  this.buildPath(basePath, `${prop}[${idx}]`)
                );
                newList.push(nestedResult.casted);
                added.push(...nestedResult.added);
                removed.push(...nestedResult.removed);
                incompatibilityReasons.push(...nestedResult.incompatibilityReasons);
              } else {
                newList.push(item);
              }
            }
            result[prop] = newList;
          }
        }
      }
    }

    return { casted: result, added, removed, incompatibilityReasons };
  }

  /**
   * Whether a *resolved* nested-property schema (from `resolveSchemaFully`)
   * describes an object worth recursing into during a cast - `type` naming
   * `'object'` (directly, or inside a `type` array such as
   * `['object','null']`), or the mere presence of `properties`/`required`/
   * `additionalProperties` even when `type` is absent entirely. A literal
   * `propType === 'object'` string comparison misses both of the latter
   * cases and skips casting a nested object outright, leaving the instance's
   * stale data and the target's un-materialized defaults untouched.
   */
  private describesObjectShape(resolved: ResolvedSchema): boolean {
    const type = resolved.type;
    const typeNamesObject = type === 'object' || (Array.isArray(type) && type.includes('object'));
    const hasObjectKeywords =
      Object.keys(resolved.properties || {}).length > 0 ||
      (resolved.required || []).length > 0 ||
      resolved.additionalProperties !== undefined;
    return typeNamesObject || hasObjectKeywords;
  }

  /**
   * Validates a cast result against the target type schema, ignoring the
   * identity `const`s that a cast legitimately rewrites (§4.6.3). Returns an
   * error message, or null when the result satisfies the target type.
   */
  validateCastResult(toSchema: any, casted: any): string | null {
    try {
      const modifiedSchema = this.removeGtsConstConstraints(toSchema);
      const validate = this.ajv.compile(this.normalizeSchema(modifiedSchema));
      if (!validate(casted)) {
        // P6-4: shared formatter, so a cast-result failure reads the same
        // way as every other validation path instead of raw Ajv wording.
        return validate.errors?.map((e) => this.formatValidationError(e)).join('; ') || 'Validation failed';
      }

      // `x-gts-ref` is an assertion enforced on instances (§9.6), so a cast
      // result has to satisfy it just as a registered instance would.
      const xGtsRefErrors = new XGtsRefValidator(this).validateInstance(casted, toSchema);
      if (xGtsRefErrors.length > 0) {
        return `x-gts-ref validation failed: ${xGtsRefErrors.map((err) => err.reason).join('; ')}`;
      }

      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private removeGtsConstConstraints(schema: any): any {
    if (schema === null || schema === undefined) {
      return schema;
    }

    if (typeof schema === 'object' && !Array.isArray(schema)) {
      const result: any = {};
      for (const [key, value] of Object.entries(schema)) {
        if (key === 'const') {
          if (typeof value === 'string' && Gts.isValidGtsID(value)) {
            // Replace const with type constraint instead
            result.type = 'string';
            continue;
          }
        }
        result[key] = this.removeGtsConstConstraints(value);
      }
      return result;
    }

    if (Array.isArray(schema)) {
      return schema.map((item) => this.removeGtsConstConstraints(item));
    }

    return schema;
  }

  private buildPath(base: string, prop: string): string {
    if (!base) {
      return prop;
    }
    // Handle array indices that already have brackets
    if (prop.startsWith('[')) {
      return base + prop;
    }
    return base + '.' + prop;
  }

  private deepCopy(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }
    if (typeof obj !== 'object') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.deepCopy(item));
    }
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.deepCopy(value);
    }
    return result;
  }

  private deduplicate(arr: string[]): string[] {
    const unique = Array.from(new Set(arr));
    return unique.sort();
  }

  /**
   * OP#6 `POST /validate-json` (transient JSON validation, spec commit
   * ab1287e) - validates a candidate type schema document WITHOUT
   * registering it. `content` is the raw candidate; `schemaId` is its own
   * `$id` (already extracted and normalized by the caller).
   *
   * Unlike `validateSchemaAgainstParent` below, which looks the schema up by
   * id (so it can only run once the schema is already registered),
   * everything here works from `content` directly: meta-schema validity
   * (`ajv.validateSchema`, deliberately never run at registration time -
   * see the class-level comment on `validateSchema: false` above), the
   * shared document-level rules (`checkTypeSchemaRules`), and - reusing the
   * same base-comparison machinery `validateSchemaAgainstParent` uses -
   * whether the schema is compatible with an ALREADY-registered parent, if
   * its chained `$id` names one. The candidate's own trait completeness
   * (`validateSchemaTraits`) is intentionally not checked here: that method
   * looks every chain level, including `schemaId` itself, up in the
   * registry, which a transient candidate by definition is not in.
   */
  validateTransientSchema(content: any, schemaId: string): ValidationResult {
    try {
      const normalized = this.normalizeSchema(content);
      const metaOk = this.ajv.validateSchema(normalized);
      if (!metaOk) {
        const errors = (this.ajv.errors || []).map((e) => this.formatValidationError(e)).join('; ');
        return { id: schemaId, ok: false, error: `JSON Schema validation failed: ${errors}` };
      }

      // §9.11.5 - the explicit validation endpoints always enforce the guards.
      const ruleError = this.checkTypeSchemaRules(content, schemaId, { enforceGuards: true });
      if (ruleError) {
        return { id: schemaId, ok: false, error: ruleError };
      }

      let chain: string[];
      try {
        chain = this.buildSchemaChain(schemaId);
      } catch (err) {
        return { id: schemaId, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const parentId = chain.length > 1 ? chain[chain.length - 2] : null;
      if (!parentId) {
        // Base schema with no parent - nothing further to compare against.
        return { id: schemaId, ok: true, error: '' };
      }

      const parentEntity = this.get(parentId);
      if (!parentEntity) {
        return { id: schemaId, ok: false, error: `Parent GTS Type Schema not found: ${parentId}` };
      }
      if (!parentEntity.isSchema || !parentEntity.content) {
        return { id: schemaId, ok: false, error: `Parent entity is not a schema: ${parentId}` };
      }

      const cycleError = this.detectRefCycle(schemaId, content, new Set([schemaId]));
      if (cycleError) {
        return { id: schemaId, ok: false, error: cycleError };
      }

      const resolvedParent = this.resolveSchemaFully(parentEntity.content);
      const overlay = this.extractOverlay(content);
      const inheritsViaRef = this.inheritsParentViaRef(content, parentId);
      const errors = this.compareOverlayToBase(overlay, resolvedParent, '', inheritsViaRef);
      if (errors.length > 0) {
        return { id: schemaId, ok: false, error: `Derived schema is not compatible with base: ${errors.join('; ')}` };
      }

      return { id: schemaId, ok: true, error: '' };
    } catch (err) {
      return {
        id: schemaId,
        ok: false,
        error: `Schema validation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private validateSchemaReferenceTargets(node: any, path: string = ''): string | null {
    if (!node || typeof node !== 'object') {
      return null;
    }

    if (typeof node.$ref === 'string' && !node.$ref.startsWith('#')) {
      const refPath = path ? `${path}/$ref` : '$ref';
      if (!node.$ref.startsWith(GTS_URI_PREFIX)) {
        return `Invalid $ref at ${refPath}: expected a local pointer or gts:// URI`;
      }
      const targetId = node.$ref.substring(GTS_URI_PREFIX.length);
      if (!Gts.isValidGtsID(targetId)) {
        return `Invalid $ref at ${refPath}: ${targetId} is not a valid GTS identifier`;
      }
      const target = this.get(targetId);
      if (!target || !target.isSchema) {
        return `Unresolvable $ref at ${refPath}: ${node.$ref}`;
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref') continue;
      const nestedPath = path ? `${path}/${key}` : key;
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          const error = this.validateSchemaReferenceTargets(value[index], `${nestedPath}[${index}]`);
          if (error) return error;
        }
      } else {
        const error = this.validateSchemaReferenceTargets(value, nestedPath);
        if (error) return error;
      }
    }
    return null;
  }

  validateSchemaAgainstParent(schemaId: string): ValidationResult {
    return this.validateSchemaTransitive(schemaId, new Set(), new Map());
  }

  private validateSchemaTransitive(
    schemaId: string,
    visiting: Set<string>,
    completed: Map<string, ValidationResult>
  ): ValidationResult {
    const key = `schema:${schemaId}`;
    const cached = completed.get(key);
    if (cached) return cached;
    if (visiting.has(key)) return { id: schemaId, ok: true, error: '' };

    visiting.add(key);
    const referencedIds = new Set<string>();
    const localResult = this.validateSchemaAgainstParentLocal(schemaId, referencedIds);
    if (!localResult.ok) {
      visiting.delete(key);
      completed.set(key, localResult);
      return localResult;
    }

    const entity = this.get(schemaId)!;
    const chain = this.buildSchemaChain(schemaId);
    for (const ancestorId of chain.slice(0, -1)) {
      const ancestorResult = this.validateSchemaTransitive(ancestorId, visiting, completed);
      if (!ancestorResult.ok) {
        const result = {
          id: schemaId,
          ok: false,
          error: `Ancestor type '${ancestorId}' is invalid: ${ancestorResult.error}`,
        };
        visiting.delete(key);
        completed.set(key, result);
        return result;
      }
    }

    for (const dependencyId of this.collectSchemaDependencies(entity.content)) {
      const dependencyResult = this.validateSchemaTransitive(dependencyId, visiting, completed);
      if (!dependencyResult.ok) {
        const result = {
          id: schemaId,
          ok: false,
          error: `Referenced type '${dependencyId}' is invalid: ${dependencyResult.error}`,
        };
        visiting.delete(key);
        completed.set(key, result);
        return result;
      }
    }

    for (const dependencyId of referencedIds) {
      const dependencyResult = this.validateEntityTransitive(dependencyId, visiting, completed);
      if (!dependencyResult.ok) {
        const result = {
          id: schemaId,
          ok: false,
          error: `Referenced trait entity '${dependencyId}' is invalid: ${dependencyResult.error}`,
        };
        visiting.delete(key);
        completed.set(key, result);
        return result;
      }
    }

    visiting.delete(key);
    completed.set(key, localResult);
    return localResult;
  }

  private validateEntityTransitive(
    entityId: string,
    visiting: Set<string>,
    completed: Map<string, ValidationResult>
  ): ValidationResult {
    const entity = this.get(entityId);
    if (!entity) return { id: entityId, ok: false, error: `Entity not found: ${entityId}` };
    return entity.isSchema
      ? this.validateSchemaTransitive(entityId, visiting, completed)
      : this.validateInstanceTransitive(entityId, visiting, completed);
  }

  private collectSchemaDependencies(node: any, dependencies: Set<string> = new Set()): Set<string> {
    if (!node || typeof node !== 'object') return dependencies;
    if (typeof node.$ref === 'string' && node.$ref.startsWith(GTS_URI_PREFIX)) {
      dependencies.add(node.$ref.substring(GTS_URI_PREFIX.length));
    }
    const xGtsRef = node['x-gts-ref'];
    if (typeof xGtsRef === 'string' && xGtsRef.startsWith('gts.') && !xGtsRef.includes('*')) {
      dependencies.add(xGtsRef);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== '$ref' && key !== 'x-gts-ref') this.collectSchemaDependencies(value, dependencies);
    }
    return dependencies;
  }

  private withoutRequired(node: any): any {
    if (Array.isArray(node)) return node.map((value) => this.withoutRequired(value));
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== 'required')
        .map(([key, value]) => [key, this.withoutRequired(value)])
    );
  }

  private validateSchemaAgainstParentLocal(schemaId: string, referencedIds?: Set<string>): ValidationResult {
    const entity = this.get(schemaId);
    if (!entity) {
      return { id: schemaId, ok: false, error: `Entity not found: ${schemaId}` };
    }
    if (!entity.isSchema) {
      return { id: schemaId, ok: false, error: `Entity is not a schema: ${schemaId}` };
    }

    const content = entity.content;

    // Schemas are registered without meta-validation (`validateSchema: false`
    // above), so a malformed document - e.g. a literal `null` in a schema
    // position - can reach the resolution/comparison machinery below. That
    // makes the check inconclusive, matching `checkCompatibility`'s own
    // try/catch in `compatibility.ts`: it must not take the caller (and, at
    // the HTTP layer, the whole request) down with it.
    try {
      // §9.11.5 - the explicit validation endpoints always enforce the guards.
      const ruleError = this.checkTypeSchemaRules(content, schemaId, { enforceGuards: true });
      if (ruleError) {
        return { id: schemaId, ok: false, error: ruleError };
      }

      const refError = this.validateSchemaReferenceTargets(content);
      if (refError) {
        return { id: schemaId, ok: false, error: refError };
      }

      const xGtsRefErrors = new XGtsRefValidator(this).validateSchemaRefExistence(content);
      if (xGtsRefErrors.length > 0) {
        return {
          id: schemaId,
          ok: false,
          error: `x-gts-ref validation failed: ${xGtsRefErrors.map((error) => error.reason).join('; ')}`,
        };
      }

      // Per ADR-0001 derivation is established by the chained `$id` alone, so the
      // parent is taken from the chain. A body that references the parent via
      // `allOf` + `$ref` and one that restates the parent's fields are both valid
      // derivation forms and are checked identically.
      let chain: string[];
      try {
        chain = this.buildSchemaChain(schemaId);
      } catch (err) {
        return { id: schemaId, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const parentId = chain.length > 1 ? chain[chain.length - 2] : null;
      if (!parentId) {
        // Base schema with no parent → still validate traits
        return this.validateSchemaTraits(schemaId, referencedIds);
      }

      const parentEntity = this.get(parentId);
      if (!parentEntity) {
        return { id: schemaId, ok: false, error: `Parent schema not found: ${parentId}` };
      }
      if (!parentEntity.isSchema || !parentEntity.content) {
        return { id: schemaId, ok: false, error: `Parent entity is not a schema: ${parentId}` };
      }

      // Detect cyclic $ref references in the schema's own content
      const cycleError = this.detectRefCycle(schemaId, content, new Set([schemaId]));
      if (cycleError) {
        return { id: schemaId, ok: false, error: cycleError };
      }

      // Resolve parent's effective (fully flattened) schema
      const resolvedParent = this.resolveSchemaFully(parentEntity.content);

      // Extract overlay from derived schema (non-$ref subschemas in allOf + top-level)
      const overlay = this.extractOverlay(content);

      // Compare overlay against resolved parent
      const inheritsViaRef = this.inheritsParentViaRef(content, parentId);
      const errors = this.compareOverlayToBase(overlay, resolvedParent, '', inheritsViaRef);
      if (errors.length > 0) {
        return { id: schemaId, ok: false, error: errors.join('; ') };
      }

      // OP#13: Validate schema traits across the inheritance chain
      const traitsResult = this.validateSchemaTraits(schemaId, referencedIds);
      if (!traitsResult.ok) {
        return traitsResult;
      }

      return { id: schemaId, ok: true, error: '' };
    } catch (err) {
      return {
        id: schemaId,
        ok: false,
        error: `Schema validation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * OP#13 - trait validation across the `$id` chain (spec §9.7.5, ADR-0002/3/4).
   *
   *   1. effective trait-schema = `allOf` of every top-level `x-gts-traits-schema`
   *      along the chain, root to leaf;
   *   2. effective traits object = every top-level `x-gts-traits` applied in turn
   *      as an RFC 7396 JSON Merge Patch, root to leaf;
   *   3. materialize trait-schema `default`s for properties the merge left absent;
   *   4. for non-abstract types, the materialized object must validate against the
   *      effective trait-schema (the "completeness check").
   *
   * There is no bespoke immutability rule: a publisher locks a trait value with
   * `const` in the trait-schema, which the standard validation in step 4 enforces.
   */
  private validateSchemaTraits(schemaId: string, referencedIds?: Set<string>): ValidationResult {
    let chain: string[];
    try {
      chain = this.buildSchemaChain(schemaId);
    } catch (err) {
      return { id: schemaId, ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const traitSchemas: any[] = [];
    // `x-gts-traits-schema: false` is the "no traits permitted" declaration and
    // makes the aggregate unsatisfiable; tracked separately so that a subtree
    // with no traits at all still validates (ADR-0002).
    let traitsProhibited = false;
    let traitsProhibitedBy: string | null = null;
    // A `true` declaration constrains nothing but still establishes that the
    // chain defines a trait surface, so descendants may carry trait values.
    let hasTraitSchemaDeclaration = false;
    let effectiveTraits: Record<string, any> = {};

    for (const chainSchemaId of chain) {
      const entity = this.get(chainSchemaId);
      if (!entity || !entity.content) continue;
      const content = entity.content;

      const declaredSchema = content['x-gts-traits-schema'];
      if (declaredSchema !== undefined) {
        hasTraitSchemaDeclaration = true;
        if (traitsProhibited && declaredSchema !== false) {
          return {
            id: schemaId,
            ok: false,
            error: `x-gts-traits-schema in '${chainSchemaId}' cannot permit traits because ancestor '${traitsProhibitedBy}' declares false`,
          };
        }
        if (declaredSchema === false) {
          traitsProhibited = true;
          traitsProhibitedBy ??= chainSchemaId;
        } else if (declaredSchema !== true) {
          const isPlainObject =
            typeof declaredSchema === 'object' && declaredSchema !== null && !Array.isArray(declaredSchema);
          if (!isPlainObject) {
            return {
              id: schemaId,
              ok: false,
              error: `x-gts-traits-schema in '${chainSchemaId}' must be an object subschema or a boolean`,
            };
          }
          try {
            traitSchemas.push(this.resolveTraitSchemaRefs(declaredSchema, new Set()));
          } catch (e) {
            return { id: schemaId, ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
      }

      const declaredValues = content['x-gts-traits'];
      if (declaredValues !== undefined) {
        if (typeof declaredValues !== 'object' || declaredValues === null || Array.isArray(declaredValues)) {
          return {
            id: schemaId,
            ok: false,
            error: `x-gts-traits in '${chainSchemaId}' must be an object`,
          };
        }
        effectiveTraits = this.applyMergePatch(effectiveTraits, declaredValues);
      }
    }

    if (!hasTraitSchemaDeclaration) {
      if (Object.keys(effectiveTraits).length > 0) {
        return {
          id: schemaId,
          ok: false,
          error: 'x-gts-traits values provided but no x-gts-traits-schema is defined in the inheritance chain',
        };
      }
      return { id: schemaId, ok: true, error: '' };
    }

    const effectiveSchema: any = traitSchemas.length === 1 ? traitSchemas[0] : { allOf: traitSchemas };
    const materialized = this.applyTraitDefaults(effectiveSchema, effectiveTraits);

    // The effective trait-schema must be satisfiable in the first place. This
    // is a property of the composed schema, so - unlike completeness - it is
    // checked for abstract types too.
    const unsatisfiable = this.validateTraitChainSatisfiability(traitSchemas);
    if (unsatisfiable) {
      return { id: schemaId, ok: false, error: `effective trait schema cannot be satisfied: ${unsatisfiable}` };
    }

    // `x-gts-traits-schema: false` bans traits across the whole subtree, which
    // is a prohibition rather than a completeness requirement - so it applies
    // to abstract members of that subtree too, and is checked before the
    // abstract exemption below.
    if (traitsProhibited && Object.keys(materialized).length > 0) {
      return {
        id: schemaId,
        ok: false,
        error: 'x-gts-traits-schema is false in the inheritance chain, so no traits are permitted',
      };
    }

    // Abstract types are exempt from the *completeness* check (§9.7.5 / ADR-0003):
    // the standard JSON Schema validation of the materialized effective traits -
    // which enforces `required`/`const`/`type`/... - is skipped for them, because
    // a descendant is expected to supply/close the values. The separate x-gts-ref
    // reference-resolution rule (§9.7.5) does NOT exempt abstract types and still
    // runs below, so an abstract type's declared references must resolve.
    const self = this.get(schemaId);
    const isAbstract = !!(self && GtsModifiers.isAbstract(self.content));

    if (traitSchemas.length === 0) {
      return { id: schemaId, ok: true, error: '' };
    }

    try {
      const schemaForValidation = isAbstract ? this.withoutRequired(effectiveSchema) : effectiveSchema;
      const validate = this.ajv.compile(this.normalizeSchema(schemaForValidation));
      if (!validate(materialized)) {
        const errors =
          validate.errors?.map((e) => this.formatValidationError(e)).join('; ') || 'Trait validation failed';
        return { id: schemaId, ok: false, error: `trait validation: ${errors}` };
      }
    } catch (e) {
      return {
        id: schemaId,
        ok: false,
        error: `failed to compile trait schema: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // `x-gts-ref` is an assertion keyword (§9.6) that plain Ajv validation
    // ignores, so materialized trait values must also be checked against it
    // explicitly - mirroring the same check applied to cast results above.
    // The store is passed here (as `this`, matching the instance-side check
    // above) so that registry existence is enforced too, not just GTS-ID
    // pattern/format validity: gts-spec v0.13.3 issue #107 reverses the
    // earlier "trait values are schema-level example/default data, not live
    // references" rationale - a syntactically valid, correctly-prefixed
    // `x-gts-traits` value that names an unregistered entity must now fail
    // validation, the same as any other `x-gts-ref`. This is not gated on
    // `validateRefs`: that option only governs the separate live-reference
    // checks in `register()`/instance validation, and the canonical
    // conformance case (`TestCaseOp13_TraitRef_TopicRefNonexistent`) expects
    // the registry-existence check to still run under `validateRefs: false`
    // (the same configuration the server uses). The check itself
    // (`XGtsRefValidator.validateGtsPattern`) only fires once the type an
    // `x-gts-ref` names is itself registered, so purely documentary
    // references to a never-registered namespace (e.g. the canonical
    // `TestCaseOp13_TraitsValid_AllResolved` et al, which reference
    // `gts.x.core.events.topic.v1~` only as a pattern) are unaffected.
    const xGtsRefValidator = new XGtsRefValidator(this);

    // Beyond checking supplied values, a concrete x-gts-ref declared in the
    // effective trait schema must itself name a registered constraint type -
    // even when no value is provided. gts-spec §9.6 leaves existence checking to
    // the implementation; the reference implementation rejects a dangling
    // x-gts-ref target (like a dangling $ref). Wildcards/pointers are skipped.
    const refExistenceErrors = xGtsRefValidator.validateSchemaRefExistence(effectiveSchema);
    if (refExistenceErrors.length > 0) {
      return {
        id: schemaId,
        ok: false,
        error: `x-gts-ref validation failed: ${refExistenceErrors.map((err) => err.reason).join('; ')}`,
      };
    }

    const xGtsRefErrors = xGtsRefValidator.validateInstance(materialized, effectiveSchema);
    if (xGtsRefErrors.length > 0) {
      return {
        id: schemaId,
        ok: false,
        error: `x-gts-ref validation failed: ${xGtsRefErrors.map((err) => err.reason).join('; ')}`,
      };
    }
    for (const dependencyId of xGtsRefValidator.getReferencedIds()) {
      referencedIds?.add(dependencyId);
    }

    return { id: schemaId, ok: true, error: '' };
  }

  /**
   * Checks that the `allOf` composition of the chain's trait-schema branches
   * leaves every declared trait property expressible (§9.7.5, "if the effective
   * trait schema cannot be satisfied ... schema validation MUST fail").
   *
   * Faithful port of gts-rust's `schema_traits::validate_trait_schema_compatibility`,
   * which - for each level `i` of the chain - builds `ancestor` and `descendant`
   * as `{allOf: [...]}` wrappers over the chain prefixes `[0..i)` / `[0..i+1)`
   * and runs TWO separate checks against them:
   *
   *   1. `schema_derivation::validate_closed_descendant_branches` - a raw,
   *      structural walk (recursing into every shared property, and into the
   *      descendant's own `allOf`) that finds a closed `allOf` branch, at any
   *      depth, orphaning a property an earlier branch declared. Ported here
   *      as `collectClosedBranchOrphanErrors`, fed by `resolveSchemaFully`
   *      (this file's `flatten_schema` analog) flattening the ancestor
   *      prefix once per chain level, per gts-rust's own
   *      `validate_closed_descendant_branches` entry point. Deliberately NOT
   *      gated on required-ness: orphaning any property via a closed
   *      conjunct, required or not, always makes that conjunct reject a
   *      value the other allows.
   *
   *   2. `schema_derivation::validate_derivation` - "does the descendant's
   *      *declared* schema stay included in the ancestor's *declared* schema".
   *      Ported here via `declaredTraitSchema` (a faithful port of
   *      `declared_schema`/`absorb_declaration`/`absorb_property`/
   *      `merge_additional_properties_constraint`) plus the existing, already
   *      verified `GtsCompatibility.compareSchemas` as the accepted-set-
   *      inclusion checker (gts-rust's `check_accepted_set_inclusion`). Also
   *      ports `collect_disabled_base_properties`, the one admission rule
   *      `validate_derivation` runs alongside inclusion that inclusion itself
   *      does not express (disabling an inherited property narrows the
   *      accepted set, so plain subsumption lets it through).
   *
   * Returns a description of the first problem found, or null when satisfiable.
   */
  private validateTraitChainSatisfiability(traitSchemas: any[]): string | null {
    // Each chain level's OWN internal composition must be self-satisfiable
    // FIRST - e.g. a single trait-schema document declared as
    // `{allOf:[{properties:{k:{const:'a'}}},{properties:{k:{const:'b'}}}]}`
    // is unsatisfiable all by itself, with no ancestor involved at all. The
    // between-level loop below only ever checks narrowing steps BETWEEN
    // chain levels, so a chain with exactly one trait-schema level (or any
    // level whose own document combines multiple `allOf` branches) would
    // otherwise never have this internal conflict checked. `allOf` nesting
    // is associative, so this runs the identical prefix-narrowing check used
    // between levels over each level's own flattened branch list instead.
    for (const levelSchema of traitSchemas) {
      const branches = this.flattenAllOfBranches(levelSchema);
      for (let j = 1; j < branches.length; j++) {
        const error = this.checkNarrowingStep(branches.slice(0, j), branches.slice(0, j + 1), 'j');
        if (error) return error;
      }
    }

    // Both checks run per chain level - `ancestor = chain[0..i)`,
    // `descendant = chain[0..i+1)` - matching gts-rust's own loop
    // (`validate_trait_schema_compatibility`), rather than over the whole
    // chain's flattened `allOf` branches at once.
    for (let i = 1; i < traitSchemas.length; i++) {
      const error = this.checkNarrowingStep(traitSchemas.slice(0, i), traitSchemas.slice(0, i + 1), 'level');
      if (error) return error;
    }

    return null;
  }

  /**
   * One narrowing step of the satisfiability check - "is `descendantBranches`
   * (the ancestor prefix plus one more branch) still a valid narrowing of
   * `ancestorBranches` (the prefix alone)". Shared between the between-level
   * chain loop and the within-level internal-`allOf` loop in
   * `validateTraitChainSatisfiability`, which are the same check run over two
   * different granularities of "prefix of branches" - one chain level at a
   * time, or one `allOf` branch at a time.
   */
  private checkNarrowingStep(ancestorBranches: any[], descendantBranches: any[], unitLabel: string): string | null {
    // 1) Closed-branch orphan check - raw/structural, unconditional on
    // required-ness (see the class-level doc comment on this method's
    // caller). `ancestorFlat` is the ancestor prefix flattened ONCE
    // (gts-rust's `flatten_schema`, i.e. this file's `resolveSchemaFully`);
    // the descendant prefix is passed RAW so the recursion can walk its own
    // `allOf` directly.
    const ancestorFlat = this.resolveSchemaFully({ allOf: ancestorBranches });
    const descendantRaw = { allOf: descendantBranches };
    const orphanErrors = this.collectClosedBranchOrphanErrors(ancestorFlat, descendantRaw, '', 0);
    if (orphanErrors.length > 0) {
      return orphanErrors.join('; ');
    }

    // 2) Declared-schema-fold + accepted-set-inclusion check.
    const ancestorDeclared = this.declaredTraitSchema({ allOf: ancestorBranches }, 0);
    const descendantDeclared = this.declaredTraitSchema({ allOf: descendantBranches }, 0);

    const disabledError = this.findDisabledBaseProperty(ancestorDeclared, descendantDeclared);
    if (disabledError) {
      return disabledError;
    }

    // `forward`: Valid(descendantDeclared) ⊆ Valid(ancestorDeclared) - the
    // inclusion direction §9.7.5 requires. Only a proven `incompatible`
    // verdict is a genuine, demonstrated failure to satisfy; §9.7.5 requires
    // a *demonstrated* failure to reject a trait chain, and the
    // compatibility engine's `unknown` means "this keyword is not modeled",
    // not "this narrowing is wrong" - `compareUnmodeled()` returns `unknown`
    // for any keyword outside the `KEYWORDS` table (e.g. `pattern`,
    // `multipleOf`, a vendor `x-*` keyword, or GTS's own `x-gts-ref`), so
    // treating it the same as `incompatible` here would hard-reject entirely
    // ordinary narrowings the engine simply cannot verify either way.
    const { forward } = GtsCompatibility.compareSchemas(this, ancestorDeclared, descendantDeclared);
    if (forward === 'incompatible') {
      const index = descendantBranches.length - 1;
      return `trait-schema ${unitLabel} ${index} is not a valid narrowing of the preceding effective trait schema (${forward})`;
    }
    return null;
  }

  /**
   * Flattens one chain level's own `allOf` composition into its constituent
   * branches, recursively (`{allOf:[A,{allOf:[B,C]}]}` is equivalent to
   * `{allOf:[A,B,C]}` under JSON Schema's associative `allOf` semantics), so
   * the internal-satisfiability loop above can walk them the same way the
   * between-level loop walks chain levels. Any keywords declared alongside
   * `allOf` at the same level still constrain the composed value, so they are
   * kept as their own trailing branch.
   */
  private flattenAllOfBranches(schema: any): any[] {
    if (!isPlainSchemaObject(schema) || !Array.isArray(schema.allOf)) {
      return [schema];
    }
    const { allOf, ...rest } = schema;
    const branches: any[] = [];
    for (const branch of allOf) {
      branches.push(...this.flattenAllOfBranches(branch));
    }
    if (Object.keys(rest).length > 0) {
      branches.push(rest);
    }
    return branches;
  }

  /**
   * Faithful port of gts-rust's `collect_closed_descendant_branch_errors`
   * (`schema_derivation.rs`): a descendant branch that closes itself with
   * `additionalProperties: false` must restate every property the flattened
   * ancestor declared, or the closed branch rejects a value the ancestor
   * allows once composed via `allOf` - checked at every depth, not only the
   * top level, since a closed branch nested inside a shared property's own
   * value constrains that same object instance just as directly.
   *
   * `ancestorFlat` is flattened ONCE by the caller and re-flattened here only
   * for the property this call recurses into (mirroring gts-rust's own
   * `flatten_schema(ancestor_prop)` at each level); `descendantRaw` is walked
   * as authored so its own `allOf` branches are visited directly.
   */
  private collectClosedBranchOrphanErrors(
    ancestorFlat: ResolvedSchema,
    descendantRaw: any,
    path: string,
    depth: number
  ): string[] {
    const errors: string[] = [];
    if (depth >= MAX_SCHEMA_DEPTH) {
      errors.push(
        `closed-branch orphan check at '${path || '<root>'}' exceeds ${MAX_SCHEMA_DEPTH} levels and cannot be resolved`
      );
      return errors;
    }
    if (typeof descendantRaw !== 'object' || descendantRaw === null || Array.isArray(descendantRaw)) {
      return errors;
    }

    const ancestorProps = ancestorFlat.properties || {};
    const descendantProps: Record<string, any> = descendantRaw.properties || {};

    if (descendantRaw.additionalProperties === false) {
      const orphaned = Object.keys(ancestorProps)
        .filter((name) => ancestorProps[name] !== false && !(name in descendantProps))
        .sort();
      for (const name of orphaned) {
        const fullPath = path ? `${path}.${name}` : name;
        errors.push(
          `Property '${fullPath}' is declared in a preceding trait-schema branch but excluded by additionalProperties: false`
        );
      }
    }

    const commonNames = Object.keys(descendantProps)
      .filter((name) => name in ancestorProps)
      .sort();
    for (const name of commonNames) {
      const nextAncestorFlat = this.resolveSchemaFully(ancestorProps[name]);
      const nextPath = path ? `${path}.${name}` : name;
      errors.push(
        ...this.collectClosedBranchOrphanErrors(nextAncestorFlat, descendantProps[name], nextPath, depth + 1)
      );
    }

    if (Array.isArray(descendantRaw.allOf)) {
      for (const item of descendantRaw.allOf) {
        errors.push(...this.collectClosedBranchOrphanErrors(ancestorFlat, item, path, depth + 1));
      }
    }

    return errors;
  }

  /**
   * Faithful port of gts-rust's `collect_disabled_base_properties`: rejects a
   * descendant trait-schema level that switches an ancestor-declared property
   * off with `false`. Plain accepted-set inclusion permits this (rejecting
   * every instance that carries the property keeps the descendant's accepted
   * set inside the ancestor's), but disabling an inherited property is not a
   * valid narrowing of the trait-schema chain, so this is a separate
   * admission rule rather than a compatibility one.
   */
  private findDisabledBaseProperty(ancestorDeclared: any, descendantDeclared: any): string | null {
    const ancestorProps =
      ancestorDeclared && typeof ancestorDeclared === 'object' ? ancestorDeclared.properties || {} : {};
    const descendantProps =
      descendantDeclared && typeof descendantDeclared === 'object' ? descendantDeclared.properties || {} : {};
    for (const [name, property] of Object.entries(descendantProps)) {
      if (property === false && ancestorProps[name] !== undefined) {
        return `property '${name}': trait-schema disables a property defined by a preceding trait-schema level`;
      }
    }
    return null;
  }

  /**
   * Faithful port of gts-rust's `declared_schema`/`absorb_declaration` (see
   * `schema_derivation.rs`): reduces a schema to what it *declares*, folding
   * `allOf` branches in order so that a later declaration of a property's own
   * (non-structural) keywords replaces earlier ones - a level that restates a
   * property redeclares that property's value constraints outright, it does
   * not intersect with what came before. Object structure (`properties`,
   * `required`, `additionalProperties`) composes instead, via `absorbProperty`
   * / `mergeAdditionalPropertiesConstraint`.
   *
   * Below `MAX_SCHEMA_DEPTH` the schema is returned as authored, matching
   * gts-rust's own fail-closed choice: an unreduced declaration reads as
   * looser than it is to the inclusion checker, so recursing further would
   * only affect how conservative the rejection is, never turn a real problem
   * into a false pass.
   */
  private declaredTraitSchema(schema: any, depth: number = 0): any {
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      return schema;
    }
    if (depth >= MAX_SCHEMA_DEPTH) {
      return schema;
    }

    const declared: Record<string, any> = {};
    const additionalProperties: { value?: any } = {};

    if (Array.isArray(schema.allOf)) {
      for (const branch of schema.allOf) {
        const declaredBranch = this.declaredTraitSchema(branch, depth + 1);
        if (typeof declaredBranch === 'object' && declaredBranch !== null && !Array.isArray(declaredBranch)) {
          this.absorbDeclaration(declared, additionalProperties, declaredBranch, depth);
        }
      }
    }
    this.absorbDeclaration(declared, additionalProperties, schema, depth);

    if ('value' in additionalProperties) {
      declared.additionalProperties = additionalProperties.value;
    }

    return declared;
  }

  /** Folds one declaration level into the accumulated one (see `declaredTraitSchema`). */
  private absorbDeclaration(
    declared: Record<string, any>,
    additionalProperties: { value?: any },
    source: Record<string, any>,
    depth: number
  ): void {
    for (const [keyword, value] of Object.entries(source)) {
      switch (keyword) {
        case 'allOf':
          break;
        case 'additionalProperties':
          this.mergeAdditionalPropertiesConstraint(additionalProperties, value);
          break;
        case 'properties': {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) break;
          const target: Record<string, any> = (declared.properties = declared.properties || {});
          for (const [name, property] of Object.entries(value)) {
            const resolvedProperty = this.declaredTraitSchema(property, depth + 1);
            if (target[name] !== undefined) {
              this.absorbProperty(target, name, resolvedProperty, depth + 1);
            } else {
              target[name] = resolvedProperty;
            }
          }
          break;
        }
        case 'required': {
          if (!Array.isArray(value)) break;
          const target: string[] = (declared.required = declared.required || []);
          for (const name of value) {
            if (!target.includes(name)) target.push(name);
          }
          break;
        }
        default:
          // Later declaration of the same keyword wins (overwrite).
          declared[keyword] = value;
      }
    }
  }

  /**
   * Faithful port of gts-rust's `absorb_property`: folds an overlay's
   * declaration of a property into the one inherited from an earlier `allOf`
   * branch. The overlay's own non-structural keywords replace the inherited
   * ones wholesale (a restated property redeclares its value constraints, it
   * does not inherit an unrestated bound), while `properties`/`required`/
   * `additionalProperties` compose structurally by re-folding the overlay's
   * own structural keys on top of the inherited ones via `absorbDeclaration`.
   */
  private absorbProperty(target: Record<string, any>, name: string, overlay: any, depth: number): void {
    const inherited = target[name];
    const inheritedIsObject = typeof inherited === 'object' && inherited !== null && !Array.isArray(inherited);
    const overlayIsObject = typeof overlay === 'object' && overlay !== null && !Array.isArray(overlay);

    if (depth >= MAX_SCHEMA_DEPTH || !inheritedIsObject || !overlayIsObject) {
      target[name] = overlay;
      return;
    }

    const composed: Record<string, any> = {};
    for (const [keyword, value] of Object.entries(overlay)) {
      if (!TRAIT_STRUCTURAL_KEYWORDS.includes(keyword)) {
        composed[keyword] = value;
      }
    }

    const additionalProperties: { value?: any } = {};
    if (inherited.additionalProperties !== undefined) {
      additionalProperties.value = inherited.additionalProperties;
    }
    for (const keyword of ['properties', 'required']) {
      if (inherited[keyword] !== undefined) {
        composed[keyword] = inherited[keyword];
      }
    }

    this.absorbDeclaration(composed, additionalProperties, overlay, depth);

    if ('value' in additionalProperties) {
      composed.additionalProperties = additionalProperties.value;
    }

    target[name] = composed;
  }

  /**
   * Faithful port of gts-rust's `merge_additional_properties_constraint`: a
   * closedness-preserving lattice over `additionalProperties` values - a
   * schema equivalent to `false` (closed) always wins, a schema equivalent to
   * `true` (open) never overrides an existing constraint, and anything else
   * replaces the accumulated value. Mirrors `allOf` composition, where the
   * level stays closed if ANY branch gives `additionalProperties` a
   * false-equivalent schema, so a permissive overlay can never loosen a
   * closed ancestor.
   */
  private mergeAdditionalPropertiesConstraint(accumulated: { value?: any }, candidate: any): void {
    const currentBool = 'value' in accumulated ? this.schemaBooleanValue(accumulated.value) : undefined;
    if (currentBool === false) return; // already closed, stays closed
    const candidateBool = this.schemaBooleanValue(candidate);
    if (candidateBool === true && 'value' in accumulated) return; // intersecting with `true` changes nothing
    accumulated.value = candidate;
  }

  /** `true`/`false` when `schema` is boolean-equivalent, `undefined` otherwise. */
  private schemaBooleanValue(schema: any): boolean | undefined {
    if (schema === false) return false;
    if (isEmptySchema(schema)) return true;
    return undefined;
  }

  /**
   * Returns a description when the `const` / `enum` value sets across
   * subschemas leave no value that satisfies every branch.
   */
  private findValueConflict(subSchemas: any[]): string | null {
    let allowed: any[] | null = null;
    const seen: string[] = [];

    for (const subSchema of subSchemas) {
      if (typeof subSchema !== 'object' || subSchema === null) continue;

      let values: any[] | null = null;
      if ('const' in subSchema) values = [subSchema.const];
      else if (Array.isArray(subSchema.enum)) values = subSchema.enum;
      if (values === null) continue;

      seen.push(JSON.stringify(values));
      if (allowed === null) {
        allowed = values;
        continue;
      }
      allowed = allowed.filter((a) => values.some((b) => JSON.stringify(a) === JSON.stringify(b)));
      if (allowed.length === 0) {
        return `no value satisfies every declared const/enum (${seen.join(' vs ')})`;
      }
    }

    return null;
  }

  /**
   * JSON Merge Patch (RFC 7396): objects merge recursively, every other value
   * replaces wholesale, and a `null` deletes the key.
   */
  private applyMergePatch(target: Record<string, any>, patch: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = { ...target };

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete result[key];
        continue;
      }
      if (typeof value === 'object' && !Array.isArray(value)) {
        const current = result[key];
        const base = typeof current === 'object' && current !== null && !Array.isArray(current) ? current : {};
        result[key] = this.applyMergePatch(base, value);
        continue;
      }
      result[key] = value;
    }

    return result;
  }

  // Build the schema chain from base to leaf for a given schema ID
  /**
   * The document-level GTS rules for a type schema (§9.7.1, §9.11), in one
   * place so that every entry point enforces the same set.
   *
   * A malformed modifier declaration always fails: the document cannot be
   * interpreted at all. The remaining rules are the "guards" of §9.11.5 - they
   * run when validation is enabled at registration, and unconditionally on the
   * explicit validation endpoints.
   *
   * Returns an error message, or null when the document passes.
   */
  checkTypeSchemaRules(content: any, id: string | undefined, options: { enforceGuards: boolean }): string | null {
    const declarationError = GtsModifiers.validateDeclaration(content);
    if (declarationError) {
      return declarationError;
    }

    if (!options.enforceGuards) {
      return null;
    }

    const misplaced = GtsModifiers.findMisplacedKeywords(content);
    if (misplaced.length > 0) {
      return `document-level GTS keywords must appear at the schema top level; found at: ${misplaced.join(', ')}`;
    }

    const unknown = GtsModifiers.findUnknownKeywords(content);
    if (unknown.length > 0) {
      return `unsupported x-gts-* schema keyword(s) found at: ${unknown.join(', ')}`;
    }

    // `register()` rejects a malformed id up front, so `findFinalBaseInChain`
    // should never actually throw here; the catch only keeps this
    // string-or-null-returning check from turning into an uncaught exception
    // if that invariant is ever violated.
    let finalBase: string | null;
    try {
      finalBase = id ? this.findFinalBaseInChain(id) : null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    if (finalBase) {
      return `base type '${finalBase}' is final and cannot be extended`;
    }

    return null;
  }

  /**
   * The document-level GTS rule for an instance: its rightmost type must be
   * instantiable (§9.11.3 item 1). Returns an error message, or null.
   */
  checkInstanceRules(typeId: string | null | undefined): string | null {
    if (typeId && this.isAbstractType(typeId)) {
      return `Type '${typeId}' is abstract and cannot be directly instantiated`;
    }
    return null;
  }

  /**
   * Returns the id of the first base type in the `$id` chain of `schemaId` that
   * is marked `x-gts-final`, or null when the chain is derivable (§9.11.2).
   *
   * Determined from the chained `$id` alone, so it holds regardless of whether
   * the derived body uses `allOf` + `$ref` or restates the parent's fields.
   * Only proper ancestors are considered: a type being final does not
   * invalidate itself.
   */
  findFinalBaseInChain(schemaId: string): string | null {
    const chain = this.buildSchemaChain(schemaId);
    for (const baseId of chain.slice(0, -1)) {
      const baseEntity = this.get(baseId);
      if (baseEntity && baseEntity.isSchema && GtsModifiers.isFinal(baseEntity.content)) {
        return baseId;
      }
    }
    return null;
  }

  /** True when `typeId` resolves to a registered type marked `x-gts-abstract` (§9.11.3). */
  isAbstractType(typeId: string): boolean {
    const normalized = typeId.startsWith(GTS_URI_PREFIX) ? typeId.substring(GTS_URI_PREFIX.length) : typeId;
    const entity = this.get(normalized);
    return !!entity && entity.isSchema && GtsModifiers.isAbstract(entity.content);
  }

  private buildSchemaChain(schemaId: string): string[] {
    // Parse the schema ID to get segments
    try {
      const gtsId = Gts.parseGtsID(schemaId);
      const segments = gtsId.segments;
      const chain: string[] = [];

      for (let i = 0; i < segments.length; i++) {
        const id =
          'gts.' +
          segments
            .slice(0, i + 1)
            .map((s) => s.segment)
            .join('');
        chain.push(id);
      }

      return chain;
    } catch (err) {
      // Returning a truncated (or single-element) chain would silently hide
      // every ancestor of `schemaId` from the caller, which then fails open
      // by treating the entity as if it had no parent/trait-schema/final-base
      // ancestors at all - so, like `resolveTraitSchemaRefs`'s depth guard
      // above, the caller is told instead of being handed a permissive
      // fallback. `register()` rejects malformed ids up front, so this
      // should be unreachable in practice.
      throw new Error(`Cannot build schema chain for '${schemaId}': ${err instanceof Error ? err.message : err}`);
    }
  }

  // Resolve $ref inside a trait schema, detecting cycles
  //
  // `pathBudget` bounds the total number of `$ref` follows and `allOf` branch
  // recursions taken across the whole top-level call, not just the depth of
  // any one chain. `MAX_SCHEMA_DEPTH` alone only bounds how deep a single
  // chain can go; it does nothing to stop a diamond-shaped `allOf`/`$ref`
  // DAG (level N reaching both level N-1 and N-2, which themselves both
  // reach a shared ancestor) from being walked once per root-to-leaf path
  // through it - a count that doubles per level and can reach the millions
  // within `MAX_SCHEMA_DEPTH`. This function's own tree-walk is cheap even
  // at that path count (well under a second - see the shared MAX_SCHEMA_PATHS'
  // budget below), but the resulting *inlined* schema handed to Ajv is not:
  // Ajv's compiled validator has one function-call node per occurrence, so
  // validating even a single instance against it becomes exponential too.
  // A mutable holder (rather than a primitive `count`) is used so every
  // recursive call increments the SAME counter, matching how `visited` is
  // threaded per-path but in the opposite sense - shared across all paths,
  // not cloned per branch.
  private resolveTraitSchemaRefs(
    schema: any,
    visited: Set<string>,
    depth: number = 0,
    pathBudget: { count: number } = { count: 0 }
  ): any {
    // Returning the unresolved schema would silently drop the constraints
    // behind the remaining refs, so the caller is told instead.
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new Error(`x-gts-traits-schema nests deeper than ${MAX_SCHEMA_DEPTH} levels and cannot be resolved`);
    }
    if (typeof schema !== 'object' || schema === null) return schema;

    const result: any = {};

    for (const [key, value] of Object.entries(schema)) {
      if (key === '$ref') {
        const refUri = value as string;
        const refId = refUri.startsWith(GTS_URI_PREFIX) ? refUri.substring(GTS_URI_PREFIX.length) : refUri;

        // `visited` tracks the active recursion path, not every reference seen
        // anywhere: two siblings may legitimately point at the same trait
        // schema, and only a reference back into its own ancestry is a cycle.
        if (visited.has(refId)) {
          throw new Error(`Cyclic reference detected in trait schema: ${refId}`);
        }

        pathBudget.count++;
        if (pathBudget.count > MAX_SCHEMA_PATHS) {
          throw new Error(
            `x-gts-traits-schema reference graph has too many composition paths (exceeds ${MAX_SCHEMA_PATHS}) and cannot be resolved`
          );
        }

        const refEntity = this.get(refId);
        if (!refEntity || !refEntity.content) {
          throw new Error(`Unresolvable trait schema reference: ${refUri}`);
        }
        const resolved = this.resolveTraitSchemaRefs(
          refEntity.content,
          new Set(visited).add(refId),
          depth + 1,
          pathBudget
        );
        // Merge resolved content into result
        for (const [rk, rv] of Object.entries(resolved)) {
          if (rk !== '$id' && rk !== '$schema') {
            result[rk] = rv;
          }
        }
        continue;
      }

      if (key === 'allOf' && Array.isArray(value)) {
        // Each branch gets its own path, so sibling branches may reuse a ref.
        result.allOf = (value as any[]).map((item) => {
          pathBudget.count++;
          if (pathBudget.count > MAX_SCHEMA_PATHS) {
            throw new Error(
              `x-gts-traits-schema reference graph has too many composition paths (exceeds ${MAX_SCHEMA_PATHS}) and cannot be resolved`
            );
          }
          return this.resolveTraitSchemaRefs(item, new Set(visited), depth + 1, pathBudget);
        });
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.resolveTraitSchemaRefs(value, new Set(visited), depth + 1, pathBudget);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  // Apply defaults from trait schema to trait values
  /**
   * Materializes trait-schema `default`s into the effective traits object
   * before the completeness check (§9.7.5, ADR-0003).
   *
   * Recursive: a default declared on a nested trait property is materialized
   * too, provided its containing object is present or itself materialized.
   * Applying only top-level defaults left `routing.topic` unresolved and the
   * completeness check then failed on a trait the schema had already answered.
   */
  private applyTraitDefaults(schema: any, traits: Record<string, any>, depth: number = 0): Record<string, any> {
    if (depth > MAX_SCHEMA_DEPTH) return traits;

    const result = { ...traits };
    const { properties, required } = this.collectTraitSurface(schema);

    for (const [propName, propSchema] of Object.entries(properties)) {
      if (typeof propSchema !== 'object' || propSchema === null) continue;

      // Already carries a value: fill in whatever its own subtree defaults.
      if (propName in result) {
        const current = result[propName];
        if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
          result[propName] = this.applyTraitDefaults(propSchema, current, depth + 1);
        }
        continue;
      }

      if ('default' in propSchema) {
        result[propName] = propSchema.default;
        continue;
      }

      // No `default` of its own. ADR-0003 licenses materializing defaults, not
      // inventing values, so an absent *optional* object stays absent -
      // conjuring one would validate a subtree the author never supplied and
      // could fail a type that is legitimately incomplete there. An absent
      // *required* object is filled from its subtree; whatever the subtree
      // cannot supply is then a genuine completeness failure.
      if (required.has(propName)) {
        const nested = this.applyTraitDefaults(propSchema, {}, depth + 1);
        if (Object.keys(nested).length > 0) result[propName] = nested;
      }
    }

    return result;
  }

  /**
   * The declared surface of a trait schema at one level - its properties and
   * which of them are required - with `allOf` branches merged in.
   *
   * Both are collected together so that a caller can never read a merged
   * property list against a stale or differently-merged `required` list.
   *
   * A property can be redeclared by more than one contributing branch (the
   * schema's own `properties` and each `allOf` branch, recursively) - real
   * `allOf` semantics require a value to satisfy every branch independently,
   * not just the last one written, so merging by wholesale-replacing an
   * earlier branch's subschema with a later one silently drops whatever the
   * earlier branch declared and the later branch did not repeat (most
   * notably `default`). Every branch's subschema for a name is accumulated
   * and combined via `mergeTraitPropertySchemas` instead.
   */
  private collectTraitSurface(
    schema: any,
    depth: number = 0
  ): { properties: Record<string, any>; required: Set<string> } {
    const { declaredBy, required } = this.collectTraitDeclarations(schema, depth);

    const properties: Record<string, any> = {};
    for (const [name, subSchemas] of declaredBy) {
      properties[name] = subSchemas.length === 1 ? subSchemas[0] : this.mergeTraitPropertySchemas(subSchemas);
    }

    return { properties, required };
  }

  /**
   * The raw, per-branch-unmerged form `collectTraitSurface` collapses into
   * its `properties` map: every subschema any branch (recursively through
   * its own `allOf`) declares for a property name, kept as separate list
   * entries rather than merged into one value.
   *
   * `collectTraitSurface` collapses this for `applyTraitDefaults`, which only
   * ever needs one schema per name to read `default` from and recurse into.
   * (Trait-schema chain *satisfiability* is a separate concern, answered by
   * `validateTraitChainSatisfiability` via `resolveSchemaFully` /
   * `compareOverlayToBase` instead of this flattening.)
   */
  private collectTraitDeclarations(
    schema: any,
    depth: number = 0
  ): { declaredBy: Map<string, any[]>; required: Set<string> } {
    const declaredBy = new Map<string, any[]>();
    const required = new Set<string>();
    if (depth > MAX_SCHEMA_DEPTH || typeof schema !== 'object' || schema === null) {
      return { declaredBy, required };
    }

    const addBranchProperties = (props: Record<string, any>) => {
      for (const [name, subSchema] of Object.entries(props)) {
        const existing = declaredBy.get(name);
        if (existing) existing.push(subSchema);
        else declaredBy.set(name, [subSchema]);
      }
    };

    if (typeof schema.properties === 'object' && schema.properties !== null) {
      addBranchProperties(schema.properties);
    }
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === 'string') required.add(name);
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const item of schema.allOf) {
        const branch = this.collectTraitDeclarations(item, depth + 1);
        for (const [name, subSchemas] of branch.declaredBy) {
          const existing = declaredBy.get(name);
          if (existing) existing.push(...subSchemas);
          else declaredBy.set(name, [...subSchemas]);
        }
        for (const name of branch.required) required.add(name);
      }
    }

    return { declaredBy, required };
  }

  /**
   * Combines more than one branch's subschema for the same property name
   * into one schema that `applyTraitDefaults` can read.
   *
   * `applyTraitDefaults` looks for a `default` directly on the property
   * schema it's given, then recurses into that same schema as a sub-schema
   * for nested properties/required. Wrapping the branches in `{ allOf: [...] }`
   * gives the recursive call everything it needs (nested `properties` and
   * `required` still resolve correctly, since `collectTraitSurface` already
   * knows how to flatten `allOf`); the one piece `allOf` doesn't surface for
   * a direct read is `default`, so it's hoisted onto the wrapper too.
   *
   * `subSchemas` is built root-to-leaf (the chain walk that produces
   * `traitSchemas` runs from the base schema down to the leaf), so when more
   * than one branch declares a `default` for the same property, the LAST
   * match is the most-derived (descendant) declaration. That's the one that
   * wins, consistent with the descendant-overrides-ancestor convention used
   * everywhere else in this file (e.g. `applyMergePatch`'s RFC 7396
   * last-wins merge) - a descendant redeclaring a property's default is
   * meant to override its ancestor's, not the other way around.
   */
  private mergeTraitPropertySchemas(subSchemas: any[]): any {
    const withDefault = [...subSchemas].reverse().find((s) => typeof s === 'object' && s !== null && 'default' in s);
    const merged: any = { allOf: subSchemas };
    if (withDefault) merged.default = withDefault.default;
    return merged;
  }

  // Detect cyclic $ref references reachable from a schema's content
  private detectRefCycle(originId: string, content: any, visited: Set<string>, depth: number = 0): string | null {
    // Fail closed, and separately from the non-object base case: `null` means
    // "no cycle here", so returning it on overflow would let a cycle that sits
    // below the limit pass unexamined.
    if (depth > MAX_SCHEMA_DEPTH) {
      return `reference chain from '${originId}' exceeds ${MAX_SCHEMA_DEPTH} levels and cannot be checked for cycles`;
    }
    if (!content || typeof content !== 'object') return null;

    // Check direct ref on this object
    const ref = content['$ref'];
    if (typeof ref === 'string') {
      const refId = ref.startsWith(GTS_URI_PREFIX) ? ref.substring(GTS_URI_PREFIX.length) : ref;
      if (visited.has(refId)) {
        return `Cyclic reference detected: ${refId}`;
      }
      const refEntity = this.get(refId);
      if (refEntity && refEntity.content) {
        // Same rule as resolveTraitSchemaRefs: `visited` is the active
        // recursion path, so following a ref extends a copy of it. Sharing one
        // set across siblings reports ordinary reuse of a common schema as a
        // cycle.
        const inner = this.detectRefCycle(originId, refEntity.content, new Set(visited).add(refId), depth + 1);
        if (inner) return inner;
      }
    }

    // Recurse into allOf - each branch is its own path.
    if (Array.isArray(content.allOf)) {
      for (const sub of content.allOf) {
        const inner = this.detectRefCycle(originId, sub, new Set(visited), depth + 1);
        if (inner) return inner;
      }
    }

    return null;
  }

  /**
   * Every `$ref` this schema declares directly - at the top level or
   * in an `allOf` branch.
   *
   * The top level counts: `{"$ref": parent}` is a valid JSON Schema way to say
   * "identical to the parent", and ADR-0001 leaves the derivation body free, so
   * a derived type written that way inherits just as much as an `allOf` one.
   */
  private collectDirectRefs(schema: any): string[] {
    if (!schema || typeof schema !== 'object') {
      return [];
    }

    const refs: string[] = [];
    const own = schema['$ref'];
    if (typeof own === 'string') {
      refs.push(own);
    }

    if (Array.isArray(schema.allOf)) {
      for (const sub of schema.allOf) {
        if (sub && typeof sub === 'object') {
          const ref = sub['$ref'];
          if (typeof ref === 'string') {
            refs.push(ref);
          }
        }
      }
    }
    return refs;
  }

  /**
   * True when the derived body pulls its chain parent in through `allOf` +
   * `$ref`, so the parent's constraints keep applying to the same instance.
   *
   * A reference to some unrelated type does not count: the parent's
   * constraints would not be inherited, so the derived body still has to
   * restate them (ADR-0001 variant 2c).
   */
  private inheritsParentViaRef(schema: any, parentId: string): boolean {
    return this.collectDirectRefs(schema).some((ref) => {
      const normalized = ref.startsWith(GTS_URI_PREFIX) ? ref.substring(GTS_URI_PREFIX.length) : ref;
      return normalized === parentId;
    });
  }

  private resolveSchemaFully(schema: any, visited: Set<string> = new Set()): ResolvedSchema {
    // Schemas are registered without meta-validation, so a `null` (or any
    // other non-object) can legitimately reach here - directly as the schema
    // passed in, or recursively via a property value / `allOf` entry that
    // turned out to be `null`. Treat it as a no-op/malformed entry rather
    // than reading `.type` off it, which would throw.
    if (!isPlainSchemaObject(schema)) {
      return { properties: {}, required: [], additionalProperties: undefined, type: undefined };
    }

    const result: ResolvedSchema = {
      properties: {},
      required: [],
      additionalProperties: undefined,
      type: schema.type,
    };

    // A top-level `$ref` carries the whole referenced schema, exactly as an
    // `allOf` branch does; without this a parent written that way resolves to
    // nothing and its constraints become unenforceable for descendants.
    const ownRef = schema['$ref'];
    if (typeof ownRef === 'string') {
      const refId = ownRef.startsWith(GTS_URI_PREFIX) ? ownRef.substring(GTS_URI_PREFIX.length) : ownRef;
      if (!visited.has(refId)) {
        const refEntity = this.get(refId);
        if (refEntity && refEntity.content) {
          const resolved = this.resolveSchemaFully(refEntity.content, new Set(visited).add(refId));
          Object.assign(result.properties, resolved.properties);
          result.required.push(...(resolved.required || []));
          if (resolved.additionalProperties !== undefined) {
            result.additionalProperties = resolved.additionalProperties;
          }
          if (resolved.type && !result.type) {
            result.type = resolved.type;
          }
        }
      }
    }

    // If this schema has allOf, resolve each part
    if (schema.allOf && Array.isArray(schema.allOf)) {
      for (const sub of schema.allOf) {
        // A malformed `allOf` entry (e.g. a literal `null`) is a no-op, not a
        // crash - see the guard at the top of this method.
        if (!isPlainSchemaObject(sub)) continue;
        const ref = sub['$ref'];
        if (typeof ref === 'string') {
          // Resolve referenced schema
          const refId = ref.startsWith(GTS_URI_PREFIX) ? ref.substring(GTS_URI_PREFIX.length) : ref;
          if (visited.has(refId)) {
            continue;
          }
          visited.add(refId);
          const refEntity = this.get(refId);
          if (refEntity && refEntity.content) {
            const resolved = this.resolveSchemaFully(refEntity.content, visited);
            Object.assign(result.properties, resolved.properties);
            if (resolved.required) {
              result.required.push(...resolved.required);
            }
            if (resolved.additionalProperties !== undefined) {
              result.additionalProperties = resolved.additionalProperties;
            }
            if (resolved.type && !result.type) {
              result.type = resolved.type;
            }
          }
        } else {
          // Non-ref subschema - merge it
          const resolved = this.resolveSchemaFully(sub, visited);
          // For overlay properties, merge them (they override)
          for (const [propName, propSchema] of Object.entries(resolved.properties || {})) {
            if (result.properties[propName]) {
              // Merge property constraints - overlay tightens base
              result.properties[propName] = this.mergePropertySchemas(result.properties[propName], propSchema);
            } else {
              result.properties[propName] = propSchema;
            }
          }
          if (resolved.required) {
            result.required.push(...resolved.required);
          }
          if (resolved.additionalProperties !== undefined) {
            result.additionalProperties = resolved.additionalProperties;
          }
        }
      }
    }

    // Add direct properties
    if (isPlainSchemaObject(schema.properties)) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        if (result.properties[propName]) {
          result.properties[propName] = this.mergePropertySchemas(result.properties[propName], propSchema);
        } else {
          result.properties[propName] = propSchema;
        }
      }
    }

    // Add direct required
    if (schema.required && Array.isArray(schema.required)) {
      result.required.push(...schema.required);
    }

    // Direct additionalProperties
    if (schema.additionalProperties !== undefined) {
      result.additionalProperties = schema.additionalProperties;
    }

    // Deduplicate required
    result.required = Array.from(new Set(result.required));

    return result;
  }

  private mergePropertySchemas(base: any, overlay: any): any {
    if (base === false || overlay === false) {
      return false;
    }
    if (typeof base !== 'object' || typeof overlay !== 'object') {
      return overlay;
    }
    const merged: any = { ...base };
    for (const [key, val] of Object.entries(overlay)) {
      if (key === 'properties' && merged.properties) {
        merged.properties = { ...merged.properties, ...(val as any) };
      } else if (key === 'required' && merged.required) {
        const mergedReq = new Set([...(merged.required as string[]), ...(val as string[])]);
        merged.required = Array.from(mergedReq);
      } else {
        merged[key] = val;
      }
    }
    return merged;
  }

  private extractOverlay(schema: any): ResolvedSchema {
    const overlay: ResolvedSchema = {
      properties: {},
      required: [],
      additionalProperties: undefined,
    };

    if (!isPlainSchemaObject(schema)) {
      return overlay;
    }

    if (schema.allOf && Array.isArray(schema.allOf)) {
      for (const sub of schema.allOf) {
        // A malformed `allOf` entry (e.g. a literal `null`) is a no-op, not a
        // crash - see `isPlainSchemaObject`.
        if (!isPlainSchemaObject(sub)) continue;
        const ref = sub['$ref'];
        if (typeof ref === 'string') {
          continue; // Skip ref subschemas
        }
        // This is a non-ref overlay subschema
        if (isPlainSchemaObject(sub.properties)) {
          for (const [propName, propSchema] of Object.entries(sub.properties)) {
            overlay.properties[propName] = overlay.properties[propName]
              ? this.mergePropertySchemas(overlay.properties[propName], propSchema)
              : propSchema;
          }
        }
        if (sub.required && Array.isArray(sub.required)) {
          overlay.required.push(...sub.required);
        }
        if (sub.additionalProperties !== undefined) {
          overlay.additionalProperties = sub.additionalProperties;
        }
      }
    }

    // Add top-level properties (outside allOf)
    if (isPlainSchemaObject(schema.properties)) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        overlay.properties[propName] = overlay.properties[propName]
          ? this.mergePropertySchemas(overlay.properties[propName], propSchema)
          : propSchema;
      }
    }
    if (schema.required && Array.isArray(schema.required)) {
      overlay.required.push(...schema.required);
    }
    if (schema.additionalProperties !== undefined && overlay.additionalProperties === undefined) {
      overlay.additionalProperties = schema.additionalProperties;
    }

    return overlay;
  }

  /**
   * Compares a derived schema's overlay against its resolved base (§3.1, §4.1).
   *
   * `inheritsViaRef` says whether the derived body pulls the base in through
   * `allOf` + `$ref`. When it does, the base branch keeps applying to the same
   * instance, so the overlay cannot loosen anything by omission - only by
   * excluding values the base allows. When the derived body instead restates
   * the parent's fields (ADR-0001 variant 2c), anything it fails to restate is
   * a genuine loosening.
   */
  private compareOverlayToBase(
    overlay: ResolvedSchema,
    baseResolved: ResolvedSchema,
    path: string,
    inheritsViaRef: boolean = true
  ): string[] {
    const errors: string[] = [];
    const overlayProps = overlay.properties || {};
    const baseProps = baseResolved.properties || {};

    for (const [propName, propSchema] of Object.entries(overlayProps)) {
      const propPath = path ? `${path}.${propName}` : propName;

      // Property schema set to false
      if (propSchema === false) {
        if (baseProps[propName] !== undefined) {
          errors.push(`Property '${propPath}' is set to false but exists in base`);
        }
        continue;
      }

      const baseProp = baseProps[propName];

      if (baseProp === undefined || baseProp === null) {
        // New property not in base
        if (baseResolved.additionalProperties === false) {
          errors.push(`Property '${propPath}' not in base and base has additionalProperties: false`);
        }
        continue;
      }

      if (baseProp === false) {
        // Base already set property to false, overlay can't use it
        errors.push(`Property '${propPath}' is forbidden in base`);
        continue;
      }

      // Both base and overlay have this property — compare constraints
      if (typeof propSchema === 'object' && propSchema !== null) {
        errors.push(...this.comparePropertyConstraints(propSchema, baseProp, propPath, inheritsViaRef));
      }
    }

    // A derived level that closes itself must restate the base's properties:
    // under allOf the closed branch is evaluated on its own and would reject
    // every value the base declares but the derived omits.
    if (overlay.additionalProperties === false) {
      for (const propName of Object.keys(baseProps)) {
        if (baseProps[propName] === false) continue;
        if (!(propName in overlayProps)) {
          const propPath = path ? `${path}.${propName}` : propName;
          errors.push(`Property '${propPath}' is declared in base but excluded by additionalProperties: false`);
        }
      }
    }

    if (!inheritsViaRef) {
      // The derived schema stands alone, so it must carry the base's
      // constraints itself rather than inherit them through a $ref.
      if (baseResolved.additionalProperties === false && overlay.additionalProperties !== false) {
        errors.push('Cannot loosen additionalProperties from false to true');
      }

      const overlayRequired = new Set(overlay.required || []);
      for (const requiredProp of baseResolved.required || []) {
        if (!overlayRequired.has(requiredProp)) {
          const propPath = path ? `${path}.${requiredProp}` : requiredProp;
          errors.push(`Property '${propPath}' is required in base but not in derived`);
        }
      }
    }

    return errors;
  }

  private comparePropertyConstraints(
    derived: any,
    base: any,
    propPath: string,
    inheritsViaRef: boolean = true
  ): string[] {
    const errors: string[] = [];

    if (typeof base !== 'object' || base === null) {
      return errors;
    }

    // Cross-keyword conflicts: the loosening/drop checks below only compare
    // the SAME keyword between `derived` and `base` (e.g. `maximum` vs
    // `maximum`), so they cannot see a conflict between DIFFERENT keywords
    // declared by the two sides on the same property - e.g. `derived`
    // declares `maximum: 5` while `base` already declared `minimum: 10`: no
    // value satisfies both, but nothing above compares `minimum` against
    // `maximum`. `findValueConflict`/`findCrossedBound` check whether a SET
    // of sibling subschemas has a non-empty joint value-set/bound-range
    // intersection, which is exactly this question.
    const crossKeywordConflict = this.findValueConflict([derived, base]) || findCrossedBound([derived, base]);
    if (crossKeywordConflict) {
      errors.push(`Property '${propPath}' cannot be satisfied: ${crossKeywordConflict}`);
    }

    // Type check
    const baseType = base.type;
    const derivedType = derived.type;
    if (baseType !== undefined && derivedType !== undefined) {
      if (Array.isArray(derivedType)) {
        // Derived has array type — widening (fail)
        if (!Array.isArray(baseType)) {
          errors.push(`Property '${propPath}' widens type from '${baseType}' to array`);
          return errors;
        }
      }
      if (Array.isArray(baseType)) {
        if (!Array.isArray(derivedType)) {
          // Could be narrowing from array type
          if (!baseType.includes(derivedType)) {
            errors.push(`Property '${propPath}' type '${derivedType}' not in base types [${baseType}]`);
            return errors;
          }
        }
      } else if (!Array.isArray(derivedType)) {
        // Both scalar types
        if (baseType !== derivedType) {
          errors.push(`Property '${propPath}' type changed from '${baseType}' to '${derivedType}'`);
          return errors;
        }
      }
    }

    // Determine if the overlay adds any NEW constraint keywords not in the base.
    // Under allOf semantics, base constraints are preserved. Drops are only flagged
    // when the overlay doesn't introduce any new tightening constraints.
    const CONSTRAINT_KEYWORDS = [
      'maxLength',
      'minLength',
      'maximum',
      'minimum',
      'maxItems',
      'minItems',
      'enum',
      'const',
      'pattern',
      'items',
    ];
    const baseConstraintKeys = new Set(CONSTRAINT_KEYWORDS.filter((kw) => base[kw] !== undefined));
    const derivedConstraintKeys = new Set(CONSTRAINT_KEYWORDS.filter((kw) => derived[kw] !== undefined));
    const hasNewConstraints = [...derivedConstraintKeys].some((kw) => !baseConstraintKeys.has(kw));

    // Max constraints (tightening = lower value OK; loosening = higher value FAIL)
    for (const kw of ['maxLength', 'maximum', 'maxItems']) {
      if (base[kw] !== undefined) {
        if (derived[kw] === undefined) {
          if (!hasNewConstraints) {
            errors.push(`Property '${propPath}' drops constraint '${kw}'`);
          }
        } else if (derived[kw] > base[kw]) {
          errors.push(`Property '${propPath}' loosens '${kw}' from ${base[kw]} to ${derived[kw]}`);
        }
      }
    }

    // Min constraints (tightening = higher value OK; loosening = lower value FAIL)
    for (const kw of ['minLength', 'minimum', 'minItems']) {
      if (base[kw] !== undefined) {
        if (derived[kw] === undefined) {
          if (!hasNewConstraints) {
            errors.push(`Property '${propPath}' drops constraint '${kw}'`);
          }
        } else if (derived[kw] < base[kw]) {
          errors.push(`Property '${propPath}' loosens '${kw}' from ${base[kw]} to ${derived[kw]}`);
        }
      }
    }

    // Enum check
    if (base.enum !== undefined) {
      if (derived.enum === undefined) {
        if (!hasNewConstraints) {
          errors.push(`Property '${propPath}' drops constraint 'enum'`);
        }
      } else {
        const baseSet = new Set(base.enum.map((v: any) => JSON.stringify(v)));
        for (const val of derived.enum) {
          if (!baseSet.has(JSON.stringify(val))) {
            errors.push(`Property '${propPath}' enum value '${val}' not in base enum`);
          }
        }
      }
    }

    // Const check
    if (base.const !== undefined) {
      if (derived.const === undefined) {
        if (!hasNewConstraints) {
          errors.push(`Property '${propPath}' drops constraint 'const'`);
        }
      } else if (JSON.stringify(base.const) !== JSON.stringify(derived.const)) {
        errors.push(
          `Property '${propPath}' const conflict: ${JSON.stringify(derived.const)} vs base ${JSON.stringify(base.const)}`
        );
      }
    }
    // Check const in derived against base numeric constraints
    if (derived.const !== undefined && typeof derived.const === 'number') {
      if (base.minimum !== undefined && derived.const < base.minimum) {
        errors.push(`Property '${propPath}' const ${derived.const} violates base minimum ${base.minimum}`);
      }
      if (base.maximum !== undefined && derived.const > base.maximum) {
        errors.push(`Property '${propPath}' const ${derived.const} violates base maximum ${base.maximum}`);
      }
    }

    // Pattern check
    if (base.pattern !== undefined) {
      if (derived.pattern === undefined) {
        if (!hasNewConstraints) {
          errors.push(`Property '${propPath}' drops constraint 'pattern'`);
        }
      } else if (base.pattern !== derived.pattern) {
        errors.push(`Property '${propPath}' pattern changed from '${base.pattern}' to '${derived.pattern}'`);
      }
    }

    // Items check (array items)
    if (base.items !== undefined) {
      if (derived.items === undefined) {
        if (!hasNewConstraints) {
          errors.push(`Property '${propPath}' drops constraint 'items'`);
        }
      } else if (typeof base.items === 'object' && typeof derived.items === 'object') {
        errors.push(...this.comparePropertyConstraints(derived.items, base.items, `${propPath}.items`, inheritsViaRef));
      }
    }

    // Nested object: recursively compare
    if (base.type === 'object' && derived.type === 'object') {
      if (base.properties || derived.properties) {
        const nestedOverlay = {
          properties: derived.properties || {},
          required: derived.required || [],
          additionalProperties: derived.additionalProperties,
        };
        const nestedBase = {
          properties: base.properties || {},
          required: base.required || [],
          additionalProperties: base.additionalProperties,
        };
        errors.push(...this.compareOverlayToBase(nestedOverlay, nestedBase, propPath, inheritsViaRef));
      }
    }

    return errors;
  }

  getAttribute(gtsId: string, path: string): any {
    const entity = this.get(gtsId);
    if (!entity) {
      return {
        gts_id: gtsId,
        path,
        resolved: false,
        error: `Entity not found: ${gtsId}`,
      };
    }

    const value = this.getNestedValue(entity.content, path);

    return {
      gts_id: gtsId,
      path,
      resolved: value !== undefined,
      value,
    };
  }

  private getNestedValue(obj: any, path: string): any {
    // Split path by dots but handle array notation
    const parts: string[] = [];
    let current = '';
    let inBracket = false;

    for (let i = 0; i < path.length; i++) {
      const char = path[i];
      if (char === '[') {
        if (current) {
          parts.push(current);
          current = '';
        }
        inBracket = true;
      } else if (char === ']') {
        if (current) {
          parts.push(`[${current}]`);
          current = '';
        }
        inBracket = false;
      } else if (char === '.' && !inBracket) {
        if (current) {
          parts.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current) {
      parts.push(current);
    }

    let result = obj;
    for (const part of parts) {
      if (result === null || result === undefined) {
        return undefined;
      }

      // Handle array index notation
      if (part.startsWith('[') && part.endsWith(']')) {
        const index = parseInt(part.slice(1, -1), 10);
        if (Array.isArray(result) && !isNaN(index)) {
          result = result[index];
        } else {
          return undefined;
        }
      } else {
        // Regular property access
        if (typeof result === 'object' && part in result) {
          result = result[part];
        } else {
          return undefined;
        }
      }
    }

    return result;
  }
}

/**
 * @param forceIsSchema - Caller-declared intent (P6-2/P6-3): when set,
 * stamps `isSchema` authoritatively instead of deriving it from
 * `GtsExtractor`'s `$schema`-keyword shape heuristic, which cannot
 * distinguish a schema-less-looking-but-declared schema (e.g. registered via
 * `POST /type-schemas` with no embedded `$schema`) from ordinary instance
 * JSON - a shape heuristic can never close that gap because the document
 * can contain zero schema keywords.
 */
export function createJsonEntity(content: any, _config?: Partial<GtsConfig>, forceIsSchema?: boolean): JsonEntity {
  const extractResult = GtsExtractor.extractID(content, undefined, forceIsSchema);

  const references = new Set<string>();
  findReferences(content, references);

  return {
    id: extractResult.id,
    schemaId: extractResult.type_id,
    content,
    isSchema: extractResult.is_type_schema,
    references,
  };
}

function findReferences(obj: any, refs: Set<string>, visited = new Set()): void {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) {
    return;
  }

  visited.add(obj);

  if ('$ref' in obj && typeof obj['$ref'] === 'string') {
    const ref = obj['$ref'];
    const normalized = ref.startsWith(GTS_URI_PREFIX) ? ref.substring(GTS_URI_PREFIX.length) : ref;
    if (Gts.isValidGtsID(normalized)) {
      refs.add(normalized);
    }
  }

  if ('x-gts-ref' in obj && typeof obj['x-gts-ref'] === 'string') {
    const ref = obj['x-gts-ref'];
    if (Gts.isValidGtsID(ref)) {
      refs.add(ref);
    }
  }

  for (const value of Object.values(obj)) {
    findReferences(value, refs, visited);
  }
}
