import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

globalThis.__SKILLFLOW_NO_AUTO_ATTACH__ = true;
const { createBackgroundController } = await import('../extension/background.js');
const { buildPlanSnapshot } = await import('../extension/lib/plan-builder.js');
const { normalizeSkillIR, validateSkillIR, validateAnalyzeTraceProposal } = await import(
  '../extension/lib/schemas.js'
);
const { createStore } = await import('../extension/lib/store.js');
const { distillSnapshot, buildTraceSummaryForAI } = await import('../extension/lib/dom-distiller.js');
const { createAiClient, stripThinkAndExtractJson } = await import('../extension/lib/ai-client.js');
const {
  analyzeRecordedTrace,
  buildSanitizedPreviewPayload
} = await import('../extension/lib/skill-analyzer.js');
const {
  extractArgsFromInput,
  matchSkillByQuery,
  normalizeRelativeDate
} = await import('../extension/lib/clarification.js');
const { createDriver } = await import('../extension/lib/driver.js');
const { isSamePageIgnoringQueryAndHash } = await import('../extension/lib/drivers/mv3-driver.js');
const { createRunController } = await import('../extension/lib/run-controller.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '../extension');

// ---------------------------------------------------------------------------
// 1. schemas.js: Skill IR v0.3 与 AI 提案安全校验
// ---------------------------------------------------------------------------
{
  const raw = {
    id: 'skill-001',
    name: '跨系统查账与录入',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    steps: [
      { id: 's1', action: 'auth_checkpoint', origin: 'http://127.0.0.1:18761', loggedInIndicator: '' },
      { id: 's2', action: 'fill', origin: 'http://127.0.0.1:18761', paramKey: 'unit', target: { label: '查询单位' } },
      { id: 's3', action: 'extract', origin: 'http://127.0.0.1:18761', target: { cssPath: '#batch' }, outputVar: 'batchCode' }
    ],
    parameters: [{ key: 'unit', label: '查询单位', type: 'string', sourceStepId: 's2' }]
  };
  const ir = normalizeSkillIR(raw);
  assert.equal(ir.schemaVersion, '0.3');
  assert.equal(ir.steps[0].loggedInIndicator, '');
  assert.deepEqual(ir.steps[1].valueRef, { param: 'unit' });
  assert.equal(validateSkillIR(ir).ok, true);

  // 禁止动态代码动作
  const badIr = structuredClone(ir);
  badIr.steps[1].action = 'executeScript';
  assert.equal(validateSkillIR(badIr).ok, false);

  // analyzeTrace 引用不存在的 stepId 必须报 AI_STEP_REF_UNKNOWN
  const badAi = validateAnalyzeTraceProposal(
    {
      name: 'x',
      intent: 'y',
      parameterCandidates: [{ key: 'unit', label: '单位', type: 'string', sourceStepId: 'nonexistent-99' }]
    },
    ['s1', 's2', 's3']
  );
  assert.equal(badAi.ok, false);
  assert.equal(badAi.errorCode, 'AI_STEP_REF_UNKNOWN');

  // 禁止模型提案夹带脚本
  const evilAi = validateAnalyzeTraceProposal(
    { name: 'x', intent: 'y', code: 'alert(1)', parameterCandidates: [] },
    ['s1']
  );
  assert.equal(evilAi.ok, false);
  console.log('PASS: schemas.js validates Skill IR v0.3 & blocks executeScript / unknown stepId');
}

// ---------------------------------------------------------------------------
// 2. store.js: 统一 redactObject 脱敏落盘 & API Key 仅存 session
// ---------------------------------------------------------------------------
{
  const localStore = {};
  const sessionStore = {};
  const mockChrome = {
    storage: {
      local: {
        get: async (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(arr.filter((k) => k in localStore).map((k) => [k, structuredClone(localStore[k])]));
        },
        set: async (patch) => Object.assign(localStore, structuredClone(patch))
      },
      session: {
        get: async (k) => (k in sessionStore ? { [k]: structuredClone(sessionStore[k]) } : {}),
        set: async (patch) => Object.assign(sessionStore, structuredClone(patch)),
        remove: async (k) => {
          delete sessionStore[k];
        }
      }
    }
  };
  const store = createStore(mockChrome);

  await store.saveAiConfig({
    mode: 'remote',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'deepseek-v4-flash',
    apiKey: 'sk-MUST-NOT-HIT-LOCAL'
  });
  await store.setAiApiKey('sk-SESSION-ONLY-KEY');

  assert.equal(JSON.stringify(localStore).includes('sk-MUST-NOT-HIT-LOCAL'), false);
  assert.equal(JSON.stringify(localStore).includes('sk-SESSION-ONLY-KEY'), false);
  assert.equal(await store.getAiApiKey(), 'sk-SESSION-ONLY-KEY');

  await store.saveRun({
    id: 'r1',
    skillId: 's1',
    status: 'VERIFIED_SUCCESS',
    logs: [{ ok: true, message: 'done', password: 'SECRET_PWD_SHOULD_REDACT' }],
    elapsedMs: 120
  });
  assert.equal(JSON.stringify(localStore.runs).includes('SECRET_PWD_SHOULD_REDACT'), false);

  const exported = store.exportSkillJson({
    id: 'sk1',
    name: 'demo',
    steps: [{ id: 's1', action: 'auth_checkpoint', sensitive: true, value: 'RAW_PASS_MUST_STRIP' }]
  });
  assert.equal(exported.includes('RAW_PASS_MUST_STRIP'), false);
  console.log('PASS: store.js redacts local persistence/exports & isolates API Key in session');
}

// ---------------------------------------------------------------------------
// 3. dom-distiller.js + content.js DISTILL_DOM: 真实字节压缩率与防空检查
// ---------------------------------------------------------------------------
{
  const rawHtmlSample = '<div>' + '<span>冗余展示装饰文案</span>'.repeat(120) + '</div>';
  const distilled = distillSnapshot({
    rawBytes: Buffer.byteLength(rawHtmlSample, 'utf8'),
    nodes: [
      { tag: 'input', type: 'text', testId: 'unit-input', label: '查询单位', cssPath: '#unit', value: 'SHOULD_DROP' },
      { tag: 'input', type: 'password', label: '登录密码', cssPath: '#pwd', sensitive: true, auth: true },
      { tag: 'button', text: '查询数据', cssPath: '#query-btn' }
    ],
    pageContext: { title: '营销 2.0 查询系统', headings: ['台账查询'] },
    tables: [{ selector: '#result-table', headers: ['客户批号', '供电单位'], rowCount: 3 }],
    statusContainers: [{ selector: '#result-summary', dataStatus: 'ok', text: '查询成功' }]
  });

  assert.equal(distilled.ok, true);
  assert.ok(distilled.rawBytes > distilled.distilledBytes);
  assert.ok(distilled.compressionRatio > 0.85);
  assert.ok(distilled.estimatedTokens > 0 && distilled.estimatedTokens < 1000);
  assert.equal(JSON.stringify(distilled).includes('SHOULD_DROP'), false);

  const emptyRes = distillSnapshot({ rawBytes: 200, nodes: [] });
  assert.equal(emptyRes.ok, false);
  assert.equal(emptyRes.errorCode, 'DOM_DISTILL_EMPTY');

  // content.js 内部 distillDomInPage 实测（含隐身元素过滤）
  const sandbox = {
    document: {
      title: '测试页',
      addEventListener: () => {},
      documentElement: { outerHTML: rawHtmlSample },
      body: {
        innerHTML: rawHtmlSample,
        querySelectorAll: (sel) => {
          if (sel.includes('input')) {
            return [
              {
                nodeType: 1,
                localName: 'input',
                id: 'unit',
                value: '敏感未提交输入',
                isConnected: true,
                offsetParent: { tagName: 'BODY' },
                attrs: { 'data-testid': 'unit-input', name: 'unit' },
                getAttribute(k) { return this.attrs[k] ?? null; },
                hasAttribute(k) { return k in this.attrs; },
                getClientRects: () => [{ width: 100, height: 20 }],
                closest: () => null
              }
            ];
          }
          return [];
        }
      },
      querySelectorAll: () => [],
      querySelector: () => null
    },
    location: { origin: 'http://127.0.0.1:18761', href: 'http://127.0.0.1:18761/sys_a_query.html' },
    chrome: { runtime: { id: 'ext', sendMessage: async () => ({ ok: true }), onMessage: { addListener: () => {} } } },
    getComputedStyle: () => ({}),
    CSS: { escape: (s) => String(s) },
    Event: class { constructor(t, o) { this.type = t; Object.assign(this, o); } },
    KeyboardEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o); } },
    TextEncoder,
    WeakMap, WeakSet, Set, Array, Object, String, Boolean, Number, Date, Error, Promise, setTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8'), sandbox);

  const pageDistilledRaw = sandbox.__skillflowTestHooks.distillDomInPage({ maxNodes: 40 });
  assert.equal(pageDistilledRaw.ok, true);
  assert.equal(pageDistilledRaw.nodes.length, 1);
  assert.equal('value' in pageDistilledRaw.nodes[0], false);
  const compressed = distillSnapshot(pageDistilledRaw);
  assert.ok(compressed.compressionRatio > 0.8);

  const tracePkg = buildTraceSummaryForAI(
    { name: '测试', startUrl: 'http://127.0.0.1:18761/sys_a_query.html', steps: [{ id: 's1', action: 'click' }] },
    compressed
  );
  assert.ok(tracePkg.estimatedTokens <= 5500);
  console.log('PASS: dom-distiller + content DISTILL_DOM computes real compression ratio & drops raw input values');
}

