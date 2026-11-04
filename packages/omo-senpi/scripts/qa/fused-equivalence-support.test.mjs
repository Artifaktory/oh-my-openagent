import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import {
	E23_FINAL_REPLY_BARRIER,
	driveMemoryTurn,
	dropTimestampOffsets,
	pinEnginePackage,
	splitStatusChannels,
	statusCounts,
	stopSandboxProcesses,
} from "./fused-equivalence-support.mjs";

const status = (key, text) => ({ type: "extension_ui_request", method: "setStatus", statusKey: key, statusText: text });
const turnEvent = (type) => ({ type });

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function bounded(promise, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`E23 fixture: timed out waiting for ${label}`)), 2_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function memoryTurnFixture({ buffered = [], onPrompt, onRelease } = {}) {
	const client = { events: [], eventWaiters: [] };
	const expirations = new Map();
	const promptSent = deferred();
	const response = deferred();
	const finalReply = deferred();
	const releasedBarriers = [];
	const control = new MessageChannel();
	const emitted = [];
	let promptFrames;
	let closedFrames;
	let closed = false;
	let disposed = false;
	const disposedError = new Error("E23 fixture disposed");
	const remove = (waiter) => {
		clearTimeout(waiter.timer);
		expirations.delete(waiter);
		const index = client.eventWaiters.indexOf(waiter);
		if (index !== -1) client.eventWaiters.splice(index, 1);
	};
	const emit = (event) => {
		emitted.push(event);
		if (closed) return;
		client.events.push(event);
		for (const waiter of [...client.eventWaiters]) {
			if (!waiter.pred(event)) continue;
			remove(waiter);
			waiter.resolve(event);
		}
	};
	// Match the pinned RpcClient's buffered lookup and waiter shape; close never cancels these waiters.
	client.waitForEvent = (pred, { timeoutMs = 60_000 } = {}) => {
		if (disposed) return Promise.reject(disposedError);
		const found = client.events.find(pred);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const waiter = { pred, resolve, timer: undefined };
			const expire = (error = new Error(`event wait timeout after ${timeoutMs}ms`)) => {
				remove(waiter);
				reject(error);
			};
			waiter.timer = setTimeout(expire, timeoutMs);
			expirations.set(waiter, expire);
			client.eventWaiters.push(waiter);
		});
	};
	const run = {
		client,
		server: {
			releaseBarrier(name) {
				releasedBarriers.push(name);
				if (name !== E23_FINAL_REPLY_BARRIER) return;
				finalReply.resolve();
				onRelease?.(emit);
			},
		},
		nextEvent(pred, { timeoutMs = 120_000 } = {}) {
			const seen = client.events.length;
			const waiting = client.waitForEvent((event) => client.events.indexOf(event) >= seen && pred(event), { timeoutMs });
			waiting.catch(() => undefined);
			return waiting;
		},
		async prompt() {
			const idle = run.nextEvent((event) => event.type === "agent_idle");
			promptFrames = [...client.events];
			promptSent.resolve();
			onPrompt?.(emit);
			await response.promise;
			return idle;
		},
		async close() {
			closedFrames = [...client.events];
			closed = true;
		},
	};
	for (const event of buffered) emit(event);
	return {
		run,
		emit,
		emitted,
		get promptFrames() { return promptFrames; },
		get closedFrames() { return closedFrames; },
		releasedBarriers,
		finalReplyReleased: finalReply.promise,
		promptSent: promptSent.promise,
		acceptPrompt: () => response.resolve(),
		rejectPrompt: (error) => response.reject(error),
		completePrompt() {
			response.resolve();
			emit(turnEvent("agent_idle"));
		},
		rejectEvents(error) {
			for (const waiter of [...client.eventWaiters]) expirations.get(waiter)(error);
		},
		checkpoint() {
			// A control message arrives after ready promise continuations, without counting microtasks or sleeping.
			return bounded(new Promise((resolve) => {
				control.port1.once("message", resolve);
				control.port2.postMessage("checkpoint");
			}), "control message");
		},
		dispose() {
			disposed = true;
			response.resolve();
			finalReply.resolve();
			for (const expire of [...expirations.values()]) expire(disposedError);
			control.port1.close();
			control.port2.close();
		},
	};
}

