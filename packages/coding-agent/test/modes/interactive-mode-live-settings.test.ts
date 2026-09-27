import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@zag/zag-agent-core";
import { ModelRegistry } from "@zag/zag-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@zag/zag-coding-agent/config/settings";
import { InteractiveMode } from "@zag/zag-coding-agent/modes/interactive-mode";
import { AgentSession } from "@zag/zag-coding-agent/session/agent-session";
import { AuthStorage } from "@zag/zag-coding-agent/session/auth-storage";
import { SessionManager } from "@zag/zag-coding-agent/session/session-manager";
import { initTheme } from "@zag/zag-tui/theme";
import { TempDir } from "@zag/zag-utils";

import { cfgStatusLineContextLine, cfgStatusLineLeftSegments } from "@zag/zag-coding-agent/modes/settings";
import { cfgHideThinkingBlock } from "@zag/zag-coding-agent/session/settings";

describe("InteractiveMode live settings", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@zag-live-ui-settings-");
		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true, "statusLine.preset": "custom" },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("applies status-line and thinking-visibility changes made outside the settings panel", async () => {
		cfgStatusLineLeftSegments.set(session.settings, ["time", "model"]);
		cfgStatusLineContextLine.set(session.settings, "off");
		cfgHideThinkingBlock.set(session.settings, true);
		await Promise.resolve();

		const effective = mode.statusLine.getEffectiveSettingsForTest();
		expect(effective.leftSegments).toEqual(["time", "model"]);
		expect(effective.contextLine).toBe("off");
		expect(mode.hideThinkingBlock).toBe(true);
	});
});
