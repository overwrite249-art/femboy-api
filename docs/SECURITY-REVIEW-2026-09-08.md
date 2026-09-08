# Security and reliability review — 2026-09-08

## Scope

Reviewed the public `overwrite249-art/femboy-api` repository from baseline commit
`fc4a32796601661556c6ba40f61ce07f089edd00`. Changes are proposed on a separate branch;
no production deployment, credential rotation, balance migration or merge was
performed. This is a source review with regression tests and local integration
checks, not a guarantee that every bug or vulnerability has been found.

Baseline checks found 313 tests (307 passed, 6 failed), three TypeScript errors,
secret-scanner fixture/substring false positives, and two npm audit entries after
resolving the previously unlocked dependency ranges. The production build also
failed because the login page used `useSearchParams` without a Suspense boundary.

## Reproduced issues and changes

| Area | Issue addressed | Regression evidence |
| --- | --- | --- |
| Registration / privilege boundaries | Public mass assignment could allocate quota/groups; administrative user responses exposed password verifier material; admin/key paths could cross elevated-role boundaries | `auth-hardening.test.ts` |
| Authentication / sessions | Cached expiry/authority survived changes; limited cache invalidation; non-atomic guessing counters; weak origin/redirect handling; unbound/replayable OAuth state; cookie-only logout | `auth-hardening.test.ts`, `auth.test.ts`, `session.test.ts` |
| Password storage | Unversioned 210,000-iteration hashes lacked a safe upgrade path | `password-hardening.test.ts`, legacy-login upgrade regression |
| Durable accounting | Expiring Redis balances could rehydrate stale money; credits and admin edits diverged from hot state; holds and final charges lacked durable atomic persistence | `ledger-hardening.test.ts`, `quota-race.test.ts`, real Mongo integration |
| Usage and recovery | Duplicate deliveries incremented rollups again; popping before persistence could lose records; lock release was not owner-atomic | ledger/limiter/usage tests; Mongo outage-replay integration |
| Upstream transport | DNS validation was not bound to the real socket; cross-origin redirects could forward credentials/body; DNS family failures, IPv6/trailing-dot and redirect semantics needed fail-closed handling | `transport-hardening.test.ts`, `ssrf.test.ts` |
| Resource limits | Redis failures admitted concurrency; shared counter release races; body/stream limits could miss UTF-8, complete oversized lines or many small event lines; cancellation could hang | `limiter-hardening.test.ts`, `framing-hardening.test.ts`, transport tests |
| Provider response paths | Standalone redactors were not consistently used; opaque credential echoes could escape; terminal stream handling dropped late usage or left upstream open | actual relay-path regressions in `relay-pipeline.test.ts` |
| Async isolation | Arbitrary provider POST forwarding; unowned follow-up IDs; premature poll limits starved due tasks; numeric/deep IDs and rotating provider accounts broke task isolation | `tasks-hardening.test.ts`, `tasks.test.ts` |
| Build / tooling | Type errors, polluted test environment restoration, missing login Suspense, misleading static rule, non-blocking audits, no lockfile | clean install, test/type/build checks and blocking CI |

## Verification

Local verification on the completed patch:

| Check | Result |
| --- | --- |
| Full suite, Node 22.23.2 | 386 passed, 0 failed, 1 integration entry skipped without its opt-in environment |
| Full suite, Node 24.14.1 | 386 passed, 0 failed, 1 integration entry skipped without its opt-in environment |
| TypeScript | Passed |
| Production build, Node 22 and 24 | Passed on both |
| Real MongoDB 8.0.12 replica-set integration | 8 passed (7 subtests plus parent), none skipped |
| Native fetch + pinned socket | Passed with original Host preserved |
| Local production HTTP checks | Login renders; missing production configuration returns 503; security headers present |
| Billing vectors / local secret-pattern scan | Passed |
| npm audit | 0 known vulnerabilities in the resolved dependency tree at review time |
| Semgrep gateway / community TypeScript + secrets | 0 findings, 0 reported errors |
| Repaired runtime rule fixture | Missing Node declaration rejected; correct declaration accepted |

