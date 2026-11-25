# GenerateRecipe backend

Cloudflare Worker API for YouTube recipe previews and recipe generation from a
user-provided transcript. The Worker validates the source, calls OpenRouter for
recipe generation, validates the recipe, and accounts for AI usage in a
SQLite-backed Durable Object.

Automatic caption extraction, audio acquisition, STT, and Instagram support are
not implemented. Processing currently requires `fallback_transcript`; visual
frame processing and other deferred features are out of scope.

## Local development

Requirements: Node.js supported by the installed Wrangler version and npm.

```sh
npm ci
npm test -- --run
npx tsc --noEmit
npm run dev
```

Wrangler serves the Worker locally at `http://localhost:8787`. Local Durable
Object state is persisted by Wrangler under `.wrangler/`. The `wrangler.jsonc`
SQLite export and binding are used by both local development and deployment.
The health endpoint can be checked without provider credentials:

```sh
curl -i http://localhost:8787/api/v1/health
```

Recipe processing needs a model and pricing configuration. For local-only
secrets, create `.dev.vars` beside `wrangler.jsonc`; it is ignored by Git. Do not
commit it:

```dotenv
OPENROUTER_API_KEY="your-key"
AI_USAGE_ADMIN_TOKEN="a-long-random-admin-token"
OPENROUTER_RECIPE_MODEL="provider/model-id"
OPENROUTER_PRICING_MODEL="provider/model-id"
OPENROUTER_MAX_INPUT_COST_PER_MILLION_USD="<approved-model-input-price-per-million>"
OPENROUTER_MAX_OUTPUT_COST_PER_MILLION_USD="<approved-model-output-price-per-million>"
```

Replace the example model and price values with the approved model's current
OpenRouter model/endpoint prices. `OPENROUTER_PRICING_MODEL` must exactly match
`OPENROUTER_RECIPE_MODEL`; the Worker fails closed when pricing is absent or
mismatched. The maximum input/output prices are non-secret values and are
expressed in USD per million tokens. Do not send live processing requests until
the selected model and application budget have been reviewed.

| Name | Type | Requirement |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Secret | Required for recipe processing. |
| `AI_USAGE_ADMIN_TOKEN` | Secret | Required for the admin usage endpoints. |
| `OPENROUTER_RECIPE_MODEL` | Variable | Required; selected model identifier. |
| `OPENROUTER_PRICING_MODEL` | Variable | Required; exact match for the selected model. |
| `OPENROUTER_MAX_INPUT_COST_PER_MILLION_USD` | Variable | Required maximum input-token price. |
| `OPENROUTER_MAX_OUTPUT_COST_PER_MILLION_USD` | Variable | Required maximum output-token price. |
| `AI_BUDGET_LIMIT_USD` | Variable | Defaults to `20` in Wrangler; do not raise for this milestone. |
| `AI_BUDGET_RESERVE_USD` | Variable | Defaults to `5` in Wrangler; keep protected for the demo. |
| `YOUTUBE_API_KEY` | Secret | Optional; enables YouTube metadata lookup only. |

For deployed Workers, add `OPENROUTER_API_KEY` and `AI_USAGE_ADMIN_TOKEN` as
Worker secrets:

```sh
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put AI_USAGE_ADMIN_TOKEN
```

Configure the model and maximum endpoint prices as non-secret Worker variables.
An optional `YOUTUBE_API_KEY` only enables video metadata lookup; it is not a
transcript extractor.

## AI budget and usage ledger

`wrangler.jsonc` sets `AI_BUDGET_LIMIT_USD=20` and
`AI_BUDGET_RESERVE_USD=5`. Reservations are serialized transactionally by the
named Durable Object; normal processing may reserve at most $15 until the
protected reserve is deliberately changed. Each request reserves a conservative
maximum before the OpenRouter call. Actual reported costs are settled against
that reservation, and pending costs continue to count against the cap.

The ledger stores job and provider usage metadata, token/audio totals, cost
estimates, provider generation references, and a hash of each idempotency key.
It does not store transcripts, prompts, URLs, credentials, or raw provider
responses. The admin summary includes provider references, so keep its bearer
token private.

Send a stable, random `Idempotency-Key` (8–200 characters) when retrying the
same logical process request. The key is hashed and scoped to the process
endpoint. A duplicate returns `409 IDEMPOTENCY_KEY_REUSED`; responses are not
replayed, and reusing a key for different input is also rejected. Without the
header, each request receives a unique key and remains backward-compatible but
is not deduplicated.

### Admin usage and reconciliation

`GET /api/v1/admin/usage` requires
`Authorization: Bearer <AI_USAGE_ADMIN_TOKEN>` and returns aggregate and recent
provider usage. Use it only from a trusted operator environment.

When an operation remains `usage_pending`, use `processing.cost_summary.usage_operation_id`
from a successful response or `error.usage_operation_id` from a processing error.
Check the OpenRouter generation reference and provider records first. Reconcile
only with the provider-reported cost:

```http
POST /api/v1/admin/usage
Authorization: Bearer <AI_USAGE_ADMIN_TOKEN>
Content-Type: application/json

{
  "operation_id": "28542f09-a1d8-471a-ba04-74be6a27f207",
  "actual_cost_usd": 0.0012,
  "provider_status": "succeeded"
}
```

Use `actual_cost_usd: 0` only after confirming that the provider incurred no
charge. Reconciliation is atomic, allowed once per pending operation, and
records that an administrator settled it. This endpoint updates the ledger; it
does not call an AI provider.

An unstarted reservation expires after five minutes when the next reservation
or admin summary runs. Only jobs still in `reserved` state with no provider
operation are released; started or timed-out calls are never expired
automatically because they may have incurred a charge. If their provider cost
cannot be verified, leave them pending and keep the budget reserve held.
After an expired reservation, use a new idempotency key if the same logical
request is intentionally resubmitted.

## Cloudflare Durable Object lifecycle

`wrangler.jsonc` binds `AI_USAGE_LEDGER` to the `AIUsageLedger` class and
declares SQLite storage in the `exports` map. Current Wrangler uses this
declarative export to provision the class namespace on the first deploy; no
separate legacy `migrations` array is required. The constructor creates the
tables and applies the additive `terminal_status` column migration.

Before any authorized deployment:

1. Confirm the target Cloudflare account/environment and that the class name,
   binding, SQLite storage type, and `$20`/`$5` budget values are correct.
2. Configure secrets and non-secret model/pricing variables in that environment.
3. Review Wrangler's planned Durable Object class changes. Do not delete,
   rename, or transfer the exported class: deletion destroys its ledger data.
4. Deploy only with separate authorization. No production namespace has been
   provisioned as part of this review.

The singleton ledger serializes budget decisions and is intentionally a
consistency boundary. Durable Object storage and account quotas are separate
from OpenRouter credits and may have Cloudflare plan limits or charges.

## Known limitations before controlled live testing

- The $20 cap is enforced by this application ledger, not by OpenRouter itself;
  set an independent provider-side limit on the dedicated API key.
- A timeout or ambiguous 5xx may have incurred a provider charge. The Worker
  does not retry 5xx responses, and retains the reservation pending manual
  reconciliation. Only a rejected 429 is retried once.
- If a timed-out request returns no generation ID, correlate the operation
  using the provider dashboard, model, and timestamp. If the charge cannot be
  determined, do not reconcile it as zero.
- Jobs and usage records currently have no general retention/compaction policy.
  Monitor Durable Object storage before scaling request volume.
- OpenRouter recipe processing is mocked in tests. No credentialed integration
  test or paid call is performed by the test suite.