// ---------------------------------------------------------------------------
// 4. ai-client.js + skill-analyzer.js: <think> 剥离、1x 带错重试、Mock 与降级
// ---------------------------------------------------------------------------
{
  const parsedThink = stripThinkAndExtractJson(
    '<think>正在思考 DeepSeek-v4-flash 输出...</think>\n```json\n{"matchedSkillId":"sk1","candidates":[{"skillId":"sk1","score":0.9,"reason":"ok"}],"confidence":"high"}\n```'
  );
  assert.equal(parsedThink.ok, true);
  assert.equal(parsedThink.data.matchedSkillId, 'sk1');

  // 4a. 远程带错重试 1 次后恢复成功
  let callCount = 0;
  let capturedAuthHeader = '';
  let capturedPromptBody = '';
  const retryAi = createAiClient({
    getConfig: async () => ({
      mode: 'remote',
      baseUrl: 'http://intranet-llm.local/v1',
      model: 'deepseek-v4-flash',
      timeoutMs: 8000
    }),
    getApiKey: async () => 'sk-intranet-284b',
    fetchImpl: async (_url, init) => {
      callCount++;
      capturedAuthHeader = init.headers.Authorization;
      capturedPromptBody = init.body;
      const content =
        callCount === 1
          ? '<think>oops</think>{"name":"查询","intent":"查电量","parameterCandidates":[{"key":"unit","type":"string","sourceStepId":"ghost-step"}]}'
          : '<think>fixed</think>```json\n{"name":"查询","intent":"查电量","parameterCandidates":[{"key":"unit","label":"查询单位","type":"string","required":true,"sourceStepId":"s1","reason":"ok"}]}\n```';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 420, completion_tokens: 90 }
        })
      };
    }
  });

  const session = {
    id: 'sess-1',
    name: '月度查询',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18761', target: { label: '查询单位' }, value: '杭州供电所' },
      { id: 's2', action: 'auth_checkpoint', origin: 'http://127.0.0.1:18761', sensitive: true }
    ]
  };

  const preview = buildSanitizedPreviewPayload({ session });
  assert.equal(preview.previewJson.includes('杭州供电所'), true);

  const analyzeRes = await analyzeRecordedTrace({ session, aiClient: retryAi });
  assert.equal(callCount, 2, '首轮 AI_STEP_REF_UNKNOWN 必须触发带错重试 1 次');
  assert.equal(analyzeRes.degraded, false);
  assert.equal(analyzeRes.retried, true);
  assert.equal(capturedAuthHeader, 'Bearer sk-intranet-284b');
  assert.equal(capturedPromptBody.includes('<untrusted_page_data>'), true);
  assert.equal(analyzeRes.draft.parameterCandidates[0].sourceStepId, 's1');

  // 4b. 连续失败时优雅降级到规则兜底，不抛异常、不阻断保存
  const brokenAi = createAiClient({
    getConfig: async () => ({ mode: 'remote', baseUrl: 'http://intranet-llm.local/v1', model: 'm' }),
    getApiKey: async () => '',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'NOT JSON AT ALL' } }] })
    })
  });
  const degradedRes = await analyzeRecordedTrace({ session, aiClient: brokenAi });
  assert.equal(degradedRes.ok, true);
  assert.equal(degradedRes.degraded, true);
  assert.equal(degradedRes.errorCode, 'AI_SCHEMA_INVALID');
  assert.equal(degradedRes.draft.parameterCandidates[0].sourceStepId, 's1');

  // 4c. 超时中止返回 AI_TIMEOUT
  const slowAi = createAiClient({
    getConfig: async () => ({ mode: 'remote', baseUrl: 'http://slow.local/v1', model: 'm', timeoutMs: 2000 }),
    getApiKey: async () => '',
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })
  });
  const timeoutRes = await slowAi.matchSkill({
    userQuery: '查电量',
    skills: [{ id: 'sk1', name: '查询', intent: '查电量', paramKeys: ['unit'] }]
  });
  assert.equal(timeoutRes.ok, false);
  assert.equal(timeoutRes.errorCode, 'AI_TIMEOUT');
  console.log('PASS: ai-client <think> stripping, 1x error-guided retry, fallback & AI_TIMEOUT');
}

