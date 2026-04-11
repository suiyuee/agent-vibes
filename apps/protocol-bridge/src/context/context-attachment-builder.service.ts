import { Injectable } from "@nestjs/common"
import type {
  ContextProjectionAttachment,
  InvestigationMemorySummaryLike,
} from "./types"
import { TokenCounterService } from "./token-counter.service"

export interface SessionTodoAttachmentLike {
  content: string
  status: string
}

// Re-export for convenient import by downstream consumers.
export type { InvestigationMemorySummaryLike } from "./types"

export interface ContextAttachmentSnapshot {
  readPaths: string[]
  fileStates: Array<{
    path: string
    beforeContent: string
    afterContent: string
  }>
  todos: SessionTodoAttachmentLike[]
  investigationSummaries?: InvestigationMemorySummaryLike[]
  activeSubAgent?: {
    subagentId: string
    model: string
    turnCount: number
    toolCallCount: number
    modifiedFiles: string[]
    pendingToolCallIds: string[]
  }
}

@Injectable()
export class ContextAttachmentBuilderService {
  private readonly TOTAL_ATTACHMENT_BUDGET = 2200
  private readonly MAX_ATTACHMENT_TOKENS = 700
  private readonly INVESTIGATION_MEMORY_MAX_ATTACHMENT_TOKENS = 1500
  private readonly INVESTIGATION_MEMORY_MAX_ITEMS = 6
  private readonly INVESTIGATION_MEMORY_MAX_DETAIL_TOKENS = 420

  constructor(private readonly tokenCounter: TokenCounterService) {}

  buildAttachments(
    snapshot: ContextAttachmentSnapshot,
    options?: { maxTokens?: number }
  ): ContextProjectionAttachment[] {
    const budget = Math.max(
      options?.maxTokens || this.TOTAL_ATTACHMENT_BUDGET,
      0
    )
    if (budget <= 0) return []

    // Attachment priority: investigation memory is placed first because it
    // captures distilled evidence from the current agent turn.  When the total
    // attachment budget is tight, earlier candidates consume budget first and
    // later ones are dropped — so ordering encodes importance.
    const candidates: Array<ContextProjectionAttachment | null> = [
      this.buildInvestigationMemoryAttachment(snapshot),
      this.buildSubAgentAttachment(snapshot),
      this.buildTodosAttachment(snapshot),
      this.buildFileStatesAttachment(snapshot),
      this.buildReadPathsAttachment(snapshot),
    ]

    const attachments: ContextProjectionAttachment[] = []
    let consumed = 0

    for (const candidate of candidates) {
      if (!candidate) continue
      if (candidate.tokenCount <= 0) continue
      if (consumed + candidate.tokenCount > budget) continue
      attachments.push(candidate)
      consumed += candidate.tokenCount
    }

    return attachments
  }

  // Investigation memory is rendered as a stable attachment instead of being
  // appended to the live system prompt, so backends like Codex can treat it as
  // part of the projected context/fingerprint path rather than a per-turn hack.
  //
  // Budget-aware construction: items are evaluated newest-first so that when
  // the token budget is tight, older (less relevant) items are dropped while
  // the most recent evidence and the footer instruction are always preserved.
  private buildInvestigationMemoryAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    const summaries = snapshot.investigationSummaries || []
    if (summaries.length === 0) return null

    const footer =
      "Prefer synthesizing from this collected evidence instead of repeating equivalent investigative tool calls."

    // Reserve tokens for the footer so it is never truncated.  The header
    // line is added by buildAttachment and accounted for when that method
    // trims body to maxTokens, so we do not reserve it here to avoid
    // double-counting.
    const reservedTokens = this.tokenCounter.countText(footer) + 2 // separators
    const itemBudget = Math.max(
      0,
      this.INVESTIGATION_MEMORY_MAX_ATTACHMENT_TOKENS - reservedTokens
    )

    // Evaluate from newest to oldest so the most recent evidence survives
    // budget constraints.  We collect in reverse, then flip for display.
    const recent = summaries.slice(-this.INVESTIGATION_MEMORY_MAX_ITEMS)
    const selected: string[] = []
    let consumedTokens = 0

