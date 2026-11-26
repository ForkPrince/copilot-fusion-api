/** Shared HTTP primitives for GitHub and Copilot endpoints. */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Headers GitHub's Copilot clients send; several endpoints require them. */
export const EDITOR_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
}

export function githubHeaders(accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...EDITOR_HEADERS,
  }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  return headers
}

export function copilotHeaders(token: string, apiVersion: string): Record<string, string> {
  return {
    ...githubHeaders(token),
    "X-GitHub-Api-Version": apiVersion,
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
