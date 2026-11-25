"use strict";

import { deriveRiskLevel, isRiskStep, normalizeTargetOrigins } from './plan-builder.js';
import { redactObject, sanitizeUrl } from './sanitizer.js';

/**
 * 纯模板技能导出器与评测遥测组装模块（不调 LLM、无 Chrome API 依赖）：
 * - exportSkillMarkdown: 导出带 YAML Frontmatter 的标准 SKILL.md（适配 OpenClaw / 技能商城）
 * - exportMcpToolJson / formatMcpToolJson: 导出标准 MCP Tool Schema JSON（含 inputSchema 与 annotations）
 * - buildEvalTelemetryPayload: 导出课题 #60 四维对比评测脱敏日志 JSON
 */

function yamlQuote(str) {
  return JSON.stringify(String(str ?? '').replace(/\r?\n/g, ' ').trim());
}

function escapeMdCell(val) {
  return String(val ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function toMcpToolName(skill) {
  const rawId = String(skill?.id || 'skill').toLowerCase();
  const slug = rawId.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'skill';
  return `skillflow_${slug}`.slice(0, 64);
}

function paramToJsonSchema(param) {
  const type = param?.type || 'string';
  const desc = String(param?.label || param?.key || '').trim();

  if (type === 'dataset') {
    const props = {};
    const req = [];
    for (const col of param?.columns || []) {
      props[col.key] = paramToJsonSchema(col);
      if (col.required !== false) req.push(col.key);
    }
    return {
      type: 'array',
      description: desc || '批量 CSV 数据行集合',
      items: {
        type: 'object',
        properties: props,
        required: req,
        additionalProperties: false
      }
    };
  }

  if (type === 'number') {
    return { type: 'number', description: desc };
  }
  if (type === 'month') {
    return {
      type: 'string',
      pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
      description: desc ? `${desc}（YYYY-MM）` : 'YYYY-MM'
    };
  }
  if (type === 'date') {
    return {
      type: 'string',
      format: 'date',
      description: desc ? `${desc}（YYYY-MM-DD）` : 'YYYY-MM-DD'
    };
  }
  if (type === 'enum' && Array.isArray(param?.options) && param.options.length > 0) {
    return {
      type: 'string',
      enum: param.options.map((o) => String(o)),
      description: desc
    };
  }
  return { type: 'string', description: desc };
}

function formatStepSummaryLine(step, index) {
  const num = index + 1;
  const riskTag = step.risk === 'write_commit'
    ? ' `[写提交 · 需人工确认]`'
    : isRiskStep(step)
      ? ' `[门禁]`'
      : '';

  if (step.action === 'navigate') {
    return `${num}. **navigate**：跳转至 \`${sanitizeUrl(step.url || '') || step.origin || '-'}\`${riskTag}`;
  }
  if (step.action === 'auth_checkpoint') {
    return `${num}. **auth_checkpoint**：认证检查点（站点 \`${step.origin || '-'}\`，策略 \`manual_takeover / ephemeral_prompt\`，凭据零落盘）${riskTag}`;
  }
  if (step.action === 'manual' || step.sensitive) {
    return `${num}. **manual**：敏感字段/文件人工接管步（\`${step.target?.label || step.target?.cssPath || '-'}\`，零原值回放）${riskTag}`;
  }
  if (step.action === 'extract') {
    return `${num}. **extract**：从 \`${step.target?.cssPath || step.target?.label || '-'}\` 提取值写入变量 \`${step.outputVar || '(临时)'}\`${riskTag}`;
  }
  const targetDesc =
    step.target?.label || step.target?.text || step.target?.testId || step.target?.cssPath || '元素';
  let sourceDesc = '';
  if (step.valueRef?.rowField) sourceDesc = ` ← CSV列 \`${step.valueRef.rowField}\``;
  else if (step.valueRef?.var) sourceDesc = ` ← 跨步变量 \`${step.valueRef.var}\``;
  else if (step.valueRef?.param || step.paramKey) {
    sourceDesc = ` ← 参数 \`${step.valueRef?.param || step.paramKey}\``;
  } else if (step.value !== undefined && step.value !== '') {
    sourceDesc = ` ← 固定值 ${yamlQuote(step.value)}`;
  }
  return `${num}. **${step.action}**：\`${targetDesc}\`${sourceDesc}${riskTag}`;
}

/**
 * 纯模板生成标准 SKILL.md 文本（强制前置全量脱敏）。
 */
export function exportSkillMarkdown(rawSkill) {
  const skill = redactObject(rawSkill || {});
  const origins = normalizeTargetOrigins(skill);
  const steps = Array.isArray(skill.steps) ? skill.steps : [];
  const params = Array.isArray(skill.parameters) ? skill.parameters : [];
  const riskLevel = deriveRiskLevel(steps);
  const writeMode = skill.riskPolicy?.writeMode || (skill.batchLoop?.enabled ? 'pilot_then_batch' : 'commit');
  const scalarParams = params.filter((p) => p?.type !== 'dataset');
  const datasetParam = params.find((p) => p?.type === 'dataset') || null;

  const lines = [
    '---',
    `name: ${yamlQuote(skill.name || '未命名技能')}`,
    `description: ${yamlQuote(skill.intent || skill.description || skill.name || 'SkillFlow v0.3 自动化技能')}`,
    `skill_id: ${yamlQuote(skill.id || '')}`,
    `schema_version: ${yamlQuote(skill.schemaVersion || '0.3')}`,
    `version: ${Number(skill.version || 1)}`,
    `auth_policy: ${yamlQuote(skill.authPolicy || 'manual_takeover')}`,
    `risk_level: ${yamlQuote(riskLevel)}`,
    '---',
    '',
    `# ${skill.name || '未命名技能'}`,
    '',
    `> 由 SkillFlow v0.3 零代码技能工厂导出（IR v${skill.schemaVersion || '0.3'} · 默认已过全域脱敏检查）。`,
    '',
    '## 适用系统',
    `- **起始页面**：\`${sanitizeUrl(skill.startUrl || '') || '(未指定)'}\``,
    `- **授权站点白名单（allowedOrigins）**：`,
    ...(origins.length ? origins.map((o) => `  - \`${o}\``) : ['  - (无)']),
    '',
    '## 输入参数与 CSV 列定义'
  ];

  if (scalarParams.length > 0) {
    lines.push('### 标量参数');
    lines.push('| 参数 Key | 中文标签 | 类型 | 必填 |');
    lines.push('|---|---|---|---|');
    for (const p of scalarParams) {
      lines.push(
        `| \`${escapeMdCell(p.key)}\` | ${escapeMdCell(p.label || p.key)} | \`${escapeMdCell(p.type || 'string')}\` | ${p.required === false ? '否' : '是'} |`
      );
    }
    lines.push('');
  } else {
    lines.push('- 无标量运行参数。');
    lines.push('');
  }

  if (datasetParam || skill.batchLoop?.enabled) {
    const cols = datasetParam?.columns || [];
    lines.push(`### CSV 批量数据集列定义（参数 \`${datasetParam?.key || 'batchRows'}\`）`);
    if (cols.length > 0) {
      lines.push('| 列 Key | 表头标签 | 类型 | 必填 |');
      lines.push('|---|---|---|---|');
      for (const c of cols) {
        lines.push(
          `| \`${escapeMdCell(c.key)}\` | ${escapeMdCell(c.label || c.key)} | \`${escapeMdCell(c.type || 'string')}\` | ${c.required === false ? '否' : '是'} |`
        );
      }
    } else {
      lines.push('- 未定义 CSV 映射列。');
    }
    if (skill.batchLoop?.enabled) {
      lines.push(
        `- **批量控制策略**：试跑条数 \`pilotCount = ${Number(skill.batchLoop.pilotCount ?? 2)}\`，行间复位规则 \`${
          skill.batchLoop.rowResetRule?.url
            ? sanitizeUrl(skill.batchLoop.rowResetRule.url)
            : skill.batchLoop.rowResetRule?.selector || '(无)'
        }\``
      );
    }
    lines.push('');
  }

  lines.push('## 执行步骤与风险门禁');
  lines.push(`- **写操作防护模式**：\`${writeMode}\``);
  lines.push(`- **最高风险等级**：\`${riskLevel}\``);
  lines.push('- **安全门禁**：运行前须计算 `planHash` (SHA-256) 并写入后台不可变审批快照；禁止存储或外发密码/口令/验证码/敏感个人字段。');
  lines.push('');

  if (skill.batchLoop?.enabled && Array.isArray(skill.batchLoop.rowSteps) && skill.batchLoop.rowSteps.length > 0) {
    const stepById = new Map(steps.map((s, idx) => [s.id, { step: s, idx }]));
    const preList = (skill.batchLoop.preSteps || []).map((id) => stepById.get(id)).filter(Boolean);
    const rowList = (skill.batchLoop.rowSteps || []).map((id) => stepById.get(id)).filter(Boolean);
    const postList = (skill.batchLoop.postSteps || []).map((id) => stepById.get(id)).filter(Boolean);
    if (preList.length) {
      lines.push('### 前序阶段（preSteps · 单次执行）');
      preList.forEach(({ step }, i) => lines.push(formatStepSummaryLine(step, i)));
      lines.push('');
    }
    lines.push('### 批量循环阶段（rowSteps · 逐条 0 模型调用执行）');
    rowList.forEach(({ step }, i) => lines.push(formatStepSummaryLine(step, i)));
    lines.push('');
    if (postList.length) {
      lines.push('### 收尾阶段（postSteps）');
      postList.forEach(({ step }, i) => lines.push(formatStepSummaryLine(step, i)));
      lines.push('');
    }
  } else if (steps.length > 0) {
    steps.forEach((step, idx) => lines.push(formatStepSummaryLine(step, idx)));
    lines.push('');
  } else {
    lines.push('- 暂无步骤。');
    lines.push('');
  }

  lines.push('## 业务核验与采集规范');
  lines.push(`- **结果校验选择器**：\`${skill.resultSelector || '(未配置)'}\``);
  if (skill.extractSpec) {
    lines.push(`- **结构化采集模式**：\`${skill.extractSpec.mode || 'table'}\`（容器 \`${skill.extractSpec.containerSelector || '-'}\`）`);
    if (skill.extractSpec.statusSelector) {
      lines.push(`- **状态核验选择器**：\`${skill.extractSpec.statusSelector}\`；错误文案 \`${skill.extractSpec.errorSelector || '-'}\``);
    }
    if (Array.isArray(skill.extractSpec.fields) && skill.extractSpec.fields.length) {
      lines.push(
        `- **采集字段**：${skill.extractSpec.fields.map((f) => `\`${f.key}\``).join('、')}`
      );
    }
  } else {
    lines.push('- **结构化采集配置**：未配置 `extractSpec`（仅能判定动作完成 `L0 / ACTIONS_COMPLETED_UNVERIFIED`，不得误报业务成功 `VERIFIED_SUCCESS`）。');
  }

  if (Array.isArray(skill.postconditions) && skill.postconditions.length) {
    lines.push('- **业务后置断言（postconditions）**：');
    for (const pc of skill.postconditions) {
      lines.push(`  - \`${pc.type || 'assertion'}\` ${pc.selector || ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * 导出标准 MCP Tool Schema 对象（自动由 Skill IR.parameters 构造 inputSchema，并推导 annotations.readOnlyHint）。
 */
export function exportMcpToolJson(rawSkill) {
  const skill = redactObject(rawSkill || {});
  const steps = Array.isArray(skill.steps) ? skill.steps : [];
  const params = Array.isArray(skill.parameters) ? skill.parameters : [];
  const origins = normalizeTargetOrigins(skill);
  const riskLevel = deriveRiskLevel(steps);
  const readOnlyHint = riskLevel === 'read';

  const properties = {};
  const required = [];
  for (const p of params) {
    if (!p?.key) continue;
    properties[p.key] = paramToJsonSchema(p);
    if (p.required) {
      required.push(p.key);
    }
  }

  const writeMode = skill.riskPolicy?.writeMode || (skill.batchLoop?.enabled ? 'pilot_then_batch' : 'commit');

  return {
    name: toMcpToolName(skill),
    description:
      skill.intent ||
      skill.description ||
      `${skill.name || 'SkillFlow 技能'}（适用站点：${origins.join(', ') || '已授权站点'}）`,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false
    },
    annotations: {
      title: skill.name || '未命名技能',
      readOnlyHint,
      destructiveHint: riskLevel === 'write_commit',
      idempotentHint: readOnlyHint,
      openWorldHint: false
    },
    'x-skillflow': {
      schemaVersion: skill.schemaVersion || '0.3',
      skillId: skill.id || '',
      version: Number(skill.version || 1),
      allowedOrigins: origins,
      authPolicy: skill.authPolicy || 'manual_takeover',
      writeMode,
      riskLevel,
      hasBatchLoop: Boolean(skill.batchLoop?.enabled),
      hasExtractSpec: Boolean(skill.extractSpec)
    }
  };
}

/**
 * 将 MCP Tool Schema 格式化为带缩进的 JSON 字符串。
 */
export function formatMcpToolJson(rawSkill) {
  return JSON.stringify(exportMcpToolJson(rawSkill), null, 2);
}

/**
 * 构造课题 #60 四维对比评测脱敏遥测导出 JSON。
 */
export function buildEvalTelemetryPayload({
  skill = null,
  distilled = null,
  runSummary = null,
  modelUsage = null,
  recordsCount = 0
} = {}) {
  return redactObject({
    schemaVersion: '0.3',
    exportedAt: new Date().toISOString(),
    skillId: skill?.id || runSummary?.skillId || '',
    skillName: skill?.name || runSummary?.skillName || '',
    skillVersion: Number(skill?.version || 1),
    allowedOrigins: normalizeTargetOrigins(skill || {}),
    domMetrics: distilled
      ? {
          rawBytes: distilled.rawBytes ?? 0,
          distilledBytes: distilled.distilledBytes ?? 0,
          compressionRatio: distilled.compressionRatio ?? 0,
          estimatedTokens: distilled.estimatedTokens ?? 0,
          nodeCount:
            distilled.nodeCount ??
            (Array.isArray(distilled.snapshot)
              ? distilled.snapshot.length
              : Array.isArray(distilled.nodes)
                ? distilled.nodes.length
                : 0)
        }
      : null,
    runSummary: runSummary
      ? {
          runId: runSummary.runId || runSummary.id || '',
          status: runSummary.status || '',
          evidenceLevel: runSummary.evidenceLevel || 'L0',
          elapsedMs: runSummary.elapsedMs ?? 0,
          errorCode: runSummary.errorCode || null,
          failedStepIndex: runSummary.failedStepIndex ?? null,
          failedStepId: runSummary.failedStepId ?? null,
          locatorStats: runSummary.locatorStats || null,
          batchSummary: runSummary.batchSummary || null
        }
      : null,
    recordsCount: Number(recordsCount || 0),
    modelUsage: modelUsage || null
  });
}

const CSV_HEADER_LABELS = {
  rowIndex: '行号',
  status: '执行状态',
  receiptNo: '回执单号',
  error: '失败原因',
  errorCode: '错误码',
  evidenceLevel: '证据等级',
  orgName: '供电单位',
  unit: '查询单位',
  batchCode: '关联客户批号',
  batch: '客户批号',
  meterNo: '表计编号',
  kwh: '申报电量',
  voltage: '电压等级',
  month: '查询月份',
  remark: '备注'
};

const PURE_NUMBER_RE = /^[+-]?\d+(?:\.\d+)?$/;

function sanitizeCsvFormulaCell(rawStr) {
  if (!rawStr) return '';
  if (/^[=+\-@\t\r]/.test(rawStr) && !PURE_NUMBER_RE.test(rawStr.trim())) {
    return `'${rawStr}`;
  }
  return rawStr;
}

function escapeCsvCell(value) {
  const raw = value === undefined || value === null ? '' : String(value);
  const safe = sanitizeCsvFormulaCell(raw);
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * 确定性导出明细 / 失败清单 CSV：
 * - 前置全量 redactObject 脱敏；
 * - 强制 UTF-8 BOM (\uFEFF) 确保 Windows Excel 双击不乱码；
 * - RFC-4180 引号转义 + CSV 公式注入防护（非纯数字的 =/+/-/@/\t/\r 开头字符前加单引号）；
 * - failedOnly: true 仅导出 status === 'failed' | 'unknown' | 'error' 的异常行。
 */
export function exportRecordsCsv(records = [], recordSchema = [], { failedOnly = false } = {}) {
  const safeRecords = redactObject(Array.isArray(records) ? records : []);
  const filteredRows = failedOnly
    ? safeRecords.filter((r) =>
        ['failed', 'unknown', 'error'].includes(String(r?.status || '').toLowerCase())
      )
    : safeRecords;

  const ignoreKeys = new Set(['rawStatus', 'message']);
  const colList = [];
  const seenKeys = new Set();

  for (const s of Array.isArray(recordSchema) ? recordSchema : []) {
    if (!s?.key || ignoreKeys.has(s.key) || seenKeys.has(s.key)) continue;
    seenKeys.add(s.key);
    const label = s.label && s.label !== s.key ? s.label : CSV_HEADER_LABELS[s.key] || s.key;
    colList.push({ key: s.key, label });
  }

  for (const row of filteredRows) {
    if (!row || typeof row !== 'object') continue;
    for (const k of Object.keys(row)) {
      if (ignoreKeys.has(k) || seenKeys.has(k)) continue;
      if (k === 'elapsedMs' && colList.length > 0) continue;
      seenKeys.add(k);
      colList.push({ key: k, label: CSV_HEADER_LABELS[k] || k });
    }
  }

  if (failedOnly && !seenKeys.has('error')) {
    colList.push({ key: 'error', label: CSV_HEADER_LABELS.error });
    seenKeys.add('error');
  }

  if (colList.length === 0) {
    colList.push(
      { key: 'rowIndex', label: '行号' },
      { key: 'status', label: '执行状态' },
      { key: 'error', label: '失败原因' }
    );
  }

  const lines = [colList.map((c) => escapeCsvCell(c.label)).join(',')];
  for (const row of filteredRows) {
    lines.push(colList.map((c) => escapeCsvCell(row?.[c.key] ?? '')).join(','));
  }

  return '\uFEFF' + lines.join('\r\n');
}
