"use strict";

import { distillSnapshot } from '../dom-distiller.js';
import { isSamePageIgnoringQueryAndHash, safeOriginOf, sanitizeUrl } from '../sanitizer.js';
import { extractStructuredRecords } from '../table-extractor.js';

export { isSamePageIgnoringQueryAndHash };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * L1 一期纯 MV3 Content Script 执行驱动。
 */
export class Mv3ContentScriptDriver {
  constructor({
    chromeApi = globalThis.chrome,
    tabId = null,
    allowedOrigins = [],
    readyTimeoutMs = 6000,
    stepDelayMs = 150
  } = {}) {
    this.chrome = chromeApi;
    this.tabId = tabId;
    this.allowedOrigins = Array.isArray(allowedOrigins) ? [...allowedOrigins] : [];
    this.readyTimeoutMs = Number(readyTimeoutMs || 6000);
    this.stepDelayMs = Number(stepDelayMs ?? 150);
  }

  get kind() {
    return 'mv3-content';
  }

  capabilities() {
    return {
      trustedEvents: false,
      crossOriginIframe: false,
      nativeFileUpload: false,
      persistentBackgroundLoop: false
    };
  }

  async waitTabReady(tabId) {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const tab = await this.chrome.tabs.get(tabId);
        if (tab?.status === 'complete') return tab;
      } catch (_) {}
      await sleep(80);
    }
    const err = new Error('页面长时间未加载完成');
    err.errorCode = 'ACTION_FAILED';
    throw err;
  }

  async ensureContentScript(tabId) {
    try {
      const ping = await this.chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (ping?.ok) return ping;
    } catch (_) {}
    await this.chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const pingAfter = await this.chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (!pingAfter?.ok) {
      const err = new Error('Content Script 注入失败');
      err.errorCode = 'ACTION_FAILED';
      throw err;
    }
    return pingAfter;
  }

  async assertOriginAllowed({ tabId = null, url = '', allowedOrigins = this.allowedOrigins } = {}) {
    const res = await this.chrome.runtime.sendMessage({
      type: 'CHECK_ORIGIN_ACCESS',
      tabId,
      url,
      allowedOrigins
    });
    if (!res?.ok) {
      const err = new Error(`${res?.errorCode || 'SITE_NOT_ALLOWED'}: ${res?.message || '站点未授权'}`);
      err.errorCode = res?.errorCode || 'SITE_NOT_ALLOWED';
      throw err;
    }
    return res;
  }

  async resolveTargetTab() {
    if (this.tabId) {
      const tab = await this.chrome.tabs.get(this.tabId).catch(() => null);
      if (tab && /^https?:\/\//.test(tab.url || '')) return tab;
    }
    const tabs = await this.chrome.tabs.query({ active: true, currentWindow: true });
    const active = tabs.find((t) => /^https?:\/\//.test(t.url || ''));
    if (!active) {
      const err = new Error('请先在当前窗口打开一个 http/https 业务网页');
      err.errorCode = 'SITE_NOT_ALLOWED';
      throw err;
    }
    this.tabId = active.id;
    return active;
  }

  async ensureSession(allowedOrigins = null) {
    if (Array.isArray(allowedOrigins) && allowedOrigins.length > 0) {
      this.allowedOrigins = allowedOrigins.map(safeOriginOf).filter(Boolean);
    }
    const tab = await this.resolveTargetTab();
    await this.assertOriginAllowed({ tabId: tab.id, url: tab.url, allowedOrigins: this.allowedOrigins });
    await this.waitTabReady(tab.id);
    await this.ensureContentScript(tab.id);
    return {
      tabId: tab.id,
      currentOrigin: safeOriginOf(tab.url),
      currentUrl: tab.url
    };
  }

  async waitForNavigationComplete(tabId, triggerFn) {
    const onUpdated = this.chrome?.tabs?.onUpdated;
    const canListen =
      typeof onUpdated?.addListener === 'function' &&
      typeof onUpdated?.removeListener === 'function';
    if (!canListen) {
      await triggerFn();
      await this.waitTabReady(tabId);
      return;
    }

    let timer = null;
    let listener = null;
    const waitEvent = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const err = new Error('页面导航或强制刷新超时');
        err.errorCode = 'ACTION_FAILED';
        reject(err);
      }, this.readyTimeoutMs);
      listener = (updatedId, changeInfo) => {
        if (updatedId === tabId && changeInfo?.status === 'complete') {
          resolve();
        }
      };
      onUpdated.addListener(listener);
    });

    try {
      await triggerFn();
      await waitEvent;
    } finally {
      if (timer) clearTimeout(timer);
      if (listener) onUpdated.removeListener(listener);
    }
    await this.waitTabReady(tabId);
  }

  async navigate(url, opts = {}) {
    const origins = Array.isArray(opts.allowedOrigins) ? opts.allowedOrigins : this.allowedOrigins;
    await this.assertOriginAllowed({ url, allowedOrigins: origins });
    if (!this.tabId) {
      await this.resolveTargetTab();
    }
    const current = await this.chrome.tabs.get(this.tabId);
    const isSameExact = sanitizeUrl(current?.url) === sanitizeUrl(url);
    const shouldSkip = opts.forceReload
      ? false
      : opts.ignoreQueryAndHash
        ? isSamePageIgnoringQueryAndHash(current?.url, url)
        : isSameExact;

    if (!shouldSkip) {
      let isHashOnlyChange = false;
      if (!opts.forceReload && !isSameExact && isSamePageIgnoringQueryAndHash(current?.url, url)) {
        try {
          isHashOnlyChange = new URL(current.url).search === new URL(url).search;
        } catch (_) {}
      }

      const trigger = async () => {
        if (opts.forceReload && isSameExact && typeof this.chrome.tabs.reload === 'function') {
          await this.chrome.tabs.reload(this.tabId);
        } else {
          await this.chrome.tabs.update(this.tabId, { url });
        }
      };

      if (isHashOnlyChange) {
        await trigger();
        await this.waitTabReady(this.tabId);
      } else {
        await this.waitForNavigationComplete(this.tabId, trigger);
      }
      if (this.stepDelayMs > 0) await sleep(this.stepDelayMs);
    }
    await this.ensureContentScript(this.tabId);
    const latest = await this.chrome.tabs.get(this.tabId);
    return { finalUrl: latest?.url || url, reloaded: !shouldSkip };
  }

  async distillDom(opts = {}) {
    if (!this.tabId) {
      await this.resolveTargetTab();
    }
    await this.waitTabReady(this.tabId);
    await this.ensureContentScript(this.tabId);
    if (this.allowedOrigins.length > 0) {
      await this.assertOriginAllowed({ tabId: this.tabId, allowedOrigins: this.allowedOrigins });
    }
    const raw = await this.chrome.tabs.sendMessage(this.tabId, {
      type: 'DISTILL_DOM',
      opts
    });
    return distillSnapshot(raw, opts);
  }

  async executeStep(step) {
    if (!step || typeof step !== 'object') {
      return { ok: false, errorCode: 'ACTION_FAILED', message: '无效执行步骤' };
    }
    if (step.action === 'navigate') {
      const navRes = await this.navigate(step.url, {
        allowedOrigins: this.allowedOrigins,
        ignoreQueryAndHash: Boolean(step.preserveQuery)
      });
      return {
        ok: true,
        matchedLocator: 'navigate',
        finalUrl: navRes.finalUrl
      };
    }

    await this.waitTabReady(this.tabId);
    await this.ensureContentScript(this.tabId);
    await this.assertOriginAllowed({ tabId: this.tabId, allowedOrigins: this.allowedOrigins });

    let res;
    try {
      res = await this.chrome.tabs.sendMessage(this.tabId, { type: 'PLAY_STEP', step });
    } catch (err) {
      return {
        ok: false,
        errorCode: 'ACTION_FAILED',
        message: `步骤执行消息失败（可能发生页面跳转）：${err.message}`
      };
    }

    if (res?.ok && this.stepDelayMs > 0) {
      await sleep(this.stepDelayMs);
    }
    return {
      ok: Boolean(res?.ok),
      matchedLocator: res?.matchedLocator || '',
      extractedValue: res?.extractedValue,
      errorCode: res?.errorCode,
      message: res?.error || res?.message || ''
    };
  }

  async checkAuthState(checkpoint = {}) {
    await this.waitTabReady(this.tabId);
    await this.ensureContentScript(this.tabId);
    await this.assertOriginAllowed({ tabId: this.tabId, allowedOrigins: this.allowedOrigins });
    const res = await this.chrome.tabs.sendMessage(this.tabId, {
      type: 'CHECK_AUTH_STATE',
      checkpoint
    });
    return {
      state: res?.state === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'AUTHENTICATED',
      hasCaptcha: Boolean(res?.hasCaptcha),
      canEphemeralFill: Boolean(res?.canEphemeralFill),
      authSelector: res?.authSelector || ''
    };
  }

  async fillEphemeralAuth(checkpoint = {}, credentials = {}) {
    try {
      await this.waitTabReady(this.tabId);
      await this.ensureContentScript(this.tabId);
      await this.assertOriginAllowed({ tabId: this.tabId, allowedOrigins: this.allowedOrigins });
      const res = await this.chrome.tabs.sendMessage(this.tabId, {
        type: 'FILL_EPHEMERAL_AUTH',
        checkpoint,
        credentials
      });
      return res || { ok: false, errorCode: 'AUTH_REQUIRED', downgradeToManual: true };
    } finally {
      if (credentials && typeof credentials === 'object') {
        credentials.username = '';
        credentials.password = '';
      }
    }
  }

  async getResult(selector) {
    await this.waitTabReady(this.tabId);
    await this.ensureContentScript(this.tabId);
    return await this.chrome.tabs.sendMessage(this.tabId, {
      type: 'GET_RESULT',
      selector
    });
  }

  async pickElement(opts = {}) {
    if (!this.tabId) {
      await this.resolveTargetTab();
    }
    await this.waitTabReady(this.tabId);
    await this.ensureContentScript(this.tabId);
    if (this.allowedOrigins.length > 0) {
      await this.assertOriginAllowed({ tabId: this.tabId, allowedOrigins: this.allowedOrigins });
    }
    return await this.chrome.tabs.sendMessage(this.tabId, {
      type: 'START_PICK_ELEMENT',
      opts
    });
  }

  async cancelPickElement() {
    if (!this.tabId) return { ok: true };
    try {
      return await this.chrome.tabs.sendMessage(this.tabId, { type: 'CANCEL_PICK_ELEMENT' });
    } catch (_) {
      return { ok: true };
    }
  }

  async extractRecords(spec, contextRow = {}) {
    await this.waitTabReady(this.tabId);
    await this.ensureContentScript(this.tabId);
    if (this.allowedOrigins.length > 0) {
      await this.assertOriginAllowed({ tabId: this.tabId, allowedOrigins: this.allowedOrigins });
    }
    const raw = await this.chrome.tabs.sendMessage(this.tabId, {
      type: 'EXTRACT_RECORDS',
      spec
    });
    return extractStructuredRecords(raw, spec, contextRow);
  }
}
