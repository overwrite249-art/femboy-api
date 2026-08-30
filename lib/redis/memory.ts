/**
 * In-process Redis twin.
 *
 * Used by `node --test`, by the local harness and as an automatic fallback
 * when Upstash credentials are absent. JavaScript's single-threaded event loop
 * gives every `command()` the same atomicity guarantee a Lua script has on the
 * real server, so the quota and limiter semantics are identical - only the
 * durability and cross-instance sharing are not.
 */

type Entry = {
	value: string | Map<string, string> | Array<string> | Array<{ score: number; member: string }>
	expiresAt: number | null
}

export class MemoryRedis {
	readonly kind = "memory" as const
	private store = new Map<string, Entry>()

	// -- housekeeping --------------------------------------------------------

	private live(key: string): Entry | undefined {
		const entry = this.store.get(key)
		if (!entry) return undefined
		if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
			this.store.delete(key)
			return undefined
		}
		return entry
	}

	private str(key: string): string | null {
		const entry = this.live(key)
		if (!entry) return null
		return typeof entry.value === "string" ? entry.value : null
	}

	private hash(key: string, create = false): Map<string, string> | null {
		const entry = this.live(key)
		if (entry && entry.value instanceof Map) return entry.value
		if (entry && !(entry.value instanceof Map)) return null
		if (!create) return null
		const map = new Map<string, string>()
		this.store.set(key, { value: map, expiresAt: null })
		return map
	}

	private list(key: string, create = false): string[] | null {
		const entry = this.live(key)
		if (entry && Array.isArray(entry.value) && (entry.value.length === 0 || typeof entry.value[0] === "string")) {
			return entry.value as string[]
		}
		if (entry) return null
		if (!create) return null
		const arr: string[] = []
		this.store.set(key, { value: arr, expiresAt: null })
		return arr
	}

	private zset(key: string, create = false): Array<{ score: number; member: string }> | null {
		const entry = this.live(key)
		if (entry && Array.isArray(entry.value)) {
			if (entry.value.length === 0 || typeof entry.value[0] === "object") {
				return entry.value as Array<{ score: number; member: string }>
			}
			return null
		}
		if (entry) return null
		if (!create) return null
		const arr: Array<{ score: number; member: string }> = []
		this.store.set(key, { value: arr, expiresAt: null })
		return arr
	}

	private setTtl(key: string, seconds: number): void {
		const entry = this.store.get(key)
		if (!entry) return
		entry.expiresAt = Date.now() + seconds * 1000
	}

	/** Test helper: wipe everything. */
	flushall(): void {
		this.store.clear()
	}

	/** Test helper: inspect raw keys. */
	keys(pattern = "*"): string[] {
		const re = new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`)
		const out: string[] = []
		for (const key of [...this.store.keys()]) {
			if (this.live(key) && re.test(key)) out.push(key)
		}
		return out
	}

	// -- command dispatch ----------------------------------------------------

	async command(args: Array<string | number>): Promise<unknown> {
		const verb = String(args[0] ?? "").toUpperCase()
		const a = args.map((x) => String(x))
		switch (verb) {
			case "PING":
				return "PONG"
			case "GET":
				return this.str(a[1])
			case "SET": {
				const key = a[1]
				const value = a[2]
				const upper = a.slice(3).map((x) => x.toUpperCase())
				const nx = upper.includes("NX")
				const xx = upper.includes("XX")
				const exists = this.live(key) !== undefined
				if (nx && exists) return null
				if (xx && !exists) return null
				this.store.set(key, { value, expiresAt: null })
				const exIdx = upper.indexOf("EX")
				if (exIdx !== -1) this.setTtl(key, Number(a[3 + exIdx + 1]))
				const pxIdx = upper.indexOf("PX")
				if (pxIdx !== -1) {
					const entry = this.store.get(key)
					if (entry) entry.expiresAt = Date.now() + Number(a[3 + pxIdx + 1])
				}
				return "OK"
			}
			case "SETEX": {
				this.store.set(a[1], { value: a[3], expiresAt: Date.now() + Number(a[2]) * 1000 })
				return "OK"
			}
			case "DEL": {
				let n = 0
				for (const key of a.slice(1)) {
					if (this.live(key) !== undefined) n++
					this.store.delete(key)
				}
				return n
			}
			case "EXISTS": {
				let n = 0
				for (const key of a.slice(1)) if (this.live(key) !== undefined) n++
				return n
			}
			case "EXPIRE":
				if (this.live(a[1]) === undefined) return 0
				this.setTtl(a[1], Number(a[2]))
				return 1
			case "PEXPIRE": {
				const entry = this.live(a[1])
				if (!entry) return 0
				entry.expiresAt = Date.now() + Number(a[2])
				return 1
			}
			case "TTL": {
				const entry = this.live(a[1])
				if (!entry) return -2
				if (entry.expiresAt === null) return -1
				return Math.ceil((entry.expiresAt - Date.now()) / 1000)
			}
			case "INCR":
				return this.incrBy(a[1], 1)
			case "INCRBY":
				return this.incrBy(a[1], Number(a[2]))
			case "DECRBY":
				return this.incrBy(a[1], -Number(a[2]))
			case "DECR":
				return this.incrBy(a[1], -1)
			case "HSET": {
				const map = this.hash(a[1], true)
				if (!map) return 0
				let added = 0
				for (let i = 2; i + 1 < a.length; i += 2) {
					if (!map.has(a[i])) added++
					map.set(a[i], a[i + 1])
				}
				return added
			}
			case "HGET": {
				const map = this.hash(a[1])
				const v = map?.get(a[2])
				return v === undefined ? null : v
			}
			case "HMGET": {
				const map = this.hash(a[1])
				return a.slice(2).map((f) => map?.get(f) ?? null)
			}
			case "HGETALL": {
				const map = this.hash(a[1])
				if (!map) return {}
				const out: Record<string, string> = {}
				for (const [k, v] of map) out[k] = v
				return out
			}
			case "HINCRBY": {
				const map = this.hash(a[1], true)
				if (!map) return 0
				const next = Number(map.get(a[2]) ?? "0") + Number(a[3])
				map.set(a[2], String(next))
				return next
			}
			case "HDEL": {
				const map = this.hash(a[1])
				if (!map) return 0
				let n = 0
				for (const f of a.slice(2)) if (map.delete(f)) n++
				return n
			}
			case "RPUSH": {
				const list = this.list(a[1], true)
				if (!list) return 0
				list.push(...a.slice(2))
				return list.length
			}
			case "LPUSH": {
				const list = this.list(a[1], true)
				if (!list) return 0
				list.unshift(...a.slice(2))
				return list.length
			}
			case "LRANGE": {
				const list = this.list(a[1]) ?? []
				const start = Number(a[2])
				const stop = Number(a[3])
				const end = stop < 0 ? list.length + stop + 1 : stop + 1
				return list.slice(start < 0 ? list.length + start : start, end)
			}
			case "LLEN":
				return (this.list(a[1]) ?? []).length
			case "LTRIM": {
				const list = this.list(a[1])
				if (!list) return "OK"
				const start = Number(a[2])
				const stop = Number(a[3])
				const end = stop < 0 ? list.length + stop + 1 : stop + 1
				const kept = list.slice(start < 0 ? list.length + start : start, end)
				list.length = 0
				list.push(...kept)
				return "OK"
			}
			case "LPOP": {
				const list = this.list(a[1])
				if (!list || list.length === 0) return null
				const count = a[2] === undefined ? 1 : Number(a[2])
				const taken = list.splice(0, count)
				return a[2] === undefined ? taken[0] ?? null : taken
			}
			case "ZADD": {
				const z = this.zset(a[1], true)
				if (!z) return 0
				let added = 0
				for (let i = 2; i + 1 < a.length; i += 2) {
					const score = Number(a[i])
					const member = a[i + 1]
					const existing = z.find((e) => e.member === member)
					if (existing) existing.score = score
					else {
						z.push({ score, member })
						added++
					}
				}
				z.sort((x, y) => x.score - y.score)
				return added
			}
			case "ZCARD":
				return (this.zset(a[1]) ?? []).length
			case "ZREMRANGEBYSCORE": {
				const z = this.zset(a[1])
				if (!z) return 0
				const min = a[2] === "-inf" ? Number.NEGATIVE_INFINITY : Number(a[2])
				const max = a[3] === "+inf" ? Number.POSITIVE_INFINITY : Number(a[3])
				const before = z.length
				const kept = z.filter((e) => e.score < min || e.score > max)
				z.length = 0
				z.push(...kept)
				return before - z.length
			}
			case "ZRANGE": {
				const z = this.zset(a[1]) ?? []
				const start = Number(a[2])
				const stop = Number(a[3])
				const end = stop < 0 ? z.length + stop + 1 : stop + 1
				return z.slice(start < 0 ? z.length + start : start, end).map((e) => e.member)
			}
			case "SCAN": {
				// Minimal MATCH-only implementation; cursor is always 0 (one shot).
				const matchIdx = a.findIndex((x) => x.toUpperCase() === "MATCH")
				const pattern = matchIdx === -1 ? "*" : a[matchIdx + 1]
				return ["0", this.keys(pattern)]
			}
			default:
				throw new Error(`MemoryRedis: unsupported command ${verb}`)
		}
	}

	private incrBy(key: string, delta: number): number {
		const current = Number(this.str(key) ?? "0")
		const next = current + delta
		const existing = this.store.get(key)
		this.store.set(key, { value: String(next), expiresAt: existing?.expiresAt ?? null })
		return next
	}

	async pipeline(commands: Array<Array<string | number>>): Promise<unknown[]> {
		const out: unknown[] = []
		for (const cmd of commands) out.push(await this.command(cmd))
		return out
	}
}

function escapeRe(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
