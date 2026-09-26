/*
 * x-gts-ref validation for GTS schemas
 * Validates that string values match specified GTS ID patterns
 */

import type Ajv from 'ajv';
import { Gts } from './gts';
import {
  EntityLookup,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_PATHS,
  GtsRefValidationMode,
  GTS_PREFIX,
  hasUriPrefix,
  stripUriPrefix,
} from './types';

export const X_GTS_REF_SELF = '/$id';

/**
 * Whether `value`, already known to be prefixed by an exact (non-wildcard)
 * `pattern`, matches it on a segment boundary. Type patterns (ending with `~`)
 * admit derived identifiers; any other (exact) pattern requires a full match or
 * a `~` boundary immediately after the pattern, so `…w.v1` does not spuriously
 * accept `…w.v12` / `…w.v1.5`.
 */
function matchesAtSegmentBoundary(value: string, pattern: string): boolean {
  return value.length === pattern.length || pattern.endsWith('~') || value[pattern.length] === '~';
}

/**
 * Why the string `value` does not satisfy `pattern`, or `null` if it matches.
 * Pure pattern matching (concrete id, type prefix, or single trailing wildcard);
 * registry existence and the `/$id` self-reference are decided by
 * {@link XGtsRefValidator}, not here. Shared by that walker and the structural
 * `x-gts-ref` Ajv keyword so both agree on matching.
 */
export function gtsPatternViolation(value: string, pattern: string): string | null {
  if (!Gts.isValidGtsID(value)) {
    return `Value '${value}' is not a valid GTS identifier`;
  }
  if (pattern === GTS_PREFIX + '*') return null;
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1)) ? null : `Value '${value}' does not match pattern '${pattern}'`;
  }
  if (!value.startsWith(pattern) || !matchesAtSegmentBoundary(value, pattern)) {
    return `Value '${value}' does not match pattern '${pattern}'`;
  }
  return null;
}

/**
 * Registers `x-gts-ref` as a first-class Ajv keyword so `oneOf`/`anyOf`/`allOf`
 * resolve correctly: branches that differ only by `x-gts-ref` stay distinct
 * instead of collapsing to identical match-all schemas once stripped. This is
 * the same design gts-go and gts-rust use (a registered keyword/vocabulary) and
 * removes the need to strip x-gts-ref and rewrite `oneOf`→`anyOf`.
 *
 * Only concrete/wildcard patterns are enforced here. The `/$id` self-reference
 * (needs the selected type) and registry existence stay with XGtsRefValidator.
 */
export function applyXGtsRefKeyword(ajv: Ajv): void {
  // Named so it can attach a descriptive error (Ajv reads `validate.errors`
  // straight after the call), keeping the same "does not match pattern" wording
  // the standalone walker produces.
  const validate = function xGtsRefValidate(refPattern: string, data: unknown): boolean {
    if (typeof refPattern !== 'string' || refPattern === X_GTS_REF_SELF) return true;
    if (typeof data !== 'string') return true;
    const reason = gtsPatternViolation(data, stripUriPrefix(refPattern));
    if (reason === null) return true;
    (validate as unknown as { errors: unknown[] }).errors = [
      { keyword: 'x-gts-ref', message: reason, params: { pattern: refPattern } },
    ];
    return false;
  };
  ajv.addKeyword({ keyword: 'x-gts-ref', schemaType: 'string', errors: true, validate });
}

const SCHEMA_VALUE_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
  'x-gts-traits-schema',
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_MAP_KEYWORDS = new Set(['$defs', 'definitions', 'dependentSchemas', 'properties', 'patternProperties']);

