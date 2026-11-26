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

/** Best-effort wire guess for a model id (used for fallback anchor picks). */
export function wireOfModelId(modelId: string): Wire {
  if (/^(claude-|anthropic)/.test(modelId)) return "messages"
  if (/^(mai-|grok-)/.test(modelId)) return "responses"
  const gpt = /^gpt-(\d+)/.exec(modelId)
  if (gpt && Number(gpt[1]) >= 5 && !modelId.startsWith("gpt-5-mini")) return "responses"
  return "chat"
}
