"use strict";

import { redactObject, sanitizeUrl } from './sanitizer.js';

/**
 * 轻量化 DOM 语义蒸馏器与压缩率/Token 估算模块（服务课题 #60 硬指标评测）。
 */

export function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text || '')).length;
}

/**
 * 面向中英混排的保守 Token 估算（ASCII ~4 字符/token，中文/非 ASCII ~0.9 token/字符）。
 */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) <= 0x7f) asciiCount++;
    else nonAsciiCount++;
  }
  return Math.ceil(asciiCount / 4 + nonAsciiCount * 0.9);
}

function compactText(str, maxLen = 60) {
  const s = String(str || '').replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function compactNode(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { i: index };
  if (raw.tag) out.tag = String(raw.tag);
  if (raw.type) out.type = String(raw.type);
  if (raw.testId) out.testId = compactText(raw.testId, 50);
  if (raw.stableId) out.stableId = compactText(raw.stableId, 50);
  if (raw.label) out.label = compactText(raw.label, 60);
  if (raw.ariaLabel && raw.ariaLabel !== raw.label) {
    out.ariaLabel = compactText(raw.ariaLabel, 60);
  }
  if (raw.text) out.text = compactText(raw.text, 60);
  if (raw.placeholder) out.placeholder = compactText(raw.placeholder, 50);
  if (raw.anchor) out.anchor = compactText(raw.anchor, 50);
  if (raw.cssPath) out.cssPath = compactText(raw.cssPath, 100);
  if (raw.sensitive) out.sensitive = true;
  if (raw.auth) out.auth = true;
  // 铁律：蒸馏快照绝不携带页面输入值
  return out;
}

function compactPageContext(rawCtx) {
  const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
  const headings = Array.isArray(ctx.headings)
    ? ctx.headings.map((h) => compactText(h, 60)).filter(Boolean).slice(0, 6)
    : [];
  const selectOptionsSample = {};
  if (ctx.selectOptionsSample && typeof ctx.selectOptionsSample === 'object') {
    for (const [k, opts] of Object.entries(ctx.selectOptionsSample).slice(0, 6)) {
      if (Array.isArray(opts)) {
        selectOptionsSample[compactText(k, 40)] = opts
          .map((o) => compactText(o, 30))
          .filter(Boolean)
          .slice(0, 8);
      }
    }
  }
  return {
    title: compactText(ctx.title, 80),
    headings,
    selectOptionsSample
  };
}

/**
 * 将页面原始采集结果裁剪为轻量语义快照，并真实计算 rawBytes / distilledBytes / compressionRatio。
 */
export function pickPreferredStatusSelector(statusContainers = []) {
  const list = Array.isArray(statusContainers) ? statusContainers : [];
  const isTableSel = (sel) => /(?:^|[.#_-\s])table\b/i.test(String(sel || '').trim());
  const candidates = list
    .map((c) => ({
      selector: compactText(c?.selector || '', 80),
      dataStatus: compactText(c?.dataStatus || '', 20)
    }))
    .filter((c) => c.selector && !isTableSel(c.selector));

  if (!candidates.length) return '';

  const exactPriority = ['#receipt-status', '#result-summary', '#result', '#receipt-box'];
  for (const target of exactPriority) {
    const hit = candidates.find((c) => c.selector === target);
    if (hit) return hit.selector;
  }

  const semanticHit = candidates.find(
    (c) => Boolean(c.dataStatus) || /status|summary|result|receipt|toast|msg/i.test(c.selector)
  );
  if (semanticHit) return semanticHit.selector;

  return candidates[0].selector || '';
}

export function distillSnapshot(rawExtraction, opts = {}) {
  const maxNodes = Math.min(Math.max(Number(opts.maxNodes || 60), 1), 120);
  const maxChars = Math.min(Math.max(Number(opts.maxChars || 12000), 1000), 24000);

  const rawBytes = Math.max(0, Number(rawExtraction?.rawBytes || 0));
  const rawNodes = Array.isArray(rawExtraction?.nodes) ? rawExtraction.nodes : [];
  const pageContext = redactObject(compactPageContext(rawExtraction?.pageContext));
  const tables = redactObject(
    (Array.isArray(rawExtraction?.tables) ? rawExtraction.tables : []).slice(0, 6).map((t) => ({
      selector: compactText(t?.selector, 80),
      headers: Array.isArray(t?.headers)
        ? t.headers.map((h) => compactText(h, 30)).filter(Boolean).slice(0, 10)
        : [],
      rowCount: Number(t?.rowCount || 0)
    }))
  );
  const statusContainers = redactObject(
    (Array.isArray(rawExtraction?.statusContainers) ? rawExtraction.statusContainers : [])
      .slice(0, 6)
      .map((c) => ({
        selector: compactText(c?.selector, 80),
        dataStatus: compactText(c?.dataStatus, 20),
        text: compactText(c?.text, 80)
      }))
  );

  let snapshot = [];
  for (let i = 0; i < rawNodes.length && snapshot.length < maxNodes; i++) {
    const node = compactNode(rawNodes[i], snapshot.length + 1);
    if (node) snapshot.push(node);
  }
  snapshot = redactObject(snapshot);

  const buildPayloadObj = (nodes) => ({
    pageContext,
    tables,
    statusContainers,
    snapshot: nodes
  });

  let serialized = JSON.stringify(buildPayloadObj(snapshot));
  while (serialized.length > maxChars && snapshot.length > 5) {
    snapshot = snapshot.slice(0, Math.max(5, Math.floor(snapshot.length * 0.8)));
    serialized = JSON.stringify(buildPayloadObj(snapshot));
  }

  const distilledBytes = utf8ByteLength(serialized);
  const compressionRatio =
    rawBytes > 0 ? Number(Math.max(0, (rawBytes - distilledBytes) / rawBytes).toFixed(4)) : 0;
  const estimatedTokens = estimateTokens(serialized);

  if (snapshot.length === 0) {
    return {
      ok: false,
      errorCode: 'DOM_DISTILL_EMPTY',
      message: '页面未能蒸馏出可见交互节点，请确认目标页面或 iframe 边界',
      rawBytes,
      distilledBytes,
      compressionRatio,
      estimatedTokens,
      nodeCount: 0,
      snapshot: [],
      pageContext,
      tables,
      statusContainers
    };
  }

  return {
    ok: true,
    rawBytes,
    distilledBytes,
    compressionRatio,
    estimatedTokens,
    nodeCount: snapshot.length,
    snapshot,
    pageContext,
    tables,
    statusContainers
  };
}

/**
 * 为 AI analyzeTrace 生成脱敏且硬控 ≤ 5500 Tokens 的轻量轨迹摘要。
 */
export function buildTraceSummaryForAI(session, distilled = null, opts = {}) {
  const maxPromptTokens = Math.min(Number(opts.maxTokens || 5500), 6000);
  const steps = Array.isArray(session?.steps) ? session.steps : [];

  const compactSteps = steps.map((s) => {
    const isSensitive = Boolean(s?.sensitive || s?.action === 'auth_checkpoint' || s?.action === 'manual');
    const out = {
      id: String(s?.id || ''),
      action: String(s?.action || ''),
      origin: String(s?.origin || ''),
      url: s?.url ? sanitizeUrl(s.url) : ''
    };
    if (s?.target && typeof s.target === 'object') {
      out.target = {};
      for (const k of ['testId', 'stableId', 'label', 'text', 'tag', 'type', 'cssPath']) {
        if (s.target[k]) out.target[k] = compactText(s.target[k], 60);
      }
    }
    if (!isSensitive && s?.value !== undefined) {
      out.sampleValue = compactText(s.value, 60);
    }
    if (isSensitive) out.sensitive = true;
    if (s?.action === 'auth_checkpoint') {
      out.authSelector = s.authSelector || '';
      out.loggedInIndicator = s.loggedInIndicator || '';
    }
    return out;
  });

  let distilledSnapshot = Array.isArray(distilled?.snapshot) ? [...distilled.snapshot] : [];
  const pageContext = distilled?.pageContext || {
    title: compactText(session?.name || '', 80),
    headings: [],
    selectOptionsSample: {}
  };

  const makePayload = () =>
    redactObject({
      sessionName: compactText(session?.name || '', 60),
      startUrl: sanitizeUrl(session?.startUrl || ''),
      allowedOrigins: Array.isArray(session?.allowedOrigins) ? session.allowedOrigins : [],
      steps: compactSteps,
      tables: distilled?.tables || [],
      statusContainers: distilled?.statusContainers || [],
      domSample: distilledSnapshot
    });

  let traceSummary = makePayload();
  let serialized = JSON.stringify({ traceSummary, pageContext });
  let tokens = estimateTokens(serialized);

  while (tokens > maxPromptTokens && distilledSnapshot.length > 0) {
    distilledSnapshot = distilledSnapshot.slice(0, Math.floor(distilledSnapshot.length * 0.6));
    traceSummary = makePayload();
    serialized = JSON.stringify({ traceSummary, pageContext });
    tokens = estimateTokens(serialized);
  }

  return {
    traceSummary,
    pageContext,
    estimatedTokens: tokens,
    rawBytes: Number(distilled?.rawBytes || 0),
    distilledBytes: Number(distilled?.distilledBytes || utf8ByteLength(serialized)),
    compressionRatio: Number(distilled?.compressionRatio || 0)
  };
}
