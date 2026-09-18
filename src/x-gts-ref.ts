/*
 * x-gts-ref validation for GTS schemas
 * Validates that string values match specified GTS ID patterns
 */

import { Gts } from './gts';
import { EntityLookup, MAX_SCHEMA_DEPTH, MAX_SCHEMA_PATHS } from './types';

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

export function visitJsonSubschemas(schema: any, path: string, visit: (subschema: any, path: string) => void): void {
  for (const [key, value] of Object.entries(schema)) {
    const nestedPath = path ? `${path}/${key}` : key;
    if (SCHEMA_VALUE_KEYWORDS.has(key)) {
      visit(value, nestedPath);
    } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${nestedPath}[${index}]`));
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, childSchema] of Object.entries(value)) {
        visit(childSchema, `${nestedPath}/${name}`);
      }
    } else if (key === 'items') {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${nestedPath}[${index}]`));
      } else {
        visit(value, nestedPath);
      }
    } else if (key === 'dependencies' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, dependency] of Object.entries(value)) {
        if (!Array.isArray(dependency)) {
          visit(dependency, `${nestedPath}/${name}`);
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
  private enforceExistence: boolean;
  private referencedIds: Set<string> = new Set();

  /**
   * @param store Entity registry used to check that referenced GTS IDs actually
   *   exist. Omit it (or pass `undefined`) to validate only the GTS-ID
   *   format/pattern of referenced values without requiring the referenced
   *   entity to be registered.
   * @param enforceExistence When `true` (the default) and a `store` is
   *   provided, an `x-gts-ref` value must resolve to a registered entity or
   *   validation fails. Existence is enforced uniformly for every constraint
   *   form, including wildcard patterns and the bare `gts.*` wildcard
   *   (gts-spec §9.6). Set to `false` to validate only that the value is a
   *   well-formed GTS id matching the constraint pattern, without requiring the
   *   referenced entity to be registered.
   */
  constructor(store?: EntityLookup, enforceExistence: boolean = true) {
    this.store = store;
    this.enforceExistence = enforceExistence;
  }

  getReferencedIds(): Set<string> {
    return new Set(this.referencedIds);
  }

  /**
   * Validate an instance against x-gts-ref constraints in schema
   */
  validateInstance(instance: any, schema: any, instancePath: string = ''): XGtsRefValidationError[] {
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
    if (typeof schema.$ref === 'string' && (schema.$ref === '#' || schema.$ref.startsWith('#/'))) {
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
        this.visitInstance(instance, resolved, path, rootSchema, errors, depth + 1, pathBudget);
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
        const err = this.validateRefValue(instance, schema['x-gts-ref'], path, rootSchema);
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
            const propPath = path ? `${path}.${propName}` : propName;
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
    if (schema.type === 'array' && schema.items) {
      if (Array.isArray(instance)) {
        instance.forEach((item, idx) => {
          const itemPath = `${path}[${idx}]`;
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

  /**
   * Resolve a local JSON-pointer `$ref` (`#` or `#/...`) against the root
   * schema. Only local pointers are supported here - `x-gts-ref` traversal
   * only ever needs to follow refs within the same schema document (e.g. a
   * `properties` entry pointing into `definitions`, or a recursive
   * `$ref: "#"` back to the root).
   */
  private resolveSchemaRef(rootSchema: any, ref: string): any {
    if (ref === '#') return rootSchema;
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
      const refPath = path ? `${path}/x-gts-ref` : 'x-gts-ref';
      const err = this.validateRefPattern(schema['x-gts-ref'], refPath, rootSchema);
      if (err) {
        errors.push(err);
      }
    }

    visitJsonSubschemas(schema, path, (subschema, subschemaPath) => {
      this.visitSchema(subschema, subschemaPath, rootSchema, errors);
    });
  }

  private validateRefValue(
    value: string,
    refPattern: any,
    fieldPath: string,
    schema: any
  ): XGtsRefValidationError | null {
    if (typeof refPattern !== 'string') {
      return {
        fieldPath,
        value,
        refPattern: String(refPattern),
        reason: `Value must be a string, got ${typeof refPattern}`,
      };
    }

    let resolvedPattern = refPattern;

    // Resolve pattern if it's a relative reference
    if (refPattern.startsWith('/')) {
      const resolved = this.resolvePointer(schema, refPattern);
      if (!resolved) {
        return {
          fieldPath,
          value,
          refPattern,
          reason: `Cannot resolve reference path '${refPattern}'`,
        };
      }

      // Check if the resolved value is a pointer that needs further resolution
      if (resolved.startsWith('/')) {
        const furtherResolved = this.resolvePointer(schema, resolved);
        if (!furtherResolved) {
          return {
            fieldPath,
            value,
            refPattern,
            reason: `Cannot resolve nested reference '${refPattern}' -> '${resolved}'`,
          };
        }
        resolvedPattern = furtherResolved;
      } else {
        resolvedPattern = resolved;
      }

      if (!resolvedPattern.startsWith('gts.')) {
        return {
          fieldPath,
          value,
          refPattern,
          reason: `Resolved reference '${refPattern}' -> '${resolvedPattern}' is not a GTS pattern`,
        };
      }
    }

    // Validate against GTS pattern
    return this.validateGtsPattern(value, resolvedPattern, fieldPath);
  }

  private validateRefPattern(refPattern: any, fieldPath: string, rootSchema: any): XGtsRefValidationError | null {
    if (typeof refPattern !== 'string') {
      return {
        fieldPath,
        value: refPattern,
        refPattern: '',
        reason: `x-gts-ref value must be a string, got ${typeof refPattern}`,
      };
    }

    // Case 1: Absolute GTS pattern
    if (refPattern.startsWith('gts.')) {
      return this.validateGtsIDOrPattern(refPattern, fieldPath);
    }

    // Case 2: Relative reference
    if (refPattern.startsWith('/')) {
      const resolved = this.resolvePointer(rootSchema, refPattern);
      if (!resolved) {
        return {
          fieldPath,
          value: refPattern,
          refPattern,
          reason: `Cannot resolve reference path '${refPattern}'`,
        };
      }
      if (!Gts.isValidGtsID(resolved)) {
        return {
          fieldPath,
          value: refPattern,
          refPattern,
          reason: `Resolved reference '${refPattern}' -> '${resolved}' is not a valid GTS identifier`,
        };
      }
      return null;
    }

    return {
      fieldPath,
      value: refPattern,
      refPattern,
      reason: `Invalid x-gts-ref value: '${refPattern}' must start with 'gts.' or '/'`,
    };
  }

  private validateGtsIDOrPattern(pattern: string, fieldPath: string): XGtsRefValidationError | null {
    if (pattern === 'gts.*') {
      return null; // Valid wildcard
    }

    if (pattern.includes('*')) {
      // Wildcard pattern - validate prefix
      const prefix = pattern.replace('*', '');
      if (!prefix.startsWith('gts.')) {
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
    // Validate it's a valid GTS ID
    if (!Gts.isValidGtsID(value)) {
      return {
        fieldPath,
        value,
        refPattern: pattern,
        reason: `Value '${value}' is not a valid GTS identifier`,
      };
    }

    // Check pattern match
    if (pattern === 'gts.*') {
      // Any valid GTS ID matches
    } else if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (!value.startsWith(prefix)) {
        return {
          fieldPath,
          value,
          refPattern: pattern,
          reason: `Value '${value}' does not match pattern '${pattern}'`,
        };
      }
    } else if (!value.startsWith(pattern)) {
      return {
        fieldPath,
        value,
        refPattern: pattern,
        reason: `Value '${value}' does not match pattern '${pattern}'`,
      };
    }

    // The referenced value must resolve to a registered entity when a store is
    // available and existence enforcement is enabled. Existence is enforced
    // uniformly for all constraint forms, including wildcard patterns and the
    // bare `gts.*` wildcard (gts-spec §9.6): the value has already been checked
    // to be a well-formed GTS id that matches the pattern, so it only remains
    // to confirm at least one registered type/instance resolves it. Callers
    // that only need format/pattern validation construct this validator with
    // `enforceExistence` set to `false` (or without a store).
    if (this.store && this.enforceExistence) {
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

  /**
   * Walk a schema and verify that every concrete (non-wildcard, non-relative)
   * x-gts-ref names a constraint type that is registered. This enforces the
   * reference-implementation rule that an x-gts-ref must point at an existing
   * constraint type even when no value is supplied: gts-spec §9.6 leaves
   * reference-existence checking to the implementation, and the reference
   * implementation treats a dangling x-gts-ref target like a dangling $ref.
   * Wildcard patterns name a family rather than one concrete dependency.
   * Relative pointer references are resolved against the root schema before
   * their target existence is checked. Existence is only checked when a store
   * is available and enforcement is enabled.
   */
  validateSchemaRefExistence(schema: any, schemaPath: string = ''): XGtsRefValidationError[] {
    const errors: XGtsRefValidationError[] = [];
    if (!this.store || !this.enforceExistence) {
      return errors;
    }
    this.visitSchemaRefExistence(schema, schemaPath, schema, errors);
    return errors;
  }

  private visitSchemaRefExistence(schema: any, path: string, rootSchema: any, errors: XGtsRefValidationError[]): void {
    if (!schema || typeof schema !== 'object') return;

    const ref = schema['x-gts-ref'];
    const refPath = path ? `${path}/x-gts-ref` : 'x-gts-ref';
    const resolvedRef = typeof ref === 'string' && ref.startsWith('/') ? this.resolvePointer(rootSchema, ref) : ref;
    if (typeof ref === 'string' && ref.startsWith('/') && !resolvedRef) {
      errors.push({
        fieldPath: refPath,
        value: ref,
        refPattern: '',
        reason: `x-gts-ref constraint pointer '${ref}' does not resolve to a string`,
      });
    } else if (typeof resolvedRef === 'string' && resolvedRef.startsWith('gts.') && !resolvedRef.includes('*')) {
      if (this.store && !this.store.get(resolvedRef)) {
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
      this.visitSchemaRefExistence(subschema, subschemaPath, rootSchema, errors);
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

  /**
   * Strip the "gts://" prefix from a value if present
   */
  private stripGtsURIPrefix(value: string): string {
    return value.replace(/^gts:\/\//, '');
  }

  /**
   * Resolve a JSON Pointer in the schema
   * Note: For /$id references, the gts:// prefix is stripped from the value
   */
  private resolvePointer(schema: any, pointer: string): string {
    const path = pointer.startsWith('/') ? pointer.slice(1) : pointer;
    if (!path) return '';

    const parts = path.split('/');
    let current: any = schema;

    for (const part of parts) {
      if (!current || typeof current !== 'object') {
        return '';
      }
      current = current[part];
      if (current === undefined) {
        return '';
      }
    }

    // If current is a string, return it (stripping gts:// prefix if present)
    if (typeof current === 'string') {
      return this.stripGtsURIPrefix(current);
    }

    // If current is a dict with x-gts-ref, resolve it
    if (current && typeof current === 'object' && current['x-gts-ref']) {
      const xGtsRef = current['x-gts-ref'];
      if (typeof xGtsRef === 'string') {
        if (xGtsRef.startsWith('/')) {
          return this.resolvePointer(schema, xGtsRef);
        }
        return xGtsRef;
      }
    }

    return '';
  }
}
