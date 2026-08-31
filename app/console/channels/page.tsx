"use client"

import { useState } from "react"
import type { FormEvent } from "react"

import { api } from "../api.ts"
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
	const list = useApi<{ channels: Channel[] }>("/api/admin/channels?limit=100")
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [report, setReport] = useState<string>("")
	const [form, setForm] = useState(EMPTY_FORM)
	const [keysFor, setKeysFor] = useState("")
	const [newKeys, setNewKeys] = useState("")

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
		})
	}

	function toggle(channel: Channel) {
		const next = channel.status === "enabled" ? "disabled" : "enabled"
		void run(() => api.patch("/api/admin/channels/" + channel._id, { status: next }))
	}

	function remove(channel: Channel) {
		void run(() => api.remove("/api/admin/channels/" + channel._id))
	}

	function replaceKeys(event: FormEvent) {
		event.preventDefault()
		const id = keysFor
		void run(async () => {
			await api.post("/api/admin/channels/" + id + "/keys", { keys: lineList(newKeys) })
			setNewKeys("")
			setKeysFor("")
		})
	}

	function testAll() {
		void run(async () => {
			const result = await api.post<Record<string, unknown>>("/api/admin/channels/test")
			setReport(JSON.stringify(result, null, 2))
		})
	}

	const channels = list.data?.channels ?? []

	return (
		<>
			<ErrorNote message={error || list.error} />

			<section className="section">
				<div className="section-head">
					<h2 className="section-title">Channels</h2>
					<span className="section-note">
						higher priority wins outright; equal priority load-balances by weight
					</span>
					<button className="btn btn-small" type="button" onClick={testAll} disabled={busy}>
						Test all
					</button>
				</div>

				<Panel>
					{list.loading && channels.length === 0 ? (
						<Loading />
					) : channels.length === 0 ? (
						<div className="empty">No channels yet. Add one below.</div>
					) : (
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
									<th />
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
										<td className="num hide-sm">{formatNumber(channel.priority)}</td>
										<td className="num hide-sm">{formatNumber(channel.weight)}</td>
										<td className="num hide-sm">{formatNumber(channel.keyCount ?? 0)}</td>
										<td>
											<Pill tone={channel.autoDisabled ? "bad" : statusTone(channel.status)} dot>
												{channel.autoDisabled ? "auto-disabled" : channel.status}
											</Pill>
											{channel.failCount ? (
												<div className="hint">{formatNumber(channel.failCount)} fails</div>
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
												onClick={() => setKeysFor(channel._id)}
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
					)}
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
									rows={4}
									value={newKeys}
									onChange={(event) => setNewKeys(event.target.value)}
								/>
								<span className="hint">
									This replaces every key on the channel. Existing keys are sealed and
									cannot be read back, so they cannot be merged.
								</span>
							</div>
							<div className="form-foot">
								<span className="hint">Written to the audit log.</span>
								<button className="btn" type="button" onClick={() => setKeysFor("")}>
									Cancel
								</button>
								<button className="btn btn-primary" type="submit" disabled={busy}>
									Replace
								</button>
							</div>
						</form>
					</Panel>
				</section>
			) : null}

			<section className="section">
				<div className="section-head">
					<h2 className="section-title">Add channel</h2>
					<span className="section-note">keys are sealed with AES-GCM before storage</span>
				</div>
				<Panel>
					<form className="form" onSubmit={create}>
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
								value={form.baseUrl}
								onChange={(event) => set("baseUrl", event.target.value)}
								placeholder="https://api.openai.com"
								required
							/>
							<span className="hint">
								Private addresses and link-local ranges are refused, including via
								redirect.
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
							<span className="hint">Empty means this channel may serve any model.</span>
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
								value={form.priority}
								onChange={(event) => set("priority", event.target.value)}
								inputMode="numeric"
							/>
						</div>
						<div className="field">
							<label htmlFor="weight">Weight</label>
							<input
								id="weight"
								value={form.weight}
								onChange={(event) => set("weight", event.target.value)}
								inputMode="numeric"
							/>
							<span className="hint">A weight of 0 still receives traffic; the floor is 10.</span>
						</div>
						<div className="field field-wide">
							<label htmlFor="keys">API keys, one per line</label>
							<textarea
								id="keys"
								rows={3}
								value={form.keys}
								onChange={(event) => set("keys", event.target.value)}
							/>
							<span className="hint">
								Rotated round-robin. A key that fails repeatedly is skipped before the
								channel is.
							</span>
						</div>
						<div className="form-foot">
							<span className="hint">Written to the audit log.</span>
							<button className="btn btn-primary" type="submit" disabled={busy}>
								Create channel
							</button>
						</div>
					</form>
				</Panel>
			</section>

			<Callout tone="warn">
				A provider key entered here can never be displayed again. Keep your own copy
				if you need one.
			</Callout>
		</>
	)
}
