import { describe, expect, it } from "bun:test";
import {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isWriteToolResult,
	type ToolResultEvent,
} from "@zag/zag-coding-agent/extensibility/ext-compat-coding-agent-shim";

// Issue #8161: zag-lean-ctx@3.9.18 imports `isEditToolResult`/`isWriteToolResult`
// from `@zag/zag-coding-agent`, which aliases to this shim. The shim's
// `export * from "../index"` never forwarded the `is<Tool>ToolResult` guard
// family (dropped from the public API in 10.2.3), so a named import threw Bun's
// static "Export named X not found" error and aborted `zag install`.

function resultEvent(toolName: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "call-1",
		input: {},
		content: [],
		isError: false,
		toolName,
		details: undefined,
	};
}

describe("legacy shim tool-result guards", () => {
	it("narrows a tool_result event by tool name", () => {
		expect(isEditToolResult(resultEvent("edit"))).toBe(true);
		expect(isEditToolResult(resultEvent("write"))).toBe(false);

		expect(isWriteToolResult(resultEvent("write"))).toBe(true);
		expect(isWriteToolResult(resultEvent("edit"))).toBe(false);

		expect(isBashToolResult(resultEvent("bash"))).toBe(true);
		expect(isReadToolResult(resultEvent("read"))).toBe(true);
		expect(isGrepToolResult(resultEvent("grep"))).toBe(true);
		expect(isFindToolResult(resultEvent("find"))).toBe(true);
		expect(isLsToolResult(resultEvent("ls"))).toBe(true);
		expect(isFindToolResult(resultEvent("ls"))).toBe(false);
		expect(isLsToolResult(resultEvent("find"))).toBe(false);

		expect(isBashToolResult(resultEvent("read"))).toBe(false);
	});
});
