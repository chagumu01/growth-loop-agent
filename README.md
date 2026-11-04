# 成长回路 · Growth Loop Agent

把学习记录变成课程、练习和下一步行动的 AI 学习助手。

用户输入「今天学习了 Agent 工具调用，但还没弄懂失败时怎么办」→ 系统提供对话反馈、理解测验和课程学习入口 → 用户通过作答与练习留下可继续学习的证据，而不只是积累聊天记录。

> 当前版本：`0.2.0-prototype`。这是可运行的学习型 Agent 原型，包含 Next.js Web、Capacitor Android 壳、个人账号与 SQLite 数据层。首页仍包含演示数据，不能把演示统计当成真实学习成果。

## About

**GitHub 仓库简介：**

成长回路：将学习记录转化为课程、理解测验与下一步行动的 AI 学习 Agent，支持个人学习记忆、受控工具调用、课程技能复用与对抗式理解验证。基于 Next.js、React、SQLite 和 Capacitor。

**示例：**记录「学过 RAG，但分不清检索和生成」→ 通过测验暴露概念误解 → 在后续同主题课程生成时加入澄清约束。

## 可以体验什么

| 能力 | 输入 → 系统行为 → 结果 | 入口 |
| --- | --- | --- |
| 今日对话与复盘 | 输入「今天看了工具调用」→ 解析记录和意图、生成反馈 → 给出下一步；晚间回顾可追问行动、理解和明日计划 | 首页、`/api/agent` |
| AI 课程与讲师 | 输入主题「Agent 工具调用」、目标和基础 → 编排课程、补全讲解和练习 → 逐节学习、向讲师追问、提交课后开放题 | 课程工作台、`/api/learning-program` |
| 理解测验 | 提交学习底稿与个人理解 → 出题并按作答评分 → 返回逐题反馈与回看建议 | 记录页、`/api/quiz` |
| 个人行动 | 输入「安排一次工具契约复习」→ 提案、确认和服务端校验 → 创建本人任务；支持幂等与失败恢复 | `/account`、`/actions`、`/api/tools` |
| 学习记忆 | 保存「上次混淆了检索和生成」→ 建索引并检索 → 返回个人记录及原文引用 | `/memory`、`/api/memory` |
| 课程技能复用 | 重复生成符合相同约束的课程 → 检索模板、匹配参数并验收 → 合格的活跃技能返回课程，否则走原生成路径 | `lib/skill/` |
| 对抗式理解验证（可选） | 作答错误陈述「只要调用工具成功，Agent 任务就一定完成」→ 独立核验与判卷 → 识别误解，或在无法判断时弃权 | `lib/verification/`、`/api/verification` |
| 微信与 Android | 微信发送学习记录 → 服务端文本回复；Android 打开应用 → 加载 Next.js 页面与 API | `/api/wechat`、`android/` |

## 核心机制

### 学习记忆：把历史证据带回学习过程

个人记录、反馈、索引和会话相关数据存入 SQLite，并按用户隔离。检索支持关键词和可选向量服务；没有向量配置时仍可使用关键词检索。浏览器历史需要本人确认后导入，导入按原 ID 去重并排除演示种子。

**例子：**用户保存「Agent 工具调用失败后要保留状态」→ 在记忆页检索「工具调用」→ 返回对应记录与原文，供用户回看。对抗测验发现的未解决误解和同主题反馈，还会作为后续课程生成的约束。

### 程序性记忆：课程模板先验证，再复用

目前技能范围是 `course.generate`，不是任意任务的自动学习。系统记录课程生成轨迹，尝试将成功轨迹提炼成参数化模板。候选技能需要影子验证；活跃技能也需要满足触发参数和课程结构验收。返回的技能课程使用新的课程、章节和题目 ID，并标记 `mode=skill`。

**例子：**同一类课程最近 5 次轨迹有 4 次成功 → 成功比例为 `4/5=80%`，且成功次数不少于 3，满足提炼前置条件 → 模型尝试生成候选模板；这不等于模板已经上线。

候选模板必须与真实 LLM 课程在去除 ID、时间、模式等元数据后内容一致，连续通过 5 次影子验证才晋升。该条件非常保守，不能宣称候选模板能稳定自动晋升。

**例子：**候选模板连续通过 4 次，第 5 次讲解内容与 LLM 结果不同 → 连续成功计数归零 → 继续使用原生成路径。已有活跃技能最近连续 3 次计入惩罚的执行均未成功，则会被停用。

### 对抗式理解验证：检查是否识破错误前提

启用后，已登录用户的合适测验可追加错误陈述题，由 Generator 生成、Verifier 独立核验、Judge 判断用户是否识破。它们是分离的逻辑角色，可以配置不同模型与端点；默认配置并不保证来自不同模型或供应商。课程章节评分和记录测验是不同入口，这套追加题机制接在记录测验链路。

