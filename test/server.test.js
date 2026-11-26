import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "../dist/server.js"

const FUTURE = Math.floor(Date.now() / 1000) + 86400

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function autoResponse(overrides = {}) {
  return {
    session_token: "session-tok-1",
    expires_at: FUTURE,
    selected_model: {
      id: "gpt-6-luna",
      supported_endpoints: ["/responses", "/chat/completions"],
      capabilities: { input: ["text", "image"] },
    },
    ...overrides,
  }
}

function defaultHandler(url, init, body) {
  if (url.includes("/meta")) {
    return json({ auto: { tiers: [
      { id: "balance", status: { enabled: true } },
      { id: "hydrafusion", type: "fusion", status: { enabled: true } },
      { id: "hydrafusion-max", type: "fusion", status: { enabled: true } },
    ] } })
  }
  if (url.includes("/auto")) return json(autoResponse())
  if (url.includes("/models")) {
    return json({ data: [
      { id: "gpt-6-luna", supported_endpoints: ["/responses", "/chat/completions"] },
      { id: "gpt-5-mini", supported_endpoints: ["/chat/completions"] },
    ] })
  }
  if (url.includes("/chat/completions")) {
    return json({ id: "chatcmpl-1", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "hello back" } }] })
  }
  if (url.includes("/responses")) {
    return json({ id: "resp-1", object: "response", model: body.model, output: [] })
  }
  throw new Error(`unexpected upstream request: ${url}`)
}

async function start(overrides = {}, handler = defaultHandler) {
  const calls = []
  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined)
    const body = raw ? JSON.parse(String(raw)) : undefined
    const headers = input instanceof Request
      ? Object.fromEntries(input.headers.entries())
      : (init?.headers ?? {})
    const normalized = { ...(init ?? {}), headers }
    calls.push({ url, init: normalized, body })
    return handler(url, normalized, body)
  }
  let invalidations = 0
  const creds = {
    async get() { return { token: "copilot_tok", baseURL: "https://api.githubcopilot.com", key: "stable-key" } },
    invalidate() { invalidations++ },
  }
  if (overrides.creds) Object.assign(creds, overrides.creds)
  const server = createServer({
    creds,
    fetchImpl,
    anchorModel: "gpt-6-luna",
    route: "conversation",
    stripTemperature: true,
    timeoutMs: 5000,
    skewMs: 300000,
    debug: false,
    ...overrides,
    creds,
    fetchImpl,
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    get invalidations() { return invalidations },
  }
}

async function stop(server) {
  await new Promise((resolve) => server.close(resolve))
}

function chatRequest(body, headers = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }
}

