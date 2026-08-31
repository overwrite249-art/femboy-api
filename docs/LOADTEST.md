# Load testing

## What is being measured, and what is not

The k6 script in `k6/relay.js` is not a benchmark. A gateway's throughput number
is mostly a statement about the provider behind it and the platform underneath
it, and neither is under our control. What it measures is **whether the gateway
stays correct while it is busy**, which is a different and more useful question.

Three specific claims are under test:

1. **Quota is never overspent under concurrency.** The unit test proves this for
   ten simultaneous reservations against one balance. The load test proves it
   for thousands across many connections, which is where a Lua script that was
   accidentally two round trips instead of one would show up.
2. **Rate limits refuse rather than degrade.** A limiter that starts returning
   500s instead of 429s under pressure has failed, even though it is still
   limiting.
3. **No credential appears in any response body.** Checked on every single
   response, not sampled. This is cheap and it is the assertion most worth
   making continuously, because a leak that only happens under load is exactly
   the kind that reaches production.

## The two scenarios and why both exist

`ramping-vus` climbs to a target concurrency and holds. This finds saturation
behaviour: connection pool exhaustion, event loop starvation, and the point at
which the Mongo driver's pool becomes the bottleneck.

`constant-arrival-rate` holds a fixed request rate regardless of how slow the
responses become. This is the important one. Under `ramping-vus`, a gateway that
slows down simply receives fewer requests, so it looks fine right up until it
doesn't. A constant arrival rate keeps applying pressure and reveals queue
growth -- which is what actually happens in production when a provider slows
down and clients keep calling.

## Metrics that matter, in order

**Time to first byte, not total duration.** For a streamed response, total
duration is a property of how long the model talks. First byte is the gateway's
own latency and the only part it is responsible for. The `first_byte` trend is
the primary number.

**The ratio of 429 to 500.** Under overload, every refusal should be a 429 or a
503 with a specific code. A single 500 under load is a bug, not capacity.

**Counted refusals by cause.** `quota_refused`, `rate_limited` and `no_channel`
are separate counters because they mean completely different things: the first is
correct behaviour, the second is correct behaviour, the third is an operator
configuration problem that a load test should surface loudly.

## Running it honestly

```bash
k6 run -e BASE_URL=https://your-deployment -e API_KEY=sk-... k6/relay.js
```

Point it at a deployment with a **stub channel**, not a real provider. Load
testing through a paid provider measures the provider, costs money, and will get
the key rate limited. Set up a channel whose base URL is a trivial echo service
and the numbers become about the gateway.

Two things will otherwise waste a run:

- **Cold starts.** The first requests after a deploy include function
  initialisation and a Mongo handshake. Discard the first 30 seconds.
- **A quota ceiling.** If the test user runs out of quota mid-run, every
  subsequent request is a fast 402 and the latency numbers look excellent. Give
  the load test user unlimited quota, or the run measures nothing.

## Interpreting a bad result

| Symptom | Most likely cause |
| --- | --- |
| First byte climbs with concurrency, upstream flat | Mongo pool exhausted; raise `MONGODB_MAX_POOL_SIZE` |
| Sudden 503 `no_channel` under load | Breaker tripped by upstream failures, not by load |
| 500s with no error code | An unwrapped throw; find it, wrap it, it is a bug |
| Quota refusals when balance is high | Reservations not being released on error paths |
| Throughput fine, `errors` counter rising | Provider rate limiting; the gateway is behaving |
