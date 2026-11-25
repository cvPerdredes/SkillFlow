"use strict";

import { estimateTokens, pickPreferredStatusSelector } from './dom-distiller.js';
import { redactObject } from './sanitizer.js';
import {
  ALLOWED_QUERY_OPS,
  validateAnalyzeTraceProposal,
  validateExplainRunProposal,
  validateExtractArgsProposal,
  validateMatchSkillProposal,
  validatePlanQueryProposal
} from './schemas.js';

/**
 * 面向 ≤ 284B 内网模型（DeepSeek-v4-flash 及 30B–80B 开源/光明模型）的 4+1 原子 AI 适配器：
 * - 单次请求硬控 ≤ 5500 Tokens；
 * - 剥离 <think>...</think> 与 Markdown 代码块并容错提取 JSON；
 * - Schema / stepId 校验失败带报错信息自动重试 1 次（总超时 ≤ 15s）；
 * - 内置完全离线 Mock 模式与调用统计埋点。
 */

export const DEFAULT_AI_TIMEOUT_MS = 15000;
export const MAX_PROMPT_TOKENS = 5500;

/**
 * 剥离 <think>...</think> 思考块与 Markdown 代码围栏，并提取首个完整 JSON 对象。
 */
export function stripThinkAndExtractJson(rawText) {
  let text = String(rawText ?? '').trim();
  if (!text) {
    return { ok: false, errorCode: 'AI_SCHEMA_INVALID', message: '模型返回为空' };
  }

  // 1. 剥离闭合的 <think>...</think>
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // 若模型截断未闭合 </think>，尝试只剥离 <think> 到首个 '{' 之前的非 JSON 内容
  if (/<think>/i.test(text)) {
    const afterLastThink = text.replace(/^[\s\S]*<\/think>/i, '').trim();
    text = afterLastThink.replace(/<think>[\s\S]*?(?=\{)/i, '').trim();
  }

  // 2. 优先尝试提取 ```json ... ``` 或 ``` ... ``` 代码块
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    const candidate = fenceMatch[1].trim();
    try {
      return { ok: true, data: JSON.parse(candidate) };
    } catch (_) {
      text = candidate;
    }
  }

  // 3. 直接解析整串
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (_) {}

  // 4. 括号平衡法提取首个完整 JSON 对象（跳过字符串内部引号）
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const slice = text.slice(start, i + 1);
          try {
            return { ok: true, data: JSON.parse(slice) };
          } catch (err) {
            return {
              ok: false,
              errorCode: 'AI_SCHEMA_INVALID',
              message: `JSON 解析失败: ${err.message}`
            };
          }
        }
      }
    }
  }

  return {
    ok: false,
    errorCode: 'AI_SCHEMA_INVALID',
    message: '未能在模型输出中找到有效 JSON 对象'
  };
}

