import { expect, spyOn, test } from "bun:test"
import { isSessionComplete } from "../../tools/delegate-task/sync-session-turns"
import { createAutopilotMessageID } from "./native-message-id"

test("#given native counter one in the same millisecond #when prompt IDs are supplied #then fresh replies complete and stale replies do not", () => {
  const clock = spyOn(Date, "now").mockReturnValue(1793393488419)
  try {
    const prompts = Array.from({ length: 32 }, () => createAutopilotMessageID())
    const assistant = { info: { id: "msg_18e94f223001HAKWZaTSc1mwIB", role: "assistant", finish: "stop" } }
    expect(new Set(prompts).size).toBe(prompts.length)
    for (const id of prompts) {
      expect(isSessionComplete([{ info: { id, role: "user" } }, assistant])).toBe(true)
    }

    clock.mockReturnValue(1793393488420)
    const nextPrompt = { info: { id: createAutopilotMessageID(), role: "user" } }
    expect(isSessionComplete([assistant, nextPrompt])).toBe(false)
    const nextAssistant = { info: { id: "msg_18e94f22400100000000000000", role: "assistant", finish: "stop" } }
    expect(isSessionComplete([nextPrompt, nextAssistant])).toBe(true)
  } finally {
    clock.mockRestore()
  }
})
