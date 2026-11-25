"use strict";

import { safeOriginOf, sanitizeRecordedStep, sanitizeUrl } from './lib/sanitizer.js';
import { computePlanHashFromPayload } from './lib/plan-builder.js';

const APPROVED_PLANS_KEY = 'sf_approved_plans';
const MAX_APPROVED_PLANS = 20;
const RECORDABLE_ACTIONS = new Set([
  'click',
  'fill',
  'select',
  'check',
  'keypress',
  'manual',
  'auth_checkpoint'
]);

function isSameTarget(a, b) {
  if (!a || !b) return false;
  if (a.testId && b.testId) return a.testId === b.testId;
  if (a.stableId && b.stableId) return a.stableId === b.stableId;
  const cssA = a.cssPath || a.css;
  const cssB = b.cssPath || b.css;
  if (cssA && cssB) return cssA === cssB;
  return (
    Boolean(a.tag || b.tag) &&
    a.tag === b.tag &&
    (a.label || '') === (b.label || '') &&
    (a.name || '') === (b.name || '')
  );
}

function appendAllowedOrigin(session, origin) {
  if (!session || !origin) return;
  if (!Array.isArray(session.allowedOrigins)) {
    session.allowedOrigins = [];
  }
  if (!session.allowedOrigins.includes(origin)) {
    session.allowedOrigins.push(origin);
  }
}

/**
 * 创建背景调度控制器（支持 MV3 Service Worker 与 Node 单测隔离注入 chromeApi）。
 */
