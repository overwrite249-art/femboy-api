/**
 * Durable, cross-instance coordination using MongoDB only.
 *
 * Named limiter programs run inside majority-committed Mongo transactions.
 * Small scalar/hash/sorted-set values use the same deterministic interpreter
 * as the tested Redis twin, but its state is loaded and committed on EVERY
 * operation: no authority or pending work lives in process memory.
 *
 * Lists are separate item documents, not growing BSON arrays. Their metadata
 * document serializes append/trim/pop operations and owner-checked acks.
 */
import { createHash, randomInt } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { getDb } from "../db/index.ts"
import { DuplicateKeyError, type Database } from "../db/driver.ts"
import { ConfigurationError, isProduction } from "../config/env.ts"
import { MemoryRedis, type ValueSnapshot } from "./memory.ts"
import type { RedisLike } from "./client.ts"
import type { ScriptName } from "./lua.ts"
import { executeScriptProgram } from "./scripts.ts"
import { randomHex } from "../util/crypto.ts"

export const COORDINATION_KEYS = "coordination_keys"
export const COORDINATION_ITEMS = "coordination_items"
const MAX_VALUE_BYTES = 1024 * 1024
const MAX_LIST_READ = 1000
const VALUE_COMMANDS = new Set([
	"GET", "SET", "SETEX", "INCR", "INCRBY", "DECR", "DECRBY",
	"HSET", "HGET", "HMGET", "HGETALL", "HINCRBY", "HDEL",
	"ZADD", "ZCARD", "ZREM", "ZREMRANGEBYSCORE", "ZRANGE",
])
const READ_COMMANDS = new Set(["GET", "HGET", "HMGET", "HGETALL", "ZCARD", "ZRANGE"])
const LIST_COMMANDS = new Set(["RPUSH", "LPUSH", "LRANGE", "LLEN", "LTRIM", "LPOP"])

type KeyDoc = {
	_id: string
	kind: "value" | "list"
	expiresAt: Date | null
	snapshot?: ValueSnapshot
	head?: number
	tail?: number
	generation?: string
}
type ListItem = { _id: string; key: string; generation: string; position: number; value: string; expiresAt: Date | null }

function integer(value: string | undefined): number {
	const parsed = Number(value)
	if (value === undefined || !Number.isSafeInteger(parsed)) throw new Error("invalid coordination integer")
	return parsed
}
function bounded(value: unknown): void {
	if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_VALUE_BYTES) {
		throw new Error("coordination value exceeds the safe size limit")
	}
}
function range(length: number, from: number, to: number): [number, number] {
	const first = Math.max(0, from < 0 ? length + from : from)
	const last = Math.min(length - 1, to < 0 ? length + to : to)
	return [first, last]
}

class TransactionCommands {
	private db: Database
	constructor(db: Database) { this.db = db }

	private async load(key: string): Promise<KeyDoc | null> {
		const keys = this.db.collection<KeyDoc>(COORDINATION_KEYS)
		const record = await keys.findOne({ _id: key })
		if (record?.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
			await this.remove(key)
			return null
		}
		return record
	}

	private async remove(key: string): Promise<void> {
		await this.db.collection<KeyDoc>(COORDINATION_KEYS).deleteOne({ _id: key })
		await this.db.collection<ListItem>(COORDINATION_ITEMS).deleteMany({ key })
	}

	private async save(record: KeyDoc): Promise<void> {
		const { _id, ...value } = record
		await this.db.collection<KeyDoc>(COORDINATION_KEYS).updateOne({ _id }, { $set: value }, true)
	}

	async command(args: Array<string | number>): Promise<unknown> {
		if (!args.length || args.length > 4096) throw new Error("invalid coordination command")
		bounded(args)
		const a = args.map(String)
		const verb = a[0].toUpperCase()
		if (verb === "PING") {
			await this.db.collection<KeyDoc>(COORDINATION_KEYS).findOne({ _id: "__health_probe__" })
			return "PONG"
		}
		if (a[1] === undefined || a[1].length > 512) throw new Error("invalid coordination key")
		if (verb === "DEL" || verb === "EXISTS") {
			let found = 0
			for (const key of new Set(a.slice(1))) {
				if (await this.load(key)) found++
				if (verb === "DEL") await this.remove(key)
			}
			return found
		}
		if (!VALUE_COMMANDS.has(verb) && !LIST_COMMANDS.has(verb) && !["TTL", "EXPIRE", "PEXPIRE"].includes(verb)) {
			throw new Error("unsupported coordination command")
		}
		const key = a[1]
		let record = await this.load(key)
		let replacedList = false
		if (verb === "TTL") {
			return !record ? -2 : !record.expiresAt ? -1 : Math.ceil((new Date(record.expiresAt).getTime() - Date.now()) / 1000)
		}
		if (verb === "EXPIRE" || verb === "PEXPIRE") {
			if (!record) return 0
			const duration = integer(a[2]) * (verb === "EXPIRE" ? 1000 : 1)
			if (duration <= 0) { await this.remove(key); return 1 }
			record.expiresAt = new Date(Date.now() + duration)
			if (Number.isNaN(record.expiresAt.getTime())) throw new Error("invalid coordination expiry")
			if (record.snapshot) record.snapshot.expiresAt = record.expiresAt.getTime()
			await this.save(record)
			if (record.kind === "list") await this.db.collection<ListItem>(COORDINATION_ITEMS).updateMany(
				{ key, generation: record.generation }, { $set: { expiresAt: record.expiresAt } },
			)
			return 1
		}
		if (LIST_COMMANDS.has(verb)) return this.list(verb, a, record)
		if (record?.kind === "list") {
			if (verb !== "SET" && verb !== "SETEX") throw new Error("coordination value has the wrong type")
			if (verb === "SET" && a.slice(3).some((item) => item.toUpperCase() === "NX")) return null
			await this.remove(key)
			replacedList = true
			record = null
		}
		const interpreter = new MemoryRedis()
		if (record?.snapshot) interpreter.importValue(key, record.snapshot)
		else if (replacedList) interpreter.importValue(key, { type: "scalar", value: "", expiresAt: null })
		const result = await interpreter.command(args)
		if (!READ_COMMANDS.has(verb)) {
			const snapshot = interpreter.exportValue(key)
			if (!snapshot) await this.remove(key)
			else {
				bounded(snapshot)
				await this.save({ _id: key, kind: "value", snapshot,
					expiresAt: snapshot.expiresAt === null ? null : new Date(snapshot.expiresAt) })
			}
		}
		return result
	}

