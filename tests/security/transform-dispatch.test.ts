process.env.ANTHROPIC_VERSION = "2023-06-01"
process.env.AZURE_DEFAULT_API_VERSION = "2024-10-21"

import test from "node:test"
import assert from "node:assert/strict"

import {
	createOpenaiStreamTranslator,
	createStreamTranslator,
	dialectFor,
	normalizeOpenaiRequest,
	provderAuthHeadersAlias as _unused,
} from "../../lib/transform/index.ts"
