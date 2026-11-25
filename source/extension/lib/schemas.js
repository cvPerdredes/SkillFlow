"use strict";

import { safeOriginOf, sanitizeUrl } from './sanitizer.js';

/**
 * SkillFlow v0.3 结构冻结与校验契约（Skill IR v0.3 / PlanSnapshot / RunRecord / 4+1 AI 提案）。
 */

export const SKILL_SCHEMA_VERSION = '0.3';

export const PARAM_TYPES = Object.freeze([
  'string',
  'month',
  'date',
  'number',
  'enum',
  'dataset'
]);

export const STEP_ACTIONS = Object.freeze([
  'navigate',
  'fill',
  'select',
  'check',
  'keypress',
  'click',
  'extract',
  'auth_checkpoint',
  'manual'
]);

export const AUTH_POLICIES = Object.freeze(['manual_takeover', 'ephemeral_prompt']);

export const WRITE_MODES = Object.freeze(['commit', 'prefill_only', 'pilot_then_batch']);

export const ALLOWED_QUERY_OPS = Object.freeze([
  'count',
  'groupCount',
  'ratio',
  'sum',
  'avg',
  'filterTopErrors',
  'listFailedRows'
]);

export const RUN_STATUSES = Object.freeze([
  'IDLE',
  'RUNNING',
  'PAUSED_AUTH_REQUIRED',
  'PAUSED_CONFIRM_REQUIRED',
  'PAUSED_PILOT_REVIEW',
  'VERIFIED_SUCCESS',
  'ACTIONS_COMPLETED_UNVERIFIED',
  'FAILED',
  'CANCELLED'
]);

