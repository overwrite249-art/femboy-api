# Scheduler setup on Vercel Hobby

The gateway uses cron-job.org for its eight maintenance schedules. Native
Vercel cron jobs are deliberately absent from `vercel.json`: Hobby supports
daily schedules only, which is insufficient for usage flushing and task polling.

## Before connecting

1. Set the required MongoDB, Upstash Redis and signing/encryption secrets in
   Vercel's environment settings. Never commit a populated environment file.
2. Set `PUBLIC_BASE_URL` to a **stable HTTPS production origin**, with no path,
   port, credentials, query or fragment. Do not use a per-deployment preview URL.
3. Set a unique `CRON_SECRET` of at least 32 random characters.
4. Create the first root account from a trusted machine using the documented
   bootstrap command. There is no public first-admin registration endpoint.
5. Ensure cron-job.org can reach that production origin without a Vercel login
   screen, redirect, CAPTCHA or other interactive challenge. Keep preview
   protection enabled. Do not put protection bypass tokens in callback URLs.

## Get the required API key

Open <https://console.cron-job.org>, sign in, and generate an **API key under
Settings**. See the [official REST API documentation](https://docs.cron-job.org/rest-api.html).
If you apply IP restrictions to the key, they must allow the deployment's
outbound addresses; ordinary serverless egress addresses can change.

Sign in to the **production** app as root and open **Console → Setup**
(`/console/setup`). The public `/setup` page provides instructions only.
Enter the key and choose **Connect cron-job.org**.

The key is used only for this request to `https://api.cron-job.org`. It is not
stored in app environment variables, source, database, browser storage or audit
logs. The external scheduler does store `CRON_SECRET` as the Authorization
header it sends to the gateway. Restrict access to the scheduler account too.
Job response-body storage is disabled.

First-time setup takes roughly two minutes: cron-job.org limits job creation
to five calls per minute. Keep the page open. Setup uses a shared owner-token
lease to prevent concurrent duplicate provisioning.

## Schedules

All times are UTC. Each target is `/api/cron/<job>`.

| Job | Schedule |
| --- | --- |
| `health-check` | Every 5 minutes |
| `flush-usage` | Every 2 minutes |
| `poll-tasks` | Every minute |
| `reconcile-quota` | Every 10 minutes |
| `rollup` | Hourly at minute 7 |
| `refresh-pricing` | Daily at 03:23 |
| `expire-tokens` | Hourly at minute 41 |
| `partition-maint` | Daily at 04:13 |

Setup succeeds when the provider has accepted the configuration, not when
jobs have completed. Check **cron-job.org → execution history** for HTTP 200
responses and review failure/disable notifications. The provider's default
execution timeout applies; slow jobs may need a timeout appropriate to the
scheduler account and the app's function limit. Do not consider a timeout
proof that the server-side operation did not run.

## Updates, failures and rotation

- Re-enter the API key to update the matching jobs for the same origin.
  Unrelated jobs are not changed. Conflicting/duplicate targets fail closed.
- On a partial failure, already-created jobs remain enabled. Rerun setup after
  resolving the issue; existing matches are updated, not duplicated.
- An incomplete provider job list causes **no writes**.
- If `CRON_SECRET` changes, rerun setup to update the scheduler's headers.
- If the production origin changes, review and disable the old origin's jobs
  in cron-job.org after cutover. Setup never silently deletes other jobs.
- If the management API key leaks, revoke it in cron-job.org. The app does not
  need to retain it for scheduled execution.
- Preview deployments cannot configure the production scheduler.

References:
- <https://docs.cron-job.org/rest-api.html>
- <https://vercel.com/docs/cron-jobs/usage-and-pricing>