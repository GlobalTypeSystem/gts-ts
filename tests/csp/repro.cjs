'use strict';
// Canonical reproduction of gts-ts issue #28 (core validation under CSP).
// Usage: node --disallow-code-generation-from-strings issue-28-repro.cjs <repository-root>
// Exits 0 only when validateInstance returns `ok && valid`; exits 1 otherwise
// (including when validation throws, for example the Ajv EvalError under the flag).
// Exports `runRepro(api)` so the browser harness runs the very same scenario.

function runRepro(api) {
  const { GtsStore, createJsonEntity } = api;
  const store = new GtsStore();
  store.register(createJsonEntity({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'gts://gts.acme.demo.ui.widget.v1~', type: 'object', required: ['id','name'], properties: { id: {type:'string'}, name: {type:'string'} } }));
  store.register(createJsonEntity({ id: 'gts.acme.demo.ui.widget.v1~acme.demo.ui.sample.v1', name: 'sample' }));
  return store.validateInstance('gts.acme.demo.ui.widget.v1~acme.demo.ui.sample.v1');
}

module.exports = { runRepro };

if (require.main === module) {
  const path = require('path');
  const root = path.resolve(process.argv[2] || process.cwd());
  let result;
  try {
    result = runRepro(require(path.join(root, 'dist', 'index.js')));
  } catch (error) {
    console.log('repro threw:', error && error.message ? error.message : String(error));
    process.exit(1);
  }
  console.log(result);
  process.exit(result && result.ok === true && result.valid === true ? 0 : 1);
}
