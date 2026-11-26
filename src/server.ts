/**
 * Standalone OpenAI-compatible HTTP API backed by Copilot Fusion routing.
 *
 * Public endpoints:
 *   GET  /health
 *   GET  /v1/models
 *   POST /v1/chat/completions   (JSON or SSE when `stream: true`)
 *   POST /v1/responses          (JSON or SSE when `stream: true`)
 *
 * Routing is best-effort: if `/auto` fails or the pick cannot serve the
 * requested wire, the request goes out unmodified against a catalog model,
 * exactly like it would without Fusion.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { FusionRouter } from "./router.js"
import type { CopilotCredentials, CredentialProvider } from "./creds.js"
import { copilotHeaders, describeError, type FetchLike } from "./http.js"
import { chatToResponses, responsesToChat, ResponsesToChatStream } from "./bridge.js"
import { extractPromptFromBody } from "./prompt.js"
import { COPILOT_API_VERSION, resolveWireTier } from "./tiers.js"
import { wireForEndpoint, wireForRoutedModel, wirePath, type Wire } from "./wire.js"
import {
  effortFromBody,
  isKnownModel,
  listOpenAIModels,
  MODEL_IDS,
  sessionIdFrom,
  tierFromRequest,
} from "./models.js"
import type { FusionOptions } from "./options.js"

const MAX_BODY_BYTES = 16 * 1024 * 1024
const RETRIABLE_STATUS = new Set([400, 401, 403, 404, 422])

export interface ServerOptions extends FusionOptions {
  readonly creds: CredentialProvider
  readonly apiKey?: string
  readonly router?: FusionRouter
  readonly fetchImpl?: FetchLike
  readonly log?: (...args: string[]) => void
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  })
  res.end(text)
}

function sendError(res: ServerResponse, status: number, message: string, code?: string): void {
  sendJson(res, status, {
    error: {
      message,
      type: status === 500 ? "server_error" : "invalid_request_error",
      ...(code ? { code } : {}),
    },
  })
}

function authorized(headers: IncomingMessage["headers"], apiKey: string | undefined): boolean {
  if (!apiKey) return true
  const header = headers.authorization
  const value = Array.isArray(header) ? header[0] : header
  const bearer = value?.startsWith("Bearer ") ? value.slice(7) : undefined
  const candidates = [bearer, headers["x-api-key"]].filter((c): c is string => !!c)
  const expected = Buffer.from(apiKey)
  return candidates.some((candidate) => {
    const actual = Buffer.from(candidate)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large")
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new HttpError(400, "request body must be valid JSON")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "request body must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

export function createServer(options: ServerOptions): Server {
  const log = (...args: string[]) => options.log?.(...args)
  const warn = (...args: string[]) => log("[warn]", ...args)
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  const router = options.router ?? new FusionRouter({
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    skewMs: options.skewMs,
    log,
  })

  const handleInference = async (req: IncomingMessage, res: ServerResponse, wire: Wire): Promise<void> => {
    const body = await readBody(req)
    if (!isKnownModel(body.model)) {
      sendError(
        res,
        404,
        `Unknown model '${String(body.model)}'. Available models: ${MODEL_IDS.join(", ")}`,
        "model_not_found",
      )
      return
    }
    const variant = tierFromRequest(body.model, effortFromBody(body))
    if (!variant) {
      sendError(res, 400, "could not resolve a Fusion tier for this model", "invalid_model")
      return
    }

    let credentials: CopilotCredentials
    try {
      credentials = await options.creds.get()
    } catch (error) {
      sendError(res, 503, `Copilot is not authenticated: ${describeError(error)}`, "copilot_auth_required")
      return
    }

    const sessionID = sessionIdFrom(req.headers, body)
    const meta = await router.getMeta(credentials.baseURL, credentials.token).catch(() => undefined)
    const resolved = resolveWireTier(variant, meta?.byId)
    let routeFailure: string | undefined
    if (!resolved) {
      routeFailure = `Fusion tier '${variant}' is disabled for this account`
      warn(routeFailure)
    }

    let modelId: string | undefined
    let sessionToken: string | undefined
    let routed = false
    let upstreamWire: Wire = wire
    const prompt = extractPromptFromBody(body)
    if (resolved && prompt && (prompt.text.trim() || prompt.image)) {
      const result = await router.route({
        baseURL: credentials.baseURL,
        token: credentials.token,
        credsKey: credentials.key,
        sessionID,
        variant,
        wire,
        tier: resolved.wire,
        text: prompt.text,
        image: prompt.image,
        route: options.route,
      })
      if (result.ok) {
        modelId = result.entry.modelId
        sessionToken = result.entry.sessionToken
        routed = true
        upstreamWire = wireForRoutedModel(result.entry.endpoints, modelId, wire)
        log(
          `fusion: ${variant} -> ${modelId}${resolved.degraded ? " (degraded tier)" : ""}` +
            (upstreamWire === wire ? "" : ` (bridging ${wire} -> ${upstreamWire})`),
        )
      } else {
        if (result.code === "http_401" || result.code === "http_403") options.creds.invalidate()
        routeFailure = `route unavailable (${result.reason})`
        warn(`fusion ${routeFailure}`)
      }
    }

    if (!modelId) {
      if (options.strict) {
        sendError(
          res,
          503,
          `Fusion could not route this request: ${routeFailure ?? "no routable prompt in the request"}. ` +
            `Set FUSION_STRICT=0 to allow a plain-model fallback.`,
          "fusion_unavailable",
        )
        return
      }
      modelId = await router.resolveAnchor(credentials.baseURL, credentials.token, wire, options.anchorModel)
    }

    const isStream = body.stream === true
    let lastAttemptBridged = false
    const attempt = async (
      targetModel: string,
      targetSessionToken?: string,
      isRouted = false,
      targetWire: Wire = wire,
    ): Promise<Response> => {
      lastAttemptBridged = isRouted && wire === "chat" && targetWire === "responses"
      let nextBody: Record<string, unknown> = { ...body, model: targetModel }
      // `session_id` is our routing hint, not an OpenAI/Copilot field.
      delete nextBody.session_id
      if (isRouted && options.stripTemperature !== false) delete nextBody.temperature
      if (lastAttemptBridged) nextBody = chatToResponses(nextBody) as Record<string, unknown>
      const headers: Record<string, string> = {
        ...copilotHeaders(credentials.token, COPILOT_API_VERSION),
        Accept: isStream ? "text/event-stream" : "application/json",
      }
      if (targetSessionToken) headers["Copilot-Session-Token"] = targetSessionToken
      const beta = req.headers["openai-beta"]
      if (typeof beta === "string") headers["OpenAI-Beta"] = beta
      const target = `${credentials.baseURL.replace(/\/+$/, "")}${wirePath(targetWire)}`
      return fetchImpl(new Request(target, {
        method: "POST",
        headers,
        body: JSON.stringify(nextBody),
        signal: controller.signal,
      }))
    }

    const controller = new AbortController()
    res.on("close", () => {
      if (!res.writableEnded) controller.abort()
    })

    let upstream = await attempt(modelId, sessionToken, routed, upstreamWire)
    if (!upstream.ok && routed && RETRIABLE_STATUS.has(upstream.status) && !options.strict) {
      warn(`routed request failed (HTTP ${upstream.status}) — retrying on the fallback model`)
      if (upstream.status === 401 || upstream.status === 403) {
        options.creds.invalidate()
        credentials = await options.creds.get({ force: true })
      }
      const fallback = await router.resolveAnchor(credentials.baseURL, credentials.token, wire, options.anchorModel)
      upstream = await attempt(fallback, undefined, false, wire)
    }

    if (!upstream.ok) {
      const text = await upstream.text()
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      })
      res.end(text)
      return
    }

    const contentType = upstream.headers.get("content-type")
    const bridged = lastAttemptBridged
    if (isStream) {
      res.writeHead(200, {
        "content-type": bridged ? "text/event-stream; charset=utf-8" : contentType ?? "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      })
      if (!upstream.body) {
        res.end()
        return
      }
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      const translator = bridged
        ? new ResponsesToChatStream({ id: `chatcmpl-${Date.now()}`, model: String(body.model) })
        : undefined
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (res.destroyed) continue
          if (translator) {
            const converted = translator.push(decoder.decode(value, { stream: true }))
            if (converted) res.write(converted)
          } else {
            res.write(value)
          }
        }
        if (translator) {
          const tail = translator.flush()
          if (tail) res.write(tail)
        }
      } finally {
        reader.releaseLock()
      }
      res.end()
      return
    }

    if (bridged) {
      const payload: unknown = await upstream.json()
      sendJson(res, 200, responsesToChat(payload, String(body.model)))
      return
    }

    const text = await upstream.text()
    res.writeHead(200, { "content-type": contentType ?? "application/json; charset=utf-8" })
    res.end(text)
  }

  const server = createHttpServer((req, res) => {
    void (async () => {
      res.setHeader("Access-Control-Allow-Origin", "*")
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-api-key, x-session-id, openai-beta")
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      if (req.method === "OPTIONS") {
        res.writeHead(204)
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? "/", "http://localhost")
        if (url.pathname === "/health" || url.pathname === "/") {
          sendJson(res, 200, { status: "ok", service: "copilot-fusion" })
          return
        }
        if (!authorized(req.headers, options.apiKey)) {
          sendError(res, 401, "invalid API key", "invalid_api_key")
          return
        }
        if (req.method === "GET" && url.pathname === "/v1/models") {
          sendJson(res, 200, listOpenAIModels())
          return
        }
        const wire = req.method === "POST" ? wireForEndpoint(url.pathname) : undefined
        if (!wire) {
          sendError(res, 404, `Unknown endpoint '${url.pathname}'`, "not_found")
          return
        }
        await handleInference(req, res, wire)
      } catch (error) {
        if (res.headersSent) {
          res.end()
          return
        }
        if (error instanceof HttpError) {
          sendError(res, error.status, error.message)
          return
        }
        log(`request failed: ${describeError(error)}`)
        sendError(res, 500, `internal error: ${describeError(error)}`)
      }
    })()
  })
  return server
}
