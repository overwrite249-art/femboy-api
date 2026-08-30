/**
 * Outbound request guard.
 *
 * Channel base URLs are configured by operators and, in a multi-tenant
 * deployment, sometimes by semi-trusted admins. A gateway that will fetch any
 * URL it is given is a confused deputy: it sits inside the network perimeter
 * and will happily read the cloud metadata endpoint on an attacker's behalf.
 *
 * Four things have to be true before a request leaves:
 *
 *  1. The URL is shaped like something we are willing to call at all - https,
 *     a sane port, no embedded credentials.
 *  2. The host is written unambiguously. `URL` rewrites `0177.0.0.1` and
 *     `2130706433` into dotted quads, which means the address that gets
 *     validated is not always the one the operator typed.
 *  3. The host is not a non-routable address literal.
 *  4. Every address the host resolves to is publicly routable. Validating the
 *     name alone is useless when an attacker controls the DNS record.
 *
 * Point 4 still leaves a rebinding window between the check and the connect.
 * Verdicts are cached only briefly, and the resolved addresses are returned so
 * a caller that can pin them does not have to trust DNS twice.
 */

import { config } from "../config/env.ts"
import { ssrfBlocked } from "../http/errors.ts"
import { ipToBytes, matchesAnyCidr } from "../auth/cidr.ts"
import { redisGetJson, redisSetJson } from "../redis/client.ts"
import { K } from "../redis/keys.ts"

/** How long a resolution verdict may be reused. Short, to limit rebinding. */
const VERDICT_TTL_SEC = 60

/**
 * Everything that is not publicly routable, plus the ranges that are
 * technically routable but never a legitimate upstream.
 */
export const BLOCKED_V4_CIDRS = [
	"0.0.0.0/8", // "this network"
	"10.0.0.0/8", // RFC1918
	"100.64.0.0/10", // CGNAT, and Alibaba metadata at 100.100.100.200
	"127.0.0.0/8", // loopback
	"169.254.0.0/16", // link-local, and 169.254.169.254 metadata
	"172.16.0.0/12", // RFC1918
	"192.0.0.0/24", // IETF protocol assignments
	"192.0.2.0/24", // TEST-NET-1
	"192.88.99.0/24", // 6to4 relay anycast
	"192.168.0.0/16", // RFC1918
	"198.18.0.0/15", // benchmarking
	"198.51.100.0/24", // TEST-NET-2
	"203.0.113.0/24", // TEST-NET-3
	"224.0.0.0/4", // multicast
	"240.0.0.0/4", // reserved, includes 255.255.255.255
]

export const BLOCKED_V6_CIDRS = [
	"::/128", // unspecified
	"::1/128", // loopback
	"64:ff9b::/96", // NAT64, can be used to reach v4 private space
	"100::/64", // discard-only
	"2001:db8::/32", // documentation
	"2002::/16", // 6to4
	"fc00::/7", // unique local
	"fe80::/10", // link-local
	"ff00::/8", // multicast
]

/** Names that resolve inside a cloud or container network. */
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa", ".lan", ".localdomain"]
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"])

/** Ports we are willing to speak HTTP to when none are configured. */
const DEFAULT_ALLOWED_PORTS = [80, 443, 8080, 8443]

/** A dotted-quad label with no leading zeros: the only form we accept. */
const PLAIN_V4_LABEL = /^(0|[1-9][0-9]{0,2})$/

export type ResolvedUpstream = {
	url: URL
	hostname: string
	/** Every address the host resolved to, all verified public. */
	addresses: string[]
}

export type DnsResolver = (hostname: string) => Promise<string[]>

/** True when the address is not publicly routable. */
export function isBlockedAddress(ip: string): boolean {
	const bytes = ipToBytes(ip)
	if (bytes === null) return true
	return matchesAnyCidr(bytes.length === 4 ? BLOCKED_V4_CIDRS : BLOCKED_V6_CIDRS, ip)
}

