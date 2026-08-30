/**
 * In-process document store implementing the `Database` interface.
 *
 * Supports the operator subset the gateway actually uses:
 *   query : $eq $ne $gt $gte $lt $lte $in $nin $exists $regex $and $or $not $all $size
 *   update: $set $unset $inc $push $pull $addToSet $setOnInsert $min $max $currentDate
 *
 * Unique indexes are enforced, because several security properties (billing
 * idempotency, one-shot redemption codes) depend on them.
 */

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

function clone<T>(value: T): T {
	if (value === null || typeof value !== "object") return value
	if (value instanceof Date) return new Date(value.getTime()) as unknown as T
	if (Array.isArray(value)) return value.map((v) => clone(v)) as unknown as T
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = clone(v)
	return out as T
}

function getPath(doc: unknown, path: string): unknown {
	const parts = path.split(".")
	let current: unknown = doc
	for (const part of parts) {
		if (current === null || current === undefined) return undefined
		if (Array.isArray(current)) {
			const index = Number(part)
			current = Number.isInteger(index) ? current[index] : undefined
			continue
		}
		if (typeof current !== "object") return undefined
		current = (current as Record<string, unknown>)[part]
	}
	return current
}

function setPath(doc: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".")
	let current: Record<string, unknown> = doc
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i]
		if (part === "__proto__" || part === "constructor" || part === "prototype") return
		if (typeof current[part] !== "object" || current[part] === null) current[part] = {}
		current = current[part] as Record<string, unknown>
	}
	const last = parts[parts.length - 1]
	if (last === "__proto__" || last === "constructor" || last === "prototype") return
	current[last] = value
}

function unsetPath(doc: Record<string, unknown>, path: string): void {
	const parts = path.split(".")
	let current: Record<string, unknown> = doc
	for (let i = 0; i < parts.length - 1; i++) {
		const next = current[parts[i]]
		if (typeof next !== "object" || next === null) return
		current = next as Record<string, unknown>
	}
	delete current[parts[parts.length - 1]]
}

function compare(a: unknown, b: unknown): number {
	const av = a instanceof Date ? a.getTime() : a
	const bv = b instanceof Date ? b.getTime() : b
	if (typeof av === "number" && typeof bv === "number") return av - bv
	if (typeof av === "string" && typeof bv === "string") return av < bv ? -1 : av > bv ? 1 : 0
	if (av === bv) return 0
	return String(av) < String(bv) ? -1 : 1
}

function valueEquals(a: unknown, b: unknown): boolean {
	if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
	if (a instanceof Date && typeof b === "string") return a.toISOString() === b
	if (Array.isArray(a) && !Array.isArray(b)) return a.some((item) => valueEquals(item, b))
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => valueEquals(item, b[i]))
	}
	if (a && b && typeof a === "object" && typeof b === "object") {
		return JSON.stringify(a) === JSON.stringify(b)
	}
	return a === b
}

function matchOperator(actual: unknown, op: string, expected: unknown): boolean {
	switch (op) {
		case "$eq":
			return valueEquals(actual, expected)
		case "$ne":
			return !valueEquals(actual, expected)
		case "$gt":
			return actual !== undefined && actual !== null && compare(actual, expected) > 0
		case "$gte":
			return actual !== undefined && actual !== null && compare(actual, expected) >= 0
		case "$lt":
			return actual !== undefined && actual !== null && compare(actual, expected) < 0
		case "$lte":
			return actual !== undefined && actual !== null && compare(actual, expected) <= 0
		case "$in":
			return (
				Array.isArray(expected) &&
				expected.some((item) =>
					Array.isArray(actual) ? actual.some((a) => valueEquals(a, item)) : valueEquals(actual, item),
				)
			)
		case "$nin":
			return (
				!Array.isArray(expected) ||
				!expected.some((item) =>
					Array.isArray(actual) ? actual.some((a) => valueEquals(a, item)) : valueEquals(actual, item),
				)
			)
		case "$exists":
			return expected ? actual !== undefined : actual === undefined
		case "$regex": {
			if (typeof actual !== "string") return false
			const re = expected instanceof RegExp ? expected : new RegExp(String(expected))
			return re.test(actual)
		}
		case "$all":
			return (
				Array.isArray(expected) &&
				Array.isArray(actual) &&
				expected.every((item) => actual.some((a) => valueEquals(a, item)))
			)
		case "$size":
			return Array.isArray(actual) && actual.length === Number(expected)
		case "$not":
			return !matchCondition(actual, expected)
		default:
			throw new Error(`memory store: unsupported query operator ${op}`)
	}
}

