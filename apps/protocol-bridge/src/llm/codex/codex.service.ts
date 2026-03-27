/**
 * CodexService — Core executor for Codex (OpenAI Responses API) reverse proxy.
 *
 * Handles:
 * - Claude → Codex request translation
 * - HTTP POST to Codex upstream (SSE streaming)
 * - WebSocket transport (with automatic fallback to HTTP)
 * - Codex SSE → Claude SSE response translation
 * - Non-streaming mode
 * - Proxy support (HTTP/HTTPS/SOCKS5)
 * - Request header emulation (codex_cli_rs client)
 * - OAuth token management with auto-refresh
 * - Prompt caching via Conversation_id/Session_id headers
 * - Retry-after handling for rate limits
 *
 * Ported from CLIProxyAPI:
 *   - internal/runtime/executor/codex_executor.go
 *   - internal/runtime/executor/codex_websockets_executor.go
 *   - internal/translator/codex/claude/
 */

import { HttpException, Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicResponse } from "../../shared/anthropic"
import { CodexModelTier, normalizeCodexModelTier } from "../model-registry"
import { CodexAuthService } from "./codex-auth.service"
import { CodexCacheService } from "./codex-cache.service"
import { translateClaudeToCodex } from "./codex-request-translator"
import {
  createStreamState,
  translateCodexSseEvent,
  translateCodexToClaudeNonStream,
} from "./codex-response-translator"
import { buildReverseMapFromClaudeTools } from "./tool-name-shortener"
import {
  CodexWebSocketService,
  CodexWebSocketUpgradeError,
} from "./codex-websocket.service"

// ── Constants (matching codex_cli_rs) ──────────────────────────────────

const CODEX_CLIENT_VERSION = "0.101.0"
const CODEX_USER_AGENT =
  "codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464"
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex"

export class CodexApiError extends HttpException {
  constructor(
    statusCode: number,
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(
      {
        type: "error",
        error: {
          type: "api_error",
          message,
        },
        message,
        ...(retryAfterSeconds != null
          ? { retry_after: retryAfterSeconds }
          : {}),
      },
      statusCode
    )
    this.name = "CodexApiError"
  }
}

// ── Service ────────────────────────────────────────────────────────────

@Injectable()
export class CodexService implements OnModuleInit {
  private readonly logger = new Logger(CodexService.name)

  private apiKey: string = ""
  private accessToken: string = ""
  private baseUrl: string = DEFAULT_BASE_URL
  private proxyUrl: string = ""
  private sessionId: string = crypto.randomUUID()
  private configuredModelTier: CodexModelTier | null = null

