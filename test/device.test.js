import test from "node:test"
import assert from "node:assert/strict"
import {
  DeviceAuth,
  DeviceLoginError,
  parseAccessTokenResponse,
  parseCopilotToken,
  parseDeviceCodeResponse,
} from "../dist/device.js"

function mockFetch(handler) {
  const calls = []
  const fetchImpl = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, fetchImpl }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function makeAuth(fetchImpl, overrides = {}) {
  return new DeviceAuth({
    clientId: "client-1",
    deviceCodeUrl: "https://github.com/login/device/code",
    accessTokenUrl: "https://github.com/login/oauth/access_token",
    copilotTokenUrl: "https://api.github.com/copilot_internal/v2/token",
    fetchImpl,
    sleep: async () => undefined,
    now: overrides.now ?? (() => 1_800_000_000_000),
  })
}

test("pure parsers tolerate garbage", () => {
  assert.equal(parseDeviceCodeResponse(undefined), undefined)
  assert.equal(parseAccessTokenResponse({ error: "authorization_pending" }), undefined)
  assert.equal(parseCopilotToken({ token: 1 }, 0), undefined)
  assert.deepEqual(
    parseDeviceCodeResponse({ device_code: "d", user_code: "U", verification_uri: "https://github.com/device" }),
    { deviceCode: "d", userCode: "U", verificationUri: "https://github.com/device", verificationUriComplete: undefined, intervalSec: 5, expiresInSec: 900 },
  )
})

test("parseCopilotToken reads expiry and enterprise endpoint", () => {
  const parsed = parseCopilotToken({
    token: "tok",
    expires_at: 1_800_000_600,
    endpoints: { api: "https://copilot-api.ghe.example.com" },
  }, 1_800_000_000_000)
  assert.equal(parsed.token, "tok")
  assert.equal(parsed.expiresAtMs, 1_800_000_600_000)
  assert.equal(parsed.baseURL, "https://copilot-api.ghe.example.com")
  assert.equal(parseCopilotToken({ token: "tok" }, 1000).expiresAtMs, 1000 + 29 * 60_000)
})

test("begin posts the public Copilot client id and read:user scope", async () => {
  const { calls, fetchImpl } = mockFetch(() => json({ device_code: "d", user_code: "ABCD", verification_uri: "https://github.com/device", interval: 7, expires_in: 600 }))
  const device = await makeAuth(fetchImpl).begin()
  assert.equal(device.userCode, "ABCD")
  assert.equal(device.intervalSec, 7)
  const body = JSON.parse(String(calls[0].init.body))
  assert.equal(body.client_id, "client-1")
  assert.equal(body.scope, "read:user")
})

test("waitForAuthorization handles pending, slow_down, then success", async () => {
  let poll = 0
  let now = 1_800_000_000_000
  const { calls, fetchImpl } = mockFetch(() => {
    poll++
    if (poll === 1) return json({ error: "authorization_pending" })
    if (poll === 2) return json({ error: "slow_down" })
    return json({ access_token: "gho_ok", refresh_token: "refresh_ok" })
  })
  const seen = []
  const token = await makeAuth(fetchImpl, { now: () => (now += 10_000) }).waitForAuthorization(
    { deviceCode: "d", userCode: "ABCD", verificationUri: "https://github.com/device", intervalSec: 1, expiresInSec: 600 },
    (delay) => seen.push(delay),
  )
  assert.equal(token.accessToken, "gho_ok")
  assert.equal(token.refreshToken, "refresh_ok")
  assert.equal(calls.length, 3)
  assert.deepEqual(seen, [1000])
})

test("waitForAuthorization surfaces access_denied and expiry", async () => {
  const denied = mockFetch(() => json({ error: "access_denied", error_description: "no thanks" }))
  await assert.rejects(
    () => makeAuth(denied.fetchImpl).waitForAuthorization({ deviceCode: "d", userCode: "ABCD", verificationUri: "u", intervalSec: 1, expiresInSec: 60 }),
    (error) => error instanceof DeviceLoginError && error.code === "access_denied" && /no thanks/.test(error.message),
  )

  let now = 0
  const slow = mockFetch(() => json({ error: "authorization_pending" }))
  await assert.rejects(
    () => makeAuth(slow.fetchImpl, { now: () => (now += 10_000) }).waitForAuthorization({ deviceCode: "d", userCode: "ABCD", verificationUri: "u", intervalSec: 1, expiresInSec: 1 }),
    (error) => error.code === "expired_token",
  )
})

test("exchangeForCopilotToken sends editor headers and bearer auth", async () => {
  const { calls, fetchImpl } = mockFetch(() => json({ token: "copilot_tok", expires_at: 1_800_000_600, endpoints: { api: "https://api.business.githubcopilot.com" } }))
  const result = await makeAuth(fetchImpl).exchangeForCopilotToken("gho_ok")
  assert.equal(result.token, "copilot_tok")
  assert.equal(result.baseURL, "https://api.business.githubcopilot.com")
  assert.equal(calls[0].init.method, undefined)
  assert.equal(calls[0].init.headers.Authorization, "Bearer gho_ok")
  assert.equal(calls[0].init.headers["Editor-Version"], "vscode/1.107.0")
  assert.equal(calls[0].init.headers["Copilot-Integration-Id"], "vscode-chat")
})

test("exchange failure is a typed error without echoing the response body", async () => {
  const { fetchImpl } = mockFetch(() => json({ message: "secret account detail" }, 401))
  await assert.rejects(
    () => makeAuth(fetchImpl).exchangeForCopilotToken("gho_bad"),
    (error) => error instanceof DeviceLoginError && error.code === "http_401" && !/secret/.test(error.message),
  )
})

test("refreshGitHubToken returns undefined when refresh is unsupported", async () => {
  const ok = mockFetch(() => json({ access_token: "gho_new", refresh_token: "refresh_new" }))
  assert.equal((await makeAuth(ok.fetchImpl).refreshGitHubToken("refresh_old")).accessToken, "gho_new")
  const bad = mockFetch(() => json({ error: "invalid_grant" }, 400))
  assert.equal(await makeAuth(bad.fetchImpl).refreshGitHubToken("refresh_old"), undefined)
})
