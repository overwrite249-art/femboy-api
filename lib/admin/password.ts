/**
 * Console passwords.
 *
 * A password is not an API key: it is chosen by a human, so it is low entropy
 * and must be slow to verify. PBKDF2-SHA256 with a per-user salt is used here
 * because it is available in WebCrypto on every runtime this project targets,
 * which keeps the dependency count at zero (the same constraint the rest of
 * `lib/` follows).
 *
 * 210,000 iterations is OWASP's 2023 floor for PBKDF2-HMAC-SHA256. It costs a
 * few hundred milliseconds server-side, which is acceptable for a sign-in and
 * expensive for an offline attacker with a stolen database.
 *
 * Note what is NOT here: any way to get a password back. Only the derived bits
 * are stored, and comparison is constant-time so a near-miss reveals nothing.
 */

import { bytesToHex, randomHex, timingSafeEqualHex } from "../util/crypto.ts"
import { invalidRequest } from "../http/errors.ts"

export const PBKDF2_ITERATIONS = 210_000
export const SALT_BYTES = 16
export const DERIVED_BITS = 256

const MIN_LENGTH = 10
const MAX_LENGTH = 512

const encoder = new TextEncoder()

export type PasswordRecord = { passwordHash: string; passwordSalt: string }

async function derive(password: string, saltHex: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	)
	const bits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt: encoder.encode(saltHex) as BufferSource,
			iterations: PBKDF2_ITERATIONS,
			hash: "SHA-256",
		},
		key,
		DERIVED_BITS,
	)
	return bytesToHex(new Uint8Array(bits))
}

/**
 * Rejects passwords that are too short to be worth hashing, and absurdly long
 * ones -- an unbounded input to a deliberately slow function is a denial of
 * service (the same shape as GW-008, one layer up).
 */
export function assertPasswordAcceptable(password: unknown): string {
	if (typeof password !== "string") {
		throw invalidRequest("password is required", "password")
	}
	if (password.length < MIN_LENGTH) {
		throw invalidRequest(`password must be at least ${MIN_LENGTH} characters`, "password")
	}
	if (password.length > MAX_LENGTH) {
		throw invalidRequest("password is too long", "password")
	}
	return password
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
	assertPasswordAcceptable(password)
	const passwordSalt = randomHex(SALT_BYTES)
	return { passwordHash: await derive(password, passwordSalt), passwordSalt }
}

/**
 * Verifies a password. Returns false rather than throwing for every failure,
 * including a user with no password set, so the caller cannot accidentally
 * distinguish "wrong password" from "password login not enabled".
 */
export async function verifyPassword(
	password: string,
	record: { passwordHash?: string; passwordSalt?: string },
): Promise<boolean> {
	if (!record.passwordHash || !record.passwordSalt) {
		// Still burn the time, so account enumeration cannot be timed.
		await derive(password, "absent")
		return false
	}
	if (typeof password !== "string" || password.length > MAX_LENGTH) return false
	const candidate = await derive(password, record.passwordSalt)
	return timingSafeEqualHex(candidate, record.passwordHash)
}
