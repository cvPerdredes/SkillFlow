# SkillFlow v0.3.1 · 跨电脑 Antigravity 续研与审查交接手册

> **用途**：用于在更换开发电脑后，在新安装的 **Antigravity IDE** 中无缝恢复“**架构师独立审查 + 独立开发实现**”双对话协同节奏，确保安全红线、冻结文档与已验收成果零丢失。

---

## 一、当前封版里程碑（`v0.3.1` 已验收封版）

当前提交已完整交付并验证通过 **v0.3（Phase 0–3 全量闭环）** + **v0.3.1（模块 A + 模块 B 工程收口）**：

### 已完成能力清单
1. **Phase 0–3 冻结核心能力**：
   - 双固定端口跨系统仿真（系统 A `18761` 支持 `?layout=v2` / `?ambiguous=1` / `?needAuth=1`；系统 B `18762` 台账回执与 12 行 `sample_batch.csv`）。
   - 录制统一串行队列（`background.js`）、登录检查点 `auth_checkpoint` 折叠与模式 A（人工接管）/ 模式 B（纯内存临时密文填单，遇验证码自动降级）、双端 `isSensitive` 100% 校验与凭据零残留。
   - 轻量化 `dom-distiller.js`（平均 **94.1%** 压缩率）、`ExecutionDriver` + `Mv3ContentScriptDriver` 严格解耦、会话级不可变 `planHash` 审批门禁（`chrome.storage.session` 持久化防 SW 休眠丢失 + 防参数篡改）。
   - OpenAI-Compatible ≤ 284B 模型适配（`<think>` 剥离、1× 带错重试、超限拦截、Mock 降级）与 4+1 原子接口（`matchSkill` / `analyzeTrace` / `extractArgs` / `planQuery` / `explainRun`）。
   - 1→N CSV 批量执行（试跑前 2 条门禁、`forceReload` 复位、`L0–L3` 核验区分、`WRITE_OUTCOME_UNKNOWN` 严禁自动重放）、确定性 `reduce` 统计与纯 DOM 分布柱状图、单步元素重绑（Re-bind）、`SKILL.md` / MCP Tool JSON / 脱敏评测遥测 JSON 导出。
2. **v0.3.1 模块 A（真机体验收口 + 技能库与账本导出）**：
   - `pickPreferredStatusSelector` 优先识别 `#result-summary` / `#receipt-status` 而避开数据表格；`start()` 重置 02 区配置；`execute()` 立即清空旧摘要与图表；`.status` 胶囊单行渲染 + 全局 `[hidden] { display: none !important; }` 防护 + 窄下拉框文案精简。
   - 技能 JSON 导入强校验与投毒拦截（`store.importSkillJson` 拦截 `executeScript` / 非法 `origin` / 敏感明文并去重覆盖）、技能关键词检索（配合 `selectSkillInPicker` 防过滤态选中失效）、内联两步确认删除技能（0 `window.confirm`）。
   - 历史执行账本切换器（`runHistoryPicker`）+ 复查分布追问；明细与失败清单 CSV 导出（UTF-8 BOM + RFC-4180 转义 + `sanitizeCsvFormulaCell` 公式注入防护且不误伤纯负数 + 敏感字段脱敏）。
3. **v0.3.1 模块 B（可维护录制与断点运维）**：
   - 步骤列表定位符摘要、单步 `↑`/`↓` 调序与删除；提取模式元素拾取器（`startElementPicker({ mode: 'extract' })` 不吞 `<td>`/`<span>` 并清空 `target.text` 按槽位提取）、`insertExtractStep` 智能跨系统插位（自动落在跳站 `<a>` 与跨站 `navigate` 之前）、02 区 `valueRef.var` 变量来源切换与保存。
   - 批量断点完整恢复（`resumeFromCheckpoint` 强制重签新 `planHash`、已跑行零重放、`WRITE_OUTCOME_UNKNOWN` 断点续跑先停在人工裁定卡、暂停态不重复显示断点恢复卡）与“仅加载失败行到待跑队列”（严格排除 `verified` 与 `unknown` 防重入库，加载前清空旧 CSV 映射）。

