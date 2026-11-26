/** On-disk credential store. Written atomically with owner-only permissions. */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface StoredAuth {
  readonly githubToken: string
  readonly refreshToken?: string
  readonly copilotToken?: string
  readonly copilotExpiresAtMs?: number
  readonly baseURL?: string
  readonly updatedAt: number
}

export interface StoreOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly configDir?: string
  readonly authFile?: string
}

/** Default: ~/.config/copilot-fusion/auth.json (%APPDATA% on Windows). */
export function authFilePath(options: StoreOptions = {}): string {
  if (options.authFile) return options.authFile
  if (options.configDir) return join(options.configDir, "auth.json")
  const env = options.env ?? process.env
  if (env.COPILOT_FUSION_AUTH_FILE) return env.COPILOT_FUSION_AUTH_FILE
  if (env.COPILOT_FUSION_CONFIG_DIR) return join(env.COPILOT_FUSION_CONFIG_DIR, "auth.json")
  const base = process.platform === "win32" && env.APPDATA
    ? env.APPDATA
    : join(homedir(), ".config")
  return join(base, "copilot-fusion", "auth.json")
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function parseStoredAuth(payload: unknown): StoredAuth | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const data = payload as Record<string, unknown>
  const githubToken = text(data.githubToken)
  if (!githubToken) return undefined
  const expires = typeof data.copilotExpiresAtMs === "number" && Number.isFinite(data.copilotExpiresAtMs)
    ? data.copilotExpiresAtMs
    : undefined
  return {
    githubToken,
    refreshToken: text(data.refreshToken),
    copilotToken: text(data.copilotToken),
    copilotExpiresAtMs: expires,
    baseURL: text(data.baseURL),
    updatedAt: typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt) ? data.updatedAt : 0,
  }
}

export async function readAuth(path: string): Promise<StoredAuth | undefined> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return undefined
  }
  try {
    return parseStoredAuth(JSON.parse(raw))
  } catch {
    return undefined
  }
}

export async function writeAuth(path: string, auth: StoredAuth): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

export async function clearAuth(path: string): Promise<void> {
  await unlink(path).catch(() => undefined)
}

/** Never print a full token: logs and `status` use this instead. */
export function maskToken(token: string): string {
  if (token.length <= 12) return "••••"
  return `${token.slice(0, 6)}…${token.slice(-4)}`
}
