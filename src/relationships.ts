import { RelationshipResult } from './types';
import { GtsStore } from './store';
import { Gts } from './gts';

export class GtsRelationships {
  static resolveRelationships(store: GtsStore, gtsId: string): RelationshipResult {
    try {
      const entity = store.get(gtsId);
      if (!entity) {
        return {
          id: gtsId,
          relationships: [],
          brokenReferences: [],
          error: `Entity not found: ${gtsId}`,
        };
      }

      const relationships: Set<string> = new Set();
      const brokenReferences: Set<string> = new Set();

      const visited = new Set<string>();
      this.findRelationships(store, entity.content, relationships, brokenReferences, visited);

      if (entity.schemaId) {
        relationships.add(entity.schemaId);
        const schemaEntity = store.get(entity.schemaId);
        if (!schemaEntity) {
          brokenReferences.add(entity.schemaId);
        }
      }

      return {
        id: gtsId,
        relationships: Array.from(relationships).sort(),
        brokenReferences: Array.from(brokenReferences).sort(),
      };
    } catch (error) {
      return {
        id: gtsId,
        relationships: [],
        brokenReferences: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private static findRelationships(
    store: GtsStore,
    obj: any,
    relationships: Set<string>,
    brokenReferences: Set<string>,
    visited: Set<any>
  ): void {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) {
      return;
    }

    visited.add(obj);

    if ('$ref' in obj && typeof obj['$ref'] === 'string') {
      const ref = obj['$ref'];
      const normalized = ref.startsWith('gts://') ? ref.substring(6) : ref;
      if (Gts.isValidGtsID(normalized)) {
        relationships.add(normalized);
        if (!store.get(normalized)) {
          brokenReferences.add(normalized);
        }
      }
    }

    if ('x-gts-ref' in obj && typeof obj['x-gts-ref'] === 'string') {
      const ref = obj['x-gts-ref'];
      if (Gts.isValidGtsID(ref)) {
        relationships.add(ref);
        if (!store.get(ref)) {
          brokenReferences.add(ref);
        }
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        this.findRelationships(store, item, relationships, brokenReferences, visited);
      }
    } else {
      for (const value of Object.values(obj)) {
        this.findRelationships(store, value, relationships, brokenReferences, visited);
      }
    }
  }
}
