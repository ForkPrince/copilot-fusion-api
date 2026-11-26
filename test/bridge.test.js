import test from "node:test"
import assert from "node:assert/strict"
import { chatToResponses, responsesToChat, ResponsesToChatStream } from "../dist/bridge.js"

function sseChunks(text) {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const line = block.split("\n").find((l) => l.startsWith("data: "))
    if (!line) return undefined
  const raw = line.slice(6).trim()
  if (!raw || raw === "[DONE]") return undefined
  return JSON.parse(raw)
  }).filter(Boolean)
}

test("chatToResponses maps messages, roles, and image parts", () => {
  const body = chatToResponses({
    model: "gpt-6-luna",
    stream: true,
    temperature: 0.4,
    max_tokens: 512,
    n: 2,
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: [
        { type: "text", text: "what is here" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ] },
    ],
  })
  assert.equal(body.model, "gpt-6-luna")
  assert.equal(body.stream, true)
  assert.equal(body.messages, undefined)
  assert.equal(body.n, undefined)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.max_output_tokens, 512)
  assert.deepEqual(body.input, [
    { role: "system", content: "be brief" },
    { role: "user", content: [
      { type: "input_text", text: "what is here" },
      { type: "input_image", image_url: "https://example.com/a.png" },
    ] },
  ])
})

test("chatToResponses maps assistant tool calls and tool results", () => {
  const body = chatToResponses({
    messages: [
      { role: "assistant", content: null, tool_calls: [
        { id: "call-1", type: "function", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } },
      ] },
      { role: "tool", tool_call_id: "call-1", content: '["a.ts"]' },
    ],
    tools: [{ type: "function", function: { name: "glob", description: "find files", parameters: { type: "object" } } }],
  })
  assert.deepEqual(body.input, [
    { type: "function_call", call_id: "call-1", name: "glob", arguments: '{"pattern":"*.ts"}' },
    { type: "function_call_output", call_id: "call-1", output: '["a.ts"]' },
  ])
  assert.deepEqual(body.tools, [
    { type: "function", name: "glob", description: "find files", parameters: { type: "object" } },
  ])
})

test("chatToResponses keeps assistant text alongside tool calls", () => {
  const body = chatToResponses({
    messages: [{ role: "assistant", content: "working on it", tool_calls: [
      { id: "c1", function: { name: "bash", arguments: "{}" } },
    ] }],
  })
  assert.equal(body.input.length, 2)
  assert.equal(body.input[0].type, "function_call")
  assert.deepEqual(body.input[1], { role: "assistant", content: "working on it" })
})

test("responsesToChat converts text, tool calls, and usage", () => {
  const result = responsesToChat({
    id: "resp-1",
    output: [
      { type: "message", content: [{ type: "output_text", text: "hello " }, { type: "output_text", text: "world" }] },
      { type: "function_call", call_id: "call-9", name: "read", arguments: '{"path":"a.ts"}' },
      { type: "reasoning", content: [] },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }, "copilot-fusion")
  assert.equal(result.object, "chat.completion")
  assert.equal(result.id, "resp-1")
  assert.equal(result.model, "copilot-fusion")
  assert.equal(result.choices[0].message.content, "hello world")
  assert.deepEqual(result.choices[0].message.tool_calls, [{
    id: "call-9", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' },
  }])
  assert.equal(result.choices[0].finish_reason, "tool_calls")
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})

test("responsesToChat tolerates empty and malformed payloads", () => {
  const result = responsesToChat(undefined, "copilot-fusion")
  assert.equal(result.choices[0].message.content, null)
  assert.equal(result.choices[0].finish_reason, "stop")
  assert.deepEqual(result.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
})

test("stream translator handles events split across chunk boundaries", () => {
  const translator = new ResponsesToChatStream({ id: "chatcmpl-1", model: "copilot-fusion" })
  const raw = 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n'
    + 'data: {"type":"response.completed"}\n\n'
  let out = ""
  for (const char of raw) out += translator.push(char) // one byte at a time
  out += translator.flush()
  const chunks = sseChunks(out)
  assert.equal(chunks.length, 2, "one text chunk and one finish chunk; [DONE] is not JSON")
  assert.equal(chunks[0].choices[0].delta.content, "hi")
  assert.equal(chunks[1].choices[0].finish_reason, "stop")
  assert.match(out, /\[DONE\]/)
})

test("stream translator ignores upstream [DONE] and unknown events", () => {
  const translator = new ResponsesToChatStream({ id: "chatcmpl-1", model: "copilot-fusion" })
  const out = translator.push('data: [DONE]\n\ndata: {"type":"response.created"}\n\n')
    + translator.push('data: {"type":"response.output_text.delta","delta":"ok"}\n\n')
  const chunks = sseChunks(out)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, "ok")
})

test("stream translator emits a done-only tool call once", () => {
  const translator = new ResponsesToChatStream({ id: "chatcmpl-1", model: "copilot-fusion" })
  const out = translator.push('data: {"type":"response.function_call_arguments.done","item_id":"fc-1","call_id":"c1","name":"glob","arguments":"{\\"a\\":1}"}\n\n')
    + translator.flush()
  const chunks = sseChunks(out).filter((c) => c.choices[0].delta.tool_calls)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, "glob")
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.arguments, '{"a":1}')
})

test("stream translator keeps indexes for multiple tool calls", () => {
  const translator = new ResponsesToChatStream({ id: "chatcmpl-1", model: "copilot-fusion" })
  const events = [
    { type: "response.output_item.added", item: { type: "function_call", id: "fc-1", call_id: "c1", name: "first" } },
    { type: "response.output_item.added", item: { type: "function_call", id: "fc-2", call_id: "c2", name: "second" } },
    { type: "response.function_call_arguments.delta", item_id: "fc-2", delta: "two" },
    { type: "response.function_call_arguments.delta", item_id: "fc-1", delta: "one" },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
  const chunks = sseChunks(translator.push(events)).filter((c) => c.choices[0].delta.tool_calls)
  assert.equal(chunks.length, 4)
  assert.deepEqual(chunks.map((c) => c.choices[0].delta.tool_calls[0].index), [0, 1, 1, 0])
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, "first")
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.name, "second")
})

test("stream translator forwards error events as chat errors", () => {
  const translator = new ResponsesToChatStream({ id: "chatcmpl-1", model: "copilot-fusion" })
  const out = translator.push('data: {"type":"error","error":{"message":"boom"}}\n\n')
  assert.equal(sseChunks(out)[0].error.message, "boom")
})
