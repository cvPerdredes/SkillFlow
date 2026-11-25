import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createBackgroundController } from '../extension/background.js';
import { createAiClient } from '../extension/lib/ai-client.js';
import {
  applyBatchLoopPartition,
  createBatchRunner,
  extractFailedRowsForRetry
} from '../extension/lib/batch-runner.js';
import { createDriver } from '../extension/lib/driver.js';
import { buildPlanSnapshot } from '../extension/lib/plan-builder.js';
import { normalizeSkillIR, validateSkillIR } from '../extension/lib/schemas.js';
import {
  analyzeRecordedTrace,
  applyDraftToSkillIR,
  buildExtractStepFromPick,
  fallbackAnalyzeTrace,
  insertExtractStep
} from '../extension/lib/skill-analyzer.js';
import { exportRecordsCsv } from '../extension/lib/skill-exporter.js';
import { createStore } from '../extension/lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.resolve(__dirname, '..');
const EXT_DIR = path.join(SOURCE_DIR, 'extension');

// ---------------------------------------------------------------------------
// 1. 模块 A2: store.importSkillJson 强校验、去重覆盖、拦截投毒 & deleteSkill
// ---------------------------------------------------------------------------
{
  const localMem = {};
  const chromeStoreMock = {
    storage: {
      local: {
        get: async (k) => {
          const arr = Array.isArray(k) ? k : [k];
          return Object.fromEntries(arr.filter((x) => x in localMem).map((x) => [x, structuredClone(localMem[x])]));
        },
        set: async (p) => Object.assign(localMem, structuredClone(p))
      },
      session: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {}
      }
    }
  };
  const store = createStore(chromeStoreMock);

  const validSkillJson = JSON.stringify({
    id: 'sk-imp-1',
    name: '导入台账查询 V1',
    schemaVersion: '0.3',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html?token=DROP_ME&menuId=M1',
    allowedOrigins: ['http://127.0.0.1:18761'],
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18761', paramKey: 'unit', target: { label: '查询单位' } },
      { id: 's2', action: 'click', origin: 'http://127.0.0.1:18761', target: { text: '查询数据' } }
    ]
  });

  const imp1 = await store.importSkillJson(validSkillJson);
  assert.equal(imp1.ok, true);
  assert.equal(imp1.skill.id, 'sk-imp-1');
  assert.equal(imp1.skill.startUrl.includes('DROP_ME'), false, '导入技能 URL token 必须清洗');

  // 同 id 再次导入应去重覆盖而非重复追加
  const impOverride = await store.importSkillJson(
    JSON.stringify({
      ...JSON.parse(validSkillJson),
      name: '导入台账查询 V2 覆盖版'
    })
  );
  assert.equal(impOverride.ok, true);
  const allAfterOverride = await store.getSkills();
  assert.equal(allAfterOverride.length, 1);
  assert.equal(allAfterOverride[0].name, '导入台账查询 V2 覆盖版');

  // 拒绝非法动作 executeScript、非法 origin 与敏感密码投毒
  const badScript = await store.importSkillJson(
    JSON.stringify({
      id: 'bad-exec',
      name: '恶意脚本',
      steps: [{ id: 's1', action: 'executeScript', origin: 'http://127.0.0.1:18761' }]
    })
  );
  assert.equal(badScript.ok, false);
  assert.equal(badScript.errorCode, 'SKILL_IMPORT_INVALID');

  const badOrigin = await store.importSkillJson(
    JSON.stringify({
      id: 'bad-origin',
      name: '非法地址',
      startUrl: 'javascript:alert(1)',
      steps: [{ id: 's1', action: 'click', origin: 'http://127.0.0.1:18761' }]
    })
  );
  assert.equal(badOrigin.ok, false);
  assert.equal(badOrigin.errorCode, 'SKILL_IMPORT_INVALID');

  const badSecret = await store.importSkillJson(
    JSON.stringify({
      id: 'bad-secret',
      name: '含敏感原值',
      steps: [
        {
          id: 's1',
          action: 'fill',
          origin: 'http://127.0.0.1:18761',
          target: { label: '登录密码', type: 'password' },
          value: 'SECRET_12345'
        }
      ]
    })
  );
  assert.equal(badSecret.ok, false);
  assert.equal(badSecret.errorCode, 'SKILL_IMPORT_INVALID');

  const badSyntax = await store.importSkillJson('{bad json');
  assert.equal(badSyntax.ok, false);

  await store.deleteSkill('sk-imp-1');
  assert.equal((await store.getSkills()).length, 0);
  console.log('PASS: store.importSkillJson validation/dedup & poison blocking + deleteSkill');
}

