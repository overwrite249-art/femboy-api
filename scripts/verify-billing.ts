/**
 * Verifies the billing arithmetic against the documented formula.
 *
 * This exists because a billing bug is silent. Nothing throws, no test fails,
 * and the only symptom is that the numbers are wrong -- for months, in either
 * direction. So the formula is recomputed here independently of the
 * implementation and the two are compared.
 *
 * The reference case, from docs/COST.md:
 *
 *   gpt-4o, 1000 prompt tokens, 500 completion tokens,
 *   modelRatio 1.25, completionRatio 4, groupRatio 1
 *
 *   quota = (1000 + 500 x 4) x 1.25 x 1  =  3750
 *
 * The common wrong answer is 7500, which comes from multiplying the whole total
 * by the completion ratio instead of only the completion part.
 */

import { resolvePricing } from "../lib/pricing/index.ts"
import { computeQuota } from "../lib/usage/billing.ts"
import { EMPTY_USAGE } from "../lib/usage/measure.ts"
import { config } from "../lib/config/env.ts"

let failures = 0

function check(name: string, actual: number, expected: number): void {
	// Quota is an integer currency; exact equality is the right comparison.
	if (actual === expected) {
		console.log(`pass  ${name}: ${actual}`)
		return
	}
	failures += 1
	console.log(`FAIL  ${name}: got ${actual}, expected ${expected}`)
}

async function main(): Promise<void> {
	console.log(`quota per unit: ${config.quotaPerUnit}`)
	console.log("")

	const { pricing, groupRatio } = await resolvePricing("gpt-4o", "default")
	console.log(
		`resolved gpt-4o: modelRatio=${pricing.modelRatio} completionRatio=${pricing.completionRatio} groupRatio=${groupRatio}`,
	)
	console.log("")

	// -- the reference vector, recomputed by hand from the resolved ratios ----
	const prompt = 1000
	const completion = 500
	const byHand = Math.round(
		(prompt + completion * pricing.completionRatio) * pricing.modelRatio * groupRatio,
	)
	const computed = computeQuota(
		{ ...EMPTY_USAGE, promptTokens: prompt, completionTokens: completion },
		pricing,
		groupRatio,
		"gpt-4o",
	).quota
	check("1000 prompt + 500 completion matches the documented formula", computed, byHand)

	if (pricing.modelRatio === 1.25 && pricing.completionRatio === 4 && groupRatio === 1) {
		check("the canonical vector is 3750", computed, 3750)
		if (computed === 7500) {
			console.log("      7500 means the completion ratio was applied to the whole total")
		}
	} else {
		console.log(
			"note  the pricing table does not carry the canonical 1.25/4 ratios, so the",
		)
		console.log("      3750 assertion was skipped; the formula check above still applies")
	}

	// -- completion tokens must cost more than prompt tokens -----------------
	const promptOnly = computeQuota(
		{ ...EMPTY_USAGE, promptTokens: 1000 },
		pricing,
		groupRatio,
		"gpt-4o",
	).quota
	const completionOnly = computeQuota(
		{ ...EMPTY_USAGE, completionTokens: 1000 },
		pricing,
		groupRatio,
		"gpt-4o",
	).quota
	if (pricing.completionRatio > 1 && completionOnly <= promptOnly) {
		failures += 1
		console.log(
			`FAIL  output should cost more than input: ${completionOnly} vs ${promptOnly}`,
		)
	} else {
		console.log(`pass  output costs more than input: ${completionOnly} vs ${promptOnly}`)
	}

	// -- cached input must cost less than fresh input ------------------------
	const cached = computeQuota(
		{ ...EMPTY_USAGE, promptTokens: 1000, cachedTokens: 1000 },
		pricing,
		groupRatio,
		"gpt-4o",
	).quota
	if (cached > promptOnly * 2) {
		failures += 1
		console.log(`FAIL  cached tokens billed above the fresh rate: ${cached}`)
	} else {
		console.log(`pass  cached input is discounted: ${cached} for 1000 fresh + 1000 cached`)
	}

	// -- nothing free ---------------------------------------------------------
	const tiny = computeQuota(
		{ ...EMPTY_USAGE, promptTokens: 1 },
		pricing,
		groupRatio,
		"gpt-4o",
	).quota
	if (pricing.modelRatio > 0 && tiny < 1) {
		failures += 1
		console.log("FAIL  a billable request settled to zero quota")
	} else {
		console.log(`pass  a one-token request still costs something: ${tiny}`)
	}

	// -- zero usage is free ---------------------------------------------------
	const nothing = computeQuota({ ...EMPTY_USAGE }, pricing, groupRatio, "gpt-4o").quota
	check("zero usage costs zero", nothing, 0)

	console.log("")
	console.log(
		failures === 0
			? "billing arithmetic agrees with the documented formula"
			: `${failures} billing check(s) failed`,
	)
	process.exit(failures === 0 ? 0 : 1)
}

await main()
