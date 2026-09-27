import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, ApiKey, Model } from "@zag/zag-ai";

export type MnemoLlmCompletionTask = {
	kind: "memory-extraction";
	input: string;
};

export interface MnemoLlmCompleteOptions {
	maxTokens?: number;
	temperature?: number;
	timeout?: number;
	provider?: string | null;
	model?: string | null;
	task?: MnemoLlmCompletionTask;
}

export type MnemoLlmCompletion = (
	prompt: string,
	opts?: MnemoLlmCompleteOptions,
) => string | null | Promise<string | null>;

/**
 * What an embedding provider's `embed` returns: the embedding matrix streamed as async batches,
 * matching fastembed's `embed()` (`AsyncGenerator<number[][]>`). Each yielded batch is a list of
 * rows; each row is one number per dimension. Yield the whole matrix as a single batch when not
 * streaming: `async *embed(texts) { yield texts.map(embedOne); }`.
 */
export type EmbeddingOutput = AsyncIterable<number[][]>;

export interface MnemoEmbeddingProvider {
	embed(texts: readonly string[]): EmbeddingOutput | Promise<EmbeddingOutput>;
	available?(): boolean | Promise<boolean>;
}

export interface MnemoEmbeddingRuntimeOptions {
	disabled?: boolean;
	model?: string;
	apiUrl?: string;
	apiKey?: ApiKey;
	provider?: MnemoEmbeddingProvider | ((texts: readonly string[]) => EmbeddingOutput | Promise<EmbeddingOutput>);
	/** Override `MNEMO_EMBEDDING_MAX_INPUT_CHARS`. `0` disables the cap. See `config.embeddingMaxInputChars`. */
	maxInputChars?: number;
}

export interface MnemoLlmRuntimeOptions {
	enabled?: boolean;
	baseUrl?: string;
	apiKey?: ApiKey;
	model?: string | Model<Api>;
	maxTokens?: number;
	complete?: MnemoLlmCompletion;
	/** Override the fact-extraction prompt template ({text}/{lang}). Used to feed small local models a friendlier format. */
	extractionPrompt?: string;
	/** Override the consolidation/sleep prompt template ({memories}/{source}/{memory_count}). */
	consolidationPrompt?: string;
}

export interface MnemoRuntimeOptions {
	embeddings?: false | MnemoEmbeddingRuntimeOptions;
	llm?: false | MnemoLlmRuntimeOptions | Model<Api> | MnemoLlmCompletion;
	/** Verbose diagnostics: escalates best-effort failure logs from debug to warn. */
	debug?: boolean;
}

export interface ResolvedMnemoEmbeddingRuntimeOptions {
	disabled?: boolean;
	model?: string;
	apiUrl?: string;
	apiKey?: ApiKey;
	provider?: MnemoEmbeddingProvider;
	maxInputChars?: number;
}

export interface ResolvedMnemoLlmRuntimeOptions {
	enabled?: boolean;
	baseUrl?: string;
	apiKey?: ApiKey;
	model?: string | Model<Api>;
	maxTokens?: number;
	complete?: MnemoLlmCompletion;
	extractionPrompt?: string;
	consolidationPrompt?: string;
}

export interface ResolvedMnemoRuntimeOptions {
	embeddings?: ResolvedMnemoEmbeddingRuntimeOptions;
	llm?: ResolvedMnemoLlmRuntimeOptions;
	debug?: boolean;
}

const runtimeOptionsStorage = new AsyncLocalStorage<ResolvedMnemoRuntimeOptions>();

export function withMnemoRuntimeOptions<T>(options: ResolvedMnemoRuntimeOptions | undefined, fn: () => T): T {
	if (options === undefined) {
		return fn();
	}
	return runtimeOptionsStorage.run(options, fn);
}

export function getMnemoRuntimeOptions(): ResolvedMnemoRuntimeOptions | undefined {
	return runtimeOptionsStorage.getStore();
}

/** Whether the active runtime scope requested verbose diagnostics (`mnemo.debug`). */
export function mnemoDebugEnabled(): boolean {
	return runtimeOptionsStorage.getStore()?.debug === true;
}

export function resolveEmbeddingProvider(
	provider:
		| MnemoEmbeddingProvider
		| ((texts: readonly string[]) => EmbeddingOutput | Promise<EmbeddingOutput>)
		| undefined,
): MnemoEmbeddingProvider | undefined {
	if (provider === undefined) {
		return undefined;
	}
	if (typeof provider === "function") {
		return { embed: provider };
	}
	return provider;
}

export function isZagAiModel(value: unknown): value is Model<Api> {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const maybe = value as Partial<Model<Api>>;
	return (
		typeof maybe.id === "string" &&
		typeof maybe.provider === "string" &&
		typeof maybe.baseUrl === "string" &&
		typeof maybe.api === "string"
	);
}
