#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { validateGtsID, parseGtsID, matchIDPattern, idToUUID, extractID, GTS, createJsonEntity } from '../index';

const program = new Command();

program
  .name('gts')
  .description('GTS CLI - Global Type System command-line interface')
  .version('0.1.0')
  .option('--path <path>', 'Path to JSON and schema files', process.env.GTS_PATH)
  .option('--config <config>', 'Path to GTS config JSON file', process.env.GTS_CONFIG)
  .option('-v, --verbose', 'Verbose output', false);

// OP#1 - Validate ID
program
  .command('validate-id')
  .description('Validate a GTS ID')
  .requiredOption('-i, --id <id>', 'GTS ID to validate')
  .action((options) => {
    const result = validateGtsID(options.id);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });

// OP#2 - Extract ID
program
  .command('extract-id')
  .description('Extract GTS ID from JSON content')
  .requiredOption('-f, --file <file>', 'JSON file to extract ID from')
  .action((options) => {
    try {
      const content = JSON.parse(fs.readFileSync(options.file, 'utf-8'));
      const result = extractID(content);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// OP#3 - Parse ID
program
  .command('parse-id')
  .description('Parse a GTS ID into components')
  .requiredOption('-i, --id <id>', 'GTS ID to parse')
  .action((options) => {
    const result = parseGtsID(options.id);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });

// OP#4 - Match ID
program
  .command('match-id')
  .description('Match GTS ID against pattern')
  .requiredOption('-p, --pattern <pattern>', 'Pattern to match against')
  .requiredOption('-c, --candidate <candidate>', 'Candidate ID to match')
  .action((options) => {
    const result = matchIDPattern(options.candidate, options.pattern);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.match ? 0 : 1);
  });

// OP#5 - UUID
program
  .command('uuid')
  .description('Generate UUID from GTS ID')
  .requiredOption('-i, --id <id>', 'GTS ID to convert')
  .action((options) => {
    const result = idToUUID(options.id);
    if (result.error) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    console.log(result.uuid);
  });

// OP#6 - Validate Instance
program
  .command('validate')
  .description('Validate instance against schema')
  .requiredOption('-i, --id <id>', 'Instance ID to validate')
  .action((options, command) => {
    const gts = loadStore(command.parent);
    const result = gts.validateInstance(options.id);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });

// OP#7 - Relationships
program
  .command('relationships')
  .description('Resolve relationships for an entity')
  .requiredOption('-i, --id <id>', 'Entity ID')
  .action((options, command) => {
    const gts = loadStore(command.parent);
    const result = gts.resolveRelationships(options.id);
    console.log(JSON.stringify(result, null, 2));
  });

// OP#8 - Compatibility
program
  .command('compatibility')
  .description('Check schema compatibility')
  .requiredOption('-o, --old <old>', 'Old schema ID')
  .requiredOption('-n, --new <new>', 'New schema ID')
  .option('-m, --mode <mode>', 'Compatibility mode (backward|forward|full)', 'full')
  .action((options, command) => {
    const gts = loadStore(command.parent);
    const result = gts.checkCompatibility(options.old, options.new, options.mode);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.is_fully_compatible ? 0 : 1);
  });

// OP#9 - Cast
program
  .command('cast')
  .description('Cast instance to different schema version')
  .requiredOption('-f, --from <from>', 'Source instance ID')
  .requiredOption('-t, --to <to>', 'Target schema ID')
  .action((options, command) => {
    const gts = loadStore(command.parent);
    const result = gts.castInstance(options.from, options.to);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });

// OP#10 - Query
program
  .command('query')
  .description('Query entities')
  .requiredOption('-e, --expr <expr>', 'Query expression')
  .option('-l, --limit <limit>', 'Maximum results', '100')
  .action((options, command) => {
    const gts = loadStore(command.parent);
    const result = gts.query(options.expr, parseInt(options.limit, 10));
    console.log(JSON.stringify(result, null, 2));
  });

// OP#11 - Attribute
program
  .command('attr')
  .description('Get attribute value')
  .requiredOption('-p, --path <path>', 'Attribute path (e.g., gts.vendor.pkg.ns.type.v1.0@name)')
  .action((options, command) => {
    const gts = loadStore(command.parent);
    const result = gts.getAttribute(options.path);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.resolved ? 0 : 1);
  });

