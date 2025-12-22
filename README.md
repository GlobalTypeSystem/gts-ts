# GTS TypeScript Implementation

A complete TypeScript implementation of the Global Type System (GTS)

## Overview

GTS [Global Type System](https://github.com/globaltypesystem/gts-spec) is a simple, human-readable, globally unique identifier and referencing system for data type definitions (e.g., JSON Schemas) and data instances (e.g., JSON objects). This TypeScript implementation provides type-safe operations for working with GTS identifiers.

## Roadmap

Featureset:

- [x] **OP#1 - ID Validation**: Verify identifier syntax using regex patterns
- [x] **OP#2 - ID Extraction**: Fetch identifiers from JSON objects or JSON Schema documents
- [x] **OP#3 - ID Parsing**: Decompose identifiers into constituent parts (vendor, package, namespace, type, version, etc.)
- [x] **OP#4 - ID Pattern Matching**: Match identifiers against patterns containing wildcards
- [x] **OP#5 - ID to UUID Mapping**: Generate deterministic UUIDs from GTS identifiers
- [x] **OP#6 - Schema Validation**: Validate object instances against their corresponding schemas
- [x] **OP#7 - Relationship Resolution**: Load all schemas and instances, resolve inter-dependencies, and detect broken references
- [x] **OP#8 - Compatibility Checking**: Verify that schemas with different MINOR versions are compatible
- [x] **OP#8.1 - Backward compatibility checking**
- [x] **OP#8.2 - Forward compatibility checking**
- [x] **OP#8.3 - Full compatibility checking**
- [x] **OP#9 - Version Casting**: Transform instances between compatible MINOR versions
- [x] **OP#10 - Query Execution**: Filter identifier collections using the GTS query language
- [x] **OP#11 - Attribute Access**: Retrieve property values and metadata using the attribute selector (`@`)

Other GTS spec [Reference Implementation](https://github.com/globaltypesystem/gts-spec/blob/main/README.md#9-reference-implementation-recommendations) recommended features support:

- [x] **In-memory entities registry** - simple GTS entities registry with optional GTS references validation on entity registration
- [x] **CLI** - command-line interface for all GTS operations
- [x] **Web server** - a non-production web-server with REST API for the operations processing and testing
- [x] **x-gts-ref** - to support special GTS entity reference annotation in schemas
- [ ] **YAML support** - to support YAML files (*.yml, *.yaml) as input files
- [ ] **TypeSpec support** - add [typespec.io](https://typespec.io/) files (*.tsp) support
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
  name: 'My Entity'
};

const extracted = extractID(content);
console.log(`ID: ${extracted.id}`);
console.log(`Schema ID: ${extracted.schemaId}`);

// OP#3 - ID Parsing
const parsed = parseGtsID('gts.vendor.pkg.ns.type.v1~');
if (parsed.ok) {
  for (const seg of parsed.segments) {
    console.log(`Vendor: ${seg.vendor}, Package: ${seg.package}, Type: ${seg.type}, Version: v${seg.verMajor}`);
  }
}

// OP#4 - Pattern Matching
const matchResult = matchIDPattern(
  'gts.vendor.pkg.ns.type.v1.0',
  'gts.vendor.pkg.*'
);
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
  name: 'My Entity'
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

// OP#8 - Check compatibility
const compatResult = gts.checkCompatibility(
  'gts.vendor.pkg.ns.type.v1~',
  'gts.vendor.pkg.ns.type.v2~',
  'backward'
);
if (compatResult.compatible) {
  console.log('Schemas are compatible');
}

// OP#9 - Cast instance to different version
const castResult = gts.castInstance(
  'gts.vendor.pkg.ns.type.v1.0',
  'gts.vendor.pkg.ns.type.v2~'
);
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
```

### API Endpoints

#### Entity Management
- `GET /entities` - List all entities
- `GET /entities/:id` - Get specific entity
- `POST /entities` - Add new entity
- `POST /entities/bulk` - Add multiple entities
- `POST /schemas` - Add new schema

#### GTS Operations
- `GET /validate-id?id=<gts_id>` - Validate GTS ID (OP#1)
- `POST /extract-id` - Extract GTS ID from JSON (OP#2)
- `GET /parse-id?id=<gts_id>` - Parse GTS ID (OP#3)
- `GET /match-id-pattern?pattern=<pattern>&candidate=<id>` - Match pattern (OP#4)
- `GET /uuid?id=<gts_id>` - Generate UUID (OP#5)
- `POST /validate-instance` - Validate instance (OP#6)
- `GET /resolve-relationships?id=<gts_id>` - Resolve relationships (OP#7)
- `GET /compatibility?old=<id>&new=<id>&mode=<mode>` - Check compatibility (OP#8)
- `POST /cast` - Cast instance (OP#9)
- `GET /query?expr=<expression>&limit=<limit>` - Query entities (OP#10)
- `GET /attr?path=<path>` - Get attribute value (OP#11)

#### Other
- `GET /health` - Health check
- `GET /openapi` - OpenAPI specification

### Example Usage

```bash
# Health check
curl http://127.0.0.1:8000/health

# Validate a GTS ID
curl "http://127.0.0.1:8000/validate-id?id=gts.vendor.pkg.ns.type.v1~"

# Add a schema
curl -X POST http://127.0.0.1:8000/schemas \
  -H "Content-Type: application/json" \
  -d '{
    "$$id": "gts.test.example.ns.person.v1~",
    "type": "object",
    "properties": {
      "name": { "type": "string" },
      "age": { "type": "number" }
    },
    "required": ["name"]
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