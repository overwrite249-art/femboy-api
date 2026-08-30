import test from "node:test"
import assert from "node:assert/strict"

process.env.QUOTA_PER_UNIT = "500000"

import { setDb } from "../../lib/db/index.ts"
import { MemoryDatabase } from "../../lib/db/memory.ts"
import { MemoryRedis } from "../../lib/redis/memory.ts"
import { setRedis } from "../../lib/redis/client.ts"
import {
	cacheReadRatioFor,
	defaultPricingFor,
	getModelPricing,
	ratioFromUsdPerMillion,
	toolSurchargeQuota,
	usageSemanticFor,
} from "../../lib/pricing/index.ts"
import { normalizeUsage } from "../../lib/usage/measure.ts"
import { EMPTY_USAGE } from "../../lib/usage/measure.ts"
import { billedModelFor, computeQuota, quotaToUsd } from "../../lib/usage/billing.ts"

const QUOTA_PER_USD = 500_000

function usage(overrides: Partial<typeof EMPTY_USAGE> = {}) {
	return { ...EMPTY_USAGE, toolCalls: {}, ...overrides }
}

test("a plain request bills exactly the published price", () => {
	const pricing = defaultPricingFor("gpt-4o")
	const { quota } = computeQuota(usage({ promptTokens: 1000, completionTokens: 500 }), pricing, 1)
	// 1000 in at $2.50/1M = $0.0025, 500 out at $10/1M = $0.005.
	assert.equal(quotaToUsd(quota), 0.0075)
	assert.equal(quota, 3750)
})

test("cache reads are discounted but never free", () => {
	const pricing = defaultPricingFor("gpt-4o")
	const full = computeQuota(usage({ promptTokens: 1000 }), pricing, 1).quota
	const allCached = computeQuota(usage({ promptTokens: 1000, cachedTokens: 1000 }), pricing, 1).quota
	// gpt-4o reads cache at half price.
	assert.equal(allCached, full / 2)
	assert.ok(allCached > 0)
})

test("the prompt subtraction cannot go negative", () => {
	const pricing = defaultPricingFor("gpt-4o")
	// A provider that over-reports its subsets must not produce a credit.
	const result = computeQuota(
		usage({ promptTokens: 100, cachedTokens: 400, imageTokens: 300 }),
		pricing,
		1,
	)
	assert.equal(result.baseTokens, 0)
	assert.ok(result.quota > 0)
})

test("anthropic and openai bill identically for identical work", () => {
	// The same conversation: 1050 prompt tokens of which 1000 were cached.
	const anthropic = normalizeUsage({
		input_tokens: 50,
		output_tokens: 200,
		cache_read_input_tokens: 1000,
	})
	const openai = normalizeUsage({
		prompt_tokens: 1050,
		completion_tokens: 200,
		prompt_tokens_details: { cached_tokens: 1000 },
	})

	// Normalisation must make the exclusive provider inclusive.
	assert.equal(anthropic.promptTokens, 1050)
	assert.equal(openai.promptTokens, 1050)
	assert.equal(anthropic.promptTokens, openai.promptTokens)
	assert.equal(anthropic.cachedTokens, openai.cachedTokens)

	// And with matching prices the charge is the same.
	const pricing = { ...defaultPricingFor("gpt-4o"), cachedRatio: 0.1 }
	assert.equal(
		computeQuota(anthropic, pricing, 1).quota,
		computeQuota(openai, pricing, 1).quota,
	)
})

test("treating an exclusive provider as inclusive would under-bill", () => {
	const pricing = defaultPricingFor("claude-3-5-sonnet")
	const correct = normalizeUsage({
		input_tokens: 50,
		output_tokens: 100,
		cache_read_input_tokens: 1000,
	})
	// The naive reading: trust input_tokens as the whole prompt.
	const naive = usage({ promptTokens: 50, completionTokens: 100, cachedTokens: 1000 })

	const correctQuota = computeQuota(correct, pricing, 1).quota
	const naiveQuota = computeQuota(naive, pricing, 1).quota
	assert.ok(
		correctQuota > naiveQuota,
		`GW-016: correct ${correctQuota} must exceed naive ${naiveQuota}`,
	)
	// The naive path loses the 1000 cached tokens entirely.
	assert.equal(correct.promptTokens - naive.promptTokens, 1000)
})

