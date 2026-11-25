"use strict";

import { redactObject } from './sanitizer.js';

/**
 * 网页表格与提交回执结构化抽取模块：
 * 将 content.js 采集的原始二维行或回执 DOM 数据规范化为标准 records[] 与 recordSchema。
 */

const HEADER_META_RULES = [
  { re: /客户批号|批号|batch/i, key: 'batchCode', type: 'string' },
  { re: /供电单位|查询单位|单位|org|unit/i, key: 'orgName', type: 'string' },
  { re: /电压等级|电压|voltage/i, key: 'voltage', type: 'string' },
  { re: /查询月份|月份|month/i, key: 'month', type: 'string' },
  { re: /表计编号|表计|meter/i, key: 'meterNo', type: 'string' },
  { re: /回执单号|工单号|单号|receipt/i, key: 'receiptNo', type: 'string' },
  { re: /申报电量|电量|kwh/i, key: 'kwh', type: 'number' },
  { re: /失败原因|错误信息|error/i, key: 'error', type: 'string' },
  { re: /状态|status/i, key: 'status', type: 'status' },
  { re: /备注|remark/i, key: 'remark', type: 'string' }
];

export function inferColumnMeta(headerText, index) {
  const label = String(headerText || '').trim() || `列${index + 1}`;
  for (const rule of HEADER_META_RULES) {
    if (rule.re.test(label)) {
      return { key: rule.key, label, type: rule.type };
    }
  }
  return { key: `col_${index + 1}`, label, type: 'string' };
}

function coerceCellValue(rawVal, type) {
  const s = rawVal === undefined || rawVal === null ? '' : String(rawVal).trim();
  if (type === 'number') {
    const cleaned = s.replace(/,/g, '');
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : s;
  }
  return s;
}

function resolveColumns(headers = [], specCols = null) {
  if (Array.isArray(specCols) && specCols.length > 0) {
    return specCols.map((c, idx) => {
      const colIdx =
        typeof c.index === 'number'
          ? c.index
          : c.header
            ? headers.findIndex((h) => h === c.header || h.includes(c.header))
            : idx;
      const resolvedIndex = colIdx >= 0 ? colIdx : idx;
      const inferred = inferColumnMeta(c.label || c.header || headers[resolvedIndex] || c.key, idx);
      return {
        key: String(c.key || inferred.key),
        label: String(c.label || c.header || headers[resolvedIndex] || c.key || inferred.label),
        type: c.type || inferred.type,
        index: resolvedIndex
      };
    });
  }

  const usedKeys = new Set();
  return headers.map((h, idx) => {
    const base = inferColumnMeta(h, idx);
    let key = base.key;
    let n = 2;
    while (usedKeys.has(key)) key = `${base.key}_${n++}`;
    usedKeys.add(key);
    return {
      key,
      label: base.label,
      type: base.type,
      index: idx
    };
  });
}

/**
 * 规范化二维结果表（如系统 A #result-table）。
 */
export function normalizeTableRecords(rawExtraction, spec = {}) {
  const found = Boolean(rawExtraction?.found);
  const headers = Array.isArray(rawExtraction?.headers) ? rawExtraction.headers : [];
  const rawRows = Array.isArray(rawExtraction?.rawRows) ? rawExtraction.rawRows : [];

  const maxRowWidth = rawRows.reduce((max, r) => Math.max(max, Array.isArray(r) ? r.length : 0), 0);
  const effectiveHeaders =
    headers.length > 0 ? headers : Array.from({ length: maxRowWidth }, (_, i) => `列${i + 1}`);
  const cols = resolveColumns(effectiveHeaders, spec?.columns);

  const records = rawRows.map((cells, rowIdx) => {
    const rec = { rowIndex: rowIdx + 1 };
    for (const col of cols) {
      rec[col.key] = coerceCellValue(cells?.[col.index], col.type);
    }
    return redactObject(rec);
  });

  const recordSchema = cols.map((c) => ({
    key: c.key,
    label: c.label,
    type: c.type === 'number' ? 'number' : c.type === 'status' ? 'status' : 'string'
  }));

  const evidenceLevel = records.length > 0 ? 'L2' : found ? 'L1' : 'L0';
  return {
    mode: 'table',
    found,
    records,
    recordSchema,
    evidenceLevel,
    rowCount: records.length
  };
}

