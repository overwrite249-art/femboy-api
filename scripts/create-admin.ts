/**
 * Bootstraps the first administrator.
 *
 * There is deliberately no "first request becomes admin" path in the HTTP
 * layer: that pattern turns a fresh deployment into a race between the
 * operator and whoever is scanning the internet. Instead the first admin is
 * created out of band, here.
 *
 *   bun run bootstrap:admin -- --username root --password '...'
 *
 * Prints one API key. It is not stored anywhere and cannot be recovered.
 */

import { hashPassword } from "../lib/admin/password.ts"
import { createToken, createUser, findUserByUsername } from "../lib/admin/store.ts"
import { config } from "../lib/config/env.ts"
import { users } from "../lib/db/index.ts"

function arg(name: string): string {
	const flag = `--${name}`
	const index = process.argv.indexOf(flag)
	if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1] ?? ""
	const inline = process.argv.find((entry) => entry.startsWith(`${flag}=`))
	return inline ? inline.slice(flag.length + 1) : ""
}

async function main(): Promise<void> {
	if (!config.mongoUri) {
		console.error("MONGODB_URI is not set, so this would write to a throwaway in-memory store.")
		process.exit(1)
	}
	if (!config.keyPepper) {
		console.error("KEY_PEPPER is not set. The key digest would not be reproducible.")
		process.exit(1)
	}

	const username = arg("username") || process.env.ADMIN_USERNAME || "root"
	const password = arg("password") || process.env.ADMIN_PASSWORD || ""
	const force = process.argv.includes("--force")

	if (!password) {
		console.error("Provide --password or set ADMIN_PASSWORD.")
		process.exit(1)
	}

	const collection = await users()
	const existingRoot = await collection.findOne({ role: "root" })
	if (existingRoot && !force) {
		console.error(`A root user already exists (${existingRoot.username}). Pass --force to add another.`)
		process.exit(1)
	}
	if (await findUserByUsername(username)) {
		console.error(`The username ${username} is taken.`)
		process.exit(1)
	}

	const user = await createUser({ username, role: "root", quota: 0 })
	const credentials = await hashPassword(password)
	await collection.updateOne(
		{ _id: user._id },
		{ $set: { passwordHash: credentials.passwordHash, passwordSalt: credentials.passwordSalt } },
	)

	const { key } = await createToken({
		userId: user._id,
		name: "bootstrap",
		unlimitedQuota: true,
	})

	console.log("")
	console.log(`  Created root user: ${user.username} (${user._id})`)
	console.log(`  API key:           ${key}`)
	console.log("")
	console.log("  This key is shown once. Store it now; it cannot be recovered.")
	console.log("")
	process.exit(0)
}

await main()