/**
 * Whether the host is an attempt at an address literal.
 *
 * A real hostname never ends in an all-numeric or `0x`-prefixed label, so this
 * catches the encoded forms without misclassifying domains that happen to be
 * spelled with hex characters.
 */
export function looksLikeAddressLiteral(hostname: string): boolean {
	if (hostname.includes(":")) return true // bare IPv6
	const labels = hostname.split(".")
	const last = labels[labels.length - 1] ?? ""
	return /^[0-9]+$/.test(last) || /^0x[0-9a-f]+$/i.test(last)
}

/**
 * Whether the host, as written, means something different after parsing.
 *
 * `new URL("https://010.0.0.1/").hostname` is `8.0.0.1`, because the parser
 * reads `010` as octal. Validating the parsed value is therefore validating a
 * different address than the one configured, and the parser's willingness to
 * normalise is the only thing standing between `0177.0.0.1` and loopback.
 *
 * Rather than depend on that, any host whose numeric form is not a plain
 * dotted quad is refused outright. No legitimate upstream is written this way.
 */
export function hasAmbiguousHostEncoding(rawUrl: string): boolean {
	const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(rawUrl)
	if (!match) return false

	let authority = match[1] ?? ""
	const at = authority.lastIndexOf("@")
	if (at !== -1) authority = authority.slice(at + 1)
	// Bracketed IPv6 has no octal ambiguity; it is checked as a literal.
	if (authority.startsWith("[")) return false
	const colon = authority.lastIndexOf(":")
	const host = colon === -1 ? authority : authority.slice(0, colon)
	if (!host) return false

	const labels = host.split(".")
	const last = labels[labels.length - 1] ?? ""
	// Only address-literal attempts are in scope; domains are left alone.
	if (!/^[0-9]+$/.test(last) && !/^0x[0-9a-f]+$/i.test(last)) return false
	// A plain dotted quad is the one acceptable numeric form.
	if (labels.length === 4 && labels.every((label) => PLAIN_V4_LABEL.test(label))) return false
	return true
}

function stripBrackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
}

function matchesDomain(hostname: string, pattern: string): boolean {
	const host = hostname.toLowerCase()
	const rule = pattern.trim().toLowerCase()
	if (!rule) return false
	if (rule.startsWith("*.")) {
		const suffix = rule.slice(1) // ".example.com"
		return host.endsWith(suffix)
	}
	// A bare domain also covers its subdomains.
	return host === rule || host.endsWith(`.${rule}`)
}

