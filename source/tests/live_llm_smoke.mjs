import assert from 'node:assert/strict';

import { createAiClient } from '../extension/lib/ai-client.js';
import { extractArgsFromInput, matchSkillByQuery } from '../extension/lib/clarification.js';
import { answerRunQuestion } from '../extension/lib/result-qa.js';
import { analyzeRecordedTrace } from '../extension/lib/skill-analyzer.js';

/**
 * 独立真实模型网关冒烟脚本（不加入离线 npm test）：
 * 仅从环境变量读取配置，绝不硬编码任何 API Key：
 *   SF_AI_API_KEY       必填，否则礼貌提示并退出码 0
 *   SF_AI_BASE_URL      可选，默认 https://api.siliconflow.cn/v1
 *   SF_AI_MODEL         可选，默认 deepseek-v4-flash-0731
 *   SF_AI_THINKING_MODE 可选，auto | off，默认 auto
 */

const baseUrl = String(process.env.SF_AI_BASE_URL || 'https://api.siliconflow.cn/v1').trim();
const model = String(process.env.SF_AI_MODEL || 'deepseek-v4-flash-0731').trim();
const apiKey = String(process.env.SF_AI_API_KEY || '').trim();
const thinkingMode = process.env.SF_AI_THINKING_MODE === 'off' ? 'off' : 'auto';
const timeoutMs = Number(process.env.SF_AI_TIMEOUT_MS || 30000);

if (!apiKey) {
  console.log('未检测到环境变量 SF_AI_API_KEY，已跳过真实大模型联调冒烟。');
  console.log('如需实测真实网关，请先设置环境变量后运行，例如 (PowerShell):');
  console.log('  $env:SF_AI_API_KEY="sk-your-key"');
  console.log('  $env:SF_AI_BASE_URL="https://api.siliconflow.cn/v1"');
  console.log('  $env:SF_AI_MODEL="deepseek-v4-flash-0731"');
  console.log('  node tests/live_llm_smoke.mjs');
  process.exit(0);
}

const aiClient = createAiClient({
  getConfig: async () => ({
    mode: 'remote',
    baseUrl,
    model,
    timeoutMs,
    temperature: 0.1,
    maxTokens: 2048,
    thinkingMode
  }),
  getApiKey: async () => apiKey
});

const summary = [];

