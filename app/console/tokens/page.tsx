"use client"

import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"

import { api } from "../api.ts"
import { Plus, KeyRound } from "lucide-react"
import { useConfirm, useToast } from "../../components/interface.tsx"
import { matchesSearch, tokenState } from "../../../lib/console/client-utils.ts"
import {
	Empty,
	PageHeader,
	Pagination,
	RefreshButton,
	SearchInput,
} from "../ui.tsx"
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
	const [page, setPage] = useState(0)
	const list = useApi<{ tokens: Token[] }>(
		`/api/admin/tokens?limit=100&skip=${page * 100}`,
	)
	const confirm = useConfirm()
	const notify = useToast()
	const actionPending = useRef(false)
	const [query, setQuery] = useState("")
	const [status, setStatus] = useState("all")
	const [owner, setOwner] = useState("all")
	const [creating, setCreating] = useState(false)
	useEffect(() => {
		const hash = () => {
			if (window.location.hash === "#create") setCreating(true)
		}
		hash()
		window.addEventListener("hashchange", hash)
		return () => window.removeEventListener("hashchange", hash)
	}, [])
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
		expiresAt: "",
		allowedIps: "",
	})

	async function run(action: () => Promise<unknown>) {
		if (actionPending.current) return
		actionPending.current = true
		setBusy(true)
		setError("")
		try {
			await action()
			list.reload()
			notify("API key changes saved.")
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "the request was refused",
			)
		} finally {
			actionPending.current = false
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
			if (form.expiresAt)
				body.expiresAt = new Date(form.expiresAt).toISOString()
			if (form.allowedIps.trim())
				body.allowedIps = form.allowedIps
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean)
			if (form.allowedModels) {
				body.allowedModels = form.allowedModels
					.split(",")
					.map((part) => part.trim())
					.filter((part) => part.length > 0)
			}
			const created = await api.post<{ key: string }>("/api/admin/tokens", body)
			setSecret(created.key)
			setForm({
				userId: "",
				name: "",
				quota: "",
				unlimited: false,
				allowedModels: "",
				expiresAt: "",
				allowedIps: "",
			})
			setCreating(false)
		})
	}

	async function rotate(token: Token) {
		if (
			!(await confirm({
				title: `Rotate ${token.name}?`,
				description:
					"The existing key stops working after rotation. The replacement is shown once. Update every application that uses this token.",
				action: "Rotate key",
				danger: true,
			}))
		)
			return
		void run(async () => {
			const rotated = await api.post<{ key: string }>(
				"/api/admin/tokens/" + token._id + "/rotate",
			)
			setSecret(rotated.key)
		})
	}

	async function toggle(token: Token) {
		const next = token.status === "enabled" ? "disabled" : "enabled"
		if (
			next === "disabled" &&
			!(await confirm({
				title: `Disable ${token.name}?`,
				description:
					"Applications using this key will no longer be able to authenticate until you enable it again.",
				action: "Disable key",
			}))
		)
			return
		void run(() =>
			api.patch("/api/admin/tokens/" + token._id, { status: next }),
		)
	}

	async function remove(token: Token) {
		if (
			!(await confirm({
				title: `Delete ${token.name}?`,
				description:
					"This permanently revokes the token. Applications using it will lose access. Usage records are retained.",
				action: "Delete key",
				danger: true,
			}))
		)
			return
		void run(() => api.remove("/api/admin/tokens/" + token._id))
	}

	const allTokens = list.data?.tokens ?? []
	const names = new Map<string, string>()
	for (const user of users.data?.users ?? []) names.set(user._id, user.username)
	const tokens = allTokens.filter(
		(token) =>
			matchesSearch(
				query,
				token.name,
				token.masked,
				token.allowedModels,
				names.get(token.userId),
			) &&
			(status === "all" || tokenState(token) === status) &&
			(owner === "all" || token.userId === owner),
	)
	function openCreate() {
		setCreating(true)
		setTimeout(
			() =>
				document.getElementById("create")?.scrollIntoView({ block: "start" }),
			0,
		)
	}

	return (
		<>
			<PageHeader
				eyebrow="Manage"
				title="API keys"
				description="Issue scoped gateway keys, set limits, and rotate credentials without touching provider accounts."
				actions={
					<>
						<RefreshButton
							onClick={() => {
								list.reload()
								users.reload()
							}}
							loading={list.loading}
						/>
						<button
							className="btn btn-primary"
							type="button"
							onClick={openCreate}
							disabled={Boolean(secret)}
						>
							<Plus size={16} />
							Create API key
						</button>
					</>
				}
			/>
			<ErrorNote message={error || list.error || users.error} />

			{secret ? (
				<SecretOnce
					label="This API key"
					value={secret}
					onDone={() => setSecret("")}
				/>
			) : null}

			<section className="section">
				<div className="section-head">
					<h2 className="section-title">Gateway keys</h2>
					<span className="section-note">
						Separate from provider credentials
					</span>
				</div>
				<Panel>
					<div className="toolbar">
						<SearchInput
							value={query}
							onChange={setQuery}
							placeholder="Search keys on this page…"
						/>
						<span className="filter-control">
							<select
								aria-label="Filter token status"
								value={status}
								onChange={(event) => setStatus(event.target.value)}
							>
								<option value="all">All states</option>
								<option value="enabled">Enabled</option>
								<option value="disabled">Disabled</option>
								<option value="expired">Expired</option>
							</select>
						</span>
						<span className="filter-control">
							<select
								aria-label="Filter token owner"
								value={owner}
								onChange={(event) => setOwner(event.target.value)}
							>
								<option value="all">All owners</option>
								{(users.data?.users ?? []).map((user) => (
									<option key={user._id} value={user._id}>
										{user.username}
									</option>
								))}
							</select>
						</span>
					</div>
					{list.loading && tokens.length === 0 ? (
						<Loading />
					) : tokens.length === 0 ? (
						<Empty>
							<h3>
								{allTokens.length ? "No matching keys" : "No keys issued"}
							</h3>
							<p>
								{allTokens.length
									? "Try different filters to find your token."
									: "Create a scoped key for each application. You’ll see the full secret only once."}
							</p>
							{allTokens.length ? (
								<button
									className="btn btn-small"
									type="button"
									onClick={() => {
										setQuery("")
										setStatus("all")
										setOwner("all")
									}}
								>
									Clear filters
								</button>
							) : (
								<button
									className="btn btn-primary"
									type="button"
									onClick={openCreate}
								>
									<KeyRound size={16} />
									Create your first key
								</button>
							)}
						</Empty>
					) : (
						<div
							className="table-wrap"
							role="region"
							tabIndex={0}
							aria-label="Tokens table, scroll for more columns"
						>
							<table>
								<thead>
									<tr>
										<th>Name</th>
										<th>Key</th>
										<th className="hide-sm">Owner</th>
										<th className="num hide-sm">Quota</th>
										<th className="hide-sm">Models</th>
										<th>State</th>
										<th>
											<span className="sr-only">Actions</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{tokens.map((token) => (
										<tr key={token._id}>
											<td>
												{token.name}
												<div className="hint">
													Created {formatDate(token.createdAt)}
												</div>
												{token.expiresAt ? (
													<div className="hint">
														Expires {formatDate(token.expiresAt)}
													</div>
												) : null}
											</td>
											<td className="mono">{token.masked ?? "sk-..."}</td>
											<td className="hide-sm">
												{names.get(token.userId) ?? token.userId}
											</td>
											<td className="num hide-sm">
												{token.unlimitedQuota
													? "unlimited"
													: formatNumber(token.usedQuota) +
														" / " +
														formatNumber(token.quota)}
											</td>
											<td className="hide-sm hint">
												{(token.allowedModels ?? []).length === 0
													? "any"
													: (token.allowedModels ?? []).join(", ")}
											</td>
											<td>
												<Pill
													tone={
														tokenState(token) === "expired"
															? "warn"
															: statusTone(token.status)
													}
													dot
												>
													{tokenState(token)}
												</Pill>
											</td>
											<td className="num">
												<button
													className="btn btn-small"
													type="button"
													onClick={() => rotate(token)}
													disabled={busy || Boolean(secret)}
												>
													Rotate
												</button>{" "}
												<button
													className="btn btn-small"
													type="button"
													onClick={() => toggle(token)}
													disabled={busy || Boolean(secret)}
												>
													{token.status === "enabled" ? "Disable" : "Enable"}
												</button>{" "}
												<button
													className="btn btn-small btn-danger"
													type="button"
													onClick={() => remove(token)}
													disabled={busy || Boolean(secret)}
												>
													Delete
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					<Pagination
						page={page}
						hasMore={allTokens.length === 100}
						loading={list.loading}
						count={tokens.length}
						onPage={setPage}
					/>
				</Panel>
			</section>

			<section className="section create-anchor" id="create">
				{creating ? (
					<>
						<div className="section-head">
							<h2 className="section-title">Create a gateway key</h2>
							<span className="section-note">
								shown once, then only as a digest
							</span>
						</div>
						<Panel>
							<form className="form" onSubmit={create}>
								<div className="field">
									<label htmlFor="userId">Owner</label>
									<select
										id="userId"
										value={form.userId}
										onChange={(event) =>
											setForm((current) => ({
												...current,
												userId: event.target.value,
											}))
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
											setForm((current) => ({
												...current,
												name: event.target.value,
											}))
										}
										placeholder="laptop"
										required
									/>
								</div>
								<div className="field">
									<label htmlFor="tquota">Quota</label>
									<input
										id="tquota"
										type="number"
										min={0}
										step={1}
										value={form.quota}
										onChange={(event) =>
											setForm((current) => ({
												...current,
												quota: event.target.value,
											}))
										}
										inputMode="numeric"
										placeholder="500000"
									/>
									<span className="hint">
										Quota units, not dollars. Check the overview for this
										deployment’s conversion rate.
									</span>
								</div>
								<div className="field">
									<label htmlFor="tmodels">Allowed models</label>
									<input
										id="tmodels"
										value={form.allowedModels}
										onChange={(event) =>
											setForm((current) => ({
												...current,
												allowedModels: event.target.value,
											}))
										}
										placeholder="gpt-4o, claude-*"
									/>
									<span className="hint">
										A single trailing asterisk is the only wildcard.
									</span>
								</div>
								<div className="field">
									<label htmlFor="texpiry">Expires at (your local time)</label>
									<input
										id="texpiry"
										type="datetime-local"
										value={form.expiresAt}
										onChange={(event) =>
											setForm((current) => ({
												...current,
												expiresAt: event.target.value,
											}))
										}
									/>
									<span className="hint">Leave empty for no expiration.</span>
								</div>
								<div className="field">
									<label htmlFor="tips">Allowed IPs / CIDRs</label>
									<input
										id="tips"
										value={form.allowedIps}
										onChange={(event) =>
											setForm((current) => ({
												...current,
												allowedIps: event.target.value,
											}))
										}
										placeholder="203.0.113.10, 198.51.100.0/24"
									/>
									<span className="hint">
										Comma-separated. Empty allows any IP.
									</span>
								</div>
								<div className="field field-wide">
									<div className="check">
										<input
											id="unlimited"
											type="checkbox"
											checked={form.unlimited}
											onChange={(event) =>
												setForm((current) => ({
													...current,
													unlimited: event.target.checked,
												}))
											}
										/>
										<label htmlFor="unlimited">
											No per-token quota cap (owner balance still applies)
										</label>
									</div>
								</div>
								<div className="form-foot">
									<span className="hint">Written to the audit log.</span>
									<button
										className="btn"
										type="button"
										disabled={busy}
										onClick={() => setCreating(false)}
									>
										Cancel
									</button>
									<button
										className="btn btn-primary"
										type="submit"
										disabled={busy || Boolean(secret)}
									>
										{busy ? "Creating…" : "Create API key"}
									</button>
								</div>
							</form>
						</Panel>
					</>
				) : null}
			</section>
		</>
	)
}
