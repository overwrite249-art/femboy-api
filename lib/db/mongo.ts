/**
 * MongoDB adapter.
 *
 * The driver is imported dynamically so that:
 *  - the Edge runtime never tries to bundle a TCP client
 *  - tests and the offline harness can run with zero installed dependencies
 *
 * The connection is memoised on `globalThis` because a serverless function can
 * be re-entered many times per container; creating a client per invocation is
 * the classic way to exhaust a Mongo connection pool.
 */

import { config } from "../config/env.ts"
import {
	DuplicateKeyError,
	type BulkWriteOp,
	type Collection,
	type Database,
	type Filter,
	type FindOptions,
	type IndexSpec,
	type UpdateResult,
	type UpdateSpec,
} from "./driver.ts"

type AnyRecord = Record<string, unknown>

/** Structural view of the pieces of the driver we use. */
type DriverCollection = {
	findOne(filter: AnyRecord, options?: AnyRecord): Promise<AnyRecord | null>
	find(filter: AnyRecord, options?: AnyRecord): { toArray(): Promise<AnyRecord[]> }
	countDocuments(filter?: AnyRecord): Promise<number>
	insertOne(doc: AnyRecord): Promise<unknown>
	insertMany(docs: AnyRecord[], options?: AnyRecord): Promise<{ insertedCount: number }>
	updateOne(filter: AnyRecord, update: AnyRecord, options?: AnyRecord): Promise<AnyRecord>
	updateMany(filter: AnyRecord, update: AnyRecord, options?: AnyRecord): Promise<AnyRecord>
	findOneAndUpdate(filter: AnyRecord, update: AnyRecord, options?: AnyRecord): Promise<AnyRecord | null>
	deleteOne(filter: AnyRecord): Promise<{ deletedCount?: number }>
	deleteMany(filter: AnyRecord): Promise<{ deletedCount?: number }>
	bulkWrite(ops: unknown[], options?: AnyRecord): Promise<unknown>
	distinct(field: string, filter?: AnyRecord): Promise<unknown[]>
	createIndexes(specs: unknown[]): Promise<unknown>
	drop(): Promise<unknown>
}

type DriverDb = {
	collection(name: string): DriverCollection
	listCollections(filter?: AnyRecord, options?: AnyRecord): { toArray(): Promise<AnyRecord[]> }
	command(cmd: AnyRecord): Promise<AnyRecord>
}

type DriverClient = {
	db(name: string): DriverDb
	connect(): Promise<unknown>
	close(): Promise<void>
}

function wrapDuplicate(error: unknown): never {
	if (DuplicateKeyError.is(error)) {
		throw new DuplicateKeyError(String((error as { message?: string }).message ?? "unique"))
	}
	throw error
}

class MongoCollection<T extends { _id: string }> implements Collection<T> {
	private raw: DriverCollection

	constructor(raw: DriverCollection) {
		this.raw = raw
	}

	async findOne(filter: Filter, options: FindOptions = {}): Promise<T | null> {
		const doc = await this.raw.findOne(filter, toDriverOptions(options))
		return (doc as T) ?? null
	}

	async find(filter: Filter, options: FindOptions = {}): Promise<T[]> {
		const docs = await this.raw.find(filter, toDriverOptions(options)).toArray()
		return docs as T[]
	}

	async countDocuments(filter: Filter = {}): Promise<number> {
		return this.raw.countDocuments(filter)
	}

	async insertOne(doc: T): Promise<void> {
		try {
			await this.raw.insertOne(doc as unknown as AnyRecord)
		} catch (error) {
			wrapDuplicate(error)
		}
	}

	async insertMany(docs: T[], ordered = true): Promise<number> {
		if (docs.length === 0) return 0
		try {
			const res = await this.raw.insertMany(docs as unknown as AnyRecord[], { ordered })
			return res.insertedCount ?? docs.length
		} catch (error) {
			if (!ordered && DuplicateKeyError.is(error)) {
				const result = (error as { result?: { insertedCount?: number } }).result
				return result?.insertedCount ?? 0
			}
			return wrapDuplicate(error)
		}
	}

	async updateOne(filter: Filter, update: UpdateSpec, upsert = false): Promise<UpdateResult> {
		try {
			const res = (await this.raw.updateOne(filter, update, { upsert })) as {
				matchedCount?: number
				modifiedCount?: number
				upsertedId?: unknown
			}
			return {
				matchedCount: res.matchedCount ?? 0,
				modifiedCount: res.modifiedCount ?? 0,
				upsertedId: res.upsertedId ? String(res.upsertedId) : null,
			}
		} catch (error) {
			return wrapDuplicate(error)
		}
	}