// List entities
program
  .command('list')
  .description('List all entities')
  .option('-l, --limit <limit>', 'Maximum results', '100')
  .action((options, command) => {
    const gts = loadStore(command.parent);
    const entities = gts['store'].getAll().slice(0, parseInt(options.limit, 10));
    const result = {
      count: entities.length,
      items: entities.map((e) => e.id),
    };
    console.log(JSON.stringify(result, null, 2));
  });

// Server command
program
  .command('server')
  .description('Start HTTP server')
  .option('--host <host>', 'Host to bind to', '127.0.0.1')
  .option('--port <port>', 'Port to listen on', '8000')
  .action(async (options, command) => {
    const parentOpts = command.parent.opts();

    // Import server dynamically
    const { GtsServer } = await import('../server/server');

    const config = {
      host: options.host,
      port: parseInt(options.port, 10),
      verbose: parentOpts.verbose ? 2 : 1,
      path: parentOpts.path,
    };

    const server = new GtsServer(config);

    // Load entities if path provided
    if (config.path) {
      const gts = loadStore(command.parent);
      // Transfer loaded entities to server
      const entities = gts['store'].getAll();
      for (const entity of entities) {
        server['store'].register(entity.content);
      }
      console.log(`Loaded ${entities.length} entities from ${config.path}`);
    }

    await server.start();
  });

// OpenAPI command
program
  .command('openapi')
  .description('Generate OpenAPI specification')
  .option('-o, --out <file>', 'Output file')
  .action((options) => {
    const spec = {
      openapi: '3.0.0',
      info: {
        title: 'GTS API',
        version: '0.1.0',
        description: 'Global Type System API',
      },
      servers: [
        {
          url: 'http://127.0.0.1:8000',
          description: 'Default GTS Server',
        },
      ],
      paths: {},
      components: {},
    };

    const output = JSON.stringify(spec, null, 2);

    if (options.out) {
      fs.writeFileSync(options.out, output);
      console.log(`OpenAPI spec written to ${options.out}`);
    } else {
      console.log(output);
    }
  });

// Helper function to load entities from path
function loadStore(command: any): GTS {
  const options = command.opts();
  const gts = new GTS({ validateRefs: false });

  if (!options.path) {
    return gts;
  }

  const paths = options.path.split(',');

  for (const dirPath of paths) {
    if (!fs.existsSync(dirPath)) {
      if (options.verbose) {
        console.warn(`Path does not exist: ${dirPath}`);
      }
      continue;
    }

    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      if (options.verbose) {
        console.warn(`Path is not a directory: ${dirPath}`);
      }
      continue;
    }

    loadEntitiesFromDir(gts, dirPath, options.verbose);
  }

  return gts;
}

function loadEntitiesFromDir(gts: GTS, dirPath: string, verbose: boolean): void {
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const filePath = path.join(dirPath, file);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      // Handle arrays of entities
      const entities = Array.isArray(data) ? data : [data];

      for (const entity of entities) {
        try {
          const gtsEntity = createJsonEntity(entity);
          if (gtsEntity.id) {
            gts.register(entity);
            if (verbose) {
              console.log(`Loaded: ${gtsEntity.id}`);
            }
          }
        } catch (err) {
          if (verbose) {
            console.warn(`Failed to load entity from ${file}: ${err}`);
          }
        }
      }
    } catch (err) {
      if (verbose) {
        console.warn(`Failed to read ${file}: ${err}`);
      }
    }
  }
}

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
