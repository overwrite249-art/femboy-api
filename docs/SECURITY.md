# Security audit

Thirty findings were identified in the design review. Each one below names the
mechanism that closes it and the test that proves it, or says plainly that it is
still open.

A note on how to read this: "closed" means there is a test that fails if the
protection is removed. Where a protection exists but is only argued for rather
than tested, it says so.

## Status

| ID | Finding | Status | Proven by |
|---|---|---|---|
| GW-001 | Quota race under concurrency | Closed | `quota-race.test.ts` |
| GW-002 | Plaintext upstream keys at rest | Closed | `admin.test.ts`, `store.test.ts` |
| GW-003 | SSRF via channel base URL | Closed | `ssrf.test.ts` |
| GW-004 | Zombie upstream after client disconnect | Closed | `stream-limits.test.ts` |
| GW-005 | Credential leak through error bodies | Closed | `auth.test.ts` |
| GW-006 | X-Forwarded-For spoofing | Closed | `auth.test.ts` |
| GW-007 | Unbounded SSE line buffer | Closed | `transform-sse.test.ts` |
| GW-008 | Decompression bomb / oversized body | Closed | `stream-limits.test.ts` |
| GW-009 | Abort before settle leaks reservation | Closed | `quota-race.test.ts` |
| GW-010 | Timing oracle on key comparison | Closed | `auth.test.ts` |
| GW-011 | Response splitting via SSE injection | Closed | `transform-sse.test.ts` |
| GW-012 | Cross-provider prompt injection via roles | Closed | `transform-*.test.ts` |
| GW-013 | Billing the mapped model instead of the requested one | Closed | `billing-math.test.ts`, `relay-pipeline.test.ts` |
| GW-014 | Retry storm amplification | Closed | `retry.test.ts` |
| GW-015 | Fail-open rate limiter when Redis is down | Implemented | assertions pending |
| GW-016 | Anthropic cached-token semantics | Closed | `billing-math.test.ts` |
| GW-017 | Prototype pollution via JSON body | Closed | `store.test.ts` |
| GW-018 | Console credential accepted on the relay | Closed | `admin.test.ts` |
| GW-019 | Task IDOR on async job polling | **Open** | Phase 6 |
| GW-020 | Redemption code brute force | Closed | `admin.test.ts` |
| GW-021 | ReDoS in model allowlist matching | Closed | `auth.test.ts` |
| GW-022 | Schema recursion bomb (Gemini tools) | Closed | `transform-gemini.test.ts` |
| GW-023 | Prompt content in logs | Closed | by construction, see below |
| GW-024 | Raw client addresses stored | Closed | `usage.test.ts`, `admin.test.ts` |
| GW-025 | Fixed-window burst at the boundary | Closed | `ratelimit.test.ts` |
| GW-026 | Key-existence timing disclosure | Closed | `auth.test.ts` |
| GW-027 | Slowloris against the relay | Closed | `stream-limits.test.ts` |
| GW-028 | Forgeable cron authorization | Closed | `cron.test.ts` |
| GW-029 | Pricing poisoning via remote sync | Closed | by construction, see below |
| GW-030 | AGPL contamination | Closed | clean-room, see `docs/REFERENCES.md` |

## The ones worth explaining

### GW-001 / GW-009 -- quota is a reservation, not a subtraction

Billing cannot be "check, then charge": between the two, a hundred concurrent
requests all pass the check. Instead each request *reserves* an estimate
atomically in Redis, then settles the difference once real usage is known.

The reserve/settle/release trio are Lua scripts so they are atomic on the
server. Every script has a behaviour-identical JavaScript twin used when Redis is
unconfigured, and the twin serialises through a promise chain -- because a twin
that is merely *correct* but not *atomic* passes unit tests and then fails under
load, which is the exact bug the finding describes. `quota-race.test.ts` fires
ten concurrent requests against a balance that can fund five and asserts that
exactly five are granted.

Abandoned reservations are released on abort and expire after 15 minutes, so a
client that disconnects mid-stream does not permanently hold quota.

### GW-005 / GW-010 / GW-026 -- the authenticator gives nothing away

