import { readdirSync, readFileSync } from 'fs';
import { builtinModules } from 'module';
import { join, relative, sep } from 'path';
import * as ts from 'typescript';

// The core library (everything under src/ except the Node-only cli/ and server/
// entry points) runs in browsers, which have no Node built-in modules. A bundler
// stubs or rejects such an import, so it would fail only at run time in the
// consumer's application.

const SRC = join(__dirname, '..', 'src');
const NODE_ONLY_DIRS = new Set(['cli', 'server'].map((dir) => join(SRC, dir)));
const BUILTINS = new Set(builtinModules);

function coreFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return NODE_ONLY_DIRS.has(full) ? [] : coreFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Node built-in modules that `source` imports, requires or dynamically imports. */
function builtinImports(source: string): string[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map(({ fileName }) => fileName)
    .filter((name) => name.startsWith('node:') || BUILTINS.has(name.split('/')[0]));
}

describe('core library imports', () => {
  test('detects every import form', () => {
    const source = [
      "import { createHash } from 'crypto';",
      "import * as fs from 'node:fs';",
      "export { readFile } from 'fs/promises';",
      "const path = require('path');",
      "const os = () => import('os');",
      "import { canonicalJson } from './json-canonical';",
      "import { compileSchema } from 'json-schema-library';",
    ].join('\n');
    expect(builtinImports(source)).toEqual(['crypto', 'node:fs', 'fs/promises', 'path', 'os']);
  });

  test('reads the core and skips the Node-only entry points', () => {
    const files = coreFiles(SRC).map((file) => relative(SRC, file).split(sep).join('/'));
    expect(files).toEqual(expect.arrayContaining(['index.ts', 'store.ts', 'json-canonical.ts']));
    expect(files.filter((file) => file.startsWith('cli/') || file.startsWith('server/'))).toEqual([]);
  });

  test('no core file imports a Node built-in module', () => {
    const found = coreFiles(SRC).flatMap((file) =>
      builtinImports(readFileSync(file, 'utf8')).map((name) => `${relative(SRC, file).split(sep).join('/')}: ${name}`)
    );
    expect(found).toEqual([]);
  });
});
