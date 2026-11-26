#!/usr/bin/env node
/** CLI for the standalone Copilot Fusion OpenAI-compatible API. */
import { DeviceAuth, DeviceLoginError } from "./device.js"
import { FileCredentialProvider } from "./creds.js"
import { authFilePath, maskToken } from "./store.js"
import { configFromEnv } from "./options.js"
import { createServer } from "./server.js"
import { describeError } from "./http.js"

const VERSION = "0.3.0"

function usage(): string {
  return `copilot-fusion-api ${VERSION}

Usage: copilot-fusion-api <command>

Commands:
  login     Sign in with GitHub device code (stores a Copilot token locally)
  serve     Start the OpenAI-compatible API (default command)
  status    Show authentication status
  logout    Remove stored credentials
  help      Show this message

Configuration is read from the environment:
  HOST=127.0.0.1 PORT=8080 API_KEY=secret
  COPILOT_ANCHOR_MODEL COPILOT_BASE_URL COPILOT_FUSION_AUTH_FILE
  GITHUB_CLIENT_ID FUSION_DEBUG=1 FUSION_ROUTE=conversation|prompt
`
}

function makeDeviceAuth() {
  const config = configFromEnv()
  return {
    config,
    device: new DeviceAuth({
      clientId: config.githubClientId,
      deviceCodeUrl: config.deviceCodeUrl,
      accessTokenUrl: config.accessTokenUrl,
      copilotTokenUrl: config.copilotTokenUrl,
    }),
  }
}

async function login(): Promise<void> {
  const { config, device } = makeDeviceAuth()
  const code = await device.begin()
  const uri = code.verificationUriComplete ?? code.verificationUri
  process.stderr.write(`\n  Open: ${uri}\n  Code: ${code.userCode}\n\n  Waiting for authorization (Ctrl-C to cancel)...\n`)
  const github = await device.waitForAuthorization(code, () => process.stderr.write("."))
  process.stderr.write("\n")
  const copilot = await device.exchangeForCopilotToken(github.accessToken)
  const provider = new FileCredentialProvider({
    authFile: config.authFile ?? authFilePath({ configDir: config.configDir }),
    deviceAuth: device,
    baseURLOverride: config.copilotBaseURL,
  })
  await provider.save({
    githubToken: github.accessToken,
    refreshToken: github.refreshToken,
    copilotToken: copilot.token,
    copilotExpiresAtMs: copilot.expiresAtMs,
    baseURL: config.copilotBaseURL ?? copilot.baseURL,
    updatedAt: Date.now(),
  })
  const endpoint = config.copilotBaseURL ?? copilot.baseURL ?? "https://api.githubcopilot.com"
  process.stderr.write(`\nLogged in. Copilot API: ${endpoint}; token expires ${new Date(copilot.expiresAtMs).toISOString()}.\n`)
  const path = authFilePath({ authFile: config.authFile, configDir: config.configDir })
  process.stderr.write(`Credentials saved to ${path} (owner-only permissions).\n`)
}

async function status(): Promise<void> {
  const { config, device } = makeDeviceAuth()
  const provider = new FileCredentialProvider({
    authFile: config.authFile ?? authFilePath({ configDir: config.configDir }),
    deviceAuth: device,
    baseURLOverride: config.copilotBaseURL,
  })
  const state = await provider.status()
  if (!state.authenticated) {
    process.stdout.write("Not logged in. Run `copilot-fusion-api login`.\n")
    return
  }
  process.stdout.write(`Auth file:     ${state.authFile}\n`)
  process.stdout.write(`GitHub token:  ${maskToken(state.githubToken ?? "")}\n`)
  process.stdout.write(`Copilot API:   ${state.baseURL ?? "unknown"}\n`)
  process.stdout.write(`Copilot token: ${state.copilotValid ? "valid" : "expired (will refresh on first request)"}\n`)
  if (state.copilotExpiresAtMs) {
    process.stdout.write(`Expires:       ${new Date(state.copilotExpiresAtMs).toISOString()}\n`)
  }
}

async function logout(): Promise<void> {
  const { config, device } = makeDeviceAuth()
  const provider = new FileCredentialProvider({
    authFile: config.authFile ?? authFilePath({ configDir: config.configDir }),
    deviceAuth: device,
  })
  await provider.clear()
  process.stderr.write("Stored credentials removed.\n")
}

async function serve(): Promise<void> {
  const config = configFromEnv()
  const device = new DeviceAuth({
    clientId: config.githubClientId,
    deviceCodeUrl: config.deviceCodeUrl,
    accessTokenUrl: config.accessTokenUrl,
    copilotTokenUrl: config.copilotTokenUrl,
  })
  const provider = new FileCredentialProvider({
    authFile: config.authFile ?? authFilePath({ configDir: config.configDir }),
    deviceAuth: device,
    baseURLOverride: config.copilotBaseURL,
    skewMs: config.skewMs,
    log: config.debug ? (...args: string[]) => console.error("[copilot-fusion]", ...args) : undefined,
  })
  const server = createServer({
    ...config,
    creds: provider,
    log: config.debug ? (...args: string[]) => console.error("[copilot-fusion]", ...args) : undefined,
  })
  server.on("error", (error) => {
    console.error(`[copilot-fusion] server error: ${describeError(error)}`)
    process.exitCode = 1
  })
  server.listen(config.port, config.host, () => {
    console.error(`[copilot-fusion] OpenAI-compatible API at http://${config.host}:${config.port}/v1`)
    console.error(`[copilot-fusion] models: copilot-fusion, copilot-fusion-high, copilot-fusion-max`)
    if (config.apiKey) console.error("[copilot-fusion] API key authentication enabled")
  })
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)))
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "serve"
  switch (command) {
    case "login":
      await login()
      return
    case "status":
      await status()
      return
    case "logout":
      await logout()
      return
    case "serve":
      await serve()
      return
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(usage())
      return
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`)
      return
    default:
      process.stderr.write(`Unknown command '${command}'.\n\n${usage()}`)
      process.exitCode = 2
  }
}

main().catch((error: unknown) => {
  const message = error instanceof DeviceLoginError || error instanceof Error ? error.message : String(error)
  process.stderr.write(`[copilot-fusion] ${message}\n`)
  process.exitCode = 1
})
