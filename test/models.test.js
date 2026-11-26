import test from "node:test"
import assert from "node:assert/strict"
import { effortFromBody, isKnownModel, listOpenAIModels, sessionIdFrom, tierFromRequest } from "../dist/models.js"

test("/v1/models lists only the Fusion models", () => {
  const list = listOpenAIModels()
  assert.equal(list.object, "list")
  assert.deepEqual(list.data.map((m) => m.id), [
    "copilot-fusion",
    "copilot-fusion-standard",
    "copilot-fusion-high",
    "copilot-fusion-max",
  ])
  assert.equal(list.data[0].object, "model")
  assert.equal(list.data[0].owned_by, "github-copilot")
  assert.equal(list.data[0].created, list.data[1].created)
})

test("model names are recognised case-insensitively", () => {
  assert.equal(isKnownModel("COPILOT-FUSION-HIGH"), true)
  assert.equal(isKnownModel("github-copilot/fusion"), true)
  assert.equal(isKnownModel("github-copilot/fusion#max"), true)
  assert.equal(isKnownModel("gpt-6-luna"), false)
  assert.equal(isKnownModel(undefined), false)
})

test("named tiers win over reasoning effort", () => {
  assert.equal(tierFromRequest("copilot-fusion-standard", "xhigh"), "standard")
  assert.equal(tierFromRequest("copilot-fusion-high", "low"), "high")
  assert.equal(tierFromRequest("copilot-fusion-max", "low"), "max")
  assert.equal(tierFromRequest("github-copilot/fusion#high", "xhigh"), "high")
  assert.equal(tierFromRequest("fusion-max"), "max")
})

test("reasoning effort selects the tier when the name is generic", () => {
  assert.equal(tierFromRequest("copilot-fusion"), "standard")
  assert.equal(tierFromRequest("copilot-fusion", "low"), "standard")
  assert.equal(tierFromRequest("copilot-fusion", "medium"), "high")
  assert.equal(tierFromRequest("copilot-fusion", "high"), "high")
  assert.equal(tierFromRequest("copilot-fusion", "xhigh"), "max")
  assert.equal(tierFromRequest("copilot-fusion", "bogus"), "standard")
  assert.equal(tierFromRequest("gpt-6-luna", "high"), undefined)
})

test("effort is read from both OpenAI request shapes", () => {
  assert.equal(effortFromBody({ reasoning_effort: "xhigh" }), "xhigh")
  assert.equal(effortFromBody({ reasoning: { effort: "low" } }), "low")
  assert.equal(effortFromBody({ reasoning: "xhigh" }), undefined)
  assert.equal(effortFromBody({}), undefined)
})

test("session ids prefer headers, then body fields, then a stable default", () => {
  assert.equal(sessionIdFrom({ "x-session-id": "abc" }, {}), "abc")
  assert.equal(sessionIdFrom({ "x-session-id": ["first", "second"] }, {}), "first")
  assert.equal(sessionIdFrom({ "x-conversation-id": "conv-1" }, {}), "conv-1")
  assert.equal(sessionIdFrom({}, { session_id: "from-body" }), "from-body")
  assert.equal(sessionIdFrom({}, { conversation_id: "resp-1" }), "resp-1")
  assert.equal(sessionIdFrom({}, { user: "user-1" }), "user-1")
  assert.equal(sessionIdFrom({}, {}), "default")
  assert.equal(sessionIdFrom({ "x-session-id": "bad id!?" }, {}), "bad_id__")
  assert.equal(sessionIdFrom({ "x-session-id": "x".repeat(500) }, {}).length, 200)
})
