# Client parity

The gateway speaks four dialects. "Compatible" is a claim that needs a boundary,
so this document draws one: what is wire-identical, what differs deliberately,
and what is absent.

## The rule everything else follows

**A client that works against the provider works against the gateway with only
the base URL and the key changed.** Where that is not true, it is listed below.
If a difference is not listed here, it is a bug.

## OpenAI dialect

| Surface | Status |
| --- | --- |
| `POST /v1/chat/completions` | Identical, streaming and buffered |
| `POST /v1/completions` | Identical (legacy text completion) |
| `POST /v1/responses` | Identical, including `input` instead of `messages` |
| `POST /v1/responses/compact` | Identical |
| `POST /v1/alpha/search` | Identical, billed with the tool surcharge |
| `POST /v1/embeddings` | Identical |
| `POST /v1/images/generations` | Identical |
| `POST /v1/images/edits` | Identical, multipart forwarded byte for byte |
| `POST /v1/audio/speech` | Identical, binary response streamed |
| `POST /v1/audio/transcriptions` | Identical, multipart forwarded byte for byte |
| `POST /v1/audio/translations` | Identical |
| `POST /v1/moderations` | Identical |
| `POST /v1/rerank` | Identical (Cohere-style, widely adopted) |
| `GET /v1/models` | **Filtered** -- see below |
| `POST /v1/videos` | Asynchronous, returns a gateway task id |
| `GET /v1/dashboard/billing/*` | Answered from our ledger -- see below |
| `GET /v1/realtime` | **501.** Not served; see docs/ROADMAP.md |

### `GET /v1/models` is filtered, on purpose

The provider lists every model its account can reach. The gateway lists every
model **the calling token is entitled to**, which is the union of what the
group's channels serve intersected with the token's allowlist. A client that
discovers models from this endpoint and then calls one will never get a
`model_not_allowed` surprise, which is the behaviour a client actually wants.

### Streaming usage

OpenAI omits token counts from a streamed response unless the request sets
`stream_options.include_usage`. The gateway injects that option so it can bill
accurately, then **suppresses the resulting usage-only frame** if the client did
not ask for it. A client that did ask receives it unchanged. This is invisible
and exists so that streaming is not free.

### Billing dashboard

`/v1/dashboard/billing/subscription` reports the **gateway** balance, not a
provider account. `/v1/dashboard/billing/usage` reports lifetime account usage
and ignores the `start_date` / `end_date` parameters. Both endpoints are
deprecated upstream; they exist because cost dashboards still call them.

## Anthropic dialect

| Surface | Status |
| --- | --- |
| `POST /v1/messages` | Identical, streaming and buffered |
| `POST /v1/messages/count_tokens` | Identical |
| `x-api-key` header auth | Accepted |
| `anthropic-version` header | Accepted and forwarded |

Two behaviours worth knowing:

- **`max_tokens` is required by Anthropic and optional in OpenAI.** A request
  translated from the OpenAI dialect gets a default rather than an error.
- **Cache tokens are excluded from `input_tokens` by Anthropic and included by
  Gemini.** The gateway normalises both to an inclusive total before billing, so
  the same conversation costs the same through either dialect. This is the single
  most common source of "why is my bill different" and is documented in
  `docs/PROVIDER-QUIRKS.md`.

## Gemini dialect

| Surface | Status |
| --- | --- |
| `POST /v1beta/models/{model}:generateContent` | Identical |
| `POST /v1beta/models/{model}:streamGenerateContent` | Identical |
| `POST /v1beta/models/{model}:countTokens` | Identical |
| `POST /v1beta/models/{model}:embedContent` | Identical |
| `POST /v1beta/models/{model}:batchEmbedContents` | Identical |
| `x-goog-api-key` header auth | Accepted |
| `?key=` query auth | Accepted |

Gemini's `thoughtsTokenCount` is counted as completion tokens, because that is
what it is: output the model produced and charged for. Safety settings are
forwarded as sent; the gateway only overrides them if `GEMINI_SAFETY_OFF` is
explicitly enabled by the operator.

## Midjourney and the async platforms

| Surface | Status |
| --- | --- |
| `POST /mj/submit/*` | Identical request, **rewritten task id** |
| `GET /mj/task/{id}/fetch` | Identical response shape |
| `POST /suno/*`, `/kling/*`, `/jimeng/*`, `/vidu/*`, `/dify/*` | Forwarded |
| `GET /v1/tasks`, `GET /v1/tasks/{id}` | Gateway-native task view |

The one intentional difference across all of them: **the task id in the response
is the gateway's, not the provider's.** A provider id is often sequential, and
forwarding it would let one customer poll another's job. The gateway id is 166
bits of random and is checked against its owner on every fetch. Clients that
store the returned id and poll with it -- which is all of them -- notice nothing.

A task belonging to another user returns **404, not 403**, because "you may not
see this" still confirms it exists.

## Authentication forms accepted

| Form | Notes |
| --- | --- |
| `Authorization: Bearer sk-...` | Primary |
| `x-api-key: sk-...` | Anthropic clients |
| `x-goog-api-key: sk-...` | Gemini clients |
| `?key=sk-...` | Gemini clients that cannot set headers |
| `mj-api-secret: sk-...` | Midjourney clients |
| `Sec-WebSocket-Protocol` | Recognised, but realtime is 501 |

A console session cookie is **never** accepted as API authentication, and an API
key is never accepted as a console session. They are separate authorities and
both directions are proven by test.

## Not implemented

These are absent, not broken. A client using them will get a clear 404 or 501:

- **Realtime / WebSocket** (`/v1/realtime`) -- 501 with an explanation.
- **Batch API** (`/v1/batches`) -- needs durable multi-hour job storage and its
  own billing semantics.
- **Files API** (`/v1/files`) -- needs blob storage; the gateway stores no
  customer content by design.
- **Assistants / threads** -- a stateful product surface, not a relay surface.
- **Fine-tuning** (`/v1/fine_tuning/*`) -- provider-account-scoped, and a shared
  channel key must not be able to create artefacts on a tenant's behalf.
- **Vector stores** -- same reason as Files.

## The honest boundary

The gateway is compatible with these **wire formats**. It is not guaranteed
compatible with every client library's assumptions about undocumented behaviour:
exact `retry-after` semantics, provider-specific error body fields beyond
`error.message` / `error.type` / `error.code`, keepalive comment frequency in
streams, or HTTP/2 push behaviour. Those are unbounded to chase and are not
claimed.

Every interaction in the test suite is against a stub built from published
documentation, not against live providers. Parity with a real provider's current
behaviour is therefore asserted from documentation, and the first real traffic
should be treated as the actual test.
