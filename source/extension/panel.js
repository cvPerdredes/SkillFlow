"use strict";

import { createAiClient } from './lib/ai-client.js';
import {
  applyBatchLoopPartition,
  autoMapCsvColumns,
  createBatchRunner,
  extractFailedRowsForRetry,
  parseCsv,
  validateAndBindBatchRows
} from './lib/batch-runner.js';
import { extractArgsFromInput, matchSkillByQuery } from './lib/clarification.js';
import { pickPreferredStatusSelector } from './lib/dom-distiller.js';
import { createDriver } from './lib/driver.js';
import {
  buildPlanSnapshot,
  canonicalJson,
  isRiskStep,
  normalizeAndValidateRuntimeArgs,
  normalizeTargetOrigins
} from './lib/plan-builder.js';
import { answerRunQuestion } from './lib/result-qa.js';
import { createRunController } from './lib/run-controller.js';
import { safeOriginOf, sanitizeUrl } from './lib/sanitizer.js';
import { PARAM_TYPES, validateSkillIR } from './lib/schemas.js';
import {
  analyzeRecordedTrace,
  applyDraftToSkillIR,
  applyRebindToSkill,
  buildExtractStepFromPick,
  buildSanitizedPreviewPayload,
  insertExtractStep
} from './lib/skill-analyzer.js';
import {
  buildEvalTelemetryPayload,
  exportRecordsCsv,
  exportSkillMarkdown,
  formatMcpToolJson
} from './lib/skill-exporter.js';
import { AI_PROVIDER_PRESETS, defaultStore, validateRemoteAiBaseUrl } from './lib/store.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_QA_ANSWER = '已接入确定性统计与防幻觉拒答护栏：无明细或缺少维度时将显式拒答。';

const state = {
  allSkills: [],
  allRuns: [],
  session: null,
  distilled: null,
  draft: null,
  loaded: null,
  recording: null,
  logs: [],
  records: [],
  recordSchema: [],
  lastRunSummary: null,
  lastResult: null,
  lastQuestion: null,
  pendingSnapshot: null,
  pendingResumeCheckpoint: null,
  activeCheckpoint: null,
  riskResolver: null,
  activeController: null,
  pendingRebind: null,
  rebindDriver: null,
  extractDriver: null,
  parsedCsv: null,
  csvMapping: {},
  boundBatchRows: null,
  userTouchedBatchLoop: false
};

const aiClient = createAiClient({
  getConfig: () => defaultStore.getAiConfig(),
  getApiKey: () => defaultStore.getAiApiKey(),
  onTelemetry: (stats) => renderAiTelemetry(stats)
});

function formatAiSourceBadge({
  mode = 'mock',
  model = null,
  latencyMs = 0,
  usage = null,
  retried = false,
  degraded = false,
  errorMessage = ''
} = {}) {
  if (degraded) {
    return `⚠ 已降级规则兜底：${errorMessage || '模型响应异常'}`;
  }
  if (mode === 'remote') {
    const pTok = Number(usage?.prompt_tokens || 0);
    const cTok = Number(usage?.completion_tokens || 0);
    const totalTok = pTok + cTok;
    const tokStr = totalTok > 0 ? ` · ${totalTok} tokens` : '';
    const msStr = latencyMs > 0 ? ` · ${latencyMs}ms` : '';
    const retryStr = retried ? ' · 重试1次通过' : '';
    return `远程 ${model || 'LLM'}${msStr}${tokStr}${retryStr}`;
  }
  return `Mock 离线 · ${latencyMs || 0}ms`;
}

const approvalClient = {
  approvePlan: ({ expectedPlanHash, payload }) =>
    chrome.runtime.sendMessage({ type: 'APPROVE_PLAN', expectedPlanHash, payload }),
  verifyPlan: ({ planHash, payload }) =>
    chrome.runtime.sendMessage({ type: 'VERIFY_PLAN', planHash, payload }),
  revokePlan: ({ planHash }) =>
    chrome.runtime.sendMessage({ type: 'REVOKE_PLAN', planHash })
};

const allowed = (url) => /^https?:\/\//.test(url || '');
const text = (e, t) => {
  if (e) e.textContent = String(t ?? '');
  return e;
};

function element(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content !== undefined) text(el, content);
  return el;
}

function message(s) {
  text($('message'), s);
}

function setStatus(enabled) {
  $('recordingTag').textContent = enabled ? '● 正在录制' : '未录制';
  $('recordingTag').classList.toggle('active', Boolean(enabled));
  $('start').disabled = enabled;
  $('stop').disabled = !enabled;
  renderSiteAuthBanner();
}

function renderSiteAuthBanner() {
  const banner = $('siteAuthBanner');
  if (!banner) return;
  const pendingOrigin = state.recording?.active ? state.recording?.pendingAuthOrigin : '';
  if (!pendingOrigin) {
    banner.hidden = true;
    return;
  }
  text(
    $('siteAuthText'),
    `检测到跨站跳转至未授权站点 ${pendingOrigin}，点击下方按钮授权后将自动续录（已录步骤不丢失）。`
  );
  banner.hidden = false;
}

async function focusedTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find((t) => allowed(t.url));
  if (!tab) throw new Error('请先在当前窗口打开一个 http/https 业务网页');
  return tab;
}

async function checkPermission(url, ask = true) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('仅支持 http/https 页面');
  const pattern = u.origin + '/*';
  const exists = await chrome.permissions.contains({ origins: [pattern] });
  if (exists) return;
  if (!ask) throw new Error(`SITE_NOT_ALLOWED: 目标站点 ${u.origin} 未授权`);
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) throw new Error('未获得该站点访问权限');
}

function describe(s) {
  if (s.action === 'navigate') return '导航至 ' + (s.url || '');
  if (s.action === 'auth_checkpoint') {
    return `人工登录/认证检查点 (${s.origin || safeOriginOf(s.url) || '当前站点'}) [凭据零保留]`;
  }
  if (s.action === 'manual') {
    const label = s.target?.label || s.target?.cssPath || '敏感字段';
    return `人工处理敏感输入: ${label} [零原值]`;
  }
  if (s.action === 'extract') {
    const loc = s.target?.testId || s.target?.stableId || s.target?.cssPath || s.target?.label || '节点';
    return `提取字段 → {{var.${s.outputVar || '(临时)'}}} (${loc})`;
  }
  const target = s.target?.label || s.target?.text || s.target?.cssPath || s.target?.css || '目标';
  if (s.action === 'fill' || s.action === 'select') {
    const valStr = s.valueRef?.rowField
      ? `{{row.${s.valueRef.rowField}}}`
      : s.valueRef?.var
        ? `{{var.${s.valueRef.var}}}`
        : s.value ?? '';
    return `${target}: ${valStr}`;
  }
  if (s.action === 'check') return `${target}: ${s.checked ? '勾选' : '取消勾选'}`;
  return `${s.action} · ${target}`;
}

function formatStepLocatorSummary(s) {
  if (!s) return '';
  if (s.action === 'navigate') return `origin: ${safeOriginOf(s.url) || s.origin || '-'}`;
  if (s.action === 'auth_checkpoint') return `auth: ${s.authSelector || '#login-form'}`;
  const t = s.target || {};
  const parts = [];
  if (t.testId) parts.push(`testId=${t.testId}`);
  if (t.stableId) parts.push(`id=${t.stableId}`);
  if (t.label) parts.push(`label=${t.label}`);
  if (t.cssPath) parts.push(`css=${t.cssPath}`);
  return parts.slice(0, 2).join(' · ') || 'locator: default';
}

async function deleteRecordedStep(index) {
  if (state.recording?.active || !state.session?.steps) return;
  const removed = state.session.steps[index];
  let nextSteps = state.session.steps.filter((_, i) => i !== index);
  if (
    removed?.action === 'extract' &&
    removed.outputVar &&
    !nextSteps.some((s) => s.action === 'extract' && s.outputVar === removed.outputVar)
  ) {
    nextSteps = nextSteps.map((s) => {
      if (s.valueRef?.var === removed.outputVar) {
        const copy = { ...s };
        delete copy.valueRef;
        return copy;
      }
      return s;
    });
  }
  const origins = normalizeTargetOrigins({
    startUrl: state.session.startUrl,
    steps: nextSteps
  });
  state.session = {
    ...state.session,
    steps: nextSteps,
    allowedOrigins: origins.length ? origins : state.session.allowedOrigins || []
  };
  state.draft = null;
  await defaultStore.setRecordingBundle({ currentSession: state.session });
  renderSteps();
  renderParameterEditor();
  renderDistillAndPreview();
  disableSave(!nextSteps.length);
  message(`已删除第 ${index + 1} 步（剩余 ${nextSteps.length} 步），可继续编辑或保存。`);
}

async function moveRecordedStep(index, delta) {
  if (state.recording?.active || !state.session?.steps) return;
  const target = index + delta;
  if (target < 0 || target >= state.session.steps.length) return;
  const nextSteps = [...state.session.steps];
  const [moved] = nextSteps.splice(index, 1);
  nextSteps.splice(target, 0, moved);
  const origins = normalizeTargetOrigins({
    startUrl: state.session.startUrl,
    steps: nextSteps
  });
  state.session = {
    ...state.session,
    steps: nextSteps,
    allowedOrigins: origins.length ? origins : state.session.allowedOrigins || []
  };
  state.draft = null;
  await defaultStore.setRecordingBundle({ currentSession: state.session });
  renderSteps();
  renderParameterEditor();
  renderDistillAndPreview();
  message(`已将第 ${index + 1} 步移动至第 ${target + 1} 步。`);
}

function renderSteps() {
  const list = $('steps');
  list.replaceChildren();
  const steps = state.session?.steps || [];
  const canEdit = !state.recording?.active && steps.length > 0;
  if ($('extractToolBox')) {
    $('extractToolBox').hidden = !canEdit;
  }
  if (!steps.length) {
    list.append(element('div', 'muted', '尚无动作'));
    return;
  }
  const annMap = new Map(
    (state.draft?.stepAnnotations || []).map((a) => [a.stepId, a.summary])
  );
  steps.forEach((s, i) => {
    const div = element('div', 'step');
    const main = element('div', 'step-main');
    main.append(
      element('div', null, describe(s)),
      element('div', 'step-locator', formatStepLocatorSummary(s))
    );
    const annText = annMap.get(s.id);
    if (annText) {
      main.append(element('div', 'step-ai-note', `AI 摘要：${annText}`));
    }
    div.append(element('b', null, `#${i + 1} ${s.action}`), main);
    if (!state.recording?.active) {
      const actions = element('div', 'step-actions');
      const upBtn = element('button', 'btn-step-move', '↑');
      upBtn.type = 'button';
      upBtn.title = '上移一步';
      upBtn.disabled = i === 0;
      upBtn.addEventListener('click', () => {
        moveRecordedStep(i, -1).catch((e) => message('移动步骤失败：' + e.message));
      });
      const downBtn = element('button', 'btn-step-move', '↓');
      downBtn.type = 'button';
      downBtn.title = '下移一步';
      downBtn.disabled = i === steps.length - 1;
      downBtn.addEventListener('click', () => {
        moveRecordedStep(i, 1).catch((e) => message('移动步骤失败：' + e.message));
      });
      const delBtn = element('button', 'btn-step-del', '删除');
      delBtn.type = 'button';
      delBtn.addEventListener('click', () => {
        deleteRecordedStep(i).catch((e) => message('删除步骤失败：' + e.message));
      });
      actions.append(upBtn, downBtn, delBtn);
      div.append(actions);
    }
    list.append(div);
  });
}

