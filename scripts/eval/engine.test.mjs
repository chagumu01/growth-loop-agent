import assert from "node:assert/strict";
import test from "node:test";
import { assertChecks, compareBaseline, evaluationEnvironment, executeCases } from "./engine.mjs";

const scenario = (id, steps) => ({ id, capability: "implemented", initialData: { fresh: true },
  allowedOperations: ["read synthetic response"], expectedBusinessState: "not persisted", steps });
const ok = { path: "/api/agent", checks: [{ path: "status", equals: 200 }] };

test("a failed case does not hide later results or count missing capabilities as passed", async () => {
  const cases = [scenario("fails", [{ ...ok, checks: [{ path: "status", equals: 400 }] }]),
    scenario("passes", [ok]),
    { id: "pending", capability: "not_implemented", reason: "No persistence yet", issue: 2, expectedBusinessState: "stored" }];
  let requests = 0;
  const result = await executeCases(cases, async () => { requests++; return { status: 200 }; });
  assert.deepEqual(result.map((r) => r.status), ["failed", "passed", "not_implemented"]);
  assert.equal(result[0].stage, "assertion");
  assert.equal(result[0].step, 1);
  assert.equal(requests, 2);
});

test("generated response captures drive subsequent requests and stay scoped to one case", async () => {
  const requests = [];
  const result = await executeCases([
    scenario("flow", [{ ...ok, capture: "generated" }, { ...ok,
      body: { id: { $ref: "generated.id" }, conversationId: "$session:a" } }]),
    scenario("separate", [{ ...ok, body: { id: { $ref: "generated.id" } } }]),
  ], async (request) => { requests.push(request); return { status: 200, body: { id: "synthetic-quiz" } }; });
  assert.equal(requests[1].body.id, "synthetic-quiz");
  assert.equal(requests[1].body.conversationId, "eval-flow-a");
  assert.equal(result[0].status, "passed");
  assert.equal(result[1].status, "failed");
});

test("unknown, empty and vacuous assertions fail rather than silently passing", () => {
  assert.throws(() => assertChecks({}, []));
  assert.throws(() => assertChecks({}, [{ path: "body", equal: true }]));
  assert.throws(() => assertChecks({}, [{ path: "body" }]));
  assert.throws(() => assertChecks({ score: NaN }, [{ path: "score", min: 0 }]));
  assert.throws(() => assertChecks({ score: 101 }, [{ path: "score", max: 100 }]));
});

test("malformed capabilities and duplicate ids stop the run", async () => {
  const request = async () => { throw new Error("Must not execute"); };
  await assert.rejects(executeCases([scenario("duplicate", [ok]), scenario("duplicate", [ok])], request));
  await assert.rejects(executeCases([{ id: "unknown", capability: "skip" }], request));
});

test("network failures carry request-stage evidence", async () => {
  const [result] = await executeCases([scenario("offline", [ok])], async () => { throw new Error("connection refused"); });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCategory, "request_failed");
  assert.equal(result.message, "connection refused");
});

test("default mode strips inherited live credentials and redirects persistent storage", () => {
  const source = { PATH: "tools", LLM_PROVIDER: "openai", LLM_API_KEY: "synthetic-key",
    OPENAI_API_KEY: "synthetic-key", DEEPSEEK_API_KEY: "synthetic-key", GLM_MODEL: "live",
    WECHAT_TOKEN: "synthetic-key", MEMORY_DB_PATH: "personal.sqlite", MEMORY_EMBEDDING_API_KEY: "synthetic-key" };
  const rules = evaluationEnvironment(source, "/temporary/evaluation");
  assert.equal(rules.PATH, "tools");
  assert.equal(rules.LLM_PROVIDER, "demo");
  for (const key of ["LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "GLM_MODEL", "WECHAT_TOKEN", "MEMORY_EMBEDDING_API_KEY"]) {
    assert.equal(rules[key], undefined);
  }
  assert.equal(rules.MEMORY_DB_PATH, "/temporary/evaluation/memory.sqlite");
  const llm = evaluationEnvironment(source, "/temporary/evaluation", "llm");
  assert.equal(llm.LLM_API_KEY, "synthetic-key");
  assert.equal(llm.WECHAT_TOKEN, undefined);
  assert.equal(source.MEMORY_DB_PATH, "personal.sqlite");
});

test("removing a baseline case or relabeling a passing case as unimplemented is a regression", () => {
  const baseline = { results: [{ id: "existing", status: "passed" }, { id: "future", status: "not_implemented" }] };
  assert.equal(compareBaseline([{ id: "existing", status: "not_implemented" }], baseline).length, 2);
  assert.deepEqual(compareBaseline([{ id: "existing", status: "passed" }, { id: "future", status: "passed" }], baseline), []);
});