export function escapeJsonPointerSegment(segment: string | number): string {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function appendJsonPointer(path: string, segment: string | number): string {
  return `${path}/${escapeJsonPointerSegment(segment)}`;
}

export function visitJsonSubschemas(schema: any, path: string, visit: (subschema: any, path: string) => void): void {
  for (const [key, value] of Object.entries(schema)) {
    const nestedPath = appendJsonPointer(path, key);
    if (SCHEMA_VALUE_KEYWORDS.has(key)) {
      visit(value, nestedPath);
    } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      value.forEach((item, index) => visit(item, appendJsonPointer(nestedPath, index)));
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, childSchema] of Object.entries(value)) {
        visit(childSchema, appendJsonPointer(nestedPath, name));
      }
    } else if (key === 'items') {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, appendJsonPointer(nestedPath, index)));
      } else {
        visit(value, nestedPath);
      }
    } else if (key === 'dependencies' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, dependency] of Object.entries(value)) {
        if (!Array.isArray(dependency)) {
          visit(dependency, appendJsonPointer(nestedPath, name));
        }
      }
    }
  }
}

export interface XGtsRefValidationError {
  fieldPath: string;
  value: any;
  refPattern: string;
  reason: string;
}

export class XGtsRefValidator {
  private store: EntityLookup | undefined;
  private mode: GtsRefValidationMode;
  private referencedIds: Set<string> = new Set();
  private referencedWildcardPatterns: Set<string> = new Set();
  private selectedTypeId: string | undefined;
  private selfId: string | undefined;

  constructor(store?: EntityLookup, mode: GtsRefValidationMode | boolean = GtsRefValidationMode.AnyValid) {
    this.store = store;
    this.mode = typeof mode === 'boolean' ? (mode ? GtsRefValidationMode.AnyPresent : GtsRefValidationMode.None) : mode;
  }

  getReferencedIds(): Set<string> {
    return new Set(this.referencedIds);
  }

  getReferencedWildcardPatterns(): Set<string> {
    return new Set(this.referencedWildcardPatterns);
  }

  isSelfReference(value: unknown): boolean {
    return value === X_GTS_REF_SELF;
  }

  private getSelectedTypeId(schema: any, selectedTypeId?: string): string | undefined {
    const candidate = selectedTypeId ?? schema?.$id;
    return typeof candidate === 'string' ? stripUriPrefix(candidate) : undefined;
  }

  /**
   * Validate an instance against x-gts-ref constraints in schema
   */
  validateInstance(
    instance: any,
    schema: any,
    instancePath: string = '',
    selectedTypeId?: string,
    selfId?: string
  ): XGtsRefValidationError[] {
    this.selectedTypeId = this.getSelectedTypeId(schema, selectedTypeId);
    // The id of the entity being validated. A reference to it is satisfied by
    // that entity itself, so it must bypass the registry-existence check (the
    // entity may not be registered yet under validate-before-register).
    this.selfId = typeof selfId === 'string' ? stripUriPrefix(selfId) : undefined;
    const errors: XGtsRefValidationError[] = [];
    this.visitInstance(instance, schema, instancePath, schema, errors);
    return errors;
  }

  /**
   * Validate x-gts-ref fields in a schema definition
   */
  validateSchema(schema: any, schemaPath: string = '', rootSchema: any = null): XGtsRefValidationError[] {
    if (!rootSchema) {
      rootSchema = schema;
    }
    const errors: XGtsRefValidationError[] = [];
    this.visitSchema(schema, schemaPath, rootSchema, errors);
    return errors;
  }