// ---------------------------------------------------------------------------
// 5. clarification.js: matchSkill + extractArgs（缺参追问、相对日期与非法拦截）
// ---------------------------------------------------------------------------
{
  const mockAi = createAiClient({ getConfig: async () => ({ mode: 'mock' }) });
  const skills = [
    {
      id: 'sk-query',
      name: '营销电量台账查询',
      intent: '按单位和月份查询台账明细',
      parameters: [
        { key: 'unit', label: '查询单位', type: 'string', required: true },
        { key: 'month', label: '查询月份', type: 'month', required: true }
      ]
    },
    {
      id: 'sk-form',
      name: '台账批量录入',
      intent: '录入供电单位与申报电量',
      parameters: [{ key: 'orgName', label: '供电单位', type: 'string', required: true }]
    }
  ];

  const matched = await matchSkillByQuery({ userQuery: '帮我查 B 单位电量', skills, aiClient: mockAi });
  assert.equal(matched.matchedSkillId, 'sk-query');

  const round1 = await extractArgsFromInput({
    userText: '查 B 单位',
    parameters: skills[0].parameters,
    collectedArgs: {},
    lastQuestion: null,
    currentDate: '2026-11-24',
    aiClient: mockAi
  });
  assert.equal(round1.providedArgs.unit, 'B单位');
  assert.deepEqual(round1.missingRequired, ['month']);
  assert.ok(round1.nextQuestion.includes('查询月份'));

  // 非法月份格式拦截
  const badRound = await extractArgsFromInput({
    userText: '2026-13',
    parameters: skills[0].parameters,
    collectedArgs: round1.providedArgs,
    lastQuestion: round1.nextQuestion,
    currentDate: '2026-11-24',
    aiClient: mockAi
  });
  assert.equal(badRound.invalidArgs.length, 1);
  assert.equal(badRound.invalidArgs[0].errorCode, 'PARAMETER_INVALID');

  // 相对日期“上个月”结合 currentDate 归一化（含跨年边界）
  const round2 = await extractArgsFromInput({
    userText: '上个月',
    parameters: skills[0].parameters,
    collectedArgs: round1.providedArgs,
    lastQuestion: round1.nextQuestion,
    currentDate: '2026-11-24',
    aiClient: mockAi
  });
  assert.equal(round2.providedArgs.unit, 'B单位');
  assert.equal(round2.providedArgs.month, '2026-10');
  assert.deepEqual(round2.missingRequired, []);

  assert.equal(normalizeRelativeDate('上个月', '2026-01-15', 'month').value, '2025-12');
  console.log('PASS: clarification matchSkill, extractArgs slot merge, relative dates & invalid format rejection');
}

