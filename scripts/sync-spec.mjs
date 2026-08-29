#!/usr/bin/env node
// Pulls the current published spec. The API serves it publicly, so this repo
// never needs access to the private monorepo.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPEC_URL = process.env.FOPOST_SPEC_URL ?? 'https://api.fopost.com/v1/openapi.json';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const response = await fetch(SPEC_URL);
if (!response.ok) {
  console.error(`Failed to fetch ${SPEC_URL}: ${response.status} ${response.statusText}`);
  process.exit(1);
}

const spec = await response.json();
writeFileSync(join(root, 'openapi.json'), `${JSON.stringify(spec, null, 2)}\n`);
console.log(`openapi.json updated from ${SPEC_URL} (API version ${spec.info.version})`);
