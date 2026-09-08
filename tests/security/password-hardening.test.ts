import test from "node:test"
import assert from "node:assert/strict"
import { pbkdf2Sync } from "node:crypto"
import { hashPassword, needsPasswordUpgrade, verifyPassword } from "../../lib/admin/password.ts"

test("new password hashes are versioned and use the stronger work factor", async () => {
	const record = await hashPassword("a-test-only-passphrase")
	assert.match(record.passwordHash, /^pbkdf2-sha256:600000:[a-f0-9]{64}$/)
	assert.equal(await verifyPassword("a-test-only-passphrase", record), true)
	assert.equal(await verifyPassword("wrong-passphrase", record), false)
	assert.equal(needsPasswordUpgrade(record), false)
})

test("legacy hashes remain verifiable and are marked for upgrade", async () => {
	const passwordSalt = "0123456789abcdef0123456789abcdef"
	const record = {
		passwordSalt,
		passwordHash: pbkdf2Sync("legacy-test-passphrase", passwordSalt, 210000, 32, "sha256").toString("hex"),
	}
	assert.equal(await verifyPassword("legacy-test-passphrase", record), true)
	assert.equal(await verifyPassword("wrong-passphrase", record), false)
	assert.equal(needsPasswordUpgrade(record), true)
})

test("malformed work factors never trigger attacker-selected iteration counts", async () => {
	assert.equal(await verifyPassword("a-test-only-passphrase", {
		passwordHash: "pbkdf2-sha256:99999999999:" + "a".repeat(64), passwordSalt: "fixture",
	}), false)
	assert.equal(await verifyPassword("x".repeat(513), {}), false)
})