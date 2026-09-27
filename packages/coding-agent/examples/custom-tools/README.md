# Custom Tools Examples

Example custom tools for zag-coding-agent.

## Examples

Each example uses the `subdirectory/index.ts` structure required for tool discovery.

### hello/

Minimal example showing the basic structure of a custom tool.

### todo/

Full-featured example demonstrating:

- `onSession` for state reconstruction from session history
- Custom `renderCall` and `renderResult`
- Proper branching support via details storage
- State management without external files

## Usage

```bash
# Test directly (can point to any .ts file)
zag --tool examples/custom-tools/todo/index.ts

# Or copy entire folder to tools directory for persistent use
cp -r todo ~/.zag/agent/tools/
```

Then in zag:

```
> add a todo "test custom tools"
> list todos
> toggle todo #1
> clear todos
```

## Writing Custom Tools

See [docs/custom-tools.md](../../docs/custom-tools.md) for full documentation.

### Key Points

**Factory pattern:**

```typescript
import { Text } from "@zag/zag-tui";
import type { CustomToolFactory } from "@zag/zag-coding-agent";

const factory: CustomToolFactory = zag => ({
	name: "my_tool",
	label: "My Tool",
	description: "Tool description for LLM",
	parameters: zag.zod.object({
		action: zag.zod.enum(["list", "add"]),
	}),

	// Called on session start/switch/branch/clear
	onSession(event) {
		// Reconstruct state from event.entries
	},

	async execute(toolCallId, params) {
		return {
			content: [{ type: "text", text: "Result" }],
			details: {/* for rendering and state reconstruction */},
		};
	},
});

export default factory;
```

**Custom rendering:**

```typescript
renderCall(args, theme) {
  return new Text(
    theme.fg("toolTitle", theme.bold("my_tool ")) + args.action,
    0, 0  // No padding - Box handles it
  );
},

renderResult(result, { expanded, isPartial }, theme) {
  if (isPartial) {
    return new Text(theme.fg("warning", "Working..."), 0, 0);
  }
  return new Text(theme.fg("success", "✓ Done"), 0, 0);
},
```

**Use `z.enum` for discriminated string tool args:**

```typescript
const z = zag.zod;

parameters: z.object({
	action: z.enum(["list", "add"]),
});
```
