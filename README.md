<div align="center">

# copilot-fusion-api

[![ci](https://github.com/IcyHot09/opencode-copilot-fusion/actions/workflows/ci.yml/badge.svg)](https://github.com/IcyHot09/opencode-copilot-fusion/actions/workflows/ci.yml)

Use GitHub Copilot Fusion from any OpenAI client. The server picks a model per prompt and bills the request through Copilot.

</div>

> [!IMPORTANT]
> This project is unofficial. It uses Copilot's undocumented private endpoints (`POST /auto` and `GET /meta`). They can change or stop working without notice. GitHub does not endorse it. Use it at your own risk and respect your organization's Copilot policies.

Point an existing OpenAI client at the server, ask for a Fusion model, and inference goes to the model Copilot picks. The project used to be an opencode plugin. It now runs on its own with no editor integration and no `@opencode` dependency.

## What you get

| Model name | Fusion tier | `/auto` tier | Plans |
| --- | --- | --- | --- |
| `copilot-fusion`, `copilot-fusion-standard` | Standard | `balance` | all plans |
| `copilot-fusion-high` | High | `hydrafusion` | Pro+, Max, Business, Enterprise |
| `copilot-fusion-max` | Max | `hydrafusion-max` | Pro+, Max, Business, Enterprise |

You can also select a tier with OpenAI's reasoning effort on the generic `copilot-fusion` model. `low` selects Standard, `medium` and `high` select High, and `xhigh` selects Max. An explicit model name wins over the effort field. If High is unavailable but classic Auto is offered, the server degrades to the `intelligence` tier. Max has no fallback.

## Install

Requires Node 22 or newer and a GitHub account with an active Copilot seat.

```sh
npm install -g copilot-fusion-api
```

Or install a release tarball without npm registry access:

```sh
curl -L -o copilot-fusion-api.tgz https://github.com/IcyHot09/opencode-copilot-fusion/releases/download/v0.3.0/copilot-fusion-api-0.3.0.tgz
npm install -g ./copilot-fusion-api.tgz
```

To run from source, clone the repository and run `npm install && npm run build`.

## Sign in

```sh
copilot-fusion-api login
```

The command prints a GitHub URL and a one-time code. Open the URL and enter the code. The CLI saves the Copilot credential to `~/.config/copilot-fusion/auth.json` with owner-only permissions. It exchanges the long-lived GitHub token for a short-lived Copilot token and refreshes it before it expires. Run `copilot-fusion-api status` to check the login or `copilot-fusion-api logout` to remove it.

The server never asks clients for a GitHub token. The key clients send guards the local HTTP API and is required only when you set `API_KEY`.

## Run

```sh
copilot-fusion-api serve
```

The server listens on `127.0.0.1:8080` by default. To require a key from clients:

```sh
API_KEY=local-secret PORT=3000 copilot-fusion-api serve
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Authorization: Bearer local-secret' \
  -H 'Content-Type: application/json' \
  -d '{"model":"copilot-fusion-high","messages":[{"role":"user","content":"review this diff"}]}'
```

OpenAI SDKs only need a different base URL:

```js
import OpenAI from "openai"

const client = new OpenAI({ baseURL: "http://127.0.0.1:8080/v1", apiKey: "local-secret" })
const reply = await client.chat.completions.create({
  model: "copilot-fusion-high",
  messages: [{ role: "user", content: "review this diff" }],
  stream: true,
})
for await (const chunk of reply) process.stdout.write(chunk.choices[0]?.delta?.content ?? "")
```

Set `X-Session-ID` on each request to keep routing sticky across turns. Without it the server groups requests under a shared `default` session. The identifier can also come from `session_id` in the request body or `user`.

## Docker

Build the image and mount the credential directory so the container reuses your login:

```sh
docker build -t copilot-fusion-api .
docker run -it -v "$HOME/.config/copilot-fusion:/root/.config/copilot-fusion" copilot-fusion-api login
docker run -p 8080:8080 -v "$HOME/.config/copilot-fusion:/root/.config/copilot-fusion" -e API_KEY=local-secret copilot-fusion-api
```

The image listens on `0.0.0.0:8080`. Set `COPILOT_FUSION_AUTH_FILE` to use a credential file elsewhere.

## Endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Liveness check |
| `GET /v1/models` | The four Fusion model ids |
| `POST /v1/chat/completions` | Chat Completions, including `stream: true` over SSE |
| `POST /v1/responses` | Responses API, including `stream: true` over SSE |

Both inference endpoints pass tools, images, system prompts and tool calls through to Copilot unchanged. The server swaps the `model` field to the picked model and attaches `Copilot-Session-Token`, which is what bills Fusion.

## Configuration

All settings come from the environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8080` | Bind port |
| `API_KEY` | unset | When set, clients must send it as a bearer token or `x-api-key` |
| `COPILOT_ANCHOR_MODEL` | unset | Model used when routing is unavailable |
| `COPILOT_BASE_URL` | token response | Override the Copilot API endpoint |
| `GITHUB_CLIENT_ID` | public Copilot client id | OAuth device flow client |
| `FUSION_ROUTE` | `conversation` | `conversation` pins a model per session, `prompt` picks per prompt |
| `FUSION_STRIP_TEMPERATURE` | `1` | Drop `temperature` from routed requests |
| `FUSION_TIMEOUT_MS` | `5000` | Timeout for `/auto` and `/meta` calls |
| `FUSION_SKEW_MS` | `300000` | Re-route this long before a session token expires |
| `FUSION_DEBUG` | unset | Set to `1` for stderr diagnostics |
| `COPILOT_FUSION_AUTH_FILE` | platform config dir | Override the credential file path |
| `COPILOT_FUSION_CONFIG_DIR` | `~/.config/copilot-fusion` | Override the credential directory |

Useful commands: `copilot-fusion-api help`, `copilot-fusion-api --version`, `npm start`, `npm run login`.

## How routing works

1. The server reads `GET /meta` to see which tiers the account can run, then calls `POST /auto` with the last user prompt, `has_image` and the selected tier.
2. `/auto` replies with one picked model and a 24-hour session token. The inference request goes to that model with `Copilot-Session-Token` set.
3. The pick stays pinned for the session. A new pick happens after a variant switch, near token expiry, on an image prompt when the pick lacks vision, or on every prompt in `prompt` mode.
4. If `/auto` fails, returns no usable model or picks a model that cannot serve the requested wire, the server falls back to a catalog model with the original body. If a routed upstream request fails, it retries once on that fallback.

Fusion orchestration (cascade, critique and parallel model calls) happens on GitHub's servers. The client only chooses a tier. The server logs the picked model and any `hydra_scores` or `discounted_costs` with `FUSION_DEBUG=1`, but GitHub does not guarantee a full per-turn model list.

Copilot bills each underlying model. High and Max can call more than one model per prompt.

## Limits

Only the OpenAI Chat Completions and Responses endpoints are exposed. Copilot's Anthropic-style `/v1/messages` wire is not. Model names outside the four listed ids are rejected with `model_not_found`. Device login needs a browser once, so it does not run unattended on a fresh machine.

## Development

```sh
npm install
npm test
npm run typecheck
```

Tests use mocked `/auto`, `/meta` and inference responses. No Copilot account is needed.

## License

MIT. See [LICENSE](./LICENSE).
