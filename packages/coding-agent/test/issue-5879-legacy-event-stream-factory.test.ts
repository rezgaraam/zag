import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadExtensions } from "@zag/zag-coding-agent/extensibility/extensions/loader";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@zag/zag-utils";

describe("issue #5879: legacy provider compatibility", () => {
	it("creates a fresh agent database while loading historical auth exports", async () => {
		const projectDir = TempDir.createSync("@issue-5879-");
		const freshAgentDir = projectDir.join("fresh", "agent");
		const originalDirEnv: Record<string, string | undefined> = {
			ZAG_CODING_AGENT_DIR: process.env.ZAG_CODING_AGENT_DIR,
			ZAG_PROFILE: process.env.ZAG_PROFILE,
		};
		const extensionPath = path.join(projectDir.path(), "zag-provider-like-plugin", "index.ts");
		await Bun.write(
			extensionPath,
			[
				'import { createAssistantMessageEventStream } from "@zag/zag-ai";',
				'import { AuthStorage } from "@zag/zag-coding-agent";',
				"",
				"export default function() {",
				"\tconst stream = createAssistantMessageEventStream();",
				'\tconst credential = AuthStorage.create().get("issue-5879-missing-provider");',
				'\tif (credential !== undefined) throw new Error("Unexpected test credential");',
				'\tif (typeof stream.push !== "function") throw new Error("Invalid assistant message event stream");',
				"}",
			].join("\n"),
		);

		setAgentDir(freshAgentDir);

		try {
			const result = await loadExtensions([extensionPath], projectDir.path());

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			expect(await Bun.file(path.join(freshAgentDir, "agent.db")).exists()).toBe(true);
		} finally {
			for (const key in originalDirEnv) {
				const value = originalDirEnv[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			__resetDirsFromEnvForTests();
			projectDir.removeSync();
		}
	});
});
