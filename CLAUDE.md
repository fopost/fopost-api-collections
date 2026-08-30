# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What This Is

The **published contract of the FoPost API**: `openapi.json` (OpenAPI 3.1, 54 paths / 70
operations across 11 groups) plus ready-to-run client collections generated from it — a Postman
v2.1 collection with two environments, and a Bruno collection as one plain-text file per request.
`ENDPOINTS.md` is the browsable index. No dependencies, no build step, Node >= 20, `private: true`
(nothing here is published to a registry). MIT.

## This Repo Is The Source Of Truth Every SDK Tracks

`openapi.json` here is the contract the whole client ecosystem is written against:
`fopost-php`, `fopost-js`, `fopost-python`, `fopost-go`, `fopost-ruby`, `fopost-java`,
`fopost-dotnet`, `fopost-rust`, `fopost-swift`, `fopost-kotlin`, `fopost-dart`, plus the
non-SDK clients `fopost-mcp`, `fopost-extension`, and the automation integrations. They are
separate git repos, checked out as siblings at `../fopost-<name>`. None of them depends on this
repo as a package — they read it.

Which means: **a change that lands here is a change every client has already been told to expect,
or a change nobody warned them about.** When you notice this repo's spec gain, lose, or reshape an
operation, say so explicitly and name the clients that wrap it. Do not "fix" a client to match a
spec drift without checking which side actually moved.

## Which Copy Is Authoritative

There are two copies of `openapi.json` and they are byte-identical today. They are not peers.

| Copy | Role |
| :--- | :--- |
| `fopost/apps/api/openapi.json` (the monorepo) | **Authoritative.** Generated from the API's own Zod request schemas plus a hand-maintained route manifest in `apps/api/scripts/generate-openapi.ts`. Committed, and CI runs `openapi:check` so a handler change with no spec update fails |
| `fopost-api-collections/openapi.json` (here) | A **published mirror**, pulled from the live API. Not edited by hand, ever |

The path a change travels:

1. A handler changes in the monorepo, and `apps/api/scripts/generate-openapi.ts` is updated in the
   same commit (response shapes there are hand-written from the handlers, so the generator is a
   route manifest, not an introspection).
2. `pnpm --filter @fopost/api openapi:generate` rewrites `apps/api/openapi.json`;
   `openapi:check` regenerates and fails on any diff.
3. The API serves that committed file publicly at `GET https://api.fopost.com/v1/openapi.json`
   (`apps/api/src/handlers/openapi.ts` reads it off disk and caches it for an hour).
4. **`npm run sync` here fetches that URL** and overwrites the local `openapi.json`. It never
   reads the monorepo, which is why this public repo needs no access to the private one.
5. `npm run generate` rewrites `postman/`, `bruno/`, and `ENDPOINTS.md` from the local spec.

The consequence worth remembering: `npm run sync` tracks the **deployed** API, not the monorepo
working tree. Between a merge and a deploy the two copies legitimately differ, and the copy here
is the older one. `FOPOST_SPEC_URL` overrides the fetch target when a staging spec is wanted.

**Never hand-edit `openapi.json` in this repo.** A spec fix belongs in the monorepo generator; this
copy is replaced wholesale by `sync`.

## Brand Rules

- The product is **FoPost** (`fopost.com`). Never write "OwlStack" — retired Aug 2026.
  `rebrand()` in `scripts/lib/spec.mjs` exists to scrub the retired name out of spec prose on the
  way into user-facing collection text; leave it in place.
- Never write an email address. Support is https://fopost.com/contact and GitHub issues. The
  spec's `info.contact` is a name plus that URL, with no address — keep it that way.
- Never name AI providers/models, infrastructure vendors, hosting, or any person. Everything in
  this repo is a public surface, including request descriptions and example bodies.
- Example bodies use fictional content and `yourbrand.com`-style domains, never a real account.

## Architecture