The regular suite uses injected memory stores and mock upstreams, plus a real
loopback socket regression. The separate Mongo integration suite ran against an
actual disposable MongoDB 8.0.12 replica set bound to loopback.
It verifies oversell protection, rollback, duplicate settlement, redemption,
usage deduplication, queued recovery and real unique-index behavior.

Checks include `npm ci --ignore-scripts`, `npm test`, `npm run typecheck`,
`npm run build`, `npm run verify:billing`, `npm run check:secrets`, `npm audit`,
Semgrep gateway invariants and community TypeScript/secrets rules. CI targets
Node 22 and 24, with an additional disposable Mongo integration job.

The lockfile resolves Next 15.5.25, React 19.2.8, MongoDB driver 6.21.0 and Undici
7.29.1. The dispatcher stays on the patched 7.x line because Node 22/24's
built-in fetch requires its legacy handler API. An actual loopback-socket test
caught and now guards against the incompatible Undici 8 API. Next's vulnerable transitive PostCSS pin is overridden to compatible
8.x **8.5.28**; the clean install/build and npm audit verify that resolved tree.
Revisit the override when upgrading Next. Actions are pinned to immutable SHAs;
Semgrep is pinned to 1.176.1. Dependabot checks npm and Actions weekly.

The local secret scanner's `sk-` substring bug is fixed. Only deterministic test
fixture lines have `allow-secret` markers. The static Math.random exemption is
limited to the non-secret retry-jitter line; credential/lock randomness is not
exempted. The runtime rule now reports missing Node declarations rather than
flagging already-correct routes.

GitHub reported one existing secret-scanning alert pointing at a deterministic
AWS-format redaction-test fixture; the alert was **left open** for owner review.
No secret values were retrieved from the alert API. GitHub code scanning reported
that no analysis had run. Local clean scans do not imply that all GitHub security
alerts are closed.

## Deployment and compatibility gates

- **Mandatory reviewed balance migration:** [QUOTA-MIGRATION.md](QUOTA-MIGRATION.md).
  Unversioned accounts fail closed. Mongo must support transactions. Never serve
  v1/v2 accounting simultaneously or roll back code without reconciling money.
- Production now rejects missing/partial storage and secret configuration rather
  than silently running per-instance memory state.
- Async submissions are JSON-only and path-allowlisted. Operators must explicitly
  approve non-default platform paths; arbitrary account-resource proxying stays
  blocked. Review existing queued jobs before provider-key rotation.
- Cross-origin upstream redirects and plaintext production URLs are rejected.
- Legacy passwords upgrade on successful sign-in; inactive accounts retain old
  hashes until they authenticate or undergo an operator-managed password reset.

## Limits and follow-up verification

No live paid provider accounts, real Upstash service, production Mongo, deployment
secrets, DNS infrastructure, provider billing receipts or production traffic were
tested. Rehearse the migration and validate the actual provider contracts in
staging. These checks cannot establish that every dependency or code path is safe.

Balances can go into debt when actual usage exceeds its estimate; configure
provider budgets and gateway limits rather than treating a hold as a spend cap.
Durable holds survive crashes, but unknown billable work is not automatically
refunded. Dual-store outages, Redis loss and a crash before a measured outcome is
persisted can require manual reconciliation. Monitor recovery queue depth and
expired holds. Buffered analytics may be lost if Redis itself is lost.

Redaction removes exact credentials and known patterns, not every possible
encoded or fragmented secret. Task-ID rewriting replaces exact values, not ID
substrings inside artifact URLs. Existing tasks without a recorded provider key
ID retain the legacy fallback. Review these boundaries against your provider's
actual semantics before enabling additional async paths.
