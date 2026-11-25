import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createBackgroundController } from '../extension/background.js';
import {
  applyBatchLoopPartition,
  autoMapCsvColumns,
  createBatchRunner,
  parseCsv,
  validateAndBindBatchRows
} from '../extension/lib/batch-runner.js';
import { createDriver } from '../extension/lib/driver.js';
import { buildPlanSnapshot } from '../extension/lib/plan-builder.js';
import { createRunController } from '../extension/lib/run-controller.js';
import { normalizeSkillIR, validateSkillIR } from '../extension/lib/schemas.js';
import { applyRebindToSkill } from '../extension/lib/skill-analyzer.js';
import {
  buildEvalTelemetryPayload,
  exportMcpToolJson,
  exportSkillMarkdown,
  formatMcpToolJson
} from '../extension/lib/skill-exporter.js';
import { createStore } from '../extension/lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.resolve(__dirname, '..');
const EXT_DIR = path.join(SOURCE_DIR, 'extension');

// ---------------------------------------------------------------------------
// 1. 微瑕 1：Mv3ContentScriptDriver forceReload + batch-runner applyRowReset
// ---------------------------------------------------------------------------
{
  let reloadCalls = 0;
  let updateCalls = 0;
  let tabUrl = 'http://127.0.0.1:18762/sys_b_form.html';
  let rowSubmitCount = 0;
  let receiptState = 'idle';

  const sessionStore = {};
  let bgCtrl = null;
  const chromeMock = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) =>
        await new Promise((resolve) =>
          bgCtrl.handleMessage(msg, { tab: { id: 10 }, url: tabUrl }, resolve)
        )
    },
    permissions: { contains: async () => true },
    tabs: {
      onUpdated: { addListener: () => {} },
      query: async () => [{ id: 10, url: tabUrl, status: 'complete' }],
      get: async () => ({ id: 10, url: tabUrl, status: 'complete' }),
      reload: async () => {
        reloadCalls++;
        receiptState = 'idle';
      },
      update: async (_tid, { url }) => {
        updateCalls++;
        tabUrl = url;
        receiptState = 'idle';
        return { id: 10, url };
      },
      sendMessage: async (_tid, msg) => {
        if (msg.type === 'PING') return { ok: true, url: tabUrl };
        if (msg.type === 'PLAY_STEP') {
          if (msg.step.action === 'click' && msg.step.target?.text === '提交台账') {
            rowSubmitCount++;
            // 验证进入第 2 行前页面已被复位为 idle
            assert.equal(receiptState, 'idle', '每行提交前旧回执必须已被 forceReload 清空为 idle');
            receiptState = 'ok';
            return { ok: true, matchedLocator: 'text' };
          }
          return { ok: true, matchedLocator: 'label+tag' };
        }
        if (msg.type === 'EXTRACT_RECORDS') {
          return {
            ok: true,
            found: true,
            mode: 'receipt',
            statusAttr: receiptState,
            statusText: receiptState,
            errorText: '',
            boxText: `单号 GD-${rowSubmitCount}`,
            extractedFields: { receiptNo: `GD-${rowSubmitCount}` }
          };
        }
        return { ok: true };
      }
    },
    scripting: { executeScript: async () => {} },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: {
        get: async (k) => (k in sessionStore ? { [k]: structuredClone(sessionStore[k]) } : {}),
        set: async (p) => Object.assign(sessionStore, structuredClone(p)),
        remove: async (k) => { delete sessionStore[k]; }
      }
    }
  };

  bgCtrl = createBackgroundController(chromeMock);
  const driver = createDriver('mv3-content', {
    chromeApi: chromeMock,
    allowedOrigins: ['http://127.0.0.1:18762'],
    stepDelayMs: 0
  });
  await driver.ensureSession();

  const noForce = await driver.navigate('http://127.0.0.1:18762/sys_b_form.html');
  assert.equal(noForce.reloaded, false);
  assert.equal(reloadCalls, 0);

  const forced = await driver.navigate('http://127.0.0.1:18762/sys_b_form.html', { forceReload: true });
  assert.equal(forced.reloaded, true);
  assert.equal(reloadCalls, 1);

  const batchSkill = normalizeSkillIR({
    id: 'sk-reset-test',
    name: '行间复位验证',
    startUrl: 'http://127.0.0.1:18762/sys_b_form.html',
    allowedOrigins: ['http://127.0.0.1:18762'],
    parameters: [
      {
        key: 'batchRows',
        label: 'CSV',
        type: 'dataset',
        columns: [{ key: 'orgName', label: '供电单位', type: 'string', required: true }]
      }
    ],
    batchLoop: {
      enabled: true,
      datasetParam: 'batchRows',
      preSteps: [],
      rowSteps: ['s1', 's2'],
      postSteps: [],
      pilotCount: 0,
      rowResetRule: { type: 'navigateOrClick', url: 'http://127.0.0.1:18762/sys_b_form.html' }
    },
    extractSpec: {
      mode: 'receipt',
      containerSelector: '#receipt-box',
      statusSelector: '#receipt-status',
      errorSelector: '#receipt-error',
      fields: [{ key: 'receiptNo', selector: '#receipt-no' }, { key: 'orgName', source: 'row.orgName' }]
    },
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18762', valueRef: { rowField: 'orgName' }, target: { label: '供电单位' } },
      { id: 's2', action: 'click', origin: 'http://127.0.0.1:18762', target: { text: '提交台账' }, risk: 'write_commit' }
    ]
  });

  const rows = [{ orgName: '杭州供电所' }, { orgName: '宁波供电所' }];
  const snap = await buildPlanSnapshot({ skill: batchSkill, args: {}, writeMode: 'commit', batchRows: rows });
  const runner = createBatchRunner({
    driver,
    store: null,
    approvalClient: {
      approvePlan: (m) => bgCtrl.approvePlan(m),
      verifyPlan: (m) => bgCtrl.verifyPlan(m),
      revokePlan: (m) => bgCtrl.revokePlan(m)
    }
  });
  const res = await runner.start({ skill: batchSkill, snapshot: snap, batchRows: rows });
  assert.equal(res.status, 'VERIFIED_SUCCESS');
  assert.equal(reloadCalls, 2, '第 2 行开始前必须通过 forceReload 复位页面');

  // 兼容 rowResetRule.type === 'click' + selector
  let resetBtnClicked = false;
  const clickDriver = {
    async ensureSession() { return { currentUrl: 'http://127.0.0.1:18762/sys_b_form.html' }; },
    async navigate() { return { finalUrl: 'http://127.0.0.1:18762/sys_b_form.html' }; },
    async executeStep(step) {
      if (step.target?.cssPath === '#reset-btn') resetBtnClicked = true;
      return { ok: true, matchedLocator: 'cssPath' };
    },
    async extractRecords() {
      return {
        receiptStatus: 'verified',
        receiptNo: 'GD-1',
        records: [{ receiptNo: 'GD-1', orgName: '杭州' }],
        recordSchema: [{ key: 'receiptNo', type: 'string' }],
        evidenceLevel: 'L2'
      };
    }
  };
  const clickSkill = structuredClone(batchSkill);
  clickSkill.batchLoop.rowResetRule = { type: 'click', selector: '#reset-btn' };
  const clickSnap = await buildPlanSnapshot({ skill: clickSkill, args: {}, writeMode: 'commit', batchRows: rows });
  const clickRunner = createBatchRunner({
    driver: clickDriver,
    store: null,
    approvalClient: {
      approvePlan: (m) => bgCtrl.approvePlan(m),
      verifyPlan: (m) => bgCtrl.verifyPlan(m),
      revokePlan: (m) => bgCtrl.revokePlan(m)
    }
  });
  const clickRes = await clickRunner.start({ skill: clickSkill, snapshot: clickSnap, batchRows: rows });
  assert.equal(clickRes.status, 'VERIFIED_SUCCESS');
  assert.equal(resetBtnClicked, true, 'rowResetRule.selector=#reset-btn 应兼容点击复位');
  console.log('PASS: Micro-fix 1 forceReload & selector reset rule in batch row loop');
}

