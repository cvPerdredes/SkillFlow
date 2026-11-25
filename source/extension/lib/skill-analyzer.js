"use strict";

import { buildTraceSummaryForAI, pickPreferredStatusSelector } from './dom-distiller.js';
import { redactObject, safeOriginOf } from './sanitizer.js';
import { normalizeSkillIR, validateSkillIR } from './schemas.js';

/**
 * 轨迹压缩 → 脱敏载荷预览 → analyzeTrace AI 分析 → 规则回退与 IR 组装模块。
 */

function proposeFallbackKey(step, index, used) {
  const raw = `${step.target?.label || ''} ${step.target?.placeholder || ''} ${step.target?.name || ''}`.toLowerCase();
  let base = `field${index + 1}`;
  let type = 'string';

  if (/月份|月度|month/.test(raw) || step.target?.type === 'month') {
    base = 'month';
    type = 'month';
  } else if (/日期|时间|date/.test(raw) || step.target?.type === 'date') {
    base = 'date';
    type = 'date';
  } else if (/电量|kwh|数量|数值/.test(raw) || step.target?.type === 'number') {
    base = /电量|kwh/.test(raw) ? 'kwh' : 'value';
    type = 'number';
  } else if (/批号|batch/.test(raw)) {
    base = 'batchCode';
  } else if (/表计|meter/.test(raw)) {
    base = 'meterNo';
  } else if (/单位|部门|org|unit/.test(raw)) {
    base = 'unit';
  } else if (/客户|customer/.test(raw)) {
    base = 'customer';
  }

  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}_${n++}`;
  used.add(key);
  return { key, type };
}

/**
 * 生成外发大模型前的脱敏预览载荷（不含密码、Token、敏感原值）。
 */
export function buildSanitizedPreviewPayload({ session, distilled = null }) {
  const bundle = buildTraceSummaryForAI(session, distilled);
  const safeBundle = redactObject({
    traceSummary: bundle.traceSummary,
    pageContext: bundle.pageContext
  });
  return {
    traceSummary: safeBundle.traceSummary,
    pageContext: safeBundle.pageContext,
    metrics: {
      rawBytes: bundle.rawBytes,
      distilledBytes: bundle.distilledBytes,
      compressionRatio: bundle.compressionRatio,
      estimatedTokens: bundle.estimatedTokens
    },
    previewJson: JSON.stringify(safeBundle, null, 2)
  };
}

/**
 * 模型超时、异常或离线时的规则兜底草稿生成（仅绑定原轨迹 stepId）。
 */
export function fallbackAnalyzeTrace({ session, distilled = null }) {
  const steps = Array.isArray(session?.steps) ? session.steps : [];
  const usedKeys = new Set();
  const parameterCandidates = [];
  const uncertainties = [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.action === 'auth_checkpoint') {
      uncertainties.push(`步骤 ${s.id} 为登录检查点，默认采用人工接管（manual_takeover）`);
      continue;
    }
    if (s.action === 'manual' || s.sensitive) {
      uncertainties.push(`步骤 ${s.id} 涉及敏感字段，不自动参数化或存储原值`);
      continue;
    }
    if (s.action === 'fill' || s.action === 'select') {
      const { key, type } = proposeFallbackKey(s, i, usedKeys);
      parameterCandidates.push({
        key,
        label: s.target?.label || s.target?.placeholder || key,
        type,
        required: true,
        sourceStepId: s.id,
        reason: '本地规则兜底建议'
      });
    }
  }

  const resultSelectorHint = pickPreferredStatusSelector(distilled?.statusContainers) || null;
  let extractHint = null;
  if (distilled?.statusContainers?.some((c) => c.selector === '#receipt-box' || c.selector === '#receipt-status')) {
    extractHint = {
      mode: 'receipt',
      containerSelector: '#receipt-box',
      statusSelector: '#receipt-status'
    };
  } else if (distilled?.tables?.length) {
    extractHint = {
      mode: 'table',
      containerSelector: distilled.tables[0].selector
    };
  }

  const pageTitle = distilled?.pageContext?.title || '';
  return {
    name: session?.name || (pageTitle ? `${pageTitle.slice(0, 20)}` : '录制技能草稿'),
    intent: `共 ${steps.length} 步操作（规则兜底解析）`,
    parameterCandidates,
    stepAnnotations: steps.map((s) => ({
      stepId: s.id,
      summary: `${s.action} ${s.target?.label || s.target?.text || s.url || ''}`.trim()
    })),
    batchLoopHint: null,
    extractHint,
    resultSelectorHint,
    uncertainties
  };
}

/**
 * 调用 analyzeTrace 生成技能草稿；失败时自动降级规则模式，绝不阻塞录制资产保存。
 */
export async function analyzeRecordedTrace({ session, distilled = null, aiClient }) {
  const previewPayload = buildSanitizedPreviewPayload({ session, distilled });
  if (!aiClient) {
    return {
      ok: true,
      mode: 'fallback',
      degraded: true,
      errorCode: null,
      errorMessage: '未配置 AI 适配器，已切换本地规则生成草稿',
      draft: fallbackAnalyzeTrace({ session, distilled }),
      previewPayload,
      usage: null
    };
  }

  const res = await aiClient.analyzeTrace({
    traceSummary: previewPayload.traceSummary,
    pageContext: previewPayload.pageContext
  });

  if (res.ok) {
    const draft = structuredClone(res.data || {});
    const isTableSel = /(?:^|[.#_-\s])table\b/i.test(String(draft.resultSelectorHint || ''));
    if ((!draft.resultSelectorHint || isTableSel) && previewPayload?.traceSummary?.statusContainers?.length) {
      draft.resultSelectorHint = pickPreferredStatusSelector(previewPayload.traceSummary.statusContainers) || null;
    }
    return {
      ok: true,
      mode: res.mode,
      degraded: false,
      draft,
      previewPayload,
      usage: res.usage || null,
      retried: Boolean(res.retried)
    };
  }

  return {
    ok: true,
    mode: 'fallback',
    degraded: true,
    errorCode: res.errorCode || 'AI_SCHEMA_INVALID',
    errorMessage: res.message || '模型解析失败，已安全降级为规则编辑草稿',
    draft: fallbackAnalyzeTrace({ session, distilled }),
    previewPayload,
    usage: null
  };
}

/**
 * 将已录制步骤与 AI/人工审核后的参数决策合并为校验通过的 Skill IR v0.3。
 */
export function applyDraftToSkillIR({ session, draft = null, overrides = {} }) {
  const base = structuredClone(session || {});
  if (draft?.name && !overrides.name) base.name = draft.name;
  if (overrides.name) base.name = overrides.name;
  if (overrides.intent !== undefined) base.intent = overrides.intent;
  else if (draft?.intent) base.intent = draft.intent;

  if (overrides.authPolicy) base.authPolicy = overrides.authPolicy;
  if (overrides.resultSelector !== undefined) base.resultSelector = overrides.resultSelector;
  else if (draft?.resultSelectorHint) base.resultSelector = draft.resultSelectorHint;

  const steps = Array.isArray(base.steps) ? base.steps : [];
  const stepMap = new Map(steps.map((s) => [s.id, s]));

  const hasExplicitVarBindings =
    overrides.stepVarBindings instanceof Map ||
    (overrides.stepVarBindings && typeof overrides.stepVarBindings === 'object');
  const varBindings =
    overrides.stepVarBindings instanceof Map
      ? overrides.stepVarBindings
      : hasExplicitVarBindings
        ? new Map(Object.entries(overrides.stepVarBindings))
        : null;

  if (Array.isArray(overrides.parameters)) {
    base.parameters = overrides.parameters;
    for (const s of steps) {
      delete s.paramKey;
      if (s.valueRef?.param) delete s.valueRef;
      if (hasExplicitVarBindings && s.valueRef?.var) delete s.valueRef;
    }
    for (const p of overrides.parameters) {
      const targetStep = p.sourceStepId ? stepMap.get(p.sourceStepId) : null;
      if (targetStep && !targetStep.sensitive && targetStep.action !== 'auth_checkpoint' && targetStep.action !== 'manual') {
        targetStep.paramKey = p.key;
        targetStep.valueRef = { param: p.key };
      }
    }
  } else if (Array.isArray(draft?.parameterCandidates) && !base.parameters?.length) {
    base.parameters = draft.parameterCandidates.map((c) => {
      const targetStep = stepMap.get(c.sourceStepId);
      if (targetStep && !targetStep.sensitive) {
        targetStep.paramKey = c.key;
        targetStep.valueRef = { param: c.key };
      }
      return {
        key: c.key,
        label: c.label || c.key,
        type: c.type || 'string',
        required: c.required !== false,
        defaultValue: targetStep?.value ?? '',
        sourceStepId: c.sourceStepId
      };
    });
  }

  if (varBindings) {
    for (const [sid, rawVar] of varBindings.entries()) {
      const varName = String(rawVar || '').trim();
      const targetStep = stepMap.get(sid);
      if (
        varName &&
        targetStep &&
        !targetStep.sensitive &&
        targetStep.action !== 'auth_checkpoint' &&
        targetStep.action !== 'manual'
      ) {
        delete targetStep.paramKey;
        targetStep.valueRef = { var: varName };
      }
    }
  }

  const normalized = normalizeSkillIR(base);
  const validation = validateSkillIR(normalized);
  return { skill: normalized, validation };
}

/**
 * 零代码页面选点提取（模块 B2）：
 * 清空 target.text 使回放按槽位定位（testId / stableId / cssPath）而非写死旧录制值。
 */
export function buildExtractStepFromPick({
  pickedTarget,
  origin = '',
  outputVar,
  stepId = ''
} = {}) {
  const varName = String(outputVar || '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(varName)) {
    throw new Error('提取变量名必须以英文字母开头，仅含字母、数字和下划线（最多 40 位）');
  }
  if (!pickedTarget || typeof pickedTarget !== 'object' || Object.keys(pickedTarget).length === 0) {
    throw new Error('缺少选点拾取的页面目标节点描述');
  }
  const cleanTarget = redactObject(structuredClone(pickedTarget));
  cleanTarget.text = '';
  return {
    id: String(stepId || `s_extract_${Date.now()}`).trim(),
    action: 'extract',
    origin: safeOriginOf(origin) || '',
    target: cleanTarget,
    outputVar: varName,
    risk: 'read'
  };
}

/**
 * 跨系统 extract 步骤智能插位（纯函数，不原地修改 steps）：
 * 若 extractStep.origin 已在源站出现过且后续存在异源跳转 depIdx，则插在异源迁移前
 * （若前一步为 <a> 跳站链接点击则再提前到点击前）；单站则追加末尾。
 */
export function insertExtractStep(steps, extractStep, startUrl = '') {
  const list = Array.isArray(steps) ? [...steps] : [];
  if (!extractStep) return list;

  const stepOriginOf = (s) => safeOriginOf(s?.origin) || safeOriginOf(s?.url) || '';
  const extOrigin = stepOriginOf(extractStep);
  if (!extOrigin) return [...list, extractStep];

  const startOrigin = safeOriginOf(startUrl);
  let seenExtOrigin = Boolean(startOrigin && startOrigin === extOrigin);
  let depIdx = -1;

  for (let i = 0; i < list.length; i++) {
    const o = stepOriginOf(list[i]);
    if (!o) continue;
    if (o === extOrigin) {
      seenExtOrigin = true;
    } else if (seenExtOrigin) {
      depIdx = i;
      break;
    }
  }

  if (depIdx < 0) {
    return [...list, extractStep];
  }

  let insertIdx = depIdx;
  if (
    depIdx > 0 &&
    list[depIdx - 1]?.action === 'click' &&
    String(list[depIdx - 1]?.target?.tag || '').toLowerCase() === 'a'
  ) {
    insertIdx = depIdx - 1;
  }

  list.splice(insertIdx, 0, extractStep);
  return list;
}

/**
 * 单步元素重绑（FR-17）：仅替换失败步骤的 target 并自增版本号，无需整条重录。
 */
export function applyRebindToSkill(rawSkill, { stepIndex = null, stepId = null, newTarget } = {}) {
  if (!rawSkill || typeof rawSkill !== 'object') {
    return { ok: false, errorCode: 'ACTION_FAILED', errors: ['无效技能对象'] };
  }
  if (!newTarget || typeof newTarget !== 'object' || Object.keys(newTarget).length === 0) {
    return { ok: false, errorCode: 'ACTION_FAILED', errors: ['缺少新定位目标描述符'] };
  }

  const next = structuredClone(rawSkill);
  const steps = Array.isArray(next.steps) ? next.steps : [];
  let idx = -1;
  if (stepId) {
    idx = steps.findIndex((s) => s.id === stepId);
  }
  if (idx < 0 && stepIndex !== null && stepIndex !== undefined) {
    const numIdx = Number(stepIndex);
    if (Number.isInteger(numIdx) && numIdx >= 0 && numIdx < steps.length) {
      idx = numIdx;
    }
  }
  if (idx < 0 || !steps[idx]) {
    return { ok: false, errorCode: 'ACTION_FAILED', errors: ['未定位到待重绑的失败步骤'] };
  }

  steps[idx].target = {
    ...redactObject(structuredClone(newTarget)),
    rebound: true
  };
  next.version = Number(next.version || 1) + 1;

  const normalized = normalizeSkillIR(next);
  const validation = validateSkillIR(normalized);
  return {
    ok: validation.ok,
    skill: normalized,
    stepIndex: idx,
    stepId: normalized.steps[idx]?.id || '',
    errors: validation.errors || []
  };
}
