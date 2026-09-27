import { ensureChromiumExecutable } from "@zag/zag-coding-agent/tools/browser/launch";

const platform = process.env.ZAG_BROWSER_PROBE_PLATFORM;
if (platform) Object.defineProperty(process, "platform", { value: platform });

const executable = await ensureChromiumExecutable();
process.stdout.write(executable ?? "");
