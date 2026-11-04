/// <reference types="bun-types" />

// Platform contract (#10856): a pull request outside the full matrix must not take a hosted
// macOS or Windows runner. The required matrix contexts keep their names because the leg still
// reports, but it runs on Linux with every heavy step skipped; native binary parity, which is
// not a required context, is skipped at the job level.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { load } from "js-yaml"

const workflowsDir = new URL("../.github/workflows/", import.meta.url)
const NOT_FULL_MATRIX = "needs.ci-mode.outputs.full_matrix != 'true'"
const FAST = ["self-hosted", "Linux", "X64", "af-ci-fast-v1"]
const BUILD = ["self-hosted", "Linux", "X64", "af-ci-build-v1", "backbone-ci"]

interface RunnerContext {
  event_name?: string
  repository?: string
  event?: { pull_request?: { head?: { repo?: { full_name?: string } | null } } }
}

const internalPr: RunnerContext = {
  event_name: "pull_request",
  repository: "owner/repo",
  event: { pull_request: { head: { repo: { full_name: "owner/repo" } } } },
}
const hostedContexts: readonly RunnerContext[] = [
  { ...internalPr, event: { pull_request: { head: { repo: { full_name: "fork/repo" } } } } },
  { ...internalPr, event: {} },
  { ...internalPr, event: { pull_request: {} } },
  { ...internalPr, event: { pull_request: { head: { repo: null } } } },
  { ...internalPr, repository: "" },
  { event_name: "pull_request" },
  ...["push", "merge_group", "pull_request_target", "workflow_dispatch", "", "unknown"]
    .map((event_name) => ({ ...internalPr, event_name })),
]

const routedJobs = [
  ...["lint-ratchet", "ci-mode", "block-master-pr", "typecheck", "macos-test-1-status",
    "macos-test-2-status", "macos-codex-status", "macos-senpi-status"]
    .map((name) => ({ file: "ci.yml", name, labels: FAST, os: name.startsWith("macos-") ? "macos-latest" : undefined })),
  ...["test", "codex-compatibility", "senpi-compatibility"]
    .map((name) => ({ file: "ci.yml", name, labels: BUILD, os: "ubuntu-latest" })),
  ...["build", "omo-ai-payload-check", "lazycodex-published-smoke"]
    .map((name) => ({ file: "ci.yml", name, labels: BUILD, os: undefined })),
  { file: "lint-workflows.yml", name: "actionlint", labels: FAST, os: undefined },
  { file: "changelog-gate.yml", name: "changelog-gate", labels: FAST, os: undefined },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function jobs(file: string): Record<string, unknown> {
  const parsed: unknown = load(readFileSync(new URL(file, workflowsDir), "utf8"))
  if (!isRecord(parsed) || !isRecord(parsed["jobs"])) throw new Error(`${file} must define jobs`)
  return parsed["jobs"]
}

function job(file: string, name: string): Record<string, unknown> {
  const found = jobs(file)[name]
  if (!isRecord(found)) throw new Error(`${file} must define ${name}`)
  return found
}

function toJavaScript(expression: string): string {
  // Preserve JSON labels and GitHub's escaped single quotes inside string literals.
  return expression.split(/('(?:''|[^'])*')/g).map((part, index) => index % 2
    ? JSON.stringify(part.slice(1, -1).replaceAll("''", "'"))
    : part.replace(/([!=])=/g, "$1==")
      .replaceAll("needs.ci-mode.", 'needs["ci-mode"].')
      .replace(/(?<=[\w\]])\.(?=[A-Za-z_])/g, "?.")
  ).join("")
}

function resolveRunner(expression: string, os: string | undefined, fullMatrix: string, github: RunnerContext = {}): string | string[] {
  const body = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(expression)?.[1]
  if (body === undefined) return expression
  const evaluate = new Function("matrix", "needs", "github", "fromJSON", "format", `return ${toJavaScript(body)}`)
  // Missing GitHub properties resolve to an empty string, including a deleted head repository.
  const context = {
    event_name: github.event_name ?? "",
    repository: github.repository ?? "",
    event: { pull_request: { head: { repo: { full_name: github.event?.pull_request?.head?.repo?.full_name ?? "" } } } },
  }
  const result: unknown = evaluate(
    { os }, { "ci-mode": { outputs: { full_matrix: fullMatrix } } }, context, JSON.parse,
    (template: string, ...values: unknown[]) => template.replace(/\{(\d+)\}/g, (_match, index: string) => String(values[Number(index)])),
  )
  if (typeof result !== "string" && !(Array.isArray(result) && result.every((label) => typeof label === "string"))) {
    throw new Error(`runs-on must resolve to a label or label array, got ${String(result)}`)
  }
  return result
}

describe("#given the OS matrix jobs that report required contexts", () => {
  test.each(["test", "codex-compatibility", "senpi-compatibility"])(
    "#then %s allocates a macOS or Windows runner only for the full matrix",
    (name) => {
      const runsOn = String(job("ci.yml", name)["runs-on"])
      expect(runsOn).toContain(NOT_FULL_MATRIX)
      for (const os of ["macos-latest", "windows-latest"]) {
        expect(resolveRunner(runsOn, os, "false")).toBe("ubuntu-26.04")
        expect(resolveRunner(runsOn, os, "")).toBe("ubuntu-26.04")
        expect(resolveRunner(runsOn, os, "true")).toBe(os)
        for (const fullMatrix of ["false", "", "unknown"]) {
          expect(resolveRunner(runsOn, os, fullMatrix, internalPr)).toEqual(FAST)
          for (const context of hostedContexts) {
            expect(resolveRunner(runsOn, os, fullMatrix, context)).toBe("ubuntu-26.04")
          }
        }
        for (const context of [internalPr, ...hostedContexts]) {
          expect(resolveRunner(runsOn, os, "true", context)).toBe(os)
        }
      }
      expect(resolveRunner(runsOn, "ubuntu-latest", "true")).toBe("ubuntu-26.04")
      expect(resolveRunner(runsOn, "ubuntu-latest", "false")).toBe("ubuntu-26.04")
      expect(resolveRunner(runsOn, "ubuntu-latest", "true", internalPr)).toEqual(BUILD)
      expect(resolveRunner(runsOn, "ubuntu-latest", "false", internalPr)).toEqual(BUILD)
    },
  )
})

