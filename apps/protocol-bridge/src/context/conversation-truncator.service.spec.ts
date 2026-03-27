import { describe, expect, it } from "@jest/globals"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { ConversationTruncatorService } from "./conversation-truncator.service"
import { SummaryCacheService } from "./summary-cache.service"
import { SummaryGeneratorService } from "./summary-generator.service"
import { TokenCounterService } from "./token-counter.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import type { UnifiedMessage } from "./types"

type ConversationTruncatorHarness = ConversationTruncatorService & {
  trimOldestMessagesToFit(
    messages: UnifiedMessage[],
    maxTokens: number,
    options?: { pendingToolUseIds?: Iterable<string> }
  ): {
    messages: UnifiedMessage[]
    tokenCount: number
    originalTokenCount: number
  }
}

describe("ConversationTruncatorService hard fit", () => {
  it("re-trims after synthetic tool-result repair grows the payload", () => {
    const originalHome = process.env.HOME
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-vibes-conversation-truncator-")
    )
    process.env.HOME = tempHome

    const tokenCounter = new TokenCounterService()
    tokenCounter.onModuleInit()

    const toolIntegrity = new ToolIntegrityService(tokenCounter)
    const summaryCache = new SummaryCacheService(tokenCounter)
    summaryCache.onModuleInit()
    const summaryGenerator = new SummaryGeneratorService(tokenCounter)
    const truncator = new ConversationTruncatorService(
      tokenCounter,
      toolIntegrity,
      summaryCache,
      summaryGenerator
    ) as ConversationTruncatorHarness

    try {
      const orphanToolUse: UnifiedMessage = {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_orphan",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
      }

      const repaired = toolIntegrity.sanitizeMessages([orphanToolUse])
      const toolOnlyTokens = tokenCounter.countMessages([orphanToolUse])
      const repairedTokens = tokenCounter.countMessages(repaired.messages)

      expect(repaired.removedOrphanToolUses).toBe(1)
      expect(repairedTokens).toBeGreaterThan(toolOnlyTokens)

      const oversizedHistory: UnifiedMessage[] = [
        { role: "user", content: "x".repeat(1200) },
        orphanToolUse,
      ]

      const budget = toolOnlyTokens + 1
      const fitted = truncator.trimOldestMessagesToFit(oversizedHistory, budget)

      expect(fitted.originalTokenCount).toBeGreaterThan(budget)
      expect(fitted.tokenCount).toBeLessThanOrEqual(budget)
      expect(tokenCounter.countMessages(fitted.messages)).toBeLessThanOrEqual(
        budget
      )
    } finally {
      summaryCache.onModuleDestroy()
      process.env.HOME = originalHome
      fs.rmSync(tempHome, { recursive: true, force: true })
    }
  })
})
