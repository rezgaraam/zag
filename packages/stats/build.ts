import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compile } from "@tailwindcss/node";

/**
 * Extract Tailwind class names from source files by scanning for className attributes.
 */
async function extractTailwindClasses(dir: string): Promise<Set<string>> {
	const classes = new Set<string>();
	const classPattern = /className\s*=\s*["'`]([^"'`]+)["'`]/g;

	async function scanDir(currentDir: string): Promise<void> {
		const entries = await fs.readdir(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				await scanDir(fullPath);
			} else if (entry.isFile() && /\.(tsx|ts|jsx|js)$/.test(entry.name)) {
				const content = await Bun.file(fullPath).text();
				const matches = content.matchAll(classPattern);
				for (const match of matches) {
					for (const cls of match[1].split(/\s+/)) {
						if (cls) classes.add(cls);
					}
				}
			}
		}
	}

	await scanDir(dir);
	return classes;
}

// Clean dist
await fs.rm("./dist/client", { recursive: true, force: true });

// Build Tailwind CSS
console.log("Building Tailwind CSS...");
const sourceCss = await Bun.file("./src/client/styles.css").text();
const candidates = await extractTailwindClasses("./src/client");
const baseDir = path.resolve("./src/client");

const compiler = await compile(sourceCss, {
	base: baseDir,
	onDependency: () => {},
});
const tailwindOutput = compiler.build([...candidates]);
await Bun.write("./dist/client/styles.css", tailwindOutput);

// Build React app
console.log("Building React app...");
const result = await Bun.build({
	entrypoints: ["./src/client/index.tsx"],
	outdir: "./dist/client",
	minify: true,
	naming: "[dir]/[name].[ext]",
});

if (!result.success) {
	console.error("Build failed");
	for (const message of result.logs) {
		console.error(message);
	}
	process.exit(1);
}

// Create index.html
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Usage Statistics</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='sky' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%231c1535'/%3E%3Cstop offset='1' stop-color='%230f0a14'/%3E%3C/linearGradient%3E%3CclipPath id='tile'%3E%3Crect width='64' height='64' rx='14'/%3E%3C/clipPath%3E%3C/defs%3E%3Cg clip-path='url(%23tile)'%3E%3Crect width='64' height='64' fill='url(%23sky)'/%3E%3Ccircle cx='44' cy='22' r='10' fill='%23ff9632'/%3E%3Ccircle cx='44' cy='22' r='7' fill='%23ffd65a'/%3E%3Cpath d='M48 25 L33 58 H50 Z' fill='%2378aaf0'/%3E%3Cpath d='M48 25 L50 58 H64 Z' fill='%234e7cd2'/%3E%3Cpath d='M48 25 L50.18 29.5 L49 28.6 L47.8 30.2 L46.7 28.9 L45.95 29.5 Z' fill='%23ecf4ff'/%3E%3Cpath d='M24 12 L2 58 H26 Z' fill='%236096eb'/%3E%3Cpath d='M24 12 L26 58 H46 Z' fill='%233460be'/%3E%3Cpath d='M24 12 L27.8 20 L26.3 19 L25 21.5 L23.2 19.2 L21.6 20.7 L20.2 20 Z' fill='%23ecf4ff'/%3E%3Cpath d='M0 49 C 10 45.5, 20 46, 31 49.5 S 52 45.5, 64 48 V64 H0 Z' fill='%235cc46e'/%3E%3Cpath d='M0 55 C 12 52, 22 52.5, 34 56 S 54 53, 64 54.5 V64 H0 Z' fill='%232e8c50'/%3E%3C/g%3E%3C/svg%3E">
    <script>
      (function () {
        try {
          var stored = localStorage.getItem("zag-stats-theme");
          var system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
          var theme = stored === "light" || stored === "dark" ? stored : system;
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.colorScheme = theme;
        } catch (e) {}
      })();
    </script>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="root"></div>
    <script src="index.js" type="module"></script>
</body>
</html>`;

await Bun.write("./dist/client/index.html", indexHtml);

console.log("Build complete");
