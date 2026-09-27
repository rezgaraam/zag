import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@zag/zag-coding-agent/extensibility/extensions/loader";
import { TempDir } from "@zag/zag-utils";

const currentZagCodingAgentPath = Bun.resolveSync("@zag/zag-coding-agent", import.meta.dir);
const currentZagExtensionsPath = Bun.resolveSync("@zag/zag-coding-agent/extensibility/extensions", import.meta.dir);

describe("issue #973: legacy Zag plugin imports", () => {
	let projectDir: TempDir;
	let extensionPath: string;

	beforeEach(() => {
		projectDir = TempDir.createSync("@issue-973-");
		const pluginDir = path.join(projectDir.path(), "ext-compat-plugin");
		extensionPath = path.join(pluginDir, "dist", "extension.ts");
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "ext-compat-plugin",
				version: "1.0.0",
				zag: {
					extensions: ["./dist/extension.ts"],
				},
			}),
		);
		fs.writeFileSync(
			extensionPath,
			[
				'import { isToolCallEventType as legacyRoot } from "@zag/zag-coding-agent";',
				'import { isToolCallEventType as legacyExtensions } from "@zag/zag-coding-agent/extensibility/extensions";',
				`import { isToolCallEventType as modernRoot } from ${JSON.stringify(currentZagCodingAgentPath)};`,
				`import { isToolCallEventType as modernExtensions } from ${JSON.stringify(currentZagExtensionsPath)};`,
				"",
				'if (legacyRoot !== modernRoot) throw new Error("legacy root import did not remap");',
				'if (legacyExtensions !== modernExtensions) throw new Error("legacy extension import did not remap");',
				"",
				"export default function(zag) {",
				'\tzag.registerCommand("ext-compat-ext", { handler: async () => {} });',
				"}",
			].join("\n"),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
	});

	it("loads plugin extensions that import @zag packages", async () => {
		const result = await loadExtensions([extensionPath], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		expect(result.errors).toEqual([]);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("ext-compat-ext")).toBe(true);
	});
});