// ---------------------------------------------------------------------------
// 6. Mv3ContentScriptDriver + RunController 状态机全流程测试
//    覆盖：微瑕1同路径保留query、outputVar跨系统传值、prefill_only、auth_checkpoint双模式、planHash防篡改
// ---------------------------------------------------------------------------
function buildRunTestHarness({ initialUrl, authStateSequence = [], captcha = false }) {
  const localStore = {};
  const sessionStore = {};
  const navCalls = [];
  const stepCalls = [];
  let currentUrl = initialUrl;
  let authIdx = 0;

  const chromeMock = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) => {
        return await new Promise((resolve) => {
          const handled = bgCtrl.handleMessage(msg, { tab: { id: 21 }, url: currentUrl }, resolve);
          if (!handled) resolve({ ok: false });
        });
      }
    },
    sidePanel: { setPanelBehavior: async () => {} },
    permissions: { contains: async () => true },
    tabs: {
      onUpdated: { addListener: () => {} },
      query: async () => [{ id: 21, url: currentUrl, status: 'complete' }],
      get: async (tabId) => ({ id: tabId, url: currentUrl, status: 'complete' }),
      update: async (tabId, { url }) => {
        navCalls.push(url);
        currentUrl = url;
        return { id: tabId, url };
      },
      sendMessage: async (_tabId, msg) => {
        if (msg.type === 'PING') return { ok: true, url: currentUrl };
        if (msg.type === 'CHECK_AUTH_STATE') {
          const cur = authStateSequence[Math.min(authIdx++, Math.max(0, authStateSequence.length - 1))] || {
            state: 'AUTHENTICATED',
            hasCaptcha: false,
            canEphemeralFill: false
          };
          return { ok: true, ...cur };
        }
        if (msg.type === 'FILL_EPHEMERAL_AUTH') {
          if (captcha) {
            return {
              ok: false,
              errorCode: 'AUTH_CAPTCHA_DETECTED',
              downgradeToManual: true,
              message: '检测到验证码，已降级'
            };
          }
          return { ok: true, submitted: true };
        }
        if (msg.type === 'PLAY_STEP') {
          stepCalls.push(structuredClone(msg.step));
          if (msg.step.action === 'extract') {
            return { ok: true, action: 'extract', extractedValue: 'KH-202611-HZ01', matchedLocator: 'cssPath' };
          }
          return { ok: true, action: msg.step.action, matchedLocator: 'label+tag' };
        }
        if (msg.type === 'GET_RESULT') {
          return { ok: true, found: true, status: 'ok', text: '提交成功：GD-202611-001' };
        }
        return { ok: true };
      }
    },
    scripting: { executeScript: async () => {} },
    storage: {
      local: {
        get: async (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(arr.filter((k) => k in localStore).map((k) => [k, structuredClone(localStore[k])]));
        },
        set: async (patch) => Object.assign(localStore, structuredClone(patch))
      },
      session: {
        get: async (k) => (k in sessionStore ? { [k]: structuredClone(sessionStore[k]) } : {}),
        set: async (patch) => Object.assign(sessionStore, structuredClone(patch)),
        remove: async (k) => {
          delete sessionStore[k];
        }
      }
    }
  };

  const bgCtrl = createBackgroundController(chromeMock);
  const store = createStore(chromeMock);
  const driver = createDriver('mv3-content', { chromeApi: chromeMock, stepDelayMs: 0 });
  const approvalClient = {
    approvePlan: (m) => bgCtrl.approvePlan(m),
    verifyPlan: (m) => bgCtrl.verifyPlan(m),
    revokePlan: (m) => bgCtrl.revokePlan(m)
  };
  const controller = createRunController({ driver, store, approvalClient });

  return { controller, bgCtrl, store, navCalls, stepCalls, localStore, sessionStore };
}