test("health and model catalog work without Copilot auth", async () => {
  const { server, url, calls } = await start()
  try {
    const health = await fetch(`${url}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: "ok", service: "copilot-fusion" })

    const models = await fetch(`${url}/v1/models`)
    assert.equal(models.status, 200)
    const list = await models.json()
    assert.equal(list.object, "list")
    assert.equal(list.data.length, 4)
    assert.equal(calls.length, 0)
  } finally {
    await stop(server)
  }
})

test("API key is enforced when configured and accepts x-api-key too", async () => {
  const { server, url } = await start({ apiKey: "secret" })
  try {
    assert.equal((await fetch(`${url}/v1/models`)).status, 401)
    const bearer = await fetch(`${url}/v1/models`, { headers: { Authorization: "Bearer secret" } })
    assert.equal(bearer.status, 200)
    const byHeader = await fetch(`${url}/v1/models`, { headers: { "x-api-key": "secret" } })
    assert.equal(byHeader.status, 200)
  } finally {
    await stop(server)
  }
})

test("chat completions route through /auto and rewrite the upstream request", async () => {
  const { server, url, calls } = await start()
  try {
    const response = await fetch(`${url}/v1/chat/completions`, chatRequest({
      model: "copilot-fusion-high",
      messages: [{ role: "user", content: "write a retry function" }],
      temperature: 0.7,
      session_id: "ses-1",
    }, { "x-session-id": "ses-1" }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.model, "gpt-6-luna")

    const auto = calls.find((c) => c.url.includes("/auto"))
    assert.ok(auto)
    assert.equal(auto.body.tier, "hydrafusion")
    assert.equal(auto.body.prompt, "write a retry function")

    const inference = calls.find((c) => c.url.includes("/chat/completions"))
    assert.equal(inference.url, "https://api.githubcopilot.com/chat/completions")
    assert.equal(inference.body.model, "gpt-6-luna")
    assert.equal(inference.body.temperature, undefined)
    assert.equal("session_id" in inference.body, false)
    assert.equal(inference.init.headers["copilot-session-token"], "session-tok-1")
    assert.equal(inference.init.headers.authorization, "Bearer copilot_tok")
    assert.equal(inference.init.headers["copilot-integration-id"], "vscode-chat")
  } finally {
    await stop(server)
  }
})

test("streaming responses are piped through unchanged", async () => {
  const streamHandler = (url, init, body) => {
    if (url.includes("/chat/completions")) {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "chunk-1", model: body.model, choices: [] })}\n\n`))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      }), { headers: { "content-type": "text/event-stream" } })
    }
    return defaultHandler(url, init, body)
  }
  const { server, url, calls } = await start({}, streamHandler)
  try {
    const response = await fetch(`${url}/v1/chat/completions`, chatRequest({
      model: "copilot-fusion",
      messages: [{ role: "user", content: "stream please" }],
      stream: true,
    }))
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type"), /text\/event-stream/)
    assert.match(await response.text(), /\[DONE\]/)
    const inference = calls.find((c) => c.url.includes("/chat/completions"))
    assert.equal(inference.init.headers.accept, "text/event-stream")
  } finally {
    await stop(server)
  }
})

test("responses endpoint uses reasoning_effort for the tier and the /responses wire", async () => {
  const { server, url, calls } = await start()
  try {
    const response = await fetch(`${url}/v1/responses`, chatRequest({
      model: "copilot-fusion",
      input: "explain this diff",
      reasoning_effort: "xhigh",
    }))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).model, "gpt-6-luna")
    const auto = calls.find((c) => c.url.includes("/auto"))
    assert.equal(auto.body.tier, "hydrafusion-max")
    assert.equal(auto.body.prompt, "explain this diff")
    const inference = calls.find((c) => c.url.endsWith("/responses"))
    assert.equal(inference.url, "https://api.githubcopilot.com/responses")
  } finally {
    await stop(server)
  }
})

test("sticky sessions reuse one /auto call; different sessions re-route", async () => {
  const { server, url, calls } = await start()
  try {
    const body = { model: "copilot-fusion", messages: [{ role: "user", content: "hi" }] }
    await fetch(`${url}/v1/chat/completions`, chatRequest(body, { "x-session-id": "session-a" }))
    await fetch(`${url}/v1/chat/completions`, chatRequest(body, { "x-session-id": "session-a" }))
    await fetch(`${url}/v1/chat/completions`, chatRequest(body, { "x-session-id": "session-b" }))
    assert.equal(calls.filter((c) => c.url.includes("/auto")).length, 2)
  } finally {
    await stop(server)
  }
})

test("unknown models are rejected before any upstream call", async () => {
  const { server, url, calls } = await start()
  try {
    const response = await fetch(`${url}/v1/chat/completions`, chatRequest({
      model: "gpt-6-luna", messages: [{ role: "user", content: "hi" }],
    }))
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error.code, "model_not_found")
    assert.equal(calls.length, 0)
  } finally {
    await stop(server)
  }
})

test("invalid JSON is a 400", async () => {
  const { server, url } = await start()
  try {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "not json",
    })
    assert.equal(response.status, 400)
  } finally {
    await stop(server)
  }
})

