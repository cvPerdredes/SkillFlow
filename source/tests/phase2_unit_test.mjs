import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

globalThis.__SKILLFLOW_NO_AUTO_ATTACH__ = true;
const { createBackgroundController } = await import('../extension/background.js');
const {
  buildPlanSnapshot,
  canonicalJson,
  normalizeAndValidateRuntimeArgs
} = await import('../extension/lib/plan-builder.js');
const { isSamePageIgnoringQueryAndHash } = await import('../extension/lib/sanitizer.js');
const { normalizeSkillIR } = await import('../extension/lib/schemas.js');
const { createStore, validateRemoteAiBaseUrl } = await import('../extension/lib/store.js');
const { createAiClient } = await import('../extension/lib/ai-client.js');
const { extractArgsFromInput, matchSkillByQuery } = await import('../extension/lib/clarification.js');
const { createDriver } = await import('../extension/lib/driver.js');
const { extractStructuredRecords } = await import('../extension/lib/table-extractor.js');
const { evaluateRunOutcome } = await import('../extension/lib/result-evaluator.js');
const {
  autoMapCsvColumns,
  createBatchRunner,
  parseCsv,
  validateAndBindBatchRows
} = await import('../extension/lib/batch-runner.js');
const { answerRunQuestion } = await import('../extension/lib/result-qa.js');
const { createRunController } = await import('../extension/lib/run-controller.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.resolve(__dirname, '..');
const EXT_DIR = path.join(SOURCE_DIR, 'extension');

// ---------------------------------------------------------------------------
// 1. 4 个 Phase 1 运行态 Bug 回归测试
// ---------------------------------------------------------------------------
{
  // 1a. 数字参数预览与执行双向一致，不再触发 PLAN_NOT_APPROVED 死锁
  const numSkill = normalizeSkillIR({
    id: 'sk-num',
    name: '电量录入',
    startUrl: 'http://127.0.0.1:18762/sys_b_form.html',
    parameters: [{ key: 'kwh', label: '申报电量', type: 'number', required: true }],
    steps: [{ id: 's1', action: 'fill', origin: 'http://127.0.0.1:18762', paramKey: 'kwh', target: { label: '申报电量' } }]
  });
  const previewChecked = normalizeAndValidateRuntimeArgs(numSkill, { kwh: '12800' });
  assert.equal(previewChecked.ok, true);
  assert.equal(previewChecked.args.kwh, 12800);
  const snap = await buildPlanSnapshot({ skill: numSkill, args: previewChecked.args });
  const execChecked = normalizeAndValidateRuntimeArgs(numSkill, { kwh: '12800' });
  assert.equal(canonicalJson(execChecked.args), canonicalJson(snap.args));

  // 1b. NL 匹配以空 collectedArgs={} 启动 extractArgs，确保“查 B 单位”追问缺失月份
  const mockAi = createAiClient({ getConfig: async () => ({ mode: 'mock' }) });
  const querySkill = normalizeSkillIR({
    id: 'sk-q',
    name: '月度台账查询',
    intent: '按单位和月份查询电量明细',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    parameters: [
      { key: 'unit', label: '查询单位', type: 'string', required: true, defaultValue: 'A单位' },
      { key: 'month', label: '查询月份', type: 'month', required: true, defaultValue: '2026-10' }
    ],
    steps: [{ id: 's1', action: 'click', origin: 'http://127.0.0.1:18761', target: { text: '查询数据' } }]
  });
  const m = await matchSkillByQuery({ userQuery: '查 B 单位', skills: [querySkill], aiClient: mockAi });
  assert.equal(m.matchedSkillId, 'sk-q');
  const ext = await extractArgsFromInput({
    userText: '查 B 单位',
    parameters: querySkill.parameters,
    collectedArgs: {},
    lastQuestion: null,
    currentDate: '2026-11-24',
    aiClient: mockAi
  });
  assert.equal(ext.providedArgs.unit, 'B单位');
  assert.deepEqual(ext.missingRequired, ['month']);

  // 1c. 远程模型 baseUrl 协议校验
  const okUrl = validateRemoteAiBaseUrl('http://127.0.0.1:8000/v1/');
  assert.equal(okUrl.ok, true);
  assert.equal(okUrl.origin, 'http://127.0.0.1:8000');
  assert.equal(okUrl.normalizedUrl, 'http://127.0.0.1:8000/v1');
  assert.equal(validateRemoteAiBaseUrl('javascript:alert(1)').ok, false);
  assert.equal(validateRemoteAiBaseUrl('ftp://bad.local/v1').ok, false);

  const memStore = createStore({
    storage: { local: { get: async () => ({}), set: async () => {} } }
  });
  await assert.rejects(
    () => memStore.saveAiConfig({ mode: 'remote', baseUrl: 'javascript:alert(1)' }),
    /http/
  );

  // 1d. isSamePageIgnoringQueryAndHash 已上移至 sanitizer.js，且 runController.switchAuthToManual() 同步更新检查点
  assert.equal(
    isSamePageIgnoringQueryAndHash(
      'http://127.0.0.1:18761/sys_a_query.html?layout=v2',
      'http://127.0.0.1:18761/sys_a_query.html'
    ),
    true
  );

  const localStore = {};
  const sessionStore = {};
  const chromeMock = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) =>
        await new Promise((resolve) => bgCtrl.handleMessage(msg, { tab: { id: 31 }, url: 'http://127.0.0.1:18761/sys_a_query.html' }, resolve))
    },
    permissions: { contains: async () => true },
    tabs: {
      onUpdated: { addListener: () => {} },
      query: async () => [{ id: 31, url: 'http://127.0.0.1:18761/sys_a_query.html', status: 'complete' }],
      get: async () => ({ id: 31, url: 'http://127.0.0.1:18761/sys_a_query.html', status: 'complete' }),
      sendMessage: async (_tid, msg) => {
        if (msg.type === 'CHECK_AUTH_STATE') return { ok: true, state: 'AUTH_REQUIRED', hasCaptcha: false, canEphemeralFill: true };
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
  const bgCtrl = createBackgroundController(chromeMock);
  const store = createStore(chromeMock);
  const driver = createDriver('mv3-content', { chromeApi: chromeMock, stepDelayMs: 0 });
  const rc = createRunController({
    driver,
    store,
    approvalClient: {
      approvePlan: (m) => bgCtrl.approvePlan(m),
      verifyPlan: (m) => bgCtrl.verifyPlan(m),
      revokePlan: (m) => bgCtrl.revokePlan(m)
    }
  });
  const authSkill = normalizeSkillIR({
    id: 'sk-auth-sw',
    name: '认证切换测试',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    authPolicy: 'ephemeral_prompt',
    steps: [{ id: 's1', action: 'auth_checkpoint', origin: 'http://127.0.0.1:18761' }]
  });
  const authSnap = await buildPlanSnapshot({ skill: authSkill, args: {} });
  const paused = await rc.start({ skill: authSkill, snapshot: authSnap });
  assert.equal(paused.authPauseInfo.mode, 'ephemeral_prompt');
  const switched = await rc.switchAuthToManual();
  assert.equal(switched.authPauseInfo.mode, 'manual_takeover');
  assert.equal(localStore.runCheckpoints[0].authPauseInfo.mode, 'manual_takeover');
  console.log('PASS: All 4 Phase 1 runtime bug regressions verified');
}

// ---------------------------------------------------------------------------
// 2. S1 端到端: 系统 A 结果表抽取 + L2 核验 + 单位/电压分布与总电量追问
// ---------------------------------------------------------------------------
{
  // 在轻量 DOM 夹具内测试 content.js extractRecordsInPage
  const tableRows = [
    ['KH-202611-HZ01', '杭州供电所', '10kV', '2026-11', '正常', '12800'],
    ['KH-202611-HZ02', '杭州供电所', '35kV', '2026-11', '正常', '26400'],
    ['KH-202611-NB01', '宁波供电所', '10kV', '2026-11', '正常', '18500'],
    ['KH-202611-NB02', '宁波供电所', '35kV', '2026-11', '正常', '32900']
  ];
  const headers = ['客户批号', '供电单位', '电压等级', '查询月份', '状态', '申报电量(kWh)'];

  const makeEl = (tag, textContent = '', attrs = {}, children = []) => ({
    nodeType: 1,
    localName: tag,
    tagName: tag.toUpperCase(),
    textContent,
    children,
    getAttribute: (k) => attrs[k] ?? null
  });

  const tableEl = makeEl('table', '', { id: 'result-table' });
  const trNodes = tableRows.map((cols) =>
    makeEl('tr', '', {}, cols.map((c) => makeEl('td', c)))
  );
  const thNodes = headers.map((h) => makeEl('th', h));

  const sandbox = {
    document: {
      addEventListener: () => {},
      querySelector: (sel) => {
        if (sel === '#result-table') {
          return {
            ...tableEl,
            querySelectorAll: (sub) => (sub.includes('th') ? thNodes : trNodes)
          };
        }
        return null;
      },
      querySelectorAll: () => []
    },
    location: { origin: 'http://127.0.0.1:18761', href: 'http://127.0.0.1:18761/sys_a_query.html' },
    chrome: { runtime: { id: 'ext', sendMessage: async () => ({ ok: true }), onMessage: { addListener: () => {} } } },
    getComputedStyle: () => ({}),
    CSS: { escape: (s) => String(s) },
    WeakMap, WeakSet, Set, Array, Object, String, Boolean, Number, Date, Error, Promise, setTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8'), sandbox);

  const rawTable = sandbox.__skillflowTestHooks.extractRecordsInPage({
    mode: 'table',
    containerSelector: '#result-table'
  });
  const structured = extractStructuredRecords(rawTable, { mode: 'table' });
  assert.equal(structured.evidenceLevel, 'L2');
  assert.equal(structured.records.length, 4);
  assert.equal(structured.records[0].kwh, 12800);

  // result-evaluator: error 状态严禁标为 VERIFIED_SUCCESS
  const s1Skill = normalizeSkillIR({
    id: 'sk-s1',
    name: '系统 A 电量查询',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    resultSelector: '#result-summary',
    extractSpec: { mode: 'table', containerSelector: '#result-table' },
    steps: [{ id: 's1', action: 'click', origin: 'http://127.0.0.1:18761', target: { text: '查询数据' } }]
  });
  const okOutcome = evaluateRunOutcome({
    skill: s1Skill,
    actionCompleted: true,
    result: { found: true, status: 'ok', text: '查询成功' },
    records: structured.records,
    extractedEvidenceLevel: structured.evidenceLevel
  });
  assert.equal(okOutcome.status, 'VERIFIED_SUCCESS');
  assert.equal(okOutcome.evidenceLevel, 'L2');

  const errOutcome = evaluateRunOutcome({
    skill: s1Skill,
    actionCompleted: true,
    result: { found: true, status: 'error', text: '输入不完整' },
    records: [],
    extractedEvidenceLevel: 'L0'
  });
  assert.equal(errOutcome.status, 'FAILED');
  assert.equal(errOutcome.errorCode, 'OUTCOME_UNVERIFIED');

  // result-qa 对 S1 追问
  const s1Answer = await answerRunQuestion({
    question: '共多少条、各供电所和电压等级分布如何、总电量合计是多少？',
    records: structured.records,
    recordSchema: structured.recordSchema
  });
  assert.equal(s1Answer.cannotCompute, false);
  assert.equal(s1Answer.computedEvidence.totalRecords, 4);
  assert.deepEqual(s1Answer.computedEvidence.unitDistribution.counts, { 杭州供电所: 2, 宁波供电所: 2 });
  assert.deepEqual(s1Answer.computedEvidence.voltageDistribution.counts, { '10kV': 2, '35kV': 2 });
  assert.equal(s1Answer.computedEvidence.metricStats.sum, 90600);
  assert.ok(s1Answer.evidenceRefs.includes('records:1..4'));
  console.log('PASS: S1 query table extraction, L2 evaluation & deterministic QA');
}

// ---------------------------------------------------------------------------
// 3. S2 端到端: sample_batch.csv (12条) + 前2条试跑门禁 + 10成功/2失败 + 分布追问 + 0 LLM循环
// ---------------------------------------------------------------------------
function createBatchMockHarness({ simulateUnknownOnRow = null } = {}) {
  const localStore = {};
  const sessionStore = {};
  let currentUrl = 'http://127.0.0.1:18761/sys_a_query.html';
  let formState = {};
  let ledgerSeq = 0;
  let lastReceipt = null;
  const submitCountByRow = new Map();
  let activeRowHint = 0;

  const chromeMock = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) =>
        await new Promise((resolve) => bgCtrl.handleMessage(msg, { tab: { id: 41 }, url: currentUrl }, resolve))
    },
    permissions: { contains: async () => true },
    tabs: {
      onUpdated: { addListener: () => {} },
      query: async () => [{ id: 41, url: currentUrl, status: 'complete' }],
      get: async () => ({ id: 41, url: currentUrl, status: 'complete' }),
      update: async (tid, { url }) => {
        currentUrl = url;
        if (url.includes('sys_b_form.html')) {
          formState = {};
          lastReceipt = null;
        }
        return { id: tid, url };
      },
      sendMessage: async (_tid, msg) => {
        if (msg.type === 'PING') return { ok: true, url: currentUrl };
        if (msg.type === 'CHECK_AUTH_STATE') return { ok: true, state: 'AUTHENTICATED', hasCaptcha: false };
        if (msg.type === 'PLAY_STEP') {
          const step = msg.step;
          if (step.action === 'extract') {
            return { ok: true, action: 'extract', extractedValue: 'KH-202611-HZ01', matchedLocator: 'cssPath' };
          }
          if (step.action === 'fill' || step.action === 'select') {
            const key = step.valueRef?.rowField || step.target?.name || step.target?.label;
            formState[key] = step.value;
            return { ok: true, action: step.action, matchedLocator: 'label+tag' };
          }
          if (step.action === 'click' && step.target?.text === '提交台账') {
            activeRowHint++;
            submitCountByRow.set(activeRowHint, (submitCountByRow.get(activeRowHint) || 0) + 1);
            if (simulateUnknownOnRow === activeRowHint) {
              lastReceipt = { ok: true, found: true, mode: 'receipt', statusAttr: 'idle', statusText: 'idle', errorText: '', boxText: '', extractedFields: { receiptNo: '-' } };
              return { ok: true, action: 'click', matchedLocator: 'text' };
            }
            const orgName = String(formState.orgName || '').trim();
            const kwh = Number(formState.kwh);
            if (!orgName || orgName === '未备案所') {
              lastReceipt = { ok: true, found: true, mode: 'receipt', statusAttr: 'error', statusText: 'error', errorText: '单位代码不存在', boxText: '提交失败：单位代码不存在', extractedFields: { receiptNo: '-' } };
            } else if (Number.isNaN(kwh) || kwh <= 0 || kwh > 50000) {
              lastReceipt = { ok: true, found: true, mode: 'receipt', statusAttr: 'error', statusText: 'error', errorText: '电量超限需核查', boxText: '提交失败：电量超限需核查', extractedFields: { receiptNo: '-' } };
            } else {
              ledgerSeq++;
              const no = `GD-202611-${String(ledgerSeq).padStart(3, '0')}`;
              lastReceipt = { ok: true, found: true, mode: 'receipt', statusAttr: 'ok', statusText: 'ok', errorText: '', boxText: `提交成功：单号 ${no}`, extractedFields: { receiptNo: no } };
            }
            return { ok: true, action: 'click', matchedLocator: 'text' };
          }
          return { ok: true, action: step.action, matchedLocator: 'text' };
        }
        if (msg.type === 'EXTRACT_RECORDS') {
          return lastReceipt || { ok: true, found: false, mode: 'receipt', statusAttr: '', errorText: '', boxText: '', extractedFields: {} };
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

  const bgCtrl = createBackgroundController(chromeMock);
  const store = createStore(chromeMock);
  const driver = createDriver('mv3-content', { chromeApi: chromeMock, stepDelayMs: 0 });
  const batchRunner = createBatchRunner({
    driver,
    store,
    approvalClient: {
      approvePlan: (m) => bgCtrl.approvePlan(m),
      verifyPlan: (m) => bgCtrl.verifyPlan(m),
      revokePlan: (m) => bgCtrl.revokePlan(m)
    }
  });
  return { batchRunner, submitCountByRow, localStore };
}

{
  // CSV BOM 与引号解析 + 脏数据拦截
  const bomParsed = parseCsv('\uFEFF"供电单位","申报电量"\r\n"杭州,供电所",1200\n');
  assert.deepEqual(bomParsed.headers, ['供电单位', '申报电量']);
  assert.equal(bomParsed.rawRows[0][0], '杭州,供电所');

  const sampleCsvText = fs.readFileSync(path.join(SOURCE_DIR, 'demo-site', 'sample_batch.csv'), 'utf8');
  const parsedSample = parseCsv(sampleCsvText);
  assert.equal(parsedSample.rawRows.length, 12);

  const columns = [
    { key: 'orgName', label: '供电单位', type: 'string', required: true },
    { key: 'meterNo', label: '表计编号', type: 'string', required: true },
    { key: 'kwh', label: '申报电量', type: 'number', required: true },
    { key: 'voltage', label: '电压等级', type: 'string', required: true },
    { key: 'remark', label: '备注', type: 'string', required: false }
  ];
  const { mapping, unmappedRequired } = autoMapCsvColumns(parsedSample.headers, columns);
  assert.deepEqual(unmappedRequired, []);

  // 脏数据行前置报错 CSV_SCHEMA_INVALID
  const dirtyCsv = parseCsv('供电单位,表计编号,申报电量,电压等级,备注\n杭州供电所,M-01,不是数字,10kV,脏数据\n');
  const dirtyCheck = validateAndBindBatchRows(dirtyCsv, columns, mapping);
  assert.equal(dirtyCheck.ok, false);
  assert.equal(dirtyCheck.errorCode, 'CSV_SCHEMA_INVALID');

  const bound = validateAndBindBatchRows(parsedSample, columns, mapping);
  assert.equal(bound.ok, true);
  assert.equal(bound.rowCount, 12);

  // S2 跨系统批量运行：先试跑前 2 条 -> 核验放行剩余 10 条
  const s2Skill = normalizeSkillIR({
    id: 'sk-s2-batch',
    name: '跨系统客户批号查询与台账批量录入',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    allowedOrigins: ['http://127.0.0.1:18761', 'http://127.0.0.1:18762'],
    parameters: [
      { key: 'queryUnit', label: '查询单位', type: 'string', required: true },
      { key: 'batchRows', label: '批量台账', type: 'dataset', required: false, columns }
    ],
    batchLoop: {
      enabled: true,
      datasetParam: 'batchRows',
      preSteps: ['s1', 's2', 's3', 's4'],
      rowSteps: ['s5', 's6', 's7', 's8', 's9', 's10', 's11'],
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
        { key: 'kwh', source: 'row.kwh', type: 'number' },
        { key: 'voltage', source: 'row.voltage' }
      ]
    },
    steps: [
      { id: 's1', action: 'auth_checkpoint', origin: 'http://127.0.0.1:18761' },
      { id: 's2', action: 'fill', origin: 'http://127.0.0.1:18761', valueRef: { param: 'queryUnit' }, target: { label: '查询单位' } },
      { id: 's3', action: 'click', origin: 'http://127.0.0.1:18761', target: { text: '查询数据' } },
      { id: 's4', action: 'extract', origin: 'http://127.0.0.1:18761', target: { cssPath: '#result-table tbody tr:first-child td:first-child' }, outputVar: 'customerBatchCode' },
      { id: 's5', action: 'navigate', origin: 'http://127.0.0.1:18762', url: 'http://127.0.0.1:18762/sys_b_form.html' },
      { id: 's6', action: 'fill', origin: 'http://127.0.0.1:18762', valueRef: { rowField: 'orgName' }, target: { name: 'orgName', label: '供电单位' } },
      { id: 's7', action: 'fill', origin: 'http://127.0.0.1:18762', valueRef: { var: 'customerBatchCode' }, target: { name: 'batchCode', label: '关联客户批号' } },
      { id: 's8', action: 'fill', origin: 'http://127.0.0.1:18762', valueRef: { rowField: 'meterNo' }, target: { name: 'meterNo', label: '表计编号' } },
      { id: 's9', action: 'fill', origin: 'http://127.0.0.1:18762', valueRef: { rowField: 'kwh' }, target: { name: 'kwh', label: '申报电量' } },
      { id: 's10', action: 'select', origin: 'http://127.0.0.1:18762', valueRef: { rowField: 'voltage' }, target: { name: 'voltage', label: '电压等级' } },
      { id: 's11', action: 'click', origin: 'http://127.0.0.1:18762', target: { text: '提交台账' }, risk: 'write_commit' }
    ]
  });

  const s2Snap = await buildPlanSnapshot({
    skill: s2Skill,
    args: { queryUnit: '杭州供电所' },
    writeMode: 'pilot_then_batch',
    batchRows: bound.rows
  });

  let llmCallsDuringBatch = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    llmCallsDuringBatch++;
    throw new Error('批量循环体内禁止发起任何网络/模型调用');
  };
  let pilotPaused;
  let resumed;
  const s2Harness = createBatchMockHarness();
  try {
    pilotPaused = await s2Harness.batchRunner.start({
      skill: s2Skill,
      snapshot: s2Snap,
      batchRows: bound.rows
    });

    assert.equal(pilotPaused.status, 'PAUSED_PILOT_REVIEW');
    assert.equal(pilotPaused.ledger.length, 2);
    assert.equal(pilotPaused.batchSummary.verified, 2);
    assert.equal(pilotPaused.vars.customerBatchCode, 'KH-202611-HZ01');

    resumed = await s2Harness.batchRunner.approveRemainingAndContinue();
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.status, 'VERIFIED_SUCCESS');
  assert.deepEqual(resumed.state.batchSummary, {
    total: 12,
    verified: 10,
    failed: 2,
    skipped: 0,
    unknown: 0
  });
  assert.equal(resumed.state.ledger[4].status, 'failed');
  assert.equal(resumed.state.ledger[4].error, '电量超限需核查');
  assert.equal(resumed.state.ledger[8].status, 'failed');
  assert.equal(resumed.state.ledger[8].error, '单位代码不存在');
  assert.equal(llmCallsDuringBatch, 0, '批量循环体内必须 0 次 LLM 调用');

  // S2 分布追问与账本 100% 一致性校验
  const s2Qa = await answerRunQuestion({
    question: '一共成功多少条、失败几条、按供电单位成功分布和失败原因占比分别是什么？',
    records: resumed.state.records,
    recordSchema: resumed.state.recordSchema,
    runSummary: resumed.state
  });
  assert.equal(s2Qa.cannotCompute, false);
  assert.deepEqual(s2Qa.computedEvidence.statusSummary, {
    total: 12,
    verified: 10,
    failed: 2,
    unknown: 0,
    skipped: 0
  });
  assert.deepEqual(s2Qa.computedEvidence.unitVerifiedDistribution.counts, {
    杭州供电所: 3,
    温州供电所: 3,
    宁波供电所: 2,
    嘉兴供电所: 2
  });
  assert.equal(s2Qa.computedEvidence.errorBreakdown.totalFailed, 2);
  assert.equal(s2Qa.computedEvidence.errorBreakdown.items[0].percentOfFailed, '50.0%');
  assert.equal(s2Qa.computedEvidence.errorBreakdown.items[1].percentOfFailed, '50.0%');
  assert.ok(s2Qa.evidenceRefs.includes('failedRows:5,9'));
  console.log('PASS: S2 12-row CSV batch (pilot-2 gate -> 10 verified / 2 failed) & 100% consistent distribution QA');

  // ---------------------------------------------------------------------------
  // 4. WRITE_OUTCOME_UNKNOWN 严禁自动重试 + 无明细/缺维度严格拒答
  // ---------------------------------------------------------------------------
  const unknownHarness = createBatchMockHarness({ simulateUnknownOnRow: 3 });
  const fourRows = bound.rows.slice(0, 4);
  const uSnap = await buildPlanSnapshot({
    skill: s2Skill,
    args: { queryUnit: '杭州供电所' },
    writeMode: 'commit',
    batchRows: fourRows
  });
  const pausedUnknown = await unknownHarness.batchRunner.start({
    skill: s2Skill,
    snapshot: uSnap,
    batchRows: fourRows
  });
  assert.equal(pausedUnknown.status, 'PAUSED_CONFIRM_REQUIRED');
  assert.equal(pausedUnknown.unknownWriteInfo.rowIndex, 3);
  assert.equal(unknownHarness.submitCountByRow.get(3), 1, 'UNKNOWN 写入严禁自动重试');

  const resolvedUnknown = await unknownHarness.batchRunner.resolveUnknownRowAndResume({
    resolution: 'failed',
    note: '人工核对未入库'
  });
  assert.equal(resolvedUnknown.ok, true);
  assert.equal(resolvedUnknown.state.batchSummary.total, 4);
  assert.equal(resolvedUnknown.state.batchSummary.verified, 3);
  assert.equal(resolvedUnknown.state.batchSummary.failed, 1);
  assert.equal(unknownHarness.submitCountByRow.get(3), 1, '人工核定续跑后绝不重放第 3 行');

  // 无明细严格拒答 + 缺维度严格拒答
  const emptyRefusal = await answerRunQuestion({
    question: '按供电单位分布占比是多少？',
    records: []
  });
  assert.equal(emptyRefusal.cannotCompute, true);
  assert.ok(emptyRefusal.answer.includes('拒答'));

  const missingDimRefusal = await answerRunQuestion({
    question: '按客户经理分布占比是多少？',
    records: resumed.state.records,
    recordSchema: resumed.state.recordSchema
  });
  assert.equal(missingDimRefusal.cannotCompute, true);
  assert.ok(missingDimRefusal.answer.includes('拒答'));
  console.log('PASS: WRITE_OUTCOME_UNKNOWN never replays & empty/missing-dimension strictly refuses');
}
