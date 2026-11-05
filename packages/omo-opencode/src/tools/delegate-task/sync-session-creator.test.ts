import { describe, expect, test } from "bun:test"

import { createSyncSession } from "./sync-session-creator"
import { createSyncAdmission } from "./sync-admission"

describe("createSyncSession", () => {
  test("#given paused parent lookup #when cancelled #then native create is fenced after lookup", async () => {
    const parent = Promise.withResolvers<{ data: { directory: string } }>()
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    const control = createSyncAdmission({ invocationId: "creator", waiterId: "creator", signal: controller.signal, deadline: Date.now() + 5000 })
    let creates = 0
    const client = { session: {
      get: async (input: { signal: AbortSignal }) => { expect(input.signal).toBe(control.signal); entered.resolve(); return parent.promise },
      create: async () => { creates++; return { data: { id: "late" } } },
    } }
    const result = createSyncSession(client as never, { parentSessionID: "parent", agentToUse: "autopilot",
      description: "controlled", defaultDirectory: "/fallback", control })
    await entered.promise; controller.abort(); parent.resolve({ data: { directory: "/parent" } })
    await expect(result).rejects.toThrow("sync_admission_cancelled")
    expect(creates).toBe(0); control.dispose()
  })

  test("#given cancellation immediately before create #when control checks #then no wire create is sent", async () => {
    let checks = 0, creates = 0
    const client = { session: { get: async () => ({ data: { directory: "/parent" } }),
      create: async () => { creates++; return { data: { id: "late" } } } } }
    await expect(createSyncSession(client as never, { parentSessionID: "parent", agentToUse: "autopilot",
      description: "controlled", defaultDirectory: "/fallback", control: { signal: new AbortController().signal,
        remaining: () => 5000, check: () => { if (++checks === 3) throw Error("cancelled-before-create") } } })).rejects.toThrow("cancelled-before-create")
    expect(creates).toBe(0)
  })
  test("creates child session with question permission denied", async () => {
    // given
    const createCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          return { data: { id: "ses_child" } }
        },
      },
    }

    // when
    const result = await createSyncSession(client as never, {
      parentSessionID: "ses_parent",
      agentToUse: "explore",
      description: "test task",
      defaultDirectory: "/fallback",
    })

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_child", parentDirectory: "/parent" })
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.body).toEqual({
      parentID: "ses_parent",
      title: "test task (@explore subagent)",
      permission: [
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
  })

  test("prefixes the category in the child session title", async () => {
    // given
    const createCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          return { data: { id: "ses_child" } }
        },
      },
    }
    const input = {
      parentSessionID: "ses_parent",
      agentToUse: "explore",
      description: "test task",
      defaultDirectory: "/fallback",
      category: "quick",
    }

    // when
    await createSyncSession(client as never, input)

    // then
    const body = createCalls[0]?.body as Record<string, unknown> | undefined
    expect(body?.title).toBe("[quick] test task (@explore subagent)")
  })
})
