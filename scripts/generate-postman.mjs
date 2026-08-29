// Emits the Postman v2.1 collection and its environments.

import { mkdirSync, writeFileSync } from 'node:fs';
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
  tagDescription,
} from './lib/spec.mjs';

const COLLECTION_ID = '8f6a2c14-5b7d-4c39-9e02-fopost000001';

const collectionTests = (op) => {
  const lines = [
    `pm.test('status is successful', function () {`,
    `    pm.expect(pm.response.code).to.be.oneOf([${successCodes(op).join(', ')}]);`,
    `});`,
  ];
  const variable = CAPTURE[op.operationId];
  if (variable) {
    lines.push(
      ``,
      `if (pm.response.code < 300) {`,
      `    var body = pm.response.json();`,
      `    var id = body.id || (body.data && (body.data.id || (body.data[0] && body.data[0].id)));`,
      `    if (id) {`,
      `        pm.collectionVariables.set('${variable}', id);`,
      `        console.log('${variable} =', id);`,
      `    }`,
      `}`,
    );
  }
  return lines;
};

function buildUrl(path, op, resolve) {
  const segments = path.replace(/^\//, '').split('/');
  const params = (op.parameters ?? []).map(resolve);
  const pathParams = [];

  const postmanPath = segments.map((segment) => {
    const match = segment.match(/^\{(.+)\}$/);
    if (!match) return segment;
    const name = match[1];
    pathParams.push({
      key: name,
      value: `{{${pathVariable(name, path)}}}`,
      description: params.find((p) => p.in === 'path' && p.name === name)?.description ?? '',
    });
    return `:${name}`;
  });

  const query = params
    .filter((p) => p.in === 'query')
    .map((p) => {
      const schema = resolve(p.schema ?? {});
      const value =
        schema.default !== undefined
          ? String(schema.default)
          : Array.isArray(schema.enum)
            ? String(schema.enum[0])
            : '';
      return {
        key: p.name,
        value,
        description: rebrand(p.description ?? ''),
        disabled: !p.required,
      };
    });

  const raw = `{{baseUrl}}/${postmanPath.join('/')}${
    query.filter((q) => !q.disabled).length
      ? `?${query
          .filter((q) => !q.disabled)
          .map((q) => `${q.key}=${q.value}`)
          .join('&')}`
      : ''
  }`;

  const url = { raw, host: ['{{baseUrl}}'], path: postmanPath };
  if (query.length) url.query = query;
  if (pathParams.length) url.variable = pathParams;
  return url;
}

function buildRequest(entry, resolve) {
  const { path, method, op } = entry;
  const request = {
    method: method.toUpperCase(),
    header: [],
    url: buildUrl(path, op, resolve),
    description: requestDocs(op, resolve),
  };

  const json = op.requestBody?.content?.['application/json']?.schema;
  if (json) {
    request.header.push({ key: 'Content-Type', value: 'application/json' });
    request.body = {
      mode: 'raw',
      raw: JSON.stringify(exampleBody(json, resolve), null, 2),
      options: { raw: { language: 'json' } },
    };
  } else if (op.operationId === 'uploadMedia') {
    // Documented in prose only: multipart under `files`, up to 5, 50 MB each.
    request.body = {
      mode: 'formdata',
      formdata: [
        { key: 'files', type: 'file', src: [], description: 'Up to 5 files, 50 MB each' },
        { key: 'workspaceId', value: '{{workspaceId}}', type: 'text' },
      ],
    };
  }

  return {
    name: rebrand(op.summary ?? op.operationId ?? `${method.toUpperCase()} ${path}`),
    request,
    response: [],
    event: [{ listen: 'test', script: { type: 'text/javascript', exec: collectionTests(op) } }],
  };
}

export function generatePostman(spec, outDir) {
  const resolve = makeResolver(spec);
  const groups = groupByTag(spec);

  const collection = {
    info: {
      _postman_id: COLLECTION_ID,
      name: 'FoPost API',
      description: rebrand(spec.info.description ?? ''),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'X-API-Key', type: 'string' },
        { key: 'value', value: '{{apiKey}}', type: 'string' },
        { key: 'in', value: 'header', type: 'string' },
      ],
    },
    event: [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: [
            "pm.test('responds as JSON', function () {",
            "    if (pm.response.code !== 204) {",
            "        pm.expect(pm.response.headers.get('Content-Type') || '').to.include('json');",
            '    }',
            '});',
            '',
            "var remaining = pm.response.headers.get('X-RateLimit-Remaining');",
            "if (remaining !== null && Number(remaining) < 10) {",
            "    console.warn('Rate limit nearly exhausted:', remaining, 'requests left');",
            '}',
          ],
        },
      },
    ],
    item: [],
    variable: [
      { key: 'baseUrl', value: spec.servers?.[0]?.url ?? 'https://api.fopost.com', type: 'string' },
      { key: 'apiKey', value: '', type: 'string' },
      { key: 'workspaceId', value: '', type: 'string' },
      { key: 'accountId', value: '', type: 'string' },
      { key: 'postId', value: '', type: 'string' },
      { key: 'labelId', value: '', type: 'string' },
      { key: 'webhookId', value: '', type: 'string' },
      { key: 'automationId', value: '', type: 'string' },
      { key: 'mediaId', value: '', type: 'string' },
      { key: 'communityId', value: '', type: 'string' },
      { key: 'runId', value: '', type: 'string' },
      { key: 'batchId', value: '', type: 'string' },
    ],
  };

  for (const [tag, entries] of groups) {
    collection.item.push({
      name: tag,
      description: tagDescription(spec, tag),
      item: entries.map((entry) => buildRequest(entry, resolve)),
    });
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'fopost-api.postman_collection.json'),
    `${JSON.stringify(collection, null, 2)}\n`,
  );

  // Only what genuinely differs per environment. Ids are runtime state captured
  // by the test scripts into collection variables; an environment entry of the
  // same name would resolve first and shadow them with an empty string.
  const environment = (name, baseUrl) => ({
    id: `fopost-env-${name.toLowerCase()}`,
    name: `FoPost ${name}`,
    values: [
      { key: 'baseUrl', value: baseUrl, type: 'default', enabled: true },
      { key: 'apiKey', value: '', type: 'secret', enabled: true },
    ],
    _postman_variable_scope: 'environment',
  });

  writeFileSync(
    join(outDir, 'fopost-production.postman_environment.json'),
    `${JSON.stringify(environment('Production', 'https://api.fopost.com'), null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, 'fopost-local.postman_environment.json'),
    `${JSON.stringify(environment('Local', 'http://localhost:8080'), null, 2)}\n`,
  );

  return collection.item.reduce((sum, folder) => sum + folder.item.length, 0);
}