// ---------------------------------------------------------------------------
// 2. 微瑕 2 & 3：跨双系统批量切分 & 无 extractSpec 返回 ACTIONS_COMPLETED_UNVERIFIED (L0)
// ---------------------------------------------------------------------------
{
  const crossSkill = normalizeSkillIR({
    id: 'sk-cross-split',
    name: '跨系统查询并批量录入',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    allowedOrigins: ['http://127.0.0.1:18761', 'http://127.0.0.1:18762'],
    steps: [
      { id: 's1', action: 'auth_checkpoint', origin: 'http://127.0.0.1:18761' },
      { id: 's2', action: 'fill', origin: 'http://127.0.0.1:18761', paramKey: 'unit', target: { label: '查询单位' } },
      { id: 's3', action: 'click', origin: 'http://127.0.0.1:18761', target: { text: '查询数据' } },
      { id: 's4', action: 'extract', origin: 'http://127.0.0.1:18761', target: { cssPath: '#result-table td' }, outputVar: 'batchCodeVar' },
      { id: 's5', action: 'navigate', origin: 'http://127.0.0.1:18762', url: 'http://127.0.0.1:18762/sys_b_form.html' },
      { id: 's6', action: 'fill', origin: 'http://127.0.0.1:18762', paramKey: 'orgName', target: { label: '供电单位' } },
      { id: 's7', action: 'fill', origin: 'http://127.0.0.1:18762', valueRef: { var: 'batchCodeVar' }, target: { label: '关联客户批号' } },
      { id: 's8', action: 'fill', origin: 'http://127.0.0.1:18762', paramKey: 'kwh', target: { label: '申报电量' } },
      { id: 's9', action: 'click', origin: 'http://127.0.0.1:18762', target: { text: '提交台账' }, risk: 'write_commit' }
    ]
  });

  const collected = [
    { key: 'unit', label: '查询单位', type: 'string', required: true, sourceStepId: 's2' },
    { key: 'orgName', label: '供电单位', type: 'string', required: true, sourceStepId: 's6' },
    { key: 'kwh', label: '申报电量', type: 'number', required: true, sourceStepId: 's8' }
  ];

  const { skill: partitioned, datasetColumns } = applyBatchLoopPartition({
    skill: crossSkill,
    collectedParams: collected,
    pilotCount: 2
  });

  assert.deepEqual(partitioned.batchLoop.preSteps, ['s1', 's2', 's3', 's4', 's5']);
  assert.deepEqual(partitioned.batchLoop.rowSteps, ['s6', 's7', 's8', 's9']);
  assert.equal(partitioned.batchLoop.rowResetRule.url, 'http://127.0.0.1:18762/sys_b_form.html');
  assert.deepEqual(
    datasetColumns.map((c) => c.key),
    ['orgName', 'kwh'],
    '仅系统 B 字段进入 CSV dataset 列'
  );
  assert.equal(partitioned.parameters[0].key, 'unit', '系统 A 标量参数保留在顶层 parameters');
  assert.equal(partitioned.steps.find((s) => s.id === 's7').valueRef.var, 'batchCodeVar', '系统 A->B 变量引用保留');
  assert.equal(validateSkillIR(partitioned).ok, true);

  // 微瑕 3：未配置 extractSpec 的批量执行严禁标为 verified 或 VERIFIED_SUCCESS
  const noExtractSkill = normalizeSkillIR({
    id: 'sk-no-extract',
    name: '无回执采集合约批量',
    startUrl: 'http://127.0.0.1:18762/sys_b_form.html',
    allowedOrigins: ['http://127.0.0.1:18762'],
    parameters: [
      { key: 'batchRows', label: 'CSV', type: 'dataset', columns: [{ key: 'orgName', label: '供电单位', type: 'string', required: true }] }
    ],
    batchLoop: {
      enabled: true,
      datasetParam: 'batchRows',
      preSteps: [],
      rowSteps: ['s1', 's2'],
      postSteps: [],
      pilotCount: 0,
      rowResetRule: { type: 'navigateOrClick', url: 'http://127.0.0.1:18762/sys_b_form.html' }
    },
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18762', valueRef: { rowField: 'orgName' }, target: { label: '供电单位' } },
      { id: 's2', action: 'click', origin: 'http://127.0.0.1:18762', target: { text: '提交台账' }, risk: 'write_commit' }
    ]
  });

  const sessStore = {};
  const bg = createBackgroundController({
    runtime: { onInstalled: { addListener: () => {} }, onMessage: { addListener: () => {} } },
    storage: {
      session: {
        get: async (k) => (k in sessStore ? { [k]: structuredClone(sessStore[k]) } : {}),
        set: async (p) => Object.assign(sessStore, structuredClone(p)),
        remove: async (k) => { delete sessStore[k]; }
      }
    }
  });
  const rows = [{ orgName: '杭州' }, { orgName: '温州' }];
  const snap = await buildPlanSnapshot({ skill: noExtractSkill, args: {}, writeMode: 'commit', batchRows: rows });
  const unverifiedRunner = createBatchRunner({
    driver: {
      async ensureSession() { return { currentUrl: 'http://127.0.0.1:18762/sys_b_form.html' }; },
      async navigate() { return { finalUrl: 'http://127.0.0.1:18762/sys_b_form.html' }; },
      async executeStep() { return { ok: true, matchedLocator: 'text' }; }
    },
    store: null,
    approvalClient: {
      approvePlan: (m) => bg.approvePlan(m),
      verifyPlan: (m) => bg.verifyPlan(m),
      revokePlan: (m) => bg.revokePlan(m)
    }
  });
  const noExtRes = await unverifiedRunner.start({ skill: noExtractSkill, snapshot: snap, batchRows: rows });
  assert.equal(noExtRes.status, 'ACTIONS_COMPLETED_UNVERIFIED');
  assert.equal(noExtRes.evidenceLevel, 'L0');
  assert.equal(noExtRes.batchSummary.verified, 0);
  assert.equal(noExtRes.batchSummary.unverified, 2);
  assert.ok(noExtRes.ledger.every((r) => r.status === 'unverified' && r.evidenceLevel === 'L0'));
  console.log('PASS: Micro-fixes 2 & 3 cross-origin batch split and strict L0 unverified status');
}