function matchCondition(actual: unknown, condition: unknown): boolean {
	if (condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date)) {
		const entries = Object.entries(condition as Record<string, unknown>)
		if (entries.length > 0 && entries.every(([k]) => k.startsWith("$"))) {
			return entries.every(([op, expected]) => matchOperator(actual, op, expected))
		}
	}
	return valueEquals(actual, condition)
}

export function matchesFilter(doc: Record<string, unknown>, filter: Filter): boolean {
	for (const [key, condition] of Object.entries(filter)) {
		if (key === "$and") {
			if (!(condition as Filter[]).every((sub) => matchesFilter(doc, sub))) return false
			continue
		}
		if (key === "$or") {
			if (!(condition as Filter[]).some((sub) => matchesFilter(doc, sub))) return false
			continue
		}
		if (key === "$nor") {
			if ((condition as Filter[]).some((sub) => matchesFilter(doc, sub))) return false
			continue
		}
		if (key === "$expr") throw new Error("memory store: $expr is not supported")
		if (!matchCondition(getPath(doc, key), condition)) return false
	}
	return true
}

export function applyUpdate(doc: Record<string, unknown>, update: UpdateSpec, isInsert: boolean): void {
	for (const [op, payload] of Object.entries(update)) {
		if (!op.startsWith("$")) throw new Error("memory store: replacement updates are not supported")
		const fields = payload as Record<string, unknown>
		switch (op) {
			case "$set":
				for (const [path, value] of Object.entries(fields)) setPath(doc, path, clone(value))
				break
			case "$setOnInsert":
				if (isInsert) for (const [path, value] of Object.entries(fields)) setPath(doc, path, clone(value))
				break
			case "$unset":
				for (const path of Object.keys(fields)) unsetPath(doc, path)
				break
			case "$inc":
				for (const [path, value] of Object.entries(fields)) {
					const current = getPath(doc, path)
					setPath(doc, path, (typeof current === "number" ? current : 0) + Number(value))
				}
				break
			case "$min":
				for (const [path, value] of Object.entries(fields)) {
					const current = getPath(doc, path)
					if (current === undefined || compare(value, current) < 0) setPath(doc, path, clone(value))
				}
				break
			case "$max":
				for (const [path, value] of Object.entries(fields)) {
					const current = getPath(doc, path)
					if (current === undefined || compare(value, current) > 0) setPath(doc, path, clone(value))
				}
				break
			case "$currentDate":
				for (const path of Object.keys(fields)) setPath(doc, path, new Date())
				break
			case "$push":
				for (const [path, value] of Object.entries(fields)) {
					const current = getPath(doc, path)
					const arr = Array.isArray(current) ? current.slice() : []
					const spec = value as { $each?: unknown[]; $slice?: number }
					if (spec && typeof spec === "object" && Array.isArray(spec.$each)) {
						arr.push(...spec.$each.map((v) => clone(v)))
						if (typeof spec.$slice === "number") {
							const sliced = spec.$slice < 0 ? arr.slice(spec.$slice) : arr.slice(0, spec.$slice)
							setPath(doc, path, sliced)
							continue
						}
					} else {
						arr.push(clone(value))
					}
					setPath(doc, path, arr)
				}
				break
			case "$addToSet":
				for (const [path, value] of Object.entries(fields)) {
					const current = getPath(doc, path)
					const arr = Array.isArray(current) ? current.slice() : []
					const items =
						value && typeof value === "object" && Array.isArray((value as { $each?: unknown[] }).$each)
							? ((value as { $each: unknown[] }).$each)
							: [value]
					for (const item of items) if (!arr.some((a) => valueEquals(a, item))) arr.push(clone(item))
					setPath(doc, path, arr)
				}
				break
			case "$pull":
				for (const [path, value] of Object.entries(fields)) {
					const current = getPath(doc, path)
					if (!Array.isArray(current)) continue
					setPath(
						doc,
						path,
						current.filter((item) => !matchCondition(item, value)),
					)
				}
				break
			default:
				throw new Error(`memory store: unsupported update operator ${op}`)
		}
	}
}

