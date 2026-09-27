/**
 * Regression: plugin extensions must resolve `@zag/zag-*` imports to the same
 * in-process bundled copy (the shim in `ext-compat.ts`), so plugins observe a
 * single module registry instead of a duplicate from their own node_modules.
 *
 * Reported failures the test covers:
 *   - `@juicesharp/rpiv-ask-user-question` ⇒ `@zag/zag-tui`
 *   - `@plannotator/zag-extension`         ⇒ `@zag/zag-agent-core`
 *   - `@runfusion/fusion`                 ⇒ `@zag/zag-coding-agent/...`
 *
 * Plus the two upstream-only surfaces that turned up via real-plugin E2E:
 *   - `Key` runtime helper from `zag-tui` (used by plannotator + rpiv-*).
 *   - `zag-ai/oauth` subpath (used by runfusion's bundled extension).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@zag/zag-coding-agent/extensibility/extensions/loader";
import { TempDir } from "@zag/zag-utils";

const canonicalCodingAgent = Bun.resolveSync("@zag/zag-coding-agent", import.meta.dir);
const canonicalCodingAgentExtensions = Bun.resolveSync(
	"@zag/zag-coding-agent/extensibility/extensions",
	import.meta.dir,
);
const canonicalUtils = Bun.resolveSync("@zag/zag-utils", import.meta.dir);
const canonicalTui = Bun.resolveSync("@zag/zag-tui", import.meta.dir);
// Subpath: upstream `zag-ai/oauth` re-exported `utils/oauth/index`; our zag-ai now
// exposes the same surface at the real `@zag/zag-ai/oauth` export, so the
// legacy `@zag/zag-ai/oauth` specifier canonicalizes straight to it.
const canonicalAiOauth = Bun.resolveSync("@zag/zag-ai/oauth", import.meta.dir);

interface AliasCase {
	id: string;
	aliasSpecifier: string;
	canonicalPath: string;
	symbol: string;
}

const CASES: readonly AliasCase[] = [
	// Used by @juicesharp/rpiv-* plugins.
	{
		id: "tui",
		aliasSpecifier: "@zag/zag-tui",
		canonicalPath: canonicalTui,
		symbol: "visibleWidth",
	},
	// @zag self-import — canonical scope must still flow through the shim
	// so a duplicate copy is never dragged in from a plugin's own node_modules.
	{ id: "zag-utils", aliasSpecifier: "@zag/zag-utils", canonicalPath: canonicalUtils, symbol: "logger" },
	{
		id: "zag-coding-agent",
		aliasSpecifier: "@zag/zag-coding-agent",
		canonicalPath: canonicalCodingAgent,
		symbol: "isToolCallEventType",
	},
	// Subpath import (regression: issue #973).
	{
		id: "coding-agent-extensions",
		aliasSpecifier: "@zag/zag-coding-agent/extensibility/extensions",
		canonicalPath: canonicalCodingAgentExtensions,
		symbol: "isToolCallEventType",
	},
	// Subpath: legacy `zag-ai/oauth` resolves to the real `@zag/zag-ai/oauth`.
	{
		id: "ai-oauth",
		aliasSpecifier: "@zag/zag-ai/oauth",
		canonicalPath: canonicalAiOauth,
		// `refreshOAuthToken` is exported by our `oauth/index` and by upstream's
		// `oauth.d.ts`; it makes a stable probe across both layouts.
		symbol: "refreshOAuthToken",
	},
	// `Key` runtime helper restored on zag-tui (plannotator + rpiv-* import it).
	{
		id: "tui-key",
		aliasSpecifier: "@zag/zag-tui",
		canonicalPath: canonicalTui,
		symbol: "Key",
	},
];

describe("zag-* scope aliases", () => {
	let projectDir: TempDir;
	let extensionPath: string;

	beforeEach(() => {
		projectDir = TempDir.createSync("@zag-scope-aliases-");
		const pluginDir = path.join(projectDir.path(), "alias-probe-plugin");
		extensionPath = path.join(pluginDir, "dist", "extension.ts");
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "alias-probe-plugin",
				version: "1.0.0",
				zag: { extensions: ["./dist/extension.ts"] },
			}),
		);

		// Each case imports the same symbol via the aliased scope and via the
		// resolved canonical absolute path. The default factory throws unless the
		// two are object-identical, proving they came from a single module
		// instance.
		const lines: string[] = [];
		const checks: string[] = [];
		for (const [idx, c] of CASES.entries()) {
			lines.push(`import { ${c.symbol} as alias${idx} } from "${c.aliasSpecifier}";`);
			lines.push(`import { ${c.symbol} as canonical${idx} } from ${JSON.stringify(c.canonicalPath)};`);
			checks.push(
				`if (alias${idx} !== canonical${idx}) throw new Error(${JSON.stringify(
					`${c.aliasSpecifier} did not remap to the bundled copy (case ${c.id})`,
				)});`,
			);
		}

		fs.writeFileSync(
			extensionPath,
			[...lines, "", ...checks, "", "export default function(zag) {", "\t/* no-op */", "}"].join("\n"),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
	});

	it("remaps every aliased zag-* scope and known upstream subpath to the bundled in-process copy", async () => {
		const result = await loadExtensions([extensionPath], projectDir.path());
		expect(result.errors).toEqual([]);
		const extension = result.extensions.find(ext => ext.path === extensionPath);
		expect(extension).toBeDefined();
	});
});
