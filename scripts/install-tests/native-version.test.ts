import { describe, expect, it } from "bun:test";
import { nativeVersionFromExports } from "./native-version";

describe("native addon release sentinel", () => {
	it("normalizes the unique version sentinel", () => {
		expect(nativeVersionFromExports(["load", "__zagNativesV17_2_6", "other"])).toBe("17.2.6");
	});

	it("rejects missing or ambiguous sentinels", () => {
		expect(nativeVersionFromExports(["load"])).toBeUndefined();
		expect(nativeVersionFromExports(["__zagNativesV17_2_6", "__zagNativesV17_2_7"])).toBeUndefined();
	});
});
