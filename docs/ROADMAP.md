# Roadmap

What is deliberately not built, in the order it should be built. Everything here
is a real gap, not a hypothetical improvement, and each item says why it was
left out rather than pretending it was an oversight.

## Near term

### Realtime (WebSocket) relay

`/v1/realtime` is answered with 501 and an explanation rather than a broken
implementation. A WebSocket relay needs a long-lived bidirectional connection,
which a serverless function cannot hold. Doing it properly means a separate
always-on process, which is a different deployment shape and a different cost
model. Half-implementing it would be worse than the honest refusal.

**What it would take:** a small Node service with the same authenticator and
quota ledger, sharing Mongo and Redis, with the gateway issuing a short-lived
ticket that the socket service redeems. The credential must never be in the
subprotocol header the browser can read.

### Tiered pricing

`ModelPricingDoc.tiers` exists in the schema and is not yet consumed. Long-context
models charge more above a token threshold, and until the tier is applied those
requests are billed at the base rate -- which loses money rather than
overcharging, so it fails safe.

**What it would take:** selecting the tier by prompt token count inside
`computeQuota`, and a test vector per tier boundary. The boundary is the whole
risk: off-by-one at the threshold silently misprices every long request.

### Forced degradation tests

GW-015 (fail closed when the ledger is unavailable) is implemented and reviewed
but not proven, because forcing `isDegraded()` true at the exact moment a
reservation is attempted needs a Redis stub that throws on demand. Until that
exists, the claim rests on code review, which is why the security document lists
it as implemented rather than proven.

## Medium term

### Aggregation-backed usage reporting

Usage rollups are maintained incrementally on write, because the storage
abstraction deliberately has no `aggregate`. That keeps the in-memory twin
honest and the query path predictable, but it means a new report shape needs new
rollup keys rather than a new query. A read-only aggregation path for the console
would remove that constraint without weakening the write path.

### Per-channel cost tracking

Quota measures what the customer was charged. It does not measure what the
provider charged us, so channel-level margin is invisible. This needs a second
price table keyed by channel rather than by model, and it is the single most
valuable business feature not present.

### Prompt caching hints

Anthropic and Gemini both bill cache writes at a premium and cache reads at a
discount. The gateway prices all three correctly but does not help clients use
them -- it does not insert cache control markers. Doing that means editing the
request body, which the relay currently avoids on principle.

## Long term, and possibly never

### Multi-region

One Mongo cluster and one Redis instance mean one region is authoritative.
Quota is the obstacle: a globally distributed ledger either accepts overspend at
the edges or accepts a round trip to a single region, and the round trip is the
honest choice. Read-heavy paths could be regional; the ledger should not be.

### Provider SDK compatibility beyond the wire format

The gateway is wire-compatible with four dialects. It is not compatible with
every client library's assumptions about undocumented behaviour -- retry-after
semantics, specific error body shapes, streaming keepalive intervals. Chasing
that is unbounded work, and `PARITY.md` states the boundary instead.

### An admin UI for everything

The console covers the daily operations. It does not cover index management,
bucket rotation, or ledger repair, and those live in scripts on purpose: they are
rare, dangerous, and better with a terminal and a runbook than with a button.
