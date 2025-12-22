export * from './types';
export { Gts } from './gts';
export { GtsExtractor } from './extract';
export { GtsStore, createJsonEntity } from './store';
export { GtsRelationships } from './relationships';
export { GtsCompatibility } from './compatibility';
export { GtsCast } from './cast';
export { GtsQuery } from './query';

import { Gts } from './gts';
import { GtsExtractor } from './extract';
import { GtsStore, createJsonEntity } from './store';
import { GtsRelationships } from './relationships';
import { GtsCompatibility } from './compatibility';
import { GtsCast } from './cast';
import { GtsQuery } from './query';
import {
  ValidationResult,
  ParseResult,
  MatchResult,
  UUIDResult,
  ExtractResult,
  AttributeResult,
  QueryResult,
  RelationshipResult,
  CompatibilityResult,
  CastResult,
  GtsConfig,
} from './types';

export const isValidGtsID = (id: string): boolean => Gts.isValidGtsID(id);
export const validateGtsID = (id: string): ValidationResult => Gts.validateGtsID(id);
export const parseGtsID = (id: string): ParseResult => Gts.parseID(id);
export const matchIDPattern = (candidate: string, pattern: string): MatchResult =>
  Gts.matchIDPattern(candidate, pattern);
export const idToUUID = (id: string): UUIDResult => Gts.idToUUID(id);
export const extractID = (content: any, schemaContent?: any): ExtractResult =>
  GtsExtractor.extractID(content, schemaContent);

export class GTS {
  private store: GtsStore;

  constructor(config?: Partial<GtsConfig>) {
    this.store = new GtsStore(config);
  }

  register(content: any): void {
    const entity = createJsonEntity(content);
    this.store.register(entity);
  }

  get(id: string): any {
    const entity = this.store.get(id);
    return entity?.content;
  }

  validateInstance(id: string): ValidationResult {
    return this.store.validateInstance(id);
  }

  getAttribute(path: string): AttributeResult {
    // Parse the combined path format: gts_id@attr_path
    const atIndex = path.indexOf('@');
    if (atIndex === -1) {
      return {
        path,
        resolved: false,
        error: 'Invalid attribute path: missing @',
      };
    }
    const gtsId = path.substring(0, atIndex);
    const attrPath = path.substring(atIndex + 1);
    return this.store.getAttribute(gtsId, attrPath);
  }

  query(expression: string, limit?: number): QueryResult {
    return GtsQuery.query(this.store, expression, limit);
  }

  resolveRelationships(id: string): RelationshipResult {
    return GtsRelationships.resolveRelationships(this.store, id);
  }

  checkCompatibility(
    oldId: string,
    newId: string,
    mode: 'backward' | 'forward' | 'full' = 'full'
  ): CompatibilityResult {
    return GtsCompatibility.checkCompatibility(this.store, oldId, newId, mode);
  }

  castInstance(fromId: string, toSchemaId: string): CastResult {
    return GtsCast.castInstance(this.store, fromId, toSchemaId);
  }
}

export default GTS;
