/**
 * The narrow document-store interface the whole application is written
 * against.
 *
 * Two implementations exist:
 *  - `mongo.ts`   wraps the official driver (production)
 *  - `memory.ts`  a faithful subset used by tests, the harness and local dev
 *
 * Keeping the surface narrow is deliberate: it is small enough that the memory
 * twin can be trusted, which is what makes the security tests meaningful
 * without a live database.
 */

export type Filter = Record<string, unknown>
export type UpdateSpec = Record<string, unknown>

export type FindOptions = {
	sort?: Record<string, 1 | -1>
	limit?: number
	skip?: number
	projection?: Record<string, 0 | 1>
}

export type UpdateResult = {
	matchedCount: number
	modifiedCount: number
	upsertedId: string | null
}

export type BulkWriteOp<T> =
	| { insertOne: { document: T } }
	| { updateOne: { filter: Filter; update: UpdateSpec; upsert?: boolean } }
	| { deleteOne: { filter: Filter } }

export type IndexSpec = {
	key: Record<string, 1 | -1>
	name: string
	unique?: boolean
	sparse?: boolean
	/** Seconds; creates a TTL index on a Date field. */
	expireAfterSeconds?: number
	partialFilterExpression?: Filter
}

export type Collection<T extends { _id: string }> = {
	findOne(filter: Filter, options?: FindOptions): Promise<T | null>
	find(filter: Filter, options?: FindOptions): Promise<T[]>
	countDocuments(filter?: Filter): Promise<number>
	insertOne(doc: T): Promise<void>
	insertMany(docs: T[], ordered?: boolean): Promise<number>
	updateOne(filter: Filter, update: UpdateSpec, upsert?: boolean): Promise<UpdateResult>
	updateMany(filter: Filter, update: UpdateSpec): Promise<UpdateResult>
	/** Atomic read-modify-write. Returns the document AFTER the update. */
	findOneAndUpdate(filter: Filter, update: UpdateSpec, options?: { upsert?: boolean }): Promise<T | null>
	deleteOne(filter: Filter): Promise<number>
	deleteMany(filter: Filter): Promise<number>
	bulkWrite(ops: Array<BulkWriteOp<T>>, ordered?: boolean): Promise<void>
	distinct(field: string, filter?: Filter): Promise<unknown[]>
	createIndexes(specs: IndexSpec[]): Promise<void>
	drop(): Promise<void>
}

export type Database = {
	readonly kind: "mongo" | "memory"
	collection<T extends { _id: string }>(name: string): Collection<T>
	listCollections(): Promise<string[]>
	ping(): Promise<boolean>
	close(): Promise<void>
}

/** Raised when a unique index would be violated. */
export class DuplicateKeyError extends Error {
	readonly key: string
	constructor(key: string) {
		super(`duplicate key: ${key}`)
		this.name = "DuplicateKeyError"
		this.key = key
	}
	static is(value: unknown): boolean {
		if (value instanceof DuplicateKeyError) return true
		const code = (value as { code?: unknown } | null)?.code
		return code === 11000 || code === 11001
	}
}