function recordStep(name, ok, ms, detail) {
  summary.push({ name, ok, ms, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} (${ms}ms) -> ${detail}`);
}

console.log(`开始真实网关冒烟: baseUrl=${baseUrl}, model=${model}, thinkingMode=${thinkingMode}`);

// 1. listModels
const modelsRes = await aiClient.listModels();
recordStep(
  'listModels',
  modelsRes.ok,
  modelsRes.latencyMs,
  modelsRes.ok
    ? `count=${modelsRes.count}, deepseek=${modelsRes.deepseekModels.slice(0, 5).join(', ')}`
    : `${modelsRes.errorCode}: ${modelsRes.message} | ${modelsRes.hint}`
);

// 2. testConnection
const probeRes = await aiClient.testConnection();
recordStep(
  'testConnection',
  probeRes.ok,
  probeRes.latencyMs,
  probeRes.ok
    ? `HTTP ${probeRes.httpStatus}, preview=${probeRes.rawPreview}`
    : `${probeRes.errorCode}: ${probeRes.message} | ${probeRes.hint}`
);

// 3. matchSkill
const skills = [
  { id: 'sk_query', name: '营销电量台账查询', intent: '按供电单位与月份查询电量台账', parameters: [{ key: 'unit' }, { key: 'month' }] },
  { id: 'sk_batch', name: '系统B批量台账录入', intent: '按CSV逐行填写用电台账并提交', parameters: [{ key: 'batchRows', type: 'dataset' }] }
];
const matchRes = await matchSkillByQuery({ userQuery: '查 B 单位', skills, aiClient });
recordStep(
  'matchSkill',
  matchRes.mode === 'remote' && !matchRes.degraded && matchRes.matchedSkillId === 'sk_query',
  matchRes.latencyMs,
  `mode=${matchRes.mode}, matched=${matchRes.matchedSkillId}, conf=${matchRes.confidence}`
);

// 4. analyzeTrace
const traceRes = await analyzeRecordedTrace({
  session: {
    id: 'sess-smoke',
    name: '系统A查询',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18761', target: { label: '查询单位', cssPath: '#unit' }, value: '杭州供电所' },
      { id: 's2', action: 'click', origin: 'http://127.0.0.1:18761', target: { tag: 'button', text: '查询数据', cssPath: '#query-btn' } }
    ]
  },
  distilled: {
    ok: true,
    rawBytes: 12000,
    distilledBytes: 600,
    compressionRatio: 0.95,
    estimatedTokens: 180,
    nodeCount: 2,
    nodes: [{ tag: 'input', label: '查询单位', cssPath: '#unit' }],
    tables: [{ selector: '#result-table', headers: ['批号', '供电单位'], rowCount: 3 }],
    statusContainers: [{ selector: '#result-summary', dataStatus: 'ok', text: '查询完成' }],
    pageContext: { title: '系统A台账查询' }
  },
  aiClient
});
recordStep(
  'analyzeTrace',
  traceRes.mode === 'remote' && !traceRes.degraded && !/#result-table/.test(traceRes.draft?.resultSelectorHint || ''),
  traceRes.latencyMs,
  `mode=${traceRes.mode}, selector=${traceRes.draft?.resultSelectorHint}, params=${(traceRes.draft?.parameterCandidates || []).length}`
);

// 5. extractArgs（核心追问场景：仅提单位时不能把月份标为已填充）
const extRes = await extractArgsFromInput({
  userText: '查 B 单位',
  parameters: [
    { key: 'unit', label: '查询单位', type: 'string', required: true },
    { key: 'month', label: '查询月份', type: 'month', required: true }
  ],
  collectedArgs: {},
  currentDate: '2026-11-25',
  aiClient
});
recordStep(
  'extractArgs',
  extRes.mode === 'remote' && !extRes.degraded && Boolean(extRes.providedArgs.unit) && extRes.missingRequired.includes('month'),
  extRes.latencyMs,
  `mode=${extRes.mode}, provided=${JSON.stringify(extRes.providedArgs)}, missing=${JSON.stringify(extRes.missingRequired)}`
);

// 6. planQuery + explainRun (via answerRunQuestion)
const qaRes = await answerRunQuestion({
  question: '按供电单位分布统计成功条数',
  records: [
    { rowIndex: 1, orgName: '杭州所', status: 'verified' },
    { rowIndex: 2, orgName: '杭州所', status: 'verified' },
    { rowIndex: 3, orgName: '宁波所', status: 'failed', error: '未备案' }
  ],
  recordSchema: [
    { key: 'orgName', type: 'string' },
    { key: 'status', type: 'string' },
    { key: 'error', type: 'string' }
  ],
  aiClient
});
recordStep(
  'planQuery+explainRun',
  qaRes.mode === 'remote' && !qaRes.degraded && !qaRes.cannotCompute,
  qaRes.meta?.latencyMs || 0,
  `mode=${qaRes.mode}, refs=${qaRes.evidenceRefs.join(',')}`
);

const stats = aiClient.getStats();
const passed = summary.filter((s) => s.ok).length;
console.log(`\n=== 冒烟汇总：${passed}/${summary.length} 通过 ===`);
console.log(
  `统计：calls=${stats.calls}, retries=${stats.retries}, degraded=${stats.degradedCount}, promptTokens=${stats.totalPromptTokens}, completionTokens=${stats.totalCompletionTokens}`
);
assert.equal(passed, summary.length, '部分真实网关冒烟项未通过');