function defaultMockHandlers() {
  return {
    matchSkill: ({ userQuery, skills }) => {
      const q = String(userQuery || '').toLowerCase();
      const scored = (skills || [])
        .map((s) => {
          const hay = `${s.name || ''} ${s.intent || ''} ${(s.paramKeys || []).join(' ')}`.toLowerCase();
          let score = 0;
          if (/查|查询|台账|电量/.test(q) && /查|查询|台账|电量/.test(hay)) score += 0.55;
          if (/录|填|报|批量/.test(q) && /录|填|报|批量/.test(hay)) score += 0.55;
          if (s.name && q.includes(String(s.name).toLowerCase())) score += 0.4;
          for (const ch of q.replace(/\s+/g, '')) {
            if (hay.includes(ch)) score += 0.05;
          }
          return {
            skillId: s.id,
            score: Number(Math.min(0.99, score).toFixed(2)),
            reason: 'Mock 规则关键词匹配'
          };
        })
        .sort((a, b) => b.score - a.score);
      const top = scored[0];
      return {
        matchedSkillId: top && top.score >= 0.35 ? top.skillId : null,
        candidates: scored.slice(0, 3),
        confidence: !top || top.score < 0.35 ? 'low' : top.score >= 0.7 ? 'high' : 'medium'
      };
    },

    analyzeTrace: ({ traceSummary, pageContext }) => {
      const steps = Array.isArray(traceSummary?.steps) ? traceSummary.steps : [];
      const candidates = [];
      const usedKeys = new Set();
      for (const s of steps) {
        if (!['fill', 'select'].includes(s.action) || s.sensitive) continue;
        const lbl = String(s.target?.label || s.target?.placeholder || '').trim();
        let baseKey = 'param';
        let type = 'string';
        if (/月|month/i.test(lbl)) {
          baseKey = 'month';
          type = 'month';
        } else if (/日期|date/i.test(lbl)) {
          baseKey = 'date';
          type = 'date';
        } else if (/电量|kwh|数量|金额/i.test(lbl)) {
          baseKey = 'kwh';
          type = 'number';
        } else if (/单位|部门|org|unit/i.test(lbl)) {
          baseKey = 'unit';
        } else if (/表计|meter/i.test(lbl)) {
          baseKey = 'meterNo';
        } else if (/批号|batch/i.test(lbl)) {
          baseKey = 'batchCode';
        }
        let key = baseKey;
        let idx = 2;
        while (usedKeys.has(key)) key = `${baseKey}_${idx++}`;
        usedKeys.add(key);
        candidates.push({
          key,
          label: lbl || key,
          type,
          required: true,
          sourceStepId: s.id,
          reason: 'Mock 语义分析建议参数'
        });
      }
      const statusContainers = Array.isArray(traceSummary?.statusContainers)
        ? traceSummary.statusContainers
        : [];
      const resultSelectorHint = pickPreferredStatusSelector(statusContainers) || null;
      const hasReceiptBox = statusContainers.some(
        (c) => c?.selector === '#receipt-box' || c?.selector === '#receipt-status'
      );
      const extractHint = hasReceiptBox
        ? {
            mode: 'receipt',
            containerSelector: '#receipt-box',
            statusSelector: '#receipt-status'
          }
        : (traceSummary?.tables || []).length
          ? { mode: 'table', containerSelector: traceSummary.tables[0].selector }
          : null;

      return {
        name: pageContext?.title ? `${pageContext.title.slice(0, 20)}技能` : traceSummary?.sessionName || '自动化技能',
        intent: `复用录制流程：${(steps || []).length} 步操作（Mock 离线解析）`,
        parameterCandidates: candidates,
        stepAnnotations: steps.map((s) => ({
          stepId: s.id,
          summary: `${s.action} ${s.target?.label || s.target?.text || s.url || ''}`.trim()
        })),
        batchLoopHint: null,
        extractHint,
        resultSelectorHint,
        uncertainties: steps.some((s) => s.action === 'auth_checkpoint')
          ? ['流程包含登录检查点 auth_checkpoint，运行时默认由人工接管登录']
          : []
      };
    },

    extractArgs: ({ userText, parameters, collectedArgs, lastQuestion, currentDate }) => {
      const providedArgs = { ...(collectedArgs || {}) };
      const text = String(userText || '').trim();
      const paramList = Array.isArray(parameters) ? parameters : [];
      const curDate = /^\d{4}-\d{2}-\d{2}$/.test(String(currentDate || ''))
        ? currentDate
        : new Date().toISOString().slice(0, 10);
      const [cy, cm] = curDate.split('-').map(Number);

      const monthParam = paramList.find((p) => p.type === 'month' || p.key === 'month');
      if (monthParam) {
        const mHit = text.match(/(\d{4})[-/年](\d{1,2})月?/);
        if (mHit) {
          const mm = Number(mHit[2]);
          if (mm >= 1 && mm <= 12) {
            providedArgs[monthParam.key] = `${mHit[1]}-${String(mm).padStart(2, '0')}`;
          }
        } else if (/上个?月/.test(text)) {
          const prevM = cm === 1 ? 12 : cm - 1;
          const prevY = cm === 1 ? cy - 1 : cy;
          providedArgs[monthParam.key] = `${prevY}-${String(prevM).padStart(2, '0')}`;
        } else if (/本个?月|这个月/.test(text)) {
          providedArgs[monthParam.key] = `${cy}-${String(cm).padStart(2, '0')}`;
        }
      }

      const unitParam = paramList.find((p) => /unit|org/i.test(p.key) || /单位/.test(p.label || ''));
      if (unitParam) {
        const uHit = text.match(/([A-Za-z0-9\u4e00-\u9fa5]+\s*(?:供电所|供电公司|单位|部门))/);
        if (uHit) {
          providedArgs[unitParam.key] = uHit[1].replace(/^[查录入填报]+\s*/, '').replace(/\s+/g, '').trim();
        }
      }

      if (lastQuestion && text && Object.keys(providedArgs).length === Object.keys(collectedArgs || {}).length) {
        const stillMissing = paramList.filter(
          (p) => p.required !== false && !providedArgs[p.key]
        );
        if (stillMissing.length === 1 && !/查|请/.test(text)) {
          providedArgs[stillMissing[0].key] = text;
        }
      }

      const missingRequired = paramList
        .filter((p) => p.required !== false && (providedArgs[p.key] === undefined || providedArgs[p.key] === ''))
        .map((p) => p.key);

      const missingLabels = paramList
        .filter((p) => missingRequired.includes(p.key))
        .map((p) => p.label || p.key);

      return {
        providedArgs,
        missingRequired,
        nextQuestion: missingLabels.length ? `请补充以下必填参数：${missingLabels.join('、')}` : null,
        ambiguities: []
      };
    },

    planQuery: ({ question, recordSchema, allowedOps }) => {
      const q = String(question || '');
      const ops = Array.isArray(allowedOps) && allowedOps.length ? allowedOps : ALLOWED_QUERY_OPS;
      const hasField = (k) => (recordSchema || []).some((f) => f.key === k);
      if (/失败原因|为什么失败|报错/.test(q) && ops.includes('filterTopErrors')) {
        return { op: 'filterTopErrors', groupBy: hasField('error') ? 'error' : null, limit: 5 };
      }
      if (/分布|按单位|按供电|占比/.test(q) && ops.includes('groupCount')) {
        const gb = (recordSchema || []).find((f) => /org|unit|status/i.test(f.key))?.key || null;
        return gb
          ? { op: 'groupCount', groupBy: gb }
          : { op: null, cannotComputeReason: '当前明细缺少分组维度字段' };
      }
      return { op: ops.includes('count') ? 'count' : ops[0] };
    },

    explainRun: ({ computedEvidence }) => {
      return {
        answer: `基于确定性统计结果：${JSON.stringify(computedEvidence || {})}`,
        evidenceRefs: ['deterministic-mock'],
        caveats: ['当前为离线 Mock 解释结果，仅引用已有统计摘要']
      };
    }
  };
}

