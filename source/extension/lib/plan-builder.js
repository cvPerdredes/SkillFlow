"use strict";

import { safeOriginOf, sanitizeUrl } from './sanitizer.js';
import { validateTypedParamValue } from './schemas.js';

/**
 * 不可变执行计划构造与 planHash (SHA-256) 计算模块（Chrome 116+ & Node ESM 通用）。
 */

const RISK_CLICK_RE =
  /提交|保存|删除|覆盖|审批|发布|付款|确认录入|确认提交|submit|save|delete|approve|publish|pay/i;

/**
 * 键字典序确定的规范化 JSON 序列化。
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (type === 'boolean' || type === 'string') {
    return JSON.stringify(value);
  }
  if (type === 'undefined' || type === 'function' || type === 'symbol') {
    return 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined && typeof value[k] !== 'function' && typeof value[k] !== 'symbol')
    .sort();
  return (
    '{' +
    keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',') +
    '}'
  );
}

/**
 * 使用 Web Crypto API 计算 UTF-8 文本的 SHA-256 小写十六进制摘要。
 */
export async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('当前运行环境缺少 crypto.subtle，无法计算不可变 planHash');
  }
  const bytes = new TextEncoder().encode(String(text ?? ''));
  const digest = await subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * 判断步骤是否需要高危确认或人工介入。
 */
export function isRiskStep(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.risk === 'write_commit' || step.risk === 'write' || step.risk === 'auth') {
    return true;
  }
  if (step.action === 'manual' || step.action === 'auth_checkpoint') return true;
  if (step.action !== 'click') return false;
  const label = [step.target?.label, step.target?.text, step.target?.ariaLabel].join(' ');
  return RISK_CLICK_RE.test(label);
}

/**
 * 推导整条执行计划的最高风险等级。
 */
export function deriveRiskLevel(steps = []) {
  let hasWrite = false;
  for (const step of steps) {
    if (!step) continue;
    if (step.risk === 'write_commit') return 'write_commit';
    if (step.action === 'click') {
      const label = [step.target?.label, step.target?.text, step.target?.ariaLabel].join(' ');
      if (RISK_CLICK_RE.test(label)) return 'write_commit';
    }
    if (step.risk === 'write') hasWrite = true;
  }
  return hasWrite ? 'write' : 'read';
}

/**
 * 将运行参数展开到技能步骤副本（兼容 v0.1 paramKey 与 v0.3 valueRef.param）。
 */
export function applySkillParams(skill, args = {}) {
  const steps = Array.isArray(skill?.steps) ? skill.steps : [];
  return steps.map((s) => {
    const step = structuredClone(s);
    if (step.sensitive || step.action === 'auth_checkpoint' || step.action === 'manual') {
      delete step.value;
      return step;
    }
    const key = step.paramKey || step.valueRef?.param;
    if (key && Object.prototype.hasOwnProperty.call(args, key)) {
      step.value = args[key];
    }
    return step;
  });
}

/**
 * 统一归一化并校验运行参数（保证 preview 与 execute 数值/日期类型一致，消除数字参数 PLAN_NOT_APPROVED 死锁）。
 */
export function normalizeAndValidateRuntimeArgs(skill, rawArgs = {}) {
  const normalized = {};
  const input = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  for (const p of skill?.parameters || []) {
    if (p?.type === 'dataset') continue;
    const checked = validateTypedParamValue(p, input[p.key]);
    if (!checked.ok) {
      return {
        ok: false,
        key: p.key,
        errorCode: checked.errorCode || 'PARAMETER_INVALID',
        message: checked.message
      };
    }
    normalized[p.key] = checked.value;
  }
  return { ok: true, args: normalized };
}

/**
 * 归一化技能涉及的目标站点白名单（排序去重）。
 */
export function normalizeTargetOrigins(skill, overrideOrigins = null) {
  const raw = [];
  if (Array.isArray(overrideOrigins)) raw.push(...overrideOrigins);
  if (Array.isArray(skill?.allowedOrigins)) raw.push(...skill.allowedOrigins);
  if (skill?.startUrl) raw.push(skill.startUrl);
  if (Array.isArray(skill?.steps)) {
    for (const s of skill.steps) {
      if (s?.origin) raw.push(s.origin);
      if (s?.url) raw.push(s.url);
    }
  }
  const unique = new Set();
  for (const item of raw) {
    const origin = safeOriginOf(item);
    if (origin) unique.add(origin);
  }
  return Array.from(unique).sort();
}

