import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleToolCall, TOOLS } from "@zag/zag-mnemo/mcp-tools";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "mnemo-ts-provider-parity-"));
	process.env.MNEMO_DATA_DIR = dataDir;
	process.env.MNEMO_NO_EMBEDDINGS = "1";
	delete process.env.MNEMO_MCP_BANK;
	delete process.env.MNEMO_SHARED_SURFACE_DB;
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	delete process.env.MNEMO_DATA_DIR;
	delete process.env.MNEMO_NO_EMBEDDINGS;
	delete process.env.MNEMO_MCP_BANK;
	delete process.env.MNEMO_SHARED_SURFACE_DB;
});

describe("provider all-tools parity", () => {
	it("registers the Python provider-compatible tool surface with valid JSON schemas", () => {
		const names = TOOLS.map(tool => tool.name);
		expect(names).toHaveLength(23);
		for (const name of [
			"mnemo_remember",
			"mnemo_recall",
			"mnemo_sleep",
			"mnemo_stats",
			"mnemo_invalidate",
			"mnemo_validate",
			"mnemo_get",
			"mnemo_triple_add",
			"mnemo_triple_query",
			"mnemo_scratchpad_write",
			"mnemo_scratchpad_read",
			"mnemo_scratchpad_clear",
			"mnemo_export",
			"mnemo_update",
			"mnemo_forget",
			"mnemo_import",
			"mnemo_diagnose",
			"mnemo_shared_remember",
			"mnemo_shared_recall",
			"mnemo_shared_forget",
			"mnemo_shared_stats",
			"mnemo_graph_query",
			"mnemo_graph_link",
		]) {
			expect(names).toContain(name);
		}
		for (const tool of TOOLS) {
			const roundTripped = JSON.parse(JSON.stringify(tool.inputSchema)) as { type: string };
			expect(roundTripped.type).toBe("object");
		}
	});

	it("returns user-facing argument errors instead of mutating on missing arguments", async () => {
		for (const [name, args, expected] of [
			["mnemo_remember", {}, "content is required"],
			["mnemo_recall", {}, "query is required"],
			["mnemo_scratchpad_write", { content: "" }, "content is required"],
			["mnemo_update", { memory_id: "missing-id" }, "content or importance is required"],
			["mnemo_forget", {}, "memory_id is required"],
			["mnemo_export", {}, "output_path is required"],
			["mnemo_import", {}, "Either input_path (for file import) is required"],
		] as const) {
			const result = await handleToolCall(name, args);
			expect(result.error).toBe(expected);
		}
	});

	it("exports provider data to a file and imports it into a fresh isolated bank", async () => {
		const remembered = await handleToolCall("mnemo_remember", {
			content: "source provider memory for import parity",
			importance: 0.7,
			bank: "source",
		});
		expect(remembered.status).toBe("stored");
		await handleToolCall("mnemo_scratchpad_write", {
			content: "portable provider scratch",
			bank: "source",
		});

		const exportPath = join(dataDir, "provider-export.json");
		const exported = await handleToolCall("mnemo_export", {
			output_path: exportPath,
			bank: "source",
		});
		expect(exported.status).toBe("exported");
		expect(existsSync(exportPath)).toBe(true);
		const payload = JSON.parse(readFileSync(exportPath, "utf8")) as { working_memory?: unknown[] };
		expect(payload.working_memory?.length).toBe(1);

		const imported = await handleToolCall("mnemo_import", { input_path: exportPath, bank: "dest" });
		expect(imported.status).toBe("imported");
		expect(JSON.stringify(imported.stats)).toContain("inserted");
		const recalled = await handleToolCall("mnemo_recall", {
			query: "import parity",
			bank: "dest",
			limit: 5,
		});
		expect(recalled.count as number).toBeGreaterThanOrEqual(1);
	});

	it("diagnose, validate, graph, and shared handlers return structured provider results", async () => {
		const remembered = await handleToolCall("mnemo_remember", {
			content: "validate me through provider parity",
			bank: "ops",
		});
		const memoryId = remembered.memory_id as string;
		const validate = await handleToolCall("mnemo_validate", {
			memory_id: memoryId,
			action: "attest",
			validator: "test",
			bank: "ops",
		});
		expect(validate.status).toBe("validation_attest");
		const diagnose = await handleToolCall("mnemo_diagnose", { bank: "ops" });
		expect(diagnose.status).toBe("ok");
		expect(diagnose.db_path).toContain("banks/ops/mnemo.db");
		const graphQuery = await handleToolCall("mnemo_graph_query", { seed_memory_id: memoryId, bank: "ops" });
		expect(graphQuery).toMatchObject({
			status: "ok",
			seed_memory_id: memoryId,
			count: 0,
			results_count: 0,
			results: [],
			related_memories: [],
			bank: "ops",
		});
		expect(
			await handleToolCall("mnemo_graph_link", {
				source_id: memoryId,
				target_id: "other",
				relationship: "related",
				bank: "ops",
			}),
		).toMatchObject({
			status: "linked",
			source_id: memoryId,
			target_id: "other",
			relationship: "related",
			edge_type: "related",
			weight: 0.5,
			bank: "ops",
		});

		const shared = await handleToolCall("mnemo_shared_remember", {
			content: "Prefer concise parity notes",
			kind: "preference",
		});
		expect(shared.status).toBe("stored_shared");
		expect((await handleToolCall("mnemo_shared_forget", { memory_id: shared.memory_id })).status).toBe("deleted");
	}, 30_000);
});
