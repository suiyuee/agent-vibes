import { describe, expect, it } from "@jest/globals"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { ChatSessionManager } from "./chat-session.service"
import type { ParsedCursorRequest } from "./cursor-request-parser"

describe("ChatSessionManager multimodal initialization", () => {
  function createInitialRequest(): ParsedCursorRequest {
    return {
      conversation: [{ role: "user", content: "describe this image" }],
      newMessage: "describe this image",
      model: "claude-sonnet-4-20250514",
      thinkingLevel: 0,
      unifiedMode: "AGENT",
      isAgentic: true,
      supportedTools: [],
      useWeb: false,
      attachedImages: [{ data: "AQID", mimeType: "image/png" }],
    }
  }

  async function withTempHome(
    run: (manager: ChatSessionManager) => void | Promise<void>
  ): Promise<void> {
    const originalHome = process.env.HOME
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-vibes-chat-session-")
    )
    process.env.HOME = tempHome

    const manager = new ChatSessionManager()

    try {
      await run(manager)
    } finally {
      manager.onModuleDestroy()
      process.env.HOME = originalHome
      fs.rmSync(tempHome, { recursive: true, force: true })
    }
  }

  it("stores attached images in the initial user session history", () => {
    return withTempHome((manager) => {
      const session = manager.getOrCreateSession(
        "conv-1",
        createInitialRequest()
      )
      expect(session.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "describe this image" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "AQID",
              },
            },
          ],
        },
      ])
    })
  })

  it("does not inject synthetic tool results for still-pending tool calls", async () => {
    await withTempHome(async (manager) => {
      manager.getOrCreateSession("conv-2", createInitialRequest())
      await manager.addPendingToolCall(
        "conv-2",
        "toolu_pending",
        "run_terminal_command",
        { command: "pwd" }
      )

      manager.replaceMessages("conv-2", [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_pending",
              name: "run_terminal_command",
              input: { command: "pwd" },
            },
            {
              type: "tool_use",
              id: "toolu_broken",
              name: "read_file",
              input: { path: "README.md" },
            },
          ],
        },
      ])

      const session = manager.getSession("conv-2")
      expect(session?.messages).toEqual([
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_pending",
              name: "run_terminal_command",
              input: { command: "pwd" },
            },
            {
              type: "tool_use",
              id: "toolu_broken",
              name: "read_file",
              input: { path: "README.md" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_broken",
              content:
                "Tool execution was interrupted or result was lost due to context truncation.",
            },
          ],
        },
      ])
    })
  })
})
