import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { capturePolicySnapshot, type NativeInstructionView, type PolicySnapshotInput } from "./policy-snapshot"
import { readPolicyFile } from "./policy-file-reader"
import { sha256 } from "./protocol"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omo-policy-"))
  directories.push(directory)
  const sources = ["one", "two"].map(id => ({ id, channel: "rule" as const, kind: "file" as const, source: `${id}.md`, sha256: sha256(id) }))
  await Promise.all(sources.map(source => writeFile(path.join(directory, source.source), source.id)))
  const manifest = { format_version: "1", revision: "A", sources }
  const publish = async () => {
    await writeFile(path.join(directory, "next.json"), JSON.stringify(manifest))
    await rename(path.join(directory, "next.json"), path.join(directory, "manifest.json"))
  }
  await publish()
  const view: NativeInstructionView = { configurationDigest: "a".repeat(64), sources: [] }
  const input: PolicySnapshotInput = { directory, roots: [directory], manifestPath: "manifest.json", enrollment: sources, readNativeView: async () => view }
  return { directory, manifest, input, view, publish }
}

describe("policy snapshot exact-byte publication", () => {
  test("unpublished edit fails; published edit and new-publication revert preserve in-flight bytes", async () => {
    // given
    const f = await fixture()
    const a = await capturePolicySnapshot(f.input)
    // when
    await writeFile(path.join(f.directory, "one.md"), "changed")
    await expect(capturePolicySnapshot(f.input)).rejects.toThrow("policy_mismatch")
    f.manifest.sources[0].sha256 = sha256("changed")
    f.manifest.revision = "B"
    await f.publish()
    const b = await capturePolicySnapshot(f.input)
    await writeFile(path.join(f.directory, "one.md"), "one")
    f.manifest.sources[0].sha256 = sha256("one")
    f.manifest.revision = "revert-A"
    await f.publish()
    const reverted = await capturePolicySnapshot(f.input)
    // then
    expect(a.sources[0].text).toBe("one")
    expect(b.sources[0].text).toBe("changed")
    expect(reverted.policyDigest).toBe(a.policyDigest)
    expect(reverted.manifestDigest).not.toBe(a.manifestDigest)
    expect(b.policyDigest).not.toBe(a.policyDigest)
    expect(Object.isFrozen(a.sources[0].descriptor)).toBe(true)
  })

  test("ordered rule identities change when their composition order changes", async () => {
    // given
    const f = await fixture()
    const a = await capturePolicySnapshot(f.input)
    // when
    f.manifest.sources.reverse()
    await f.publish()
    // then
    expect((await capturePolicySnapshot(f.input)).policyDigest).not.toBe(a.policyDigest)
  })

  test("rejects native unenrolled references before attempting any policy file read", async () => {
    // given
    const f = await fixture()
    // when / then: missing manifest would produce a different failure if preflight read first
    await expect(capturePolicySnapshot({ ...f.input, manifestPath: "missing.json", readNativeView: async () => ({ ...f.view,
      sources: [{ id: "prompt", channel: "prompt", kind: "file", source: "never-read.md" }] }) })).rejects.toThrow("source_unenrolled")
  })

  for (const change of ["file", "manifest", "native", "replacement", "removal"] as const) {
    test(`rejects ${change} mutation at the native confirmation boundary`, async () => {
      // given
      const f = await fixture()
      let reads = 0
      // when: the runtime configuration read is a deterministic publication barrier
      const readNativeView = async () => {
        if (++reads === 2) {
          if (change === "file") await writeFile(path.join(f.directory, "one.md"), "new")
          if (change === "manifest") { f.manifest.revision = "B"; await f.publish() }
          if (change === "native") return { ...f.view, configurationDigest: "b".repeat(64) }
          if (change === "replacement") {
            await writeFile(path.join(f.directory, "replacement.md"), "one")
            await rename(path.join(f.directory, "replacement.md"), path.join(f.directory, "one.md"))
          }
          if (change === "removal") await rm(path.join(f.directory, "one.md"))
        }
        return f.view
      }
      // then
      await expect(capturePolicySnapshot({ ...f.input, readNativeView })).rejects.toThrow(change === "removal" ? "source_unavailable" : "source_changed")
    })
  }

  test("rejects removal, invalid UTF8, malformed manifest, conflicts and unknown authority fields", async () => {
    // given
    const f = await fixture()
    // when / then
    await rm(path.join(f.directory, "one.md"))
    await expect(capturePolicySnapshot(f.input)).rejects.toThrow("source_unavailable")
    await writeFile(path.join(f.directory, "one.md"), Buffer.from([0xff]))
    await expect(capturePolicySnapshot(f.input)).rejects.toThrow("invalid_utf8")
    await writeFile(path.join(f.directory, "manifest.json"), "{")
    await expect(capturePolicySnapshot(f.input)).rejects.toThrow("invalid_manifest")
    await writeFile(path.join(f.directory, "manifest.json"), JSON.stringify({ ...f.manifest, permission: { bash: true } }))
    await expect(capturePolicySnapshot(f.input)).rejects.toThrow("invalid_manifest")
    f.manifest.sources.push(f.manifest.sources[0])
    await f.publish()
    await expect(capturePolicySnapshot(f.input)).rejects.toThrow("invalid_manifest")
  })

  test("bounds actual bytes, total transaction size and source count", async () => {
    // given
    const f = await fixture()
    // when / then
    await expect(capturePolicySnapshot({ ...f.input, maxSources: 1 })).rejects.toThrow("invalid_manifest")
    await expect(capturePolicySnapshot({ ...f.input, maxTotalBytes: 1 })).rejects.toThrow("source_too_large")
    await writeFile(path.join(f.directory, "one.md"), "x".repeat(65537))
    await expect(capturePolicySnapshot(f.input)).rejects.toThrow("source_too_large")
  })

  test("native capture failures expose a bounded code without the provider's contents", async () => {
    // given
    const f = await fixture()
    // when / then
    await expect(capturePolicySnapshot({ ...f.input, readNativeView: async () => { throw new Error("sensitive fixture detail") } }))
      .rejects.toThrow(/^invalid_configuration$/)
  })

  test("rejects traversal, remote, credentials, unsupported types, roots and junction escapes", async () => {
    // given
    const f = await fixture()
    const outside = await fixture()
    const forbidden = ["../one.md", "https://example.invalid/rule.md", ".env", "auth.json", "key.pem", "one.exe", "one.md:stream"]
    // when / then
    for (const reference of forbidden) await expect(readPolicyFile(reference, f.input)).rejects.toThrow("source_forbidden")
    await expect(readPolicyFile(path.join(outside.directory, "one.md"), f.input)).rejects.toThrow("source_forbidden")
    await symlink(outside.directory, path.join(f.directory, "linked"), process.platform === "win32" ? "junction" : "dir")
    await expect(readPolicyFile("linked/one.md", f.input)).rejects.toThrow("source_forbidden")
    await mkdir(path.join(f.directory, "directory.md"))
    await expect(readPolicyFile("directory.md", f.input)).rejects.toThrow("source_forbidden")
  })
})
