import { CastResult } from './types';
import { GtsStore } from './store';
import { Gts } from './gts';
import { GtsCompatibility } from './compatibility';

export class GtsCast {
  static castInstance(store: GtsStore, fromId: string, toSchemaId: string): CastResult {
    try {
      const fromGtsId = Gts.parseGtsID(fromId);
      const fromEntity = store.get(fromGtsId.id);

      if (!fromEntity) {
        return {
          ok: false,
          fromId,
          toId: toSchemaId,
          error: `Instance not found: ${fromId}`,
        };
      }

      if (!fromEntity.schemaId) {
        return {
          ok: false,
          fromId,
          toId: toSchemaId,
          error: `No schema found for instance: ${fromId}`,
        };
      }

      const toGtsId = Gts.parseGtsID(toSchemaId);
      const toSchema = store.get(toGtsId.id);

      if (!toSchema) {
        return {
          ok: false,
          fromId,
          toId: toSchemaId,
          error: `Target schema not found: ${toSchemaId}`,
        };
      }

      if (!toSchema.isSchema) {
        return {
          ok: false,
          fromId,
          toId: toSchemaId,
          error: `Target is not a schema: ${toSchemaId}`,
        };
      }

      const fromSchemaEntity = store.get(fromEntity.schemaId);
      if (!fromSchemaEntity) {
        return {
          ok: false,
          fromId,
          toId: toSchemaId,
          error: `Source schema not found: ${fromEntity.schemaId}`,
        };
      }

      const compatCheck = GtsCompatibility.checkCompatibility(store, fromEntity.schemaId, toSchemaId, 'full');

      if (!compatCheck.is_fully_compatible) {
        return {
          ok: false,
          fromId,
          toId: toSchemaId,
          error: `Schemas are not compatible: ${compatCheck.incompatibility_reasons.join('; ')}`,
        };
      }

      const castedInstance = this.performCast(
        fromEntity.content,
        fromSchemaEntity.content,
        toSchema.content,
        toSchemaId
      );

      return {
        ok: true,
        fromId,
        toId: toSchemaId,
        result: castedInstance,
      };
    } catch (error) {
      return {
        ok: false,
        fromId,
        toId: toSchemaId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private static performCast(instance: any, fromSchema: any, toSchema: any, toSchemaId: string): any {
    const result: any = { ...instance };

    const fromSegments = Gts.parseID(fromSchema['$$id'] || fromSchema['$id']).segments;
    const toSegments = Gts.parseID(toSchemaId).segments;

    if (fromSegments.length > 0 && toSegments.length > 0) {
      const fromVersion = `v${fromSegments[0].verMajor}.${fromSegments[0].verMinor ?? 0}`;
      const toVersion = `v${toSegments[0].verMajor}.${toSegments[0].verMinor ?? 0}`;

      if ('gtsId' in result) {
        result.gtsId = result.gtsId.replace(fromVersion, toVersion);
      }
    }

    if ('$schema' in result || '$$schema' in result) {
      result['$schema'] = toSchemaId;
      if ('$$schema' in result) {
        result['$$schema'] = toSchemaId;
      }
    }

    const toProps = toSchema.properties || {};
    const toRequired = new Set(toSchema.required || []);

    const filtered: any = {};
    for (const [key, value] of Object.entries(result)) {
      if (key in toProps || key === 'gtsId' || key === '$schema' || key === '$$schema') {
        filtered[key] = value;
      }
    }

    for (const prop of toRequired) {
      if (!((prop as string) in filtered)) {
        const propSchema = toProps[prop as string];
        if (propSchema) {
          filtered[prop as string] = this.getDefaultValue(propSchema);
        }
      }
    }

    // Also add properties with default values that aren't required
    for (const [propName, propSchema] of Object.entries(toProps)) {
      if (!(propName in filtered) && propSchema && typeof propSchema === 'object' && 'default' in propSchema) {
        filtered[propName] = propSchema.default;
      }
    }

    return filtered;
  }

  private static getDefaultValue(schema: any): any {
    if ('default' in schema) {
      return schema.default;
    }

    const type = schema.type;
    if (Array.isArray(type)) {
      if (type.includes('null')) {
        return null;
      }
      return this.getDefaultForType(type[0]);
    }

    return this.getDefaultForType(type);
  }

  private static getDefaultForType(type: string): any {
    switch (type) {
      case 'string':
        return '';
      case 'number':
      case 'integer':
        return 0;
      case 'boolean':
        return false;
      case 'array':
        return [];
      case 'object':
        return {};
      default:
        return null;
    }
  }
}
