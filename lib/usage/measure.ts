/**
 * Turns whatever an upstream reports into one canonical usage record.
 *
 * Every provider counts differently, and the differences are not cosmetic:
 *
 *  - OpenAI's `prompt_tokens` already contains `cached_tokens`.
 *  - Anthropic's `input_tokens` excludes both cache reads and cache writes.
 *  - Gemini reports `promptTokenCount` including `cachedContentTokenCount`,
 *    and keeps reasoning in a separate `thoughtsTokenCount`.
 *
 * Applying one billing formula to those three shapes is GW-016. The formula
 * subtracts cached tokens from the prompt to find the full-price remainder, so
 * an exclusive provider's prompt must be made inclusive first - otherwise the
 * subtraction clamps to zero and every cached request is billed as if the new
 * tokens were free.
 *
 * Canonical form is always inclusive: `promptTokens` counts every prompt token
 * exactly once, with the cached, cache-write, image and audio subsets broken
 * out alongside it.
 */

import { asRecord } from "../util/json.ts"
import type { UsageSemantic } from "../pricing/index.ts"

export type NormalizedUsage = {
	/** Inclusive of cached, cache-write, image and audio prompt tokens. */
	promptTokens: number
	/** Inclusive of reasoning tokens. */
	completionTokens: number
	cachedTokens: number
	cacheWrite5mTokens: number
	cacheWrite1hTokens: number
	imageTokens: number
	audioPromptTokens: number
	audioCompletionTokens: number
	reasoningTokens: number
	toolCalls: Record<string, number>
}

export const EMPTY_USAGE: NormalizedUsage = {
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	cacheWrite5mTokens: 0,
	cacheWrite1hTokens: 0,
	imageTokens: 0,
	audioPromptTokens: 0,
	audioCompletionTokens: 0,
	reasoningTokens: 0,
	toolCalls: {},
}

function num(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value)
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Recognises the payload shape rather than trusting the caller's claim. */
export function detectUsageShape(raw: unknown): "openai" | "anthropic" | "gemini" | "unknown" {
	const r = asRecord(raw)
	if (!r) return "unknown"
	if ("promptTokenCount" in r || "candidatesTokenCount" in r || "totalTokenCount" in r) return "gemini"
	if ("input_tokens" in r || "output_tokens" in r) return "anthropic"
	if ("prompt_tokens" in r || "completion_tokens" in r) return "openai"
	return "unknown"
}

function fromOpenAi(r: Record<string, unknown>): NormalizedUsage {
	const promptDetails = asRecord(r.prompt_tokens_details) ?? {}
	const completionDetails = asRecord(r.completion_tokens_details) ?? {}
	const cached = num(promptDetails.cached_tokens)
	const audioPrompt = num(promptDetails.audio_tokens)
	const image = num(promptDetails.image_tokens)
	return {
		...EMPTY_USAGE,
		// Already inclusive.
		promptTokens: num(r.prompt_tokens),
		completionTokens: num(r.completion_tokens),
		cachedTokens: cached,
		audioPromptTokens: audioPrompt,
		imageTokens: image,
		audioCompletionTokens: num(completionDetails.audio_tokens),
		reasoningTokens: num(completionDetails.reasoning_tokens),
		toolCalls: {},
	}
}

function fromAnthropic(r: Record<string, unknown>): NormalizedUsage {
	const input = num(r.input_tokens)
	const cacheRead = num(r.cache_read_input_tokens)
	// Newer responses split creation by TTL; the flat field is the older form.
	const creation = asRecord(r.cache_creation)
	const write5m = creation ? num(creation.ephemeral_5m_input_tokens) : 0
	const write1h = creation ? num(creation.ephemeral_1h_input_tokens) : 0
	const flatCreation = num(r.cache_creation_input_tokens)
	// Prefer the itemised split; fall back to treating the total as 5-minute.
	const resolved5m = write5m + write1h > 0 ? write5m : flatCreation
	return {
		...EMPTY_USAGE,
		// Made inclusive here - this is the GW-016 correction.
		promptTokens: input + cacheRead + resolved5m + write1h,
		completionTokens: num(r.output_tokens),
		cachedTokens: cacheRead,
		cacheWrite5mTokens: resolved5m,
		cacheWrite1hTokens: write1h,
		toolCalls: {},
	}
}

