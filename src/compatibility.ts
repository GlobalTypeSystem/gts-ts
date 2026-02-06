import { CompatibilityResult } from './types';
import { GtsStore } from './store';
import { Gts } from './gts';

export class GtsCompatibility {
  static checkCompatibility(
    store: GtsStore,
    oldId: string,
    newId: string,
    _mode: 'backward' | 'forward' | 'full' = 'full'
  ): CompatibilityResult {
    const backwardErrors: string[] = [];
    const forwardErrors: string[] = [];

    try {
      const oldGtsId = Gts.parseGtsID(oldId);
      const newGtsId = Gts.parseGtsID(newId);

      const oldEntity = store.get(oldGtsId.id);
      const newEntity = store.get(newGtsId.id);

      if (!oldEntity) {
        backwardErrors.push(`Old schema not found: ${oldId}`);
        return this.buildResult(oldId, newId, false, false, false, backwardErrors, forwardErrors);
      }

      if (!newEntity) {
        backwardErrors.push(`New schema not found: ${newId}`);
        return this.buildResult(oldId, newId, false, false, false, backwardErrors, forwardErrors);
      }

      if (!oldEntity.isSchema) {
        backwardErrors.push(`Old entity is not a schema: ${oldId}`);
        return this.buildResult(oldId, newId, false, false, false, backwardErrors, forwardErrors);
      }

      if (!newEntity.isSchema) {
        backwardErrors.push(`New entity is not a schema: ${newId}`);
        return this.buildResult(oldId, newId, false, false, false, backwardErrors, forwardErrors);
      }

      const oldSchema = oldEntity.content;
      const newSchema = newEntity.content;

      const isBackward = this.checkBackwardCompatibility(oldSchema, newSchema, backwardErrors);
      const isForward = this.checkForwardCompatibility(oldSchema, newSchema, forwardErrors);
      const isFullyCompatible = isBackward && isForward;

      return this.buildResult(oldId, newId, isFullyCompatible, isBackward, isForward, backwardErrors, forwardErrors);
    } catch (error) {
      backwardErrors.push(error instanceof Error ? error.message : String(error));
      return this.buildResult(oldId, newId, false, false, false, backwardErrors, forwardErrors);
    }
  }

  private static buildResult(
    oldId: string,
    newId: string,
    isFullyCompatible: boolean,
    isBackward: boolean,
    isForward: boolean,
    backwardErrors: string[],
    forwardErrors: string[]
  ): CompatibilityResult {
    return {
      from: oldId,
      to: newId,
      old: oldId,
      new: newId,
      direction: this.inferDirection(oldId, newId),
      added_properties: [],
      removed_properties: [],
      changed_properties: [],
      is_fully_compatible: isFullyCompatible,
      is_backward_compatible: isBackward,
      is_forward_compatible: isForward,
      incompatibility_reasons: [...backwardErrors, ...forwardErrors],
      backward_errors: backwardErrors,
      forward_errors: forwardErrors,
    };
  }

  private static inferDirection(fromId: string, toId: string): string {
    try {
      const fromGtsId = Gts.parseGtsID(fromId);
      const toGtsId = Gts.parseGtsID(toId);

      if (!fromGtsId.segments.length || !toGtsId.segments.length) {
        return 'unknown';
      }

      const fromSeg = fromGtsId.segments[fromGtsId.segments.length - 1];
      const toSeg = toGtsId.segments[toGtsId.segments.length - 1];

      if (fromSeg.verMajor < toSeg.verMajor) return 'upgrade';
      if (fromSeg.verMajor > toSeg.verMajor) return 'downgrade';
      if ((fromSeg.verMinor || 0) < (toSeg.verMinor || 0)) return 'upgrade';
      if ((fromSeg.verMinor || 0) > (toSeg.verMinor || 0)) return 'downgrade';

      return 'same';
    } catch {
      return 'unknown';
    }
  }

  private static checkBackwardCompatibility(oldSchema: any, newSchema: any, errors: string[]): boolean {
    const oldProps = oldSchema.properties || {};
    const newProps = newSchema.properties || {};
    const oldRequired = new Set(oldSchema.required || []);

    let compatible = true;

    for (const propName of Object.keys(oldProps)) {
      if (!(propName in newProps)) {
        if (oldRequired.has(propName)) {
          errors.push(`Required property '${propName}' removed in new schema`);
          compatible = false;
        }
      } else {
        if (!this.checkPropertyCompatibility(propName, oldProps[propName], newProps[propName], errors, 'backward')) {
          compatible = false;
        }
      }
    }

    return compatible;
  }

  private static checkForwardCompatibility(oldSchema: any, newSchema: any, errors: string[]): boolean {
    const oldProps = oldSchema.properties || {};
    const newProps = newSchema.properties || {};
    const newRequired = new Set(newSchema.required || []);

    let compatible = true;

    for (const propName of Object.keys(newProps)) {
      if (!(propName in oldProps)) {
        if (newRequired.has(propName)) {
          errors.push(`New required property '${propName}' added`);
          compatible = false;
        }
      } else {
        if (!this.checkPropertyCompatibility(propName, oldProps[propName], newProps[propName], errors, 'forward')) {
          compatible = false;
        }
      }
    }

    return compatible;
  }

  private static checkPropertyCompatibility(
    propName: string,
    oldProp: any,
    newProp: any,
    errors: string[],
    direction: 'backward' | 'forward'
  ): boolean {
    const oldType = this.normalizeType(oldProp.type);
    const newType = this.normalizeType(newProp.type);

    if (oldType !== newType) {
      if (!this.areTypesCompatible(oldType, newType, direction)) {
        errors.push(`Property '${propName}' type incompatibly changed from ${oldType} to ${newType}`);
        return false;
      }
    }

    if (oldProp.enum && newProp.enum) {
      const oldEnum = new Set(oldProp.enum);
      const newEnum = new Set(newProp.enum);

      if (direction === 'backward') {
        for (const value of oldEnum) {
          if (!newEnum.has(value)) {
            errors.push(`Enum value '${value}' removed from property '${propName}'`);
            return false;
          }
        }
      }
    }

    return true;
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
