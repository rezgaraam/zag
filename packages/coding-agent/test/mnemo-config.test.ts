import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@zag/zag-coding-agent/config/settings";
import { loadMnemoConfig, type MnemoBackendConfig } from "@zag/zag-coding-agent/mnemo/config";
import { getMemoriesDir } from "@zag/zag-utils";

// `mnemo.embeddingVariant` selects the concrete local embedding model, while an
// explicit `mnemo.embeddingModel` is an advanced override that wins. Scoping is
// pinned to "global" so the resolver stays pure (no legacy-bank disk probing).
function mnemoConfigFor(overrides: Record<string, unknown>, agentDir = "/tmp/mnemo-config-test"): MnemoBackendConfig {
	const settings = Settings.isolated({ "mnemo.scoping": "global", ...overrides });
	return loadMnemoConfig(settings, agentDir);
}

function embeddingModelFor(overrides: Record<string, unknown>): string | undefined {
	return mnemoConfigFor(overrides).providerOptions.embeddingModel;
}

describe("loadMnemoConfig embedding variant resolution", () => {
	it("maps the en variant to BAAI/bge-base-en-v1.5", () => {
		expect(embeddingModelFor({ "mnemo.embeddingVariant": "en" })).toBe("BAAI/bge-base-en-v1.5");
	});

	it("maps the multilingual variant to intfloat/multilingual-e5-large", () => {
		expect(embeddingModelFor({ "mnemo.embeddingVariant": "multilingual" })).toBe("intfloat/multilingual-e5-large");
	});

	it("lets an explicit embeddingModel override win over the variant", () => {
		expect(
			embeddingModelFor({
				"mnemo.embeddingVariant": "multilingual",
				"mnemo.embeddingModel": "openai/text-embedding-3-small",
			}),
		).toBe("openai/text-embedding-3-small");
	});

	it("ignores a blank override and falls back to the variant", () => {
		expect(embeddingModelFor({ "mnemo.embeddingVariant": "en", "mnemo.embeddingModel": "   " })).toBe(
			"BAAI/bge-base-en-v1.5",
		);
	});

	it("honors MNEMO_EMBEDDING_MODEL when no explicit model setting is present", () => {
		const previous = Bun.env.MNEMO_EMBEDDING_MODEL;
		Bun.env.MNEMO_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5";
		try {
			// The documented env override must not be shadowed by the variant default.
			expect(embeddingModelFor({ "mnemo.embeddingVariant": "en" })).toBe("BAAI/bge-large-en-v1.5");
		} finally {
			if (previous === undefined) delete Bun.env.MNEMO_EMBEDDING_MODEL;
			else Bun.env.MNEMO_EMBEDDING_MODEL = previous;
		}
	});

	it("falls back to MNEMO_EMBEDDING_MODEL when the configured model is blank or null", () => {
		const previous = Bun.env.MNEMO_EMBEDDING_MODEL;
		Bun.env.MNEMO_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5";
		try {
			// Clearing the field in the settings panel must not permanently shadow the env model.
			expect(embeddingModelFor({ "mnemo.embeddingModel": "" })).toBe("BAAI/bge-large-en-v1.5");
			expect(embeddingModelFor({ "mnemo.embeddingModel": "  " })).toBe("BAAI/bge-large-en-v1.5");
			expect(embeddingModelFor({ "mnemo.embeddingModel": null })).toBe("BAAI/bge-large-en-v1.5");
		} finally {
			if (previous === undefined) delete Bun.env.MNEMO_EMBEDDING_MODEL;
			else Bun.env.MNEMO_EMBEDDING_MODEL = previous;
		}
	});

	it("lets an explicit embeddingModel setting win over the env var", () => {
		const previous = Bun.env.MNEMO_EMBEDDING_MODEL;
		Bun.env.MNEMO_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5";
		try {
			expect(embeddingModelFor({ "mnemo.embeddingModel": "openai/text-embedding-3-small" })).toBe(
				"openai/text-embedding-3-small",
			);
		} finally {
			if (previous === undefined) delete Bun.env.MNEMO_EMBEDDING_MODEL;
			else Bun.env.MNEMO_EMBEDDING_MODEL = previous;
		}
	});
});

describe("loadMnemoConfig database path resolution", () => {
	it("resolves a blank dbPath to persistent agent storage", () => {
		const agentDir = "/tmp/mnemo-blank-db-path-test";
		const defaultPath = path.join(getMemoriesDir(agentDir), "mnemo", "mnemo.db");

		expect(mnemoConfigFor({ "mnemo.dbPath": "" }, agentDir).dbPath).toBe(defaultPath);
		expect(mnemoConfigFor({ "mnemo.dbPath": " \t " }, agentDir).dbPath).toBe(defaultPath);
	});
});
