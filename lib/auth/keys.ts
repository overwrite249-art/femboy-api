/**
 * API key format, generation and verification.
 *
 *   sk-<8 char prefix><40+ char secret>[-directive[-value]]...
 *
 * The prefix is public and indexed; it is how a key is located without
 * revealing anything useful. The secret is never stored - only
 * SHA-256(pepper : prefix : secret). Rotating KEY_PEPPER invalidates every key
 * at once, which is the intended break-glass response to a database leak.
 *
 * Trailing hyphen-separated segments are per-request directives. They travel
 * inside the credential so a client can express routing intent through SDKs
 * that offer no way to add headers.
 */

import { config } from "../config/env.ts"
import { randomAlphanumeric, sha256Hex } from "../util/crypto.ts"

export const KEY_SCHEME = "sk"
export const KEY_PREFIX_LENGTH = 8
export const KEY_SECRET_LENGTH = 48

/** Hard input ceiling. Bounded input keeps every parser below linear-time. */
export const MAX_KEY_INPUT = 512
const MAX_BODY_LENGTH = 128
const MAX_DIRECTIVES = 8

/** Anchored, bounded, no alternation: cannot backtrack (GW-021). */
const KEY_BODY_PATTERN = /^([A-Za-z0-9]{8})([A-Za-z0-9]{40,})$/
const DIRECTIVE_VALUE_PATTERN = /^[A-Za-z0-9_]{1,64}$/

/** Directives that consume the following segment as their value. */
const VALUE_DIRECTIVES = new Set(["ch", "channel", "g", "group", "retry", "tier", "region"])

export type KeyDirectives = {
	/** Pin the request to one channel. Honoured for admins only. */
	channelId?: string
	/** Override the billing/routing group. Must be a group the user may use. */
	group?: string
	/** Lower the retry ceiling for this request. Never raises it. */
	retry?: number
	tier?: string
	region?: string
	/** Valueless directives, lowercased. */
	flags: string[]
}

export type ParsedKey = {
	prefix: string
	secret: string
	directives: KeyDirectives
}

export type GeneratedKey = {
	/** The only moment the full credential exists. Show once, never store. */
	key: string
	prefix: string
	secret: string
	last4: string
	digest: string
}

function emptyDirectives(): KeyDirectives {
	return { flags: [] }
}

function parseDirectives(segments: string[]): KeyDirectives {
	const out = emptyDirectives()
	let consumed = 0
	let i = 0
	while (i < segments.length && consumed < MAX_DIRECTIVES) {
		consumed++
		const name = segments[i].toLowerCase()
		if (!VALUE_DIRECTIVES.has(name)) {
			if (name.length > 0 && DIRECTIVE_VALUE_PATTERN.test(name)) out.flags.push(name)
			i += 1
			continue
		}
		const value = i + 1 < segments.length ? segments[i + 1] : ""
		i += 2
		if (!DIRECTIVE_VALUE_PATTERN.test(value)) continue
		switch (name) {
			case "ch":
			case "channel":
				out.channelId = value
				break
			case "g":
			case "group":
				out.group = value
				break
			case "retry": {
				const n = Number(value)
				if (Number.isInteger(n) && n >= 0 && n <= 10) out.retry = n
				break
			}
			case "tier":
				out.tier = value
				break
			case "region":
				out.region = value
				break
		}
	}
	return out
}

/**
 * Splits a credential into prefix, secret and directives.
 * Returns null for anything that is not shaped like one of our keys - the
 * caller must still perform a dummy hash so the rejection is not faster than
 * a real verification.
 */
export function parseApiKey(raw: string): ParsedKey | null {
	if (typeof raw !== "string") return null
	const trimmed = raw.trim()
	const minimum = KEY_SCHEME.length + 1 + KEY_PREFIX_LENGTH + 40
	if (trimmed.length < minimum || trimmed.length > MAX_KEY_INPUT) return null

	const segments = trimmed.split("-")
	if (segments.length < 2) return null
	if (segments[0] !== KEY_SCHEME) return null

	const body = segments[1]
	if (body.length > MAX_BODY_LENGTH) return null
	const match = KEY_BODY_PATTERN.exec(body)
	if (!match) return null

	return {
		prefix: match[1],
		secret: match[2],
		directives: parseDirectives(segments.slice(2)),
	}
}

/**
 * The stored verifier. Peppered so that a database dump alone is not enough to
 * mount an offline search, and domain-separated by prefix so two keys that
 * somehow share a secret still produce different digests.
 */
export async function digestApiKey(prefix: string, secret: string): Promise<string> {
	return sha256Hex(`${config.keyPepper}:${prefix}:${secret}`)
}

export async function generateApiKey(): Promise<GeneratedKey> {
	const prefix = randomAlphanumeric(KEY_PREFIX_LENGTH)
	const secret = randomAlphanumeric(KEY_SECRET_LENGTH)
	return {
		key: `${KEY_SCHEME}-${prefix}${secret}`,
		prefix,
		secret,
		last4: secret.slice(-4),
		digest: await digestApiKey(prefix, secret),
	}
}

/** Display form for the console and for logs: sk-abcd1234...WXYZ */
export function maskKey(prefix: string, last4: string): string {
	return `${KEY_SCHEME}-${prefix}...${last4}`
}

/**
 * Matches a model against an allowlist entry. A single trailing `*` is the
 * only wildcard, so entries cannot be crafted into expensive patterns.
 */
export function modelMatches(pattern: string, model: string): boolean {
	if (pattern === "*") return true
	if (pattern.endsWith("*")) return model.startsWith(pattern.slice(0, -1))
	return pattern === model
}
