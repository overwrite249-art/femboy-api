"use client"
import { useRef, useState } from "react"
import type { FormEvent } from "react"
import { Plus, ShieldCheck, Wallet } from "lucide-react"
import { Dialog, useConfirm, useToast } from "../../components/interface.tsx"
import { matchesSearch } from "../../../lib/console/client-utils.ts"
import { api } from "../api.ts"
import { useSession } from "../session-context.tsx"
import {
	Callout,
	Empty,
	ErrorNote,
	Loading,
	PageHeader,
	Pagination,
	Panel,
	Pill,
	RefreshButton,
	SearchInput,
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
const INITIAL = {
	username: "",
	displayName: "",
	email: "",
	role: "user",
	group: "default",
	quota: "",
}
export default function UsersPage() {
	const session = useSession()
	const [page, setPage] = useState(0)
	const list = useApi<{ users: User[] }>(
		`/api/admin/users?limit=51&skip=${page * 50}`,
	)
	const confirm = useConfirm()
	const notify = useToast()
	const pending = useRef(false)
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [query, setQuery] = useState("")
	const [role, setRole] = useState("all")
	const [creating, setCreating] = useState(false)
	const [form, setForm] = useState(INITIAL)
	const [balanceUser, setBalanceUser] = useState<User | null>(null)
	const [balance, setBalance] = useState("")
	const [balanceError, setBalanceError] = useState("")
	const roles = session?.role === "root" ? ["user", "admin", "root"] : ["user"]
	const manageable = (user: User) =>
		session?.role === "root" || user.role === "user"
	async function run(action: () => Promise<unknown>) {
		if (pending.current) return
		pending.current = true
		setBusy(true)
		setError("")
		try {
			await action()
			list.reload()
			notify("Account changes saved.")
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "The request was refused.",
			)
		} finally {
			setBusy(false)
			pending.current = false
		}
	}
	function create(event: FormEvent) {
		event.preventDefault()
		void run(async () => {
			await api.post("/api/admin/users", {
				...form,
				quota: Number(form.quota || 0),
			})
			setForm(INITIAL)
			setCreating(false)
		})
	}
	async function changeRole(user: User, value: string) {
		if (
			!(await confirm({
				title: `Change ${user.username}’s role?`,
				description: `This grants the ${value} role immediately. Admin and root accounts can manage sensitive gateway configuration. Only grant the access this person needs.`,
				action: "Change role",
				danger: value !== "user",
			}))
		)
			return
		void run(() => api.patch("/api/admin/users/" + user._id, { role: value }))
	}
	async function toggle(user: User) {
		const next = user.status === "enabled" ? "disabled" : "enabled"
		if (
			!(await confirm({
				title: `${next === "enabled" ? "Enable" : "Disable"} ${user.username}?`,
				description:
					next === "disabled"
						? "This account’s console access and gateway tokens will stop working."
						: "This account and its otherwise-valid tokens will be able to authenticate again.",
				action: next === "enabled" ? "Enable account" : "Disable account",
				danger: next === "disabled",
			}))
		)
			return
		void run(() => api.patch("/api/admin/users/" + user._id, { status: next }))
	}
	async function saveBalance(event: FormEvent) {
		event.preventDefault()
		if (pending.current || !balanceUser) return
		pending.current = true
		setBusy(true)
		setBalanceError("")
		try {
			await api.patch("/api/admin/users/" + balanceUser._id, {
				quota: Number(balance),
				expectedQuota: balanceUser.quota,
			})
			setBalanceUser(null)
			list.reload()
			notify("Quota balance updated.")
		} catch (cause) {
			setBalanceError(
				cause instanceof Error
					? cause.message
					: "The balance could not be saved.",
			)
			list.reload()
		} finally {
			pending.current = false
			setBusy(false)
		}
	}
	const loaded = list.data?.users ?? []
	const users = loaded
		.slice(0, 50)
		.filter(
			(user) =>
				matchesSearch(
					query,
					user.username,
					user.displayName,
					user.email,
					user.group,
				) &&
				(role === "all" || user.role === role),
		)
	return (
		<>
			<PageHeader
				eyebrow="Manage"
				title="Users"
				description="Set each account’s role, status and quota balance."
				actions={
					<>
						<RefreshButton onClick={list.reload} loading={list.loading} />
						<button
							className="btn btn-primary"
							type="button"
							onClick={() => setCreating(!creating)}
						>
							<Plus size={16} />
							{creating ? "Close form" : "Add user"}
						</button>
					</>
				}
			/>
			<ErrorNote message={error || list.error} />
			{creating ? (
				<section className="section">
					<Panel
						title="Create an API account"
						note="No console password is created"
					>
						<form className="form" onSubmit={create}>
							{[
								["username", "Username", "my-app"],
								["displayName", "Display name (optional)", "My application"],
								["email", "Email (optional)", ""],
								["group", "Routing group", "default"],
							].map(([name, label, placeholder]) => (
								<div className="field" key={name}>
									<label htmlFor={"user-" + name}>{label}</label>
									<input
										id={"user-" + name}
										type={name === "email" ? "email" : "text"}
										value={form[name as keyof typeof form]}
										required={name === "username" || name === "group"}
										maxLength={
											name === "username" || name === "group" ? 64 : 200
										}
										placeholder={placeholder}
										onChange={(event) =>
											setForm((current) => ({
												...current,
												[name]: event.target.value,
											}))
										}
									/>
								</div>
							))}
							<div className="field">
								<label htmlFor="user-role">Role</label>
								<select
									id="user-role"
									value={form.role}
									onChange={(event) =>
										setForm((current) => ({
											...current,
											role: event.target.value,
										}))
									}
								>
									{roles.map((value) => (
										<option key={value}>{value}</option>
									))}
								</select>
							</div>
							<div className="field">
								<label htmlFor="user-quota">
									Starting balance (quota units)
								</label>
								<input
									id="user-quota"
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
									placeholder="0"
								/>
								<span className="hint">
									This is an internal credit allocation, not a payment.
								</span>
							</div>
							<div className="form-foot">
								<span className="hint">
									No credentials will be sent by email.
								</span>
								<button
									className="btn"
									type="button"
									disabled={busy}
									onClick={() => {
										setCreating(false)
										setForm(INITIAL)
									}}
								>
									Cancel
								</button>
								<button
									className="btn btn-primary"
									type="submit"
									disabled={busy}
								>
									{busy ? "Creating…" : "Create user"}
								</button>
							</div>
						</form>
					</Panel>
				</section>
			) : null}
			<section className="section">
				<Panel title="Workspace users" note="Roles checked on every request">
					<div className="toolbar">
						<SearchInput
							value={query}
							onChange={setQuery}
							placeholder="Search people on this page…"
						/>
						<span className="filter-control">
							<select
								aria-label="Filter user role"
								value={role}
								onChange={(event) => setRole(event.target.value)}
							>
								<option value="all">All roles</option>
								<option value="user">User</option>
								<option value="admin">Admin</option>
								<option value="root">Root</option>
							</select>
						</span>
					</div>
					{list.loading && !list.data ? (
						<Loading />
					) : !users.length ? (
						<Empty>
							<h3>No users in this view</h3>
							<p>
								Try another search, or create an application owner to issue
								their first key.
							</p>
							<button
								type="button"
								className="btn btn-small"
								onClick={() => {
									setQuery("")
									setRole("all")
								}}
							>
								Clear filters
							</button>
						</Empty>
					) : (
						<div
							className="table-wrap"
							role="region"
							tabIndex={0}
							aria-label="Users table, scroll for more columns"
						>
							<table>
								<thead>
									<tr>
										<th>Account</th>
										<th>Role</th>
										<th>Group</th>
										<th className="num">Balance</th>
										<th>Status</th>
										<th>
											<span className="sr-only">Actions</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{users.map((user) => (
										<tr key={user._id}>
											<td>
												<strong>{user.displayName || user.username}</strong>
												<div className="hint">
													@{user.username}
													{user._id === session?.id ? " · You" : ""}
												</div>
												{user.email ? (
													<div className="hint">{user.email}</div>
												) : null}
											</td>
											<td>
												{session?.role === "root" &&
												user._id !== session?.id ? (
													<select
														aria-label={"Role for " + user.username}
														value={user.role}
														onChange={(event) =>
															changeRole(user, event.target.value)
														}
														disabled={busy}
													>
														{roles.map((value) => (
															<option key={value}>{value}</option>
														))}
													</select>
												) : (
													<Pill tone="info">{user.role}</Pill>
												)}
											</td>
											<td className="mono">{user.group}</td>
											<td className="num">
												{formatNumber(user.quota)}
												<div className="hint">
													{formatNumber(user.usedQuota)} used
												</div>
											</td>
											<td>
												<Pill tone={statusTone(user.status)} dot>
													{user.status}
												</Pill>
											</td>
											<td className="num">
												<button
													className="btn btn-small"
													type="button"
													disabled={busy || !manageable(user)}
													onClick={() => {
														setBalanceUser(user)
														setBalance(String(user.quota))
														setBalanceError("")
													}}
												>
													<Wallet size={14} />
													Balance
												</button>
												{user._id !== session?.id ? (
													<button
														className="btn btn-small"
														type="button"
														disabled={busy || !manageable(user)}
														onClick={() => toggle(user)}
													>
														{user.status === "enabled" ? "Disable" : "Enable"}
													</button>
												) : null}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					<Pagination
						page={page}
						hasMore={loaded.length > 50}
						loading={list.loading}
						count={users.length}
						onPage={setPage}
					/>
				</Panel>
			</section>
			<Callout tone="warn">
				Accounts created here have no console password. Issue an API key for
				application access. A trusted operator must use the documented bootstrap
				workflow to establish password access; no public first-admin claim is
				available.
			</Callout>
			<Dialog
				open={Boolean(balanceUser)}
				title={"Set balance · " + (balanceUser?.username ?? "")}
				onClose={() => {
					if (!busy) setBalanceUser(null)
				}}
			>
				<form onSubmit={saveBalance}>
					<div className="dialog-body">
						<ErrorNote message={balanceError} />
						<div className="field">
							<label htmlFor="balance-units">
								New remaining balance (quota units)
							</label>
							<input
								id="balance-units"
								type="number"
								min={0}
								step={1}
								required
								value={balance}
								onChange={(event) => setBalance(event.target.value)}
								disabled={busy}
							/>
							<span className="hint">
								Currently shown: {formatNumber(balanceUser?.quota)} units. This
								sets the balance; it does not add to it or charge a payment
								method.
							</span>
						</div>
						<p className="privacy-note">
							<ShieldCheck size={16} />
							If another request changes the balance, this edit is refused.
							Close, refresh, and review the current amount before retrying.
						</p>
					</div>
					<div className="dialog-actions">
						<button
							className="btn"
							type="button"
							disabled={busy}
							onClick={() => setBalanceUser(null)}
						>
							Cancel
						</button>
						<button
							className="btn btn-primary"
							type="submit"
							disabled={busy || Number(balance) === balanceUser?.quota}
						>
							{busy ? "Saving…" : "Set balance"}
						</button>
					</div>
				</form>
			</Dialog>
		</>
	)
}
