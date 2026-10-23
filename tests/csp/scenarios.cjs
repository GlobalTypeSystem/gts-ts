'use strict';
// CSP scenario matrix over built `dist/` (plain Node, no test framework).
// Usage: node --disallow-code-generation-from-strings tests/csp/scenarios.cjs <root> [--control]
// `--control` skips ONLY the flag canary (used for the unflagged Ajv green control).
// Scenario expectations come from the gts-spec and ADR-0005, not from the engine.
// A scenario marked `engineOnly: true` fails on the Ajv baseline because Ajv is wrong.

const path = require('path');

const args = process.argv.slice(2);
const control = args.includes('--control');
const root = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());

if (control) {
  console.log('control mode: flag canary skipped');
} else {
  let threw = false;
  try {
    new Function('return 1')();
  } catch {
    threw = true;
  }
  if (!threw) {
    console.log('flag not active');
    process.exit(2);
  }
}

const api = require(path.join(root, 'dist', 'index.js'));
const { GtsStore, createJsonEntity } = api;
const { runRepro } = require('./repro.cjs');

const DIALECTS = {
  'draft-07': { uri: 'http://json-schema.org/draft-07/schema#', defs: 'definitions' },
  '2019-09': { uri: 'https://json-schema.org/draft/2019-09/schema', defs: '$defs' },
  '2020-12': { uri: 'https://json-schema.org/draft/2020-12/schema', defs: '$defs' },
};
const NONE = 'none';

function assert(cond, reason) {
  if (!cond) throw new Error(reason);
}
function isGood(r) {
  return r && r.ok === true && r.valid !== false;
}
function isBad(r) {
  return r && r.ok === false && r.valid !== true;
}
function expectGood(r, what) {
  assert(isGood(r), `${what} expected ok/valid, got ${JSON.stringify(r)}`);
}
function expectBad(r, what, keyword, instancePath) {
  assert(isBad(r), `${what} expected failure, got ${JSON.stringify(r)}`);
  if (keyword !== undefined) {
    const hit = (r.errors || []).some(
      (e) => e.keyword === keyword && (instancePath === undefined || e.instancePath === instancePath)
    );
    assert(hit, `${what} expected issue keyword=${keyword} instancePath=${instancePath}, got ${JSON.stringify(r.errors)}`);
  }
}
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function mk(d, name, extra) {
  return { $schema: DIALECTS[d].uri, $id: `gts://gts.acme.demo.t.${name}.v1~`, type: 'object', ...extra };
}
function tid(name) {
  return `gts.acme.demo.t.${name}.v1~`;
}
function storeWith(...schemas) {
  const store = new GtsStore();
  for (const s of schemas) store.register(createJsonEntity(s));
  return store;
}
// Instance validation helper: transient, structural only (refs not checked for existence).
function vi(store, content, typeId) {
  return store.validateTransientInstance(content, typeId, null, NONE);
}

const scenarios = [];
function scenario(name, fn, opts) {
  scenarios.push({ name, fn, engineOnly: !!(opts && opts.engineOnly) });
}
function perDialect(name, fn, dialects, opts) {
  for (const d of dialects || Object.keys(DIALECTS)) scenario(`${name} [${d}]`, () => fn(d), opts);
}

scenario('issue-28 repro', () => {
  const r = runRepro(api);
  assert(r && r.ok === true && r.valid === true, `repro result ${JSON.stringify(r)}`);
});

perDialect('pattern', (d) => {
  const s = mk(d, 'pat', { properties: { code: { type: 'string', pattern: '^[A-Z]{3}$' } } });
  const store = storeWith(s);
  expectGood(vi(store, { code: 'ABC' }, tid('pat')), 'valid code');
  expectBad(vi(store, { code: 'abc' }, tid('pat')), 'invalid code', 'pattern', '/code');
});

perDialect('patternProperties', (d) => {
  const s = mk(d, 'pprops', { patternProperties: { '^x_': { type: 'integer' } } });
  const store = storeWith(s);
  expectGood(vi(store, { x_a: 1 }, tid('pprops')), 'valid');
  expectBad(vi(store, { x_a: 'no' }, tid('pprops')), 'invalid', 'type', '/x_a');
});

perDialect('propertyNames', (d) => {
  const s = mk(d, 'pnames', { propertyNames: { pattern: '^[a-z]+$' } });
  const store = storeWith(s);
  expectGood(vi(store, { abc: 1 }, tid('pnames')), 'valid');
  expectBad(vi(store, { ABC: 1 }, tid('pnames')), 'invalid', 'propertyNames');
});

perDialect('out-of-profile pattern rejected', (d) => {
  const s = mk(d, 'oop', { properties: { a: { type: 'string', pattern: '(?=a)b' } } });
  const store = new GtsStore();
  const r = store.validateSchemaDocument(s, tid('oop'));
  expectBad(r, 'lookahead pattern');
  assert(/Unsupported regular expression/.test(r.error), `wording missing: ${r.error}`);
  const good = store.validateSchemaDocument(mk(d, 'oopok', { properties: { a: { type: 'string', pattern: '^a+$' } } }), tid('oopok'));
  expectGood(good, 'in-profile pattern');
});

