// @ts-nocheck — example file; install @zag/zag-coding-agent before running
import type { ExtensionAPI } from "@zag/zag-coding-agent";

export default function myPlugin(zag: ExtensionAPI) {
  zag.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("my-plugin loaded from example marketplace!", "info");
  });
}
