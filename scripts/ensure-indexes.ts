/**
 * Creates every index the gateway relies on, including the usage-log index set
 * for the current month and the next one.
 *
 * Safe to run repeatedly: index creation is idempotent, and running it just
 * before a month boundary is exactly how the partition-maint cron avoids a
 * cold, unindexed collection on the first of the month.
 *
 *   bun run db:indexes
 */

import { partitionMaintenance } from "../lib/cron/jobs.ts"
import { config } from "../lib/config/env.ts"

async function main(): Promise<void> {
	if (!config.mongoUri) {
		console.error("MONGODB_URI is not set. Refusing to run against the in-memory twin,")
		console.error("because creating indexes there would silently do nothing.")
		process.exit(1)
	}

	console.log(`Database: ${config.mongoDb}`)
	const result = await partitionMaintenance()
	console.log(`Buckets prepared: ${(result.buckets as string[]).join(", ")}`)
	console.log(`Indexes ensured: ${result.created as number}`)
	process.exit(0)
}

await main()
