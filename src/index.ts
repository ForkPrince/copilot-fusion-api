/**
 * copilot-fusion-api
 *
 * A standalone OpenAI-compatible API for GitHub Copilot Fusion. Exposes the
 * pieces used by the CLI server so they can also be embedded in other Node
 * programs (or in tests) without depending on any editor integration.
 */
export { createServer, type ServerOptions } from "./server.js"
export {
  AuthError,
  DEFAULT_BASE_URL,
  FileCredentialProvider,
  type CopilotCredentials,
  type CredentialProvider,
  type CredentialProviderOptions,
} from "./creds.js"
export {
  DeviceAuth,
  DeviceLoginError,
  parseAccessTokenResponse,
  parseCopilotToken,
  parseDeviceCodeResponse,
  type CopilotToken,
  type DeviceAuthOptions,
  type DeviceCodeResponse,
  type GitHubAccessToken,
} from "./device.js"
export {
  authFilePath,
  clearAuth,
  maskToken,
  parseStoredAuth,
  readAuth,
  writeAuth,
  type StoredAuth,
} from "./store.js"
export {
  configFromEnv,
  DEFAULT_FUSION_OPTIONS,
  DEFAULT_GITHUB_CLIENT_ID,
  parseFusionOptions,
  type FusionOptions,
  type RouteMode,
  type ServerConfig,
} from "./options.js"
export { credsKey, FusionRouter, type RouteEntry, type RouteRequest, type RouteResult } from "./router.js"
export {
  effortFromBody,
  isKnownModel,
  listOpenAIModels,
  MODEL_IDS,
  sessionIdFrom,
  tierFromRequest,
  type OpenAIModel,
} from "./models.js"
export { extractPromptFromBody, type ExtractedPrompt } from "./prompt.js"
export { rewriteRequest, type RewriteOptions, type RewriteResult } from "./rewrite.js"
export {
  COPILOT_API_VERSION,
  FUSION_TIERS,
  isFusionVariant,
  normalizeVariant,
  parseFusionMeta,
  resolveWireTier,
  type FusionMetaTiers,
  type FusionVariant,
  type ResolvedTier,
  type TierAvailability,
} from "./tiers.js"
export { wireForEndpoint, wireOfModelId, wirePath, type Wire } from "./wire.js"
export type { FetchLike } from "./http.js"