/**
 * 创建 4+1 原子 AI 适配器。
 */
export function createAiClient({
  getConfig,
  getApiKey,
  fetchImpl = globalThis.fetch,
  mockHandlers = null
} = {}) {
  const mocks = { ...defaultMockHandlers(), ...(mockHandlers || {}) };
  const stats = {
    calls: 0,
    retries: 0,
    degradedCount: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    lastUsage: null
  };

  async function callOpenAiCompatible({ baseUrl, apiKey, model, messages, signal }) {
    const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const resp = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || 'deepseek-v4-flash',
        temperature: 0.1,
        messages
      }),
      signal
    });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${bodyText.slice(0, 160)}`);
    }
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('响应缺少 choices[0].message.content');
    }
    return { content, usage: json?.usage || null };
  }

  function recordUsage(usage) {
    if (!usage || typeof usage !== 'object') return;
    stats.totalPromptTokens += Number(usage.prompt_tokens || 0);
    stats.totalCompletionTokens += Number(usage.completion_tokens || 0);
    stats.lastUsage = usage;
  }

  async function invokeJsonTask({ taskName, systemPrompt, userPayload, validateFn, mockFn }) {
    const cfg = (await getConfig?.()) || { mode: 'mock' };
    const safePayload = redactObject(userPayload);

    if (cfg.mode !== 'remote' || !String(cfg.baseUrl || '').trim()) {
      const rawMock = await mockFn(safePayload);
      const checked = validateFn(rawMock);
      if (!checked.ok) {
        stats.degradedCount++;
        return {
          ok: false,
          mode: 'mock',
          errorCode: checked.errorCode || 'AI_SCHEMA_INVALID',
          errors: checked.errors,
          message: checked.errors.join('; ')
        };
      }
      return { ok: true, mode: 'mock', data: checked.value, usage: null, retried: false };
    }

    const userMessageText =
      `<untrusted_page_data>\n${JSON.stringify(safePayload)}\n</untrusted_page_data>\n` +
      `请严格只输出一个符合契约的 JSON 对象，禁止输出任何解释、代码或 <think> 之外的冗余文本。`;

    const promptTokens = estimateTokens(systemPrompt + '\n' + userMessageText);
    if (promptTokens > MAX_PROMPT_TOKENS) {
      return {
        ok: false,
        mode: 'remote',
        errorCode: 'AI_SCHEMA_INVALID',
        errors: [`上下文超限 (${promptTokens} > ${MAX_PROMPT_TOKENS} tokens)`],
        message: '单次模型输入超出 6K Token 上限，已拦截外发'
      };
    }

    const timeoutMs = Math.min(Math.max(Number(cfg.timeoutMs || DEFAULT_AI_TIMEOUT_MS), 2000), 15000);
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('AI_TIMEOUT')), timeoutMs);

    const apiKey = (await getApiKey?.()) || '';
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessageText }
    ];

    try {
      stats.calls++;
      const first = await callOpenAiCompatible({
        baseUrl: cfg.baseUrl,
        apiKey,
        model: cfg.model,
        messages,
        signal: controller.signal
      });
      recordUsage(first.usage);

      const parsed1 = stripThinkAndExtractJson(first.content);
      const val1 = parsed1.ok ? validateFn(parsed1.data) : { ok: false, errorCode: parsed1.errorCode, errors: [parsed1.message] };
      if (val1.ok) {
        return { ok: true, mode: 'remote', data: val1.value, usage: first.usage, retried: false };
      }

      // 容错机制：带具体校验错误自动重试 1 次（剩余时间充足时）
      if (Date.now() + 1200 < deadline) {
        stats.retries++;
        stats.calls++;
        const retryMessages = [
          ...messages,
          { role: 'assistant', content: first.content },
          {
            role: 'user',
            content:
              `你上一条 JSON 未通过校验（${val1.errorCode}: ${(val1.errors || []).join('; ')}）。` +
              `请立即修正并仅输出合法 JSON 对象，所有 stepId/skillId 必须严格来自输入数据。`
          }
        ];
        const second = await callOpenAiCompatible({
          baseUrl: cfg.baseUrl,
          apiKey,
          model: cfg.model,
          messages: retryMessages,
          signal: controller.signal
        });
        recordUsage(second.usage);

        const parsed2 = stripThinkAndExtractJson(second.content);
        const val2 = parsed2.ok ? validateFn(parsed2.data) : { ok: false, errorCode: parsed2.errorCode, errors: [parsed2.message] };
        if (val2.ok) {
          return { ok: true, mode: 'remote', data: val2.value, usage: second.usage, retried: true };
        }
        stats.degradedCount++;
        return {
          ok: false,
          mode: 'remote',
          errorCode: val2.errorCode || 'AI_SCHEMA_INVALID',
          errors: val2.errors,
          message: `${taskName} 重试后仍未通过校验: ${(val2.errors || []).join('; ')}`
        };
      }

      stats.degradedCount++;
      return {
        ok: false,
        mode: 'remote',
        errorCode: val1.errorCode || 'AI_SCHEMA_INVALID',
        errors: val1.errors,
        message: `${taskName} 校验失败且无足够时间重试: ${(val1.errors || []).join('; ')}`
      };
    } catch (err) {
      stats.degradedCount++;
      const isTimeout =
        err?.name === 'AbortError' || String(err?.message || '').includes('AI_TIMEOUT');
      return {
        ok: false,
        mode: 'remote',
        errorCode: isTimeout ? 'AI_TIMEOUT' : 'AI_SCHEMA_INVALID',
        errors: [String(err?.message || err)],
        message: isTimeout ? `模型请求超时（>${timeoutMs}ms）` : `模型调用失败: ${err.message}`
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getStats: () => ({ ...stats }),

    async matchSkill({ userQuery, skills }) {
      const knownIds = (skills || []).map((s) => s.id);
      return invokeJsonTask({
        taskName: 'matchSkill',
        systemPrompt:
          '你是技能匹配器。仅根据 <untrusted_page_data> 中 skills 列表和 userQuery，返回 JSON：{ "matchedSkillId": string|null, "candidates": [{"skillId": string, "score": number, "reason": string}], "confidence": "high"|"medium"|"low" }。严禁编造不存在的 skillId。',
        userPayload: { userQuery, skills },
        validateFn: (p) => validateMatchSkillProposal(p, knownIds),
        mockFn: (payload) => mocks.matchSkill(payload)
      });
    },

    async analyzeTrace({ traceSummary, pageContext }) {
      const knownStepIds = (traceSummary?.steps || []).map((s) => s.id);
      return invokeJsonTask({
        taskName: 'analyzeTrace',
        systemPrompt:
          '你是技能结构化分析器。只能引用 <untrusted_page_data> 中已存在的 stepId，禁止虚构新步骤、禁止生成 JS 或代码。返回 JSON：{ "name": string, "intent": string, "parameterCandidates": [{"key": string, "label": string, "type": "string"|"month"|"date"|"number"|"enum"|"dataset", "required": boolean, "sourceStepId": string, "reason": string}], "stepAnnotations": [{"stepId": string, "summary": string, "outputVar"?: string}], "batchLoopHint": object|null, "extractHint": object|null, "resultSelectorHint"?: string|null, "uncertainties": string[] }。',
        userPayload: { traceSummary, pageContext },
        validateFn: (p) => validateAnalyzeTraceProposal(p, knownStepIds),
        mockFn: (payload) => mocks.analyzeTrace(payload)
      });
    },

    async extractArgs({ userText, parameters, collectedArgs = {}, lastQuestion = null, currentDate }) {
      return invokeJsonTask({
        taskName: 'extractArgs',
        systemPrompt:
          '你是结构化参数提取器。结合 currentDate、collectedArgs、lastQuestion 从 userText 提取 parameters 中声明的参数；相对日期（如“本月/上个月/昨天”）必须归一化为标准格式。返回 JSON：{ "providedArgs": object, "missingRequired": string[], "nextQuestion": string|null, "ambiguities": string[] }。',
        userPayload: { userText, parameters, collectedArgs, lastQuestion, currentDate },
        validateFn: (p) => validateExtractArgsProposal(p, parameters),
        mockFn: (payload) => mocks.extractArgs(payload)
      });
    },

    async planQuery({ question, recordSchema, allowedOps = ALLOWED_QUERY_OPS }) {
      const keys = (recordSchema || []).map((r) => r.key);
      return invokeJsonTask({
        taskName: 'planQuery',
        systemPrompt:
          '你是查询规划器。只能将用户问题映射为 allowedOps 内的统计操作，绝不直接估算或编造统计数字。返回 JSON：{ "op": string|null, "groupBy"?: string|null, "metricField"?: string|null, "filterStatus"?: string|null, "limit"?: number|null, "cannotComputeReason"?: string|null }。',
        userPayload: { question, recordSchema, allowedOps },
        validateFn: (p) => validatePlanQueryProposal(p, keys),
        mockFn: (payload) => mocks.planQuery(payload)
      });
    },

    async explainRun({ question, computedEvidence }) {
      return invokeJsonTask({
        taskName: 'explainRun',
        systemPrompt:
          '你是结果解释器。只能基于 computedEvidence 中已算出的确定性事实回答，禁止推测未提供的分布或金额。返回 JSON：{ "answer": string, "evidenceRefs": string[], "caveats": string[] }。',
        userPayload: { question, computedEvidence },
        validateFn: (p) => validateExplainRunProposal(p),
        mockFn: (payload) => mocks.explainRun(payload)
      });
    }
  };
}
