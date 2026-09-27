/**
 * Git Checkpoint Hook
 *
 * Creates git stash checkpoints at each turn so /branch can restore code state.
 * When branching, offers to restore code to that point in history.
 */
import type { HookAPI } from "@zag/zag-coding-agent";

export default function (zag: HookAPI) {
	const checkpoints = new Map<string, string>();
	let currentEntryId: string | undefined;

	// Track the current entry ID when user messages are saved
	zag.on("tool_result", async (_event, ctx) => {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) currentEntryId = leaf.id;
	});

	zag.on("turn_start", async () => {
		// Create a git stash entry before LLM makes changes
		const { stdout } = await zag.exec("git", ["stash", "create"]);
		const ref = stdout.trim();
		if (ref && currentEntryId) {
			checkpoints.set(currentEntryId, ref);
		}
	});

	zag.on("session_before_branch", async (event, ctx) => {
		const ref = checkpoints.get(event.entryId);
		if (!ref) return;

		if (!ctx.hasUI) {
			// In non-interactive mode, don't restore automatically
			return;
		}

		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);

		if (choice?.startsWith("Yes")) {
			await zag.exec("git", ["stash", "apply", ref]);
			ctx.ui.notify("Code restored to checkpoint", "info");
		}
	});

	zag.on("agent_end", async () => {
		// Clear checkpoints after agent completes
		checkpoints.clear();
	});
}