// 6a. 微瑕 1 + outputVar 跨系统传值
{
  assert.equal(
    isSamePageIgnoringQueryAndHash(
      'http://127.0.0.1:18761/sys_a_query.html?layout=v2#/marketing/query',
      'http://127.0.0.1:18761/sys_a_query.html'
    ),
    true
  );

  const skill = normalizeSkillIR({
    id: 'sk-cross',
    name: '跨系统查询填报',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    allowedOrigins: ['http://127.0.0.1:18761', 'http://127.0.0.1:18762'],
    resultSelector: '#receipt-status',
    parameters: [{ key: 'unit', label: '查询单位', type: 'string', required: true }],
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18761', paramKey: 'unit', target: { label: '查询单位' } },
      { id: 's2', action: 'click', origin: 'http://127.0.0.1:18761', target: { text: '查询数据' } },
      { id: 's3', action: 'extract', origin: 'http://127.0.0.1:18761', target: { cssPath: '#result-table tbody tr:first-child td:first-child' }, outputVar: 'customerBatchCode' },
      { id: 's4', action: 'navigate', origin: 'http://127.0.0.1:18762', url: 'http://127.0.0.1:18762/sys_b_form.html' },
      { id: 's5', action: 'fill', origin: 'http://127.0.0.1:18762', valueRef: { var: 'customerBatchCode' }, target: { label: '关联客户批号' } },
      { id: 's6', action: 'click', origin: 'http://127.0.0.1:18762', target: { text: '提交台账' }, risk: 'write_commit' }
    ]
  });

  const harness = buildRunTestHarness({
    initialUrl: 'http://127.0.0.1:18761/sys_a_query.html?layout=v2'
  });
  const snapshot = await buildPlanSnapshot({ skill, args: { unit: '杭州供电所' } });
  const finalState = await harness.controller.start({ skill, snapshot, confirmRiskStep: async () => true });

  assert.equal(finalState.status, 'VERIFIED_SUCCESS');
  // 起始页同 origin + pathname 的 ?layout=v2 未被重置，仅发生跨系统 s4 一次 navigate
  assert.deepEqual(harness.navCalls, ['http://127.0.0.1:18762/sys_b_form.html']);
  assert.equal(finalState.vars.customerBatchCode, 'KH-202611-HZ01');
  const fillBatchStep = harness.stepCalls.find((s) => s.id === 's5');
  assert.equal(fillBatchStep.value, 'KH-202611-HZ01');

  // 6b. prefill_only 模式：自动跳过 write_commit 点击并标为 ACTIONS_COMPLETED_UNVERIFIED
  const prefillHarness = buildRunTestHarness({
    initialUrl: 'http://127.0.0.1:18761/sys_a_query.html'
  });
  const prefillSnap = await buildPlanSnapshot({ skill, args: { unit: '杭州供电所' }, writeMode: 'prefill_only' });
  const prefillState = await prefillHarness.controller.start({ skill, snapshot: prefillSnap });
  assert.equal(prefillState.status, 'ACTIONS_COMPLETED_UNVERIFIED');
  assert.equal(prefillHarness.stepCalls.some((s) => s.id === 's6'), false);
  console.log('PASS: Same-path query preservation, cross-system outputVar transfer & prefill_only');
}