async function exerciseMemoryTurn(options, scenario) {
	const fixture = memoryTurnFixture(options);
	const outcome = driveMemoryTurn(fixture.run).then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	try {
		await scenario(fixture, outcome);
	} finally {
		// Explicit test teardown is separate from child close and from the assertions about owned waiters.
		fixture.dispose();
		await bounded(outcome, "diagnostic teardown");
	}
}

describe("E23 memory turn scheduling", () => {
	const initial = status("memory", "mem: ready");
	const changed = status("memory", "mem: fact committed; backlog pending");
	const notReady = [
		["missing footer", undefined],
		["unrelated channel", status("task", "busy")],
		["cleared footer", status("memory", undefined)],
		["empty footer", status("memory", "")],
		["missing text", { type: "extension_ui_request", method: "setStatus", statusKey: "memory" }],
		["wrong method", { ...changed, method: "setWidget" }],
		["error frame", { ...changed, type: "extension_error" }],
	];

	for (const [label, event] of notReady) {
		test(`#given ${label} before the first write #when the footer is held #then the prompt starts and its final reply waits`, async () => {
			await exerciseMemoryTurn({}, async (fixture, outcome) => {
				if (event) fixture.emit(event);
				await bounded(fixture.promptSent, "cold memory prompt");
				await fixture.checkpoint();
				assert.deepEqual(fixture.promptFrames, [], "the cold prompt must be allowed to create its first memory");
				assert.deepEqual(fixture.releasedBarriers, [], "E23 released its final reply before first-write footer readiness");
				assert.equal(fixture.closedFrames, undefined);
				fixture.emit(initial);
				await bounded(fixture.finalReplyReleased, "final reply after first-write footer");
				assert.deepEqual(fixture.releasedBarriers, [E23_FINAL_REPLY_BARRIER]);
				fixture.completePrompt();
				await fixture.checkpoint();
				assert.equal(fixture.closedFrames, undefined, "the first footer cannot also prove the settled transition");
				fixture.emit(changed);
				assert.equal((await bounded(outcome, "completed memory turn")).error, undefined);
				assert.deepEqual(fixture.closedFrames, fixture.emitted);
				assert.equal(fixture.run.client.eventWaiters.length, 0);
			});
		});
	}

	for (const [label, event] of [...notReady, ["unchanged footer", status("memory", initial.statusText)]]) {
		test(`#given buffered startup and ${label} after idle #when the changed footer is held #then close waits`, async () => {
			await exerciseMemoryTurn({ buffered: [initial] }, async (fixture, outcome) => {
				await bounded(fixture.promptSent, "memory prompt with buffered startup");
				fixture.completePrompt();
				if (event) fixture.emit(event);
				await fixture.checkpoint();
				assert.equal(fixture.closedFrames, undefined, "E23 closed after agent_idle before the changed memory footer");
				fixture.emit(changed);
				assert.equal((await bounded(outcome, "changed footer and close")).error, undefined);
				assert.deepEqual(fixture.closedFrames, fixture.emitted);
				assert.equal(fixture.run.client.eventWaiters.length, 0);
			});
		});
	}

	test("#given a changed footer buffered before the prompt #when idle arrives #then only a fresh transition permits close", async () => {
		await exerciseMemoryTurn({ buffered: [initial, changed] }, async (fixture, outcome) => {
			await bounded(fixture.promptSent, "memory prompt");
			fixture.completePrompt();
			await fixture.checkpoint();
			assert.equal(fixture.closedFrames, undefined, "a pre-prompt footer cannot prove completion of this memory turn");
			const fresh = status("memory", "mem: new fact committed; backlog changed");
			fixture.emit(fresh);
			assert.equal((await bounded(outcome, "fresh footer and close")).error, undefined);
			assert.deepEqual(fixture.closedFrames, fixture.emitted);
			assert.equal(fixture.run.client.eventWaiters.length, 0);
		});
	});

	test("#given a footer emitted during prompt submission #when idle arrives later #then the transition is retained", async () => {
		await exerciseMemoryTurn({ buffered: [initial], onPrompt: (emit) => emit(changed) }, async (fixture, outcome) => {
			await bounded(fixture.promptSent, "memory prompt");
			assert.equal(fixture.closedFrames, undefined);
			fixture.completePrompt();
			assert.equal((await bounded(outcome, "immediate footer and later idle")).error, undefined);
			assert.ok(fixture.promptFrames.includes(initial));
			assert.ok(fixture.closedFrames.includes(changed));
			assert.deepEqual(fixture.closedFrames, fixture.emitted);
			assert.equal(fixture.run.client.eventWaiters.length, 0);
		});
	});

	test("#given a rejected prompt after idle #when the memory turn fails #then its error survives and no owned waiter remains", async () => {
		const failure = new Error("memory prompt rejected");
		await exerciseMemoryTurn({ buffered: [initial] }, async (fixture, outcome) => {
			await bounded(fixture.promptSent, "memory prompt");
			// Resolve CaseRun's idle waiter separately so any remaining waiter belongs to the added footer barrier.
			fixture.emit(turnEvent("agent_idle"));
			fixture.rejectPrompt(failure);
			assert.equal((await bounded(outcome, "prompt rejection")).error, failure);
			assert.equal(fixture.closedFrames, undefined);
			assert.equal(fixture.run.client.eventWaiters.length, 0, "the failed turn left its footer waiter registered");
		});
	});

	for (const phase of ["startup", "changed"]) {
		test(`#given a rejected ${phase} footer wait #when the memory turn fails #then rejection cannot become readiness`, async () => {
			const failure = new Error(`${phase} footer wait rejected`);
			await exerciseMemoryTurn({ buffered: phase === "changed" ? [initial] : [] }, async (fixture, outcome) => {
				if (phase === "changed") {
					await bounded(fixture.promptSent, "memory prompt");
					fixture.completePrompt();
				}
				await fixture.checkpoint();
				fixture.rejectEvents(failure);
				fixture.acceptPrompt();
				assert.equal((await bounded(outcome, `${phase} footer rejection`)).error, failure);
				if (phase === "startup") assert.deepEqual(fixture.promptFrames, [], "the cold prompt must precede first-write readiness");
				assert.deepEqual(fixture.releasedBarriers, [E23_FINAL_REPLY_BARRIER], "failure must release the owned reply before child teardown");
				assert.equal(fixture.closedFrames, undefined, "a rejected footer wait still closed as a successful turn");
				assert.equal(fixture.run.client.eventWaiters.length, 0);
			});
		});
	}

	test("#given a footer emitted on final reply release #when idle arrives later #then close retains the transition", async () => {
		await exerciseMemoryTurn({ buffered: [initial], onRelease: (emit) => emit(changed) }, async (fixture, outcome) => {
			await bounded(fixture.finalReplyReleased, "final reply release");
			assert.equal(fixture.closedFrames, undefined);
			fixture.completePrompt();
			assert.equal((await bounded(outcome, "release-time footer and idle")).error, undefined);
			assert.deepEqual(fixture.closedFrames, fixture.emitted);
			assert.equal(fixture.run.client.eventWaiters.length, 0);
		});
	});

	for (const buffered of [[], [initial]]) {
		test(`#given foreign waiters and ${buffered.length ? "a ready" : "a cold"} footer #when the prompt rejects before idle #then only owned waits are removed`, async () => {
			const fixture = memoryTurnFixture({ buffered });
			const failure = new Error("prompt rejected before idle");
			const before = turnEvent("foreign_before");
			const after = turnEvent("foreign_after");
			const foreignBefore = fixture.run.client.waitForEvent((event) => event === before);
			foreignBefore.catch(() => undefined);
			const beforeWaiter = fixture.run.client.eventWaiters.at(-1);
			const outcome = driveMemoryTurn(fixture.run).then((value) => ({ value }), (error) => ({ error }));
			try {
				await bounded(fixture.promptSent, "memory prompt");
				await fixture.checkpoint();
				const foreignAfter = fixture.run.client.waitForEvent((event) => event === after);
				foreignAfter.catch(() => undefined);
				const afterWaiter = fixture.run.client.eventWaiters.at(-1);
				fixture.rejectPrompt(failure);
				assert.equal((await bounded(outcome, "original prompt failure")).error, failure);
				assert.equal(fixture.closedFrames, undefined);
				assert.deepEqual(fixture.releasedBarriers, [E23_FINAL_REPLY_BARRIER]);
				assert.deepEqual(fixture.run.client.eventWaiters, [beforeWaiter, afterWaiter]);
				fixture.emit(before);
				fixture.emit(after);
				assert.equal(await bounded(foreignBefore, "earlier foreign waiter"), before);
				assert.equal(await bounded(foreignAfter, "later foreign waiter"), after);
				assert.equal(fixture.run.client.eventWaiters.length, 0);
			} finally {
				fixture.dispose();
				await bounded(outcome, "ownership teardown");
			}
		});
	}
});

