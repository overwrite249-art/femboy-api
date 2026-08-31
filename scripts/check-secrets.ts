/**
 * Fails the build if anything credential-shaped was committed.
 *
 * This is deliberately dumb and deliberately noisy. A scanner that tries to be
 * clever about what is "probably a test fixture" is a scanner that eventually
 * waves through a real key. Add an inline `allow-secret` comment to accept a
 * specific line.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	".next",
	".vercel",
	"dist",
	"coverage",
])

const SKIP_FILES = new Set([".env.example"])

const TEXT_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".json",
	".md",
	".yml",
	".yaml",
	".css",
	".html",
	".sh",
	".env",
]

type Finding = { file: string; line: number; rule: string; excerpt: string }

const RULES: Array<{ name: string; pattern: RegExp }> = [
	{ name: "relay-key", pattern: /sk-[A-Za-z0-9]{24,}/ },
	{ name: "openai-project-key", pattern: /sk-proj-[A-Za-z0-9_-]{20,}/ },
	{ name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
	{ name: "google-key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
	{ name: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
	{ name: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/ },
	{ name: "slack-token", pattern: /xox[abposr]-[A-Za-z0-9-]{10,}/ },
	{ name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{
		name: "mongo-uri-with-password",
		pattern: /mongodb(\+srv)?:\/\/[^\s:/@"']+:[^\s:/@"']+@/,
	},
	{ name: "upstash-token", pattern: /A[A-Za-z0-9_-]{40,}=$/ },
	{ name: "jwt", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
]

function isTextFile(name: string): boolean {
	if (name.startsWith(".env")) return true
	for (const extension of TEXT_EXTENSIONS) {
		if (name.endsWith(extension)) return true
	}
	return false
}

function walk(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue
		const full = join(dir, entry)
		const stats = statSync(full)
		if (stats.isDirectory()) {
			walk(full, out)
			continue
		}
		if (SKIP_FILES.has(entry)) continue
		if (!isTextFile(entry)) continue
		out.push(full)
	}
}

function scan(): Finding[] {
	const files: string[] = []
	walk(".", files)

	const findings: Finding[] = []
	for (const file of files) {
		let content = ""
		try {
			content = readFileSync(file, "utf8")
		} catch {
			continue
		}
		const lines = content.split("\n")
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index]
			if (line.includes("allow-secret")) continue
			for (const rule of RULES) {
				const match = rule.pattern.exec(line)
				if (!match) continue
				findings.push({
					file,
					line: index + 1,
					rule: rule.name,
					excerpt: match[0].slice(0, 12) + "...",
				})
			}
		}
	}
	return findings
}

const findings = scan()

if (findings.length === 0) {
	console.log("no credential-shaped strings found")
	process.exit(0)
}

console.error("possible committed secrets:")
for (const finding of findings) {
	console.error(
		"  " + finding.file + ":" + finding.line + "  " + finding.rule + "  " + finding.excerpt,
	)
}
console.error("")
console.error("If one of these is a fixture, add an inline allow-secret comment.")
process.exit(1)