	private async list(verb: string, a: string[], record: KeyDoc | null): Promise<unknown> {
		const key = a[1]
		if (record && record.kind !== "list") throw new Error("coordination value has the wrong type")
		const rows = this.db.collection<ListItem>(COORDINATION_ITEMS)
		if (!record) record = { _id: key, kind: "list", expiresAt: null, head: 0, tail: -1, generation: randomHex(16) }
		let head = record.head ?? 0
		let tail = record.tail ?? -1
		const generation = record.generation!
		const filter = { key, generation }
		const length = Math.max(0, tail - head + 1)
		if (verb === "LLEN") return length
		if (verb === "RPUSH" || verb === "LPUSH") {
			if (a.length < 3) throw new Error("list push requires a value")
			for (const value of a.slice(2)) {
				const position = verb === "RPUSH" ? ++tail : --head
				if (!Number.isSafeInteger(position)) throw new Error("coordination queue position overflow")
				const _id = createHash("sha256").update(`${key}\0${generation}\0${position}`).digest("hex")
				await rows.insertOne({ _id, key, generation, position, value, expiresAt: record.expiresAt })
			}
			await this.save({ ...record, head, tail })
			return tail - head + 1
		}
		if (verb === "LPOP") {
			const count = a[2] === undefined ? 1 : integer(a[2])
			if (count < 0 || count > MAX_LIST_READ) throw new Error("list pop count is outside the safe limit")
			if (!length || count === 0) return a[2] === undefined ? null : []
			const taken = Math.min(count, length)
			const found = await rows.find({ ...filter, position: { $gte: head, $lt: head + taken } },
				{ sort: { position: 1 }, limit: taken })
			if (found.length !== taken) throw new Error("coordination queue is inconsistent")
			await rows.deleteMany({ ...filter, position: { $lt: head + taken } })
			head += taken
			if (head > tail) await this.remove(key)
			else await this.save({ ...record, head, tail })
			return a[2] === undefined ? found[0]?.value ?? null : found.map((row) => row.value)
		}
		const [first, last] = range(length, integer(a[2]), integer(a[3]))
		if (verb === "LRANGE") {
			if (first > last) return []
			const size = last - first + 1
			if (size > MAX_LIST_READ) throw new Error("list read exceeds the safe limit; use batches")
			const found = await rows.find({ ...filter, position: { $gte: head + first, $lte: head + last } },
				{ sort: { position: 1 }, limit: size })
			if (found.length !== size) throw new Error("coordination queue is inconsistent")
			return found.map((row) => row.value)
		}
		if (first > last) { await this.remove(key); return "OK" }
		const newHead = head + first
		const newTail = head + last
		await rows.deleteMany({ ...filter, $or: [{ position: { $lt: newHead } }, { position: { $gt: newTail } }] })
		await this.save({ ...record, head: newHead, tail: newTail })
		return "OK"
	}
}

export class MongoCoordinator implements RedisLike {
	readonly kind = "mongo" as const

	private async atomic<T>(work: (commands: TransactionCommands) => Promise<T>): Promise<T> {
		const db = await getDb()
		if (isProduction() && db.kind !== "mongo") throw new ConfigurationError("production coordination requires durable MongoDB")
		// Concurrent first inserts can raise duplicate-key rather than a labelled
		// write conflict; retry the complete transaction, never a partial script.
		for (let attempt = 0; ; attempt++) {
			try {
				return await db.transaction((tx) => work(new TransactionCommands(tx)))
			} catch (error) {
				if (attempt >= 7 || !DuplicateKeyError.is(error)) throw error
				await sleep(Math.min(250, 5 * 2 ** attempt) + randomInt(10))
			}
		}
	}

	command(args: Array<string | number>): Promise<unknown> {
		return this.atomic((commands) => commands.command(args))
	}

	pipeline(batch: Array<Array<string | number>>): Promise<unknown[]> {
		if (batch.length > 1000) return Promise.reject(new Error("coordination pipeline is too large"))
		return this.atomic(async (commands) => {
			const result: unknown[] = []
			for (const command of batch) result.push(await commands.command(command))
			return result
		})
	}

	runScript(name: ScriptName, keys: string[], args: Array<string | number>): Promise<number[]> {
		return this.atomic((commands) => executeScriptProgram(commands, name, keys, args))
	}
}