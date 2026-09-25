/*
 * JSON Schema dialect (`$schema`) detection and canonicalization. Extracted
 * from `store.ts` to mirror gts-rust's `schema_dialect.rs`: dialect routing is
 * a distinct concern from registry behavior, and keeping it here makes the
 * supported-dialect allow-list a single, testable choke point.
 */

import { JSON_SCHEMA_HOST } from './types';

/** The three JSON Schema draft dialects this implementation supports. */
export type SchemaDialect = 'draft-07' | '2019-09' | '2020-12';

/**
 * Classify a schema document's declared `$schema` dialect, defaulting to
 * `draft-07` when absent.
 *
 * The Ajv registries are dialect-specific (each holds only its own dialect's
 * vocabulary), and instance validation compiles synchronously, so a `$ref`
 * target must live in the SAME Ajv instance as the schema that references it:
 * `$ref` composes the referenced schema INTO the referrer's single compiled
 * validation, evaluated under the referrer's one dialect. JSON Schema itself
 * assumes one dialect per validation and defines no semantics for composing
 * subschemas of different dialects, so a cross-dialect `$ref` is not merely an
 * Ajv limitation - it is underspecified. Returning the canonical dialect
 * bucket lets a mismatch across a `$ref` be rejected with a clear error
 * instead of surfacing as a compile throw a surrounding catch turns into a
 * bogus "invalid".
 *
 * Throws on an unsupported or malformed `$schema` value; the URI is parsed
 * strictly (scheme + host only, no userinfo/port/query/fragment) to keep the
 * allow-list tight.
 */
export function dialectOf(schema: any): SchemaDialect {
  const dialect = schema?.$schema;
  if (dialect === undefined) return 'draft-07';
  if (typeof dialect !== 'string' || dialect.length === 0) {
    throw new Error('$schema must declare a supported JSON Schema dialect');
  }
  let uri: URL;
  try {
    uri = new URL(dialect);
  } catch {
    throw new Error(`Unsupported JSON Schema dialect: ${String(dialect)}`);
  }
  if (
    (uri.protocol !== 'http:' && uri.protocol !== 'https:') ||
    uri.hostname.toLowerCase() !== JSON_SCHEMA_HOST ||
    uri.username !== '' ||
    uri.password !== '' ||
    uri.port !== '' ||
    uri.search !== '' ||
    uri.hash !== ''
  ) {
    throw new Error(`Unsupported JSON Schema dialect: ${dialect}`);
  }
  switch (uri.pathname) {
    case '/draft-07/schema':
      return 'draft-07';
    case '/draft/2019-09/schema':
      return '2019-09';
    case '/draft/2020-12/schema':
      return '2020-12';
    default:
      throw new Error(`Unsupported JSON Schema dialect: ${dialect}`);
  }
}

/** Canonical meta-schema URI for a dialect bucket. */
export function canonicalDialectUri(dialect: SchemaDialect | string): string {
  if (dialect === '2019-09') return 'https://json-schema.org/draft/2019-09/schema';
  if (dialect === '2020-12') return 'https://json-schema.org/draft/2020-12/schema';
  return 'http://json-schema.org/draft-07/schema#';
}
