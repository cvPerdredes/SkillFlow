import assert from 'node:assert/strict';

globalThis.__SKILLFLOW_NO_AUTO_ATTACH__ = true;
const { createBackgroundController } = await import('../extension/background.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createMockChrome({
  localStore = {},
  sessionStore = {},
  permittedOrigins = ['http://127.0.0.1:18761'],
  tabUrlMap = { 11: 'http://127.0.0.1:18761/sys_a_query.html' },
  storageDelayMs = 0
} = {}) {
  const listeners = {
    onInstalled: [],
    onUpdated: [],
    onMessage: []
  };
  const sentTabMessages = [];
  const executedScripts = [];
  const runtimeMessages = [];
  const allowedSet = new Set(permittedOrigins);

  const readStore = async (storeObj, keys) => {
    if (storageDelayMs) await delay(storageDelayMs);
    if (keys === undefined || keys === null) return structuredClone(storeObj);
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) {
      if (k in storeObj) out[k] = structuredClone(storeObj[k]);
    }
    return out;
  };

  const writeStore = async (storeObj, patch) => {
    if (storageDelayMs) await delay(storageDelayMs);
    for (const [k, v] of Object.entries(patch || {})) {
      storeObj[k] = structuredClone(v);
    }
  };

  const chromeMock = {
    runtime: {
      onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
      onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
      sendMessage: async (msg) => {
        runtimeMessages.push(msg);
        return { ok: true };
      }
    },
    sidePanel: { setPanelBehavior: async () => {} },
    permissions: {
      contains: async ({ origins }) => {
        return (origins || []).every((pattern) => {
          const origin = pattern.replace(/\/\*$/, '');
          return allowedSet.has(origin);
        });
      }
    },
    tabs: {
      onUpdated: { addListener: (fn) => listeners.onUpdated.push(fn) },
      get: async (tabId) => ({ id: tabId, url: tabUrlMap[tabId] || '', status: 'complete' }),
      sendMessage: async (tabId, msg) => {
        sentTabMessages.push({ tabId, msg });
        return { ok: true };
      }
    },
    scripting: {
      executeScript: async (opts) => {
        executedScripts.push(opts);
      }
    },
    storage: {
      local: {
        get: (keys) => readStore(localStore, keys),
        set: (patch) => writeStore(localStore, patch)
      },
      session: {
        get: (keys) => readStore(sessionStore, keys),
        set: (patch) => writeStore(sessionStore, patch),
        setAccessLevel: async () => {}
      }
    }
  };

  return {
    chromeMock,
    localStore,
    sessionStore,
    allowedSet,
    tabUrlMap,
    sentTabMessages,
    executedScripts,
    runtimeMessages,
    listeners
  };
}

// ---------------------------------------------------------------------------
// 1. Bug 2: sanitizeUrl 保留路由 Hash 与白名单业务 Query，剔除敏感凭证参数
// ---------------------------------------------------------------------------
{
  const env = createMockChrome({
    localStore: {
      recording: { active: true, tabId: 11 },
      currentSession: { id: 's1', allowedOrigins: [], steps: [] }
    }
  });
  const ctrl = createBackgroundController(env.chromeMock);
  const sender = {
    tab: { id: 11 },
    url: 'http://127.0.0.1:18761/sys_a_query.html?token=secret&menuId=M201&month=2026-11#/marketing/query?ticket=abc&tab=detail'
  };
  const res = await ctrl.handleRecordEvent(
    { action: 'fill', target: { label: '查询月份', cssPath: '#month', tag: 'input' }, value: '2026-11' },
    sender
  );
  assert.equal(res.ok, true);
  assert.equal(
    env.localStore.currentSession.steps[0].url,
    'http://127.0.0.1:18761/sys_a_query.html?menuId=M201&month=2026-11#/marketing/query?tab=detail'
  );
  console.log('PASS: Bug 2 sanitizeUrl preserves route hash and whitelist business query');
}