**例子：**原测验有 3 道题 → 追加 1 道经核验的错误陈述题 → 对抗题比例为 `1/(3+1)=25%`。原测验不足 3 道时不会追加，不是随机抽取四分之一的测验。

判卷区分 `caught`（识破）、`missed`（未识破）、`misidentified`（指错位置）。模型不可用或结果不合格时返回 `abstained=true`，不据此写入误解。未识破或指错位置且未弃权时，才记录误解；后续同主题课程遇到这些约束时跳过技能快捷路径，重新生成。

**例子：**用户回答「工具成功就代表任务完成」→ Judge 确认没有识破错误 → 保存相关误解；若 Judge 超时 → 标记弃权 → 不把服务失败当成用户不理解。

### 工具执行：对话建议经过确认才能落库

个人行动链路包含工具协议、参数校验、确认、执行、幂等与恢复。模型生成的建议不能直接等同于数据已写入。

**例子：**用户要求「明天复习工具契约」→ 先展示待确认操作 → 确认后创建个人任务；重复执行同一幂等请求不会重复创建任务。

## 快速开始

需要 Node.js **≥22.13.0** 和 npm，推荐 Node.js 24。项目使用内置 SQLite，需要 Node.js 服务和可持久化的数据库路径。

下面以 Windows PowerShell 为例：

```powershell
git clone https://github.com/chagumu01/growth-loop-agent.git
Set-Location growth-loop-agent
npm.cmd install
Copy-Item -LiteralPath .env.example -Destination .env.local
npm.cmd run dev
```

