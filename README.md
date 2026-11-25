# SkillFlow v0.3.1 · 浏览器智能操作与技能录制复用插件

> **对应课题**：国家电网 2026 年人工智能高端培训班 · 课题 **#60（浙江）《浏览器智能操作与技能录制复用技术研究及应用》**  
> **技术栈**：Chrome **116+** 纯 Manifest V3 零构建原生 ESM 扩展 + 经典 IIFE Content Script（零 Node 打包依赖、零本地桌面进程）  
> **当前封版里程碑**：**`v0.3.1`**（v0.3 冻结闭环 + 模块 A/B 体验与运维闭环，已在真实 `Google Chrome 158` 端到端通过）

---

## 一、仓库目录说明（方案 B · 文档与源码一体化）

| 路径 | 职责与冻结约束 |
|---|---|
| [HANDOFF.md](./HANDOFF.md) | **跨机续研与 Antigravity 双对话交接手册**（含架构师 / 开发双开场 Prompt、红线与下一步路线） |
| [docs/](./docs) | **6 份已冻结设计/评测文档**（PRD v0.3、架构契约与接口冻结、四维评测方案、联调契约单等，**只读保护**） |
| [source/](./source) | **扩展与仿真测试唯一源码目录**（[README](./source/README.md) 含详尽内部模块与演示指南） |
| [source/extension/](./source/extension) | Chrome 116+ MV3 插件源码（直接用于 `chrome://extensions` 解压加载） |
| [source/demo-site/](./source/demo-site) | 本地双端口跨系统仿真业务站点（系统 A `18761` + 系统 B `18762` + [sample_batch.csv](./source/demo-site/sample_batch.csv)） |
| [source/tests/](./source/tests) | 6 套全量自动化单测与课题 #60 3×4×3 四维量化对比评测脚本 |

---

## 二、30 秒快速启动与自动化验收

环境要求：**Node.js >= 18**、**Chrome / Edge >= 116**（可选 Python 3 启动 Python 版仿真服务，建议加 `-B` 参数避免生成 `__pycache__`）。

```bash
# 1. 进入源码目录执行语法校验、全量 6 套单元测试与四维基准评测
cd source
npm run check
npm test
npm run bench

# 2. 启动本地双固定端口仿真业务系统（18761 系统 A + 18762 系统 B）
node demo_server.mjs
```

安装扩展：打开 Chrome 访问 `chrome://extensions` → 开启右上角 **开发者模式** → 点击 **加载已解压的扩展程序** → 选择 [source/extension/](./source/extension) 目录，点击工具栏 **SkillFlow v0.3** 图标打开侧边栏即可体验。

---

## 三、已实测核心成果与指标（v0.3.1）

- **全量自动化验证**：`npm run check`（23 个文件语法检查）与 `npm test`（6 套单元与契约回归：`background_unit_test.mjs`、`v03_contract_test.mjs`、`phase1_unit_test.mjs`、`phase2_unit_test.mjs`、`phase3_unit_test.mjs`、`phase4_v031_unit_test.mjs`）**100% 通过**。
- **课题 #60 四维基准实测（Mock 仿真链路）**：
  - **轻量化 DOM 蒸馏压缩率**：平均 **94.1%**（系统 A `15137B → 745B` 压缩 `95.08%`，系统 B `14293B → 1005B` 压缩 `92.97%`）；
  - **元素定位准确率**：**82 / 82 (100.0%)**，`?layout=v2` 动态 ID 与结构扰动 **3/3** 命中，`?ambiguous=1` 同名歧义按钮安全拦截 `TARGET_AMBIGUOUS`（**0 误点**）；
  - **1→N 批量诚实核验与低开销**：12 条 CSV 经试跑 2 条门禁后精准核验 **10 成功 / 2 业务失败**，循环体内 LLM 调用 **0 次**，全套仿真耗时 **< 100 ms**。
- **真实 Chrome 158 端到端实测（0 Console / 0 SW 报错）**：
  - 覆盖 v0.3 全部 6 大场景 + v0.3.1 模块 A/B 全部 4 组扩展场景（含零代码页面 `<td>` 选点提取 `extract → outputVar` 自动跨站插位并动态搬运 `KH-202611-B01`、侧边栏重载后断点续跑、历史回看与分布图表、UTF-8 BOM 与防公式注入 CSV 导出、仅加载失败行精准重试）。

---

## 四、后续接手入口

在新电脑克隆本仓库后，请先阅读 [HANDOFF.md](./HANDOFF.md)，内含可直接复制粘贴给 Antigravity **首席架构师审查对话** 与 **独立开发对话** 的完整启动上下文。
