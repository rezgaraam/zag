import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@zag/zag-utils";
import { $, type Server } from "bun";
import {
	getBehaviorDashboardStats,
	getCostDashboardStats,
	getDashboardStats,
	getFolderStats,
	getModelDashboardStats,
	getOverviewStats,
	getProviderDashboardStats,
	getRecentErrors,
	getRecentRequests,
	getRequestDetails,
	getToolDashboardStats,
	getTotalMessageCount,
	syncAllSessions,
} from "./aggregator";
import { decodeEmbeddedClientArchive } from "./embedded-client";
import embeddedClientArchiveTxt from "./embedded-client.generated.txt";
import { getGainDashboardStats } from "./gain-aggregator";
import {
	prepareStatsPort,
	recoverStatsPort,
	STATS_DASHBOARD_HEADER,
	STATS_DASHBOARD_HOSTNAME,
	STATS_DASHBOARD_HOSTNAME_HEADER,
	STATS_DASHBOARD_SECURITY_VERSION,
} from "./port-conflict";
import {
	buildSessionTrace,
	getTraceEntry,
	listSessionSummaries,
	TRACE_ETAG_VERSION,
	traceFingerprintForEtag,
	TracePathError,
} from "./trace";

const EMBEDDED_CLIENT_ARCHIVE = decodeEmbeddedClientArchive(embeddedClientArchiveTxt);

const CLIENT_DIR = path.join(import.meta.dir, "client");
const STATIC_DIR = path.join(import.meta.dir, "..", "dist", "client");
const IS_BUN_COMPILED =
	Boolean(process.env.ZAG_COMPILED || Bun.env.ZAG_COMPILED) ||
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");
// The prepacked npm bundle (coding-agent dist/cli.js) constant-folds
// process.env.ZAG_BUNDLED at build time. Like compiled binaries, it ships no
// dashboard sources or prebuilt dist/client next to the bundle, so the
// embedded archive is the only viable asset source.
const IS_PREBUILT = IS_BUN_COMPILED || Boolean(process.env.ZAG_BUNDLED || Bun.env.ZAG_BUNDLED);
const USE_EMBEDDED_CLIENT = EMBEDDED_CLIENT_ARCHIVE !== null || IS_PREBUILT;

const EMBEDDED_CLIENT_DIR_ROOT = path.join(os.tmpdir(), "zag-stats-client");
let embeddedClientDirPromise: Promise<string> | null = null;

function sanitizeArchivePath(archivePath: string): string | null {
	const normalized = archivePath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized === ".") return null;
	if (normalized.includes("..") || path.isAbsolute(normalized)) return null;
	return normalized;
}

async function extractEmbeddedClientArchive(archiveBytes: Buffer, outputDir: string): Promise<void> {
	const archive = new Bun.Archive(archiveBytes);
	const files = await archive.files();
	const extractRoot = path.resolve(outputDir);

	for (const [archivePath, file] of files) {
		const sanitizedPath = sanitizeArchivePath(archivePath);
		if (!sanitizedPath) continue;
		const destinationPath = path.resolve(extractRoot, sanitizedPath);
		if (!destinationPath.startsWith(extractRoot + path.sep)) {
			throw new Error(`Archive entry escapes extraction directory: ${archivePath}`);
		}
		await Bun.write(destinationPath, file);
	}
}

async function getEmbeddedClientDir(): Promise<string> {
	if (!USE_EMBEDDED_CLIENT) return STATIC_DIR;
	if (embeddedClientDirPromise) return embeddedClientDirPromise;

	if (!EMBEDDED_CLIENT_ARCHIVE) {
		throw new Error(
			"Embedded stats client bundle missing. Rebuild the zag binary or npm bundle with embedded stats assets.",
		);
	}

	embeddedClientDirPromise = (async () => {
		const bundleHash = Bun.hash(EMBEDDED_CLIENT_ARCHIVE).toString(16);
		const outputDir = path.join(EMBEDDED_CLIENT_DIR_ROOT, bundleHash);
		const markerPath = path.join(outputDir, "index.html");
		try {
			const marker = await fs.stat(markerPath);
			if (marker.isFile()) return outputDir;
		} catch {}

		await fs.rm(outputDir, { recursive: true, force: true });
		await fs.mkdir(outputDir, { recursive: true });
		await extractEmbeddedClientArchive(EMBEDDED_CLIENT_ARCHIVE, outputDir);
		return outputDir;
	})();

	return embeddedClientDirPromise;
}

