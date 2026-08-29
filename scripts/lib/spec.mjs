// Shared reading of the OpenAPI document: ref resolution, example bodies,
// variable naming. Both emitters build on this so Postman and Bruno never
// disagree about what an operation looks like.

import { readFileSync } from 'node:fs';

export const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** The retired brand still appears in the spec prose; collections are user-facing. */
export function rebrand(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/FoPost/g, 'FoPost').replace(/Fopost/g, 'FoPost');
}

export function loadSpec(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function makeResolver(spec) {
  const seen = new Set();
  return function resolve(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (schema.$ref) {
      if (seen.has(schema.$ref)) return { type: 'object', properties: {} };
      seen.add(schema.$ref);
      const parts = schema.$ref.replace(/^#\//, '').split('/');
      let node = spec;
      for (const part of parts) node = node?.[part];
      const out = resolve(node);
      seen.delete(schema.$ref);
      return out;
    }
    return schema;
  };
}

/** Path params that should read from a collection variable instead of a literal. */
const ID_BY_RESOURCE = {
  posts: 'postId',
  workspaces: 'workspaceId',
  labels: 'labelId',
  webhooks: 'webhookId',
  automations: 'automationId',
  accounts: 'accountId',
  media: 'mediaId',
};

export function pathVariable(paramName, path) {
  if (paramName !== 'id') return paramName;
  const resource = path.split('/')[2];
  return ID_BY_RESOURCE[resource] ?? 'id';
}

/** Body fields that are ids of things the collection already tracks. */
const BODY_VARIABLES = {
  workspace_id: 'workspaceId',
  workspaceId: 'workspaceId',
  account_id: 'accountId',
  accountId: 'accountId',
  post_id: 'postId',
  postId: 'postId',
  label_id: 'labelId',
  labelId: 'labelId',
};

/** Arrays of ids that should read from a collection variable. */
const ARRAY_VARIABLES = {
  accounts: 'accountId',
  accountIds: 'accountId',
  account_ids: 'accountId',
  labels: 'labelId',
  labelIds: 'labelId',
  source_ids: 'sourceId',
};

const firstType = (schema) =>
  Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;

function placeholderString(name, schema) {
  switch (schema.format) {
    case 'uuid':
      return '00000000-0000-0000-0000-000000000000';
    case 'date-time':
      return '2026-01-01T12:00:00.000Z';
    case 'date':
      return '2026-01-01';
    case 'uri':
    case 'url':
      return 'https://example.com';
    case 'email':
      return 'someone@example.com';
    default:
      break;
  }
  if (/color$/i.test(name)) return '#2563eb';
  if (/name$/i.test(name)) return `Example ${name.replace(/_?name$/i, '') || 'name'}`.trim();
  if (/(text|content|description|message)$/i.test(name)) return 'Hello from FoPost.';
  if (/timezone$/i.test(name)) return 'UTC';
  return schema.minLength ? 'x'.repeat(schema.minLength) : 'string';
}

/**
 * A sendable example value. Optional properties are deliberately left out of
 * object bodies: a request you can fire without editing beats one that documents
 * every field and returns 400.
 */
export function exampleValue(schema, resolve, name = '', depth = 0) {
  if (!schema) return null;
  const s = resolve(schema);
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined && firstType(s) !== 'object') return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.oneOf?.length) return exampleValue(s.oneOf[0], resolve, name, depth);
  if (s.anyOf?.length) return exampleValue(s.anyOf[0], resolve, name, depth);
  if (s.allOf?.length) {
    return s.allOf.reduce(
      (acc, part) => Object.assign(acc, exampleValue(part, resolve, name, depth)),
      {},
    );
  }

  const type = firstType(s);
  if (type === 'array') {
    if (depth > 4) return [];
    const item = exampleValue(s.items, resolve, name, depth + 1);
    return item === null && !s.minItems ? [] : [item];
  }
  if (type === 'object' || s.properties) {
    if (depth > 4) return {};
    const required = new Set(s.required ?? []);
    const props = Object.entries(s.properties ?? {});
    // Required fields when the schema names any; otherwise the scalar fields, so
    // an all-optional body is still a sendable example instead of `{}`.
    const chosen = required.size
      ? props.filter(([key]) => required.has(key))
      : props
          .filter(([, value]) => {
            const t = firstType(resolve(value));
            return t !== 'object' && t !== 'array' && !resolve(value).properties;
          })
          .slice(0, 6);
    // Schemas whose every field is a nested array or object would still be `{}`.
    const fields = chosen.length ? chosen : props.slice(0, 3);
    const body = {};
    for (const [key, value] of fields) {
      body[key] = exampleValue(value, resolve, key, depth + 1);
    }
    return body;
  }
  if (type === 'boolean') return s.default ?? false;
  if (type === 'integer' || type === 'number') {
    if (s.minimum !== undefined) return s.minimum;
    if (s.exclusiveMinimum !== undefined) return s.exclusiveMinimum + 1;
    return 1;
  }
  if (type === 'null') return null;

  const variable = BODY_VARIABLES[name];
  if (variable && s.format === 'uuid') return `{{${variable}}}`;
  return placeholderString(name, s);
}