// ---------------------------------------------------------------------------
// 2. 模块 A3: exportRecordsCsv (UTF-8 BOM / RFC-4180 / 公式注入防护 / failedOnly / 脱敏)
// ---------------------------------------------------------------------------
{
  const schema = [
    { key: 'rowIndex', label: '行号', type: 'number' },
    { key: 'orgName', label: '供电单位', type: 'string' },
    { key: 'kwh', label: '申报电量', type: 'number' },
    { key: 'status', label: '执行状态', type: 'status' },
    { key: 'error', label: '失败原因', type: 'string' },
    { key: 'remark', label: '备注', type: 'string' }
  ];
  const rows = [
    {
      rowIndex: 1,
      orgName: '杭州,供电所',
      kwh: 12800,
      status: 'verified',
      error: '',
      remark: '正常 "双引号" 记录',
      apiKey: 'sk-must-redact'
    },
    {
      rowIndex: 2,
      orgName: '=CMD|"/C calc"!A0',
      kwh: -12.5,
      status: 'failed',
      error: '+SUM(1,2) 电量超限',
      remark: '@RISK\t=1+1'
    },
    {
      rowIndex: 3,
      orgName: '-malicious_cell',
      kwh: 900,
      status: 'unknown',
      error: '\rWRITE_OUTCOME_UNKNOWN',
      remark: '未知回执'
    }
  ];

  const allCsv = exportRecordsCsv(rows, schema, { failedOnly: false });
  assert.ok(allCsv.startsWith('\uFEFF'), '必须带 UTF-8 BOM 防止 Windows Excel 乱码');
  assert.equal(allCsv.includes('sk-must-redact'), false, '导出 CSV 不得泄露敏感密钥字段');
  assert.ok(allCsv.includes('"杭州,供电所"'), '含逗号单元格必须按 RFC-4180 加引号');
  assert.ok(allCsv.includes('"正常 ""双引号"" 记录"'), '含双引号单元格必须双写转义');
  assert.ok(allCsv.includes(`"'=CMD|""/C calc""!A0"`), '= 开头公式必须前置单引号并转义引号');
  assert.ok(allCsv.includes(`'+SUM(1,2) 电量超限`), '+ 开头非纯数字字符串必须前置单引号');
  assert.ok(allCsv.includes(`'@RISK\t=1+1`), '@ 开头公式必须前置单引号');
  assert.ok(allCsv.includes(`'-malicious_cell`), '- 开头非纯数字字符串必须前置单引号');
  assert.ok(allCsv.includes(',-12.5,'), '纯负数 -12.5 不得被误加单引号');
  assert.ok(allCsv.includes('"\'\rWRITE_OUTCOME_UNKNOWN"'), '\\r 开头字符串必须前置单引号');

  const failedOnlyCsv = exportRecordsCsv(rows, schema, { failedOnly: true });
  const failedLines = failedOnlyCsv.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(failedLines.length, 3, 'failedOnly=true 应仅含 1 行表头 + 2 条 failed/unknown 行');
  assert.equal(failedOnlyCsv.includes('杭州,供电所'), false, 'failedOnly=true 不得包含已成功行');
  console.log('PASS: exportRecordsCsv BOM, RFC-4180, formula-injection guard, redaction & failedOnly');
}