/** Extracts an equality-only seed document for an upsert. */
function seedFromFilter(filter: Filter): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(filter)) {
		if (key.startsWith("$")) continue
		if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
			const entries = Object.entries(value as Record<string, unknown>)
			if (entries.every(([k]) => k.startsWith("$"))) {
				const eq = entries.find(([k]) => k === "$eq")
				if (eq) setPath(out, key, clone(eq[1]))
				continue
			}
		}
		setPath(out, key, clone(value))
	}
	return out
}

class MemoryCollection<T extends { _id: string }> implements Collection<T> {
	private docs = new Map<string, Record<string, unknown>>()
	private indexes: IndexSpec[] = []
	private counter = 0

	private uniqueGuard(candidate: Record<string, unknown>, ignoreId?: string): void {
		for (const index of this.indexes) {
			if (!index.unique) continue
			const fields = Object.keys(index.key)
			const values = fields.map((f) => getPath(candidate, f))
			if (index.sparse && values.some((v) => v === undefined || v === null)) continue
			if (index.partialFilterExpression && !matchesFilter(candidate, index.partialFilterExpression)) continue
			for (const [id, existing] of this.docs) {
				if (id === ignoreId) continue
				if (index.partialFilterExpression && !matchesFilter(existing, index.partialFilterExpression)) continue
				const same = fields.every((f, i) => valueEquals(getPath(existing, f), values[i]))
				if (same) throw new DuplicateKeyError(index.name)
			}
		}
	}

	private query(filter: Filter, options: FindOptions = {}): Array<Record<string, unknown>> {
		let rows = [...this.docs.values()].filter((doc) => matchesFilter(doc, filter))
		if (options.sort) {
			const entries = Object.entries(options.sort)
			rows = rows.slice().sort((a, b) => {
				for (const [field, direction] of entries) {
					const av = getPath(a, field)
					const bv = getPath(b, field)
					if (av === undefined && bv === undefined) continue
					if (av === undefined) return direction === 1 ? -1 : 1
					if (bv === undefined) return direction === 1 ? 1 : -1
					const cmp = compare(av, bv)
					if (cmp !== 0) return direction === 1 ? cmp : -cmp
				}
				return 0
			})
		}
		if (options.skip) rows = rows.slice(options.skip)
		if (options.limit !== undefined) rows = rows.slice(0, options.limit)
		return rows
	}

	private project(doc: Record<string, unknown>, projection?: Record<string, 0 | 1>): T {
		if (!projection) return clone(doc) as T
		const includes = Object.entries(projection).filter(([, v]) => v === 1).map(([k]) => k)
		const excludes = Object.entries(projection).filter(([, v]) => v === 0).map(([k]) => k)
		if (includes.length > 0) {
			const out: Record<string, unknown> = { _id: doc._id }
			for (const field of includes) {
				const value = getPath(doc, field)
				if (value !== undefined) setPath(out, field, clone(value))
			}
			return out as T
		}
		const out = clone(doc)
		for (const field of excludes) unsetPath(out, field)
		return out as T
	}

	async findOne(filter: Filter, options: FindOptions = {}): Promise<T | null> {
		const rows = this.query(filter, { ...options, limit: 1 })
		return rows.length === 0 ? null : this.project(rows[0], options.projection)
	}

	async find(filter: Filter, options: FindOptions = {}): Promise<T[]> {
		return this.query(filter, options).map((doc) => this.project(doc, options.projection))
	}

	async countDocuments(filter: Filter = {}): Promise<number> {
		return this.query(filter).length
	}

	async insertOne(doc: T): Promise<void> {
		const copy = clone(doc) as Record<string, unknown>
		if (!copy._id) copy._id = `mem_${++this.counter}_${Math.random().toString(36).slice(2, 8)}`
		if (this.docs.has(String(copy._id))) throw new DuplicateKeyError("_id")
		this.uniqueGuard(copy)
		this.docs.set(String(copy._id), copy)
	}

	async insertMany(docs: T[], ordered = true): Promise<number> {
		let inserted = 0
		for (const doc of docs) {
			try {
				await this.insertOne(doc)
				inserted++
			} catch (error) {
				if (ordered) throw error
			}
		}
		return inserted
	}

