/**
 * Codex OAuth Authentication Service
 *
 * Handles OpenAI OAuth2 PKCE flow for Codex CLI authentication.
 * Supports:
 * - API key authentication (direct)
 * - OAuth access token authentication (from codex CLI login)
 * - Token refresh with retry
 * - JWT ID token parsing for account info
 *
 * Ported from CLIProxyAPI:
 *   - internal/auth/codex/openai_auth.go
 *   - internal/auth/codex/openai.go
 *   - internal/auth/codex/token.go
 *   - internal/auth/codex/jwt_parser.go
 *   - internal/auth/codex/pkce.go
 */

import { Injectable, Logger } from "@nestjs/common"
import * as crypto from "crypto"
import { CodexModelTier, normalizeCodexModelTier } from "../model-registry"

// ── OAuth Constants (matching codex_cli_rs) ────────────────────────────

const AUTH_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const REDIRECT_URI = "http://localhost:1455/auth/callback"

// ── Types ──────────────────────────────────────────────────────────────

export interface PKCECodes {
  codeVerifier: string
  codeChallenge: string
}

export interface CodexTokenData {
  idToken: string
  accessToken: string
  refreshToken: string
  accountId: string
  email: string
  expire: string
}

export interface CodexAuthBundle {
  apiKey: string
  tokenData: CodexTokenData
  lastRefresh: string
}

interface JWTClaims {
  sub?: string
  email?: string
  organizations?: Array<{ id: string; is_default?: boolean }>
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
    chatgpt_plan_type?: string
    organizations?: Array<{ id: string; is_default?: boolean }>
  }
  [key: string]: unknown
}

// ── Service ────────────────────────────────────────────────────────────

@Injectable()
export class CodexAuthService {
  private readonly logger = new Logger(CodexAuthService.name)

  /** Current token data (if using OAuth mode) */
  private tokenData: CodexTokenData | null = null
  private lastRefresh: string = ""

  // ── PKCE Utilities ─────────────────────────────────────────────────

  /**
   * Generate PKCE codes for OAuth2 authorization flow.
   * Ported from: internal/auth/codex/pkce.go
   */
  generatePKCECodes(): PKCECodes {
    const verifierBytes = crypto.randomBytes(32)
    const codeVerifier = verifierBytes
      .toString("base64url")
      .replace(/[^a-zA-Z0-9\-._~]/g, "")

    const hash = crypto.createHash("sha256").update(codeVerifier).digest()
    const codeChallenge = hash.toString("base64url")

    return { codeVerifier, codeChallenge }
  }

  // ── Auth URL Generation ────────────────────────────────────────────