	async updateMany(filter: Filter, update: UpdateSpec): Promise<UpdateResult> {
		const res = (await this.raw.updateMany(filter, update)) as {
			matchedCount?: number
			modifiedCount?: number
		}
		return {
			matchedCount: res.matchedCount ?? 0,
			modifiedCount: res.modifiedCount ?? 0,
			upsertedId: null,
		}
	}

	async findOneAndUpdate(
		filter: Filter,
		update: UpdateSpec,
		options: { upsert?: boolean } = {},
	): Promise<T | null> {
		try {
			// `returnDocument: "after"` is what makes the guarded decrement usable
			// as a compare-and-swap: the caller sees the post-image or null.
			const doc = await this.raw.findOneAndUpdate(filter, update, {
				upsert: options.upsert ?? false,
				returnDocument: "after",
				includeResultMetadata: false,
			})
			return (doc as T) ?? null
		} catch (error) {
			return wrapDuplicate(error)
		}
	}

	async deleteOne(filter: Filter): Promise<number> {
		const res = await this.raw.deleteOne(filter)
		return res.deletedCount ?? 0
	}

	async deleteMany(filter: Filter): Promise<number> {
		const res = await this.raw.deleteMany(filter)
		return res.deletedCount ?? 0
	}

	async bulkWrite(ops: Array<BulkWriteOp<T>>, ordered = false): Promise<void> {
		if (ops.length === 0) return
		await this.raw.bulkWrite(ops as unknown[], { ordered })
	}

	async distinct(field: string, filter: Filter = {}): Promise<unknown[]> {
		return this.raw.distinct(field, filter)
	}

	async createIndexes(specs: IndexSpec[]): Promise<void> {
		if (specs.length === 0) return
		await this.raw.createIndexes(
			specs.map((spec) => ({
				key: spec.key,
				name: spec.name,
				unique: spec.unique,
				sparse: spec.sparse,
				expireAfterSeconds: spec.expireAfterSeconds,
				partialFilterExpression: spec.partialFilterExpression,
			})),
		)
	}

	async drop(): Promise<void> {
		try {
			await this.raw.drop()
		} catch {
			// dropping a non-existent collection is not an error for us
		}
	}
}

function toDriverOptions(options: FindOptions): AnyRecord {
	const out: AnyRecord = {}
	if (options.sort) out.sort = options.sort
	if (options.limit !== undefined) out.limit = options.limit
	if (options.skip !== undefined) out.skip = options.skip
	if (options.projection) out.projection = options.projection
	return out
}

class MongoDatabase implements Database {
	readonly kind = "mongo" as const
	private db: DriverDb
	private client: DriverClient

	constructor(client: DriverClient, db: DriverDb) {
		this.client = client
		this.db = db
	}

	collection<T extends { _id: string }>(name: string): Collection<T> {
		return new MongoCollection<T>(this.db.collection(name))
	}

	async listCollections(): Promise<string[]> {
		const list = await this.db.listCollections({}, { nameOnly: true }).toArray()
		return list.map((entry) => String(entry.name))
	}

	async ping(): Promise<boolean> {
		try {
			await this.db.command({ ping: 1 })
			return true
		} catch {
			return false
		}
	}

	async close(): Promise<void> {
		await this.client.close()
	}
}

type GlobalWithMongo = typeof globalThis & {
	__fbapiMongo?: { client: DriverClient; database: Database }
}

/**
 * Connects (once per container) and returns the wrapped database.
 * Throws when `MONGODB_URI` is not configured - callers decide whether to fall
 * back to the memory driver.
 */
export async function connectMongo(): Promise<Database> {
	const uri = config.mongoUri
	if (!uri) throw new Error("MONGODB_URI is not configured")

	const globalRef = globalThis as GlobalWithMongo
	if (globalRef.__fbapiMongo) return globalRef.__fbapiMongo.database

	const driver = (await import("mongodb")) as unknown as {
		MongoClient: new (uri: string, options?: AnyRecord) => DriverClient
	}
	const client = new driver.MongoClient(uri, {
		maxPoolSize: config.mongoMaxPoolSize,
		minPoolSize: 0,
		// Serverless containers freeze between invocations; keep the handshake
		// budget short so a dead pool surfaces fast instead of eating the request.
		serverSelectionTimeoutMS: 8_000,
		connectTimeoutMS: 8_000,
		socketTimeoutMS: 45_000,
		retryWrites: true,
		compressors: ["zlib"],
	})
	await client.connect()
	const database = new MongoDatabase(client, client.db(config.mongoDb))
	globalRef.__fbapiMongo = { client, database }
	return database
}

export async function closeMongo(): Promise<void> {
	const globalRef = globalThis as GlobalWithMongo
	if (!globalRef.__fbapiMongo) return
	await globalRef.__fbapiMongo.client.close()
	globalRef.__fbapiMongo = undefined
}
