"use client"

import { useState } from "react"
import type { FormEvent } from "react"

import { api } from "../api.ts"
import { useConfirm, useToast } from "../../components/interface.tsx"
import { PageHeader, RefreshButton } from "../ui.tsx"
import {
	Callout,
	ErrorNote,
	Loading,
	Panel,
	formatNumber,
	useApi,
} from "../ui.tsx"

type Pricing = {
	_id: string
	modelRatio: number
	completionRatio: number
	cachedRatio?: number
	perCallQuota?: number
}

type Mapping = { _id: string; from: string; to: string; channelId?: string }

type GroupRatio = { _id: string; ratio: number; description?: string }

export default function PricingPage() {
	const confirm = useConfirm()
	const notify = useToast()
	const pricing = useApi<{ pricing: Pricing[] }>("/api/admin/pricing")
	const mappings = useApi<{ mappings: Mapping[] }>("/api/admin/mappings")
	const ratios = useApi<{ groupRatios: GroupRatio[] }>(
		"/api/admin/group-ratios",
	)

	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [priceForm, setPriceForm] = useState({
		model: "",
		modelRatio: "",
		completionRatio: "",
	})
	const [mapForm, setMapForm] = useState({ from: "", to: "" })
	const [ratioForm, setRatioForm] = useState({ group: "", ratio: "" })

	async function run(action: () => Promise<unknown>, reload: () => void) {
		if (busy) return
		if (
			!(await confirm({
				title: "Update billing configuration?",
				description:
					"Pricing and model mappings affect future request costs and routing. Review the exact values before applying this change.",
				action: "Apply change",
			}))
		)
			return
		setBusy(true)
		setError("")
		try {
			await action()
			reload()
			notify("Billing configuration saved.")
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "the request was refused",
			)
		} finally {
			setBusy(false)
		}
	}

	function savePrice(event: FormEvent) {
		event.preventDefault()
		void run(async () => {
			await api.post("/api/admin/pricing", {
				model: priceForm.model,
				modelRatio: Number(priceForm.modelRatio),
				completionRatio: Number(priceForm.completionRatio),
			})
			setPriceForm({ model: "", modelRatio: "", completionRatio: "" })
		}, pricing.reload)
	}

	function saveMapping(event: FormEvent) {
		event.preventDefault()
		void run(async () => {
			await api.post("/api/admin/mappings", {
				from: mapForm.from,
				to: mapForm.to,
			})
			setMapForm({ from: "", to: "" })
		}, mappings.reload)
	}

	function saveRatio(event: FormEvent) {
		event.preventDefault()
		void run(async () => {
			await api.post("/api/admin/group-ratios", {
				group: ratioForm.group,
				ratio: Number(ratioForm.ratio),
			})
			setRatioForm({ group: "", ratio: "" })
		}, ratios.reload)
	}

	return (
		<>
			<PageHeader
				eyebrow="BILLING RULES"
				title="Pricing, with your own perspective."
				description="Override model rates, map model names, and tailor price multipliers for routing groups."
				actions={
					<RefreshButton
						onClick={() => {
							pricing.reload()
							mappings.reload()
							ratios.reload()
						}}
						loading={pricing.loading || mappings.loading || ratios.loading}
					/>
				}
			/>
			<ErrorNote
				message={error || pricing.error || mappings.error || ratios.error}
			/>

			<section className="section">
				<Panel title="Model pricing" note="ratios, not dollars">
					{pricing.loading && !pricing.data ? (
						<Loading />
					) : (pricing.data?.pricing ?? []).length === 0 ? (
						<div className="empty">
							No overrides. Every model falls back to the built-in catalogue.
						</div>
					) : (
						<table>
							<thead>
								<tr>
									<th>Model</th>
									<th className="num">Prompt</th>
									<th className="num">Completion</th>
									<th className="num hide-sm">Cached</th>
									<th>
										<span className="sr-only">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{(pricing.data?.pricing ?? []).map((row) => (
									<tr key={row._id}>
										<td className="mono">{row._id}</td>
										<td className="num">{row.modelRatio}</td>
										<td className="num">{row.completionRatio}</td>
										<td className="num hide-sm">
											{row.cachedRatio ?? "\u2014"}
										</td>
										<td className="num">
											<button
												className="btn btn-small btn-danger"
												type="button"
												disabled={busy}
												onClick={() =>
													run(
														() =>
															api.remove(
																"/api/admin/pricing/" +
																	encodeURIComponent(row._id),
															),
														pricing.reload,
													)
												}
											>
												Remove
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
				<Panel title="Set a price">
					<form className="form" onSubmit={savePrice}>
						<div className="field">
							<label htmlFor="model">Model</label>
							<input
								id="model"
								value={priceForm.model}
								onChange={(event) =>
									setPriceForm((current) => ({
										...current,
										model: event.target.value,
									}))
								}
								placeholder="gpt-4o"
								required
							/>
						</div>
						<div className="field">
							<label htmlFor="modelRatio">Prompt ratio</label>
							<input
								id="modelRatio"
								type="number"
								min={0}
								step="any"
								value={priceForm.modelRatio}
								onChange={(event) =>
									setPriceForm((current) => ({
										...current,
										modelRatio: event.target.value,
									}))
								}
								placeholder="1.25"
								required
							/>
							<span className="hint">
								Quota per prompt token before the group multiplier.
							</span>
						</div>
						<div className="field">
							<label htmlFor="completionRatio">Completion ratio</label>
							<input
								id="completionRatio"
								type="number"
								min={0}
								step="any"
								value={priceForm.completionRatio}
								onChange={(event) =>
									setPriceForm((current) => ({
										...current,
										completionRatio: event.target.value,
									}))
								}
								placeholder="4"
								required
							/>
						</div>
						<div className="form-foot">
							<span className="hint">
								Prices are operator-entered only. Nothing is ever synced from a
								remote catalogue.
							</span>
							<button className="btn btn-primary" type="submit" disabled={busy}>
								Save price
							</button>
						</div>
					</form>
				</Panel>
			</section>

			<section className="section split">
				<Panel title="Model mappings" note="requested name to upstream name">
					{(mappings.data?.mappings ?? []).length === 0 ? (
						<div className="empty">No mappings.</div>
					) : (
						<table>
							<tbody>
								{(mappings.data?.mappings ?? []).map((row) => (
									<tr key={row._id}>
										<td className="mono">{row.from}</td>
										<td className="mono">{row.to}</td>
										<td className="num">
											<button
												className="btn btn-small btn-danger"
												type="button"
												disabled={busy}
												onClick={() =>
													run(
														() => api.remove("/api/admin/mappings/" + row._id),
														mappings.reload,
													)
												}
											>
												Remove
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
					<form className="form" onSubmit={saveMapping}>
						<div className="field">
							<label htmlFor="from">From</label>
							<input
								id="from"
								value={mapForm.from}
								onChange={(event) =>
									setMapForm((current) => ({
										...current,
										from: event.target.value,
									}))
								}
								required
							/>
						</div>
						<div className="field">
							<label htmlFor="to">To</label>
							<input
								id="to"
								value={mapForm.to}
								onChange={(event) =>
									setMapForm((current) => ({
										...current,
										to: event.target.value,
									}))
								}
								required
							/>
						</div>
						<div className="form-foot">
							<span className="hint">
								Billing still uses the requested name.
							</span>
							<button className="btn" type="submit" disabled={busy}>
								Add mapping
							</button>
						</div>
					</form>
				</Panel>

				<Panel title="Group ratios" note="price multiplier per group">
					{(ratios.data?.groupRatios ?? []).length === 0 ? (
						<div className="empty">No groups configured.</div>
					) : (
						<table>
							<tbody>
								{(ratios.data?.groupRatios ?? []).map((row) => (
									<tr key={row._id}>
										<td className="mono">{row._id}</td>
										<td className="num">{row.ratio}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
					<form className="form" onSubmit={saveRatio}>
						<div className="field">
							<label htmlFor="group">Group</label>
							<input
								id="group"
								value={ratioForm.group}
								onChange={(event) =>
									setRatioForm((current) => ({
										...current,
										group: event.target.value,
									}))
								}
								placeholder="default"
								required
							/>
						</div>
						<div className="field">
							<label htmlFor="ratio">Ratio</label>
							<input
								id="ratio"
								type="number"
								min={0}
								step="any"
								value={ratioForm.ratio}
								onChange={(event) =>
									setRatioForm((current) => ({
										...current,
										ratio: event.target.value,
									}))
								}
								placeholder="1"
								required
							/>
						</div>
						<div className="form-foot">
							<span className="hint">
								A ratio of 0.5 halves every price for that group.
							</span>
							<button className="btn" type="submit" disabled={busy}>
								Save ratio
							</button>
						</div>
					</form>
				</Panel>
			</section>

			<Callout tone="warn">
				A nonzero price never settles to zero quota: the floor is one unit, so a
				cheap call is still a billed call.
			</Callout>
		</>
	)
}
