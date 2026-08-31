"use client"

import { useState } from "react"
import type { FormEvent } from "react"

import { api } from "../api.ts"
import {
	ErrorNote,
	Loading,
	Panel,
	Pill,
	SecretOnce,
	formatDate,
	formatNumber,
	statusTone,
	useApi,
} from "../ui.tsx"

type Token = {
	_id: string
	userId: string
	name: string
	masked?: string
	status: string
	quota: number
	usedQuota: number
	unlimitedQuota?: boolean
	allowedModels?: string[]
	allowedIps?: string[]
	expiresAt?: string | null
	createdAt?: string
}

type User = { _id: string; username: string }

export default function TokensPage() {
	const list = useApi<{ tokens: Token[] }>("/api/admin/tokens?limit=100")
	const users = useApi<{ users: User[] }>("/api/admin/users?limit=200")
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [secret, setSecret] = useState("")
	const [form, setForm] = useState({
		userId: "",
		name: "",
		quota: "",
		unlimited: false,
		allowedModels: "",
	})

	async function run(action: () => Promise<unknown>) {
		setBusy(true)
		setError("")
		try {
			await action()
			list.reload()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "the request was refused")
		} finally {
			setBusy(false)
		}
	}

	function create(event: FormEvent) {
		event.preventDefault()
		void run(async () => {
			const body: Record<string, unknown> = {
				userId: form.userId,
				name: form.name,
				unlimitedQuota: form.unlimited,
			}
			if (form.quota) body.quota = Number(form.quota)
			if (form.allowedModels) {
				body.allowedModels = form.allowedModels
					.split(",")
					.map((part) => part.trim())
					.filter((part) => part.length > 0)
			}
			const created = await api.post<{ key: string }>("/api/admin/tokens", body)
			setSecret(created.key)
			setForm({ userId: "", name: "", quota: "", unlimited: false, allowedModels: "" })
		})
	}

	function rotate(token: Token) {
		void run(async () => {
			const rotated = await api.post<{ key: string }>(
				"/api/admin/tokens/" + token._id + "/rotate",
			)
			setSecret(rotated.key)
		})
	}

	function toggle(token: Token) {
		const next = token.status === "enabled" ? "disabled" : "enabled"
		void run(() => api.patch("/api/admin/tokens/" + token._id, { status: next }))
	}

	function remove(token: Token) {
		void run(() => api.remove("/api/admin/tokens/" + token._id))
	}

	const tokens = list.data?.tokens ?? []
	const names = new Map<string, string>()
	for (const user of users.data?.users ?? []) names.set(user._id, user.username)

	return (
		<>
			<ErrorNote message={error || list.error} />

			{secret ? (
				<SecretOnce label="This API key" value={secret} onDone={() => setSecret("")} />
			) : null}

			<section className="section">
				<div className="section-head">
					<h2 className="section-title">Tokens</h2>
					<span className="section-note">stored as peppered digests, never as text</span>
				</div>
				<Panel>
					{list.loading && tokens.length === 0 ? (
						<Loading />
					) : tokens.length === 0 ? (
						<div className="empty">No tokens yet.</div>
					) : (
						<table>
							<thead>
								<tr>
									<th>Name</th>
									<th>Key</th>
									<th className="hide-sm">Owner</th>
									<th className="num hide-sm">Quota</th>
									<th className="hide-sm">Models</th>
									<th>State</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{tokens.map((token) => (
									<tr key={token._id}>
										<td>
											{token.name}
											<div className="hint">created {formatDate(token.createdAt)}</div>
										</td>
										<td className="mono">{token.masked ?? "sk-..."}</td>
										<td className="hide-sm">{names.get(token.userId) ?? token.userId}</td>
										<td className="num hide-sm">
											{token.unlimitedQuota
												? "unlimited"
												: formatNumber(token.usedQuota) + " / " + formatNumber(token.quota)}
										</td>
										<td className="hide-sm hint">
											{(token.allowedModels ?? []).length === 0
												? "any"
												: (token.allowedModels ?? []).join(", ")}
										</td>
										<td>
											<Pill tone={statusTone(token.status)} dot>
												{token.status}
											</Pill>
										</td>
										<td className="num">
											<button
												className="btn btn-small"
												type="button"
												onClick={() => rotate(token)}
												disabled={busy}
											>
												Rotate
											</button>{" "}
											<button
												className="btn btn-small"
												type="button"
												onClick={() => toggle(token)}
												disabled={busy}
											>
												{token.status === "enabled" ? "Disable" : "Enable"}
											</button>{" "}
											<button
												className="btn btn-small btn-danger"
												type="button"
												onClick={() => remove(token)}
												disabled={busy}
											>
												Delete
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Panel>
			</section>

			<section className="section">
				<div className="section-head">
					<h2 className="section-title">Mint a token</h2>
					<span className="section-note">shown once, then only as a digest</span>
				</div>
				<Panel>
					<form className="form" onSubmit={create}>
						<div className="field">
							<label htmlFor="userId">Owner</label>
							<select
								id="userId"
								value={form.userId}
								onChange={(event) =>
									setForm((current) => ({ ...current, userId: event.target.value }))
								}
								required
							>
								<option value="">select a user</option>
								{(users.data?.users ?? []).map((user) => (
									<option key={user._id} value={user._id}>
										{user.username}
									</option>
								))}
							</select>
						</div>
						<div className="field">
							<label htmlFor="tname">Name</label>
							<input
								id="tname"
								value={form.name}
								onChange={(event) =>
									setForm((current) => ({ ...current, name: event.target.value }))
								}
								placeholder="laptop"
								required
							/>
						</div>
						<div className="field">
							<label htmlFor="tquota">Quota</label>
							<input
								id="tquota"
								value={form.quota}
								onChange={(event) =>
									setForm((current) => ({ ...current, quota: event.target.value }))
								}
								inputMode="numeric"
								placeholder="500000"
							/>
							<span className="hint">500,000 quota units is one US dollar.</span>
						</div>
						<div className="field">
							<label htmlFor="tmodels">Allowed models</label>
							<input
								id="tmodels"
								value={form.allowedModels}
								onChange={(event) =>
									setForm((current) => ({ ...current, allowedModels: event.target.value }))
								}
								placeholder="gpt-4o, claude-*"
							/>
							<span className="hint">A single trailing asterisk is the only wildcard.</span>
						</div>
						<div className="field field-wide">
							<div className="check">
								<input
									id="unlimited"
									type="checkbox"
									checked={form.unlimited}
									onChange={(event) =>
										setForm((current) => ({ ...current, unlimited: event.target.checked }))
									}
								/>
								<label htmlFor="unlimited">Unlimited quota</label>
							</div>
						</div>
						<div className="form-foot">
							<span className="hint">Written to the audit log.</span>
							<button className="btn btn-primary" type="submit" disabled={busy}>
								Mint token
							</button>
						</div>
					</form>
				</Panel>
			</section>
		</>
	)
}