  private visitInstance(
    instance: any,
    schema: any,
    path: string,
    rootSchema: any,
    errors: XGtsRefValidationError[],
    depth: number = 0,
    pathBudget: { count: number } = { count: 0 }
  ): void {
    if (!schema) return;

    // `$ref` following is the only way this traversal can recurse without
    // being driven by the instance shrinking (a bare `$ref: "#"` re-enters
    // the whole root schema), so it's the one place a cycle can actually
    // blow the stack - bounded the same way `resolveTraitSchemaRefs` /
    // `resolveSchemaFully` bound their own $ref/allOf recursion in
    // src/store.ts: a per-chain depth ceiling (`MAX_SCHEMA_DEPTH`) plus a
    // total-follows budget (`MAX_SCHEMA_PATHS`) shared across the whole
    // top-level call via the mutable `pathBudget` holder. Failing closed
    // with a bounded error (rather than silently stopping and reporting no
    // violation) matches how every other depth guard in this codebase
    // behaves - a schema this deep is per se suspicious, so surfacing it as
    // a validation failure is preferable to hiding it.
    if (
      typeof schema.$ref === 'string' &&
      (schema.$ref === '#' || schema.$ref.startsWith('#/') || hasUriPrefix(schema.$ref))
    ) {
      if (depth >= MAX_SCHEMA_DEPTH) {
        errors.push({
          fieldPath: path || '/',
          value: instance,
          refPattern: '',
          reason: `x-gts-ref traversal via $ref nests deeper than ${MAX_SCHEMA_DEPTH} levels and cannot be resolved`,
        });
        return;
      }
      pathBudget.count++;
      if (pathBudget.count > MAX_SCHEMA_PATHS) {
        errors.push({
          fieldPath: path || '/',
          value: instance,
          refPattern: '',
          reason: `x-gts-ref traversal $ref graph has too many composition paths (exceeds ${MAX_SCHEMA_PATHS}) and cannot be resolved`,
        });
        return;
      }
      const resolved = this.resolveSchemaRef(rootSchema, schema.$ref);
      if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
        const resolvedRoot = hasUriPrefix(schema.$ref) ? resolved : rootSchema;
        this.visitInstance(instance, resolved, path, resolvedRoot, errors, depth + 1, pathBudget);
      } else {
        // The pointer either resolves nowhere (`resolveSchemaRef` returned
        // `null`/`undefined`) or resolves to something that isn't usable as
        // a schema (e.g. into a `default` value, an array index, or any
        // other non-object). Either way, the subtree behind this `$ref`
        // cannot be validated - failing open here (silently stopping and
        // reporting no violation) would let a typo'd, stale, or
        // non-schema-resolving pointer hide every x-gts-ref constraint
        // beneath it. Fail closed instead, matching the depth/path-budget
        // guards above and `resolveTraitSchemaRefs` in src/store.ts, which
        // throws on an unresolvable reference.
        errors.push({
          fieldPath: path || '/',
          value: instance,
          refPattern: '',
          reason: `Cannot resolve $ref '${schema.$ref}' for x-gts-ref traversal`,
        });
      }
      return;
    }

    // Check for x-gts-ref constraint
    if (schema['x-gts-ref'] !== undefined) {
      if (typeof instance === 'string') {
        const err = this.validateRefValue(instance, schema['x-gts-ref'], path);
        if (err) {
          errors.push(err);
        }
      }
    }

    // Recurse into object properties. `schema.type === 'object'` is not
    // required: a schema that only declares `required` / `properties` /
    // `additionalProperties` (no explicit `type`) is still an object schema
    // under JSON Schema semantics, and x-gts-ref enforcement must not depend
    // on an explicit `type: object` declaration.
    if (this.isObjectLikeSchema(schema) && schema.properties) {
      if (instance && typeof instance === 'object') {
        for (const propName in schema.properties) {
          if (propName in instance) {
            const propPath = appendJsonPointer(path, propName);
            this.visitInstance(
              instance[propName],
              schema.properties[propName],
              propPath,
              rootSchema,
              errors,
              depth,
              pathBudget
            );
          }
        }
      }
    }

