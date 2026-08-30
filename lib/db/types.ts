/**
 * MongoDB document model.
 *
 * This is the MongoDB port of the relational design in the blueprint. Three
 * things replace what the SQL version relied on:
 *
 *  - row-level security  -> every query is scoped by `userId` in the repository
 *    layer; no route ever builds a filter without an owner predicate
 *  - table partitioning  -> `usage_logs_YYYYMM` collections created on demand
 *    and dropped by the partition-maintenance cron
 *  - SQL functions       -> atomic `findOneAndUpdate` with guard predicates
 *    (`{ quota: { $gte: amount } }`) and multi-document transactions
 */

export const COLLECTIONS = {
	users: "users",
	tokens: "tokens",
	channels: "channels",
	channelKeys: "channel_keys",
	abilities: "abilities",
	modelPricing: "model_pricing",
	modelMappings: "model_mappings",
	groupRatios: "group_ratios",
	redemptionCodes: "redemption_codes",
	quotaJournal: "quota_journal",
	tasks: "tasks",
	usageRollups: "usage_rollups",
	auditLogs: "audit_logs",
	settings: "settings",
	oauthStates: "oauth_states",
} as const

/** Usage logs are sharded by UTC month: usage_logs_202608. */
export function usageCollectionName(bucket: string): string {
	return `usage_logs_${bucket}`
}

export type UserRole = "user" | "admin" | "root"
export type EntityStatus = "enabled" | "disabled" | "deleted"

export type UserDoc = {
	_id: string
	username: string
	displayName: string
	email: string
	/** PBKDF2-derived, never a raw hash of the password alone. */
	passwordHash?: string
	passwordSalt?: string
	githubId?: string
	role: UserRole
	status: EntityStatus
	/** Billing group; selects the group ratio and the ability pool. */
	group: string
	/** Remaining quota in quota units. */
	quota: number
	/** Lifetime consumption, for reporting only. */
	usedQuota: number
	requestCount: number
	affCode?: string
	invitedBy?: string
	rpmLimit?: number
	tpmLimit?: number
	createdAt: Date
	updatedAt: Date
	lastLoginAt?: Date
}

export type TokenDoc = {
	_id: string
	userId: string
	name: string
	/** Public, indexable 8-char prefix of the key. */
	keyPrefix: string
	/** SHA-256(KEY_PEPPER:prefix:secret). The secret itself is never stored. */
	keyDigest: string
	/** Last four characters, for display in the console. */
	keyLast4: string
	status: EntityStatus
	/** Private budget; ignored when `unlimitedQuota` is true. */
	quota: number
	usedQuota: number
	unlimitedQuota: boolean
	expiresAt: Date | null
	/** CIDR allowlist. Empty means any address. */
	allowedIps: string[]
	/** Model allowlist. Empty means any model the group can reach. */
	allowedModels: string[]
	/** Overrides the owning user's group when set. */
	group?: string
	rpmLimit?: number
	tpmLimit?: number
	createdAt: Date
	updatedAt: Date
	accessedAt?: Date
}

export type ChannelType =
	| "openai"
	| "azure"
	| "anthropic"
	| "gemini"
	| "vertex"
	| "bedrock"
	| "mistral"
	| "cohere"
	| "deepseek"
	| "moonshot"
	| "zhipu"
	| "qwen"
	| "baidu"
	| "xai"
	| "groq"
	| "openrouter"
	| "ollama"
	| "midjourney"
	| "suno"
	| "kling"
	| "jimeng"
	| "vidu"
	| "dify"
	| "custom"

export type ChannelDoc = {
	_id: string
	name: string
	type: ChannelType
	baseUrl: string
	status: EntityStatus
	/** Higher wins; ties are broken by weighted random. */
	priority: number
	/** Weight for random selection inside a priority tier (uses weight + 10). */
	weight: number
	groups: string[]
	models: string[]
	/** from -> to, applied after the global mapping table. */
	modelMapping: Record<string, string>
	/** Extra headers merged into every upstream call (never secrets). */
	headers: Record<string, string>
	testModel?: string
	balance?: number
	balanceUpdatedAt?: Date
	autoDisabled: boolean
	failCount: number
	rpmLimit?: number
	/** Provider-specific knobs: apiVersion, region, project, deployment map... */
	config: Record<string, unknown>
	createdAt: Date
	updatedAt: Date
}

export type ChannelKeyDoc = {
	_id: string
	channelId: string
	/** AES-256-GCM envelope; see lib/util/crypto.ts. */
	cipher: string
	iv: string
	authTag: string
	keyVersion: number
	fingerprint: string
	status: EntityStatus
	index: number
	failCount: number
	lastUsedAt?: Date
	createdAt: Date
}

/**
 * Denormalised routing table. `_id` is `group|model|channelId` so a rebuild is
 * an idempotent upsert and duplicates are impossible.
 */
export type AbilityDoc = {
	_id: string
	group: string
	model: string
	channelId: string
	enabled: boolean
	priority: number
	weight: number
	updatedAt: Date
}

