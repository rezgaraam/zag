import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@zag/zag-coding-agent/capability/types";
import { getConfigDirs } from "@zag/zag-coding-agent/config";
import { resolveClaudePaths } from "@zag/zag-coding-agent/config/claude-paths";
import { getUserPath } from "@zag/zag-coding-agent/discovery/helpers";
import { getAgentDir } from "@zag/zag-utils";

describe("ZAG_CONFIG_DIR", () => {
	const original = process.env.ZAG_CONFIG_DIR;
	afterEach(() => {
		if (original === undefined) {
			delete process.env.ZAG_CONFIG_DIR;
		} else {
			process.env.ZAG_CONFIG_DIR = original;
		}
	});

	test("getUserPath resolves the native user scope via getAgentDir (profile-aware)", () => {
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};
		// Native user config follows the active profile through getAgentDir(), not
		// ctx.home, so it stays in sync with builtin.ts and getMCPConfigPath("user").
		// The old behavior joined ctx.home + ".zag/agent" and leaked the default
		// profile's config into every profile.
		expect(getUserPath(ctx, "native", "commands")).toBe(path.join(getAgentDir(), "commands"));
		expect(getUserPath(ctx, "native", "commands")).not.toContain(ctx.home);
	});

	test("getConfigDirs respects ZAG_CONFIG_DIR for user base", () => {
		process.env.ZAG_CONFIG_DIR = ".config/zag";
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".config/zag", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".zag", level: "user" });
	});
});

describe("CLAUDE_CONFIG_DIR", () => {
	const original = process.env.CLAUDE_CONFIG_DIR;
	afterEach(() => {
		if (original === undefined) {
			delete process.env.CLAUDE_CONFIG_DIR;
		} else {
			process.env.CLAUDE_CONFIG_DIR = original;
		}
	});

	test("relocates Claude user discovery and .claude.json together", () => {
		process.env.CLAUDE_CONFIG_DIR = "./fixtures/claude-home";
		const expectedRoot = path.resolve("./fixtures/claude-home");
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};

		expect(resolveClaudePaths(ctx.home)).toEqual({
			configDir: expectedRoot,
			configFile: path.join(expectedRoot, ".claude.json"),
		});
		expect(getUserPath(ctx, "claude", "commands")).toBe(path.join(expectedRoot, "commands"));
		expect(
			getConfigDirs("commands", { user: true, project: false }).find(entry => entry.source === ".claude"),
		).toEqual({ path: path.join(expectedRoot, "commands"), source: ".claude", level: "user" });
	});

	test("keeps the legacy split paths when the override is unset", () => {
		delete process.env.CLAUDE_CONFIG_DIR;
		expect(resolveClaudePaths("/home/tester")).toEqual({
			configDir: path.join("/home/tester", ".claude"),
			configFile: path.join("/home/tester", ".claude.json"),
		});
	});
});
