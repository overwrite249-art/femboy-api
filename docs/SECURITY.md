# Security controls and boundaries

The [2026-09-08 review](SECURITY-REVIEW-2026-09-08.md) supersedes the original
“29 of 30 findings closed” claim. That claim did not hold when several controls
were tested through their real call paths. This is a control catalogue, not a
certification that the application is vulnerability-free.

## Authentication and console

- Registration accepts only public profile fields and server-hashed credentials;
  callers cannot allocate quota, choose paid groups or assign privileges.
- Responses use explicit user-field allowlists and omit password hashes/salts.
- New passwords use salted, versioned PBKDF2-SHA256 at 600,000 iterations. Legacy
  210,000-iteration hashes are verified and upgraded on successful login, with a
  compare-and-set update. Malformed records cannot choose an arbitrary work factor.
- Login, registration, redemption and OAuth initiation use shared atomic attempt
  limits before expensive or state-changing work.
- Cookie and relay credentials remain separate. Unsafe cookie-authenticated
  requests require the CSRF header; provided origins must exactly match the
  configured origin. Return paths reject control characters and backslashes.
- OAuth state is browser-bound, expires at ten minutes and is consumed atomically
  before code exchange. GitHub identity linking uses its immutable numeric ID.
- Logout revokes the session ID in Mongo until expiry, not just the browser cookie.
  If revocation cannot be checked, logout does not claim success.
- Current user/key status, expiry, role and entitlements are re-read during
  authentication. Cached credentials cannot preserve a revoked or demoted role.
- Admin cannot create or modify root/admin accounts or their keys; root can.
  Unknown roles have no implicit administrative authority.

## Network and bounded input

- Outbound URL policy validates all DNS answer families and pins the accepted
  addresses to the actual socket, preserving Host and TLS certificate checking.
- Cross-origin redirects are rejected before forwarding credentials or bodies.
  Same-origin redirects honor method/body rules and have a bounded hop count.
- Private/non-global addresses, forbidden hosts/ports and plaintext production
  upstreams are refused. Production cannot opt back into plaintext.
- Uploads, non-stream JSON, SSE lines/events, response bytes and stream lifetime
  have bounds. UTF-8 bytes are counted; deep JSON is checked before recursive
  sanitizing. Cancellation does not wait forever on an uncooperative source.
- Actual provider credentials are redacted from the relay/passthrough/task paths,
  including opaque credentials that do not match a known vendor regex.
  Unexpected server exceptions return generic errors rather than internal text.

## Shared admission and durable money

- Redis admission errors fail closed. Concurrency uses request-owned leases, not
  shared decrement counters. Lock release and queue acknowledgement check ownership
  atomically, preventing an expired worker from modifying a new worker's state.
- Mongo transactions commit user/token money and request journal state together.
  Reservation ownership, safe financial values and replay state are validated.
  Redis eviction cannot restore a spent balance.
- Redemption claim/credit and usage-event/rollup updates are transactional.
  Buffered events are persisted before an owner-checked acknowledgement.
- Measured settlements can queue in Redis during a Mongo outage; reconciliation
  replays them idempotently. Unknown abandoned work retains its durable hold and
  requires operator review, not automatic refunds from incomplete analytics.
- Estimates are not hard maximum charges. Actual usage can exceed the hold and
  create debt. Operators need suitable limits, provider budgets and monitoring.
- Existing unversioned balances fail closed until the explicit reviewed
  [quota migration](QUOTA-MIGRATION.md) has been applied.

## Async media

Only JSON submissions to explicitly allowed paths are accepted. Recognized
resource references must be owned gateway tasks on the same platform/channel;
new tasks retain the submitting provider key ID for polling and follow-ups.
Fetches are owner-scoped inside the query, and unknown roles cannot bypass scope.
Polling excludes terminal/not-yet-due history before applying its batch limit.
See [client parity](PARITY.md) for the intentional compatibility restrictions.

## Verification and residual risk

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run verify:billing`,
`npm run check:secrets`, `npm audit` and both Semgrep configurations in CI. Run
`npm run test:integration` only with a disposable loopback Mongo replica set.

These checks do not cover live provider accounts, real Upstash failure modes,
production networking, deployment secrets or every possible concurrent failure.
Provider URLs can contain opaque IDs, and adversarially encoded secret fragments
are not guaranteed to match redaction. Redis loss can lose buffered telemetry.
A process crash plus storage failures can require manual billing reconciliation.
Deployment review and ongoing monitoring remain necessary.

If an actual credential may have leaked, revoke/rotate it at the issuer first.
Do not paste credentials into an issue. Follow [the runbook](RUNBOOK.md).
