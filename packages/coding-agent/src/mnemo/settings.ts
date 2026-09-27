/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Mnemo local SQLite memory backend.
export const cfgMnemoDbPath = register({
	id: "mnemo.dbPath",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo DB Path",
		description: "Optional SQLite DB path. Defaults to the agent memories directory.",
		condition: "mnemoActive",
	},
});

export const cfgMnemoBank = register({
	id: "mnemo.bank",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo Bank",
		description: "Optional shared bank base name. Per-project modes derive project-local banks from it.",
		condition: "mnemoActive",
	},
});

export const cfgMnemoScoping = register({
	id: "mnemo.scoping",
	type: "enum",
	values: ["global", "per-project", "per-project-tagged"] as const,
	default: "per-project",
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo Scoping",
		description:
			"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = project-local writes plus global recall visibility",
		options: [
			{
				value: "global",
				label: "Global",
				description: "One shared Mnemo bank for every project",
			},
			{
				value: "per-project",
				label: "Per project",
				description: "Project-local Mnemo bank per cwd basename",
			},
			{
				value: "per-project-tagged",
				label: "Per project (tagged)",
				description: "Write to a project-local bank but merge project + shared recall results",
			},
		],
		condition: "mnemoActive",
	},
});

export const cfgMnemoEmbeddingVariant = register({
	id: "mnemo.embeddingVariant",
	type: "enum",
	values: ["en", "multilingual"] as const,
	default: "en",
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Embedding variant",
		description:
			"Local embedding model family. en = stronger English model; multilingual = cross-language model. Changing this rebuilds existing memory embeddings on next start.",
		options: [
			{
				value: "en",
				label: "English (bge-base-en-v1.5)",
				description: "BAAI/bge-base-en-v1.5 (768d), English-only",
			},
			{
				value: "multilingual",
				label: "Multilingual (multilingual-e5-large)",
				description: "intfloat/multilingual-e5-large (1024d), cross-language recall",
			},
		],
		condition: "mnemoActive",
	},
});

export const cfgMnemoAutoRecall = register({
	id: "mnemo.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo Auto Recall",
		description: "Recall local memories into the first turn of each session",
		condition: "mnemoActive",
	},
});

export const cfgMnemoAutoRetain = register({
	id: "mnemo.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo Auto Retain",
		description: "Retain completed conversation turns into local Mnemo memory",
		condition: "mnemoActive",
	},
});

export const cfgMnemoPolyphonicRecall = register({
	id: "mnemo.polyphonicRecall",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo Polyphonic Recall",
		description: "Enable 4-voice recall (vector, graph, fact, temporal) fused with reciprocal rank fusion",
		condition: "mnemoActive",
	},
});

export const cfgMnemoEnhancedRecall = register({
	id: "mnemo.enhancedRecall",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo Enhanced Recall",
		description: "Enable the tiered query result cache for repeated and similar recall queries",
		condition: "mnemoActive",
	},
});

export const cfgMnemoProactiveLinking = register({
	id: "mnemo.proactiveLinking",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo Proactive Linking",
		description:
			"Ingest new memories into the episodic graph as they are stored, linking them to related entities and memories",
		condition: "mnemoActive",
	},
});

export const cfgMnemoNoEmbeddings = register({
	id: "mnemo.noEmbeddings",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo Disable Embeddings",
		description: "Force deterministic FTS-only recall instead of vector embeddings",
		condition: "mnemoActive",
	},
});

export const cfgMnemoEmbeddingModel = register({
	id: "mnemo.embeddingModel",
	type: "string",
	default: undefined,
	// Without the env term a variant default would silently shadow a user's configured env model.
	env: { name: "MNEMO_EMBEDDING_MODEL", fallback: "blank" },
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo Embedding Model",
		description:
			"Advanced: explicit embedding model id that overrides the variant. Leave empty to use mnemo.embeddingVariant.",
		condition: "mnemoActive",
	},
});

export const cfgMnemoEmbeddingApiUrl = register({
	id: "mnemo.embeddingApiUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo Embedding API URL",
		description: "Optional OpenAI-compatible embedding endpoint passed to Mnemo",
		condition: "mnemoActive",
	},
});

export const cfgMnemoEmbeddingApiKey = register({
	id: "mnemo.embeddingApiKey",
	type: "string",
	credential: true,
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo Embedding API Key",
		description: "Optional embedding API key passed to Mnemo",
		condition: "mnemoActive",
	},
});

export const cfgMnemoLlmMode = register({
	id: "mnemo.llmMode",
	type: "enum",
	values: ["none", "smol", "remote"] as const,
	default: "smol",
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo LLM Mode",
		description:
			"Use no LLM, the online tiny model (the TINY role from /models, else @smol), or a remote OpenAI-compatible endpoint",
		condition: "mnemoActive",
		options: [
			{ value: "none", label: "None", description: "Disable Mnemo LLM-backed extraction" },
			{
				value: "smol",
				label: "Online (tiny)",
				description: "Use the online tiny model (the TINY role from /models, else @smol)",
			},
			{ value: "remote", label: "Remote", description: "Use the Mnemo remote LLM settings below" },
		],
	},
});

export const cfgMnemoLlmBaseUrl = register({
	id: "mnemo.llmBaseUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo LLM Base URL",
		description: "Optional OpenAI-compatible LLM endpoint for Mnemo remote mode",
		condition: "mnemoActive",
	},
});

export const cfgMnemoLlmApiKey = register({
	id: "mnemo.llmApiKey",
	type: "string",
	credential: true,
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo LLM API Key",
		description: "Optional LLM API key for Mnemo remote mode",
		condition: "mnemoActive",
	},
});

export const cfgMnemoLlmModel = register({
	id: "mnemo.llmModel",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemo",
		label: "Mnemo LLM Model",
		description: "Optional LLM model name for Mnemo remote mode",
		condition: "mnemoActive",
	},
});

export const cfgMnemoRetainEveryNTurns = register({ id: "mnemo.retainEveryNTurns", type: "number", default: 4 });

export const cfgMnemoRecallLimit = register({ id: "mnemo.recallLimit", type: "number", default: 8 });

export const cfgMnemoRecallContextTurns = register({ id: "mnemo.recallContextTurns", type: "number", default: 3 });

export const cfgMnemoRecallMaxQueryChars = register({
	id: "mnemo.recallMaxQueryChars",
	type: "number",
	default: 4000,
});

export const cfgMnemoInjectionTokenLimit = register({
	id: "mnemo.injectionTokenLimit",
	type: "number",
	default: 5000,
});

export const cfgMnemoDebug = register({ id: "mnemo.debug", type: "boolean", default: false });
