/**
 * DNS validation must govern the actual socket, not just an earlier lookup.
 * Each request's dispatcher can connect only to its prevalidated answers.
 * Keeping the original URL preserves Host and TLS SNI/certificate validation.
 * Keep the dispatcher on Undici 7: Undici 8 removed the legacy handler API
 * consumed by Node 22/24's built-in fetch. The real-socket regression covers it.
 */
import { Agent } from "undici"
import { isIP, type LookupFunction } from "node:net"
import type { ResolvedUpstream } from "./ssrf.ts"

export function pinnedLookup(target: ResolvedUpstream): LookupFunction {
	const allowed = target.addresses.map((address) => ({ address, family: isIP(address) }))
	return (hostname, options, callback) => {
		const name = hostname.toLowerCase().replace(/\.$/, "")
		const family = typeof options === "number" ? options : options.family
		const addresses = allowed.filter((entry) => !family || family === entry.family)
		if (name !== target.hostname || !addresses.length) {
			const error = Object.assign(new Error("no validated upstream address"), { code: "ENOTFOUND" })
			callback(error, "", 0)
			return
		}
		if (typeof options === "object" && options.all) callback(null, addresses)
		else callback(null, addresses[0].address, addresses[0].family)
	}
}

export function createPinnedDispatcher(target: ResolvedUpstream): Agent {
	return new Agent({ connect: { lookup: pinnedLookup(target) } })
}