describe("#given the approved internal-PR runner pools", () => {
  for (const { file, name, labels, os } of routedJobs) {
    test(`#when ${file}/${name} is routed #then only an internal PR uses its unique pool`, () => {
      const runsOn = String(job(file, name)["runs-on"])
      for (const fullMatrix of ["true", "false", "", "unknown"]) {
        expect(resolveRunner(runsOn, os, fullMatrix, internalPr)).toEqual(labels)
        for (const context of hostedContexts) {
          expect(resolveRunner(runsOn, os, fullMatrix, context)).toBe("ubuntu-26.04")
        }
      }
    })
  }

  test("#when pool labels overlap #then selected labels exclude the other pool and trusted/deploy runners", () => {
    const runners = [
      { id: 17, labels: ["af-ci-fast-v1", "af-ci-build-v1"] },
      { id: 19, labels: ["af-ci-fast-v1", "af-ci-build-v1"] },
      { id: 18, labels: ["af-ci-build-v1", "backbone-ci"] },
      { id: 21, labels: ["af-ci-build-v1", "backbone-ci"] },
      { id: 16, labels: ["tars-trusted-v1", "trusted"] },
      { id: 20, labels: ["artifaktory-deploy", "af-deploy-v1"] },
    ].map((runner) => ({ ...runner, labels: ["self-hosted", "Linux", "X64", ...runner.labels] }))
    for (const { file, name, labels, os } of routedJobs) {
      const selected = resolveRunner(String(job(file, name)["runs-on"]), os, "true", internalPr)
      if (!Array.isArray(selected)) throw new Error(`${file}/${name} must select a label array`)
      expect(runners.filter((runner) => selected.every((label) => runner.labels.includes(label))).map((runner) => runner.id))
        .toEqual(labels === FAST ? [17, 19] : [18, 21])
    }
  })

  test("#when native and push-only jobs are selected #then their original hosted runners remain", () => {
    expect(job("ci.yml", "macos-combined")["runs-on"]).toBe("macos-latest")
    const parity = String(job("ci.yml", "native-binary-parity")["runs-on"])
    for (const os of ["macos-15", "windows-latest"]) {
      expect(resolveRunner(parity, os, "true", internalPr)).toBe(os)
    }
    for (const name of ["auto-commit-schema", "draft-release"]) {
      expect(job("ci.yml", name)["runs-on"]).toBe("ubuntu-24.04")
    }
  })
})

describe("#given native binary parity, which has no ubuntu leg", () => {
  test("#then the whole job is skipped outside the full matrix and heavy validation", () => {
    const condition = String(job("ci.yml", "native-binary-parity")["if"])
    expect(condition).toBe(
      "needs.ci-mode.outputs.run_heavy == 'true' && needs.ci-mode.outputs.full_matrix == 'true'",
    )
  })
})

describe("#given the path-filtered workflows that also run macOS/Windows on dev pushes", () => {
  test.each(["desktop-engine.yml", "desktop-windows-qa.yml", "desktop-linux-qa.yml", "get-worker-ci.yml"])(
    "#then %s cancels a superseded PR run but lets a dev run finish and collapses pending dev runs",
    (file) => {
      const parsed: unknown = load(readFileSync(new URL(file, workflowsDir), "utf8"))
      if (!isRecord(parsed) || !isRecord(parsed["concurrency"])) throw new Error(`${file} must define concurrency`)
      const concurrency = parsed["concurrency"]
      const evaluate = (expression: unknown, github: unknown) => {
        const body = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(String(expression))?.[1]
        if (body === undefined) throw new Error(`${file} concurrency must be an expression`)
        return new Function("github", `return ${toJavaScript(body)}`)(github)
      }
      const group = (github: unknown) => String(concurrency["group"]).replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_match, body: string) => String(new Function("github", `return ${toJavaScript(body)}`)(github)))
      const pr = { workflow: "W", event_name: "pull_request", event: { pull_request: { number: 7 } }, ref: "refs/pull/7/merge", sha: "a" }
      const push = (sha: string) => ({ workflow: "W", event_name: "push", event: {}, ref: "refs/heads/dev", sha })

      expect(group(pr)).toBe("W-7")
      expect(evaluate(concurrency["cancel-in-progress"], pr)).toBe(true)
      expect(group(push("a"))).toBe(group(push("b")))
      expect(evaluate(concurrency["cancel-in-progress"], push("a"))).toBe(false)
    },
  )
})

describe("#given the label-triggered full-matrix run", () => {
  test.each(["ci:full-matrix", "run-full-ci"])("#then the %s label starts it", (label) => {
    const condition = String(job("ci-full-matrix-label.yml", "full-matrix")["if"])
    const evaluate = new Function("github", `return ${toJavaScript(condition)}`)
    expect(evaluate({ event: { label: { name: label } } })).toBe(true)
    expect(evaluate({ event: { label: { name: "bug" } } })).toBe(false)
  })
})
