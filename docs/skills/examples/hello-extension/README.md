# hello-extension

A minimal `zag` extension that demonstrates the two most common authoring patterns: subscribing to `session_start` to notify on load, and registering a `/hello` slash command that sends a greeting into the conversation. It is intentionally small — use it as a copy-paste starting point for your own extension.

## Install

**Option A — drop into user extensions directory:**

```
cp -r . ~/.zag/agent/extensions/hello-extension
```

Restart `zag`. You will see the startup notification immediately.

With `zag --profile <name>`, use `~/.zag/profiles/<name>/agent/extensions/hello-extension` instead. `ZAG_CODING_AGENT_DIR` likewise changes the agent directory.

**Option B — point the settings `extensions` array at it:**

```yaml
# ~/.zag/agent/config.yml
extensions:
  - /path/to/hello-extension
```

**Option C — load once via CLI flag:**

```
zag --extension ./hello-extension
```

## Usage

After loading, type `/hello` or `/hello Ada` in the zag prompt. The command sends a visible greeting custom message into the conversation and shows a "Message sent!" notification.

## What it demonstrates

- Default export factory receiving `ExtensionAPI`
- `zag.on("session_start", ...)` — session lifecycle hook
- `zag.registerCommand(...)` — slash command registration
- `ctx.ui.notify(...)` — user-facing notification
- `package.json` with `zag.extensions` manifest field
