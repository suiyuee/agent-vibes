import { Injectable, Logger } from "@nestjs/common"
import {
  detectModelFamily,
  isOpusModel,
  resolveCloudCodeModel,
} from "./model-registry"

/**
 * Backend types for routing.
 * - google: Gemini-family models via Google Cloud Code
 * - google-claude: Claude family models served by Google Cloud Code
 * - codex: OpenAI GPT/O-series models via Codex reverse proxy
 * - openai-compat: Third-party OpenAI-compatible API (Chat Completions)
 */
export type BackendType = "google" | "google-claude" | "codex" | "openai-compat"

/**
 * Model routing result
 */
export interface ModelRouteResult {
  backend: BackendType
  model: string
  isThinking: boolean
}

@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name)

  private googleAvailable = false
  private codexAvailable = false
  private openaiCompatAvailable = false

  /**
   * Keep availability check so startup behavior remains explicit.
   */
  async initializeRouting(
    googleCheck: () => Promise<boolean>,
    codexCheck?: () => Promise<boolean>,
    openaiCompatCheck?: () => Promise<boolean>
  ): Promise<void> {
    this.logger.log("=== Testing Backend APIs ===")

    this.googleAvailable = await googleCheck().catch((e) => {
      this.logger.error(
        `Google Cloud Code check error: ${(e as Error).message}`
      )
      return false
    })

    if (codexCheck) {
      this.codexAvailable = await codexCheck().catch((e) => {
        this.logger.error(`Codex check error: ${(e as Error).message}`)
        return false
      })
    }

    if (openaiCompatCheck) {
      this.openaiCompatAvailable = await openaiCompatCheck().catch((e) => {
        this.logger.error(
          `OpenAI-compatible check error: ${(e as Error).message}`
        )
        return false
      })
    }

    this.logger.log("=== Backend Availability ===")
    this.logger.log(`  Google Cloud Code: ${this.googleAvailable ? "✓" : "✗"}`)
    this.logger.log(`  Codex (OpenAI):    ${this.codexAvailable ? "✓" : "✗"}`)
    this.logger.log(
      `  OpenAI-Compat:     ${this.openaiCompatAvailable ? "✓" : "✗"}`
    )
    this.logger.log("=== Routing Decision ===")
    this.logger.log("  Gemini/Claude models -> Google backend")
    if (this.openaiCompatAvailable) {
      this.logger.log(
        "  GPT/O-series models  -> OpenAI-compatible backend (priority)"
      )
    } else if (this.codexAvailable) {
      this.logger.log("  GPT/O-series models  -> Codex backend")
    } else {
      this.logger.log(
        "  GPT/O-series models  -> ERROR (no GPT backend configured)"
      )
    }
    this.logger.log("========================")
  }

  /** Backend availability getters for startup banner */
  get isGoogleAvailable(): boolean {
    return this.googleAvailable
  }
  get isCodexAvailable(): boolean {
    return this.codexAvailable
  }
  get isOpenaiCompatAvailable(): boolean {
    return this.openaiCompatAvailable
  }

  /**
   * Resolve model to appropriate backend.
   * Uses unified model-registry for all name resolution.
   */
  resolveModel(cursorModel: string): ModelRouteResult {
    const normalized = cursorModel.toLowerCase().trim()
    const family = detectModelFamily(normalized)
    const entry = resolveCloudCodeModel(normalized)

    // 1. Known model with registry entry
    if (entry) {
      // GPT family → openai-compat (priority) > codex > google fallback
      if (entry.family === "gpt") {
        if (this.openaiCompatAvailable) {
          this.logger.log(
            `[ROUTE] ${cursorModel} -> OpenAI-compat | ${entry.cloudCodeId}`
          )
          return {
            backend: "openai-compat",
            model: entry.cloudCodeId,
            isThinking: entry.isThinking,
          }
        }
        if (this.codexAvailable) {
          this.logger.log(
            `[ROUTE] ${cursorModel} -> Codex | ${entry.cloudCodeId}`
          )
          return {
            backend: "codex",
            model: entry.cloudCodeId,
            isThinking: entry.isThinking,
          }
        }

        throw new Error(
          `No GPT backend available for model ${cursorModel}. ` +
            `Configure OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY or CODEX_API_KEY.`
        )
      }

      // Claude/Gemini → Google backend
      const backend: BackendType = entry.isClaudeThroughGoogle
        ? "google-claude"
        : "google"
      this.logger.log(
        `[ROUTE] ${cursorModel} -> Google Cloud Code${entry.isClaudeThroughGoogle ? " Claude" : ""} | ${entry.cloudCodeId}`
      )
      return {
        backend,
        model: entry.cloudCodeId,
        isThinking: entry.isThinking,
      }
    }

    // 2. Claude Opus not in registry -> default Opus
    if (isOpusModel(normalized)) {
      this.logger.log(
        `[ROUTE] ${cursorModel} -> Google Cloud Code Claude | claude-opus-4-6-thinking`
      )
      return {
        backend: "google-claude",
        model: "claude-opus-4-6-thinking",
        isThinking: true,
      }
    }

    // 3. GPT family -> openai-compat > codex > google fallback
    if (family === "gpt") {
      const isThinkingModel =
        normalized.startsWith("o3") ||
        normalized.startsWith("o4") ||
        normalized.startsWith("codex")

      if (this.openaiCompatAvailable) {
        this.logger.log(
          `[ROUTE] ${cursorModel} -> OpenAI-compat | ${normalized}`
        )
        return {
          backend: "openai-compat",
          model: normalized,
          isThinking: isThinkingModel,
        }
      }
      if (this.codexAvailable) {
        this.logger.log(`[ROUTE] ${cursorModel} -> Codex | ${normalized}`)
        return {
          backend: "codex",
          model: normalized,
          isThinking: isThinkingModel,
        }
      }
      throw new Error(
        `No GPT backend available for model ${cursorModel}. ` +
          `Configure OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY or CODEX_API_KEY.`
      )
    }

    // 4. Unknown Claude variant not in registry
    if (family === "claude") {
      throw new Error(
        `Unknown Claude model ${cursorModel} not in registry. ` +
          `Supported Claude models are resolved via model-registry.`
      )
    }

    // 5. Unknown model family
    throw new Error(
      `Unknown model ${cursorModel}. Supported families: gemini, claude, gpt/o-series.`
    )
  }
}