Key comparison is `timingSafeEqualHex` over digests, never string equality.
Unknown prefixes are cached as negative results for a few seconds so a
non-existent key costs the same as a real one. Every authentication path is
padded to `MIN_AUTH_LATENCY_MS`. Error bodies carry a coarse code and never echo
the presented credential.

### GW-011 -- model output cannot forge a stream frame

An SSE frame is terminated by a blank line. A model that emits `\n\n` inside its
content could therefore end the frame early and inject a synthetic one. Every
outbound frame goes through `formatSse`, which re-encodes the payload as JSON
and prefixes each line, so a blank line in content becomes `data: ` rather than
a frame boundary. Asserted for all three dialects.

### GW-012 -- roles are structure, never text

No converter builds a prompt by concatenating a role marker onto content. A
message body containing `\n\nHuman:` is data, not a turn boundary. An
unrecognised role is refused rather than coerced to `user`, because coercion is
how a `system` instruction becomes attacker-controlled.

### GW-018 -- two authorities, deliberately not interchangeable

A console session cookie and an `sk-` relay key are different credentials with
different threat models. A stolen cookie must not buy inference, and a leaked
relay key must not administer the gateway.

The relay authenticator reads `Authorization`, `x-api-key`, `x-goog-api-key`,
`?key=`, `mj-api-secret` and the WebSocket subprotocol -- and never cookies. The
console guard accepts a session or a key with role >= admin, and re-reads the
role from the database rather than trusting the cookie's claim, so demoting a
user takes effect immediately. Both directions are asserted.

### GW-020 -- redemption codes are digests

Codes are stored as `SHA-256("redeem:" + code)` with a 4-character prefix kept
for support. The claim is a conditional update on `status: "unused"`, so two
concurrent redemptions cannot both win. Failures are indistinguishable between
"never existed", "already spent", and "disabled", and a per-user attempt counter
caps guessing.

### GW-023 -- prompts are never persisted

`UsageLogDoc` has no field capable of holding message content. The only
prompt-derived value ever recorded is `promptShape`, which describes structure
(message count, role sequence, approximate size) and not text. Audit metadata
passes through `scrubMeta`, which drops any key matching
`/key|secret|token|password|cipher|credential|authorization|cookie|digest/i`,
truncates strings at 200 characters, and bounds depth and key count.

### GW-028 -- Vercel's cron header is not a credential

`x-vercel-cron` is set by the platform but is not secret and not verifiable, so
it proves nothing. Cron authorization compares
`sha256Hex("cron:" + presented)` against the configured secret in constant time.
An unset `CRON_SECRET` returns 503 rather than running the job: an unconfigured
secret fails closed, never open.

### GW-029 -- prices are typed, never fetched

`refreshPricing` deliberately does not sync from a remote catalogue. A poisoned
price is a billing bug that presents as a discount, and a gateway that trusts a
third-party price list has outsourced its revenue. Prices come from the
catalogue defaults in `lib/pricing` or from a row an operator wrote, and every
write is audited.

### GW-019 -- still open

Asynchronous job endpoints (Midjourney submit/fetch, video and music tasks)
return a task id. If the fetch endpoint authorises on the id alone, any
authenticated caller can read another tenant's task. The fix is to scope every
task row to its owning user and check ownership on read, which lands with the
task layer in Phase 6. It is listed as open rather than omitted because the
endpoints are not yet implemented -- there is nothing to exploit, but also
nothing to claim.

## Console-specific hardening

- **Passwords** use PBKDF2-SHA256 at 210,000 iterations with a per-user salt.
  Verification always performs a derivation, even for an unknown user, so
  response time does not reveal whether an account exists.
- **CSRF**: cookie authentication is ambient, so every unsafe method requires
  the token in a *header*. The cookie copy is deliberately not accepted as proof
  of itself -- a cross-site form post can send cookies but cannot set headers.
- **Origin** is checked against `PUBLIC_BASE_URL` when both are present.
- **Open redirect**: the OAuth `?redirect=` parameter is only honoured as a
  local path. Protocol-relative values like `//evil.example` are rejected.
- **OAuth replay**: the state row is deleted before the code is exchanged.
- **Identity linking** uses GitHub's immutable numeric id, never email or login
  name, both of which the account holder can change.
- **Network fence**: `ADMIN_ALLOWED_CIDRS` is checked before any credential, so
  a leaked admin key is still useless from outside the allowed ranges.