test("anthropic cache writes carry their ttl premium", () => {
	const pricing = defaultPricingFor("claude-3-5-sonnet")
	const parsed = normalizeUsage({
		input_tokens: 0,
		output_tokens: 0,
		cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 100 },
	})
	assert.equal(parsed.cacheWrite5mTokens, 100)
	assert.equal(parsed.cacheWrite1hTokens, 100)
	assert.equal(parsed.promptTokens, 200)

	const result = computeQuota(parsed, pricing, 1)
	// 100 * 1.25 + 100 * 2.0 = 325 ratio-weighted tokens.
	assert.equal(result.promptUnits, 325)
	assert.equal(result.baseTokens, 0)
})

test("a flat cache_creation total is treated as the cheaper tier", () => {
	const parsed = normalizeUsage({
		input_tokens: 10,
		output_tokens: 0,
		cache_creation_input_tokens: 400,
	})
	assert.equal(parsed.cacheWrite5mTokens, 400)
	assert.equal(parsed.cacheWrite1hTokens, 0)
	assert.equal(parsed.promptTokens, 410)
})

test("gemini reasoning is billed as output exactly once", () => {
	const parsed = normalizeUsage({
		promptTokenCount: 100,
		candidatesTokenCount: 200,
		thoughtsTokenCount: 300,
		totalTokenCount: 600,
	})
	assert.equal(parsed.completionTokens, 500)
	assert.equal(parsed.reasoningTokens, 300)

	const pricing = defaultPricingFor("gemini-2.5-pro")
	const result = computeQuota(parsed, pricing, 1)
	// Reasoning is inside completionTokens, so it must not be added twice.
	assert.equal(result.completionUnits, 500 * pricing.completionRatio)
})

test("a real charge never rounds away to nothing", () => {
	const pricing = defaultPricingFor("gpt-4o-mini")
	const { quota } = computeQuota(usage({ promptTokens: 1 }), pricing, 1)
	assert.ok(quota >= 1, "a priced token must cost at least one quota unit")
})

test("a genuinely free request costs nothing", () => {
	const pricing = { ...defaultPricingFor("gpt-4o"), modelRatio: 0 }
	assert.equal(computeQuota(usage({ promptTokens: 1000 }), pricing, 1).quota, 0)
	assert.equal(computeQuota(usage(), defaultPricingFor("gpt-4o"), 1).quota, 0)
})

test("the group ratio scales the whole bill", () => {
	const pricing = defaultPricingFor("gpt-4o")
	const full = computeQuota(usage({ promptTokens: 1000, completionTokens: 100 }), pricing, 1).quota
	const halved = computeQuota(usage({ promptTokens: 1000, completionTokens: 100 }), pricing, 0.5).quota
	assert.equal(halved, Math.round(full / 2))
})

test("tool surcharges follow the published per-call rates", () => {
	// $25 per 1000 web searches on gpt-4o.
	assert.equal(toolSurchargeQuota("gpt-4o", { web_search: 1 }), 0.025 * QUOTA_PER_USD)
	assert.equal(toolSurchargeQuota("gpt-4.1", { web_search: 4 }), 0.1 * QUOTA_PER_USD)
	// Other families pay the standard $10 per 1000.
	assert.equal(toolSurchargeQuota("claude-3-5-sonnet", { web_search: 1 }), 0.01 * QUOTA_PER_USD)
	assert.equal(toolSurchargeQuota("gpt-4o", { file_search: 1000 }), 2.5 * QUOTA_PER_USD)
	assert.equal(toolSurchargeQuota("gemini-2.5-pro", { google_search: 1000 }), 14 * QUOTA_PER_USD)
	assert.equal(toolSurchargeQuota("gpt-4o", { image_generation: 10 }), 1.5 * QUOTA_PER_USD)
	// Unknown tools and nonsense counts are ignored rather than guessed at.
	assert.equal(toolSurchargeQuota("gpt-4o", { made_up_tool: 5 }), 0)
	assert.equal(toolSurchargeQuota("gpt-4o", { web_search: -5 }), 0)
})