describe("splitStatusChannels", () => {
	test("#given a channel that published twice #when split #then both snapshots are kept in order and counted", () => {
		const client = {
			turn: [turnEvent("agent_start"), status("memory", "a"), turnEvent("turn_end"), status("memory", "b")],
			surfaces: [{ n: 1 }, { n: 2 }, { n: 3 }],
		};

		const split = splitStatusChannels(client);

		expect(split.turn).toEqual([turnEvent("agent_start"), turnEvent("turn_end")]);
		expect(split.status["setStatus:memory"]).toEqual({ count: 2, snapshots: [status("memory", "a"), status("memory", "b")] });
		expect(split.surfaces).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
	});

	test("#given two runs whose channel counts differ #when split #then the splits differ", () => {
		const once = splitStatusChannels({ turn: [status("memory", "a")] });
		const twice = splitStatusChannels({ turn: [status("memory", "a"), status("memory", "a")] });

		expect(once.status).not.toEqual(twice.status);
	});

	test("#given split observations #when counted #then each O6 client lists its channel counts", () => {
		const O6 = [splitStatusChannels({ turn: [status("memory", "a"), status("goal", "g"), status("memory", "b")] })];

		expect(statusCounts({ O6 })).toEqual([{ "setStatus:memory": 2, "setStatus:goal": 1 }]);
	});
});

