"use strict";

import { ALLOWED_QUERY_OPS } from './schemas.js';

/**
 * 确定性统计计算与数据分布追问模块（planQuery -> reduce 确定性算账 -> explainRun）。
 * 严禁使用 Object.groupBy / Map.groupBy（Chrome 116 兼容），全部使用手写 reduce 实现；
 * 无明细或缺少请求维度时必须显式拒答，严禁幻觉猜测。
 */

function filterRecordsByStatus(records, filterStatus = null) {
  const list = Array.isArray(records) ? records : [];
  if (!filterStatus) return list;
  const target = String(filterStatus).trim().toLowerCase();
  return list.filter((r) => String(r?.status || '').trim().toLowerCase() === target);
}

export function countRecords(records, { filterStatus = null } = {}) {
  const filtered = filterRecordsByStatus(records, filterStatus);
  return {
    op: 'count',
    filterStatus: filterStatus || null,
    total: filtered.length
  };
}

/**
 * 手写 reduce 分组计数（兼容 Chrome 116，禁止 Object.groupBy）。
 */
export function groupCount(records, key, { filterStatus = null } = {}) {
  const filtered = filterRecordsByStatus(records, filterStatus);
  const total = filtered.length;
  const counts = filtered.reduce((acc, row) => {
    const val = row?.[key];
    const k = val === undefined || val === null || String(val).trim() === '' ? '(空)' : String(val).trim();
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, Object.create(null));

  const groups = Object.keys(counts)
    .map((k) => {
      const count = counts[k];
      const ratio = total > 0 ? Number((count / total).toFixed(4)) : 0;
      return {
        key: k,
        count,
        ratio,
        percent: `${(ratio * 100).toFixed(1)}%`
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    op: 'groupCount',
    key,
    filterStatus: filterStatus || null,
    total,
    counts: { ...counts },
    groups
  };
}

export function sumField(records, metricField, { groupBy = null, filterStatus = null } = {}) {
  const filtered = filterRecordsByStatus(records, filterStatus);
  const agg = filtered.reduce(
    (acc, row) => {
      const raw = row?.[metricField];
      const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/,/g, ''));
      if (Number.isFinite(n)) {
        acc.sum += n;
        acc.validCount += 1;
        if (groupBy) {
          const gk = String(row?.[groupBy] ?? '(空)');
          acc.byGroup[gk] = (acc.byGroup[gk] || 0) + n;
        }
      }
      return acc;
    },
    { sum: 0, validCount: 0, byGroup: Object.create(null) }
  );

  return {
    op: 'sum',
    metricField,
    groupBy: groupBy || null,
    filterStatus: filterStatus || null,
    sum: Number(agg.sum.toFixed(4)),
    validCount: agg.validCount,
    ...(groupBy ? { byGroup: { ...agg.byGroup } } : {})
  };
}

export function avgField(records, metricField, { groupBy = null, filterStatus = null } = {}) {
  const s = sumField(records, metricField, { groupBy, filterStatus });
  return {
    op: 'avg',
    metricField,
    groupBy: groupBy || null,
    filterStatus: filterStatus || null,
    avg: s.validCount > 0 ? Number((s.sum / s.validCount).toFixed(4)) : 0,
    sum: s.sum,
    validCount: s.validCount
  };
}

export function filterTopErrors(records, { groupBy = 'error', limit = 5 } = {}) {
  const list = Array.isArray(records) ? records : [];
  const failedRows = list.filter((r) => {
    const st = String(r?.status || '').toLowerCase();
    return st === 'failed' || st === 'unknown' || st === 'error';
  });

  const grouped = failedRows.reduce((acc, row, idx) => {
    const reason =
      String(row?.[groupBy] || row?.error || '未知失败原因').trim() || '未知失败原因';
    if (!acc[reason]) {
      acc[reason] = { count: 0, rowIndices: [] };
    }
    acc[reason].count += 1;
    acc[reason].rowIndices.push(row?.rowIndex ?? idx + 1);
    return acc;
  }, Object.create(null));

  const totalFailed = failedRows.length;
  const items = Object.keys(grouped)
    .map((reason) => {
      const entry = grouped[reason];
      const ratioOfFailed = totalFailed > 0 ? Number((entry.count / totalFailed).toFixed(4)) : 0;
      return {
        reason,
        count: entry.count,
        ratioOfFailed,
        percentOfFailed: `${(ratioOfFailed * 100).toFixed(1)}%`,
        rowIndices: entry.rowIndices
      };
    })
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, Math.max(1, Number(limit || 5)));

  return {
    op: 'filterTopErrors',
    totalRecords: list.length,
    totalFailed,
    items
  };
}

