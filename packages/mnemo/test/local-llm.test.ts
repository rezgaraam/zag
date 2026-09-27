import { afterEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@zag/zag-ai";
import { createMockModel, registerMockApi } from "@zag/zag-ai/providers/mock";
import { CallableLlmBackend, resetHostLlmBackendForTests, setHostLlmBackend } from "@zag/zag-mnemo/core/llm-backends";
import {
	buildHostPrompt,
	callLocalLlm,
	callRemoteLlm,
	chunkMemoriesByBudget,
	cleanOutput,
	complete,
	llmAvailable,
	localGgufAvailable,
	summarizeMemories,
} from "@zag/zag-mnemo/core/local-llm";
import { Mnemo } from "@zag/zag-mnemo/core/memory";
import { withMnemoRuntimeOptions } from "@zag/zag-mnemo/core/runtime-options";
import { TempDir } from "@zag/zag-utils";

const OLD_ENV = { ...process.env };

const tempDirs: TempDir[] = [];

// Per-test SQLite path so `new Mnemo(...)` never touches the shared default
// bank file. Full-workspace parallel runs otherwise contend on that single path
// and throw SQLITE_BUSY at initBeam once busy_timeout is exceeded (#9886).
function tempDbPath(): string {
	const tempDir = TempDir.createSync("@mnemo-local-llm-");
	tempDirs.push(tempDir);
	return tempDir.join("mnemo.db");
}

function restoreEnv(): void {
	for (const key in process.env) {
		if (!(key in OLD_ENV)) delete process.env[key];
	}
	for (const key in OLD_ENV) {
		const value = OLD_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	restoreEnv();
	resetHostLlmBackendForTests();
	for (const tempDir of tempDirs.splice(0)) {
		tempDir.removeSync();
	}
});

registerMockApi();

describe("local LLM TypeScript port", () => {
	it("reports remote availability and calls OpenAI-compatible HTTP", async () => {
		process.env.MNEMO_LLM_BASE_URL = "http://local-llm/v1";
		process.env.MNEMO_LLM_API_KEY = "sk-test";
		process.env.MNEMO_LLM_MODEL = "test-model";
		let auth = "";
		let model = "";
		const fetchMock: FetchImpl = async (_input, init?) => {
			auth = new Headers(init?.headers).get("authorization") ?? "";
			model = (JSON.parse(String(init?.body)) as { model: string }).model;
			return new Response(JSON.stringify({ choices: [{ message: { content: "Remote summary." } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		expect(llmAvailable()).toBe(true);
		expect(await callRemoteLlm("Test prompt", 0.2, { fetch: fetchMock })).toBe("Remote summary.");
		expect(auth).toBe("Bearer sk-test");
		expect(model).toBe("test-model");
	});

	it("removes leading reasoning blocks from remote summaries", async () => {
		process.env.MNEMO_LLM_BASE_URL = "http://reasoning-llm/v1";
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									"<think>\nThe user requested a one-sentence summary.\n</think>\nMnemo uses multilingual-e5-large.",
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		expect(await summarizeMemories(["Mnemo uses multilingual-e5-large."], "", { fetch: fetchMock })).toBe(
			"Mnemo uses multilingual-e5-large.",
		);
	});

	it("preserves a literal think tag that follows real content", () => {
		expect(cleanOutput("The XML tag is <think>keep</think>")).toBe("The XML tag is <think>keep</think>");
	});

	it("keeps local GGUF unavailable and returns null for local completion", async () => {
		expect(localGgufAvailable()).toBe(false);
		expect(await callLocalLlm("prompt")).toBeNull();
	});

	it("uses host backend before remote and skips remote on host miss", async () => {
		process.env.MNEMO_LLM_ENABLED = "true";
		process.env.MNEMO_HOST_LLM_ENABLED = "true";
		process.env.MNEMO_LLM_BASE_URL = "http://remote/v1";
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return new Response(JSON.stringify({ choices: [{ message: { content: "Remote summary." } }] }), {
				status: 200,
			});
		};

		setHostLlmBackend(new CallableLlmBackend("host", () => "Host summary."));
		expect(await summarizeMemories(["Memory one"], "", { fetch: fetchMock })).toBe("Host summary.");
		expect(calls).toBe(0);

		setHostLlmBackend(new CallableLlmBackend("host", () => null));
		expect(await summarizeMemories(["Memory one"], "", { fetch: fetchMock })).toBeNull();
		expect(calls).toBe(0);
	});

	it("renders host sleep prompt override without chat-template tokens", () => {
		process.env.MNEMO_SLEEP_PROMPT = "Write in German. Source={source}. Memories:\n{memories}";
		expect(buildHostPrompt(["User prefers tea"], "profile")).toBe(
			"Write in German. Source=profile. Memories:\n- User prefers tea",
		);
	});

	it("expands chunk budget when host backend will handle calls", () => {
		process.env.MNEMO_LLM_ENABLED = "true";
		process.env.MNEMO_HOST_LLM_ENABLED = "true";
		process.env.MNEMO_HOST_LLM_N_CTX = "32000";
		process.env.MNEMO_LLM_N_CTX = "2048";
		setHostLlmBackend(new CallableLlmBackend("host", () => "x"));
		const hostChunks = chunkMemoriesByBudget(["x".repeat(10_000)]);
		resetHostLlmBackendForTests();
		const localChunks = chunkMemoriesByBudget(["x".repeat(10_000)]);
		expect(hostChunks).toHaveLength(1);
		expect(localChunks).toHaveLength(0);
	});

	it("uses a constructor-scoped completion function instead of remote URL settings", async () => {
		process.env.MNEMO_LLM_ENABLED = "true";
		process.env.MNEMO_LLM_BASE_URL = "http://remote.example/v1";
		let fetchCalls = 0;
		const fetchMock: FetchImpl = async () => {
			fetchCalls += 1;
			throw new Error("remote should not be called");
		};
		const memory = new Mnemo({
			dbPath: tempDbPath(),
			llm: async (prompt, opts) => `fn:${prompt}:${opts?.maxTokens ?? 0}`,
		});
		try {
			const text = await withMnemoRuntimeOptions(memory.runtimeOptions, () =>
				complete("hello", 0.3, { fetch: fetchMock }),
			);
			expect(text).toBe("fn:hello:2048");
			expect(fetchCalls).toBe(0);
		} finally {
			memory.close();
		}
	});

	it("uses a constructor-scoped zag-ai Model instance", async () => {
		const model = createMockModel({
			handler: () => ({ content: ["model summary"] }),
		});
		const memory = new Mnemo({ dbPath: tempDbPath(), llm: model });
		try {
			const text = await withMnemoRuntimeOptions(memory.runtimeOptions, () => complete("hello"));
			expect(text).toBe("model summary");
		} finally {
			memory.close();
		}
	});

	it("lets llm:false override remote environment defaults", async () => {
		process.env.MNEMO_LLM_ENABLED = "true";
		process.env.MNEMO_LLM_BASE_URL = "http://remote.example/v1";
		let fetchCalls = 0;
		const fetchMock: FetchImpl = async () => {
			fetchCalls += 1;
			throw new Error("remote should not be called");
		};
		const memory = new Mnemo({ dbPath: tempDbPath(), llm: false });
		try {
			const text = await withMnemoRuntimeOptions(memory.runtimeOptions, () =>
				complete("hello", 0.3, { fetch: fetchMock }),
			);
			expect(text).toBeNull();
			expect(fetchCalls).toBe(0);
		} finally {
			memory.close();
		}
	});
});