/** Same as exampleValue but substitutes collection variables for known ids. */
export function exampleBody(schema, resolve) {
  const raw = exampleValue(schema, resolve);
  const walk = (node, key) => {
    if (Array.isArray(node)) {
      const variable = BODY_VARIABLES[key] ?? ARRAY_VARIABLES[key] ?? null;
      return node.map((item) =>
        typeof item === 'string' && /^[0-9a-f-]{36}$/i.test(item) && variable
          ? `{{${variable}}}`
          : walk(item, key),
      );
    }
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
    }
    if (typeof node === 'string' && BODY_VARIABLES[key] && /^[0-9a-f-]{36}$/i.test(node)) {
      return `{{${BODY_VARIABLES[key]}}}`;
    }
    return node;
  };
  return walk(raw, '');
}

/** Human-readable type for the optional-field list in a request's docs. */
export function describeType(schema, resolve) {
  const s = resolve(schema);
  if (Array.isArray(s.enum) && s.enum.length) return s.enum.map((v) => `\`${v}\``).join(' | ');
  const type = firstType(s);
  const nullable = Array.isArray(s.type) && s.type.includes('null');
  let label = type ?? 'any';
  if (type === 'array') label = `${describeType(s.items ?? {}, resolve)}[]`;
  if (s.format) label = `${label} (${s.format})`;
  return nullable ? `${label} | null` : label;
}

export function operations(spec) {
  const list = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      list.push({ path, method, op, tag: op.tags?.[0] ?? 'Other' });
    }
  }
  return list;
}

export function groupByTag(spec) {
  const order = (spec.tags ?? []).map((t) => t.name);
  const groups = new Map(order.map((name) => [name, []]));
  for (const entry of operations(spec)) {
    if (!groups.has(entry.tag)) groups.set(entry.tag, []);
    groups.get(entry.tag).push(entry);
  }
  for (const [name, list] of groups) if (!list.length) groups.delete(name);
  return groups;
}

export function tagDescription(spec, name) {
  return rebrand(spec.tags?.find((t) => t.name === name)?.description ?? '');
}

/**
 * Request documentation: the operation's own prose, its required scope, then the
 * optional fields left out of the example body so nothing is hidden.
 */
export function requestDocs(op, resolve) {
  const parts = [];
  if (op.description) parts.push(rebrand(op.description));
  const scope = op['x-fopost-scope'];
  if (scope) parts.push(`**Scope:** \`${scope}\``);

  const schema = op.requestBody?.content?.['application/json']?.schema;
  if (schema) {
    const s = resolve(schema);
    const required = new Set(s.required ?? []);
    const optional = Object.entries(s.properties ?? {}).filter(([key]) => !required.has(key));
    if (optional.length) {
      const rows = optional.map(([key, value]) => {
        const note = resolve(value).description ? ` — ${rebrand(resolve(value).description)}` : '';
        return `- \`${key}\`: ${describeType(value, resolve)}${note}`;
      });
      parts.push(`**Optional fields** (not in the example body):\n${rows.join('\n')}`);
    }
  }
  return parts.join('\n\n');
}

/** Ids worth capturing so folders chain without hand-copying uuids. */
export const CAPTURE = {
  createPost: 'postId',
  listPosts: 'postId',
  duplicatePost: 'postId',
  createWorkspace: 'workspaceId',
  listWorkspaces: 'workspaceId',
  createAccount: 'accountId',
  listAccounts: 'accountId',
  createLabel: 'labelId',
  listLabels: 'labelId',
  createWebhook: 'webhookId',
  listWebhooks: 'webhookId',
  createAutomation: 'automationId',
  listAutomations: 'automationId',
  uploadMedia: 'mediaId',
  listMedia: 'mediaId',
};

export function successCodes(op) {
  const codes = Object.keys(op.responses ?? {})
    .filter((code) => /^2\d\d$/.test(code))
    .map(Number);
  return codes.length ? codes : [200];
}
