import { handleSchedulerSetup } from "../../../../lib/setup/controller.ts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 240

export const GET = handleSchedulerSetup
export const POST = handleSchedulerSetup