"use client"

import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"

import { api } from "../api.ts"
import { Boxes, Plus, ShieldCheck, FlaskConical, SearchX } from "lucide-react"
import { useConfirm, useToast } from "../../components/interface.tsx"
import { matchesSearch } from "../../../lib/console/client-utils.ts"
import {
	Empty,
	PageHeader,
	Pagination,
	RefreshButton,
	SearchInput,
	StatCard,
} from "../ui.tsx"
import {
	Callout,
	ErrorNote,
	Loading,
	Panel,
	Pill,
	formatNumber,
	statusTone,
	useApi,
} from "../ui.tsx"

type Channel = {
	_id: string
	name: string
	type: string
	baseUrl: string
	status: string
	priority: number
	weight: number
	groups?: string[]
	models?: string[]
	keyCount?: number
	autoDisabled?: boolean
	failCount?: number
}

function commaList(value: string): string[] {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
}

function lineList(value: string): string[] {
	return value
		.split("\n")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
}

const EMPTY_FORM = {
	name: "",
	type: "openai",
	baseUrl: "",
	models: "",
	groups: "default",
	priority: "100",
	weight: "0",
	keys: "",
}

export default function ChannelsPage() {
	const [page, setPage] = useState(0)
	const list = useApi<{ channels: Channel[] }>(
		`/api/admin/channels?limit=100&skip=${page * 100}`,
	)
	const confirm = useConfirm()
	const notify = useToast()
	const actionPending = useRef(false)
	const [query, setQuery] = useState("")
	const [status, setStatus] = useState("all")
	const [provider, setProvider] = useState("all")
	const [creating, setCreating] = useState(false)
	useEffect(() => {
		const hash = () => {
			if (window.location.hash === "#create") setCreating(true)
		}
		hash()
		window.addEventListener("hashchange", hash)
		return () => window.removeEventListener("hashchange", hash)
	}, [])
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [report, setReport] = useState<string>("")
	const [form, setForm] = useState(EMPTY_FORM)
	const [keysFor, setKeysFor] = useState("")
	const [newKeys, setNewKeys] = useState("")

	async function run(action: () => Promise<unknown>) {
		if (actionPending.current) return
		actionPending.current = true
		setBusy(true)
		setError("")
		try {
			await action()
			list.reload()
			notify("Channel changes saved.")
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "the request was refused",
			)
		} finally {
			actionPending.current = false
			setBusy(false)
		}
	}

	function set(key: string, value: string) {
		setForm((current) => ({ ...current, [key]: value }))
	}

	function create(event: FormEvent) {
		event.preventDefault()
		void run(async () => {
			await api.post("/api/admin/channels", {
				name: form.name,
				type: form.type,
				baseUrl: form.baseUrl,
				models: commaList(form.models),
				groups: commaList(form.groups),
				priority: Number(form.priority),
				weight: Number(form.weight),
				keys: lineList(form.keys),
			})
			setForm(EMPTY_FORM)
			setCreating(false)
		})
	}

	async function toggle(channel: Channel) {
		const next = channel.status === "enabled" ? "disabled" : "enabled"
		if (
			next === "disabled" &&
			!(await confirm({
				title: `Disable ${channel.name}?`,
				description:
					"New requests will no longer route through this channel. Other enabled channels may continue serving traffic.",
				action: "Disable channel",
			}))
		)
			return
		void run(() =>
			api.patch("/api/admin/channels/" + channel._id, { status: next }),
		)
	}

	async function remove(channel: Channel) {
		if (
			!(await confirm({
				title: `Delete ${channel.name}?`,
				description:
					"This removes the channel and its sealed provider keys. Existing usage records remain, but the connection cannot be recovered from this screen.",
				action: "Delete channel",
				danger: true,
			}))
		)
			return
		void run(() => api.remove("/api/admin/channels/" + channel._id))
	}

	async function replaceKeys(event: FormEvent) {
		event.preventDefault()
		if (
			!(await confirm({
				title: "Replace every provider key?",
				description:
					"The new list replaces all keys on this channel. Old keys cannot be displayed or recovered here. Requests will use the replacement list.",
				action: "Replace keys",
				danger: true,
			}))
		)
			return
		const id = keysFor
		void run(async () => {
			await api.post("/api/admin/channels/" + id + "/keys", {
				keys: lineList(newKeys),
			})
			setNewKeys("")
			setKeysFor("")
		})
	}

	async function testAll() {
		if (
			!(await confirm({
				title: "Probe provider channels?",
				description:
					"This sends real health-check requests to provider channels. Depending on the provider, probes can consume quota or incur charges.",
				action: "Run health probes",
			}))
		)
			return
		void run(async () => {
			const result = await api.post<Record<string, unknown>>(
				"/api/admin/channels/test",
			)
			setReport(JSON.stringify(result, null, 2))
		})
	}

	const allChannels = list.data?.channels ?? []
	const channels = allChannels.filter(
		(channel) =>
			matchesSearch(
				query,
				channel.name,
				channel.type,
				channel.models,
				channel.baseUrl,
			) &&
			(provider === "all" || channel.type === provider) &&
			(status === "all" ||
				(channel.autoDisabled ? "auto-disabled" : channel.status) === status),
	)
	function preset(type: string, baseUrl: string) {
		setForm((current) => ({
			...current,
			type,
			baseUrl,
			name: current.name || type + "-primary",
		}))
	}
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
				title="Provider channels"
				description="Connect providers and control routing. Applications stay independent of any single model."
				actions={
					<>
						<RefreshButton onClick={list.reload} loading={list.loading} />
						<button
							className="btn btn-primary"
							type="button"
							onClick={openCreate}
						>
							<Plus size={16} />
							Add channel
						</button>
					</>
				}
			/>
			<ErrorNote message={error || list.error} />

			<section className="section">
				<div className="section-head">
					<h2 className="section-title">Provider channels</h2>
					<span className="section-note">
						Higher priority first · equal priority balances by weight
					</span>
					<button
						className="btn btn-small"
						type="button"
						onClick={testAll}
						disabled={busy || !allChannels.length}
					>
						<FlaskConical size={15} />
						Test channels
					</button>
				</div>

				<Panel>
					<div className="toolbar">
						<SearchInput
							value={query}
							onChange={setQuery}
							placeholder="Search channels on this page…"
						/>
						<span className="filter-control">
							<select
								aria-label="Filter channel status"
								value={status}
								onChange={(event) => setStatus(event.target.value)}
							>
								<option value="all">All states</option>
								<option value="enabled">Enabled</option>
								<option value="disabled">Disabled</option>
								<option value="auto-disabled">Auto-disabled</option>
							</select>
						</span>
						<span className="filter-control">
							<select
								aria-label="Filter provider"
								value={provider}
								onChange={(event) => setProvider(event.target.value)}
							>
								<option value="all">All providers</option>
								{Array.from(new Set(allChannels.map((channel) => channel.type)))
									.sort()
									.map((value) => (
										<option key={value}>{value}</option>
									))}
							</select>
						</span>
					</div>
					{list.loading && channels.length === 0 ? (
						<Loading />
					) : channels.length === 0 ? (
						<Empty>
							<h3>
								{allChannels.length
									? "No matching channels"
									: "No channels configured"}
							</h3>
							<p>
								{allChannels.length
									? "Try a different search or reset your filters."
									: "Add a channel to point the gateway at a provider account and its model list."}
							</p>
							{allChannels.length ? (
								<button
									className="btn btn-small"
									type="button"
									onClick={() => {
										setQuery("")
										setStatus("all")
										setProvider("all")
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
									<Plus size={16} />
									Connect a provider
								</button>
							)}
						</Empty>
					) : (
						<div
							className="table-wrap"
							role="region"
							tabIndex={0}
							aria-label="Channels table, scroll for more columns"
						>
							<table>
								<thead>
									<tr>
										<th>Name</th>
										<th>Provider</th>
										<th className="hide-sm">Models</th>
										<th className="num hide-sm">Priority</th>
										<th className="num hide-sm">Weight</th>
										<th className="num hide-sm">Keys</th>
										<th>State</th>
										<th>
											<span className="sr-only">Actions</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{channels.map((channel) => (
										<tr key={channel._id}>
											<td>
												{channel.name}
												<div className="hint mono">{channel.baseUrl}</div>
											</td>
											<td className="mono">{channel.type}</td>
											<td className="hide-sm hint">
												{(channel.models ?? []).length === 0
													? "any"
													: (channel.models ?? []).join(", ")}
											</td>
											<td className="num hide-sm">
												{formatNumber(channel.priority)}
											</td>
											<td className="num hide-sm">
												{formatNumber(channel.weight)}
											</td>
											<td className="num hide-sm">
												{formatNumber(channel.keyCount ?? 0)}
											</td>
											<td>
												<Pill
													tone={
														channel.autoDisabled
															? "bad"
															: statusTone(channel.status)
													}
													dot
												>
													{channel.autoDisabled
														? "auto-disabled"
														: channel.status}
												</Pill>
												{channel.failCount ? (
													<div className="hint">
														{formatNumber(channel.failCount)} fails
													</div>
												) : null}
											</td>
											<td className="num">
												<button
													className="btn btn-small"
													type="button"
													onClick={() => toggle(channel)}
													disabled={busy}
												>
													{channel.status === "enabled" ? "Disable" : "Enable"}
												</button>{" "}
												<button
													className="btn btn-small"
													type="button"
													onClick={() => {
														setNewKeys("")
														setKeysFor(channel._id)
														setTimeout(
															() => document.getElementById("newkeys")?.focus(),
															0,
														)
													}}
													disabled={busy}
												>
													Keys
												</button>{" "}
												<button
													className="btn btn-small btn-danger"
													type="button"
													onClick={() => remove(channel)}
													disabled={busy}
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
						hasMore={allChannels.length === 100}
						loading={list.loading}
						count={channels.length}
						onPage={setPage}
					/>
				</Panel>
			</section>

			{report ? (
				<section className="section">
					<Panel title="Test report" note="one probe per channel">
						<pre className="code">{report}</pre>
					</Panel>
				</section>
			) : null}

			{keysFor ? (
				<section className="section">
					<Panel title="Replace keys" note={keysFor}>
						<form className="form" onSubmit={replaceKeys}>
							<div className="field field-wide">
								<label htmlFor="newkeys">Keys, one per line</label>
								<textarea
									id="newkeys"
									autoComplete="off"
									spellCheck={false}
									required
									rows={4}
									value={newKeys}
									onChange={(event) => setNewKeys(event.target.value)}
								/>
								<span className="hint">
									This replaces every key on the channel. Existing keys are
									sealed and cannot be read back, so they cannot be merged.
								</span>
							</div>
							<div className="form-foot">
								<span className="hint">Written to the audit log.</span>
								<button
									className="btn"
									type="button"
									onClick={() => {
										setKeysFor("")
										setNewKeys("")
									}}
								>
									Cancel
								</button>
								<button
									className="btn btn-primary"
									type="submit"
									disabled={busy}
								>
									Replace
								</button>
							</div>
						</form>
					</Panel>
				</section>
			) : null}

			<section className="section create-anchor" id="create">
				{creating ? (
					<>
						<div className="section-head">
							<h2 className="section-title">Connect a new provider</h2>
							<span className="section-note">
								Provider credentials are encrypted before storage
							</span>
						</div>
						<Panel>
							<div
								className="provider-presets"
								role="group"
								aria-label="Provider presets"
							>
								{[
									["openai", "https://api.openai.com"],
									["anthropic", "https://api.anthropic.com"],
									["gemini", "https://generativelanguage.googleapis.com"],
									["openrouter", "https://openrouter.ai/api"],
								].map(([type, url]) => (
									<button
										className={
											"btn btn-small" + (form.type === type ? " selected" : "")
										}
										type="button"
										key={type}
										onClick={() => preset(type, url)}
										disabled={busy}
									>
										{type}
									</button>
								))}
							</div>
							<form className="form" onSubmit={create} autoComplete="off">
								<div className="field">
									<label htmlFor="name">Name</label>
									<input
										id="name"
										value={form.name}
										onChange={(event) => set("name", event.target.value)}
										placeholder="openai-primary"
										required
									/>
								</div>
								<div className="field">
									<label htmlFor="type">Provider</label>
									<select
										id="type"
										value={form.type}
										onChange={(event) => set("type", event.target.value)}
									>
										<option value="openai">openai</option>
										<option value="azure">azure</option>
										<option value="anthropic">anthropic</option>
										<option value="gemini">gemini</option>
										<option value="vertex">vertex</option>
										<option value="deepseek">deepseek</option>
										<option value="groq">groq</option>
										<option value="openrouter">openrouter</option>
										<option value="ollama">ollama</option>
									</select>
								</div>
								<div className="field field-wide">
									<label htmlFor="baseUrl">Base URL</label>
									<input
										id="baseUrl"
										type="url"
										value={form.baseUrl}
										onChange={(event) => set("baseUrl", event.target.value)}
										placeholder="https://api.openai.com"
										required
									/>
									<span className="hint">
										Private addresses and link-local ranges are refused,
										including via redirect.
									</span>
								</div>
								<div className="field">
									<label htmlFor="models">Models</label>
									<input
										id="models"
										value={form.models}
										onChange={(event) => set("models", event.target.value)}
										placeholder="gpt-4o, gpt-4o-mini"
									/>
									<span className="hint">
										Empty means this channel may serve any model.
									</span>
								</div>
								<div className="field">
									<label htmlFor="groups">Groups</label>
									<input
										id="groups"
										value={form.groups}
										onChange={(event) => set("groups", event.target.value)}
									/>
								</div>
								<div className="field">
									<label htmlFor="priority">Priority</label>
									<input
										id="priority"
										type="number"
										min={0}
										max={1000000}
										required
										value={form.priority}
										onChange={(event) => set("priority", event.target.value)}
										inputMode="numeric"
									/>
								</div>
								<div className="field">
									<label htmlFor="weight">Weight</label>
									<input
										id="weight"
										type="number"
										min={0}
										max={1000000}
										required
										value={form.weight}
										onChange={(event) => set("weight", event.target.value)}
										inputMode="numeric"
									/>
									<span className="hint">
										A weight of 0 still receives traffic; the floor is 10.
									</span>
								</div>
								<div className="field field-wide">
									<label htmlFor="keys">API keys, one per line</label>
									<textarea
										id="keys"
										autoComplete="off"
										spellCheck={false}
										required
										rows={3}
										value={form.keys}
										onChange={(event) => set("keys", event.target.value)}
									/>
									<span className="hint">
										Rotated round-robin. A key that fails repeatedly is skipped
										before the channel is.
									</span>
								</div>
								<div className="form-foot">
									<span className="hint">Written to the audit log.</span>
									<button
										className="btn"
										type="button"
										disabled={busy}
										onClick={() => {
											setCreating(false)
											setForm(EMPTY_FORM)
										}}
									>
										Cancel
									</button>
									<button
										className="btn btn-primary"
										type="submit"
										disabled={busy}
									>
										{busy ? "Saving…" : "Create channel"}
									</button>
								</div>
							</form>
						</Panel>
					</>
				) : null}
			</section>

			<Callout tone="warn">
				A provider key entered here can never be displayed again. Keep your own
				copy if you need one.
			</Callout>
		</>
	)
}
