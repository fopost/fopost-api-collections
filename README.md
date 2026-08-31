# FoPost API Collections

Ready-to-run API client collections for the [FoPost](https://fopost.com) API, generated from its
OpenAPI specification. Import one, paste an API key, and every endpoint is a request you can send.

Covers **70 operations across 11 groups**: posts, publishing, workspaces, accounts, communities,
labels, webhooks, analytics, automations, and media. The full list is in [ENDPOINTS.md](ENDPOINTS.md).

| Client | What to import | |
| --- | --- | --- |
| **Postman** | `postman/fopost-api.postman_collection.json` | plus an environment from the same folder |
| **Bruno** | the `bruno/` folder | open it as a collection |
| **Hoppscotch, Insomnia, Thunder Client, and anything else** | `openapi.json` | import the spec directly |

## Postman

1. **Import** → drop in `postman/fopost-api.postman_collection.json` and
   `postman/fopost-production.postman_environment.json`.
2. Select the **FoPost Production** environment.
3. Set `apiKey` to a key from **Settings → API Keys** in the FoPost dashboard
   (<https://fopost.com/dashboard/settings/api-keys>).
4. Send **Workspaces → List workspaces**. The collection stores the first workspace id in
   `workspaceId`, so the rest of the requests are ready to go.

Authentication is set once on the collection and inherited by every request, so there is no header to
add by hand.

## Bruno

Bruno is open source and stores requests as plain text, one file per request.

1. Install Bruno, then **Open Collection** and pick the `bruno/` folder.
2. Choose the **Production** environment and set `apiKey` (it is declared as a secret, so it stays out
   of the repo).
3. Send any request. Captured ids are written to runtime variables, so running the collection never
   modifies a tracked file.

## Other clients

Every other client imports `openapi.json` directly. Point it at the file in this repo, or at the live
spec, which the API serves publicly:

```
https://api.fopost.com/v1/openapi.json
```

That spec is also all you need for a generated SDK, a mock server, or `curl`.

## Chaining requests

Ids are captured from responses and written back automatically, so folders work in order without
copying uuids by hand:

| Variable | Set by |
| --- | --- |
| `workspaceId` | List or create a workspace |
| `accountId` | List or create an account |
| `postId` | List, create, or duplicate a post |
| `labelId` | List or create a label |
| `webhookId` | List or create a webhook |
| `automationId` | List or create an automation |
| `mediaId` | List media or upload a file |

`baseUrl` and `apiKey` are the only two you set yourself, and they are the only two an environment
carries. The ids are runtime state, not environment config: Postman keeps them as collection
variables and Bruno as runtime variables, in both cases written by the request that returned them.
An environment entry of the same name would resolve first and shadow the captured value with an
empty string, so `npm run generate` refuses to emit one.

Any request can ignore the variable entirely: type a literal id into the URL or body and only that
request changes. `communityId`, `runId`, and `batchId` are filled in from whichever record you are
working with.

## Authentication and scopes

Requests send `X-API-Key`. A key carries only the scopes granted when it was created, and every
request is confined to the workspaces that key can reach.

Each request's documentation names the scope it needs: `posts` (which also covers publishing,
deliveries, and media), `workspaces`, `accounts`, `labels`, `webhooks`, `analytics`, `automations`.
A key may also be bound to a single workspace, in which case naming any other workspace returns
`403`.

Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`; the
collections log a warning when a key is close to its ceiling. Mutating endpoints require an active
subscription and return `403 subscription_required` without one.

## Example bodies

Request bodies contain the **required** fields with realistic values, so a request sends without
editing. Optional fields are listed in each request's documentation tab with their types and enum
values, rather than being pre-filled with defaults you would have to delete.

## Regenerating

The collections are generated, never hand-edited. There are no dependencies and no build step.

```bash
npm run sync       # pull the current spec from the public API
npm run generate   # rewrite postman/, bruno/, and ENDPOINTS.md
npm run check      # fail if the committed output is stale
```

`scripts/lib/spec.mjs` holds the shared reading of the spec, and the two emitters build on it, so
Postman and Bruno can never drift apart. Adding another client is a new emitter, not a new repo.

## Contributing

Issues and pull requests are welcome. Because everything under `postman/` and `bruno/` is generated,
fixes belong in `scripts/`; run `npm run generate` and commit the result alongside the change.

## License

MIT. See [LICENSE](LICENSE).