// ---------------------------------------------------------------------------
// 2. Bug 3: tabs.onUpdated 与 RECORD_EVENT 共用同一串行队列，异步存储下零丢步
// ---------------------------------------------------------------------------
{
  const env = createMockChrome({
    storageDelayMs: 15,
    localStore: {
      recording: { active: true, tabId: 11 },
      currentSession: { id: 's2', allowedOrigins: ['http://127.0.0.1:18761'], steps: [] }
    }
  });
  const ctrl = createBackgroundController(env.chromeMock);
  const sender = { tab: { id: 11 }, url: 'http://127.0.0.1:18761/sys_a_query.html' };

  const [r1, r2] = await Promise.all([
    ctrl.handleRecordEvent(
      { action: 'click', target: { stableId: '#goto', text: '下一页', tag: 'a', cssPath: '#goto' } },
      sender
    ),
    ctrl.handleTabUpdated(
      11,
      { url: 'http://127.0.0.1:18761/second.html?menuId=M202', status: 'complete' },
      { id: 11, url: 'http://127.0.0.1:18761/second.html?menuId=M202' }
    )
  ]);

  assert.equal(r1.ok, true);
  assert.equal(r2.status, 'ready');
  assert.equal(env.localStore.currentSession.steps.length, 2, '并发写入不得丢失任何步骤');
  assert.equal(env.localStore.currentSession.steps[0].action, 'click');
  assert.equal(env.localStore.currentSession.steps[1].action, 'navigate');
  console.log('PASS: Bug 3 unified serial queue prevents tabs.onUpdated race drops');
}

// ---------------------------------------------------------------------------
// 3. Bug 4: fill 折叠 (>600ms 仍合并)、check 状态翻转保留、click 连点不误吞、auth 合并
// ---------------------------------------------------------------------------
{
  const env = createMockChrome({
    localStore: {
      recording: { active: true, tabId: 11 },
      currentSession: { id: 's3', allowedOrigins: ['http://127.0.0.1:18761'], steps: [] }
    }
  });
  const ctrl = createBackgroundController(env.chromeMock);
  const sender = { tab: { id: 11 }, url: 'http://127.0.0.1:18761/sys_a_query.html' };

  // 3a. fill 连续多次（模拟超过 600ms 间隔）依然折叠保留最终值
  await ctrl.handleRecordEvent(
    { action: 'fill', target: { stableId: '#unit', label: '查询单位', cssPath: '#unit', tag: 'input' }, value: '杭州' },
    sender
  );
  env.localStore.currentSession.steps[0].ts -= 5000;
  const fillRes2 = await ctrl.handleRecordEvent(
    { action: 'fill', target: { stableId: '#unit', label: '查询单位', cssPath: '#unit', tag: 'input' }, value: '杭州供电所' },
    sender
  );
  assert.equal(fillRes2.collapsed, true);
  assert.equal(env.localStore.currentSession.steps.length, 1);
  assert.equal(env.localStore.currentSession.steps[0].value, '杭州供电所');

  // 3b. check 状态翻转不得被吞掉，同状态 600ms 内去重
  await ctrl.handleRecordEvent(
    { action: 'check', target: { stableId: '#chk', cssPath: '#chk', tag: 'input' }, checked: true },
    sender
  );
  await ctrl.handleRecordEvent(
    { action: 'check', target: { stableId: '#chk', cssPath: '#chk', tag: 'input' }, checked: false },
    sender
  );
  const dupCheck = await ctrl.handleRecordEvent(
    { action: 'check', target: { stableId: '#chk', cssPath: '#chk', tag: 'input' }, checked: false },
    sender
  );
  assert.equal(dupCheck.deduped, true);
  assert.equal(env.localStore.currentSession.steps.length, 3); // fill + check(true) + check(false)

  // 3c. click 连点不误吞
  await ctrl.handleRecordEvent(
    { action: 'click', target: { stableId: '#next', text: '下一页', cssPath: '#next', tag: 'button' } },
    sender
  );
  await ctrl.handleRecordEvent(
    { action: 'click', target: { stableId: '#next', text: '下一页', cssPath: '#next', tag: 'button' } },
    sender
  );
  assert.equal(env.localStore.currentSession.steps.length, 5);

  // 3d. 登录容器内多步折叠为单个 auth_checkpoint 且零原值
  await ctrl.handleRecordEvent(
    { action: 'auth_checkpoint', target: { stableId: '#login-user', label: '员工账号', tag: 'input' }, inAuthContainer: true },
    sender
  );
  await ctrl.handleRecordEvent(
    { action: 'auth_checkpoint', target: { stableId: '#login-pass', label: '登录密码', tag: 'input' }, inAuthContainer: true },
    sender
  );
  await ctrl.handleRecordEvent(
    { action: 'auth_checkpoint', target: { stableId: '#login-submit', text: '登录系统 A', tag: 'button' }, inAuthContainer: true },
    sender
  );
  assert.equal(env.localStore.currentSession.steps.length, 6);
  const authStep = env.localStore.currentSession.steps[5];
  assert.equal(authStep.action, 'auth_checkpoint');
  assert.equal('value' in authStep, false);
  console.log('PASS: Bug 4 fill collapsing, check flip preservation, rapid clicks, auth_checkpoint merge');
}

