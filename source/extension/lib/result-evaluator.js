"use strict";

/**
 * L0–L3 业务结果核验与证据分级模块：
 * 严格区分“动作完成 (ACTIONS_COMPLETED_UNVERIFIED)”与“业务核验成功 (VERIFIED_SUCCESS)”，
 * 绝不把 error 回执、空结果或未校验流程误报为 VERIFIED_SUCCESS。
 */

export const EVIDENCE_RANK = Object.freeze({
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3
});

function higherEvidence(a = 'L0', b = 'L0') {
  return (EVIDENCE_RANK[a] || 0) >= (EVIDENCE_RANK[b] || 0) ? a : b;
}

/**
 * 评估单条声明式后置条件（postcondition）。
 */
export function evaluatePostcondition(pc, ctx = {}) {
  const type = String(pc?.type || '');
  const id = String(pc?.id || type || 'pc');
  const level = pc?.evidenceLevel && pc.evidenceLevel in EVIDENCE_RANK ? pc.evidenceLevel : 'L2';
  const result = ctx.result || null;
  const records = Array.isArray(ctx.records) ? ctx.records : [];
  const args = ctx.args || {};

  if (type === 'elementStatus') {
    const expected = String(pc?.equals || 'ok').toLowerCase();
    const actual = String(result?.status || '').toLowerCase();
    const passed = Boolean(result?.found) && actual === expected;
    return {
      id,
      type,
      passed,
      evidenceLevel: passed ? level : 'L0',
      reason: passed
        ? `结果元素状态匹配 (${actual})`
        : `期望状态 "${expected}"，实际为 "${actual || (result?.found ? '空' : '元素未找到')}"`
    };
  }

  if (type === 'textContainsParam') {
    const expectedText = String(pc?.param ? args[pc.param] ?? '' : pc?.text ?? '').trim();
    const actualText = String(result?.text || '');
    const passed = Boolean(result?.found) && (!expectedText || actualText.includes(expectedText));
    return {
      id,
      type,
      passed,
      evidenceLevel: passed ? level : 'L0',
      reason: passed
        ? `结果文本包含参数 "${expectedText}"`
        : `结果文本未包含参数 "${expectedText}"`
    };
  }

  if (type === 'textNotContains') {
    const forbidden = String(pc?.text || '').trim();
    const actualText = String(result?.text || '');
    const passed = Boolean(result?.found) && (!forbidden || !actualText.includes(forbidden));
    return {
      id,
      type,
      passed,
      evidenceLevel: passed ? level : 'L0',
      reason: passed
        ? `结果文本不含失败关键词 "${forbidden}"`
        : `结果文本命中异常关键词 "${forbidden}"`
    };
  }

  if (type === 'rowCount') {
    const min = Number(pc?.min ?? 1);
    const max = pc?.max !== undefined ? Number(pc.max) : Infinity;
    const count = records.length;
    const passed = count >= min && count <= max;
    return {
      id,
      type,
      passed,
      evidenceLevel: passed ? level : 'L0',
      reason: passed
        ? `采集明细行数 ${count} 满足区间 [${min}, ${Number.isFinite(max) ? max : '∞'}]`
        : `采集明细行数 ${count} 不满足要求 [${min}, ${Number.isFinite(max) ? max : '∞'}]`
    };
  }

  if (type === 'recordIdObserved') {
    const hasReceiptNo = records.some((r) => r?.receiptNo && r.receiptNo !== '-');
    const regexHit = pc?.pattern
      ? new RegExp(pc.pattern).test(String(result?.text || ''))
      : /[A-Z]{2}-\d{4,}-\d+/.test(String(result?.text || ''));
    const passed = hasReceiptNo || regexHit;
    return {
      id,
      type,
      passed,
      evidenceLevel: passed ? level : 'L0',
      reason: passed ? '观测到业务回执单号' : '未观测到有效回执单号'
    };
  }

  return {
    id,
    type,
    passed: false,
    evidenceLevel: 'L0',
    reason: `不支持的后置条件类型: ${type}`
  };
}

/**
 * 综合评估单次运行或单条业务执行结果：
 * 返回 { status, verified, evidenceLevel, errorCode?, checks, reason }。
 */
