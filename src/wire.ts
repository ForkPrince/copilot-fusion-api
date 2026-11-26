/**
 * Wire model: which upstream endpoint a routed request is sent to. The wire
 * is chosen by the OpenAI-compatible endpoint the client called, not by the
 * body, so `/v1/chat/completions` always stays chat and `/v1/responses`
 * always stays responses.
 */

export type Wire = "responses" | "chat" | "messages"

export function wirePath(wire: Wire): string {
  switch (wire) {
    case "responses":
      return "/responses"
    case "chat":
      return "/chat/completions"
    case "messages":
      return "/v1/messages"
  }
}

/** Map the server's public path to the upstream wire. */
export function wireForEndpoint(pathname: string): Wire | undefined {
  const path = pathname.replace(/\/+$/, "").replace(/^\/v1/, "")
  if (path === "/chat/completions") return "chat"
  if (path === "/responses") return "responses"
  if (path === "/messages") return "messages"
  return undefined
}

/** Wires advertised by a `/auto` pick or a `/models` catalog entry. */
export function wiresFromEndpoints(endpoints: unknown): ReadonlySet<Wire> {
  const result = new Set<Wire>()
  if (!Array.isArray(endpoints)) return result
  for (const raw of endpoints) {
    if (typeof raw !== "string") continue
    const path = raw.replace(/\/+$/, "")
    if (path === "/chat/completions" || path === "/v1/chat/completions") result.add("chat")
    else if (path === "/responses" || path === "/interactions") result.add("responses")
    else if (path === "/v1/messages" || path === "/messages") result.add("messages")
  }
  return result
}

/**
 * Upstream wire for a routed model. Prefer the wire the client asked for when
 * the model serves it; otherwise use one the model actually advertises.
 */
export function wireForRoutedModel(endpoints: unknown, modelId: string, requested: Wire): Wire {
  const served = wiresFromEndpoints(endpoints)
  if (served.has(requested)) return requested
  if (served.size > 0) {
    for (const candidate of ["chat", "responses", "messages"] as const) {
      if (served.has(candidate)) return candidate
    }
  }
  return wireOfModelId(modelId)
}

/** Best-effort wire guess for a model id (used for fallback anchor picks). */
export function wireOfModelId(modelId: string): Wire {
  if (/^(claude-|anthropic)/.test(modelId)) return "messages"
  if (/^(mai-|grok-)/.test(modelId)) return "responses"
  const gpt = /^gpt-(\d+)/.exec(modelId)
  if (gpt && Number(gpt[1]) >= 5 && !modelId.startsWith("gpt-5-mini")) return "responses"
  return "chat"
}