perDialect('format date-time/time/regex', (d) => {
  const s = mk(d, 'fmt', {
    properties: {
      at: { type: 'string', format: 'date-time' },
      t: { type: 'string', format: 'time' },
      rx: { type: 'string', format: 'regex' },
    },
  });
  const store = storeWith(s);
  expectGood(vi(store, { at: '2020-01-01T00:00:00Z', t: '10:00:00+02:00', rx: '^a+$' }, tid('fmt')), 'valid formats');
  expectBad(vi(store, { at: '2020-01-01T00:00:00' }, tid('fmt')), 'date-time without offset', 'format', '/at');
  expectBad(vi(store, { t: '10:00:00' }, tid('fmt')), 'time without offset', 'format', '/t');
  expectBad(vi(store, { rx: '(?=a)' }, tid('fmt')), 'regex out of profile', 'format', '/rx');
});

const REF = 'gts.acme.demo.t.ref.v1~';
function xref(d, shape) {
  return mk(d, 'xr', { properties: { ref: shape } });
}
const XR_OK = `${REF}acme.demo.i.one.v1`;
const XR_BAD = 'gts.acme.demo.t.other.v1~acme.demo.i.one.v1';
for (const [label, shape, okVal, badVal] of [
  ['plain', { type: 'string', 'x-gts-ref': `${REF}*` }, XR_OK, XR_BAD],
  ['oneOf', { oneOf: [{ type: 'string', 'x-gts-ref': `${REF}*` }, { type: 'integer' }] }, XR_OK, XR_BAD],
  ['anyOf', { anyOf: [{ type: 'string', 'x-gts-ref': `${REF}*` }, { type: 'integer' }] }, XR_OK, XR_BAD],
  ['not', { not: { type: 'string', 'x-gts-ref': `${REF}*` } }, XR_BAD, XR_OK],
]) {
  perDialect(`x-gts-ref ${label}`, (d) => {
    const store = storeWith(xref(d, shape));
    expectGood(vi(store, { ref: okVal }, tid('xr')), `${label} valid`);
    expectBad(vi(store, { ref: badVal }, tid('xr')), `${label} invalid`);
  });
}

perDialect('x-gts-ref /$id per-call context', (d) => {
  const a = mk(d, 'sa', { properties: { ref: { type: 'string', 'x-gts-ref': '/$id' } } });
  const b = mk(d, 'sb', { properties: { ref: { type: 'string', 'x-gts-ref': '/$id' } } });
  const store = storeWith(a, b);
  const value = tid('sa');
  expectGood(vi(store, { ref: value }, tid('sa')), 'call 1 (type sa)');
  expectBad(vi(store, { ref: value }, tid('sb')), 'call 2 (type sb)', 'x-gts-ref', '/ref');
  expectGood(vi(store, { ref: tid('sb') }, tid('sb')), 'call 3 (type sb)');
});

perDialect('chained gts:// $ref with #/defs fragment', (d) => {
  const defs = DIALECTS[d].defs;
  const A = tid('ca');
  const B = `${A}acme.demo.t.cb.v1~`;
  const C = `${B}acme.demo.t.cc.v1~`;
  const base = { $schema: DIALECTS[d].uri, $id: `gts://${A}`, type: 'object', [defs]: { name: { type: 'string' } } };
  const mid = {
    $schema: DIALECTS[d].uri,
    $id: `gts://${B}`,
    allOf: [{ $ref: `gts://${A}` }, { type: 'object', properties: { n: { $ref: '#/' + defs + '/nm' } } }],
    [defs]: { nm: { type: 'string' } },
  };
  const leaf = {
    $schema: DIALECTS[d].uri,
    $id: `gts://${C}`,
    allOf: [{ $ref: `gts://${B}` }, { type: 'object', properties: { m: { type: 'integer' } } }],
  };
  const store = storeWith(base, mid, leaf);
  expectGood(vi(store, { n: 'x', m: 1 }, C), 'chain valid');
  expectBad(vi(store, { n: 5, m: 1 }, C), 'fragment ref violated', 'type', '/n');
  expectBad(vi(store, { n: 'x', m: 'no' }, C), 'leaf violated', 'type', '/m');
});

perDialect('closed object rejects _id', (d) => {
  const s = mk(d, 'closed', { properties: { a: { type: 'string' } }, additionalProperties: false });
  const store = storeWith(s);
  expectGood(vi(store, { a: 'x' }, tid('closed')), 'without _id');
  expectBad(vi(store, { a: 'x', _id: 'y' }, tid('closed')), 'with _id', 'additionalProperties');
});

