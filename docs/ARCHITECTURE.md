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

Nothing in `lib/**` imports from `app/**`, and nothing in `lib/**` imports
`next/*`. That is what makes the whole thing testable with `bun test` and no
framework harness -- 250 tests run in under five seconds because there is no
server to boot.

## Zero runtime dependencies in the core

Every module in `lib/**` uses only Web-standard APIs: `Request`, `Response`,
`fetch`, `crypto.subtle`, `ReadableStream`, `TextEncoder`. The two real
dependencies (`mongodb`, `@upstash/redis`) are imported *dynamically, inside
functions*, so that:

- a unit test can run without either service configured, and
- an unconfigured service degrades to an in-memory twin rather than a crash.

The twins are not toys. `MemoryDatabase` implements the same `Collection`
interface including `findOneAndUpdate` as a compare-and-swap and unique index
enforcement, and `MemoryRedis` runs behaviour-identical JavaScript versions of
every Lua script, serialised through a promise chain so that atomicity is
preserved and not merely simulated.

## Why the relay runs on Node, not Edge

The blueprint targets Edge for latency. This implementation runs the relay on
the Node runtime instead, because the MongoDB driver needs raw TCP, which the
Edge runtime does not provide. The alternatives were a data-proxy hop in front
of every query, or Postgres. Since MongoDB is the requirement, Node is the
consequence.

What is preserved: streaming is still a passthrough of `ReadableStream`, and
nothing buffers a whole response. What is lost: cold starts are a little slower
and the function is regional rather than at the edge.

`export const runtime = "nodejs"` is declared explicitly on every route rather
than relying on a default, so the choice is visible where it applies.

## Three-tier storage

1. **Upstash Redis over REST** -- hot path. Token identity cache, quota ledger,
   rate-limit counters, channel health, ability cache. Every read-modify-write is
   a Lua script, so it is atomic across concurrent invocations.
2. **MongoDB** -- authoritative. Users, tokens, channels, sealed channel keys,
   pricing, usage logs (partitioned monthly as `usage_logs_YYYYMM`), rollups,
   audit, settings.
3. **In-process twins** -- used when neither is configured. Makes the test suite
   dependency-free and local development possible with no services running.

Redis is a cache, never an authority. The elected channel is always re-read from
Mongo and re-checked with `serves()` before its key is used, because a
denormalised ability row is a performance structure and not a permission
(finding: caches are never authorization).

## Usage writes are buffered

Billing one document per request would make Mongo the bottleneck at the exact
moment traffic is highest. Instead each request appends to a Redis list and a
cron job drains it in batches, keyed on the request id so a replayed drain
cannot bill twice. The ledger in Redis is decremented synchronously, so a user's
balance is always current even when the Mongo write is seconds behind.

## Control plane

`app/api/admin/[...path]` and `app/api/auth/[...path]` are catch-all routes that
delegate to `lib/admin/router.ts` and `lib/admin/login.ts`. The dispatcher is a
hand-written switch, not a routing library: the entire control plane is
reviewable in one file, and there is nothing between a request and the authority
it is asking for.

The console under `app/console/**` is a client-rendered React app that talks to
that same JSON API with a session cookie. It has no privileged server component
and no server actions, so there is exactly one authorization path to audit.
