import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';
import * as fs from 'fs';

// Loads the core bundle (dist/index.js closure, crypto aliased to the SHA-256 shim) in
// headless Chromium under a strict CSP + Trusted Types header and asserts that the
// issue-28 repro runs with zero violations. A control page that deliberately breaks the
// policy must fire violations, otherwise the test would be vacuous.

const STRICT_CSP =
  "script-src 'self'; object-src 'none'; base-uri 'none'; worker-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'";

const root = path.resolve(__dirname, '..', '..');
const bundleDir = path.join(root, '.tmp', 'csp-bundle');
const bundleFile = path.join(bundleDir, 'bundle.js');

const MAIN_HTML =
  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><script src="/bundle.js"></script></body></html>';
// The inline script is blocked by script-src itself: under `require-trusted-types-for 'script'`
// a string passed to Function() is reported as a Trusted Types violation before script-src is consulted.
const CONTROL_HTML =
  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><script>window.__inlineRan = true;</script><script src="/control.js"></script></body></html>';
const CONTROL_JS = `
try { new Function('return 1'); } catch (e) { /* expected: blocked by script-src */ }
try { document.body.innerHTML = '<b>x</b>'; } catch (e) { /* expected: blocked by Trusted Types */ }
`;

interface Violation {
  violatedDirective: string;
  blockedURI: string;
  sample: string;
}

const counts = { main: -1, control: -1, requests: -1 };
let server: http.Server;
let baseUrl = '';

async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: unknown[] };
    w.__violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__violations.push({
        violatedDirective: event.violatedDirective,
        blockedURI: event.blockedURI,
        sample: event.sample,
      });
    });
  });
}

async function violationsOf(page: Page): Promise<Violation[]> {
  await page.waitForTimeout(300);
  return page.evaluate(() => (window as unknown as { __violations: Violation[] }).__violations);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await build({
    stdin: {
      contents: `
        const api = require(${JSON.stringify(path.join(root, 'dist', 'index.js'))});
        const { runRepro } = require(${JSON.stringify(path.join(root, 'tests', 'csp', 'repro.cjs'))});
        try {
          globalThis.__result = runRepro(api);
        } catch (error) {
          globalThis.__error = String((error && error.stack) || error);
        }
      `,
      resolveDir: root,
      loader: 'js',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: bundleFile,
    // Node's crypto (core uses createHash('sha256') once) is replaced by a pure-JS shim.
    alias: {
      crypto: path.join(root, 'tests', 'csp', 'sha256-shim.js'),
      // core `require('jsonc-parser')` makes esbuild pick the UMD `main`, whose `require` indirection
      // breaks bundling; the package's own ES-module build is used instead.
      'jsonc-parser': path.join(root, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js'),
    },
    // repro.cjs requires `path` only inside its `require.main === module` guard (inert here).
    external: ['path'],
    logLevel: 'silent',
  });

  // Scan gate: the whole bundle, `path` external included.
  execFileSync(process.execPath, ['scripts/csp-scan.mjs', '--root', '.tmp/csp-bundle'], { cwd: root, stdio: 'pipe' });

  server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const headers = { 'Content-Security-Policy': STRICT_CSP };
    const send = (type: string, body: string | Buffer, status = 200) => {
      res.writeHead(status, { ...headers, 'Content-Type': type });
      res.end(body);
    };
    if (url === '/') send('text/html', MAIN_HTML);
    else if (url === '/bundle.js') send('application/javascript', fs.readFileSync(bundleFile));
    else if (url === '/control.html') send('text/html', CONTROL_HTML);
    else if (url === '/control.js') send('application/javascript', CONTROL_JS);
    else send('text/plain', 'not found', 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  console.log(`CSP_COUNTS main=${counts.main} control=${counts.control} requests=${counts.requests}`);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('control page violating the policy fires violations (positive control)', async ({ page }) => {
  await instrument(page);
  await page.goto(`${baseUrl}/control.html`);
  const violations = await violationsOf(page);
  counts.control = violations.length;
  expect(violations.some((v) => v.violatedDirective.startsWith('script-src'))).toBe(true);
  expect(violations.some((v) => v.violatedDirective.startsWith('require-trusted-types-for'))).toBe(true);
});

test('core bundle runs the issue-28 repro under the strict CSP with zero violations', async ({ page }) => {
  const requested: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'http:') requested.push(url.pathname);
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await instrument(page);

  const response = await page.goto(`${baseUrl}/`);
  const violations = await violationsOf(page);
  counts.main = violations.length;
  counts.requests = requested.length;

  const outcome = await page.evaluate(() => {
    const g = globalThis as unknown as { __result?: unknown; __error?: string };
    return { result: g.__result, error: g.__error };
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeResult = require('./repro.cjs').runRepro(require('../../dist/index.js'));

  expect(response?.headers()['content-security-policy']).toBe(STRICT_CSP);
  expect(outcome.error).toBeUndefined();
  expect(outcome.result).toEqual(nodeResult);
  expect((outcome.result as { ok: boolean }).ok).toBe(true);
  expect((outcome.result as { valid: boolean }).valid).toBe(true);
  expect(violations).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect([...requested].sort()).toEqual(['/', '/bundle.js']);
});