// ---------------------------------------------------------------------------
// 3. FR-15: skill-exporter.js 一键导出 SKILL.md & MCP Tool JSON + 脱敏
// ---------------------------------------------------------------------------
{
  const readSkill = normalizeSkillIR({
    id: 'sk-read-01',
    name: '营销台账月度查询',
    intent: '按单位和月份查询电量表结构',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html?token=SECRET_TOK_999&menuId=M1',
    allowedOrigins: ['http://127.0.0.1:18761'],
    parameters: [
      { key: 'unit', label: '查询单位', type: 'string', required: true },
      { key: 'month', label: '查询月份', type: 'month', required: true }
    ],
    extractSpec: { mode: 'table', containerSelector: '#result-table' },
    resultSelector: '#result-summary',
    steps: [
      { id: 's1', action: 'auth_checkpoint', origin: 'http://127.0.0.1:18761', sensitive: true, value: 'LEAK_PW' },
      { id: 's2', action: 'fill', origin: 'http://127.0.0.1:18761', paramKey: 'unit', target: { label: '查询单位' } },
      { id: 's3', action: 'click', origin: 'http://127.0.0.1:18761', target: { text: '查询数据' } }
    ]
  });
  readSkill.apiKey = 'sk-should-be-redacted';

  const md = exportSkillMarkdown(readSkill);
  assert.ok(md.startsWith('---\n'));
  assert.ok(md.includes('name: "营销台账月度查询"'));
  assert.ok(md.includes('## 适用系统'));
  assert.ok(md.includes('## 输入参数与 CSV 列定义'));
  assert.ok(md.includes('## 执行步骤与风险门禁'));
  assert.ok(md.includes('## 业务核验与采集规范'));
  assert.equal(md.includes('SECRET_TOK_999'), false, '导出 SKILL.md 不得包含 URL token');
  assert.equal(md.includes('LEAK_PW'), false, '导出 SKILL.md 不得包含敏感密码');
  assert.equal(md.includes('sk-should-be-redacted'), false, '导出 SKILL.md 不得包含 API Key');

  const mcpRead = exportMcpToolJson(readSkill);
  assert.equal(mcpRead.name, 'skillflow_sk-read-01');
  assert.equal(mcpRead.annotations.readOnlyHint, true);
  assert.equal(mcpRead.annotations.destructiveHint, false);
  assert.deepEqual(mcpRead.inputSchema.required, ['unit', 'month']);
  assert.equal(mcpRead.inputSchema.properties.month.pattern, '^\\d{4}-(0[1-9]|1[0-2])$');

  const writeSkill = normalizeSkillIR({
    id: 'sk-write-batch',
    name: '台账批量录入',
    allowedOrigins: ['http://127.0.0.1:18762'],
    parameters: [
      {
        key: 'batchRows',
        label: 'CSV 数据',
        type: 'dataset',
        required: true,
        columns: [
          { key: 'orgName', label: '供电单位', type: 'string', required: true },
          { key: 'kwh', label: '申报电量', type: 'number', required: true }
        ]
      }
    ],
    batchLoop: { enabled: true, datasetParam: 'batchRows', preSteps: [], rowSteps: ['s1'], postSteps: [], pilotCount: 2 },
    steps: [{ id: 's1', action: 'click', origin: 'http://127.0.0.1:18762', target: { text: '提交台账' }, risk: 'write_commit' }]
  });
  const mcpWriteText = formatMcpToolJson(writeSkill);
  const mcpWrite = JSON.parse(mcpWriteText);
  assert.equal(mcpWrite.annotations.readOnlyHint, false);
  assert.equal(mcpWrite.annotations.destructiveHint, true);
  assert.equal(mcpWrite.inputSchema.properties.batchRows.type, 'array');
  assert.equal(mcpWrite.inputSchema.properties.batchRows.items.properties.kwh.type, 'number');
  console.log('PASS: FR-15 skill-exporter SKILL.md & MCP Tool JSON + redaction');
}

