# Mnemo memory backend

zag can use `@zag/zag-mnemo` as a local long-term memory backend.

Set:

```yaml
memory:
  backend: mnemo
```

Example:

```yaml
memory:
  backend: mnemo
mnemo:
  scoping: per-project-tagged
```

With this backend enabled, the coding agent:

1. Opens one or more local Mnemo SQLite databases according to the configured bank scoping.
2. Recalls relevant memories into a `<memories>` block for the first model turn of a session and refreshes the base prompt if recall happens from the `agent_start` listener.
3. Retains completed conversation turns into the retain bank after agent turns, no more often than `mnemo.retainEveryNTurns`.
4. Adds recalled memory as extra compaction context when compaction asks the memory backend for `preCompactionContext`.
5. Uses the normal `/memory view`, `/memory stats`, `/memory diagnose`, `/memory clear`, and `/memory enqueue` commands through the shared memory backend interface.

Recalled memory is background context, not instructions. Current user messages and tool output take precedence when they conflict.

## Agent tools

Selecting Mnemo makes these discoverable tools available:

- `recall` — search scoped memories. Results are previews and include memory IDs.
- `retain` — store durable facts explicitly.
- `reflect` — synthesize an answer across recalled memories.
- `memory_edit` — `update`, `forget`, or `invalidate` an editable memory by ID. Fact-table rows are read-only.

Read the full content and metadata for a recalled result with `read memory://<memory-id>` before replacing it; clipped recall previews are not safe update payloads. The optional `learn` tool is also able to retain into Mnemo when `autolearn.enabled: true`.

## Settings

