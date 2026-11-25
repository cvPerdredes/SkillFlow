"use strict";

import { isRiskStep } from './plan-builder.js';
import { isSamePageIgnoringQueryAndHash, redactObject, safeOriginOf, sanitizeUrl } from './sanitizer.js';
import { validateTypedParamValue } from './schemas.js';

/**
 * 1→N CSV 批量执行引擎：
 * - 支持 UTF-8 BOM 与引号转义 CSV 解析、表头列映射、脏数据前置拦截（CSV_SCHEMA_INVALID）；
 * - 严格切分 preSteps / rowSteps / postSteps 与行间复位；批量循环体内 0 次模型调用；
 * - 支持 pilotCount（默认 2 条）试跑门禁、逐条持久化账本与 WRITE_OUTCOME_UNKNOWN 严禁自动重试。
 */

const COLUMN_ALIASES = {
  orgName: ['供电单位', '单位', '部门', 'org', 'orgname', 'unit'],
  batchCode: ['关联客户批号', '客户批号', '批号', 'batch', 'batchcode'],
  meterNo: ['表计编号', '表号', '电表编号', 'meter', 'meterno'],
  kwh: ['申报电量', '电量', '电量(kwh)', 'kwh'],
  voltage: ['电压等级', '电压', 'voltage'],
  remark: ['备注', '说明', 'remark', 'note']
};

/**
 * 解析标准 RFC-4180 CSV 文本（自动剥离 UTF-8 BOM，支持引号包裹与 "" 转义）。
 */
export function parseCsv(csvText) {
  const cleaned = String(csvText ?? '').replace(/^\uFEFF/, '');
  const records = [];
  let currentRow = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if (ch === '\r') {
      if (cleaned[i + 1] === '\n') i++;
      currentRow.push(currentCell.trim());
      if (currentRow.some((c) => c !== '')) records.push(currentRow);
      currentRow = [];
      currentCell = '';
    } else if (ch === '\n') {
      currentRow.push(currentCell.trim());
      if (currentRow.some((c) => c !== '')) records.push(currentRow);
      currentRow = [];
      currentCell = '';
    } else {
      currentCell += ch;
    }
  }

  if (currentCell !== '' || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((c) => c !== '')) records.push(currentRow);
  }

  if (records.length === 0) {
    return { headers: [], rows: [], rawRows: [] };
  }

  const headers = records[0];
  const rawRows = records.slice(1);
  const rows = rawRows.map((cells) => {
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = cells[c] ?? '';
    }
    return obj;
  });

  return { headers, rows, rawRows };
}

/**
 * 根据 CSV 表头自动匹配 dataset 列定义。
 */
export function autoMapCsvColumns(csvHeaders = [], columnSchemas = []) {
  const mapping = {};
  const unmappedRequired = [];
  const norm = (s) => String(s || '').trim().toLowerCase();

  for (const col of columnSchemas || []) {
    const aliases = [col.key, col.label, ...(COLUMN_ALIASES[col.key] || [])].map(norm).filter(Boolean);
    let hit = csvHeaders.find((h) => norm(h) === norm(col.label) || norm(h) === norm(col.key));
    if (!hit) {
      hit = csvHeaders.find((h) => aliases.includes(norm(h)));
    }
    if (!hit) {
      hit = csvHeaders.find((h) => aliases.some((a) => norm(h).includes(a) || a.includes(norm(h))));
    }
    if (hit) {
      mapping[col.key] = hit;
    } else if (col.required !== false) {
      unmappedRequired.push(col.key);
    }
  }

  return { mapping, unmappedRequired };
}

/**
 * 按列映射校验全部 CSV 行并绑定为标准 batchRows[]；存在缺列或类型脏数据时前置拦截。
 */
export function validateAndBindBatchRows(parsedCsv, columnSchemas = [], mapping = {}) {
  const headers = parsedCsv?.headers || [];
  const rawRows = parsedCsv?.rawRows || [];
  const errors = [];
  const dirtyRows = [];

  if (!headers.length || !rawRows.length) {
    return {
      ok: false,
      errorCode: 'CSV_SCHEMA_INVALID',
      errors: ['CSV 文件为空或缺少数据行'],
      dirtyRows: []
    };
  }

  const headerIndex = new Map(headers.map((h, i) => [h, i]));
  for (const col of columnSchemas || []) {
    const mappedHeader = mapping?.[col.key];
    if (!mappedHeader || !headerIndex.has(mappedHeader)) {
      if (col.required !== false) {
        errors.push(`缺少必填列映射：${col.label || col.key}`);
      }
    }
  }
  if (errors.length > 0) {
    return { ok: false, errorCode: 'CSV_SCHEMA_INVALID', errors, dirtyRows };
  }

  const boundRows = [];
  for (let r = 0; r < rawRows.length; r++) {
    const cells = rawRows[r];
    const rowObj = {};
    const rowErrs = [];

    for (const col of columnSchemas || []) {
      const mappedHeader = mapping?.[col.key];
      if (!mappedHeader || !headerIndex.has(mappedHeader)) continue;
      const rawVal = cells[headerIndex.get(mappedHeader)] ?? '';
      const checked = validateTypedParamValue(
        {
          key: col.key,
          label: col.label || col.key,
          type: col.type || 'string',
          required: col.required !== false,
          options: col.options
        },
        rawVal
      );
      if (!checked.ok) {
        rowErrs.push(`${col.label || col.key}: ${checked.message}`);
      } else {
        rowObj[col.key] = checked.value;
      }
    }

    if (rowErrs.length > 0) {
      dirtyRows.push({ rowIndex: r + 1, errors: rowErrs });
    } else {
      boundRows.push(redactObject(rowObj));
    }
  }

  if (dirtyRows.length > 0) {
    return {
      ok: false,
      errorCode: 'CSV_SCHEMA_INVALID',
      errors: dirtyRows.map((d) => `第 ${d.rowIndex} 行脏数据：${d.errors.join('；')}`),
      dirtyRows
    };
  }

  return { ok: true, rows: boundRows, rowCount: boundRows.length };
}

function toVerifyPayload(snapshot) {
  return {
    skillId: snapshot.skillId,
    skillVersion: snapshot.skillVersion,
    targetOrigins: snapshot.targetOrigins,
    writeMode: snapshot.writeMode,
    args: snapshot.args,
    batchRows: snapshot.batchRows,
    steps: snapshot.steps,
    riskLevel: snapshot.riskLevel
  };
}

