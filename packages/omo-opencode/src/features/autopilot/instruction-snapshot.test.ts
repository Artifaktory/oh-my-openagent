import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { capturePolicySnapshot, type NativeInstructionView } from "./policy-snapshot"
import { composeInstructionSnapshot } from "./instruction-snapshot"
import { sha256 } from "./protocol"
import type { PolicySource } from "./types"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function capture(channels: readonly PolicySource["channel"][]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omo-instructions-"))
  directories.push(directory)
  const sourceText = (channel: string) => `dynamic-${channel}-${path.basename(directory)}`
  const sources = channels.map(channel => ({ id: channel, channel, kind: "inline" as const, source: `native/config/${channel}`, sha256: sha256(sourceText(channel)) }))
  const rule = { id: "rule", channel: "rule" as const, kind: "file" as const, source: "rule.md", sha256: sha256(sourceText("rule")) }
  await writeFile(path.join(directory, "rule.md"), sourceText("rule"))
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ format_version: "1", revision: "A", sources: [...sources, rule] }))
  const view: NativeInstructionView = { configurationDigest: "a".repeat(64), sources: sources.map(source => {
    const { sha256: digest, ...identity } = source
    return { ...identity, text: sourceText(source.channel) }
  }) }
  const input = { directory, roots: [directory], manifestPath: "manifest.json", enrollment: [...sources, rule], readNativeView: async () => view }
  return { snapshot: await capturePolicySnapshot(input), sourceText, input, view }
}

describe("captured native instruction composition", () => {
  test("preserves native replacement, append and skill order inside fixed wrapper and final rules", async () => {
    // given
    const f = await capture(["category_append", "prompt", "prompt_append", "skill", "caller_skill"])
    const fixed = { pluginRevision: "revision", factory: "fixed factory bytes", protocol: "fixed protocol bytes" }
    // when
    const result = composeInstructionSnapshot(f.snapshot, fixed)
    // then: these are dynamic source payloads, not assertions about authored prompt wording
    expect(result.text).toBe([fixed.factory, fixed.protocol,
      [f.sourceText("skill"), f.sourceText("caller_skill"), `${f.sourceText("prompt")}\n${f.sourceText("prompt_append")}`].join("\n\n"),
      f.sourceText("rule")].join("\n\n"))
    expect(result.manifestDigest).toBe(f.snapshot.manifestDigest)
    expect(result.configurationDigest).toBe(f.snapshot.configurationDigest)
    expect(Object.isFrozen(result)).toBe(true)
  })

  test("category append remains when no direct replacement is selected", async () => {
    // given
    const f = await capture(["category_append", "prompt_append"])
    const fixed = { pluginRevision: "revision", factory: "factory", protocol: "protocol" }
    // when / then
    expect(composeInstructionSnapshot(f.snapshot, fixed).text).toBe(
      [fixed.factory, fixed.protocol, `${f.sourceText("category_append")}\n${f.sourceText("prompt_append")}`, f.sourceText("rule")].join("\n\n"))
  })

  test("fixed bytes and composition identities bind instructions separately from publication", async () => {
    // given
    const f = await capture(["prompt"])
    const fixed = { pluginRevision: "revision", factory: "factory", protocol: "protocol" }
    const a = composeInstructionSnapshot(f.snapshot, fixed)
    // when
    const b = composeInstructionSnapshot(f.snapshot, { ...fixed, protocol: "updated protocol" })
    const c = composeInstructionSnapshot(f.snapshot, { ...fixed, pluginRevision: "next" })
    // then
    expect(b.digest).not.toBe(a.digest)
    expect(c.digest).not.toBe(a.digest)
    expect(b.manifestDigest).toBe(a.manifestDigest)
    expect(() => composeInstructionSnapshot(f.snapshot, { ...fixed, protocol: "" })).toThrow("invalid_configuration")
  })

  test("inline native edits need matching publication; previously captured instructions remain stable", async () => {
    // given
    const f = await capture(["prompt_append"])
    const fixed = { pluginRevision: "revision", factory: "factory", protocol: "protocol" }
    const before = composeInstructionSnapshot(f.snapshot, fixed)
    // when
    const changed = { ...f.view, sources: f.view.sources.map(source => ({ ...source, text: "unpublished" })) }
    // then
    await expect(capturePolicySnapshot({ ...f.input, readNativeView: async () => changed })).rejects.toThrow("policy_mismatch")
    expect(composeInstructionSnapshot(f.snapshot, fixed).digest).toBe(before.digest)
    await expect(capturePolicySnapshot({ ...f.input, readNativeView: async () => ({ ...f.view, sources: [] }) })).rejects.toThrow("source_unenrolled")
  })
})
