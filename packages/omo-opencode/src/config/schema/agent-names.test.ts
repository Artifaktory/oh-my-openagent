/// <reference path="../../../../../bun-test.d.ts" />

import { describe, expect, test } from "bun:test"
import { OhMyOpenCodeConfigSchema } from "./oh-my-opencode-config"
import { BuiltinAgentNameSchema, OverridableAgentNameSchema } from "./agent-names"

describe("OhMyOpenCodeConfigSchema disabled_skills", () => {
  test("#given canonical Autopilot #when configured and disabled #then both native name schemas preserve the key", () => {
    expect(BuiltinAgentNameSchema.parse("autopilot")).toBe("autopilot")
    expect(OverridableAgentNameSchema.parse("autopilot")).toBe("autopilot")
    const config = OhMyOpenCodeConfigSchema.parse({ agents: { autopilot: { model: "provider/model" } }, disabled_agents: ["autopilot"] })
    expect(config.agents?.autopilot?.model).toBe("provider/model")
    expect(config.disabled_agents).toEqual(["autopilot"])
  })

  test("accepts review-work, runtime security skills", () => {
    // given
    const config = {
      disabled_skills: [
        "review-work",
        "remove-ai-slops",
        "init-deep",
        "security-research",
        "security-review",
        "debugging",
        "visual-qa",
      ],
    }

    // when
    const result = OhMyOpenCodeConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.disabled_skills).toEqual([
        "review-work",
        "remove-ai-slops",
        "init-deep",
        "security-research",
        "security-review",
        "debugging",
        "visual-qa",
      ])
    }
  })
})
