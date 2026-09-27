/**
 * Contract tests for the three shared memory tool factories.
 *
 * These exercise the public tool surface (factory gating + execute path) by
 * spying on `HindsightApi.prototype.{retain, recall, reflect}` and stubbing
 * Hindsight state on the fake ToolSession. We deliberately do not boot a real
 * session — these tools only need a populated state accessor and Settings.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { resetSettingsForTest, Settings } from "@zag/zag-coding-agent/config/settings";
import { HindsightApi } from "@zag/zag-coding-agent/hindsight/client";
import type { HindsightConfig } from "@zag/zag-coding-agent/hindsight/config";
import { HindsightSessionState } from "@zag/zag-coding-agent/hindsight/state";
import { mnemoBackend } from "@zag/zag-coding-agent/mnemo/backend";
import { loadMnemoConfig, type MnemoBackendConfig } from "@zag/zag-coding-agent/mnemo/config";
import {
	getMnemoScopedDbPaths,
	getMnemoSessionState,
	loadMnemo,
	loadMnemoCore,
	MnemoSessionState,
	setMnemoSessionState,
} from "@zag/zag-coding-agent/mnemo/state";
import type { AgentSessionEventListener } from "@zag/zag-coding-agent/session/agent-session";
import type { ToolSession } from "@zag/zag-coding-agent/tools/index";
import { MemoryEditTool } from "@zag/zag-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@zag/zag-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@zag/zag-coding-agent/tools/memory-reflect";
import { MemoryRetainTool } from "@zag/zag-coding-agent/tools/memory-retain";
import { resetMemoryForTests } from "@zag/zag-mnemo";
import { logger, TempDir } from "@zag/zag-utils";

// Mnemo is lazy-loaded at runtime; preload it for synchronous state construction.
await Promise.all([loadMnemo(), loadMnemoCore()]);

const TEST_SESSION_ID = "test-session-id";
let registeredState: HindsightSessionState | undefined;
let registeredMnemoState: MnemoSessionState | undefined;
let tempDbPath: string | undefined;
let tempDbDir: TempDir | undefined;

function makeConfig(overrides: Partial<HindsightConfig> = {}): HindsightConfig {
	return {
		hindsightApiUrl: "http://localhost:8888",
		hindsightApiToken: null,
		bankId: null,
		bankIdPrefix: "",
		scoping: "global",
		bankMission: "",
		retainMission: null,
		autoRecall: true,
		autoRetain: true,
		retainMode: "full-session",
		retainEveryNTurns: 3,
		retainOverlapTurns: 2,
		retainContext: "zag",
		recallBudget: "mid",
		recallMaxTokens: 1024,
		recallTypes: ["world", "experience"],
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		recallPromptPreamble: "preamble",
		debug: false,
		requestTimeoutMs: 30_000,
		reflectTimeoutMs: 120_000,
		recallTimeoutMs: 30_000,
		retainTimeoutMs: 60_000,
		mentalModelsEnabled: false,
		mentalModelAutoSeed: false,
		mentalModelMaxRenderChars: 16_000,
		...overrides,
	};
}

function makeSession(settings: Settings, sessionId: string | null = TEST_SESSION_ID): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getSessionSpawns: () => null,
		getHindsightSessionState: () => (sessionId === TEST_SESSION_ID ? registeredState : undefined),
		getMnemoSessionState: () => (sessionId === TEST_SESSION_ID ? registeredMnemoState : undefined),
	} as unknown as ToolSession;
}

interface RegisterStateOptions {
	retainTags?: string[];
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	sessionOverrides?: Record<string, unknown>;
}

function registerState(client: HindsightApi, settings?: Settings, opts: RegisterStateOptions = {}) {
	registeredState = new HindsightSessionState({
		sessionId: TEST_SESSION_ID,
		client,
		bankId: "test-bank",
		retainTags: opts.retainTags,
		recallTags: opts.recallTags,
		recallTagsMatch: opts.recallTagsMatch,
		config: makeConfig(),
		session: {
			sessionId: TEST_SESSION_ID,
			sessionManager: { getEntries: () => [] } as never,
			emitNotice: () => {},
			getHindsightSessionState: () => registeredState,
			...opts.sessionOverrides,
		} as never,
		banksSet: new Set(),
		lastRetainedTurn: 0,
		hasRecalledForFirstTurn: false,
	});
	void settings;
}

function makeMnemoConfig(
	overrides: (Partial<MnemoBackendConfig> & Record<string, unknown>) | undefined = {},
): MnemoBackendConfig {
	if (!tempDbPath) {
		tempDbDir = TempDir.createSync(`@mnemo-test-${Date.now()}-`);
		tempDbPath = tempDbDir.join("mnemo.db");
	}
	return {
		dbPath: tempDbPath,
		bank: "test-bank",
		autoRecall: true,
		autoRetain: true,
		polyphonicRecall: false,
		enhancedRecall: false,
		proactiveLinking: false,
		retainEveryNTurns: 3,
		recallLimit: 10,
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		injectionTokenLimit: 1024,
		debug: false,
		providerOptions: {
			noEmbeddings: true,
			embeddingModel: undefined,
			embeddingApiUrl: undefined,
			embeddingApiKey: undefined,
			llm: false,
		},
		llmMode: "none",
		llmBaseUrl: undefined,
		llmApiKey: undefined,
		llmModel: undefined,
		...overrides,
	};
}

interface RegisterMnemoStateOptions {
	cwd?: string;
	sessionId?: string;
	entries?: () => unknown[];
	listeners?: Set<AgentSessionEventListener>;
}

function registerMnemoState(config?: MnemoBackendConfig, options: RegisterMnemoStateOptions = {}): MnemoSessionState {
	const finalConfig = config ?? makeMnemoConfig();
	const sessionId = options.sessionId ?? TEST_SESSION_ID;
	registeredMnemoState = new MnemoSessionState({
		sessionId,
		config: finalConfig,
		session: {
			sessionId,
			settings: Settings.isolated({
				"memory.backend": "mnemo",
				"mnemo.noEmbeddings": true,
				"mnemo.llmMode": "none",
			}),
			modelRegistry: {
				getApiKeyForProvider: async () => undefined,
				resolver: () => async () => undefined,
			} as never,
			sessionManager: {
				getEntries: options.entries ?? (() => []),
				getCwd: () => options.cwd ?? "/tmp",
			} as never,
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
			subscribe: (listener: AgentSessionEventListener) => {
				options.listeners?.add(listener);
				return () => options.listeners?.delete(listener);
			},
		} as never,
	});
	setMnemoSessionState(registeredMnemoState.session as never, registeredMnemoState);
	return registeredMnemoState;
}

describe("Hindsight tool factories", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("retain/recall/reflect factories return null when memory.backend !== hindsight", () => {
		const settings = Settings.isolated({ "memory.backend": "local", "memories.enabled": false });
		const session = makeSession(settings);
		expect(MemoryRetainTool.createIf(session)).toBeNull();
		expect(MemoryRecallTool.createIf(session)).toBeNull();
		expect(MemoryReflectTool.createIf(session)).toBeNull();
	});

	it("retain/recall/reflect factories return tool instances when Hindsight is configured", () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeSession(settings);
		expect(MemoryRetainTool.createIf(session)).toBeInstanceOf(MemoryRetainTool);
		expect(MemoryRecallTool.createIf(session)).toBeInstanceOf(MemoryRecallTool);
		expect(MemoryReflectTool.createIf(session)).toBeInstanceOf(MemoryReflectTool);
	});
});

describe("Mnemo tool factories", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemoState = undefined;
		tempDbPath = undefined;
		tempDbDir = undefined;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await registeredMnemoState?.dispose();
		registeredMnemoState = undefined;
		await tempDbDir?.remove();
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	it("memory tool factories gate on supported backends", () => {
		const offSettings = Settings.isolated({ "memory.backend": "off", "memories.enabled": false });
		const hindsightSettings = Settings.isolated({ "memory.backend": "hindsight" });
		const localSession = makeSession(Settings.isolated({ "memory.backend": "local", "memories.enabled": false }));
		expect(MemoryRetainTool.createIf(localSession)).toBeNull();
		expect(MemoryRecallTool.createIf(localSession)).toBeNull();
		expect(MemoryReflectTool.createIf(localSession)).toBeNull();
		expect(MemoryEditTool.createIf(makeSession(offSettings))).toBeNull();
		expect(MemoryEditTool.createIf(makeSession(hindsightSettings))).toBeNull();
	});

	it("retain/recall/reflect/edit factories return tool instances when memory.backend === mnemo", () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const session = makeSession(settings);
		expect(MemoryRetainTool.createIf(session)).toBeInstanceOf(MemoryRetainTool);
		expect(MemoryRecallTool.createIf(session)).toBeInstanceOf(MemoryRecallTool);
		expect(MemoryReflectTool.createIf(session)).toBeInstanceOf(MemoryReflectTool);
		expect(MemoryEditTool.createIf(session)).toBeInstanceOf(MemoryEditTool);
	});
});

describe("retain.execute", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("queues the memory and reports success without calling the API", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		registerState(client, settings);

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-1", { items: [{ content: "user prefers tabs" }] });

		expect(result.content[0]).toEqual({ type: "text", text: "1 memory queued." });
		// Tool returns before any HTTP work happens.
		expect(retainBatchSpy).not.toHaveBeenCalled();
		expect(retainSpy).not.toHaveBeenCalled();
		expect(registeredState?.retainQueue.depth).toBe(1);
	});

	it("flushes a multi-item tool call as a single retainBatch call with per-item context", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		registerState(client, settings, { retainTags: ["project:zag"] });

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-batch", {
			items: [{ content: "fact one" }, { content: "fact two", context: "user override" }],
		});
		expect(result.content[0]).toEqual({ type: "text", text: "2 memories queued." });

		await registeredState?.flushRetainQueue();

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		const [bankId, items, options] = retainBatchSpy.mock.calls[0];
		expect(bankId).toBe("test-bank");
		expect(options).toEqual(expect.objectContaining({ async: true }));
		expect(items).toEqual([
			expect.objectContaining({
				content: "fact one",
				metadata: { session_id: TEST_SESSION_ID },
				tags: ["project:zag"],
			}),
			expect.objectContaining({
				content: "fact two",
				context: "user override",
				metadata: { session_id: TEST_SESSION_ID },
				tags: ["project:zag"],
			}),
		]);
		expect(registeredState?.retainQueue.depth).toBe(0);
	});

	it("emits a UI-only warning notice when the batch flush fails", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "retainBatch").mockRejectedValue(new Error("HTTP 503"));
		const noticeSpy = vi.fn();
		registerState(client, settings, { sessionOverrides: { emitNotice: noticeSpy } });

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		await tool.execute("call-x", { items: [{ content: "doomed fact" }] });
		await registeredState?.flushRetainQueue();

		expect(noticeSpy).toHaveBeenCalledTimes(1);
		const [level, message, source] = noticeSpy.mock.calls[0];
		expect(level).toBe("warning");
		expect(source).toBe("Hindsight");
		expect(message).toContain("HTTP 503");
		expect(message).toContain("1 memory");
	});

	it("throws when no per-session state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-2", { items: [{ content: "x" }] })).rejects.toThrow(/not initialised/i);
	});
});

describe("retain.execute (Mnemo backend)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemoState = undefined;
		tempDbPath = undefined;
		tempDbDir = undefined;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await registeredMnemoState?.dispose();
		registeredMnemoState = undefined;
		await tempDbDir?.remove();
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	it("writes memories synchronously and returns a stored success message", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		registerMnemoState();

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemo-1", {
			items: [{ content: "user prefers tabs", context: "editor configuration" }],
		});

		expect(result.content[0]).toEqual({ type: "text", text: "1 memory stored." });

		// Verify the memory was actually stored by recalling it
		const recallTool = MemoryRecallTool.createIf(makeSession(settings))!;
		const recallResult = await recallTool.execute("call-mnemo-recall", { query: "user preferences" });

		const text = (recallResult.content[0] as { text: string }).text;
		expect(text).toContain("user prefers tabs");
	});

	it("stores multiple memories and returns correct count", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		registerMnemoState();

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemo-multi", {
			items: [
				{ content: "fact one" },
				{ content: "fact two", context: "additional context" },
				{ content: "fact three" },
			],
		});

		expect(result.content[0]).toEqual({ type: "text", text: "3 memories stored." });

		// Verify all memories are recallable
		const recallTool = MemoryRecallTool.createIf(makeSession(settings))!;
		const recallResult = await recallTool.execute("call-mnemo-recall-multi", { query: "facts" });

		const text = (recallResult.content[0] as { text: string }).text;
		expect(text).toContain("fact one");
		expect(text).toContain("fact two");
		expect(text).toContain("fact three");
	});

	// A failed write stored nothing, so reporting the whole batch as stored
	// misleads the caller about the failure, its cause, and what was kept.
	it("reports what a batch stored and why a later write failed instead of claiming success", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const state = registerMnemoState();
		const memory = state.getScopedRetainTarget().memory;
		const remember = memory.remember.bind(memory);
		const storedIds: string[] = [];
		let writes = 0;
		vi.spyOn(memory, "remember").mockImplementation((content, options) => {
			writes += 1;
			if (writes === 2) throw new Error("database or disk is full");
			const id = remember(content, options);
			storedIds.push(id);
			return id;
		});

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const error = await tool
			.execute("call-mnemo-partial", {
				items: [{ content: "fact kept" }, { content: "fact lost" }, { content: "fact never tried" }],
			})
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("did not store item 2 of 3: database or disk is full.");
		expect((error as Error).message).toContain(`item 1 (id ${storedIds[0]})`);
		expect((error as Error).message).toContain("Later items were not attempted.");
		expect(writes).toBe(2);
		expect(memory.get(storedIds[0]!)).toMatchObject({ content: "fact kept" });
	});

	it("does not claim untried items when the last item of a batch fails", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const state = registerMnemoState();
		vi.spyOn(state.getScopedRetainTarget().memory, "remember").mockImplementation(() => {
			throw new Error("database or disk is full");
		});

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const error = await tool
			.execute("call-mnemo-last", { items: [{ content: "only fact" }] })
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("item 1 of 1: database or disk is full. Nothing was stored.");
		expect((error as Error).message).not.toContain("Later items");
	});

	it("isolates memories between projects when scoping is per-project", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemo",
			"mnemo.scoping": "per-project",
		});
		const alphaConfig = makeMnemoConfig({ scoping: "per-project", bank: "project-alpha" });
		const betaConfig = makeMnemoConfig({ scoping: "per-project", bank: "project-beta" });
		registerMnemoState(alphaConfig, { cwd: "/work/project-alpha" });
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemo-alpha-store", {
			items: [{ content: "alpha uses tabs" }],
		});
		await registeredMnemoState?.dispose();
		registerMnemoState(betaConfig, { cwd: "/work/project-beta" });
		const betaRecall = await MemoryRecallTool.createIf(makeSession(settings))!.execute("call-mnemo-beta-recall", {
			query: "tabs",
		});
		expect(betaRecall.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
		await registeredMnemoState?.dispose();
		registerMnemoState(alphaConfig, { cwd: "/work/project-alpha" });
		const alphaRecall = await MemoryRecallTool.createIf(makeSession(settings))!.execute("call-mnemo-alpha-recall", {
			query: "tabs",
		});
		expect((alphaRecall.content[0] as { text: string }).text).toContain("alpha uses tabs");
	});
	it("throws when no per-session Mnemo state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-mnemo-no-state", { items: [{ content: "x" }] })).rejects.toThrow(
			/not initialised/i,
		);
	});
});

describe("Mnemo backend lifecycle", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemoState = undefined;
		tempDbPath = undefined;
		tempDbDir = undefined;
		// Close any leaked default Mnemo instance from a prior test so its
		// SQLite handle doesn't keep the next test's DB files locked on Windows.
		resetMemoryForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await registeredMnemoState?.dispose();
		registeredMnemoState = undefined;
		// Close the mnemo default instance so its SQLite handle doesn't keep
		// the temp DB files locked on Windows.
		resetMemoryForTests();
		await tempDbDir?.remove().catch(() => {});
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	it("keeps background auto-recall engine failures from escaping", async () => {
		const entries = [{ type: "message", message: { role: "user", content: "existing memory" } }];
		const state = registerMnemoState(makeMnemoConfig({ autoRecall: true }), {
			entries: () => entries,
		});
		vi.spyOn(state.getScopedRecallTargets()[0].memory, "recallEnhanced").mockRejectedValue(
			new TypeError("mmrRerankIndices is not a function"),
		);

		await expect(state.maybeRecallOnAgentStart()).resolves.toBeUndefined();
		expect(state.hasRecalledForFirstTurn).toBe(false);
	});

	it("contains unavailable-bank failures from agent-end retention", async () => {
		const listeners = new Set<AgentSessionEventListener>();
		const entries = [{ type: "message", message: { role: "user", content: "turn one" } }];
		const state = registerMnemoState(makeMnemoConfig({ retainEveryNTurns: 1 }), {
			entries: () => entries,
			listeners,
		});
		state.attachSessionListeners();
		state.memory.beam.db.close();
		const warning = Promise.withResolvers<void>();
		const warn = vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			if (message === "Mnemo: lifecycle hook failed") warning.resolve();
			void context;
		});

		for (const listener of listeners) listener({ type: "agent_end", messages: [] } as never);
		await warning.promise;

		expect(warn).toHaveBeenCalledWith("Mnemo: lifecycle hook failed", {
			banks: ["test-bank"],
			operation: "agent_end retention",
			error: "Cannot use a closed database",
		});
	});

	it("contains failures before agent-start recall reaches its internal bank guard", async () => {
		const listeners = new Set<AgentSessionEventListener>();
		const state = registerMnemoState(makeMnemoConfig(), {
			entries: () => {
				throw new Error("session journal unavailable");
			},
			listeners,
		});
		state.attachSessionListeners();
		const warning = Promise.withResolvers<void>();
		const warn = vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			if (message === "Mnemo: lifecycle hook failed") warning.resolve();
			void context;
		});

		for (const listener of listeners) listener({ type: "agent_start" } as never);
		await warning.promise;

		expect(warn).toHaveBeenCalledWith("Mnemo: lifecycle hook failed", {
			banks: ["test-bank"],
			operation: "agent_start recall",
			error: "session journal unavailable",
		});
	});
	it("auto-retain stores only the not-yet-retained suffix", async () => {
		const entries = Array.from({ length: 4 }, (_, index) => ({
			type: "message",
			message: { role: "user", content: `turn ${index + 1}` },
		}));
		const state = registerMnemoState(makeMnemoConfig({ retainEveryNTurns: 2 }), {
			cwd: "/work/project-alpha",
			entries: () => entries,
		});
		state.lastRetainedTurn = 2;
		const retainSpy = vi.spyOn(state, "retainMessages").mockResolvedValue();

		await state.maybeRetainOnAgentEnd([{ role: "user", content: [{ type: "text", text: "turn 4" }] }] as never);

		expect(retainSpy).toHaveBeenCalledTimes(1);
		expect(retainSpy.mock.calls[0][0]).toEqual([
			{ role: "user", content: "turn 3" },
			{ role: "user", content: "turn 4" },
		]);
		expect(state.lastRetainedTurn).toBe(4);
	});

	it("does not retain the current session on dispose when auto-retain is disabled", async () => {
		const entries = [{ type: "message", message: { role: "user", content: "private turn" } }];
		const state = registerMnemoState(makeMnemoConfig({ autoRetain: false }), {
			entries: () => entries,
		});
		const dbPath = state.memory.dbPath;
		if (!dbPath) throw new Error("Expected a file-backed Mnemo database");

		await state.dispose();

		const db = new Database(dbPath, { readonly: true });
		const row = db
			.prepare<{ count: number }, []>(`
				SELECT COUNT(*) AS count
				FROM working_memory
				WHERE source = 'coding-agent-transcript'
			`)
			.get();
		db.close();
		expect(row?.count).toBe(0);
	});

	it("explicit force-retention stores the current session when auto-retain is disabled", async () => {
		const entries = [{ type: "message", message: { role: "user", content: "explicitly forced turn" } }];
		const state = registerMnemoState(makeMnemoConfig({ autoRetain: false }), {
			entries: () => entries,
		});

		await state.forceRetainCurrentSession();

		const row = state.memory.beam.db
			.prepare<{ count: number }, []>(`
				SELECT COUNT(*) AS count
				FROM working_memory
				WHERE source = 'coding-agent-transcript'
			`)
			.get();
		expect(row?.count).toBe(1);
	});
	it("explicit consolidation stores the current session when auto-retain is disabled", async () => {
		const entries = [{ type: "message", message: { role: "user", content: "explicitly consolidated turn" } }];
		const state = registerMnemoState(makeMnemoConfig({ autoRetain: false }), {
			entries: () => entries,
		});

		await state.consolidate({ sleep: false });

		const row = state.memory.beam.db
			.prepare<{ count: number }, []>(`
				SELECT COUNT(*) AS count
				FROM working_memory
				WHERE source = 'coding-agent-transcript'
			`)
			.get();
		expect(row?.count).toBe(1);
	});

	it("explicit enqueue retains the current session when auto-retain is disabled", async () => {
		const entries = [{ type: "message", message: { role: "user", content: "explicitly retained turn" } }];
		const state = registerMnemoState(makeMnemoConfig({ autoRetain: false }), {
			entries: () => entries,
		});
		const retainMemory = state.getScopedRetainTarget().memory;
		vi.spyOn(retainMemory, "sleepAllSessions");

		await mnemoBackend.enqueue(path.dirname(tempDbPath!), "/tmp", state.session);

		const row = retainMemory.beam.db
			.prepare<{ count: number }, []>(`
				SELECT COUNT(*) AS count
				FROM working_memory
				WHERE source = 'coding-agent-transcript'
			`)
			.get();
		expect(row?.count).toBe(1);
		expect(retainMemory.sleepAllSessions).toHaveBeenCalledTimes(1);
	});

	it("consolidates age-eligible working memory at session start so the next write does not TTL-trim it (#10770)", () => {
		const state = registerMnemoState();
		const memory = state.getScopedRetainTarget().memory;
		const beam = memory.beam;
		// Explicit retain from a prior session: STATED, unconsolidated.
		const retainId = memory.remember("durable lesson worth keeping across sessions", {
			source: "coding-agent-retain",
			importance: 0.75,
			scope: "bank",
			extract: false,
		});
		// Simulate a >24h session gap: past the 24h TTL and the 12h sleep gate.
		const oldTs = new Date(Date.now() - 48 * 3_600_000).toISOString();
		beam.db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [oldTs, retainId]);

		// Session start consolidation stamps consolidated_at before any write.
		state.promoteEligibleWorkingMemory();
		const consolidatedAt = (
			beam.db.query("SELECT consolidated_at FROM working_memory WHERE id = ?").get(retainId) as {
				consolidated_at: string | null;
			} | null
		)?.consolidated_at;
		expect(consolidatedAt).not.toBeNull();

		// A later write triggers trimWorkingMemory(); the consolidated row survives.
		memory.remember("a fresh note in the new session", { source: "coding-agent-transcript", scope: "bank" });
		expect(memory.get(retainId)).not.toBeNull();
	});

	it("promotes aged working memory when the backend starts a top-level session (#10770)", async () => {
		// Resolve seed and started session to the SAME bank/db: `global` scoping
		// with the shared `default` bank maps the retain bank straight to dbPath.
		const settings = Settings.isolated({
			"memory.backend": "mnemo",
			"mnemo.noEmbeddings": true,
			"mnemo.llmMode": "none",
			"mnemo.scoping": "global",
			"mnemo.bank": "default",
			"mnemo.dbPath": makeMnemoConfig().dbPath,
		});
		// Seed an aged, unconsolidated retain row, then close the bank handles so
		// backend.start reopens the same DB file from disk.
		const seed = registerMnemoState(makeMnemoConfig({ scoping: "global", bank: "default" }));
		const seedMemory = seed.getScopedRetainTarget().memory;
		const retainId = seedMemory.remember("aged durable lesson", {
			source: "coding-agent-retain",
			scope: "bank",
			extract: false,
		});
		seedMemory.beam.db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [
			new Date(Date.now() - 48 * 3_600_000).toISOString(),
			retainId,
		]);
		await seed.dispose({ consolidate: false });
		registeredMnemoState = undefined;
		resetMemoryForTests();

		const modelRegistry = { getApiKeyForProvider: async () => undefined, resolver: () => async () => undefined };
		const session = {
			sessionId: TEST_SESSION_ID,
			settings,
			modelRegistry,
			sessionManager: { getEntries: () => [], getCwd: () => "/tmp" },
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
			subscribe: () => () => {},
		} as never;
		await mnemoBackend.start({
			session,
			settings,
			modelRegistry: modelRegistry as never,
			agentDir: path.dirname(tempDbPath!),
			taskDepth: 0,
		});

		const started = getMnemoSessionState(session);
		expect(started).toBeDefined();
		registeredMnemoState = started;
		const memory = started!.getScopedRetainTarget().memory;
		// The row must have survived start into the reopened bank, and a later
		// write (which triggers trimWorkingMemory) must not remove it — start
		// promoted it to episodic, so the TTL trim skips it.
		expect(memory.get(retainId)).not.toBeNull();
		memory.remember("a fresh note after start", { source: "coding-agent-transcript", scope: "bank" });
		expect(memory.get(retainId)).not.toBeNull();
	});

	it("does not re-store retained turns during consolidation or after resume", async () => {
		const entries = Array.from({ length: 6 }, (_, index) => ({
			type: "message",
			message: { role: "user", content: `turn ${index + 1}` },
		}));
		let visibleTurns = 2;
		const config = makeMnemoConfig({ retainEveryNTurns: 2 });
		const state = registerMnemoState(config, {
			cwd: "/work/project-alpha",
			entries: () => entries.slice(0, visibleTurns),
		});

		await state.maybeRetainOnAgentEnd([] as never);
		visibleTurns = 4;
		await state.maybeRetainOnAgentEnd([] as never);
		await state.forceRetainCurrentSession();
		await state.dispose({ consolidate: false });

		visibleTurns = 6;
		const resumed = registerMnemoState(config, {
			cwd: "/work/project-alpha",
			entries: () => entries.slice(0, visibleTurns),
		});
		await resumed.forceRetainCurrentSession();

		const rows = resumed.memory.beam.db
			.prepare<{ content: string; retainedThroughUserTurn: number }, [string]>(`
				SELECT
					content,
					CAST(json_extract(metadata_json, '$.retained_through_user_turn') AS INTEGER)
						AS retainedThroughUserTurn
				FROM working_memory
				WHERE source = 'coding-agent-transcript'
				  AND json_extract(metadata_json, '$.session_id') = ?
				ORDER BY rowid
			`)
			.all(TEST_SESSION_ID);
		expect(rows.map(row => row.content.match(/turn \d+/g))).toEqual([
			["turn 1", "turn 2"],
			["turn 3", "turn 4"],
			["turn 5", "turn 6"],
		]);
		expect(rows.map(row => row.retainedThroughUserTurn)).toEqual([2, 4, 6]);
	});

	it("does not over-count legacy cumulative resumed rows when restoring the cursor", async () => {
		const entries = Array.from({ length: 8 }, (_, index) => ({
			type: "message",
			message: { role: "user", content: `turn ${index + 1}` },
		}));
		const config = makeMnemoConfig({ retainEveryNTurns: 2 });
		const seed = registerMnemoState(config, { cwd: "/work/project-alpha" });
		const turn = (index: number) => ({ role: "user", content: `turn ${index}` });
		// Legacy pre-fix bank: two incremental rows plus a cumulative row written
		// by a resumed session whose in-memory cursor had reset to zero. None of
		// them carry retained_through_user_turn metadata.
		await seed.retainMessages([turn(1), turn(2)], `${TEST_SESSION_ID}-1`);
		await seed.retainMessages([turn(3), turn(4)], `${TEST_SESSION_ID}-2`);
		await seed.retainMessages([turn(1), turn(2), turn(3), turn(4), turn(5), turn(6)], `${TEST_SESSION_ID}-3`);
		await seed.dispose({ consolidate: false });

		const resumed = registerMnemoState(config, {
			cwd: "/work/project-alpha",
			entries: () => entries,
		});
		await resumed.maybeRetainOnAgentEnd([] as never);

		const rows = resumed.memory.beam.db
			.prepare<{ content: string }, [string]>(`
				SELECT content
				FROM working_memory
				WHERE source = 'coding-agent-transcript'
				  AND json_extract(metadata_json, '$.session_id') = ?
				ORDER BY rowid
			`)
			.all(TEST_SESSION_ID);
		expect(rows).toHaveLength(4);
		expect(rows.at(-1)?.content.match(/turn \d+/g)).toEqual(["turn 7", "turn 8"]);
	});

	it("retains the full transcript but extracts and embeds clean projections", async () => {
		const state = registerMnemoState(makeMnemoConfig(), { cwd: "/work/project-alpha" });
		const rememberSpy = vi.spyOn(state, "rememberInScope").mockReturnValue("memory-id");

		await state.retainMessages(
			[
				{ role: "user", content: "I always prefer tabs" },
				{ role: "assistant", content: "the parser never initializes and reorder never activates" },
				{ role: "user", content: "I never use semicolons" },
			],
			"source-1",
		);

		expect(rememberSpy).toHaveBeenCalledTimes(1);
		const [storedTranscript, options] = rememberSpy.mock.calls[0];
		if (options === undefined) throw new Error("retainMessages did not pass remember options");
		expect(storedTranscript).toContain("[role: assistant]");
		expect(storedTranscript).toContain("reorder never activates");
		expect(options.extract).toBe(true);
		expect(options.extractEntities).toBe(true);
		expect(options.extractText).toContain("I always prefer tabs");
		expect(options.extractText).toContain("I never use semicolons");
		expect(options.extractText).not.toContain("parser never initializes");
		expect(options.embedText).toContain("I always prefer tabs");
		expect(options.embedText).toContain("parser never initializes");
		expect(options.embedText).toContain("I never use semicolons");
		expect(options.embedText).not.toContain("[role:");
		expect(options.embedText).not.toContain(":end]");
	});

	it("registers subagent aliases from parent Mnemo state without Hindsight", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const parentState = registerMnemoState();
		const childSession = {
			sessionId: "child-session-id",
			settings,
			sessionManager: {
				getEntries: () => [],
				getCwd: () => "/tmp",
			},
			emitNotice: () => {},
		} as never;

		await mnemoBackend.start({
			session: childSession,
			settings,
			modelRegistry: {} as never,
			agentDir: path.dirname(tempDbPath!),
			taskDepth: 1,
			parentMnemoSessionState: parentState,
		});

		const childState = getMnemoSessionState(childSession);
		expect(childState?.aliasOf).toBe(parentState);
		expect(childState?.getScopedRetainTarget().bank).toBe(parentState.getScopedRetainTarget().bank);
		await childState?.dispose();
	});

	it("flushes extractions and closes every owned bank on session shutdown (#2320)", async () => {
		const config = makeMnemoConfig({
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
			retainBank: "project-alpha",
			recallBanks: ["project-alpha", "default"],
		});
		const state = registerMnemoState(config, { cwd: "/work/project-alpha" });
		// Seed working memory in each owned bank so the SQL consolidation path
		// has rows to walk and the sleep call is not a trivial no-op.
		state.rememberInScope("project-alpha note", { scope: "bank", extract: false, source: "test" });
		state.globalMemory?.remember("default-bank note", { scope: "bank", extract: false, source: "test" });

		const retainMemory = state.getScopedRetainTarget().memory;
		const ownedMemories = [retainMemory];
		if (state.globalMemory && state.globalMemory !== retainMemory) {
			ownedMemories.push(state.globalMemory);
		}

		const retainSpy = vi.spyOn(state, "forceRetainCurrentSession").mockResolvedValue();
		const perBank = ownedMemories.map(memory => ({
			memory,
			flush: vi.spyOn(memory, "flushExtractions"),
			sleep: vi.spyOn(memory, "sleep"),
			close: vi.spyOn(memory, "close"),
		}));

		await state.dispose();

		expect(retainSpy).toHaveBeenCalledTimes(1);
		for (const bank of perBank) {
			expect(bank.flush).toHaveBeenCalledTimes(1);
			expect(bank.sleep).not.toHaveBeenCalled();
			expect(bank.close).toHaveBeenCalledTimes(1);
			const flushedAt = bank.flush.mock.invocationCallOrder[0];
			const closedAt = bank.close.mock.invocationCallOrder[0];
			expect(flushedAt).toBeLessThan(closedAt);
			expect(retainSpy.mock.invocationCallOrder[0]).toBeLessThan(closedAt);
		}
		// State already consumed its owned resources; the afterEach hook would
		// otherwise re-enter dispose on closed handles.
		registeredMnemoState = undefined;
	});

	it("dispose({ timeoutMs }) returns within the budget when consolidate stalls (#3641)", async () => {
		const state = registerMnemoState();
		const retainMemory = state.getScopedRetainTarget().memory;
		// Hold flushExtractions hostage longer than any reasonable shutdown budget
		// so the race exclusively settles via the timeout branch.
		const flushStall = Promise.withResolvers<void>();
		let flushCalls = 0;
		const flushSpy = vi.spyOn(retainMemory, "flushExtractions").mockImplementation(async () => {
			flushCalls++;
			await flushStall.promise;
		});
		const closeDone = Promise.withResolvers<void>();
		const close = retainMemory.close.bind(retainMemory);
		const closeSpy = vi.spyOn(retainMemory, "close").mockImplementation(() => {
			close();
			closeDone.resolve();
		});

		const BUDGET_MS = 20;
		const start = Bun.nanoseconds();
		await state.dispose({ timeoutMs: BUDGET_MS });
		const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;

		// Dispose must surrender within the budget; the in-flight consolidate is
		// detached, not awaited. The ceiling is only there to catch a hang, so
		// it absorbs a full second of timer/scheduling delay on a loaded runner.
		expect(elapsedMs).toBeLessThan(BUDGET_MS + 1_000);
		expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS - 10);
		expect(flushSpy).toHaveBeenCalled();
		expect(flushCalls).toBe(1);
		// `close()` is deferred so SQLite writes don't race a closed handle.
		expect(closeSpy).not.toHaveBeenCalled();

		// Release the stall and confirm the deferred close runs once consolidate
		// settles — i.e. the SQLite handle still ends up released eventually.
		flushStall.resolve();
		await closeDone.promise;
		expect(closeSpy).toHaveBeenCalledTimes(1);

		registeredMnemoState = undefined;
	});

	it("bounds synchronous SQLite lock waits on every owned bank during final retention (#7351)", async () => {
		// per-project-tagged owns a project retain bank AND the shared bank; lock the
		// shared bank so a retain-only busy-timeout fix would still stall teardown.
		const config = makeMnemoConfig({
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
		});
		const entries = [
			{ type: "message", message: { role: "user", content: "hello" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
		];
		const state = registerMnemoState(config, { cwd: "/work/project-alpha", entries: () => entries });
		const ownedDbPaths = getMnemoScopedDbPaths(config);
		const sharedDbPath = ownedDbPaths.find(dbPath => dbPath === config.dbPath);
		const lock = new Database(sharedDbPath!);
		lock.exec("BEGIN IMMEDIATE");
		const sharedMemory = state.globalMemory;
		const sharedFlushCalled = Promise.withResolvers<void>();
		const sharedFlushSpy = vi.spyOn(sharedMemory!, "flushExtractions").mockImplementation(async () => {
			// Signal first: the exec below may throw SQLITE_BUSY while the lock is
			// still held, and the call itself is what the test awaits.
			sharedFlushCalled.resolve();
			// Model a pending extraction/embedding commit. An idle shared bank performs
			// no SQLite work during flush, so merely locking it would not exercise its
			// connection's busy timeout.
			sharedMemory!.beam.db.exec("PRAGMA user_version=7351");
		});

		const started = performance.now();
		try {
			await state.dispose({ timeoutMs: 50 });
		} finally {
			lock.exec("ROLLBACK");
			lock.close();
		}
		const elapsedMs = performance.now() - started;

		try {
			expect(elapsedMs).toBeLessThan(500);
			// When the shutdown budget expires mid-consolidate, dispose detaches the
			// pass instead of abandoning it (#3641) — so on a slow runner the shared
			// flush may not have run yet when dispose returns. The lock is released
			// above, so the detached pass must still reach the shared bank; await
			// the call itself instead of asserting synchronously.
			await sharedFlushCalled.promise;
			expect(sharedFlushSpy).toHaveBeenCalledTimes(1);
		} finally {
			registeredMnemoState = undefined;
		}
	});

	it.each([{}, { retain: false }])(
		"unbounded dispose drains and closes without sleeping (options: %j)",
		async options => {
			const state = registerMnemoState();
			const retainMemory = state.getScopedRetainTarget().memory;
			const flushSpy = vi.spyOn(retainMemory, "flushExtractions").mockResolvedValue();
			const sleepSpy = vi.spyOn(retainMemory, "sleep");
			const closeSpy = vi.spyOn(retainMemory, "close");

			await state.dispose(options);

			// Unbounded dispose still runs the consolidate-then-close pipeline, but
			// skips the synchronous bank sleep so the interactive shutdown path stays
			// fast (#3641). Full consolidation remains reachable via `/memory enqueue`.
			expect(flushSpy).toHaveBeenCalledTimes(1);
			expect(sleepSpy).not.toHaveBeenCalled();
			expect(closeSpy).toHaveBeenCalledTimes(1);

			registeredMnemoState = undefined;
		},
	);

	it("dispose retains the current session without scheduling LLM fact extraction", async () => {
		const state = registerMnemoState();
		const retainSpy = vi.spyOn(state, "forceRetainCurrentSession").mockResolvedValue();

		await state.dispose();

		expect(retainSpy).toHaveBeenCalledTimes(1);
		expect(retainSpy).toHaveBeenCalledWith({ extract: false });

		registeredMnemoState = undefined;
	});

	it("consolidate({ sleep: false }) retains and flushes without sleeping the bank", async () => {
		const state = registerMnemoState();
		const retainMemory = state.getScopedRetainTarget().memory;
		vi.spyOn(state, "forceRetainCurrentSession").mockResolvedValue();
		vi.spyOn(retainMemory, "flushExtractions").mockResolvedValue();
		const sleepAllSessionsSpy = vi.spyOn(retainMemory, "sleepAllSessions");
		const sleepSpy = vi.spyOn(retainMemory, "sleep");

		await state.consolidate({ sleep: false });

		expect(sleepAllSessionsSpy).not.toHaveBeenCalled();
		expect(sleepSpy).not.toHaveBeenCalled();

		registeredMnemoState = undefined;
	});

	it("consolidate({ full: true }) runs the full cross-session sleepAllSessions", async () => {
		const state = registerMnemoState();
		const retainMemory = state.getScopedRetainTarget().memory;
		vi.spyOn(state, "forceRetainCurrentSession").mockResolvedValue();
		vi.spyOn(retainMemory, "flushExtractions").mockResolvedValue();
		const sleepAllSessionsSpy = vi.spyOn(retainMemory, "sleepAllSessions");
		const sleepSpy = vi.spyOn(retainMemory, "sleep");

		await state.consolidate({ full: true });

		expect(sleepAllSessionsSpy).toHaveBeenCalledTimes(1);
		expect(sleepAllSessionsSpy).toHaveBeenCalledWith(false);
		expect(sleepSpy).not.toHaveBeenCalled();

		registeredMnemoState = undefined;
	});

	it("skips consolidation when disposing an aliased subagent state (#2320)", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const parentState = registerMnemoState();
		const parentMemory = parentState.getScopedRetainTarget().memory;
		const childSession = {
			sessionId: "child-session-id",
			settings,
			sessionManager: { getEntries: () => [], getCwd: () => "/tmp" },
			emitNotice: () => {},
		} as never;
		await mnemoBackend.start({
			session: childSession,
			settings,
			modelRegistry: {} as never,
			agentDir: path.dirname(tempDbPath!),
			taskDepth: 1,
			parentMnemoSessionState: parentState,
		});
		const childState = getMnemoSessionState(childSession);
		expect(childState?.aliasOf).toBe(parentState);

		const flushSpy = vi.spyOn(parentMemory, "flushExtractions");
		const sleepSpy = vi.spyOn(parentMemory, "sleepAllSessions");
		const closeSpy = vi.spyOn(parentMemory, "close");
		const parentRetainSpy = vi.spyOn(parentState, "forceRetainCurrentSession");

		await childState?.dispose();

		// Alias dispose must not touch the parent's owned memories or trigger
		// parent retention; the parent state outlives the subagent.
		expect(flushSpy).not.toHaveBeenCalled();
		expect(sleepSpy).not.toHaveBeenCalled();
		expect(closeSpy).not.toHaveBeenCalled();
		expect(parentRetainSpy).not.toHaveBeenCalled();
	});

	it("aliased subagent enqueue still flushes and sleeps the parent's shared banks (#2327 review)", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const parentState = registerMnemoState();
		const parentMemory = parentState.getScopedRetainTarget().memory;
		const childSession = {
			sessionId: "child-session-id",
			settings,
			sessionManager: { getEntries: () => [], getCwd: () => "/tmp" },
			emitNotice: () => {},
			modelRegistry: {} as never,
			getMnemoSessionState: () => getMnemoSessionState(childSession),
		} as never;
		await mnemoBackend.start({
			session: childSession,
			settings,
			modelRegistry: {} as never,
			agentDir: path.dirname(tempDbPath!),
			taskDepth: 1,
			parentMnemoSessionState: parentState,
		});
		const childState = getMnemoSessionState(childSession);
		expect(childState?.aliasOf).toBe(parentState);

		const flushSpy = vi.spyOn(parentMemory, "flushExtractions");
		const sleepSpy = vi.spyOn(parentMemory, "sleepAllSessions");
		const parentRetainSpy = vi.spyOn(parentState, "forceRetainCurrentSession");
		const childRetainSpy = vi.spyOn(childState!, "forceRetainCurrentSession");

		await mnemoBackend.enqueue(path.dirname(tempDbPath!), "/tmp", childSession);

		// /memory enqueue from a subagent must still consolidate the shared
		// banks; `forceRetainCurrentSession` is the one piece that the alias
		// guard short-circuits (the subagent's transcript is the parent's
		// concern), but the SQL-level flush and sleep must reach every owned
		// bank or the user's enqueue silently no-ops.
		expect(flushSpy).toHaveBeenCalledTimes(1);
		expect(sleepSpy).toHaveBeenCalledTimes(1);
		expect(sleepSpy).toHaveBeenCalledWith(false);
		expect(childRetainSpy).toHaveBeenCalledTimes(1);
		expect(parentRetainSpy).not.toHaveBeenCalled();
	});

	it("clears scoped Mnemo data and rehydrates active state", async () => {
		const config = makeMnemoConfig({
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
			retainBank: "project-alpha",
			recallBanks: ["project-alpha", "default"],
		});
		const listeners = new Set<AgentSessionEventListener>();
		const state = registerMnemoState(config, { cwd: "/work/project-alpha", listeners });
		state.rememberInScope("project clear marker", { scope: "bank", extract: false, source: "test" });
		state.globalMemory?.remember("global clear marker", { scope: "bank", extract: false, source: "test" });
		const session = state.session;
		setMnemoSessionState(session, state);

		await mnemoBackend.clear(path.dirname(config.dbPath), "/work/project-alpha", session);

		const rehydrated = getMnemoSessionState(session);
		if (!rehydrated) throw new Error("Mnemo state was not rehydrated");
		expect(rehydrated).not.toBe(state);
		expect(listeners.size).toBe(1);
		const remaining = await rehydrated.recallResultsScoped("clear marker");
		expect(remaining.some(hit => String(hit.content).includes("clear marker"))).toBe(false);
		expect(rehydrated.rememberScoped("after-clear", { source: "test", scope: "bank", extract: false })).toEqual(
			expect.any(String),
		);
		registeredMnemoState = rehydrated;
	});
	it("attaches listeners when enqueue rehydrates missing state", async () => {
		const config = makeMnemoConfig();
		const listeners = new Set<AgentSessionEventListener>();
		const seed = registerMnemoState(config, { listeners });
		const session = seed.session;
		setMnemoSessionState(session, undefined);
		await seed.dispose({ consolidate: false });
		registeredMnemoState = undefined;

		await mnemoBackend.enqueue(path.dirname(config.dbPath), "/tmp", session);

		registeredMnemoState = getMnemoSessionState(session);
		expect(registeredMnemoState).toBeDefined();
		expect(listeners.size).toBe(1);
	});

	it("clear() skips consolidation before deleting the DBs (#2327 review)", async () => {
		const config = makeMnemoConfig({
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
			retainBank: "project-alpha",
			recallBanks: ["project-alpha", "default"],
		});
		const state = registerMnemoState(config, { cwd: "/work/project-alpha" });
		const ownedMemories = [state.getScopedRetainTarget().memory];
		if (state.globalMemory && state.globalMemory !== ownedMemories[0]) {
			ownedMemories.push(state.globalMemory);
		}

		const retainSpy = vi.spyOn(state, "forceRetainCurrentSession");
		const consolidateSpy = vi.spyOn(state, "consolidate");
		const perBank = ownedMemories.map(memory => ({
			flush: vi.spyOn(memory, "flushExtractions"),
			sleep: vi.spyOn(memory, "sleepAllSessions"),
			close: vi.spyOn(memory, "close"),
		}));

		const session = state.session;
		setMnemoSessionState(session, state);

		await mnemoBackend.clear(path.dirname(config.dbPath), "/work/project-alpha", session);

		// `/memory clear` is about to delete the SQLite files: spending tokens
		// and time consolidating memory that will be wiped is wasted work.
		expect(retainSpy).not.toHaveBeenCalled();
		expect(consolidateSpy).not.toHaveBeenCalled();
		for (const bank of perBank) {
			expect(bank.flush).not.toHaveBeenCalled();
			expect(bank.sleep).not.toHaveBeenCalled();
			expect(bank.close).toHaveBeenCalledTimes(1);
		}
		registeredMnemoState = getMnemoSessionState(session);
		expect(registeredMnemoState).toBeDefined();
	});

	it("exposes direct mnemo runtime status and search/save results", async () => {
		const config = makeMnemoConfig({
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
			retainBank: "project-alpha",
			recallBanks: ["project-alpha", "default"],
		});
		const state = registerMnemoState(config, { cwd: "/work/project-alpha" });
		const session = state.session;
		setMnemoSessionState(session, state);

		const save = await mnemoBackend.save!(
			{ agentDir: path.dirname(config.dbPath), cwd: "/work/project-alpha", session },
			{
				content: "the user prefers dark mode in their editor",
				source: "test-source",
				context: "editor preferences",
				importance: 0.8,
			},
		);
		expect(save).toMatchObject({ backend: "mnemo", stored: 1, ids: [expect.any(String)] });

		const status = await mnemoBackend.status!({
			agentDir: path.dirname(config.dbPath),
			cwd: "/work/project-alpha",
			session,
		});
		expect(status).toMatchObject({
			backend: "mnemo",
			active: true,
			writable: true,
			searchable: true,
			retainBank: "project-alpha",
		});
		expect(status.recallBanks).toEqual(expect.arrayContaining(["project-alpha", "default"]));

		const search = await mnemoBackend.search!(
			{ agentDir: path.dirname(config.dbPath), cwd: "/work/project-alpha", session },
			"dark mode",
		);
		expect(search.backend).toBe("mnemo");
		expect(search.count).toBeGreaterThan(0);
		expect(search.items[0]).toMatchObject({
			content: expect.stringContaining("dark mode"),
			source: "test-source",
			score: expect.any(Number),
		});
	});

	it("redacts credentials in saved content and metadata context before they reach the bank", async () => {
		const config = makeMnemoConfig({ bank: "project-alpha", retainBank: "project-alpha" });
		const state = registerMnemoState(config, { cwd: "/work/project-alpha" });
		const session = state.session;
		setMnemoSessionState(session, state);
		const dbPath = state.memory.dbPath;
		if (!dbPath) throw new Error("Expected a file-backed Mnemo database");

		const token = `npm_${"aB3dEfGh1JkLmN0pQrStUvWxYz2345678901".slice(0, 36)}`;
		const save = await mnemoBackend.save!(
			{ agentDir: path.dirname(config.dbPath), cwd: "/work/project-alpha", session },
			{
				content: `publish the package with ${token}`,
				source: "test-source",
				context: `registry auth uses ${token}`,
				importance: 0.8,
			},
		);
		expect(save).toMatchObject({ backend: "mnemo", stored: 1 });

		const db = new Database(dbPath, { readonly: true });
		const row = db
			.prepare<{ content: string; embed_text: string | null; metadata_json: string | null }, []>(`
				SELECT content, embed_text, metadata_json
				FROM working_memory
				WHERE source = 'test-source'
			`)
			.get();
		const ftsHits = db
			.prepare<{ count: number }, [string]>(`
				SELECT COUNT(*) AS count FROM fts_working WHERE fts_working MATCH ?
			`)
			.get(token);
		db.close();

		expect(row).toBeDefined();
		expect(row?.content).toBe("publish the package with [REDACTED]");
		expect(row?.embed_text ?? "").not.toContain("npm_");
		expect(JSON.parse(row?.metadata_json ?? "{}").context).toBe("registry auth uses [REDACTED]");
		expect(ftsHits?.count ?? 0).toBe(0);
	});

	it("reports aborted searches and failed saves", async () => {
		const state = registerMnemoState();
		const session = state.session;
		setMnemoSessionState(session, state);

		const controller = new AbortController();
		controller.abort();
		await expect(
			mnemoBackend.search!({ agentDir: "/tmp/agent", cwd: "/tmp", session }, "anything", {
				signal: controller.signal,
			}),
		).resolves.toMatchObject({
			backend: "mnemo",
			count: 0,
			message: "Search aborted.",
		});

		const rememberSpy = vi.spyOn(state, "rememberScoped").mockImplementation(() => {
			throw new Error("database or disk is full");
		});
		await expect(
			mnemoBackend.save!({ agentDir: "/tmp/agent", cwd: "/tmp", session }, { content: "memory that fails" }),
		).resolves.toMatchObject({
			backend: "mnemo",
			stored: 0,
			message: "Mnemo did not store the memory: database or disk is full",
		});
		rememberSpy.mockRestore();
	});

	it("derives valid project banks from the absolute project root", async () => {
		const rootDir = TempDir.createSync(`@mnemo-bank-${Date.now()}-`);
		const root = rootDir.path();
		const alphaCwd = path.join(root, "a", "api");
		const betaCwd = path.join(root, "b", "api");
		mkdirSync(alphaCwd, { recursive: true });
		mkdirSync(betaCwd, { recursive: true });
		try {
			const base = Settings.isolated({
				"memory.backend": "mnemo",
				"mnemo.scoping": "per-project",
				"mnemo.bank": "../../bad bank name with spaces and punctuation!",
			});
			const alpha = loadMnemoConfig(await base.cloneForCwd(alphaCwd), root);
			const beta = loadMnemoConfig(await base.cloneForCwd(betaCwd), root);

			expect(alpha.bank).not.toBe(beta.bank);
			const banks = [alpha.bank, beta.bank, alpha.globalBank, beta.globalBank].filter(
				(bank): bank is string => typeof bank === "string",
			);
			for (const bank of banks) {
				expect(bank).toMatch(/^[A-Za-z0-9_-]+$/);
				expect(bank.length).toBeLessThanOrEqual(64);
			}
			expect(alpha.globalBank).toBe("bad-bank-name-with-spaces-and-punctuation");
		} finally {
			rootDir.removeSync();
		}
	});
});
describe("recall.execute", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("returns the no-results sentinel when recall yields empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client, settings);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-3", { query: "anything" });
		expect(result.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
	});

	it("formats non-empty results with count + UTC timestamp header", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [
				{ text: "fact one", type: "world", id: "1" },
				{ text: "fact two", id: "2" },
			],
		} as never);
		registerState(client, settings);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-4", { query: "anything" });
		const block = (result.content[0] as { text: string }).text;
		expect(block).toMatch(/^Found 2 relevant memories \(as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)/);
		expect(block).toContain("- fact one [world]");
		expect(block).toContain("- fact two");
	});

	it("forwards recall tags + tagsMatch from session state when present", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client, settings, { recallTags: ["project:zag"], recallTagsMatch: "any" });

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		await tool.execute("call-tags", { query: "anything" });

		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"anything",
			expect.objectContaining({ tags: ["project:zag"], tagsMatch: "any" }),
		);
	});

	it("rethrows underlying client errors", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockRejectedValue(new Error("HTTP 503"));
		registerState(client, settings);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-5", { query: "anything" })).rejects.toThrow(/HTTP 503/);
	});
});

describe("recall.execute (Mnemo backend)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemoState = undefined;
		tempDbPath = undefined;
		tempDbDir = undefined;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await registeredMnemoState?.dispose();
		registeredMnemoState = undefined;
		await tempDbDir?.remove();
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	it("returns the no-results sentinel when empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		registerMnemoState();

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemo-empty", { query: "nonexistent query" });

		expect(result.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
	});

	it("surfaces recall engine failures instead of the no-results sentinel", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const state = registerMnemoState();
		const failure = new TypeError("mmrRerankIndices is not a function");
		vi.spyOn(state.getScopedRecallTargets()[0].memory, "recallEnhanced").mockRejectedValue(failure);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-mnemo-failure", { query: "existing memory" })).rejects.toThrow(failure);
	});

	it("keeps healthy scoped targets available when another target fails", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const state = registerMnemoState(
			makeMnemoConfig({
				scoping: "per-project-tagged",
				bank: "project-bank",
				globalBank: "global-bank",
			}),
		);
		vi.spyOn(state.getScopedRecallTargets()[0].memory, "recallEnhanced").mockRejectedValue(
			new Error("project bank unavailable"),
		);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemo-partial-failure", { query: "nonexistent query" });
		expect(result.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
	});

	it("returns a populated text block when a retained memory exists", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		registerMnemoState();

		// First, store a memory
		const retainTool = MemoryRetainTool.createIf(makeSession(settings))!;
		await retainTool.execute("call-mnemo-store", {
			items: [{ content: "the user prefers dark mode in their editor" }],
		});

		// Then recall it
		const recallTool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await recallTool.execute("call-mnemo-query", { query: "editor preferences" });

		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/\(id: [^)]+\)/);
		expect(text).toContain("Found 1 relevant memory");
		expect(text).toContain("the user prefers dark mode in their editor");
	});

	it("shares memories across projects when scoping is global", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemo",
			"mnemo.scoping": "global",
		});
		const config = makeMnemoConfig({ scoping: "global", bank: "default" });
		registerMnemoState(config, { cwd: "/work/project-alpha" });
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemo-global-store", {
			items: [{ content: "global memory survives project switches" }],
		});
		registeredMnemoState?.dispose();
		registerMnemoState(config, { cwd: "/work/project-beta" });
		const result = await MemoryRecallTool.createIf(makeSession(settings))!.execute("call-mnemo-global-recall", {
			query: "project switches",
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("global memory survives project switches");
	});

	it("merges global and project-local memories on recall when scoping is per-project-tagged", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemo",
			"mnemo.scoping": "per-project-tagged",
		});
		// Store a global memory (uses default/global bank)
		registerMnemoState(makeMnemoConfig({ scoping: "global", bank: "default", globalBank: "default" }), {
			cwd: "/work/project-alpha",
		});
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemo-tagged-global", {
			items: [{ content: "the user likes concise CLI output" }],
		});
		// Store project-alpha local memory
		registeredMnemoState?.dispose();
		registerMnemoState(
			makeMnemoConfig({ scoping: "per-project-tagged", bank: "project-alpha", globalBank: "default" }),
			{ cwd: "/work/project-alpha" },
		);
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemo-tagged-local", {
			items: [{ content: "project alpha uses pnpm workspaces" }],
		});
		// Store project-beta local memory
		registeredMnemoState?.dispose();
		registerMnemoState(
			makeMnemoConfig({ scoping: "per-project-tagged", bank: "project-beta", globalBank: "default" }),
			{ cwd: "/work/project-beta" },
		);
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemo-tagged-other", {
			items: [{ content: "project beta deploys to staging first" }],
		});
		// Recall from project-alpha should merge global + alpha, exclude beta
		registeredMnemoState?.dispose();
		registerMnemoState(
			makeMnemoConfig({ scoping: "per-project-tagged", bank: "project-alpha", globalBank: "default" }),
			{ cwd: "/work/project-alpha" },
		);
		const result = await MemoryRecallTool.createIf(makeSession(settings))!.execute("call-mnemo-tagged-recall", {
			query: "what should I know about this user and project alpha?",
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("the user likes concise CLI output");
		expect(text).toContain("project alpha uses pnpm workspaces");
		expect(text).not.toContain("project beta deploys to staging first");
	});

	it("throws when no per-session Mnemo state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-mnemo-no-state", { query: "anything" })).rejects.toThrow(/not initialised/i);
	});
});

describe("memory_edit.execute (Mnemo backend)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemoState = undefined;
		tempDbPath = undefined;
		tempDbDir = undefined;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await registeredMnemoState?.dispose();
		registeredMnemoState = undefined;
		await tempDbDir?.remove();
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	async function retainAndRecallId(settings: Settings, content: string, query: string): Promise<string> {
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-memory-edit-store", {
			items: [{ content }],
		});
		const id = (await registeredMnemoState?.recallResultsScoped(query))?.[0]?.id;
		return id!;
	}

	it("updates a working memory by recall id", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		registerMnemoState();
		const id = await retainAndRecallId(settings, "editor accent color is blue", "accent color");

		const result = await MemoryEditTool.createIf(makeSession(settings))!.execute("call-memory-edit-update", {
			op: "update",
			id,
			content: "editor accent color is green",
			importance: 2,
		});

		expect((result.content[0] as { text: string }).text).toContain("updated");
		const recalled = await registeredMnemoState!.recallResultsScoped("accent color");
		expect(recalled.map(memory => memory.content)).toContain("editor accent color is green");
	});

	it("forgets a working memory by recall id", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		registerMnemoState();
		const id = await retainAndRecallId(settings, "temporary deployment note can be deleted", "deployment note");

		const result = await MemoryEditTool.createIf(makeSession(settings))!.execute("call-memory-edit-forget", {
			op: "forget",
			id,
		});

		expect((result.content[0] as { text: string }).text).toContain("deleted");
		const recalled = await registeredMnemoState!.recallResultsScoped("deployment note");
		expect(recalled.map(memory => memory.content)).not.toContain("temporary deployment note can be deleted");
	});

	it("invalidates a working memory by recall id", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		registerMnemoState();
		const id = await retainAndRecallId(settings, "stale api key rotation policy", "api key rotation");

		const result = await MemoryEditTool.createIf(makeSession(settings))!.execute("call-memory-edit-invalidate", {
			op: "invalidate",
			id,
		});

		expect((result.content[0] as { text: string }).text).toContain("invalidated");
		const recalled = await registeredMnemoState!.recallResultsScoped("api key rotation");
		expect(recalled.map(memory => memory.content)).not.toContain("stale api key rotation policy");
	});

	it("reports not_found for unknown ids", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		registerMnemoState();

		const result = await MemoryEditTool.createIf(makeSession(settings))!.execute("call-memory-edit-missing", {
			op: "forget",
			id: "missing-memory-id",
		});

		expect(result.details).toEqual({ status: "not_found" });
		expect((result.content[0] as { text: string }).text).toContain("not found");
	});

	it("throws when no per-session Mnemo state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const tool = MemoryEditTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-memory-edit-no-state", { op: "forget", id: "anything" })).rejects.toThrow(
			/not initialised/i,
		);
	});

	it("renders backend stats and diagnostics for scoped banks", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const state = registerMnemoState();
		await retainAndRecallId(settings, "stats fixture memory for mnemo", "stats fixture");

		const stats = await mnemoBackend.stats?.("/tmp/agent", "/tmp", state.session);
		const diagnose = await mnemoBackend.diagnose?.("/tmp/agent", "/tmp", state.session);

		expect(stats).toContain("# Mnemo Memory Stats");
		expect(stats).toContain("test-bank");
		expect(diagnose).toContain("# Mnemo Memory Diagnostics");
		expect(diagnose).toContain("test-bank");
	});
});

describe("reflect.execute", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("returns the reflect text and forwards context", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const reflectSpy = vi
			.spyOn(HindsightApi.prototype, "reflect")
			.mockResolvedValue({ text: "Synthesised answer" } as never);
		registerState(client, settings);

		const tool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-6", { query: "what does the user prefer?", context: "background" });
		expect(reflectSpy).toHaveBeenCalledWith(
			"test-bank",
			"what does the user prefer?",
			expect.objectContaining({ context: "background", budget: "mid" }),
		);
		expect((result.content[0] as { text: string }).text).toBe("Synthesised answer");
	});

	it("falls back to a sentinel when reflect returns blank text", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "reflect").mockResolvedValue({ text: "  " } as never);
		registerState(client, settings);

		const tool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-7", { query: "anything" });
		expect((result.content[0] as { text: string }).text).toBe("No relevant information found to reflect on.");
	});
});

describe("reflect.execute (Mnemo backend)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemoState = undefined;
		tempDbPath = undefined;
		tempDbDir = undefined;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await registeredMnemoState?.dispose();
		registeredMnemoState = undefined;
		await tempDbDir?.remove();
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	it("returns the no-results sentinel when empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		registerMnemoState();

		const tool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemo-reflect-empty", {
			query: "what does the user prefer?",
		});

		expect(result.content[0]).toEqual({
			type: "text",
			text: "No relevant information found to reflect on.",
		});
	});

	it("returns a synthesized text block based on recalled memories when data exists", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		registerMnemoState();

		// First, store memories
		const retainTool = MemoryRetainTool.createIf(makeSession(settings))!;
		await retainTool.execute("call-mnemo-store-reflect", {
			items: [
				{ content: "the user prefers dark mode in their editor" },
				{ content: "the user uses Vim keybindings" },
				{ content: "the user likes tabs over spaces" },
			],
		});

		// Then reflect on them
		const reflectTool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await reflectTool.execute("call-mnemo-reflect-query", {
			query: "what are the user's editor preferences?",
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Based on recalled memories");
		expect(text).toContain("dark mode");
		expect(text).toContain("Vim");
		expect(text).toContain("tabs");
	});

	it("includes additional context in the query when provided", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		registerMnemoState();

		// Store a memory
		const retainTool = MemoryRetainTool.createIf(makeSession(settings))!;
		await retainTool.execute("call-mnemo-store-context", {
			items: [{ content: "the user works on Python projects" }],
		});

		// Reflect with context
		const reflectTool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await reflectTool.execute("call-mnemo-reflect-context", {
			query: "what does the user work on?",
			context: "this is for a new project setup",
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Based on recalled memories");
		expect(text).toContain("Python");
	});

	it("merges global and project-local memories on reflect when scoping is per-project-tagged", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemo",
			"mnemo.scoping": "per-project-tagged",
		});
		// Store a global memory (uses default/global bank)
		registerMnemoState(makeMnemoConfig({ scoping: "global", bank: "default", globalBank: "default" }), {
			cwd: "/work/project-alpha",
		});
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemo-reflect-global", {
			items: [{ content: "the user prefers concise summaries" }],
		});
		// Store project-alpha local memory
		registeredMnemoState?.dispose();
		registerMnemoState(
			makeMnemoConfig({ scoping: "per-project-tagged", bank: "project-alpha", globalBank: "default" }),
			{ cwd: "/work/project-alpha" },
		);
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemo-reflect-local", {
			items: [{ content: "project alpha uses turbo for task orchestration" }],
		});
		const result = await MemoryReflectTool.createIf(makeSession(settings))!.execute("call-mnemo-reflect-tagged", {
			query: "what matters for this user working in project alpha?",
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Based on recalled memories");
		expect(text).toContain("the user prefers concise summaries");
		expect(text).toContain("project alpha uses turbo for task orchestration");
	});

	it("throws when no per-session Mnemo state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemo" });
		const tool = MemoryReflectTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-mnemo-reflect-no-state", { query: "anything" })).rejects.toThrow(
			/not initialised/i,
		);
	});
});
