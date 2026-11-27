import test from "node:test"
import assert from "node:assert/strict"
import { configFromEnv, DEFAULT_FUSION_OPTIONS, parseFusionOptions } from "../dist/options.js"

const EMPTY = {}

test("defaults and tolerance for garbage", () => {
  assert.deepEqual(parseFusionOptions(undefined, EMPTY), DEFAULT_FUSION_OPTIONS)
  assert.deepEqual(parseFusionOptions("junk", EMPTY), DEFAULT_FUSION_OPTIONS)
  assert.deepEqual(parseFusionOptions(null, EMPTY), DEFAULT_FUSION_OPTIONS)
})

test("custom options parsed", () => {
  const custom = parseFusionOptions({
    anchorModel: "mai-code-1.1-flash",
    route: "prompt",
    strict: false,
    stripTemperature: false,
    timeoutMs: 9000,
    skewMs: 60000,
    debug: true,
  }, EMPTY)
  assert.equal(custom.anchorModel, "mai-code-1.1-flash")
  assert.equal(custom.route, "prompt")
  assert.equal(custom.strict, false)
  assert.equal(custom.stripTemperature, false)
  assert.equal(custom.timeoutMs, 9000)
  assert.equal(custom.skewMs, 60000)
  assert.equal(custom.debug, true)
})

test("out-of-range values fall back", () => {
  assert.equal(parseFusionOptions({ timeoutMs: 999999 }, EMPTY).timeoutMs, DEFAULT_FUSION_OPTIONS.timeoutMs)
  assert.equal(parseFusionOptions({ route: "everywhere" }, EMPTY).route, "conversation")
  assert.equal(parseFusionOptions({ skewMs: -1 }, EMPTY).skewMs, DEFAULT_FUSION_OPTIONS.skewMs)
})

test("routing options can come from the environment", () => {
  const parsed = parseFusionOptions(undefined, {
    ROUTE: "prompt",
    STRICT: "0",
    STRIP_TEMPERATURE: "0",
    TIMEOUT_MS: "9000",
    SKEW_MS: "60000",
    DEBUG: "1",
    COPILOT_ANCHOR_MODEL: "gpt-6-terra",
  })
  assert.equal(parsed.route, "prompt")
  assert.equal(parsed.strict, false)
  assert.equal(parsed.stripTemperature, false)
  assert.equal(parsed.timeoutMs, 9000)
  assert.equal(parsed.skewMs, 60000)
  assert.equal(parsed.debug, true)
  assert.equal(parsed.anchorModel, "gpt-6-terra")
})

test("configFromEnv has safe localhost defaults and honours overrides", () => {
  const defaults = configFromEnv(EMPTY)
  assert.equal(defaults.host, "127.0.0.1")
  assert.equal(defaults.port, 8080)
  assert.equal(defaults.apiKey, undefined)
  assert.equal(defaults.githubClientId, "Iv1.b507a08c87ecfe98")

  const configured = configFromEnv({
    HOST: "0.0.0.0",
    PORT: "3000",
    API_KEY: "secret",
    COPILOT_BASE_URL: "https://copilot-api.ghe.example.com",
    GITHUB_CLIENT_ID: "custom",
    COPILOT_AUTH_FILE: "/tmp/auth.json",
  })
  assert.equal(configured.host, "0.0.0.0")
  assert.equal(configured.port, 3000)
  assert.equal(configured.apiKey, "secret")
  assert.equal(configured.copilotBaseURL, "https://copilot-api.ghe.example.com")
  assert.equal(configured.githubClientId, "custom")
  assert.equal(configured.authFile, "/tmp/auth.json")
})

test("invalid port and client overrides are ignored", () => {
  assert.equal(configFromEnv({ PORT: "not-a-port" }).port, 8080)
  assert.equal(configFromEnv({ PORT: "70000" }).port, 8080)
})
