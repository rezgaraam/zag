# @zag/zag-mnemo

Local SQLite memory engine for zag agents.

This package is the Bun/TypeScript port of the Mnemosyne memory engine. It provides:

- `Mnemo`, a small facade for remember/recall/stats/sleep workflows.
- `BeamMemory`, the lower-level working/episodic memory engine.
- MCP tool definitions and a dispatcher for host integrations.
- Optional local ONNX embeddings through `fastembed` and optional OpenAI-compatible embedding/LLM endpoints.

The package does not bundle or download a local GGUF LLM. LLM paths are host-backend or OpenAI-compatible remote only; when no LLM is configured, deterministic heuristic paths are used.

## Basic use

```ts
import { Mnemo } from "@zag/zag-mnemo";

const memory = new Mnemo({ dbPath: "./mnemo.db", bank: "project" });
const id = memory.remember("The deployment target is stable-cluster.", {
	source: "notes",
	importance: 0.8,
	veracity: "true",
});

const results = memory.recall("deployment target", 5);
console.log(id, results[0]?.content);

memory.close();
```

## Configuration

`Mnemo` accepts LLM and embedding options directly. `MNEMO_*` environment variables remain fallbacks/defaults when the matching constructor option is omitted.

```ts
import { Mnemo } from "@zag/zag-mnemo";
import type { Model } from "@zag/zag-ai";

const ftsOnly = new Mnemo({ noEmbeddings: true });

const remoteEmbeddings = new Mnemo({
	embeddingModel: "text-embedding-3-small",
	embeddingApiUrl: "https://api.openai.com/v1",
	embeddingApiKey: process.env.OPENAI_API_KEY,
});

const remoteLlm = new Mnemo({
	llm: {
		baseUrl: "https://api.openai.com/v1",
		apiKey: process.env.OPENAI_API_KEY,
		model: "gpt-4.1-mini",
	},
	// Equivalent aliases: llmBaseUrl, llmApiKey, llmModel.
});

declare const smolModel: Model;
const zagAiLlm = new Mnemo({ llm: smolModel });
const dynamicLlm = new Mnemo({
	llm: async (prompt, opts) => {
		const token = await getFreshOauthToken();
		return await completeWithZagAi(prompt, {
			token,
			maxTokens: opts?.maxTokens,
			temperature: opts?.temperature,
		});
	},
});
```

### Banks and host scoping

`Mnemo` itself exposes banks directly through constructor options such as `bank`; it does not hard-code coding-agent project scoping.

The zag coding-agent wrapper adds `mnemo.scoping` on top of those constructor options:

- `global`: one shared bank
- `per-project`: isolated project memory
- `per-project-tagged`: project-local writes plus global recall visibility

In `per-project-tagged`, the wrapper is responsible for combining project-local retention with global recall visibility. The package still just exposes banks plus constructor-level LLM and embedding options.

Common environment fallbacks:

- `MNEMO_DATA_DIR` / `MNEMO_DB_PATH`: default storage location.
- `MNEMO_DB_PAGE_SIZE`: optional SQLite page size for new file-backed databases; use a valid power of two from 512 to 65536 or `os` to request the detected system page size. Unset preserves SQLite's default.
- `MNEMO_NO_EMBEDDINGS=1`: force FTS-only recall.
- `MNEMO_EMBEDDING_MODEL`: defaults to `BAAI/bge-small-en-v1.5`.
- `MNEMO_EMBEDDING_API_URL` and `MNEMO_EMBEDDING_API_KEY`: OpenAI-compatible embedding endpoint.
- `MNEMO_LLM_ENABLED=1`, `MNEMO_LLM_BASE_URL`, `MNEMO_LLM_API_KEY`, `MNEMO_LLM_MODEL`: OpenAI-compatible LLM endpoint.

Local embeddings use the `fastembed` npm package. Its default `BGESmallENV15` model is 384-dimensional and uses the package's CLS pooling plus vector normalization path. Local GGUF LLMs are not available in this package.

## Commands

```sh
mnemo remember "Use stable-cluster for production deploys"
mnemo recall "production deploy target"
mnemo stats
mnemo sleep
```

## Tests

```sh
bun --cwd packages/mnemo test
bun --cwd packages/mnemo run check
```