export function createBackgroundController(chromeApi = globalThis.chrome) {
  let storageWriteQueue = Promise.resolve();
  let sessionWriteQueue = Promise.resolve();
  let fallbackSessionPlans = {};

  function enqueueStorageWrite(task) {
    const run = storageWriteQueue.catch(() => {}).then(task);
    storageWriteQueue = run.catch(() => {});
    return run;
  }

  function enqueueSessionOp(task) {
    const run = sessionWriteQueue.catch(() => {}).then(task);
    sessionWriteQueue = run.catch(() => {});
    return run;
  }

  async function readApprovedPlans() {
    const sessionApi = chromeApi?.storage?.session;
    if (sessionApi?.get) {
      const data = await sessionApi.get(APPROVED_PLANS_KEY);
      const map = data?.[APPROVED_PLANS_KEY];
      return map && typeof map === 'object' ? { ...map } : {};
    }
    return { ...fallbackSessionPlans };
  }

  async function writeApprovedPlans(map) {
    const entries = Object.entries(map || {})
      .sort((a, b) => (b[1]?.approvedAt || 0) - (a[1]?.approvedAt || 0))
      .slice(0, MAX_APPROVED_PLANS);
    const trimmed = Object.fromEntries(entries);
    const sessionApi = chromeApi?.storage?.session;
    if (sessionApi?.set) {
      await sessionApi.set({ [APPROVED_PLANS_KEY]: trimmed });
    } else {
      fallbackSessionPlans = trimmed;
    }
    return trimmed;
  }

  async function permitted(url) {
    try {
      const u = new URL(String(url || ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return Boolean(await chromeApi.permissions.contains({ origins: [u.origin + '/*'] }));
    } catch (_) {
      return false;
    }
  }

  function notifyRuntimeBestEffort(payload) {
    try {
      const maybePromise = chromeApi?.runtime?.sendMessage?.(payload);
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {});
      }
    } catch (_) {
      // Side Panel 未打开时允许静默忽略
    }
  }

  async function inject(tabId, url) {
    if (!(await permitted(url))) return false;
    try {
      await chromeApi.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      const { recording } = await chromeApi.storage.local.get('recording');
      if (recording?.active && recording.tabId === tabId) {
        await chromeApi.tabs.sendMessage(tabId, { type: 'SET_RECORDING', enabled: true });
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async function handleTabUpdated(tabId, change, tab) {
    const outcome = await enqueueStorageWrite(async () => {
      const { recording, currentSession } = await chromeApi.storage.local.get([
        'recording',
        'currentSession'
      ]);
      if (!recording?.active || recording.tabId !== tabId) {
        return { status: 'noop' };
      }

      const rawUrl = change?.url || tab?.url || '';
      const origin = safeOriginOf(rawUrl);
      if (!origin) {
        return { status: 'noop' };
      }

      const isAllowed = await permitted(rawUrl);
      if (!isAllowed) {
        const cleanPendingUrl = sanitizeUrl(rawUrl);
        const nextRecording = {
          ...recording,
          pendingAuthOrigin: origin,
          pendingAuthUrl: cleanPendingUrl
        };
        await chromeApi.storage.local.set({ recording: nextRecording });
        notifyRuntimeBestEffort({
          type: 'RECORDING_SITE_PERMISSION_REQUIRED',
          tabId,
          origin,
          url: cleanPendingUrl
        });
        return { status: 'pending_auth', origin };
      }

      let sessionChanged = false;
      let recordingChanged = false;
      const nextRecording = { ...recording };
      if (nextRecording.pendingAuthOrigin || nextRecording.pendingAuthUrl) {
        nextRecording.pendingAuthOrigin = null;
        nextRecording.pendingAuthUrl = null;
        recordingChanged = true;
      }

      if (currentSession?.steps) {
        const prevOrigins = Array.isArray(currentSession.allowedOrigins)
          ? currentSession.allowedOrigins.length
          : 0;
        appendAllowedOrigin(currentSession, origin);
        if (currentSession.allowedOrigins.length !== prevOrigins) {
          sessionChanged = true;
        }
        if (change?.url) {
          const cleanUrl = sanitizeUrl(change.url);
          if (cleanUrl) {
            const last = currentSession.steps.at(-1);
            if (last?.action !== 'navigate' || last.url !== cleanUrl) {
              currentSession.steps.push({
                id: crypto.randomUUID(),
                action: 'navigate',
                origin,
                url: cleanUrl,
                ts: Date.now()
              });
              sessionChanged = true;
            }
          }
        }
      }

      if (sessionChanged || recordingChanged) {
        const patch = {};
        if (sessionChanged) patch.currentSession = currentSession;
        if (recordingChanged) patch.recording = nextRecording;
        await chromeApi.storage.local.set(patch);
      }

      return {
        status: 'ready',
        shouldInject: change?.status === 'complete' && Boolean(tab?.url),
        url: tab?.url || rawUrl
      };
    });

    if (outcome?.status === 'ready' && outcome.shouldInject) {
      await inject(tabId, outcome.url);
    }
    return outcome;
  }

  async function handleRecordEvent(step, sender) {
    return enqueueStorageWrite(async () => {
      const { recording, currentSession } = await chromeApi.storage.local.get([
        'recording',
        'currentSession'
      ]);
      if (
        !recording?.active ||
        !currentSession?.steps ||
        sender?.tab?.id !== recording.tabId ||
        !(await permitted(sender?.url))
      ) {
        return { ok: false, reason: 'not-recording' };
      }
      if (!step || !RECORDABLE_ACTIONS.has(step.action)) {
        return { ok: false, reason: 'invalid-step' };
      }

      const safe = sanitizeRecordedStep(step, sender.url);
      if (!RECORDABLE_ACTIONS.has(safe.action)) {
        return { ok: false, reason: 'invalid-step' };
      }

      appendAllowedOrigin(currentSession, safe.origin);

      const now = Date.now();
      const last = currentSession.steps.at(-1);

      // 1. 认证容器或密码相关步骤统一合并为单个 auth_checkpoint，绝不保存原值
      if (
        safe.action === 'auth_checkpoint' &&
        last?.action === 'auth_checkpoint' &&
        last.origin === safe.origin
      ) {
        last.ts = now;
        last.url = safe.url;
        delete last.value;
        await chromeApi.storage.local.set({ currentSession });
        return { ok: true, collapsed: true, action: 'auth_checkpoint' };
      }

      // 2. 同元素连续 fill / select 无视 600ms 限制直接原地折叠保留最终值
      if (
        (safe.action === 'fill' || safe.action === 'select') &&
        last?.action === safe.action &&
        last.url === safe.url &&
        isSameTarget(last.target, safe.target)
      ) {
        last.value = safe.value;
        last.ts = now;
        last.target = safe.target;
        await chromeApi.storage.local.set({ currentSession });
        return { ok: true, collapsed: true };
      }

      // 3. 敏感 manual 步原地折叠（永不含 value）
      if (
        safe.action === 'manual' &&
        last?.action === 'manual' &&
        last.url === safe.url &&
        isSameTarget(last.target, safe.target)
      ) {
        last.ts = now;
        delete last.value;
        await chromeApi.storage.local.set({ currentSession });
        return { ok: true, collapsed: true };
      }

      // 4. check 补充比较 checked 状态；仅在短窗内同状态重复时去重，状态翻转不吞
      if (
        safe.action === 'check' &&
        last?.action === 'check' &&
        last.url === safe.url &&
        isSameTarget(last.target, safe.target) &&
        last.checked === safe.checked &&
        now - last.ts < 600
      ) {
        return { ok: true, deduped: true };
      }

      // 5. click 不做同元素时间窗误吞，保留合法连点（翻页/增行）
      currentSession.steps.push({
        id: crypto.randomUUID(),
        ts: now,
        ...safe
      });
      await chromeApi.storage.local.set({ currentSession });
      return { ok: true };
    });
  }

  async function authorizeRecordingOrigin({ tabId, url }) {
    const resolvedTab = tabId ? await chromeApi.tabs.get(tabId).catch(() => null) : null;
    const rawUrl = url || resolvedTab?.url || '';
    const origin = safeOriginOf(rawUrl);
    if (!origin || !(await permitted(rawUrl))) {
      return {
        ok: false,
        errorCode: 'SITE_NOT_ALLOWED',
        message: '站点权限尚未授予，无法继续跨站录制'
      };
    }

    const prep = await enqueueStorageWrite(async () => {
      const { recording, currentSession } = await chromeApi.storage.local.get([
        'recording',
        'currentSession'
      ]);
      if (!recording?.active || !currentSession?.steps) {
        return { ok: false, errorCode: 'NOT_RECORDING', message: '当前没有活动中的录制会话' };
      }
      const targetTabId = tabId || recording.tabId;
      const cleanUrl = sanitizeUrl(rawUrl);
      appendAllowedOrigin(currentSession, origin);
      const last = currentSession.steps.at(-1);
      if (cleanUrl && (last?.action !== 'navigate' || last.url !== cleanUrl)) {
        currentSession.steps.push({
          id: crypto.randomUUID(),
          action: 'navigate',
          origin,
          url: cleanUrl,
          ts: Date.now()
        });
      }
      const nextRecording = {
        ...recording,
        tabId: targetTabId,
        pendingAuthOrigin: null,
        pendingAuthUrl: null
      };
      await chromeApi.storage.local.set({ currentSession, recording: nextRecording });
      return {
        ok: true,
        targetTabId,
        cleanUrl,
        stepCount: currentSession.steps.length,
        allowedOrigins: [...currentSession.allowedOrigins]
      };
    });

    if (!prep.ok) return prep;
    const injected = await inject(prep.targetTabId, rawUrl);
    if (!injected) {
      return {
        ok: false,
        errorCode: 'CONTENT_INJECT_FAILED',
        message: '授权成功但注入录制脚本失败，请刷新当前业务页面后重试'
      };
    }
    return {
      ok: true,
      origin,
      url: prep.cleanUrl,
      stepCount: prep.stepCount,
      allowedOrigins: prep.allowedOrigins
    };
  }

  async function approvePlan(message) {
    const payload = message?.payload;
    if (!payload || !payload.skillId) {
      return { ok: false, errorCode: 'PLAN_NOT_APPROVED', message: '缺少有效执行计划载荷' };
    }
    return enqueueSessionOp(async () => {
      const computed = await computePlanHashFromPayload(payload);
      if (message.expectedPlanHash && message.expectedPlanHash !== computed.planHash) {
        return {
          ok: false,
          errorCode: 'PLAN_NOT_APPROVED',
          message: '前后端计划摘要不一致，审批被拒绝'
        };
      }
      const plans = await readApprovedPlans();
      plans[computed.planHash] = {
        planHash: computed.planHash,
        skillId: String(payload.skillId),
        skillVersion: Number(payload.skillVersion || 1),
        targetOrigins: computed.targetOrigins,
        writeMode: String(payload.writeMode || 'commit'),
        riskLevel: computed.riskLevel,
        batchRowCount: computed.batchRowCount,
        approvedAt: Date.now()
      };
      await writeApprovedPlans(plans);
      return {
        ok: true,
        planHash: computed.planHash,
        riskLevel: computed.riskLevel,
        targetOrigins: computed.targetOrigins
      };
    });
  }

  async function verifyPlan(message) {
    const { planHash, payload } = message || {};
    if (!planHash || !payload) {
      return {
        ok: false,
        errorCode: 'PLAN_NOT_APPROVED',
        message: '未提供有效的已审批计划哈希'
      };
    }
    return enqueueSessionOp(async () => {
      const computed = await computePlanHashFromPayload(payload);
      const plans = await readApprovedPlans();
      const record = plans[planHash];
      if (!record || computed.planHash !== planHash) {
        return {
          ok: false,
          errorCode: 'PLAN_NOT_APPROVED',
          message: '执行计划未审批或审批后参数/站点/步骤发生变更，请重新预览审批',
          computedPlanHash: computed.planHash
        };
      }
      return { ok: true, planHash, record };
    });
  }

  async function revokePlan(message) {
    return enqueueSessionOp(async () => {
      if (!message?.planHash) {
        await writeApprovedPlans({});
        return { ok: true };
      }
      const plans = await readApprovedPlans();
      delete plans[message.planHash];
      await writeApprovedPlans(plans);
      return { ok: true };
    });
  }

  async function checkOriginAccess({ tabId, url, allowedOrigins = [] }) {
    let targetUrl = url || '';
    if (tabId) {
      const liveTab = await chromeApi.tabs.get(tabId).catch(() => null);
      if (liveTab?.url) targetUrl = liveTab.url;
    }
    const origin = safeOriginOf(targetUrl);
    if (!origin) {
      return {
        ok: false,
        errorCode: 'SITE_NOT_ALLOWED',
        message: '当前页面不是受支持的 http/https 业务站点'
      };
    }
    const normalizedWhitelist = (Array.isArray(allowedOrigins) ? allowedOrigins : [])
      .map(safeOriginOf)
      .filter(Boolean);
    if (!normalizedWhitelist.includes(origin)) {
      return {
        ok: false,
        errorCode: 'SITE_NOT_ALLOWED',
        origin,
        message: `站点 ${origin} 不在技能授权白名单 allowedOrigins 内`
      };
    }
    if (!(await permitted(targetUrl))) {
      return {
        ok: false,
        errorCode: 'SITE_NOT_ALLOWED',
        origin,
        message: `站点 ${origin} 尚未获得浏览器主机权限`
      };
    }
    return { ok: true, origin, url: sanitizeUrl(targetUrl) };
  }

  function handleMessage(message, sender, sendResponse) {
    const type = message?.type;
    if (type === 'RECORD_EVENT') {
      handleRecordEvent(message.step, sender)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, reason: String(err) }));
      return true;
    }
    if (type === 'APPROVE_PLAN') {
      approvePlan(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, errorCode: 'PLAN_NOT_APPROVED', message: String(err) }));
      return true;
    }
    if (type === 'VERIFY_PLAN') {
      verifyPlan(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, errorCode: 'PLAN_NOT_APPROVED', message: String(err) }));
      return true;
    }
    if (type === 'REVOKE_PLAN') {
      revokePlan(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, message: String(err) }));
      return true;
    }
    if (type === 'CHECK_ORIGIN_ACCESS') {
      checkOriginAccess(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, errorCode: 'SITE_NOT_ALLOWED', message: String(err) }));
      return true;
    }
    if (type === 'AUTHORIZE_RECORDING_ORIGIN') {
      authorizeRecordingOrigin(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, errorCode: 'SITE_NOT_ALLOWED', message: String(err) }));
      return true;
    }
    return false;
  }

  function attachListeners() {
    chromeApi?.runtime?.onInstalled?.addListener?.(async () => {
      await chromeApi.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
      await chromeApi.storage?.session
        ?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
        .catch?.(() => {});
    });
    chromeApi?.tabs?.onUpdated?.addListener?.((tabId, change, tab) => {
      handleTabUpdated(tabId, change, tab).catch(() => {});
    });
    chromeApi?.runtime?.onMessage?.addListener?.(handleMessage);
  }

  return {
    enqueueStorageWrite,
    permitted,
    inject,
    handleTabUpdated,
    handleRecordEvent,
    authorizeRecordingOrigin,
    approvePlan,
    verifyPlan,
    revokePlan,
    checkOriginAccess,
    handleMessage,
    attachListeners
  };
}

if (
  typeof globalThis.chrome !== 'undefined' &&
  globalThis.chrome?.runtime?.onMessage?.addListener &&
  !globalThis.__SKILLFLOW_NO_AUTO_ATTACH__
) {
  const controller = createBackgroundController(globalThis.chrome);
  controller.attachListeners();
}
