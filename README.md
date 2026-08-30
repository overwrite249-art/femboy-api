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
  against a quota ledger that is exactly-once, even when a stream is aborted.
- **Isolation.** Your upstream provider keys are encrypted at rest and never
  appear in a response, a log line or an error message.

It runs entirely on serverless primitives: Next.js route handlers on Vercel,
MongoDB Atlas for durable state, Upstash Redis for the hot path.

---

## Supported surface

| Dialect | Endpoints |
| --- | --- |
| **OpenAI** | `/v1/chat/completions` · `/v1/completions` · `/v1/responses` · `/v1/embeddings` · `/v1/images/*` · `/v1/audio/*` · `/v1/moderations` · `/v1/rerank` · `/v1/models` · `/v1/realtime` |
| **Anthropic** | `/v1/messages` · `/v1/messages/count_tokens` |
| **Gemini** | `/v1beta/models/{model}:generateContent` · `:streamGenerateContent` · `:countTokens` · `:embedContent` · `:batchEmbedContents` |
| **Async media** | `/mj/submit/*` · `/mj/task/{id}/fetch` · Suno · Kling · Jimeng · Vidu · Dify · `/v1/videos` |
| **Billing** | `/v1/dashboard/billing/subscription` · `/usage` |

Authentication is accepted in every form the corresponding SDK sends it:
`Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, `?key=`, `mj-api-secret`,
and the WebSocket subprotocol form used by the realtime API.

---

## Quick start

```bash
git clone https://github.com/overwrite249-art/femboy-api.git
cd femboy-api
npm install
cp .env.example .env.local
```

Generate the secrets:

```bash
for v in KEY_PEPPER CHANNEL_KEY_MASTER SESSION_SECRET CRON_SECRET IP_HASH_SECRET ADMIN_BOOTSTRAP_TOKEN; do
  echo "$v=$(openssl rand -hex 32)"
done >> .env.local
```

Add your `MONGODB_URI` (Atlas free tier is enough) and the two Upstash values,
then:

```bash
npm run db:indexes     # create every index, including the TTL and unique ones
npm run bootstrap:admin
npm run dev
```

The console is at `http://localhost:3000`, the API at `http://localhost:3000/v1`.

### Running with no services at all

Omit `MONGODB_URI` and the Upstash variables and the gateway starts anyway,
backed by an in-process store and an in-process Redis twin. Every feature works;
nothing survives a restart. This is what the test suite and the offline harness
use:

```bash
npm test        # unit + security suites, zero dependencies required
npm run harness # a real HTTP server with a mock upstream
```

---

## Deploying

```bash
vercel --prod
```

Set the same variables in the Vercel dashboard. `vercel.json` already declares
the eight cron jobs the gateway needs (health checks, usage flushing, task
polling, quota reconciliation, rollups, pricing refresh, token expiry and
partition maintenance).

> **Note.** The relay runs on the Node runtime rather than Edge. The MongoDB
> driver needs a TCP socket, which Edge does not provide. The hot path still
> only touches Redis over HTTP; Mongo is consulted on a cache miss.

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
  │   token cache    Lua ledger     token bucket│
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

This implementation was written against a threat model of thirty findings
(`GW-001` … `GW-030`) covering quota races, SSRF, credential leakage, response
splitting, prompt-injection across provider boundaries, billing manipulation and
fail-open limiters. Each one is documented with its exploit, its fix and the
test that proves the fix in [`docs/SECURITY.md`](docs/SECURITY.md) and
[`docs/AUDIT.md`](docs/AUDIT.md).

Highlights:

- Quota debits are a single atomic Lua script - concurrent requests cannot both
  pass a balance check.
- Settlement is keyed by request id and journalled, so an aborted stream is
  refunded exactly once.
- Upstream keys are sealed with AES-256-GCM under a versioned master key and are
  scrubbed from every outbound string by a redactor with ReDoS-safe patterns.
- The client address is taken from the *right* of `X-Forwarded-For`, so a
  spoofed prefix cannot evade per-IP limits.
- Outbound URLs are resolved and checked against private, link-local, loopback
  and metadata ranges before a connection is made.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Request lifecycle, module map, data model |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model and control catalogue |
| [`docs/AUDIT.md`](docs/AUDIT.md) | GW-001…GW-030 with exploit and proof |
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
