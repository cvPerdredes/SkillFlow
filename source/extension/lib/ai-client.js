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
 * 面向 SiliconFlow / DeepSeek / ≤ 284B 内网 OpenAI-Compatible 模型的 4+1 原子 AI 适配器：
 * - 单次请求硬控 ≤ 5500 Tokens；
 * - 剥离 <think>...</think> 与 Markdown 代码块，支持内容分片与 reasoning_content 截断诊断；
 * - Schema / stepId 校验失败带报错信息自动重试 1 次（默认超时 30s，支持 5s–60s 配置）；
 * - 支持 enable_thinking: false 遇到 400 自动剥离重试、连通性探针、拉取模型列表与实时遥测。
 */

export const DEFAULT_AI_TIMEOUT_MS = 30000;
export const MAX_PROMPT_TOKENS = 5500;

/**
 * 规范化 OpenAI-Compatible /chat/completions 地址（兼容 /v1、/v1/ 或已含尾路径）。
 */
export function resolveChatEndpoint(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) {
    throw new Error('缺少模型接口 Base URL');
  }
  if (/\/chat\/completions$/i.test(clean)) return clean;
  if (/\/models$/i.test(clean)) return clean.replace(/\/models$/i, '/chat/completions');
  return `${clean}/chat/completions`;
}

/**
 * 规范化 OpenAI-Compatible /models 地址（兼容 /v1、/v1/ 或已含尾路径）。
 */
export function resolveModelsEndpoint(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) {
    throw new Error('缺少模型接口 Base URL');
  }
  if (/\/models$/i.test(clean)) return clean;
  if (/\/chat\/completions$/i.test(clean)) return clean.replace(/\/chat\/completions$/i, '/models');
  return `${clean}/models`;
}

function extractAssistantContent(json) {
  const msg = json?.choices?.[0]?.message;
  let text = '';
  if (typeof msg?.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg?.content)) {
    text = msg.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (!String(text || '').trim()) {
    if (typeof msg?.reasoning_content === 'string' && msg.reasoning_content.trim()) {
      throw new Error(
        '模型仅输出了思考过程 (reasoning_content) 而正文 content 为空，请调大 maxTokens 或在 00 区将“思考模式”切为“关闭思考加速 JSON”后重试'
      );
    }
    throw new Error('响应缺少有效 choices[0].message.content');
  }
  return text;
}

function classifyRemoteError(err, { httpStatus = null, baseUrl = '', model = '' } = {}) {
  const status = Number(httpStatus || err?.httpStatus || 0) || null;
  const msg = String(err?.message || err || '');
  const isTimeout = err?.name === 'AbortError' || /AI_TIMEOUT|超时/i.test(msg);

  let hint = `请检查 Base URL（${baseUrl || '未配置'}）、Model ID（${model || '未填'}）与网络连通性。`;
  if (isTimeout) {
    hint = '请求超时，建议在 00 区调大“超时(秒)”（如 30–60 秒），或将思考模式设为“关闭思考加速 JSON”后重试。';
  } else if (status === 401 || status === 403) {
    hint = `鉴权失败（HTTP ${status}）：请检查会话 API Key 是否填写正确、是否失效或账户余额不足。`;
  } else if (status === 404) {
    hint = `接口或模型不存在（HTTP 404）：请核对 Base URL（例如 https://api.siliconflow.cn/v1）与 Model ID（${model || '未填'}），可点击“拉取模型列表”核对精确模型前缀。`;
  } else if (status === 429) {
    hint = '触发限流或配额不足（HTTP 429）：请稍后重试或检查账户配额/并发限制。';
  } else if (status === 400) {
    hint = `请求参数或模型被网关拒绝（HTTP 400）：请核对 Model ID 是否正确，以及 maxTokens/thinkingMode 参数是否受支持。`;
  } else if (status && status >= 500) {
    hint = `远端模型网关服务异常（HTTP ${status}）：请稍后重试或切换模型。`;
  } else if (/Failed to fetch|NetworkError|fetch failed|CORS|ERR_/i.test(msg)) {
    hint = '网络请求或 CORS 拦截失败：请点击保存/探测以授予该网关主机权限，并确认代理或网关地址可达。';
  }

  return { httpStatus: status, isTimeout, hint };
}

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
 * 创建 4+1 原子 AI 适配器（支持多提供商远程调用、探针探测与实时遥测）。
 */
