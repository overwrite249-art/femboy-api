# MongoDB-only operation

The gateway can run on Vercel with a transaction-capable MongoDB Atlas database,
server secrets, and an external scheduler. A separate Redis account is not required.

## Configuration

- Set `MONGODB_URI` and `MONGODB_DB`.
- Set `COORDINATION_BACKEND=mongo`.
- Set `KEY_PEPPER`, `CHANNEL_KEY_MASTER`, `SESSION_SECRET`, `CRON_SECRET` and
  `IP_HASH_SECRET` to independent cryptographically random secrets.
- Set `PUBLIC_BASE_URL` to the stable HTTPS production origin.
- Complete [cron-job.org setup](SCHEDULER-SETUP.md).

The optional Upstash fields may be left empty. `auto` selects Upstash if either
Upstash field is supplied (both are then required), otherwise MongoDB when
configured. Explicit `mongo` ignores the Upstash fields. There is no production
fallback to an in-process store.

## What is stored

Money, identities, sessions and application records remain in their existing
MongoDB collections. Two additional collections provide coordination:

- `coordination_keys`: small scalar/hash/sorted-set state, TTL deadlines,
  limiter buckets, owner tokens and queue metadata.
- `coordination_items`: one document per queue item, with indexed queue
  generation and position. Queues are not unbounded arrays in a single document.

Every named limiter program and queue acknowledgement executes in a Mongo
transaction with majority write concern. Independent serverless instances share
the same state. The deterministic value interpreter is request-local computation,
not a cache or an alternative store; its output is committed before success.
Expired state is refused immediately without waiting for Mongo's TTL monitor.

The adapter supports the bounded command subset used by this gateway, not an
arbitrary Redis endpoint. Small values are limited to 1 MiB, list reads/pops to
1,000 items per batch. Unknown commands and arbitrary Lua are refused.

## Tradeoffs and outages

Mongo-only operation is simpler to provision but adds database transactions and
round trips to rate limiting, routing and queue operations. High-contention queues
or large request volumes can increase latency and Atlas load; monitor those before
scaling traffic. Optional Upstash remains available for an independent coordinator.

A Mongo outage fails shared limits closed. It may also prevent final settlement
and writing its recovery queue because both use the same database. The app does
not claim that an unpersisted measurement was safely queued. Existing quota holds
remain in the durable ledger, and reconciliation reports unresolved holds for
operator review. Unknown provider costs are never automatically refunded.

Do not delete coordination collections to reset balances or bypass a limit.
Balances live in the transaction ledger, not these coordination records.

## Switching an existing live deployment

Fresh databases require no Redis migration. For an existing deployment:

1. Stop incoming traffic and old cron writers.
2. Drain usage and settlement queues using the old backend.
3. Preserve any remaining recovery records and resolve pending holds.
4. Change the backend and redeploy all instances together. Do not run mixed
   backends: they would have independent limits, locks and queues.
5. Re-enable the external scheduler, check histories and verify before reopening.

No user data needs to be deleted for a fresh MongoDB-only deployment.

## Verification

`npm test` covers sharing across coordinator instances, atomic fixed/token
buckets, concurrency slots, TTL behavior, queue ownership, rollback and outage
failure. `npm run test:integration` uses a **disposable loopback-only replica set**
to verify actual Mongo transaction races and persistence. These tests never use
a production Atlas database.