<div align="center">

# copilot-api

[![ci](https://github.com/IcyHot09/opencode-copilot-fusion/actions/workflows/ci.yml/badge.svg)](https://github.com/IcyHot09/opencode-copilot-fusion/actions/workflows/ci.yml)

Use GitHub Copilot Fusion and Auto from any OpenAI client. The server picks a model for each prompt and bills it to your Copilot account.

</div>

> [!IMPORTANT]
> Unofficial. It uses undocumented Copilot endpoints that may change or stop working. Check your organization's Copilot policies before use.

## Install

Node 22 or newer and a GitHub account with an active Copilot seat.

```sh
npm install -g copilot-api
```

## Sign in

```sh
copilot-api login
```

Open the URL it prints and enter the code. The CLI saves a credential locally and refreshes it as needed. Use `copilot-api status` to check the login and `copilot-api logout` to remove it.

## Run

```sh
copilot-api serve
```

The server listens on `127.0.0.1:8080` and exposes `/v1/chat/completions` and `/v1/responses`, both with streaming. It also serves `/v1/models` and `/health`.

Copilot may pick a model that only supports `/responses`, so the server translates between the two wire formats and chat clients keep working.

Point an OpenAI client at it:

```js
import OpenAI from "openai"

const client = new OpenAI({ baseURL: "http://127.0.0.1:8080/v1", apiKey: "local-secret" })
const reply = await client.chat.completions.create({
  model: "copilot-fusion",
  messages: [{ role: "user", content: "review this diff" }],
})
console.log(reply.choices[0].message.content)
```

Send `X-Session-ID` on each request to keep the same model across a conversation.

## Models

Two routing families are available. Both send the request to Copilot's `/auto` endpoint, which chooses a model based on the prompt and the selected tier.

### Fusion

Fusion has three effort levels.

| Model | Tier |
| --- | --- |
| `copilot-fusion`, `copilot-fusion-standard` | Standard |
| `copilot-fusion-high` | High |
| `copilot-fusion-max` | Max |

High and Max need Pro+, Max, Business or Enterprise. With the generic `copilot-fusion` name, reasoning effort picks the tier: `low` maps to Standard, `medium` and `high` to High, and `xhigh` to Max.

### Auto

Auto has four routing profiles, including a Fast preset for lower latency.

| Model | Profile |
| --- | --- |
| `auto`, `copilot-auto` | Balance (default) |
| `copilot-auto-efficiency` | Efficiency |
| `copilot-auto-balance` | Balance |
| `copilot-auto-intelligence` | Intelligence |
| `copilot-auto-fast` | Fast |

With the generic `auto` name, reasoning effort picks the profile: `low` maps to Efficiency, `medium` to Balance, and `high` and `xhigh` to Intelligence.

A tier or profile in the model name always wins over reasoning effort. Both families use the same `X-Session-ID` stickiness.

## Configuration

All settings come from the environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Bind address |
| `API_KEY` | unset | Require clients to send a bearer token |
| `STRICT` | `1` | Fail instead of falling back when routing fails |
| `ROUTE` | `conversation` | Keep one model per session, or pick per prompt with `prompt` |
| `DEBUG` | unset | Set to `1` to log routing details |

## Development

```sh
npm install
npm run check
```

It runs the typecheck, build and tests.

## License

MIT. See [LICENSE](./LICENSE).
