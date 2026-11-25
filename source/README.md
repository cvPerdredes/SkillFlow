# SkillFlow v0.3 · 国网内网零代码 Skill 生产工厂与确定性执行器

> **对应课题**：国家电网 2026 年人工智能高端培训班 · 课题 **#60（浙江）《浏览器智能操作与技能录制复用技术研究及应用》**  
> **技术路线**：Chrome **116+** 纯 Manifest V3 零构建原生 ESM 扩展 + 经典单文件 IIFE Content Script（零 Node 打包依赖、零桌面后台进程）  
> **模型基线**：兼容离线 **Mock** 与内网 OpenAI-Compatible 接口（能力按 **≤ DeepSeek-v4-flash 284B** 容错设计，支持 `<think>` 剥离、单次带错重试、超时与降级兜底）。

---

## 一、核心架构与安全红线

1. **Skill IR v0.3 与 `ExecutionDriver` 严格解耦**
   - 上层控制器（[run-controller.js](extension/lib/run-controller.js)、[batch-runner.js](extension/lib/batch-runner.js)、[plan-builder.js](extension/lib/plan-builder.js)）仅通过 [ExecutionDriver](extension/lib/driver.js) 抽象契约操控页面，严禁直接调用 `chrome.tabs` / `chrome.scripting` / `drivers/`。
   - 一期唯一落地驱动为 [Mv3ContentScriptDriver](extension/lib/drivers/mv3-driver.js)（L1 纯 MV3），二期可平滑演进至 `chrome-debugger`（L2）或本地 Playwright/CDP 伴侣（L3）而无需改动 Skill IR。
2. **后台不可变 `planHash` 审批门禁（防休眠丢失 + 防 TOCTOU）**
   - 预览执行计划时按规范化载荷计算 SHA-256 `planHash`；[background.js](extension/background.js) 将已审批快照持久化至 `chrome.storage.session`（SW 休眠重启不丢，关闭浏览器自动销毁，网页不可读）。
   - 执行中任意参数、写模式、鉴权策略、CSV 行或目标站点被改动，均在每步执行前触发 `PLAN_NOT_APPROVED` 拦截。
3. **凭据与敏感信息零残留（双端纵深防御）**
   - 前端 [content.js](extension/content.js) 与后台 [sanitizer.js](extension/lib/sanitizer.js) 维持 100% 一致的敏感词判定（覆盖 `密码/口令/验证码/手机号/户号/身份证/姓名/银行卡` 等 `<label>`、表格前序 `<td>` 与属性）；登录容器（如 `#login-form`）整块折叠为 `auth_checkpoint`（零原值）。
   - 模式 B（`ephemeral_prompt`）输入的临时账号/口令仅存内存局部变量，填入提交后立即清零；模型 API Key 仅存 `chrome.storage.session`，严禁写入 `local` 存储或导出文件。
4. **Chrome 116+ 兼容与安全性约束**
   - 严禁使用 Chrome 117+ 新增语法（如 `Object.groupBy` / `Map.groupBy`）；所有分组统计均通过手写 `reduce` 完成。
   - 侧边栏与后台模块零 `window.confirm` / `window.alert`、零 `eval` / `new Function`、零 `innerHTML` / HTML 字符串拼接注入。

---

## 二、快速启动本地双固定端口仿真系统

Windows（自动探测 `py -3` → 本机 Python → LibreOffice Python → Node 18+ 内置 HTTP 服务）：

```bat
cd SkillFlow_v0.3\source
start-demo-windows.bat
```

或按需手动启动：

```bash
# Python 3 方式（建议 -B 不生成 __pycache__）
python -B demo_server.py

# 或纯 Node 方式（Node >= 18）
node demo_server.mjs
```