test("missing Copilot login returns a 503 with an actionable message", async () => {
  const { server, url } = await start({
    creds: { get: async () => { throw new Error("not logged in") }, invalidate() {} },
  })
  try {
    const response = await fetch(`${url}/v1/chat/completions`, chatRequest({
      model: "copilot-fusion", messages: [{ role: "user", content: "hi" }],
    }))
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.error.code, "copilot_auth_required")
    assert.match(body.error.message, /not logged in/)
  } finally {
    await stop(server)
  }
})

test("routing failure falls back to a catalog model without a session token", async () => {
  const failing = (url, init, body) => url.includes("/auto")
    ? new Response("nope", { status: 503 })
    : defaultHandler(url, init, body)
  const { server, url, calls } = await start({}, failing)
  try {
    const response = await fetch(`${url}/v1/chat/completions`, chatRequest({
      model: "copilot-fusion", messages: [{ role: "user", content: "hi" }], temperature: 0.3,
    }))
    assert.equal(response.status, 200)
    const inference = calls.find((c) => c.url.includes("/chat/completions"))
    assert.equal(inference.body.model, "gpt-6-luna")
    assert.equal(inference.body.temperature, 0.3, "temperature is only stripped on routed requests")
    assert.equal(inference.init.headers["copilot-session-token"], undefined)
  } finally {
    await stop(server)
  }
})

test("strict mode refuses a plain-model fallback and reports why routing failed", async () => {
  const failing = (url, init, body) => url.includes("/auto")
    ? new Response("nope", { status: 503 })
    : defaultHandler(url, init, body)
  const { server, url, calls } = await start({ strict: true }, failing)
  try {
    const response = await fetch(`${url}/v1/chat/completions`, chatRequest({
      model: "copilot-fusion", messages: [{ role: "user", content: "hi" }],
    }))
    assert.equal(response.status, 503)
    const error = (await response.json()).error
    assert.equal(error.code, "fusion_unavailable")
    assert.match(error.message, /route unavailable \(HTTP 503\)/)
    assert.match(error.message, /FUSION_STRICT=0/)
    assert.equal(calls.some((c) => c.url.includes("/chat/completions")), false)
  } finally {
    await stop(server)
  }
})

test("strict mode does not switch to a plain model after a routed 400", async () => {
  const rejecting = (url, init, body) => url.includes("/chat/completions")
    ? json({ error: { message: "The requested model is not supported.", code: "model_not_supported" } }, 400)
    : defaultHandler(url, init, body)
  const { server, url, calls } = await start({ strict: true }, rejecting)
  try {
    const response = await fetch(`${url}/v1/chat/completions`, chatRequest({
      model: "copilot-fusion", messages: [{ role: "user", content: "hi" }],
    }))
    assert.equal(response.status, 400)
    const inferences = calls.filter((c) => c.url.includes("/chat/completions"))
    assert.equal(inferences.length, 1)
    assert.equal(inferences[0].init.headers["copilot-session-token"], "session-tok-1")
  } finally {
    await stop(server)
  }
})

test("a routed upstream 400 is retried once on the fallback model", async () => {
  let inferenceCount = 0
  const flaky = (url, init, body) => {
    if (url.includes("/chat/completions")) {
      inferenceCount++
      return inferenceCount === 1 ? new Response("bad model", { status: 400 }) : defaultHandler(url, init, body)
    }
    return defaultHandler(url, init, body)
  }
  const { server, url, calls } = await start({}, flaky)
  try {
    const response = await fetch(`${url}/v1/chat/completions`, chatRequest({
      model: "copilot-fusion", messages: [{ role: "user", content: "hi" }], temperature: 0.3,
    }))
    assert.equal(response.status, 200)
    const inferences = calls.filter((c) => c.url.includes("/chat/completions"))
    assert.equal(inferences.length, 2)
    assert.equal(inferences[0].init.headers["copilot-session-token"], "session-tok-1")
    assert.equal(inferences[1].init.headers["copilot-session-token"], undefined)
    assert.equal(inferences[1].body.temperature, 0.3)
    assert.equal((await response.json()).model, "gpt-6-luna")
  } finally {
    await stop(server)
  }
})