perDialect('unevaluatedProperties across remote allOf', (d) => {
  const A = tid('ua');
  const B = `${A}acme.demo.t.ub.v1~`;
  const base = { $schema: DIALECTS[d].uri, $id: `gts://${A}`, type: 'object', properties: { a: { type: 'string' } } };
  const child = {
    $schema: DIALECTS[d].uri,
    $id: `gts://${B}`,
    allOf: [{ $ref: `gts://${A}` }],
    properties: { b: { type: 'string' } },
    unevaluatedProperties: false,
  };
  const store = storeWith(base, child);
  expectGood(vi(store, { a: 'x', b: 'y' }, B), 'all evaluated');
  expectBad(vi(store, { a: 'x', b: 'y', c: 'z' }, B), 'extra property', 'unevaluatedProperties');
}, ['2019-09', '2020-12']);

perDialect('schema error vs value failure', (d) => {
  const PREFIX = 'JSON Schema validation failed:';
  const store = new GtsStore();
  const badDoc = mk(d, 'sev', { properties: { a: { type: 'bogus-type' } } });
  const r = store.validateSchemaDocument(badDoc, tid('sev'));
  expectBad(r, 'invalid schema document');
  assert(count(r.error, PREFIX) === 1, `prefix count != 1: ${r.error}`);
  const good = mk(d, 'sev2', { properties: { a: { type: 'string' } } });
  const st2 = storeWith(good);
  expectGood(st2.validateSchemaDocument(good, tid('sev2')), 'valid schema document');
  const iv = vi(st2, { a: 1 }, tid('sev2'));
  expectBad(iv, 'value failure', 'type', '/a');
  assert(count(iv.error, PREFIX) === 0, `value failure carries the schema prefix: ${iv.error}`);
});

perDialect('transient instance and schema', (d) => {
  const s = mk(d, 'tr', { required: ['a'], properties: { a: { type: 'string' } } });
  const store = storeWith(s);
  expectGood(vi(store, { a: 'x' }, tid('tr')), 'transient instance valid');
  expectBad(vi(store, {}, tid('tr')), 'transient instance invalid', 'required');
  expectGood(store.validateTransientSchema(mk(d, 'trs', { properties: { a: { type: 'string' } } }), tid('trs')), 'transient schema valid');
  expectBad(store.validateTransientSchema(mk(d, 'trb', { properties: { a: { type: 'bogus-type' } } }), tid('trb')), 'transient schema invalid');
});

perDialect('unresolved $ref fails with prefix once', (d) => {
  const PREFIX = 'JSON Schema validation failed:';
  const store = new GtsStore();
  const bad = mk(d, 'unres', { properties: { a: { $ref: `gts://${tid('missing')}` } } });
  const r = store.validateSchemaDocument(bad, tid('unres'));
  expectBad(r, 'unresolved ref');
  assert(count(r.error, PREFIX) === 1, `prefix count != 1: ${r.error}`);
});

scenario('validateCastResult valid and invalid cast', () => {
  const store = new GtsStore();
  const target = mk('draft-07', 'cast', { required: ['a'], properties: { a: { type: 'string' } } });
  assert(store.validateCastResult(target, { a: 'x' }) === null, 'valid cast result rejected');
  const bad = store.validateCastResult(target, { a: 1 });
  assert(typeof bad === 'string' && bad.length > 0, `invalid cast result accepted: ${bad}`);
});

scenario('trait validation and validateSchemaAgainstParent via validateSchema', () => {
  const DRAFT7 = DIALECTS['draft-07'].uri;
  const baseId = tid('trbase');
  const base = {
    $id: `gts://${baseId}`,
    $schema: DRAFT7,
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
    'x-gts-abstract': true,
    'x-gts-traits-schema': {
      type: 'object',
      properties: { retention: { type: 'string', pattern: '^P[0-9]+D$' } },
      required: ['retention'],
    },
  };
  const derived = (name, traits) => ({
    $id: `gts://${baseId}acme.demo.t.${name}.v1~`,
    $schema: DRAFT7,
    type: 'object',
    allOf: [{ $ref: `gts://${baseId}` }, { type: 'object' }],
    'x-gts-traits': traits,
  });
  const okKid = derived('trok', { retention: 'P30D' });
  const badKid = derived('trbad', { retention: 'forever' });
  const store = storeWith(base, okKid, badKid);
  expectGood(store.validateSchema(okKid.$id.slice('gts://'.length)), 'traits satisfy the trait schema');
  expectBad(store.validateSchema(badKid.$id.slice('gts://'.length)), 'traits violate the trait schema');
});

let failed = 0;
for (const sc of scenarios) {
  try {
    sc.fn();
    console.log(`PASS ${sc.name}${sc.engineOnly ? ' (engineOnly)' : ''}`);
  } catch (error) {
    failed++;
    const msg = error && error.message ? error.message : String(error);
    console.log(`FAIL ${sc.name}: ${msg.split('\n')[0]}; error=${msg}`);
  }
}
console.log(`${scenarios.length - failed}/${scenarios.length} scenarios passed`);
process.exit(failed ? 1 : 0);