启动后将同时监听两个固定回环端口（严禁监听 `0.0.0.0`）：
- **系统 A（营销 2.0 客户与电量台账查询）**：`http://127.0.0.1:18761/sys_a_query.html`（支持 `?layout=v2` 动态 ID `ext-gen-*` 轻改版、`?ambiguous=1` 同名按钮歧义开关、`?needAuth=1` 模拟登录与验证码）
- **系统 B（工单与业务台账批量录入）**：`http://127.0.0.1:18762/sys_b_form.html`（内置 `未备案所 -> 单位代码不存在`、`kwh 超限 -> 电量超限需核查` 业务回执，配合 [sample_batch.csv](demo-site/sample_batch.csv) 12 条样本）

---

## 三、Chrome 扩展安装与端到端演示指南

### 3.1 加载扩展
1. 打开 Chrome（≥116）或 Edge，访问 `chrome://extensions`，开启右上角 **开发者模式**。
2. 点击 **加载已解压的扩展程序**，选择 `SkillFlow_v0.3/source/extension` 目录。
3. 点击浏览器工具栏 **SkillFlow v0.3** 图标打开 Side Panel 侧边栏。

### 3.2 演示主线 S1（单系统查询 + 表格采集 + 确定性分布追问）
1. 在系统 A 页面打开录制，输入查询单位 `杭州供电所`、月份 `2026-11`，点击 **查询数据**，结束录制。
2. 在 Section 02 点击 **AI 生成草稿**（可展开预览脱敏载荷），采集预设选 `系统 A 结果表格 (#result-table)`，结果选择器填 `#result-summary`，点击 **保存技能 (IR v0.3)**。
3. 在 Section 03 一句话输入 **“查 B 单位”** 点击 **匹配技能**：插件命中查询技能并追问缺失月份；再输入 `2026-11` 补全参数 → **预览执行计划** → **批准计划并执行**。
4. 在 Section 04 查看 L2 核验结果，追问 **“共多少条、各供电所和电压等级分布如何、总电量合计是多少？”**，即可看到精确数值统计与纯 DOM 渲染的横向柱状分布图；若追问 **“按客户经理分布”**，插件将触发防幻觉护栏严格拒答。

### 3.3 演示主线 S2（跨系统取号 + 12 条 CSV 试跑 2 条核验放行 + 失败归因）
1. 打开系统 A 开始录制：查询单位 `杭州供电所`、月份 `2026-11` → 点击 **查询数据** →（可标注首行客户批号 `extract` 输出至变量）→ 点击页面链接跳转至 `18762` 系统 B。
2. 侧边栏弹出 **“检测到跨站跳转至未授权站点 http://127.0.0.1:18762”**，点击 **授权当前站点并继续录制**（前置步骤零丢失），填写系统 B 表单字段并点击 **提交台账**，停止录制。
3. 勾选参数、开启 **启用 1→N CSV 批量录入循环**（工具自动按最后一次跨 Origin `navigate` 切分 `preSteps` 与系统 B `rowSteps`，并设置行间 `forceReload` 复位 URL）、采集预设选 `系统 B 提交回执 (#receipt-box)`，保存技能。
4. 在 Section 03 导入 `demo-site/sample_batch.csv`（12 条）：先以 **试跑 2 条核验再批量放行 (`pilot_then_batch`)** 执行，暂停核验前 2 条回执无误后放行剩余 10 条（批量循环内 **0 次模型调用**）。
5. 执行结束得到 **10 成功 / 2 业务失败**（第 5 行 `电量超限需核查`、第 9 行 `单位代码不存在`），追问 **“一共成功多少条、失败几条、按供电单位成功分布和失败原因占比分别是什么？”**，生成 100% 账本一致的答案与红色失败分布柱状图。

### 3.4 轻改版命中、`TARGET_AMBIGUOUS` 拦截、单步重绑与生态导出
- 在系统 A 打开 `?layout=v2`（`id` 全变为动态 `ext-gen-9101` 等且嵌套层级改变），直接回放原 v1 技能仍可依靠 `<label>` 与文本多维定位 100% 命中；
- 打开 `?ambiguous=1` 或隐藏/删除目标按钮触发 `TARGET_AMBIGUOUS` / `ACTION_FAILED` 后，侧边栏弹出 **🎯 单步元素重绑（Re-bind）** 卡片，点击按钮后直接在网页悬停红框选定新元素即可只替换该步 `target`；
- 选中任意已保存技能可一键 **导出 `SKILL.md`**（YAML Frontmatter + 适用系统 + 参数/CSV 列 + 门禁 + 核验规范）与 **导出 MCP JSON**（自动生成 `inputSchema` 与 `readOnlyHint`）；在 Section 04 可 **导出脱敏评测日志 JSON**。