    for (let i = recent.length - 1; i >= 0; i--) {
      const summary = recent[i]!
      const detailText = this.trimToBudget(
        summary.details?.trim() || "",
        this.INVESTIGATION_MEMORY_MAX_DETAIL_TOKENS
      )
      // Use a temporary marker; real numbering is assigned after reversal.
      const itemText = detailText
        ? `- ${summary.label}\n${detailText}`
        : `- ${summary.label}`
      const itemTokens = this.tokenCounter.countText(itemText)
      if (consumedTokens + itemTokens > itemBudget) break
      selected.push(itemText)
      consumedTokens += itemTokens
    }

    if (selected.length === 0) return null

    // Restore chronological order and assign stable numbering.
    selected.reverse()
    const numberedLines = selected
      .map((line, index) => line.replace(/^- /, `${index + 1}. `))
      .join("\n\n")

    return this.buildAttachment(
      "investigation_memory",
      "Investigation Memory",
      [numberedLines, footer].filter(Boolean).join("\n\n"),
      this.INVESTIGATION_MEMORY_MAX_ATTACHMENT_TOKENS
    )
  }

  private buildReadPathsAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.readPaths.length === 0) return null

    const lines = snapshot.readPaths
      .slice(-20)
      .map((path) => `- ${path}`)
      .join("\n")

    return this.buildAttachment("read_paths", "Recently Read Files", lines)
  }

  private buildSubAgentAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    const subAgent = snapshot.activeSubAgent
    if (!subAgent) return null

    const lines = [
      `- Active sub-agent: ${subAgent.subagentId}`,
      `- Model: ${subAgent.model}`,
      `- Completed turns: ${subAgent.turnCount}`,
      `- Tool calls: ${subAgent.toolCallCount}`,
    ]

    if (subAgent.pendingToolCallIds.length > 0) {
      lines.push(
        `- Waiting on tools: ${subAgent.pendingToolCallIds.join(", ")}`
      )
    }
    if (subAgent.modifiedFiles.length > 0) {
      lines.push(
        ...subAgent.modifiedFiles
          .slice(-10)
          .map((filePath) => `- Modified file: ${filePath}`)
      )
    }

    return this.buildAttachment(
      "sub_agent",
      "Active Sub-Agent",
      lines.join("\n")
    )
  }

  private buildFileStatesAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.fileStates.length === 0) return null

    const lines = snapshot.fileStates
      .slice(-10)
      .map((state) => {
        const beforeLines = state.beforeContent.split("\n").length
        const afterLines = state.afterContent.split("\n").length
        const delta = afterLines - beforeLines
        const changeLabel =
          delta === 0 ? "0 lines" : `${delta > 0 ? "+" : ""}${delta} lines`
        return `- ${state.path} (${changeLabel})`
      })
      .join("\n")

    return this.buildAttachment("file_states", "Tracked File Changes", lines)
  }

  private buildTodosAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.todos.length === 0) return null

    const lines = snapshot.todos
      .slice(-20)
      .map((todo) => `- [${todo.status}] ${todo.content}`)
      .join("\n")

    return this.buildAttachment("todos", "Todo State", lines)
  }

  private buildAttachment(
    kind: ContextProjectionAttachment["kind"],
    label: string,
    body: string,
    maxTokens?: number
  ): ContextProjectionAttachment {
    const budget = maxTokens ?? this.MAX_ATTACHMENT_TOKENS
    const header = `[Context attachment: ${label}]`
    const content = `${header}\n${this.trimToBudget(body, budget)}`
    return {
      kind,
      label,
      content,
      tokenCount: this.tokenCounter.countText(content),
    }
  }

  private trimToBudget(text: string, maxTokens: number): string {
    const value = text.trim()
    if (!value) return value

    if (this.tokenCounter.countText(value) <= maxTokens) {
      return value
    }

    let end = value.length
    while (end > 64) {
      end = Math.floor(end * 0.8)
      const candidate = `${value.slice(0, end).trim()}\n...[truncated]`
      if (this.tokenCounter.countText(candidate) <= maxTokens) {
        return candidate
      }
    }

    return "...[truncated]"
  }
}
