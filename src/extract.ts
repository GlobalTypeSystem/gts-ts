import { ExtractResult, GTS_URI_PREFIX } from './types';
import { Gts } from './gts';

export interface GtsConfig {
  entityIdFields: string[];
  schemaIdFields: string[];
}

export function getDefaultConfig(): GtsConfig {
  return {
    entityIdFields: ['$id', '$$id', 'gtsId', 'gtsIid', 'gtsOid', 'gtsI', 'gts_id', 'gts_oid', 'gts_iid', 'id'],
    schemaIdFields: ['$schema', '$$schema', 'gtsTid', 'gtsT', 'gts_t', 'gts_tid', 'type', 'schema'],
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
    const schemaField = content['$schema'] || content['$$schema'];
    if (typeof schemaField === 'string') {
      if (schemaField.includes('json-schema.org') || schemaField.startsWith('gts://')) {
        return true;
      }

      // If $schema points to a GTS type ID
      if (schemaField.startsWith('gts.')) {
        // Check if entity ID ends with ~ (indicates schema)
        const config = getDefaultConfig();
        const entityResult = this.findFirstValidField(content, config.entityIdFields);
        if (entityResult && entityResult.value.endsWith('~')) {
          return true;
        }

        // Check for schema-like properties
        if (schemaField.endsWith('~')) {
          if ('type' in content || 'properties' in content || 'items' in content || 'enum' in content) {
            return true;
          }
        }
      }
    }

    // Check if $id or $$id ends with ~ (schema marker)
    if (content['$$id'] && typeof content['$$id'] === 'string') {
      const id = this.normalizeValue(content['$$id'], '$$id');
      if (id.endsWith('~')) {
        return true;
      }
    }

    if (content['$id'] && typeof content['$id'] === 'string') {
      const id = this.normalizeValue(content['$id'], '$id');
      if (id.endsWith('~')) {
        return true;
      }
    }

    return false;
  }

  static extractID(content: any, schemaContent?: any): ExtractResult {
    const config = getDefaultConfig();
    let id = '';
    let schemaId = '';
    let selectedEntityField: string | undefined;
    let selectedSchemaIdField: string | undefined;
    const isSchema = this.isJsonSchema(content);

    if (typeof content === 'object' && content !== null) {
      // Extract entity ID
      const entityResult = this.findFirstValidField(content, config.entityIdFields);
      if (entityResult) {
        id = entityResult.value;
        selectedEntityField = entityResult.field;
      }

      // Extract schema ID
      const schemaResult = this.findFirstValidField(content, config.schemaIdFields);
      if (schemaResult) {
        schemaId = schemaResult.value;
        selectedSchemaIdField = schemaResult.field;
      }

      // If no schema ID found but entity ID is a type ID (ends with ~), use it as schema ID
      if (!schemaId && id && id.endsWith('~')) {
        schemaId = id;
        // Don't set selectedSchemaIdField - the entity ID itself is a type
      }

      // If entity ID contains ~, extract schema ID from it
      if (!schemaId && id && id.includes('~')) {
        const lastTilde = id.lastIndexOf('~');
        if (lastTilde > 0) {
          schemaId = id.substring(0, lastTilde + 1);
          if (!selectedSchemaIdField && selectedEntityField) {
            selectedSchemaIdField = selectedEntityField;
          }
        }
      }
    }

    // Try to extract from schemaContent if provided
    if (!schemaId && schemaContent && typeof schemaContent === 'object') {
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