export type PricingTier = {
	/** Applies when prompt tokens are >= this threshold. */
	minPromptTokens: number
	modelRatio: number
	completionRatio: number
}

export type ModelPricingDoc = {
	/** The canonical model name. */
	_id: string
	/** USD per 1M prompt tokens, expressed as the gateway's ratio unit. */
	modelRatio: number
	completionRatio: number
	/** Multiplier applied to cache-read tokens. Provider specific. */
	cachedRatio?: number
	/** 5-minute cache write multiplier (Anthropic). */
	cacheWrite5mRatio?: number
	/** 1-hour cache write multiplier (Anthropic). */
	cacheWrite1hRatio?: number
	imageRatio?: number
	audioRatio?: number
	audioCompletionRatio?: number
	/** Fixed quota charged per call, for per-request priced endpoints. */
	perCallQuota?: number
	tiers?: PricingTier[]
	/**
	 * How the provider reports prompt tokens.
	 * "inclusive": prompt_tokens already contains cached tokens (OpenAI)
	 * "exclusive": input_tokens excludes cached tokens (Anthropic) - GW-016
	 */
	usageSemantic: "inclusive" | "exclusive"
	source: "builtin" | "manual" | "sync"
	updatedAt: Date
}

export type ModelMappingDoc = {
	_id: string
	from: string
	to: string
	/** Empty = global; otherwise limited to one channel. */
	channelId?: string
	createdAt: Date
}

export type GroupRatioDoc = {
	_id: string
	ratio: number
	description?: string
	updatedAt: Date
}

export type RedemptionCodeDoc = {
	_id: string
	/** Only the digest is stored (GW-020). */
	codeDigest: string
	/** First 4 chars, so support can identify a batch without the code. */
	codePrefix: string
	quota: number
	status: "unused" | "used" | "disabled"
	batchId: string
	usedBy?: string
	usedAt?: Date
	createdBy: string
	expiresAt?: Date
	createdAt: Date
}

export type UsageLogDoc = {
	_id: string
	/** Unique per request; the idempotency anchor for billing. */
	requestId: string
	userId: string
	tokenId: string
	channelId: string
	group: string
	/** What the client asked for. */
	model: string
	/** What was actually sent upstream after mapping (GW-013). */
	mappedModel: string
	/** The model whose price was applied - always the requested one. */
	billedModel: string
	endpoint: string
	dialect: string
	stream: boolean
	promptTokens: number
	completionTokens: number
	cachedTokens: number
	cacheWrite5mTokens: number
	cacheWrite1hTokens: number
	imageTokens: number
	audioPromptTokens: number
	audioCompletionTokens: number
	reasoningTokens: number
	toolCalls: Record<string, number>
	quota: number
	elapsedMs: number
	firstByteMs: number
	retries: number
	status: "success" | "error" | "aborted"
	errorCode?: string
	httpStatus: number
	/** HMAC of the client address; the raw value is never persisted (GW-024). */
	ipHash: string
	createdAt: Date
}

export type QuotaJournalDoc = {
	_id: string
	requestId: string
	kind: "reserve" | "settle" | "release" | "adjust"
	userId: string
	tokenId: string
	amount: number
	reserved: number
	state: "pending" | "applied" | "failed"
	createdAt: Date
	appliedAt?: Date
}

export type TaskPlatform = "midjourney" | "suno" | "kling" | "jimeng" | "vidu" | "dify" | "video"

export type TaskDoc = {
	_id: string
	/** Opaque, unguessable id handed to the client (GW-019). */
	taskId: string
	/** The provider's own id, kept internal. */
	upstreamTaskId?: string
	platform: TaskPlatform
	action: string
	userId: string
	tokenId: string
	channelId: string
	model: string
	status: "pending" | "submitted" | "in_progress" | "success" | "failure" | "expired"
	progress: string
	quota: number
	quotaSettled: boolean
	submitTime: Date
	startTime?: Date
	finishTime?: Date
	pollCount: number
	nextPollAt?: Date
	properties: Record<string, unknown>
	result?: Record<string, unknown>
	failReason?: string
}

export type UsageRollupDoc = {
	_id: string
	scope: "user" | "channel" | "model" | "global"
	key: string
	/** ISO hour bucket, e.g. 2026-08-30T21. */
	bucket: string
	requests: number
	errors: number
	quota: number
	promptTokens: number
	completionTokens: number
	updatedAt: Date
}

export type AuditLogDoc = {
	_id: string
	actorId: string
	actorRole: UserRole | "system"
	action: string
	targetType: string
	targetId: string
	meta: Record<string, unknown>
	ipHash: string
	createdAt: Date
}

export type SettingDoc = {
	_id: string
	value: unknown
	updatedAt: Date
}

export type OAuthStateDoc = {
	_id: string
	provider: "github"
	redirect: string
	createdAt: Date
	/** TTL index target. */
	expiresAt: Date
}