test("tool surcharges land on the bill", () => {
	const pricing = defaultPricingFor("gpt-4o")
	const withTool = computeQuota(
		usage({ promptTokens: 1000, toolCalls: { web_search: 1 } }),
		pricing,
		1,
		"gpt-4o",
	)
	assert.equal(withTool.toolQuota, 12_500)
	assert.equal(withTool.quota, 1250 + 12_500)
})

test("cache-read discounts are per family and ordered correctly", () => {
	assert.equal(cacheReadRatioFor("gpt-5-mini"), 0.1)
	// gpt-4o must not be captured by the gpt-4 rule.
	assert.equal(cacheReadRatioFor("gpt-4o-2024-08-06"), 0.5)
	assert.equal(cacheReadRatioFor("o1-preview"), 0.5)
	assert.equal(cacheReadRatioFor("gpt-4.1"), 0.25)
	assert.equal(cacheReadRatioFor("deepseek-chat"), 0.25)
	assert.equal(cacheReadRatioFor("claude-3-opus"), 0.1)
	assert.equal(cacheReadRatioFor("gemini-3-pro"), 0.1)
})

test("provider semantics are detected from the model family", () => {
	assert.equal(usageSemanticFor("claude-3-5-sonnet"), "exclusive")
	assert.equal(usageSemanticFor("anthropic/claude-sonnet-4"), "exclusive")
	assert.equal(usageSemanticFor("gpt-4o"), "inclusive")
	assert.equal(usageSemanticFor("gemini-2.5-pro"), "inclusive")
})

test("dated snapshots inherit their family price", () => {
	assert.equal(
		defaultPricingFor("gpt-4o-2024-11-20").modelRatio,
		ratioFromUsdPerMillion(2.5),
	)
	// The longest matching prefix wins, so mini is not priced as full gpt-4o.
	assert.equal(defaultPricingFor("gpt-4o-mini").modelRatio, ratioFromUsdPerMillion(0.15))
	// A vendor prefix is stripped before matching.
	assert.equal(defaultPricingFor("openai/gpt-4o").modelRatio, ratioFromUsdPerMillion(2.5))
	// Unknown models bill at the fallback rather than for free.
	assert.ok(defaultPricingFor("some-unreleased-model").modelRatio > 0)
})

test("a mapped model never changes what the user pays", () => {
	// A channel rewriting gpt-4o to a cheaper model must not move the price,
	// in either direction.
	assert.equal(billedModelFor("gpt-4o", "gpt-4o-mini"), "gpt-4o")
	assert.equal(billedModelFor("gpt-4o-mini", "gpt-4o"), "gpt-4o-mini")
})

test("pricing overrides come from the database and are cached", async () => {
	setDb(new MemoryDatabase())
	setRedis(new MemoryRedis())

	const first = await getModelPricing("gpt-4o")
	assert.equal(first.modelRatio, ratioFromUsdPerMillion(2.5))

	// A partial override merges over the catalogue default.
	setRedis(new MemoryRedis())
	const { modelPricing } = await import("../../lib/db/index.ts")
	const collection = await modelPricing()
	await collection.insertOne({
		_id: "gpt-4o",
		modelRatio: 99,
		completionRatio: 2,
	})
	const overridden = await getModelPricing("gpt-4o")
	assert.equal(overridden.modelRatio, 99)
	assert.equal(overridden.completionRatio, 2)
	// Untouched fields keep their catalogue value.
	assert.equal(overridden.cachedRatio, 0.5)
})

test("malformed usage payloads bill nothing rather than throwing", () => {
	const pricing = defaultPricingFor("gpt-4o")
	for (const raw of [null, undefined, "", 42, [], { nonsense: true }]) {
		const parsed = normalizeUsage(raw)
		assert.equal(parsed.promptTokens, 0)
		assert.equal(computeQuota(parsed, pricing, 1).quota, 0)
	}
	// Negative and non-numeric counts are floored at zero, not trusted.
	const hostile = normalizeUsage({ prompt_tokens: -5000, completion_tokens: "1e9999" })
	assert.equal(hostile.promptTokens, 0)
	assert.equal(hostile.completionTokens, 0)
})
