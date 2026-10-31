import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@opencode-ai/sdk"
import type { CategoryConfig } from "../../config/schema"
import { applyCategoryOverride, applyOverrides, mergeAgentConfig } from "./agent-overrides"
import type { AgentOverrideConfig } from "../types"

function makeBase(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    instructions: "test prompt",
    model: "openai/gpt-5.6-sol",
    mode: "primary",
    ...overrides,
  } as AgentConfig
}

describe("applyCategoryOverride", () => {
  test("#given deferred native instructions #when applying overrides #then numeric settings compose without file materialization", () => {
    const base = makeBase({ prompt: "fixed fixture" })
    const override = { model: "provider/direct", category: "review", prompt: "file://./missing-prompt.md",
      prompt_append: "file://./missing-append.md", skills: ["unresolved"], temperature: 0.4 }
    const categories = { review: { model: "provider/category", prompt_append: "file://./missing-category.md", reasoning: "high" as const } }
    const result = applyOverrides(base, override, categories, undefined, true)
    expect(result.model).toBe("provider/direct")
    expect(result.temperature).toBe(0.4)
    expect(result.variant).toBe("high")
    expect(result.prompt).toBe(base.prompt)
    expect(result.skills).toBeUndefined()
  })

  describe("#given canonical reasoning on category", () => {
    test("lowers category reasoning to variant on the agent config", () => {
      // given
      const base = makeBase()
      const categories: Record<string, CategoryConfig> = {
        "ultrabrain": { reasoning: "xhigh" } as CategoryConfig,
      }

      // when
      const result = applyCategoryOverride(base, "ultrabrain", categories)

      // then
      expect(result.variant).toBe("xhigh")
    })

    test("reasoning takes precedence over deprecated variant", () => {
      // given
      const base = makeBase()
      const categories: Record<string, CategoryConfig> = {
        "ultrabrain": { reasoning: "high", variant: "medium" } as CategoryConfig,
      }

      // when
      const result = applyCategoryOverride(base, "ultrabrain", categories)

      // then
      expect(result.variant).toBe("high")
    })

    test("deprecated variant still applied when reasoning is absent", () => {
      // given
      const base = makeBase()
      const categories: Record<string, CategoryConfig> = {
        "ultrabrain": { variant: "medium" } as CategoryConfig,
      }

      // when
      const result = applyCategoryOverride(base, "ultrabrain", categories)

      // then
      expect(result.variant).toBe("medium")
    })
  })
})

describe("mergeAgentConfig", () => {
  describe("#given canonical reasoning on agent override", () => {
    test("lowers reasoning to variant on the merged config", () => {
      // given
      const base = makeBase()
      const override: AgentOverrideConfig = { reasoning: "high" }

      // when
      const result = mergeAgentConfig(base, override)

      // then
      expect(result.variant).toBe("high")
    })

    test("reasoning takes precedence over deprecated variant in override", () => {
      // given
      const base = makeBase()
      const override: AgentOverrideConfig = { reasoning: "high", variant: "medium" }

      // when
      const result = mergeAgentConfig(base, override)

      // then
      expect(result.variant).toBe("high")
    })

    test("deprecated variant still applied when reasoning is absent", () => {
      // given
      const base = makeBase()
      const override: AgentOverrideConfig = { variant: "medium" }

      // when
      const result = mergeAgentConfig(base, override)

      // then
      expect(result.variant).toBe("medium")
    })

    test("reasoning overrides base variant from factory defaults", () => {
      // given
      const base = makeBase({ variant: "low" })
      const override: AgentOverrideConfig = { reasoning: "high" }

      // when
      const result = mergeAgentConfig(base, override)

      // then
      expect(result.variant).toBe("high")
    })

    test("does not set variant when neither reasoning nor variant is in override", () => {
      // given
      const base = makeBase({ variant: "low" })
      const override: AgentOverrideConfig = { temperature: 0.5 }

      // when
      const result = mergeAgentConfig(base, override)

      // then
      expect(result.variant).toBe("low")
    })
  })
})

describe("applyOverrides", () => {
  describe("#given both category and agent reasoning", () => {
    test("agent reasoning takes precedence over category reasoning", () => {
      // given
      const base = makeBase()
      const categories: Record<string, CategoryConfig> = {
        "ultrabrain": { reasoning: "medium" } as CategoryConfig,
      }
      const override: AgentOverrideConfig = {
        category: "ultrabrain",
        reasoning: "high",
      }

      // when
      const result = applyOverrides(base, override, categories)

      // then
      expect(result.variant).toBe("high")
    })

    test("agent reasoning takes precedence over category variant", () => {
      // given
      const base = makeBase()
      const categories: Record<string, CategoryConfig> = {
        "ultrabrain": { variant: "medium" } as CategoryConfig,
      }
      const override: AgentOverrideConfig = {
        category: "ultrabrain",
        reasoning: "high",
      }

      // when
      const result = applyOverrides(base, override, categories)

      // then
      expect(result.variant).toBe("high")
    })

    test("category reasoning applied when agent has no reasoning or variant", () => {
      // given
      const base = makeBase()
      const categories: Record<string, CategoryConfig> = {
        "ultrabrain": { reasoning: "high" } as CategoryConfig,
      }
      const override: AgentOverrideConfig = {
        category: "ultrabrain",
        temperature: 0.3,
      }

      // when
      const result = applyOverrides(base, override, categories)

      // then
      expect(result.variant).toBe("high")
    })
  })
})