// ---------------------------------------------------------------------------
// 3. 模块 A1: analyzeTrace & fallbackAnalyzeTrace 优先选用状态栏而非 #result-table
// ---------------------------------------------------------------------------
{
  const session = {
    id: 'sess-sel',
    name: '系统 A 查询',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18761', target: { label: '查询单位' }, value: '杭州供电所' },
      { id: 's2', action: 'click', origin: 'http://127.0.0.1:18761', target: { text: '查询数据' } }
    ]
  };
  const distilledSysA = {
    ok: true,
    rawBytes: 15000,
    distilledBytes: 800,
    compressionRatio: 0.94,
    estimatedTokens: 300,
    nodeCount: 3,
    pageContext: { title: '系统 A 营销查询', headings: [], selectOptionsSample: {} },
    tables: [{ selector: '#result-table', headers: ['客户批号', '供电单位'], rowCount: 2 }],
    statusContainers: [
      { selector: '#result-table', dataStatus: '', text: '混淆条目' },
      { selector: '#result-summary', dataStatus: 'idle', text: '尚未查询' }
    ],
    snapshot: []
  };

  const mockAi = createAiClient({ getConfig: async () => ({ mode: 'mock' }) });
  const aiRes = await analyzeRecordedTrace({ session, distilled: distilledSysA, aiClient: mockAi });
  assert.equal(aiRes.draft.resultSelectorHint, '#result-summary', 'analyzeTrace 必须选 #result-summary 而非 #result-table');
  assert.equal(aiRes.draft.extractHint.containerSelector, '#result-table');

  const fbDraft = fallbackAnalyzeTrace({ session, distilled: distilledSysA });
  assert.equal(fbDraft.resultSelectorHint, '#result-summary', 'fallbackAnalyzeTrace 必须优先选 #result-summary');

  const distilledSysB = {
    ...distilledSysA,
    tables: [{ selector: '#ledger-table', headers: ['回执单号'], rowCount: 0 }],
    statusContainers: [
      { selector: '#receipt-box', dataStatus: 'idle', text: '...' },
      { selector: '#receipt-status', dataStatus: 'idle', text: 'idle' }
    ]
  };
  const aiResB = await analyzeRecordedTrace({ session, distilled: distilledSysB, aiClient: mockAi });
  assert.equal(aiResB.draft.resultSelectorHint, '#receipt-status');
  console.log('PASS: analyzeTrace & fallbackAnalyzeTrace prioritize status bar for resultSelector');
}