  /** Whether to prefer WebSocket transport over HTTP */
  private useWebSocket: boolean = false
  /** Whether WebSocket was rejected by upstream (fallback to HTTP) */
  private webSocketRejected: boolean = false

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: CodexAuthService,
    private readonly cacheService: CodexCacheService,
    private readonly wsService: CodexWebSocketService
  ) {}

  onModuleInit() {
    this.apiKey = this.configService.get<string>("CODEX_API_KEY", "").trim()
    this.accessToken = this.configService
      .get<string>("CODEX_ACCESS_TOKEN", "")
      .trim()
    this.baseUrl = this.configService
      .get<string>("CODEX_BASE_URL", DEFAULT_BASE_URL)
      .trim()
    this.proxyUrl = this.configService.get<string>("CODEX_PROXY_URL", "").trim()

    // WebSocket transport preference
    const wsEnv = this.configService
      .get<string>("CODEX_USE_WEBSOCKET", "")
      .trim()
      .toLowerCase()
    this.useWebSocket = wsEnv === "true" || wsEnv === "1"

    if (!this.baseUrl) {
      this.baseUrl = DEFAULT_BASE_URL
    }

    // If access token is provided, set it in the auth service
    if (this.accessToken) {
      this.authService.setTokenData({
        idToken: this.configService.get<string>("CODEX_ID_TOKEN", "").trim(),
        accessToken: this.accessToken,
        refreshToken: this.configService
          .get<string>("CODEX_REFRESH_TOKEN", "")
          .trim(),
        accountId: this.configService
          .get<string>("CODEX_ACCOUNT_ID", "")
          .trim(),
        email: "",
        expire: new Date(Date.now() + 3600 * 1000).toISOString(),
      })
    }

    this.configuredModelTier = this.resolveConfiguredModelTier()

    const hasCredentials = !!(this.apiKey || this.accessToken)
    this.logger.log(
      `Codex backend initialized: baseUrl=${this.baseUrl}, ` +
        `hasApiKey=${!!this.apiKey}, hasAccessToken=${!!this.accessToken}, ` +
        `hasProxy=${!!this.proxyUrl}, useWebSocket=${this.useWebSocket}, ` +
        `modelTier=${this.configuredModelTier || "unknown"}`
    )
    if (!hasCredentials) {
      this.logger.warn(
        "No Codex credentials configured (CODEX_API_KEY or CODEX_ACCESS_TOKEN). " +
          "GPT/O-series models will not be available."
      )
    }
  }

  /**
   * Check if Codex backend is available (has credentials configured).
   */
  isAvailable(): boolean {
    return !!(this.apiKey || this.accessToken)
  }

  getModelTier(): CodexModelTier | null {
    return this.authService.getPlanType() || this.configuredModelTier
  }

  private resolveConfiguredModelTier(): CodexModelTier | null {
    const envTier = normalizeCodexModelTier(
      this.configService.get<string>("CODEX_PLAN_TYPE", "")
    )
    if (envTier) {
      return envTier
    }

    const tokenTier = this.authService.getPlanType()
    if (tokenTier) {
      return tokenTier
    }

    return this.readModelTierFromLocalAuthFile()
  }

  private readModelTierFromLocalAuthFile(): CodexModelTier | null {
    const codexHome =
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
    const authFile = path.join(codexHome, "auth.json")

    try {
      if (!fs.existsSync(authFile)) {
        return null
      }

      const raw = fs.readFileSync(authFile, "utf8")
      const parsed = JSON.parse(raw) as {
        tokens?: { id_token?: string }
      }

      return this.authService.getPlanTypeFromIdToken(
        parsed.tokens?.id_token || ""
      )
    } catch (error) {
      this.logger.warn(
        `Failed to infer Codex plan type from ${authFile}: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  /**
   * Get the bearer token for authentication.
   * Prefers API key over access token.
   * For access token mode, ensures token is valid (refreshes if needed).
   */
  private async getBearerToken(): Promise<string> {
    if (this.apiKey) return this.apiKey

    // Try to get a valid access token (with auto-refresh)
    const token = await this.authService.ensureValidToken()
    if (token) return token

    // Fallback to static access token
    return this.accessToken
  }

  /**
   * Get bearer token synchronously (for non-async contexts).
   */
  private getBearerTokenSync(): string {
    if (this.apiKey) return this.apiKey
    const tokenData = this.authService.getTokenData()
    return tokenData?.accessToken || this.accessToken
  }

  /**
   * Determine if we're using an API key (vs OAuth access token).
   */
  private isApiKeyMode(): boolean {
    return !!this.apiKey
  }

  /**
   * Build the fetch agent for proxy support.
   */
  private buildProxyAgent():
    | HttpProxyAgent<string>
    | HttpsProxyAgent<string>
    | SocksProxyAgent
    | undefined {
    if (!this.proxyUrl) return undefined

    try {
      const url = new URL(this.proxyUrl)
      switch (url.protocol) {
        case "http:":
          return new HttpProxyAgent(this.proxyUrl)
        case "https:":
          return new HttpsProxyAgent(this.proxyUrl)
        case "socks5:":
        case "socks5h:":
        case "socks4:":
          return new SocksProxyAgent(this.proxyUrl)
        default:
          this.logger.error(`Unsupported proxy scheme: ${url.protocol}`)
          return undefined
      }
    } catch (e) {
      this.logger.error(`Failed to parse proxy URL: ${(e as Error).message}`)
      return undefined
    }
  }

  /**
   * Build request headers matching codex_cli_rs behavior.
   * Ported from: codex_executor.go applyCodexHeaders()
   */
  private buildHeaders(
    token: string,
    stream: boolean,
    cacheHeaders?: Record<string, string>
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Version: CODEX_CLIENT_VERSION,
      Session_id: this.sessionId,
      "User-Agent": CODEX_USER_AGENT,
      Connection: "Keep-Alive",
      Accept: stream ? "text/event-stream" : "application/json",
    }

    // Non-API-key mode: add Originator header (OAuth/access token mode)
    if (!this.isApiKeyMode()) {
      headers["Originator"] = "codex_cli_rs"

      // Add account ID if available
      const accountId = this.authService.getAccountId()
      if (accountId) {
        headers["Chatgpt-Account-Id"] = accountId
      }
    }

    // Merge cache headers
    if (cacheHeaders) {
      for (const [key, value] of Object.entries(cacheHeaders)) {
        headers[key] = value
      }
    }

    return headers
  }

  /**
   * Parse retry-after from Codex rate limit errors.
   * Ported from: codex_executor.go parseCodexRetryAfter()
   */
  private parseRetryAfter(
    statusCode: number,
    errorBody: string
  ): number | null {
    if (statusCode !== 429) return null

    try {
      const parsed = JSON.parse(errorBody) as Record<string, unknown>
      const error = parsed.error as Record<string, unknown> | undefined
      if (!error) return null

      if (error.type !== "usage_limit_reached") return null

      // Check resets_at (Unix timestamp)
      const resetsAt = error.resets_at as number | undefined
      if (resetsAt && resetsAt > 0) {
        const now = Math.floor(Date.now() / 1000)
        if (resetsAt > now) {
          return resetsAt - now
        }
      }

      // Check resets_in_seconds
      const resetsInSeconds = error.resets_in_seconds as number | undefined
      if (resetsInSeconds && resetsInSeconds > 0) {
        return resetsInSeconds
      }
    } catch {
      // Ignore parse errors
    }

    return null
  }

  private summarizeErrorBody(errorBody: string): string {
    const trimmed = errorBody.trim()
    if (!trimmed) {
      return ""
    }

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const error =
        parsed.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>)
          : undefined
      const message =
        (typeof error?.message === "string" && error.message.trim()) ||
        (typeof parsed.message === "string" && parsed.message.trim()) ||
        trimmed

      return message.slice(0, 200)
    } catch {
      return trimmed.slice(0, 200)
    }
  }

  private createCodexApiError(
    statusCode: number,
    errorBody: string
  ): CodexApiError {
    const retryAfter = this.parseRetryAfter(statusCode, errorBody)
    const details = this.summarizeErrorBody(errorBody)

    if (retryAfter != null) {
      const suffix = details ? ` ${details}` : ""
      return new CodexApiError(
        statusCode,
        `Codex rate limited. Retry after ${retryAfter} seconds.${suffix}`,
        retryAfter
      )
    }

    const message = details
      ? `Codex API error ${statusCode}: ${details}`
      : `Codex API error ${statusCode}`

    return new CodexApiError(statusCode, message)
  }

  /**
   * Build the Codex request URL.
   */
  private buildUrl(endpoint: string = "responses"): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/${endpoint}`
  }

  /**
   * Get cache ID for the current request.
   */
  private getCacheId(dto: CreateMessageDto): string {
    // Extract user ID from metadata if available
    const metadata = dto as unknown as {
      metadata?: { user_id?: string }
    }
    const userId = metadata?.metadata?.user_id

    if (userId) {
      return this.cacheService.getOrCreateCacheId(dto.model, userId)
    }

    // Fallback: use API key-based cache
    if (this.apiKey) {
      return this.cacheService.getCacheIdFromApiKey(this.apiKey)
    }

    return ""
  }

  // ── Non-streaming ────────────────────────────────────────────────────

  /**
   * Send a non-streaming message through Codex.
   */
  async sendClaudeMessage(dto: CreateMessageDto): Promise<AnthropicResponse> {
    const token = await this.getBearerToken()
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    const modelName = dto.model
    const reverseToolMap = buildReverseMapFromClaudeTools(dto.tools)

    // Translate request
    let codexRequest = translateClaudeToCodex(dto, modelName) as Record<
      string,
      unknown
    >

    // Apply prompt cache
    const cacheId = this.getCacheId(dto)
    if (cacheId) {
      codexRequest = this.cacheService.injectCacheKey(codexRequest, cacheId)
    }

    // Try WebSocket transport first (if enabled and not rejected)
    if (
      this.useWebSocket &&
      !this.webSocketRejected &&
      this.wsService.isWebSocketAvailable()
    ) {
      try {
        return await this.sendViaWebSocket(
          token,
          codexRequest,
          modelName,
          reverseToolMap,
          cacheId
        )
      } catch (e) {
        if (e instanceof CodexWebSocketUpgradeError) {
          if (e.shouldFallbackToHttp()) {
            this.logger.warn("WebSocket upgrade rejected, falling back to HTTP")
            this.webSocketRejected = true
          } else {
            throw this.createCodexApiError(
              e.statusCode || 502,
              e.body || e.message
            )
          }
        } else {
          throw e
        }
      }
    }

    // HTTP transport
    return this.sendViaHttp(
      token,
      codexRequest,
      modelName,
      reverseToolMap,
      cacheId
    )
  }

  /**
   * Send non-streaming via HTTP.
   */
  private async sendViaHttp(
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string
  ): Promise<AnthropicResponse> {
    const requestBody = JSON.stringify(codexRequest)
    const url = this.buildUrl("responses")
    const cacheHeaders = this.cacheService.buildCacheHeaders(cacheId)
    const headers = this.buildHeaders(token, true, cacheHeaders)

    this.logger.log(
      `[Codex] Non-stream request: model=${modelName}, url=${url}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(300_000),
    }

    const agent = this.buildProxyAgent()
    if (agent) {
      fetchOptions.dispatcher = agent
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[Codex] Request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )

      throw this.createCodexApiError(response.status, errorBody)
    }

    // Read the full SSE stream and find response.completed
    const fullBody = await response.text()
    const lines = fullBody.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue

      const jsonStr = trimmed.slice(5).trim()
      if (!jsonStr || jsonStr === "[DONE]") continue

      try {
        const event = JSON.parse(jsonStr) as Record<string, unknown>
        if (event.type === "response.completed") {
          const result = translateCodexToClaudeNonStream(event, reverseToolMap)
          if (result) {
            this.logger.log(
              `[Codex] Non-stream response: model=${result.model}, stop=${result.stop_reason}`
            )
            return result
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    throw new Error("Codex stream ended without response.completed event")
  }

  /**
   * Send non-streaming via WebSocket.
   */
  private async sendViaWebSocket(
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string
  ): Promise<AnthropicResponse> {
    const httpUrl = this.buildUrl("responses")
    const wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
    const cacheHeaders = this.cacheService.buildCacheHeaders(cacheId)
    const wsHeaders = this.wsService.buildWebSocketHeaders(
      token,
      this.isApiKeyMode(),
      this.authService.getAccountId(),
      cacheHeaders
    )

    this.logger.log(
      `[Codex] WebSocket non-stream request: model=${modelName}, url=${wsUrl}`
    )

    const ws = await this.wsService.connect(
      wsUrl,
      wsHeaders,
      this.proxyUrl || undefined
    )

    try {
      const wsBody = this.wsService.buildWebSocketRequestBody(codexRequest)
      const completedEvent = await this.wsService.sendViaWebSocket(ws, wsBody)

      const result = translateCodexToClaudeNonStream(
        completedEvent as Record<string, unknown>,
        reverseToolMap
      )
      if (result) {
        this.logger.log(
          `[Codex] WebSocket non-stream response: model=${result.model}, stop=${result.stop_reason}`
        )
        return result
      }

      throw new Error("WebSocket response did not contain valid completion")
    } finally {
      ws.close()
    }
  }

  // ── Streaming ────────────────────────────────────────────────────────

  /**
   * Send a streaming message through Codex.
   * Returns an async generator yielding Claude SSE event strings.
   */
  async *sendClaudeMessageStream(
    dto: CreateMessageDto
  ): AsyncGenerator<string, void, unknown> {
    const token = await this.getBearerToken()
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    const modelName = dto.model
    const reverseToolMap = buildReverseMapFromClaudeTools(dto.tools)

    // Translate request
    let codexRequest = translateClaudeToCodex(dto, modelName) as Record<
      string,
      unknown
    >

    // Apply prompt cache
    const cacheId = this.getCacheId(dto)
    if (cacheId) {
      codexRequest = this.cacheService.injectCacheKey(codexRequest, cacheId)
    }

    // Try WebSocket transport first (if enabled and not rejected)
    if (
      this.useWebSocket &&
      !this.webSocketRejected &&
      this.wsService.isWebSocketAvailable()
    ) {
      try {
        yield* this.streamViaWebSocket(
          token,
          codexRequest,
          modelName,
          reverseToolMap,
          cacheId
        )
        return
      } catch (e) {
        if (e instanceof CodexWebSocketUpgradeError) {
          if (e.shouldFallbackToHttp()) {
            this.logger.warn(
              "WebSocket upgrade rejected, falling back to HTTP for streaming"
            )
            this.webSocketRejected = true
          } else {
            throw this.createCodexApiError(
              e.statusCode || 502,
              e.body || e.message
            )
          }
        } else {
          throw e
        }
      }
    }

    // HTTP transport
    yield* this.streamViaHttp(
      token,
      codexRequest,
      modelName,
      reverseToolMap,
      cacheId
    )
  }

  /**
   * Stream via HTTP SSE transport.
   */
  private async *streamViaHttp(
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string
  ): AsyncGenerator<string, void, unknown> {
    const requestBody = JSON.stringify(codexRequest)
    const url = this.buildUrl("responses")
    const cacheHeaders = this.cacheService.buildCacheHeaders(cacheId)
    const headers = this.buildHeaders(token, true, cacheHeaders)

    this.logger.log(`[Codex] Stream request: model=${modelName}, url=${url}`)

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(600_000),
    }

    const agent = this.buildProxyAgent()
    if (agent) {
      fetchOptions.dispatcher = agent
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[Codex] Stream request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )

      throw this.createCodexApiError(response.status, errorBody)
    }

    if (!response.body) {
      throw new Error("Codex response has no body")
    }

    // Stream SSE events
    const state = createStreamState()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          const claudeEvents = translateCodexSseEvent(
            trimmed,
            state,
            reverseToolMap
          )
          for (const event of claudeEvents) {
            yield event
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const claudeEvents = translateCodexSseEvent(
          buffer.trim(),
          state,
          reverseToolMap
        )
        for (const event of claudeEvents) {
          yield event
        }
      }
    } finally {
      reader.releaseLock()
    }

    this.logger.log(
      `[Codex] Stream completed: model=${modelName}, blocks=${state.blockIndex}, hasToolCall=${state.hasToolCall}`
    )
  }

  /**
   * Stream via WebSocket transport.
   * Converts WebSocket JSON messages to SSE-formatted lines for the
   * existing response translator.
   */
  private async *streamViaWebSocket(
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string
  ): AsyncGenerator<string, void, unknown> {
    const httpUrl = this.buildUrl("responses")
    const wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
    const cacheHeaders = this.cacheService.buildCacheHeaders(cacheId)
    const wsHeaders = this.wsService.buildWebSocketHeaders(
      token,
      this.isApiKeyMode(),
      this.authService.getAccountId(),
      cacheHeaders
    )

    this.logger.log(
      `[Codex] WebSocket stream request: model=${modelName}, url=${wsUrl}`
    )

    const ws = await this.wsService.connect(
      wsUrl,
      wsHeaders,
      this.proxyUrl || undefined
    )

    const state = createStreamState()

    try {
      const wsBody = this.wsService.buildWebSocketRequestBody(codexRequest)

      for await (const msg of this.wsService.streamViaWebSocket(ws, wsBody)) {
        // Convert WebSocket message to SSE line for the translator
        const sseLine = `data: ${JSON.stringify(msg)}`
        const claudeEvents = translateCodexSseEvent(
          sseLine,
          state,
          reverseToolMap
        )
        for (const event of claudeEvents) {
          yield event
        }
      }
    } finally {
      ws.close()
    }

    this.logger.log(
      `[Codex] WebSocket stream completed: model=${modelName}, blocks=${state.blockIndex}, hasToolCall=${state.hasToolCall}`
    )
  }

  // ── Availability ─────────────────────────────────────────────────────

  /**
   * Check if the Codex backend is reachable.
   */
  checkAvailability(): Promise<boolean> {
    return Promise.resolve(this.isAvailable())
  }
}
