/**
 * The model catalogue.
 *
 * What a caller may use is the union of what the channels serving their group
 * advertise, not a hand-maintained list - a static list drifts, and a drifted
 * catalogue is a support ticket that looks like an outage.
 *
 * A channel with an empty `models` array is a deliberate catch-all: it will
 * serve anything asked of it. Those cannot be enumerated, so they contribute
 * nothing here even though requests to them succeed.
 */

import { channels, modelMappings } from "../db/index.ts"

export type ModelCard = {
	id: string
	object: "model"
	created: number
	owned_by: string
}

/** Distinct model names the group can reach, sorted for a stable response. */
export async function listModelsForGroup(group: string): Promise<string[]> {
	const collection = await channels()
	const enabled = await collection.find({ status: "enabled", autoDisabled: false })

	const names = new Set<string>()
	for (const channel of enabled) {
		const groups = Array.isArray(channel.groups) ? channel.groups : []
		if (groups.length > 0 && !groups.includes(group)) continue
		for (const model of Array.isArray(channel.models) ? channel.models : []) {
			if (typeof model === "string" && model !== "") names.add(model)
		}
	}

	// Aliases are usable names too, so a client that only reads /v1/models can
	// still discover them.
	const mappings = await (await modelMappings()).find({})
	for (const mapping of mappings) {
		if (typeof mapping.from === "string" && mapping.from !== "") names.add(mapping.from)
	}

	return [...names].sort()
}

export async function modelCardsForGroup(group: string, ownedBy = "femboy-api"): Promise<ModelCard[]> {
	const created = Math.floor(Date.now() / 1000)
	const names = await listModelsForGroup(group)
	return names.map((id) => ({ id, object: "model" as const, created, owned_by: ownedBy }))
}
