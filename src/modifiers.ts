/**
 * GTS Type Schema Modifiers - `x-gts-final` / `x-gts-abstract` (spec §9.11),
 * plus the shared document-level keyword placement rule (§9.7.1 / §9.11.5).
 *
 * - `x-gts-final: true`   - the type cannot be inherited from.
 * - `x-gts-abstract: true` - the type cannot be directly instantiated.
 *
 * Both are type-level keywords: they describe the GTS Type as a whole and are
 * only meaningful at the top level of the schema document. The same is true of
 * the two trait keywords, so the placement check covers all four.
 */

import { MAX_SCHEMA_DEPTH } from './types';
import { SCHEMA_KEYWORD_POSITIONS } from './compatibility';

export const X_GTS_FINAL = 'x-gts-final';
export const X_GTS_ABSTRACT = 'x-gts-abstract';
export const X_GTS_TRAITS = 'x-gts-traits';
export const X_GTS_TRAITS_SCHEMA = 'x-gts-traits-schema';
export const X_GTS_REF = 'x-gts-ref';

/**
 * The four keywords that describe the type as a whole and therefore MUST sit at
 * the top level of the schema document (§9.7.1, §9.11.2 item 5, §9.11.3 item 6).
 */
export const DOCUMENT_LEVEL_KEYWORDS = [X_GTS_FINAL, X_GTS_ABSTRACT, X_GTS_TRAITS_SCHEMA, X_GTS_TRAITS];

/**
 * The complete set of `x-gts-*` schema keywords this implementation defines
 * (gts-spec 0.13.3, README.md:1847, "spec: reject unknown x-gts schema
 * keywords"). Any other `x-gts-`-prefixed key found in a schema keyword
 * position - the document root or any subschema - is a schema-authoring
 * mistake (an unsupported keyword or a typo of one of these) and MUST be
 * rejected. Plain `x-*` vendor extensions that do not carry the `x-gts-`
 * prefix are untouched by this rule.
 */
export const SUPPORTED_X_GTS_KEYWORDS = [X_GTS_ABSTRACT, X_GTS_FINAL, X_GTS_TRAITS, X_GTS_TRAITS_SCHEMA, X_GTS_REF];

export class GtsModifiers {
  /** True when the schema declares `x-gts-final: true`; `false`/absent are no-ops. */
  static isFinal(schema: any): boolean {
    return this.readModifier(schema, X_GTS_FINAL) === true;
  }

  /** True when the schema declares `x-gts-abstract: true`; `false`/absent are no-ops. */
  static isAbstract(schema: any): boolean {
    return this.readModifier(schema, X_GTS_ABSTRACT) === true;
  }

  private static readModifier(schema: any, keyword: string): unknown {
    if (!schema || typeof schema !== 'object') return undefined;
    return schema[keyword];
  }

  /**
   * Checks the declaration of the modifiers on a single schema document:
   * non-boolean values and the meaningless `final + abstract` combination are
   * both invalid (§9.11.1). Returns an error message, or null when valid.
   */
  static validateDeclaration(schema: any): string | null {
    if (!schema || typeof schema !== 'object') return null;

    for (const keyword of [X_GTS_FINAL, X_GTS_ABSTRACT]) {
      const value = schema[keyword];
      if (value !== undefined && typeof value !== 'boolean') {
        return `${keyword} must be a boolean, got ${JSON.stringify(value)}`;
      }
    }

    if (schema[X_GTS_FINAL] === true && schema[X_GTS_ABSTRACT] === true) {
      return `a schema must not declare both ${X_GTS_FINAL} and ${X_GTS_ABSTRACT}`;
    }

    return null;
  }

  /**
   * Finds document-level GTS keywords that were placed inside a subschema
   * (an `allOf` entry, a `properties` value, a `definitions` entry, ...).
   * Such a keyword attaches to a subschema rather than to the type and MUST be
   * rejected rather than silently ignored.
   *
   * Returns the JSON paths of the misplaced keywords, empty when correct.
   */
  static findMisplacedKeywords(schema: any): string[] {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];

