/**
 * Model pricing.
 *
 * Everything is expressed in "quota", an integer unit with
 * `QUOTA_PER_UNIT` (default 500000) quota to the dollar. Integers avoid the
 * float drift that turns a million small charges into a visible discrepancy.
 *
 * A ratio is quota-per-token. The published catalogue below is quoted in the
 * familiar USD-per-million form and converted once, so the numbers can be
 * checked against a provider's pricing page without arithmetic.
 *
 * Resolution order: Redis cache, then the `model_pricing` collection, then the
 * built-in catalogue. The gateway therefore bills sensibly before any pricing
 * sync has run, and an operator can override any model without a deploy.
 */

import { config } from "../config/env.ts"
import { groupRatios, modelPricing } from "../db/index.ts"
import { redisGetJson, redisSetJson } from "../redis/client.ts"
import { K } from "../redis/keys.ts"

/** Bump to invalidate every cached pricing entry at once. */
export const PRICING_VERSION = 3

/**
 * How a provider reports prompt tokens.
 * - `inclusive`: prompt_tokens already contains cached tokens (OpenAI).
 * - `exclusive`: input_tokens excludes cached tokens (Anthropic) - GW-016.
 */
export type UsageSemantic = "inclusive" | "exclusive"

export type ResolvedPricing = {
	model: string
	/** Quota per prompt token. */
	modelRatio: number
	/** Completion tokens cost `modelRatio * completionRatio`. */
	completionRatio: number
	/** Multiplier for cache-read tokens. */
	cachedRatio: number
	cacheWrite5mRatio: number
	cacheWrite1hRatio: number
	imageRatio: number
	/** Absolute quota per audio prompt token. */
	audioRatio: number
	/** Absolute quota per audio completion token. */
	audioCompletionRatio: number
	/** Flat quota for per-request priced endpoints. */
	perCallQuota: number
	usageSemantic: UsageSemantic
}

/** Anthropic's published cache-write premiums. */
const DEFAULT_CACHE_WRITE_5M_RATIO = 1.25
const DEFAULT_CACHE_WRITE_1H_RATIO = 2.0

type PriceCard = {
	/** USD per 1M prompt tokens. */
	in: number
	/** USD per 1M completion tokens. */
	out: number
	/** USD per 1M audio prompt tokens. */
	audioIn?: number
	/** USD per 1M audio completion tokens. */
	audioOut?: number
}

/**
 * Longest-prefix matched, so `gpt-4o-2024-08-06` inherits `gpt-4o` and dated
 * snapshots do not silently fall back to the generic default.
 */
const CATALOG: Record<string, PriceCard> = {
	"gpt-4o": { in: 2.5, out: 10, audioIn: 40, audioOut: 80 },
	"gpt-4o-mini": { in: 0.15, out: 0.6, audioIn: 10, audioOut: 20 },
	"gpt-4.1": { in: 2, out: 8 },
	"gpt-4.1-mini": { in: 0.4, out: 1.6 },
	"gpt-4.1-nano": { in: 0.1, out: 0.4 },
	"gpt-4-turbo": { in: 10, out: 30 },
	"gpt-4": { in: 30, out: 60 },
	"gpt-3.5-turbo": { in: 0.5, out: 1.5 },
	"gpt-5": { in: 1.25, out: 10 },
	"gpt-5-mini": { in: 0.25, out: 2 },
	"gpt-5-nano": { in: 0.05, out: 0.4 },
	o1: { in: 15, out: 60 },
	"o1-mini": { in: 1.1, out: 4.4 },
	o3: { in: 2, out: 8 },
	"o3-mini": { in: 1.1, out: 4.4 },
	"o4-mini": { in: 1.1, out: 4.4 },
	"claude-3-opus": { in: 15, out: 75 },
	"claude-3-sonnet": { in: 3, out: 15 },
	"claude-3-haiku": { in: 0.25, out: 1.25 },
	"claude-3-5-sonnet": { in: 3, out: 15 },
	"claude-3-5-haiku": { in: 0.8, out: 4 },
	"claude-3-7-sonnet": { in: 3, out: 15 },
	"claude-sonnet-4": { in: 3, out: 15 },
	"claude-opus-4": { in: 15, out: 75 },
	"claude-haiku-4": { in: 1, out: 5 },
	"gemini-1.5-flash": { in: 0.075, out: 0.3 },
	"gemini-1.5-pro": { in: 1.25, out: 5 },
	"gemini-2.0-flash": { in: 0.1, out: 0.4 },
	"gemini-2.5-flash": { in: 0.3, out: 2.5 },
	"gemini-2.5-pro": { in: 1.25, out: 10 },
	"gemini-3-pro": { in: 2, out: 12 },
	"deepseek-chat": { in: 0.27, out: 1.1 },
	"deepseek-reasoner": { in: 0.55, out: 2.19 },
	"text-embedding-3-small": { in: 0.02, out: 0 },
	"text-embedding-3-large": { in: 0.13, out: 0 },
	"text-embedding-ada-002": { in: 0.1, out: 0 },
}