  /**
   * Generate the OAuth authorization URL with PKCE.
   * Ported from: internal/auth/codex/openai_auth.go GenerateAuthURL()
   */
  generateAuthURL(state: string, pkceCodes: PKCECodes): string {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: "openid email profile offline_access",
      state,
      code_challenge: pkceCodes.codeChallenge,
      code_challenge_method: "S256",
      prompt: "login",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    })

    return `${AUTH_URL}?${params.toString()}`
  }

  // ── Token Exchange ─────────────────────────────────────────────────

  /**
   * Exchange an authorization code for access and refresh tokens.
   * Ported from: internal/auth/codex/openai_auth.go ExchangeCodeForTokens()
   */
  async exchangeCodeForTokens(
    code: string,
    pkceCodes: PKCECodes,
    redirectUri: string = REDIRECT_URI
  ): Promise<CodexAuthBundle> {
    const data = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: pkceCodes.codeVerifier,
    })

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: data.toString(),
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Token exchange failed with status ${response.status}: ${body.slice(0, 200)}`
      )
    }

    const tokenResp = (await response.json()) as {
      access_token: string
      refresh_token: string
      id_token: string
      token_type: string
      expires_in: number
    }

    const claims = this.parseJWTToken(tokenResp.id_token)
    const accountId = claims ? this.extractAccountId(claims) : ""
    const email = claims?.email || ""

    const expireDate = new Date(
      Date.now() + tokenResp.expires_in * 1000
    ).toISOString()

    const tokenData: CodexTokenData = {
      idToken: tokenResp.id_token,
      accessToken: tokenResp.access_token,
      refreshToken: tokenResp.refresh_token,
      accountId,
      email,
      expire: expireDate,
    }

    this.tokenData = tokenData
    this.lastRefresh = new Date().toISOString()

    return {
      apiKey: "",
      tokenData,
      lastRefresh: this.lastRefresh,
    }
  }

  // ── Token Refresh ──────────────────────────────────────────────────

  /**
   * Refresh an access token using a refresh token.
   * Ported from: internal/auth/codex/openai_auth.go RefreshTokens()
   */
  async refreshTokens(refreshToken: string): Promise<CodexTokenData> {
    if (!refreshToken) {
      throw new Error("Refresh token is required")
    }

    const data = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    })

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: data.toString(),
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Token refresh failed with status ${response.status}: ${body.slice(0, 200)}`
      )
    }

    const tokenResp = (await response.json()) as {
      access_token: string
      refresh_token: string
      id_token: string
      token_type: string
      expires_in: number
    }

    const claims = this.parseJWTToken(tokenResp.id_token)
    const accountId = claims ? this.extractAccountId(claims) : ""
    const email = claims?.email || ""

    const expireDate = new Date(
      Date.now() + tokenResp.expires_in * 1000
    ).toISOString()

    return {
      idToken: tokenResp.id_token,
      accessToken: tokenResp.access_token,
      refreshToken: tokenResp.refresh_token,
      accountId,
      email,
      expire: expireDate,
    }
  }

  /**
   * Refresh tokens with retry mechanism.
   * Ported from: internal/auth/codex/openai_auth.go RefreshTokensWithRetry()
   */
  async refreshTokensWithRetry(
    refreshToken: string,
    maxRetries: number = 3
  ): Promise<CodexTokenData> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
      }

      try {
        const tokenData = await this.refreshTokens(refreshToken)
        this.tokenData = tokenData
        this.lastRefresh = new Date().toISOString()
        return tokenData
      } catch (e) {
        lastError = e as Error
        const errorMsg = lastError.message.toLowerCase()

        // Non-retryable errors
        if (errorMsg.includes("refresh_token_reused")) {
          this.logger.warn(
            `Token refresh attempt ${attempt + 1} failed with non-retryable error: ${lastError.message}`
          )
          throw lastError
        }

        this.logger.warn(
          `Token refresh attempt ${attempt + 1} failed: ${lastError.message}`
        )
      }
    }

    throw new Error(
      `Token refresh failed after ${maxRetries} attempts: ${lastError?.message}`
    )
  }

  // ── JWT Parsing ────────────────────────────────────────────────────

  /**
   * Parse a JWT token without verification (for extracting claims).
   * Ported from: internal/auth/codex/jwt_parser.go ParseJWTToken()
   */
  private parseJWTToken(token: string): JWTClaims | null {
    if (!token) return null

    try {
      const parts = token.split(".")
      if (parts.length !== 3) return null

      const payload = parts[1]
      if (!payload) return null

      const decoded = Buffer.from(payload, "base64url").toString("utf-8")
      return JSON.parse(decoded) as JWTClaims
    } catch {
      this.logger.warn("Failed to parse JWT token")
      return null
    }
  }

  /**
   * Extract account ID from JWT claims.
   * Ported from: internal/auth/codex/jwt_parser.go GetAccountID()
   */
  private extractAccountId(claims: JWTClaims): string {
    const authClaims = claims["https://api.openai.com/auth"]
    if (authClaims?.chatgpt_account_id) {
      return authClaims.chatgpt_account_id
    }

    const organizations = authClaims?.organizations || claims.organizations
    if (organizations && Array.isArray(organizations)) {
      for (const org of organizations) {
        if (org.is_default && org.id) {
          return org.id
        }
      }
      if (organizations.length > 0 && organizations[0]?.id) {
        return organizations[0].id
      }
    }
    return ""
  }

  // ── Token State ────────────────────────────────────────────────────

  getTokenData(): CodexTokenData | null {
    return this.tokenData
  }

  isTokenExpired(): boolean {
    if (!this.tokenData?.expire) return true
    try {
      const expireDate = new Date(this.tokenData.expire)
      return Date.now() > expireDate.getTime() - 30_000
    } catch {
      return true
    }
  }

  getAccountId(): string {
    return this.tokenData?.accountId || ""
  }

  getPlanType(): CodexModelTier | null {
    return this.getPlanTypeFromIdToken(this.tokenData?.idToken || "")
  }

  getPlanTypeFromIdToken(idToken: string): CodexModelTier | null {
    const claims = this.parseJWTToken(idToken)
    if (!claims) {
      return null
    }

    return normalizeCodexModelTier(
      claims["https://api.openai.com/auth"]?.chatgpt_plan_type
    )
  }

  getAccountIdFromIdToken(idToken: string): string {
    const claims = this.parseJWTToken(idToken)
    if (!claims) {
      return ""
    }

    return this.extractAccountId(claims)
  }

  setTokenData(tokenData: CodexTokenData): void {
    this.tokenData = tokenData
    this.lastRefresh = new Date().toISOString()
  }

  /**
   * Ensure we have a valid access token, refreshing if needed.
   */
  async ensureValidToken(): Promise<string | null> {
    if (!this.tokenData) return null

    if (this.isTokenExpired() && this.tokenData.refreshToken) {
      this.logger.log("Access token expired, refreshing...")
      try {
        await this.refreshTokensWithRetry(this.tokenData.refreshToken)
        this.logger.log("Token refreshed successfully")
      } catch (e) {
        this.logger.error(`Token refresh failed: ${(e as Error).message}`)
        return null
      }
    }

    return this.tokenData.accessToken || null
  }
}
