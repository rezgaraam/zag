import { describe, expect, it } from "bun:test";
import * as ZagCodingAgent from "@zag/zag-coding-agent";
import { askToolRenderer } from "@zag/zag-tui/tools/ask";

/**
 * Issue #12680: 0d6dbd32 moved the ask renderer into @zag/zag-tui, so
 * extensions that shadow the built-in ask tool can no longer reach the native
 * renderer through the injected zag.zag namespace. Extensions receive the root
 * barrel of this package as zag.zag, so this pins the re-export there.
 */
describe("askToolRenderer reachability from extensions (issue #12680)", () => {
	const namespace = ZagCodingAgent as Record<string, unknown>;

	it("re-exports the ask renderer from the root barrel", () => {
		expect(namespace.askToolRenderer).toBe(askToolRenderer);
	});

	it("carries the render surface shadow-ask extensions consumed before the zag-tui migration", () => {
		const renderer = namespace.askToolRenderer as typeof askToolRenderer | undefined;
		expect(renderer).toBeDefined();
		expect(typeof renderer?.renderCall).toBe("function");
		expect(typeof renderer?.renderResult).toBe("function");
		expect(renderer?.mergeCallAndResult).toBe(true);
	});
});
