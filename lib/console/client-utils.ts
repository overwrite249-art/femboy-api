/** Browser-only presentation helpers; never pass credentials to exports. */
export function matchesSearch(query: string, ...values: unknown[]): boolean {
	const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
	const haystack = values
		.map((value) =>
			Array.isArray(value) ? value.join(" ") : String(value ?? ""),
		)
		.join(" ")
		.toLowerCase()
	return terms.every((term) => haystack.includes(term))
}

export function csvCell(value: unknown): string {
	let text = String(value ?? "")
	// Spreadsheet programs can execute formulas after whitespace/control prefixes.
	if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))
		text = "'" + text
	return '"' + text.replaceAll('"', '""') + '"'
}
export function toCsv(headers: string[], rows: unknown[][]): string {
	return (
		[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
		"\r\n"
	)
}
export function downloadCsv(
	filename: string,
	headers: string[],
	rows: unknown[][],
): void {
	const url = URL.createObjectURL(
		new Blob(["\ufeff", toCsv(headers, rows)], {
			type: "text/csv;charset=utf-8",
		}),
	)
	const link = document.createElement("a")
	link.href = url
	link.download = filename.replace(/[^a-zA-Z0-9._-]/g, "_")
	document.body.append(link)
	link.click()
	link.remove()
	setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function monthBucket(value: string): string {
	return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value.replace("-", "") : ""
}
export function utcMonth(): string {
	return new Date().toISOString().slice(0, 7)
}
export function tokenState(
	token: { status: string; expiresAt?: string | null },
	now = Date.now(),
): string {
	if (
		token.status === "enabled" &&
		token.expiresAt &&
		new Date(token.expiresAt).getTime() <= now
	)
		return "expired"
	return token.status
}
/** Copied examples always use an environment variable, never the entered key. */
export function curlExample(origin: string, body: object): string {
	const safeOrigin = new URL(origin).origin
	const escaped = JSON.stringify(body, null, 2).replaceAll("'", "'\\''")
	return `curl '${safeOrigin}/v1/chat/completions' \\\n  -H "Authorization: Bearer $FEMBOY_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '${escaped}'`
}
