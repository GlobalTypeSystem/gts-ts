export * from './types';
export { Gts } from './gts';
export { GtsExtractor } from './extract';
export { GtsStore, createJsonEntity } from './store';
export { GtsRelationships } from './relationships';
export { GtsCompatibility } from './compatibility';
export { GtsQuery } from './query';
export { GtsModifiers, DOCUMENT_LEVEL_KEYWORDS } from './modifiers';
export { XGtsRefValidator, X_GTS_REF_SELF } from './x-gts-ref';
export type { XGtsRefValidationError } from './x-gts-ref';
export {
  parseJSONC,
  tryParseJSONC,
  parseYAML,
  tryParseYAML,
  parseGtsTextContent,
  parseGtsText,
  GtsTextParseError,
} from './text-parser';
export { attachSourceLocations, sourceSpanAt } from './source-location';

import { Gts } from './gts';
import { GtsExtractor } from './extract';
import { GtsStore, createJsonEntity } from './store';
import { GtsRelationships } from './relationships';
import { GtsCompatibility } from './compatibility';
import { GtsQuery } from './query';
import {
  ValidationResult,
  ParseResult,
  MatchResult,
  UUIDResult,
  ExtractResult,
  AttributeResult,
  QueryResult,
  RelationshipResult,
  CompatibilityResult,
  CastResult,
  GtsConfig,
  EntityLookup,
  JsonEntity,
  GtsRefValidationMode,
  GtsTextFormat,
  GtsTextValidationResult,
  GtsEntityValidationResult,
  ValidationIssue,
} from './types';
import { parseGtsText } from './text-parser';
import { SourceLocator } from './source-location';

export const isValidGtsID = (id: string): boolean => Gts.isValidGtsID(id);
export const validateGtsID = (id: string): ValidationResult => Gts.validateGtsID(id);
export const parseGtsID = (id: string): ParseResult => Gts.parseID(id);
export const matchIDPattern = (candidate: string, pattern: string): MatchResult =>
  Gts.matchIDPattern(candidate, pattern);
export const idToUUID = (id: string): UUIDResult => Gts.idToUUID(id);
export const extractID = (content: any, schemaContent?: any): ExtractResult =>
  GtsExtractor.extractID(content, schemaContent);

export class GTS {
  private store: GtsStore;

  constructor(config?: Partial<GtsConfig>) {
    this.store = new GtsStore(config);
  }

  /**
   * Source-aware validation of a raw text payload. The caller passes the
   * serialization `format` (derived from its own file extension or content
   * type); the library never receives a file path or name, so none can appear
   * in diagnostics. Diagnostics carry only in-text spans (offset/line/column).
   *
   * Side effect: every successfully-parsed entity is registered into this
   * store, even when other entities in the payload are invalid or when the
   * overall result is `ok: false`. Registration is not rolled back. Callers
   * that need all-or-nothing semantics should validate against a throwaway
   * `GTS` instance and only register into their real store on success.
   */
  registerAndValidateText(
    text: string,
    format: GtsTextFormat = 'jsonc',
    refValidation: GtsRefValidationMode = GtsRefValidationMode.AnyValid
  ): GtsTextValidationResult {
    const parsed = parseGtsText(text, format);
    if (!parsed.ok) {
      return { ok: false, entities: [], errors: parsed.errors || [] };
    }

    const locator = new SourceLocator(format, text);
    const results: GtsEntityValidationResult[] = [];
    const registrationErrors = new Map<number, ValidationResult>();
    parsed.entities.forEach((entity, entityIndex) => {
      try {
        this.store.register(entity);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const issue: ValidationIssue = {
          instancePath: '/$id',
          schemaPath: '#',
          keyword: 'registration',
          message,
          params: {},
        };
        registrationErrors.set(entityIndex, { id: entity.id, ok: false, error: message, errors: [issue] });
      }
    });

    parsed.entities.forEach((entity, entityIndex) => {
      const rawResult =
        registrationErrors.get(entityIndex) ||
        (entity.isSchema
          ? this.store.validateSchema(entity.id, refValidation)
          : this.store.validateInstance(entity.id, refValidation));
      const fallbackIssue: ValidationIssue = {
        instancePath: entity.isSchema ? '/$id' : '/',
        schemaPath: '#',
        keyword: entity.isSchema ? 'schema' : 'instance',
        message: rawResult.error,
        params: {},
      };
      const localizedErrors = locator.attach(
        entityIndex,
        rawResult.errors?.length ? rawResult.errors : rawResult.ok ? [] : [fallbackIssue]
      );
      const result = localizedErrors.length > 0 ? { ...rawResult, errors: localizedErrors } : rawResult;
      results.push({ entityIndex, id: entity.id, isSchema: entity.isSchema, result });
    });

    const errors = results.flatMap((entry) => entry.result.errors || []);
    return { ok: results.every((entry) => entry.result.ok), entities: results, errors };
  }

