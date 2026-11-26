/**
 * GitHub OAuth device login and the Copilot token exchange.
 *
 *   1. POST /login/device/code          -> device_code + user_code
 *   2. POST /login/oauth/access_token   -> long-lived GitHub OAuth token
 *   3. GET  /copilot_internal/v2/token  -> short-lived Copilot API token
 *
 * The Copilot token is what authorises inference requests; the GitHub token
 * is kept only so it can be exchanged again when the Copilot token expires.
 */
import { githubHeaders, type FetchLike } from "./http.js"

export interface DeviceCodeResponse {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete?: string
  readonly intervalSec: number
  readonly expiresInSec: number
}

export interface GitHubAccessToken {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresInSec?: number
}

export interface CopilotToken {
  readonly token: string
  readonly expiresAtMs: number
  /** API base advertised by the token response (enterprise / data residency). */
  readonly baseURL?: string
}

export class DeviceLoginError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = "DeviceLoginError"
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** Pure parser, exported for tests. */
export function parseDeviceCodeResponse(payload: unknown): DeviceCodeResponse | undefined {
  const data = record(payload)
  if (!data) return undefined
  const deviceCode = stringField(data.device_code)
  const userCode = stringField(data.user_code)
  const verificationUri = stringField(data.verification_uri)
  if (!deviceCode || !userCode || !verificationUri) return undefined
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: stringField(data.verification_uri_complete),
    intervalSec: positiveInt(data.interval, 5),
    expiresInSec: positiveInt(data.expires_in, 900),
  }
}

/** Pure parser for the OAuth token poll / refresh response. */
export function parseAccessTokenResponse(payload: unknown): GitHubAccessToken | undefined {
  const data = record(payload)
  if (!data) return undefined
  const accessToken = stringField(data.access_token)
  if (!accessToken) return undefined
  return {
    accessToken,
    refreshToken: stringField(data.refresh_token),
    expiresInSec: typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : undefined,
  }
}

/** Pure parser for GET /copilot_internal/v2/token. */
export function parseCopilotToken(payload: unknown, now: number): CopilotToken | undefined {
  const data = record(payload)
  if (!data) return undefined
  const token = stringField(data.token)
  if (!token) return undefined
  const raw = typeof data.expires_at === "number" && Number.isFinite(data.expires_at) ? data.expires_at : undefined
  const expiresAtMs = raw === undefined ? now + 29 * 60_000 : raw * 1000
  const api = record(data.endpoints)?.api
  return {
    token,
    expiresAtMs,
    baseURL: stringField(api),
  }
}

export interface DeviceAuthOptions {
  readonly clientId: string
  readonly deviceCodeUrl: string
  readonly accessTokenUrl: string
  readonly copilotTokenUrl: string
  readonly fetchImpl?: FetchLike
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class DeviceAuth {
  constructor(private readonly options: DeviceAuthOptions) {}

  private get fetchImpl(): FetchLike {
    return this.options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private async postForm(url: string, body: Record<string, unknown>): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: githubHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new DeviceLoginError(`network error: ${error instanceof Error ? error.message : String(error)}`, "network")
    }
    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      if (!response.ok) throw new DeviceLoginError(`HTTP ${response.status}`, `http_${response.status}`)
      throw new DeviceLoginError("response was not JSON", "bad_json")
    }
    if (!response.ok) {
      const data = record(payload)
      const error = stringField(data?.error) ?? `HTTP ${response.status}`
      throw new DeviceLoginError(error, error)
    }
    return payload
  }

  /** Step 1: ask GitHub for a device + user code. */
  async begin(): Promise<DeviceCodeResponse> {
    const payload = await this.postForm(this.options.deviceCodeUrl, {
      client_id: this.options.clientId,
      scope: "read:user",
    })
    const parsed = parseDeviceCodeResponse(payload)
    if (!parsed) throw new DeviceLoginError("device code response was missing required fields", "bad_shape")
    return parsed
  }

  /**
   * Step 2: poll until the user approves the code in their browser.
   * `onPending` is called on every `authorization_pending` poll so the CLI can
   * show a quiet progress indicator.
   */
  async waitForAuthorization(
    device: DeviceCodeResponse,
    onPending?: (delayMs: number) => void,
  ): Promise<GitHubAccessToken> {
    const sleep = this.options.sleep ?? DEFAULT_SLEEP
    let intervalMs = Math.max(1, device.intervalSec) * 1000
    const deadline = this.now + Math.max(1, device.expiresInSec) * 1000
    while (this.now < deadline) {
      await sleep(intervalMs)
      const payload = await this.postForm(this.options.accessTokenUrl, {
        client_id: this.options.clientId,
        device_code: device.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      })
      const token = parseAccessTokenResponse(payload)
      if (token) return token
      const data = record(payload)
      const error = stringField(data?.error) ?? "unknown_error"
      if (error === "authorization_pending") {
        onPending?.(intervalMs)
        continue
      }
      if (error === "slow_down") {
        intervalMs += 5000
        continue
      }
      const description = stringField(data?.error_description) ?? error
      throw new DeviceLoginError(description, error)
    }
    throw new DeviceLoginError("device code expired before the user authorised it", "expired_token")
  }

  /** Step 3: exchange the GitHub token for a short-lived Copilot token. */
  async exchangeForCopilotToken(githubToken: string): Promise<CopilotToken> {
    let response: Response
    try {
      response = await this.fetchImpl(this.options.copilotTokenUrl, {
        headers: githubHeaders(githubToken),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new DeviceLoginError(`network error: ${error instanceof Error ? error.message : String(error)}`, "network")
    }
    if (!response.ok) {
      throw new DeviceLoginError(`Copilot token exchange failed: HTTP ${response.status}`, `http_${response.status}`)
    }
    const payload = await response.json().catch(() => undefined)
    const parsed = parseCopilotToken(payload, this.now)
    if (!parsed) throw new DeviceLoginError("Copilot token response was missing a token", "bad_shape")
    return parsed
  }

  /** Rotate a device-flow GitHub token when the provider supports it. */
  async refreshGitHubToken(refreshToken: string): Promise<GitHubAccessToken | undefined> {
    try {
      const payload = await this.postForm(this.options.accessTokenUrl, {
        client_id: this.options.clientId,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      })
      return parseAccessTokenResponse(payload)
    } catch {
      return undefined
    }
  }
}
