import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConversationTruncatorService, UnifiedMessage } from "../../context"
import { TokenizerService } from "../../context/tokenizer.service"
import { CodexService } from "../../llm/codex/codex.service"
import { GoogleModelCacheService } from "../../llm/google/google-model-cache.service"
import { GoogleService } from "../../llm/google/google.service"
import {
  getCodexPublicModelIds,
  getPublicModelMetadata,
  resolveCloudCodeModel,
} from "../../llm/model-registry"
import { ModelRouterService } from "../../llm/model-router.service"
import { OpenaiCompatService } from "../../llm/openai-compat/openai-compat.service"
import type { AnthropicResponse } from "../../shared/anthropic"
import { CountTokensDto } from "./dto/count-tokens.dto"
import { CreateMessageDto } from "./dto/create-message.dto"

/**
 * MessagesService - Routes requests to Google or Codex backend.
 */
@Injectable()
export class MessagesService implements OnModuleInit {
  private readonly logger = new Logger(MessagesService.name)

  constructor(
    private readonly googleService: GoogleService,
    private readonly googleModelCache: GoogleModelCacheService,
    private readonly modelRouter: ModelRouterService,
    private readonly tokenizer: TokenizerService,
    private readonly truncator: ConversationTruncatorService,
    private readonly codexService: CodexService,
    private readonly openaiCompatService: OpenaiCompatService
  ) {}

  /**
   * Initialize backend availability checks.
   */
  async onModuleInit(): Promise<void> {
    await this.modelRouter.initializeRouting(
      () => this.googleService.checkAvailability(),
      () => this.codexService.checkAvailability(),
      () => this.openaiCompatService.checkAvailability()
    )
    this.logger.log("Backend availability tests completed")
  }