// ---------------------------------------------------------------------------
// 4. 模块 B2: extract 模式选点（不吞 <td> / 清空 target.text 槽位回放）+ 下游 valueRef.var 跨系统保留
// ---------------------------------------------------------------------------
{
  const listeners = new Map();
  let onMsg = null;

  class TableNode {
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
    getClientRects() { return [{ width: 90, height: 24 }]; }
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

  const body = new TableNode('body');
  const formWrap = new TableNode('div', { role: 'button' });
  const table = new TableNode('table', { id: 'result-table' });
  const tbody = new TableNode('tbody');
  const tr1 = new TableNode('tr');
  const td1 = new TableNode('td', {}, 'KH-202611-HZ01');
  const td2 = new TableNode('td', {}, '杭州供电所');
  tr1.append(td1, td2);
  tbody.append(tr1);
  table.append(tbody);
  formWrap.append(table);
  body.append(formWrap);

  const doc = {
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
    createElement: (t, a, tx) => new TableNode(t, a, tx)
  };
  const sandbox = {
    document: doc,
    location: { origin: 'http://127.0.0.1:18761', href: 'http://127.0.0.1:18761/sys_a_query.html' },
    chrome: {
      runtime: {
        id: 'extract-pick-test',
        sendMessage: async () => ({ ok: true }),
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

  // extract 模式悬停与点击 td 时绝不归并到外层 [role="button"]
  const pickPromise = new Promise((r) => onMsg({ type: 'START_PICK_ELEMENT', opts: { mode: 'extract' } }, {}, r));
  for (const fn of [...(listeners.get('mouseover') || [])]) {
    fn({ type: 'mouseover', target: td1, isTrusted: true });
  }
  assert.equal(td1.style.outline, '2px solid #0b7285');
  for (const fn of [...(listeners.get('click') || [])]) {
    fn({ type: 'click', target: td1, isTrusted: true, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  }
  const picked = await pickPromise;
  assert.equal(picked.ok, true);
  assert.equal(picked.target.tag, 'td', 'extract 模式不得把 <td> 归并成外层交互控件');
  assert.equal(picked.target.cssPath, '#result-table > tbody > tr:nth-of-type(1) > td:nth-of-type(1)');

  const extractStep = buildExtractStepFromPick({
    pickedTarget: picked.target,
    origin: 'http://127.0.0.1:18761',
    outputVar: 'batchCodeVar',
    stepId: 's3_ext'
  });
  assert.equal(extractStep.target.text, '', 'extract 步骤必须清空 target.text 以便按槽位定位新结果');

  // 换成 B 单位查询后的 2 行新数据，回放 PLAY_STEP 应按槽位定位第 1 行第 1 列提取新批号
  td1.textContent = 'KH-202611-B01';
  const tr2 = new TableNode('tr');
  tr2.append(new TableNode('td', {}, 'KH-202611-B02'), new TableNode('td', {}, 'B单位'));
  tbody.append(tr2);

  const playExtract = await new Promise((r) => onMsg({ type: 'PLAY_STEP', step: extractStep }, {}, r));
  assert.equal(playExtract.ok, true);
  assert.equal(playExtract.extractedValue, 'KH-202611-B01');

  // 验证下游填报字段选择 {{var.batchCodeVar}} 经过 applyDraftToSkillIR 与 applyBatchLoopPartition 后保留 valueRef.var
  const crossSess = {
    id: 'sess-var-flow',
    name: '零代码跨系统取数填报',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18761', target: { label: '查询单位' }, value: '杭州供电所' },
      { id: 's2', action: 'click', origin: 'http://127.0.0.1:18761', target: { text: '查询数据' } },
      extractStep,
      { id: 's4', action: 'navigate', origin: 'http://127.0.0.1:18762', url: 'http://127.0.0.1:18762/sys_b_form.html' },
      { id: 's5', action: 'fill', origin: 'http://127.0.0.1:18762', target: { label: '供电单位' }, value: '杭州供电所' },
      { id: 's6', action: 'fill', origin: 'http://127.0.0.1:18762', target: { label: '关联客户批号' }, value: 'OLD_VAL' },
      { id: 's7', action: 'click', origin: 'http://127.0.0.1:18762', target: { text: '提交台账' }, risk: 'write_commit' }
    ]
  };
  const uiCollected = [
    { key: 'queryUnit', label: '查询单位', type: 'string', required: true, sourceStepId: 's1' },
    { key: 'orgName', label: '供电单位', type: 'string', required: true, sourceStepId: 's5' }
  ];
  const { skill: draftedSkill } = applyDraftToSkillIR({
    session: crossSess,
    overrides: {
      parameters: uiCollected,
      stepVarBindings: { s6: 'batchCodeVar' }
    }
  });
  const s6Bound = draftedSkill.steps.find((s) => s.id === 's6');
  assert.deepEqual(s6Bound.valueRef, { var: 'batchCodeVar' });

  const { skill: batchVarSkill, datasetColumns } = applyBatchLoopPartition({
    skill: draftedSkill,
    collectedParams: uiCollected,
    pilotCount: 2
  });
  assert.deepEqual(datasetColumns.map((c) => c.key), ['orgName'], '引用 var 的步骤不应挤占 CSV 必填列');
  assert.deepEqual(batchVarSkill.steps.find((s) => s.id === 's6').valueRef, { var: 'batchCodeVar' });
  assert.equal(validateSkillIR(batchVarSkill).ok, true);

  // insertExtractStep 回归：跨系统含 <a id="goto-sys-b"> 跳站链接时插在 click <a> 与 navigate 18762 之前，并归入 preSteps
  const rawCrossSteps = [
    { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18761', target: { label: '查询单位' }, value: '杭州供电所' },
    { id: 's2', action: 'click', origin: 'http://127.0.0.1:18761', target: { tag: 'button', text: '查询数据' } },
    { id: 's3_link', action: 'click', origin: 'http://127.0.0.1:18761', target: { tag: 'a', id: 'goto-sys-b', cssPath: '#goto-sys-b', text: '前往系统B' } },
    { id: 's4', action: 'navigate', origin: 'http://127.0.0.1:18762', url: 'http://127.0.0.1:18762/sys_b_form.html' },
    { id: 's5', action: 'fill', origin: 'http://127.0.0.1:18762', target: { label: '供电单位' }, value: '杭州供电所' },
    { id: 's6', action: 'fill', origin: 'http://127.0.0.1:18762', target: { label: '关联客户批号' }, value: 'OLD_VAL' },
    { id: 's7', action: 'click', origin: 'http://127.0.0.1:18762', target: { text: '提交台账' }, risk: 'write_commit' }
  ];
  const arrangedCross = insertExtractStep(
    rawCrossSteps,
    extractStep,
    'http://127.0.0.1:18761/sys_a_query.html'
  );
  assert.equal(rawCrossSteps.length, 7, 'insertExtractStep 必须是纯函数，不得原地修改输入数组');
  assert.deepEqual(
    arrangedCross.map((s) => s.id),
    ['s1', 's2', 's3_ext', 's3_link', 's4', 's5', 's6', 's7'],
    'extract 应插在 click 查询之后、click <a> 与 navigate 18762 之前'
  );

  const { skill: draftedArranged } = applyDraftToSkillIR({
    session: { ...crossSess, steps: arrangedCross },
    overrides: {
      parameters: uiCollected,
      stepVarBindings: { s6: 'batchCodeVar' }
    }
  });
  const { skill: batchArranged } = applyBatchLoopPartition({
    skill: draftedArranged,
    collectedParams: uiCollected,
    pilotCount: 2
  });
  assert.deepEqual(
    batchArranged.batchLoop.preSteps,
    ['s1', 's2', 's3_ext', 's3_link', 's4'],
    'insertExtractStep 插入的 extract 应随跨系统前置链路正确归入 preSteps'
  );
  assert.deepEqual(batchArranged.batchLoop.rowSteps, ['s5', 's6', 's7']);
  assert.deepEqual(batchArranged.steps.find((s) => s.id === 's6').valueRef, { var: 'batchCodeVar' });
  assert.equal(validateSkillIR(batchArranged).ok, true);

  // 无 <a> 点击直接 navigate 18762 时插到 navigate 前；单站录制时追加末尾
  assert.deepEqual(
    insertExtractStep(
      [rawCrossSteps[0], rawCrossSteps[1], rawCrossSteps[3], rawCrossSteps[4]],
      extractStep,
      'http://127.0.0.1:18761/sys_a_query.html'
    ).map((s) => s.id),
    ['s1', 's2', 's3_ext', 's4', 's5']
  );
  assert.deepEqual(
    insertExtractStep(
      [rawCrossSteps[0], rawCrossSteps[1]],
      extractStep,
      'http://127.0.0.1:18761/sys_a_query.html'
    ).map((s) => s.id),
    ['s1', 's2', 's3_ext'],
    '单站录制应将 extract 追加到步骤末尾'
  );
  console.log('PASS: extract-mode picker (<td> slot CSS & empty text) + insertExtractStep + valueRef.var batch preservation');
}

// ---------------------------------------------------------------------------
// 5. 模块 B3: resumeFromCheckpoint（不重放已完成行 / 新 planHash 审批 / UNKNOWN 不重放）& extractFailedRowsForRetry
// ---------------------------------------------------------------------------
{
  const createCheckpointHarness = ({ unknownRow = null } = {}) => {
    const localStore = {};
    const sessionStore = {};
    let currentUrl = 'http://127.0.0.1:18762/sys_b_form.html';
    const submitCounts = new Map();
    const rowForm = {};
    let rowSeq = 0;

    let bgCtrl;
    const chromeMock = {
      runtime: {
        onInstalled: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        sendMessage: async (m) =>
          await new Promise((r) => bgCtrl.handleMessage(m, { tab: { id: 1 }, url: currentUrl }, r))
      },
      permissions: { contains: async () => true },
      tabs: {
        onUpdated: { addListener: () => {} },
        query: async () => [{ id: 1, url: currentUrl, status: 'complete' }],
        get: async () => ({ id: 1, url: currentUrl, status: 'complete' }),
        reload: async () => { rowForm.orgName = ''; rowForm.kwh = ''; },
        update: async (_tid, { url }) => { currentUrl = url; rowForm.orgName = ''; rowForm.kwh = ''; return { id: 1, url }; },
        sendMessage: async (_tid, msg) => {
          if (msg.type === 'PING') return { ok: true, url: currentUrl };
          if (msg.type === 'PLAY_STEP') {
            if (msg.step.action === 'fill') {
              rowForm[msg.step.valueRef?.rowField || 'field'] = msg.step.value;
              return { ok: true, matchedLocator: 'label+tag' };
            }
            if (msg.step.action === 'click') {
              const key = `${rowForm.orgName}:${rowForm.kwh}`;
              const cnt = (submitCounts.get(key) || 0) + 1;
              submitCounts.set(key, cnt);
              return { ok: true, matchedLocator: 'text' };
            }
          }
          if (msg.type === 'EXTRACT_RECORDS') {
            rowSeq++;
            if (unknownRow && unknownRow === `${rowForm.orgName}:${rowForm.kwh}`) {
              return { ok: true, found: true, mode: 'receipt', statusAttr: 'idle', statusText: 'idle', errorText: '', extractedFields: { receiptNo: '-' } };
            }
            if (rowForm.orgName === '未备案所') {
              return { ok: true, found: true, mode: 'receipt', statusAttr: 'error', statusText: 'error', errorText: '单位代码不存在', extractedFields: { receiptNo: '-' } };
            }
            return {
              ok: true,
              found: true,
              mode: 'receipt',
              statusAttr: 'ok',
              statusText: 'ok',
              errorText: '',
              extractedFields: { receiptNo: `GD-${rowSeq}` }
            };
          }
          return { ok: true };
        }
      },
      scripting: { executeScript: async () => {} },
      storage: {
        local: {
          get: async (k) => {
            const arr = Array.isArray(k) ? k : [k];
            return Object.fromEntries(arr.filter((x) => x in localStore).map((x) => [x, structuredClone(localStore[x])]));
          },
          set: async (p) => Object.assign(localStore, structuredClone(p))
        },
        session: {
          get: async (k) => (k in sessionStore ? { [k]: structuredClone(sessionStore[k]) } : {}),
          set: async (p) => Object.assign(sessionStore, structuredClone(p)),
          remove: async (k) => { delete sessionStore[k]; }
        }
      }
    };
    bgCtrl = createBackgroundController(chromeMock);
    const store = createStore(chromeMock);
    const driver = createDriver('mv3-content', { chromeApi: chromeMock, stepDelayMs: 0 });
    const approvalClient = {
      approvePlan: (m) => bgCtrl.approvePlan(m),
      verifyPlan: (m) => bgCtrl.verifyPlan(m),
      revokePlan: (m) => bgCtrl.revokePlan(m)
    };
    return { store, driver, approvalClient, submitCounts };
  };

  const skill = normalizeSkillIR({
    id: 'sk-resume-batch',
    name: '断点续跑测试技能',
    startUrl: 'http://127.0.0.1:18762/sys_b_form.html',
    allowedOrigins: ['http://127.0.0.1:18762'],
    parameters: [
      {
        key: 'batchRows',
        label: 'CSV',
        type: 'dataset',
        columns: [
          { key: 'orgName', label: '供电单位', type: 'string', required: true },
          { key: 'kwh', label: '申报电量', type: 'number', required: true }
        ]
      }
    ],
    batchLoop: {
      enabled: true,
      datasetParam: 'batchRows',
      preSteps: [],
      rowSteps: ['s1', 's2', 's3'],
      postSteps: [],
      pilotCount: 2,
      rowResetRule: { type: 'navigateOrClick', url: 'http://127.0.0.1:18762/sys_b_form.html' }
    },
    extractSpec: {
      mode: 'receipt',
      containerSelector: '#receipt-box',
      statusSelector: '#receipt-status',
      errorSelector: '#receipt-error',
      fields: [
        { key: 'receiptNo', selector: '#receipt-no' },
        { key: 'orgName', source: 'row.orgName' },
        { key: 'kwh', source: 'row.kwh', type: 'number' }
      ]
    },
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18762', valueRef: { rowField: 'orgName' }, target: { label: '供电单位' } },
      { id: 's2', action: 'fill', origin: 'http://127.0.0.1:18762', valueRef: { rowField: 'kwh' }, target: { label: '申报电量' } },
      { id: 's3', action: 'click', origin: 'http://127.0.0.1:18762', target: { text: '提交台账' }, risk: 'write_commit' }
    ]
  });

  const rows = [
    { orgName: '杭州所', kwh: 100 },
    { orgName: '宁波所', kwh: 200 },
    { orgName: '温州所', kwh: 300 },
    { orgName: '未备案所', kwh: 400 }
  ];

  // 5a. 在前 2 条试跑门禁暂停后模拟重开插件 -> 签发新 planHash -> 续跑剩余第 3、4 行
  const h1 = createCheckpointHarness();
  const snap1 = await buildPlanSnapshot({ skill, args: {}, writeMode: 'pilot_then_batch', batchRows: rows });
  const runner1 = createBatchRunner({ driver: h1.driver, store: h1.store, approvalClient: h1.approvalClient });
  const pausedPilot = await runner1.start({ skill, snapshot: snap1, batchRows: rows });
  assert.equal(pausedPilot.status, 'PAUSED_PILOT_REVIEW');
  assert.equal(h1.submitCounts.get('杭州所:100'), 1);
  assert.equal(h1.submitCounts.get('宁波所:200'), 1);

  const cps1 = await h1.store.getRunCheckpoints();
  assert.equal(cps1.length, 1);
  assert.equal(cps1[0].batchRows.length, 4);

  // 未经 approvePlan 的新 runner（错误 planHash 门禁拦截验证）
  const snapBad = await buildPlanSnapshot({ skill, args: { tampered: 'x' }, writeMode: 'pilot_then_batch', batchRows: rows });
  const runnerResumed = createBatchRunner({ driver: h1.driver, store: h1.store, approvalClient: {
    approvePlan: async () => ({ ok: false, errorCode: 'PLAN_NOT_APPROVED', message: '未批准新计划' }),
    verifyPlan: (m) => h1.approvalClient.verifyPlan(m),
    revokePlan: (m) => h1.approvalClient.revokePlan(m)
  } });
  const blockedResume = await runnerResumed.resumeFromCheckpoint({ skill, snapshot: snapBad, checkpoint: cps1[0] });
  assert.equal(blockedResume.status, 'FAILED');
  assert.equal(blockedResume.errorCode, 'PLAN_NOT_APPROVED');

  // 合法新审批快照续跑：绝不重放前 2 行
  const snap2 = await buildPlanSnapshot({ skill, args: {}, writeMode: 'pilot_then_batch', batchRows: rows });
  const runnerResumedOk = createBatchRunner({ driver: h1.driver, store: h1.store, approvalClient: h1.approvalClient });
  const finalResumed = await runnerResumedOk.resumeFromCheckpoint({ skill, snapshot: snap2, checkpoint: cps1[0] });
  assert.equal(finalResumed.status, 'VERIFIED_SUCCESS');
  assert.equal(h1.submitCounts.get('杭州所:100'), 1, '已完成第 1 行绝不能在续跑时重放');
  assert.equal(h1.submitCounts.get('宁波所:200'), 1, '已完成第 2 行绝不能在续跑时重放');
  assert.equal(h1.submitCounts.get('温州所:300'), 1);
  assert.equal(h1.submitCounts.get('未备案所:400'), 1);
  assert.equal(finalResumed.batchSummary.verified, 3);
  assert.equal(finalResumed.batchSummary.failed, 1);
  assert.equal((await h1.store.getRunCheckpoints()).length, 0, '批量完成后断点应自动清理');

  // 5b. WRITE_OUTCOME_UNKNOWN 断点恢复：必须先停在 PAUSED_CONFIRM_REQUIRED 等人工裁定，严禁自动重放
  const h2 = createCheckpointHarness({ unknownRow: '温州所:300' });
  const snapU1 = await buildPlanSnapshot({ skill, args: {}, writeMode: 'commit', batchRows: rows });
  const rU1 = createBatchRunner({ driver: h2.driver, store: h2.store, approvalClient: h2.approvalClient });
  const unknownPaused = await rU1.start({ skill, snapshot: snapU1, batchRows: rows });
  assert.equal(unknownPaused.status, 'PAUSED_CONFIRM_REQUIRED');
  assert.equal(unknownPaused.unknownWriteInfo.rowIndex, 3);
  assert.equal(h2.submitCounts.get('温州所:300'), 1);

  const cps2 = await h2.store.getRunCheckpoints();
  assert.equal(cps2.length, 1);
  const snapU2 = await buildPlanSnapshot({ skill, args: {}, writeMode: 'commit', batchRows: rows });
  const rU2 = createBatchRunner({ driver: h2.driver, store: h2.store, approvalClient: h2.approvalClient });
  const resumedHold = await rU2.resumeFromCheckpoint({ skill, snapshot: snapU2, checkpoint: cps2[0] });
  assert.equal(resumedHold.status, 'PAUSED_CONFIRM_REQUIRED', '含 UNKNOWN 写入的断点续跑后必须先待人工裁定');
  assert.equal(resumedHold.unknownWriteInfo.rowIndex, 3);
  assert.equal(h2.submitCounts.get('温州所:300'), 1, '未知写入行绝不自动重放');

  const afterManual = await rU2.resolveUnknownRowAndResume({ resolution: 'failed', note: '人工核对未入库' });
  assert.equal(afterManual.ok, true);
  assert.equal(h2.submitCounts.get('温州所:300'), 1);
  assert.equal(h2.submitCounts.get('未备案所:400'), 1);

  // 5c. extractFailedRowsForRetry：仅提取 status === 'failed'，严格排除 verified 与 unknown
  const extractedRetry = extractFailedRowsForRetry(
    [
      { rowIndex: 1, orgName: '杭州所', kwh: 100, status: 'verified', receiptNo: 'GD-1', error: '' },
      { rowIndex: 2, orgName: '未备案所', kwh: 400, status: 'failed', receiptNo: '-', error: '单位代码不存在' },
      { rowIndex: 3, orgName: '温州所', kwh: 300, status: 'unknown', receiptNo: '-', error: 'WRITE_OUTCOME_UNKNOWN' }
    ],
    [{ key: 'orgName' }, { key: 'kwh' }]
  );
  assert.equal(extractedRetry.count, 1);
  assert.equal(extractedRetry.excludedUnknownCount, 1);
  assert.deepEqual(extractedRetry.rows, [{ orgName: '未备案所', kwh: 400 }]);
  console.log('PASS: batch-runner resumeFromCheckpoint, planHash/UNKNOWN safety guards & extractFailedRowsForRetry');
}