	async updateOne(filter: Filter, update: UpdateSpec, upsert = false): Promise<UpdateResult> {
		const rows = this.query(filter, { limit: 1 })
		if (rows.length === 0) {
			if (!upsert) return { matchedCount: 0, modifiedCount: 0, upsertedId: null }
			const seed = seedFromFilter(filter)
			if (!seed._id) seed._id = `mem_${++this.counter}_${Math.random().toString(36).slice(2, 8)}`
			applyUpdate(seed, update, true)
			this.uniqueGuard(seed)
			this.docs.set(String(seed._id), seed)
			return { matchedCount: 0, modifiedCount: 0, upsertedId: String(seed._id) }
		}
		const before = JSON.stringify(rows[0])
		const candidate = clone(rows[0])
		applyUpdate(candidate, update, false)
		this.uniqueGuard(candidate, String(rows[0]._id))
		this.docs.set(String(candidate._id), candidate)
		return {
			matchedCount: 1,
			modifiedCount: before === JSON.stringify(candidate) ? 0 : 1,
			upsertedId: null,
		}
	}

	async updateMany(filter: Filter, update: UpdateSpec): Promise<UpdateResult> {
		const rows = this.query(filter)
		let modified = 0
		for (const row of rows) {
			const before = JSON.stringify(row)
			const candidate = clone(row)
			applyUpdate(candidate, update, false)
			this.uniqueGuard(candidate, String(row._id))
			this.docs.set(String(candidate._id), candidate)
			if (before !== JSON.stringify(candidate)) modified++
		}
		return { matchedCount: rows.length, modifiedCount: modified, upsertedId: null }
	}

	async findOneAndUpdate(
		filter: Filter,
		update: UpdateSpec,
		options: { upsert?: boolean } = {},
	): Promise<T | null> {
		const rows = this.query(filter, { limit: 1 })
		if (rows.length === 0) {
			if (!options.upsert) return null
			const seed = seedFromFilter(filter)
			if (!seed._id) seed._id = `mem_${++this.counter}_${Math.random().toString(36).slice(2, 8)}`
			applyUpdate(seed, update, true)
			this.uniqueGuard(seed)
			this.docs.set(String(seed._id), seed)
			return clone(seed) as T
		}
		const candidate = clone(rows[0])
		applyUpdate(candidate, update, false)
		this.uniqueGuard(candidate, String(rows[0]._id))
		this.docs.set(String(candidate._id), candidate)
		return clone(candidate) as T
	}

	async deleteOne(filter: Filter): Promise<number> {
		const rows = this.query(filter, { limit: 1 })
		if (rows.length === 0) return 0
		this.docs.delete(String(rows[0]._id))
		return 1
	}

	async deleteMany(filter: Filter): Promise<number> {
		const rows = this.query(filter)
		for (const row of rows) this.docs.delete(String(row._id))
		return rows.length
	}

	async bulkWrite(ops: Array<BulkWriteOp<T>>, ordered = false): Promise<void> {
		for (const op of ops) {
			try {
				if ("insertOne" in op) await this.insertOne(op.insertOne.document)
				else if ("updateOne" in op) {
					await this.updateOne(op.updateOne.filter, op.updateOne.update, op.updateOne.upsert)
				} else if ("deleteOne" in op) await this.deleteOne(op.deleteOne.filter)
			} catch (error) {
				if (ordered) throw error
			}
		}
	}

	async distinct(field: string, filter: Filter = {}): Promise<unknown[]> {
		const seen: unknown[] = []
		for (const row of this.query(filter)) {
			const value = getPath(row, field)
			const items = Array.isArray(value) ? value : [value]
			for (const item of items) {
				if (item === undefined) continue
				if (!seen.some((s) => valueEquals(s, item))) seen.push(item)
			}
		}
		return seen
	}

	async createIndexes(specs: IndexSpec[]): Promise<void> {
		for (const spec of specs) {
			const existing = this.indexes.findIndex((i) => i.name === spec.name)
			if (existing === -1) this.indexes.push(spec)
			else this.indexes[existing] = spec
		}
	}

	async drop(): Promise<void> {
		this.docs.clear()
		this.indexes = []
	}
}

export class MemoryDatabase implements Database {
	readonly kind = "memory" as const
	private collections = new Map<string, MemoryCollection<{ _id: string }>>()

	collection<T extends { _id: string }>(name: string): Collection<T> {
		let existing = this.collections.get(name)
		if (!existing) {
			existing = new MemoryCollection<{ _id: string }>()
			this.collections.set(name, existing)
		}
		return existing as unknown as Collection<T>
	}

	async listCollections(): Promise<string[]> {
		return [...this.collections.keys()]
	}

	async ping(): Promise<boolean> {
		return true
	}

	async close(): Promise<void> {
		this.collections.clear()
	}

	/** Test helper. */
	reset(): void {
		this.collections.clear()
	}
}