async function getLatestMtime(dir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		// Tolerate missing source trees (e.g. installs without the dashboard
		// sources); the caller falls back to prebuilt assets or a clear build
		// failure instead of crashing on the scan.
		if (isEnoent(err)) return 0;
		throw err;
	}

	const promises = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			promises.push(getLatestMtime(fullPath));
		} else if (entry.isFile()) {
			promises.push(fs.stat(fullPath).then(stats => stats.mtimeMs));
		}
	}

	let latest = 0;
	await Promise.allSettled(promises).then(results => {
		for (const result of results) {
			if (result.status === "fulfilled") {
				latest = Math.max(latest, result.value);
			}
		}
	});
	return latest;
}

const ensureClientBuild = async () => {
	if (USE_EMBEDDED_CLIENT) return;
	const indexPath = path.join(STATIC_DIR, "index.html");
	const cssPath = path.join(STATIC_DIR, "styles.css");
	const clientSourceMtime = await getLatestMtime(CLIENT_DIR);
	const tailwindConfigPath = path.join(import.meta.dir, "..", "tailwind.config.js");
	let tailwindConfigMtime = 0;
	try {
		const tailwindConfigStats = await fs.stat(tailwindConfigPath);
		tailwindConfigMtime = tailwindConfigStats.mtimeMs;
	} catch {}
	const sourceMtime = Math.max(clientSourceMtime, tailwindConfigMtime);
	let shouldBuild = true;
	try {
		const [indexStats, cssStats] = await Promise.all([fs.stat(indexPath), fs.stat(cssPath)]);
		if (
			indexStats.isFile() &&
			cssStats.isFile() &&
			indexStats.mtimeMs >= sourceMtime &&
			cssStats.mtimeMs >= sourceMtime
		) {
			shouldBuild = false;
		}
	} catch {
		shouldBuild = true;
	}

	if (!shouldBuild) return;

	await fs.rm(STATIC_DIR, { recursive: true, force: true });

	console.log("Building stats client...");
	const packageRoot = path.join(import.meta.dir, "..");
	const buildResult = await $`bun run build.ts`.cwd(packageRoot).quiet().nothrow();
	if (buildResult.exitCode !== 0) {
		const output = buildResult.text().trim();
		const details = output ? `\n${output}` : "";
		throw new Error(`Failed to build stats client (exit ${buildResult.exitCode})${details}`);
	}

	const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Usage Statistics</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='sky' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%231c1535'/%3E%3Cstop offset='1' stop-color='%230f0a14'/%3E%3C/linearGradient%3E%3CclipPath id='tile'%3E%3Crect width='64' height='64' rx='14'/%3E%3C/clipPath%3E%3C/defs%3E%3Cg clip-path='url(%23tile)'%3E%3Crect width='64' height='64' fill='url(%23sky)'/%3E%3Ccircle cx='44' cy='22' r='10' fill='%23ff9632'/%3E%3Ccircle cx='44' cy='22' r='7' fill='%23ffd65a'/%3E%3Cpath d='M48 25 L33 58 H50 Z' fill='%2378aaf0'/%3E%3Cpath d='M48 25 L50 58 H64 Z' fill='%234e7cd2'/%3E%3Cpath d='M48 25 L50.18 29.5 L49 28.6 L47.8 30.2 L46.7 28.9 L45.95 29.5 Z' fill='%23ecf4ff'/%3E%3Cpath d='M24 12 L2 58 H26 Z' fill='%236096eb'/%3E%3Cpath d='M24 12 L26 58 H46 Z' fill='%233460be'/%3E%3Cpath d='M24 12 L27.8 20 L26.3 19 L25 21.5 L23.2 19.2 L21.6 20.7 L20.2 20 Z' fill='%23ecf4ff'/%3E%3Cpath d='M0 49 C 10 45.5, 20 46, 31 49.5 S 52 45.5, 64 48 V64 H0 Z' fill='%235cc46e'/%3E%3Cpath d='M0 55 C 12 52, 22 52.5, 34 56 S 54 53, 64 54.5 V64 H0 Z' fill='%232e8c50'/%3E%3C/g%3E%3C/svg%3E">
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="root"></div>
    <script src="index.js" type="module"></script>
</body>
</html>`;

	await Bun.write(path.join(STATIC_DIR, "index.html"), indexHtml);
};

/**
 * Handle API requests.
 */
export async function handleApi(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	// Stats reads are DB-only; explicit /api/sync does the expensive session scan.
	const range = url.searchParams.get("range");

	if (path === "/api/stats") {
		const stats = await getDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/overview") {
		const stats = await getOverviewStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/model-dashboard") {
		const stats = await getModelDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/costs") {
		const stats = await getCostDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/behavior") {
		const stats = await getBehaviorDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/tools") {
		const stats = await getToolDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/providers") {
		const stats = await getProviderDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/recent") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentRequests(limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/errors") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentErrors(range, limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/models") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.byModel);
	}

	if (path === "/api/stats/folders") {
		const stats = await getFolderStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/timeseries") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.timeSeries);
	}

	if (path.startsWith("/api/request/")) {
		const id = path.split("/").pop();
		if (!id) return new Response("Bad Request", { status: 400 });
		const details = await getRequestDetails(parseInt(id, 10));
		if (!details) return new Response("Not Found", { status: 404 });
		return Response.json(details);
	}

	if (path === "/api/sync") {
		const result = await syncAllSessions();
		const count = await getTotalMessageCount();
		return Response.json({ ...result, totalMessages: count });
	}

	if (path === "/api/stats/gain") {
		const project = url.searchParams.get("project");
		const stats = await getGainDashboardStats(range, project);
		return Response.json(stats);
	}
	if (path === "/api/sessions") {
		const limitParam = Number(url.searchParams.get("limit") ?? "100");
		const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : 100;
		const q = url.searchParams.get("q") ?? undefined;
		return Response.json(await listSessionSummaries(limit, q));
	}

	if (path === "/api/session/trace") {
		const file = url.searchParams.get("file");
		if (!file) return Response.json({ error: "file required" }, { status: 400 });
		try {
			// ETag-first: compare the client's etag against the
			// root+child fingerprint WITHOUT building the trace. A matching
			// (unchanged) poll returns 304 after stats only; only a changed
			// tree pays the full re-read/re-parse/rebuild in
			// buildSessionTrace (itself memoized for non-conditional polls).
			// The fingerprint covers child transcripts, so a subagent-only
			// append changes the ETag and never 304s stale.
			const clientEtag = req.headers.get("if-none-match");
			if (clientEtag) {
				const fingerprint = await traceFingerprintForEtag(file);
				if (fingerprint !== undefined) {
					const etag = `"${TRACE_ETAG_VERSION}:${fingerprint}"`;
					if (clientEtag === etag) return new Response(null, { status: 304 });
				}
			}
			const trace = await buildSessionTrace(file);
			const etag = `"${TRACE_ETAG_VERSION}:${trace.etag}"`;
			if (clientEtag === etag) return new Response(null, { status: 304 });
			return Response.json(trace, { headers: { ETag: etag } });
		} catch (err) {
			if (err instanceof TracePathError) return Response.json({ error: err.message }, { status: 400 });
			if (isEnoent(err)) return Response.json({ error: "session not found" }, { status: 404 });
			throw err;
		}
	}

	if (path === "/api/session/entry") {
		const file = url.searchParams.get("file");
		const id = url.searchParams.get("id");
		if (!file || !id) return Response.json({ error: "file and id required" }, { status: 400 });
		try {
			const entry = await getTraceEntry(file, id);
			if (!entry) return Response.json({ error: "entry not found" }, { status: 404 });
			return Response.json({ entry });
		} catch (err) {
			if (err instanceof TracePathError) return Response.json({ error: err.message }, { status: 400 });
			throw err;
		}
	}

	return new Response("Not Found", { status: 404 });
}

/**
 * Handle static file requests.
 */
async function handleStatic(requestPath: string): Promise<Response> {
	const staticDir = await getEmbeddedClientDir();
	const filePath = requestPath === "/" ? "/index.html" : requestPath;
	const fullPath = path.join(staticDir, filePath);

	const file = Bun.file(fullPath);
	if (await file.exists()) {
		return new Response(file);
	}

	// SPA fallback
	const index = Bun.file(path.join(staticDir, "index.html"));
	if (await index.exists()) {
		return new Response(index);
	}

	return new Response("Not Found", { status: 404 });
}

/** Format a dashboard origin, including brackets required by IPv6 literals. */
export function formatStatsDashboardUrl(hostname: string, port: number): string {
	const urlHostname = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
	return `http://${urlHostname}:${port}`;
}

