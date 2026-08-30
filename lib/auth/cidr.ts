/**
 * IPv4 / IPv6 parsing and CIDR containment.
 *
 * Used by the token IP allowlist, the admin network allowlist and the SSRF
 * guard. Written by hand because the alternatives all pull in a dependency,
 * and because a permissive parser here is a security bug: `010.0.0.1` and
 * `::ffff:127.0.0.1` are exactly the kind of input an attacker uses to slip
 * past a naive check.
 */

/** Strict dotted-quad. Rejects leading zeros, which some parsers read as octal. */
function parseIpv4(value: string): Uint8Array | null {
	const parts = value.split(".")
	if (parts.length !== 4) return null
	const out = new Uint8Array(4)
	for (let i = 0; i < 4; i++) {
		const part = parts[i]
		if (part.length === 0 || part.length > 3) return null
		if (part.length > 1 && part[0] === "0") return null
		for (let c = 0; c < part.length; c++) {
			const code = part.charCodeAt(c)
			if (code < 48 || code > 57) return null
		}
		const n = Number(part)
		if (n > 255) return null
		out[i] = n
	}
	return out
}

const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/

/** Writes groups into `target` starting at `offset`; returns the new offset. */
function emitGroups(target: Uint8Array, groups: string[], offset: number): number | null {
	let pos = offset
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i]
		if (group.includes(".")) {
			// An embedded IPv4 tail is only legal as the final element.
			if (i !== groups.length - 1) return null
			const v4 = parseIpv4(group)
			if (!v4 || pos + 4 > 16) return null
			target.set(v4, pos)
			pos += 4
			continue
		}
		if (!HEX_GROUP.test(group) || pos + 2 > 16) return null
		const n = parseInt(group, 16)
		target[pos] = (n >> 8) & 0xff
		target[pos + 1] = n & 0xff
		pos += 2
	}
	return pos
}

function parseIpv6(value: string): Uint8Array | null {
	let text = value
	if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1)
	const zone = text.indexOf("%")
	if (zone !== -1) text = text.slice(0, zone)
	if (!text.includes(":")) return null
	if (text.length > 45) return null

	const doubleColon = text.indexOf("::")
	if (doubleColon !== -1 && text.indexOf("::", doubleColon + 1) !== -1) return null

	let head: string[] = []
	let tail: string[] = []
	if (doubleColon === -1) {
		head = text.split(":")
	} else {
		const before = text.slice(0, doubleColon)
		const after = text.slice(doubleColon + 2)
		head = before === "" ? [] : before.split(":")
		tail = after === "" ? [] : after.split(":")
	}

	const bytes = new Uint8Array(16)
	const headLen = emitGroups(bytes, head, 0)
	if (headLen === null) return null

	const tailBuffer = new Uint8Array(16)
	const tailLen = emitGroups(tailBuffer, tail, 0)
	if (tailLen === null) return null

	if (doubleColon === -1) {
		return headLen === 16 && tailLen === 0 ? bytes : null
	}
	// "::" must stand for at least one all-zero group.
	if (headLen + tailLen > 14) return null
	bytes.set(tailBuffer.subarray(0, tailLen), 16 - tailLen)
	return bytes
}

/**
 * Parses an address to its raw bytes: 4 for IPv4, 16 for IPv6.
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) collapses to its 4-byte form so that a
 * v4 rule still matches a v4 client arriving over a v6 socket.
 */
export function ipToBytes(ip: string): Uint8Array | null {
	const value = ip.trim()
	if (value.length === 0 || value.length > 64) return null
	const v4 = parseIpv4(value)
	if (v4) return v4
	const v6 = parseIpv6(value)
	if (!v6) return null
	let mapped = true
	for (let i = 0; i < 10; i++) {
		if (v6[i] !== 0) {
			mapped = false
			break
		}
	}
	if (mapped && v6[10] === 0xff && v6[11] === 0xff) return v6.subarray(12, 16)
	return v6
}

export function isValidIp(ip: string): boolean {
	return ipToBytes(ip) !== null
}

export type ParsedCidr = { bytes: Uint8Array; bits: number }

/** Accepts `10.0.0.0/8`, `::1/128` or a bare address (implicit full mask). */
export function parseCidr(cidr: string): ParsedCidr | null {
	const value = cidr.trim()
	if (value.length === 0) return null
	const slash = value.lastIndexOf("/")
	const base = slash === -1 ? value : value.slice(0, slash)
	const bytes = ipToBytes(base)
	if (!bytes) return null
	const width = bytes.length * 8
	if (slash === -1) return { bytes, bits: width }
	const suffix = value.slice(slash + 1)
	if (suffix.length === 0 || suffix.length > 3) return null
	for (let i = 0; i < suffix.length; i++) {
		const code = suffix.charCodeAt(i)
		if (code < 48 || code > 57) return null
	}
	const bits = Number(suffix)
	if (bits > width) return null
	return { bytes, bits }
}

/** True when `ip` falls inside `cidr`. Mixed address families never match. */
export function cidrContains(cidr: string, ip: string): boolean {
	const rule = parseCidr(cidr)
	if (!rule) return false
	const target = ipToBytes(ip)
	if (!target) return false
	if (target.length !== rule.bytes.length) return false

	const fullBytes = rule.bits >> 3
	for (let i = 0; i < fullBytes; i++) {
		if (target[i] !== rule.bytes[i]) return false
	}
	const remaining = rule.bits & 7
	if (remaining === 0) return true
	const mask = (0xff << (8 - remaining)) & 0xff
	return (target[fullBytes] & mask) === (rule.bytes[fullBytes] & mask)
}

/** True when the address matches any rule. An empty rule list matches nothing. */
export function matchesAnyCidr(cidrs: string[], ip: string): boolean {
	for (const cidr of cidrs) {
		if (cidrContains(cidr, ip)) return true
	}
	return false
}
