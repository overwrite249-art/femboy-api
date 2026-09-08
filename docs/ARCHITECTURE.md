# Architecture

## The shape of a request

```
client
  |
  v
app/api/**/route.ts        thin: parse the path, hand off, return the Response
  |
  v
lib/relay/entry.ts         one entry point for every relay dialect
  |
  +--> lib/auth            who is this, and may they ask for this model
  +--> lib/ratelimit       may they ask right now
  +--> lib/quota           reserve an estimate atomically
  +--> lib/routing         which channel, which key
  +--> lib/transform       translate the request into the channel's dialect
  +--> lib/upstream        fetch it, with SSRF and stream guards
  +--> lib/transform       translate the response back
  +--> lib/usage           measure what was actually spent
  +--> lib/quota           settle the difference
  |
  v
client
```

The order matters and is not negotiable:

- **Authenticate before buffering.** The body limit is applied *during* the read,
  not after, so an unauthenticated caller cannot make the gateway hold a
  gigabyte in memory (GW-008).
- **Reserve before routing.** A request that cannot be paid for should not cost a
  provider call.
- **Settle after measuring.** The reservation is an estimate; the charge is
  reality. The difference is refunded or collected.

## Layers

| Directory | Responsibility | Depends on |
|---|---|---|
| `lib/config` | typed, lazily-read environment | nothing |
| `lib/util` | crypto, JSON limits, time | nothing |
| `lib/http` | header filtering, error envelopes, redaction | util |
| `lib/db` | Mongo access and an in-memory twin | config, util |
| `lib/redis` | Upstash REST, Lua scripts, JS twins | config, util |
| `lib/auth` | credential extraction, digests, identity | db, redis, http |
| `lib/quota` | reserve / settle / release | redis, db |
| `lib/ratelimit` | RPM, TPM, concurrency, success windows | redis |
| `lib/pricing` | ratios, group multipliers, tool surcharges | db, redis |
| `lib/routing` | abilities, election, health, key rotation | db, redis |
| `lib/upstream` | SSRF guard, timeouts, stream caps | config, http |
| `lib/transform` | dialect translation, SSE framing | util |
| `lib/usage` | measurement, buffering, rollups | db, redis, pricing |
| `lib/relay` | the pipeline that composes all of the above | everything |
| `lib/cron` | scheduled maintenance | db, redis, usage |
| `lib/admin` | control plane: sessions, store, catalog, audit | everything |

Nothing in `lib/**` imports `next/*`. The core can be exercised with Node's
native test runner without booting Next. The core uses Web APIs where practical,
plus MongoDB, Undici's pinned connection dispatcher, and Node async context for
the transactional memory twin. Redis uses the Upstash REST protocol directly.

The memory twins are for development and tests, not proof of production service
parity. CI also runs accounting tests against a disposable MongoDB replica set.

## Why the relay runs on Node, not Edge

The blueprint targets Edge for latency. This implementation runs the relay on
the Node runtime instead, because the MongoDB driver needs raw TCP, which the
Edge runtime does not provide. The alternatives were a data-proxy hop in front
of every query, or Postgres. Since MongoDB is the requirement, Node is the
consequence.

What is preserved: streaming is still a passthrough of `ReadableStream`, and
streaming responses stay incremental (non-stream JSON is bounded and buffered). What is lost: cold starts are a little slower
and the function is regional rather than at the edge.

`export const runtime = "nodejs"` is declared explicitly on every route rather
than relying on a default, so the choice is visible where it applies.

## Storage responsibilities

1. **MongoDB** is authoritative for users, tokens, channels, sealed provider keys,
   pricing, revocations, tasks, audit and accounting. Reservations, settlement,
   redemption and their balance updates use snapshot/majority transactions.
   Atlas or a replica set is required. Financial journals have no automatic TTL.
2. **Upstash Redis** coordinates shared rate limits, request-owned concurrency
   leases, caches, health, buffered analytics and queued settlement recovery.
   Eviction cannot restore money, but can reset limiter history or lose queued
   telemetry; use appropriate retention and monitoring.
3. **In-process twins** are permitted only outside production. Their transaction
   serialization and rollback are tested; they are not a distributed backend.

Authentication re-reads current key and user authority even on a digest-cache
hit. Routing rechecks current channel eligibility. Caches are not permission
stores. Session revocation is checked in durable storage on every cookie use.

## Accounting and buffered usage

An estimate is held before calling a provider. The final charge may exceed that
estimate and create debt; this is not a hard maximum-spend guarantee. Settlement
updates both balances, lifetime counters and the journal in one transaction.
The gateway generates request IDs itself, and an applied ID cannot fund new work.

Usage events are analytics, not a source from which money is reconstructed. A
flush peeks at Redis, commits immutable events and derived rollups together, then
acknowledges the prefix only while it owns the lock. Replays cannot increment a
committed event twice.

If Mongo is temporarily down at settlement, the measured outcome is queued in
Redis for idempotent replay. If both stores fail, or a process dies before the
outcome is persisted, the durable hold remains. The reconciliation job reports
abandoned holds for operator review rather than guessing a refund.

Existing balances require the explicit [v2 migration](QUOTA-MIGRATION.md).

## Control plane

`app/api/admin/[...path]` and `app/api/auth/[...path]` are catch-all routes that
delegate to `lib/admin/router.ts` and `lib/admin/login.ts`. The dispatcher is a
hand-written switch, not a routing library: the entire control plane is
reviewable in one file, and there is nothing between a request and the authority
it is asking for.

The console under `app/console/**` is a client-rendered React app that talks to
that same JSON API with a session cookie. It has no privileged server component
and no server actions, so there is exactly one authorization path to audit.
