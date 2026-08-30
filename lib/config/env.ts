/**
 * Central configuration loader.
 *
 * Every value is exposed through a getter so that tests (and hot reloads) can
 * mutate `process.env` and immediately observe the change. Nothing here throws
 * at import time: the gateway must be able to boot far enough to return a
 * structured error instead of a 500 HTML page when an operator forgets a var.
 */

export function envStr(name: string, fallback = ""): string {
	const raw = process.env[name]
	if (raw === undefined) return fallback
	const trimmed = raw.trim()
	return trimmed === "" ? fallback : trimmed
}

export function envNum(name: string, fallback: number): number {
	const raw = process.env[name]
	if (raw === undefined || raw.trim() === "") return fallback
	const parsed = Number(raw)
	return Number.isFinite(parsed) ? parsed : fallback
}

export function envInt(name: string, fallback: number): number {
	return Math.trunc(envNum(name, fallback))
}

export function envBool(name: string, fallback: boolean): boolean {
	const raw = process.env[name]
	if (raw === undefined || raw.trim() === "") return fallback
	const v = raw.trim().toLowerCase()
	if (v === "1" || v === "true" || v === "yes" || v === "on") return true
	if (v === "0" || v === "false" || v === "no" || v === "off") return false
	return fallback
}

export function envList(name: string, fallback: string[] = []): string[] {
	const raw = process.env[name]
	if (raw === undefined || raw.trim() === "") return fallback
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
}

/** Runtime environment name. */
export function nodeEnv(): "development" | "test" | "production" {
	const v = envStr("NODE_ENV", "development")
	if (v === "production" || v === "test") return v
	return "development"
}

export function isProduction(): boolean {
	return nodeEnv() === "production"
}

/**
 * The full configuration surface. Grouped to mirror the blueprint sections so
 * that an operator can map a knob back to the spec paragraph that defines it.
 */
