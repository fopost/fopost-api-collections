#!/usr/bin/env node
// Lists every operation in openapi.json that a client has no method for.
//
//   node scripts/sdk-gaps.mjs                        every SDK sibling under ../
//   node scripts/sdk-gaps.mjs ../fopost-go [...]     only these clients
//   node scripts/sdk-gaps.mjs --root /path/to/dir    siblings live elsewhere (a worktree)
//   node scripts/sdk-gaps.mjs --spec path/to/openapi.json
//   node scripts/sdk-gaps.mjs --json
//
// An operation counts as wrapped when the client's source spells its path as a
// string literal (a path param may be any interpolation) with the HTTP verb
// within a few lines, when the path sits in a helper and the verb is used in
// that same file, or when the operationId is named in a comment or docstring (the
// explicit escape hatch; a method merely named like it does not count). Exits 1 on any gap.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHODS, loadSpec } from './lib/spec.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Full REST clients: every operation in the spec must be reachable. */
export const SDK_CLIENTS = [
  'fopost-js',
  'fopost-python',
  'fopost-php',
  'fopost-ruby',
  'fopost-go',
  'fopost-rust',
  'fopost-java',
  'fopost-dotnet',
  'fopost-swift',
  'fopost-kotlin',
  'fopost-dart',
  'fopost-elixir',
];

/** Whole groups no SDK wraps. */
const SKIPPED_TAGS = {
  OAuth: 'the authorization server for MCP clients, spoken by an OAuth library',
  API: 'the spec itself',
};

/** Single operations no SDK wraps, with the reason. */
const SKIPPED_OPERATIONS = {
  adsConnectCallback: 'browser redirect at the end of an ad-network login',
  triggerAutomationWebhook: 'called by the third party, authenticated by the automation secret',
};

const SOURCE_EXT = /\.(ts|js|mjs|py|php|rb|go|rs|java|cs|swift|kt|dart|ex|exs)$/;
const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'target', 'vendor', 'deps', '_build', 'bin', 'obj', '.git',
  '.claude', 'examples', 'example', 'test', 'tests', 'Tests', 'spec', '__pycache__',
]);
const TEST_FILE = /(\.test\.|_test\.|Tests?\.|_spec\.|^test_)/;

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (SOURCE_EXT.test(entry) && !TEST_FILE.test(entry)) out.push(full);
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `{id}`, `${id}`, `\(id)`, `#{id}`, `%s`, or a `" + id + "` concatenation.
const INTERPOLATION =
  '(?:\\$?\\{[^}/]*\\}|\\\\\\([^)]*\\)|#\\{[^}]*\\}|%[sv]|"\\s*\\+[^/\\n"]*\\+\\s*"|"\\s*<>[^/\\n"]*<>\\s*")';

const PARAM = '[^/\\n]+';
const isParam = (seg) => /^\{.+\}$/.test(seg);
const literal = (seg) => `(?:${escape(seg)}|${INTERPOLATION})`;
const BOUNDARY = `(?=["'\`?)\\s,;]|$)`;

/**
 * `/v1/posts/{id}/unpublish` → a regex over source for that path. Matches the whole path
 * spelled from a quote, or only the segments after a param when a helper built the prefix
 * (`{AccountPath(id)}/telegram/commands`, `path(id) <> "/telegram/commands"`).
 */
function pathPatterns(path) {
  const segments = path.replace(/^\/v1/, '').split('/').slice(1);
  const render = (segs) => segs.map((seg) => (isParam(seg) ? PARAM : literal(seg))).join('/');
  const tails = [];
  segments.forEach((seg, i) => {
    const tail = segments.slice(i + 1);
    if (!isParam(seg) || tail.length === 0 || !tail.some((t) => !isParam(t))) return;
    tails.push(`(?:[})"'\`])/${render(tail)}`);
  });
  return {
    full: new RegExp(`["'\`](?:/v1)?/${render(segments)}${BOUNDARY}`, 'g'),
    tail: tails.length ? new RegExp(`(?:${tails.join('|')})${BOUNDARY}`, 'g') : null,
    resource: segments[0],
  };
}

/** A tail match on a line that spells another resource's path is that other resource. */
function tailConflicts(line, resource, resources) {
  for (const other of resources) {
    if (other !== resource && new RegExp(`/${escape(other)}(?:/|["'\`])`).test(line)) return true;
  }
  return false;
}