function fromGemini(r: Record<string, unknown>): NormalizedUsage {
	const prompt = num(r.promptTokenCount)
	const cached = num(r.cachedContentTokenCount)
	const thoughts = num(r.thoughtsTokenCount)
	const candidates = num(r.candidatesTokenCount)
	return {
		...EMPTY_USAGE,
		promptTokens: prompt,
		// Reasoning is billed as output but reported separately.
		completionTokens: candidates + thoughts,
		cachedTokens: cached,
		reasoningTokens: thoughts,
		toolCalls: {},
	}
}

/**
 * @param raw the provider's usage object
 * @param semantic how this model reports prompt tokens; used only when the
 *   payload shape is ambiguous, since a recognised shape implies its own rule
 */
export function normalizeUsage(raw: unknown, semantic: UsageSemantic = "inclusive"): NormalizedUsage {
	const r = asRecord(raw)
	if (!r) return { ...EMPTY_USAGE, toolCalls: {} }

	switch (detectUsageShape(r)) {
		case "openai":
			return fromOpenAi(r)
		case "anthropic":
			return fromAnthropic(r)
		case "gemini":
			return fromGemini(r)
		default:
			break
	}

	// Unrecognised shape: fall back to the configured semantic so a new
	// provider is not billed as if nothing was cached.
	const prompt = num(r.prompt_tokens ?? r.input_tokens ?? r.promptTokens)
	const cached = num(r.cached_tokens ?? r.cache_read_input_tokens)
	return {
		...EMPTY_USAGE,
		promptTokens: semantic === "exclusive" ? prompt + cached : prompt,
		completionTokens: num(r.completion_tokens ?? r.output_tokens ?? r.completionTokens),
		cachedTokens: cached,
		toolCalls: {},
	}
}

/** Adds two records, used to accumulate streamed deltas. */
export function addUsage(a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage {
	const toolCalls: Record<string, number> = { ...a.toolCalls }
	for (const [tool, count] of Object.entries(b.toolCalls ?? {})) {
		toolCalls[tool] = (toolCalls[tool] ?? 0) + count
	}
	return {
		promptTokens: a.promptTokens + b.promptTokens,
		completionTokens: a.completionTokens + b.completionTokens,
		cachedTokens: a.cachedTokens + b.cachedTokens,
		cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
		cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
		imageTokens: a.imageTokens + b.imageTokens,
		audioPromptTokens: a.audioPromptTokens + b.audioPromptTokens,
		audioCompletionTokens: a.audioCompletionTokens + b.audioCompletionTokens,
		reasoningTokens: a.reasoningTokens + b.reasoningTokens,
		toolCalls,
	}
}

/**
 * A streamed response may report cumulative usage on every chunk or only on
 * the last one. Taking the maximum of each field is correct for both.
 */
export function maxUsage(a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage {
	const toolCalls: Record<string, number> = { ...a.toolCalls }
	for (const [tool, count] of Object.entries(b.toolCalls ?? {})) {
		toolCalls[tool] = Math.max(toolCalls[tool] ?? 0, count)
	}
	return {
		promptTokens: Math.max(a.promptTokens, b.promptTokens),
		completionTokens: Math.max(a.completionTokens, b.completionTokens),
		cachedTokens: Math.max(a.cachedTokens, b.cachedTokens),
		cacheWrite5mTokens: Math.max(a.cacheWrite5mTokens, b.cacheWrite5mTokens),
		cacheWrite1hTokens: Math.max(a.cacheWrite1hTokens, b.cacheWrite1hTokens),
		imageTokens: Math.max(a.imageTokens, b.imageTokens),
		audioPromptTokens: Math.max(a.audioPromptTokens, b.audioPromptTokens),
		audioCompletionTokens: Math.max(a.audioCompletionTokens, b.audioCompletionTokens),
		reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens),
		toolCalls,
	}
}