// ---------------------------------------------------------------------------
// 4. FR-17: content.js START_PICK_ELEMENT / CANCEL_PICK_ELEMENT + 单步重绑 Re-bind
// ---------------------------------------------------------------------------
{
  const listeners = new Map();
  const recordedEmits = [];
  let onMsg = null;

  class PickNode {
    constructor(tagName, attrs = {}, textContent = '') {
      this.nodeType = 1;
      this.localName = tagName.toLowerCase();
      this.tagName = tagName.toUpperCase();
      this.attrs = new Map(Object.entries(attrs));
      this.children = [];
      this.parentElement = null;
      this.style = { outline: '', outlineOffset: '' };
      this.isConnected = true;
      this._text = textContent;
    }
    get id() { return this.attrs.get('id') || ''; }
    set id(v) { this.attrs.set('id', String(v)); }
    get className() { return this.attrs.get('class') || ''; }
    set className(v) { this.attrs.set('class', String(v)); }
    get childNodes() { return this.children.length ? this.children : this._text ? [{ nodeType: 3, nodeValue: this._text }] : []; }
    get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
    set textContent(v) { this._text = String(v ?? ''); }
    get offsetParent() { return { tagName: 'BODY' }; }
    getClientRects() { return [{ width: 80, height: 28 }]; }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    hasAttribute(k) { return this.attrs.has(k); }
    contains(other) {
      let cur = other;
      while (cur) { if (cur === this) return true; cur = cur.parentElement; }
      return false;
    }
    matches(sel) {
      return sel.split(',').map((s) => s.trim()).some((p) => {
        if (p.startsWith('#')) return this.id === p.slice(1);
        if (p.startsWith('[')) return this.hasAttribute(p.slice(1, -1));
        return this.localName === p.toLowerCase();
      });
    }
    closest(sel) {
      let cur = this;
      while (cur) { if (cur.matches(sel)) return cur; cur = cur.parentElement; }
      return null;
    }
    append(...nodes) {
      for (const n of nodes) { n.parentElement = this; this.children.push(n); }
      return this;
    }
  }

  const body = new PickNode('body');
  const newBtn = new PickNode('button', { id: 'rebound-btn', 'data-testid': 'query-v3-btn' }, '查询台账');
  body.append(newBtn);

  const doc = {
    body,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type) || [];
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    querySelectorAll: () => [newBtn],
    querySelector: () => newBtn,
    createElement: (tag, attrs, txt) => new PickNode(tag, attrs, txt)
  };
  const dispatch = (type, target, extra = {}) => {
    const arr = [...(listeners.get(type) || [])];
    const evt = {
      type,
      target,
      isTrusted: true,
      defaultPrevented: false,
      stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...extra
    };
    for (const fn of arr) fn(evt);
    return evt;
  };

  const sandbox = {
    document: doc,
    location: { origin: 'http://127.0.0.1:18761', href: 'http://127.0.0.1:18761/sys_a_query.html' },
    chrome: {
      runtime: {
        id: 'pick-test',
        sendMessage: async (m) => recordedEmits.push(m),
        onMessage: { addListener: (fn) => { onMsg = fn; } }
      }
    },
    getComputedStyle: (el) => el.style,
    CSS: { escape: (s) => s },
    WeakMap, WeakSet, Set, Array, Object, String, Boolean, Number, Date, Error, Promise, setTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8'), sandbox);

  // 开启录制 + 启动选点：选点期间绝不产生误录制
  await new Promise((r) => onMsg({ type: 'SET_RECORDING', enabled: true }, {}, r));
  let pickResult = null;
  const pickDone = new Promise((r) => {
    onMsg({ type: 'START_PICK_ELEMENT' }, {}, (res) => {
      pickResult = res;
      r(res);
    });
  });

  dispatch('mouseover', newBtn);
  assert.equal(newBtn.style.outline, '2px solid #e03131', '悬停元素应高亮红色边框');
  const clickEvt = dispatch('click', newBtn);
  await pickDone;
  assert.equal(clickEvt.defaultPrevented, true);
  assert.equal(clickEvt.stopped, true);
  assert.equal(newBtn.style.outline, '', '选定后应恢复高亮样式');
  assert.equal(pickResult.ok, true);
  assert.equal(pickResult.target.testId, 'query-v3-btn');
  assert.equal(recordedEmits.length, 0, '选点期间点击绝不误触发录制');

  // CANCEL_PICK_ELEMENT 与 Escape 取消选点
  const escPromise = new Promise((r) => onMsg({ type: 'START_PICK_ELEMENT' }, {}, r));
  dispatch('keydown', body, { key: 'Escape' });
  const escRes = await escPromise;
  assert.equal(escRes.ok, false);
  assert.equal(escRes.cancelled, true);

  const msgCancelPromise = new Promise((r) => onMsg({ type: 'START_PICK_ELEMENT' }, {}, r));
  const ackCancel = await new Promise((r) => onMsg({ type: 'CANCEL_PICK_ELEMENT' }, {}, r));
  assert.equal(ackCancel.ok, true);
  const canceledRes = await msgCancelPromise;
  assert.equal(canceledRes.cancelled, true);

  // RunController 失败暴露 failedStepIndex / failedStepId + applyRebindToSkill
  const brokenSkill = normalizeSkillIR({
    id: 'sk-rebind',
    name: '重绑测试技能',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    allowedOrigins: ['http://127.0.0.1:18761'],
    parameters: [{ key: 'unit', label: '查询单位', type: 'string', required: true, sourceStepId: 's1' }],
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18761', paramKey: 'unit', target: { label: '查询单位' } },
      { id: 's2', action: 'click', origin: 'http://127.0.0.1:18761', target: { cssPath: '#missing-btn', text: '旧按钮' } }
    ]
  });
  const sess = {};
  const bg = createBackgroundController({
    runtime: { onInstalled: { addListener: () => {} }, onMessage: { addListener: () => {} } },
    storage: {
      session: {
        get: async (k) => (k in sess ? { [k]: structuredClone(sess[k]) } : {}),
        set: async (p) => Object.assign(sess, structuredClone(p)),
        remove: async (k) => { delete sess[k]; }
      }
    }
  });
  const snap = await buildPlanSnapshot({ skill: brokenSkill, args: { unit: '杭州供电所' } });
  const ctrl = createRunController({
    driver: {
      async ensureSession() { return { currentUrl: brokenSkill.startUrl }; },
      async executeStep(step) {
        if (step.id === 's2') {
          return { ok: false, errorCode: 'TARGET_AMBIGUOUS', message: '命中 2 个同名按钮' };
        }
        return { ok: true, matchedLocator: 'label+tag' };
      }
    },
    store: null,
    approvalClient: {
      approvePlan: (m) => bg.approvePlan(m),
      verifyPlan: (m) => bg.verifyPlan(m),
      revokePlan: (m) => bg.revokePlan(m)
    }
  });
  const failRun = await ctrl.start({ skill: brokenSkill, snapshot: snap });
  assert.equal(failRun.status, 'FAILED');
  assert.equal(failRun.errorCode, 'TARGET_AMBIGUOUS');
  assert.equal(failRun.failedStepIndex, 1);
  assert.equal(failRun.failedStepId, 's2');
  assert.equal(failRun.locatorStats.hits, 1);
  assert.equal(failRun.locatorStats.ambiguousCount, 1);

  const rebound = applyRebindToSkill(brokenSkill, {
    stepIndex: failRun.failedStepIndex,
    stepId: failRun.failedStepId,
    newTarget: pickResult.target
  });
  assert.equal(rebound.ok, true);
  assert.equal(rebound.skill.version, brokenSkill.version + 1);
  assert.equal(rebound.skill.steps[1].target.testId, 'query-v3-btn');
  assert.deepEqual(rebound.skill.steps[0], brokenSkill.steps[0], '非重绑步骤不得被改动');
  assert.deepEqual(rebound.skill.parameters, brokenSkill.parameters, '重绑不得丢失参数定义');

  // FR-18: buildEvalTelemetryPayload 脱敏校验
  const telemetry = buildEvalTelemetryPayload({
    skill: rebound.skill,
    distilled: { rawBytes: 12000, distilledBytes: 1200, compressionRatio: 0.9, estimatedTokens: 400, nodes: [{}] },
    runSummary: failRun,
    modelUsage: { totalCalls: 1, apiKey: 'MUST_BE_REMOVED' },
    recordsCount: 0
  });
  assert.equal(JSON.stringify(telemetry).includes('MUST_BE_REMOVED'), false);
  assert.equal(telemetry.domMetrics.compressionRatio, 0.9);
  assert.equal(telemetry.runSummary.locatorStats.ambiguousCount, 1);
  console.log('PASS: FR-17 element picker, failedStep tracking, Re-bind & FR-18 telemetry redaction');
}