function createDashboardServer(port: number, hostname: string): Server<undefined> {
	const server = Bun.serve({
		port,
		hostname,
		async fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname;

			// The identity header lets another zag session's reuse probe positively
			// recognize this dashboard without allowing cross-origin API reads.
			const dashboardHeaders: Record<string, string> = {
				[STATS_DASHBOARD_HEADER]: STATS_DASHBOARD_SECURITY_VERSION,
				[STATS_DASHBOARD_HOSTNAME_HEADER]: hostname,
			};

			if (req.method === "OPTIONS") {
				return new Response(null, { headers: dashboardHeaders });
			}

			try {
				let response: Response;

				if (path.startsWith("/api/")) {
					response = await handleApi(req);
				} else {
					response = await handleStatic(path);
				}

				// Add the dashboard identity header to all responses.
				const headers = new Headers(response.headers);
				for (const key in dashboardHeaders) {
					headers.set(key, dashboardHeaders[key]);
				}

				return new Response(response.body, {
					status: response.status,
					headers,
				});
			} catch (error) {
				console.error("Server error:", error);
				return Response.json(
					{ error: error instanceof Error ? error.message : "Unknown error" },
					{ status: 500, headers: dashboardHeaders },
				);
			}
		},
	});
	return server;
}

/**
 * Start the HTTP server, reusing a live dashboard or reclaiming a stale zag listener.
 */
