# GTS TypeScript Implementation

A complete TypeScript implementation of the Global Type System (GTS)

## Overview

GTS [Global Type System](https://github.com/globaltypesystem/gts-spec) is a simple, human-readable, globally unique identifier and referencing system for data type definitions (e.g., JSON Schemas) and data instances (e.g., JSON objects). This TypeScript implementation provides type-safe operations for working with GTS identifiers.

**Targets gts-spec [v0.14.0](https://github.com/GlobalTypeSystem/gts-spec/releases/tag/v0.14.0)** — recorded in [`.gts-spec-version`](.gts-spec-version) and pinned by the `.gts-spec` submodule. Run `make update-spec` to check the pinned release out. See the [CHANGELOG](CHANGELOG.md) for the breaking changes in the v0.13.3 → v0.14.0 upgrade.

## Roadmap

Featureset:

- [x] **OP#1 - ID Validation**: Verify identifier syntax using regex patterns
- [x] **OP#2 - ID Extraction**: Fetch identifiers from JSON objects or JSON Schema documents
- [x] **OP#3 - ID Parsing**: Decompose identifiers into constituent parts (vendor, package, namespace, type, version, etc.)
- [x] **OP#4 - ID Pattern Matching**: Match identifiers against patterns containing wildcards
- [x] **OP#5 - ID to UUID Mapping**: Generate deterministic UUIDs from GTS identifiers
- [x] **OP#6 - Instance Validation**: Validate object instances against their corresponding Type Schemas
- [x] **OP#7 - Relationship Resolution**: Load all schemas and instances, resolve inter-dependencies, and detect broken references
- [x] **OP#8 - Type Schema Evolution Compatibility Checking**: Compare two definitions of one type identity and report the tri-state verdict (`compatible` / `incompatible` / `unknown`) for each relation
- [x] **OP#8.1 - Backward compatibility checking**
- [x] **OP#8.2 - Forward compatibility checking**
- [x] **OP#8.3 - Full compatibility checking**
- [x] **OP#9 - Version Casting**: Transform an instance to another version of its type. Reported separately from compatibility (§4.3, §4.6.3): a cast succeeds when its result satisfies the target type, not when the two schemas are compatible
- [x] **OP#10 - Query Execution**: Filter identifier collections using the GTS query language
- [x] **OP#11 - Attribute Access**: Retrieve property values and metadata using the attribute selector (`@`)
- [x] **OP#12 - Type Derivation Validation**: Validate that a derived type correctly extends its base chain
- [x] **OP#13 - Schema Traits Validation**: Validate `x-gts-traits-schema` / `x-gts-traits` across the `$id` chain

Other GTS spec [Reference Implementation](https://github.com/globaltypesystem/gts-spec/blob/main/README.md#9-reference-implementation-recommendations) recommended features support:

- [x] **In-memory entities registry** - simple GTS entities registry with optional GTS references validation on entity registration
- [x] **CLI** - command-line interface for all GTS operations
- [x] **Web server** - a non-production web-server with REST API for the operations processing and testing
- [x] **x-gts-ref** - to support special GTS entity reference annotation in schemas
- [x] **x-gts-final / x-gts-abstract** - GTS Type Schema modifiers controlling inheritance and instantiation
- [ ] **YAML support** - to support YAML files (`*.yml`, `*.yaml`) as input files
- [ ] **TypeSpec support** - add [typespec.io](https://typespec.io/) files (`*.tsp`) support
- [ ] **UUID for instances** - to support UUID as ID in JSON instances

## Usage

### Basic Operations

```typescript
import { isValidGtsID, validateGtsID, parseGtsID, matchIDPattern, idToUUID } from '@globaltypesystem/gts-ts';

// OP#1 - ID Validation
if (isValidGtsID('gts.vendor.pkg.ns.type.v1~')) {
  console.log('Valid GTS ID');
}

const result = validateGtsID('gts.vendor.pkg.ns.type.v1~');
if (result.valid) {
  console.log(`Valid: ${result.id}`);
} else {
  console.log(`Invalid: ${result.error}`);
}

// OP#2 - ID Extraction
import { extractID } from '@globaltypesystem/gts-ts';

const content = {
  gtsId: 'gts.vendor.pkg.ns.type.v1.0',
  name: 'My Entity',
};

const extracted = extractID(content);
console.log(`ID: ${extracted.id}`);
console.log(`Type ID: ${extracted.type_id}`);

// OP#3 - ID Parsing
const parsed = parseGtsID('gts.vendor.pkg.ns.type.v1~');
if (parsed.ok) {
  for (const seg of parsed.segments) {
    console.log(`Vendor: ${seg.vendor}, Package: ${seg.package}, Type: ${seg.type}, Version: v${seg.verMajor}`);
  }
}

// OP#4 - Pattern Matching
const matchResult = matchIDPattern('gts.vendor.pkg.ns.type.v1.0', 'gts.vendor.pkg.*');
if (matchResult.match) {
  console.log('Pattern matched!');
}

// OP#5 - UUID Generation
const uuidResult = idToUUID('gts.vendor.pkg.ns.type.v1~');
console.log(`UUID: ${uuidResult.uuid}`);
```

### Using the GTS Store

```typescript
import { GTS } from '@globaltypesystem/gts-ts';

// Create a new store
const gts = new GTS();

// Register an entity
const entity = {
  gtsId: 'gts.vendor.pkg.ns.type.v1.0',
  name: 'My Entity',
};

gts.register(entity);

// OP#6 - Validate an instance
const validation = gts.validateInstance('gts.vendor.pkg.ns.type.v1.0');
if (validation.ok) {
  console.log('Instance is valid');
}

// OP#7 - Resolve relationships
const relationships = gts.resolveRelationships('gts.vendor.pkg.ns.type.v1.0');
console.log(`Relationships: ${relationships.relationships}`);
console.log(`Broken references: ${relationships.brokenReferences}`);

// OP#8 - Check Type Schema evolution compatibility
// Each relation is reported as 'compatible', 'incompatible' or 'unknown'
const compatResult = gts.checkCompatibility('gts.vendor.pkg.ns.type.v1~', 'gts.vendor.pkg.ns.type.v2~');
console.log(`backward: ${compatResult.backward_compatibility}`);
console.log(`forward:  ${compatResult.forward_compatibility}`);
console.log(`full:     ${compatResult.full_compatibility}`);

// OP#9 - Cast instance to different version
const castResult = gts.castInstance('gts.vendor.pkg.ns.type.v1.0', 'gts.vendor.pkg.ns.type.v2~');
if (castResult.ok) {
  console.log('Instance casted successfully');
}

// OP#10 - Query entities
const queryResult = gts.query('gts.vendor.pkg.*', 100);
console.log(`Found ${queryResult.count} entities`);

// OP#11 - Attribute access
const attr = gts.getAttribute('gts.vendor.pkg.ns.type.v1.0@name');
if (attr.resolved) {
  console.log(`Attribute value: ${attr.value}`);
}
```

### Source-aware diagnostics

Use `registerAndValidateText()` when a client needs editor locations. The
library never receives a file path or name — the caller passes only the raw
text and its `format` (`'json' | 'jsonc' | 'yaml'`, derived on the client from
its own file extension or content type) — so no filesystem information can
appear in diagnostics. `instancePath` identifies the value semantically, while
`source.value` and optional `source.key` contain absolute UTF-16 offsets and
zero-based line/column coordinates. `entityIndex` identifies an entry in a
top-level array.

```typescript
const result = gts.registerAndValidateText(sourceText, 'jsonc');
for (const issue of result.errors) {
  const { entityIndex, instancePath, source } = issue;
  console.log(entityIndex, instancePath, source?.value.line, source?.value.column);
}
```

For a missing required property, no key token exists, so the source span points
to the containing object. Clients should use `source.key` when they want to
underline an existing key and `source.value` otherwise.

> **Privacy:** `ValidationIssue.data` and `ValidationIssue.params` may echo the
> raw failing value from the instance being validated. Prefer `instancePath`
> and `source` for display, and do not forward `data`/`params` to logs or
> telemetry unless you have confirmed the payload contains no sensitive data.

> **Side effect:** `registerAndValidateText()` registers every parseable entity
> into the store even when the payload is invalid, and registration is not
> rolled back. For all-or-nothing semantics, validate against a throwaway `GTS`
> instance first and only register into your real store on success.

### Advanced Query Language

The query language supports complex expressions with AND, OR, and NOT operators:

```typescript
// Simple pattern matching
gts.query('gts.vendor.*');

// Complex queries with logical operators
gts.query('gts.vendor.* OR gts.other.*');
gts.query('gts.vendor.* AND NOT gts.vendor.test.*');
gts.query('(gts.vendor.* OR gts.other.*) AND gts.*.*.ns.*');
```

## CLI Usage

The package includes a CLI tool for GTS operations:

```bash
# Install globally
npm install -g @globaltypesystem/gts-ts

# Or use locally with npx
npx gts

# Basic operations
gts validate-id -i gts.vendor.pkg.ns.type.v1~
gts parse-id -i gts.vendor.pkg.ns.type.v1.0
gts match-id -p "gts.vendor.pkg.*" -c gts.vendor.pkg.ns.type.v1.0
gts uuid -i gts.vendor.pkg.ns.type.v1~

# Operations with loaded entities
gts --path ./examples validate -i gts.vendor.pkg.ns.type.v1.0
gts --path ./examples relationships -i gts.vendor.pkg.ns.type.v1~
gts --path ./examples compatibility -o gts.vendor.pkg.ns.type.v1~ -n gts.vendor.pkg.ns.type.v2~
gts --path ./examples cast -f gts.vendor.pkg.ns.type.v1.0 -t gts.vendor.pkg.ns.type.v2~
gts --path ./examples query -e "gts.vendor.pkg.*" -l 10
gts --path ./examples attr -p gts.vendor.pkg.ns.type.v1.0@name
gts --path ./examples list -l 100
```

## Web Server

The package includes a non-production web server with REST API for testing and development:

### Building the Server

```bash
# install dependencies
npm ci

# build the server
npm run build
```

### Starting the Server

```bash
# Using npm scripts
npm run server

# Using the CLI
gts server --host 127.0.0.1 --port 8000

# With preloaded entities
gts --path ./examples server --port 8001

# Using the dedicated server command
npx gts-server --host 127.0.0.1 --port 8000 --verbose 2

# Allow re-registering an entity with different content (default: reject with 409)
gts server --allow-entity-updates
npx gts-server --allow-entity-updates
```

By default the registry protects its state: re-`POST`ing an id that is already
stored with **different** content is rejected with `409 Conflict`, while an
identical re-submission is idempotent (`200`). Pass `--allow-entity-updates` to
opt into replacement semantics.

### API Endpoints

#### Entity Management

- `GET /entities` - List all entities
- `GET /entities/:id` - Get specific entity
- `POST /entities` - Add new entity
- `POST /entities/bulk` - Add multiple entities
- `POST /type-schemas` - Register a GTS Type Schema under an explicit `type_id`

#### GTS Operations

- `GET /validate-id?id=<gts_id>` - Validate GTS ID (OP#1)
- `POST /extract-id` - Extract GTS ID from JSON (OP#2)
- `GET /parse-id?id=<gts_id>` - Parse GTS ID (OP#3)
- `GET /match-id-pattern?pattern=<pattern>&candidate=<id>` - Match pattern (OP#4)
- `GET /uuid?id=<gts_id>` - Generate UUID (OP#5)
- `POST /validate-instance` - Validate instance (OP#6)
- `POST /validate-json` - Validate transient instance or Type Schema JSON without registering it (OP#6)
- `POST /validate-json/:gts_type` - Validate transient instance JSON against an explicit GTS type, without registering it (OP#6)
- `GET /resolve-relationships?id=<gts_id>` - Resolve relationships (OP#7)
- `GET /compatibility?old_type_id=<id>&new_type_id=<id>` - Check Type Schema evolution compatibility (OP#8)
- `POST /cast` - Cast instance (OP#9)
- `GET /query?expr=<expression>&limit=<limit>` - Query entities (OP#10)
- `GET /attr?path=<path>` - Get attribute value (OP#11)
- `POST /validate-type-schema` - Validate a derived Type Schema against its base chain (OP#12)
- `POST /validate-entity` - Validate entity (type schema or instance) (OP#12/OP#13)

#### Other

- `GET /health` - Health check
- `GET /openapi` - OpenAPI specification

### Example Usage

```bash
# Health check
curl http://127.0.0.1:8000/health

# Validate a GTS ID
curl "http://127.0.0.1:8000/validate-id?id=gts.vendor.pkg.ns.type.v1~"

# Register a GTS Type Schema
curl -X POST http://127.0.0.1:8000/type-schemas \
  -H "Content-Type: application/json" \
  -d '{
    "type_id": "gts.test.example.ns.person.v1~",
    "type_schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "age": { "type": "number" }
      },
      "required": ["name"]
    }
  }'

# Query entities
curl "http://127.0.0.1:8000/query?expr=gts.test.*&limit=10"
```

## Development

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Run linting
npm run lint

# Type checking
npm run typecheck

# Format code
npm run format

# Start development server
npm run server:dev
```

## License

Apache License 2.0
