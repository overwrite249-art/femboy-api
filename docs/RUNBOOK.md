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

Ask for the gateway request ID (`x-fbapi-request-id`, or `x-request-id` on the
async surface) first; it is the join
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

1. Find the gateway request ID in `quota_journal`, then correlate usage and
   provider receipts. Partial output, image/audio requests and accepted async
   jobs can be billable even when there are no completion tokens.
2. Inspect the reservation state, reserved amount and measured charge. Applied
   entries are idempotent; never edit or delete the journal to force a replay.
3. Run the authenticated reconciliation cron to replay queued settlements:

```sh
curl -H "authorization: Bearer $CRON_SECRET" https://your-app/api/cron/reconcile-quota
```

`pendingReview` and `requestIds` identify expired durable holds needing review.
The 15-minute marker is **not an automatic refund or deletion**. Check receipts
before settling or crediting unknown work, and record the correction in audit.
Do not rebuild balances from analytics, which may be delayed or incomplete.

## 3. Redis is unavailable

New paid admission fails closed. **Do not unset Redis variables, force a memory
backend, or disable limiters to restore service.** Production rejects missing or
partial storage configuration intentionally.

1. Restore shared Redis connectivity and credentials; check provider limits.
2. After recovery, run `flush-usage` and `reconcile-quota` with cron auth.
3. Inspect lost limiter history, queued analytics/settlements and abandoned
   Mongo holds if Redis was reset. Money itself remains durable in Mongo.

## 4. Mongo is unavailable

Current key/user authority, session revocation and accounting require Mongo.
A cached identity is not permission to continue serving paid traffic.

1. Keep admission closed; restore Atlas/replica-set availability.
2. Check connection limits, transaction support, and `MONGODB_MAX_POOL_SIZE`.
3. On recovery, drain Redis usage and settlement queues, then inspect abandoned
   holds. If both stores were unavailable, measured outcomes may need recovery
   from provider receipts. Never promise that all telemetry survived.

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

The current implementation has **no automatic previous-master fallback**.
Schedule maintenance, stop submissions/polling, securely retain the original
provider credentials and a backup, configure the new master/version, and re-enter
the channel keys so they are sealed with the new master. Verify each channel
before resuming. Replacing key rows can invalidate the key IDs of queued tasks;
finish or reconcile those tasks before rotation.

Do not discard the old master/backup until restoration has been verified. Never
store either master or raw provider keys in GitHub, logs or an issue.

## 8. Cron jobs are not running

Symptoms: usage rows lag, async tasks stop progressing, or reconciliation is
delayed. Authentication itself checks expiry; it does not rely on the cron.

1. Check `vercel.json` still lists the schedules.
2. Confirm `CRON_SECRET` is set in the environment. If it is unset the endpoints
   return 503 by design, rather than running unauthenticated.
3. Trigger the job by hand with the secret in the `authorization` header. The
   `x-vercel-cron` header alone is never trusted.

## 9. Bootstrapping a fresh deployment

Use Node 22.19+ and `npm ci --ignore-scripts`. Configure all production storage
and secrets. Supply `ADMIN_PASSWORD` through your private environment.

```sh
node --env-file=.env.local --experimental-strip-types scripts/ensure-indexes.ts
node --env-file=.env.local --experimental-strip-types scripts/create-admin.ts
```

Then sign in at `/login`, add a channel, and test a small budgeted request in
staging. Confirm current authority, balance settlement and usage delivery before
announcing the deployment. Do not seed demo channels into production.

## 10. Restoring after a lost working copy

```sh
git clone https://github.com/overwrite249-art/femboy-api
cd femboy-api
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
```

The regular suite uses injected memory twins and mock providers. Run the separate
loopback-only Mongo integration suite with a disposable replica set as in CI.
Passing local tests is not evidence that production credentials, networking or
provider contracts are correct.

## 11. Rolling back

**Do not promote pre-v2 accounting code against migrated or subsequently spent
balances.** Stop all traffic and crons and use the [migration rollback procedure](QUOTA-MIGRATION.md).
Rolling back code does not undo database state, pricing edits or provider calls.
A database restore without reconciling charges since the snapshot can recreate
spendable money. Preserve journal history and reconcile receipts first.

## 12. What to escalate immediately

- A provider key or relay key appearing in any response body, log line, or audit
  row.
- Unexpected debt or aged pending holds. An estimate is not a hard spend ceiling.
- Any successful admin action by an identity whose role is `user` in the audit
  log.
- Message content appearing in a usage row. There is no field that can hold it,
  so its presence means a schema change slipped through review.
