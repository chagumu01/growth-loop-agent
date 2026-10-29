import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compareBaseline, evaluationEnvironment, executeCases } from "./engine.mjs";
import { startVectorFixture } from './mock-vectors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arguments_ = process.argv.slice(2);
if (arguments_.some((arg) => !['--llm', '--hybrid', '--mock-vectors'].includes(arg))) throw new Error('Usage: npm run eval [-- --llm] [--hybrid --mock-vectors]');
if (arguments_.includes('--mock-vectors') && !arguments_.includes('--hybrid')) throw new Error('--mock-vectors requires --hybrid');
const mode = arguments_.includes("--llm") ? "llm" : "rules";
const retrieval = arguments_.includes('--hybrid') ? 'hybrid' : 'keyword';
const suite = JSON.parse(readFileSync(join(root, "scripts/eval/scenarios.json"), "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceFiles = ["lib/agent/provider.ts", "lib/agent/understanding.ts", "lib/agent/quiz.ts", "lib/learning-program/service.ts"];
const versions = {
  suite: suite.version,
  suiteHash: hash(JSON.stringify(suite)),
  node: process.version,
  next: JSON.parse(readFileSync(join(root, "node_modules/next/package.json"))).version,
  sourceHashes: Object.fromEntries(sourceFiles.map((file) => [file, hash(readFileSync(join(root, file)))])),
};
try {
  versions.commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  versions.dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
} catch { versions.commit = "unknown"; }

// A sibling directory keeps Windows builds on the dependency drive. Cross-drive
// junctions break webpack entry resolution and may exhaust the system temp drive.
const tempRoot = realpathSync(dirname(root));
const sandbox = mkdtempSync(join(tempRoot, "growth-loop-eval-"));
const runtimeEnv = evaluationEnvironment(process.env, sandbox, mode);
let server;
let build;
let interrupted = false;
let vectorFixture;
const stop = (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* Already exited. */ }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
};
const interrupt = () => { interrupted = true; stop(build); stop(server); };
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

function launch(args, env, onData = () => {}) {
  const child = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), ...args], {
    cwd: sandbox, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-16000);
    onData(output, chunk.toString(), stream === child.stdout);
  });
  const completion = new Promise((resolve_, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve_({ code, output }));
  });
  return { child, completion, output: () => output };
}

