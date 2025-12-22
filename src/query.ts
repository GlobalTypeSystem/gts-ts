import { QueryResult } from './types';
import { GtsStore } from './store';
import { Gts } from './gts';

export class GtsQuery {
  static query(store: GtsStore, expression: string, limit: number = 100): QueryResult {
    try {
      // Parse the query expression to extract base pattern and filters
      const { basePattern, filters, error } = this.parseQueryExpression(expression);

      if (error) {
        return {
          query: expression,
          count: 0,
          items: [],
          error: error,
          limit: limit,
        };
      }

      const results: any[] = [];

      // Iterate through all entities in the store
      for (const [id, entity] of store['byId']) {
        if (results.length >= limit) break;

        // Check if ID matches the pattern
        if (!this.matchesIDPattern(id, basePattern)) {
          continue;
        }

        // Check filters
        if (!this.matchesFilters(entity.content, filters)) {
          continue;
        }

        results.push(entity.content);
      }

      return {
        query: expression,
        count: results.length,
        items: results,
        limit: limit,
      };
    } catch (error) {
      return {
        query: expression,
        count: 0,
        items: [],
        error: error instanceof Error ? error.message : String(error),
        limit: limit,
      };
    }
  }

  private static parseQueryExpression(expr: string): {
    basePattern: string;
    filters: Map<string, string>;
    error?: string;
  } {
    // Split by '[' to separate base pattern from filters
    const parts = expr.split('[');
    const basePattern = parts[0].trim();
    const filters = new Map<string, string>();

    if (parts.length > 1) {
      // Extract filter string (remove trailing ])
      let filterStr = parts[1].trim();
      if (!filterStr.endsWith(']')) {
        return {
          basePattern,
          filters,
          error: "Invalid query: missing closing bracket ']'",
        };
      }
      filterStr = filterStr.slice(0, -1);

      // Check if base pattern ends with ~ or ~* (type ID/pattern) - filters not allowed on type queries
      if (basePattern.endsWith('~') || basePattern.endsWith('~*')) {
        return {
          basePattern,
          filters,
          error: 'Invalid query: filters cannot be used with type patterns (ending with ~ or ~*)',
        };
      }

      // Parse filters
      const filterParts = filterStr.split(',');
      for (const part of filterParts) {
        const trimmed = part.trim();
        if (trimmed.includes('=')) {
          const [key, ...valueParts] = trimmed.split('=');
          const value = valueParts
            .join('=')
            .trim()
            .replace(/^["']|["']$/g, '');
          filters.set(key.trim(), value);
        }
      }
    }

    // Validate the pattern
    const isWildcard = basePattern.includes('*');
    const validationError = this.validateQueryPattern(basePattern, isWildcard);
    if (validationError) {
      return {
        basePattern,
        filters,
        error: validationError,
      };
    }

    return { basePattern, filters };
  }

  private static validateQueryPattern(basePattern: string, isWildcard: boolean): string | undefined {
    if (isWildcard) {
      // Wildcard pattern must end with .* or ~*
      if (!basePattern.endsWith('.*') && !basePattern.endsWith('~*')) {
        return 'Invalid query: wildcard patterns must end with .* or ~*';
      }

      // Validate as wildcard pattern
      try {
        // Just check it's a valid pattern format
        if (!basePattern.startsWith('gts.')) {
          return "Invalid query: pattern must start with 'gts.'";
        }
      } catch (err) {
        return `Invalid query: ${err}`;
      }
    } else {
      // Non-wildcard pattern must be a complete valid GTS ID
      try {
        const result = Gts.parseID(basePattern);
        if (!result.ok) {
          return `Invalid query: ${result.error}`;
        }

        // Check if pattern is incomplete (missing version or type)
        // A complete GTS ID must end with a version (v1, v1.2) or ~ for types
        const segments = result.segments || [];
        if (segments.length === 0) {
          return 'Invalid query: GTS ID has no valid segments';
        }

        const lastSeg = segments[segments.length - 1];
        if (!lastSeg.isType && !lastSeg.verMajor) {
          return 'Invalid query: incomplete GTS ID pattern';
        }
      } catch (err) {
        return `Invalid query: ${err}`;
      }
    }

    return undefined;
  }

  private static matchesIDPattern(entityID: string, basePattern: string): boolean {
    // Always use the proper matchIDPattern function which handles wildcards and version matching
    const matchResult = Gts.matchIDPattern(entityID, basePattern);
    return matchResult.match;
  }

  private static matchesFilters(entityContent: any, filters: Map<string, string>): boolean {
    if (filters.size === 0) {
      return true;
    }

    if (!entityContent || typeof entityContent !== 'object') {
      return false;
    }

    for (const [key, value] of filters) {
      const entityValue = String(entityContent[key] ?? '');

      // Support wildcard in filter values
      if (value === '*') {
        // Wildcard matches any non-empty value
        if (!entityValue || entityValue === 'null' || entityValue === 'undefined') {
          return false;
        }
      } else if (entityValue !== value) {
        return false;
      }
    }

    return true;
  }
}