/** Default resolver: DNS over HTTPS, so no platform DNS API is required. */
async function resolveOverHttps(hostname: string): Promise<string[]> {
	const endpoint = config.dohResolver
	if (!endpoint) return []
	const addresses: string[] = []
	for (const type of ["A", "AAAA"]) {
		try {
			const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=${type}`
			const res = await fetch(url, {
				headers: { accept: "application/dns-json" },
				signal: AbortSignal.timeout(3000),
			})
			if (!res.ok) continue
			const body = (await res.json()) as { Answer?: Array<{ type?: number; data?: string }> }
			for (const answer of body.Answer ?? []) {
				// 1 = A, 28 = AAAA. Anything else is a CNAME we do not follow here.
				if ((answer.type === 1 || answer.type === 28) && typeof answer.data === "string") {
					addresses.push(answer.data.trim())
				}
			}
		} catch {
			// A resolver failure is handled by the caller's fail-closed policy.
		}
	}
	return addresses
}

let resolver: DnsResolver = resolveOverHttps

/** Swap the resolver. Used by tests and by deployments with a local resolver. */
export function setDnsResolver(next: DnsResolver | null): void {
	resolver = next ?? resolveOverHttps
}

/**
 * Validates an outbound URL. Throws `ssrfBlocked` with a reason rather than
 * returning a boolean, so no call site can forget to check the result.
 */
export async function assertUpstreamUrlAllowed(rawUrl: string): Promise<ResolvedUpstream> {
	// Before parsing, while the host still means what it says.
	if (hasAmbiguousHostEncoding(rawUrl)) {
		throw ssrfBlocked("upstream host uses an ambiguous address encoding")
	}

	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		throw ssrfBlocked("upstream url is not parseable")
	}

	const scheme = url.protocol.toLowerCase()
	if (scheme !== "https:" && scheme !== "http:") {
		throw ssrfBlocked(`unsupported upstream scheme ${scheme}`)
	}
	if (scheme === "http:" && !config.allowPlaintextUpstream) {
		throw ssrfBlocked("plaintext upstream requests are disabled")
	}
	// Credentials in a URL are a redirect-laundering trick and are never needed.
	if (url.username || url.password) {
		throw ssrfBlocked("upstream url must not embed credentials")
	}

	const hostname = stripBrackets(url.hostname).toLowerCase()
	if (!hostname) throw ssrfBlocked("upstream url has no host")

	const port = url.port ? Number(url.port) : scheme === "https:" ? 443 : 80
	const allowedPorts = config.upstreamAllowedPorts.length
		? config.upstreamAllowedPorts
		: DEFAULT_ALLOWED_PORTS
	if (!allowedPorts.includes(port)) {
		throw ssrfBlocked(`upstream port ${port} is not allowed`)
	}

	if (BLOCKED_HOSTS.has(hostname)) throw ssrfBlocked(`upstream host ${hostname} is not routable`)
	for (const suffix of BLOCKED_SUFFIXES) {
		if (hostname.endsWith(suffix)) throw ssrfBlocked(`upstream host ${hostname} is internal`)
	}

	for (const pattern of config.upstreamDomainDenylist) {
		if (matchesDomain(hostname, pattern)) throw ssrfBlocked(`upstream host ${hostname} is denied`)
	}
	const allowlist = config.upstreamDomainAllowlist
	if (allowlist.length > 0 && !allowlist.some((p) => matchesDomain(hostname, p))) {
		throw ssrfBlocked(`upstream host ${hostname} is not on the allowlist`)
	}

	// An address literal is checked directly; there is nothing to resolve.
	if (looksLikeAddressLiteral(hostname)) {
		if (ipToBytes(hostname) === null) {
			throw ssrfBlocked("upstream host is a malformed address literal")
		}
		if (isBlockedAddress(hostname)) {
			throw ssrfBlocked("upstream address is not publicly routable")
		}
		return { url, hostname, addresses: [hostname] }
	}

	const cacheKey = K.ssrfVerdict(hostname)
	const cached = await redisGetJson<{ ok: boolean; addresses: string[] }>(cacheKey).catch(() => null)
	if (cached) {
		if (!cached.ok) throw ssrfBlocked("upstream address is not publicly routable")
		return { url, hostname, addresses: cached.addresses }
	}

	const addresses = await resolver(hostname)
	if (addresses.length === 0) {
		// Fail closed: an unresolvable host is not a safe host.
		throw ssrfBlocked(`upstream host ${hostname} could not be resolved`)
	}
	for (const address of addresses) {
		if (isBlockedAddress(address)) {
			await redisSetJson(cacheKey, { ok: false, addresses: [] }, VERDICT_TTL_SEC).catch(() => undefined)
			throw ssrfBlocked("upstream host resolves to a non-routable address")
		}
	}

	await redisSetJson(cacheKey, { ok: true, addresses }, VERDICT_TTL_SEC).catch(() => undefined)
	return { url, hostname, addresses }
}

/**
 * Redirects are followed manually so each hop is re-validated. An upstream
 * that 302s to the metadata service must not be trusted just because its
 * first hop was public.
 */
export async function assertRedirectAllowed(location: string, base: URL): Promise<ResolvedUpstream> {
	const resolved = new URL(location, base)
	return assertUpstreamUrlAllowed(resolved.toString())
}