// 6c. auth_checkpoint 模式 A（人工接管）+ 模式 B（内存临时密文填单与验证码自动降级）
{
  const authSkill = normalizeSkillIR({
    id: 'sk-auth',
    name: '含登录流程',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    allowedOrigins: ['http://127.0.0.1:18761'],
    authPolicy: 'manual_takeover',
    resultSelector: '#result-summary',
    steps: [
      { id: 's1', action: 'auth_checkpoint', origin: 'http://127.0.0.1:18761' },
      { id: 's2', action: 'click', origin: 'http://127.0.0.1:18761', target: { text: '查询数据' } }
    ]
  });
  const snapA = await buildPlanSnapshot({ skill: authSkill, args: {} });

  // 模式 A：先停 AUTH_REQUIRED，继续前若未登录仍拦截，登录后原位续跑
  const hA = buildRunTestHarness({
    initialUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    authStateSequence: [
      { state: 'AUTH_REQUIRED', hasCaptcha: true, canEphemeralFill: false },
      { state: 'AUTH_REQUIRED', hasCaptcha: true, canEphemeralFill: false },
      { state: 'AUTHENTICATED', hasCaptcha: false, canEphemeralFill: false }
    ]
  });
  const pausedA = await hA.controller.start({ skill: authSkill, snapshot: snapA });
  assert.equal(pausedA.status, 'PAUSED_AUTH_REQUIRED');
  assert.equal(pausedA.authPauseInfo.mode, 'manual_takeover');

  const stillNotLoggedIn = await hA.controller.resumeAfterManualAuth();
  assert.equal(stillNotLoggedIn.ok, false);
  assert.equal(stillNotLoggedIn.errorCode, 'AUTH_REQUIRED');

  const resumedA = await hA.controller.resumeAfterManualAuth();
  assert.equal(resumedA.ok, true);
  assert.equal(resumedA.state.status, 'VERIFIED_SUCCESS');
  assert.equal(hA.stepCalls.length, 1);

  // 模式 B：ephemeral_prompt 成功填单、内存即毁、零落盘
  const hB = buildRunTestHarness({
    initialUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    authStateSequence: [
      { state: 'AUTH_REQUIRED', hasCaptcha: false, canEphemeralFill: true },
      { state: 'AUTHENTICATED', hasCaptcha: false, canEphemeralFill: false }
    ]
  });
  const pausedB = await hB.controller.start({
    skill: authSkill,
    snapshot: snapA,
    authPolicyOverride: 'ephemeral_prompt'
  });
  assert.equal(pausedB.status, 'PAUSED_AUTH_REQUIRED');
  assert.equal(pausedB.authPauseInfo.mode, 'ephemeral_prompt');

  const creds = { username: 'sg_ops01', password: 'EPHEMERAL_SECRET_PASSWORD' };
  const resumedB = await hB.controller.submitEphemeralAuth(creds);
  assert.equal(creds.username, '');
  assert.equal(creds.password, '');
  assert.equal(resumedB.ok, true);
  assert.equal(resumedB.state.status, 'VERIFIED_SUCCESS');
  assert.equal(JSON.stringify(hB.localStore).includes('EPHEMERAL_SECRET_PASSWORD'), false);
  assert.equal(JSON.stringify(hB.sessionStore).includes('EPHEMERAL_SECRET_PASSWORD'), false);

  // 模式 B 遇验证码自动降级为模式 A
  const hBcap = buildRunTestHarness({
    initialUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    authStateSequence: [
      { state: 'AUTH_REQUIRED', hasCaptcha: true, canEphemeralFill: false },
      { state: 'AUTHENTICATED', hasCaptcha: false, canEphemeralFill: false }
    ]
  });
  const pausedBcap = await hBcap.controller.start({
    skill: authSkill,
    snapshot: snapA,
    authPolicyOverride: 'ephemeral_prompt'
  });
  assert.equal(pausedBcap.status, 'PAUSED_AUTH_REQUIRED');
  assert.equal(pausedBcap.authPauseInfo.mode, 'manual_takeover');
  assert.equal(pausedBcap.authPauseInfo.downgraded, true);

  // 中途撤销审批必须触发 PLAN_NOT_APPROVED 阻断续跑
  await hBcap.bgCtrl.revokePlan({ planHash: snapA.planHash });
  const blockedResume = await hBcap.controller.resumeAfterManualAuth();
  assert.equal(blockedResume.ok, true);
  assert.equal(blockedResume.state.status, 'FAILED');
  assert.equal(blockedResume.state.errorCode, 'PLAN_NOT_APPROVED');
  console.log('PASS: auth_checkpoint Mode A/B, credential wipe, captcha downgrade & planHash gate');
}
