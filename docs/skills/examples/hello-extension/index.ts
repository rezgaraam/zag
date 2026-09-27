// @ts-nocheck — example file; install @zag/zag-coding-agent before running
import type { ExtensionAPI } from "@zag/zag-coding-agent";

export default function helloExtension(zag: ExtensionAPI) {
  // Show a greeting whenever a session starts.
  zag.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Hello from hello-extension!", "info");
  });

  // Register a /hello slash command that sends a greeting into the conversation.
  zag.registerCommand("hello", {
    description: "Send a greeting into the conversation",
    handler: async (args, ctx) => {
      const name = args.trim() || "there";
      zag.sendMessage(
        {
          customType: "hello-extension",
          content: `Hello, ${name}!`,
          display: true,
          attribution: "user",
        },
        { triggerTurn: false }
      );
      ctx.ui.notify("Message sent!", "info");
    },
  });
}