function normalizeStepForHash(step) {
  if (!step || typeof step !== 'object') return {};
  const isSensitive = Boolean(step.sensitive || step.action === 'auth_checkpoint' || step.action === 'manual');
  return {
    id: String(step.id || ''),
    action: String(step.action || ''),
    origin: String(step.origin || safeOriginOf(step.url) || ''),
    url: step.url ? sanitizeUrl(step.url) : '',
    target: step.target || {},
    ...(isSensitive || step.value === undefined ? {} : { value: String(step.value) }),
    ...(typeof step.checked === 'boolean' ? { checked: step.checked } : {}),
    ...(step.risk ? { risk: step.risk } : {}),
    ...(step.authSelector ? { authSelector: step.authSelector } : {}),
    ...(step.loggedInIndicator ? { loggedInIndicator: step.loggedInIndicator } : {}),
    ...(step.outputVar ? { outputVar: step.outputVar } : {}),
    ...(step.paramKey ? { paramKey: step.paramKey } : {}),
    ...(step.valueRef ? { valueRef: step.valueRef } : {})
  };
}

/**
 * 供 background.js 与 panel.js 独立计算不可变 planHash。
 */
export async function computePlanHashFromPayload({
  skillId,
  skillVersion = 1,
  targetOrigins = [],
  writeMode = 'commit',
  args = {},
  batchRows = null,
  steps = [],
  riskLevel = null
}) {
  const sortedOrigins = Array.from(
    new Set((Array.isArray(targetOrigins) ? targetOrigins : []).map(safeOriginOf).filter(Boolean))
  ).sort();

  const normalizedArgs = args && typeof args === 'object' ? args : {};
  const normalizedBatch = Array.isArray(batchRows) ? batchRows : null;
  const batchRowCount = normalizedBatch ? normalizedBatch.length : 0;

  const argsDigest = await sha256Hex(
    canonicalJson({ args: normalizedArgs, batchRows: normalizedBatch })
  );

  const normalizedSteps = (Array.isArray(steps) ? steps : []).map(normalizeStepForHash);
  const stepsDigest = await sha256Hex(canonicalJson(normalizedSteps));

  const resolvedRisk = riskLevel || deriveRiskLevel(steps);

  const planHash = await sha256Hex(
    canonicalJson({
      skillId: String(skillId || ''),
      skillVersion: Number(skillVersion || 1),
      targetOrigins: sortedOrigins,
      writeMode: String(writeMode || 'commit'),
      argsDigest,
      batchRowCount,
      stepsDigest,
      riskLevel: resolvedRisk
    })
  );

  return {
    planHash,
    argsDigest,
    stepsDigest,
    targetOrigins: sortedOrigins,
    riskLevel: resolvedRisk,
    batchRowCount
  };
}

/**
 * 生成供审批确认与执行使用的不可变 PlanSnapshot。
 */
export async function buildPlanSnapshot({
  skill,
  args = {},
  targetOrigins = null,
  writeMode = 'commit',
  batchRows = null
}) {
  if (!skill || !skill.id) {
    throw new Error('无法构建执行计划：缺少有效技能对象');
  }
  const expandedSteps = applySkillParams(skill, args);
  const origins = normalizeTargetOrigins(skill, targetOrigins);
  const digest = await computePlanHashFromPayload({
    skillId: skill.id,
    skillVersion: skill.version || 1,
    targetOrigins: origins,
    writeMode,
    args,
    batchRows,
    steps: expandedSteps
  });

  return {
    planId: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `plan-${Date.now()}`,
    planHash: digest.planHash,
    skillId: skill.id,
    skillVersion: Number(skill.version || 1),
    skillName: String(skill.name || ''),
    targetOrigins: digest.targetOrigins,
    writeMode: String(writeMode || 'commit'),
    riskLevel: digest.riskLevel,
    argsDigest: digest.argsDigest,
    batchRowCount: digest.batchRowCount,
    stepsDigest: digest.stepsDigest,
    args: structuredClone(args || {}),
    batchRows: Array.isArray(batchRows) ? structuredClone(batchRows) : null,
    steps: expandedSteps,
    createdAt: new Date().toISOString()
  };
}
