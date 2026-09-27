import type { CustomToolFactory } from "@zag/zag-coding-agent";

const factory: CustomToolFactory = zag => ({
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	parameters: zag.zod.object({
		name: zag.zod.string().describe("Name to greet"),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		const { name } = params;
		return {
			content: [{ type: "text", text: `Hello, ${name}!` }],
			details: { greeted: name },
		};
	},
});

export default factory;