---

## 四、自动化校验、单元测试与课题 #60 四维评测

在 `SkillFlow_v0.3/source` 目录运行：

```bash
# 1. 全量 JS 语法检查（22 个扩展/脚本文件）
npm run check

# 2. 全量 5 套单元测试（含后台 SW 持久化、双端敏感词一致性、AI 容错、CSV 批量、Re-bind/导出/红线回归）
npm test

# 3. 课题 #60 一键复现 3×4×3 四维量化对比评测（输出 Markdown 对比表与 JSON 指标）
npm run bench

# 4. Python 服务端无缓存语法检查（不产生 __pycache__）
python -B -c "import ast; ast.parse(open('demo_server.py', encoding='utf-8').read())"
```

可选 Playwright 真无头 Chromium E2E 用例（需本机预先安装 `playwright` 与 Chromium 浏览器）：

```bash
python tests/content_unit_test.py
```

---

## 五、文件清单（`source/`）

- `extension/manifest.json`：MV3 清单（`0.3.0`，`minimum_chrome_version: "116"`，`unlimitedStorage`）
- `extension/background.js`：ESM 后台调度中心（统一串行队列、`session` 持久化 `planHash` 门禁、跨站授权与后台二次脱敏兜底）
- `extension/content.js`：经典单文件 IIFE（录制与登录折叠、`DISTILL_DOM`、多维定位与可见/歧义校验、`EXTRACT_RECORDS`、`START_PICK_ELEMENT` 单步重绑选点）
- `extension/lib/sanitizer.js` / `schemas.js` / `store.js` / `plan-builder.js` / `dom-distiller.js`
- `extension/lib/driver.js` & `extension/lib/drivers/mv3-driver.js`
- `extension/lib/ai-client.js` / `skill-analyzer.js` / `clarification.js` / `run-controller.js`
- `extension/lib/table-extractor.js` / `result-evaluator.js` / `batch-runner.js` / `result-qa.js` / `skill-exporter.js`
- `extension/panel.html` / `panel.css` / `panel.js`
- `demo_server.py` / `demo_server.mjs` / `start-demo-windows.bat` / `demo-site/*`
- `tests/background_unit_test.mjs` / `v03_contract_test.mjs` / `phase1_unit_test.mjs` / `phase2_unit_test.mjs` / `phase3_unit_test.mjs` / `benchmark_topic60.mjs` / `content_unit_test.py`

---

## 六、已知边界与诚实说明（L1 纯 MV3 期）

1. **受限于浏览器扩展沙箱（L1 边界）**：本版暂不支持自动静默上传 `<input type="file">` 本地附件（遇到将降级为 `manual` 人工确认步）、无法穿透封闭跨域 `iframe` 或纯 Canvas 绘制控件，且不注入或劫持 `window.alert`/`window.confirm` 原生弹窗。上述能力将在二期 `ExecutionDriver` 的 `chrome-debugger`（L2）或本地 Playwright/CDP 伴侣（L3）演进中按需引入。
2. **后台批量休眠恢复限制**：若用户在批量 1→N 运行途中直接关闭 Side Panel 页面，循环不会在后台静默继续提交写操作（防失控合规设计）；已运行条目的状态账本与断点已持久落盘，重开后可核对已跑记录。
3. **跨浏览器适配**：基于 Chrome Extension Manifest V3 Side Panel 与 Scripting API，实测兼容 Chromium 116+ 与 Edge 116+；依赖 `user-agent`/非 Chromium 内核旧浏览器不在本期支持范围内。
