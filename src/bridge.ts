/**
 * Translate between OpenAI Chat Completions and Copilot's Responses wire.
 *
 * Fusion often picks a model that only serves `/responses`, while clients
 * such as OpenCode call `/v1/chat/completions`. The server keeps the client
 * wire on the outside and converts the request/response around the routed
 * inference call, so a Fusion pick is never discarded just because of its
 * wire.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function normalizeChatContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content ?? ""
  return content.map((part) => {
    if (!isRecord(part)) return part
    if (part.type === "image_url") {
      const url = isRecord(part.image_url) ? part.image_url.url : part.image_url
      return { type: "input_image", image_url: text(url) }
    }
    if (part.type === "text" || part.type === "input_text") {
      return { type: "input_text", text: text(part.text) }
    }
    return part
  })
}

/** Chat Completions body -> Responses body. `model` is left for the caller. */
export function chatToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const input: Record<string, unknown>[] = []
  for (const raw of messages) {
    if (!isRecord(raw)) continue
    if (raw.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: text(raw.tool_call_id),
        output: typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content ?? ""),
      })
      continue
    }
    if (raw.role === "assistant" && Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) {
        if (!isRecord(call)) continue
        const fn = isRecord(call.function) ? call.function : {}
        input.push({
          type: "function_call",
          call_id: text(call.id),
          name: text(fn.name),
          arguments: text(fn.arguments) || "{}",
        })
      }
      if (raw.content === null || raw.content === undefined || raw.content === "") continue
    }
    input.push({ role: raw.role, content: normalizeChatContent(raw.content) })
  }

  const tools = Array.isArray(body.tools)
    ? body.tools.map((raw) => {
        if (!isRecord(raw)) return raw
        const fn = isRecord(raw.function) ? raw.function : {}
        return {
          type: "function",
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
        }
      })
    : undefined

  const next: Record<string, unknown> = { ...body }
  delete next.messages
  delete next.max_tokens
  delete next.n
  delete next.tools
  next.input = input
  if (tools) next.tools = tools
  if (typeof body.max_tokens === "number") next.max_output_tokens = body.max_tokens
  return next
}

/** Responses body -> Chat Completions body, with `model` restored. */
export function responsesToChat(payload: unknown, model: string): Record<string, unknown> {
  const data = isRecord(payload) ? payload : {}
  const output = Array.isArray(data.output) ? data.output : []
  let content = ""
  const toolCalls: Record<string, unknown>[] = []
  for (const raw of output) {
    if (!isRecord(raw)) continue
    if (raw.type === "message" && Array.isArray(raw.content)) {
      for (const part of raw.content) {
        if (isRecord(part) && typeof part.text === "string" && (part.type === "output_text" || part.type === "input_text" || !part.type)) {
          content += part.text
        }
      }
    } else if (raw.type === "function_call") {
      toolCalls.push({
        id: text(raw.call_id) || text(raw.id),
        type: "function",
        function: { name: text(raw.name), arguments: text(raw.arguments) || "{}" },
      })
    }
  }
  const usage = isRecord(data.usage) ? data.usage : {}
  return {
    id: text(data.id) || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: count(usage.input_tokens),
      completion_tokens: count(usage.output_tokens),
      total_tokens: count(usage.total_tokens),
    },
  }
}

interface ChatChunkOptions {
  readonly id: string
  readonly model: string
}

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

interface PendingCall {
  readonly index: number
  id: string
  name: string
  /** argument fragments already emitted as deltas */
  args: string
}

/** Stateful SSE translator: Responses events in, Chat Completions chunks out. */
export class ResponsesToChatStream {
  private buffer = ""
  private readonly created = Math.floor(Date.now() / 1000)
  private readonly calls = new Map<string, PendingCall>()
  private nextCallIndex = 0

  constructor(private readonly options: ChatChunkOptions) {}

  /** Chat tool-call deltas need both `id` and `function.name` on every chunk. */
  private ensureCall(itemId: unknown, callId: unknown, name: unknown): PendingCall {
    const key = text(itemId) || text(callId) || `call-${this.nextCallIndex}`
    let call = this.calls.get(key)
    if (!call) {
      call = {
        index: this.nextCallIndex++,
        id: text(callId) || text(itemId) || key,
        name: text(name) || "function",
        args: "",
      }
      this.calls.set(key, call)
    }
    if (text(name)) call.name = text(name)
    if (text(callId)) {
      call.id = text(callId)
      this.calls.set(text(callId), call)
    }
    if (text(itemId)) this.calls.set(text(itemId), call)
    return call
  }

  private toolCallChunk(call: PendingCall, args: string): string {
    return this.chunk({
      tool_calls: [{
        index: call.index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: args },
      }],
    })
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    return sse({
      id: this.options.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.options.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })
  }

  push(bytes: string): string {
    this.buffer += bytes
    let out = ""
    for (;;) {
      const boundary = this.buffer.indexOf("\n\n")
      if (boundary === -1) break
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      out += this.translate(block)
    }
    return out
  }

  flush(): string {
    const rest = this.buffer.trim()
    this.buffer = ""
    return rest ? this.translate(rest) : ""
  }

  private translate(block: string): string {
    const dataLines = block.split("\n").filter((line) => line.startsWith("data:"))
    let event: Record<string, unknown> | undefined
    for (const line of dataLines) {
      const raw = line.slice(5).trim()
      if (!raw || raw === "[DONE]") continue
      try {
        const parsed: unknown = JSON.parse(raw)
        if (isRecord(parsed)) event = parsed
      } catch {
        // Ignore keep-alives and malformed events.
      }
    }
    if (!event) return ""
    const type = text(event.type)
    switch (type) {
      case "response.output_text.delta":
        return this.chunk({ content: text(event.delta) })
      case "response.output_item.added": {
        const item = isRecord(event.item) ? event.item : undefined
        if (!item || item.type !== "function_call") return ""
        const call = this.ensureCall(item.id, item.call_id, item.name)
        return this.toolCallChunk(call, "")
      }
      case "response.function_call_arguments.delta": {
        const call = this.ensureCall(event.item_id, event.call_id, event.name)
        call.args += text(event.delta)
        return this.toolCallChunk(call, text(event.delta))
      }
      case "response.function_call_arguments.done": {
        const call = this.ensureCall(event.item_id, event.call_id, event.name)
        // `done` repeats the full argument string; deltas already carried it.
        if (call.args.length > 0) return ""
        call.args = text(event.arguments)
        return this.toolCallChunk(call, call.args)
      }
      case "response.completed":
      case "response.failed":
        return this.chunk({}, "stop") + "data: [DONE]\n\n"
      case "error":
        return sse({ error: event.error ?? { message: "upstream error", type: "server_error" } })
      default:
        return ""
    }
  }
}
