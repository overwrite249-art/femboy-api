import { readFileSync, writeFileSync } from "node:fs"
import { getDb, isEphemeral } from "../lib/db/index.ts"
import { exportBalancePlan, applyBalancePlan, type BalancePlan } from "../lib/quota/migrate.ts"
import { closeMongo } from "../lib/db/mongo.ts"

async function main() {
	const [action, path] = process.argv.slice(2)
	if (!["--export", "--apply"].includes(action) || !path || isEphemeral()) {
		throw new Error("Usage: npm run migrate:quota -- --export|--apply balances.json (requires MongoDB)")
	}
	if (process.env.QUOTA_MIGRATION_MAINTENANCE !== "1") {
		throw new Error("Stop ALL old relay traffic and cron jobs, then set QUOTA_MIGRATION_MAINTENANCE=1")
	}
	const db = await getDb()
	if (action === "--export") {
		writeFileSync(path, JSON.stringify(await exportBalancePlan(db), null, 2) + "\n", { mode: 0o600, flag: "wx" })
		console.log("Exported an unreviewed plan. Reconcile missing counters, in-flight holds, receipts and v1 journals before marking reviewed=true.")
	} else {
		const plan = JSON.parse(readFileSync(path, "utf8")) as BalancePlan
		console.log(`Upgraded ${await applyBalancePlan(db, plan)} reviewed balances. Unlisted legacy rows still fail closed.`)
	}
}

try {
	await main()
} catch (error) {
	console.error(error instanceof Error ? error.message : "migration failed")
	process.exitCode = 1
} finally {
	await closeMongo()
}