// ---------------------------------------------------------------------------
// 4. 修正 2: 后台接收 RECORD_EVENT 走 sanitizer.js 二次兜底清洗，绝不落盘密码/手机号
// ---------------------------------------------------------------------------
{
  const env = createMockChrome({
    localStore: {
      recording: { active: true, tabId: 11 },
      currentSession: { id: 's4', allowedOrigins: ['http://127.0.0.1:18761'], steps: [] }
    }
  });
  const ctrl = createBackgroundController(env.chromeMock);
  const sender = { tab: { id: 11 }, url: 'http://127.0.0.1:18761/sys_a_query.html' };

  await ctrl.handleRecordEvent(
    { action: 'fill', target: { label: '手机号', cssPath: '#mobile', tag: 'input' }, value: '13800138000' },
    sender
  );
  await ctrl.handleRecordEvent(
    { action: 'fill', target: { label: '登录密码', cssPath: '#pwd', tag: 'input' }, value: 'SuperSecret!2026' },
    sender
  );
  const steps = env.localStore.currentSession.steps;
  assert.equal(steps[0].action, 'manual');
  assert.equal(steps[0].sensitive, true);
  assert.equal('value' in steps[0], false);
  assert.equal(steps[1].action, 'auth_checkpoint');
  assert.equal('value' in steps[1], false);
  const serialized = JSON.stringify(env.localStore);
  assert.equal(serialized.includes('13800138000'), false);
  assert.equal(serialized.includes('SuperSecret!2026'), false);
  console.log('PASS: Defense-in-depth backend sanitizer strips raw credentials & PII');
}

