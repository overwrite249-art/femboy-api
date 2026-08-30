/** Time, deadline and abort helpers shared by the relay and the cron jobs. */

export function nowMs(): number {
	return Date.now()
}

export function nowSec(): number {
	return Math.floor(Date.now() / 1000)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"))
			return
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		function onAbort() {
			clearTimeout(timer)
			reject(new DOMException("Aborted", "AbortError"))
		}
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

/** Full jitter exponential backoff, capped. */
export function backoffDelayMs(attempt: number, baseMs = 200, capMs = 8_000): number {
	const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt))
	return Math.floor(Math.random() * exponential)
}

export class Deadline {
	readonly startedAt: number
	readonly budgetMs: number

	constructor(budgetMs: number) {
		this.startedAt = Date.now()
		this.budgetMs = budgetMs
	}

	get elapsedMs(): number {
		return Date.now() - this.startedAt
	}

	get remainingMs(): number {
		return Math.max(0, this.budgetMs - this.elapsedMs)
	}

	get expired(): boolean {
		return this.remainingMs <= 0
	}

	/** Remaining budget clamped to an upper bound (used for per-try timeouts). */
	sliceMs(maxMs: number): number {
		return Math.max(1, Math.min(maxMs, this.remainingMs))
	}
}

/**
 * Combines caller aborts with a local timeout and returns a signal plus a
 * `dispose()` that MUST be called to clear the timer, otherwise a serverless
 * invocation can be held open by a pending timeout (GW-004).
 */
export function withTimeout(
	timeoutMs: number,
	upstream?: AbortSignal | null,
): { signal: AbortSignal; dispose: () => void; controller: AbortController } {
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
		controller.abort(new DOMException("Timeout", "TimeoutError"))
	}, Math.max(1, timeoutMs))

	const onUpstreamAbort = () => controller.abort(upstream?.reason)
	if (upstream) {
		if (upstream.aborted) controller.abort(upstream.reason)
		else upstream.addEventListener("abort", onUpstreamAbort, { once: true })
	}

	const dispose = () => {
		if (timer !== null) {
			clearTimeout(timer)
			timer = null
		}
		upstream?.removeEventListener("abort", onUpstreamAbort)
	}

	return { signal: controller.signal, dispose, controller }
}

/** Resolves the promise or rejects with a TimeoutError. Always clears its timer. */
export async function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new DOMException(`${label} timed out after ${ms}ms`, "TimeoutError")),
					ms,
				)
			}),
		])
	} finally {
		if (timer !== null) clearTimeout(timer)
	}
}

/** UTC `YYYYMM` bucket used to shard usage collections (Mongo "partitions"). */
export function monthBucket(date: Date = new Date()): string {
	const y = date.getUTCFullYear()
	const m = `${date.getUTCMonth() + 1}`.padStart(2, "0")
	return `${y}${m}`
}

export function addMonths(date: Date, months: number): Date {
	const next = new Date(date.getTime())
	next.setUTCMonth(next.getUTCMonth() + months)
	return next
}

export function startOfUtcDay(date: Date = new Date()): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export function startOfUtcHour(date: Date = new Date()): Date {
	return new Date(
		Date.UTC(
			date.getUTCFullYear(),
			date.getUTCMonth(),
			date.getUTCDate(),
			date.getUTCHours(),
		),
	)
}