function renderDistillAndPreview() {
  const metricsEl = $('distillMetrics');
  if (state.distilled && state.distilled.rawBytes > 0) {
    const pct = (state.distilled.compressionRatio * 100).toFixed(1);
    text(
      metricsEl,
      `DOM 蒸馏：原始 ${state.distilled.rawBytes}B → 蒸馏 ${state.distilled.distilledBytes}B（压缩 ${pct}% · ~${state.distilled.estimatedTokens} tokens · ${state.distilled.nodeCount} 节点）`
    );
    metricsEl.hidden = false;
  } else {
    metricsEl.hidden = true;
  }

  const wrap = $('sanitizedPreviewWrap');
  if (state.session?.steps?.length) {
    const preview = buildSanitizedPreviewPayload({
      session: state.session,
      distilled: state.distilled
    });
    text($('sanitizedPreviewJson'), preview.previewJson);
    wrap.hidden = false;
  } else {
    wrap.hidden = true;
  }
}

function proposeBaseName(s, i) {
  const p = (s.target?.label || s.target?.placeholder || s.target?.name || '').toLowerCase();
  if (/月份|月度|month/.test(p) || s.target?.type === 'month') return { key: 'month', type: 'month' };
  if (/日期|时间|date/.test(p) || s.target?.type === 'date') return { key: 'date', type: 'date' };
  if (/批号|batch/.test(p)) return { key: 'batchCode', type: 'string' };
  if (/表计|meter/.test(p)) return { key: 'meterNo', type: 'string' };
  if (/电量|kwh/.test(p) || s.target?.type === 'number') return { key: 'kwh', type: 'number' };
  if (/电压|voltage/.test(p)) return { key: 'voltage', type: 'string' };
  if (/备注|remark/.test(p)) return { key: 'remark', type: 'string' };
  if (/供电单位|单位|部门|organization|unit|org/.test(p)) return { key: 'orgName', type: 'string' };
  if (/客户|customer/.test(p)) return { key: 'customer', type: 'string' };
  return { key: `field${i + 1}`, type: 'string' };
}

function renderParameterEditor(draftCandidates = null) {
  const host = $('parameterEditor');
  host.replaceChildren();
  const steps = state.session?.steps || [];
  const draftByStep = new Map((draftCandidates || []).map((c) => [c.sourceStepId, c]));
  const extractVars = Array.from(
    new Set(steps.filter((s) => s.action === 'extract' && s.outputVar).map((s) => s.outputVar))
  );
  const usedCounts = new Map();
  let count = 0;

  steps.forEach((s, index) => {
    if (!['fill', 'select'].includes(s.action)) return;
    if (s.sensitive || s.action === 'auth_checkpoint' || s.action === 'manual') return;
    count++;

    const draftMatch = draftByStep.get(s.id);
    const baseInfo = draftMatch
      ? { key: draftMatch.key, type: draftMatch.type || 'string' }
      : proposeBaseName(s, index);
    const seen = (usedCounts.get(baseInfo.key) || 0) + 1;
    usedCounts.set(baseInfo.key, seen);
    const uniqueName = seen === 1 ? baseInfo.key : `${baseInfo.key}_${seen}`;

    const box = element('div', 'param');
    const title = element('label', 'toggle');
    const cb = element('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.index = index;
    cb.className = 'parameter-check';
    title.append(
      cb,
      document.createTextNode('  ' + (s.target?.label || s.target?.cssPath || s.target?.css || '输入参数'))
    );

    const row = element('div', 'row');
    const key = element('input');
    key.value = uniqueName;
    key.placeholder = '变量名';
    key.className = 'parameter-key';
    key.dataset.index = index;

    const typeSel = element('select');
    typeSel.className = 'parameter-type';
    typeSel.dataset.index = index;
    for (const t of PARAM_TYPES.filter((pt) => pt !== 'dataset')) {
      const opt = element('option', null, t);
      opt.value = t;
      typeSel.append(opt);
    }
    typeSel.value = PARAM_TYPES.includes(baseInfo.type) ? baseInfo.type : 'string';

    row.append(key, typeSel);
    box.append(title, row);

    if (extractVars.length > 0) {
      const srcRow = element('div', 'param-source-row');
      const srcSel = element('select');
      srcSel.className = 'parameter-source';
      srcSel.dataset.index = index;
      const userOpt = element('option', null, '参数来源：用户输入 / CSV 列');
      userOpt.value = 'param';
      srcSel.append(userOpt);
      for (const vn of extractVars) {
        const vOpt = element('option', null, `参数来源：引用提取变量 {{var.${vn}}}`);
        vOpt.value = `var:${vn}`;
        srcSel.append(vOpt);
      }
      if (s.valueRef?.var && extractVars.includes(s.valueRef.var)) {
        srcSel.value = `var:${s.valueRef.var}`;
        key.disabled = true;
        typeSel.disabled = true;
      }
      srcSel.addEventListener('change', () => {
        const val = srcSel.value;
        const useVar = val.startsWith('var:');
        key.disabled = useVar;
        typeSel.disabled = useVar;
        const stepRef = state.session?.steps?.[index];
        if (stepRef) {
          if (useVar) {
            stepRef.valueRef = { var: val.slice(4) };
            delete stepRef.paramKey;
          } else {
            delete stepRef.valueRef;
          }
          defaultStore.setRecordingBundle({ currentSession: state.session }).catch(() => {});
        }
      });
      srcRow.append(srcSel);
      box.append(srcRow);
    }

    host.append(box);
  });

  if (!count) {
    host.append(element('div', 'muted', '录制中没有可参数化的非敏感填写/选择动作'));
  }
}

function disableSave(disabled) {
  $('saveSkill').disabled = disabled;
  $('downloadSkill').disabled = disabled;
  $('analyzeDraftBtn').disabled = disabled;
}

async function invalidateApproval(reason = '') {
  const prevHash = state.pendingSnapshot?.planHash || null;
  state.pendingSnapshot = null;
  state.pendingResumeCheckpoint = null;
  $('approvalCard').hidden = true;
  $('riskPrompt').hidden = true;
  $('pilotReviewCard').hidden = true;
  $('unknownWriteCard').hidden = true;
  if (state.riskResolver) {
    const resolve = state.riskResolver;
    state.riskResolver = null;
    resolve(false);
  }
  if (prevHash) {
    await approvalClient.revokePlan({ planHash: prevHash }).catch(() => {});
  }
  if (reason) message(reason);
}

async function start() {
  try {
    await invalidateApproval();
    const tab = await focusedTab();
    await checkPermission(tab.url, true);
    const startOrigin = new URL(tab.url).origin;
    state.session = {
      id: crypto.randomUUID(),
      schemaVersion: '0.3',
      version: 1,
      name: $('skillName').value.trim() || '未命名技能',
      startUrl: sanitizeUrl(tab.url),
      allowedOrigins: [startOrigin],
      createdAt: new Date().toISOString(),
      steps: [],
      resultSelector: ''
    };
    state.distilled = null;
    state.draft = null;
    state.recording = {
      active: true,
      tabId: tab.id,
      origin: startOrigin,
      pendingAuthOrigin: null,
      pendingAuthUrl: null
    };
    await defaultStore.setRecordingBundle({
      currentSession: state.session,
      recording: state.recording
    });

    const driver = createDriver('mv3-content', { tabId: tab.id, allowedOrigins: [startOrigin] });
    await driver.ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'SET_RECORDING', enabled: true });

    setStatus(true);
    disableSave(true);
    // 模块 A1：开始新录制时重置 02 区表单字段，避免上一个技能配置串入
    state.userTouchedBatchLoop = false;
    $('skillIntent').value = '';
    $('resultSelector').value = '';
    $('extractSpecPreset').value = 'none';
    $('enableBatchLoop').checked = false;
    $('pilotCountInput').value = '2';
    $('draftNotice').hidden = true;
    $('parameterEditor').replaceChildren(element('div', 'muted', '结束录制后生成'));
    if ($('extractToolBox')) $('extractToolBox').hidden = true;
    renderSteps();
    renderDistillAndPreview();
    message(`录制中（${startOrigin}）：请在业务页面正常操作，若跳转新系统请按提示授权续录。`);
  } catch (e) {
    message('无法开始录制：' + e.message);
  }
}

async function grantCurrentSiteForRecording() {
  try {
    if (!state.recording?.active) throw new Error('当前没有活动中的录制会话');
    const tab = state.recording.tabId
      ? await chrome.tabs.get(state.recording.tabId).catch(() => focusedTab())
      : await focusedTab();
    if (!tab?.url || !allowed(tab.url)) throw new Error('当前标签页不是有效 http/https 业务页面');
    await checkPermission(tab.url, true);
    const res = await chrome.runtime.sendMessage({
      type: 'AUTHORIZE_RECORDING_ORIGIN',
      tabId: tab.id,
      url: tab.url
    });
    if (!res?.ok) throw new Error(res?.message || '跨站续录授权失败');
    const bundle = await defaultStore.getRecordingBundle();
    state.session = bundle.currentSession || state.session;
    state.recording = bundle.recording || state.recording;
    renderSiteAuthBanner();
    renderSteps();
    message(`已授权站点 ${res.origin} 并恢复录制，已保留前序全部步骤（共 ${res.stepCount} 步）。`);
  } catch (e) {
    message('跨站授权失败：' + e.message);
  }
}

async function stop() {
  try {
    const bundle = await defaultStore.getRecordingBundle();
    state.session = bundle.currentSession || state.session;
    const recTabId = bundle.recording?.tabId;
    if (recTabId) {
      try {
        await chrome.tabs.sendMessage(recTabId, { type: 'SET_RECORDING', enabled: false });
      } catch (_) {}
      try {
        const driver = createDriver('mv3-content', {
          tabId: recTabId,
          allowedOrigins: normalizeTargetOrigins(state.session || {})
        });
        state.distilled = await driver.distillDom({ maxNodes: 60 });
      } catch (_) {
        state.distilled = null;
      }
    }
    state.recording = { active: false, pendingAuthOrigin: null, pendingAuthUrl: null };
    await defaultStore.setRecordingBundle({ recording: state.recording });
    setStatus(false);
    renderSteps();
    renderParameterEditor();
    renderDistillAndPreview();
    disableSave(!state.session?.steps?.length);
    message(
      `录制结束，共 ${state.session?.steps?.length || 0} 步。` +
        (state.distilled?.ok
          ? `DOM 已蒸馏（压缩率 ${(state.distilled.compressionRatio * 100).toFixed(1)}%）。`
          : '') +
        '可点击“AI 生成草稿”或直接审核保存。'
    );
  } catch (e) {
    message('结束录制失败：' + e.message);
  }
}

