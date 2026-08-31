"use client"

import { useCallback, useEffect, useState } from "react"
import type { ReactNode } from "react"

import { api } from "./api.ts"

/* ------------------------------------------------------------- formatting */

export function formatNumber(value: unknown): string {
	const num = typeof value === "number" ? value : Number(value ?? 0)
	if (!Number.isFinite(num)) return "0"
	return num.toLocaleString("en-US")
}

export function formatUsd(value: unknown): string {
	const num = typeof value === "number" ? value : Number(value ?? 0)
	if (!Number.isFinite(num)) return "$0.00"
	if (num !== 0 && Math.abs(num) < 0.01) return "<$0.01"
	return "$" + num.toFixed(2)
}

export function formatPercent(part: number, whole: number): string {
	if (!whole) return "0%"
	return ((part / whole) * 100).toFixed(2) + "%"
}

export function formatDate(value: unknown): string {
	if (!value) return "\u2014"
	const date = new Date(String(value))
	if (Number.isNaN(date.getTime())) return String(value)
	return date.toLocaleString()
}

export function quotaToUsd(quota: number, quotaPerUnit: number): number {
	if (!quotaPerUnit) return 0
	return quota / quotaPerUnit
}

/* ------------------------------------------------------------------ pieces */

export function Panel(props: {
	title?: string
	note?: string
	actions?: ReactNode
	children: ReactNode
}) {
	const hasHead = Boolean(props.title || props.note || props.actions)
	return (
		<div className="panel">
			{hasHead ? (
				<div className="panel-head">
					{props.title ? <span className="panel-title">{props.title}</span> : null}
					{props.note ? <span className="panel-note">{props.note}</span> : null}
					{props.actions}
				</div>
			) : null}
			<div className="panel-body">{props.children}</div>
		</div>
	)
}

export function StatCard(props: {
	label: string
	value: string
	sub?: ReactNode
}) {
	return (
		<div className="card">
			<div className="card-label">{props.label}</div>
			<div className="card-value">{props.value}</div>
			{props.sub ? <div className="card-sub">{props.sub}</div> : null}
		</div>
	)
}

export type Tone = "ok" | "warn" | "bad" | "info" | "idle"

export function Pill(props: { tone: Tone; children: ReactNode; dot?: boolean }) {
	return (
		<span className={"pill pill-" + props.tone}>
			{props.dot ? <span className="dot" /> : null}
			{props.children}
		</span>
	)
}

export function statusTone(status: unknown): Tone {
	const value = String(status ?? "").toLowerCase()
	if (value === "enabled" || value === "healthy" || value === "unused") return "ok"
	if (value === "disabled" || value === "deleted") return "bad"
	if (value === "used") return "idle"
	return "info"
}

export function httpTone(status: unknown): Tone {
	const code = Number(status ?? 0)
	if (code >= 200 && code < 300) return "ok"
	if (code === 429) return "warn"
	if (code >= 400) return "bad"
	return "idle"
}

export function Callout(props: { tone: "ok" | "warn" | "bad"; children: ReactNode }) {
	const glyph = props.tone === "ok" ? "\u2713" : "\u26a0"
	return (
		<div className={"callout callout-" + props.tone}>
			<span className="callout-icon">{glyph}</span>
			<div>{props.children}</div>
		</div>
	)
}

export function Empty(props: { children: ReactNode }) {
	return <div className="empty">{props.children}</div>
}

export function Loading(props: { rows?: number }) {
	const rows = props.rows ?? 3
	const keys: number[] = []
	for (let index = 0; index < rows; index += 1) keys.push(index)
	return (
		<div className="empty">
			{keys.map((key) => (
				<div className="skeleton" key={key} />
			))}
		</div>
	)
}

export function Bar(props: { value: number; total: number }) {
	const ratio = props.total > 0 ? Math.min(1, props.value / props.total) : 0
	// Built as a variable so the JSX stays free of nested braces.
	const fill = { width: (ratio * 100).toFixed(1) + "%" }
	return (
		<div className="bar">
			<span style={fill} />
		</div>
	)
}

/* A secret the server will never show again. Displayed once, with a copy
 * action, and an explicit warning that reloading loses it. */
export function SecretOnce(props: { label: string; value: string; onDone: () => void }) {
	const [copied, setCopied] = useState(false)

	async function copy() {
		try {
			await navigator.clipboard.writeText(props.value)
			setCopied(true)
		} catch {
			setCopied(false)
		}
	}

	return (
		<div className="section">
			<Callout tone="ok">
				<strong>{props.label}</strong> is shown once. It is stored only as a digest,
				so nobody can display it again, including you.
			</Callout>
			<div className="secret">
				<span>{props.value}</span>
			</div>
			<div className="form-foot">
				<span className="hint">{copied ? "Copied to clipboard." : "\u00a0"}</span>
				<button className="btn btn-small" type="button" onClick={copy}>
					Copy
				</button>
				<button className="btn btn-small" type="button" onClick={props.onDone}>
					I have saved it
				</button>
			</div>
		</div>
	)
}

/* --------------------------------------------------------------- data hook */

export type Resource<T> = {
	data: T | null
	error: string
	loading: boolean
	reload: () => void
}

export function useApi<T>(path: string): Resource<T> {
	const [data, setData] = useState<T | null>(null)
	const [error, setError] = useState("")
	const [loading, setLoading] = useState(true)
	const [nonce, setNonce] = useState(0)

	const reload = useCallback(() => {
		setNonce((value) => value + 1)
	}, [])

	useEffect(() => {
		let cancelled = false
		setLoading(true)
		api
			.get<T>(path)
			.then((value) => {
				if (cancelled) return
				setData(value)
				setError("")
			})
			.catch((cause: unknown) => {
				if (cancelled) return
				setError(cause instanceof Error ? cause.message : "the request was refused")
			})
			.finally(() => {
				if (!cancelled) setLoading(false)
			})
		return () => {
			cancelled = true
		}
	}, [path, nonce])

	return { data, error, loading, reload }
}

export function ErrorNote(props: { message: string }) {
	if (!props.message) return null
	return <Callout tone="bad">{props.message}</Callout>
}