export function listFailedRows(records, { limit = 20 } = {}) {
  const list = Array.isArray(records) ? records : [];
  const failed = list
    .filter((r) => ['failed', 'unknown', 'error'].includes(String(r?.status || '').toLowerCase()))
    .slice(0, Math.max(1, Number(limit || 20)))
    .map((r, idx) => ({
      rowIndex: r?.rowIndex ?? idx + 1,
      orgName: r?.orgName || r?.unit || '',
      status: r?.status || 'failed',
      error: r?.error || '',
      receiptNo: r?.receiptNo || '-'
    }));

  return {
    op: 'listFailedRows',
    totalFailed: failed.length,
    rows: failed
  };
}

function inferSchemaFromRecords(records, providedSchema = []) {
  if (Array.isArray(providedSchema) && providedSchema.length > 0) {
    return providedSchema;
  }
  const first = records[0] || {};
  return Object.keys(first)
    .filter((k) => !['rawStatus', 'message'].includes(k))
    .map((k) => ({
      key: k,
      label: k,
      type: k === 'status' ? 'status' : typeof first[k] === 'number' ? 'number' : 'string'
    }));
}

function hasDimension(schemaKeys, records, candidates) {
  for (const c of candidates) {
    if (schemaKeys.has(c)) return c;
    if (records.some((r) => r && c in r && r[c] !== undefined)) return c;
  }
  return null;
}

/**
 * 规则兜底版 planQuery：同时负责检测请求维度是否在明细中存在。
 */
export function fallbackPlanQuery({ question, recordSchema = [], records = [] }) {
  const q = String(question || '').trim();
  const schema = inferSchemaFromRecords(records, recordSchema);
  const schemaKeys = new Set(schema.map((s) => s.key));

  // 检测明确缺少的统计维度，严格拒答
  if (/客户经理|经办人|负责人/.test(q) && !hasDimension(schemaKeys, records, ['manager', 'owner', 'handler'])) {
    return { op: null, cannotComputeReason: '当前采集明细中缺少“客户经理/负责人”维度字段，严格拒答' };
  }
  if (/地市|区域|省份|城区/.test(q) && !hasDimension(schemaKeys, records, ['region', 'city', 'area', 'province'])) {
    return { op: null, cannotComputeReason: '当前采集明细中缺少“区域/地市”维度字段，严格拒答' };
  }
  if (/金额|电费|费用|元/.test(q) && !hasDimension(schemaKeys, records, ['amount', 'money', 'fee', 'price'])) {
    return { op: null, cannotComputeReason: '当前采集明细中缺少“金额/费用”数值字段，严格拒答' };
  }

  const unitKey = hasDimension(schemaKeys, records, ['orgName', 'unit']);
  const voltageKey = hasDimension(schemaKeys, records, ['voltage', 'voltageLevel']);
  const statusKey = hasDimension(schemaKeys, records, ['status']);
  const kwhKey = hasDimension(schemaKeys, records, ['kwh']) || schema.find((s) => s.type === 'number' && s.key !== 'rowIndex')?.key;

  if (/失败原因|报错|异常原因/.test(q)) {
    return { op: 'filterTopErrors', groupBy: 'error', limit: 5 };
  }
  if (/哪些失败|失败行|异常清单|失败明细/.test(q)) {
    return { op: 'listFailedRows', limit: 20 };
  }
  if (/电压/.test(q)) {
    if (!voltageKey) return { op: null, cannotComputeReason: '当前采集明细中缺少“电压等级”维度字段，严格拒答' };
    return { op: 'groupCount', groupBy: voltageKey };
  }
  if (/供电单位|供电所|按单位|各单位|分布|占比/.test(q)) {
    if (unitKey) return { op: 'groupCount', groupBy: unitKey };
    if (statusKey) return { op: 'groupCount', groupBy: statusKey };
    return { op: null, cannotComputeReason: '当前采集明细中缺少可分组的单位或状态维度字段，严格拒答' };
  }
  if (/平均|均值/.test(q)) {
    if (!kwhKey) return { op: null, cannotComputeReason: '当前采集明细中缺少可计算均值的数值字段，严格拒答' };
    return { op: 'avg', metricField: kwhKey };
  }
  if (/总电量|合计|总和|总计|多少度|多少kwh/i.test(q)) {
    if (!kwhKey) return { op: null, cannotComputeReason: '当前采集明细中缺少可合计的数值字段，严格拒答' };
    return { op: 'sum', metricField: kwhKey };
  }
  return { op: 'count' };
}