function resolveBatchPartitions(skill, steps) {
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const loop = skill?.batchLoop;
  if (loop && (Array.isArray(loop.preSteps) || Array.isArray(loop.rowSteps) || Array.isArray(loop.postSteps))) {
    const pick = (ids) => (Array.isArray(ids) ? ids.map((id) => stepMap.get(id)).filter(Boolean) : []);
    return {
      preSteps: pick(loop.preSteps),
      rowSteps: pick(loop.rowSteps),
      postSteps: pick(loop.postSteps),
      pilotCount: Number(loop.pilotCount ?? 2),
      rowResetRule: loop.rowResetRule || null
    };
  }
  return {
    preSteps: [],
    rowSteps: [...steps],
    postSteps: [],
    pilotCount: 2,
    rowResetRule: null
  };
}

/**
 * 批量技能切分辅助函数（支持跨双系统录制自动划分 preSteps / rowSteps 与目标行复位 URL）：
 * - 当 skill.allowedOrigins.length > 1 时，将最后一次跨 Origin navigate 及其之前步骤划入 preSteps
 *   （保留系统 A 标量参数与 extract outputVar），仅将目标填报站点步骤划入 rowSteps；
 * - 单站点录制时，auth_checkpoint 划入 preSteps，其余步骤划入 rowSteps。
 */
export function applyBatchLoopPartition({ skill, collectedParams = [], pilotCount = 2 }) {
  const nextSkill = structuredClone(skill || {});
  const steps = Array.isArray(nextSkill.steps) ? nextSkill.steps : [];
  const paramsList = Array.isArray(collectedParams) ? structuredClone(collectedParams) : [];
  const paramByStepId = new Map(
    paramsList.filter((p) => p?.sourceStepId).map((p) => [p.sourceStepId, p])
  );

  const origins = Array.isArray(nextSkill.allowedOrigins) ? nextSkill.allowedOrigins : [];
  const isCrossOrigin = origins.length > 1;

  let splitIdx = -1;
  let targetFormUrl = '';

  if (isCrossOrigin && steps.length > 0) {
    let curOrigin =
      safeOriginOf(nextSkill.startUrl) ||
      safeOriginOf(steps[0]?.origin || steps[0]?.url) ||
      '';
    let firstDiffOriginIdx = -1;
    let firstDiffUrl = '';

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const stepOrigin = safeOriginOf(s.origin || s.url);
      if (firstDiffOriginIdx < 0 && stepOrigin && curOrigin && stepOrigin !== curOrigin) {
        firstDiffOriginIdx = i;
        firstDiffUrl = s.url || stepOrigin;
      }
      if (s.action === 'navigate') {
        const navOrigin = safeOriginOf(s.url || s.origin);
        if (navOrigin && curOrigin && navOrigin !== curOrigin) {
          splitIdx = i;
          targetFormUrl = sanitizeUrl(s.url || '') || navOrigin;
        }
        if (navOrigin) curOrigin = navOrigin;
      } else if (stepOrigin && !curOrigin) {
        curOrigin = stepOrigin;
      }
    }

    if (splitIdx < 0 && firstDiffOriginIdx >= 0) {
      splitIdx = Math.max(-1, firstDiffOriginIdx - 1);
      targetFormUrl = sanitizeUrl(firstDiffUrl) || '';
    }
  }

  const preStepIds = [];
  const rowStepIds = [];
  const preParamIds = new Set();
  const rowParams = [];

  if (isCrossOrigin && splitIdx >= 0) {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (i <= splitIdx) {
        preStepIds.push(s.id);
        if (paramByStepId.has(s.id)) preParamIds.add(s.id);
      } else {
        rowStepIds.push(s.id);
        const mapped = paramByStepId.get(s.id);
        if (mapped) {
          delete s.paramKey;
          s.valueRef = { rowField: mapped.key };
          rowParams.push(mapped);
        }
      }
    }
  } else {
    for (const s of steps) {
      if (s.action === 'auth_checkpoint') {
        preStepIds.push(s.id);
        if (paramByStepId.has(s.id)) preParamIds.add(s.id);
      } else {
        rowStepIds.push(s.id);
        const mapped = paramByStepId.get(s.id);
        if (mapped) {
          delete s.paramKey;
          s.valueRef = { rowField: mapped.key };
          rowParams.push(mapped);
        }
      }
    }
  }

  const datasetColumns = rowParams.map((p) => ({
    key: p.key,
    label: p.label,
    type: p.type || 'string',
    required: p.key !== 'remark' && p.key !== 'batchCode'
  }));

  const preParams = paramsList.filter((p) => preParamIds.has(p.sourceStepId));
  nextSkill.parameters = [
    ...preParams,
    {
      key: 'batchRows',
      label: '批量导入台账表(CSV)',
      type: 'dataset',
      required: false,
      defaultValue: '',
      default: '',
      sensitive: false,
      columns: datasetColumns
    }
  ];

  const resetUrl = sanitizeUrl(targetFormUrl || nextSkill.startUrl || '');
  nextSkill.batchLoop = {
    enabled: true,
    datasetParam: 'batchRows',
    preSteps: preStepIds,
    rowSteps: rowStepIds,
    postSteps: [],
    pilotCount: Math.max(0, Number(pilotCount ?? 2)),
    rowResetRule: resetUrl ? { type: 'navigateOrClick', url: resetUrl } : null
  };
  nextSkill.riskPolicy = {
    ...(nextSkill.riskPolicy || {}),
    writeMode: 'pilot_then_batch'
  };

  return { skill: nextSkill, datasetColumns, preStepIds, rowStepIds };
}

/**
 * 仅提取批量运行中的明确失败行（status === 'failed'）用于重构待重跑队列：
 * - 严格排除已成功（verified/skipped/unverified）与写入未知行（unknown，防重复入库）。
 */
export function extractFailedRowsForRetry(records = [], columnSchemas = []) {
  const list = redactObject(Array.isArray(records) ? records : []);
  const schemaKeys = Array.isArray(columnSchemas) && columnSchemas.length > 0
    ? columnSchemas.map((c) => c.key).filter(Boolean)
    : null;
  const metaKeys = new Set([
    'rowIndex',
    'status',
    'receiptNo',
    'error',
    'errorCode',
    'evidenceLevel',
    'elapsedMs',
    'rawStatus',
    'message'
  ]);

  let excludedUnknownCount = 0;
  const rows = [];

  for (const r of list) {
    const st = String(r?.status || '').toLowerCase();
    if (st === 'unknown') {
      excludedUnknownCount += 1;
      continue;
    }
    if (st !== 'failed') continue;

    const projected = {};
    if (schemaKeys) {
      for (const k of schemaKeys) {
        if (Object.prototype.hasOwnProperty.call(r, k)) {
          projected[k] = r[k];
        } else {
          projected[k] = '';
        }
      }
    } else {
      for (const k of Object.keys(r || {})) {
        if (!metaKeys.has(k)) projected[k] = r[k];
      }
    }
    rows.push(redactObject(projected));
  }

  return {
    rows,
    count: rows.length,
    excludedUnknownCount
  };
}

