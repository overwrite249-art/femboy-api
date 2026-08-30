/**
 * The quota formula.
 *
 * quota = (base
 *          + cached      * cachedRatio
 *          + write5m     * cacheWrite5mRatio
 *          + write1h     * cacheWrite1hRatio
 *          + image       * imageRatio
 *          + completion  * completionRatio) * modelRatio * groupRatio
 *         + audioQuota
 *         + toolSurcharges
 *         + perCallQuota
 *
 * where base = prompt - cached - write5m - write1h - image - audioPrompt,
 * clamped at zero. `promptTokens` is inclusive by the time it reaches here
 * (see `measure.ts`), so subtracting the itemised subsets leaves exactly the
 * tokens charged at full price.
 *
 * Audio is added outside the model multiplier because audio is priced per
 * token in absolute terms rather than as a multiple of the text rate.
 */

import { config } from "../config/env.ts"
import { toolSurchargeQuota } from "../pricing/index.ts"
import type { ResolvedPricing } from "../pricing/index.ts"
import type { NormalizedUsage } from "./measure.ts"

export type QuotaBreakdown = {
	/** Prompt tokens charged at the full rate. */
	baseTokens: number
	/** Ratio-weighted prompt units before the model multiplier. */
	promptUnits: number
	completionUnits: number
	textQuota: number
	audioQuota: number
	toolQuota: number
	perCallQuota: number
	/** The integer actually charged. */
	quota: number
}

function clampNonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Prices one request.
 *
 * @param model the model to bill as. Always the model the client asked for,
 *   never the one a channel mapped it to - otherwise a channel could change
 *   what a user pays by rewriting the name (GW-013).
 */
export function computeQuota(
	usage: NormalizedUsage,
	pricing: ResolvedPricing,
	groupRatio: number,
	model: string = pricing.model,
): QuotaBreakdown {
	const ratio = clampNonNegative(pricing.modelRatio)
	const group = clampNonNegative(groupRatio) || 1

	const prompt = clampNonNegative(usage.promptTokens)
	const cached = clampNonNegative(usage.cachedTokens)
	const write5m = clampNonNegative(usage.cacheWrite5mTokens)
	const write1h = clampNonNegative(usage.cacheWrite1hTokens)
	const image = clampNonNegative(usage.imageTokens)
	const audioPrompt = clampNonNegative(usage.audioPromptTokens)
	const audioCompletion = clampNonNegative(usage.audioCompletionTokens)
	// Reasoning tokens are already inside completionTokens; adding them again
	// would double-charge the most expensive part of a response.
	const completion = clampNonNegative(usage.completionTokens)

	const baseTokens = clampNonNegative(prompt - cached - write5m - write1h - image - audioPrompt)

	const promptUnits =
		baseTokens +
		cached * pricing.cachedRatio +
		write5m * pricing.cacheWrite5mRatio +
		write1h * pricing.cacheWrite1hRatio +
		image * pricing.imageRatio
	const completionUnits = completion * pricing.completionRatio

	const textQuota = (promptUnits + completionUnits) * ratio * group
	const audioQuota =
		(audioPrompt * pricing.audioRatio + audioCompletion * pricing.audioCompletionRatio) * group
	const toolQuota = toolSurchargeQuota(model, usage.toolCalls ?? {})
	const perCallQuota = clampNonNegative(pricing.perCallQuota)

	const total = textQuota + audioQuota + toolQuota + perCallQuota
	let quota = Math.round(total)

	// A priced model must never settle to nothing. Rounding a real but tiny
	// charge down to zero is how a free tier gets built by accident.
	if (quota < 1 && total > 0) quota = 1

	return {
		baseTokens,
		promptUnits,
		completionUnits,
		textQuota,
		audioQuota,
		toolQuota,
		perCallQuota,
		quota,
	}
}

/** Convenience wrapper when only the charge is needed. */
export function quotaFor(
	usage: NormalizedUsage,
	pricing: ResolvedPricing,
	groupRatio: number,
	model?: string,
): number {
	return computeQuota(usage, pricing, groupRatio, model).quota
}

export function quotaToUsd(quota: number): number {
	const per = config.quotaPerUnit
	return per > 0 ? quota / per : 0
}

/**
 * The model whose price applies. Kept as a named function so the rule is
 * stated in one place and cannot drift between call sites (GW-013).
 */
export function billedModelFor(requestedModel: string, _mappedModel: string): string {
	return requestedModel
}