async function runAnalyzeDraft() {
  if (!state.session?.steps?.length) return;
  const btn = $('analyzeDraftBtn');
  try {
    btn.disabled = true;
    text(btn, 'AI 解析中...');
    const res = await analyzeRecordedTrace({
      session: state.session,
      distilled: state.distilled,
      aiClient
    });
    state.draft = res.draft;
    if (res.draft?.name) $('skillName').value = res.draft.name;
    if (res.draft?.intent) $('skillIntent').value = res.draft.intent;
    // 模块 A1：优先选用 statusContainers 状态节点，严禁将表格容器填入 resultSelector
    const preferredStatusSel =
      (res.draft?.resultSelectorHint &&
      !/(?:^|[.#_-\s])table\b/i.test(res.draft.resultSelectorHint)
        ? res.draft.resultSelectorHint
        : '') || pickPreferredStatusSelector(state.distilled?.statusContainers);
    if (preferredStatusSel && !$('resultSelector').value.trim()) {
      $('resultSelector').value = preferredStatusSel;
    }
    if (res.draft?.extractHint?.mode === 'table') {
      $('extractSpecPreset').value = 'sys_a_table';
    } else if (res.draft?.extractHint?.mode === 'receipt') {
      $('extractSpecPreset').value = 'sys_b_receipt';
    }

    const batchHintSuggested = Boolean(
      res.draft?.batchLoopHint &&
        Array.isArray(res.draft.batchLoopHint.rowSteps) &&
        res.draft.batchLoopHint.rowSteps.length > 0
    );
    let batchHintNote = '';
    if (batchHintSuggested) {
      if (!state.userTouchedBatchLoop && !$('enableBatchLoop').checked) {
        $('enableBatchLoop').checked = true;
        batchHintNote = '💡 AI 识别到重复填报特征，已自动勾选 1→N CSV 批量循环（可手动取消）。';
      } else if (!$('enableBatchLoop').checked) {
        batchHintNote = '💡 AI 建议：当前流程适合勾选“启用 1→N CSV 批量录入循环”。';
      }
    }

    renderSteps();
    renderParameterEditor(res.draft?.parameterCandidates || null);
    renderDistillAndPreview();

    const notice = $('draftNotice');
    const parts = [];
    const sourceBadge = formatAiSourceBadge(res);
    if (res.degraded) {
      parts.push(`${sourceBadge}（已回退规则草稿，不阻断保存）`);
    } else {
      parts.push(`✓ 草稿生成成功（${sourceBadge}）`);
    }
    if (batchHintNote) parts.push(batchHintNote);
    if (res.draft?.stepAnnotations?.length) {
      const topAnns = res.draft.stepAnnotations
        .slice(0, 4)
        .map((a) => `${a.stepId}: ${a.summary}`)
        .join('；');
      parts.push(`步骤摘要（${res.draft.stepAnnotations.length} 步）：${topAnns}`);
    }
    if (res.draft?.uncertainties?.length) {
      parts.push('不确定项：\n- ' + res.draft.uncertainties.join('\n- '));
    }
    text(notice, parts.join('\n'));
    notice.hidden = false;
  } catch (e) {
    message('草稿生成失败：' + e.message);
  } finally {
    text(btn, 'AI 生成草稿');
    btn.disabled = !state.session?.steps?.length;
  }
}

function buildExtractSpecFromPreset(preset, batchColumns = []) {
  if (preset === 'sys_a_table') {
    return { mode: 'table', containerSelector: '#result-table' };
  }
  if (preset === 'sys_b_receipt') {
    return {
      mode: 'receipt',
      containerSelector: '#receipt-box',
      statusSelector: '#receipt-status',
      errorSelector: '#receipt-error',
      fields: [
        { key: 'receiptNo', selector: '#receipt-no' },
        ...batchColumns.map((c) => ({
          key: c.key,
          label: c.label,
          source: `row.${c.key}`,
          ...(c.type === 'number' ? { type: 'number' } : {})
        }))
      ]
    };
  }
  return null;
}

function buildSkill() {
  if (!state.session?.steps?.length) throw new Error('没有可保存的步骤');
  const steps = state.session.steps;
  const collectedParams = [];
  const stepVarBindings = {};
  const used = new Set();

  for (const cb of document.querySelectorAll('.parameter-check')) {
    if (!cb.checked) continue;
    const i = Number(cb.dataset.index);
    const step = steps[i];
    if (!step || step.sensitive || step.action === 'auth_checkpoint' || step.action === 'manual') {
      continue;
    }
    const sourceVal = document.querySelector(`.parameter-source[data-index="${i}"]`)?.value || 'param';
    if (sourceVal.startsWith('var:')) {
      stepVarBindings[step.id] = sourceVal.slice(4);
      continue;
    }
    const key = document.querySelector(`.parameter-key[data-index="${i}"]`).value.trim();
    const type = document.querySelector(`.parameter-type[data-index="${i}"]`)?.value || 'string';
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) {
      throw new Error(`第${i + 1}步的变量名必须是英文字母开头、仅含字母数字下划线`);
    }
    if (used.has(key)) throw new Error('变量名不能重复：' + key);
    used.add(key);
    collectedParams.push({
      key,
      label: step.target?.label || key,
      type,
      required: true,
      defaultValue: step.value ?? '',
      sourceStepId: step.id
    });
  }

  const batchEnabled = Boolean($('enableBatchLoop').checked);
  const preset = $('extractSpecPreset').value || 'none';
  const pilotCount = Math.max(0, Number($('pilotCountInput').value || 2));

  const { skill: baseSkill, validation } = applyDraftToSkillIR({
    session: state.session,
    draft: state.draft,
    overrides: {
      name: $('skillName').value.trim() || state.session?.name || '未命名技能',
      intent: $('skillIntent').value.trim(),
      authPolicy: $('skillAuthPolicy').value,
      resultSelector: $('resultSelector').value.trim(),
      parameters: collectedParams,
      stepVarBindings
    }
  });

  let skill = baseSkill;
  let batchColumns = [];
  if (batchEnabled) {
    // 微瑕 2 修复：跨双系统录制自动按最后一次 cross-origin navigate 切分 preSteps / rowSteps
    const partitioned = applyBatchLoopPartition({
      skill: baseSkill,
      collectedParams,
      pilotCount
    });
    skill = partitioned.skill;
    batchColumns = partitioned.datasetColumns || [];
  }

  const extractSpec = buildExtractSpecFromPreset(preset, batchColumns);
  if (extractSpec) {
    skill.extractSpec = extractSpec;
  }

  const finalValidation = validateSkillIR(skill);
  if (!validation.ok || !finalValidation.ok) {
    const errs = [...(validation.errors || []), ...(finalValidation.errors || [])];
    throw new Error('Skill IR v0.3 校验失败：' + errs.join('；'));
  }
  return skill;
}

async function saveSkill() {
  try {
    const skill = buildSkill();
    const saved = await defaultStore.saveSkill(skill);
    state.loaded = saved;
    await renderSkillPicker(saved.id);
    message(
      `已保存 Skill IR v0.3“${saved.name}”（${saved.steps.length} 步，站点 ${saved.allowedOrigins.length} 个${saved.batchLoop?.enabled ? ' · 支持 CSV 批量' : ''}）。`
    );
  } catch (e) {
    message('保存失败：' + e.message);
  }
}

function triggerDownload(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function downloadSkill() {
  try {
    const skill = buildSkill();
    const jsonText = defaultStore.exportSkillJson(skill);
    triggerDownload('skillflow-v03-' + skill.id.slice(0, 8) + '.json', jsonText, 'application/json');
  } catch (e) {
    message('导出失败：' + e.message);
  }
}

function exportLoadedSkillMd() {
  const skill = state.loaded;
  if (!skill) {
    message('请先选择或保存一个技能后再导出 SKILL.md');
    return;
  }
  const mdText = exportSkillMarkdown(skill);
  triggerDownload(`${skill.id.slice(0, 12)}.SKILL.md`, mdText, 'text/markdown;charset=utf-8');
  message(`已导出脱敏 SKILL.md（${skill.name}）`);
}

function exportLoadedMcpJson() {
  const skill = state.loaded;
  if (!skill) {
    message('请先选择或保存一个技能后再导出 MCP JSON');
    return;
  }
  const jsonText = formatMcpToolJson(skill);
  triggerDownload(`${skill.id.slice(0, 12)}.mcp.json`, jsonText, 'application/json');
  message(`已导出标准 MCP Tool Schema JSON（${skill.name}）`);
}

function filterSkillOptions(selectId = null) {
  const select = $('skillPicker');
  const prev = selectId || select.value;
  const q = ($('skillSearchInput')?.value || '').trim().toLowerCase();
  const filtered = q
    ? state.allSkills.filter((s) =>
        `${s.name || ''} ${s.intent || ''} ${(s.allowedOrigins || []).join(' ')}`
          .toLowerCase()
          .includes(q)
      )
    : state.allSkills;

  select.replaceChildren();
  const empty = element(
    'option',
    null,
    filtered.length ? `请选择已保存技能（共 ${filtered.length} 条）` : '无匹配技能'
  );
  empty.value = '';
  select.append(empty);
  filtered.forEach((s) => {
    const opt = element('option', null, `${s.name} · ${(s.steps || []).length}步`);
    opt.value = s.id;
    select.append(opt);
  });
  if (prev && filtered.some((s) => s.id === prev)) {
    select.value = prev;
  }
}

async function selectSkillInPicker(skillId, { prefillDefaults = false } = {}) {
  if (!skillId) return false;
  if (!state.allSkills.some((s) => s.id === skillId)) {
    state.allSkills = await defaultStore.getSkills();
  }
  if (!state.allSkills.some((s) => s.id === skillId)) {
    return false;
  }
  const select = $('skillPicker');
  const hasOption = Array.from(select.options || []).some((opt) => opt.value === skillId);
  if (!hasOption) {
    if ($('skillSearchInput')) $('skillSearchInput').value = '';
    filterSkillOptions(skillId);
  }
  select.value = skillId;
  await loadSkill({ prefillDefaults });
  return true;
}

async function renderSkillPicker(selectId) {
  state.allSkills = await defaultStore.getSkills();
  filterSkillOptions(selectId);
  if (selectId && state.allSkills.some((s) => s.id === selectId)) {
    await selectSkillInPicker(selectId, { prefillDefaults: false });
  } else if (!state.loaded) {
    await refreshCheckpointBanner();
  }
}

function updateRecordActionButtons() {
  const hasRecords = state.records.length > 0;
  const hasAbnormal = state.records.some((r) =>
    ['failed', 'unknown', 'error'].includes(String(r?.status || '').toLowerCase())
  );
  const hasRetryableFailed = state.records.some(
    (r) => String(r?.status || '').toLowerCase() === 'failed'
  );
  const targetSkillId = state.lastRunSummary?.skillId || state.loaded?.id || '';
  const targetSkill =
    (targetSkillId && state.allSkills.find((s) => s.id === targetSkillId)) ||
    (state.loaded && (!targetSkillId || state.loaded.id === targetSkillId) ? state.loaded : null);
  const supportsBatch = Boolean(
    targetSkill && (getDatasetParam(targetSkill) || targetSkill.batchLoop?.enabled)
  );
  if ($('exportRecordsCsvBtn')) $('exportRecordsCsvBtn').disabled = !hasRecords;
  if ($('exportFailedCsvBtn')) $('exportFailedCsvBtn').disabled = !hasAbnormal;
  if ($('loadFailedRowsBtn')) $('loadFailedRowsBtn').hidden = !(hasRetryableFailed && supportsBatch);
}

async function refreshRunHistoryPicker(selectedId = '') {
  const picker = $('runHistoryPicker');
  if (!picker) return;
  state.allRuns = await defaultStore.getRuns();
  picker.replaceChildren();
  const defOpt = element(
    'option',
    null,
    state.allRuns.length ? `当前视图 / 回看历史执行（共 ${state.allRuns.length} 条）` : '暂无历史执行记录'
  );
  defOpt.value = '';
  picker.append(defOpt);
  for (const r of state.allRuns) {
    const tsShort = String(r.ts || '').replace('T', ' ').slice(0, 16);
    const recCount = Array.isArray(r.records) ? r.records.length : 0;
    const opt = element(
      'option',
      null,
      `[${tsShort}] ${r.skillName || r.skillId} · ${r.status} (${recCount}条)`
    );
    opt.value = r.id;
    picker.append(opt);
  }
  if (selectedId && state.allRuns.some((r) => r.id === selectedId)) {
    picker.value = selectedId;
  }
}

function loadHistoricalRun(runId) {
  const run = state.allRuns.find((r) => r.id === runId);
  if (!run) return;
  state.records = Array.isArray(run.records) ? run.records : [];
  state.recordSchema = Array.isArray(run.recordSchema) ? run.recordSchema : [];
  state.lastRunSummary = run;
  state.lastResult = run.result || null;
  state.logs = Array.isArray(run.logs) ? run.logs : [];

  text($('recordsSummaryBadge'), `${state.records.length} 条明细`);
  const unverifiedPart = run.batchSummary?.unverified
    ? ` / 未核验 ${run.batchSummary.unverified}`
    : '';
  const batchPart = run.batchSummary
    ? ` · 批量共 ${run.batchSummary.total} 条（成功 ${run.batchSummary.verified} / 失败 ${run.batchSummary.failed}${unverifiedPart}）`
    : '';
  text(
    $('runSummary'),
    `[历史回看] ${run.skillName || run.skillId} · 状态：${run.status}${batchPart} · ${run.elapsedMs || 0}ms` +
      (run.error ? ` · ${run.error}` : '')
  );

  $('runLogs').replaceChildren();
  state.logs.forEach((entry) => {
    $('runLogs').append(
      element(
        'div',
        'log ' + (entry.ok ? 'ok' : 'error'),
        (entry.ok ? '✓ ' : '✗ ') + entry.message
      )
    );
  });

  if ($('qaChartHost')) {
    $('qaChartHost').replaceChildren();
    $('qaChartHost').hidden = true;
  }
  text($('answer'), `已载入历史执行（${state.records.length} 条明细），可直接追问分布或导出 CSV。`);
  updateRecordActionButtons();
}

async function refreshCheckpointBanner() {
  const card = $('checkpointResumeCard');
  if (!card) return;
  if (state.activeController) {
    state.activeCheckpoint = null;
    card.hidden = true;
    return;
  }
  const cps = await defaultStore.getRunCheckpoints();
  const batchCps = (cps || []).filter((c) => Array.isArray(c.batchRows) && c.batchRows.length > 0);
  const cp = state.loaded
    ? batchCps.find((c) => c.skillId === state.loaded.id) || null
    : batchCps[0] || null;

  state.activeCheckpoint = cp;
  if (!cp) {
    card.hidden = true;
    return;
  }
  const doneCount = Array.isArray(cp.ledger) ? cp.ledger.length : 0;
  const totalCount = cp.batchRows.length;
  const verifiedCount = cp.batchSummary?.verified || 0;
  const failedCount = cp.batchSummary?.failed || 0;
  const unknownHint =
    cp.status === 'PAUSED_CONFIRM_REQUIRED' && cp.unknownWriteInfo
      ? `\n⚠ 含第 ${cp.unknownWriteInfo.rowIndex} 行 WRITE_OUTCOME_UNKNOWN，审批续跑后需先人工核定（绝不自动重放）。`
      : '';
  text(
    $('checkpointResumeText'),
    `技能“${cp.skillName || cp.skillId}”于 ${String(cp.updatedAt || '').replace('T', ' ').slice(0, 19)} 中断（${cp.status}）：\n` +
      `已处理 ${doneCount}/${totalCount} 行（成功 ${verifiedCount} / 失败 ${failedCount}）${unknownHint}`
  );
  card.hidden = false;
}

function getDatasetParam(skill) {
  return (skill?.parameters || []).find((p) => p.type === 'dataset') || null;
}

function renderCsvMappingUI(datasetParam) {
  const host = $('csvMappingHost');
  host.replaceChildren();
  const statusEl = $('csvStatusBadge');
  const errEl = $('csvErrorBox');

  if (!state.parsedCsv) {
    text(statusEl, '未导入');
    errEl.hidden = true;
    state.boundBatchRows = null;
    return;
  }

  const columns = datasetParam?.columns || [];
  for (const col of columns) {
    const row = element('label', null, `列映射：${col.label || col.key} (${col.type || 'string'})`);
    const sel = element('select');
    sel.className = 'csv-col-map';
    sel.dataset.key = col.key;
    const emptyOpt = element('option', null, '-- 未映射 --');
    emptyOpt.value = '';
    sel.append(emptyOpt);
    for (const h of state.parsedCsv.headers) {
      const opt = element('option', null, h);
      opt.value = h;
      sel.append(opt);
    }
    sel.value = state.csvMapping[col.key] || '';
    sel.addEventListener('change', async () => {
      state.csvMapping[col.key] = sel.value;
      await invalidateApproval('CSV 列映射已变动，请重新预览执行计划。');
      validateCurrentCsvRows(datasetParam);
    });
    row.append(sel);
    host.append(row);
  }

  validateCurrentCsvRows(datasetParam);
}

function validateCurrentCsvRows(datasetParam) {
  const statusEl = $('csvStatusBadge');
  const errEl = $('csvErrorBox');
  const columns = datasetParam?.columns || [];
  const res = validateAndBindBatchRows(state.parsedCsv, columns, state.csvMapping);
  if (!res.ok) {
    state.boundBatchRows = null;
    text(statusEl, '校验失败');
    text(errEl, `${res.errorCode}: ${res.errors.join('\n')}`);
    errEl.hidden = false;
    return false;
  }
  state.boundBatchRows = res.rows;
  text(statusEl, `已就绪 ${res.rowCount} 条`);
  errEl.hidden = true;
  return true;
}

async function loadSkill({ prefillDefaults = false } = {}) {
  await invalidateApproval();
  state.lastQuestion = null;
  state.parsedCsv = null;
  state.csvMapping = {};
  state.boundBatchRows = null;
  state.pendingRebind = null;
  if ($('csvFileInput')) $('csvFileInput').value = '';
  $('clarifyBox').hidden = true;
  $('rebindCard').hidden = true;
  if ($('deleteSkillConfirmCard')) $('deleteSkillConfirmCard').hidden = true;

  const skills = await defaultStore.getSkills();
  state.allSkills = skills;
  const skill = skills.find((s) => s.id === $('skillPicker').value);
  state.loaded = skill || null;

  const host = $('runtimeParams');
  host.replaceChildren();
  const originsBar = $('allowedOriginsBar');
  $('preview').disabled = !skill;
  $('nlArgsGroup').hidden = !skill;
  $('runOptionsRow').hidden = !skill;
  $('skillExportRow').hidden = !skill;
  if ($('deleteSkillBtn')) $('deleteSkillBtn').disabled = !skill;

  const datasetParam = getDatasetParam(skill);
  const hasBatch = Boolean(datasetParam || skill?.batchLoop?.enabled);
  $('csvBatchSection').hidden = !hasBatch;

  if (!skill) {
    originsBar.hidden = true;
    host.append(element('div', 'muted', '请选择技能'));
    await refreshCheckpointBanner();
    return;
  }

  $('runAuthPolicySelect').value = skill.authPolicy || 'manual_takeover';
  $('writeModeSelect').value =
    skill.riskPolicy?.writeMode || (hasBatch ? 'pilot_then_batch' : 'commit');

  const origins = normalizeTargetOrigins(skill);
  originsBar.hidden = false;
  text(originsBar, '授权站点白名单：' + (origins.join(' , ') || '(无)'));

  const scalarParams = (skill.parameters || []).filter((p) => p.type !== 'dataset');
  for (const p of scalarParams) {
    const label = element('label', null, `${p.label || p.key} [${p.type || 'string'}]`);
    const input = element('input');
    const recordedSample = p.defaultValue ?? p.default ?? '';
    // Bug 2 修复：NL 匹配默认不预填旧录制值，仅放在 placeholder 提示，确保缺参时真实触发追问
    input.value = prefillDefaults ? recordedSample : '';
    input.placeholder = recordedSample ? `录制示例：${recordedSample}` : '';
    input.dataset.key = p.key;
    input.dataset.sample = recordedSample;
    input.className = 'runtime-param';
    const onParamEdit = () => {
      if (state.pendingSnapshot) {
        invalidateApproval('参数已变动，原计划审批已自动失效，请重新点击“预览执行计划”。');
      }
    };
    input.addEventListener('input', onParamEdit);
    input.addEventListener('change', onParamEdit);
    label.append(input);
    host.append(label);
  }
  if (!scalarParams.length) {
    host.append(element('div', 'muted', hasBatch ? '该技能为 CSV 批量驱动技能，请导入下方 CSV 数据' : '该技能没有可变参数'));
  }

  if (hasBatch) {
    renderCsvMappingUI(datasetParam);
  }
  await refreshCheckpointBanner();
  updateRecordActionButtons();
}

function argsFromUI() {
  const args = {};
  document.querySelectorAll('.runtime-param').forEach((input) => {
    args[input.dataset.key] = input.value;
  });
  return args;
}

function readAndValidateRuntimeArgs(skill) {
  return normalizeAndValidateRuntimeArgs(skill, argsFromUI());
}

function setArgsToUI(args) {
  document.querySelectorAll('.runtime-param').forEach((input) => {
    const k = input.dataset.key;
    if (Object.prototype.hasOwnProperty.call(args, k)) {
      input.value = args[k];
    }
  });
}

async function runMatchSkill() {
  const userQuery = $('nlQuery').value.trim();
  if (!userQuery) {
    message('请输入自然语言任务描述再匹配技能');
    return;
  }
  const skills = await defaultStore.getSkills();
  if (!skills.length) {
    message('当前尚未保存任何技能，请先录制并保存技能');
    return;
  }
  const btn = $('matchSkillBtn');
  btn.disabled = true;
  text(btn, 'AI 解析中...');
  try {
    const res = await matchSkillByQuery({ userQuery, skills, aiClient });
    const box = $('matchResultBox');
    box.hidden = false;
    const badge = formatAiSourceBadge(res);
    if (!res.matchedSkillId) {
      text(box, `未找到高置信度匹配技能（置信度：${res.confidence}）[ ${badge} ]，请在下方手动选择。`);
      return;
    }
    state.allSkills = skills;
    const matched = skills.find((s) => s.id === res.matchedSkillId);
    text(
      box,
      `已命中技能：“${matched?.name || res.matchedSkillId}”（置信度：${res.confidence}）[ ${badge} ]`
    );
    // Bug 2 + P1 修复：搜索过滤态下也确保清空检索词并稳定选中命中技能
    await selectSkillInPicker(res.matchedSkillId, { prefillDefaults: false });

    if (state.loaded?.parameters?.some((p) => p.type !== 'dataset')) {
      $('nlArgInput').value = userQuery;
      await runExtractArgs();
    }
  } finally {
    btn.disabled = false;
    text(btn, '匹配技能');
  }
}

async function runExtractArgs() {
  if (!state.loaded) return;
  const userText = $('nlArgInput').value.trim();
  if (!userText) return;
  const btn = $('extractArgsBtn');
  btn.disabled = true;
  text(btn, 'AI 解析中...');
  try {
    const res = await extractArgsFromInput({
      userText,
      parameters: state.loaded.parameters || [],
      collectedArgs: argsFromUI(),
      lastQuestion: state.lastQuestion,
      currentDate: new Date().toISOString().slice(0, 10),
      aiClient
    });
    setArgsToUI(res.providedArgs || {});
    state.lastQuestion = res.nextQuestion || null;
    await invalidateApproval();

    const badge = formatAiSourceBadge(res);
    const clarify = $('clarifyBox');
    if (res.invalidArgs?.length || res.missingRequired?.length) {
      const promptMsg = res.nextQuestion || `请补充参数：${res.missingRequired.join('、')}`;
      text(clarify, `${promptMsg}\n[ ${badge} ]`);
      clarify.hidden = false;
    } else {
      text(clarify, `✓ 全部必填参数已补齐并通过格式校验，可预览执行计划。\n[ ${badge} ]`);
      clarify.hidden = false;
    }
  } finally {
    btn.disabled = false;
    text(btn, '解析补参');
  }
}

async function preview() {
  if (!state.loaded) return;
  try {
    await invalidateApproval();
    const checked = readAndValidateRuntimeArgs(state.loaded);
    if (!checked.ok) {
      throw new Error(`${checked.errorCode}: ${checked.message}`);
    }

    const datasetParam = getDatasetParam(state.loaded);
    const hasBatch = Boolean(datasetParam || state.loaded.batchLoop?.enabled);
    let batchRows = null;
    if (hasBatch) {
      if (!state.boundBatchRows?.length) {
        throw new Error('CSV_SCHEMA_INVALID: 请先导入并通过校验的批量 CSV 数据');
      }
      batchRows = state.boundBatchRows;
    }

    const writeMode = $('writeModeSelect').value || 'commit';
    const snapshot = await buildPlanSnapshot({
      skill: state.loaded,
      args: checked.args,
      writeMode,
      batchRows
    });
    state.pendingSnapshot = snapshot;

    text($('planHashBadge'), `planHash: ${snapshot.planHash.slice(0, 12)}…`);
    text(
      $('plan'),
      `技能：${snapshot.skillName} (v${snapshot.skillVersion})\n` +
        `写模式：${snapshot.writeMode} | 鉴权策略：${$('runAuthPolicySelect').value}\n` +
        `允许站点：${snapshot.targetOrigins.join(', ')}\n` +
        `输入参数：${JSON.stringify(snapshot.args)}` +
        (batchRows ? `\n批量记录数：${batchRows.length} 条（前 2 条试跑后放行：${writeMode === 'pilot_then_batch' ? '是' : '否'}）` : '') +
        `\n\n执行步骤：\n` +
        snapshot.steps
          .map((s, i) => `${i + 1}. ${describe(s)}${isRiskStep(s) ? '  ⚠需内联确认' : ''}`)
          .join('\n') +
        `\n\n结果校验选择器：${state.loaded.resultSelector || '(未配置)'}`
    );
    $('approvalCard').hidden = false;
    message('已生成不可变执行计划快照（修改任一参数/策略/CSV 将立即作废），请核对后批准执行。');
  } catch (e) {
    message('预览计划失败：' + e.message);
  }
}

function confirmInlineRisk(step, index) {
  return new Promise((resolve) => {
    state.riskResolver = resolve;
    text(
      $('riskPromptText'),
      `第 ${index + 1} 步涉及写提交或敏感状态确认：\n${describe(step)}\n\n请核对右侧网页当前状态后再确认继续。`
    );
    $('riskPrompt').hidden = false;
  });
}

function addLog(entry) {
  state.logs.push(entry);
  const div = element(
    'div',
    'log ' + (entry.ok ? 'ok' : 'error'),
    (entry.ok ? '✓ ' : '✗ ') + entry.message
  );
  $('runLogs').append(div);
  $('runLogs').scrollTop = $('runLogs').scrollHeight;
}

function renderRunState(runState) {
  if (Array.isArray(runState.records)) {
    state.records = runState.records;
    state.recordSchema = runState.recordSchema || [];
    text($('recordsSummaryBadge'), `${state.records.length} 条明细`);
    updateRecordActionButtons();
  }

  const pauseCard = $('authPauseCard');
  if (runState.status === 'PAUSED_AUTH_REQUIRED' && runState.authPauseInfo) {
    const info = runState.authPauseInfo;
    const isEphemeral = info.mode === 'ephemeral_prompt';
    text(
      $('authPauseText'),
      isEphemeral
        ? '当前为模式 B（内存临时密文填单）：输入仅在内存直接填入页面并立即销毁，不写 storage、不发模型、不入日志。'
        : `请直接在右侧业务网页完成登录${info.hasCaptcha ? '与图形/短信验证码' : ''}，完成后点击【我已登录，原位继续执行】。${info.downgraded ? '（已自动切换为人工接管）' : ''}`
    );
    $('authModeABox').hidden = isEphemeral;
    $('authModeBBox').hidden = !isEphemeral;
    pauseCard.hidden = false;
  } else {
    pauseCard.hidden = true;
  }

  const pilotCard = $('pilotReviewCard');
  if (runState.status === 'PAUSED_PILOT_REVIEW') {
    const pilotRows = (runState.ledger || []).slice(0, runState.pilotCount || 2);
    text(
      $('pilotReviewSummary'),
      pilotRows
        .map(
          (r) =>
            `行#${r.rowIndex} [${r.status}] ${r.orgName || ''} ${r.kwh || ''}kWh → ${
              r.status === 'verified' ? `单号 ${r.receiptNo}` : `失败：${r.error}`
            }`
        )
        .join('\n')
    );
    pilotCard.hidden = false;
  } else {
    pilotCard.hidden = true;
  }

  const unknownCard = $('unknownWriteCard');
  if (runState.status === 'PAUSED_CONFIRM_REQUIRED' && runState.unknownWriteInfo) {
    text(
      $('unknownWriteText'),
      `第 ${runState.unknownWriteInfo.rowIndex} 行提交后未采集到明确页面回执（${runState.unknownWriteInfo.reason}）。\n为防止重复录入生产台账，插件严禁自动重试！请人工在系统 B 核对是否已落库后再选择处理方式。`
    );
    unknownCard.hidden = false;
  } else {
    unknownCard.hidden = true;
  }

  if (
    ['PAUSED_PILOT_REVIEW', 'PAUSED_AUTH_REQUIRED', 'PAUSED_CONFIRM_REQUIRED'].includes(
      runState.status
    )
  ) {
    refreshCheckpointBanner().catch(() => {});
  }

  if (
    ['VERIFIED_SUCCESS', 'ACTIONS_COMPLETED_UNVERIFIED', 'FAILED', 'CANCELLED'].includes(
      runState.status
    )
  ) {
    state.activeController = null;
    state.lastResult = runState.lastResult || null;
    state.lastRunSummary = runState;
    $('runSummary').replaceChildren();
    const unverifiedPart = runState.batchSummary?.unverified
      ? ` / 未核验 ${runState.batchSummary.unverified}`
      : '';
    const batchPart = runState.batchSummary
      ? ` · 批量共 ${runState.batchSummary.total} 条（成功 ${runState.batchSummary.verified} / 失败 ${runState.batchSummary.failed}${unverifiedPart}）`
      : '';
    text(
      $('runSummary'),
      `状态：${runState.status}${batchPart} · ${runState.logs.filter((x) => x.ok).length}项日志 · ${runState.elapsedMs}ms` +
        (runState.error ? ` · ${runState.error}` : '')
    );
    message(runState.error ? `执行结束（${runState.status}）：${runState.error}` : `执行完成（${runState.status}）`);
    $('run').disabled = false;
    $('preview').disabled = false;
    $('cancelPlan').disabled = false;
    updateRecordActionButtons();
    refreshRunHistoryPicker(runState.runId).catch(() => {});
    refreshCheckpointBanner().catch(() => {});

    const rebindCard = $('rebindCard');
    const canRebind =
      runState.status === 'FAILED' &&
      ['ACTION_FAILED', 'TARGET_AMBIGUOUS'].includes(runState.errorCode) &&
      (runState.failedStepIndex !== null && runState.failedStepIndex !== undefined || runState.failedStepId);
    if (canRebind && state.loaded) {
      const idxLabel = Number.isInteger(runState.failedStepIndex) ? runState.failedStepIndex + 1 : '?';
      state.pendingRebind = {
        skillId: state.loaded.id,
        stepIndex: runState.failedStepIndex,
        stepId: runState.failedStepId
      };
      text(
        $('rebindText'),
        `第 ${idxLabel} 步元素定位失败（${runState.errorCode}）。可直接点击下方按钮在页面上重新指认目标元素并保存，无需整条重录。`
      );
      text($('startRebindBtn'), `重新指认第 ${idxLabel} 步元素`);
      $('startRebindBtn').disabled = false;
      $('cancelRebindBtn').disabled = true;
      rebindCard.hidden = false;
    } else {
      state.pendingRebind = null;
      rebindCard.hidden = true;
    }
  }
}

async function execute() {
  const skill = state.loaded;
  const snapshot = state.pendingSnapshot;
  const resumeCheckpoint = state.pendingResumeCheckpoint;
  if (!skill || !snapshot) {
    message('PLAN_NOT_APPROVED: 请先点击“预览执行计划”并核对后再执行');
    return;
  }

  // Bug 1 + Bug 4 修复：共用 readAndValidateRuntimeArgs 并同时核对 writeMode
  const liveChecked = readAndValidateRuntimeArgs(skill);
  const liveWriteMode = $('writeModeSelect').value || 'commit';
  if (
    !liveChecked.ok ||
    canonicalJson(liveChecked.args) !== canonicalJson(snapshot.args) ||
    liveWriteMode !== snapshot.writeMode
  ) {
    await invalidateApproval('PLAN_NOT_APPROVED: 检测到输入参数或写模式已于预览后变更，审批已失效，请重新预览');
    return;
  }

  $('run').disabled = true;
  $('preview').disabled = true;
  $('cancelPlan').disabled = true;
  $('rebindCard').hidden = true;
  state.pendingRebind = null;
  state.pendingResumeCheckpoint = null;
  state.logs = [];
  state.records = [];
  state.recordSchema = [];
  state.lastResult = null;
  state.lastRunSummary = null;
  // 模块 A1：点击执行时立即清空旧运行摘要与问答结果，防止残留上一轮结论
  text($('runSummary'), '执行中...');
  text($('answer'), DEFAULT_QA_ANSWER);
  if ($('qaChartHost')) {
    $('qaChartHost').replaceChildren();
    $('qaChartHost').hidden = true;
  }
  text($('recordsSummaryBadge'), '0 条明细');
  $('runLogs').replaceChildren();
  updateRecordActionButtons();

  const driver = createDriver('mv3-content', {
    allowedOrigins: snapshot.targetOrigins
  });

  if (Array.isArray(snapshot.batchRows) && snapshot.batchRows.length > 0) {
    const batchRunner = createBatchRunner({
      driver,
      store: defaultStore,
      approvalClient,
      onStateChange: renderRunState,
      onLog: addLog
    });
    state.activeController = batchRunner;
    if ($('checkpointResumeCard')) $('checkpointResumeCard').hidden = true;
    const finalState = resumeCheckpoint
      ? await batchRunner.resumeFromCheckpoint({
          skill,
          snapshot,
          checkpoint: resumeCheckpoint,
          authPolicyOverride: $('runAuthPolicySelect').value
        })
      : await batchRunner.start({
          skill,
          snapshot,
          batchRows: snapshot.batchRows,
          authPolicyOverride: $('runAuthPolicySelect').value
        });
    if (!['PAUSED_AUTH_REQUIRED', 'PAUSED_PILOT_REVIEW', 'PAUSED_CONFIRM_REQUIRED'].includes(finalState.status)) {
      await invalidateApproval();
      state.activeController = null;
    }
    return;
  }

  const controller = createRunController({
    driver,
    store: defaultStore,
    approvalClient,
    onStateChange: renderRunState,
    onLog: addLog
  });
  state.activeController = controller;
  if ($('checkpointResumeCard')) $('checkpointResumeCard').hidden = true;

  const finalState = await controller.start({
    skill,
    snapshot,
    authPolicyOverride: $('runAuthPolicySelect').value,
    confirmRiskStep: confirmInlineRisk
  });

  if (finalState.status !== 'PAUSED_AUTH_REQUIRED') {
    await invalidateApproval();
    state.activeController = null;
  }
}

async function handleResumeManualAuth() {
  if (!state.activeController) return;
  const res = await state.activeController.resumeAfterManualAuth();
  if (!res.ok) {
    message(res.message);
  } else if (
    !['PAUSED_AUTH_REQUIRED', 'PAUSED_PILOT_REVIEW', 'PAUSED_CONFIRM_REQUIRED'].includes(
      res.state?.status
    )
  ) {
    await invalidateApproval();
    state.activeController = null;
  }
}

async function handleSubmitEphemeralAuth() {
  if (!state.activeController) return;
  const userEl = $('ephemeralUser');
  const passEl = $('ephemeralPass');
  const credentials = {
    username: userEl.value.trim(),
    password: passEl.value
  };
  userEl.value = '';
  passEl.value = '';

  const res = await state.activeController.submitEphemeralAuth(credentials);
  if (!res.ok) {
    message(res.message);
  } else if (
    !['PAUSED_AUTH_REQUIRED', 'PAUSED_PILOT_REVIEW', 'PAUSED_CONFIRM_REQUIRED'].includes(
      res.state?.status
    )
  ) {
    await invalidateApproval();
    state.activeController = null;
  }
}

async function handleSwitchToManualAuth() {
  if (!state.activeController) return;
  $('ephemeralUser').value = '';
  $('ephemeralPass').value = '';
  // Bug 4 修复：同步通知控制器内部状态与持久化检查点
  await state.activeController.switchAuthToManual();
  message('已切换为人工接管模式：请在右侧业务网页完成登录后点击【我已登录，原位继续执行】。');
}

async function handleCancelRun() {
  if (!state.activeController) return;
  await state.activeController.cancel();
  await invalidateApproval('已中止当前执行。');
  state.activeController = null;
  await refreshCheckpointBanner();
}

function appendBarChartCard(host, title, entries, { isError = false } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const card = element('div', 'qa-chart-card');
  card.append(element('div', 'qa-chart-title', title));
  for (const item of entries) {
    const row = element('div', 'qa-bar-row');
    const meta = element('div', 'qa-bar-meta');
    meta.append(element('span', null, item.label));
    meta.append(element('span', null, `${item.count} 条 (${item.percentText})`));
    const track = element('div', 'qa-bar-track');
    const fill = element('div', isError ? 'qa-bar-fill error-bar' : 'qa-bar-fill');
    const pct = Math.max(2, Math.min(100, Math.round(Number(item.ratio || 0) * 100)));
    fill.style.width = `${item.count > 0 ? pct : 0}%`;
    track.append(fill);
    row.append(meta, track);
    card.append(row);
  }
  host.append(card);
}

function renderQaCharts(computedEvidence) {
  const host = $('qaChartHost');
  if (!host) return;
  host.replaceChildren();
  if (!computedEvidence) {
    host.hidden = true;
    return;
  }

  let cardCount = 0;
  const unitDist = computedEvidence.unitVerifiedDistribution || computedEvidence.unitDistribution;
  if (unitDist?.groups?.length) {
    appendBarChartCard(
      host,
      computedEvidence.unitVerifiedDistribution ? '按供电单位成功分布' : '按供电单位分布',
      unitDist.groups.map((g) => ({
        label: g.key,
        count: g.count,
        ratio: g.ratio,
        percentText: g.percent
      }))
    );
    cardCount += 1;
  }

  if (computedEvidence.voltageDistribution?.groups?.length) {
    appendBarChartCard(
      host,
      '按电压等级分布',
      computedEvidence.voltageDistribution.groups.map((g) => ({
        label: g.key,
        count: g.count,
        ratio: g.ratio,
        percentText: g.percent
      }))
    );
    cardCount += 1;
  }

  if (computedEvidence.errorBreakdown?.items?.length) {
    appendBarChartCard(
      host,
      '失败原因占比分布',
      computedEvidence.errorBreakdown.items.map((it) => ({
        label: it.reason,
        count: it.count,
        ratio: it.ratioOfFailed,
        percentText: it.percentOfFailed
      })),
      { isError: true }
    );
    cardCount += 1;
  }

  if (cardCount === 0 && computedEvidence.primary?.groups?.length) {
    appendBarChartCard(
      host,
      `分组分布 (${computedEvidence.primary.key || '分类'})`,
      computedEvidence.primary.groups.map((g) => ({
        label: g.key,
        count: g.count,
        ratio: g.ratio,
        percentText: g.percent
      }))
    );
    cardCount += 1;
  }

  host.hidden = cardCount === 0;
}

async function handleStartRebind() {
  if (!state.loaded || !state.pendingRebind) return;
  const { stepIndex, stepId } = state.pendingRebind;
  $('startRebindBtn').disabled = true;
  $('cancelRebindBtn').disabled = false;
  message(`请在右侧业务网页点击需要重新绑定的第 ${(stepIndex ?? 0) + 1} 步元素（按 Esc 取消）...`);

  try {
    const driver = createDriver('mv3-content', {
      allowedOrigins: normalizeTargetOrigins(state.loaded)
    });
    state.rebindDriver = driver;
    const picked = await driver.pickElement({
      prompt: `SkillFlow 重绑第 ${(stepIndex ?? 0) + 1} 步：请点击目标页面元素（Esc 取消）`
    });
    if (!picked?.ok || !picked.target) {
      message(picked?.message || '已取消单步元素重绑');
      return;
    }

    const rebound = applyRebindToSkill(state.loaded, {
      stepIndex,
      stepId,
      newTarget: picked.target
    });
    if (!rebound.ok) {
      throw new Error((rebound.errors || []).join('；') || '重绑校验失败');
    }

    const prevArgs = argsFromUI();
    const saved = await defaultStore.saveSkill(rebound.skill);
    state.loaded = saved;
    $('rebindCard').hidden = true;
    state.pendingRebind = null;
    await renderSkillPicker(saved.id);
    setArgsToUI(prevArgs);
    await invalidateApproval();
    message(
      `已完成第 ${rebound.stepIndex + 1} 步单步元素重绑并升级至 v${saved.version}，请重新“预览执行计划”后回放。`
    );
  } catch (e) {
    message('单步元素重绑失败：' + e.message);
  } finally {
    state.rebindDriver = null;
    $('startRebindBtn').disabled = false;
    $('cancelRebindBtn').disabled = true;
  }
}

async function handleCancelRebind() {
  if (state.rebindDriver?.cancelPickElement) {
    await state.rebindDriver.cancelPickElement();
  }
  $('startRebindBtn').disabled = false;
  $('cancelRebindBtn').disabled = true;
  message('已取消元素重绑选点。');
}

function exportTelemetryLogJson() {
  const payload = buildEvalTelemetryPayload({
    skill: state.loaded,
    distilled: state.distilled,
    runSummary: state.lastRunSummary,
    modelUsage: aiClient.getStats(),
    recordsCount: state.records.length
  });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  triggerDownload(`skillflow-eval-${ts}.json`, JSON.stringify(payload, null, 2), 'application/json');
  message('已导出课题 #60 脱敏评测遥测日志 JSON（含 DOM 压缩率、定位策略命中与模型开销）。');
}

function handleExportRecordsCsv(failedOnly) {
  if (!state.records.length) {
    message('当前没有可导出的执行明细');
    return;
  }
  const csvText = exportRecordsCsv(state.records, state.recordSchema, { failedOnly });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = failedOnly ? `skillflow-failed-${ts}.csv` : `skillflow-records-${ts}.csv`;
  triggerDownload(name, csvText, 'text/csv;charset=utf-8');
  message(
    failedOnly
      ? '已导出失败清单 CSV（含 UTF-8 BOM 与公式注入防护，可修订后重导）。'
      : '已导出全部执行明细 CSV（含 UTF-8 BOM 与脱敏/防注入防护）。'
  );
}

async function handlePickExtractField() {
  if (state.recording?.active || !state.session?.steps) {
    message('请先完成录制后再从页面选点提取变量。');
    return;
  }
  const varName = ($('extractVarName')?.value || '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(varName)) {
    message('提取变量名必须以英文字母开头，仅含字母数字下划线');
    return;
  }

  $('pickExtractFieldBtn').disabled = true;
  $('cancelExtractPickBtn').disabled = false;
  message(`请在业务网页点击要提取为 {{var.${varName}}} 的单元格或字段（按 Esc 取消）...`);

  try {
    const origins = normalizeTargetOrigins(state.session || {});
    const driver = createDriver('mv3-content', { allowedOrigins: origins });
    state.extractDriver = driver;
    const sess = await driver.ensureSession(origins);
    const picked = await driver.pickElement({
      mode: 'extract',
      prompt: `SkillFlow 提取变量 {{var.${varName}}}：请点击数据节点（Esc 取消）`
    });
    if (!picked?.ok || !picked.target) {
      message(picked?.message || '已取消提取变量选点');
      return;
    }

    let n = state.session.steps.length + 1;
    while (state.session.steps.some((s) => s.id === `s${n}_ext`)) n++;
    const step = buildExtractStepFromPick({
      pickedTarget: picked.target,
      origin: sess.currentOrigin || origins[0] || '',
      outputVar: varName,
      stepId: `s${n}_ext`
    });
    const nextSteps = insertExtractStep(
      state.session.steps,
      step,
      state.session.startUrl || ''
    );
    const insertedPos = nextSteps.findIndex((s) => s.id === step.id) + 1;
    state.session = {
      ...state.session,
      steps: nextSteps,
      allowedOrigins: normalizeTargetOrigins({ startUrl: state.session.startUrl, steps: nextSteps })
    };
    state.draft = null;
    await defaultStore.setRecordingBundle({ currentSession: state.session });
    renderSteps();
    renderParameterEditor();
    renderDistillAndPreview();
    disableSave(false);
    message(
      `已插入第 ${insertedPos} 步提取变量 {{var.${varName}}}（按槽位定位），可在 02 区将后续填写字段来源切换为引用该变量。`
    );
  } catch (e) {
    message('选点提取失败：' + e.message);
  } finally {
    state.extractDriver = null;
    $('pickExtractFieldBtn').disabled = false;
    $('cancelExtractPickBtn').disabled = true;
  }
}

async function handleCancelExtractPick() {
  if (state.extractDriver?.cancelPickElement) {
    await state.extractDriver.cancelPickElement();
  }
  $('pickExtractFieldBtn').disabled = false;
  $('cancelExtractPickBtn').disabled = true;
  message('已取消提取字段选点。');
}

async function handlePreviewResumeCheckpoint() {
  const cp = state.activeCheckpoint;
  if (!cp) return;
  try {
    if (!state.loaded || state.loaded.id !== cp.skillId) {
      const ok = await selectSkillInPicker(cp.skillId, { prefillDefaults: false });
      if (!ok) {
        throw new Error('未在技能库找到该断点对应的技能定义');
      }
    }
    const skill = state.loaded;
    if (!skill) throw new Error('未能加载断点关联技能');

    await invalidateApproval();
    if (cp.args && typeof cp.args === 'object') {
      setArgsToUI(cp.args);
    }
    const writeMode = cp.writeMode || $('writeModeSelect').value || 'pilot_then_batch';
    $('writeModeSelect').value = writeMode;

    const checked = readAndValidateRuntimeArgs(skill);
    if (!checked.ok) {
      throw new Error(checked.errors.join('；') || '断点参数校验未通过，请补全或修正参数后重试');
    }
    const args = checked.args;
    const snapshot = await buildPlanSnapshot({
      skill,
      args,
      writeMode,
      batchRows: cp.batchRows
    });
    state.pendingSnapshot = snapshot;
    state.pendingResumeCheckpoint = cp;

    const doneCount = Array.isArray(cp.ledger) ? cp.ledger.length : 0;
    const unknownWarn =
      cp.status === 'PAUSED_CONFIRM_REQUIRED' && cp.unknownWriteInfo
        ? `\n⚠ 断点含第 ${cp.unknownWriteInfo.rowIndex} 行 WRITE_OUTCOME_UNKNOWN，审批续跑后将先暂停待人工裁定，绝不自动重放！`
        : '';

    text($('planHashBadge'), `planHash: ${snapshot.planHash.slice(0, 12)}…`);
    text(
      $('plan'),
      `【断点续跑新计划】技能：${snapshot.skillName} (v${snapshot.skillVersion})\n` +
        `写模式：${snapshot.writeMode} | 鉴权策略：${$('runAuthPolicySelect').value}\n` +
        `恢复起点：第 ${Math.min((cp.currentRowIndex || 0) + 1, cp.batchRows.length)}/${cp.batchRows.length} 行（已保留 ${doneCount} 条已执行账本）` +
        unknownWarn +
        `\n允许站点：${snapshot.targetOrigins.join(', ')}\n` +
        `输入参数：${JSON.stringify(snapshot.args)}`
    );
    $('approvalCard').hidden = false;
    message('已为断点续跑签发新的不可变 planHash，请核对后批准继续。');
  } catch (e) {
    message('准备断点续跑失败：' + e.message);
  }
}

async function handleLoadFailedRowsToQueue() {
  if (!state.records.length) return;
  const targetSkillId = state.lastRunSummary?.skillId || state.loaded?.id || '';
  if (targetSkillId && (!state.loaded || state.loaded.id !== targetSkillId)) {
    await selectSkillInPicker(targetSkillId, { prefillDefaults: false });
  }
  const datasetParam = getDatasetParam(state.loaded);
  const supportsBatch = Boolean(
    state.loaded && (datasetParam || state.loaded.batchLoop?.enabled)
  );
  if (!supportsBatch) {
    message('当前目标技能不是批量技能，无法载入失败行队列。');
    return;
  }
  const extracted = extractFailedRowsForRetry(state.records, datasetParam?.columns || []);
  if (!extracted.count) {
    message(
      extracted.excludedUnknownCount > 0
        ? `仅检测到 ${extracted.excludedUnknownCount} 条 WRITE_OUTCOME_UNKNOWN 行，为防重复入库已排除自动重跑队列。`
        : '当前明细中没有可重跑的 failed 行。'
    );
    return;
  }

  await invalidateApproval();
  state.boundBatchRows = extracted.rows;
  state.parsedCsv = null;
  state.csvMapping = {};
  if ($('csvFileInput')) $('csvFileInput').value = '';
  if ($('csvMappingHost')) $('csvMappingHost').replaceChildren();
  if ($('csvBatchSection')) $('csvBatchSection').hidden = false;
  text($('csvStatusBadge'), `失败行重构 ${extracted.count} 条`);
  $('csvErrorBox').hidden = true;
  if (state.lastRunSummary?.args && typeof state.lastRunSummary.args === 'object') {
    setArgsToUI(state.lastRunSummary.args);
  }
  message(
    `已提取 ${extracted.count} 条明确失败行放入待跑队列` +
      (extracted.excludedUnknownCount > 0
        ? `（已严格排除 ${extracted.excludedUnknownCount} 条未知状态行防重）`
        : '') +
      '，请点击“预览执行计划”后重新审批执行。'
  );
}

async function answer() {
  const q = $('question').value.trim();
  const askBtn = $('ask');
  if (askBtn) {
    askBtn.disabled = true;
    text(askBtn, 'AI 分析中...');
  }
  try {
    const res = await answerRunQuestion({
      question: q,
      records: state.records,
      recordSchema: state.recordSchema,
      runSummary: state.lastRunSummary,
      aiClient
    });
    const parts = [String(res.answer || '').trim()];
    if (
      Array.isArray(res.evidenceRefs) &&
      res.evidenceRefs.length > 0 &&
      !parts[0].includes('【证据索引】')
    ) {
      parts.push(`【证据索引】${res.evidenceRefs.join(', ')}`);
    }
    if (Array.isArray(res.caveats) && res.caveats.length > 0 && !parts[0].includes('【说明】')) {
      parts.push(`【说明】${res.caveats.join('；')}`);
    }
    const srcLabel =
      res.mode === 'guard' || res.mode === 'rule'
        ? '安全护栏拦截 · 0 次模型调用'
        : formatAiSourceBadge({
            mode: res.meta?.mode || res.mode,
            model: res.meta?.model,
            latencyMs: res.meta?.latencyMs,
            usage: res.meta?.usage,
            retried: res.meta?.retried,
            degraded: res.degraded,
            errorMessage: res.meta?.degradedReason
          });
    parts.push(`[ ${srcLabel} ]`);
    text($('answer'), parts.filter(Boolean).join('\n'));
    renderQaCharts(res.cannotCompute ? null : res.computedEvidence);
  } catch (e) {
    text($('answer'), `查询分析失败：${e.message}`);
  } finally {
    if (askBtn) {
      askBtn.disabled = false;
      text(askBtn, '查询分析结果');
    }
  }
}

function renderAiTelemetry(stats = aiClient.getStats()) {
  const bar = $('aiTelemetryBar');
  if (!bar) return;
  if (!stats.lastTask) {
    text(
      bar,
      `AI 遥测：尚未调用（累计 ${stats.calls || 0} 次 · 重试 ${stats.retries || 0} · 降级 ${stats.degradedCount || 0}）`
    );
    return;
  }
  const modeLabel =
    stats.lastMode === 'remote' ? (stats.lastError ? '异常/降级' : '远程') : 'Mock';
  const lu = stats.lastUsage;
  const tokPart = lu
    ? ` · ${Number(lu.prompt_tokens || 0)}+${Number(lu.completion_tokens || 0)} tok`
    : '';
  const totalTok = (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0);
  text(
    bar,
    `AI 遥测：最近 ${stats.lastTask} · ${modeLabel} · ${stats.lastModel || '-'} · ${stats.lastLatencyMs || 0}ms${tokPart}（累计 ${stats.calls || 0} 次 · 重试 ${stats.retries || 0} · 降级 ${stats.degradedCount || 0} · 共 ${totalTok} tok）`
  );
}

function populateModelDatalist(models = []) {
  const dl = $('aiModelSuggestions');
  if (!dl) return;
  dl.replaceChildren();
  const uniq = Array.from(new Set((models || []).map((m) => String(m || '').trim()).filter(Boolean))).slice(
    0,
    80
  );
  for (const id of uniq) {
    const opt = element('option');
    opt.value = id;
    dl.append(opt);
  }
}

async function renderAiKeyStatus() {
  const badge = $('aiKeyStatusBadge');
  if (!badge) return;
  const configured = await defaultStore.hasAiApiKey();
  text(badge, configured ? '会话 Key：已配置（仅内存）' : '会话 Key：未配置');
  badge.classList.toggle('ready', configured);
}

function showAiProbeResult(ok, lines) {
  const box = $('aiProbeResult');
  if (!box) return;
  box.className = 'probe-box ' + (ok === true ? 'ok' : ok === false ? 'error' : '');
  text(box, Array.isArray(lines) ? lines.join('\n') : String(lines || ''));
  box.hidden = false;
}

function readAiFormDraft() {
  const sec = Number($('aiTimeoutSec')?.value || 30);
  const timeoutMs = Number.isFinite(sec)
    ? Math.min(Math.max(Math.round(sec * 1000), 5000), 60000)
    : 30000;
  return {
    mode: $('aiMode').value === 'remote' ? 'remote' : 'mock',
    provider: $('aiProvider')?.value || 'siliconflow',
    baseUrl: ($('aiBaseUrl')?.value || '').trim(),
    model: ($('aiModel')?.value || '').trim(),
    timeoutMs,
    thinkingMode: $('aiThinkingMode')?.value === 'off' ? 'off' : 'auto',
    unsavedApiKey: ($('aiApiKey')?.value || '').trim()
  };
}

async function loadAiSettingsUI() {
  const cfg = await defaultStore.getAiConfig();
  $('aiMode').value = cfg.mode;
  if ($('aiProvider')) $('aiProvider').value = cfg.provider || 'siliconflow';
  $('aiBaseUrl').value = cfg.baseUrl || '';
  $('aiModel').value = cfg.model || 'deepseek-v4-flash-0731';
  if ($('aiTimeoutSec')) $('aiTimeoutSec').value = String(Math.round((cfg.timeoutMs || 30000) / 1000));
  if ($('aiThinkingMode')) $('aiThinkingMode').value = cfg.thinkingMode || 'auto';
  const preset = AI_PROVIDER_PRESETS[cfg.provider] || AI_PROVIDER_PRESETS.siliconflow;
  populateModelDatalist([cfg.model, ...(preset?.suggestedModels || [])]);
  $('remoteAiFields').hidden = cfg.mode !== 'remote';
  text($('aiModeTag'), cfg.mode === 'remote' ? `远程 (${cfg.model})` : 'Mock 离线');
  await renderAiKeyStatus();
  renderAiTelemetry();
}

$('aiMode').addEventListener('change', () => {
  $('remoteAiFields').hidden = $('aiMode').value !== 'remote';
  if ($('aiProbeResult')) $('aiProbeResult').hidden = true;
});

$('aiProvider')?.addEventListener('change', () => {
  const pId = $('aiProvider').value;
  const preset = AI_PROVIDER_PRESETS[pId];
  if (preset && pId !== 'custom') {
    $('aiBaseUrl').value = preset.baseUrl;
    $('aiModel').value = preset.defaultModel;
  }
  populateModelDatalist(preset?.suggestedModels || []);
  if ($('aiProbeResult')) $('aiProbeResult').hidden = true;
});

$('testAiConnBtn')?.addEventListener('click', async () => {
  const btn = $('testAiConnBtn');
  const draft = readAiFormDraft();
  const urlCheck = validateRemoteAiBaseUrl(draft.baseUrl);
  if (!urlCheck.ok) {
    showAiProbeResult(false, [`✗ ${urlCheck.message}`]);
    return;
  }
  btn.disabled = true;
  text(btn, '探测中...');
  showAiProbeResult(null, `正在向 ${urlCheck.normalizedUrl} 发送最小 JSON 探针...`);
  try {
    await checkPermission(urlCheck.normalizedUrl, true);
    const res = await aiClient.testConnection({
      baseUrl: urlCheck.normalizedUrl,
      model: draft.model,
      timeoutMs: draft.timeoutMs,
      thinkingMode: draft.thinkingMode,
      apiKey: draft.unsavedApiKey
    });
    if (res.ok) {
      const tokText = res.usage
        ? ` | Token: ${Number(res.usage.prompt_tokens || 0)}+${Number(res.usage.completion_tokens || 0)}`
        : '';
      const replyPreview = res.parsedJson ? JSON.stringify(res.parsedJson) : res.rawPreview;
      showAiProbeResult(true, [
        `✓ ${res.message}（HTTP ${res.httpStatus} · ${res.latencyMs}ms${tokText}）`,
        `模型：${res.model} | 端点：${res.endpoint}`,
        `模型返回：${replyPreview}`,
        ...(res.hint ? [res.hint] : [])
      ]);
    } else {
      showAiProbeResult(false, [
        `✗ 连通失败（${res.httpStatus ? 'HTTP ' + res.httpStatus : res.errorCode} · ${res.latencyMs}ms）`,
        `原因：${res.message}`,
        `排查建议：${res.hint}`
      ]);
    }
  } catch (e) {
    showAiProbeResult(false, [`✗ 无法发起连通测试：${e.message}`]);
  } finally {
    btn.disabled = false;
    text(btn, '测试连通性');
  }
});

$('fetchAiModelsBtn')?.addEventListener('click', async () => {
  const btn = $('fetchAiModelsBtn');
  const draft = readAiFormDraft();
  const urlCheck = validateRemoteAiBaseUrl(draft.baseUrl);
  if (!urlCheck.ok) {
    showAiProbeResult(false, [`✗ ${urlCheck.message}`]);
    return;
  }
  btn.disabled = true;
  text(btn, '拉取中...');
  showAiProbeResult(null, `正在拉取 ${urlCheck.normalizedUrl}/models ...`);
  try {
    await checkPermission(urlCheck.normalizedUrl, true);
    const res = await aiClient.listModels({
      baseUrl: urlCheck.normalizedUrl,
      model: draft.model,
      timeoutMs: draft.timeoutMs,
      apiKey: draft.unsavedApiKey
    });
    if (res.ok) {
      populateModelDatalist([draft.model, ...res.models]);
      const dsPreview = res.deepseekModels.length
        ? `DeepSeek 候选(${res.deepseekModels.length})：${res.deepseekModels.slice(0, 6).join(', ')}`
        : `前几项示例：${res.models.slice(0, 6).join(', ')}`;
      showAiProbeResult(true, [
        `✓ 已拉取 ${res.count} 个模型并填入候选下拉（HTTP ${res.httpStatus} · ${res.latencyMs}ms）`,
        dsPreview
      ]);
    } else {
      showAiProbeResult(false, [
        `✗ 拉取模型列表失败（${res.httpStatus ? 'HTTP ' + res.httpStatus : res.errorCode} · ${res.latencyMs}ms）`,
        `原因：${res.message}`,
        `排查建议：${res.hint}`
      ]);
    }
  } catch (e) {
    showAiProbeResult(false, [`✗ 拉取模型列表失败：${e.message}`]);
  } finally {
    btn.disabled = false;
    text(btn, '拉取模型列表');
  }
});

$('saveAiConfig').addEventListener('click', async () => {
  try {
    const draft = readAiFormDraft();
    if (draft.mode === 'remote') {
      const urlCheck = validateRemoteAiBaseUrl(draft.baseUrl);
      if (!urlCheck.ok) {
        throw new Error(urlCheck.message);
      }
      // Bug 3 修复：用户手势内为主机模型网关申请权限，防内网网关 CORS 拦截
      await checkPermission(urlCheck.normalizedUrl, true);
    }
    const saved = await defaultStore.saveAiConfig({
      mode: draft.mode,
      provider: draft.provider,
      baseUrl: draft.baseUrl,
      model: draft.model,
      timeoutMs: draft.timeoutMs,
      thinkingMode: draft.thinkingMode
    });
    if (draft.unsavedApiKey) {
      await defaultStore.setAiApiKey(draft.unsavedApiKey);
      $('aiApiKey').value = '';
    }
    await loadAiSettingsUI();
    message(
      `模型配置已保存（${saved.provider} · ${saved.mode} · ${saved.model} · 超时 ${Math.round(saved.timeoutMs / 1000)}s，API Key 仅存 session 内存）。`
    );
  } catch (e) {
    message('保存模型设置失败：' + e.message);
  }
});

$('clearAiKey').addEventListener('click', async () => {
  await defaultStore.clearAiApiKey();
  $('aiApiKey').value = '';
  await renderAiKeyStatus();
  message('已清空会话内存中的 API Key。');
});

$('enableBatchLoop')?.addEventListener('change', () => {
  state.userTouchedBatchLoop = true;
});

$('csvFileInput').addEventListener('change', async (evt) => {
  const file = evt.target.files?.[0];
  if (!file) return;
  await invalidateApproval('已重新选择 CSV 文件，请核对映射后预览执行计划。');
  const csvText = await file.text();
  state.parsedCsv = parseCsv(csvText);
  const datasetParam = getDatasetParam(state.loaded);
  const { mapping } = autoMapCsvColumns(state.parsedCsv.headers, datasetParam?.columns || []);
  state.csvMapping = mapping;
  renderCsvMappingUI(datasetParam);
});

$('fillSampleArgsBtn').addEventListener('click', async () => {
  document.querySelectorAll('.runtime-param').forEach((input) => {
    if (input.dataset.sample) input.value = input.dataset.sample;
  });
  await invalidateApproval('已填入录制示例参数，请重新预览执行计划。');
});

$('writeModeSelect').addEventListener('change', () => {
  if (state.pendingSnapshot) {
    invalidateApproval('写操作防护模式已变更，原计划审批已自动失效，请重新预览。');
  }
});
$('runAuthPolicySelect').addEventListener('change', () => {
  if (state.pendingSnapshot) {
    invalidateApproval('鉴权策略已变更，原计划审批已自动失效，请重新预览。');
  }
});

$('approvePilotRemaining').addEventListener('click', async () => {
  if (!state.activeController?.approveRemainingAndContinue) return;
  const res = await state.activeController.approveRemainingAndContinue();
  if (
    res.state &&
    !['PAUSED_AUTH_REQUIRED', 'PAUSED_PILOT_REVIEW', 'PAUSED_CONFIRM_REQUIRED'].includes(res.state.status)
  ) {
    await invalidateApproval();
    state.activeController = null;
  }
});
$('cancelPilotRemaining').addEventListener('click', handleCancelRun);

$('markUnknownVerified').addEventListener('click', async () => {
  if (!state.activeController?.resolveUnknownRowAndResume) return;
  const res = await state.activeController.resolveUnknownRowAndResume({ resolution: 'verified' });
  if (
    res.state &&
    !['PAUSED_AUTH_REQUIRED', 'PAUSED_PILOT_REVIEW', 'PAUSED_CONFIRM_REQUIRED'].includes(res.state.status)
  ) {
    await invalidateApproval();
    state.activeController = null;
  }
});
$('markUnknownFailed').addEventListener('click', async () => {
  if (!state.activeController?.resolveUnknownRowAndResume) return;
  const res = await state.activeController.resolveUnknownRowAndResume({
    resolution: 'failed',
    note: '人工核对未入库'
  });
  if (
    res.state &&
    !['PAUSED_AUTH_REQUIRED', 'PAUSED_PILOT_REVIEW', 'PAUSED_CONFIRM_REQUIRED'].includes(res.state.status)
  ) {
    await invalidateApproval();
    state.activeController = null;
  }
});
$('cancelUnknownRun').addEventListener('click', handleCancelRun);

$('start').addEventListener('click', start);
$('stop').addEventListener('click', stop);
$('grantCurrentSite').addEventListener('click', grantCurrentSiteForRecording);
$('analyzeDraftBtn').addEventListener('click', runAnalyzeDraft);
$('saveSkill').addEventListener('click', saveSkill);
$('downloadSkill').addEventListener('click', downloadSkill);
$('pickExtractFieldBtn').addEventListener('click', handlePickExtractField);
$('cancelExtractPickBtn').addEventListener('click', handleCancelExtractPick);
$('skillSearchInput').addEventListener('input', () => filterSkillOptions());
$('importSkillBtn').addEventListener('click', () => $('importSkillFile').click());
$('importSkillFile').addEventListener('change', async (evt) => {
  const file = evt.target.files?.[0];
  evt.target.value = '';
  if (!file) return;
  try {
    const rawText = await file.text();
    const res = await defaultStore.importSkillJson(rawText);
    if (!res.ok) {
      throw new Error(`${res.errorCode || 'SKILL_IMPORT_INVALID'}: ${res.message}`);
    }
    await renderSkillPicker(res.skill.id);
    message(`已导入并校验通过技能“${res.skill.name}”（${res.skill.steps.length} 步）。`);
  } catch (e) {
    message('导入技能失败：' + e.message);
  }
});
$('deleteSkillBtn').addEventListener('click', () => {
  if (!state.loaded) return;
  text($('deleteSkillConfirmText'), `确认从本地技能库永久删除“${state.loaded.name}”？此操作不可撤销。`);
  $('deleteSkillConfirmCard').hidden = false;
});
$('cancelDeleteSkillBtn').addEventListener('click', () => {
  $('deleteSkillConfirmCard').hidden = true;
});
$('confirmDeleteSkillBtn').addEventListener('click', async () => {
  if (!state.loaded) return;
  const delName = state.loaded.name;
  const delId = state.loaded.id;
  $('deleteSkillConfirmCard').hidden = true;
  await defaultStore.deleteSkill(delId);
  await invalidateApproval();
  state.loaded = null;
  $('skillPicker').value = '';
  await renderSkillPicker();
  await loadSkill({ prefillDefaults: false });
  message(`已删除技能“${delName}”。`);
});
$('previewResumeCheckpointBtn').addEventListener('click', handlePreviewResumeCheckpoint);
$('discardCheckpointBtn').addEventListener('click', async () => {
  if (!state.activeCheckpoint) return;
  const runId = state.activeCheckpoint.runId;
  await defaultStore.clearRunCheckpoint(runId);
  if (state.pendingResumeCheckpoint?.runId === runId) {
    await invalidateApproval();
  }
  await refreshCheckpointBanner();
  message('已丢弃该批量执行断点记录。');
});
$('exportSkillMd').addEventListener('click', exportLoadedSkillMd);
$('exportMcpJson').addEventListener('click', exportLoadedMcpJson);
$('exportEvalJson').addEventListener('click', exportTelemetryLogJson);
$('exportRecordsCsvBtn').addEventListener('click', () => handleExportRecordsCsv(false));
$('exportFailedCsvBtn').addEventListener('click', () => handleExportRecordsCsv(true));
$('loadFailedRowsBtn').addEventListener('click', handleLoadFailedRowsToQueue);
$('runHistoryPicker').addEventListener('change', () => {
  const id = $('runHistoryPicker').value;
  if (id) loadHistoricalRun(id);
});
$('startRebindBtn').addEventListener('click', handleStartRebind);
$('cancelRebindBtn').addEventListener('click', handleCancelRebind);
$('matchSkillBtn').addEventListener('click', runMatchSkill);
$('extractArgsBtn').addEventListener('click', runExtractArgs);
$('skillPicker').addEventListener('change', () => loadSkill({ prefillDefaults: false }));
$('preview').addEventListener('click', preview);
$('run').addEventListener('click', execute);
$('cancelPlan').addEventListener('click', () => invalidateApproval('已取消当前计划审批。'));
$('riskApprove').addEventListener('click', () => {
  $('riskPrompt').hidden = true;
  if (state.riskResolver) {
    const resolve = state.riskResolver;
    state.riskResolver = null;
    resolve(true);
  }
});
$('riskReject').addEventListener('click', () => {
  $('riskPrompt').hidden = true;
  if (state.riskResolver) {
    const resolve = state.riskResolver;
    state.riskResolver = null;
    resolve(false);
  }
});
$('resumeAuthManual').addEventListener('click', handleResumeManualAuth);
$('submitEphemeralAuth').addEventListener('click', handleSubmitEphemeralAuth);
$('switchToManualAuth').addEventListener('click', handleSwitchToManualAuth);
$('cancelRunBtnA').addEventListener('click', handleCancelRun);
$('ask').addEventListener('click', answer);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.recording) {
    state.recording = changes.recording.newValue || null;
    setStatus(Boolean(state.recording?.active));
  }
  if (changes.currentSession && state.recording?.active) {
    state.session = changes.currentSession.newValue;
    renderSteps();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'RECORDING_SITE_PERMISSION_REQUIRED') {
    state.recording = {
      ...(state.recording || { active: true }),
      pendingAuthOrigin: msg.origin,
      pendingAuthUrl: msg.url
    };
    renderSiteAuthBanner();
    message(`检测到跨站跳转至未授权站点 ${msg.origin}，请点击上方“授权当前站点并继续录制”。`);
  }
});

(async () => {
  await loadAiSettingsUI();
  const bundle = await defaultStore.getRecordingBundle();
  state.recording = bundle.recording;
  state.session = bundle.currentSession;
  setStatus(Boolean(state.recording?.active));
  renderSteps();
  if (state.session && !state.recording?.active) {
    renderParameterEditor();
    renderDistillAndPreview();
    disableSave(!state.session.steps?.length);
  }
  await renderSkillPicker();
  await refreshRunHistoryPicker();
  await refreshCheckpointBanner();
  updateRecordActionButtons();
})().catch((e) => message(e.message));
