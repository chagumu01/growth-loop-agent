import assert from "node:assert/strict";

export function readPath(value, path) {
  return path.split(".").reduce((current, key) =>
    current != null && Object.hasOwn(current, key) ? current[key] : undefined, value);
}

export function resolveInput(value, captures, session, mode, retrieval = "keyword") {
  if (value === "$mode") return mode === "llm" ? "llm" : "demo";
  if (value === "$grading") return mode === "llm" ? "llm" : "rules";
  if (value === "$index") return retrieval === "hybrid" ? "ready" : "keyword";
  if (typeof value === "string" && value.startsWith("$session:")) return `${session}-${value.slice(9)}`;
  if (Array.isArray(value)) return value.map((item) => resolveInput(item, captures, session, mode, retrieval));
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "$ref")) {
      assert.equal(Object.keys(value).length, 1, "$ref must be the only key");
      const result = readPath(captures, value.$ref);
      assert.notEqual(result, undefined, `Missing captured response: ${value.$ref}`);
      return result;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, resolveInput(item, captures, session, mode, retrieval)]));
  }
  return value;
}

export function assertChecks(response, checks) {
  assert.ok(Array.isArray(checks) && checks.length > 0, "Each step needs assertions");
  const allowed = new Set(["path", "equals", "contains", "length", "min", "max", "absent"]);
  for (const check of checks) {
    assert.equal(typeof check.path, "string", "Assertion requires a path");
    assert.ok(Object.keys(check).every((key) => allowed.has(key)), `Unknown assertion: ${JSON.stringify(check)}`);
    assert.ok(Object.keys(check).length > 1, `No assertion for ${check.path}`);
    const value = readPath(response, check.path);
    if (Object.hasOwn(check, "equals")) assert.deepEqual(value, check.equals, check.path);
    if (Object.hasOwn(check, "absent")) {
      assert.equal(check.absent, true, "absent must be true");
      assert.equal(value, undefined, check.path);
    }
    if (Object.hasOwn(check, "contains")) {
      assert.ok(typeof value === "string" || Array.isArray(value), `${check.path} is not searchable`);
      assert.ok(value.includes(check.contains), `${check.path} does not contain ${JSON.stringify(check.contains)}`);
    }
    if (Object.hasOwn(check, "length")) assert.equal(value?.length, check.length, check.path);
    for (const bound of ["min", "max"]) {
      if (!Object.hasOwn(check, bound)) continue;
      assert.ok(Number.isFinite(value), `${check.path} must be a finite number`);
      assert.ok(bound === "min" ? value >= check.min : value <= check.max, `${check.path} violates ${bound} ${check[bound]}`);
    }
  }
}

export async function executeCases(cases, request, { mode = "rules", retrieval = "keyword" } = {}) {
  assert.ok(Array.isArray(cases) && cases.length > 0, "Scenario set must not be empty");
  const seen = new Set();
  for (const scenario of cases) {
    assert.ok(scenario.id && !seen.has(scenario.id), `Missing/duplicate scenario id: ${scenario.id}`);
    seen.add(scenario.id);
    assert.ok(["implemented", "not_implemented"].includes(scenario.capability), `Unknown capability: ${scenario.id}`);
  }
  const results = [];
  for (const scenario of cases) {
    if (scenario.capability === "not_implemented") {
      assert.ok(scenario.reason && scenario.issue && scenario.expectedBusinessState, `Missing gap evidence: ${scenario.id}`);
      results.push({ id: scenario.id, status: "not_implemented", issue: scenario.issue,
        reason: scenario.reason, expectedBusinessState: scenario.expectedBusinessState });
      continue;
    }
    const start = performance.now();
    let stage = "setup";
    let stepIndex = -1;
    try {
      assert.ok(scenario.initialData && scenario.allowedOperations && scenario.expectedBusinessState, `Missing scenario contract: ${scenario.id}`);
      assert.ok(Array.isArray(scenario.steps) && scenario.steps.length, `Missing steps: ${scenario.id}`);
      const captures = {};
      const traceIds = [];
      for (const [index, step] of scenario.steps.entries()) {
        stepIndex = index;
        stage = "request";
        const input = resolveInput(step, captures, `eval-${scenario.id}`, mode, retrieval);
        const response = await request(input);
        if (response.requestId) traceIds.push(response.requestId);
        stage = "assertion";
        assertChecks(response, input.checks);
        if (step.capture) captures[step.capture] = response.body;
      }
      results.push({ id: scenario.id, status: "passed", durationMs: Math.round(performance.now() - start),
        businessState: scenario.expectedBusinessState, traceIds });
    } catch (error) {
      results.push({ id: scenario.id, status: "failed", stage, step: stepIndex + 1,
        errorCategory: stage === "assertion" ? "assertion_failed" : stage === "request" ? "request_failed" : "invalid_scenario",
        message: error.message, durationMs: Math.round(performance.now() - start) });
    }
  }
  return results;
}

export function evaluationEnvironment(source, directory, mode = "rules") {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (/^(LLM_|OPENAI_|DEEPSEEK_|GLM_|WECHAT_|MEMORY_)/.test(key)) delete environment[key];
  }
  if (mode === "llm") {
    for (const [key, value] of Object.entries(source)) {
      if (/^(LLM_|OPENAI_|DEEPSEEK_|GLM_)/.test(key)) environment[key] = value;
    }
  } else environment.LLM_PROVIDER = "demo";
  return { ...environment, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", TEMP: directory, TMP: directory, TMPDIR: directory,
    MEMORY_DB_PATH: `${directory}/memory.sqlite` };
}

export function compareBaseline(results, baseline) {
  const current = new Map(results.map((result) => [result.id, result.status]));
  return baseline.results.filter((previous) => !current.has(previous.id)
    || (previous.status === "passed" && current.get(previous.id) !== "passed"))
    .map((previous) => ({ id: previous.id, status: "failed", stage: "baseline",
      errorCategory: "baseline_regression", message: `Previously ${previous.status}; now ${current.get(previous.id) || "missing"}` }));
}
