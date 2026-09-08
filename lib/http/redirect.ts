/** Shared by the sign-in page and OAuth callback; never navigate off-origin. */
export function safeRedirect(value: string | null): string {
	if (!value || !value.startsWith("/") || value.startsWith("//")) return "/console"
	// URL parsers strip control characters and treat backslashes as slashes.
	if (/[\\\u0000-\u001f\u007f]/.test(value)) return "/console"
	return value.slice(0, 500)
}