### 已核验测试与真机证据
- `cd source && npm run check && npm test && npm run bench`：全部 **exit 0**（6 套单测全绿，静态红线扫描 0 违规，基准 82/82 命中、94.1% 压缩、0 循环体 LLM 调用）。
- **真实 `Google Chrome 158.0.8127.37` Computer-Use 端到端实测**：v0.3（6/6）与 v0.3.1（4/4）全部实机通过，**`consoleErrors = 0`**、**`swErrors = 0`**，并逐帧截图确认无排版遮挡或按钮挤压。

---

## 二、目录保护与 8 条不可违背的工程红线

换机后无论是架构师审查还是开发编码，以下铁律**一票否决**：

### 目录修改边界
- **严禁修改 `docs/` 下 6 份冻结文档**（原始时间戳基准 `2026/11/24`）：架构与契约已在内网基线冻结。
- **所有产品代码、仿真页与自动化测试改动严格限定在 `source/` 目录内**。
- **架构师审查对话**只负责文档/规范审核、执行命令复跑、红线巡检与实机验收，**不直接修改 `source/` 业务源码**；所有 `source/` 代码改动由**独立开发对话**执行。

### 8 条硬红线检查清单（`npm test` 中 `v03_contract_test.mjs` 会自动静态扫描）
1. **禁止模型生成或执行远程 JS**：零 `eval(`、零 `new Function`、零 `steps` 注入；只允许白名单动作与固定 Schema JSON。
2. **凭据零残留底线**：账号密码、OTP、Token、API Key 绝不入录制步骤、`chrome.storage.local`、导出文件、断点账本或外发 LLM 载荷；API Key 仅存 `chrome.storage.session`。
3. **`planHash` 不可变门禁**：任何运行（含 `resumeFromCheckpoint` 与失败行重试）均须重新预览生成 `planHash` 并存入 `chrome.storage.session`，每步执行前强校验；改参/改写模式/改策略立即失效。
4. **防幻觉统计铁律**：统计分布问答严禁模型心算，必须走 `planQuery → reduce 确定性统计 → explainRun`，`records` 为空或缺少维度时严格拒答。
5. **Chrome 116 兼容性硬约束**：`manifest.json` 锁定 `"minimum_chrome_version": "116"`，严禁使用 Chrome 117+ 独占 API（如 `Object.groupBy` / `Map.groupBy`）。
6. **无阻塞 DOM 渲染与零原生弹窗**：侧边栏与后台严禁使用 `window.confirm` / `window.alert` / `window.prompt` 与 `.innerHTML=` / `.outerHTML=` / `insertAdjacentHTML` / `document.write`。
7. **`ExecutionDriver` 严格解耦 & 循环体 0 AI 调用**：`run-controller.js`、`batch-runner.js` 等上层模块严禁直接调用 `chrome.tabs` / `chrome.scripting` / `drivers/`；`batch-runner.js` 循环体严禁引入或调用 `ai-client.js`。
8. **防重放与站点白名单**：写操作后若页面未返回明确成功/失败状态，判定 `WRITE_OUTCOME_UNKNOWN` 并立即暂停待人工核对，**严禁自动重试**；全程校验 `allowedOrigins` + `chrome.permissions`。

---

## 三、新电脑环境准备与下一步规划

### 1. 新电脑基础环境
1. 安装 **Git**、**Node.js >= 18**、**Google Chrome（>= 116，推荐最新版）**。
2. 拉取代码：
   ```bash
   git clone https://github.com/cvPerdredes/SkillFlow.git
   cd SkillFlow/source
   npm run check && npm test && npm run bench
   ```
3. （可选）如需在新电脑用 Python 脚本跑自动化 Chrome Computer-Use 验证，安装 Python 3 及依赖：
   `pip install websocket-client pillow`

### 2. 尚未推进的后续阶段（换机后按需开展）
- **阶段 C · 真模型 + 真实内网业务系统联调（下一优先级）**：
  - 在配置了内网 DeepSeek-v4-flash (≤284B) / 光明大模型网关及测试业务系统的环境下，实测 `analyzeTrace` / `matchSkill` / `extractArgs` / `planQuery` / `explainRun` 的真实端到端表现与 Token/耗时统计；
  - 针对真实业务系统排查跨域 `iframe`、Shadow DOM、SSO 重定向、表单特殊校验及防重提边界。
