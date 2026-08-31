# Audit method

## What this document is for

`SECURITY.md` lists what was found and how it is closed. This document explains
**how the findings were derived**, so a reader can judge how much to trust them,
and repeat the exercise on the next change.

## The threat model, stated plainly

Five actors, in descending order of how much damage they can do:

1. **A paying customer with a valid API key.** Wants more capability than they
   paid for: models they are not entitled to, quota they did not buy, other
   tenants' data. This is the primary adversary, because they are already past
   authentication.
2. **An unauthenticated caller.** Wants to make the gateway do work for free, or
   to use it as a proxy to somewhere it can reach and they cannot.
3. **A compromised or hostile upstream provider.** Returns whatever it likes:
   oversized bodies, malformed SSE, redirects to internal addresses, usage
   numbers designed to bill the wrong party.
4. **An operator with console access but not root.** Wants to escalate, or to
   read credentials they should only be able to replace.
5. **A passive observer of logs and metrics.** Wants prompts, keys, or addresses.

Out of scope, explicitly: a compromised deployment platform, a malicious
MongoDB administrator, and side channels that require co-tenancy on the same
physical host.

## How each finding was derived

Three methods, and the findings are labelled by which one produced them:

### Method 1 -- trace a value from where it enters to every place it is used

Applied to: the client's credential, the provider's credential, the client's
address, the prompt, and the usage numbers.

This is what produced GW-005 (a credential compared with `===` leaks its length
and prefix through timing), GW-018 (a session cookie reaching the relay
authenticator would make a console login into an API key), GW-023 (a prompt that
reaches the usage row is a prompt that outlives the request), and GW-024 (a raw
address in an audit row is a location log).

The useful discipline here is to ask, for each hop: *who can read this, and did
they need to?*

### Method 2 -- ask what happens when a dependency misbehaves

Applied to: Redis, Mongo, and every provider.

For each, three questions:

- **What if it is slow?** Produced the header timeout, the idle timeout, and the
  retry budget. A gateway with no upper bound on a provider's silence is a
  gateway that holds every connection until the platform kills the function.
- **What if it is unavailable?** Produced the fail-closed quota decision
  (GW-015). Failing open on money is a business decision disguised as an
  engineering one.
- **What if it lies?** Produced the response caps (GW-020), the SSE line limit,
  the redirect re-validation (GW-003), and usage normalisation per provider
  family (GW-030). A provider that reports zero completion tokens on a streamed
  response is not hypothetical -- OpenAI does exactly that unless asked not to.

### Method 3 -- attack the concurrency, not the logic

Applied to: quota, rate limits, channel health, key rotation.

Every read-modify-write was rewritten as a question: *what happens if two of
these run at the same instant?* That produced GW-001 (check-then-charge lets N
concurrent requests each pass a balance check that only one should), GW-009
(replayed settlement double-charges unless keyed by request id), and GW-014
(a breaker that counts failures without a window flaps).

The test for this class of bug is not a unit test of the happy path. It is
`Promise.all` of ten identical calls with an assertion on how many were granted.
That is what `tests/security/quota-race.test.ts` does, and it failed the first
time it was run -- all ten were granted, which is exactly the bug the finding
describes.

## What was proven versus what was reasoned about

This distinction matters more than the finding count.

**Proven by a failing-then-passing test** (250 tests, 19 files):

- Concurrent quota reservation grants exactly the affordable number.
- A replayed settlement charges once.
- Encoded, octal, and decimal address literals are refused by the SSRF guard,
  including `010.0.0.1`, which the WHATWG URL parser normalises to `8.0.0.1`.
- A console session cookie is rejected by the relay authenticator, and a relay
  key is rejected by the console session reader.
- A write through an ambient session without a CSRF header creates nothing.
- The CIDR fence outranks a valid root credential.
- A minted key's plaintext appears in no stored document and no list response.
- A redemption code spends exactly once under a repeated attempt.
- Two failed sign-ins with different causes produce the same message.
- An OAuth `state` that was never issued is refused before any network call.
- Multibyte characters split across stream chunks are not corrupted.
- Cache-read, cache-write, and reasoning tokens bill at their own rates.

**Reasoned about but not proven by test:**

- Fail-closed behaviour when Redis is degraded mid-request. The code path exists
  and is reviewed, but forcing `isDegraded()` true at the right instant needs a
  throwing Redis stub that is not yet written. Listed as open work, not as done.
- Timing-attack resistance in absolute terms. Constant-time comparison is used
  and a latency floor is applied, but no statistical timing analysis was run.
- The behaviour of any real provider. Every provider interaction in the test
  suite is a stub built from published documentation. The quirks documented in
  `PROVIDER-QUIRKS.md` are from documentation and prior art, not from traffic.

A reader who wants to know how much to trust this should read that second list
first. It is the honest boundary of the work.

## The one finding left open

GW-019, asynchronous task ownership, was open until the task layer existed --
there is no point closing a finding about a subsystem that has not been written.
The requirement it states is specific: an async task id must be unguessable, must
not be the provider's own id, and must be checked against its owner on every
fetch. Anything less means one customer can poll another customer's job.

## How to repeat this on a change

1. If the change adds a route, ask what happens when it is called with no
   credential, a valid credential for a different tenant, and a valid credential
   with the wrong role.
2. If the change adds a read-modify-write, write the `Promise.all` test before
   the implementation.
3. If the change touches billing, add a vector with a hand-computed expected
   number. A billing test that computes its own expectation proves nothing.
4. If the change adds a field to a stored document, ask whether it can hold
   customer content. If it can, that is a finding.
5. If the change adds a dependency, answer the three questions from Method 2
   before merging.