  /**
   * @param forceIsSchema - Passed through to `createJsonEntity` (P6-2/P6-3):
   * lets a caller that already knows an entity is a GTS Type Schema by its
   * own declared intent (e.g. `POST /type-schemas`'s explicit `type_id`)
   * stamp `isSchema` authoritatively, rather than leaving it to
   * `GtsExtractor`'s document-shape heuristic, which cannot detect a schema
   * that embeds no `$schema`/root-type keyword at all.
   */
  register(content: any, forceIsSchema?: boolean): JsonEntity | undefined {
    const entity = createJsonEntity(content, undefined, forceIsSchema);
    return this.store.register(entity);
  }

  rollbackRegistration(id: string, previous?: JsonEntity): void {
    this.store.unregister(id);
    if (previous) {
      this.store.register(previous);
    }
  }

  /**
   * Roll back a `register()` call by id. Used by callers (e.g. the HTTP
   * server) that must register an entity before a later gate can validate it,
   * so a rejection after that gate must undo the registration rather than
   * leave the entity committed to the store.
   */
  unregister(id: string): void {
    this.store.unregister(id);
  }

  get(id: string): any {
    const entity = this.store.get(id);
    return entity?.content;
  }

  /**
   * Whether `id` is registered and, if so, whether the registered entity is
   * itself a GTS Type Schema (`JsonEntity.isSchema`) - `undefined` when
   * nothing is registered under `id`. `get()` above discards `isSchema`
   * along with the rest of the entity envelope (it returns `.content`
   * only), so callers that must distinguish "not found" from "found but not
   * a schema" (P6-2/P6-3 - e.g. `/validate-json/{gts_type}`'s existence
   * check, which used to be a bypass that ignored `isSchema` entirely) need
   * this instead of reaching past the facade at `.store`.
   */
  isRegisteredSchema(id: string): boolean | undefined {
    const entity = this.store.get(id);
    return entity ? entity.isSchema : undefined;
  }

  validateInstance(id: string, refValidation: GtsRefValidationMode = GtsRefValidationMode.AnyValid): ValidationResult {
    return this.store.validateInstance(id, refValidation);
  }

  validateInstanceAsync(
    id: string,
    refValidation: GtsRefValidationMode = GtsRefValidationMode.AnyValid
  ): Promise<ValidationResult> {
    return this.store.validateInstanceAsync(id, refValidation);
  }

  getAttribute(path: string): AttributeResult {
    // Parse the combined path format: gts_id@attr_path
    const atIndex = path.indexOf('@');
    if (atIndex === -1) {
      return {
        path,
        resolved: false,
        error: 'Invalid attribute path: missing @',
      };
    }
    const gtsId = path.substring(0, atIndex);
    const attrPath = path.substring(atIndex + 1);
    return this.store.getAttribute(gtsId, attrPath);
  }

  query(expression: string, limit?: number): QueryResult {
    return GtsQuery.query(this.store, expression, limit);
  }

  resolveRelationships(id: string): RelationshipResult {
    return GtsRelationships.resolveRelationships(this.store, id);
  }

  checkCompatibility(
    oldId: string,
    newId: string,
    mode: 'backward' | 'forward' | 'full' = 'full'
  ): CompatibilityResult {
    return GtsCompatibility.checkCompatibility(this.store, oldId, newId, mode);
  }

  /**
   * OP#9 - cast an instance to another version of its type.
   *
   * Delegates to the registry implementation so that the library, the CLI and
   * `POST /cast` all share one cast: it flattens the target through `allOf` and
   * GTS `$ref`s before transforming, and validates the result against the
   * target type.
   */
  castInstance(fromId: string, toTypeId: string): CastResult {
    const result = this.store.castInstance(fromId, toTypeId);
    return {
      ok: result.ok,
      fromId,
      toId: toTypeId,
      result: result.casted_entity ?? undefined,
      error: result.error || undefined,
      backward_compatibility: result.backward_compatibility ?? 'unknown',
      forward_compatibility: result.forward_compatibility ?? 'unknown',
      full_compatibility: result.full_compatibility ?? 'unknown',
    };
  }

