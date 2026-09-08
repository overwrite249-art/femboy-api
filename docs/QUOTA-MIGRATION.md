# Quota ledger v2: mandatory migration for existing deployments

**Do not deploy this branch over live v1 traffic or run both versions together.**
This release changes the accounting authority from expiring Redis counters to
MongoDB transactions. Old Mongo `quota`/`usedQuota` fields and buffered analytics
may be stale. There is no safe automatic inference when hot counters or journals
have been lost.

Newly created users/tokens receive `quotaLedgerVersion: 2`. Existing unversioned
accounts deliberately return 503 on paid relay until reviewed balances are migrated.
This migration was tested locally; it has not been run against your deployment.

## Prerequisites

- Node 22.19+; Atlas or a MongoDB replica set with multi-document transactions.
- Working shared Redis and the production secrets in `.env.local` or a private
  exported environment. Do not commit populated environment files or balance plans.
- Backups of Mongo, Redis balances/holds/journals, pricing and provider receipts.
- A maintenance window covering **all** old/new relay instances, admin balance
  edits, redemptions, async submissions/polls and scheduled cron jobs.
- A staging rehearsal on copies of data, plus an agreed accounting cutover point.

## Export, reconcile, review, apply

1. Stop new traffic and cron jobs on every old deployment, including preview or
   alternate URLs that can reach the same stores. Let known requests complete.
   Capture in-flight tasks and reservations and reconcile provider-side outcomes.
2. Back up both stores and provider receipts. Review existing identity indexes and
   resolve duplicate usernames/emails/GitHub IDs before creating unique indexes.
3. Run the **new** code's exporter while traffic remains stopped:

```sh
mkdir -p .quota-migration
QUOTA_MIGRATION_MAINTENANCE=1 node --env-file=.env.local --experimental-strip-types \
  scripts/migrate-quota-ledger.ts --export .quota-migration/balances.json
```

The environment flag acknowledges maintenance; the script cannot prove that
traffic has stopped. The output is a new mode-0600 file and refuses to overwrite
an existing plan. `.quota-migration/` is ignored by Git.

4. Review every `balances` row. `remaining: null` means **unknown**, not zero and
   not permission to reuse the old Mongo balance. Reconcile missing/corrupt Redis
   counters, v1 holds, journals, credits and receipts. For unlimited tokens whose
   hot counter did not exist, explicitly decide their stored balance rather than
   guessing. Review `usedQuota` too; it may be stale in a legacy export.
5. Set each `remaining` and `usedQuota` to reviewed safe integers. Remaining debt
   may be negative; lifetime spend must be non-negative. Do not edit IDs or
   `previousMongoQuota`, which is a stale-export checkpoint. Set top-level
   `reviewed` to `true` only after the entire plan has been reconciled and approved.
6. Apply while every relevant writer remains stopped:

```sh
QUOTA_MIGRATION_MAINTENANCE=1 node --env-file=.env.local --experimental-strip-types \
  scripts/migrate-quota-ledger.ts --apply .quota-migration/balances.json
```

Application is transactional **per row**, not across the entire plan. Invalid or
unreconciled rows are rejected before writing. A missing account or a balance
changed after export stops application; earlier rows may already be migrated.
Reapplying skips v2 rows, so investigate the error before resuming. Do not set
`quotaLedgerVersion` manually to bypass review. Unlisted legacy rows remain closed.

7. Verify every required user and token is v2, sampled balances match receipts,
   indexes exist, and Mongo transactions work. Reconcile old async tasks, including
   tasks without a stored provider key ID; do not rotate/recreate keys mid-job.
8. Deploy only the new code, restore cron schedules, and test one small, explicitly
   budgeted request. Verify reserve → settle, both balances, usage flushing and
   failed-request release. Monitor `reconcile-quota.pendingReview` and service errors
   before reopening normal traffic. Retire old deployments' access to the stores.
9. Retain the reviewed plan and backups securely. Archive legacy Redis financial
   keys only after verification; do not delete the new settlement queue or journals.

## Operational behavior after migration

Mongo owns money. `quota_journal` holds are durable and are **not deleted or
refunded automatically at expiry**. The authenticated reconciliation job drains
`quota:settlements:v2` and reports expired pending holds. Unknown usage must be
reconciled from receipts before a correction; analytics cannot prove zero cost.

Measured settlement can recover from a temporary Mongo failure while Redis
remains available. A crash before the measurement is persisted, or loss of both
stores, still needs operator review. Actual cost can exceed the reserved estimate.

## Rollback

Before opening v2 traffic, rollback can restore the backed-up v1 state with all
writers stopped and the cutover reviewed. After v2 has served any requests, **do
not simply restore a snapshot or promote old code**: that can recreate spent
money or lose provider charges. Stop all writers, preserve both journals/receipts,
reconcile post-cutover spending into an explicitly approved restored state, and
rehearse the rollback. Prefer a forward fix to financial history reconstruction.