let report;
try {
  if (retrieval === 'hybrid') {
    if (arguments_.includes('--mock-vectors')) {
      vectorFixture = await startVectorFixture();
      runtimeEnv.MEMORY_EMBEDDING_BASE_URL = vectorFixture.url;
      runtimeEnv.MEMORY_EMBEDDING_API_KEY = 'synthetic-local-only';
      runtimeEnv.MEMORY_EMBEDDING_MODEL = 'synthetic-vectors-v1';
    } else {
      for (const key of ['MEMORY_EMBEDDING_BASE_URL', 'MEMORY_EMBEDDING_API_KEY', 'MEMORY_EMBEDDING_MODEL']) {
        if (!process.env[key]) throw new Error(`Hybrid evaluation requires ${key} or --mock-vectors`);
        runtimeEnv[key] = process.env[key];
      }
    }
  }
  // Copy only application sources/configuration: never .env, .data or personal files.
  for (const path of ["app", "lib", "public", "package.json", "package-lock.json", "next.config.mjs", "tsconfig.json", "next-env.d.ts", "AGENTS.md"]) {
    if (existsSync(join(root, path))) cpSync(join(root, path), join(sandbox, path), { recursive: true });
  }
  symlinkSync(join(root, "node_modules"), join(sandbox, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  console.error("[eval] Building isolated application (no .env or learning data copied)...");
  const building = launch(["build", "--webpack"], evaluationEnvironment(process.env, sandbox));
  build = building.child;
  const buildTimer = setTimeout(() => stop(build), 180000);
  let built;
  try { built = await building.completion; } finally { clearTimeout(buildTimer); }
  if (built.code !== 0 || interrupted) throw new Error(`Isolated build failed (${built.code})\n${built.output}`);

  console.error("[eval] Starting isolated server on an ephemeral loopback port...");
  let baseUrl;
  const traces = [];
  let traceBuffer = '';
  let serving;
  const startServer = async () => {
    baseUrl = undefined;
    traceBuffer = '';
    serving = launch(['start', '--hostname', '127.0.0.1', '--port', '0'], { ...runtimeEnv, APP_VERSION: versions.commit }, (output, chunk, stdout) => {
      baseUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (stdout) {
        traceBuffer += chunk;
        const lines = traceBuffer.split('\n'); traceBuffer = lines.pop();
        for (const line of lines) {
          try { const value = JSON.parse(line); if (value.event === 'growth-loop.request') traces.push(value); } catch { /* Framework output is not a request trace. */ }
        }
      }
    });
    server = serving.child;
    let serverError;
    serving.completion.catch((error) => { serverError = error; });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (interrupted || serverError || server.exitCode !== null) throw new Error(`Server stopped: ${serverError?.message || serving.output()}`);
      if (baseUrl) {
        try {
          const response = await fetch(`${baseUrl}/api/agent`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) return;
        } catch { /* Await server readiness. */ }
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Server readiness timed out\n${serving.output()}`);
  };
  await startServer();
  const cookieJars = new Map();
  const initial = await fetch(`${baseUrl}/api/demo`).then((response) => response.json());
  const request = async (step) => {
    if (interrupted) throw new Error("Evaluation interrupted");
    if (step.restartServer) {
      stop(server); await serving.completion; await startServer();
      return { status: 200, body: { restarted: true } };
    }
    if (step.parallel) return { status: 200, body: { responses: await Promise.all(step.parallel.map(request)) } };
    if (!/^\/api\/[a-z0-9/-]+$/.test(step.path)) throw new Error(`Invalid local API path: ${step.path}`);
    const url = new URL(`${baseUrl}${step.path}`);
    for (const [key, value] of Object.entries(step.query || {})) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method: step.method || "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, ...(step.actor && cookieJars.has(step.actor) ? { Cookie: cookieJars.get(step.actor) } : {}), ...step.headers },
      ...(step.method === "GET" ? {} : { body: step.rawBody ?? JSON.stringify(step.body) }),
      signal: AbortSignal.timeout(mode === "llm" ? 120000 : 10000),
    });
    if (step.actor && response.headers.has('set-cookie')) {
      cookieJars.set(step.actor, response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '));
    }
    return { status: response.status, body: await response.json(), requestId: response.headers.get('x-request-id') };
  };
  const results = await executeCases(suite.cases, request, { mode, retrieval });
  const baselineFile = join(root, "scripts/eval/baseline.json");
  if (existsSync(baselineFile)) {
    results.push(...compareBaseline(results, JSON.parse(readFileSync(baselineFile, "utf8"))));
  }
  const final = await fetch(`${baseUrl}/api/demo`).then((response) => response.json());
  const seedUnchanged = JSON.stringify(initial) === JSON.stringify(final);
  if (!seedUnchanged) results.push({ id: "seed-integrity", status: "failed", stage: "final_state", errorCategory: "seed_changed" });
  const summary = { passed: 0, failed: 0, not_implemented: 0 };
  for (const result of results) summary[result.status]++;
  report = {
    schemaVersion: 1, mode, versions,
    retrieval: { strategy: retrieval, mockVectors: Boolean(vectorFixture), model: runtimeEnv.MEMORY_EMBEDDING_MODEL || null },
    model: mode === "rules" ? { provider: "demo", model: null } : {
      provider: runtimeEnv.LLM_PROVIDER || "openai-compatible",
      model: runtimeEnv.LLM_MODEL || runtimeEnv.OPENAI_MODEL || runtimeEnv.DEEPSEEK_MODEL || runtimeEnv.GLM_MODEL || "unknown",
    },
    promptVersionBasis: "sourceHashes identify entire provider files, including prompts; not separate prompt revisions",
    isolation: { freshServer: true, temporaryDirectory: true, personalEnvFilesCopied: false,
      seedUnchanged, database: "isolated SQLite; authenticated HTTP and restart checks", businessWritesVerified: results.some(result => result.id === "plan-query" && result.status === "passed") },
    observability: { traces, modelCalls: traces.flatMap(trace => trace.spans).filter(span => span.stage === 'model' || span.stage === 'embedding').length },
    summary, results,
  };
  process.exitCode = summary.failed || interrupted ? 1 : 0;
} catch (error) {
  report = { schemaVersion: 1, mode, versions, errorCategory: "evaluation_setup_failed", message: error.message };
  process.exitCode = 1;
} finally {
  stop(build);
  stop(server);
  if (vectorFixture) await vectorFixture.close();
  // Unlink the shared dependency junction before recursively removing only our temp directory.
  const dependencies = join(sandbox, "node_modules");
  if (existsSync(dependencies) && lstatSync(dependencies).isSymbolicLink()) unlinkSync(dependencies);
  const target = resolve(sandbox);
  if (dirname(target) !== tempRoot || !target.startsWith(`${tempRoot}${sep}growth-loop-eval-`)) throw new Error("Unsafe cleanup target");
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
console.log(JSON.stringify(report, null, 2));