export function evaluateRunOutcome({
  skill,
  writeMode = 'commit',
  actionCompleted = true,
  result = null,
  records = [],
  extractedEvidenceLevel = 'L0',
  args = {}
} = {}) {
  if (!actionCompleted) {
    return {
      status: 'FAILED',
      verified: false,
      evidenceLevel: 'L0',
      errorCode: 'ACTION_FAILED',
      checks: [],
      reason: '操作步骤未能全部执行完成'
    };
  }

  if (writeMode === 'prefill_only') {
    return {
      status: 'ACTIONS_COMPLETED_UNVERIFIED',
      verified: false,
      evidenceLevel: 'L1',
      checks: [],
      reason: '预填不提交模式：已填充表单并停留在提交前，尚未提交业务数据'
    };
  }

  const checks = [];
  const ctx = { result, records, args };

  // 1. 显式 postconditions[] 检查
  for (const pc of Array.isArray(skill?.postconditions) ? skill.postconditions : []) {
    checks.push(evaluatePostcondition(pc, ctx));
  }

  // 2. resultSelector 隐式校验（必须元素存在且 data-status 不为 error）
  if (skill?.resultSelector) {
    const okStatus =
      Boolean(result?.found) && String(result?.status || '').toLowerCase() !== 'error';
    checks.push({
      id: 'resultSelector',
      type: 'elementStatus',
      passed: okStatus,
      evidenceLevel: okStatus ? 'L2' : 'L0',
      reason: okStatus
        ? `结果校验通过 (${result?.status || 'found'})`
        : `结果校验失败：${!result?.found ? '未找到结果元素' : `页面返回状态 error (${result?.text || ''})`}`
    });
  }

  // 3. 结构化采集 extractSpec 校验
  if (skill?.extractSpec?.mode === 'receipt') {
    const rec = records[0];
    if (!rec || rec.status === 'unknown') {
      checks.push({
        id: 'extractSpec.receipt',
        type: 'receiptStatus',
        passed: false,
        evidenceLevel: 'L0',
        errorCode: 'WRITE_OUTCOME_UNKNOWN',
        reason: 'WRITE_OUTCOME_UNKNOWN: 未采集到确定性回执状态，禁止自动重试或标为成功'
      });
    } else if (rec.status === 'failed') {
      checks.push({
        id: 'extractSpec.receipt',
        type: 'receiptStatus',
        passed: false,
        evidenceLevel: 'L2',
        errorCode: 'BATCH_ROW_FAILED',
        reason: `业务校验失败：${rec.error || '页面返回 error 回执'}`
      });
    } else {
      checks.push({
        id: 'extractSpec.receipt',
        type: 'receiptStatus',
        passed: true,
        evidenceLevel: extractedEvidenceLevel === 'L2' ? 'L2' : 'L1',
        reason: `回执确认成功（单号：${rec.receiptNo || '-'}）`
      });
    }
  } else if (skill?.extractSpec?.mode === 'table') {
    const hasRows = Array.isArray(records) && records.length > 0;
    checks.push({
      id: 'extractSpec.table',
      type: 'rowCount',
      passed: hasRows,
      evidenceLevel: hasRows ? 'L2' : 'L0',
      reason: hasRows ? `已采集 ${records.length} 条结果表记录` : '结果表格为空（0 条记录）'
    });
  }

  // 未配置任何结果校验或采集规则时，严禁标为 VERIFIED_SUCCESS
  if (checks.length === 0) {
    return {
      status: 'ACTIONS_COMPLETED_UNVERIFIED',
      verified: false,
      evidenceLevel: 'L0',
      checks: [],
      reason: '未配置业务结果校验或采集规则，仅证明动作执行完成'
    };
  }

  const failedCheck = checks.find((c) => !c.passed);
  if (failedCheck) {
    return {
      status: 'FAILED',
      verified: false,
      evidenceLevel: 'L0',
      errorCode: failedCheck.errorCode || 'OUTCOME_UNVERIFIED',
      checks,
      reason: failedCheck.reason
    };
  }

  const maxLevel = checks.reduce(
    (acc, c) => higherEvidence(acc, c.evidenceLevel),
    extractedEvidenceLevel || 'L0'
  );
  return {
    status: 'VERIFIED_SUCCESS',
    verified: true,
    evidenceLevel: maxLevel,
    checks,
    reason: `全部 ${checks.length} 项业务核验通过 (${maxLevel})`
  };
}
