import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ZagCodingAgent from "@zag/zag-coding-agent";
import { loadCustomCommands } from "@zag/zag-coding-agent/extensibility/custom-commands/loader";
import { loadCustomTools } from "@zag/zag-coding-agent/extensibility/custom-tools/loader";
import { loadExtensions } from "@zag/zag-coding-agent/extensibility/extensions/loader";
import { loadHooks } from "@zag/zag-coding-agent/extensibility/hooks/loader";
import { TempDir } from "@zag/zag-utils";

declare global {
	var __zagHostZagForLoaderIdentityTest: typeof ZagCodingAgent | undefined;
}

describe("extension loader host runtime binding", () => {
	let projectDir: TempDir | undefined;

	beforeEach(() => {
		projectDir = TempDir.createSync("@loader-host-runtime-");
		globalThis.__zagHostZagForLoaderIdentityTest = ZagCodingAgent;
	});

	afterEach(() => {
		projectDir?.removeSync();
		projectDir = undefined;
		globalThis.__zagHostZagForLoaderIdentityTest = undefined;
	});

	function writeModule(relativePath: string, source: string): string {
		expect(projectDir).toBeDefined();
		const modulePath = path.join(projectDir!.path(), relativePath);
		fs.mkdirSync(path.dirname(modulePath), { recursive: true });
		fs.writeFileSync(modulePath, source);
		return modulePath;
	}

	const identityGuard = `
		const expectedZag = globalThis.__zagHostZagForLoaderIdentityTest;
		if (!expectedZag) throw new Error("missing host zag module");
		if (api.zag !== expectedZag) throw new Error("injected zag module did not match host module");
	`;

	it("passes the in-process host zag module through every loader API", async () => {
		expect(projectDir).toBeDefined();
		const cwd = projectDir!.path();

		// Write every module before any loader runs: Bun's resolver caches
		// directory entries process-wide, so a file created in `cwd` after the
		// first module resolution there is invisible to later dynamic imports.
		const extensionPath = writeModule(
			"extension.ts",
			`
				export default function(api) {
					${identityGuard}
					api.registerCommand("identity_extension", { handler: async () => {} });
				}
			`,
		);
		const toolPath = writeModule(
			"tool.ts",
			`
				export default function(api) {
					${identityGuard}
					return {
						name: "identity_tool",
						label: "Identity Tool",
						description: "Asserts injected zag identity",
						parameters: api.zod.object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
					};
				}
			`,
		);
		const agentDir = path.join(cwd, "agent");
		const commandPath = writeModule(
			path.join("agent", "commands", "identity", "index.ts"),
			`
				export default function(api) {
					${identityGuard}
					return {
						name: "identity_command",
						description: "Asserts injected zag identity",
						execute: () => "ok",
					};
				}
			`,
		);
		const hookPath = writeModule(
			"hook.ts",
			`
				export default function(api) {
					${identityGuard}
					api.on("identity:event", async () => "ok");
				}
			`,
		);

		const extensionResult = await loadExtensions([extensionPath], cwd);
		expect(extensionResult.errors).toEqual([]);
		expect(extensionResult.extensions).toHaveLength(1);
		expect(extensionResult.extensions[0].commands.has("identity_extension")).toBe(true);

		const toolResult = await loadCustomTools([{ path: toolPath }], cwd, []);
		expect(toolResult.errors).toEqual([]);
		expect(toolResult.tools.map(tool => tool.tool.name)).toEqual(["identity_tool"]);

		const commandResult = await loadCustomCommands({ cwd, agentDir });
		expect(commandResult.errors.filter(error => error.path === commandPath)).toEqual([]);
		expect(commandResult.commands.some(command => command.command.name === "identity_command")).toBe(true);

		const hookResult = await loadHooks([hookPath], cwd);
		expect(hookResult.errors).toEqual([]);
		expect(hookResult.hooks).toHaveLength(1);
		expect(hookResult.hooks[0].handlers.has("identity:event")).toBe(true);
	});
});