describe("stopSandboxProcesses", () => {
	const box = "/sandbox/eq-1";

	test("#given two sandbox processes #when stopped #then both are signalled and none survives", () => {
		const alive = new Set([11, 12]);
		const list = () => [
			...[...alive].map((pid) => ({ pid, command: `node daemon HOME=${box}` })),
			{ pid: 99, command: "unrelated" },
		];

		const stopped = stopSandboxProcesses(box, { list, kill: (pid) => alive.delete(pid), pause: () => {} });

		expect(stopped).toEqual({ signalled: 2, survivors: [], errors: [] });
	});

	test("#given a process that ignores the signal #when the deadline passes #then it is reported as a survivor", () => {
		let clock = 0;

		const stopped = stopSandboxProcesses(box, {
			list: () => [{ pid: 21, command: `x ${box}` }],
			kill: () => {},
			now: () => clock,
			pause: (ms) => {
				clock += ms;
			},
			deadlineMs: 300,
		});

		expect(stopped.signalled).toBe(1);
		expect(stopped.survivors).toEqual([21]);
	});

	test("#given a signal that fails for a reason other than ESRCH #when stopped #then the error is surfaced", () => {
		const alive = new Set([31, 32]);
		const kill = (pid) => {
			alive.delete(pid);
			const error = Object.assign(new Error(pid === 31 ? "gone" : "not permitted"), { code: pid === 31 ? "ESRCH" : "EPERM" });
			throw error;
		};

		const stopped = stopSandboxProcesses(box, {
			list: () => [...alive].map((pid) => ({ pid, command: box })),
			kill,
			pause: () => {},
		});

		expect(stopped.errors).toEqual(["pid 32: not permitted"]);
		expect(stopped.survivors).toEqual([]);
	});
});

