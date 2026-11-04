import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { z } from "zod"

// Host-preparation security contract: execute the workflow's real shell control flow
// with command-boundary probes. No product tests, namespaces or host writes run here.
const workflow = z.object({
  jobs: z.object({
    test: z.object({
      steps: z.array(z.object({
        id: z.string().optional(),
        run: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
      })),
    }),
  }),
}).parse(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")))

function linuxShard() {
  const step = workflow.jobs.test.steps.find((entry) => entry.id === "root-tests-posix-1")
  if (step?.run === undefined) throw new Error("missing Linux root shard 1 command")
  return { ...step, run: step.run }
}

const probes = `
function [() {
  if [[ "$#" == 3 && "$1" == "-e" && "$2" == "/proc/sys/kernel/apparmor_restrict_unprivileged_userns" ]]; then
    return "$APPARMOR_PATH_STATUS"
  fi
  builtin [ "$@"
}
bun() { printf 'bun:%s\\n' "$*"; }
sudo() {
  printf 'sudo:%s\\n' "$*"
  [[ "$*" == "sysctl -w kernel.apparmor_restrict_unprivileged_userns=0" ]]
}
sysctl() { printf 'unexpected direct sysctl\\n' >&2; return 92; }
unshare() {
  printf 'unshare:%s\\n' "$*" >&2
  if [[ "$*" == *"-- env CI=1 bun test --timeout 20000 packages/memory-core" ]]; then
    printf 'memory-suite\\n'
    return 0
  fi
  printf '%s\\n' "$NAMESPACE_PROCESSES"
  return "$NAMESPACE_EXIT"
}
`

function runLinux(environment: string, pathExists: boolean, processes = 8, namespaceExit = 0) {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `${probes}\n${linuxShard().run}`], {
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      BASH_ENV: "",
      RUNNER_OS: "Linux",
      OMO_CI_RUNNER_ENVIRONMENT: environment,
      APPARMOR_PATH_STATUS: pathExists ? "0" : "1",
      NAMESPACE_PROCESSES: String(processes),
      NAMESPACE_EXIT: String(namespaceExit),
    },
  })
  if (result.error !== undefined) throw result.error
  return result
}

describe("#given Linux root shard 1 on hosted or shared runners", () => {
  test("#when runner context is bound #then the step receives runner.environment", () => {
    expect(linuxShard().env?.OMO_CI_RUNNER_ENVIRONMENT).toBe("${{ runner.environment }}")
  })

  for (const environment of ["github-hosted", "self-hosted", "", "unknown", "github-hosted ", "GITHUB-HOSTED"]) {
    for (const pathExists of [true, false]) {
      test(`#when environment=${JSON.stringify(environment)} and sysctl path=${pathExists} #then only hosted may prepare AppArmor and every runner probes isolation`, () => {
        const result = runLinux(environment, pathExists)
        expect(result.status).toBe(0)
        expect(result.stdout.split("\n").filter((line) => line.startsWith("sudo:"))).toEqual(
          environment === "github-hosted" && pathExists
            ? ["sudo:sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"]
            : [],
        )
        expect(result.stdout).toContain("bun:test --timeout 20000 packages/omo-opencode\n")
        expect(result.stderr).toContain('unshare:-Upf --mount-proc --map-current-user -- sh -c ls /proc | grep -c "^[0-9]"\n')
        expect(result.stderr).toContain("unshare:-Upf --mount-proc --map-current-user -- env CI=1 bun test --timeout 20000 packages/memory-core\n")
        expect(result.stdout).toContain("memory-suite\n")
      })
    }
  }

  test.each(["github-hosted", "self-hosted", "", "unknown"])(
    "#when the namespace probe fails on %s #then memory-core cannot run against the host table",
    (environment) => {
      const result = runLinux(environment, true, 0, 42)
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("::error::cannot create an unprivileged PID namespace")
      expect(result.stdout).not.toContain("memory-suite")
    },
  )

  test.each(["github-hosted", "self-hosted", "", "unknown"])(
    "#when the namespace sees nine processes on %s #then the original eight-process limit fails closed",
    (environment) => {
      const result = runLinux(environment, true, 9)
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("::error::the PID namespace sees 9 processes")
      expect(result.stdout).not.toContain("memory-suite")
    },
  )
})