    // Recurse into array items
    if (schema.type === 'array' && Array.isArray(instance)) {
      if (Array.isArray(schema.prefixItems)) {
        schema.prefixItems.forEach((itemSchema: any, idx: number) => {
          if (idx < instance.length) {
            const itemPath = appendJsonPointer(path, idx);
            this.visitInstance(instance[idx], itemSchema, itemPath, rootSchema, errors, depth, pathBudget);
          }
        });
        if (schema.items && !Array.isArray(schema.items)) {
          instance.slice(schema.prefixItems.length).forEach((item, offset) => {
            const idx = schema.prefixItems.length + offset;
            const itemPath = appendJsonPointer(path, idx);
            this.visitInstance(item, schema.items, itemPath, rootSchema, errors, depth, pathBudget);
          });
        }
      } else if (Array.isArray(schema.items)) {
        schema.items.forEach((itemSchema: any, idx: number) => {
          if (idx < instance.length) {
            const itemPath = appendJsonPointer(path, idx);
            this.visitInstance(instance[idx], itemSchema, itemPath, rootSchema, errors, depth, pathBudget);
          }
        });
        if (schema.additionalItems && !Array.isArray(schema.additionalItems)) {
          instance.slice(schema.items.length).forEach((item, offset) => {
            const idx = schema.items.length + offset;
            const itemPath = appendJsonPointer(path, idx);
            this.visitInstance(item, schema.additionalItems, itemPath, rootSchema, errors, depth, pathBudget);
          });
        }
      } else if (schema.items) {
        instance.forEach((item, idx) => {
          const itemPath = appendJsonPointer(path, idx);
          this.visitInstance(item, schema.items, itemPath, rootSchema, errors, depth, pathBudget);
        });
      }
    }

    // Recurse into combinator subschemas
    if (Array.isArray(schema.allOf)) {
      for (const subSchema of schema.allOf) {
        this.visitInstance(instance, subSchema, path, rootSchema, errors, depth, pathBudget);
      }
    }

    if (Array.isArray(schema.anyOf)) {
      // Only enforce when all branches have x-gts-ref; mixed branches may be valid via non-x-gts-ref path (Ajv handles that)
      const refBranches = schema.anyOf.filter((s: any) => this.containsXGtsRef(s));
      if (refBranches.length > 0 && refBranches.length === schema.anyOf.length) {
        const branchResults = refBranches.map((subSchema: any) => {
          const branchErrors: XGtsRefValidationError[] = [];
          this.visitInstance(instance, subSchema, path, rootSchema, branchErrors, depth, pathBudget);
          return branchErrors;
        });
        const anyPassed = branchResults.some((errs: XGtsRefValidationError[]) => errs.length === 0);
        if (!anyPassed) {
          for (const branchErrors of branchResults) {
            errors.push(...branchErrors);
          }
        }
      }
    }

