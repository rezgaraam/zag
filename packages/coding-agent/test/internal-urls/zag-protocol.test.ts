import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@zag/zag-coding-agent/internal-urls";

describe("ZagProtocolHandler", () => {
	it("treats zag://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("zag://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("zag://tools/read.md");
		const prefixed = await router.resolve("zag://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});
});
