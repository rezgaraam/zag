/**
 * Regression for https://github.com/rezgaraam/zag/issues/12067
 *
 * Headless `zag -p` could exit successfully with no output while first-turn
 * mnemo recall awaited an embedding response. The embeddings subprocess was
 * unref'd while idle, and a pending Promise is not an event-loop handle. Keep
 * the worker referenced for the exact lifetime of each pending request so the
 * caller can receive its result, then unref it again for interactive/daemon
 * shutdown behavior.
 */
import { describe, expect, it } from "bun:test";
import { MnemoEmbedClient, type MnemoEmbedWorkerHandle } from "@zag/zag-coding-agent/mnemo/embed-client";
import type { MnemoEmbedWorkerInbound, MnemoEmbedWorkerOutbound } from "@zag/zag-coding-agent/mnemo/embed-protocol";

class DelayedEmbedWorker implements MnemoEmbedWorkerHandle {
	readonly firstRequest = Promise.withResolvers<MnemoEmbedWorkerInbound>();
	readonly secondRequest = Promise.withResolvers<MnemoEmbedWorkerInbound>();
	refCalls = 0;
	unrefCalls = 0;
	#requestCount = 0;
	#messageHandler: ((message: MnemoEmbedWorkerOutbound) => void) | undefined;

	send(message: MnemoEmbedWorkerInbound): void {
		(this.#requestCount++ === 0 ? this.firstRequest : this.secondRequest).resolve(message);
	}

	onMessage(handler: (message: MnemoEmbedWorkerOutbound) => void): () => void {
		this.#messageHandler = handler;
		return () => {
			if (this.#messageHandler === handler) this.#messageHandler = undefined;
		};
	}

	onError(): () => void {
		return () => {};
	}

	ref(): void {
		this.refCalls += 1;
	}

	unref(): void {
		this.unrefCalls += 1;
	}

	emit(message: MnemoEmbedWorkerOutbound): void {
		this.#messageHandler?.(message);
	}

	async terminate(): Promise<void> {
		this.#messageHandler = undefined;
	}
}

describe("issue #12067 — pending mnemo requests keep print mode alive", () => {
	it("references the embed worker until first-turn recall receives its result", async () => {
		const worker = new DelayedEmbedWorker();
		const client = new MnemoEmbedClient(() => worker);

		try {
			const initializing = client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
			const init = await worker.firstRequest.promise;

			expect(init.type).toBe("init");
			expect(worker.refCalls).toBe(1);
			expect(worker.unrefCalls).toBe(0);

			worker.emit({ type: "ready", id: init.id });
			const model = await initializing;
			expect(model).not.toBeNull();
			expect(worker.unrefCalls).toBe(1);

			const embedding = (async () => {
				for await (const vectors of model!.embed(["recall query"])) return vectors;
				throw new Error("embedding worker returned no vectors");
			})();
			const embed = await worker.secondRequest.promise;

			expect(embed.type).toBe("embed");
			expect(worker.refCalls).toBe(2);
			expect(worker.unrefCalls).toBe(1);
			worker.emit({ type: "vectors", id: embed.id, vectors: [[0.25, 0.75]] });

			expect(await embedding).toEqual([[0.25, 0.75]]);
			expect(worker.unrefCalls).toBe(2);
		} finally {
			await client.terminate();
		}
	});
});
