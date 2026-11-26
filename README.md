<div align="center">

# copilot-fusion-api

[![ci](https://github.com/IcyHot09/opencode-copilot-fusion/actions/workflows/ci.yml/badge.svg)](https://github.com/IcyHot09/opencode-copilot-fusion/actions/workflows/ci.yml)

Use GitHub Copilot Fusion from any OpenAI client. The server picks a model per prompt and bills the request through your Copilot account.

</div>

> [!IMPORTANT]
> Unofficial. It uses undocumented Copilot endpoints that may change or stop working. Check your organization's Copilot policies before use.

## Install

Node 22 or newer and a GitHub account with an active Copilot seat.

```sh
npm install -g copilot-fusion-api
```

## Sign in

```sh
copilot-fusion-api login
```

Open the URL it prints and enter the code. The CLI saves a credential locally and refreshes it automatically. Use `copilot-fusion-api status` to check the login and `copilot-fusion-api logout` to remove it.

## Run

```sh
copilot-fusion-api serve
```

It listens on `127.0.0.1:8080` and serves `/v1/chat/completions` and `/v1/responses`, both with streaming. Fusion may pick a model that only serves `/responses`; the server translates the wire in both directions, so chat clients keep working. Point an OpenAI client at it:

```js
import OpenAI from "openai"

const client = new OpenAI({ baseURL: "http://127.0.0.1:8080/v1", apiKey: "local-secret" })
const reply = await client.chat.completions.create({
  model: "copilot-fusion",
  messages: [{ role: "user", content: "review this diff" }],
})
console.log(reply.choices[0].message.content)
```

Send `X-Session-ID` on each request to keep the same model across turns.

## Models

| Model | Tier |
| --- | --- |
| `copilot-fusion`, `copilot-fusion-standard` | Standard |
| `copilot-fusion-high` | High |
| `copilot-fusion-max` | Max |

High and Max need Pro+, Max, Business or Enterprise. On the generic `copilot-fusion` model, reasoning effort picks the tier: `low` is Standard, `medium` and `high` are High, `xhigh` is Max.

## Configuration

All settings come from the environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Bind address |
| `API_KEY` | unset | Require clients to send a bearer token |
| `FUSION_STRICT` | `1` | Fail instead of falling back when routing fails |
| `FUSION_DEBUG` | unset | `1` logs routing details |

## Development

```sh
npm install
npm test
npm run typecheck
```

## License

MIT. See [LICENSE](./LICENSE).
