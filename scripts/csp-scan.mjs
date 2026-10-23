#!/usr/bin/env node
// Static CSP / Trusted Types scan for the core runtime closure of `dist/index.js`.
//
// Default mode: resolves the closure from dist/index.js (require / import / import()
// through relative files and bare packages in node_modules), skips dist/server and
// dist/cli, adds tests/csp/sha256-shim.js, scans each file with comments and string
// contents removed. Only standalone sinks are flagged (no method names on other objects).
// Exit codes: 0 clean, 1 findings (or selftest failure), 2 scope failure / usage error.
//
// Options:
//   --root <dir>  scan every .js/.cjs/.mjs under <dir>, no closure resolution, no scope check
//   --selftest    run the sink fixtures (must exit 1 and name every rule) and the clean
//                 fixtures (must exit 0)

import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

// `globalThis.` / `window.` / `self.` qualifiers count as standalone, other `.x` does not.
const QUAL = String.raw`(?<![\w$.])(?:(?:globalThis|window|self)\s*\.\s*)?`;

/** @type {{id: string, re: RegExp}[]} */
export const RULES = [
  { id: 'eval', re: new RegExp(String.raw`(?<![\w$.])eval\s*\(`) },
  { id: 'globalthis-eval', re: new RegExp(String.raw`(?<![\w$.])(?:globalThis|window|self)\s*\.\s*eval\s*\(`) },
  { id: 'indirect-eval', re: new RegExp(String.raw`\(\s*0\s*,\s*eval\s*\)\s*\(`) },
  { id: 'new-function', re: new RegExp(String.raw`\bnew\s+(?:(?:globalThis|window|self)\s*\.\s*)?Function\b`) },
  { id: 'function-call', re: new RegExp(String.raw`(?<!\bnew\s+)${QUAL}Function\s*\(`) },
  { id: 'settimeout', re: new RegExp(String.raw`${QUAL}setTimeout\s*\(\s*['"\x60]`) },
  { id: 'setinterval', re: new RegExp(String.raw`${QUAL}setInterval\s*\(\s*['"\x60]`) },
  { id: 'webassembly', re: new RegExp(String.raw`${QUAL}WebAssembly\s*\.`) },
  { id: 'trustedtypes', re: new RegExp(String.raw`(?<![\w$])trustedTypes\s*\.\s*createPolicy\b`) },
  { id: 'innerhtml', re: new RegExp(String.raw`\.\s*(?:inner|outer)HTML\s*=(?!=)`) },
  { id: 'insertadjacenthtml', re: new RegExp(String.raw`\binsertAdjacentHTML\s*\(`) },
  { id: 'documentwrite', re: new RegExp(String.raw`${QUAL}document\s*\.\s*write(?:ln)?\s*\(`) },
  { id: 'fetch', re: new RegExp(String.raw`${QUAL}fetch\s*\(`) },
  { id: 'xhr', re: new RegExp(String.raw`\bnew\s+(?:(?:globalThis|window|self)\s*\.\s*)?XMLHttpRequest\b`) },
  { id: 'websocket', re: new RegExp(String.raw`\bnew\s+(?:(?:globalThis|window|self)\s*\.\s*)?WebSocket\s*\(`) },
  { id: 'sendbeacon', re: new RegExp(String.raw`${QUAL}navigator\s*\.\s*sendBeacon\s*\(`) },
  { id: 'eventsource', re: new RegExp(String.raw`\bnew\s+(?:(?:globalThis|window|self)\s*\.\s*)?EventSource\s*\(`) },
  { id: 'worker', re: new RegExp(String.raw`\bnew\s+(?:(?:globalThis|window|self)\s*\.\s*)?Worker\s*\(`) },
  { id: 'sharedworker', re: new RegExp(String.raw`\bnew\s+(?:(?:globalThis|window|self)\s*\.\s*)?SharedWorker\s*\(`) },
  { id: 'importscripts', re: new RegExp(String.raw`${QUAL}importScripts\s*\(`) },
];

const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;

/**
 * Remove comments (and, unless `keepStrings`, the contents of string, template and
 * regex literals). Newlines are preserved so line numbers stay valid.
 */