| Setting                       | Default            | Description                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`              | `off`              | Set to `mnemo` to enable this backend.                                                                                                                                                                                                                                               |
| `mnemo.dbPath`              | agent memories dir | Optional SQLite database path.                                                                                                                                                                                                                                                         |
| `mnemo.bank`                | unset              | Optional shared bank base name passed to `Mnemo`; the coding-agent wrapper scopes from this base according to `mnemo.scoping`. Unset → shared bank `default`; per-project modes derive a project bank from the working-directory basename plus a stable hash of its absolute path. |
| `mnemo.scoping`             | `per-project`      | Memory visibility mode: `global` = one shared bank, `per-project` = isolated project memory, `per-project-tagged` = project-local writes plus global recall visibility.                                                                                                                |
| `mnemo.autoRecall`          | `true`             | Recall memory on the first turn of a session.                                                                                                                                                                                                                                          |
| `mnemo.autoRetain`          | `true`             | Retain completed turns automatically.                                                                                                                                                                                                                                                  |
| `mnemo.polyphonicRecall`    | `false`            | Enable 4-voice polyphonic recall (vector, graph, fact, temporal) with reciprocal rank fusion; `MNEMO_POLYPHONIC_RECALL` overrides when set.                                                                                                                                          |
| `mnemo.enhancedRecall`      | `false`            | Enable the tiered query result cache for repeated/similar recall queries; `MNEMO_ENHANCED_RECALL` overrides when set.                                                                                                                                                                |
| `mnemo.proactiveLinking`    | `false`            | Ingest new memories into the episodic graph and link them to related entities/memories as they are stored; `MNEMO_PROACTIVE_LINKING` overrides when set.                                                                                                                             |
| `mnemo.retainEveryNTurns`   | `4`                | Minimum user turns between automatic retain writes.                                                                                                                                                                                                                                    |
| `mnemo.recallLimit`         | `8`                | Maximum recalled memories in the prompt block.                                                                                                                                                                                                                                         |
| `mnemo.recallContextTurns`  | `3`                | Prior user-bounded turns included in recall queries.                                                                                                                                                                                                                                   |
| `mnemo.recallMaxQueryChars` | `4000`             | Maximum composed recall query length.                                                                                                                                                                                                                                                  |
| `mnemo.injectionTokenLimit` | `5000`             | Approximate token budget for memory prompt injection.                                                                                                                                                                                                                                  |
| `mnemo.debug`               | `false`            | Enable debug logging for backend failures.                                                                                                                                                                                                                                             |
| `mnemo.noEmbeddings`        | `false`            | Pass `noEmbeddings` to `Mnemo` and force FTS-only recall.                                                                                                                                                                                                                            |
| `mnemo.embeddingVariant`    | `en`               | Local embedding model variant: `en` = `BAAI/bge-base-en-v1.5` (768d), `multilingual` = `intfloat/multilingual-e5-large` (1024d). `mnemo.embeddingModel`/`MNEMO_EMBEDDING_MODEL` override it; changing it rebuilds stored embeddings on the next writable start.                    |
| `mnemo.embeddingModel`      | variant default    | Explicit embedding model id; overrides `mnemo.embeddingVariant`. Precedence: this setting > `MNEMO_EMBEDDING_MODEL` env > variant default; a blank or `null` setting counts as unset.                                                                                                                                         |
| `mnemo.embeddingApiUrl`     | env/default        | OpenAI-compatible embedding endpoint passed to `Mnemo`.                                                                                                                                                                                                                              |
| `mnemo.embeddingApiKey`     | env/default        | Embedding API key passed to `Mnemo`.                                                                                                                                                                                                                                                 |
| `mnemo.llmMode`             | `smol`             | `smol` resolves the configured zag-ai `tiny` role then `smol`; `remote` uses the settings below; `none` disables LLM calls.                                                                                                                                                             |
| `mnemo.llmBaseUrl`          | env/default        | OpenAI-compatible LLM endpoint for `llmMode: remote`.                                                                                                                                                                                                                                  |
| `mnemo.llmApiKey`           | env/default        | LLM API key for `llmMode: remote`.                                                                                                                                                                                                                                                     |
| `mnemo.llmModel`            | env/default        | LLM model id for `llmMode: remote`.                                                                                                                                                                                                                                                    |

## Scoping

The coding-agent wrapper applies scoping on top of the underlying `Mnemo` package:

- `global` uses one shared bank for recall and writes.
- `per-project` writes to and recalls from a bank derived from the current working directory alone — its basename plus a stable hash of its absolute path, independent of the surrounding git layout.
- `per-project-tagged` writes to the project-local bank and recalls from both the project-local bank and the shared global bank, with duplicate recall results merged.

The combined project-plus-global behavior lives in the wrapper. The `@zag/zag-mnemo` package itself still exposes banks and constructor options directly, including `bank` for selecting a bank name. Project-local banks other than the shared bank are stored as sibling bank databases managed by Mnemo's `BankManager`.

## Recall previews and full-row reads

Recall results carry clipped content previews, not full rows. Content longer than the preview cap is truncated with a trailing `…`; the result also sets `truncated: true` and `full_length` (original character count), so callers can detect clipping without parsing the marker. The cap is `RecallOptions.contentPreviewChars` (default `500`; `0` disables clipping).

The full row is always reachable by reading `memory://<memory-id>`, which resolves the live working or episodic row and returns its full content behind a small YAML frontmatter header (`id`, `bank`, `store`, `memory_type`, timestamps, `importance`, `veracity`, `session_id`, `metadata`). The coding-agent's model-facing prompts require this read before any `memory_edit update`, since `update` replaces content wholesale and would otherwise discard the unseen tail of a clipped preview.

Retention writes a marker-free transcript projection: when the host supplies an `embedText` override alongside the stored transcript, that projection is used for embedding, working-memory FTS indexing (`COALESCE(embed_text, content)`), and rebuild-reembedding, so retention protocol markers in the stored transcript do not pollute vector and full-text recall.

## LLM and embeddings

