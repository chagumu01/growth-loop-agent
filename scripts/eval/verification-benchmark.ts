import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gradeLearningQuiz, type GeneratedQuiz } from '../../lib/agent/quiz';
import { judgeAnswer } from '../../lib/verification/judge';
import { verifyTrap } from '../../lib/verification/verifier';
import { generateTrap, type Trap } from '../../lib/verification/generator';
import { traceRequest, type RequestTrace } from '../../lib/observability/trace';

// These are authored controls, not observations of real learners or human blind labels.
// Freeze all inputs before any model invocation; retain all failures and abstentions.
const controls = [
  { concept: '事务提交与回滚', core: '事务用原子性保证事务内操作全部成功或全部失败。', correct: '事务提交后不能直接回滚，撤销业务效果需要补偿操作。', wrong: '事务提交后仍可以直接回滚', caught: '不成立。提交已使事务结束，不能再直接回滚，应另起事务做补偿。', misidentified: '错误在于事务不能保证原子性；提交后直接回滚是成立的。' },
  { concept: 'SQL 参数化查询', core: '参数化查询把 SQL 代码与参数值分开处理。', correct: '参数化保护的是绑定值；动态表名和列名仍需白名单校验。', wrong: '参数化查询会自动保护拼接的表名', caught: '不成立。表名不是可绑定的普通值，动态标识符要用白名单，不能直接拼接输入。', misidentified: '错误在于不应对字符串值使用参数绑定；拼接表名本身是安全的。' },
  { concept: 'HTTP 幂等性', core: '幂等描述同一操作重复执行后的预期服务端效果。', correct: '幂等不要求每次响应码或响应体相同，例如重复 DELETE 的响应可不同。', wrong: '幂等请求每次必须返回相同状态码', caught: '不成立。幂等约束重复操作的效果，第一次 DELETE 成功后再次返回 404 也可满足幂等。', misidentified: '错误是 DELETE 永远不幂等；幂等操作确实必须每次返回同一个状态码。' },
  { concept: 'JavaScript Promise', core: 'Promise 表示异步操作最终完成或失败的状态。', correct: 'Promise 的 executor 在构造时同步调用，then 回调才进入微任务队列。', wrong: 'Promise 的 executor 一定在微任务中执行', caught: '不成立。new Promise 的 executor 同步执行，then 的回调才排入微任务。', misidentified: '错误是 then 回调会同步执行；executor 放在微任务中是正确的。' },
  { concept: 'TypeScript 运行时校验', core: 'TypeScript 在编译阶段对程序做静态类型检查。', correct: '类型断言会在编译后擦除，不能验证外部 JSON 的运行时结构。', wrong: '使用类型断言就能校验外部 JSON 的运行时结构', caught: '不成立。as 断言只是静态声明；外部 JSON 要在运行时用 schema 或显式规则验证。', misidentified: '错误是 TypeScript 不能做静态检查；as 类型断言本身能验证外部 JSON。' },
  { concept: '统计显著性与效应量', core: 'p 值用于在零假设下评估观察到的数据及更极端结果的概率。', correct: 'p 值小不代表效应大，也不代表业务收益大，需要同时查看效应量和区间。', wrong: 'p 值越小就必然说明业务效应越大', caught: '不成立。p 值受样本量等因素影响，效应大小要看效应量，业务价值还需要单独判断。', misidentified: '错误在于显著性检验必须只用于大效应；p 值越小确实能直接保证业务效应越大。' },
  { concept: 'A/B 测试随机分组', core: '随机分组有助于减少处理组与对照组的系统性选择偏差。', correct: '随机化不能保证有限样本的每个协变量完全相同，需要检查分组和样本情况。', wrong: '随机分组能保证有限样本中的所有特征完全平衡', caught: '不成立。随机化保证分配机制随机，不保证有限样本每个特征数值相等，仍需检查平衡与异常。', misidentified: '错误是随机化会必然制造选择偏差；随机组里的所有特征确实应完全一样。' },
  { concept: '向量归一化与相似度', core: '余弦相似度衡量向量方向之间的相近程度。', correct: '点积等于余弦相似度需要两个非零向量都做单位长度归一化。', wrong: '任意非零向量的点积都等于余弦相似度', caught: '不成立。点积还受长度影响，只有两个向量都归一化为单位长度时两者才相等。', misidentified: '错误是余弦相似度比较的是长度；任意非零向量的点积都等于余弦相似度没有问题。' },
  { concept: '缓存 TTL 与一致性', core: 'TTL 控制缓存条目在多长时间后失效。', correct: 'TTL 限制缓存有效时长，但 TTL 到期前仍可能读到旧值，不能保证强一致。', wrong: '只要设置 TTL 就可以保证缓存与数据库强一致', caught: '不成立。TTL 到期前仍可能陈旧；强一致需要额外协调，不能只靠过期时间。', misidentified: '错误是缓存条目不能设置过期时间；TTL 本身确实可以确保数据库与缓存强一致。' },
  { concept: 'Agent 工具调用与授权', core: 'Agent 可以通过结构化参数向工具发起操作请求。', correct: '模型生成合法参数只是提议，涉及受保护操作仍须服务端身份与权限校验。', wrong: '模型生成合法工具参数就等于用户授权', caught: '不成立。参数合法只说明格式正确，执行还要核验服务端身份、权限以及必要的用户确认。', misidentified: '错误在于工具不应使用结构化参数；模型生成合法参数就能代表用户授权。' },
];
const arguments_ = process.argv.slice(2);
if (![2, 4].includes(arguments_.length) || arguments_[0] !== '--output' || (arguments_.length === 4 && arguments_[2] !== '--reuse-baseline')) throw new Error('Usage: node --env-file=.env.local --import tsx scripts/eval/verification-benchmark.ts --output artifacts/eval/controlled.json [--reuse-baseline complete-report.json]');
const output = resolve(arguments_[1]);
if (!(process.env.LLM_API_KEY && process.env.LLM_BASE_URL && process.env.LLM_MODEL)) throw new Error('A configured live LLM is required; no mock provider is installed');
const traces: RequestTrace[] = [];
async function traced<T>(id: string, work: () => Promise<T>): Promise<T> {
  let value!: T;
  await traceRequest(new Request(`http://evaluation.local/api/benchmark/${id}`), async () => { value = await work(); return Response.json({ ok: true }); }, trace => traces.push(trace));
  return value;
}
function ordinary(index: number): GeneratedQuiz {
  const control = controls[index];
  const questions = [
    { id: 'concept', prompt: `解释「${control.concept}」的核心机制。`, hint: '定义与作用', rubric: '定义准确，解释清楚作用。' },
    { id: 'application', prompt: `给出一个「${control.concept}」的应用场景，并说明行动和验证结果。`, hint: '场景、行动、结果', rubric: '场景具体、步骤可执行、结果可验证。' },
    { id: 'boundary', prompt: `「${control.concept}」使用时需要注意什么条件或边界？`, hint: '说明前提', rubric: '正确解释适用条件，不能过度推论。' },
  ];
  return { quizId: `controlled-${index}`, topic: control.concept, sourceSummary: `${control.core}${control.correct}`, questions, internalQuestions: questions.map(q => ({ ...q, keywords: [] })), mode: 'llm', provider: process.env.LLM_MODEL! };
}
const frozen = controls.flatMap((control, index) => (['caught', 'missed', 'misidentified'] as const).map(verdict => {
  const answer = verdict === 'caught' ? control.caught : verdict === 'misidentified' ? control.misidentified : `陈述正确。${control.wrong}，这就是它的工作原理，所以实际应用中也可以直接这样判断。`;
  return { id: `control-${index}-${verdict}`, learnerId: `synthetic-${index}-${verdict}`, concept: control.concept, index, expectedVerdict: verdict,
    syntheticTruth: verdict === 'caught' ? 'mastered' : 'false_mastery', initialPassed: true,
    trapAnswer: answer, answers: { concept: control.core, application: `例如在真实项目中，先按这个机制处理请求，再检查结果是否符合要求。${control.core}`, boundary: verdict === 'caught' ? control.correct : `${control.wrong}，因此无需额外检查这个条件。` } };
}));
const baselineCache = arguments_[3] ? JSON.parse(readFileSync(arguments_[3], 'utf8')) as { complete: boolean; datasetHash: string; model: string; thinkingMode: string; samples: Array<{ id: string; baselineScore: number; baselineGradedBy: 'llm' | 'rules' }> } : null;
if (baselineCache && (!baselineCache.complete || baselineCache.model !== process.env.LLM_MODEL || baselineCache.thinkingMode !== (process.env.LLM_THINKING_MODE || 'provider-default') || baselineCache.datasetHash !== createHash('sha256').update(JSON.stringify(frozen)).digest('hex'))) throw new Error('Baseline cache must be complete and use the identical dataset, model and thinking mode');
const results: Record<string, unknown>[] = [], generation: Record<string, unknown>[] = [];
const started = Date.now();
mkdirSync(dirname(output), { recursive: true });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Archive checkout. */ }
const sourcePaths = ['lib/agent/quiz.ts', 'lib/verification/model.ts', 'lib/verification/generator.ts', 'lib/verification/verifier.ts', 'lib/verification/judge.ts'];
const metadata = { schemaVersion: 1, datasetOrigin: 'synthetic-controlled', createdAt: new Date().toISOString(), commit,
  sourceTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
  model: process.env.LLM_MODEL, thinkingMode: process.env.LLM_THINKING_MODE || 'provider-default', datasetHash: hash(JSON.stringify(frozen)), sourceHashes: Object.fromEntries(sourcePaths.map(path => [path, hash(readFileSync(path, 'utf8'))])),
  baselineReuse: arguments_[3] ? { report: resolve(arguments_[3]), hash: hash(readFileSync(arguments_[3], 'utf8')) } : null,
  caveat: '30 authored answer controls, 10 concepts, no real learners or human blind review. Baseline gets ordinary quiz answers; candidate gets a separate trap answer. This compares product screening flows, not the causal effect of role isolation. Strict verifier failures are abstentions. Initial mastery is a synthetic assumption. No answer or label is sent to Generator/Verifier except their whitelisted inputs.' };
