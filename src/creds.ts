/**
 * Copilot credential provider.
 *
 * A device login stores a long-lived GitHub OAuth token plus the short-lived
 * Copilot token it was exchanged for. This provider serves the Copilot token
 * to the router and re-exchanges it before it expires. The server never asks
 * the API client for a GitHub credential.
 */
import { DeviceAuth } from "./device.js"
import { credsKey } from "./router.js"
import { authFilePath, clearAuth, readAuth, writeAuth, type StoredAuth } from "./store.js"

export const DEFAULT_BASE_URL = "https://api.githubcopilot.com"

export interface CopilotCredentials {
  readonly token: string
  readonly baseURL: string
  /** Stable identity of the GitHub credential, used to scope sticky routes. */
  readonly key: string
}

export interface CredentialProvider {
  get(options?: { readonly force?: boolean }): Promise<CopilotCredentials>
  invalidate(): void
}

/** Copilot tokens rotate often; the GitHub credential is the stable identity. */
function credentialKey(githubToken: string, baseURL: string): string {
  return credsKey(githubToken, baseURL)
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = "AuthError"
  }
}

export interface CredentialProviderOptions {
  readonly authFile?: string
  readonly deviceAuth: DeviceAuth
  readonly baseURLOverride?: string
  readonly skewMs?: number
  readonly now?: () => number
  readonly log?: (...args: string[]) => void
}

export class FileCredentialProvider implements CredentialProvider {
  private cached?: CopilotCredentials & { readonly expiresAtMs: number }
  private inflight?: Promise<CopilotCredentials>

  constructor(private readonly options: CredentialProviderOptions) {}

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private get skewMs(): number {
    return this.options.skewMs ?? 5 * 60_000
  }

  private get path(): string {
    return this.options.authFile ?? authFilePath()
  }

  private log(...args: string[]): void {
    this.options.log?.(...args)
  }

  invalidate(): void {
    this.cached = undefined
  }

  async save(auth: StoredAuth): Promise<void> {
    await writeAuth(this.path, auth)
    this.cached = undefined
  }

  async clear(): Promise<void> {
    await clearAuth(this.path)
    this.cached = undefined
  }

  async status(): Promise<{
    readonly authFile: string
    readonly authenticated: boolean
    readonly githubToken?: string
    readonly baseURL?: string
    readonly copilotExpiresAtMs?: number
    readonly copilotValid: boolean
  }> {
    const stored = await readAuth(this.path)
    if (!stored) return { authFile: this.path, authenticated: false, copilotValid: false }
    const valid = !!stored.copilotToken
      && (stored.copilotExpiresAtMs ?? 0) - this.now > this.skewMs
    return {
      authFile: this.path,
      authenticated: true,
      githubToken: stored.githubToken,
      baseURL: this.options.baseURLOverride ?? stored.baseURL ?? DEFAULT_BASE_URL,
      copilotExpiresAtMs: stored.copilotExpiresAtMs,
      copilotValid: valid,
    }
  }

  async get(options: { readonly force?: boolean } = {}): Promise<CopilotCredentials> {
    if (!options.force && this.cached && this.cached.expiresAtMs - this.now > this.skewMs) {
      const cached = this.cached
      return { token: cached.token, baseURL: cached.baseURL, key: cached.key }
    }
    if (this.inflight) return this.inflight
    const pending = this.resolve(options.force === true).finally(() => {
      this.inflight = undefined
    })
    this.inflight = pending
    return pending
  }

  private async resolve(force: boolean): Promise<CopilotCredentials> {
    let stored = await readAuth(this.path)
    if (!stored) {
      throw new AuthError("not logged in — run `copilot-api login`", "login_required")
    }
    if (!force && stored.copilotToken && (stored.copilotExpiresAtMs ?? 0) - this.now > this.skewMs) {
      const storedBaseURL = this.options.baseURLOverride ?? stored.baseURL ?? DEFAULT_BASE_URL
      const credentials = {
        token: stored.copilotToken,
        baseURL: storedBaseURL,
        key: credentialKey(stored.githubToken, storedBaseURL),
        expiresAtMs: stored.copilotExpiresAtMs!,
      }
      this.cached = credentials
      return { token: credentials.token, baseURL: credentials.baseURL, key: credentials.key }
    }

    let exchanged = await this.exchange(stored.githubToken)
    if (!exchanged && stored.refreshToken) {
      this.log("copilot token rejected — rotating the GitHub token")
      const rotated = await this.options.deviceAuth.refreshGitHubToken(stored.refreshToken)
      if (rotated) {
        stored = {
          ...stored,
          githubToken: rotated.accessToken,
          refreshToken: rotated.refreshToken ?? stored.refreshToken,
        }
        exchanged = await this.exchange(stored.githubToken)
      }
    }
    if (!exchanged) {
      throw new AuthError("could not refresh the Copilot token — run `copilot-api login` again", "refresh_failed")
    }

    const baseURL = this.options.baseURLOverride ?? exchanged.baseURL ?? stored.baseURL ?? DEFAULT_BASE_URL
    const next: StoredAuth = {
      ...stored,
      copilotToken: exchanged.token,
      copilotExpiresAtMs: exchanged.expiresAtMs,
      baseURL,
      updatedAt: this.now,
    }
    await writeAuth(this.path, next)
    const credentials = {
      token: exchanged.token,
      baseURL,
      key: credentialKey(stored.githubToken, baseURL),
      expiresAtMs: exchanged.expiresAtMs,
    }
    this.cached = credentials
    return { token: exchanged.token, baseURL, key: credentials.key }
  }

  private async exchange(githubToken: string) {
    try {
      return await this.options.deviceAuth.exchangeForCopilotToken(githubToken)
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : ""
      if (code === "http_401" || code === "http_403") return undefined
      throw new AuthError(error instanceof Error ? error.message : String(error), code || "exchange_failed")
    }
  }
}
