/** OpenAI-visible model catalog and tier selection for Fusion and classic Auto. */
import { AUTO_TIERS, FUSION_TIERS, tierSpecFor, type FusionVariant, type RouteFamily, type TierSpec } from "./tiers.js"

const CREATED = 1_735_689_600 // stable value; model list should not churn

export interface OpenAIModel {
  readonly id: string
  readonly object: "model"
  readonly created: number
  readonly owned_by: string
}

/** Aliases with an explicit tier. `undefined` means "defer to reasoning_effort". */
const MODEL_ALIASES: Readonly<Record<string, TierSpec | undefined>> = {
  // Fusion
  "copilot-fusion": undefined,
  "copilot-fusion-standard": tierSpecFor("fusion", "standard"),
  "copilot-fusion-high": tierSpecFor("fusion", "high"),
  "copilot-fusion-max": tierSpecFor("fusion", "max"),
  fusion: undefined,
  "fusion-standard": tierSpecFor("fusion", "standard"),
  "fusion-high": tierSpecFor("fusion", "high"),
  "fusion-max": tierSpecFor("fusion", "max"),
  "github-copilot/fusion": undefined,
  "github-copilot/fusion-standard": tierSpecFor("fusion", "standard"),
  "github-copilot/fusion-high": tierSpecFor("fusion", "high"),
  "github-copilot/fusion-max": tierSpecFor("fusion", "max"),
  "github-copilot/fusion#standard": tierSpecFor("fusion", "standard"),
  "github-copilot/fusion#high": tierSpecFor("fusion", "high"),
  "github-copilot/fusion#max": tierSpecFor("fusion", "max"),
  // Classic Auto
  auto: undefined,
  "copilot-auto": undefined,
  "github-copilot/auto": undefined,
  "auto-efficiency": tierSpecFor("auto", "efficiency"),
  "auto-balance": tierSpecFor("auto", "balance"),
  "auto-intelligence": tierSpecFor("auto", "intelligence"),
  "auto-fast": tierSpecFor("auto", "fast"),
  "copilot-auto-efficiency": tierSpecFor("auto", "efficiency"),
  "copilot-auto-balance": tierSpecFor("auto", "balance"),
  "copilot-auto-intelligence": tierSpecFor("auto", "intelligence"),
  "copilot-auto-fast": tierSpecFor("auto", "fast"),
  "github-copilot/auto#efficiency": tierSpecFor("auto", "efficiency"),
  "github-copilot/auto#balance": tierSpecFor("auto", "balance"),
  "github-copilot/auto#intelligence": tierSpecFor("auto", "intelligence"),
  "github-copilot/auto#fast": tierSpecFor("auto", "fast"),
}

const DEFAULT_VARIANT: Readonly<Record<RouteFamily, string>> = { fusion: "standard", auto: "balance" }

export const MODEL_IDS: readonly string[] = [
  "copilot-fusion",
  "copilot-fusion-standard",
  "copilot-fusion-high",
  "copilot-fusion-max",
  "copilot-auto",
  "copilot-auto-efficiency",
  "copilot-auto-balance",
  "copilot-auto-intelligence",
  "copilot-auto-fast",
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
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, normalized)) return true
  const suffix = /#(standard|high|max)$/.exec(normalized)
  if (suffix) return /fusion/.test(normalized)
  return /#(efficiency|balance|intelligence|fast)$/.test(normalized)
}

function familyOf(name: string): RouteFamily {
  return /auto/.test(name) ? "auto" : "fusion"
}

function normalizeEffort(value: unknown, family: RouteFamily): string | undefined {
  if (typeof value !== "string") return undefined
  switch (value.trim().toLowerCase()) {
    case "low":
    case "minimal":
    case "none":
      return family === "fusion" ? "standard" : "efficiency"
    case "medium":
      return family === "fusion" ? "high" : "balance"
    case "high":
      return family === "fusion" ? "high" : "intelligence"
    case "xhigh":
      return family === "fusion" ? "max" : "intelligence"
    default:
      return undefined
  }
}

/**
 * Resolve the tier to send to /auto from the model name and/or OpenAI
 * reasoning effort. An explicit tier in the name always wins. Fusion effort
 * maps low -> Standard, medium/high -> High, xhigh -> Max; Auto effort maps
 * low -> Efficiency, medium -> Balance, high/xhigh -> Intelligence.
 */
export function routeSpecFromRequest(model: unknown, reasoningEffort?: unknown): TierSpec | undefined {
  const name = typeof model === "string" ? model.trim().toLowerCase() : ""
  if (!name || !isKnownModel(name)) return undefined
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, name)) {
    const explicit = MODEL_ALIASES[name]
    if (explicit) return explicit
  }
  const hash = /#(standard|high|max|efficiency|balance|intelligence|fast)$/.exec(name)
  if (hash?.[1]) {
    const bySuffix = tierSpecFor(familyOf(name), hash[1])
    if (bySuffix) return bySuffix
  }
  const family = familyOf(name)
  const effort = normalizeEffort(reasoningEffort, family)
  return tierSpecFor(family, effort ?? DEFAULT_VARIANT[family])
}

/** Fusion-only view kept for callers that only understand Fusion variants. */
export function tierFromRequest(model: unknown, reasoningEffort?: unknown): FusionVariant | undefined {
  const spec = routeSpecFromRequest(model, reasoningEffort)
  return spec?.family === "fusion" ? spec.variant as FusionVariant : undefined
}

export const AUTO_MODEL_IDS: readonly string[] = MODEL_IDS.filter((id) => id.includes("auto"))
export { AUTO_TIERS, FUSION_TIERS }

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
