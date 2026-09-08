<div align="center">

# ⬛ Femboy API

**A serverless, multi-provider AI API gateway.**\
One endpoint, one key, one bill - OpenAI, Anthropic, Gemini, and two dozen more behind it.

![Next.js](https://img.shields.io/badge/Next.js-15-000000?style=flat-square&logo=nextdotjs&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-0b1a12?style=flat-square&logo=mongodb&logoColor=4faa41)
![Redis](https://img.shields.io/badge/Upstash-Redis-1a0d0d?style=flat-square&logo=redis&logoColor=ff4438)
![Vercel](https://img.shields.io/badge/Vercel-Serverless-000000?style=flat-square&logo=vercel&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-1a1a1a?style=flat-square)

</div>

---

## What it is

Femboy API is an **API gateway for large language models**. You point your existing
SDK at it, use a key it issued, and it takes care of everything between your
application and the provider:

- **Protocol translation.** Call an Anthropic model through the OpenAI SDK, or a
  GPT model through the Gemini SDK. The gateway rewrites requests and responses -
  including streaming frames - between dialects.
- **Routing.** Many upstream accounts per model, elected by priority, weight and
  live health. A dead key is skipped, a flaky provider is retried elsewhere.
- **Metering.** Every request is priced from a per-model ratio table and settled
  against a durable, transactional quota ledger with idempotent settlement.
  Unknown abandoned work requires reconciliation; see the rollout notes.
- **Isolation.** Upstream provider keys are encrypted at rest. Response/error
  paths redact the credential used for that request, with regression coverage.

It runs entirely on serverless primitives: Next.js route handlers on Vercel,
MongoDB Atlas for durable state, shared rate limits, locks and queues.
**MongoDB-only deployment is supported; Redis is optional.** See
[MongoDB-only operations](docs/MONGODB-ONLY.md) for durability and scaling tradeoffs.

---

## Supported surface

| Dialect | Endpoints |
| --- | --- |
| **OpenAI** | `/v1/chat/completions` · `/v1/completions` · `/v1/responses` · `/v1/embeddings` · `/v1/images/*` · `/v1/audio/*` · `/v1/moderations` · `/v1/rerank` · `/v1/models` |
| **Anthropic** | `/v1/messages` · `/v1/messages/count_tokens` |
| **Gemini** | `/v1beta/models/{model}:generateContent` · `:streamGenerateContent` · `:countTokens` · `:embedContent` · `:batchEmbedContents` |
| **Async media** | JSON submissions: `/mj/submit/imagine`, `/blend`, `/describe`, `/v1/videos`; other platforms require explicit operator allowlisting. Gateway-owned task polling. |
| **Billing** | `/v1/dashboard/billing/subscription` · `/usage` |

Recognized relay credential forms include:
`Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, `?key=`, `mj-api-secret`,
and the realtime WebSocket subprotocol credential form. Realtime itself returns
501; multipart async submissions and arbitrary provider-account paths are not supported.

---

## Quick start

Use **Node.js 22.19+** (Node 22/24 are the CI targets) and npm.
**Existing deployment? Read [the mandatory quota migration](docs/QUOTA-MIGRATION.md) before upgrading.**

```bash
git clone https://github.com/overwrite249-art/femboy-api.git
cd femboy-api
npm ci --ignore-scripts
cp .env.example .env.local
```

Generate the secrets:

```bash
for v in KEY_PEPPER CHANNEL_KEY_MASTER SESSION_SECRET CRON_SECRET IP_HASH_SECRET ADMIN_BOOTSTRAP_TOKEN; do
  echo "$v=$(openssl rand -hex 32)"
done >> .env.local
```

Add your `MONGODB_URI` (Atlas or a transaction-capable replica set) and
`PUBLIC_BASE_URL`. Keep `COORDINATION_BACKEND=mongo` to run without Redis.
Next loads `.env.local`; standalone Node scripts
need `--env-file` or exported environment variables. Then:

```bash
node --env-file=.env.local --experimental-strip-types scripts/ensure-indexes.ts
# Supply ADMIN_PASSWORD privately through your shell/secret manager, not a command argument.
node --env-file=.env.local --experimental-strip-types scripts/create-admin.ts
npm run dev
```

The console is at `http://localhost:3000`, the API at `http://localhost:3000/v1`.

### Running with no services at all

In development/test only, use `COORDINATION_BACKEND=auto` and omit `MONGODB_URI`
and both Upstash variables to use
in-process twins. Nothing survives a restart, and state is not shared across
processes. **Production refuses this fallback.** The regular tests inject these twins:

```bash
npm test        # unit + security suites; no external services needed
npm run harness # standalone loopback mock provider, not an SSRF bypass
```

---

## Deploying

```bash
vercel --prod
```

Set all required storage and secret variables in the Vercel dashboard. Back up
and migrate existing balances before routing traffic to this release. Do not
run old and new accounting code concurrently.

**Finish scheduler setup after deployment.** Open `/setup` for instructions,
then sign in as root and open **Console → Setup**. You must get a
**cron-job.org API key** from [its console](https://console.cron-job.org) under
**Settings**. The app uses it once to configure the eight maintenance jobs and
does not retain the management key. Set a stable HTTPS `PUBLIC_BASE_URL` and a
strong `CRON_SECRET` first.

Native Vercel cron jobs are not installed, so this configuration works within
Vercel Hobby's daily-cron limitation without upgrading the plan. See
[scheduler setup and recovery](docs/SCHEDULER-SETUP.md) for schedules, access
requirements, timeout checks and secret rotation. Verify execution in the
external scheduler's history before accepting traffic.

> **Note.** The relay runs on the Node runtime rather than Edge. The MongoDB
> driver needs a TCP socket, which Edge does not provide. The hot path still
> checks current account/key authority in Mongo, and reserves/settles funds in
> Mongo transactions. Shared admission, caches and queues also use MongoDB in
> MongoDB-only mode; optional Upstash can move coordination to a separate service.

---

## Architecture

```
  client SDK
      │
      ▼
  ┌─────────────────────────────────────────────┐
  │ route handler          app/api/**/route.ts  │
  ├─────────────────────────────────────────────┤
  │ authenticate  →  quota reserve  →  limits   │
  │        │              │              │      │
  │        ▼              ▼              ▼      │
  │   token cache    Mongo ledger   token bucket│
  ├─────────────────────────────────────────────┤
  │ transform in  →  elect channel  →  relay    │
  │                       │             │       │
  │                  health + weight    ▼       │
  │                                 SSRF guard  │
  ├─────────────────────────────────────────────┤
  │ transform out  →  meter usage  →  settle    │
  └─────────────────────────────────────────────┘
      │                    │
      ▼                    ▼
   response          usage buffer → MongoDB
```

Full detail lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Security

The [2026-09-08 security review](docs/SECURITY-REVIEW-2026-09-08.md) records
reproduced failures, fixes, verification and remaining limits. Tests and scanners
reduce risk; they do not certify that every vulnerability has been found.

- Durable user/token balances and request journals commit together in MongoDB.
- Registration cannot assign paid quota, privileged roles or premium groups.
- Cached credentials do not preserve revoked privileges; logout revokes copied sessions.
- Atomic shared rate limits fail closed when the configured coordinator is unavailable.
- Validated DNS addresses are pinned to the actual socket; cross-origin redirects
  cannot forward provider credentials or request bodies.
- Async submissions are allowlisted and task references are owner-scoped.
- CI checks tests, types, the production build, billing vectors, secret patterns,
  dependency advisories, and static security rules.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Request lifecycle, module map, data model |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Current security controls and boundaries |
| [`docs/SECURITY-REVIEW-2026-09-08.md`](docs/SECURITY-REVIEW-2026-09-08.md) | Reproduced fixes, checks and residual risks |
| [`docs/QUOTA-MIGRATION.md`](docs/QUOTA-MIGRATION.md) | Required migration for existing deployments |
| [`docs/AUDIT.md`](docs/AUDIT.md) | Historical design-review notes, not a current attestation |
| [`docs/PARITY.md`](docs/PARITY.md) | Endpoint-by-endpoint conformance matrix |
| [`docs/PROVIDER-QUIRKS.md`](docs/PROVIDER-QUIRKS.md) | Per-provider deviations worth knowing |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Operational procedures and incident playbooks |
| [`docs/LOADTEST.md`](docs/LOADTEST.md) | k6 scenarios and expected numbers |
| [`docs/COST.md`](docs/COST.md) | What running this actually costs |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | What is deliberately not built yet |

---

## License

MIT. This is a clean-room implementation built from public provider
documentation; it contains no code derived from any AGPL-licensed gateway.