```
openapi.json                    the mirrored spec — generated upstream, synced, never edited
scripts/sync-spec.mjs           fetch the live spec (FOPOST_SPEC_URL overrides the default)
scripts/generate.mjs            orchestrator: both emitters, ENDPOINTS.md, the shadowing guard,
                                and --check for CI staleness
scripts/lib/spec.mjs            shared reading: $ref resolution, example bodies, path/body
                                variable naming, groupByTag, CAPTURE, rebrand
scripts/generate-postman.mjs    Postman v2.1 collection + two environments
scripts/generate-bruno.mjs      bruno/ (rm -rf'd and rebuilt), bruno.json, collection.bru,
                                environments/, one .bru per request
postman/  bruno/  ENDPOINTS.md  100% generated output, committed
```

Both emitters build on `scripts/lib/spec.mjs`, so Postman and Bruno can never disagree about what
an operation looks like. **Adding another client is a new emitter, not a new repo.**

**Request chaining.** `CAPTURE` in `spec.mjs` maps an operation to the id it writes back
(`workspaceId`, `accountId`, `postId`, `labelId`, `webhookId`, `automationId`, `mediaId`), so a
folder runs in order without pasting uuids. Those ids are **runtime state**: Postman keeps them as
collection variables, Bruno as runtime variables. `baseUrl` and `apiKey` are the only two an
environment carries, and `generate.mjs` **throws** if an environment ever declares a captured name
— in Postman an environment value resolves first and would shadow the captured id with an empty
string, silently breaking every chained request.

**Auth** is set once on the collection and inherited: `X-API-Key`. Each request's docs name the
scope it needs (`x-fopost-scope` in the spec): `posts` (covers publishing, deliveries, media),
`workspaces`, `accounts`, `labels`, `webhooks`, `analytics`, `automations`. Bodies carry the
**required** fields with realistic values so a request sends unedited; optional fields are
documented, not pre-filled.

## Commands

```bash
npm run sync       # pull the current spec from the public API into openapi.json
npm run generate   # rewrite postman/, bruno/, and ENDPOINTS.md
npm run check      # fail if the committed output is stale (what CI runs)
```

No install step, no dependencies, no linter, no formatter, no test runner.

## Conventions

- **Everything under `postman/` and `bruno/` and all of `ENDPOINTS.md` is generated.** A fix
  belongs in `scripts/`; run `npm run generate` and commit the regenerated output in the same
  commit as the script change. A commit that touches generated output alone is a red flag.
- Plain ESM `.mjs`, Node built-ins only. Do not add a dependency to this repo.
- Generated JSON is `JSON.stringify(…, null, 2)` with a trailing newline, and `.bru` output is
  byte-stable text. Keeping both deterministic is what makes `--check` meaningful.
- New emitters read the spec through `scripts/lib/spec.mjs` and never parse `openapi.json`
  themselves.
- When a guard exists (the shadowing check), it exists because the failure is silent. Add to it
  rather than commenting.

## Testing

There is no test runner. `npm run check` **is** the test: it snapshots every generated file,
regenerates, and fails listing exactly which files drifted or disappeared.

`.github/workflows/check.yml`:

- **`generated-output-is-current`** — `npm run check` on every push to `main`, every PR, and the
  weekly cron.
- **`spec-is-current`** — the weekly Monday 06:00 cron and `workflow_dispatch` only, deliberately
  not on PRs so an API change never reddens someone's unrelated PR. It runs `npm run sync` and
  fails when `openapi.json` differs from the live API, which is the alarm for "the API shipped an
  endpoint and the collections did not follow".

The fix for that alarm is always the same pair: `npm run sync && npm run generate`, then commit.

## Releasing

**Nothing is published.** `private: true`, no registry, and there is no `release.yml` — the only
workflow is `check.yml`, which needs no secrets. The repo *is* the artifact: consumers import the
files from GitHub, or fetch the live spec at
`https://api.fopost.com/v1/openapi.json`. Merging to `main` is the release.

If a versioned artifact is ever wanted, tag it; the version that matters is `info.version` inside
the spec, which comes from the API, not from `package.json`.

## Git

Conventional Commits, atomic. Branch `feature/<description>`, merge to `main` via PR.
Never `gh pr create` — push the branch and hand over the compare link.
