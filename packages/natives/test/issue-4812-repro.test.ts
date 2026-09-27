/**
 * Repro for https://github.com/rezgaraam/zag/issues/4812
 *
 * A long-lived zag session that survives an in-place `bun install -g` upgrade
 * keeps the previous zag-natives NAPI addon resident in the process. A tab
 * worker spawned afterwards runs the freshly-installed JS loader, which expects
 * the new sentinel (e.g. `__zagNativesV16_3_11`), but `require` returns the
 * resident old exports carrying the PRIOR sentinel (`__zagNativesV16_3_10`).
 *
 * The contract this test pins down: `validateLoadedBindings` distinguishes a
 * process-stale mix (disk consistent — restart to re-sync) from a genuinely
 * disk-stale addon (reinstall to re-sync), and chooses restart only when the
 * selected file itself carries the expected sentinel.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateLoadedBindings } from "../native/loader-state.js";

const unusedCandidate =
	"/home/u/.bun/install/global/node_modules/@zag/zag-natives-linux-x64/zag_natives.linux-x64.node";

async function withCandidate(contents: string, test: (candidate: string) => void) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zag-natives-sentinel-"));
	const candidate = path.join(dir, "zag_natives.node");
	try {
		await fs.writeFile(candidate, contents);
		test(candidate);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function ctxFor(version: string) {
	return {
		isWorkspaceLoad: false,
		packageVersion: version,
		versionSentinelExport: `__zagNativesV${version.replace(/[^A-Za-z0-9]/g, "_")}`,
	};
}

describe("issue 4812: zag-natives sentinel process-stale diagnosis", () => {
	it("accepts bindings that expose the expected sentinel", () => {
		const ctx = ctxFor("16.3.11");
		expect(() =>
			validateLoadedBindings(ctx, { __zagNativesV16_3_11: () => {}, grep: () => {} }, unusedCandidate),
		).not.toThrow();
	});

	it("reports a mid-session upgrade (restart) only when disk has the expected sentinel", async () => {
		const ctx = ctxFor("16.3.11");
		const resident = { __zagNativesV16_3_10: () => {}, grep: () => {} };
		await withCandidate("__zagNativesV16_3_11", candidate => {
			expect(() => validateLoadedBindings(ctx, resident, candidate)).toThrow("16.3.10");
			expect(() => validateLoadedBindings(ctx, resident, candidate)).toThrow("restart zag");
			expect(() => validateLoadedBindings(ctx, resident, candidate)).toThrow("Disk is already consistent");
			expect(() => validateLoadedBindings(ctx, resident, candidate)).not.toThrow("reinstall to re-sync");
		});
	});

	it("reports disk-stale (reinstall) when an old addon exposes a prior sentinel", async () => {
		const ctx = ctxFor("16.3.11");
		const stale = { __zagNativesV16_3_10: () => {}, grep: () => {} };
		await withCandidate("__zagNativesV16_3_10", candidate => {
			expect(() => validateLoadedBindings(ctx, stale, candidate)).toThrow(
				"from a different release than this loader",
			);
			expect(() => validateLoadedBindings(ctx, stale, candidate)).toThrow("reinstall to re-sync");
			expect(() => validateLoadedBindings(ctx, stale, candidate)).not.toThrow("restart zag");
		});
	});

	it("skips validation entirely in workspace dev", () => {
		const ctx = { ...ctxFor("16.3.11"), isWorkspaceLoad: true };
		expect(() => validateLoadedBindings(ctx, { grep: () => {} }, unusedCandidate)).not.toThrow();
	});
});
