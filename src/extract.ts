import { ExtractResult, GTS_URI_PREFIX, GTS_PREFIX } from './types';
import { Gts } from './gts';

export interface GtsConfig {
  entityIdFields: string[];
  schemaIdFields: string[];
}

export function getDefaultConfig(): GtsConfig {
  return {
    entityIdFields: ['$id', '$$id', 'gtsId', 'gtsIid', 'gtsOid', 'gtsI', 'gts_id', 'gts_oid', 'gts_iid', 'id'],
    schemaIdFields: [
      '$schema',
      '$$schema',
      'gtsTid',
      'gtsType',
      'gtsT',
      'gts_t',
      'gts_tid',
      'gts_type',
      'type',
      'schema',
    ],
  };
}

export class GtsExtractor {
  private static normalizeValue(value: string, fieldName?: string): string {
    let normalized = value.trim();

    // Strip the "gts://" URI prefix for $id field (JSON Schema compatibility)
    if (fieldName === '$id' && normalized.startsWith(GTS_URI_PREFIX)) {
      normalized = normalized.substring(GTS_URI_PREFIX.length);
    } else if (normalized.startsWith(GTS_URI_PREFIX)) {
      normalized = normalized.substring(GTS_URI_PREFIX.length);
    }

    return normalized;
  }

  private static findFirstValidField(
    content: any,
    fields: string[],
    requireValid: boolean = false
  ): { field: string; value: string } | null {
    if (typeof content !== 'object' || content === null) {
      return null;
    }

    // Look for any field with a value
    for (const field of fields) {
      if (field in content && typeof content[field] === 'string') {
        const value = this.normalizeValue(content[field], field);
        if (value) {
          // If requireValid is true, only return valid GTS IDs
          if (requireValid) {
            if (Gts.isValidGtsID(value)) {
              return { field, value };
            }
          } else {
            // Return any non-empty value
            return { field, value };
          }
        }
      }
    }

    return null;
  }

  private static isJsonSchema(content: any): boolean {
    if (typeof content !== 'object' || content === null) {
      return false;
    }

    // Check for JSON Schema meta-schema
    // Issue #25: A document is a schema ONLY if $schema field is present
    const schemaField = content['$schema'] || content['$$schema'];
    if (typeof schemaField === 'string') {
      // Standard JSON Schema meta-schema URLs
      if (schemaField.includes('json-schema.org')) {
        return true;
      }
      // GTS schema reference (ends with ~)
      if (schemaField.startsWith(GTS_URI_PREFIX) || schemaField.startsWith(GTS_PREFIX)) {
        return true;
      }
    }

    return false;
  }

  static extractID(content: any, schemaContent?: any): ExtractResult {
    const config = getDefaultConfig();
    let id = '';
    let schemaId: string | null = null;
    let selectedEntityField: string | undefined;
    let selectedSchemaIdField: string | undefined;
    const isSchema = this.isJsonSchema(content);

    if (typeof content === 'object' && content !== null) {
      // Extract entity ID (look for any non-empty value, preferring valid GTS IDs)
      const entityResult = this.findFirstValidField(content, config.entityIdFields);
      if (entityResult) {
        id = entityResult.value;
        selectedEntityField = entityResult.field;
      }

      // Check if entity ID is a valid GTS ID
      const isValidGtsId = id && Gts.isValidGtsID(id);

      // An ID has a "chain" if there's a ~ somewhere in the middle (not just at the end)
      // e.g., "gts.a.b.c.d.v1~x.y.z.w.v2" or "gts.a.b.c.d.v1~x.y.z.w.v2~" both have chains
      // but "gts.a.b.c.d.v1~" does NOT have a chain (it's a base type)
      const hasChain =
        isValidGtsId &&
        (() => {
          // Find first ~
          const firstTilde = id.indexOf('~');
          if (firstTilde === -1) return false;
          // Check if there's anything meaningful after the first ~
          const afterTilde = id.substring(firstTilde + 1);
          // If ends with ~, remove it for chain check
          const checkPart = afterTilde.endsWith('~') ? afterTilde.slice(0, -1) : afterTilde;
          return checkPart.length > 0;
        })();

      if (isSchema) {
        // For schemas: extract schema_id based on rules
        // Rule: For base schemas, schema_id is the $schema field value
        // Rule: For derived schemas (chained $id), schema_id is the parent type from the chain
        if (hasChain && id.endsWith('~')) {
          // Derived schema - extract parent type from chain
          // e.g., "gts.x.core.events.type.v1~x.commerce.orders.order_placed.v1.0~"
          // -> schema_id = "gts.x.core.events.type.v1~"
          const withoutTrailingTilde = id.slice(0, -1);
          const lastTilde = withoutTrailingTilde.lastIndexOf('~');
          if (lastTilde > 0) {
            schemaId = id.substring(0, lastTilde + 1);
            selectedSchemaIdField = selectedEntityField;
          }
        } else if (hasChain && !id.endsWith('~')) {
          // Chained instance ID in schema (shouldn't happen, but handle it)
          const lastTilde = id.lastIndexOf('~');
          if (lastTilde > 0) {
            schemaId = id.substring(0, lastTilde + 1);
            selectedSchemaIdField = selectedEntityField;
          }
        } else {
          // Base schema (single segment type or no $id) - use $schema field value
          const schemaResult = this.findFirstValidField(content, ['$schema', '$$schema']);
          if (schemaResult) {
            schemaId = schemaResult.value;
            selectedSchemaIdField = schemaResult.field;
          }
        }
      } else {
        // For instances (non-schemas):
        // $id without $schema means the doc is an instance, NOT a schema
        // Even if $id ends with ~, without $schema it's not treated as a schema
        // So we should NOT derive schema_id from $id alone

        // Skip $id for non-schemas - $id without $schema should not be used for schema_id
        const isIdFromDollarId = selectedEntityField === '$id' || selectedEntityField === '$$id';

        if (hasChain && !isIdFromDollarId) {
          // Extract schema ID from chain (only if not from $id)
          const lastTilde = id.lastIndexOf('~');
          if (lastTilde > 0 && !id.endsWith('~')) {
            schemaId = id.substring(0, lastTilde + 1);
            selectedSchemaIdField = selectedEntityField;
          }
        }

        if (schemaId === null && !isIdFromDollarId) {
          // No chain or chain didn't provide schema_id - try explicit schema fields
          // But don't use schema_id_fields that are $id variants (they were already checked above)
          const explicitSchemaFields = config.schemaIdFields.filter((f) => f !== '$id' && f !== '$$id');
          const schemaResult = this.findFirstValidField(content, explicitSchemaFields, true);
          if (schemaResult) {
            schemaId = schemaResult.value;
            selectedSchemaIdField = schemaResult.field;
          }
        }

        // If schema_id is still null, check regular chained ID (including from $id)
        if (schemaId === null && hasChain && !id.endsWith('~')) {
          const lastTilde = id.lastIndexOf('~');
          if (lastTilde > 0) {
            schemaId = id.substring(0, lastTilde + 1);
            selectedSchemaIdField = selectedEntityField;
          }
        }
      }
    }

    // Try to extract from schemaContent if provided and schemaId is still null
    if (schemaId === null && schemaContent && typeof schemaContent === 'object') {
      const schemaEntityResult = this.findFirstValidField(schemaContent, config.entityIdFields);
      if (schemaEntityResult) {
        schemaId = schemaEntityResult.value;
      }
    }

    return {
      id,
      schema_id: schemaId,
      selected_entity_field: selectedEntityField,
      selected_schema_id_field: selectedSchemaIdField,
      is_schema: isSchema,
    };
  }
}
