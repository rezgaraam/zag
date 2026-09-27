import { describe, expect, it } from "bun:test";
import { ptree, TempDir } from "@zag/zag-utils";

describe("bundled extension modules", () => {
	it("observes active host theme changes and native default/named exports", async () => {
		using dir = TempDir.createSync("zag-bundled-extension-");
		const entry = dir.join("extension.ts");
		await Bun.write(
			entry,
			[
				'import { theme } from "@zag/zag-tui/theme";',
				'import format, { double } from "@zag/zag-utils/virtual-fixture";',
				"export { theme };",
				'export function render() { return theme.fg("accent", "extension"); }',
				"export function describe(value) { return format(double(value)); }",
			].join("\n"),
		);
		const themePath = import.meta.resolve("../../../tui/src/theme/theme.ts");
		const loaderPath = import.meta.resolve("../../../tui/src/theme/loader.ts");
		const compatPath = import.meta.resolve("../../src/extensibility/plugins/ext-compat.ts");
		const result = await ptree.exec(
			[
				process.execPath,
				"-e",
				`
import * as host from ${JSON.stringify(themePath)};
import { loadThemeSync } from ${JSON.stringify(loaderPath)};
import { installExtCompatSpecifierShim, loadExtCompatModule } from ${JSON.stringify(compatPath)};
Bun.plugin({
	name: "bundled-extension-fixture",
	setup(build) {
		build.module("zag-ext-compat-modules", () => ({
			loader: "object",
			exports: {
				BUNDLED_ZAG_MODULE_LOADERS: {
					"@zag/zag-tui/theme": async () => host,
					"@zag/zag-utils/virtual-fixture": async () => ({
						default: value => "value=" + value,
						double: value => value * 2,
					}),
					"unused": async () => { throw new Error("unrelated host module evaluated"); },
				},
			},
		}));
	},
});
installExtCompatSpecifierShim();
const extension = await loadExtCompatModule(${JSON.stringify(entry)});
const notifications = [];
const unsubscribe = host.onThemeChange(() => {
	notifications.push(extension.theme === host.theme);
});
host.initThemeSync();
const initialized = extension.theme === host.theme;
host.setThemeInstance(loadThemeSync("dark"));
const before = extension.render();
const previousTheme = extension.theme;
host.setThemeInstance(loadThemeSync("light"));
const after = extension.render();
unsubscribe();
console.log(JSON.stringify({
	initialized,
	changed: before !== after,
	matchesHost: after === host.theme.fg("accent", "extension"),
	liveIdentity: extension.theme === host.theme && previousTheme !== extension.theme,
	uiNotifications: notifications,
	formatted: extension.describe(21),
}));
`,
			],
			{
				env: { ...Bun.env, ZAG_BUNDLED: "1", ZAG_TEST_RUNTIME: "1", ZAG_CODING_AGENT_DIR: dir.join("agent") },
				timeout: 15_000,
				allowNonZero: true,
			},
		);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			initialized: true,
			changed: true,
			matchesHost: true,
			liveIdentity: true,
			uiNotifications: [true, true],
			formatted: "value=42",
		});
	});
});
