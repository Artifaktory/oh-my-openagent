import type { ChildProcess } from "node:child_process"
import { object } from "./autopilot-evidence"

const codes = new Set(["unowned_child", "child_reuse", "request_cancelled", "request_expired"])
const reference = /^err_[0-9a-f]{8}$/
const lineLimit = 16384, requestByteLimit = 262144, recordLimit = 64, seenLimit = 4096
type RecordMetadata = { ref: string; code?: string }
type Capture = { childID: string; invalid: boolean; bytes: number; count: number;
  records: Map<string, RecordMetadata>; notify: () => void }

export function explicitDenialCode(value: unknown): string | undefined {
  const error = object(value), data = object(error.data)
  if (error.name !== "AutopilotError") return undefined
  const messages = [error.message, data.message].filter(value => value !== undefined)
  return messages.length === 1 && typeof messages[0] === "string" && codes.has(messages[0]) ? messages[0] : undefined
}

export function maskedDenialReference(value: unknown): string | undefined {
  const error = object(value), data = object(error.data)
  return error.name === "UnknownError" && typeof data.ref === "string" && reference.test(data.ref)
    && data.message === "Unexpected server error. Check server logs for details."
    && error.ref === undefined ? data.ref : undefined
}

function parseRecord(line: string): RecordMetadata | undefined {
  if (/[\r\n]/.test(line)) return undefined
  const fields = new Map<string, string>()
  let pos = 0
  while (pos < line.length) {
    if (fields.size >= 96) return undefined
    if (pos > 0) {
      if (line[pos] !== " ") return undefined
      while (line[pos] === " ") pos++
      if (pos === line.length) return undefined
    }
    const match = /^[A-Za-z_][A-Za-z0-9_.-]*=/.exec(line.slice(pos))
    if (!match) return undefined
    const key = match[0].slice(0, -1)
    if (fields.has(key)) return undefined
    pos += match[0].length
    let value: string
    if (line[pos] === '"') {
      const start = pos++
      let escaped = false, closed = false
      while (pos < line.length) {
        const char = line[pos++]
        if (escaped) { escaped = false; continue }
        if (char === "\\") { escaped = true; continue }
        if (char === '"') { closed = true; break }
      }
      if (!closed) return undefined
      try {
        const parsed: unknown = JSON.parse(line.slice(start, pos))
        if (typeof parsed !== "string") return undefined
        value = parsed
      } catch { return undefined }
    } else {
      const start = pos
      while (pos < line.length && line[pos] !== " ") pos++
      value = line.slice(start, pos)
      if (!value || /[="\\\s]/.test(value)) return undefined
    }
    fields.set(key, value)
  }
  const ref = fields.get("ref")
  if (!ref || !reference.test(ref)) return undefined
  const header = fields.get("error")?.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/, 1)[0]
  const match = header && /^AutopilotError: ([a-z_]+)$/.exec(header)
  const code = match && codes.has(match[1]) && fields.get("level") === "ERROR" && fields.get("message") === "failed" ? match[1] : undefined
  return { ref, code }
}

export class NativeDenialObserver {
  private pending = Buffer.alloc(0)
  private dropping = false
  private closed = false
  private exhausted = false
  private readonly seen = new Set<string>()
  private readonly captures = new Set<Capture>()
  constructor(private readonly child: ChildProcess) {
    if (!child.stderr) { this.closed = true; return }
    child.stderr.on("data", this.onData)
    child.stderr.once("end", this.dispose); child.stderr.once("close", this.dispose); child.stderr.once("error", this.dispose)
    child.once("exit", this.dispose)
  }
  private invalidate() { for (const capture of this.captures) capture.invalid = true }
  private record(bytes: Buffer) {
    let meta: RecordMetadata | undefined
    try { meta = parseRecord(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
    catch { meta = undefined }
    if (!meta) { this.invalidate(); return }
    const reused = this.seen.has(meta.ref)
    if (this.seen.size >= seenLimit) { this.exhausted = true; this.invalidate(); return }
    this.seen.add(meta.ref)
    for (const capture of this.captures) {
      if (++capture.count > recordLimit || reused) capture.invalid = true
      if (!capture.invalid) capture.records.set(meta.ref, meta)
    }
  }
  private readonly onData = (chunk: Buffer | string) => {
    if (this.closed) return
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    for (const capture of this.captures) {
      capture.bytes += bytes.byteLength
      if (capture.bytes > requestByteLimit) capture.invalid = true
    }
    let offset = 0
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline
      if (!this.dropping && this.pending.length + end - offset > lineLimit) {
        this.dropping = true; this.pending = Buffer.alloc(0); this.invalidate()
      }
      if (!this.dropping) this.pending = Buffer.concat([this.pending, bytes.subarray(offset, end)])
      if (newline < 0) break
      if (!this.dropping) this.record(this.pending)
      this.pending = Buffer.alloc(0); this.dropping = false; offset = newline + 1
    }
    for (const capture of this.captures) capture.notify()
  }
  begin(childID: string, signal: AbortSignal) {
    const overlap = this.captures.size > 0
    if (overlap) this.invalidate()
    const capture: Capture = { childID, invalid: overlap || this.closed || this.exhausted || this.dropping || this.pending.length > 0,
      bytes: 0, count: 0, records: new Map(), notify: () => undefined }
    this.captures.add(capture)
    const abort = () => { capture.invalid = true; capture.notify() }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    return {
      wait: (ref: string): Promise<string | undefined> => new Promise(resolve => {
        capture.notify = () => {
          if (capture.invalid || this.closed || signal.aborted) resolve(undefined)
          else if (!this.pending.length && capture.records.has(ref)) resolve(capture.records.get(ref)?.code)
        }
        capture.notify()
      }),
      metadata: () => ({ child_session_id: childID, bytes: capture.bytes, complete_records: capture.count,
        valid: !capture.invalid && !this.pending.length && !this.closed && !signal.aborted }),
      finish: () => {
        capture.invalid = true; capture.notify(); capture.notify = () => undefined; capture.records.clear()
        signal.removeEventListener("abort", abort); this.captures.delete(capture)
      },
    }
  }
  readonly dispose = () => {
    this.closed = true; this.invalidate(); this.pending = Buffer.alloc(0)
    for (const capture of this.captures) capture.notify()
    this.child.stderr?.off("data", this.onData)
    this.child.stderr?.off("end", this.dispose); this.child.stderr?.off("close", this.dispose); this.child.stderr?.off("error", this.dispose)
    this.child.off?.("exit", this.dispose)
    this.seen.clear()
  }
}