打开 [http://127.0.0.1:3000/](http://127.0.0.1:3000/)。其他系统可使用 `npm`，并用对应的文件复制命令准备 `.env.local`。

**体验例子：**保持 `LLM_PROVIDER=demo`、不填写密钥 → 打开首页记录学习内容 → 使用本地规则体验反馈；课程和判卷的规则回退不能代表真实模型质量。

使用个人数据时，先在 `/account` 注册登录，再访问 `/actions` 和 `/memory`。当前账号为 3–40 位字母、数字、下划线或连字符，密码至少 10 位，尚无密码找回。

**数据例子：**登录后保存一条工具调用笔记 → 进入个人 SQLite 数据层；在课程工作台学习一节课 → 课程进度仍保存在当前浏览器 localStorage，不会自动变成多端同步课程档案。课程反馈需要主动保存到记忆。

生产式本地运行：

```powershell
npm.cmd run build
npm.cmd run start -- --hostname 127.0.0.1 --port 3000
```

## 配置

完整变量及说明见 [`.env.example`](.env.example)。

| 配置 | 用途 | 示例 |
| --- | --- | --- |
| `LLM_PROVIDER`、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` | OpenAI-compatible `/chat/completions`；也支持对应 provider 配置 | 设置真实端点和模型后，课程生成可使用 LLM；未配置时回退 |
| `LLM_THINKING_MODE` | 可选的供应商 thinking 参数 | 供应商支持时填写 `enabled` 或 `disabled`；留空保留默认行为 |
| `MEMORY_DB_PATH` | 个人数据持久化路径 | 默认 `.data/memory.sqlite`；更换部署实例时需保留该文件及相关事务数据 |
| `MEMORY_EMBEDDING_BASE_URL`、`MEMORY_EMBEDDING_API_KEY`、`MEMORY_EMBEDDING_MODEL` | 可选向量检索 | 配置后可索引学习笔记；未配置则使用关键词检索 |
| `VERIFICATION_ENABLED` | 对抗式理解验证开关，默认 `false` | 改为 `true` 后，登录用户符合条件的记录测验可追加验证题 |
| `VERIFICATION_{GENERATOR,VERIFIER,JUDGE}_{MODEL,BASE_URL,API_KEY}` | 对抗验证各角色的可选独立配置 | Verifier 可单独配置模型；留空时回退到公共 `LLM_*` / `OPENAI_*` 配置 |
| `APP_VERSION` | 请求轨迹中的部署版本 | 填入部署提交号以区分两次课程生成所属版本 |
| `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_TOKEN` | 微信公众号接入 | 配置公众号回调到 `https://你的域名/api/wechat` |

服务状态可通过 `GET /api/agent` 和 `GET /api/learning-program` 查看。密钥只能保存在本地环境或部署 Secret，不能写进前端和 Git。

## API 与代码位置

| 接口 | 主要用途 | 代码 |
| --- | --- | --- |
| `GET/POST /api/agent` | 状态、学习记录对话与复盘 | `lib/agent/` |
| `POST /api/learning-program` | `generate`、`tutor`、`grade` | `lib/learning-program/`、`lib/skill/` |
| `POST /api/quiz` | `generate`、`grade`；可选对抗验证 | `lib/agent/quiz.ts`、`lib/verification/` |
| `/api/memory`、`/api/memory/session` | 个人学习记忆与账号会话 | `lib/memory/` |
| `/api/tools` | 个人行动的受控工具操作 | `lib/tools/` |
| `GET /api/verification` | 当前用户验证事件聚合与通过率 | `app/api/verification/route.ts` |
| `GET /api/demo` | 确定性演示数据 | `lib/demo-data.ts` |
| `/api/wechat`、`/api/wechat/status` | 公众号明文回调、状态 | `lib/wechat/` |

例如，在登录后的页面中生成「Agent 工具调用」课程，会经 `/api/learning-program` 进入课程服务，并在具备用户上下文时执行技能检索与轨迹记录；匿名生成仍可使用原课程路径。

## 验证与评测

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd run eval:critical
npm.cmd run eval:test
npm.cmd run eval
npm.cmd run eval:compare
```

`eval:critical` 自动发现 `lib/` 下的领域测试，使用隔离合成数据并禁用真实模型。`eval` 构建和启动隔离服务，需要仓库父目录写权限与构建空间，不复制个人数据库和 `.env`。`eval:compare` 默认使用关键词与本地合成向量比较，不代表真实向量模型的效果。

**例子：**修改确认后执行的逻辑 → 运行 `eval:critical` 检查工具协议、确认、执行与恢复等领域行为 → 再用隔离服务评测检查接口链路，避免拿本人任务库做回归。

真实模型验证需要在进程环境提供配置，调用会产生供应商费用：

```powershell
npm.cmd run learning:smoke -- --require-llm
npm.cmd run eval:llm
# paired.json 需按评测脚本格式准备配对标注样本
npm.cmd run eval:verification -- --data paired.json --label human
```

仓库包含对抗验证的受控实验产物，但不将固定样本结果宣传为真实用户效果。

**指标算例（仅解释口径）：**若 20 次课程请求中有 18 次命中技能，其中 1 次未通过验收，有效复用比例为 `(18-1)/20=85%`；只报 `18/20=90%` 会把失败命中也当成收益。

## Android 与微信

Android 使用 Capacitor 加载远程 Next.js 服务，默认地址为 `http://10.0.2.2:3000`，可通过 `CAPACITOR_SERVER_URL` 调整。需要 Android SDK、AVD 与 Java 21。

```powershell
npm.cmd run android:debug
npm.cmd run android:status
npm.cmd run android:stop
```

**例子：**电脑启动 Next.js 服务 → Android Emulator 通过 `10.0.2.2:3000` 访问 → 在移动壳中使用相同的课程与 API。它不是打包后可离线运行的完整学习服务。现有 APK 位于 [`artifacts/android/growth-loop-debug.apk`](artifacts/android/growth-loop-debug.apk)，属于 debug 构建。

微信公众号目前支持签名验证与明文 XML 文本回调。

**例子：**用户向公众号发送「今天学习了 RAG」→ `/api/wechat` 校验并处理文本 → 返回对话回复；该能力不等于微信登录、支付或加密回调已经完成。

## 当前边界

| 范围 | 当前状态与具体影响 |
| --- | --- |
| 数据一致性 | 首页和成长统计含 demo；例如看到演示 XP，不代表本人完成了一次真实学习任务 |
| 课程进度 | 使用浏览器 localStorage；例如换手机后不会自动恢复电脑上的章节进度 |
| 技能复用 | 仅覆盖课程生成且触发参数严格；例如更换学习目标后不能保证复用旧模板 |
| 理解判断 | 依赖模型与题目核验，不能承诺消除幻觉；例如 Judge 弃权应人工复核或重试 |
| 部署存储 | SQLite 需要持久化文件系统；例如部署到临时文件系统，重建实例后不能指望原库仍存在 |
| 通知与账号 | 无正式后台通知调度、密码找回和完整数据导出；例如创建复习任务不等于届时自动推送 |
| 发布准备 | 微信加密回调、重放保护、生产限流，以及 Android release 签名与真机验收仍需完善 |
| 许可 | 当前没有单独开源许可证；公开源码不等于已授予任意复用许可 |

备份 SQLite 应使用备份工具或停服备份，避免遗漏 WAL 中的事务。不要提交 `.env.local`、数据库、密钥或本机 Android SDK 配置。

## 进一步阅读

- [开发者手册](docs/DEVELOPER_HANDBOOK.md)：开发、检查和交接。
- [Web 服务配置](docs/WEB_SERVICE_SETUP.md)：服务启动与部署环境。
- [AI 学习程序](docs/LEARNING_PROGRAM.md)：课程、讲师与评分契约。
- [微信公众号接入](docs/WECHAT_INTEGRATION.md)：签名和文本回调。
- [Android 构建](docs/ANDROID_BUILD.md) / [APK 调试](docs/ANDROID_APK_DEBUG_AI.md)：模拟器和调试链路。

技术栈：Next.js 16.3 · React 19.2 · TypeScript · Node.js SQLite · Capacitor 8。