export const config = {
	// ---- storage -----------------------------------------------------------
	get mongoUri(): string {
		return envStr("MONGODB_URI")
	},
	get mongoDb(): string {
		return envStr("MONGODB_DB", "femboy_api")
	},
	get mongoMaxPoolSize(): number {
		return envInt("MONGODB_MAX_POOL_SIZE", 10)
	},
	get redisUrl(): string {
		return envStr("UPSTASH_REDIS_REST_URL")
	},
	get redisToken(): string {
		return envStr("UPSTASH_REDIS_REST_TOKEN")
	},

	// ---- secrets -----------------------------------------------------------
	get keyPepper(): string {
		return envStr("KEY_PEPPER")
	},
	get channelKeyMaster(): string {
		return envStr("CHANNEL_KEY_MASTER")
	},
	get channelKeyVersion(): number {
		return envInt("CHANNEL_KEY_VERSION", 1)
	},
	get sessionSecret(): string {
		return envStr("SESSION_SECRET")
	},
	get cronSecret(): string {
		return envStr("CRON_SECRET")
	},
	get ipHashSecret(): string {
		return envStr("IP_HASH_SECRET")
	},
	get adminBootstrapToken(): string {
		return envStr("ADMIN_BOOTSTRAP_TOKEN")
	},

	// ---- billing -----------------------------------------------------------
	/** Quota units per USD. 500000 quota == $1.00 (matches upstream convention). */
	get quotaPerUnit(): number {
		return envNum("QUOTA_PER_UNIT", 500_000)
	},
	/** Quota optimistically held before a non-streaming request is settled. */
	get preConsumedQuota(): number {
		return envNum("PRE_CONSUMED_QUOTA", 1_000)
	},

	// ---- retry / timeouts --------------------------------------------------
	get retryTimes(): number {
		return envInt("RETRY_TIMES", 3)
	},
	get retryBudgetMs(): number {
		return envInt("RETRY_BUDGET_MS", 60_000)
	},
	get upstreamHeaderTimeoutMs(): number {
		return envInt("UPSTREAM_HEADER_TIMEOUT_MS", 60_000)
	},
	get streamingIdleTimeoutMs(): number {
		return envInt("STREAMING_IDLE_TIMEOUT_MS", 300_000)
	},
	get ssePingIntervalMs(): number {
		return envInt("SSE_PING_INTERVAL_MS", 15_000)
	},

	// ---- request limits ----------------------------------------------------
	get maxRequestBodyMb(): number {
		return envNum("MAX_REQUEST_BODY_MB", 32)
	},
	get maxRequestBodyBytes(): number {
		return Math.trunc(this.maxRequestBodyMb * 1024 * 1024)
	},
	get maxSseLineBytes(): number {
		return envInt("MAX_SSE_LINE_BYTES", 1_048_576)
	},
	get maxUpstreamResponseBytes(): number {
		return envInt("MAX_UPSTREAM_RESPONSE_BYTES", 64 * 1024 * 1024)
	},
	get maxJsonDepth(): number {
		return envInt("MAX_JSON_DEPTH", 64)
	},
	get maxJsonNodes(): number {
		return envInt("MAX_JSON_NODES", 200_000)
	},

	// ---- provider defaults -------------------------------------------------
	get anthropicVersion(): string {
		return envStr("ANTHROPIC_VERSION", "2023-06-01")
	},
	get azureDefaultApiVersion(): string {
		return envStr("AZURE_DEFAULT_API_VERSION", "2024-10-21")
	},
	get geminiSafetyOff(): boolean {
		return envBool("GEMINI_SAFETY_OFF", false)
	},
	get allowPlaintextUpstream(): boolean {
		return envBool("ALLOW_PLAINTEXT_UPSTREAM", false)
	},

	// ---- channel health ----------------------------------------------------
	get channelFailureThreshold(): number {
		return envInt("CHANNEL_FAILURE_THRESHOLD", 5)
	},
	get channelCooldownSec(): number {
		return envInt("CHANNEL_COOLDOWN_SEC", 60)
	},
	get channelAutoDisableFails(): number {
		return envInt("CHANNEL_AUTO_DISABLE_FAILS", 3)
	},
	get channelTestConcurrency(): number {
		return envInt("CHANNEL_TEST_CONCURRENCY", 8)
	},
	get channelTestModel(): string {
		return envStr("CHANNEL_TEST_MODEL", "gpt-4o-mini")
	},

	// ---- cache TTLs --------------------------------------------------------
	get abilityCacheTtlSec(): number {
		return envInt("ABILITY_CACHE_TTL_SEC", 60)
	},
	get channelCacheTtlSec(): number {
		return envInt("CHANNEL_CACHE_TTL_SEC", 300)
	},
	get tokenCacheTtlSec(): number {
		return envInt("TOKEN_CACHE_TTL_SEC", 600)
	},
	get affinityTtlSec(): number {
		return envInt("AFFINITY_TTL_SEC", 1_800)
	},
	get pricingCacheTtlSec(): number {
		return envInt("PRICING_CACHE_TTL_SEC", 300)
	},

	// ---- rate limits -------------------------------------------------------
	get defaultRpm(): number {
		return envInt("DEFAULT_RPM", 60)
	},
	get defaultTpm(): number {
		return envInt("DEFAULT_TPM", 0)
	},
	get defaultIpRpm(): number {
		return envInt("DEFAULT_IP_RPM", 120)
	},
	get defaultSuccessPerWindow(): number {
		return envInt("DEFAULT_SUCCESS_PER_WINDOW", 1_000)
	},
	get defaultWindowSec(): number {
		return envInt("DEFAULT_WINDOW_SEC", 60)
	},

	// ---- network trust -----------------------------------------------------
	get trustedProxyHops(): number {
		return envInt("TRUSTED_PROXY_HOPS", 1)
	},
	get adminAllowedCidrs(): string[] {
		return envList("ADMIN_ALLOWED_CIDRS")
	},
	get upstreamDomainAllowlist(): string[] {
		return envList("UPSTREAM_DOMAIN_ALLOWLIST")
	},
	get upstreamDomainDenylist(): string[] {
		return envList("UPSTREAM_DOMAIN_DENYLIST")
	},
	get upstreamAllowedPorts(): number[] {
		const raw = envList("UPSTREAM_ALLOWED_PORTS", ["443", "8443"])
		return raw.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0)
	},
	get dohResolver(): string {
		return envStr("DOH_RESOLVER", "https://cloudflare-dns.com/dns-query")
	},

	// ---- observability -----------------------------------------------------
	get axiomToken(): string {
		return envStr("AXIOM_TOKEN")
	},
	get axiomDataset(): string {
		return envStr("AXIOM_DATASET")
	},
	get logLevel(): "debug" | "info" | "warn" | "error" {
		const v = envStr("LOG_LEVEL", "info")
		if (v === "debug" || v === "warn" || v === "error") return v
		return "info"
	},
	get logSampleRate(): number {
		const v = envNum("LOG_SAMPLE_RATE", 1)
		return Math.min(1, Math.max(0, v))
	},
	get sentryDsn(): string {
		return envStr("SENTRY_DSN")
	},
	/** Floor for auth latency, closing the key-existence timing oracle (GW-026). */
	get minAuthLatencyMs(): number {
		return envInt("MIN_AUTH_LATENCY_MS", 30)
	},

	// ---- misc --------------------------------------------------------------
	get publicBaseUrl(): string {
		const explicit = envStr("PUBLIC_BASE_URL")
		if (explicit) return explicit.replace(/\/+$/, "")
		const vercel = envStr("VERCEL_URL")
		if (vercel) return "https://" + vercel
		return "http://localhost:3000"
	},
	get siteName(): string {
		return envStr("SITE_NAME", "Femboy API")
	},
	get registrationEnabled(): boolean {
		return envBool("REGISTRATION_ENABLED", true)
	},
	get githubClientId(): string {
		return envStr("GITHUB_CLIENT_ID")
	},
	get githubClientSecret(): string {
		return envStr("GITHUB_CLIENT_SECRET")
	},
}

