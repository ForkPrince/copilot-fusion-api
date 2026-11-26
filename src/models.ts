/** OpenAI-visible model catalog and Fusion tier selection. */
import type { FusionVariant } from "./tiers.js"

const CREATED = 1_735_689_600 // stable value; model list should not churn

export interface OpenAIModel {
  readonly id: string
  readonly object: "model"
  readonly created: number
  readonly owned_by: string
}

/** Aliases with an explicit tier. `undefined` means "defer to reasoning_effort". */
const MODEL_ALIASES: Readonly<Record<string, FusionVariant | undefined>> = {
  "copilot-fusion": undefined,
  "copilot-fusion-standard": "standard",
  "copilot-fusion-high": "high",
  "copilot-fusion-max": "max",
  fusion: undefined,
  "fusion-standard": "standard",
  "fusion-high": "high",
  "fusion-max": "max",
  "github-copilot/fusion": undefined,
  "github-copilot/fusion-standard": "standard",
  "github-copilot/fusion-high": "high",
  "github-copilot/fusion-max": "max",
  "github-copilot/fusion#standard": "standard",
  "github-copilot/fusion#high": "high",
  "github-copilot/fusion#max": "max",
}

export const MODEL_IDS: readonly string[] = [
  "copilot-fusion",
  "copilot-fusion-standard",
  "copilot-fusion-high",
  "copilot-fusion-max",
]

export function listOpenAIModels(): { readonly object: "list"; readonly data: OpenAIModel[] } {
  return {
    object: "list",
    data: MODEL_IDS.map((id) => ({ id, object: "model", created: CREATED, owned_by: "github-copilot" })),
  }
}

export function isKnownModel(model: unknown): boolean {
  if (typeof model !== "string") return false
  const normalized = model.trim().toLowerCase()
  if (MODEL_ALIASES[normalized] !== undefined) return true
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, normalized)) return true
  return /#(standard|high|max)$/.test(normalized)
}

function normalizeEffort(value: unknown): FusionVariant | undefined {
  if (typeof value !== "string") return undefined
  switch (value.trim().toLowerCase()) {
    case "low":
    case "minimal":
    case "none":
      return "standard"
    case "medium":
    case "high":
      return "high"
    case "xhigh":
      return "max"
    default:
      return undefined
  }
}

/**
 * Resolve the Fusion tier from the model name and/or OpenAI reasoning effort.
 * An explicit tier in the model name always wins; otherwise the effort maps
 * low -> Standard, medium/high -> High, xhigh -> Max.
 */
export function tierFromRequest(model: unknown, reasoningEffort?: unknown): FusionVariant | undefined {
  const name = typeof model === "string" ? model.trim().toLowerCase() : ""
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, name)) {
    const explicit = MODEL_ALIASES[name]
    if (explicit) return explicit
  }
  const suffix = /#(standard|high|max)$/.exec(name)
  if (suffix?.[1]) return suffix[1] as FusionVariant
  if (!name || !isKnownModel(name)) return undefined
  const effort = normalizeEffort(reasoningEffort)
  if (effort) return effort
  if (name && Object.prototype.hasOwnProperty.call(MODEL_ALIASES, name)) return "standard"
  return undefined
}

/** Extract a reasoning effort from either Chat Completions or Responses shape. */
export function effortFromBody(body: Record<string, unknown>): unknown {
  if (typeof body.reasoning_effort === "string") return body.reasoning_effort
  const reasoning = body.reasoning
  if (typeof reasoning === "object" && reasoning !== null) {
    return (reasoning as Record<string, unknown>).effort
  }
  return undefined
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function cleanSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const cleaned = value.trim().replace(/[^\w.\-:/]/g, "_").slice(0, 200)
  return cleaned || undefined
}

/** Sticky routing key. Clients opt in with `X-Session-ID` (or body fields). */
export function sessionIdFrom(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  body: Record<string, unknown>,
): string {
  return cleanSessionId(headerValue(headers["x-session-id"]) ?? headerValue(headers["x-conversation-id"]))
    ?? cleanSessionId(body.session_id)
    ?? cleanSessionId(body.conversation_id)
    ?? cleanSessionId(body.user)
    ?? "default"
}
