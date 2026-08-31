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

type User = {
	_id: string
	username: string
	displayName?: string
	email?: string
	role: string
	status: string
	group: string
	quota: number
	usedQuota: number
	requestCount?: number
}

const ROLES = ["user", "admin", "root"]

export default function UsersPage() {
	const list = useApi<{ users: User[] }>("/api/admin/users?limit=200")
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [form, setForm] = useState({ username: "", role: "user", group: "default", quota: "" })

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
				username: form.username,
				role: form.role,
				group: form.group,
			}
			if (form.quota) body.quota = Number(form.quota)
			await api.post("/api/admin/users", body)
			setForm({ username: "", role: "user", group: "default", quota: "" })
		})
	}

	function setRole(user: User, role: string) {
		void run(() => api.patch("/api/admin/users/" + user._id, { role }))
	}

	function toggle(user: User) {
		const next = user.status === "enabled" ? "disabled" : "enabled"
		void run(() => api.patch("/api/admin/users/" + user._id, { status: next }))
	}

	function topUp(user: User) {
		void run(() =>
			api.patch("/api/admin/users/" + user._id, { quota: user.quota + 500000 }),
		)
	}

	const users = list.data?.users ?? []

	return (
		<>
			<ErrorNote message={error || list.error} />

			<section className="section">
				<Panel title="Users" note="role is re-read from the database on every request">
					{list.loading && users.length === 0 ? (
						<Loading />
					) : users.length === 0 ? (
						<div className="empty">No users yet.</div>
					) : (
						<table>
							<thead>
								<tr>
									<th>Username</th>
									<th>Role</th>
									<th className="hide-sm">Group</th>
									<th className="num">Balance</th>
									<th className="num hide-sm">Requests</th>
									<th>State</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{users.map((user) => (
									<tr key={user._id}>
										<td>
											{user.username}
											{user.email ? <div className="hint">{user.email}</div> : null}
										</td>
										<td>
											<select
												value={user.role}
												onChange={(event) => setRole(user, event.target.value)}
												disabled={busy}
											>
												{ROLES.map((role) => (
													<option key={role} value={role}>
														{role}
													</option>
												))}
											</select>
										</td>
										<td className="hide-sm mono">{user.group}</td>
										<td className="num">
											{formatNumber(user.quota)}
											<div className="hint">spent {formatNumber(user.usedQuota)}</div>
										</td>
										<td className="num hide-sm">{formatNumber(user.requestCount ?? 0)}</td>
										<td>
											<Pill tone={statusTone(user.status)} dot>
												{user.status}
											</Pill>
										</td>
										<td className="num">
											<button
												className="btn btn-small"
												type="button"
												onClick={() => topUp(user)}
												disabled={busy}
											>
												Add $1
											</button>{" "}
											<button
												className="btn btn-small"
												type="button"
												onClick={() => toggle(user)}
												disabled={busy}
											>
												{user.status === "enabled" ? "Disable" : "Enable"}
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
				<Panel title="Add user">
					<form className="form" onSubmit={create}>
						<div className="field">
							<label htmlFor="username">Username</label>
							<input
								id="username"
								value={form.username}
								onChange={(event) =>
									setForm((current) => ({ ...current, username: event.target.value }))
								}
								required
							/>
						</div>
						<div className="field">
							<label htmlFor="role">Role</label>
							<select
								id="role"
								value={form.role}
								onChange={(event) =>
									setForm((current) => ({ ...current, role: event.target.value }))
								}
							>
								{ROLES.map((role) => (
									<option key={role} value={role}>
										{role}
									</option>
								))}
							</select>
						</div>
						<div className="field">
							<label htmlFor="group">Group</label>
							<input
								id="group"
								value={form.group}
								onChange={(event) =>
									setForm((current) => ({ ...current, group: event.target.value }))
								}
							/>
							<span className="hint">Groups carry a price multiplier.</span>
						</div>
						<div className="field">
							<label htmlFor="uquota">Starting balance</label>
							<input
								id="uquota"
								value={form.quota}
								onChange={(event) =>
									setForm((current) => ({ ...current, quota: event.target.value }))
								}
								inputMode="numeric"
								placeholder="500000"
							/>
						</div>
						<div className="form-foot">
							<span className="hint">Written to the audit log.</span>
							<button className="btn btn-primary" type="submit" disabled={busy}>
								Add user
							</button>
						</div>
					</form>
				</Panel>
			</section>

			<Callout tone="warn">
				A user created here has no password and cannot sign in to the console. Give
				them an API key, or run the bootstrap script to set a password.
			</Callout>
		</>
	)
}