export type AppConfig = typeof config

/** Secrets that must be present before the gateway may serve production traffic. */
export const REQUIRED_PRODUCTION_SECRETS = [
	"MONGODB_URI",
	"KEY_PEPPER",
	"CHANNEL_KEY_MASTER",
	"SESSION_SECRET",
	"CRON_SECRET",
	"IP_HASH_SECRET",
] as const

export type ConfigIssue = { name: string; problem: string }

/**
 * Validates configuration. Called by `/api/admin/health` and by the startup
 * self-check so misconfiguration surfaces as a diagnosable list rather than a
 * random runtime crash on the hot path.
 */
export function validateConfig(): ConfigIssue[] {
	const issues: ConfigIssue[] = []
	for (const name of REQUIRED_PRODUCTION_SECRETS) {
		const value = envStr(name)
		if (!value) {
			issues.push({ name, problem: "missing" })
			continue
		}
		if (name.endsWith("SECRET") || name === "KEY_PEPPER" || name === "CHANNEL_KEY_MASTER") {
			if (value.length < 32) {
				issues.push({ name, problem: "too short (need >= 32 chars of entropy)" })
			}
			if (/^(changeme|example|test|dev|secret|password)/i.test(value)) {
				issues.push({ name, problem: "looks like a placeholder value" })
			}
		}
	}
	if (config.quotaPerUnit <= 0) {
		issues.push({ name: "QUOTA_PER_UNIT", problem: "must be > 0" })
	}
	if (config.trustedProxyHops < 0) {
		issues.push({ name: "TRUSTED_PROXY_HOPS", problem: "must be >= 0" })
	}
	if (config.allowPlaintextUpstream && isProduction()) {
		issues.push({
			name: "ALLOW_PLAINTEXT_UPSTREAM",
			problem: "http:// upstreams must not be enabled in production",
		})
	}
	return issues
}