/** Unknown models bill at a mid-tier rate rather than for free. */
const FALLBACK_CARD: PriceCard = { in: 2.5, out: 10 }

const CATALOG_KEYS = Object.keys(CATALOG).sort((a, b) => b.length - a.length)

/** Converts a published USD-per-million price into quota per token. */
export function ratioFromUsdPerMillion(usd: number): number {
	return (usd * config.quotaPerUnit) / 1_000_000
}

/** Quota back to dollars, for display. */
export function quotaToUsd(quota: number): number {
	const per = config.quotaPerUnit
	return per > 0 ? quota / per : 0
}

export function normalizeModelName(model: string): string {
	const trimmed = String(model ?? "").trim().toLowerCase()
	// Strip an OpenRouter-style vendor prefix: "anthropic/claude-3-opus".
	const slash = trimmed.indexOf("/")
	return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

function cardFor(model: string): PriceCard {
	const name = normalizeModelName(model)
	if (CATALOG[name]) return CATALOG[name]
	for (const key of CATALOG_KEYS) {
		if (name.startsWith(key)) return CATALOG[key]
	}
	return FALLBACK_CARD
}

/**
 * Cache-read discounts, which vary by family rather than by individual model.
 * Order matters: `gpt-4o` must be tested before `gpt-4`.
 */
export function cacheReadRatioFor(model: string): number {
	const name = normalizeModelName(model)
	if (name.startsWith("gpt-5")) return 0.1
	if (name.startsWith("gpt-4o") || name.startsWith("o1") || name.startsWith("o3") || name.startsWith("o4")) {
		return 0.5
	}
	if (name.startsWith("gpt-4")) return 0.25
	if (name.startsWith("deepseek")) return 0.25
	if (name.startsWith("claude")) return 0.1
	if (name.startsWith("gemini-3")) return 0.1
	return 0.25
}

/**
 * Which providers exclude cache reads from their prompt count.
 * Getting this wrong under-bills every cached Anthropic request (GW-016).
 */
export function usageSemanticFor(model: string): UsageSemantic {
	const name = normalizeModelName(model)
	return name.startsWith("claude") || name.startsWith("anthropic") ? "exclusive" : "inclusive"
}

export function defaultPricingFor(model: string): ResolvedPricing {
	const card = cardFor(model)
	const modelRatio = ratioFromUsdPerMillion(card.in)
	return {
		model: normalizeModelName(model),
		modelRatio,
		// Expressed relative to the prompt price, matching the doc shape.
		completionRatio: card.in > 0 ? card.out / card.in : 0,
		cachedRatio: cacheReadRatioFor(model),
		cacheWrite5mRatio: DEFAULT_CACHE_WRITE_5M_RATIO,
		cacheWrite1hRatio: DEFAULT_CACHE_WRITE_1H_RATIO,
		// Image inputs are billed as ordinary prompt tokens unless overridden.
		imageRatio: 1,
		audioRatio: ratioFromUsdPerMillion(card.audioIn ?? 0),
		audioCompletionRatio: ratioFromUsdPerMillion(card.audioOut ?? 0),
		perCallQuota: 0,
		usageSemantic: usageSemanticFor(model),
	}
}

function positive(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value)
	return Number.isFinite(n) && n >= 0 ? n : fallback
}

