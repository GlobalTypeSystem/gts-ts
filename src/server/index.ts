import { Command } from 'commander';
import { GtsServer } from './server';
import { ServerConfig } from './types';
import * as fs from 'fs';
import * as path from 'path';
import { createJsonEntity } from '../index';

const program = new Command();

program
  .name('gts-server')
  .description('GTS HTTP Server')
  .version('0.1.0')
  .option('-h, --host <host>', 'Host to bind to', '127.0.0.1')
  .option('-p, --port <port>', 'Port to listen on', '8000')
  .option('-v, --verbose <level>', 'Verbosity level (0=silent, 1=info, 2=debug)', '1')
  .option('--path <path>', 'Path to JSON/schema files to preload')
  .action(async (options) => {
    const config: ServerConfig = {
      host: options.host,
      port: parseInt(options.port, 10),
      verbose: parseInt(options.verbose, 10),
      path: options.path,
    };

    console.log(`Starting GTS server on http://${config.host}:${config.port}`);

    const server = new GtsServer(config);

    // Preload entities from path if provided
    if (config.path) {
      await loadEntitiesFromPath(server, config.path);
    }

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down server...');
      await server.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\nShutting down server...');
      await server.stop();
      process.exit(0);
    });

    // Start the server
    await server.start();
  });

async function loadEntitiesFromPath(server: any, dirPath: string): Promise<void> {
  if (!fs.existsSync(dirPath)) {
    console.warn(`Path does not exist: ${dirPath}`);
    return;
  }

  const stats = fs.statSync(dirPath);
  if (!stats.isDirectory()) {
    console.warn(`Path is not a directory: ${dirPath}`);
    return;
  }

  console.log(`Loading entities from: ${dirPath}`);
  const files = fs.readdirSync(dirPath);
  let loaded = 0;
  let errors = 0;

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
            server['store'].register(entity);
            loaded++;
            if (server['config'].verbose >= 2) {
              console.log(`  Loaded: ${gtsEntity.id}`);
            }
          }
        } catch (err) {
          errors++;
          if (server['config'].verbose >= 1) {
            console.warn(`  Failed to load entity from ${file}: ${err}`);
          }
        }
      }
    } catch (err) {
      errors++;
      if (server['config'].verbose >= 1) {
        console.warn(`  Failed to read ${file}: ${err}`);
      }
    }
  }

  console.log(`Loaded ${loaded} entities (${errors} errors)`);
}

// Run the CLI if this is the main module
if (require.main === module) {
  program.parse(process.argv);
}
