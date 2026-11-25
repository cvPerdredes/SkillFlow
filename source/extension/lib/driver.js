"use strict";

import { Mv3ContentScriptDriver } from './drivers/mv3-driver.js';

/**
 * ExecutionDriver 抽象契约：
 * 上层业务（plan-builder / run-controller / batch-runner / result-evaluator）
 * 仅能通过本契约操纵页面，严禁直接调用 chrome.tabs / chrome.scripting，以保证 L1->L2->L3 平滑演进。
 */
export class ExecutionDriver {
  get kind() {
    throw new Error('NotImplemented: kind');
  }

  capabilities() {
    return {
      trustedEvents: false,
      crossOriginIframe: false,
      nativeFileUpload: false,
      persistentBackgroundLoop: false
    };
  }

  async ensureSession(_allowedOrigins) {
    throw new Error('NotImplemented: ensureSession');
  }

  /**
   * 导航至目标 URL。
   * opts: { allowedOrigins?: string[], ignoreQueryAndHash?: boolean, forceReload?: boolean }
   */
  async navigate(_url, _opts = {}) {
    throw new Error('NotImplemented: navigate');
  }

  async distillDom(_opts = {}) {
    throw new Error('NotImplemented: distillDom');
  }

  async executeStep(_step) {
    throw new Error('NotImplemented: executeStep');
  }

  async extractRecords(_spec, _contextRow = null) {
    throw new Error('NotImplemented: extractRecords');
  }

  async checkAuthState(_checkpoint) {
    throw new Error('NotImplemented: checkAuthState');
  }

  async fillEphemeralAuth(_checkpoint, _credentials) {
    throw new Error('NotImplemented: fillEphemeralAuth');
  }

  async getResult(_selector) {
    throw new Error('NotImplemented: getResult');
  }

  async pickElement(_opts = {}) {
    throw new Error('NotImplemented: pickElement');
  }

  async cancelPickElement() {
    throw new Error('NotImplemented: cancelPickElement');
  }
}

/**
 * 驱动工厂：一期唯一实现为 'mv3-content' (L1)；L2/L3 预留接口平滑演进。
 */
export function createDriver(kind = 'mv3-content', deps = {}) {
  if (kind === 'mv3-content') {
    return new Mv3ContentScriptDriver(deps);
  }
  if (kind === 'chrome-debugger' || kind === 'local-companion-cdp') {
    throw new Error(`驱动 "${kind}" 属于二期混合架构演进规划，当前一期交付请使用 "mv3-content"`);
  }
  throw new Error(`未知驱动类型: ${kind}`);
}
