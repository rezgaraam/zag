import { STREAM_AUTH_ENV, STREAM_AUTH_PROVIDER } from "@zag/zag-wire";
import { discoverAuthStorage } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";

/**
 * Bearer credential presented to Stencil services (`zag stream`, `zag clip`,
 * `zag skill`).
 *
 * `STENCIL_API_KEY` wins outright (debug and CI: `STENCIL_API_KEY=test zag
 * stream …`); otherwise the stencil.so credential stored by `/login` is used
 * and re-resolved on every call so a refreshed access token is sent after a
 * reconnect. `resolve()` returns null when neither exists.
 */
export class StencilCredential {
	#storage?: AuthStorage;

	async resolve(): Promise<string | null> {
		const fromEnv = process.env[STREAM_AUTH_ENV]?.trim();
		if (fromEnv) return fromEnv;
		this.#storage ??= await discoverAuthStorage();
		const token = await this.#storage.keys.get(STREAM_AUTH_PROVIDER);
		return token?.trim() || null;
	}

	/** Human guidance for a missing credential. */
	static get missingMessage(): string {
		return `a stencil.so account is required: run zag and use /login → Stencil, or set ${STREAM_AUTH_ENV}`;
	}

	close(): void {
		this.#storage?.close();
		this.#storage = undefined;
	}
}