// ---------------------------------------------------------------------------
// 5. 封版回归：forceReload 竞态 + ?layout=v2&ambiguous=1 重绑恢复 + batchCode 可选列
// ---------------------------------------------------------------------------
{
  // 5a. 延迟异步 onUpdated 竞态：tabs.reload() 刚触发时 tabs.get() 仍返回旧页 complete，必须等到新页 onUpdated complete
  let pageEpoch = 1;
  const activeListeners = new Set();
  const raceUrl = 'http://127.0.0.1:18762/sys_b_form.html';
  const raceSession = {};
  let raceBg = null;

  const raceChrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) =>
        await new Promise((r) => raceBg.handleMessage(msg, { tab: { id: 88 }, url: raceUrl }, r))
    },
    permissions: { contains: async () => true },
    tabs: {
      onUpdated: {
        addListener: (fn) => activeListeners.add(fn),
        removeListener: (fn) => activeListeners.delete(fn)
      },
      query: async () => [{ id: 88, url: raceUrl, status: 'complete' }],
      get: async () => ({ id: 88, url: raceUrl, status: 'complete', pageEpoch }),
      reload: async () => {
        // 故意保持旧 pageEpoch === 1 与 status: 'complete'，直到 30ms 后真正完成重载
        setTimeout(() => {
          pageEpoch = 2;
          for (const fn of [...activeListeners]) {
            fn(88, { status: 'complete' }, { id: 88, url: raceUrl, status: 'complete', pageEpoch });
          }
        }, 30);
      },
      update: async () => ({ id: 88, url: raceUrl, status: 'complete' }),
      sendMessage: async () => ({ ok: true, url: raceUrl })
    },
    scripting: { executeScript: async () => {} },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: {
        get: async (k) => (k in raceSession ? { [k]: structuredClone(raceSession[k]) } : {}),
        set: async (p) => Object.assign(raceSession, structuredClone(p)),
        remove: async (k) => { delete raceSession[k]; }
      }
    }
  };
  raceBg = createBackgroundController(raceChrome);
  const raceDriver = createDriver('mv3-content', {
    chromeApi: raceChrome,
    allowedOrigins: ['http://127.0.0.1:18762'],
    readyTimeoutMs: 2000,
    stepDelayMs: 0
  });
  await raceDriver.ensureSession();
  const navRes = await raceDriver.navigate(raceUrl, { forceReload: true });
  assert.equal(navRes.reloaded, true);
  assert.equal(pageEpoch, 2, 'navigate(forceReload:true) 必须等待新页 onUpdated complete 完成而非读取旧页面');
  assert.equal(activeListeners.size, 0, 'waitForNavigationComplete 完成后必须注销 onUpdated 监听器');

  // 5b. ?layout=v2&ambiguous=1 真实 DOM：重绑前报 TARGET_AMBIGUOUS -> START_PICK_ELEMENT + applyRebindToSkill -> cssPath-rebound 唯一命中
  const listeners = new Map();
  let onMsg = null;

  class AmbNode {
    constructor(tagName, attrs = {}, textContent = '') {
      this.nodeType = 1;
      this.localName = tagName.toLowerCase();
      this.tagName = tagName.toUpperCase();
      this.attrs = new Map(Object.entries(attrs));
      this.children = [];
      this.parentElement = null;
      this.style = { outline: '', outlineOffset: '' };
      this.isConnected = true;
      this._text = textContent;
    }
    get id() { return this.attrs.get('id') || ''; }
    set id(v) { this.attrs.set('id', String(v)); }
    get className() { return this.attrs.get('class') || ''; }
    set className(v) { this.attrs.set('class', String(v)); }
    get childNodes() { return this.children.length ? this.children : this._text ? [{ nodeType: 3, nodeValue: this._text }] : []; }
    get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
    set textContent(v) { this._text = String(v ?? ''); }
    get offsetParent() { return { tagName: 'BODY' }; }
    getClientRects() { return [{ width: 90, height: 30 }]; }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    hasAttribute(k) { return this.attrs.has(k); }
    contains(other) {
      let cur = other;
      while (cur) { if (cur === this) return true; cur = cur.parentElement; }
      return false;
    }
    matches(sel) {
      return sel.split(',').map((s) => s.trim()).some((part) => {
        const tokens = part.split(/\s*>\s*/);
        const matchTok = (node, tok) => {
          if (!tok) return false;
          if (tok.startsWith('#')) return node.id === tok.slice(1).replace(/\\/g, '');
          if (tok.startsWith('.')) return node.className.split(/\s+/).includes(tok.slice(1));
          const nth = tok.match(/^([a-z0-9*]+):nth-of-type\((\d+)\)$/i);
          if (nth) {
            if (node.localName !== nth[1].toLowerCase()) return false;
            const sibs = (node.parentElement?.children || []).filter((c) => c.localName === node.localName);
            return sibs[Number(nth[2]) - 1] === node;
          }
          if (tok.startsWith('[')) return node.hasAttribute(tok.slice(1, -1));
          return node.localName === tok.toLowerCase();
        };
        if (!matchTok(this, tokens[tokens.length - 1])) return false;
        let cur = this.parentElement;
        for (let i = tokens.length - 2; i >= 0; i--) {
          if (!cur || !matchTok(cur, tokens[i])) return false;
          cur = cur.parentElement;
        }
        return true;
      });
    }
    closest(sel) {
      let cur = this;
      while (cur) { if (cur.matches(sel)) return cur; cur = cur.parentElement; }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.matches(sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    append(...nodes) {
      for (const n of nodes) { n.parentElement = this; this.children.push(n); }
      return this;
    }
  }

  const body = new AmbNode('body');
  const queryPanel = new AmbNode('div', { id: 'query-panel', class: 'card' });
  const btnHost = new AmbNode('div', { id: 'query-btn-host' });
  const v2Layer = new AmbNode('div', { class: 'v2-layer' });
  const v2Inner = new AmbNode('div', { class: 'v2-inner' });
  const v2QueryBtn = new AmbNode('button', { id: 'ext-gen-9103', type: 'button' }, '查询数据');
  v2Inner.append(v2QueryBtn);
  v2Layer.append(v2Inner);
  btnHost.append(v2Layer);

  const ambHost = new AmbNode('div', { id: 'ambiguous-host' });
  const dupQueryBtn = new AmbNode('button', { id: 'dup-query-btn', type: 'button' }, '查询数据');
  ambHost.append(dupQueryBtn);
  queryPanel.append(btnHost, ambHost);
  body.append(queryPanel);

  const ambDoc = {
    body,
    addEventListener: (t, fn) => {
      if (!listeners.has(t)) listeners.set(t, []);
      listeners.get(t).push(fn);
    },
    removeEventListener: (t, fn) => {
      const arr = listeners.get(t) || [];
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    querySelectorAll: (s) => body.querySelectorAll(s),
    querySelector: (s) => body.querySelector(s),
    createElement: (t, a, tx) => new AmbNode(t, a, tx)
  };
  const ambSandbox = {
    document: ambDoc,
    location: { origin: 'http://127.0.0.1:18761', href: 'http://127.0.0.1:18761/sys_a_query.html?layout=v2&ambiguous=1' },
    chrome: {
      runtime: {
        id: 'amb-ext',
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener: (fn) => { onMsg = fn; } }
      }
    },
    getComputedStyle: (el) => el.style,
    CSS: { escape: (s) => s },
    WeakMap, WeakSet, Set, Array, Object, String, Boolean, Number, Date, Error, Promise, setTimeout
  };
  ambSandbox.globalThis = ambSandbox;
  vm.createContext(ambSandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8'), ambSandbox);
  const ambHooks = ambSandbox.__skillflowTestHooks;

  // 重绑前旧技能（无 testId 匹配且动态 ID 变动 -> text 歧义拦截）
  const v1Skill = normalizeSkillIR({
    id: 'sk-v2-amb',
    name: 'v2 歧义测试技能',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    allowedOrigins: ['http://127.0.0.1:18761'],
    steps: [
      {
        id: 's1',
        action: 'click',
        origin: 'http://127.0.0.1:18761',
        target: { tag: 'button', text: '查询数据', cssPath: '#query-btn-host > button', testId: 'query-btn', stableId: '#query-btn' }
      }
    ]
  });
  const preRebind = ambHooks.locateTarget(v1Skill.steps[0].target);
  assert.equal(preRebind.ok, false);
  assert.equal(preRebind.errorCode, 'TARGET_AMBIGUOUS', '未重绑步骤遇同名可见按钮必须继续拦截 TARGET_AMBIGUOUS');

  // 触发单步重绑点击 #ext-gen-9103
  const pickP = new Promise((r) => onMsg({ type: 'START_PICK_ELEMENT' }, {}, r));
  for (const fn of [...(listeners.get('click') || [])]) {
    fn({ type: 'click', target: v2QueryBtn, isTrusted: true, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  }
  const pickedV2 = await pickP;
  assert.equal(pickedV2.ok, true);
  assert.equal(pickedV2.target.cssPath, '#query-btn-host > div > div > button');

  const reboundRes = applyRebindToSkill(v1Skill, { stepIndex: 0, stepId: 's1', newTarget: pickedV2.target });
  assert.equal(reboundRes.ok, true);
  assert.equal(reboundRes.skill.steps[0].target.rebound, true);

  const postRebind = ambHooks.locateTarget(reboundRes.skill.steps[0].target);
  assert.equal(postRebind.ok, true, '显式重绑后即使 text 同名也应回退至唯一 cssPath');
  assert.equal(postRebind.element, v2QueryBtn);
  assert.equal(postRebind.matchedLocator, 'cssPath-rebound');

  // 若 cssPath 本身仍匹配多个可见节点，即使 rebound:true 也绝不盲选首个
  const stillAmbigTarget = { tag: 'button', text: '查询数据', cssPath: 'button', rebound: true };
  const stillAmbig = ambHooks.locateTarget(stillAmbigTarget);
  assert.equal(stillAmbig.ok, false);
  assert.equal(stillAmbig.errorCode, 'TARGET_AMBIGUOUS');

  // 5c. applyBatchLoopPartition batchCode 默认非必填，兼容 5 列 sample_batch.csv 与 6 列含批号 CSV
  const crossWithBatch = normalizeSkillIR({
    id: 'sk-batch-opt',
    name: '含批号跨系统批量',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    allowedOrigins: ['http://127.0.0.1:18761', 'http://127.0.0.1:18762'],
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18761', paramKey: 'unit', target: { label: '查询单位' } },
      { id: 's2', action: 'navigate', origin: 'http://127.0.0.1:18762', url: 'http://127.0.0.1:18762/sys_b_form.html' },
      { id: 's3', action: 'fill', origin: 'http://127.0.0.1:18762', paramKey: 'orgName', target: { label: '供电单位' } },
      { id: 's4', action: 'fill', origin: 'http://127.0.0.1:18762', paramKey: 'batchCode', target: { label: '关联客户批号' } },
      { id: 's5', action: 'fill', origin: 'http://127.0.0.1:18762', paramKey: 'meterNo', target: { label: '表计编号' } },
      { id: 's6', action: 'fill', origin: 'http://127.0.0.1:18762', paramKey: 'kwh', target: { label: '申报电量' } },
      { id: 's7', action: 'select', origin: 'http://127.0.0.1:18762', paramKey: 'voltage', target: { label: '电压等级' } },
      { id: 's8', action: 'fill', origin: 'http://127.0.0.1:18762', paramKey: 'remark', target: { label: '备注' } },
      { id: 's9', action: 'click', origin: 'http://127.0.0.1:18762', target: { text: '提交台账' }, risk: 'write_commit' }
    ]
  });
  const params6 = [
    { key: 'unit', label: '查询单位', type: 'string', required: true, sourceStepId: 's1' },
    { key: 'orgName', label: '供电单位', type: 'string', required: true, sourceStepId: 's3' },
    { key: 'batchCode', label: '关联客户批号', type: 'string', required: true, sourceStepId: 's4' },
    { key: 'meterNo', label: '表计编号', type: 'string', required: true, sourceStepId: 's5' },
    { key: 'kwh', label: '申报电量', type: 'number', required: true, sourceStepId: 's6' },
    { key: 'voltage', label: '电压等级', type: 'string', required: true, sourceStepId: 's7' },
    { key: 'remark', label: '备注', type: 'string', required: true, sourceStepId: 's8' }
  ];
  const partOut = applyBatchLoopPartition({ skill: crossWithBatch, collectedParams: params6, pilotCount: 2 });
  assert.equal(partOut.datasetColumns.find((c) => c.key === 'batchCode').required, false);
  assert.equal(partOut.datasetColumns.find((c) => c.key === 'remark').required, false);

  const sampleCsv = parseCsv(fs.readFileSync(path.join(SOURCE_DIR, 'demo-site', 'sample_batch.csv'), 'utf8'));
  const map5 = autoMapCsvColumns(sampleCsv.headers, partOut.datasetColumns);
  assert.deepEqual(map5.unmappedRequired, [], '5 列 sample_batch.csv 无需手动改表头即可通过校验');
  const bound5 = validateAndBindBatchRows(sampleCsv, partOut.datasetColumns, map5.mapping);
  assert.equal(bound5.ok, true);
  assert.equal(bound5.rowCount, 12);

  const csv6 = parseCsv('供电单位,关联客户批号,表计编号,申报电量,电压等级,备注\n杭州供电所,KH-202611-HZ01,M-01,1200,10kV,带批号\n');
  const map6 = autoMapCsvColumns(csv6.headers, partOut.datasetColumns);
  const bound6 = validateAndBindBatchRows(csv6, partOut.datasetColumns, map6.mapping);
  assert.equal(bound6.ok, true);
  assert.equal(bound6.rows[0].batchCode, 'KH-202611-HZ01');
  console.log('PASS: Closure regressions (forceReload onUpdated race, layout=v2&ambiguous=1 Re-bind, optional batchCode CSV)');
}
