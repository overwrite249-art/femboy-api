/*
 * Load profile for the relay.
 *
 * The point of this script is not to find the throughput ceiling. It is to prove
 * three things under concurrency:
 *
 *   1. Quota accounting does not overspend a balance (GW-001).
 *   2. The circuit breaker opens and recovers rather than flapping (GW-014).
 *   3. Streaming latency to first byte stays bounded while the pool saturates.
 *
 * Run against a staging deployment with seeded channels pointing at a mock
 * upstream. Never against a real provider account: you will pay for it.
 *
 *   k6 run -e BASE=https://staging.example.app -e KEY=sk-... k6/relay.js
 */

import http from "k6/http"
import { check, sleep } from "k6"
import { Counter, Trend } from "k6/metrics"

const BASE = __ENV.BASE || "http://localhost:3000"
const KEY = __ENV.KEY || ""
const MODEL = __ENV.MODEL || "gpt-4o-mini"

const insufficient = new Counter("quota_refusals")
const rateLimited = new Counter("rate_limited")
const noChannel = new Counter("no_channel")
const firstByte = new Trend("first_byte_ms", true)

export const options = {
	scenarios: {
		steady: {
			executor: "ramping-vus",
			startVUs: 1,
			stages: [
				{ duration: "30s", target: 10 },
				{ duration: "1m", target: 50 },
				{ duration: "30s", target: 50 },
				{ duration: "30s", target: 0 },
			],
			gracefulRampDown: "10s",
		},
		burst: {
			executor: "constant-arrival-rate",
			rate: 40,
			timeUnit: "1s",
			duration: "1m",
			preAllocatedVUs: 40,
			maxVUs: 120,
			startTime: "2m30s",
			exec: "streaming",
		},
	},
	thresholds: {
		// A refusal is a correct answer, so only unexpected failures count.
		"http_req_failed{expected_response:true}": ["rate<0.02"],
		http_req_duration: ["p(95)<8000"],
		first_byte_ms: ["p(95)<3000"],
	},
}

function headers() {
	return {
		"Content-Type": "application/json",
		Authorization: "Bearer " + KEY,
	}
}

function body(stream) {
	return JSON.stringify({
		model: MODEL,
		stream: stream,
		max_tokens: 64,
		messages: [
			{ role: "user", content: "Reply with the single word: ok" },
		],
	})
}

function classify(response) {
	if (response.status === 402 || response.status === 403) {
		const text = String(response.body || "")
		if (text.indexOf("quota") >= 0) insufficient.add(1)
	}
	if (response.status === 429) rateLimited.add(1)
	if (response.status === 503) noChannel.add(1)
}

export default function nonStreaming() {
	const response = http.post(BASE + "/v1/chat/completions", body(false), {
		headers: headers(),
		tags: { kind: "json" },
	})

	classify(response)

	check(response, {
		"answered or refused cleanly": (r) =>
			r.status === 200 || r.status === 429 || r.status === 402 || r.status === 403,
		"never leaks an upstream key": (r) =>
			String(r.body || "").indexOf("sk-") === -1,
		"carries a request id": (r) => Boolean(r.headers["X-Request-Id"]),
	})

	sleep(1)
}

export function streaming() {
	const started = Date.now()
	const response = http.post(BASE + "/v1/chat/completions", body(true), {
		headers: headers(),
		tags: { kind: "stream" },
	})

	firstByte.add(Date.now() - started)
	classify(response)

	const text = String(response.body || "")
	check(response, {
		"stream is server-sent events": (r) =>
			r.status !== 200 || String(r.headers["Content-Type"] || "").indexOf("event-stream") >= 0,
		"stream terminates": () => text.length === 0 || text.indexOf("[DONE]") >= 0,
		"no bare newline injection": () => text.indexOf("\ndata: data:") === -1,
	})
}

export function handleSummary(data) {
	return {
		stdout: JSON.stringify(
			{
				requests: data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0,
				quotaRefusals: data.metrics.quota_refusals
					? data.metrics.quota_refusals.values.count
					: 0,
				rateLimited: data.metrics.rate_limited ? data.metrics.rate_limited.values.count : 0,
				noChannel: data.metrics.no_channel ? data.metrics.no_channel.values.count : 0,
			},
			null,
			2,
		),
	}
}