FTS and embedding paths use the settings below. LLM-backed extraction/consolidation uses the configured local on-device memory model (`providers.memoryModel`) when selected, otherwise `llmMode: smol` resolves the `tiny` role first and then `smol`; `llmMode: remote` uses the OpenAI-compatible endpoint settings; `llmMode: none` disables LLM calls. If no tiny/smol model or current credential resolves, Mnemo continues without LLM-backed work.

FTS-only:

```yaml
memory:
  backend: mnemo
mnemo:
  noEmbeddings: true
```

Equivalent constructor shape:

```ts
new Mnemo({ noEmbeddings: true });
```

Remote embeddings:

```yaml
mnemo:
  embeddingModel: text-embedding-3-small
  embeddingApiUrl: https://api.openai.com/v1
  embeddingApiKey: ${OPENAI_API_KEY}
```

Equivalent constructor shape:

```ts
new Mnemo({
  embeddingModel: "text-embedding-3-small",
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingApiKey,
});
```

Remote LLM:

```yaml
mnemo:
  llmMode: remote
  llmBaseUrl: https://api.openai.com/v1
  llmApiKey: ${OPENAI_API_KEY}
  llmModel: gpt-4.1-mini
```

Equivalent constructor shapes:

```ts
new Mnemo({ llm: { baseUrl, apiKey, model } });
new Mnemo({ llmBaseUrl: baseUrl, llmApiKey: apiKey, llmModel: model });
```

Dynamic function LLM for rotating OAuth tokens:

```ts
new Mnemo({
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

zag-ai tiny/smol role LLM:

```yaml
mnemo:
  llmMode: smol
```

The coding agent resolves `tiny` first and then `smol`, and passes a dynamic completion function so every Mnemo LLM call can fetch current provider credentials at call time:

```ts
new Mnemo({
  llm: async (prompt, opts) => completeSmolWithCurrentAuth(prompt, opts),
});
```

## Operational notes

- The default shared database lives under the agent memories directory in `mnemo/mnemo.db`; project-scoped banks use sibling database paths under that Mnemo directory.
- `/memory clear` removes every scoped Mnemo SQLite database and sidecar WAL/SHM files for the active configuration.
- `/memory enqueue` forces retention of the current session, flushes pending fact extractions, and runs Mnemo sleep/consolidation for eligible working-memory rows.
- `/memory stats` and `/memory diagnose` render backend-specific bank statistics/diagnostics when the Mnemo backend is active.
- Subagents do not own separate Mnemo retain loops; they alias the parent state when a parent Mnemo state exists, and otherwise remain inert.
- Backend startup is best-effort. If database/model initialization fails, the session continues with Mnemo inert and logs a warning; memory tools then report that the backend is not initialized.

## Shutdown and durability

Normal interactive and print-mode exit uses a deliberately lighter path than `/memory enqueue`:

1. The primary state retains the current transcript with new fact extraction disabled.
2. It flushes extractions that were already in flight, but does not run per-session sleep or full cross-session promotion.
3. Only after that drain settles does it close the owned SQLite bank handles; the embedding worker shuts down after state disposal because the drain may still use it.

Aliased subagent states do not own or close the shared banks; the parent state owns final retention, flushing, and handle closure.

Interactive and print exits give this drain 1.5 seconds. If the budget expires, shutdown detaches the in-flight drain and arranges for handles to close when it settles rather than racing writes against closed databases. The process may exit first. Working-memory rows already written remain durable, but promotion or embedding for the last few turns can remain incomplete; earlier turn retention performed at agent end is unaffected.

`/memory enqueue` is the explicit stronger durability boundary: it forces retention, flushes pending extraction, and runs full sleep/consolidation across the owned banks. It does not bypass Mnemo's age gate: `sleepAllSessions` selects unconsolidated working-memory rows older than `Math.floor(workingMemoryTtlHours / 2)` hours (12 hours with the default 24-hour TTL). Fresh rows therefore remain in working memory after an immediate enqueue. Use the command before exit to force retention and flush pending work, or after the age gate to promote eligible rows; normal shutdown does not promote them.