export function createAiClient({
  getConfig,
  getApiKey,
  fetchImpl = globalThis.fetch,
  mockHandlers = null,
  onTelemetry = null
} = {}) {
  const mocks = { ...defaultMockHandlers(), ...(mockHandlers || {}) };
  const stats = {
    calls: 0,
    retries: 0,
    degradedCount: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    lastUsage: null,
    lastTask: null,
    lastMode: null,
    lastModel: null,
    lastLatencyMs: 0,
    lastError: null
  };

  function emitTelemetry() {
    if (typeof onTelemetry !== 'function') return;
    try {
      onTelemetry({ ...stats });
    } catch (_) {}
  }

  function finishTaskStats({ taskName, mode, model, startedAt, error = null }) {
    stats.lastTask = taskName;
    stats.lastMode = mode;
    stats.lastModel = model || null;
    stats.lastLatencyMs = Math.max(0, Date.now() - startedAt);
    stats.lastError = error ? String(error) : null;
    emitTelemetry();
  }

  async function postChatJson({ endpoint, apiKey, payload, signal }) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const resp = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal
    });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      const err = new Error(`HTTP ${resp.status}: ${bodyText.slice(0, 160)}`);
      err.httpStatus = resp.status;
      err.responseBody = bodyText.slice(0, 400);
      throw err;
    }
    const json = await resp.json();
    const content = extractAssistantContent(json);
    return { content, usage: json?.usage || null, httpStatus: resp.status };
  }

  async function callOpenAiCompatible({
    baseUrl,
    apiKey,
    model,
    messages,
    signal,
    temperature = 0.1,
    maxTokens = 2048,
    thinkingMode = 'auto'
  }) {
    const endpoint = resolveChatEndpoint(baseUrl);
    const parsedTemp = Number(temperature);
    const safeTemp = Number.isFinite(parsedTemp)
      ? Math.min(Math.max(parsedTemp, 0), 1)
      : 0.1;
    const parsedMax = Number(maxTokens);
    const safeMax = Number.isFinite(parsedMax)
      ? Math.min(Math.max(Math.round(parsedMax), 256), 4096)
      : 2048;

    const basePayload = {
      model: String(model || 'deepseek-v4-flash-0731').trim() || 'deepseek-v4-flash-0731',
      temperature: safeTemp,
      max_tokens: safeMax,
      messages
    };

    if (thinkingMode === 'off') {
      try {
        const res = await postChatJson({
          endpoint,
          apiKey,
          payload: { ...basePayload, enable_thinking: false },
          signal
        });
        return { ...res, thinkingStripped: false };
      } catch (err) {
        const errText = String(err?.responseBody || err?.message || '');
        if (
          err?.httpStatus === 400 &&
          /enable_thinking|unknown field|extra_forbidden|unrecognized|unsupported/i.test(errText)
        ) {
          const fallbackRes = await postChatJson({
            endpoint,
            apiKey,
            payload: basePayload,
            signal
          });
          return { ...fallbackRes, thinkingStripped: true };
        }
        throw err;
      }
    }

    const res = await postChatJson({
      endpoint,
      apiKey,
      payload: basePayload,
      signal
    });
    return { ...res, thinkingStripped: false };
  }

  function recordUsage(usage) {
    if (!usage || typeof usage !== 'object') return;
    stats.totalPromptTokens += Number(usage.prompt_tokens || 0);
    stats.totalCompletionTokens += Number(usage.completion_tokens || 0);
    stats.lastUsage = usage;
  }

  async function resolveProbeConfig(overrideCfg = null) {
    const baseCfg = (await getConfig?.()) || {};
    const ov = overrideCfg && typeof overrideCfg === 'object' ? overrideCfg : {};
    const cfg = { ...baseCfg, ...ov };
    const directKey = typeof ov.apiKey === 'string' ? ov.apiKey.trim() : '';
    const apiKey = directKey || (await getApiKey?.()) || '';
    const model = String(cfg.model || 'deepseek-v4-flash-0731').trim() || 'deepseek-v4-flash-0731';
    const timeoutMs = Math.min(Math.max(Number(cfg.timeoutMs || DEFAULT_AI_TIMEOUT_MS), 1000), 60000);
    return { cfg, apiKey, model, timeoutMs };
  }

  async function invokeJsonTask({ taskName, systemPrompt, userPayload, validateFn, mockFn }) {
    const startedAt = Date.now();
    const cfg = (await getConfig?.()) || { mode: 'mock' };
    const safePayload = redactObject(userPayload);

    if (cfg.mode !== 'remote' || !String(cfg.baseUrl || '').trim()) {
      try {
        const rawMock = await mockFn(safePayload);
        const checked = validateFn(rawMock);
        if (!checked.ok) {
          stats.degradedCount++;
          const msg = (checked.errors || []).join('; ');
          finishTaskStats({ taskName, mode: 'mock', model: 'mock', startedAt, error: msg });
          return {
            ok: false,
            mode: 'mock',
            model: 'mock',
            latencyMs: stats.lastLatencyMs,
            errorCode: checked.errorCode || 'AI_SCHEMA_INVALID',
            errors: checked.errors,
            message: msg
          };
        }
        finishTaskStats({ taskName, mode: 'mock', model: 'mock', startedAt, error: null });
        return {
          ok: true,
          mode: 'mock',
          model: 'mock',
          data: checked.value,
          usage: null,
          latencyMs: stats.lastLatencyMs,
          retried: false
        };
      } catch (err) {
        stats.degradedCount++;
        const msg = String(err?.message || err);
        finishTaskStats({ taskName, mode: 'mock', model: 'mock', startedAt, error: msg });
        return {
          ok: false,
          mode: 'mock',
          model: 'mock',
          latencyMs: stats.lastLatencyMs,
          errorCode: 'AI_SCHEMA_INVALID',
          errors: [msg],
          message: msg
        };
      }
    }

    const activeModel = String(cfg.model || 'deepseek-v4-flash-0731').trim() || 'deepseek-v4-flash-0731';
    const userMessageText =
      `<untrusted_page_data>\n${JSON.stringify(safePayload)}\n</untrusted_page_data>\n` +
      `请严格只输出一个符合契约的 JSON 对象，禁止输出任何解释、Markdown 说明或多余文本。`;

    const promptTokens = estimateTokens(systemPrompt + '\n' + userMessageText);
    if (promptTokens > MAX_PROMPT_TOKENS) {
      stats.degradedCount++;
      const msg = '单次模型输入超出 5500 Token 上限，已拦截外发';
      finishTaskStats({ taskName, mode: 'remote', model: activeModel, startedAt, error: msg });
      return {
        ok: false,
        mode: 'remote',
        model: activeModel,
        latencyMs: stats.lastLatencyMs,
        errorCode: 'AI_SCHEMA_INVALID',
        errors: [`上下文超限 (${promptTokens} > ${MAX_PROMPT_TOKENS} tokens)`],
        message: msg
      };
    }

    const timeoutMs = Math.min(Math.max(Number(cfg.timeoutMs || DEFAULT_AI_TIMEOUT_MS), 1000), 60000);
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
        model: activeModel,
        messages,
        signal: controller.signal,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        thinkingMode: cfg.thinkingMode || 'auto'
      });
      recordUsage(first.usage);

      const parsed1 = stripThinkAndExtractJson(first.content);
      const val1 = parsed1.ok
        ? validateFn(parsed1.data)
        : { ok: false, errorCode: parsed1.errorCode, errors: [parsed1.message] };
      if (val1.ok) {
        finishTaskStats({ taskName, mode: 'remote', model: activeModel, startedAt, error: null });
        return {
          ok: true,
          mode: 'remote',
          model: activeModel,
          data: val1.value,
          usage: first.usage,
          latencyMs: stats.lastLatencyMs,
          retried: false
        };
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
          model: activeModel,
          messages: retryMessages,
          signal: controller.signal,
          temperature: cfg.temperature,
          maxTokens: cfg.maxTokens,
          thinkingMode: first.thinkingStripped ? 'auto' : cfg.thinkingMode || 'auto'
        });
        recordUsage(second.usage);

        const parsed2 = stripThinkAndExtractJson(second.content);
        const val2 = parsed2.ok
          ? validateFn(parsed2.data)
          : { ok: false, errorCode: parsed2.errorCode, errors: [parsed2.message] };
        if (val2.ok) {
          finishTaskStats({ taskName, mode: 'remote', model: activeModel, startedAt, error: null });
          return {
            ok: true,
            mode: 'remote',
            model: activeModel,
            data: val2.value,
            usage: second.usage || first.usage,
            latencyMs: stats.lastLatencyMs,
            retried: true
          };
        }
        stats.degradedCount++;
        const msg = `${taskName} 重试后仍未通过校验: ${(val2.errors || []).join('; ')}`;
        finishTaskStats({ taskName, mode: 'remote', model: activeModel, startedAt, error: msg });
        return {
          ok: false,
          mode: 'remote',
          model: activeModel,
          latencyMs: stats.lastLatencyMs,
          errorCode: val2.errorCode || 'AI_SCHEMA_INVALID',
          errors: val2.errors,
          message: msg
        };
      }

      stats.degradedCount++;
      const msg = `${taskName} 校验失败且剩余超时不足以重试: ${(val1.errors || []).join('; ')}`;
      finishTaskStats({ taskName, mode: 'remote', model: activeModel, startedAt, error: msg });
      return {
        ok: false,
        mode: 'remote',
        model: activeModel,
        latencyMs: stats.lastLatencyMs,
        errorCode: val1.errorCode || 'AI_SCHEMA_INVALID',
        errors: val1.errors,
        message: msg
      };
    } catch (err) {
      stats.degradedCount++;
      const diag = classifyRemoteError(err, {
        httpStatus: err?.httpStatus,
        baseUrl: cfg.baseUrl,
        model: activeModel
      });
      const msg = diag.isTimeout
        ? `模型请求超时（>${timeoutMs}ms）`
        : `模型调用失败: ${err?.message || err}`;
      finishTaskStats({ taskName, mode: 'remote', model: activeModel, startedAt, error: msg });
      return {
        ok: false,
        mode: 'remote',
        model: activeModel,
        httpStatus: diag.httpStatus,
        latencyMs: stats.lastLatencyMs,
        errorCode: diag.isTimeout ? 'AI_TIMEOUT' : 'AI_SCHEMA_INVALID',
        errors: [String(err?.message || err)],
        hint: diag.hint,
        message: msg
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function testConnection(overrideCfg = null) {
    const startedAt = Date.now();
    const { cfg, apiKey, model, timeoutMs } = await resolveProbeConfig(overrideCfg);
    let endpoint = '';
    try {
      endpoint = resolveChatEndpoint(cfg.baseUrl);
    } catch (err) {
      const msg = err.message || String(err);
      finishTaskStats({ taskName: 'testConnection', mode: 'remote', model, startedAt, error: msg });
      return {
        ok: false,
        httpStatus: null,
        latencyMs: stats.lastLatencyMs,
        model,
        endpoint: '',
        parsedJson: null,
        rawPreview: '',
        usage: null,
        thinkingStripped: false,
        errorCode: 'AI_CONFIG_INVALID',
        message: msg,
        hint: '请先输入合法的 http(s):// Base URL，如 https://api.siliconflow.cn/v1'
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('AI_TIMEOUT')), timeoutMs);
    try {
      stats.calls++;
      const res = await callOpenAiCompatible({
        baseUrl: cfg.baseUrl,
        apiKey,
        model,
        messages: [
          {
            role: 'system',
            content: '你是接口连通性探针。请严格仅输出一行合法 JSON：{"ok":true,"echo":"pong"}。'
          },
          { role: 'user', content: '请立即输出 {"ok":true,"echo":"pong"}' }
        ],
        signal: controller.signal,
        temperature: 0,
        maxTokens: Math.min(Math.max(Number(cfg.maxTokens || 512), 512), 1024),
        thinkingMode: cfg.thinkingMode || 'auto'
      });
      recordUsage(res.usage);
      const parsed = stripThinkAndExtractJson(res.content);
      finishTaskStats({ taskName: 'testConnection', mode: 'remote', model, startedAt, error: null });
      return {
        ok: true,
        httpStatus: res.httpStatus || 200,
        latencyMs: stats.lastLatencyMs,
        model,
        endpoint,
        parsedJson: parsed.ok ? parsed.data : null,
        rawPreview: String(res.content || '').trim().slice(0, 160),
        usage: res.usage,
        thinkingStripped: Boolean(res.thinkingStripped),
        errorCode: null,
        message: parsed.ok ? '连通成功且返回合法 JSON' : 'HTTP 连通成功，但探针正文未完全符合 JSON 格式',
        hint: parsed.ok
          ? res.thinkingStripped
            ? '注：网关不支持 enable_thinking 字段，已自动剥离并兼容完成。'
            : ''
          : '连通正常；若后续任务解析失败，可在 00 区关闭思考模式或调大 maxTokens。'
      };
    } catch (err) {
      stats.degradedCount++;
      const diag = classifyRemoteError(err, {
        httpStatus: err?.httpStatus,
        baseUrl: cfg.baseUrl,
        model
      });
      const msg = diag.isTimeout
        ? `探针请求超时（>${timeoutMs}ms）`
        : String(err?.message || err);
      finishTaskStats({ taskName: 'testConnection', mode: 'remote', model, startedAt, error: msg });
      return {
        ok: false,
        httpStatus: diag.httpStatus,
        latencyMs: stats.lastLatencyMs,
        model,
        endpoint,
        parsedJson: null,
        rawPreview: '',
        usage: null,
        thinkingStripped: false,
        errorCode: diag.isTimeout ? 'AI_TIMEOUT' : 'AI_PROBE_FAILED',
        message: msg,
        hint: diag.hint
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function listModels(overrideCfg = null) {
    const startedAt = Date.now();
    const { cfg, apiKey, model, timeoutMs } = await resolveProbeConfig(overrideCfg);
    let endpoint = '';
    try {
      endpoint = resolveModelsEndpoint(cfg.baseUrl);
    } catch (err) {
      const msg = err.message || String(err);
      finishTaskStats({ taskName: 'listModels', mode: 'remote', model, startedAt, error: msg });
      return {
        ok: false,
        httpStatus: null,
        latencyMs: stats.lastLatencyMs,
        endpoint: '',
        models: [],
        deepseekModels: [],
        count: 0,
        errorCode: 'AI_CONFIG_INVALID',
        message: msg,
        hint: '请先输入合法的 http(s):// Base URL'
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('AI_TIMEOUT')), timeoutMs);
    try {
      stats.calls++;
      const headers = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const resp = await fetchImpl(endpoint, {
        method: 'GET',
        headers,
        signal: controller.signal
      });
      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => '');
        const err = new Error(`HTTP ${resp.status}: ${bodyText.slice(0, 160)}`);
        err.httpStatus = resp.status;
        err.responseBody = bodyText.slice(0, 400);
        throw err;
      }
      const json = await resp.json();
      const rawList = Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.models)
          ? json.models
          : Array.isArray(json)
            ? json
            : [];
      const models = Array.from(
        new Set(
          rawList
            .map((m) => (typeof m === 'string' ? m : String(m?.id || m?.name || '')).trim())
            .filter(Boolean)
        )
      );
      const deepseekModels = models.filter((id) => /deepseek/i.test(id));
      finishTaskStats({ taskName: 'listModels', mode: 'remote', model, startedAt, error: null });
      return {
        ok: true,
        httpStatus: resp.status,
        latencyMs: stats.lastLatencyMs,
        endpoint,
        models,
        deepseekModels,
        count: models.length,
        errorCode: null,
        message: `成功拉取 ${models.length} 个模型`,
        hint: deepseekModels.length
          ? `检测到 ${deepseekModels.length} 个 DeepSeek 系列模型。`
          : '未检索到含 deepseek 字样的模型，请从列表中选择可用模型。'
      };
    } catch (err) {
      stats.degradedCount++;
      const diag = classifyRemoteError(err, {
        httpStatus: err?.httpStatus,
        baseUrl: cfg.baseUrl,
        model
      });
      const msg = diag.isTimeout
        ? `拉取模型列表超时（>${timeoutMs}ms）`
        : String(err?.message || err);
      finishTaskStats({ taskName: 'listModels', mode: 'remote', model, startedAt, error: msg });
      return {
        ok: false,
        httpStatus: diag.httpStatus,
        latencyMs: stats.lastLatencyMs,
        endpoint,
        models: [],
        deepseekModels: [],
        count: 0,
        errorCode: diag.isTimeout ? 'AI_TIMEOUT' : 'AI_MODELS_FAILED',
        message: msg,
        hint: diag.hint
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getStats: () => ({ ...stats }),
    testConnection,
    listModels,

    async matchSkill({ userQuery, skills }) {
      const knownIds = (skills || []).map((s) => s.id);
      return invokeJsonTask({
        taskName: 'matchSkill',
        systemPrompt:
          '你是技能路由器。只能从 <untrusted_page_data>.skills 的既有 id 中选择最匹配的技能，严禁编造不存在的 skillId；无合适匹配时返回 matchedSkillId: null, confidence: "low"。' +
          '输出唯一 JSON 对象：{"matchedSkillId":string|null,"candidates":[{"skillId":string,"score":number,"reason":string}],"confidence":"high"|"medium"|"low"}。' +
          '示例：{"matchedSkillId":"sk_1","candidates":[{"skillId":"sk_1","score":0.92,"reason":"包含查询单位与电量意图"}],"confidence":"high"}。',
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
          '你是技能结构化分析器。所有 sourceStepId / stepId / preSteps / rowSteps / postSteps 必须严格来自 <untrusted_page_data>.traceSummary.steps 中的 id，严禁虚构 stepId、严禁输出 code/script/executeScript/steps/newSteps。' +
          'resultSelectorHint 必须优先选用 statusContainers 中的状态节点（如 "#result-summary" 或 "#receipt-status"），严禁将表格容器（如 "#result-table"）填入 resultSelectorHint。' +
          '输出唯一 JSON：{"name":string,"intent":string,"parameterCandidates":[{"key":string,"label":string,"type":"string"|"month"|"date"|"number"|"enum"|"dataset","required":boolean,"sourceStepId":string,"reason":string}],"stepAnnotations":[{"stepId":string,"summary":string,"outputVar"?:string}],"batchLoopHint":object|null,"extractHint":object|null,"resultSelectorHint"?:string|null,"uncertainties":string[]}。' +
          '示例：{"name":"电量台账查询","intent":"按单位与月份查询明细","parameterCandidates":[{"key":"unit","label":"查询单位","type":"string","required":true,"sourceStepId":"s1","reason":"单位输入"}],"stepAnnotations":[{"stepId":"s1","summary":"输入查询单位"}],"batchLoopHint":null,"extractHint":{"mode":"table","containerSelector":"#result-table"},"resultSelectorHint":"#result-summary","uncertainties":[]}。',
        userPayload: { traceSummary, pageContext },
        validateFn: (p) => validateAnalyzeTraceProposal(p, knownStepIds),
        mockFn: (payload) => mocks.analyzeTrace(payload)
      });
    },

    async extractArgs({ userText, parameters, collectedArgs = {}, lastQuestion = null, currentDate }) {
      return invokeJsonTask({
        taskName: 'extractArgs',
        systemPrompt:
          '你是参数提取器。结合 currentDate、collectedArgs 与 lastQuestion，从 userText 提取 parameters 中声明的参数。' +
          '铁律：providedArgs 仅允许填入从本轮或已收集输入中明确提取到的非空值（未提及字段绝对禁止输出 "" 或 null），key 必须属于 parameters；相对日期（本月/上个月/昨天等）依据 currentDate 归一化为 YYYY-MM 或 YYYY-MM-DD；缺失的必填字段 key 列入 missingRequired 并给出简短中文追问 nextQuestion。' +
          '输出唯一 JSON：{"providedArgs":object,"missingRequired":string[],"nextQuestion":string|null,"ambiguities":string[]}。' +
          '示例：{"providedArgs":{"unit":"B单位"},"missingRequired":["month"],"nextQuestion":"请补充查询月份(YYYY-MM)","ambiguities":[]}。',
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
          `你是统计查询规划器。只能将问题映射为 allowedOps（${ALLOWED_QUERY_OPS.join('|')}）内的统计操作符，groupBy/metricField 必须来自 recordSchema；若缺少所需字段或无法计算，令 op=null 并写明 cannotComputeReason，绝不编造数字。` +
          '输出唯一 JSON：{"op":string|null,"groupBy"?:string|null,"metricField"?:string|null,"filterStatus"?:string|null,"limit"?:number|null,"cannotComputeReason"?:string|null}。' +
          '示例：{"op":"groupCount","groupBy":"orgName","filterStatus":"verified"}。',
        userPayload: { question, recordSchema, allowedOps },
        validateFn: (p) => validatePlanQueryProposal(p, keys),
        mockFn: (payload) => mocks.planQuery(payload)
      });
    },

    async explainRun({ question, computedEvidence }) {
      return invokeJsonTask({
        taskName: 'explainRun',
        systemPrompt:
          '你是执行结果解释器。只能陈述 computedEvidence 中已经算出的确定性事实与数字，禁止推测或补全未出现的字段、单位或金额，并在 evidenceRefs 中列出所引用的证据条目。' +
          '输出唯一 JSON：{"answer":string,"evidenceRefs":string[],"caveats":string[]}。' +
          '示例：{"answer":"本次共执行 12 条，成功 10 条、失败 2 条。","evidenceRefs":["records:1..12"],"caveats":[]}。',
        userPayload: { question, computedEvidence },
        validateFn: (p) => validateExplainRunProposal(p),
        mockFn: (payload) => mocks.explainRun(payload)
      });
    }
  };
}
