import { spyOn } from "bun:test";
import * as parser from "@babel/parser";
import { loadExtCompatModule } from "../../src/extensibility/plugins/ext-compat";

const entryPath = process.argv[2];
if (!entryPath) throw new Error("usage: ext-compat-extension-cjs-cache-probe <entry> [--expect-cache-hit]");

const parseSpy = spyOn(parser, "parse");
try {
	const mod = (await loadExtCompatModule(entryPath)) as { result: unknown };
	if (process.argv.includes("--expect-cache-hit") && parseSpy.mock.calls.length !== 0) {
		throw new Error(`Warm CommonJS classification reparsed ${parseSpy.mock.calls.length} source(s)`);
	}
	process.stdout.write(`${String(mod.result)}\n`);
} finally {
	parseSpy.mockRestore();
}
