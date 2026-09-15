/*
 * x-gts-ref validation for GTS schemas
 * Validates that string values match specified GTS ID patterns
 */

import { Gts } from './gts';
import { EntityLookup, MAX_SCHEMA_DEPTH, MAX_SCHEMA_PATHS } from './types';

export interface XGtsRefValidationError {
  fieldPath: string;
  value: any;
  refPattern: string;
  reason: string;
}

export class XGtsRefValidator {
  private store: EntityLookup | undefined;

  /**
   * @param store Entity registry used to check that referenced GTS IDs actually
   *   exist. Omit it (or pass `undefined`) to validate only the GTS-ID
   *   format/pattern of referenced values without requiring the referenced
   *   entity to be registered - e.g. for `x-gts-traits` values, which are
   *   schema-level example/default data rather than live references.
   */
  constructor(store?: EntityLookup) {
    this.store = store;
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

    // Recurse into nested structures
    for (const key in schema) {
      if (key === 'x-gts-ref') continue;

      const nestedPath = path ? `${path}/${key}` : key;
      const value = schema[key];

      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          value.forEach((item, idx) => {
            if (item && typeof item === 'object') {
              this.visitSchema(item, `${nestedPath}[${idx}]`, rootSchema, errors);
            }
          });
        } else {
          this.visitSchema(value, nestedPath, rootSchema, errors);
        }
      }
    }
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

    // Check if entity exists in store, when a store was provided. Callers
    // that only need format/pattern validation (no existence requirement)
    // construct this validator without a store.
    //
    // This is only meaningful - and only enforced - when `pattern` itself
    // names a concrete, registered GTS type: a wildcard pattern (`gts.*`,
    // `gts.x.foo.*`) names no single schema to check against, and a pattern
    // whose named type was never registered in this store at all names a
    // namespace this store has no knowledge of (e.g. a foreign/example
    // namespace used purely to document a type's expected shape, as is
    // common for `x-gts-traits-schema` property descriptions - see
    // `TestCaseOp13_TraitsValid_AllResolved` et al in the canonical suite,
    // which reference `gts.x.core.events.topic.v1~` without ever
    // registering it and still expect success). Once the named type IS
    // registered, though, the store has enough information to check
    // instance-level existence, and a value naming a non-existent instance
    // under it must fail (`TestCaseOp13_TraitRef_TopicRefNonexistent` /
    // `TestCaseXGtsRef_PrefixAndSelfRef`, both of which register the
    // referenced type before relying on this check).
    //
    // Residual risk (P5-R1, deliberately not closed here): this gate cannot
    // distinguish "unregistered because it's a foreign/documentation
    // namespace" from "unregistered because of a typo in the `x-gts-ref`
    // type id itself". Both look identical to the store - `pattern` simply
    // has no entry - so a typo'd type id silently disables the entire
    // existence check for every value validated against it, the same way a
    // genuinely-external namespace legitimately does, and validation
    // reports success. The canonical suite requires exactly this shape
    // (`TestCaseOp13_TraitsValid_AllResolved` needs an unregistered type to
    // skip the check; `TestCaseOp13_TraitRef_TopicRefNonexistent` needs a
    // registered type to enforce it), so no reformulation of this condition
    // alone can close the gap without another signal (e.g. a separate
    // registry of "known-external" namespaces) to tell the two cases apart.
    if (this.store && !pattern.includes('*') && this.store.get(pattern)) {
      const entity = this.store.get(value);
      if (!entity) {
        return {
          fieldPath,
          value,
          refPattern: pattern,
          reason: `Referenced entity '${value}' not found in registry`,
        };
      }
    }

    return null;
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
