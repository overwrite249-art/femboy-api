# Provider quirks

Every item here caused, or would have caused, a wrong number. They are written
down because each one looks like a detail and behaves like a billing bug.

## Token accounting is not portable

The three dialects disagree about what a "prompt token" includes. Copying a
field across is the single easiest way to bill wrong.

| Provider | Field | Includes cached? | Gateway action |
|---|---|---|---|
| OpenAI | `usage.prompt_tokens` | yes | use as-is; subtract cached for the base rate |
| Anthropic | `usage.input_tokens` | **no** | add `cache_read_input_tokens` and `cache_creation_input_tokens` back |
| Gemini | `usageMetadata.promptTokenCount` | yes | do **not** add cached again |

So `normalizeUsage` takes a semantic flag rather than guessing:
`usageSemanticFor(model)` returns `"exclusive"` for `claude*` and `anthropic*`,
`"inclusive"` otherwise. Get this backwards and Anthropic traffic is
under-billed by exactly the cached portion, which on a cache-heavy workload is
most of the prompt.

### Reasoning tokens bill as zero unless you look for them

Gemini reports `candidatesTokenCount` **excluding** `thoughtsTokenCount`. A
thinking-heavy request can spend far more on reasoning than on the visible
answer, so the gateway adds `thoughtsTokenCount` into completion tokens. Without
that, a reasoning model is the cheapest thing in the catalogue and the most
expensive thing on the invoice.

OpenAI reports reasoning inside
`completion_tokens_details.reasoning_tokens`, already counted in
`completion_tokens`. It is recorded separately for reporting but never added
again.

### OpenAI streams report no usage at all by default

A streaming `chat/completions` response contains no `usage` object unless the
request set `stream_options.include_usage`. A gateway that forwards the client's
request verbatim therefore bills every streamed request as **zero**.

The gateway injects `stream_options.include_usage: true` on outbound streaming
requests and records `usageInjected` on the normalized request. When the client
did not ask for usage, the resulting usage-only frame is suppressed on the way
back out, so the client sees exactly the stream it would have got. Response
shape is preserved; the number is not lost.

## Cache pricing is per-family, not universal

Cache reads are discounted differently by every vendor, and the discount is a
ratio of the input price rather than a separate rate:

| Family | Cache read ratio |
|---|---|
| `gpt-5*` | 0.10 |
| `gpt-4o*`, `o1*`, `o3*`, `o4*` | 0.50 |
| `gpt-4*` | 0.25 |
| `claude*` | 0.10 |
| `gemini-3*` | 0.10 |
| `deepseek*` | 0.25 |
| default | 0.25 |

Anthropic also charges to *write* a cache entry: 1.25x for the 5-minute TTL and
2.0x for the 1-hour TTL. Those are separate token counts, not a surcharge on the
prompt, so they are tracked as their own fields.

## Roles are structure, never text

Every dialect encodes conversation roles differently: OpenAI uses a `role` field
per message, Anthropic splits `system` out of `messages` entirely, and Gemini
uses `contents[].role` with `model` where the others say `assistant`.

The converters map roles **structurally**. No converter builds a prompt by
concatenating a role marker onto content, because a message body containing
`\n\nHuman:` would then be indistinguishable from a real turn boundary
(GW-012). An unrecognised role is refused, never coerced to `user`.

## Gemini specifics

- **Function schemas** are not JSON Schema. `toGeminiSchema` walks an allowlist
  of keys and bounds recursion depth, both because Gemini rejects unknown keys
  and because an attacker-supplied schema is a recursion bomb (GW-022).
- **Safety settings** are opt-out via `GEMINI_SAFETY_OFF`, off by default. When
  enabled the gateway sends `BLOCK_NONE` thresholds; this is a deployment
  decision, not a default.
- **Finish reasons** do not line up. `MAX_TOKENS` maps to `length`, `SAFETY` and
  `RECITATION` to `content_filter`, `STOP` to `stop`. An unknown reason maps to
  `stop` rather than being passed through, so clients never see a value outside
  the OpenAI enum.
- **The API key can arrive four ways**: `x-goog-api-key`, `?key=`,
  `Authorization: Bearer`, and the path-embedded form. All four are accepted
  inbound; none are forwarded.

## Anthropic specifics

- `max_tokens` is **required**. Requests without it are rejected by the upstream,
  so the converter supplies `DEFAULT_MAX_TOKENS` when the client omitted it.
- `system` is a top-level field, not a message. A conversation whose first
  message is a system prompt has to be restructured, not translated.
- The streaming protocol is a state machine (`message_start`,
  `content_block_start`, `content_block_delta`, `message_delta`, `message_stop`),
  not a sequence of independent chunks. Usage arrives in two places: input
  tokens at `message_start`, output tokens at `message_delta`. Both are needed;
  reading only one loses half the bill.
- `anthropic-version` is mandatory and comes from `ANTHROPIC_VERSION`.

## Azure OpenAI

Azure is OpenAI with a different URL shape: the deployment name replaces the
model in the path and `api-version` is a required query parameter. The model in
the body is ignored by the upstream, which means a model-mapping mistake fails
silently by serving the wrong deployment. `AZURE_DEFAULT_API_VERSION` supplies
the default.

## Never re-encode what you do not understand

Audio and image endpoints take `multipart/form-data` and return binary. Parsing
and re-serialising a multipart body changes the boundary and corrupts the
upload; JSON-parsing an audio response destroys it outright. Those four
endpoints (`audio/speech`, `audio/transcriptions`, `audio/translations`,
`images/edits`) go through `lib/relay/passthrough.ts`, which forwards bytes and
only inspects headers.