const PARAM_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function isValidCalendarDate(ymd) {
  if (!DATE_RE.test(ymd)) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * 校验单个参数值是否符合其 ParameterSchema 类型约束。
 */
export function validateTypedParamValue(param, rawVal) {
  const type = param?.type || 'string';
  if (type === 'dataset') {
    if (Array.isArray(rawVal)) return { ok: true, value: rawVal };
    return { ok: false, errorCode: 'PARAMETER_INVALID', message: `参数 ${param.key} 必须是数组数据集` };
  }
  const strVal = rawVal === undefined || rawVal === null ? '' : String(rawVal).trim();
  if (!strVal) {
    if (param?.required) {
      return { ok: false, errorCode: 'MISSING_PARAMETER', message: `缺少必填参数：${param.label || param.key}` };
    }
    return { ok: true, value: '' };
  }
  if (type === 'month') {
    if (!MONTH_RE.test(strVal)) {
      return { ok: false, errorCode: 'PARAMETER_INVALID', message: `参数 ${param.label || param.key} 需为 YYYY-MM 格式` };
    }
    return { ok: true, value: strVal };
  }
  if (type === 'date') {
    if (!isValidCalendarDate(strVal)) {
      return { ok: false, errorCode: 'PARAMETER_INVALID', message: `参数 ${param.label || param.key} 需为有效 YYYY-MM-DD 日期` };
    }
    return { ok: true, value: strVal };
  }
  if (type === 'number') {
    const num = Number(strVal);
    if (!Number.isFinite(num)) {
      return { ok: false, errorCode: 'PARAMETER_INVALID', message: `参数 ${param.label || param.key} 需为有效数字` };
    }
    return { ok: true, value: num };
  }
  if (type === 'enum' && Array.isArray(param?.options) && param.options.length > 0) {
    if (!param.options.includes(strVal)) {
      return {
        ok: false,
        errorCode: 'PARAMETER_INVALID',
        message: `参数 ${param.label || param.key} 仅允许：${param.options.join(' / ')}`
      };
    }
  }
  return { ok: true, value: strVal };
}

function collectOrigins(rawSkill, steps) {
  const set = new Set();
  const add = (u) => {
    const origin = safeOriginOf(u);
    if (origin) set.add(origin);
  };
  if (Array.isArray(rawSkill?.allowedOrigins)) rawSkill.allowedOrigins.forEach(add);
  add(rawSkill?.startUrl);
  for (const s of steps || []) {
    add(s?.origin);
    add(s?.url);
  }
  return Array.from(set).sort();
}

function inferStepRisk(step) {
  if (step.risk && ['read', 'write', 'write_commit', 'auth'].includes(step.risk)) {
    return step.risk;
  }
  if (step.action === 'auth_checkpoint' || step.action === 'manual') return 'auth';
  if (step.action === 'click') {
    const label = [step.target?.label, step.target?.text, step.target?.ariaLabel].join(' ');
    if (/提交|保存|删除|覆盖|审批|发布|付款|确认录入|确认提交|submit|save|delete|approve|publish|pay/i.test(label)) {
      return 'write_commit';
    }
  }
  return 'read';
}

/**
 * 将录制会话或草稿规范化为标准 Skill IR v0.3。
 */
export function normalizeSkillIR(rawSkill) {
  const src = rawSkill && typeof rawSkill === 'object' ? rawSkill : {};
  const rawSteps = Array.isArray(src.steps) ? src.steps : [];

  const steps = rawSteps.map((s, idx) => {
    const step = structuredClone(s || {});
    step.id = String(step.id || `s${idx + 1}`);
    step.action = String(step.action || 'click');
    step.origin = safeOriginOf(step.origin || step.url || src.startUrl) || '';
    if (step.url) step.url = sanitizeUrl(step.url);

    const isSensitive =
      step.action === 'auth_checkpoint' || step.action === 'manual' || Boolean(step.sensitive);
    if (isSensitive) {
      delete step.value;
      step.sensitive = true;
    }
    if (step.action === 'auth_checkpoint') {
      step.authSelector = String(step.authSelector || '#login-form').slice(0, 120);
      step.loggedInIndicator = Object.prototype.hasOwnProperty.call(step, 'loggedInIndicator')
        ? String(step.loggedInIndicator ?? '').slice(0, 120)
        : '';
    }
    if (!step.valueRef && step.paramKey && !isSensitive) {
      step.valueRef = { param: step.paramKey };
    }
    if (!step.paramKey && step.valueRef?.param && !isSensitive) {
      step.paramKey = step.valueRef.param;
    }
    step.risk = inferStepRisk(step);
    return step;
  });

  const parameters = (Array.isArray(src.parameters) ? src.parameters : []).map((p) => {
    const type = PARAM_TYPES.includes(p?.type) ? p.type : 'string';
    const defVal = p?.defaultValue !== undefined ? p.defaultValue : p?.default ?? '';
    const out = {
      key: String(p?.key || '').trim(),
      label: String(p?.label || p?.key || '').trim(),
      type,
      required: p?.required !== undefined ? Boolean(p.required) : type !== 'dataset',
      defaultValue: defVal,
      default: defVal,
      sensitive: false
    };
    if (p?.sourceStepId) out.sourceStepId = String(p.sourceStepId);
    if (Array.isArray(p?.options)) out.options = p.options.map((o) => String(o));
    if (Array.isArray(p?.columns)) out.columns = structuredClone(p.columns);
    return out;
  });

  const authPolicy = AUTH_POLICIES.includes(src.authPolicy) ? src.authPolicy : 'manual_takeover';
  const writeMode = WRITE_MODES.includes(src.riskPolicy?.writeMode)
    ? src.riskPolicy.writeMode
    : 'commit';

  const normalized = {
    schemaVersion: SKILL_SCHEMA_VERSION,
    id: String(src.id || (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `skill-${Date.now()}`)),
    version: Number(src.version || 1),
    name: String(src.name || '未命名技能').trim(),
    intent: String(src.intent || src.description || '').trim(),
    startUrl: sanitizeUrl(src.startUrl || steps.find((s) => s.url)?.url || ''),
    allowedOrigins: collectOrigins(src, steps),
    authPolicy,
    parameters,
    steps,
    resultSelector: String(src.resultSelector || '').trim(),
    postconditions: Array.isArray(src.postconditions) ? structuredClone(src.postconditions) : [],
    riskPolicy: {
      writeMode,
      allowPrefillOnly: src.riskPolicy?.allowPrefillOnly !== false,
      retryUnknownWrites: false
    },
    createdAt: String(src.createdAt || new Date().toISOString())
  };

  if (src.batchLoop && typeof src.batchLoop === 'object') {
    normalized.batchLoop = structuredClone(src.batchLoop);
  }
  if (src.extractSpec && typeof src.extractSpec === 'object') {
    normalized.extractSpec = structuredClone(src.extractSpec);
  }
  return normalized;
}

/**
 * 校验 Skill IR v0.3 是否符合冻结契约与安全底线。
 */
export function validateSkillIR(skill) {
  const errors = [];
  if (!skill || typeof skill !== 'object') {
    return { ok: false, errors: ['技能对象不能为空'] };
  }
  if (skill.schemaVersion !== SKILL_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须为 "${SKILL_SCHEMA_VERSION}"`);
  }
  if (!String(skill.id || '').trim()) errors.push('缺少技能 id');
  if (!String(skill.name || '').trim()) errors.push('缺少技能名称 name');

  if (!Array.isArray(skill.allowedOrigins) || skill.allowedOrigins.length === 0) {
    errors.push('allowedOrigins 至少需包含一个合法 http/https 站点');
  } else {
    for (const o of skill.allowedOrigins) {
      if (!safeOriginOf(o)) errors.push(`非法站点 origin: ${o}`);
    }
  }

  if (!AUTH_POLICIES.includes(skill.authPolicy)) {
    errors.push(`authPolicy 非法: ${skill.authPolicy}`);
  }

  const seenParamKeys = new Set();
  for (const p of skill.parameters || []) {
    if (!PARAM_KEY_RE.test(String(p?.key || ''))) {
      errors.push(`参数变量名非法: ${p?.key}`);
    } else if (seenParamKeys.has(p.key)) {
      errors.push(`参数变量名重复: ${p.key}`);
    } else {
      seenParamKeys.add(p.key);
    }
    if (!PARAM_TYPES.includes(p?.type)) {
      errors.push(`参数 ${p?.key} 类型非法: ${p?.type}`);
    }
  }

  if (!Array.isArray(skill.steps) || skill.steps.length === 0) {
    errors.push('steps 不能为空');
  } else {
    const seenStepIds = new Set();
    for (const s of skill.steps) {
      if (!String(s?.id || '').trim()) {
        errors.push('存在缺少 id 的步骤');
      } else if (seenStepIds.has(s.id)) {
        errors.push(`步骤 id 重复: ${s.id}`);
      } else {
        seenStepIds.add(s.id);
      }
      if (!STEP_ACTIONS.includes(s?.action)) {
        errors.push(`禁止的或未知的动作类型: ${s?.action}`);
      }
      if (
        (s?.action === 'auth_checkpoint' || s?.action === 'manual' || s?.sensitive) &&
        s?.value !== undefined
      ) {
        errors.push(`敏感/认证步骤 ${s.id} 不得包含 value 原值`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 校验 PlanSnapshot 结构完整度。
 */
export function validatePlanSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, errors: ['PlanSnapshot 不能为空'] };
  }
  if (!String(snapshot.planId || '').trim()) errors.push('缺少 planId');
  if (!/^[0-9a-f]{64}$/i.test(String(snapshot.planHash || ''))) {
    errors.push('planHash 必须是 64 位 SHA-256 十六进制字符串');
  }
  if (!String(snapshot.skillId || '').trim()) errors.push('缺少 skillId');
  if (!Array.isArray(snapshot.targetOrigins) || snapshot.targetOrigins.length === 0) {
    errors.push('targetOrigins 不能为空');
  }
  if (!WRITE_MODES.includes(snapshot.writeMode)) {
    errors.push(`writeMode 非法: ${snapshot.writeMode}`);
  }
  if (!Array.isArray(snapshot.steps)) errors.push('steps 必须是数组');
  return { ok: errors.length === 0, errors };
}

/**
 * 校验 RunRecord 结构完整度。
 */
export function validateRunRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') {
    return { ok: false, errors: ['RunRecord 不能为空'] };
  }
  if (!String(record.id || '').trim()) errors.push('缺少 RunRecord id');
  if (!String(record.skillId || '').trim()) errors.push('缺少 skillId');
  if (!RUN_STATUSES.includes(record.status)) {
    errors.push(`运行状态 status 非法: ${record.status}`);
  }
  if (!Array.isArray(record.logs)) errors.push('logs 必须是数组');
  return { ok: errors.length === 0, errors };
}

/**
 * 校验 matchSkill AI 提案。
 */
export function validateMatchSkillProposal(proposal, knownSkillIds = []) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { ok: false, errorCode: 'AI_SCHEMA_INVALID', errors: ['matchSkill 返回必须是 JSON 对象'] };
  }
  const knownSet = new Set(knownSkillIds);
  const matched = proposal.matchedSkillId ?? null;
  if (matched !== null && !knownSet.has(matched)) {
    errors.push(`matchedSkillId 引用了不存在的技能: ${matched}`);
  }
  if (!['high', 'medium', 'low'].includes(proposal.confidence)) {
    errors.push(`confidence 必须为 high/medium/low，实际为 ${proposal.confidence}`);
  }
  const candidates = Array.isArray(proposal.candidates) ? proposal.candidates : [];
  for (const c of candidates) {
    if (!c || typeof c !== 'object' || !knownSet.has(c.skillId)) {
      errors.push(`candidate 引用了不存在的技能: ${c?.skillId}`);
    }
  }
  if (errors.length) {
    return { ok: false, errorCode: 'AI_SCHEMA_INVALID', errors };
  }
  return {
    ok: true,
    value: {
      matchedSkillId: matched,
      candidates: candidates.map((c) => ({
        skillId: String(c.skillId),
        score: Number(c.score || 0),
        reason: String(c.reason || '')
      })),
      confidence: proposal.confidence
    }
  };
}

/**
 * 校验 analyzeTrace AI 提案：严禁模型越界虚构 stepId 或生成代码/新动作。
 */
export function validateAnalyzeTraceProposal(proposal, knownStepIds = []) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { ok: false, errorCode: 'AI_SCHEMA_INVALID', errors: ['analyzeTrace 返回必须是 JSON 对象'] };
  }

  for (const forbiddenKey of ['code', 'script', 'executeScript', 'newSteps', 'steps']) {
    if (forbiddenKey in proposal) {
      return {
        ok: false,
        errorCode: 'AI_SCHEMA_INVALID',
        errors: [`禁止模型提案包含可执行字段 ${forbiddenKey}`]
      };
    }
  }

  const knownSet = new Set(knownStepIds);
  const checkStepRef = (stepId, ctx) => {
    if (!knownSet.has(stepId)) {
      return `${ctx} 引用了不存在的 stepId: ${stepId}`;
    }
    return null;
  };

  if (!String(proposal.name || '').trim()) errors.push('缺少技能名称 name');
  if (!String(proposal.intent || '').trim()) errors.push('缺少技能意图 intent');

  const paramCandidates = Array.isArray(proposal.parameterCandidates)
    ? proposal.parameterCandidates
    : [];
  for (const p of paramCandidates) {
    if (!p || typeof p !== 'object') {
      errors.push('parameterCandidates 元素必须是对象');
      continue;
    }
    const refErr = checkStepRef(p.sourceStepId, 'parameterCandidates');
    if (refErr) {
      return { ok: false, errorCode: 'AI_STEP_REF_UNKNOWN', errors: [refErr] };
    }
    if (!PARAM_KEY_RE.test(String(p.key || ''))) {
      errors.push(`建议参数名非法: ${p.key}`);
    }
    if (p.type && !PARAM_TYPES.includes(p.type)) {
      errors.push(`建议参数类型非法: ${p.type}`);
    }
  }

  const annotations = Array.isArray(proposal.stepAnnotations) ? proposal.stepAnnotations : [];
  for (const ann of annotations) {
    const refErr = checkStepRef(ann?.stepId, 'stepAnnotations');
    if (refErr) {
      return { ok: false, errorCode: 'AI_STEP_REF_UNKNOWN', errors: [refErr] };
    }
  }

  if (proposal.batchLoopHint && typeof proposal.batchLoopHint === 'object') {
    for (const bucket of ['preSteps', 'rowSteps', 'postSteps']) {
      const arr = proposal.batchLoopHint[bucket];
      if (arr === undefined) continue;
      if (!Array.isArray(arr)) {
        errors.push(`batchLoopHint.${bucket} 必须是数组`);
        continue;
      }
      for (const sid of arr) {
        const refErr = checkStepRef(sid, `batchLoopHint.${bucket}`);
        if (refErr) {
          return { ok: false, errorCode: 'AI_STEP_REF_UNKNOWN', errors: [refErr] };
        }
      }
    }
  }

  if (errors.length) {
    return { ok: false, errorCode: 'AI_SCHEMA_INVALID', errors };
  }

  return {
    ok: true,
    value: {
      name: String(proposal.name).trim(),
      intent: String(proposal.intent).trim(),
      parameterCandidates: paramCandidates.map((p) => ({
        key: String(p.key).trim(),
        label: String(p.label || p.key).trim(),
        type: PARAM_TYPES.includes(p.type) ? p.type : 'string',
        required: p.required !== false,
        sourceStepId: String(p.sourceStepId),
        reason: String(p.reason || '')
      })),
      stepAnnotations: annotations.map((a) => ({
        stepId: String(a.stepId),
        summary: String(a.summary || ''),
        outputVar: a.outputVar ? String(a.outputVar) : undefined
      })),
      batchLoopHint: proposal.batchLoopHint || null,
      extractHint: proposal.extractHint || null,
      resultSelectorHint: proposal.resultSelectorHint
        ? String(proposal.resultSelectorHint).trim()
        : null,
      uncertainties: Array.isArray(proposal.uncertainties)
        ? proposal.uncertainties.map((u) => String(u))
        : []
    }
  };
}

/**
 * 校验 extractArgs AI 提案。
 */
export function validateExtractArgsProposal(proposal, parameters = []) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { ok: false, errorCode: 'AI_SCHEMA_INVALID', errors: ['extractArgs 返回必须是 JSON 对象'] };
  }
  const paramMap = new Map((parameters || []).map((p) => [p.key, p]));
  const rawProvided =
    proposal.providedArgs && typeof proposal.providedArgs === 'object' ? proposal.providedArgs : {};
  const providedArgs = {};
  const invalidArgs = [];

  for (const [k, v] of Object.entries(rawProvided)) {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
      continue;
    }
    if (!paramMap.has(k)) {
      continue;
    }
    const checked = validateTypedParamValue(paramMap.get(k), v);
    if (!checked.ok) {
      invalidArgs.push({ key: k, errorCode: checked.errorCode, message: checked.message });
    } else if (checked.value !== '') {
      providedArgs[k] = checked.value;
    }
  }

  const missingRequired = Array.isArray(proposal.missingRequired)
    ? proposal.missingRequired.filter((k) => paramMap.has(k))
    : [];

  if (errors.length) {
    return { ok: false, errorCode: 'AI_SCHEMA_INVALID', errors };
  }

  return {
    ok: true,
    value: {
      providedArgs,
      invalidArgs,
      missingRequired,
      nextQuestion: proposal.nextQuestion ? String(proposal.nextQuestion) : null,
      ambiguities: Array.isArray(proposal.ambiguities)
        ? proposal.ambiguities.map((a) => String(a))
        : []
    }
  };
}

/**
 * 校验 planQuery AI 提案。
 */
export function validatePlanQueryProposal(proposal, recordSchemaKeys = []) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { ok: false, errorCode: 'AI_SCHEMA_INVALID', errors: ['planQuery 返回必须是 JSON 对象'] };
  }
  const op = proposal.op ?? null;
  if (op !== null && !ALLOWED_QUERY_OPS.includes(op)) {
    errors.push(`不允许的统计操作符 op: ${op}`);
  }
  if (op === null && !String(proposal.cannotComputeReason || '').trim()) {
    errors.push('op 为空时必须给出 cannotComputeReason');
  }
  const schemaSet = new Set(recordSchemaKeys);
  if (proposal.groupBy && schemaSet.size > 0 && !schemaSet.has(proposal.groupBy)) {
    errors.push(`groupBy 引用了不存在的字段: ${proposal.groupBy}`);
  }
  if (proposal.metricField && schemaSet.size > 0 && !schemaSet.has(proposal.metricField)) {
    errors.push(`metricField 引用了不存在的字段: ${proposal.metricField}`);
  }
  if (errors.length) {
    return { ok: false, errorCode: 'AI_SCHEMA_INVALID', errors };
  }
  return {
    ok: true,
    value: {
      op,
      groupBy: proposal.groupBy ? String(proposal.groupBy) : null,
      metricField: proposal.metricField ? String(proposal.metricField) : null,
      filterStatus: proposal.filterStatus ? String(proposal.filterStatus) : null,
      limit: proposal.limit ? Number(proposal.limit) : null,
      cannotComputeReason: proposal.cannotComputeReason ? String(proposal.cannotComputeReason) : null
    }
  };
}

/**
 * 校验 explainRun AI 提案。
 */
export function validateExplainRunProposal(proposal) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { ok: false, errorCode: 'AI_SCHEMA_INVALID', errors: ['explainRun 返回必须是 JSON 对象'] };
  }
  if (!String(proposal.answer || '').trim()) {
    errors.push('answer 不能为空');
  }
  if (!Array.isArray(proposal.evidenceRefs)) {
    errors.push('evidenceRefs 必须是数组');
  }
  if (errors.length) {
    return { ok: false, errorCode: 'AI_SCHEMA_INVALID', errors };
  }
  return {
    ok: true,
    value: {
      answer: String(proposal.answer).trim(),
      evidenceRefs: proposal.evidenceRefs.map((r) => String(r)),
      caveats: Array.isArray(proposal.caveats) ? proposal.caveats.map((c) => String(c)) : []
    }
  };
}
