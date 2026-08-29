// Emits the Bruno collection: one .bru file per request, git-diffable.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPTURE,
  exampleBody,
  groupByTag,
  makeResolver,
  pathVariable,
  rebrand,
  requestDocs,
  successCodes,
} from './lib/spec.mjs';

// Every block body is indented so a bare `}` inside JSON or prose can never be
// mistaken for the block terminator.
const indent = (text) =>
  String(text)
    .split('\n')
    .map((line) => (line.length ? `  ${line}` : ''))
    .join('\n');

const block = (header, body, open = '{', close = '}') =>
  `${header} ${open}\n${indent(body)}\n${close}\n`;

const kv = (pairs) => pairs.map(([k, v]) => `${k}: ${v}`).join('\n');

function fileName(op, method, path) {
  const base =
    op.operationId ??
    `${method}-${path.replace(/[^a-z0-9]+/gi, '-')}`.replace(/^-|-$/g, '');
  return `${base
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '')}.bru`;
}

function requestFile(entry, seq, resolve) {
  const { path, method, op } = entry;
  const params = (op.parameters ?? []).map(resolve);
  const query = params.filter((p) => p.in === 'query');
  const pathParams = params.filter((p) => p.in === 'path');

  const brunoPath = path.replace(/\{(.+?)\}/g, ':$1');
  const enabled = query.filter((p) => p.required);
  const queryString = enabled.length
    ? `?${enabled
        .map((p) => {
          const s = resolve(p.schema ?? {});
          return `${p.name}=${s.default ?? (Array.isArray(s.enum) ? s.enum[0] : '')}`;
        })
        .join('&')}`
    : '';

  const json = op.requestBody?.content?.['application/json']?.schema;
  const isUpload = op.operationId === 'uploadMedia';
  const bodyMode = json ? 'json' : isUpload ? 'multipartForm' : 'none';

  const parts = [];
  parts.push(
    block('meta', kv([
      ['name', rebrand(op.summary ?? op.operationId ?? path)],
      ['type', 'http'],
      ['seq', String(seq)],
    ])),
  );
  parts.push(
    block(
      method,
      kv([
        ['url', `{{baseUrl}}${brunoPath}${queryString}`],
        ['body', bodyMode],
        ['auth', 'inherit'],
      ]),
    ),
  );

  if (query.length) {
    parts.push(
      block(
        'params:query',
        kv(
          query.map((p) => {
            const s = resolve(p.schema ?? {});
            const value = s.default ?? (Array.isArray(s.enum) ? s.enum[0] : '');
            return [p.required ? p.name : `~${p.name}`, String(value)];
          }),
        ),
      ),
    );
  }

  if (pathParams.length) {
    parts.push(
      block(
        'params:path',
        kv(pathParams.map((p) => [p.name, `{{${pathVariable(p.name, path)}}}`])),
      ),
    );
  }

  if (json) {
    parts.push(block('headers', kv([['Content-Type', 'application/json']])));
    parts.push(block('body:json', JSON.stringify(exampleBody(json, resolve), null, 2)));
  } else if (isUpload) {
    parts.push(
      block(
        'body:multipart-form',
        kv([
          ['workspaceId', '{{workspaceId}}'],
          ['~files', '@file()'],
        ]),
      ),
    );
  }

  const variable = CAPTURE[op.operationId];
  if (variable) {
    parts.push(
      block(
        'script:post-response',
        [
          'if (res.getStatus() < 300) {',
          '  const body = res.getBody();',
          '  const id = body.id || (body.data && (body.data.id || (body.data[0] && body.data[0].id)));',
          `  if (id) bru.setEnvVar('${variable}', id);`,
          '}',
        ].join('\n'),
      ),
    );
  }

  parts.push(
    block(
      'tests',
      [
        `test('status is successful', function () {`,
        `  expect(res.getStatus()).to.be.oneOf([${successCodes(op).join(', ')}]);`,
        '});',
      ].join('\n'),
    ),
  );

  const docs = requestDocs(op, resolve);
  if (docs) parts.push(block('docs', docs));

  return parts.join('\n');
}

export function generateBruno(spec, outDir) {
  const resolve = makeResolver(spec);
  const groups = groupByTag(spec);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  writeFileSync(
    join(outDir, 'bruno.json'),
    `${JSON.stringify(
      { version: '1', name: 'FoPost API', type: 'collection', ignore: ['node_modules', '.git'] },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    join(outDir, 'collection.bru'),
    [
      block('auth', kv([['mode', 'apikey']])),
      block(
        'auth:apikey',
        kv([
          ['key', 'X-API-Key'],
          ['value', '{{apiKey}}'],
          ['placement', 'header'],
        ]),
      ),
      block('docs', rebrand(spec.info.description ?? '')),
    ].join('\n'),
  );

  const envDir = join(outDir, 'environments');
  mkdirSync(envDir, { recursive: true });
  const env = (name, baseUrl) =>
    [
      block(
        'vars',
        kv([
          ['baseUrl', baseUrl],
          ['workspaceId', ''],
          ['accountId', ''],
          ['postId', ''],
          ['labelId', ''],
          ['webhookId', ''],
          ['automationId', ''],
          ['mediaId', ''],
          ['communityId', ''],
          ['runId', ''],
          ['batchId', ''],
        ]),
      ),
      block('vars:secret', 'apiKey', '[', ']'),
    ].join('\n');
  writeFileSync(join(envDir, 'production.bru'), env('Production', 'https://api.fopost.com'));
  writeFileSync(join(envDir, 'local.bru'), env('Local', 'http://localhost:8080'));

  let count = 0;
  let folderSeq = 1;
  for (const [tag, entries] of groups) {
    const dir = join(outDir, tag);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'folder.bru'),
      block('meta', kv([['name', tag], ['seq', String(folderSeq++)]])),
    );
    entries.forEach((entry, index) => {
      writeFileSync(
        join(dir, fileName(entry.op, entry.method, entry.path)),
        requestFile(entry, index + 1, resolve),
      );
      count += 1;
    });
  }
  return count;
}