const VERB = {
  get: 'get',
  post: 'post',
  put: 'put',
  patch: 'patch',
  delete: 'del(?:ete)?',
};

function verbPattern(verb) {
  return new RegExp(
    `(?:^|[^A-Za-z])(?:http)?${VERB[verb]}(?:[^A-Za-z]|async|object|json|list|$)`,
    'i',
  );
}

const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*|@doc|@moduledoc|@typedoc|"""|''')/;

/** The comment and docstring lines of a file, where an operationId may be named. */
function commentText(lines) {
  const out = [];
  let docstring = false;
  for (const line of lines) {
    const fences = (line.match(/"""|'''/g) ?? []).length;
    if (docstring || COMMENT_LINE.test(line)) out.push(line);
    if (fences % 2 === 1) docstring = !docstring;
  }
  return out.join('\n');
}

function indexClient(dir) {
  return sourceFiles(dir).map((file) => {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    return { file, text, lines, comments: commentText(lines) };
  });
}

function findOperation(files, op, resources) {
  const { full, tail, resource } = pathPatterns(op.path);
  const matches = (line) => {
    full.lastIndex = 0;
    if (full.test(line)) return true;
    if (!tail) return false;
    tail.lastIndex = 0;
    return tail.test(line) && !tailConflicts(line, resource, resources);
  };
  const blank = (text) => text.replace(full, '""').replace(tail ?? /$^/, '""');
  const verb = verbPattern(op.method);
  const idWord = new RegExp(`\\b${op.id}\\b`);
  let state = 'missing';
  for (const { text, lines, comments } of files) {
    if (idWord.test(comments)) return 'named';
    let pathInFile = false;
    for (let i = 0; i < lines.length; i++) {
      if (!matches(lines[i])) continue;
      pathInFile = true;
      const window = blank(lines.slice(Math.max(0, i - 3), i + 3).join('\n'));
      if (verb.test(window)) return 'matched';
    }
    if (pathInFile && verb.test(blank(text))) state = 'file';
    else if (pathInFile && state === 'missing') state = 'path-only';
  }
  return state;
}

export function operations(spec) {
  const out = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      out.push({ path, method, id: op.operationId, tag: op.tags?.[0] ?? '' });
    }
  }
  return out;
}

export function gapsFor(spec, clientDir) {
  const files = indexClient(clientDir);
  const ops = operations(spec);
  const resources = new Set(ops.map((op) => op.path.replace(/^\/v1/, '').split('/')[1]));
  const gaps = [];
  for (const op of ops) {
    if (SKIPPED_TAGS[op.tag] || SKIPPED_OPERATIONS[op.id]) continue;
    const state = findOperation(files, op, resources);
    if (state === 'matched' || state === 'named' || state === 'file') continue;
    gaps.push({ ...op, state });
  }
  return gaps;
}

function parseArgs(argv) {
  const args = { clients: [], spec: join(root, 'openapi.json'), json: false, root: join(root, '..') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spec') args.spec = resolve(argv[++i]);
    else if (a === '--root') args.root = resolve(argv[++i]);
    else if (a === '--json') args.json = true;
    else args.clients.push(resolve(a));
  }
  if (args.clients.length === 0) {
    args.clients = SDK_CLIENTS.map((name) => join(args.root, name));
    const absent = args.clients.filter((p) => !existsSync(p));
    if (absent.length) {
      console.error(`Not checked out beside this repo: ${absent.map((p) => basename(p)).join(', ')}`);
      process.exit(1);
    }
  }
  return args;
}

/** The repo name, or the path when a worktree hides it. */
function labelFor(dir) {
  const name = basename(dir);
  return /^fopost-/.test(name) ? name : dir.replace(process.cwd() + '/', '');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const spec = loadSpec(args.spec);
  const report = {};
  let failed = false;
  for (const dir of args.clients) {
    const gaps = gapsFor(spec, dir);
    report[labelFor(dir)] = gaps;
    if (gaps.length) failed = true;
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const [name, gaps] of Object.entries(report)) {
      console.log(`${name}: ${gaps.length ? `${gaps.length} missing` : 'complete'}`);
      for (const g of gaps) {
        const note = g.state === 'path-only' ? '  (path found, verb not)' : '';
        console.log(`  ${g.method.toUpperCase().padEnd(6)} ${g.path}  ${g.id}${note}`);
      }
    }
  }
  process.exit(failed ? 1 : 0);
}