function pricingCacheKey(model: string): string {
	return `${K.pricing(PRICING_VERSION)}:${model}`
}

/**
 * Resolves a model's price. Overrides from `model_pricing` are merged over the
 * catalogue defaults, so a document may set only the fields it cares about.
 */
export async function getModelPricing(model: string): Promise<ResolvedPricing> {
	const name = normalizeModelName(model)
	const fallback = defaultPricingFor(name)

	const cached = await redisGetJson<ResolvedPricing>(pricingCacheKey(name)).catch(() => null)
	if (cached && typeof cached.modelRatio === "number") return cached

	let resolved = fallback
	try {
		const collection = await modelPricing()
		const doc = await collection.findOne({ _id: name })
		if (doc) {
			resolved = {
				model: name,
				modelRatio: positive(doc.modelRatio, fallback.modelRatio),
				completionRatio: positive(doc.completionRatio, fallback.completionRatio),
				cachedRatio: positive(doc.cachedRatio, fallback.cachedRatio),
				cacheWrite5mRatio: positive(doc.cacheWrite5mRatio, fallback.cacheWrite5mRatio),
				cacheWrite1hRatio: positive(doc.cacheWrite1hRatio, fallback.cacheWrite1hRatio),
				imageRatio: positive(doc.imageRatio, fallback.imageRatio),
				audioRatio: positive(doc.audioRatio, fallback.audioRatio),
				audioCompletionRatio: positive(doc.audioCompletionRatio, fallback.audioCompletionRatio),
				perCallQuota: positive(doc.perCallQuota, fallback.perCallQuota),
				// Family detection is the safer default when unset.
				usageSemantic:
					(doc as { usageSemantic?: UsageSemantic }).usageSemantic ?? fallback.usageSemantic,
			}
		}
	} catch {
		// A pricing lookup failure must not take the relay down; the catalogue
		// is a safe approximation and the request is still billed.
		resolved = fallback
	}

	await redisSetJson(pricingCacheKey(name), resolved, config.pricingCacheTtlSec).catch(() => undefined)
	return resolved
}

/** Per-group multiplier; 1 when the group has no override. */
export async function getGroupRatio(group: string): Promise<number> {
	if (!group || group === "default") return 1
	try {
		const collection = await groupRatios()
		const doc = await collection.findOne({ _id: group })
		return positive(doc?.ratio, 1)
	} catch {
		return 1
	}
}

export async function resolvePricing(
	model: string,
	group: string,
): Promise<{ pricing: ResolvedPricing; groupRatio: number }> {
	const [pricing, groupRatio] = await Promise.all([getModelPricing(model), getGroupRatio(group)])
	return { pricing, groupRatio }
}

/**
 * Built-in tool surcharges, in USD per 1000 calls. These are billed on top of
 * tokens because providers charge for them separately.
 */
export const TOOL_USD_PER_1K: Record<string, number> = {
	web_search: 10,
	file_search: 2.5,
	google_search: 14,
	image_generation: 150,
}

/** OpenAI charges more for web search on these families. */
function webSearchUsdPer1k(model: string): number {
	const name = normalizeModelName(model)
	return name.startsWith("gpt-4o") || name.startsWith("gpt-4.1") ? 25 : 10
}

export function toolUsdPer1k(model: string, tool: string): number {
	if (tool === "web_search") return webSearchUsdPer1k(model)
	return TOOL_USD_PER_1K[tool] ?? 0
}

/** Total surcharge in quota for a request's tool invocations. */
export function toolSurchargeQuota(model: string, toolCalls: Record<string, number>): number {
	let usd = 0
	for (const [tool, rawCount] of Object.entries(toolCalls ?? {})) {
		const count = Number(rawCount)
		if (!Number.isFinite(count) || count <= 0) continue
		usd += (toolUsdPer1k(model, tool) / 1000) * count
	}
	return usd * config.quotaPerUnit
}
