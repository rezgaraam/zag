# Repository Guidelines

## Project Overview

`robozag` is a self-hosted GitHub triage-and-fix bot that drives [`zag --mode rpc`](https://github.com/rezgaraam/zag) as a subprocess. On every issue opened in an allowlisted repository it classifies the issue, applies labels, then branches into one of: reproduce → fix → PR (`bug` / `documentation`), single-comment answer (`question`), single thoughtful comment (`enhancement` / `proposal`), or brief comment (`invalid` / `duplicate`). Follow-up comments and PR review comments resume the same zag session so the agent keeps its prior reasoning. If the orchestrator restarts mid-task, the dispatcher resumes the same session via `zag --continue` from the per-issue `session_dir`, so an interrupted task re-enters its prior reasoning instead of restarting from scratch. The orchestrator runs as a single FastAPI process inside Docker with SQLite-backed durable event state.

## Architecture & Data Flow

Webhook → durable queue → async dispatcher → per-issue git worktree → zag RPC subprocess + host tools.

1. `POST /webhook/github` — HMAC-SHA256 verified against `GITHUB_WEBHOOK_SECRET` (`server.py` + `github_events.verify_signature`). Bad signature returns `401`.
2. `github_events.route()` decides one of `triage_issue` / `handle_comment` / `handle_pr_conversation` / `handle_review` / `handle_release_ci` / `cleanup_workspace` / `skip`. Bot-authored issue/PR events (`*[bot]`, `user.type == "Bot"`, configured `bot_login`) are dropped; `workflow_run` release verdicts are routed before that guard because repair pushes use the bot account.
3. `db.record_event()` inserts the event with `INSERT OR IGNORE` on `X-GitHub-Delivery` (dedup). Endpoint returns `202`.
4. `queue.WorkerPool._dispatch_loop` atomically claims `state='queued'` rows under `BEGIN IMMEDIATE`, guarded by an in-process `_inflight` set keyed by `issue_key`. Issue work serializes per issue; release work serializes per repo under `<repo>#release`. Cap: `ROBOZAG_MAX_CONCURRENCY` (default 8).
5. `sandbox.SandboxManager.ensure_workspace()` produces issue worktrees at `/data/workspaces/<owner>__<repo>__<n>/repo` on deterministic `farm/<8hex>/<slug>` branches. `ensure_release_workspace()` reuses `<owner>__<repo>__release/repo` on the default branch with a per-tag session.
6. `tasks.*` dispatchers build `TaskInputs` and call `worker.run_task()` which spawns `zag --mode rpc` with `cwd=worktree`, persistent `session_dir`, and a randomly-picked task-appropriate model pool. Existing `<session_dir>/*.jsonl` resumes with `--continue`.
7. Inside the subprocess the agent uses **built-in zag tools** (read/edit/write/bash/lsp, scoped to the worktree) and **host tools** from `host_tools.py` (the only surface allowed to mutate GitHub or write audit rows).
8. Success → event `state='done'`. Exception → `state='failed'` with a credential-redacted traceback in `events.last_error`. The `_inflight` slot is released either way.

## Key Directories

- `src/` — package (see "Important Files").
- `src/prompts/` — Mustache-style `{{var}}` templates loaded by `persona.py` via `@cache` and `importlib.resources`. Shipped as package data (`pyproject.toml` `package-data`).
- `tests/` — pytest suite. `test_worker_smoke.py` is gated on `ROBOZAG_INTEGRATION=1`.
- `data/` — runtime state (sqlite + WAL, `workspaces/`, `logs/`). Never committed.
- `/Dockerfile` (zag root) — produces `zag/zag:dev` (zag runtime image: python + bun + rustup + zag-natives + zag_rpc + `/usr/local/bin/zag` shim + the full zag source under `/zag`). Stages: `natives-builder` → `wheel-builder` → `zag-base` → `zag-runtime` (default). Built via `bun run zag:image`. Robozag's image extends `zag-base` via `FROM ${ZAG_BASE}` in `/Dockerfile.robozag`.

## Development Commands

Task runner is `bun` against the **monorepo root** `package.json`. robozag itself no longer ships a `package.json`; every recipe lives at the root under the `robozag:*` namespace. Local venv (no docker): `bun run robozag:install` runs `pip install -e 'python/robozag[dev]'`. From there:

```
bun run test:py                   # pytest -x python/zag-rpc/tests python/robozag/tests
bun run robozag:test:integration   # ROBOZAG_INTEGRATION=1, requires zag on PATH
bun run robozag:serve              # python -m robozag serve on the host
```

Docker inner loop:

```
bun run zag:image                  # build zag/zag:dev (one-time / on zag change)
bun run zag:run                    # docker run -it zag/zag:dev (smoke-test the shim)
bun run robozag:build              # zag:image (if zag changed) + docker compose build
bun run robozag:dev                # build + up -d + follow logs
bun run robozag:up / robozag:down / robozag:restart / robozag:logs
bun run robozag:rebuild            # docker compose build --no-cache
bun run robozag:reset              # `down -v` + drop the zag image
```

Frontend (Vite + SolidJS, in `web/` — still a bun workspace):

```
bun run robozag:web:dev            # vite dev server with proxy to :8080
bun run robozag:web:build          # produce src/static/ bundle
bun --cwd=python/robozag/web run check:types   # tsc --noEmit
```

In-container CLI (`robozag` console script → `robozag.cli:main`): no root aliases — invoke directly:

```
docker compose --project-directory python/robozag exec robozag robozag triage owner/repo#N
docker compose --project-directory python/robozag exec robozag robozag replay <delivery_id>
docker compose --project-directory python/robozag exec robozag robozag status
docker compose --project-directory python/robozag exec robozag robozag cleanup owner/repo#N
```

HTTP / sqlite / webhook inspection is unaliased — use `curl http://localhost:${ROBOZAG_BIND_PORT:-8080}/{healthz,readyz,events,issues}` and `docker compose --project-directory python/robozag exec robozag sqlite3 /data/robozag.sqlite` directly.

Lint + format: TypeScript via Biome (config in `biome.json`), Python via Ruff (config in `pyproject.toml`). Root recipes cover both languages — `bun run lint` / `bun run fix` apply to the whole monorepo including robozag. `bun run lint:py` / `bun run fix:py` scope to Python only.

## Code Conventions & Common Patterns

- **Python ≥3.11**, container is 3.12-slim. `from __future__ import annotations` is the norm; type hints are mandatory on public functions.
- **Records**: prefer `@dataclass(slots=True, frozen=True)` for immutable value types (see `github_client.IssueInfo`, `sandbox.Workspace`, `db.EventRow`).
- **Async style**: FastAPI handlers and `queue.WorkerPool` are async. `worker.run_task` is **synchronous** and runs in a worker thread because `zag-rpc` is blocking — keep it that way; don't try to async it. CLI commands wrap with `asyncio.run`.
- **Config**: `pydantic-settings` `Settings` in `config.py` with `ROBOZAG_*` env prefix (e.g. `ROBOZAG_MAX_CONCURRENCY`, `ROBOZAG_REPO_ALLOWLIST`). Access only via `get_settings()` (`@cache` singleton). Tests must call `reset_settings_cache()` after mutating env.
- **Dependency injection**: pass `Settings`, `Database`, `GitHubClient`, `SandboxManager` explicitly into `create_app()`, `WorkerPool`, and `ToolBindings`. No module-level globals other than the singleton accessors (`get_settings`, `get_database`).
- **State**: SQLite (`db.Database`) is the source of truth for `events`, `issues`, `releases`, and `tool_calls`. Release rows transition through `awaiting_ci` / `fixing` / `green` / `failed` / `superseded`. Thread-safe via an internal `_lock`; `BEGIN IMMEDIATE` for claim contention. In-memory state is only the `_inflight` set in `WorkerPool`.
- **Error handling**: custom exception types (`GitHubError` with `retry_after`, `GitCommandError`, `InvalidIssueRef`, `RpcCommandError`). `sandbox.redact_credentials()` strips `user:pass@` from any URL before it lands in logs, audit rows, or exception messages. **Never** include credentialed URLs in error strings.
- **Logging**: structured JSON via `logging_config.JsonFormatter`. Use `logger.info("event", extra={...})`; do not collide with `_RESERVED` keys. Configure once via `configure_logging()`.
- **Host tools** (`host_tools.py`): every tool is built from a per-task `ToolBindings` closure and audits through `_audit()` into `tool_calls`. Audit only ever sees agent-supplied args, never internal credentials. New tools follow the same pattern: validate args → call `GitHubClient` / `SandboxManager` → return structured dict → audit.
- **Naming**: snake_case for everything Python; module names singular nouns; test files `test_<module>.py`; test functions `test_<action>_<condition>`.
- **Prompts**: edit `src/prompts/*.md`. Variables use `{{path.to.field}}`; resolution is `persona._lookup`. The package install includes them as data files — adding a new prompt requires no other registration.

## Important Files

- `src/server.py` — FastAPI app, `/webhook/github`, `/healthz`, `/readyz`, `/events`, `/issues`, `/releases`, manual triage/replay endpoints, dashboard at `/`.
- `src/queue.py` — `WorkerPool` dispatcher and `_inflight` serialization.
- `src/tasks.py` — issue/PR handlers plus `handle_release_ci`.
- `src/worker.py` — synchronous zag RPC driver, prompt assembly via `persona`.
- `src/host_tools.py` — issue/PR tools plus `release_ci_status`, `release_job_log`, and terminal `release_retag`.
- `src/sandbox.py` — clone pool + issue/release worktree lifecycle, `GitCommandError`, credential redaction.
- `src/github_client.py` — typed httpx client including Actions, tag, and GitHub Release reads.
- `src/github_events.py` — routing and HMAC verification.
- `src/db.py` — sqlite schema and DAOs for events, issues, releases, and audited tool calls.
- `src/config.py` — `Settings` model and `get_settings()`.
- `src/cli.py` — Click CLI (`serve`, `triage`, `replay`, `status`, `cleanup`).
- `src/dashboard.py` — single-page HTML dashboard served from `/`.
- `pyproject.toml` — packaging + pytest config (`asyncio_mode = "auto"`, `testpaths = ["tests"]`).
- `/Dockerfile.robozag` (zag root) — robozag's image. `FROM ${ZAG_BASE}` (default `zag/zag:dev`), adds the SolidJS dashboard bundle, the robozag Python package, and the `robozag-entrypoint` shim. Tini entrypoint, exposes `8080`, `VOLUME /data`. The toolchain (python + bun + rustup + zag-natives + zag_rpc + `zag` shim) comes from `zag-base` — no duplication in this file.
- `docker-compose.yml` — `build.args.ZAG_BASE`, mounts `$ZAG_ROOT:/work/zag:ro`, `./data:/data`, `~/.zag/agent/models.container.yml:ro` (mapped to `models.yml` inside the container — kept separate from the host's `~/.zag/agent/models.yml` so the host zag doesn't pick up gateway routing intended only for the container), `extra_hosts: llm-gateway.internal:host-gateway`.
- `entrypoint.sh` — validates `ZAG_ROOT`, creates `/data/{workspaces,logs}` + build caches.
- `.env.example` — authoritative list of required runtime env vars.
- `README.md` — full architecture + operational reference. Authoritative for end-to-end flow, host-tool spec, security posture, and configuration reference.

## Runtime/Tooling Preferences

- **Python**: 3.11+ source target, 3.12 in container. Setuptools src layout (`pyproject.toml` `[tool.setuptools] package-dir = { "" = "src" }`).
- **Package manager**: `pip` only. No poetry / uv / pdm files; don't introduce one.
- **Task runner**: `bun` (root `package.json` `scripts`). Always reach for an existing `bun run` recipe before invoking `docker compose` or `pytest` directly.
- **Container runtime**: Docker Compose v2. The image embeds Bun 1.3.14 + a rustup launcher and exposes `zag` via a `/usr/local/bin/zag` shim; `ROBOZAG_ZAG_COMMAND=zag` should not need changing.
- **Required env** (set in `.env`, see `.env.example`): `GITHUB_WEBHOOK_SECRET`, `ROBOZAG_BOT_LOGIN`, `ROBOZAG_GIT_AUTHOR_NAME`, `ROBOZAG_GIT_AUTHOR_EMAIL`, `ROBOZAG_REPO_ALLOWLIST`, plus model knobs (`ROBOZAG_MODEL`, `ROBOZAG_THINKING`, optional `ROBOZAG_PROVIDER`) and rate-limit / concurrency / timeout overrides. Set `ROBOZAG_BOT_LOGIN` to the lowercase mention handle (`robozag` in production, no leading `@` or `[bot]`; config normalizes common variants). `ROBOZAG_MAINTAINER_LOGINS` is optional comma-separated bare logins (`@`/`[bot]` optional, case-insensitive) for non-owner implementation authorizers. **GitHub auth is mode-exclusive**: either set `ROBOZAG_GH_PROXY_URL` + `ROBOZAG_GH_PROXY_HMAC_KEY` (gh-proxy mode; PAT lives only in the sidecar container — the bundled compose default), or set `GITHUB_TOKEN` directly (single-process PAT mode). `Settings._validate_proxy_or_pat` rejects a `.env` that sets both.
- **ZAG_ROOT resolution**: robozag lives inside the zag monorepo at `python/robozag/`. `bun run zag:image` builds the parent monorepo (`../..`) as its docker build context to produce `zag/zag:dev`; `docker-compose.yml` extends that image via `ZAG_BASE` and mounts the same parent path read-only at `/work/zag` for the orchestrator to see live source. Override `ZAG_ROOT` only when pointing the build/mount at a different zag checkout. Inside the container the path is always `/work/zag`. Build invalidation stays bounded: Python-only edits in robozag never trigger a natives recompile.
- **Forbidden**: no docker-in-docker, no extra service containers, no new background workers outside `WorkerPool`. The container itself is the isolation boundary; per-issue isolation is the git worktree.

## Testing & QA

- **Framework**: `pytest` with `asyncio_mode = "auto"` (`pyproject.toml`). HTTP mocking with `httpx.MockTransport`; `respx` is available but only `MockTransport` is used in-tree — match that style.
- **Fixtures** (`tests/conftest.py`):
  - `env` — `monkeypatch`-sets all required `ROBOZAG_*` env vars and calls `reset_settings_cache()` before/after.
  - `settings` — invokes `ensure_paths()` for sqlite/workspace dirs.
  - `db` — isolated `tmp_path/test.sqlite` `Database`; tests must `database.close()` in teardown when bypassing this.
- **Isolation rules**: any test mutating env via `monkeypatch.setenv` MUST also call `reset_settings_cache()` to invalidate the `@cache`d `get_settings()`.
- **Async tests**: `test_github_client.py` and `test_host_tools.py` spin custom event loops in background threads to bridge sync-style tests with async client code. Prefer `pytest-asyncio` `auto` mode (`async def test_*`) for new tests; only fall back to the loop helpers if matching the surrounding file's style.
- **Mocking**: never patch internals; inject test doubles via `httpx.MockTransport` for HTTP and via the `db` / `tmp_path` fixtures for storage. Sandbox tests use a real local bare repo as the upstream.
- **Integration**: `tests/test_worker_smoke.py` is gated by `ROBOZAG_INTEGRATION=1` (uses `pytestmark.skipif`) and needs `zag` on `PATH`. Don't enable it in default `bun run test:py`.
- **Coverage expectation**: ~80 unit tests currently. New code with a control-flow branch needs a test covering it; new host tools need at minimum a happy path + one validation-failure path mirroring `test_host_tools.py`. Test logical behavior (assertions on observable effects in DB / HTTP requests), not literal strings or default config values.
