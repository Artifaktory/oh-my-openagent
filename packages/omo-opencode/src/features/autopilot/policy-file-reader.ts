import { constants } from "node:fs"
import { lstat, open, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { sha256 } from "./protocol"
import { POLICY_LIMITS } from "./policy-schema"
import { AutopilotError, type CapturedPolicyFile } from "./types"

export interface PolicyFileScope {
  readonly directory: string
  readonly roots: readonly string[]
  readonly maxFileBytes?: number
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function validatePath(value: string): void {
  const normalized = value.replace(/\\/g, "/")
  if (value.includes("\0") || normalized.startsWith("//") || /(^|\/)\.\.(\/|$)/.test(normalized)
    || /^(?:[a-z][a-z0-9+.-]*:\/\/)/i.test(normalized)
    || /(^|\/)(?:\.env(?:\.[^/]*)?|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.config|\.npmrc|secrets?(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|auth\.json|id_rsa|id_ed25519)(\/|$)/i.test(normalized)
    || /\.(?:pem|key|p12|pfx)$/i.test(normalized)
    || normalized.replace(/^[a-z]:/i, "").includes(":")) throw new AutopilotError("source_forbidden")
}

function identity(info: NonNullable<Awaited<ReturnType<typeof stat>>>): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":")
}

export async function readPolicyFile(reference: string, scope: PolicyFileScope): Promise<CapturedPolicyFile> {
  try {
    validatePath(reference)
    const maxBytes = scope.maxFileBytes ?? POLICY_LIMITS.fileBytes
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > POLICY_LIMITS.fileBytes || !scope.roots.length) {
      throw new AutopilotError("invalid_configuration")
    }
    const candidate = path.resolve(scope.directory, reference)
    validatePath(candidate)
    if (!/\.(md|txt|json|jsonc)$/i.test(candidate)) throw new AutopilotError("source_forbidden")
    const roots = await Promise.all(scope.roots.map(root => realpath(path.resolve(scope.directory, root))))
    const canonical = await realpath(candidate)
    validatePath(canonical)
    const root = roots.find(item => contained(item, candidate) && contained(item, canonical))
    if (!root || path.relative(canonical, candidate) !== "") throw new AutopilotError("source_forbidden")
    let cursor = candidate
    while (path.relative(cursor, root) !== "") {
      if ((await lstat(cursor)).isSymbolicLink()) throw new AutopilotError("source_forbidden")
      const parent = path.dirname(cursor)
      if (parent === cursor) throw new AutopilotError("source_forbidden")
      cursor = parent
    }
    const before = await stat(canonical)
    if (!before.isFile()) throw new AutopilotError("source_forbidden")
    if (before.size > maxBytes) throw new AutopilotError("source_too_large")
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || identity(opened) !== identity(before)) throw new AutopilotError("source_changed")
      const bytes = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < bytes.length) {
        const chunk = await handle.read(bytes, length, bytes.length - length, length)
        if (!chunk.bytesRead) break
        length += chunk.bytesRead
      }
      if (length > maxBytes) throw new AutopilotError("source_too_large")
      const after = await handle.stat()
      if (identity(after) !== identity(opened) || length !== opened.size
        || await realpath(candidate) !== canonical || identity(await stat(candidate)) !== identity(opened)) {
        throw new AutopilotError("source_changed")
      }
      const captured = bytes.subarray(0, length)
      let text: string
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(captured) }
      catch { throw new AutopilotError("invalid_utf8") }
      return Object.freeze({ path: canonical, identity: identity(opened), sha256: sha256(captured), byteLength: length, text })
    } finally { await handle.close() }
  } catch (error) {
    if (error instanceof AutopilotError) throw error
    throw new AutopilotError("source_unavailable")
  }
}
