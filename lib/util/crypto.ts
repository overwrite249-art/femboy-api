/**
 * Crypto helpers built exclusively on WebCrypto so the same code runs on the
 * Edge runtime, the Node runtime and inside `node --test`.
 *
 * Nothing in here ever logs or returns raw key material.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function subtle(): SubtleCrypto {
	const c = globalThis.crypto
	if (!c || !c.subtle) {
		throw new Error("WebCrypto is unavailable in this runtime")
	}
	return c.subtle
}

export function bytesToHex(bytes: Uint8Array): string {
	let out = ""
	for (let i = 0; i < bytes.length; i++) {
		out += bytes[i].toString(16).padStart(2, "0")
	}
	return out
}

export function hexToBytes(hex: string): Uint8Array {
	const clean = hex.length % 2 === 0 ? hex : `0${hex}`
	const out = new Uint8Array(clean.length / 2)
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0
	}
	return out
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = ""
	const chunk = 0x8000
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
	}
	return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

export function base64UrlEncode(bytes: Uint8Array): string {
	return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64UrlDecode(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/")
	const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
	return base64ToBytes(padded + pad)
}

export function randomBytes(length: number): Uint8Array {
	const out = new Uint8Array(length)
	globalThis.crypto.getRandomValues(out)
	return out
}

export function randomHex(byteLength: number): string {
	return bytesToHex(randomBytes(byteLength))
}

const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

/** Rejection-sampled alphanumeric string (no modulo bias). */
export function randomAlphanumeric(length: number): string {
	const out: string[] = []
	const limit = 256 - (256 % ALPHANUM.length)
	while (out.length < length) {
		const buf = randomBytes(Math.max(16, length * 2))
		for (let i = 0; i < buf.length && out.length < length; i++) {
			const byte = buf[i]
			if (byte >= limit) continue
			out.push(ALPHANUM[byte % ALPHANUM.length])
		}
	}
	return out.join("")
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
	const data = typeof input === "string" ? encoder.encode(input) : input
	const digest = await subtle().digest("SHA-256", data as BufferSource)
	return bytesToHex(new Uint8Array(digest))
}

export async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
	const data = typeof input === "string" ? encoder.encode(input) : input
	const digest = await subtle().digest("SHA-256", data as BufferSource)
	return new Uint8Array(digest)
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const key = await subtle().importKey(
		"raw",
		encoder.encode(secret) as BufferSource,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	)
	const sig = await subtle().sign("HMAC", key, encoder.encode(message) as BufferSource)
	return bytesToHex(new Uint8Array(sig))
}

/**
 * Constant-time comparison of two hex strings.
 *
 * Length is compared without an early return: unequal lengths still walk the
 * full loop so an attacker cannot learn the digest length from timing.
 * (Closes GW-010 / GW-026 together with the auth latency floor.)
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
	const len = Math.max(a.length, b.length)
	let diff = a.length ^ b.length
	for (let i = 0; i < len; i++) {
		const ca = i < a.length ? a.charCodeAt(i) : 0
		const cb = i < b.length ? b.charCodeAt(i) : 0
		diff |= ca ^ cb
	}
	return diff === 0
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
	const len = Math.max(a.length, b.length)
	let diff = a.length ^ b.length
	for (let i = 0; i < len; i++) {
		diff |= (i < a.length ? a[i] : 0) ^ (i < b.length ? b[i] : 0)
	}
	return diff === 0
}

// ---------------------------------------------------------------------------
// AES-256-GCM envelope used for upstream channel credentials at rest (GW-002)
// ---------------------------------------------------------------------------

export type SealedSecret = {
	/** base64 ciphertext without the auth tag */
	cipher: string
	/** base64 96-bit nonce */
	iv: string
	/** base64 128-bit GCM tag */
	authTag: string
	/** master key version used, so keys can be rotated without downtime */
	keyVersion: number
	/** non-reversible fingerprint for dedupe / display (first 16 hex chars) */
	fingerprint: string
}

async function deriveMasterKey(master: string, version: number, usage: KeyUsage[]): Promise<CryptoKey> {
	if (!master) throw new Error("CHANNEL_KEY_MASTER is not configured")
	// The master value is an arbitrary-length secret; hash it to exactly 256 bits
	// and bind the key version into the derivation so v1 material cannot decrypt
	// v2 ciphertext (and vice versa).
	const material = await sha256Bytes(`fbapi:channel-key:v${version}:${master}`)
	return subtle().importKey("raw", material as BufferSource, { name: "AES-GCM" }, false, usage)
}

export async function sealSecret(
	plaintext: string,
	master: string,
	version: number,
): Promise<SealedSecret> {
	const key = await deriveMasterKey(master, version, ["encrypt"])
	const iv = randomBytes(12)
	const combined = new Uint8Array(
		(await subtle().encrypt(
			{ name: "AES-GCM", iv: iv as BufferSource, tagLength: 128 },
			key,
			encoder.encode(plaintext) as BufferSource,
		)) as ArrayBuffer,
	)
	const tagStart = combined.length - 16
	return {
		cipher: bytesToBase64(combined.subarray(0, tagStart)),
		iv: bytesToBase64(iv),
		authTag: bytesToBase64(combined.subarray(tagStart)),
		keyVersion: version,
		fingerprint: (await sha256Hex(`fp:${plaintext}`)).slice(0, 16),
	}
}

export async function openSecret(sealed: SealedSecret, master: string): Promise<string> {
	const key = await deriveMasterKey(master, sealed.keyVersion, ["decrypt"])
	const cipher = base64ToBytes(sealed.cipher)
	const tag = base64ToBytes(sealed.authTag)
	const combined = new Uint8Array(cipher.length + tag.length)
	combined.set(cipher, 0)
	combined.set(tag, cipher.length)
	const plain = await subtle().decrypt(
		{ name: "AES-GCM", iv: base64ToBytes(sealed.iv) as BufferSource, tagLength: 128 },
		key,
		combined as BufferSource,
	)
	return decoder.decode(plain)
}

/** Re-encrypts a sealed secret under a new master key version. */
export async function rotateSecret(
	sealed: SealedSecret,
	oldMaster: string,
	newMaster: string,
	newVersion: number,
): Promise<SealedSecret> {
	const plaintext = await openSecret(sealed, oldMaster)
	return sealSecret(plaintext, newMaster, newVersion)
}

// ---------------------------------------------------------------------------
// Signed, opaque session tokens (no third-party JWT dependency)
// ---------------------------------------------------------------------------

export type SignedPayload = Record<string, unknown> & { exp: number }

export async function signToken(payload: SignedPayload, secret: string): Promise<string> {
	const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)))
	const sig = await hmacSha256Hex(secret, body)
	return `${body}.${sig}`
}

export async function verifyToken<T extends SignedPayload>(
	token: string,
	secret: string,
): Promise<T | null> {
	const dot = token.indexOf(".")
	if (dot <= 0) return null
	const body = token.slice(0, dot)
	const sig = token.slice(dot + 1)
	const expected = await hmacSha256Hex(secret, body)
	if (!timingSafeEqualHex(sig, expected)) return null
	try {
		const parsed = JSON.parse(decoder.decode(base64UrlDecode(body))) as T
		if (typeof parsed.exp !== "number" || parsed.exp * 1000 < Date.now()) return null
		return parsed
	} catch {
		return null
	}
}