export interface StatsServerHandle {
	hostname: string;
	port: number;
	stop: () => void;
}

// Dashboards this process already bound, keyed by requested `hostname:port`.
// A second in-process start (e.g. `/trace` twice in one session) must return
// the live handle: probing our own port can time out under load and would
// then dead-end in the reclaim path's self-PID guard.
const activeServers = new Map<string, StatsServerHandle>();

export async function startServer(port = 3847, hostname = STATS_DASHBOARD_HOSTNAME): Promise<StatsServerHandle> {
	const activeKey = `${hostname}:${port}`;
	if (port !== 0) {
		const active = activeServers.get(activeKey);
		if (active) return active;
	}
	await ensureClientBuild();
	const preparation = await prepareStatsPort(port, hostname);
	if (preparation === "reuse") {
		return { hostname, port, stop: () => {} };
	}
	const register = (server: Server<undefined>): StatsServerHandle => {
		const handle: StatsServerHandle = {
			hostname,
			port: server.port ?? port,
			stop: () => {
				activeServers.delete(activeKey);
				server.stop();
			},
		};
		if (port !== 0) activeServers.set(activeKey, handle);
		return handle;
	};

	try {
		return register(createDashboardServer(port, hostname));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;

		const recovery = await recoverStatsPort(port, hostname);
		if (recovery === "reuse") {
			return { hostname, port, stop: () => {} };
		}

		try {
			return register(createDashboardServer(port, hostname));
		} catch (retryError) {
			throw new Error(`Failed to start stats dashboard on ${hostname}:${port} after reclaiming it.`, {
				cause: retryError,
			});
		}
	}
}