/**
 * 执行单一确定性 QueryPlan 算子。
 */
export function executeQueryPlan(plan, records = [], recordSchema = []) {
  if (!plan || !plan.op) {
    return {
      ok: false,
      cannotCompute: true,
      reason: plan?.cannotComputeReason || '无法确定统计操作'
    };
  }
  if (!ALLOWED_QUERY_OPS.includes(plan.op)) {
    return {
      ok: false,
      cannotCompute: true,
      reason: `不允许的统计操作符: ${plan.op}`
    };
  }

  const schema = inferSchemaFromRecords(records, recordSchema);
  const schemaKeys = new Set(schema.map((s) => s.key));
  const checkField = (f) => !f || schemaKeys.has(f) || records.some((r) => r && f in r);

  if (plan.op === 'count') {
    return { ok: true, result: countRecords(records, { filterStatus: plan.filterStatus }) };
  }
  if (plan.op === 'groupCount' || plan.op === 'ratio') {
    if (!plan.groupBy || !checkField(plan.groupBy)) {
      return { ok: false, cannotCompute: true, reason: `明细中缺少分组字段: ${plan.groupBy || '(空)'}` };
    }
    return {
      ok: true,
      result: {
        ...groupCount(records, plan.groupBy, { filterStatus: plan.filterStatus }),
        op: plan.op
      }
    };
  }
  if (plan.op === 'sum') {
    if (!plan.metricField || !checkField(plan.metricField)) {
      return { ok: false, cannotCompute: true, reason: `明细中缺少求和字段: ${plan.metricField || '(空)'}` };
    }
    return {
      ok: true,
      result: sumField(records, plan.metricField, {
        groupBy: plan.groupBy,
        filterStatus: plan.filterStatus
      })
    };
  }
  if (plan.op === 'avg') {
    if (!plan.metricField || !checkField(plan.metricField)) {
      return { ok: false, cannotCompute: true, reason: `明细中缺少求均值字段: ${plan.metricField || '(空)'}` };
    }
    return {
      ok: true,
      result: avgField(records, plan.metricField, {
        groupBy: plan.groupBy,
        filterStatus: plan.filterStatus
      })
    };
  }
  if (plan.op === 'filterTopErrors') {
    return {
      ok: true,
      result: filterTopErrors(records, {
        groupBy: plan.groupBy || 'error',
        limit: plan.limit || 5
      })
    };
  }
  if (plan.op === 'listFailedRows') {
    return { ok: true, result: listFailedRows(records, { limit: plan.limit || 20 }) };
  }
  return { ok: false, cannotCompute: true, reason: '未知查询算子' };
}

