import { describe, expect, test } from "bun:test"
import { AgentOverridesSchema } from "./agent-overrides"

describe("AgentOverridesSchema", () => {
  test("#given Autopilot-only fixed limits #when parsing #then unsafe explicit overrides fail while ordinary agents stay configurable", () => {
    for (const override of [{ mode: "primary" }, { model: " " }, { models: [] }, { tools: { task: true } },
      { permission: { bash: "ask" } }, { permission: { external_directory: "allow" } }, { permission: { "*": "allow" } }, { trusted: true }]) {
      expect(AgentOverridesSchema.safeParse({ autopilot: override }).success).toBe(false)
    }
    expect(AgentOverridesSchema.safeParse({ autopilot: { tools: { read: true }, permission: { read: "ask", edit: "deny" } } }).success).toBe(true)
    expect(AgentOverridesSchema.safeParse({ oracle: { mode: "primary", permission: { bash: "allow" } } }).success).toBe(true)
  })

  test("preserves custom agent keys after parsing", () => {
    const input = {
      sisyphus: { model: "anthropic/claude-opus-4-6" },
      "technical-writer": {
        model: "anthropic/claude-sonnet-4-6",
        temperature: 0.3,
        prompt_append: "You are a technical writer.",
      },
    }

    const result = AgentOverridesSchema.safeParse(input)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.sisyphus).toBeDefined()
      expect(result.data["technical-writer"]).toBeDefined()
      expect(result.data["technical-writer"]?.model).toBe("anthropic/claude-sonnet-4-6")
      expect(result.data["technical-writer"]?.temperature).toBe(0.3)
    }
  })

  test("accepts canonical reasoning on agents and per-message overrides", () => {
    // given
    const input = {
      sisyphus: {
        reasoning: "xhigh",
        ultrawork: { reasoning: "max" },
        compaction: { reasoning: "off" },
      },
    }

    // when
    const result = AgentOverridesSchema.safeParse(input)

    // then
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.sisyphus?.reasoning).toBe("xhigh")
      expect(result.data.sisyphus?.ultrawork?.reasoning).toBe("max")
      expect(result.data.sisyphus?.compaction?.reasoning).toBe("off")
    }
  })

  test("validates custom agent keys against AgentOverrideConfigSchema", () => {
    const input = {
      "custom-agent": {
        model: "provider/model",
        temperature: 5, // invalid: max is 2
      },
    }

    const result = AgentOverridesSchema.safeParse(input)

    expect(result.success).toBe(false)
  })
})