  /**
   * The raw registry cast result (every field the store computes - added /
   * removed properties, per-direction compatibility, etc.), for callers that
   * need the full response shape rather than the narrower `CastResult` that
   * `castInstance()` above returns.
   */
  castInstanceRaw(fromId: string, toTypeId: string): any {
    return this.store.castInstance(fromId, toTypeId);
  }

  /**
   * The document-level GTS rules for a type schema (§9.7.1, §9.11). Delegates
   * to the registry implementation so that `register()`, `validateEntity()`
   * and the HTTP server all share the same check instead of the server
   * reaching past `GtsStore`'s encapsulation to call it directly.
   */
  checkTypeSchemaRules(content: any, id: string | undefined, options: { enforceGuards: boolean }): string | null {
    return this.store.checkTypeSchemaRules(content, id, options);
  }

  /**
   * The document-level GTS rule for an instance: its rightmost type must be
   * instantiable (§9.11.3 item 1).
   */
  checkInstanceRules(typeId: string | null | undefined): string | null {
    return this.store.checkInstanceRules(typeId);
  }

  /** Resolves a single attribute path on an entity, given as two separate arguments. */
  getAttributeAt(gtsId: string, path: string): AttributeResult {
    return this.store.getAttribute(gtsId, path);
  }

  /**
   * A minimal, read-only view of the registry for collaborators (e.g.
   * `XGtsRefValidator`) that only need to resolve an id to an entity, so they
   * do not have to depend on `GtsStore` - or reach past this class's private
   * field to get one - just to look entities up.
   */
  asEntityLookup(): EntityLookup {
    return this.store;
  }

  /**
   * Derivation and trait completeness are both type-level properties (§9.7.5).
   * Exposed directly because `validateEntity()` below applies it only after
   * first resolving `id` to an entity.
   */
  validateSchemaAgainstParent(
    schemaId: string,
    refValidation: GtsRefValidationMode = GtsRefValidationMode.AnyValid
  ): ValidationResult {
    return this.store.validateSchemaAgainstParent(schemaId, refValidation);
  }

  validateSchema(
    schemaId: string,
    refValidation: GtsRefValidationMode = GtsRefValidationMode.AnyValid
  ): ValidationResult {
    return this.store.validateSchema(schemaId, refValidation);
  }

  validateSchemaAsync(
    schemaId: string,
    refValidation: GtsRefValidationMode = GtsRefValidationMode.AnyValid
  ): Promise<ValidationResult> {
    return this.store.validateSchemaAsync(schemaId, refValidation);
  }

  /**
   * OP#6 `POST /validate-json` (transient validation, spec commit ab1287e) -
   * validates a candidate type schema document without registering it.
   */
  validateTransientSchema(content: any, schemaId: string): ValidationResult {
    return this.store.validateTransientSchema(content, schemaId);
  }

  /**
   * OP#6 `POST /validate-json` (transient validation, spec commit ab1287e) -
   * validates candidate instance JSON against an already-registered type,
   * without requiring the candidate itself to be registered.
   */
  validateTransientInstance(content: any, typeId: string, resultId: string | null): ValidationResult {
    return this.store.validateTransientInstance(content, typeId, resultId);
  }

  validateEntity(
    id: string,
    refValidation: GtsRefValidationMode = GtsRefValidationMode.AnyValid
  ): ValidationResult & { entity_type: string } {
    const entity = this.store.get(id);
    if (!entity) {
      return { id, ok: false, error: `Entity not found: ${id}`, entity_type: 'unknown' };
    }

    if (entity.isSchema) {
      // Derivation and trait completeness are both type-level properties, so
      // /validate-entity applies exactly the same checks as OP#12 (§9.7.5).
      const result = this.store.validateSchemaAgainstParent(id, refValidation);
      return { ...result, entity_type: 'schema' };
    } else {
      const result = this.store.validateInstance(id, refValidation);
      return { ...result, entity_type: 'instance' };
    }
  }
}

export default GTS;
