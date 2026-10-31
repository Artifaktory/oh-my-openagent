import { randomBytes } from "node:crypto"

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** Native ascending IDs increment their counter before use; reserve zero for the supplied prompt. */
export function createAutopilotMessageID(): string {
  const timestamp = BigInt(Date.now()) * 0x1000n
  const prefix = Buffer.alloc(6)
  for (let index = 0; index < prefix.length; index++) {
    prefix[index] = Number((timestamp >> BigInt(40 - 8 * index)) & 0xffn)
  }
  const suffix = Array.from(randomBytes(14), byte => BASE62[byte % BASE62.length]).join("")
  return `msg_${prefix.toString("hex")}${suffix}`
}