- **阶段 D · 二期混合架构演进（视 L1 压测缺口决定）**：
  - 按 `docs/02` 保留接口平滑扩展 `L2 ChromeDebuggerDriver`（解决真实 `isTrusted` 事件、原生文件选择框自动上传、封闭 `iframe`/弹窗处理等 L1 沙箱限制）。
- **答辩与研究报告收尾（按 `docs/03` 课表）**：
  - 补全真实模型实测对照数据、截图证据与 5 分钟保底演示视频。

---

## 四、新电脑 Antigravity 开箱即用启动 Prompt（直接复制）

> **建议用法**：在新电脑 Antigravity 打开克隆下来的 `SkillFlow/` 工作区，新建两个对话（建议开启 Plan Mode 用于架构师审查对话）。

### 1. 发给新电脑「首席架构师 / 独立审查对话」的开场 Prompt

```text
请接手作为 SkillFlow 项目的首席架构师与独立代码/实机审查官（继续推进阶段 C/D 及课题 #60 定稿验收）。

请先依次阅读以下文件建立完整上下文，不要急于行动：
1. `HANDOFF.md`
2. `docs/00_v0.3冻结总览与开发启动指令.md`
3. `docs/02_架构契约与接口冻结_v0.3.md`
4. `docs/03_排期分工与课题60四维评测方案_v0.3.md`

你的角色与硬性纪律：
1. **严格职责隔离**：你不直接修改 `source/` 业务源码，也不允许改动 `docs/` 下 6 份冻结文档；全部产品编码由我另开的「独立开发对话」完成，你只负责方案决策、给开发下发精确指令、逐行审计开发提交、独立复跑验证命令及实机验证。
2. **8 条工程安全红线一票否决**：每次审查开发产出必须核查 `npm run check && npm test && npm run bench`、8 条红线（零 Chrome 117+ `groupBy`、零 `window.confirm/alert`、零 `eval/innerHTML`、零 `ExecutionDriver` 越界、零凭据泄漏、`planHash` 门禁、`UNKNOWN` 防重、循环体 0 LLM 调用）以及 `docs/` 不可变与无 `__pycache__`。
3. 请在 `source/` 下先独立跑一遍 `npm run check && npm test && npm run bench` 确认基线状态，然后等我给出下一阶段任务或开发更新通知。
```

### 2. 发给新电脑「独立开发对话」的开场 Prompt

```text
请作为 SkillFlow 项目的核心开发工程师继续在本仓库推进实现（所有方案裁定与最终验收由另一个「首席架构师审查对话」负责）。

开始改动任何代码前，请先阅读：
1. `HANDOFF.md`
2. `docs/00_v0.3冻结总览与开发启动指令.md`
3. `docs/02_架构契约与接口冻结_v0.3.md`
4. `source/README.md`

开发约束：
1. **工作目录隔离**：所有源码修改严格限制在 `source/` 目录内；严禁改动 `docs/` 下的 6 份冻结文档或根目录 `HANDOFF.md`（除非架构师明确要求更新）。
2. **严守 8 条安全与架构红线**：零 `Object.groupBy`/`Map.groupBy`（锁定 Chrome 116+）；零 `eval`/`new Function`/不安全 `innerHTML`；零 `window.confirm`/`alert`；上层调度严禁绕过 `ExecutionDriver`；批量循环体严禁调用模型；敏感字段/密码/API Key 严禁写 `local` 或外发；`planHash` 审批门禁不可绕过；`WRITE_OUTCOME_UNKNOWN` 严禁自动重放。
3. **交付标准**：每次完成任务后必须自行跑通 `cd source && npm run check && npm test && npm run bench` 与静态红线检查，不产生 `__pycache__`，并在回复中只陈述实测过的文件、符号与命令输出。

请先阅读上述文件并跑一遍基线验证命令，准备就绪后向我汇报即可。
```
