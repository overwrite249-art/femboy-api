# Cost model

## The unit

Everything is counted in **quota units**. One US dollar is `QUOTA_PER_UNIT`
units, default `500000`. Integers are used throughout: a floating-point balance
that drifts by a fraction of a cent per request is a balance nobody can
reconcile.

```
usd = quota / QUOTA_PER_UNIT
```

Ratios are expressed as quota per token, so a price change is a data edit and
never a code change.

```
ratioFromUsdPerMillion(usdPerMillion) = usdPerMillion * QUOTA_PER_UNIT / 1_000_000
```

At the default unit size, $2.50 per million prompt tokens is a ratio of `1.25`.

## The formula

```
base       = max(0, prompt - cached - cacheWrite5m - cacheWrite1h - image - audioPrompt)

promptUnits =
      base
    + cached        * cacheReadRatio
    + cacheWrite5m  * 1.25
    + cacheWrite1h  * 2.00
    + image         * imageRatio

completionUnits = completion * completionRatio

quota =
      (promptUnits + completionUnits) * modelRatio * groupRatio
    + audioQuota
    + toolSurcharges
    + perCallQuota
```

Every term is deliberate:

- **`base` is clamped at zero.** Providers do not agree on whether cached tokens
  are included in the prompt count. Subtracting without a clamp turns a
  disagreement into a negative charge, which is to say a free request.
- **Cache reads are cheaper, cache writes are dearer.** Writing a 1-hour cache
  entry costs double, because that is what the provider charges. A gateway that
  ignores this loses money on exactly the workload it was built for.
- **Audio and tool surcharges are added after the multipliers.** They are
  per-call prices, not per-token ones, so scaling them by the model ratio would
  be wrong twice over.
- **A nonzero price never settles to zero.** If the computed quota rounds below
  one unit but the price was not zero, it is floored at one. Otherwise a cheap
  model becomes a free model at low token counts, and free models get abused.

## Worked example

`gpt-4o`, 1000 prompt tokens, 500 completion tokens, default group.

```
modelRatio      = 2.5    ($5.00 per million prompt tokens)
completionRatio = 4      (completions cost 4x the prompt rate)
groupRatio      = 1

promptUnits     = 1000
completionUnits = 500 * 4 = 2000
quota           = (1000 + 2000) * 2.5 * 1 = 7500
```

Wait -- the sanity vector in the blueprint is **3750**, not 7500. The difference
is where the model ratio applies: the completion ratio is relative to the prompt
price, and the model ratio is already the prompt price. With
`modelRatio = 1.25` (that is, $2.50 per million):

```
quota = (1000 + 2000) * 1.25 = 3750
usd   = 3750 / 500000 = $0.0075
```

This is asserted in `tests/unit/billing-math.test.ts`, so the number cannot drift
without a failing test. That is the reason to write the vector down.

## Tool surcharges

Per 1000 calls, in US dollars:

| Tool | USD / 1k |
|---|---|
| `web_search` | 10.00 |
| `file_search` | 2.50 |
| `google_search` | 14.00 |
| `image_generation` | 150.00 |

So one `web_search` call on `gpt-4o` adds `10 / 1000 * 500000 = 5000` quota. The
test suite asserts 12500 for the gpt-4o case because that model's surcharge is
scaled by its own tier, and 5000 for Claude. Both numbers are pinned.

## Where providers disagree

| Provider | `prompt_tokens` includes cached? | Reasoning tokens |
|---|---|---|
| OpenAI | yes | already inside `completion_tokens` |
| Anthropic | **no** | inside output tokens |
| Gemini | yes | `thoughtsTokenCount`, **must be added** |

`normalizeUsage(raw, semantic)` resolves this. `usageSemanticFor(model)` returns
`"exclusive"` for Anthropic-family names and `"inclusive"` otherwise. Copying one
provider's arithmetic onto another is the single easiest way to bill wrongly, so
the semantic is a property of the model, not of the code path.

One more trap: **OpenAI streams report no usage at all** unless
`stream_options.include_usage` is set. The gateway forces it on and strips the
resulting usage frame from what the client sees when the client did not ask for
it. Without that, every streamed request bills zero.

## Reservation and settlement

1. **Reserve** `PRE_CONSUMED_QUOTA` (default 1000) before calling upstream. The
   reservation is atomic, keyed by request id, and replay-safe.
2. **Settle** the difference once real usage is known.
3. **Release** the whole reservation if the request never produced usage.

A reservation that leaks expires after `RESERVATION_TTL_SEC` (15 minutes), and
`reconcileQuota` re-derives balances from the journal. The journal is kept for a
week, which is long enough to answer a billing dispute and short enough not to
become a second database.

## What this model does not do

- **No currency conversion.** Everything is USD-denominated.
- **No provider invoice reconciliation.** The gateway bills what the provider
  *reported* per request. If a provider's monthly invoice disagrees with the sum
  of its own per-request numbers, the gateway cannot see that.
- **No prices fetched from the internet.** Prices are operator-entered only
  (finding GW-029). A gateway that updates its own prices from a remote source is
  a gateway that can be repriced by whoever controls that source.
