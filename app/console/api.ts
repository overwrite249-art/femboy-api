"use client"

/*
 * The console's only way of talking to the gateway.
 *
 * Two rules are enforced here rather than at each call site, because a call
 * site that forgets either one fails in a way that looks like a server bug:
 *
 *   1. Cookies are sent, so the browser's session authenticates the request.
 *   2. Every unsafe method carries the CSRF token as a *header*. The server
 *      deliberately does not accept the cookie copy as proof of itself.
 */

export const CSRF_COOKIE = "fb_csrf"
export const CSRF_HEADER = "x-csrf-token"

function readCookie(name: string): string {
	if (typeof document === "undefined") return ""
	const prefix = name + "="
	for (const part of document.cookie.split("; ")) {
		if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length))
	}
	return ""
}

export class ApiError extends Error {
	status: number
	code: string

	constructor(status: number, code: string, message: string) {
		super(message)
		this.name = "ApiError"
		this.status = status
		this.code = code
	}
}

type ErrorEnvelope = { error?: { message?: string; code?: string } }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {}
	if (body !== undefined) headers["content-type"] = "application/json"

	const unsafe = method !== "GET" && method !== "HEAD"
	if (unsafe) {
		const csrf = readCookie(CSRF_COOKIE)
		if (csrf) headers[CSRF_HEADER] = csrf
	}

	const response = await fetch(path, {
		method,
		headers,
		credentials: "same-origin",
		body: body === undefined ? undefined : JSON.stringify(body),
	})

	const text = await response.text()
	let parsed: unknown = null
	if (text.length > 0) {
		try {
			parsed = JSON.parse(text)
		} catch {
			parsed = null
		}
	}

	if (!response.ok) {
		const envelope = (parsed ?? {}) as ErrorEnvelope
		throw new ApiError(
			response.status,
			envelope.error?.code ?? "request_failed",
			envelope.error?.message ?? "the request was refused",
		)
	}

	return parsed as T
}

export const api = {
	get: function get<T>(path: string): Promise<T> {
		return request<T>("GET", path)
	},
	post: function post<T>(path: string, body?: unknown): Promise<T> {
		return request<T>("POST", path, body)
	},
	patch: function patch<T>(path: string, body?: unknown): Promise<T> {
		return request<T>("PATCH", path, body)
	},
	remove: function remove<T>(path: string): Promise<T> {
		return request<T>("DELETE", path)
	},
}

export type ConsoleUser = {
	id: string
	username: string
	displayName?: string
	role: string
	status?: string
	group?: string
	quota?: number
	usedQuota?: number
}

export async function loadSession(): Promise<ConsoleUser | null> {
	try {
		const body = await api.get<{ user: ConsoleUser | null }>("/api/auth/session")
		return body.user ?? null
	} catch {
		return null
	}
}

export async function signOut(): Promise<void> {
	try {
		await api.post("/api/auth/logout")
	} catch {
		// Signing out is best-effort: the cookie is cleared either way.
	}
}