// ---------------------------------------------------------------------------
// 5. 修正 3: 录制中跳转未授权站点 18762 -> 提示授权 -> 一键授权并恢复录制且不丢前序步骤
// ---------------------------------------------------------------------------
{
  const env = createMockChrome({
    permittedOrigins: ['http://127.0.0.1:18761'],
    tabUrlMap: { 11: 'http://127.0.0.1:18761/sys_a_query.html' },
    localStore: {
      recording: { active: true, tabId: 11, origin: 'http://127.0.0.1:18761' },
      currentSession: {
        id: 's5',
        allowedOrigins: ['http://127.0.0.1:18761'],
        steps: [{ id: 'prev-1', action: 'click', url: 'http://127.0.0.1:18761/sys_a_query.html' }]
      }
    }
  });
  const ctrl = createBackgroundController(env.chromeMock);

  // 跳转到未授权的 18762
  env.tabUrlMap[11] = 'http://127.0.0.1:18762/sys_b_form.html';
  const navRes = await ctrl.handleTabUpdated(
    11,
    { url: 'http://127.0.0.1:18762/sys_b_form.html', status: 'complete' },
    { id: 11, url: 'http://127.0.0.1:18762/sys_b_form.html' }
  );
  assert.equal(navRes.status, 'pending_auth');
  assert.equal(env.localStore.recording.active, true);
  assert.equal(env.localStore.recording.pendingAuthOrigin, 'http://127.0.0.1:18762');
  assert.equal(env.localStore.currentSession.steps.length, 1);
  assert.equal(env.runtimeMessages.at(-1)?.type, 'RECORDING_SITE_PERMISSION_REQUIRED');

  // 用户点击面板“授权当前站点并继续录制”后
  env.allowedSet.add('http://127.0.0.1:18762');
  const authRes = await ctrl.authorizeRecordingOrigin({
    tabId: 11,
    url: 'http://127.0.0.1:18762/sys_b_form.html'
  });
  assert.equal(authRes.ok, true);
  assert.equal(env.localStore.recording.pendingAuthOrigin, null);
  assert.deepEqual(env.localStore.currentSession.allowedOrigins, [
    'http://127.0.0.1:18761',
    'http://127.0.0.1:18762'
  ]);
  assert.equal(env.localStore.currentSession.steps.length, 2);
  assert.equal(env.localStore.currentSession.steps[1].action, 'navigate');
  assert.equal(env.executedScripts.length, 1);
  assert.deepEqual(env.sentTabMessages.at(-1), {
    tabId: 11,
    msg: { type: 'SET_RECORDING', enabled: true }
  });
  console.log('PASS: Cross-origin jump prompts authorization and seamlessly resumes recording');
}

// ---------------------------------------------------------------------------
// 6. Bug 6 + 修正 1: planHash 审批持久化至 storage.session，SW 重启不失效且防篡改
// ---------------------------------------------------------------------------
{
  const env = createMockChrome({
    permittedOrigins: ['http://127.0.0.1:18761', 'http://127.0.0.1:18762']
  });
  const ctrl1 = createBackgroundController(env.chromeMock);

  const payload = {
    skillId: 'skill-001',
    skillVersion: 1,
    targetOrigins: ['http://127.0.0.1:18761', 'http://127.0.0.1:18762'],
    writeMode: 'commit',
    args: { unit: '杭州供电所', month: '2026-11' },
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18761', target: { stableId: '#unit' }, value: '杭州供电所' },
      { id: 's2', action: 'click', origin: 'http://127.0.0.1:18761', target: { stableId: '#query-btn', text: '查询数据' } }
    ]
  };

  // 未审批前必拒
  const beforeApprove = await ctrl1.verifyPlan({ planHash: 'fake', payload });
  assert.equal(beforeApprove.ok, false);
  assert.equal(beforeApprove.errorCode, 'PLAN_NOT_APPROVED');

  // 审批并校验落入 session（绝不落入 local）
  const approved = await ctrl1.approvePlan({ payload });
  assert.equal(approved.ok, true);
  assert.ok(env.sessionStore.sf_approved_plans?.[approved.planHash]);
  assert.equal('sf_approved_plans' in env.localStore, false);

  // 模拟 MV3 Service Worker 休眠重启：新建全新 controller 实例
  const ctrlAfterWake = createBackgroundController(env.chromeMock);
  const validAfterWake = await ctrlAfterWake.verifyPlan({
    planHash: approved.planHash,
    payload
  });
  assert.equal(validAfterWake.ok, true, 'SW 重启后 session 中的审批快照仍应有效');

  // 参数变更立刻报 PLAN_NOT_APPROVED
  const tamperedArgs = structuredClone(payload);
  tamperedArgs.args.unit = '未备案所';
  const resArgs = await ctrlAfterWake.verifyPlan({
    planHash: approved.planHash,
    payload: tamperedArgs
  });
  assert.equal(resArgs.ok, false);
  assert.equal(resArgs.errorCode, 'PLAN_NOT_APPROVED');

  // 站点变更立刻报 PLAN_NOT_APPROVED
  const tamperedOrigin = structuredClone(payload);
  tamperedOrigin.targetOrigins = ['http://127.0.0.1:18761'];
  const resOrigin = await ctrlAfterWake.verifyPlan({
    planHash: approved.planHash,
    payload: tamperedOrigin
  });
  assert.equal(resOrigin.ok, false);
  assert.equal(resOrigin.errorCode, 'PLAN_NOT_APPROVED');

  // 步骤变更立刻报 PLAN_NOT_APPROVED
  const tamperedStep = structuredClone(payload);
  tamperedStep.steps[0].value = '篡改值';
  const resStep = await ctrlAfterWake.verifyPlan({
    planHash: approved.planHash,
    payload: tamperedStep
  });
  assert.equal(resStep.ok, false);
  assert.equal(resStep.errorCode, 'PLAN_NOT_APPROVED');

  // 撤销后立即失效
  await ctrlAfterWake.revokePlan({ planHash: approved.planHash });
  const afterRevoke = await ctrlAfterWake.verifyPlan({
    planHash: approved.planHash,
    payload
  });
  assert.equal(afterRevoke.ok, false);
  assert.equal(afterRevoke.errorCode, 'PLAN_NOT_APPROVED');
  console.log('PASS: Bug 6 + Refinement 1 session-persisted planHash gate survives SW restart & blocks tampering');
}