    if (Array.isArray(schema.oneOf)) {
      // Only enforce when all branches have x-gts-ref; mixed branches can't be coordinated with Ajv's branch selection
      const refBranches = schema.oneOf.filter((s: any) => this.containsXGtsRef(s));
      if (refBranches.length > 0 && refBranches.length === schema.oneOf.length) {
        const branchResults = refBranches.map((subSchema: any) => {
          const branchErrors: XGtsRefValidationError[] = [];
          this.visitInstance(instance, subSchema, path, rootSchema, branchErrors, depth, pathBudget);
          return branchErrors;
        });
        const passingCount = branchResults.filter((errs: XGtsRefValidationError[]) => errs.length === 0).length;
        if (passingCount === 0) {
          for (const branchErrors of branchResults) {
            errors.push(...branchErrors);
          }
        } else if (passingCount > 1) {
          errors.push({
            fieldPath: path || '/',
            value: instance,
            refPattern: '',
            reason: `Value matches ${passingCount} oneOf branches but must match exactly one`,
          });
        }
      }
    }
  }

  /**
   * Whether a schema describes an object even without an explicit
   * `type: "object"` - i.e. it declares `properties`, `required` or
   * `additionalProperties`. JSON Schema does not require `type` to be
   * present for these keywords to apply.
   */
  private isObjectLikeSchema(schema: any): boolean {
    if (!schema || typeof schema !== 'object') return false;
    if (schema.type === 'object') return true;
    if (schema.type !== undefined) return false;
    return (
      schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined
    );
  }

  /** Resolve local and GTS `$ref` targets for x-gts-ref traversal. */
  private resolveSchemaRef(rootSchema: any, ref: string): any {
    if (ref === '#') return rootSchema;
    if (hasUriPrefix(ref)) {
      return this.store?.get(stripUriPrefix(ref))?.content ?? null;
    }
    if (!ref.startsWith('#/')) return null;

    const parts = ref
      .slice(2)
      .split('/')
      .map((part) => decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~'));

    let current: any = rootSchema;
    for (const part of parts) {
      if (!current || typeof current !== 'object') return null;
      current = current[part];
      if (current === undefined) return null;
    }
    return current;
  }

  private visitSchema(schema: any, path: string, rootSchema: any, errors: XGtsRefValidationError[]): void {
    if (!schema || typeof schema !== 'object') return;

    // Check for x-gts-ref field
    if (schema['x-gts-ref'] !== undefined) {
      const refPath = appendJsonPointer(path, 'x-gts-ref');
      const err = this.validateRefPattern(schema['x-gts-ref'], refPath);
      if (err) {
        errors.push(err);
      }
    }

    visitJsonSubschemas(schema, path, (subschema, subschemaPath) => {
      this.visitSchema(subschema, subschemaPath, rootSchema, errors);
    });
  }

  private validateRefValue(value: string, refPattern: any, fieldPath: string): XGtsRefValidationError | null {
    if (typeof refPattern !== 'string') {
      return {
        fieldPath,
        value,
        refPattern: String(refPattern),
        reason: `Value must be a string, got ${typeof refPattern}`,
      };
    }

    let resolvedPattern = refPattern;
    if (this.isSelfReference(refPattern)) {
      if (!this.selectedTypeId) {
        return {
          fieldPath,
          value,
          refPattern,
          reason: 'Cannot resolve /$id without a selected GTS Type Schema',
        };
      }
      resolvedPattern = this.selectedTypeId;
    }

    // Validate against GTS pattern
    return this.validateGtsPattern(value, resolvedPattern, fieldPath);
  }

  private validateRefPattern(refPattern: any, fieldPath: string): XGtsRefValidationError | null {
    if (typeof refPattern !== 'string') {
      return {
        fieldPath,
        value: refPattern,
        refPattern: '',
        reason: `x-gts-ref value must be a string, got ${typeof refPattern}`,
      };
    }

    // Case 1: Absolute GTS pattern
    if (refPattern.startsWith(GTS_PREFIX)) {
      return this.validateGtsIDOrPattern(refPattern, fieldPath);
    }

    if (this.isSelfReference(refPattern)) {
      return null;
    }

    return {
      fieldPath,
      value: refPattern,
      refPattern,
      reason: `Invalid x-gts-ref value: '${refPattern}' must be a GTS identifier, wildcard, or '${X_GTS_REF_SELF}'`,
    };
  }

  private validateGtsIDOrPattern(pattern: string, fieldPath: string): XGtsRefValidationError | null {
    if (pattern === GTS_PREFIX + '*') {
      return null; // Valid wildcard
    }

    if (pattern.includes('*')) {
      // Wildcard pattern - validate prefix
      const prefix = pattern.replace('*', '');
      if (!prefix.startsWith(GTS_PREFIX)) {
        return {
          fieldPath,
          value: pattern,
          refPattern: pattern,
          reason: `Invalid GTS wildcard pattern: ${pattern}`,
        };
      }
      return null;
    }

    // Specific GTS ID
    if (!Gts.isValidGtsID(pattern)) {
      return {
        fieldPath,
        value: pattern,
        refPattern: pattern,
        reason: `Invalid GTS identifier: ${pattern}`,
      };
    }
    return null;
  }

  private validateGtsPattern(value: string, pattern: string, fieldPath: string): XGtsRefValidationError | null {
    // Shared pattern matching (also used by the structural x-gts-ref keyword).
    const reason = gtsPatternViolation(value, pattern);
    if (reason !== null) {
      return { fieldPath, value, refPattern: pattern, reason };
    }

    // The referenced value must resolve to a registered entity when a store is
    // available and existence enforcement is enabled. Existence is enforced
    // uniformly for all constraint forms, including wildcard patterns and the
    // bare `gts.*` wildcard (gts-spec §9.6): the value has already been checked
    // to be a well-formed GTS id that matches the pattern, so it only remains
    // to confirm at least one registered type/instance resolves it.
    if (this.store && this.mode !== GtsRefValidationMode.None) {
      // A reference to the entity currently being validated (e.g. an instance
      // whose x-gts-ref value is its own id) is satisfied by that entity
      // itself. Under validate-before-register the entity is not yet in the
      // registry, so a plain lookup would spuriously fail; and its validity is
      // already being decided by this very call, so there is nothing further
      // to check. This mirrors the transitive cycle guard that handled an
      // already-registered self-reference, without enqueueing the unregistered
      // self as a dependency (which `validateEntityTransitive` would reject as
      // "Entity not found" before its own visiting-guard could apply).
      if (this.selfId !== undefined && value === this.selfId) {
        return null;
      }
      const entity = this.store.get(value);
      if (!entity) {
        return {
          fieldPath,
          value,
          refPattern: pattern,
          reason: `Referenced entity '${value}' not found in registry`,
        };
      }
      this.referencedIds.add(value);
    }

    return null;
  }

  /** Check registry existence for concrete, wildcard, and /$id constraints. */
  validateSchemaRefExistence(schema: any, schemaPath: string = '', selectedTypeId?: string): XGtsRefValidationError[] {
    const errors: XGtsRefValidationError[] = [];
    if (!this.store || this.mode === GtsRefValidationMode.None) {
      return errors;
    }
    this.visitSchemaRefExistence(schema, schemaPath, this.getSelectedTypeId(schema, selectedTypeId), errors);
    return errors;
  }

  private visitSchemaRefExistence(
    schema: any,
    path: string,
    selectedTypeId: string | undefined,
    errors: XGtsRefValidationError[]
  ): void {
    if (!schema || typeof schema !== 'object') return;

    const ref = schema['x-gts-ref'];
    const refPath = appendJsonPointer(path, 'x-gts-ref');
    const resolvedRef = this.isSelfReference(ref) ? selectedTypeId : ref;
    if (typeof resolvedRef === 'string' && resolvedRef.startsWith(GTS_PREFIX)) {
      if (resolvedRef.includes('*')) {
        const matches =
          this.store?.getAll?.().filter((entity) => Gts.matchIDPattern(entity.id, resolvedRef).match) ?? [];
        if (matches.length === 0) {
          errors.push({
            fieldPath: refPath,
            value: ref,
            refPattern: resolvedRef,
            reason: `x-gts-ref wildcard constraint '${resolvedRef}' has no registered match`,
          });
        } else {
          this.referencedWildcardPatterns.add(resolvedRef);
        }
      } else if (this.store && !this.store.get(resolvedRef)) {
        errors.push({
          fieldPath: refPath,
          value: ref,
          refPattern: resolvedRef,
          reason: `x-gts-ref constraint type '${resolvedRef}' is not registered`,
        });
      } else {
        this.referencedIds.add(resolvedRef);
      }
    }

    visitJsonSubschemas(schema, path, (subschema, subschemaPath) => {
      this.visitSchemaRefExistence(subschema, subschemaPath, selectedTypeId, errors);
    });
  }

  private containsXGtsRef(schema: any): boolean {
    if (!schema || typeof schema !== 'object') return false;
    if (schema['x-gts-ref'] !== undefined) return true;
    for (const value of Object.values(schema)) {
      if (Array.isArray(value)) {
        if (value.some((item) => this.containsXGtsRef(item))) return true;
      } else if (value && typeof value === 'object') {
        if (this.containsXGtsRef(value)) return true;
      }
    }
    return false;
  }
}
