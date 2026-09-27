import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@zag/zag-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@zag/zag-ai/auth-broker";
import { runAuthBrokerCommand } from "@zag/zag-coding-agent/cli/auth-broker-cli";
import { getAgentDbPath, removeWithRetries, setAgentDir } from "@zag/zag-utils";

const TEAM_ORG = "org-team-1111";

async function runMigrateCapturingStdout(): Promise<string> {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await runAuthBrokerCommand({
			action: "migrate",
			flags: { fromLocal: true, includeOauth: true },
		});
	} finally {
		process.stdout.write = originalWrite;
	}
	return captured;
}

describe("auth-broker migrate (org-only dedupe)", () => {
	let agentDir = "";
	let brokerAgentDir = "";
	let brokerStore: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "broker-migrate-bearer";
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		savedEnv.ZAG_AUTH_BROKER_URL = process.env.ZAG_AUTH_BROKER_URL;
		savedEnv.ZAG_AUTH_BROKER_TOKEN = process.env.ZAG_AUTH_BROKER_TOKEN;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "zag-migrate-client-"));
		brokerAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "zag-migrate-broker-"));
		setAgentDir(agentDir);

		brokerStore = await SqliteAuthCredentialStore.open(path.join(brokerAgentDir, "agent.db"));
		brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.credentials.reload();
		handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		process.env.ZAG_AUTH_BROKER_URL = handle.url;
		process.env.ZAG_AUTH_BROKER_TOKEN = token;
	});

	afterEach(async () => {
		await handle?.close();
		brokerStorage?.close();
		brokerStore?.close();
		await removeWithRetries(agentDir);
		await removeWithRetries(brokerAgentDir);
		for (const key of ["ZAG_AUTH_BROKER_URL", "ZAG_AUTH_BROKER_TOKEN"] as const) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("rerun skips an already-migrated org-only row instead of re-uploading a stale refresh token", async () => {
		// Local row where login recovered neither email nor account: the org id
		// is the only identity the broker snapshot can echo back.
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			await localStore.upsertAuthCredential("anthropic", {
				type: "oauth",
				access: "access-local",
				refresh: "refresh-local-stale",
				expires: Date.now() + 3_600_000,
				orgId: TEAM_ORG,
				orgName: "Team",
			});
		} finally {
			localStore.close();
		}

		const firstRun = await runMigrateCapturingStdout();
		expect(firstRun).toContain("uploaded");
		const uploaded = brokerStore!.getOAuth("anthropic");
		expect(uploaded?.refresh).toBe("refresh-local-stale");
		expect(uploaded?.orgId).toBe(TEAM_ORG);

		// The broker rotates the token after migration — its copy is now newer
		// than the local one.
		await brokerStore!.upsertAuthCredential("anthropic", {
			type: "oauth",
			access: "access-rotated",
			refresh: "refresh-rotated",
			expires: Date.now() + 7_200_000,
			orgId: TEAM_ORG,
			orgName: "Team",
		});
		await brokerStorage!.credentials.reload();

		// Rerun: the org-only row must be recognized as already migrated, not
		// re-uploaded (which would clobber the broker's newer refresh token).
		const secondRun = await runMigrateCapturingStdout();
		expect(secondRun).toContain("already on broker");
		expect(secondRun).toContain("Nothing to migrate");
		const persisted = brokerStore!.getOAuth("anthropic");
		expect(persisted?.refresh).toBe("refresh-rotated");
		expect(brokerStore!.listAuthCredentials("anthropic")).toHaveLength(1);
	});
});
