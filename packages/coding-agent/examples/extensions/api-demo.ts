/**
 * API Demo Extension
 *
 * Demonstrates using ExtensionAPI's logger, injected schema builder, and zag
 * module access.
 */
import type { ExtensionAPI } from "@zag/zag-coding-agent";

export default function (zag: ExtensionAPI) {
	const z = zag.zod;

	// Access the logger for debugging
	zag.logger.debug("API demo extension loaded");

	zag.registerTool({
		name: "api_demo",
		label: "API Demo",
		description: "Demonstrates ExtensionAPI capabilities: logger, schema validation, and zag module access",
		parameters: z.object({
			message: z.string().describe("Test message"),
			logLevel: z.enum(["error", "warn", "debug"]).default("debug").describe("Log level to use"),
		}),

		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const { message, logLevel } = params;

			// Use logger at specified level
			zag.logger[logLevel]("API demo tool executed", { message, logLevel });

			// Access zag module utilities
			const { logger: zagLogger } = zag.zag;
			zagLogger.debug("Accessed zag module from extension", { sessionFile: ctx.sessionManager.getSessionFile() });

			// Get session information
			const sessionInfo = `Session: ${ctx.sessionManager.getSessionFile()}`;
			const modelInfo = ctx.model ? `Model: ${ctx.model.id}` : "Model: none";

			return {
				content: [
					{
						type: "text",
						text: [
							`API Demo Tool executed successfully!`,
							``,
							`Message: ${message}`,
							`Log Level: ${logLevel}`,
							``,
							`Features demonstrated:`,
							`1. ✓ Logger access via zag.logger`,
							`2. ✓ Schema builder access via zag.arktype`,
							`3. ✓ Zag module access via zag.zag`,
							``,
							`Context:`,
							`- ${sessionInfo}`,
							`- ${modelInfo}`,
							`- CWD: ${ctx.cwd}`,
						].join("\n"),
					},
				],
				details: {
					message,
					logLevel,
					sessionFile: ctx.sessionManager.getSessionFile(),
					modelId: ctx.model?.id,
				},
			};
		},
	});

	// Demonstrate event handling with logger
	zag.on("session_start", async () => {
		zag.logger.debug("Session started", { extension: "api-demo" });
	});

	zag.on("agent_start", async () => {
		zag.logger.debug("Agent started", { extension: "api-demo" });
	});
}