function save() { writeFileSync(output, JSON.stringify({ ...metadata, complete: results.length === frozen.length && generation.length === controls.length, elapsedMs: Date.now() - started, controls, samples: results, generation, traces }, null, 2) + '\n'); }
let next = 0;
async function main() {
await Promise.all(Array.from({ length: 2 }, async () => {
  while (next < controls.length) {
    const index = next++, control = controls[index];
    const trap: Trap = { id: `trap-${index}`, concept: control.concept, prompt: `判断以下陈述是否成立，并说明理由：${control.wrong}。`, injected_error: control.wrong, correct_version: control.correct, error_type: '边界外推', why_plausible: '把核心机制过度推广到边界情况' };
    const verified = await traced(`verify-${index}`, () => verifyTrap(trap));
    for (const fixture of frozen.filter(row => row.index === index)) {
      const cached = baselineCache?.samples.find(row => row.id === fixture.id);
      if (baselineCache && !cached) throw new Error(`Missing cached pair: ${fixture.id}`);
      const [baseline, judgment] = await Promise.all([
        cached ? Promise.resolve({ score: cached.baselineScore, gradedBy: cached.baselineGradedBy }) : traced(`baseline-${fixture.id}`, () => gradeLearningQuiz(ordinary(index), fixture.answers)),
        verified ? traced(`judge-${fixture.id}`, () => judgeAnswer(verified, fixture.trapAnswer)) : Promise.resolve(null),
      ]);
      results.push({ ...fixture, baseline: baseline.gradedBy === 'llm' ? baseline.score < 60 ? 'flagged' : 'clear' : 'abstained', baselineScore: baseline.score,
        baselineGradedBy: baseline.gradedBy, candidate: !judgment || judgment.abstained ? 'abstained' : judgment.verdict === 'caught' ? 'clear' : 'flagged',
        candidateVerdict: judgment && !judgment.abstained ? judgment.verdict : null, verifierPassed: Boolean(verified), judgment });
      save(); console.error(`[benchmark] ${results.length}/${frozen.length} ${fixture.id}; baseline=${baseline.score}; candidate=${judgment?.verdict ?? 'verifier-discarded'}`);
    }
    const generated = await traced(`generator-${index}`, () => generateTrap({ concept: control.concept, knowledge: `${control.core}${control.correct}`, misconceptions: [], difficulty: '边界条件' }));
    const checked = generated ? await traced(`generated-verifier-${index}`, () => verifyTrap(generated)) : null;
    generation.push({ concept: control.concept, generated: Boolean(generated), verifierPassed: Boolean(checked), trap: generated });
    save();
  }
}));
save();
console.log(JSON.stringify({ output, samples: results.length, generated: generation.length, model: metadata.model, elapsedMs: Date.now() - started }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
