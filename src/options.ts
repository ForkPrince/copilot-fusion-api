/**
 * Runtime configuration. Everything is sourced from environment variables so
 * the same binary works as a CLI, a server, and in a container.
 */

export type RouteMode = "conversation" | "prompt"

export interface FusionOptions {
  /** Anchor model id used when routing is unavailable. */
  readonly anchorModel?: string
  /** Sticky per conversation (default) or a fresh pick for every prompt. */
  readonly route: RouteMode
  /** Drop `temperature` from routed requests (some routed models 400 on it). */
  readonly stripTemperature: boolean
  /** `/auto` request timeout. */
  readonly timeoutMs: number
  /** Re-route when the session token is within this many ms of expiry. */
  readonly skewMs: number
  /** Verbose logging to stderr. */
  readonly debug: boolean
}

const DEFAULTS = {
  route: "conversation",
  stripTemperature: true,
  timeoutMs: 5_000,
  skewMs: 5 * 60_000,
  debug: false,
} as const satisfies Partial<FusionOptions>

export const DEFAULT_FUSION_OPTIONS: FusionOptions = { anchorModel: undefined, ...DEFAULTS }

export interface ServerConfig extends FusionOptions {
  readonly host: string
  readonly port: number
  /** When set, clients must send `Authorization: Bearer <API_KEY>`. */
  readonly apiKey?: string
  readonly githubClientId: string
  readonly deviceCodeUrl: string
  readonly accessTokenUrl: string
  readonly copilotTokenUrl: string
  /** Overrides the API endpoint advertised by the Copilot token response. */
  readonly copilotBaseURL?: string
  readonly configDir?: string
  readonly authFile?: string
}

export const DEFAULT_GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"

function stringValue(env: NodeJS.ProcessEnv, names: readonly string[], fallback?: string): string | undefined {
  for (const name of names) {
    const raw = env[name]
    if (typeof raw !== "string" || !raw.trim()) continue
    return raw.trim()
  }
  return fallback
}

function boolValue(env: NodeJS.ProcessEnv, names: readonly string[], fallback: boolean): boolean {
  for (const name of names) {
    const raw = env[name]
    if (raw === undefined || raw === "") continue
    if (/^(1|true|yes|on)$/i.test(raw.trim())) return true
    if (/^(0|false|no|off)$/i.test(raw.trim())) return false
  }
  return fallback
}

function intValue(env: NodeJS.ProcessEnv, names: readonly string[], fallback: number, min: number, max: number): number {
  const raw = stringValue(env, names)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? Math.floor(parsed) : fallback
}

/** Lenient parse of the routing options; bad values fall back to defaults. */
export function parseFusionOptions(raw: unknown, env: NodeJS.ProcessEnv = process.env): FusionOptions {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const pickString = (key: string) => {
    const value = record[key]
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }
  const pickBoolean = (key: string, fallback: boolean) => {
    const value = record[key]
    return typeof value === "boolean" ? value : fallback
  }
  const pickNumber = (key: string, fallback: number, min: number, max: number) => {
    const value = record[key]
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
      ? Math.floor(value)
      : fallback
  }
  const rawRoute = pickString("route") ?? stringValue(env, ["FUSION_ROUTE"])
  return {
    anchorModel: pickString("anchorModel") ?? stringValue(env, ["COPILOT_ANCHOR_MODEL"]),
    route: rawRoute === "prompt" ? "prompt" : "conversation",
    stripTemperature: pickBoolean("stripTemperature", boolValue(env, ["FUSION_STRIP_TEMPERATURE"], DEFAULTS.stripTemperature)),
    timeoutMs: pickNumber("timeoutMs", intValue(env, ["FUSION_TIMEOUT_MS"], DEFAULTS.timeoutMs, 500, 60_000), 500, 60_000),
    skewMs: pickNumber("skewMs", intValue(env, ["FUSION_SKEW_MS"], DEFAULTS.skewMs, 0, 24 * 60 * 60_000), 0, 24 * 60 * 60_000),
    debug: pickBoolean("debug", DEFAULTS.debug) || boolValue(env, ["FUSION_DEBUG"], false),
  }
}

/** Read the full server/CLI configuration from the environment. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const options = parseFusionOptions(undefined, env)
  return {
    ...options,
    host: stringValue(env, ["HOST", "BIND_HOST"], "127.0.0.1")!,
    port: intValue(env, ["PORT"], 8080, 1, 65535),
    apiKey: stringValue(env, ["API_KEY"]),
    githubClientId: stringValue(env, ["GITHUB_CLIENT_ID"], DEFAULT_GITHUB_CLIENT_ID)!,
    deviceCodeUrl: stringValue(env, ["GITHUB_DEVICE_CODE_URL"], "https://github.com/login/device/code")!,
    accessTokenUrl: stringValue(env, ["GITHUB_ACCESS_TOKEN_URL"], "https://github.com/login/oauth/access_token")!,
    copilotTokenUrl: stringValue(
      env,
      ["COPILOT_TOKEN_URL"],
      "https://api.github.com/copilot_internal/v2/token",
    )!,
    copilotBaseURL: stringValue(env, ["COPILOT_BASE_URL"]),
    configDir: stringValue(env, ["COPILOT_FUSION_CONFIG_DIR"]),
    authFile: stringValue(env, ["COPILOT_FUSION_AUTH_FILE"]),
  }
}
