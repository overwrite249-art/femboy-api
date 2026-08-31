# Runbook

Written for whoever is on call, including future you at 3am. Each entry says
what to check first, what to do, and what *not* to do.

## 0. Orientation

| Question | Where to look |
|---|---|
| Is anything serving? | `GET /api/cron/health-check` with the cron secret, or the console overview |
| Is one provider down? | Console -> Channels -> Test all |
| Is a user complaining about money? | Console -> Usage, then Audit |
| Did someone change something? | Console -> Audit log |
| Is Redis or Mongo the problem? | Health check reports each dependency separately |

Every error response carries an `x-request-id`. Ask for it first; it is the join
key between the client's complaint and the usage row.

## 1. All requests return 503 no_channel_available

**Check:** Console -> Channels. Look for `auto-disabled`.

A channel auto-disables after repeated failures. That is the breaker working, not
the bug. The bug is upstream.

1. Test all channels. Read the report per channel rather than in aggregate.
2. If the provider is genuinely down, nothing to do but wait; if you have a
   second channel for the same model, raise its priority so it takes over.
3. Re-enable a channel only after its probe passes. Re-enabling a dead channel
   makes every request pay a timeout before failing.

**Do not** raise `CHANNEL_FAILURE_THRESHOLD` to make the alert stop. That trades
a clear failure for a slow one.

## 2. A user says they were charged for a failed request

They may be right, and the design admits one case: a stream that dies after the
first token is billed for what it produced.

1. Find the usage row by request id. Check `httpStatus` and `completionTokens`.
2. If `completionTokens` is 0 and quota was charged, that is a real bug --
   capture the request id and the row, then refund with a redemption code.
3. If tokens were produced, the charge is correct. Explain that the provider
   billed for the tokens it generated.

Reservations are released automatically. A reservation that leaked expires after
`RESERVATION_TTL_SEC` (15 minutes), and `reconcileQuota` re-derives the balance
from the journal. Run it manually if a balance looks wrong:

```
curl -H "authorization: Bearer $CRON_SECRET" https://your-app/api/cron/reconcile-quota
```

## 3. Redis is unavailable

Symptoms: latency up, rate limits behaving oddly, `degradationReason` set.

The gateway does **not** fail open on quota. If the ledger cannot be read, the
request is refused. That is deliberate: serving free traffic is worse than
serving none.

1. Confirm with the health check which dependency is down.
2. If Upstash is degraded, the fastest safe action is to unset
   `UPSTASH_REDIS_REST_URL` so the process falls back to its in-memory twin.
   Accept that rate limits become per-instance and quota becomes per-instance:
   **only do this if the alternative is total outage**, and reverse it as soon as
   Redis returns.
3. After recovery, run `reconcile-quota`. In-memory balances are not
   authoritative.

## 4. Mongo is unavailable

Authentication itself survives briefly, because token identity is cached in
Redis with a short TTL. Once the cache expires, everything fails closed.

1. Do not restart to "clear it". A restart empties the in-process caches and
   makes the outage total and immediate.
2. Usage rows buffer in Redis and drain when Mongo returns. Data is not lost
   unless Redis is also lost.
3. Check the Atlas connection limit before assuming the cluster is down. A
   serverless deployment with a high `MONGO_MAX_POOL_SIZE` and many concurrent
   instances can exhaust connections on its own.

## 5. A provider key leaked

1. Revoke it at the provider first. Everything else is secondary.
2. Console -> Channels -> Keys, and replace the full key set for that channel.
   Keys are sealed, so they cannot be edited individually.
3. Check the audit log for who added it and when.
4. The key never appears in logs, error bodies, or audit metadata. If you find it
   in any of those, that is a P0 finding: file it against `lib/http/redact.ts`.

## 6. A relay API key leaked

1. Console -> Tokens -> Rotate. Rotation invalidates the old digest immediately
   and returns the new key once.
2. The identity cache is invalidated on rotation, so the old key stops working
   within seconds rather than at TTL.
3. If the key was used, the usage rows will show it: filter by token.

## 7. Rotating CHANNEL_KEY_MASTER

Sealed keys carry a `keyVersion`. Rotation is therefore possible without
downtime, but it is not automatic:

1. Set `CHANNEL_KEY_MASTER` to the new value and `CHANNEL_KEY_VERSION` to the
   next integer. Keep the old master available under
   `CHANNEL_KEY_MASTER_PREVIOUS` if you have implemented the optional fallback.
2. Re-enter the keys for each channel through the console. This re-seals them at
   the new version.
3. Verify with the channel test before removing the old master.

**Do not** rotate the master without re-sealing. The ciphertext becomes
undecryptable and every channel fails with a configuration error.

## 8. Cron jobs are not running

Symptoms: usage rows lag, tokens past their expiry still work, monthly partition
missing on the first of the month.

1. Check `vercel.json` still lists the schedules.
2. Confirm `CRON_SECRET` is set in the environment. If it is unset the endpoints
   return 503 by design, rather than running unauthenticated.
3. Trigger the job by hand with the secret in the `authorization` header. The
   `x-vercel-cron` header alone is never trusted.

## 9. Bootstrapping a fresh deployment

```
bun scripts/ensure-indexes.ts      # creates every index, idempotent
bun scripts/create-admin.ts        # first root account, prompts for a password
bun scripts/seed.ts                # optional: demo channel, pricing, group ratio
```

Then sign in at `/login`, add a channel with a real provider key, and send one
request. Confirm the usage row appears before announcing the deployment.

## 10. Restoring after a lost working copy

The repository is the artifact. Everything needed to rebuild is committed:

```
git clone https://github.com/overwrite249-art/femboy-api
cd femboy-api && bun install && bun test
```

The test suite needs no services: 250 tests run against in-memory twins. If they
pass, the checkout is intact.

## 11. Rolling back

Vercel keeps previous deployments; promote the last known good one. Two caveats:

- **Index changes are forward-only.** A rollback does not drop indexes, which is
  fine, because indexes are additive.
- **Pricing edits are data, not code.** Rolling back the deployment does not
  restore a previous price. Check the audit log and re-enter it.

## 12. What to escalate immediately

- A provider key or relay key appearing in any response body, log line, or audit
  row.
- A balance that goes negative by more than one pre-consumed unit.
- Any successful admin action by an identity whose role is `user` in the audit
  log.
- Message content appearing in a usage row. There is no field that can hold it,
  so its presence means a schema change slipped through review.
