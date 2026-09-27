# Native Crates

Contributor map for Rust workspace members under `crates/`. They are implementation details behind `@zag/zag-natives` and its embedded shell; package consumers use JavaScript entrypoints, not these crate APIs.

The root `Cargo.toml` lists every crate under `crates/` explicitly in `workspace.members` — add new crates there. It also patches crates.io `brush-core` to the vendored copy.

## First-party crates

| Crate           | Path                                              | Role and consumers                                                                                                                                              |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zag-natives`    | [`crates/zag-natives`](../crates/zag-natives)       | Top-level N-API `cdylib`. It exposes the JS-visible API and depends on `zag-ast`, `zag-iso`, `zag-shell`, `zag-vcs`, `zag-voice`, and `zag-walker`.                    |
| `zag-builtins`   | [`crates/zag-builtins`](../crates/zag-builtins)     | Every builtin the embedded shell installs: a patched fork of brush's POSIX/bash builtins, plus one module per in-process command-line utility (`cat`, `grep`/`rg`, `sed`, `ls`, `find`, `jq`, `fd`, `diff`, `ps`, `top`, `kill`, the moreutils set, …). `src/host.rs` holds the `Utility` trait and the `Host` view of the shell (stdio, working directory, exported environment, cancellation) that the utilities run against. Ports of uutils coreutils/findutils/sed and jaq live here too; see the crate `LICENSE` for third-party notices. |
| `zag-shell`      | [`crates/zag-shell`](../crates/zag-shell)           | Persistent embedded brush shell, command execution/minimization, process plumbing, filesystem walking, and in-process command integration used by `zag-natives`. |
| `zag-voice`      | [`crates/zag-voice`](../crates/zag-voice)           | Cross-platform microphone/playback and Opus/WebRTC support used by the `AudioCapture`, `AudioPlayback`, and `LiveWebRtcPeer` bindings.                          |
| `zag-ast`        | [`crates/zag-ast`](../crates/zag-ast)               | tree-sitter/ast-grep language registry, matching/editing, block analysis, and summarization support across the workspace grammar set.                           |
| `zag-iso`        | [`crates/zag-iso`](../crates/zag-iso)               | Isolation backend implementations and diffing for APFS, Linux/Windows clone/reflink paths, overlayfs, ProjFS, and recursive copy fallback.                      |
| `zag-walker`     | [`crates/zag-walker`](../crates/zag-walker)         | Parallel, cache-aware filesystem walker using ignore rules and globsets; shared by native grep/glob/workspace paths and shell commands.                         |
| `zag-vcs`        | [`crates/zag-vcs`](../crates/zag-vcs)               | In-process version control: git on gitoxide (the git binary survives only for credential-bound network transfers and reftable repos) and Jujutsu on jj-lib; unified discovery and operations used by the `vcs*` native bindings. |

## Vendored workspace crates

| Group | Paths | Purpose |
| ----- | ----- | ------- |
| Brush | [`crates/vendor/brush-core`](../crates/vendor/brush-core) | Vendored shell engine consumed by `zag-shell` and `zag-builtins`. Its manifest retains upstream package metadata; a workspace patch selects this local fork. |

`zag_builtins::utility_builtins()` and `zag_builtins::process_builtins()` are the authoritative lists of the commands linked into the embedded shell; `zag-shell` decides which of them to register. A directory being a workspace member does not by itself mean that `zag-natives` exposes it as a JavaScript API.

## Boundary map

```text
@zag/zag-natives JS entrypoints
  -> zag-natives (N-API conversion, platform bindings, task boundaries)
       -> zag-ast / zag-iso / zag-vcs / zag-voice / zag-walker
       -> zag-shell
            -> brush-core (parser, expansion, interpreter)
            -> zag-builtins (bash builtins + utility builtins; host.rs: per-invocation I/O and cwd)
```

For the loader and JS boundary, see:

- [`natives-architecture.md`](./natives-architecture.md)
- [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md)
- [`natives-binding-contract.md`](./natives-binding-contract.md)

Subsystem details live in:

- [`natives-build-release-debugging.md`](./natives-build-release-debugging.md)
- [`natives-media-system-utils.md`](./natives-media-system-utils.md)
- [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.md)
- [`natives-shell-pty-process.md`](./natives-shell-pty-process.md)
- [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.md)
- [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.md)

## Documentation policy

These crates remain contributor-facing implementation details. Promote one to standalone user-facing documentation only when it gains a public API or executable consumed independently of `@zag/zag-natives`; see [`user-facing-packages.md`](./user-facing-packages.md).
