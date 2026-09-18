# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-09-16

Upgrades the implementation from GTS spec **v0.13.3** to **[v0.14.0](https://github.com/GlobalTypeSystem/gts-spec/releases/tag/v0.14.0)**.

### Breaking

- Registering an entity under an existing id with different content now returns `409 Conflict` (`EntityConflictError`) by default instead of replacing it. Preserve replacement behavior by opting in with `new GTS({ allowEntityUpdates: true })` or `--allow-entity-updates`.
- `x-gts-ref` existence is now enforced uniformly for referenced values across concrete references and wildcard patterns, including `gts.*`. Values that previously validated without a corresponding registered entity now fail validation.
- Explicit Type Schema validation now rejects a concrete `x-gts-ref` constraint whose target is not a registered entity, including when that constraint is reached through a local JSON Schema `$ref`.
- `validateInstance()` and `validateSchemaAgainstParent()` now validate dependencies transitively, so a locally valid entity fails when its type, an ancestor, or a referenced entity is invalid.

### Added

- `allowEntityUpdates` registry configuration, the `EntityConflictError` export, and `--allow-entity-updates` support for both server commands.
- `x-gts-ref` support for any valid GTS wildcard pattern, including `~`-terminated patterns that match the named identifier and its derived identifiers.

### Fixed

- Explicit Type Schema validation now rejects unresolved GTS `$ref` targets, including missing derived segments.
- Trait validation now applies `x-gts-ref` integrity checks to abstract schemas and prevents descendants from reopening a trait surface prohibited by an ancestor's `x-gts-traits-schema: false` declaration.
- The HTTP server closes idle connections promptly to prevent file-descriptor exhaustion during long-running request sequences.
- TypeScript now uses Node16 module resolution, ensuring emitted CLI imports resolve correctly in Node.

## [0.5.0] - 2026-09-15

Upgrades the implementation from GTS spec **v0.13.1** to **[v0.13.3](https://github.com/GlobalTypeSystem/gts-spec/releases/tag/v0.13.3)**.

### Breaking

- `GET /entities/{id}` now returns `200` with `ok: false` for an unknown id instead of `404`.
  The spec's own `.gts-spec/tests/openapi.json` declares only `200`/`422` for this path, and
  the canonical `_assert_not_stored` conformance helper asserts `200` with `ok: false` for a
  missing entity.
- `POST /entities` now returns `422` when `validate=true` and the instance fails validation,
  instead of `200` with `ok: false`.
- An `x-gts-traits` value is now checked for registry existence, but **only when the type its
  `x-gts-ref` names is itself already registered** — a purely documentary reference to a
  never-registered namespace is still accepted. Previously a syntactically valid,
  correctly-prefixed `x-gts-traits` value naming an unregistered entity was accepted
  unconditionally; gts-spec v0.13.3 issue #107 reverses that rationale, and the canonical test
  that had pinned the old behavior was inverted.
- `$$id` / `$$schema` / `$$ref` / `$$defs` are no longer accepted as aliases for `$id` /
  `$schema` / `$ref` / `$defs`. They were an artifact of the HttpRunner conformance harness
  escaping `$` to `$$` on the wire, never real GTS or JSON Schema syntax; a schema using them
  is now processed literally (i.e. treated as an unknown, non-functional keyword) rather than
  rewritten.
- JSON Schema **format assertions** are now enforced per spec ADR-0005 for `uuid`, `email`,
  `date-time`, `date`, `time`, `uri`, `hostname`, `ipv4`, `ipv6` and `regex` — previously these
  formats were annotation-only and did not reject non-conforming values. `date-time` and `time`
  are stricter than the `ajv-formats` defaults (a timezone offset is mandatory and its bounds
  are enforced), and `regex` is asserted as a syntactically valid ECMA-262 pattern, not merely a
  string.
- Unknown `x-gts-*` schema keywords are now rejected wherever `x-gts-final` / `x-gts-abstract`
  / `x-gts-traits-schema` / `x-gts-traits` placement is enforced. Only five keywords are
  recognized: `x-gts-abstract`, `x-gts-final`, `x-gts-traits`, `x-gts-traits-schema` and
  `x-gts-ref`; any other `x-gts-` prefixed keyword now fails registration/validation instead of
  being silently ignored.
- Ajv now runs with `allErrors: true`, so a single failed validation may report several
  problems at once, joined with `"; "` in the error string, and error phrasing now matches
  python-jsonschema (`"<path> is not of type '<type>'"`) uniformly across endpoints rather than
  Ajv's own message format.

### Added

- `POST /validate-json` and `POST /validate-json/{gts_type}` (OP#6) — transient validation of
  instance or Type Schema JSON that registers nothing in the store. Both return a
  `ValidateJsonResult` with `ok`, `id`, `type_id`, `is_type_schema` and `error` always present.
- `backward_compatibility` / `forward_compatibility` / `full_compatibility` tri-state verdicts
  are now also reported on `POST /cast` responses, alongside the pre-existing
  `is_backward_compatible` / `is_forward_compatible` / `is_fully_compatible` booleans. These are
  deliberately different questions: `is_fully_compatible` reports whether the cast's transformed
  result validated against the target type, while `full_compatibility` reports schema-level
  compatibility between the two type schemas — a cast can succeed (`is_fully_compatible: true`)
  even when the schemas are not fully compatible, and vice versa.
- `is_type_schema` and `type_id` are now included on `POST /entities` success responses.
- `GtsStore.unregister()` and `GTS.isRegisteredSchema()`.

### Fixed

- OP#8 now reports `unknown` for all three compatibility verdicts when the two type schemas
  declare different JSON Schema dialects via `$schema`; equivalent spellings of the same dialect
  URI (e.g. with/without a trailing fragment) are normalized and no longer treated as a change.
- `format`, `pattern` and `multipleOf` are now treated as narrowing keywords for compatibility
  purposes: adding one narrows the accepted set (forward-compatible only), removing one widens
  it (backward-compatible only), and changing an already-present value is `unknown`. Matches the
  reference implementation's `check_narrowing_constraints`.
- An explicit major version `v0` in a query pattern is no longer treated the same as an omitted
  version (a wildcard); `v0` now matches only major version 0.
- `x-gts-ref` is now enforced in schemas that omit an explicit `type: "object"`, and through
  local `$ref` resolution, including a recursive `$ref: "#"` back to the schema root, bounded by
  `MAX_SCHEMA_DEPTH` / `MAX_SCHEMA_PATHS`.
- A dangling local `$ref` encountered during `x-gts-ref` traversal now fails validation instead
  of silently skipping the subtree behind it.
- GTS type ids longer than 100 characters used in a `POST /validate-json/{gts_type}` path
  parameter no longer 404 at the router before reaching the handler.

## [0.4.0] - 2026-08-10

Upgrades the implementation from GTS spec **v0.8** to **[v0.13.1](https://github.com/GlobalTypeSystem/gts-spec/releases/tag/v0.13.1)**.

Spec 0.12 renamed the core terminology (GTS Type / GTS Type Schema / GTS Instance) and
0.13 issued a correction to the compatibility rules, so this release contains breaking
changes to both the HTTP API and the library API.

### Breaking - HTTP API

| Before                                                                      | After                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `POST /schemas` with the schema as the body                                 | `POST /type-schemas` with `{ "type_id", "type_schema" }`      |
| `POST /validate-schema` with `{ "schema_id" }`                              | `POST /validate-type-schema` with `{ "type_id" }`             |
| `GET /compatibility?old_schema_id=&new_schema_id=`                          | `GET /compatibility?old_type_id=&new_type_id=`                |
| `POST /cast` with `{ "instance_id", "to_schema_id" }`                       | `POST /cast` with `{ "instance_id", "to_type_id" }`           |
| `/extract-id` returned `schema_id`, `selected_schema_id_field`, `is_schema` | returns `type_id`, `selected_type_id_field`, `is_type_schema` |
| `/parse-id` returned `is_schema`                                            | returns `is_type_schema`, plus a new `is_type` field          |

`GET /compatibility` now returns the tri-state verdicts required by §4.3:

```jsonc
{
  "old": "gts.x.core.events.type.v1.0~",
  "new": "gts.x.core.events.type.v1.1~",
  "backward_compatibility": "compatible", // compatible | incompatible | unknown
  "forward_compatibility": "incompatible",
  "full_compatibility": "incompatible",
}
```

The previous boolean fields (`is_backward_compatible`, `is_forward_compatible`,
`is_fully_compatible`) are still present for compatibility, but `unknown` collapses to
`false` in them and they cannot express an inconclusive check. Prefer the tri-state fields.

### Breaking - library API

- `ExtractResult`: `schema_id` → `type_id`, `selected_schema_id_field` → `selected_type_id_field`,
  `is_schema` → `is_type_schema`.
- `ParseResult`: `is_schema` → `is_type_schema`.
- `CompatibilityResult`: gains `backward_compatibility`, `forward_compatibility` and
  `full_compatibility`, each a `CompatVerdict` (`'compatible' | 'incompatible' | 'unknown'`).
- `GtsStore.checkCompatibility()` was removed; use `GTS.checkCompatibility()` or
  `GtsCompatibility.checkCompatibility(store, old, new)`.
- `GtsStore.validateEntityTraits()` was removed. `/validate-entity` and `/validate-type-schema`
  now apply the same type-level checks, so it no longer had separate semantics.
- `CompatibilityResult.added_properties`, `removed_properties` and `changed_properties` are
  now **always empty** and are deprecated. The engine decides compatibility by comparing
  accepted-instance sets rather than by diffing properties, so it no longer produces a
  property diff. The fields remain on the type and in the `GET /compatibility` response so
  existing consumers keep parsing, but they carry no information and will be removed.
- **`GtsCast` was removed.** There were two cast implementations - one in the library, one
  in the registry. Only the registry implementation resolved `allOf` / `$ref` on the target
  and validated the cast result; the library one did neither. Since GTS derived types _are_
  `allOf: [{$ref: parent}, …]`, the library version silently dropped every property when
  casting to a derived type.
  `GTS.castInstance()`, the CLI and `POST /cast` now share the registry implementation.
  The `CastResult` shape returned by the library and the CLI is unchanged; `POST /cast`
  returns the registry response (`instance_id`, `to_type_id`, `casted_entity`), which is
  what it returned before.
- Casting no longer refuses when the two type schemas are not fully compatible. Casting is
  a separate operational contract that the spec requires to be reported separately from
  schema compatibility (§4.3, §4.6.3); under 0.13 almost no real schema evolution is
  _fully_ compatible, so the old gate rejected ordinary casts. A cast now succeeds only if
  its **result** satisfies the target type, including that type's `x-gts-ref` constraints.
- The `direction` field reported `upgrade` / `downgrade` / `same` on `GET /compatibility`
  but `up` / `down` / `none` on `POST /cast`, from two separate implementations. Both now
  use `upgrade` / `downgrade` / `same` / `unknown`, and consider the MAJOR version as well
  as the MINOR.
- Two shape checks on `x-gts-traits-schema` were dropped: it no longer has to declare
  `type: "object"`, and it may contain a nested `x-gts-traits` member. Per ADR-0002 the
  keyword is an ordinary JSON Schema subschema (object, `true` or `false`), so neither
  restriction has a basis in 0.13; the placement rule deliberately does not scan inside it.
- The `mode` parameter on `GTS.checkCompatibility()` / `GtsCompatibility.checkCompatibility()` /
  `GET /compatibility?mode=` / the CLI's `-m` flag no longer narrows what gets computed
  (spec §9.2, §4.3 require always computing all three verdicts). It is retained only for
  call-site and display compatibility; the result always contains
  `backward_compatibility`, `forward_compatibility` and `full_compatibility`.
- `GtsStore.register()` now throws synchronously when a schema's `x-gts-final` /
  `x-gts-abstract` declaration is malformed (§9.11.1: a non-boolean value, or both keywords
  declared `true` on the same schema) instead of registering it uninspected. This changes
  the CLI's directory-load path: `loadEntitiesFromDir` (used by `gts load` and every command
  that loads a directory of entities) already caught the per-entity `register()` call and
  only reports the failure via `console.warn` when `--verbose` is passed - the same pattern
  it uses for an unreadable file or an unparsable JSON document in that function. Without
  `--verbose`, a directory containing a malformed schema now loads with **fewer entities
  registered than files present, and no error**; pass `--verbose` to see which entities were
  skipped and why.

### Changed - compatibility semantics (spec 0.13 §4)

OP#8 was rewritten around accepted-instance-set inclusion rather than a rule-based diff.
Several verdicts change for inputs that did not change:

- **Enums.** Adding an enum value is now backward compatible and not forward compatible
  (0.12 reported the opposite).
- **Open content models.** Adding an optional property to an open object is forward
  compatible, not backward compatible — the old schema already accepted arbitrary values
  under that name.
- **`const` fields.** Changing a `const` value is neither backward nor forward compatible.
- Content models are classified from the fully resolved effective schema (after `$ref`
  resolution and `allOf` composition), not from `additionalProperties` alone.
- An inconclusive comparison reports `unknown` instead of being conflated with
  `incompatible` — for example when the two schemas differ only in a keyword the checker
  does not model, or when a type identifier cannot be resolved.

### Added

- **`x-gts-final` / `x-gts-abstract` (§9.11).** A final type cannot be extended; an abstract
  type cannot be directly instantiated. Enforced at registration (`?validate=true`) and
  always on `/validate-type-schema`, `/validate-instance` and `/validate-entity`. Non-boolean
  values and the `final + abstract` combination are rejected outright.
- **Document-level keyword placement (§9.7.1, §9.11.5).** `x-gts-final`, `x-gts-abstract`,
  `x-gts-traits-schema` and `x-gts-traits` must appear at the schema top level; an occurrence
  nested in any subschema is rejected rather than silently ignored.
- **`GtsModifiers`** and `DOCUMENT_LEVEL_KEYWORDS` are exported from the package root.
- Unit tests covering the compatibility rules table (§4.5), the trait merge and completeness
  rules, the modifier and placement rules, and wildcard matching.

### Changed - traits (§9.7.5, ADR-0002/0003/0004)

- Trait values merge by **JSON Merge Patch (RFC 7396)**: objects merge recursively, arrays
  replace wholesale, and `null` deletes a key.
- Trait-schema `default`s are materialized before the completeness check, including defaults
  declared on nested object properties.
- **Completeness is keyed on `x-gts-abstract`**: non-abstract types must validate against the
  effective trait schema; abstract types are exempt.
- Locking a trait value across descendants is now plain `const` in `x-gts-traits-schema`.
  The bespoke immutability / default-override rules were removed.
- `x-gts-traits-schema` accepts the boolean subschema forms: `true` permits arbitrary traits,
  `false` prohibits traits on the whole subtree.

### Fixed

- **OP#5**: an identifier that already carries a UUID tail (a combined anonymous instance)
  returns that UUID instead of deriving a second one from the string.
- **OP#4**: a major-only version wildcard such as `v0.*` no longer matches every major
  version — `v0` was indistinguishable from "no version given".
- **OP#4**: a bare chain-suffix wildcard (`type.v1~*`) matches the type it is anchored on,
  as well as the identifiers derived from it.
- **OP#2**: a base type schema reports `type_id: null`. The JSON Schema dialect URL in
  `$schema` is not a GTS Type Identifier and is no longer returned as one.
- **OP#12**: derivation is validated from the chained `$id` alone, so a derived schema that
  restates its parent's fields instead of using `allOf` + `$ref` is checked too (ADR-0001).
- **OP#12**: `additionalProperties: true` or an omitted `additionalProperties` in an `allOf`
  overlay is no longer reported as loosening — the base branch keeps applying under `allOf`.
  A level that closes itself must still restate the base's properties.

### Notes for implementers

`OP#4` and `OP#10` disagree in the gts-spec 0.13 conformance suite over whether a bare
chain-suffix wildcard matches the type it is anchored on. Both verdicts are asserted, so
`matchIDPattern()` is inclusive by default and `GTS.query()` opts into strictly-derived
matching. In gts-spec 0.12 both were exclusive; 0.13 flipped only the OP#4 assertions.

## [0.3.0]

- Support for combined anonymous instances and OP#13 schema traits validation.
- Fastify upgrade; `oneOf` / `anyOf` validation fixes.