/**
 * 确定性自然语言解释器：只陈述已计算的数字与 evidenceRefs。
 */
export function formatDeterministicExplanation(question, bundle) {
  const lines = [];
  if (bundle.statusSummary) {
    const s = bundle.statusSummary;
    const parts = [`共 ${s.total} 条记录`];
    if (s.verified > 0 || s.failed > 0 || s.unknown > 0 || s.skipped > 0) {
      parts.push(`成功 ${s.verified} 条`);
      parts.push(`失败 ${s.failed} 条`);
      if (s.unknown > 0) parts.push(`状态未知 ${s.unknown} 条`);
      if (s.skipped > 0) parts.push(`跳过/预填 ${s.skipped} 条`);
    }
    lines.push(`【总览】${parts.join('，')}。`);
  } else if (bundle.primary?.op === 'count') {
    lines.push(`【总览】共 ${bundle.primary.total} 条记录。`);
  }

  if (bundle.unitVerifiedDistribution) {
    const items = bundle.unitVerifiedDistribution.groups
      .map((g) => `${g.key}: ${g.count}条 (${g.percent})`)
      .join('；');
    lines.push(`【按供电单位成功分布 (共 ${bundle.unitVerifiedDistribution.total} 条成功)】${items || '无成功记录'}`);
  }
  if (bundle.unitDistribution && !bundle.unitVerifiedDistribution) {
    const items = bundle.unitDistribution.groups
      .map((g) => `${g.key}: ${g.count}条 (${g.percent})`)
      .join('；');
    lines.push(`【按供电单位分布】${items}`);
  }
  if (bundle.voltageDistribution) {
    const items = bundle.voltageDistribution.groups
      .map((g) => `${g.key}: ${g.count}条 (${g.percent})`)
      .join('；');
    lines.push(`【按电压等级分布】${items}`);
  }
  if (bundle.metricStats) {
    lines.push(
      `【数值统计 (${bundle.metricStats.metricField})】合计 ${bundle.metricStats.sum}（有效 ${bundle.metricStats.validCount} 条，均值 ${bundle.metricStats.avg}）。`
    );
  }
  if (bundle.errorBreakdown) {
    const eb = bundle.errorBreakdown;
    if (eb.totalFailed === 0) {
      lines.push('【失败原因分布】无失败记录。');
    } else {
      const items = eb.items
        .map((it) => `${it.reason}: ${it.count}条 (占失败 ${it.percentOfFailed}，行号 ${it.rowIndices.join(',')})`)
        .join('；');
      lines.push(`【失败原因占比 (共 ${eb.totalFailed} 条失败)】${items}`);
    }
  }
  if (!lines.length && bundle.primary) {
    lines.push(`统计结果：${JSON.stringify(bundle.primary)}`);
  }
  lines.push(`【证据索引】${bundle.evidenceRefs.join(', ')}`);
  return lines.join('\n');
}

/**
 * 端到端数据分布追问入口：
 * 1. records 为空或缺少目标维度时严格拒答；
 * 2. planQuery 映射白名单算子；
 * 3. 代码确定性 reduce 计算后由 explainRun / 模板带 evidenceRefs 作答。
 */