function readBySourcePath(contextRow, sourceExpr) {
  const expr = String(sourceExpr || '');
  if (!expr) return undefined;
  const key = expr.startsWith('row.') ? expr.slice(4) : expr;
  return contextRow?.[key];
}

/**
 * 规范化表单回执明细（如系统 B #receipt-box / #receipt-status / #receipt-no / #receipt-error）。
 */
export function normalizeReceiptRecord(rawExtraction, spec = {}, contextRow = {}) {
  const found = Boolean(rawExtraction?.found);
  const rawStatus = String(rawExtraction?.statusAttr || rawExtraction?.statusText || '')
    .trim()
    .toLowerCase();
  const errorText = String(rawExtraction?.errorText || '').trim();
  const boxText = String(rawExtraction?.boxText || '').trim();
  const extractedFields = rawExtraction?.extractedFields || {};
  const receiptNo = String(extractedFields.receiptNo || '').trim();

  let receiptStatus = 'unknown';
  let evidenceLevel = 'L0';

  if (!found || !rawStatus || rawStatus === 'idle') {
    receiptStatus = 'unknown';
    evidenceLevel = 'L0';
  } else if (
    rawStatus === 'error' ||
    rawStatus === 'failed' ||
    rawStatus === 'fail' ||
    Boolean(errorText) ||
    /提交失败|校验不通过|失败：/.test(boxText)
  ) {
    receiptStatus = 'failed';
    evidenceLevel = 'L2';
  } else if (rawStatus === 'ok' || rawStatus === 'success' || rawStatus === '已入库') {
    receiptStatus = 'verified';
    evidenceLevel = receiptNo && receiptNo !== '-' ? 'L2' : 'L1';
  } else {
    receiptStatus = 'unknown';
    evidenceLevel = 'L0';
  }

  const merged = {};
  if (contextRow && typeof contextRow === 'object') {
    for (const [k, v] of Object.entries(contextRow)) {
      if (v !== undefined) merged[k] = v;
    }
  }

  for (const field of Array.isArray(spec?.fields) ? spec.fields : []) {
    if (!field?.key) continue;
    let val =
      field.source !== undefined
        ? readBySourcePath(contextRow, field.source)
        : extractedFields[field.key];
    if (field.type === 'number' && val !== undefined && val !== null && val !== '') {
      val = coerceCellValue(val, 'number');
    }
    if (val !== undefined) merged[field.key] = val;
  }

  merged.status = receiptStatus;
  merged.receiptNo = receiptNo || '-';
  merged.error =
    receiptStatus === 'failed'
      ? errorText || boxText || '业务校验失败'
      : receiptStatus === 'unknown'
        ? errorText || 'WRITE_OUTCOME_UNKNOWN'
        : '';
  merged.rawStatus = rawStatus || 'unknown';
  if (boxText) merged.message = boxText;

  const safeRecord = redactObject(merged);
  const schemaEntries = new Map();
  const addSchema = (key, label, type) => {
    if (!schemaEntries.has(key)) schemaEntries.set(key, { key, label, type });
  };
  addSchema('status', '执行状态', 'status');
  addSchema('receiptNo', '回执单号', 'string');
  addSchema('error', '失败原因', 'string');
  for (const field of Array.isArray(spec?.fields) ? spec.fields : []) {
    if (field?.key) {
      addSchema(field.key, field.label || field.key, field.type === 'number' ? 'number' : 'string');
    }
  }
  for (const [k, v] of Object.entries(safeRecord)) {
    if (['status', 'receiptNo', 'error', 'rawStatus', 'message'].includes(k)) continue;
    addSchema(k, k, typeof v === 'number' ? 'number' : 'string');
  }

  return {
    mode: 'receipt',
    found,
    records: [safeRecord],
    recordSchema: Array.from(schemaEntries.values()),
    evidenceLevel,
    receiptStatus,
    receiptNo: safeRecord.receiptNo,
    errorText: safeRecord.error
  };
}

/**
 * 统一入口：按 spec.mode 分发解析页面结构化采集结果。
 */
export function extractStructuredRecords(rawExtraction, spec = {}, contextRow = {}) {
  if (spec?.mode === 'receipt') {
    return normalizeReceiptRecord(rawExtraction, spec, contextRow);
  }
  return normalizeTableRecords(rawExtraction, spec);
}