  /**
   * Extract text content from message content
   */
  private extractTextContent(content: unknown): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .filter(
          (block): block is { type: string; text: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "text"
        )
        .map((block) => block.text)
        .join("\n")
    }
    return ""
  }

  /**
   * Prepare DTO for Google Cloud Code backend routing.
   * GoogleService replaces dto.system entirely with the official Antigravity prompt.
   * To preserve user customizations (CLAUDE.md rules, project settings, etc.),
   * extract them from dto.system and inject as user messages in dto.messages.
   *
   * This matches Antigravity's behavior: user context goes in contents (user messages),
   * not in systemInstruction.
   */
  private prepareForGoogle(dto: CreateMessageDto): CreateMessageDto {
    if (!dto.system) return dto

    // Extract raw system text
    let systemText: string
    if (typeof dto.system === "string") {
      systemText = dto.system
    } else if (Array.isArray(dto.system)) {
      systemText = dto.system
        .filter(
          (block): block is { type: string; text: string } =>
            typeof block === "object" && block !== null && block.type === "text"
        )
        .map((block) => block.text)
        .join("\n")
    } else {
      systemText = this.extractTextContent(dto.system)
    }

    if (!systemText) return dto

    // If system prompt contains Claude Code identity, extract the user rules portion
    // Claude Code format: identity section + user rules + tool descriptions + ...
    // We only need to preserve user-defined content (rules, project settings)
    const contextMessages: Array<{ role: string; content: string }> = []

    if (
      systemText.includes("You are Claude Code") ||
      systemText.includes("You are Claude")
    ) {
      // Claude Code system prompt - extract user rules sections
      // Look for common markers that indicate user-defined content
      const userRulesMarkers = [
        /# User's Custom Instructions[\s\S]*?(?=\n#|$)/,
        /# CLAUDE\.md[\s\S]*?(?=\n#|$)/,
        /## User Rules[\s\S]*?(?=\n##|$)/,
        /<user_rules>[\s\S]*?<\/user_rules>/,
      ]

      const extractedRules: string[] = []
      for (const marker of userRulesMarkers) {
        const match = systemText.match(marker)
        if (match) {
          extractedRules.push(match[0])
        }
      }

      if (extractedRules.length > 0) {
        contextMessages.push({
          role: "user",
          content:
            "<user_rules>\n" + extractedRules.join("\n\n") + "\n</user_rules>",
        })
      }
    } else {
      // Non-Claude-Code system prompt — preserve entire content as user context
      contextMessages.push({
        role: "user",
        content: "<user_rules>\n" + systemText + "\n</user_rules>",
      })
    }

    if (contextMessages.length === 0) return dto

    this.logger.log(
      `[prepareForGoogle] Moved ${contextMessages.length} user context block(s) from system to messages`
    )

    return {
      ...dto,
      messages: [...(contextMessages as typeof dto.messages), ...dto.messages],
    }
  }

  /**
   * Apply context truncation to messages if needed
   * Returns a new DTO with truncated messages
   */
  private applyTruncation(dto: CreateMessageDto): CreateMessageDto {
    // Calculate system prompt tokens
    const systemPromptTokens = dto.system
      ? this.truncator.countTokens([
          { role: "user", content: dto.system } as UnifiedMessage,
        ])
      : 0

    // Apply truncation
    const truncationResult = this.truncator.truncateInMemory(
      dto.messages as UnifiedMessage[],
      {
        systemPromptTokens,
        pendingToolUseIds: dto._pendingToolUseIds,
      }
    )

    if (truncationResult.was_truncated) {
      this.logger.log(
        `Applied context truncation: ${truncationResult.original_token_count} -> ` +
          `${truncationResult.truncated_token_count} tokens ` +
          `(${dto.messages.length} -> ${truncationResult.messages.length} messages)`
      )
    }

    return {
      ...dto,
      messages: truncationResult.messages as typeof dto.messages,
    }
  }

  /**
   * Whether doc creation prohibition policy should be injected.
   * Disabled by default for open-source friendliness.
   */
  private shouldEnforceDocProhibition(): boolean {
    const raw = process.env.ENFORCE_DOC_PROHIBITION?.toLowerCase()
    return raw === "true" || raw === "1"
  }

  /**
   * Inject documentation prohibition into system prompt
   * This applies to all request entry points.
   */
  private injectDocProhibition(dto: CreateMessageDto): CreateMessageDto {
    const docProhibition =
      "\n\n[CRITICAL SYSTEM RULE] You are ABSOLUTELY FORBIDDEN from " +
      "creating any documentation files (*.md, *.txt, README, CHANGELOG, etc.) unless the user " +
      "EXPLICITLY requests it. Do NOT create documentation proactively. Ask for permission first."

    // Handle system prompt - can be string or array of content blocks
    let systemText: string
    if (typeof dto.system === "string") {
      systemText = dto.system
    } else if (Array.isArray(dto.system)) {
      systemText = dto.system
        .filter(
          (block): block is { type: string; text: string } =>
            typeof block === "object" && block !== null && block.type === "text"
        )
        .map((block) => block.text)
        .join("\n")
    } else {
      systemText = ""
    }

    const newSystem = systemText + docProhibition

    return {
      ...dto,
      system: newSystem,
    }
  }

  async createMessage(dto: CreateMessageDto): Promise<AnthropicResponse> {
    this.logger.log(
      `Request for model: ${dto.model}, stream: ${dto.stream || false}`
    )

    if (this.shouldEnforceDocProhibition()) {
      dto = this.injectDocProhibition(dto)
    }

    // Apply context truncation before routing
    dto = this.applyTruncation(dto)

    // Use ModelRouterService for model-based routing
    const route = this.modelRouter.resolveModel(dto.model)
    const routedDto = { ...dto, model: route.model }

    // Route to OpenAI-compatible backend
    if (route.backend === "openai-compat") {
      this.logger.log(`[ROUTE] OpenAI-compat backend | model: ${route.model}`)
      return this.openaiCompatService.sendClaudeMessage(routedDto)
    }

    // Route to Codex backend for GPT/O-series models
    if (route.backend === "codex") {
      this.logger.log(`[ROUTE] Codex backend | model: ${route.model}`)
      return this.codexService.sendClaudeMessage(routedDto)
    }

    this.logger.log(`[ROUTE] Google backend | model: ${route.model}`)
    return this.googleService.sendClaudeMessage(
      this.prepareForGoogle(routedDto)
    )
  }

  /**
   * Create streaming message response
   */
  async *createMessageStream(
    dto: CreateMessageDto
  ): AsyncGenerator<string, void, unknown> {
    this.logger.log(`Streaming request for model: ${dto.model}`)

    if (this.shouldEnforceDocProhibition()) {
      dto = this.injectDocProhibition(dto)
    }

    // Apply context truncation before routing
    dto = this.applyTruncation(dto)

    // Use ModelRouterService for model-based routing
    const route = this.modelRouter.resolveModel(dto.model)
    const routedDto = { ...dto, model: route.model }

    // Route to OpenAI-compatible backend
    if (route.backend === "openai-compat") {
      this.logger.log(
        `[ROUTE] OpenAI-compat backend | model: ${route.model} | stream: true`
      )
      yield* this.openaiCompatService.sendClaudeMessageStream(routedDto)
      return
    }

    // Route to Codex backend for GPT/O-series models
    if (route.backend === "codex") {
      this.logger.log(
        `[ROUTE] Codex backend | model: ${route.model} | stream: true`
      )
      yield* this.codexService.sendClaudeMessageStream(routedDto)
      return
    }

    this.logger.log(
      `[ROUTE] Google backend | model: ${route.model} | stream: true`
    )
    yield* this.googleService.sendClaudeMessageStream(
      this.prepareForGoogle(routedDto)
    )
  }

  /**
   * Count tokens in a request
   * Reference: https://docs.anthropic.com/en/api/messages-count-tokens
   */
  countTokens(dto: CountTokensDto): { input_tokens: number } {
    this.logger.log(`Count tokens request for model: ${dto.model}`)

    let totalTokens = 0

    // Count system prompt tokens
    if (dto.system) {
      if (typeof dto.system === "string") {
        totalTokens += this.tokenizer.countTokens(dto.system)
      } else if (Array.isArray(dto.system)) {
        for (const block of dto.system) {
          if (block.type === "text" && block.text) {
            totalTokens += this.tokenizer.countTokens(block.text)
          }
        }
      }
    }

    // Count message tokens
    for (const message of dto.messages) {
      // Base tokens per message (role, separators)
      totalTokens += 4

      // Role token
      totalTokens += this.tokenizer.countTokens(message.role, false)

      // Content tokens
      if (message.content) {
        if (typeof message.content === "string") {
          totalTokens += this.tokenizer.countTokens(message.content)
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === "text" && block.text) {
              totalTokens += this.tokenizer.countTokens(block.text)
            } else if (block.type === "tool_use" && block.input) {
              // Tool use blocks: count the JSON input
              totalTokens += this.tokenizer.countTokens(
                JSON.stringify(block.input)
              )
              totalTokens += 10 // overhead for tool_use structure
            } else if (block.type === "tool_result") {
              // Tool result blocks
              if (block.text) {
                totalTokens += this.tokenizer.countTokens(block.text)
              }
              totalTokens += 5 // overhead for tool_result structure
            }
          }
        }
      }
    }

    // Count tool definition tokens
    if (dto.tools && dto.tools.length > 0) {
      for (const tool of dto.tools) {
        if (tool.name) {
          totalTokens += this.tokenizer.countTokens(tool.name, false)
        }
        if (tool.description) {
          totalTokens += this.tokenizer.countTokens(tool.description, false)
        }
        if (tool.input_schema) {
          totalTokens += this.tokenizer.countTokens(
            JSON.stringify(tool.input_schema),
            false
          )
        }
        // Overhead per tool
        totalTokens += 10
      }
    }

    // Add message separator tokens
    totalTokens += 3

    this.logger.debug(`Count tokens result: ${totalTokens}`)

    return { input_tokens: totalTokens }
  }

  listModels() {
    const now = Math.floor(Date.now() / 1000)
    const modelMap = new Map<
      string,
      {
        id: string
        object: string
        created_at: number
        owned_by: string
        type: string
        display_name?: string
      }
    >()

    const addModel = (id: string, owner?: string) => {
      if (modelMap.has(id)) return
      const metadata = getPublicModelMetadata(id)
      const resolved = resolveCloudCodeModel(id)
      const derivedOwner =
        owner ||
        metadata?.ownedBy ||
        (resolved?.family === "gpt"
          ? "openai"
          : resolved?.family === "claude"
            ? "anthropic"
            : "google")
      modelMap.set(id, {
        id,
        object: "model",
        created_at: metadata?.createdAt || now,
        owned_by: derivedOwner,
        type: "model",
        display_name: metadata?.displayName || resolved?.displayName,
      })
    }

    // 1) Dynamic models discovered from Google backend
    for (const modelId of this.googleModelCache.getAllModelIds()) {
      addModel(modelId)
    }

    // 2) Compatibility aliases we intentionally keep for existing clients
    const compatibilityModels = [
      "gemini-2.5-flash",
      "gemini-3-flash",
      "gemini-3.1-pro-high",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-3-7-sonnet-20250219",
      "claude-opus-4-6-thinking",
      "claude-4.6-opus",
      "claude-4.6-opus-thinking",
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-thinking",
      "claude-4.5-opus-high-thinking",
    ]
    for (const modelId of compatibilityModels) {
      addModel(modelId)
    }

    // 3) Codex models (if backend is available)
    if (this.codexService.isAvailable()) {
      const codexModels = getCodexPublicModelIds({
        codexModelTier: this.codexService.getModelTier(),
      })
      for (const modelId of codexModels) {
        addModel(modelId, "openai")
      }
    }

    const data = Array.from(modelMap.values()).sort((left, right) => {
      if (left.created_at !== right.created_at) {
        return right.created_at - left.created_at
      }
      return left.id.localeCompare(right.id)
    })

    return {
      data,
      has_more: false,
      first_id: data[0]?.id || "",
      last_id: data[data.length - 1]?.id || "",
    }
  }
}