export async function answerRunQuestion({
  question,
  records = [],
  recordSchema = [],
  runSummary = null,
  aiClient = null
} = {}) {
  const q = String(question || '').trim();
  if (!q) {
    return {
      ok: true,
      cannotCompute: true,
      mode: 'rule',
      degraded: false,
      answer: '请输入需要查询的统计问题，例如“成功多少条、按单位分布、失败原因占比或总电量合计”。',
      evidenceRefs: [],
      caveats: ['问题为空'],
      computedEvidence: null
    };
  }

  if (!Array.isArray(records) || records.length === 0) {
    return {
      ok: true,
      cannotCompute: true,
      mode: 'guard',
      degraded: false,
      answer:
        '当前运行未采集到可计算的结构化明细（records 为空），严格按防幻觉规则拒答，不推测或虚构数据分布。',
      evidenceRefs: [],
      caveats: ['records 为空'],
      computedEvidence: null
    };
  }

  const schema = inferSchemaFromRecords(records, recordSchema);
  const schemaKeys = new Set(schema.map((s) => s.key));

  // 先做严格维度缺失检查
  const rulePlan = fallbackPlanQuery({ question: q, recordSchema: schema, records });
  if (rulePlan.op === null && rulePlan.cannotComputeReason) {
    return {
      ok: true,
      cannotCompute: true,
      mode: 'guard',
      degraded: false,
      answer: rulePlan.cannotComputeReason,
      evidenceRefs: [`records:1..${records.length}`],
      caveats: [rulePlan.cannotComputeReason],
      computedEvidence: null
    };
  }

  let plan = rulePlan;
  let mode = 'fallback';
  let degraded = false;
  let totalLatencyMs = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let lastModel = null;
  let lastUsage = null;
  let retried = false;
  let degradedReason = null;

  const accumulateMeta = (aiRes) => {
    if (!aiRes) return;
    totalLatencyMs += Number(aiRes.latencyMs || 0);
    if (aiRes.model) lastModel = aiRes.model;
    if (aiRes.retried) retried = true;
    if (aiRes.usage && typeof aiRes.usage === 'object') {
      totalPrompt += Number(aiRes.usage.prompt_tokens || 0);
      totalCompletion += Number(aiRes.usage.completion_tokens || 0);
      lastUsage = { prompt_tokens: totalPrompt, completion_tokens: totalCompletion };
    }
  };

  if (aiClient?.planQuery) {
    const aiPlanRes = await aiClient.planQuery({
      question: q,
      recordSchema: schema,
      allowedOps: ALLOWED_QUERY_OPS
    });
    accumulateMeta(aiPlanRes);
    if (aiPlanRes?.ok && aiPlanRes.data) {
      if (aiPlanRes.data.op === null && aiPlanRes.data.cannotComputeReason) {
        return {
          ok: true,
          cannotCompute: true,
          mode: aiPlanRes.mode || 'remote',
          degraded: false,
          answer: aiPlanRes.data.cannotComputeReason,
          evidenceRefs: [`records:1..${records.length}`],
          caveats: [aiPlanRes.data.cannotComputeReason],
          computedEvidence: null,
          meta: {
            mode: aiPlanRes.mode || 'remote',
            model: lastModel,
            latencyMs: totalLatencyMs,
            usage: lastUsage,
            retried,
            degradedReason: null
          }
        };
      }
      plan = aiPlanRes.data;
      mode = aiPlanRes.mode || 'remote';
    } else {
      degraded = true;
      degradedReason = aiPlanRes?.message || aiPlanRes?.errorCode || 'planQuery 失败已降级';
    }
  }

  const primaryExec = executeQueryPlan(plan, records, schema);
  if (!primaryExec.ok) {
    return {
      ok: true,
      cannotCompute: true,
      mode,
      degraded,
      answer: primaryExec.reason,
      evidenceRefs: [`records:1..${records.length}`],
      caveats: [primaryExec.reason],
      computedEvidence: null,
      meta: {
        mode,
        model: lastModel,
        latencyMs: totalLatencyMs,
        usage: lastUsage,
        retried,
        degradedReason
      }
    };
  }

  // 计算复合子指标（全使用手写 reduce 确定性算子）
  const unitKey = hasDimension(schemaKeys, records, ['orgName', 'unit']);
  const voltageKey = hasDimension(schemaKeys, records, ['voltage', 'voltageLevel']);
  const kwhKey =
    hasDimension(schemaKeys, records, ['kwh']) ||
    schema.find((s) => s.type === 'number' && s.key !== 'rowIndex')?.key;
  const hasBatchStatus = records.some((r) =>
    ['verified', 'failed', 'unknown', 'skipped', 'unverified'].includes(
      String(r?.status || '').toLowerCase()
    )
  );

  const computedEvidence = {
    totalRecords: records.length,
    primary: primaryExec.result,
    evidenceRefs: [`records:1..${records.length}`]
  };

  if (hasBatchStatus || /成功|失败|多少|总计|状态|汇总/.test(q)) {
    const stGroup = groupCount(records, 'status');
    computedEvidence.statusSummary = {
      total: records.length,
      verified: stGroup.counts.verified || 0,
      failed: stGroup.counts.failed || 0,
      unknown: stGroup.counts.unknown || 0,
      skipped: stGroup.counts.skipped || 0,
      ...(stGroup.counts.unverified ? { unverified: stGroup.counts.unverified } : {})
    };
    if (runSummary?.id) computedEvidence.evidenceRefs.push(`run:${runSummary.id}`);
  }

  if (unitKey && /单位|供电所|分布|占比|汇总/.test(q)) {
    computedEvidence.unitDistribution = groupCount(records, unitKey);
    if (hasBatchStatus && /成功/.test(q)) {
      computedEvidence.unitVerifiedDistribution = groupCount(records, unitKey, {
        filterStatus: 'verified'
      });
    }
  }

  if (voltageKey && /电压|分布|占比|汇总/.test(q)) {
    computedEvidence.voltageDistribution = groupCount(records, voltageKey);
  }

  if (kwhKey && /电量|合计|总计|总和|平均|均值|汇总|kwh/i.test(q)) {
    const s = sumField(records, kwhKey);
    const a = avgField(records, kwhKey);
    computedEvidence.metricStats = {
      metricField: kwhKey,
      sum: s.sum,
      avg: a.avg,
      validCount: s.validCount
    };
  }

  if (hasBatchStatus && /失败|原因|异常|报错|占比/.test(q)) {
    const eb = filterTopErrors(records);
    computedEvidence.errorBreakdown = eb;
    computedEvidence.failedRows = listFailedRows(records).rows;
    const failedRowIds = eb.items
      .flatMap((it) => it.rowIndices)
      .sort((a, b) => Number(a) - Number(b));
    if (failedRowIds.length) {
      computedEvidence.evidenceRefs.push(`failedRows:${failedRowIds.join(',')}`);
    }
  }

  const caveats = [];
  if (hasBatchStatus && (computedEvidence.statusSummary?.unknown || 0) > 0) {
    caveats.push('存在写入状态未知行，需人工核对后方可计入最终成功数');
  }

  // 离线 Mock 或无远端模型时，使用确定性格式化保证数字 100% 精准；远程模式由 explainRun 组织自然语言
  if (mode === 'remote' && aiClient?.explainRun) {
    const expRes = await aiClient.explainRun({ question: q, computedEvidence });
    accumulateMeta(expRes);
    if (expRes?.ok && expRes.data) {
      return {
        ok: true,
        cannotCompute: false,
        mode: expRes.mode || 'remote',
        degraded,
        plan,
        computedEvidence,
        answer: expRes.data.answer,
        evidenceRefs: Array.from(
          new Set([...computedEvidence.evidenceRefs, ...(expRes.data.evidenceRefs || [])])
        ),
        caveats: [...caveats, ...(expRes.data.caveats || [])],
        meta: {
          mode: expRes.mode || 'remote',
          model: lastModel,
          latencyMs: totalLatencyMs,
          usage: lastUsage,
          retried,
          degradedReason
        }
      };
    }
    degraded = true;
    degradedReason = expRes?.message || expRes?.errorCode || degradedReason || 'explainRun 失败已降级';
  }

  return {
    ok: true,
    cannotCompute: false,
    mode,
    degraded,
    plan,
    computedEvidence,
    answer: formatDeterministicExplanation(q, computedEvidence),
    evidenceRefs: computedEvidence.evidenceRefs,
    caveats,
    meta: {
      mode,
      model: lastModel,
      latencyMs: totalLatencyMs,
      usage: lastUsage,
      retried,
      degradedReason
    }
  };
}