    const found: string[] = [];
    for (const [key, value] of Object.entries(schema)) {
      // The top-level occurrences are the correct placement. Their values are
      // trait data or a trait subschema, never a place for further keywords.
      if (DOCUMENT_LEVEL_KEYWORDS.includes(key)) continue;
      this.scanSubschemas(key, value, key, found, 0, this.isMisplacedCandidate);
    }
    return found;
  }

  /**
   * Finds `x-gts-*` schema keywords that are not part of the supported set
   * (gts-spec 0.13.3, README.md:1847), at the document root or in any
   * subschema. Unlike `findMisplacedKeywords`, this rule is not about
   * *placement* of an otherwise-known keyword - it flags the keyword *name*
   * itself, wherever it appears, including the root. A plain `x-*` key
   * without the `x-gts-` prefix is never flagged (ordinary vendor
   * extension); a key that merely happens to be spelled like an unsupported
   * `x-gts-*` keyword but sits in a literal-data position (a `properties` map
   * key, a `default`/`examples` value, ...) is never visited by the shared
   * walker below and so is never flagged either.
   *
   * Returns the JSON paths of the unknown keyword occurrences, empty when
   * every `x-gts-*` key in the document is one of the five supported ones.
   */
  static findUnknownKeywords(schema: any): string[] {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];

    const found: string[] = [];
    for (const [key, value] of Object.entries(schema)) {
      if (this.isUnsupportedXGts(key)) found.push(key);
      this.scanSubschemas(key, value, key, found, 0, this.isUnsupportedXGts);
    }
    return found;
  }

  private static isMisplacedCandidate(key: string): boolean {
    return DOCUMENT_LEVEL_KEYWORDS.includes(key);
  }

  private static isUnsupportedXGts(key: string): boolean {
    return key.startsWith('x-gts-') && !SUPPORTED_X_GTS_KEYWORDS.includes(key);
  }

  /**
   * Scans a *schema position* (never a data position) for keys matching
   * `matches`. Position-aware for the same reason `compatibility.ts`'s
   * `stripAnnotations` walk is: `{ properties: { 'x-gts-abstract': {...} } }`
   * names a property called `x-gts-abstract`, not an occurrence of the
   * keyword, and must not be flagged.
   */
  private static scan(
    node: any,
    path: string,
    found: string[],
    depth: number,
    matches: (key: string) => boolean
  ): void {
    if (!node || typeof node !== 'object') return;

    // The guard bounds recursion on pathological input. Stopping silently would
    // let a misplaced keyword below the limit through, so it fails closed: the
    // unscanned subtree is itself reported and the document is rejected.
    if (depth > MAX_SCHEMA_DEPTH) {
      found.push(`${path} (nesting exceeds ${MAX_SCHEMA_DEPTH} levels; cannot verify keyword placement)`);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) => this.scan(item, `${path}[${index}]`, found, depth + 1, matches));
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const childPath = `${path}/${key}`;
      if (matches(key)) {
        found.push(childPath);
        continue;
      }
      this.scanSubschemas(key, value, childPath, found, depth, matches);
    }
  }

  /** Recurses into `key`'s value only through the schema-bearing positions it defines. */
  private static scanSubschemas(
    key: string,
    value: any,
    path: string,
    found: string[],
    depth: number,
    matches: (key: string) => boolean
  ): void {
    // `dependencies` (draft-07) is heterogeneous per-entry: each map entry is
    // either a schema (schema dependency form) or a plain array of property
    // names (property dependency form). `compatibility.ts`'s KEYWORDS table
    // can't express that split without regressing its malformed-shape
    // detection for the array form, so it's handled locally here instead:
    // only the schema-shaped entries are schema positions worth scanning.
    if (key === 'dependencies') {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, sub] of Object.entries(value)) {
          if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
            this.scan(sub, `${path}/${name}`, found, depth + 1, matches);
          }
        }
      }
      return;
    }

    switch (SCHEMA_KEYWORD_POSITIONS[key]) {
      case 'schema':
        this.scan(value, path, found, depth + 1, matches);
        break;
      case 'schemaList':
        if (Array.isArray(value))
          value.forEach((item, index) => this.scan(item, `${path}[${index}]`, found, depth + 1, matches));
        break;
      case 'schemaMap':
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const [name, sub] of Object.entries(value)) {
            this.scan(sub, `${path}/${name}`, found, depth + 1, matches);
          }
        }
        break;
      default:
        // A data or unmodeled position: never a place a document-level keyword
        // can legitimately occur, and never a place to look for one either.
        break;
    }
  }
}
