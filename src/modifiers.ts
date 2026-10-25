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

import { forEachSchemaNode } from './schema-walk';
import { GTS_REF_KEYWORDS } from './ref-keywords';

export const X_GTS_FINAL = 'x-gts-final';
export const X_GTS_ABSTRACT = 'x-gts-abstract';
export const X_GTS_TRAITS = 'x-gts-traits';
export const X_GTS_TRAITS_SCHEMA = 'x-gts-traits-schema';

/**
 * The four keywords that describe the type as a whole and therefore MUST sit at
 * the top level of the schema document (§9.7.1, §9.11.2 item 5, §9.11.3 item 6).
 */
export const DOCUMENT_LEVEL_KEYWORDS = [X_GTS_FINAL, X_GTS_ABSTRACT, X_GTS_TRAITS_SCHEMA, X_GTS_TRAITS];

/**
 * The GTS keyword vocabulary (gts-spec §11.0). The `x-gts-*` namespace is
 * reserved: any other `x-gts-`-prefixed key at a schema location - including
 * the removed `x-gts-ref` - is a schema error. Plain `x-*` vendor extensions
 * outside the namespace are untouched by this rule.
 */
export const SUPPORTED_X_GTS_KEYWORDS: readonly string[] = [
  ...GTS_REF_KEYWORDS,
  X_GTS_TRAITS_SCHEMA,
  X_GTS_TRAITS,
  X_GTS_FINAL,
  X_GTS_ABSTRACT,
];

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
   * Finds document-level GTS keywords placed at a schema location other than
   * the root - an `allOf` entry, a `properties` value, a definition, a
   * `prefixItems` entry, a local `$ref` target, the trait schema, ... (shared
   * walker in schema-walk.ts). Such a keyword attaches to a subschema rather
   * than to the type and MUST be rejected rather than silently ignored.
   *
   * Returns the JSON Pointers of the misplaced keywords, empty when correct.
   */
  static findMisplacedKeywords(schema: any): string[] {
    return this.findKeywords(schema, (key, path) => path !== '' && DOCUMENT_LEVEL_KEYWORDS.includes(key));
  }

  /**
   * Finds `x-gts-*` schema keywords outside the GTS vocabulary (§11.0) at
   * every schema location the dialect defines - the root, definitions,
   * inactive branches, local `$ref` targets and `x-gts-traits-schema` (shared
   * walker in schema-walk.ts). Unlike `findMisplacedKeywords`, this rule flags
   * the keyword *name* itself. Keys in literal data (`const`, `default`,
   * `x-gts-traits`, ...) and property names are not keywords and are never
   * flagged.
   *
   * Returns the JSON Pointers of the unknown keyword occurrences, empty when
   * every `x-gts-*` keyword in the document is supported.
   */
  static findUnknownKeywords(schema: any): string[] {
    return this.findKeywords(schema, (key) => key.startsWith('x-gts-') && !SUPPORTED_X_GTS_KEYWORDS.includes(key));
  }

  /** JSON Pointers of the keywords at schema locations of `schema` that `matches`. */
  private static findKeywords(schema: any, matches: (key: string, path: string) => boolean): string[] {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];

    const found: string[] = [];
    try {
      forEachSchemaNode(schema, (node, path) => {
        for (const key of Object.keys(node)) {
          if (matches(key, path)) found.push(`${path}/${key}`);
        }
      });
    } catch (error) {
      // Fail closed: a document too deep to walk cannot be shown to be free of
      // such keywords.
      found.push(`/ (${error instanceof Error ? error.message : String(error)})`);
    }
    return found;
  }
}
