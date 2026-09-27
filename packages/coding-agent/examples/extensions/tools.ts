/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Tool selection persists across session reloads and respects branch navigation.
 *
 * Usage:
 * 1. Copy this file to ~/.zag/agent/extensions/ or your project's .zag/extensions/
 * 2. Use /tools to open the tool selector
 */
import type { ExtensionAPI, ExtensionContext } from "@zag/zag-coding-agent";
import { getSettingsListTheme } from "@zag/zag-coding-agent";
import { Container, type SettingItem, SettingsList } from "@zag/zag-tui";

// State persisted to session
interface ToolsState {
	enabledTools: string[];
}

export default function toolsExtension(zag: ExtensionAPI) {
	// Track enabled tools
	let enabledTools: Set<string> = new Set();
	let allTools: string[] = [];

	// Persist current state
	function persistState() {
		zag.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	// Apply current tool selection
	async function applyTools() {
		await zag.setActiveTools(Array.from(enabledTools));
	}

	// Find the last tools-config entry in the current branch
	async function restoreFromBranch(ctx: ExtensionContext) {
		allTools = zag.getAllTools().map(t => t.name);

		// Get entries in current branch only
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && (entry as { customType?: string }).customType === "tools-config") {
				const data = (entry as { data?: ToolsState }).data;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		if (savedTools) {
			// Restore saved tool selection (filter to only tools that still exist)
			enabledTools = new Set(savedTools.filter((t: string) => allTools.includes(t)));
			await applyTools();
		} else {
			// No saved state - sync with currently active tools
			enabledTools = new Set(zag.getActiveTools());
		}
	}

	// Register /tools command
	zag.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			// Refresh tool list
			allTools = zag.getAllTools().map(t => t.name);

			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				// Build settings items for each tool
				const items: SettingItem[] = allTools.map(tool => ({
					id: tool,
					label: tool,
					currentValue: enabledTools.has(tool) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				const header: readonly string[] = [theme.fg("accent", theme.bold("Tool Configuration")), ""];
				container.addChild(
					new (class {
						render(_width: number): readonly string[] {
							return header;
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Update enabled state and apply immediately
						if (newValue === "enabled") {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						applyTools();
						persistState();
					},
					() => {
						// Close dialog
						done(undefined);
					},
				);

				container.addChild(settingsList);

				const component = {
					render(width: number): readonly string[] {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	// Restore state on session start
	zag.on("session_start", async (_event, ctx) => {
		await restoreFromBranch(ctx);
	});

	// Restore state when navigating the session tree
	zag.on("session_tree", async (_event, ctx) => {
		await restoreFromBranch(ctx);
	});

	// Restore state after branching
	zag.on("session_branch", async (_event, ctx) => {
		await restoreFromBranch(ctx);
	});
}
