import { CompatibilityResult } from './types';
import { GtsStore } from './store';
import { Gts } from './gts';

export class GtsCompatibility {
  static checkCompatibility(
    store: GtsStore,
    oldId: string,
    newId: string,
    mode: 'backward' | 'forward' | 'full' = 'full'
  ): CompatibilityResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      const oldGtsId = Gts.parseGtsID(oldId);
      const newGtsId = Gts.parseGtsID(newId);

      const oldEntity = store.get(oldGtsId.id);
      const newEntity = store.get(newGtsId.id);

      if (!oldEntity) {
        errors.push(`Old schema not found: ${oldId}`);
        return { compatible: false, oldId, newId, mode, errors, warnings };
      }

      if (!newEntity) {
        errors.push(`New schema not found: ${newId}`);
        return { compatible: false, oldId, newId, mode, errors, warnings };
      }

      if (!oldEntity.isSchema) {
        errors.push(`Old entity is not a schema: ${oldId}`);
        return { compatible: false, oldId, newId, mode, errors, warnings };
      }

      if (!newEntity.isSchema) {
        errors.push(`New entity is not a schema: ${newId}`);
        return { compatible: false, oldId, newId, mode, errors, warnings };
      }

      const oldSchema = oldEntity.content;
      const newSchema = newEntity.content;

      if (mode === 'backward' || mode === 'full') {
        this.checkBackwardCompatibility(oldSchema, newSchema, errors, warnings);
      }

      if (mode === 'forward' || mode === 'full') {
        this.checkForwardCompatibility(oldSchema, newSchema, errors, warnings);
      }

      return {
        compatible: errors.length === 0,
        oldId,
        newId,
        mode,
        errors,
        warnings,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return {
        compatible: false,
        oldId,
        newId,
        mode,
        errors,
        warnings,
      };
    }
  }

  private static checkBackwardCompatibility(
    oldSchema: any,
    newSchema: any,
    errors: string[],
    warnings: string[]
  ): void {
    const oldProps = oldSchema.properties || {};
    const newProps = newSchema.properties || {};
    const oldRequired = new Set(oldSchema.required || []);
    const newRequired = new Set(newSchema.required || []);

    for (const prop of oldRequired) {
      if (!newRequired.has(prop)) {
        warnings.push(`Property '${prop}' is no longer required in new schema`);
      }
    }

    for (const [propName, propSchema] of Object.entries(oldProps)) {
      if (!(propName in newProps)) {
        if (oldRequired.has(propName)) {
          errors.push(`Required property '${propName}' removed in new schema`);
        } else {
          warnings.push(`Optional property '${propName}' removed in new schema`);
        }
      } else {
        this.checkPropertyCompatibility(propName, propSchema, newProps[propName], errors, warnings, 'backward');
      }
    }
  }

  private static checkForwardCompatibility(oldSchema: any, newSchema: any, errors: string[], warnings: string[]): void {
    const oldProps = oldSchema.properties || {};
    const newProps = newSchema.properties || {};
    const oldRequired = new Set(oldSchema.required || []);
    const newRequired = new Set(newSchema.required || []);

    for (const prop of newRequired) {
      if (!oldRequired.has(prop)) {
        errors.push(`New required property '${prop}' added in new schema`);
      }
    }

    for (const [propName, propSchema] of Object.entries(newProps)) {
      if (!(propName in oldProps)) {
        if (newRequired.has(propName)) {
          errors.push(`New required property '${propName}' added`);
        } else {
          warnings.push(`New optional property '${propName}' added`);
        }
      } else {
        this.checkPropertyCompatibility(propName, oldProps[propName], propSchema, errors, warnings, 'forward');
      }
    }
  }

  private static checkPropertyCompatibility(
    propName: string,
    oldProp: any,
    newProp: any,
    errors: string[],
    warnings: string[],
    direction: 'backward' | 'forward'
  ): void {
    const oldType = this.normalizeType(oldProp.type);
    const newType = this.normalizeType(newProp.type);

    if (oldType !== newType) {
      if (this.areTypesCompatible(oldType, newType, direction)) {
        warnings.push(`Property '${propName}' type changed from ${oldType} to ${newType}`);
      } else {
        errors.push(`Property '${propName}' type incompatibly changed from ${oldType} to ${newType}`);
      }
    }

    if (oldProp.enum && newProp.enum) {
      const oldEnum = new Set(oldProp.enum);
      const newEnum = new Set(newProp.enum);

      if (direction === 'backward') {
        for (const value of oldEnum) {
          if (!newEnum.has(value)) {
            errors.push(`Enum value '${value}' removed from property '${propName}'`);
          }
        }
      } else {
        for (const value of newEnum) {
          if (!oldEnum.has(value)) {
            warnings.push(`Enum value '${value}' added to property '${propName}'`);
          }
        }
      }
    }
  }

  private static normalizeType(type: any): string {
    if (Array.isArray(type)) {
      return type.join('|');
    }
    return type || 'any';
  }

  private static areTypesCompatible(oldType: string, newType: string, direction: 'backward' | 'forward'): boolean {
    if (oldType === newType) return true;

    if (direction === 'backward') {
      if (newType === 'any') return true;
      if (oldType === 'integer' && newType === 'number') return true;
    } else {
      if (oldType === 'any') return true;
      if (newType === 'integer' && oldType === 'number') return true;
    }

    const oldTypes = new Set(oldType.split('|'));
    const newTypes = new Set(newType.split('|'));

    if (direction === 'backward') {
      for (const t of oldTypes) {
        if (!newTypes.has(t)) return false;
      }
    } else {
      for (const t of newTypes) {
        if (!oldTypes.has(t)) return false;
      }
    }

    return true;
  }
}
