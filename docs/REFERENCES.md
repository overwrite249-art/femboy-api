# References

What was consulted, and what was taken from it. No code was copied from any
project listed here; where a design was borrowed, it is named.

## Provider wire formats

The dialect translators were written from published documentation, not from
observed traffic. Where documentation and reality disagree, reality wins and
`docs/PROVIDER-QUIRKS.md` records the difference.

- **OpenAI API reference** -- chat completions, responses, embeddings, images,
  audio, moderations, and the `stream_options.include_usage` behaviour that makes
  streamed billing possible at all.
- **Anthropic Messages API** -- the event sequence (`message_start`,
  `content_block_delta`, `message_delta`, `message_stop`), the required
  `max_tokens`, and the cache token fields that are *excluded* from
  `input_tokens`.
- **Google Gemini REST API** -- `generateContent` / `streamGenerateContent`,
  `usageMetadata`, `thoughtsTokenCount`, and the two auth forms
  (`x-goog-api-key` and `?key=`).
- **Midjourney proxy conventions** -- the `submit` / `task/{id}/fetch` cycle and
  the `NOT_START` / `IN_PROGRESS` / `SUCCESS` / `FAILURE` status vocabulary, as
  implemented by the widely used community proxies.

## Prior art in the gateway space

- **one-api / new-api** -- the channel, token, group and quota model is
  recognisably descended from these projects: many keys per channel, weighted
  priority election, a per-token budget nested inside a per-user budget, and
  quota as an integer unit rather than a float currency. Their relational schema
  was not used; this gateway is document-oriented and its quota ledger lives in
  Redis with Mongo as the authority, which is a different design with different
  failure modes.
- The **IDOR class of bug that becomes GW-019** is a known weakness of that
  lineage: forwarding the provider's task id to the client. It is fixed here by
  construction rather than by validation.

## Security framing

The audit in `docs/SECURITY.md` is organised around actors and value flow rather
than a checklist, but the checklists were used to look for blind spots.

- **OWASP API Security Top 10** -- particularly API1 (broken object level
  authorization), which is exactly GW-019, and API4 (unrestricted resource
  consumption), which is the quota and rate-limit layer.
- **OWASP ASVS** -- session management and credential storage requirements.
- **OWASP Password Storage Cheat Sheet** and **NIST SP 800-132** -- PBKDF2 with
  a per-user salt and a high iteration count, chosen over Argon2 because the
  runtime offers PBKDF2 through WebCrypto and a pure-JS Argon2 in a serverless
  function is worse than a well-parameterised PBKDF2.
- **SSRF prevention guidance** -- the blocklist is built from the address ranges
  themselves rather than from a denylist of hostnames: RFC 1918 (private v4),
  RFC 6598 (carrier NAT), RFC 3927 (link local), RFC 4193 (unique local v6),
  RFC 4291 (v6 loopback and unspecified), plus the cloud metadata address.

## Platform and protocol

- **WHATWG HTML Living Standard, server-sent events** -- the parsing rules that
  `lib/transform/sse.ts` implements, including the `\r\n` handling and the
  leading-space stripping after `data:` that is easy to get wrong.
- **RFC 8259** (JSON) -- depth and size limits are our own, but the grammar is
  not.
- **Redis scripting documentation** -- the guarantee that a Lua script runs
  atomically is the entire basis for the quota ledger being correct under
  concurrency.
- **MongoDB indexing and TTL documentation** -- the index set in
  `lib/db/indexes.ts`, and the decision to make usage collections monthly rather
  than relying on TTL deletes at scale.
- **Vercel platform limits** -- function duration, memory, cron scheduling, and
  the reason the relay runs on the Node runtime rather than the edge: the
  MongoDB driver needs raw TCP.
- **Upstash REST API** -- why Redis is reachable at all from a serverless
  function without connection pooling problems.

## Tooling

- **k6** -- load scenarios (`ramping-vus`, `constant-arrival-rate`).
- **Semgrep** -- the eight custom rules in `.semgrep/gateway-rules.yml` encode
  this gateway's specific invariants, not generic patterns.
- **Node's built-in test runner** (`node:test`) and **Bun's** -- the suite runs
  under both, which is deliberate: two runtimes disagreeing about a stream is a
  bug worth finding.

## What is deliberately absent

No ORM. No validation library. No logging framework. No HTTP client. Every one of
those was considered and rejected for the same reason: a gateway's dependency
tree is its attack surface, and the standard library plus two drivers is small
enough to audit in an afternoon.
