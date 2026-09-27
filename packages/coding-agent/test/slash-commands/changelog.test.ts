import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as config from "@zag/zag-coding-agent/config";
import type { InteractiveModeContext } from "@zag/zag-coding-agent/modes/types";
import { executeAcpBuiltinSlashCommand } from "@zag/zag-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@zag/zag-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@zag/zag-coding-agent/slash-commands/types";
import {
	CHANGELOG_COMMAND_USAGE,
	getChangelogPath,
	parseChangelog,
	RECENT_CHANGELOG_ENTRY_LIMIT,
} from "@zag/zag-coding-agent/utils/changelog";

function versionHeadings(markdown: string): string[] {
	return markdown.match(/^## \[[^\]]+\]/gm) ?? [];
}

function acpRuntime() {
	const chunks: string[] = [];
	const output = vi.fn((text: string) => {
		chunks.push(text);
	});
	const runtime = { output } as unknown as SlashCommandRuntime;
	return { chunks, output, runtime };
}

describe("/changelog", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows the recent default, one release for bare last, and N releases for last N", async () => {
		// Synthetic history with more releases than the recent default shows.
		const releases = Array.from({ length: RECENT_CHANGELOG_ENTRY_LIMIT + 3 }, (_, i) => {
			const minor = RECENT_CHANGELOG_ENTRY_LIMIT + 3 - i;
			return `## [1.${minor}.0] - 2026-09-${String(10 + i).padStart(2, "0")}\n\n### Fixed\n\n- Fixed thing ${minor}.\n`;
		});
		const changelogPath = path.join(os.tmpdir(), `zag-changelog-${process.pid}.md`);
		await Bun.write(changelogPath, `# Changelog\n\n## [Unreleased]\n\n${releases.join("\n")}`);
		vi.spyOn(config, "getChangelogPath").mockReturnValue(changelogPath);
		const all = await parseChangelog(getChangelogPath());
		expect(all.length).toBeGreaterThan(RECENT_CHANGELOG_ENTRY_LIMIT);

		const recent = acpRuntime();
		await executeAcpBuiltinSlashCommand("/changelog", recent.runtime);
		expect(versionHeadings(recent.chunks.join("\n"))).toEqual(
			all
				.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT)
				.map(entry => `## [${entry.major}.${entry.minor}.${entry.patch}]`)
				.reverse(),
		);

		const last = acpRuntime();
		await executeAcpBuiltinSlashCommand("/changelog last", last.runtime);
		expect(versionHeadings(last.chunks.join("\n"))).toEqual([
			`## [${all[0]!.major}.${all[0]!.minor}.${all[0]!.patch}]`,
		]);

		const lastTwo = acpRuntime();
		await executeAcpBuiltinSlashCommand("/changelog last 2", lastTwo.runtime);
		expect(versionHeadings(lastTwo.chunks.join("\n"))).toEqual(
			all
				.slice(0, 2)
				.map(entry => `## [${entry.major}.${entry.minor}.${entry.patch}]`)
				.reverse(),
		);

		const full = acpRuntime();
		await executeAcpBuiltinSlashCommand("/changelog full", full.runtime);
		expect(versionHeadings(full.chunks.join("\n")).length).toBe(all.length);
	});

	it("rejects a zero count and unknown subcommands", async () => {
		for (const text of ["/changelog last 0", "/changelog yesterday"]) {
			const h = acpRuntime();
			await executeAcpBuiltinSlashCommand(text, h.runtime);
			expect(h.chunks.join("\n")).toContain(text.endsWith("0") ? "positive integer" : CHANGELOG_COMMAND_USAGE);
		}
	});

	it("forwards TUI args and clears the editor", async () => {
		const handleChangelogCommand = vi.fn(async () => {});
		const setText = vi.fn();
		const runtime = {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleChangelogCommand,
			} as unknown as InteractiveModeContext,
		};

		expect(await executeBuiltinSlashCommand("/changelog last 3", runtime)).toBe(true);
		expect(handleChangelogCommand).toHaveBeenCalledWith("last 3");
		expect(setText).toHaveBeenCalledWith("");
	});
});
