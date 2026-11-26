import test from "node:test"
import assert from "node:assert/strict"
import { wireForEndpoint, wireForRoutedModel, wireOfModelId, wirePath, wiresFromEndpoints } from "../dist/wire.js"

test("public endpoints map to upstream wires", () => {
  assert.equal(wireForEndpoint("/v1/chat/completions"), "chat")
  assert.equal(wireForEndpoint("/chat/completions"), "chat")
  assert.equal(wireForEndpoint("/v1/responses"), "responses")
  assert.equal(wireForEndpoint("/responses"), "responses")
  assert.equal(wireForEndpoint("/v1/messages"), "messages")
  assert.equal(wireForEndpoint("/v1/models"), undefined)
  assert.equal(wireForEndpoint("/v1/responses/"), "responses")
})

test("wire paths are the unprefixed Copilot endpoints", () => {
  assert.equal(wirePath("chat"), "/chat/completions")
  assert.equal(wirePath("responses"), "/responses")
  assert.equal(wirePath("messages"), "/v1/messages")
})

test("model id heuristic matches the Copilot provider", () => {
  assert.equal(wireOfModelId("gpt-6-luna"), "responses")
  assert.equal(wireOfModelId("gpt-5.4"), "responses")
  assert.equal(wireOfModelId("gpt-5-mini"), "chat")
  assert.equal(wireOfModelId("mai-code-1.1-flash"), "responses")
  assert.equal(wireOfModelId("grok-4"), "responses")
  assert.equal(wireOfModelId("claude-opus-5.5"), "messages")
  assert.equal(wireOfModelId("unknown"), "chat")
})

test("wiresFromEndpoints accepts prefixed paths and ignores junk", () => {
  const wires = wiresFromEndpoints([
    "/chat/completions", "/v1/chat/completions", "/responses", "/interactions",
    "/v1/messages", "/messages", "/embeddings", null, 42,
  ])
  assert.deepEqual([...wires].sort(), ["chat", "messages", "responses"])
  assert.equal(wiresFromEndpoints(undefined).size, 0)
  assert.equal(wiresFromEndpoints("responses").size, 0)
})

test("wireForRoutedModel prefers the requested wire when it is served", () => {
  assert.equal(wireForRoutedModel(["/chat/completions", "/responses"], "gpt-6-luna", "chat"), "chat")
  assert.equal(wireForRoutedModel(["/responses"], "gpt-6-luna", "chat"), "responses")
  assert.equal(wireForRoutedModel(undefined, "gpt-6-luna", "chat"), "responses")
  assert.equal(wireForRoutedModel(undefined, "gpt-5-mini", "chat"), "chat")
})