// ---------------------------------------------------------------------------
// 7. CHECK_ORIGIN_ACCESS 站点白名单与浏览器权限联合校验
// ---------------------------------------------------------------------------
{
  const env = createMockChrome({
    permittedOrigins: ['http://127.0.0.1:18761'],
    tabUrlMap: { 11: 'http://127.0.0.1:18761/sys_a_query.html' }
  });
  const ctrl = createBackgroundController(env.chromeMock);

  const okRes = await ctrl.checkOriginAccess({
    tabId: 11,
    allowedOrigins: ['http://127.0.0.1:18761', 'http://127.0.0.1:18762']
  });
  assert.equal(okRes.ok, true);

  const unpermittedRes = await ctrl.checkOriginAccess({
    url: 'http://127.0.0.1:18762/sys_b_form.html',
    allowedOrigins: ['http://127.0.0.1:18761', 'http://127.0.0.1:18762']
  });
  assert.equal(unpermittedRes.ok, false);
  assert.equal(unpermittedRes.errorCode, 'SITE_NOT_ALLOWED');

  const outsideWhitelistRes = await ctrl.checkOriginAccess({
    tabId: 11,
    allowedOrigins: ['http://127.0.0.1:18762']
  });
  assert.equal(outsideWhitelistRes.ok, false);
  assert.equal(outsideWhitelistRes.errorCode, 'SITE_NOT_ALLOWED');
  console.log('PASS: CHECK_ORIGIN_ACCESS enforces both allowedOrigins and browser host permissions');
}

// ---------------------------------------------------------------------------
// 8. 微瑕 2: auth_checkpoint 的 loggedInIndicator 显式空串不得强加 '#user-badge'
// ---------------------------------------------------------------------------
{
  const env = createMockChrome({
    localStore: {
      recording: { active: true, tabId: 11 },
      currentSession: { id: 's8', allowedOrigins: ['http://127.0.0.1:18761'], steps: [] }
    }
  });
  const ctrl = createBackgroundController(env.chromeMock);
  await ctrl.handleRecordEvent(
    {
      action: 'auth_checkpoint',
      authSelector: '#custom-login',
      loggedInIndicator: '',
      inAuthContainer: true,
      target: { stableId: '#custom-pass', type: 'password' }
    },
    { tab: { id: 11 }, url: 'http://127.0.0.1:18761/custom.html' }
  );
  assert.equal(env.localStore.currentSession.steps[0].loggedInIndicator, '');
  console.log('PASS: Micro-fix 2 preserves explicit empty loggedInIndicator');
}