function summarizeLedger(ledger) {
  return ledger.reduce(
    (acc, item) => {
      acc.total += 1;
      if (item.status === 'verified') acc.verified += 1;
      else if (item.status === 'failed') acc.failed += 1;
      else if (item.status === 'skipped') acc.skipped += 1;
      else if (item.status === 'unknown') acc.unknown += 1;
      else if (item.status === 'unverified') acc.unverified = (acc.unverified || 0) + 1;
      return acc;
    },
    { total: 0, verified: 0, failed: 0, skipped: 0, unknown: 0 }
  );
}

/**
 * 创建 1→N 批量调度控制器（严禁直接调用 chrome.tabs/scripting，循环体内 0 次 LLM 调用）。
 */
export function createBatchRunner({
  driver,
  store,
  approvalClient,
  onStateChange = () => {},
  onLog = () => {},
  onRowComplete = () => {}
}) {
  let state = {
    runId: '',
    status: 'IDLE',
    skill: null,
    snapshot: null,
    payload: null,
    approvedPlanHash: null,
    batchRows: [],
    partitions: { preSteps: [], rowSteps: [], postSteps: [], pilotCount: 2, rowResetRule: null },
    phase: 'pre',
    phaseStepIndex: 0,
    currentRowIndex: 0,
    rowStepIndex: 0,
    pilotApproved: false,
    authPolicyOverride: null,
    vars: {},
    ledger: [],
    records: [],
    recordSchema: [],
    logs: [],
    authPauseInfo: null,
    unknownWriteInfo: null,
    currentRowWriteCommitted: false,
    currentRowStartTime: 0,
    failedStepIndex: null,
    failedStepId: null,
    lastStepErrorCode: null,
    locatorStats: { totalAttempts: 0, hits: 0, ambiguousCount: 0, failedCount: 0, byStrategy: {} },
    error: null,
    errorCode: null,
    startTime: 0,
    elapsedMs: 0,
    cancelled: false
  };

  function getState() {
    const batchSummary = summarizeLedger(state.ledger);
    const evidenceLevel = !state.skill?.extractSpec
      ? 'L0'
      : batchSummary.verified > 0
        ? 'L2'
        : 'L1';
    return {
      runId: state.runId,
      status: state.status,
      skillId: state.skill?.id || '',
      skillName: state.skill?.name || '',
      planHash: state.approvedPlanHash || state.snapshot?.planHash || '',
      writeMode: state.snapshot?.writeMode || 'pilot_then_batch',
      evidenceLevel,
      phase: state.phase,
      currentRowIndex: state.currentRowIndex,
      totalRows: state.batchRows.length,
      pilotCount: state.partitions.pilotCount,
      pilotApproved: state.pilotApproved,
      batchSummary,
      vars: { ...state.vars },
      ledger: [...state.ledger],
      records: [...state.records],
      recordSchema: [...state.recordSchema],
      logs: [...state.logs],
      authPauseInfo: state.authPauseInfo ? { ...state.authPauseInfo } : null,
      unknownWriteInfo: state.unknownWriteInfo ? { ...state.unknownWriteInfo } : null,
      failedStepIndex: state.failedStepIndex,
      failedStepId: state.failedStepId,
      locatorStats: structuredClone(state.locatorStats),
      error: state.error,
      errorCode: state.errorCode,
      elapsedMs: state.elapsedMs
    };
  }

  function appendLog(entry) {
    const safe = redactObject(entry);
    state.logs.push(safe);
    onLog(safe);
  }

  async function persistCheckpoint() {
    if (!store?.saveRunCheckpoint || !state.runId) return;
    await store.saveRunCheckpoint({
      runId: state.runId,
      skillId: state.skill?.id || '',
      skillName: state.skill?.name || '',
      skillVersion: Number(state.skill?.version || 1),
      planHash: state.approvedPlanHash || '',
      writeMode: state.snapshot?.writeMode || 'pilot_then_batch',
      authPolicyOverride: state.authPolicyOverride || null,
      args: state.snapshot?.args || {},
      batchRows: state.batchRows,
      status: state.status,
      phase: state.phase,
      phaseStepIndex: state.phaseStepIndex,
      currentRowIndex: state.currentRowIndex,
      rowStepIndex: state.rowStepIndex,
      pilotApproved: state.pilotApproved,
      batchSummary: summarizeLedger(state.ledger),
      ledger: state.ledger,
      records: state.records,
      recordSchema: state.recordSchema,
      vars: state.vars,
      logs: state.logs,
      authPauseInfo: state.authPauseInfo
        ? {
            mode: state.authPauseInfo.mode,
            hasCaptcha: state.authPauseInfo.hasCaptcha,
            downgraded: state.authPauseInfo.downgraded
          }
        : null,
      unknownWriteInfo: state.unknownWriteInfo,
      updatedAt: new Date().toISOString()
    });
  }

  async function finalizeBatch(finalStatus, errorMsg = null, errorCode = null) {
    const hadUnknownPause = Boolean(state.unknownWriteInfo);
    const prevStatus = state.status;
    state.status = finalStatus;
    state.error = errorMsg;
    state.errorCode = errorCode;
    state.elapsedMs = Date.now() - state.startTime;
    state.authPauseInfo = null;

    const batchSummary = summarizeLedger(state.ledger);
    const evidenceLevel = !state.skill?.extractSpec
      ? 'L0'
      : batchSummary.verified > 0
        ? 'L2'
        : 'L1';
    const record = {
      id: state.runId,
      skillId: state.skill?.id || '',
      skillName: state.skill?.name || '',
      planHash: state.approvedPlanHash || state.snapshot?.planHash || '',
      status: finalStatus,
      ok: finalStatus === 'VERIFIED_SUCCESS',
      actionCompleted:
        finalStatus === 'VERIFIED_SUCCESS' || finalStatus === 'ACTIONS_COMPLETED_UNVERIFIED',
      evidenceLevel,
      ts: new Date().toISOString(),
      args: state.snapshot?.args || {},
      batchSummary,
      locatorStats: structuredClone(state.locatorStats),
      failedStepIndex: state.failedStepIndex,
      failedStepId: state.failedStepId,
      ledger: state.ledger,
      records: state.records,
      recordSchema: state.recordSchema,
      vars: state.vars,
      logs: state.logs,
      elapsedMs: state.elapsedMs,
      error: errorMsg,
      errorCode
    };

    if (store?.saveRun) await store.saveRun(record);
    const hasRemainingRows =
      Array.isArray(state.batchRows) &&
      state.batchRows.length > 0 &&
      state.currentRowIndex < state.batchRows.length &&
      (state.ledger.length > 0 || hadUnknownPause);
    if (
      (finalStatus === 'CANCELLED' || finalStatus === 'FAILED') &&
      hasRemainingRows &&
      store?.saveRunCheckpoint
    ) {
      await store.saveRunCheckpoint({
        runId: state.runId,
        skillId: state.skill?.id || '',
        skillName: state.skill?.name || '',
        skillVersion: Number(state.skill?.version || 1),
        planHash: state.approvedPlanHash || '',
        writeMode: state.snapshot?.writeMode || 'pilot_then_batch',
        authPolicyOverride: state.authPolicyOverride || null,
        args: state.snapshot?.args || {},
        batchRows: state.batchRows,
        status: hadUnknownPause ? 'PAUSED_CONFIRM_REQUIRED' : prevStatus,
        phase: state.phase,
        phaseStepIndex: state.phaseStepIndex,
        currentRowIndex: state.currentRowIndex,
        rowStepIndex: 0,
        pilotApproved: state.pilotApproved,
        batchSummary,
        ledger: state.ledger,
        records: state.records,
        recordSchema: state.recordSchema,
        vars: state.vars,
        logs: state.logs,
        authPauseInfo: null,
        unknownWriteInfo: state.unknownWriteInfo,
        updatedAt: new Date().toISOString()
      });
    } else if (store?.clearRunCheckpoint && state.runId) {
      await store.clearRunCheckpoint(state.runId);
    }
    if (state.approvedPlanHash && approvalClient?.revokePlan) {
      await approvalClient.revokePlan({ planHash: state.approvedPlanHash }).catch(() => {});
    }
    onStateChange(getState());
    return getState();
  }

  function resolveStepForExecution(rawStep, rowData = null) {
    const resolved = structuredClone(rawStep);
    if (resolved.valueRef?.rowField) {
      const field = resolved.valueRef.rowField;
      resolved.value = rowData?.[field] ?? '';
    } else if (resolved.valueRef?.var) {
      const v = resolved.valueRef.var;
      if (!(v in state.vars) || state.vars[v] === undefined) {
        const err = new Error(`MISSING_PARAMETER: 缺少前序提取变量 ${v}`);
        err.errorCode = 'MISSING_PARAMETER';
        throw err;
      }
      resolved.value = state.vars[v];
    } else if (
      resolved.valueRef?.param &&
      Object.prototype.hasOwnProperty.call(state.snapshot?.args || {}, resolved.valueRef.param)
    ) {
      resolved.value = state.snapshot.args[resolved.valueRef.param];
    } else if (resolved.valueRef?.literal !== undefined) {
      resolved.value = resolved.valueRef.literal;
    }
    return resolved;
  }

  async function verifyPlanGate() {
    const res = await approvalClient.verifyPlan({
      planHash: state.approvedPlanHash,
      payload: state.payload
    });
    if (!res?.ok) {
      const code = res?.errorCode || 'PLAN_NOT_APPROVED';
      const err = new Error(`${code}: ${res?.message || '计划审批已失效'}`);
      err.errorCode = code;
      throw err;
    }
  }

  async function handleAuthStep(step) {
    const authInfo = await driver.checkAuthState(step);
    if (authInfo.state === 'AUTHENTICATED') {
      appendLog({ ok: true, message: 'SKIPPED_AUTHENTICATED: 登录会话有效，跳过检查点' });
      return { paused: false };
    }
    const policy = state.authPolicyOverride || state.skill?.authPolicy || 'manual_takeover';
    const canEphemeral =
      policy === 'ephemeral_prompt' && authInfo.canEphemeralFill && !authInfo.hasCaptcha;
    const mode = canEphemeral ? 'ephemeral_prompt' : 'manual_takeover';
    const downgraded = policy === 'ephemeral_prompt' && mode === 'manual_takeover';

    state.status = 'PAUSED_AUTH_REQUIRED';
    state.authPauseInfo = {
      mode,
      step,
      hasCaptcha: Boolean(authInfo.hasCaptcha),
      downgraded
    };
    appendLog({
      ok: true,
      message:
        mode === 'ephemeral_prompt'
          ? 'PAUSED_AUTH_REQUIRED: 等待侧边栏纯本地临时填入凭据'
          : `PAUSED_AUTH_REQUIRED: 请完成登录后点击继续${downgraded ? '（已降级人工接管）' : ''}`
    });
    await persistCheckpoint();
    onStateChange(getState());
    return { paused: true };
  }

  async function runSingleStep(rawStep, rowData = null) {
    await verifyPlanGate();

    if (rawStep.action === 'auth_checkpoint') {
      return await handleAuthStep(rawStep);
    }

    if (
      state.snapshot.writeMode === 'prefill_only' &&
      (rawStep.risk === 'write_commit' || (isRiskStep(rawStep) && rawStep.action === 'click'))
    ) {
      appendLog({ ok: true, message: `SKIPPED_PREFILL_ONLY: 已跳过提交动作 (${rawStep.id})` });
      return { paused: false, skipped: true };
    }

    const resolved = resolveStepForExecution(rawStep, rowData);
    const isCommitStep =
      resolved.risk === 'write_commit' ||
      (resolved.action === 'click' && isRiskStep(resolved));

    const res = await driver.executeStep(resolved);
    if (resolved.action !== 'navigate') {
      state.locatorStats.totalAttempts += 1;
      if (res?.ok) {
        state.locatorStats.hits += 1;
        const strat = res.matchedLocator || 'unknown';
        state.locatorStats.byStrategy[strat] = (state.locatorStats.byStrategy[strat] || 0) + 1;
      } else {
        const idx = (state.skill?.steps || []).findIndex((s) => s.id === rawStep.id);
        state.failedStepIndex = idx >= 0 ? idx : null;
        state.failedStepId = rawStep.id || null;
        state.lastStepErrorCode = res?.errorCode || 'ACTION_FAILED';
        if (res?.errorCode === 'TARGET_AMBIGUOUS') state.locatorStats.ambiguousCount += 1;
        else state.locatorStats.failedCount += 1;
      }
    }
    if (isCommitStep) {
      state.currentRowWriteCommitted = true;
    }

    if (!res?.ok) {
      if (state.currentRowWriteCommitted && rowData) {
        const err = new Error(`WRITE_OUTCOME_UNKNOWN: 写入动作结果不明确 (${res?.message || ''})`);
        err.errorCode = 'WRITE_OUTCOME_UNKNOWN';
        throw err;
      }
      const err = new Error(`${res?.errorCode || 'ACTION_FAILED'}: ${res?.message || '步骤失败'}`);
      err.errorCode = res?.errorCode || 'ACTION_FAILED';
      throw err;
    }

    if (resolved.action === 'extract' && resolved.outputVar) {
      state.vars[resolved.outputVar] = res.extractedValue ?? '';
    }
    return { paused: false };
  }

  async function applyRowReset(rule) {
    if (!rule) return;
    if (rule.type === 'click' && rule.selector) {
      await driver.executeStep({ action: 'click', target: { cssPath: rule.selector } });
      return;
    }
    if (rule.url) {
      await driver.navigate(rule.url, {
        allowedOrigins: state.snapshot.targetOrigins,
        forceReload: true
      });
      return;
    }
    if (rule.selector) {
      await driver.executeStep({ action: 'click', target: { cssPath: rule.selector } });
    }
  }

  async function executePipeline() {
    state.status = 'RUNNING';
    state.error = null;
    state.errorCode = null;
    onStateChange(getState());

    try {
      // 1. Pre-steps（仅执行一次，如登录 + 系统 A 取客户批号）
      if (state.phase === 'pre') {
        const pre = state.partitions.preSteps;
        while (state.phaseStepIndex < pre.length) {
          if (state.cancelled) {
            return await finalizeBatch('CANCELLED', 'USER_CANCELLED: 用户中止批量任务', 'USER_CANCELLED');
          }
          const step = pre[state.phaseStepIndex];
          const res = await runSingleStep(step, null);
          if (res.paused) return getState();
          state.phaseStepIndex += 1;
          await persistCheckpoint();
        }
        state.phase = 'row';
        state.phaseStepIndex = 0;
        await persistCheckpoint();
      }

      // 2. Row loop（1→N 循环体，0 次 LLM 调用，逐条持久账本）
      if (state.phase === 'row') {
        const rows = state.batchRows;
        const rowSteps = state.partitions.rowSteps;
        const pilotLimit = state.partitions.pilotCount;

        while (state.currentRowIndex < rows.length) {
          if (state.cancelled) {
            return await finalizeBatch('CANCELLED', 'USER_CANCELLED: 用户中止批量任务', 'USER_CANCELLED');
          }

          const r = state.currentRowIndex;
          if (
            state.snapshot.writeMode === 'pilot_then_batch' &&
            !state.pilotApproved &&
            pilotLimit > 0 &&
            r === pilotLimit &&
            rows.length > pilotLimit
          ) {
            state.status = 'PAUSED_PILOT_REVIEW';
            appendLog({
              ok: true,
              message: `PAUSED_PILOT_REVIEW: 前 ${pilotLimit} 条试跑已完成，请核验回执后放行剩余 ${rows.length - pilotLimit} 条`
            });
            await persistCheckpoint();
            onStateChange(getState());
            return getState();
          }

          const rowData = rows[r];
          if (state.rowStepIndex === 0) {
            state.currentRowStartTime = Date.now();
            state.currentRowWriteCommitted = false;
            if (r > 0 && state.partitions.rowResetRule) {
              await verifyPlanGate();
              await applyRowReset(state.partitions.rowResetRule);
            }
          }

          try {
            while (state.rowStepIndex < rowSteps.length) {
              if (state.cancelled) {
                return await finalizeBatch('CANCELLED', 'USER_CANCELLED: 用户中止批量任务', 'USER_CANCELLED');
              }
              const step = rowSteps[state.rowStepIndex];
              const res = await runSingleStep(step, rowData);
              if (res.paused) return getState();
              state.rowStepIndex += 1;
            }
          } catch (rowErr) {
            if (rowErr?.errorCode === 'WRITE_OUTCOME_UNKNOWN' || state.currentRowWriteCommitted) {
              const unknownEntry = redactObject({
                rowIndex: r + 1,
                ...rowData,
                status: 'unknown',
                receiptNo: '-',
                error: rowErr.message || 'WRITE_OUTCOME_UNKNOWN',
                errorCode: 'WRITE_OUTCOME_UNKNOWN',
                evidenceLevel: 'L0',
                elapsedMs: Date.now() - state.currentRowStartTime
              });
              state.ledger.push(unknownEntry);
              state.records.push(structuredClone(unknownEntry));
              state.status = 'PAUSED_CONFIRM_REQUIRED';
              state.unknownWriteInfo = {
                rowIndex: r + 1,
                row: rowData,
                reason: unknownEntry.error
              };
              appendLog({ ok: false, message: `第 ${r + 1} 行 WRITE_OUTCOME_UNKNOWN，严禁自动重试，已暂停待人工核对` });
              await persistCheckpoint();
              onStateChange(getState());
              return getState();
            }

            if (rowErr?.errorCode === 'PLAN_NOT_APPROVED' || rowErr?.errorCode === 'SITE_NOT_ALLOWED') {
              throw rowErr;
            }

            const failedEntry = redactObject({
              rowIndex: r + 1,
              ...rowData,
              status: 'failed',
              receiptNo: '-',
              error: rowErr.message,
              errorCode: rowErr.errorCode || 'BATCH_ROW_FAILED',
              evidenceLevel: 'L1',
              elapsedMs: Date.now() - state.currentRowStartTime
            });
            state.ledger.push(failedEntry);
            state.records.push(structuredClone(failedEntry));
            onRowComplete(failedEntry);
            appendLog({ ok: false, message: `第 ${r + 1} 行执行异常：${rowErr.message}` });
            state.currentRowIndex += 1;
            state.rowStepIndex = 0;
            await persistCheckpoint();
            continue;
          }

          // 抽取回执并评定单行业务结果
          let rowEntry;
          if (state.snapshot.writeMode === 'prefill_only') {
            rowEntry = redactObject({
              rowIndex: r + 1,
              ...rowData,
              status: 'skipped',
              receiptNo: '-',
              error: '',
              evidenceLevel: 'L1',
              elapsedMs: Date.now() - state.currentRowStartTime
            });
          } else if (state.skill?.extractSpec) {
            const ext = await driver.extractRecords(state.skill.extractSpec, rowData);
            if (ext.recordSchema?.length && !state.recordSchema.length) {
              state.recordSchema = [{ key: 'rowIndex', label: '行号', type: 'number' }, ...ext.recordSchema];
            }
            const firstRec = ext.records?.[0] || {};
            if (ext.receiptStatus === 'unknown') {
              const unknownEntry = redactObject({
                rowIndex: r + 1,
                ...firstRec,
                status: 'unknown',
                receiptNo: '-',
                error: 'WRITE_OUTCOME_UNKNOWN: 提交后未检测到明确回执状态，严禁自动重试',
                errorCode: 'WRITE_OUTCOME_UNKNOWN',
                evidenceLevel: 'L0',
                elapsedMs: Date.now() - state.currentRowStartTime
              });
              state.ledger.push(unknownEntry);
              state.records.push(structuredClone(unknownEntry));
              state.status = 'PAUSED_CONFIRM_REQUIRED';
              state.unknownWriteInfo = {
                rowIndex: r + 1,
                row: rowData,
                reason: unknownEntry.error
              };
              appendLog({ ok: false, message: `第 ${r + 1} 行回执未知 (WRITE_OUTCOME_UNKNOWN)，已安全暂停` });
              await persistCheckpoint();
              onStateChange(getState());
              return getState();
            }

            rowEntry = redactObject({
              rowIndex: r + 1,
              ...firstRec,
              status: ext.receiptStatus === 'verified' ? 'verified' : 'failed',
              receiptNo: ext.receiptNo || '-',
              error: ext.receiptStatus === 'verified' ? '' : ext.errorText || '业务校验失败',
              evidenceLevel: ext.evidenceLevel || 'L2',
              elapsedMs: Date.now() - state.currentRowStartTime
            });
          } else {
            rowEntry = redactObject({
              rowIndex: r + 1,
              ...rowData,
              status: 'unverified',
              receiptNo: '-',
              error: '',
              evidenceLevel: 'L0',
              elapsedMs: Date.now() - state.currentRowStartTime
            });
          }

          state.ledger.push(rowEntry);
          state.records.push(structuredClone(rowEntry));
          if (!state.recordSchema.length) {
            state.recordSchema = [
              { key: 'rowIndex', label: '行号', type: 'number' },
              { key: 'status', label: '执行状态', type: 'status' },
              { key: 'receiptNo', label: '回执单号', type: 'string' },
              { key: 'error', label: '失败原因', type: 'string' },
              ...Object.keys(rowData).map((k) => ({
                key: k,
                label: k,
                type: typeof rowData[k] === 'number' ? 'number' : 'string'
              }))
            ];
          }
          onRowComplete(rowEntry);
          appendLog({
            ok: ['verified', 'skipped', 'unverified'].includes(rowEntry.status),
            message:
              rowEntry.status === 'verified'
                ? `第 ${r + 1}/${rows.length} 行入库成功 (${rowEntry.receiptNo})`
                : rowEntry.status === 'skipped'
                  ? `第 ${r + 1}/${rows.length} 行已预填未提交`
                  : rowEntry.status === 'unverified'
                    ? `第 ${r + 1}/${rows.length} 行动作已完成，但未配置 extractSpec（L0 未核验）`
                    : `第 ${r + 1}/${rows.length} 行校验失败：${rowEntry.error}`
          });

          state.currentRowIndex += 1;
          state.rowStepIndex = 0;
          await persistCheckpoint();
        }
        state.phase = 'post';
        state.phaseStepIndex = 0;
        await persistCheckpoint();
      }

      // 3. Post-steps（仅执行一次）
      if (state.phase === 'post') {
        const post = state.partitions.postSteps;
        while (state.phaseStepIndex < post.length) {
          if (state.cancelled) {
            return await finalizeBatch('CANCELLED', 'USER_CANCELLED: 用户中止批量任务', 'USER_CANCELLED');
          }
          const step = post[state.phaseStepIndex];
          const res = await runSingleStep(step, null);
          if (res.paused) return getState();
          state.phaseStepIndex += 1;
          await persistCheckpoint();
        }
      }

      const summary = summarizeLedger(state.ledger);
      if (state.snapshot.writeMode === 'prefill_only') {
        return await finalizeBatch('ACTIONS_COMPLETED_UNVERIFIED');
      }
      if (!state.skill?.extractSpec) {
        if (summary.failed > 0 && !(summary.unverified > 0)) {
          return await finalizeBatch(
            'FAILED',
            `批量任务全部失败（共 ${summary.total} 条，失败 ${summary.failed} 条）`,
            state.lastStepErrorCode || 'BATCH_ROW_FAILED'
          );
        }
        return await finalizeBatch('ACTIONS_COMPLETED_UNVERIFIED');
      }
      if (summary.verified === 0 && summary.failed > 0) {
        return await finalizeBatch(
          'FAILED',
          `批量任务全部失败（共 ${summary.total} 条，失败 ${summary.failed} 条）`,
          state.lastStepErrorCode || 'BATCH_ROW_FAILED'
        );
      }
      if (summary.verified === 0) {
        return await finalizeBatch('ACTIONS_COMPLETED_UNVERIFIED');
      }
      return await finalizeBatch('VERIFIED_SUCCESS');
    } catch (err) {
      const code = err?.errorCode || 'ACTION_FAILED';
      appendLog({ ok: false, message: err.message });
      return await finalizeBatch(
        code === 'USER_CANCELLED' ? 'CANCELLED' : 'FAILED',
        err.message,
        code
      );
    }
  }

  async function start({ skill, snapshot, batchRows = [], authPolicyOverride = null }) {
    if (!skill || !snapshot) throw new Error('缺少技能或执行计划快照');
    if (!Array.isArray(batchRows) || batchRows.length === 0) {
      throw new Error('CSV_SCHEMA_INVALID: 批量执行需要至少 1 条数据');
    }

    state = {
      runId: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `batch-${Date.now()}`,
      status: 'RUNNING',
      skill,
      snapshot,
      payload: toVerifyPayload(snapshot),
      approvedPlanHash: snapshot.planHash,
      batchRows: redactObject(batchRows),
      partitions: resolveBatchPartitions(skill, snapshot.steps || []),
      phase: 'pre',
      phaseStepIndex: 0,
      currentRowIndex: 0,
      rowStepIndex: 0,
      pilotApproved: false,
      authPolicyOverride,
      vars: {},
      ledger: [],
      records: [],
      recordSchema: [],
      logs: [],
      authPauseInfo: null,
      unknownWriteInfo: null,
      currentRowWriteCommitted: false,
      currentRowStartTime: 0,
      failedStepIndex: null,
      failedStepId: null,
      lastStepErrorCode: null,
      locatorStats: { totalAttempts: 0, hits: 0, ambiguousCount: 0, failedCount: 0, byStrategy: {} },
      error: null,
      errorCode: null,
      startTime: Date.now(),
      elapsedMs: 0,
      cancelled: false
    };

    try {
      const approveRes = await approvalClient.approvePlan({
        expectedPlanHash: snapshot.planHash,
        payload: state.payload
      });
      if (!approveRes?.ok || approveRes.planHash !== snapshot.planHash) {
        const err = new Error(
          `${approveRes?.errorCode || 'PLAN_NOT_APPROVED'}: ${approveRes?.message || '计划审批失败'}`
        );
        err.errorCode = approveRes?.errorCode || 'PLAN_NOT_APPROVED';
        throw err;
      }

      const session = await driver.ensureSession(snapshot.targetOrigins);
      if (skill.startUrl && !isSamePageIgnoringQueryAndHash(session.currentUrl, skill.startUrl)) {
        await driver.navigate(skill.startUrl, { allowedOrigins: snapshot.targetOrigins });
      }
      return await executePipeline();
    } catch (err) {
      const code = err?.errorCode || 'ACTION_FAILED';
      appendLog({ ok: false, message: err.message });
      return await finalizeBatch('FAILED', err.message, code);
    }
  }

  async function approveRemainingAndContinue() {
    if (state.status !== 'PAUSED_PILOT_REVIEW') {
      return { ok: false, message: '当前并未处于试跑核验暂停状态' };
    }
    state.pilotApproved = true;
    appendLog({
      ok: true,
      message: `人工确认前 ${state.partitions.pilotCount} 条试跑无误，放行剩余 ${state.batchRows.length - state.currentRowIndex} 条`
    });
    const nextState = await executePipeline();
    return { ok: true, state: nextState };
  }

  async function resolveUnknownRowAndResume({ resolution = 'failed', note = '' } = {}) {
    if (state.status !== 'PAUSED_CONFIRM_REQUIRED' || !state.unknownWriteInfo) {
      return { ok: false, message: '当前没有待人工确认的 UNKNOWN 写入行' };
    }
    const allowedRes = ['verified', 'failed', 'skipped'].includes(resolution) ? resolution : 'failed';
    const idx = state.unknownWriteInfo.rowIndex - 1;
    if (state.ledger[idx]) {
      state.ledger[idx].status = allowedRes;
      state.ledger[idx].error = allowedRes === 'verified' ? '' : note || state.ledger[idx].error;
    }
    if (state.records[idx]) {
      state.records[idx].status = allowedRes;
      state.records[idx].error = allowedRes === 'verified' ? '' : note || state.records[idx].error;
    }
    state.unknownWriteInfo = null;
    // 严格推进到下一行，绝不重提交 UNKNOWN 写入行
    state.currentRowIndex += 1;
    state.rowStepIndex = 0;
    appendLog({
      ok: true,
      message: `已人工核定第 ${idx + 1} 行为 "${allowedRes}"（未重放提交），继续剩余条目`
    });
    await persistCheckpoint();
    const nextState = await executePipeline();
    return { ok: true, state: nextState };
  }

  async function resumeAfterManualAuth() {
    if (state.status !== 'PAUSED_AUTH_REQUIRED' || !state.authPauseInfo) {
      return { ok: false, errorCode: 'ACTION_FAILED', message: '当前并未处于登录等待暂停状态' };
    }
    const authInfo = await driver.checkAuthState(state.authPauseInfo.step);
    if (authInfo.state === 'AUTH_REQUIRED') {
      state.authPauseInfo.hasCaptcha = Boolean(authInfo.hasCaptcha);
      onStateChange(getState());
      return {
        ok: false,
        errorCode: 'AUTH_REQUIRED',
        message: '检测到业务网页仍处于未登录状态，请先完成登录再继续',
        state: getState()
      };
    }
    appendLog({ ok: true, message: 'AUTH_RESUMED_MANUAL: 登录已恢复，原位续跑批量任务' });
    state.authPauseInfo = null;
    if (state.phase === 'pre') state.phaseStepIndex += 1;
    else if (state.phase === 'row') state.rowStepIndex += 1;
    else if (state.phase === 'post') state.phaseStepIndex += 1;
    const nextState = await executePipeline();
    return { ok: true, state: nextState };
  }

  async function submitEphemeralAuth(credentials = {}) {
    if (state.status !== 'PAUSED_AUTH_REQUIRED' || !state.authPauseInfo) {
      if (credentials) {
        credentials.username = '';
        credentials.password = '';
      }
      return { ok: false, errorCode: 'ACTION_FAILED', message: '当前并未处于登录等待暂停状态' };
    }
    const pause = state.authPauseInfo;
    try {
      const fillRes = await driver.fillEphemeralAuth(pause.step, credentials);
      if (!fillRes?.ok || fillRes.downgradeToManual) {
        state.authPauseInfo = {
          ...pause,
          mode: 'manual_takeover',
          downgraded: true,
          hasCaptcha: fillRes?.errorCode === 'AUTH_CAPTCHA_DETECTED' || pause.hasCaptcha
        };
        await persistCheckpoint();
        onStateChange(getState());
        return {
          ok: false,
          downgraded: true,
          errorCode: fillRes?.errorCode || 'AUTH_REQUIRED',
          message: fillRes?.message || '已自动降级为人工接管',
          state: getState()
        };
      }
      const afterAuth = await driver.checkAuthState(pause.step);
      if (afterAuth.state === 'AUTH_REQUIRED') {
        state.authPauseInfo = { ...pause, mode: 'manual_takeover', downgraded: true };
        await persistCheckpoint();
        onStateChange(getState());
        return {
          ok: false,
          downgraded: true,
          errorCode: 'AUTH_REQUIRED',
          message: '提交后仍需验证，已切换人工接管模式',
          state: getState()
        };
      }
      state.authPauseInfo = null;
      if (state.phase === 'pre') state.phaseStepIndex += 1;
      else if (state.phase === 'row') state.rowStepIndex += 1;
      else if (state.phase === 'post') state.phaseStepIndex += 1;
      const nextState = await executePipeline();
      return { ok: true, state: nextState };
    } finally {
      if (credentials && typeof credentials === 'object') {
        credentials.username = '';
        credentials.password = '';
      }
    }
  }

  async function switchAuthToManual() {
    if (state.status !== 'PAUSED_AUTH_REQUIRED' || !state.authPauseInfo) return getState();
    state.authPauseInfo = { ...state.authPauseInfo, mode: 'manual_takeover', downgraded: true };
    await persistCheckpoint();
    onStateChange(getState());
    return getState();
  }

  /**
   * 断点续跑批量任务（必须重新签批新 PlanSnapshot + planHash，且绝不自动重放 UNKNOWN 写入行）。
   */
  async function resumeFromCheckpoint({ skill, snapshot, checkpoint, authPolicyOverride = null }) {
    if (!skill || !snapshot || !checkpoint) {
      throw new Error('缺少技能、新执行计划快照或历史断点记录');
    }
    if (checkpoint.skillId && checkpoint.skillId !== skill.id) {
      throw new Error('SKILL_MISMATCH: 断点所属技能与当前选中技能不一致');
    }
    const rows = Array.isArray(checkpoint.batchRows) && checkpoint.batchRows.length > 0
      ? checkpoint.batchRows
      : snapshot.batchRows;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('CSV_SCHEMA_INVALID: 断点缺少可恢复的 batchRows 数据');
    }

    const restoredPhase = ['pre', 'row', 'post'].includes(checkpoint.phase) ? checkpoint.phase : 'row';
    const safeRowIdx = Math.min(Math.max(0, Number(checkpoint.currentRowIndex || 0)), rows.length);
    const hasUnknownPause =
      checkpoint.status === 'PAUSED_CONFIRM_REQUIRED' && Boolean(checkpoint.unknownWriteInfo);

    state = {
      runId: checkpoint.runId || `batch-${Date.now()}`,
      status: hasUnknownPause ? 'PAUSED_CONFIRM_REQUIRED' : 'RUNNING',
      skill,
      snapshot,
      payload: toVerifyPayload(snapshot),
      approvedPlanHash: snapshot.planHash,
      batchRows: redactObject(rows),
      partitions: resolveBatchPartitions(skill, snapshot.steps || []),
      phase: restoredPhase,
      phaseStepIndex: Math.max(0, Number(checkpoint.phaseStepIndex || 0)),
      currentRowIndex: safeRowIdx,
      rowStepIndex: 0,
      pilotApproved:
        checkpoint.status === 'PAUSED_PILOT_REVIEW'
          ? true
          : Boolean(checkpoint.pilotApproved),
      authPolicyOverride: authPolicyOverride ?? checkpoint.authPolicyOverride ?? null,
      vars: structuredClone(checkpoint.vars || {}),
      ledger: redactObject(structuredClone(checkpoint.ledger || [])),
      records: redactObject(structuredClone(checkpoint.records || checkpoint.ledger || [])),
      recordSchema: structuredClone(checkpoint.recordSchema || []),
      logs: redactObject(structuredClone(checkpoint.logs || [])),
      authPauseInfo: null,
      unknownWriteInfo: hasUnknownPause ? structuredClone(checkpoint.unknownWriteInfo) : null,
      currentRowWriteCommitted: false,
      currentRowStartTime: 0,
      failedStepIndex: null,
      failedStepId: null,
      lastStepErrorCode: null,
      locatorStats: { totalAttempts: 0, hits: 0, ambiguousCount: 0, failedCount: 0, byStrategy: {} },
      error: null,
      errorCode: null,
      startTime: Date.now(),
      elapsedMs: 0,
      cancelled: false
    };

    try {
      const approveRes = await approvalClient.approvePlan({
        expectedPlanHash: snapshot.planHash,
        payload: state.payload
      });
      if (!approveRes?.ok || approveRes.planHash !== snapshot.planHash) {
        const err = new Error(
          `${approveRes?.errorCode || 'PLAN_NOT_APPROVED'}: ${approveRes?.message || '断点续跑计划审批失败'}`
        );
        err.errorCode = approveRes?.errorCode || 'PLAN_NOT_APPROVED';
        throw err;
      }

      const session = await driver.ensureSession(snapshot.targetOrigins);

      if (hasUnknownPause) {
        appendLog({
          ok: false,
          message: `断点恢复拦截（PAUSED_CONFIRM_REQUIRED）：第 ${state.unknownWriteInfo.rowIndex} 行存在未核实写入，严禁自动重放，请先人工核定后再续跑剩余条目`
        });
        await persistCheckpoint();
        onStateChange(getState());
        return getState();
      }

      const navTarget =
        state.phase === 'row'
          ? state.partitions.rowResetRule?.url || skill.startUrl
          : skill.startUrl;
      if (state.phase === 'row' && state.currentRowIndex === 0 && navTarget) {
        await driver.navigate(navTarget, {
          allowedOrigins: snapshot.targetOrigins,
          forceReload: true
        });
      } else if (navTarget && state.phase === 'pre' && !isSamePageIgnoringQueryAndHash(session.currentUrl, navTarget)) {
        await driver.navigate(navTarget, { allowedOrigins: snapshot.targetOrigins });
      } else if (state.phase === 'row' && !state.partitions.rowResetRule && skill.startUrl && !isSamePageIgnoringQueryAndHash(session.currentUrl, skill.startUrl)) {
        await driver.navigate(skill.startUrl, { allowedOrigins: snapshot.targetOrigins });
      }

      appendLog({
        ok: true,
        message: `RESUME_CHECKPOINT: 已审批新计划并从第 ${Math.min(state.currentRowIndex + 1, state.batchRows.length)}/${state.batchRows.length} 行续跑（已继承 ${state.ledger.length} 条历史账本）`
      });
      return await executePipeline();
    } catch (err) {
      const code = err?.errorCode || 'ACTION_FAILED';
      appendLog({ ok: false, message: err.message });
      return await finalizeBatch('FAILED', err.message, code);
    }
  }

  async function cancel() {
    state.cancelled = true;
    if (
      state.status === 'PAUSED_AUTH_REQUIRED' ||
      state.status === 'PAUSED_PILOT_REVIEW' ||
      state.status === 'PAUSED_CONFIRM_REQUIRED'
    ) {
      return await finalizeBatch('CANCELLED', 'USER_CANCELLED: 用户主动中止批量任务', 'USER_CANCELLED');
    }
    return getState();
  }

  return {
    getState,
    start,
    resumeFromCheckpoint,
    approveRemainingAndContinue,
    resolveUnknownRowAndResume,
    resumeAfterManualAuth,
    submitEphemeralAuth,
    switchAuthToManual,
    cancel
  };
}