export function sanitize(src, keepStrings) {
  let out = '';
  let i = 0;
  const n = src.length;
  // Template-literal nesting: entries are 'tpl' (inside template text) or a number (brace depth in ${ }).
  const stack = [];
  const blank = (ch) => (keepStrings || ch === '\n' ? ch : ' ');
  // Template text never carries module specifiers, so it is blanked in both modes.
  const blankTpl = (ch) => (ch === '\n' ? ch : ' ');
  const prevSignificant = () => out.replace(/\s+$/, '');

  while (i < n) {
    const top = stack[stack.length - 1];
    const ch = src[i];

    if (top === 'tpl') {
      if (ch === '\\') {
        out += blankTpl(ch) + blankTpl(src[i + 1] ?? '');
        i += 2;
      } else if (ch === '`') {
        out += '`';
        stack.pop();
        i++;
      } else if (ch === '$' && src[i + 1] === '{') {
        out += '${';
        stack.push(0);
        i += 2;
      } else {
        out += blankTpl(ch);
        i++;
      }
      continue;
    }

    if (typeof top === 'number') {
      if (ch === '{') stack[stack.length - 1] = top + 1;
      else if (ch === '}') {
        if (top === 0) {
          stack.pop();
          out += '}';
          i++;
          continue;
        }
        stack[stack.length - 1] = top - 1;
      }
    }

    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) if (src[i] === '\n') out += '\n';
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'") {
      out += ch;
      i++;
      while (i < n && src[i] !== ch && src[i] !== '\n') {
        if (src[i] === '\\') {
          out += blank(src[i]) + blank(src[i + 1] ?? '');
          i += 2;
        } else {
          out += blank(src[i]);
          i++;
        }
      }
      if (i < n && src[i] === ch) {
        out += ch;
        i++;
      }
      continue;
    }
    if (ch === '`') {
      out += '`';
      stack.push('tpl');
      i++;
      continue;
    }
    if (ch === '/') {
      const prev = prevSignificant();
      const last = prev[prev.length - 1];
      if (last === undefined || REGEX_PRECEDERS.has(last) || REGEX_KEYWORDS.test(prev)) {
        out += '/';
        i++;
        let inClass = false;
        while (i < n && src[i] !== '\n') {
          const c = src[i];
          if (c === '\\') {
            out += blank(c) + blank(src[i + 1] ?? '');
            i += 2;
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          out += blank(c);
          i++;
        }
        if (src[i] === '/') {
          out += '/';
          i++;
        }
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * A call-shaped match followed by `) {` on the same line is a method definition
 * (for example re2js `eval(input, pos) {`), not a call of the global.
 */
function isMethodDefinition(match, text) {
  if (!match[0].endsWith('(')) return false;
  return /^[^()]*\)\s*\{/.test(text.slice(match.index + match[0].length));
}

/** Scan one file; returns findings as {file, line, rule, excerpt}. */
export function scanSource(file, src) {
  const findings = [];
  const clean = sanitize(src, false);
  const original = src.split('\n');
  const lines = clean.split('\n');
  lines.forEach((text, idx) => {
    for (const rule of RULES) {
      const m = rule.re.exec(text);
      if (m && !isMethodDefinition(m, text)) {
        findings.push({
          file,
          line: idx + 1,
          rule: rule.id,
          excerpt: (original[idx] ?? '').trim().slice(0, 120),
        });
      }
    }
  });
  return findings;
}

// ---------------------------------------------------------------- closure resolution

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveFile(base) {
  const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')];
  return candidates.find(isFile) ?? null;
}

const EXPORT_CONDITIONS = new Set(['require', 'import', 'default', 'node', 'module', 'browser']);

function collectExportTargets(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectExportTargets(v, out));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (EXPORT_CONDITIONS.has(key)) collectExportTargets(v, out);
    }
  }
}

function exportsEntry(exportsField, subpath) {
  if (exportsField === undefined || exportsField === null) return undefined;
  const isMap = typeof exportsField === 'object' && !Array.isArray(exportsField) && Object.keys(exportsField).some((k) => k.startsWith('.'));
  if (!isMap) return subpath === '.' ? exportsField : undefined;
  if (subpath in exportsField) return exportsField[subpath];
  for (const [key, v] of Object.entries(exportsField)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const head = key.slice(0, star);
    const tail = key.slice(star + 1);
    if (subpath.startsWith(head) && subpath.endsWith(tail)) {
      const mid = subpath.slice(head.length, subpath.length - tail.length);
      const substitute = (t) => (typeof t === 'string' ? t.replace('*', mid) : t);
      const mapped = JSON.parse(JSON.stringify(v), (_, x) => substitute(x));
      return mapped;
    }
  }
  return undefined;
}

function splitSpecifier(spec) {
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const rest = spec.slice(name.length);
  return { name, subpath: rest ? `.${rest}` : '.' };
}

function findPackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (isDir(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveBare(spec, fromDir) {
  const { name, subpath } = splitSpecifier(spec);
  const pkgDir = findPackageDir(name, fromDir);
  if (!pkgDir) return [];
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    // no readable package.json: fall through to file resolution
  }
  const targets = [];
  const viaExports = exportsEntry(pkg.exports, subpath);
  if (viaExports !== undefined) collectExportTargets(viaExports, targets);
  if (subpath === '.') {
    for (const field of ['main', 'module', 'browser']) {
      const v = pkg[field];
      if (typeof v === 'string') targets.push(v);
      else if (v && typeof v === 'object' && field === 'browser') {
        for (const t of Object.values(v)) if (typeof t === 'string') targets.push(t);
      }
    }
    if (targets.length === 0) targets.push('index.js');
  } else if (viaExports === undefined) {
    targets.push(subpath);
  }
  const resolved = new Set();
  for (const t of targets) {
    const file = resolveFile(path.resolve(pkgDir, t));
    if (file && SCRIPT_EXTENSIONS.has(path.extname(file))) resolved.add(file);
  }
  return [...resolved];
}

function extractSpecifiers(src) {
  const text = sanitize(src, true);
  const specs = new Set();
  const patterns = [
    /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    /\bfrom\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*(['"])([^'"\n]+)\1/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) specs.add(m[2]);
  }
  return [...specs];
}

const builtins = new Set(builtinModules);
function isBuiltin(spec) {
  return spec.startsWith('node:') || builtins.has(spec) || builtins.has(spec.split('/')[0]);
}

function resolveClosure(entries, skipDirs) {
  const seen = new Set();
  const unresolved = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    if (skipDirs.some((d) => file === d || file.startsWith(d + path.sep))) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const spec of extractSpecifiers(src)) {
      if (isBuiltin(spec)) continue;
      let next = [];
      if (spec.startsWith('.') || path.isAbsolute(spec)) {
        const f = resolveFile(path.resolve(path.dirname(file), spec));
        if (f && SCRIPT_EXTENSIONS.has(path.extname(f))) next = [f];
        else if (!f) unresolved.add(`${path.relative(repoRoot, file)} -> ${spec}`);
      } else {
        next = resolveBare(spec, path.dirname(file));
        if (next.length === 0) unresolved.add(`${path.relative(repoRoot, file)} -> ${spec}`);
      }
      queue.push(...next);
    }
  }
  return { files: [...seen].sort(), unresolved: [...unresolved].sort() };
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (SCRIPT_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out.sort();
}

// ---------------------------------------------------------------- modes

function report(files) {
  const findings = [];
  for (const file of files) {
    findings.push(...scanSource(path.relative(repoRoot, file), fs.readFileSync(file, 'utf8')));
  }
  for (const f of findings) console.log(`${f.file}:${f.line}: ${f.rule}: ${f.excerpt}`);
  console.log(`csp-scan: ${files.length} files scanned, ${findings.length} findings`);
  return findings;
}

function runRoot(dir) {
  const abs = path.resolve(dir);
  if (!isDir(abs)) {
    console.error(`csp-scan: not a directory: ${dir}`);
    return 2;
  }
  return report(walk(abs)).length > 0 ? 1 : 0;
}

function runClosure() {
  const entry = path.join(repoRoot, 'dist', 'index.js');
  if (!isFile(entry)) {
    console.error('csp-scan: dist/index.js missing (run `npm run build` first)');
    return 2;
  }
  const shim = path.join(repoRoot, 'tests', 'csp', 'sha256-shim.js');
  const skip = [path.join(repoRoot, 'dist', 'server'), path.join(repoRoot, 'dist', 'cli')];
  const { files, unresolved } = resolveClosure([entry, shim], skip);
  const required = ['json-schema-library', 're2js'];
  const missing = required.filter((pkg) => !files.some((f) => f.includes(`${path.sep}node_modules${path.sep}${pkg}${path.sep}`)));
  if (missing.length > 0) {
    console.error(`csp-scan: scope failure, closure lacks node_modules/${missing.join(', node_modules/')}`);
    return 2;
  }
  for (const u of unresolved) console.log(`csp-scan: unresolved (not scanned): ${u}`);
  const packages = new Set(
    files
      .map((f) => path.relative(repoRoot, f).split(path.sep))
      .filter((p) => p[0] === 'node_modules')
      .map((p) => (p[1].startsWith('@') ? `${p[1]}/${p[2]}` : p[1]))
  );
  console.log(`csp-scan: closure packages: ${[...packages].sort().join(', ')}`);
  return report(files).length > 0 ? 1 : 0;
}

function selfTest() {
  const self = fileURLToPath(import.meta.url);
  const run = (dir) => spawnSync(process.execPath, [self, '--root', dir], { cwd: repoRoot, encoding: 'utf8' });
  let ok = true;

  const sinks = run('tests/csp/fixtures/sinks');
  process.stdout.write(sinks.stdout);
  const named = RULES.filter((r) => !sinks.stdout.includes(`: ${r.id}: `));
  if (sinks.status !== 1) {
    console.error(`selftest: sink fixtures exited ${sinks.status}, expected 1`);
    ok = false;
  }
  if (named.length > 0) {
    console.error(`selftest: rules missing from sink output: ${named.map((r) => r.id).join(', ')}`);
    ok = false;
  }
  const clean = run('tests/csp/fixtures/clean');
  if (clean.status !== 0) {
    console.error(`selftest: clean fixtures exited ${clean.status}, expected 0\n${clean.stdout}`);
    ok = false;
  }
  if (ok) console.log(`selftest: ok (${RULES.length} rules named by sink fixtures, clean fixtures silent)`);
  return ok ? 0 : 1;
}

const args = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code;
  if (args.includes('--selftest')) code = selfTest();
  else if (args.includes('--root')) {
    const dir = args[args.indexOf('--root') + 1];
    code = dir ? runRoot(dir) : 2;
  } else code = runClosure();
  process.exit(code);
}