describe("dropTimestampOffsets", () => {
	test("#given one ranked commit time rendered as Z, +00:00 and +09:00 #when offsets are dropped #then all three compare equal and other text keeps its offset", () => {
		// git renders a commit's own zone with %cI: +09:00 on a KST host, +00:00 from git < 2.45 in UTC, Z from git >= 2.45.
		// The harness normalizer ranks the date and time but leaves a numeric offset behind the rank token.
		const observed = (suffix) => ({
			timeline: { previousEntryAtISO: `<ts:timeline.previousEntryAtISO:1>${suffix}` },
			list: [`at <ts:entry.timestamp:2>${suffix} and later`],
			note: "meet at 10:00+09:00",
		});

		const utcZ = dropTimestampOffsets(observed(""));

		expect(dropTimestampOffsets(observed("+00:00"))).toEqual(utcZ);
		expect(dropTimestampOffsets(observed("+09:00"))).toEqual(utcZ);
		expect(dropTimestampOffsets(observed("-05:30"))).toEqual(utcZ);
		expect(utcZ.note).toBe("meet at 10:00+09:00");
	});
});

describe("pinEnginePackage", () => {
	const fixture = () => {
		const base = mkdtempSync(join(tmpdir(), "eq-pin-test-"));
		const modules = join(base, "store", "node_modules");
		for (const dir of ["@code-yeongyu/senpi/dist", "@code-yeongyu/senpi-codemode", "chalk"])
			mkdirSync(join(modules, dir), { recursive: true });
		writeFileSync(join(modules, "@code-yeongyu/senpi/package.json"), JSON.stringify({ name: "@code-yeongyu/senpi" }));
		writeFileSync(join(modules, "@code-yeongyu/senpi/dist/cli.js"), "cli");
		return { base, modules, root: join(base, "pin") };
	};

	test("#given an installed package #when pinned #then it is copied to the fixed root with its siblings linked", () => {
		const { base, modules, root } = fixture();
		try {
			const pin = pinEnginePackage(join(modules, "@code-yeongyu/senpi"), { root });

			expect(pin.packageDir).toBe(join(root, "node_modules/@code-yeongyu/senpi"));
			expect(lstatSync(pin.packageDir).isDirectory()).toBe(true);
			expect(realpathSync(pin.packageDir)).toBe(join(realpathSync(root), "node_modules/@code-yeongyu/senpi"));
			expect(readlinkSync(join(root, "node_modules/chalk"))).toBe(realpathSync(join(modules, "chalk")));
			expect(readlinkSync(join(root, "node_modules/@code-yeongyu/senpi-codemode"))).toBe(
				realpathSync(join(modules, "@code-yeongyu/senpi-codemode")),
			);
			pin.release();
			expect(existsSync(root)).toBe(false);
			expect(existsSync(`${root}.lock`)).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("#given a live driver holding the root #when another pins #then it is refused", () => {
		const { base, modules, root } = fixture();
		try {
			writeFileSync(`${root}.lock`, `${process.ppid}\n`);

			expect(() => pinEnginePackage(join(modules, "@code-yeongyu/senpi"), { root })).toThrow(/owns/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
