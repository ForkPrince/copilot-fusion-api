import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileCredentialProvider, AuthError } from "../dist/creds.js"
import { authFilePath, clearAuth, maskToken, parseStoredAuth, readAuth, writeAuth } from "../dist/store.js"

const NOW = 1_800_000_000_000

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "copilot-api-test-"))
  return { dir, path: join(dir, "auth.json") }
}

function device(overrides = {}) {
  const calls = { exchange: [], refresh: [] }
  const impl = {
    async exchangeForCopilotToken(token) {
      calls.exchange.push(token)
      if (overrides.failFirst && calls.exchange.length === 1) {
        const error = new Error("HTTP 401")
        error.code = "http_401"
        throw error
      }
      return {
        token: `copilot-${calls.exchange.length}`,
        expiresAtMs: NOW + 30 * 60_000,
        baseURL: "https://api.business.githubcopilot.com",
      }
    },
    async refreshGitHubToken(token) {
      calls.refresh.push(token)
      return overrides.rotated ? { accessToken: "gho_rotated", refreshToken: "refresh_rotated" } : undefined
    },
  }
  return { impl, calls }
}

function provider(path, deviceImpl, overrides = {}) {
  return new FileCredentialProvider({
    authFile: path,
    deviceAuth: deviceImpl,
    now: () => NOW,
    skewMs: 5 * 60_000,
    ...overrides,
  })
}

test("auth file path honours explicit file and config dir overrides", () => {
  assert.equal(authFilePath({ authFile: "/tmp/x.json", configDir: "/tmp/other" }), "/tmp/x.json")
  assert.equal(authFilePath({ configDir: "/tmp/other" }), "/tmp/other/auth.json")
  assert.equal(authFilePath({ env: { COPILOT_AUTH_FILE: "/tmp/y.json" } }), "/tmp/y.json")
})

test("malformed or partial auth files are treated as absent", async () => {
  const { dir, path } = await fixture()
  try {
    assert.equal(parseStoredAuth({}), undefined)
    assert.equal(parseStoredAuth({ githubToken: 1 }), undefined)
    assert.equal(await readAuth(path), undefined)
    await writeAuth(path, { githubToken: "gho_abc", updatedAt: NOW })
    assert.equal((await readAuth(path)).githubToken, "gho_abc")
    const mode = (await readFile(path)).length > 0
    assert.equal(mode, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("maskToken never prints the middle of a token", () => {
  assert.equal(maskToken("gho_abcdefghijklmnop"), "gho_ab…mnop")
  assert.equal(maskToken("short"), "••••")
})

test("get returns a fresh stored Copilot token without an exchange", async () => {
  const { dir, path } = await fixture()
  try {
    const d = device()
    await writeAuth(path, {
      githubToken: "gho_abc",
      copilotToken: "copilot_fresh",
      copilotExpiresAtMs: NOW + 20 * 60_000,
      baseURL: "https://api.githubcopilot.com",
      updatedAt: NOW,
    })
    const creds = await provider(path, d.impl).get()
    assert.equal(creds.token, "copilot_fresh")
    assert.equal(creds.baseURL, "https://api.githubcopilot.com")
    assert.match(creds.key, /^[0-9a-f]{16}$/)
    assert.equal(d.calls.exchange.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("get re-exchanges a near-expiry token and persists it", async () => {
  const { dir, path } = await fixture()
  try {
    const d = device()
    await writeAuth(path, { githubToken: "gho_abc", copilotToken: "old", copilotExpiresAtMs: NOW + 60_000, updatedAt: NOW })
    const p = provider(path, d.impl)
    const first = await p.get()
    assert.equal(first.token, "copilot-1")
    assert.deepEqual(d.calls.exchange, ["gho_abc"])
    const stored = await readAuth(path)
    assert.equal(stored.copilotToken, "copilot-1")
    assert.equal(stored.baseURL, "https://api.business.githubcopilot.com")
    // second call reuses the in-memory copy
    assert.equal((await p.get()).token, "copilot-1")
    assert.equal(d.calls.exchange.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the routing key stays stable when the Copilot token rotates", async () => {
  const { dir, path } = await fixture()
  try {
    const d = device()
    await writeAuth(path, { githubToken: "gho_abc", copilotToken: "stale", copilotExpiresAtMs: NOW, updatedAt: NOW })
    const p = provider(path, d.impl)
    const first = await p.get()
    const second = await p.get({ force: true })
    assert.notEqual(first.token, second.token)
    assert.equal(first.key, second.key)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("force bypasses both in-memory and on-disk caches", async () => {
  const { dir, path } = await fixture()
  try {
    const d = device()
    await writeAuth(path, { githubToken: "gho_abc", copilotToken: "fresh", copilotExpiresAtMs: NOW + 30 * 60_000, updatedAt: NOW })
    const p = provider(path, d.impl)
    assert.equal((await p.get({ force: true })).token, "copilot-1")
    assert.equal(d.calls.exchange.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a rejected Copilot token rotates the GitHub token when possible", async () => {
  const { dir, path } = await fixture()
  try {
    const d = device({ failFirst: true, rotated: true })
    await writeAuth(path, { githubToken: "gho_old", refreshToken: "refresh_old", copilotToken: "stale", copilotExpiresAtMs: NOW, updatedAt: NOW })
    const creds = await provider(path, d.impl).get()
    assert.equal(creds.token, "copilot-2")
    assert.deepEqual(d.calls.refresh, ["refresh_old"])
    assert.deepEqual(d.calls.exchange, ["gho_old", "gho_rotated"])
    assert.equal((await readAuth(path)).githubToken, "gho_rotated")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("missing login and unrecoverable refresh produce AuthError", async () => {
  const { dir, path } = await fixture()
  try {
    const d = device()
    await assert.rejects(() => provider(path, d.impl).get(), (error) => error instanceof AuthError && error.code === "login_required")
    await writeAuth(path, { githubToken: "gho_abc", copilotToken: "stale", copilotExpiresAtMs: NOW, updatedAt: NOW })
    const failing = device()
    failing.impl.exchangeForCopilotToken = async () => {
      const error = new Error("HTTP 403")
      error.code = "http_403"
      throw error
    }
    await assert.rejects(() => provider(path, failing.impl).get(), (error) => error instanceof AuthError && error.code === "refresh_failed")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("concurrent calls share one token exchange", async () => {
  const { dir, path } = await fixture()
  try {
    const d = device()
    await writeAuth(path, { githubToken: "gho_abc", copilotToken: "stale", copilotExpiresAtMs: NOW, updatedAt: NOW })
    const p = provider(path, d.impl)
    const [a, b] = await Promise.all([p.get(), p.get()])
    assert.equal(a.token, b.token)
    assert.equal(d.calls.exchange.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("status reports validity without a token, and clear removes the file", async () => {
  const { dir, path } = await fixture()
  try {
    const d = device()
    const p = provider(path, d.impl)
    const missing = await p.status()
    assert.equal(missing.authenticated, false)
    assert.equal(missing.copilotValid, false)

    await writeAuth(path, { githubToken: "gho_abcdefghijklmnop", copilotToken: "c", copilotExpiresAtMs: NOW + 10 * 60_000, updatedAt: NOW })
    const state = await p.status()
    assert.equal(state.authenticated, true)
    assert.equal(state.copilotValid, true)
    assert.equal(state.githubToken, "gho_abcdefghijklmnop")
    assert.equal(state.baseURL, "https://api.githubcopilot.com")

    await p.clear()
    assert.equal(await readAuth(path), undefined)
    await clearAuth(path) // idempotent
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
