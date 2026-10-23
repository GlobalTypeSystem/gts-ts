#!/usr/bin/env node
// Performance gate for GtsStore.validateInstance (cached and first-call paths) plus a heap-growth mode.
// Usage: node scripts/bench.mjs [--root <dir>] [--measure] [--thresholds <file>] [--heap] [--runs <n>]
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WARMUP = 200;
const CACHED_ITERATIONS = 1500;
const FIRST_CALL_WARMUP = 50;
const FIRST_CALL_ITERATIONS = 1000;
const HEAP_CALLS = 5000;
const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const TYPE_ID = 'gts.x.unit.bench.big.v1~';
const INSTANCE_ID = TYPE_ID + 'x.unit._.i.v1';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, '..');

function usage(msg) {
  process.stderr.write(
    `${msg}\nusage: node scripts/bench.mjs [--root <dir>] [--measure] [--thresholds <file>] [--heap] [--runs <n>]\n`
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    root: defaultRoot,
    measure: false,
    thresholds: path.join(defaultRoot, 'bench', 'thresholds.json'),
    heap: false,
    runs: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--measure') opts.measure = true;
    else if (a === '--heap') opts.heap = true;
    else if (a === '--runs') {
      const v = argv[++i];
      if (!v || !/^\d+$/.test(v) || Number(v) < 1) usage('--runs needs an integer >= 1');
      opts.runs = Number(v);
    } else if (a === '--root' || a === '--thresholds') {
      const v = argv[++i];
      if (!v) usage(`${a} needs a value`);
      if (a === '--root') opts.root = path.resolve(v);
      else opts.thresholds = path.resolve(v);
    } else usage(`unknown argument ${a}`);
  }
  return opts;
}

function buildWorkload() {
  const props = {};
  for (let i = 0; i < 24; i++) {
    props['p' + i] =
      i % 3 === 0
        ? { type: 'string', maxLength: 50 }
        : i % 3 === 1
          ? { type: 'integer' }
          : {
              oneOf: [
                { type: 'string' },
                { type: 'object', properties: { x: { oneOf: [{ type: 'number' }, { type: 'null' }] } } },
              ],
            };
  }
  props.id = { type: 'string' };
  const schema = { $id: 'gts://' + TYPE_ID, $schema: DIALECT, type: 'object', properties: props };
  const instance = { id: INSTANCE_ID };
  for (let i = 0; i < 24; i++) instance['p' + i] = i % 3 === 0 ? 'abc' : i % 3 === 1 ? 5 : 'q';
  return { schema, instance };
}

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const nowUs = () => Number(process.hrtime.bigint()) / 1000;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const req = createRequire(import.meta.url);
  let lib;
  try {
    lib = req(path.join(opts.root, 'dist', 'index.js'));
  } catch (e) {
    usage(`cannot load ${path.join(opts.root, 'dist', 'index.js')}: ${e.message}`);
  }
  const { GtsStore, createJsonEntity } = lib;
  const { schema, instance } = buildWorkload();

  const makeStore = () => {
    const store = new GtsStore();
    store.register(createJsonEntity(schema));
    store.register(createJsonEntity(instance));
    return store;
  };
  const checked = (r) => {
    if (!r.ok) throw new Error('benchmark workload failed validation: ' + r.error);
    return r;
  };

  const env = {
    node: process.version,
    cpu: os.cpus()[0].model,
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    root: opts.root,
  };

  if (opts.heap) {
    if (typeof global.gc !== 'function') usage('--heap requires node --expose-gc');
    const heapMb = () => {
      global.gc();
      global.gc();
      return process.memoryUsage().heapUsed / 1048576;
    };
    const workload = (fn) => {
      const before = heapMb();
      for (let i = 0; i < HEAP_CALLS; i++) fn();
      const after = heapMb();
      return Number((after - before).toFixed(3));
    };
    const store = makeStore();
    checked(store.validateInstance(INSTANCE_ID));
    const validateInstanceGrowthMb = workload(() => checked(store.validateInstance(INSTANCE_ID)));
    const transientStore = makeStore();
    checked(transientStore.validateTransientInstance(instance, TYPE_ID, null));
    const validateTransientGrowthMb = workload(() =>
      checked(transientStore.validateTransientInstance(instance, TYPE_ID, null))
    );
    console.log(
      JSON.stringify({
        ...env,
        calls: HEAP_CALLS,
        heap_growth_mb: {
          validateInstance: validateInstanceGrowthMb,
          validateTransientInstance: validateTransientGrowthMb,
        },
      })
    );
    return;
  }

  const measureOnce = () => {
    // cached path
    const store = makeStore();
    for (let i = 0; i < WARMUP; i++) checked(store.validateInstance(INSTANCE_ID));
    const cached = [];
    for (let i = 0; i < CACHED_ITERATIONS; i++) {
      const a = nowUs();
      const r = store.validateInstance(INSTANCE_ID);
      const b = nowUs();
      checked(r);
      cached.push(b - a);
    }
    // first-call path: fresh store per measurement, setup untimed
    const first = [];
    for (let i = 0; i < FIRST_CALL_WARMUP + FIRST_CALL_ITERATIONS; i++) {
      const s = makeStore();
      const a = nowUs();
      const r = s.validateInstance(INSTANCE_ID);
      const b = nowUs();
      checked(r);
      if (i >= FIRST_CALL_WARMUP) first.push(b - a);
    }
    return { cached_validate: Number(median(cached).toFixed(2)), first_call: Number(median(first).toFixed(2)) };
  };
  const perRun = { cached_validate: [], first_call: [] };
  for (let n = 0; n < opts.runs; n++) {
    const m = measureOnce();
    perRun.cached_validate.push(m.cached_validate);
    perRun.first_call.push(m.first_call);
  }
  const result = {
    ...env,
    runs: opts.runs,
    iterations: { cached_validate: CACHED_ITERATIONS, first_call: FIRST_CALL_ITERATIONS },
    warmup: { cached_validate: WARMUP, first_call: FIRST_CALL_WARMUP },
    per_run_median_us: perRun,
    median_us: { cached_validate: median(perRun.cached_validate), first_call: median(perRun.first_call) },
  };
  console.log(JSON.stringify(result));
  if (opts.measure) return;

  let th;
  try {
    th = JSON.parse(readFileSync(opts.thresholds, 'utf8'));
  } catch (e) {
    usage(`cannot read thresholds ${opts.thresholds}: ${e.message}`);
  }
  const limits = { cached_validate: th.thresholds?.cached_validate_us, first_call: th.thresholds?.first_call_us };
  let failed = false;
  for (const k of Object.keys(limits)) {
    if (typeof limits[k] !== 'number') usage(`thresholds file lacks thresholds.${k}_us`);
    const ok = result.median_us[k] <= limits[k];
    if (!ok) failed = true;
    process.stderr.write(`${ok ? 'ok  ' : 'FAIL'} ${k}: ${result.median_us[k]} us (threshold ${limits[k]} us)\n`);
  }
  if (failed) process.exit(1);
}

main();
