/*
 * x-gts-ref validation for GTS schemas
 * Validates that string values match specified GTS ID patterns
 */

import { Gts } from './gts';
import { GtsStore } from './store';

export interface XGtsRefValidationError {
  fieldPath: string;
  value: any;
  refPattern: string;
  reason: string;
}

export class XGtsRefValidator {
  private store: GtsStore;

  constructor(store: GtsStore) {
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
    errors: XGtsRefValidationError[]
  ): void {
    if (!schema) return;

    // Check for x-gts-ref constraint
    if (schema['x-gts-ref'] !== undefined) {
      if (typeof instance === 'string') {
        const err = this.validateRefValue(instance, schema['x-gts-ref'], path, rootSchema);
        if (err) {
          errors.push(err);
        }
      }
    }

    // Recurse into object properties
    if (schema.type === 'object' && schema.properties) {
      if (instance && typeof instance === 'object') {
        for (const propName in schema.properties) {
          if (propName in instance) {
            const propPath = path ? `${path}.${propName}` : propName;
            this.visitInstance(instance[propName], schema.properties[propName], propPath, rootSchema, errors);
          }
        }
      }
    }

    // Recurse into array items
    if (schema.type === 'array' && schema.items) {
      if (Array.isArray(instance)) {
        instance.forEach((item, idx) => {
          const itemPath = `${path}[${idx}]`;
          this.visitInstance(item, schema.items, itemPath, rootSchema, errors);
        });
      }
    }
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

    // Optionally check if entity exists in store
    if (this.store) {
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
