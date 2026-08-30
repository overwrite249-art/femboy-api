/**
 * Database entry point.
 *
 * `getDb()` returns the Mongo-backed store when `MONGODB_URI` is set and the
 * in-process store otherwise. The fallback is deliberate: it lets `npm run
 * harness`, the security suite and a first-run developer exercise the entire
 * gateway with no external services, while production is a one-variable
 * switch.
 */

import { config } from "../config/env.ts"
import type { Collection, Database } from "./driver.ts"
import { MemoryDatabase } from "./memory.ts"
import { COLLECTIONS, usageCollectionName } from "./types.ts"
import type {
	AbilityDoc,
	AuditLogDoc,
	ChannelDoc,
	ChannelKeyDoc,
	GroupRatioDoc,
	ModelMappingDoc,
	ModelPricingDoc,
	OAuthStateDoc,
	QuotaJournalDoc,
	RedemptionCodeDoc,
	SettingDoc,
	TaskDoc,
	TokenDoc,
	UsageLogDoc,
	UsageRollupDoc,
	UserDoc,
} from "./types.ts"
import { monthBucket } from "../util/time.ts"
import { USAGE_INDEXES } from "./indexes.ts"

let override: Database | null = null
let memory: MemoryDatabase | null = null
let mongoFailedAt = 0

/** Test/harness hook: force a specific database instance. */
export function setDb(db: Database | null): void {
	override = db
}

export function getMemoryDb(): MemoryDatabase {
	if (!memory) memory = new MemoryDatabase()
	return memory
}

export async function getDb(): Promise<Database> {
	if (override) return override
	if (!config.mongoUri) return getMemoryDb()
	// After a connection failure, back off for a few seconds rather than
	// hammering a dead cluster on every single request.
	if (mongoFailedAt && Date.now() - mongoFailedAt < 3_000) {
		throw new Error("mongodb is unavailable")
	}
	try {
		const { connectMongo } = await import("./mongo.ts")
		const db = await connectMongo()
		mongoFailedAt = 0
		return db
	} catch (error) {
		mongoFailedAt = Date.now()
		throw error
	}
}

/** True when the gateway is running without a durable database. */
export function isEphemeral(): boolean {
	return !override && !config.mongoUri
}

// -- typed collection accessors ----------------------------------------------

export async function users(): Promise<Collection<UserDoc>> {
	return (await getDb()).collection<UserDoc>(COLLECTIONS.users)
}
export async function tokens(): Promise<Collection<TokenDoc>> {
	return (await getDb()).collection<TokenDoc>(COLLECTIONS.tokens)
}
export async function channels(): Promise<Collection<ChannelDoc>> {
	return (await getDb()).collection<ChannelDoc>(COLLECTIONS.channels)
}
export async function channelKeys(): Promise<Collection<ChannelKeyDoc>> {
	return (await getDb()).collection<ChannelKeyDoc>(COLLECTIONS.channelKeys)
}
export async function abilities(): Promise<Collection<AbilityDoc>> {
	return (await getDb()).collection<AbilityDoc>(COLLECTIONS.abilities)
}
export async function modelPricing(): Promise<Collection<ModelPricingDoc>> {
	return (await getDb()).collection<ModelPricingDoc>(COLLECTIONS.modelPricing)
}
export async function modelMappings(): Promise<Collection<ModelMappingDoc>> {
	return (await getDb()).collection<ModelMappingDoc>(COLLECTIONS.modelMappings)
}
export async function groupRatios(): Promise<Collection<GroupRatioDoc>> {
	return (await getDb()).collection<GroupRatioDoc>(COLLECTIONS.groupRatios)
}
export async function redemptionCodes(): Promise<Collection<RedemptionCodeDoc>> {
	return (await getDb()).collection<RedemptionCodeDoc>(COLLECTIONS.redemptionCodes)
}
export async function quotaJournal(): Promise<Collection<QuotaJournalDoc>> {
	return (await getDb()).collection<QuotaJournalDoc>(COLLECTIONS.quotaJournal)
}
export async function tasks(): Promise<Collection<TaskDoc>> {
	return (await getDb()).collection<TaskDoc>(COLLECTIONS.tasks)
}
export async function usageRollups(): Promise<Collection<UsageRollupDoc>> {
	return (await getDb()).collection<UsageRollupDoc>(COLLECTIONS.usageRollups)
}
export async function auditLogs(): Promise<Collection<AuditLogDoc>> {
	return (await getDb()).collection<AuditLogDoc>(COLLECTIONS.auditLogs)
}
export async function settings(): Promise<Collection<SettingDoc>> {
	return (await getDb()).collection<SettingDoc>(COLLECTIONS.settings)
}
export async function oauthStates(): Promise<Collection<OAuthStateDoc>> {
	return (await getDb()).collection<OAuthStateDoc>(COLLECTIONS.oauthStates)
}

const ensuredUsageBuckets = new Set<string>()

/**
 * Returns the usage collection for a month, creating its indexes on first use.
 * This is the MongoDB stand-in for declarative table partitioning.
 */
export async function usageLogs(bucket = monthBucket()): Promise<Collection<UsageLogDoc>> {
	const db = await getDb()
	const name = usageCollectionName(bucket)
	const collection = db.collection<UsageLogDoc>(name)
	if (!ensuredUsageBuckets.has(name)) {
		ensuredUsageBuckets.add(name)
		try {
			await collection.createIndexes(USAGE_INDEXES)
		} catch {
			// A racing invocation may have created them already; harmless.
		}
	}
	return collection
}

export { COLLECTIONS, usageCollectionName }
export type { Database, Collection }
