"use strict";
(() => {
  if (globalThis.__skillflowProbeInjected) return;
  globalThis.__skillflowProbeInjected = true;

  let recording = false;
  let activePicker = null;
  const initialValues = new WeakMap();
  const dirtyElements = new WeakSet();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cssEscape = (str) =>
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(String(str))
      : String(str).replace(/([^\w-])/g, '\\$1');
  const clean = (str) => String(str || '').replace(/\s+/g, ' ').trim().slice(0, 140);

  // 注意：以下两条敏感词规则必须与 extension/lib/sanitizer.js 保持严格一致。
  const AUTH_CREDENTIAL_RE =
    /password|passwd|pwd|passcode|one-time-code|otp|captcha|verify[-_.\s]?code|verification|sms[-_.\s]?code|auth[-_.\s]?code|验证码|校验码|动态码|动态验证码|密码|口令|密钥/i;

  const SENSITIVE_PII_RE =
    /token|secret|api[-_.\s]?key|access[-_.\s]?key|credential|cookie|session|id[-_.\s]?card|identity|phone|mobile|telephone|\btel\b|bank[-_.\s]?card|card[-_.\s]?no|\b(?:account|acct)(?:[-_.\s]?(?:no|num|number|id|name))?\b|salary|amount|money|\bcvv\b|\bssn\b|令牌|手机号|手机|联系电话|电话|户号|身份证|证件号|姓名|银行卡|卡号|账号|账户|余额|金额|工资|薪资/i;

  const DYNAMIC_ID_PREFIX_RE =
    /^(?:ext-gen|ember|react-select|mui-|el-id-|ant-|rc-|yui_|gwt-uid|j_id|auto[-_]?id|uid[-_]?)/i;
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}/i;
  const LONG_RANDOM_SUFFIX_RE = /[_-]\d{4,}$/;

  function isDynamicId(id) {
    const val = String(id || '').trim();
    if (!val) return true;
    if (/^\d+$/.test(val)) return true;
    if (DYNAMIC_ID_PREFIX_RE.test(val)) return true;
    if (UUID_RE.test(val)) return true;
    if (LONG_RANDOM_SUFFIX_RE.test(val)) return true;
    return false;
  }

  function extractPureLabelText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return String(node.nodeValue || '');
    if (node.nodeType !== 1) return '';
    const tag = node.localName || String(node.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button') return '';
    if (node.childNodes && node.childNodes.length) {
      let buf = '';
      for (const child of Array.from(node.childNodes)) {
        buf += extractPureLabelText(child) + ' ';
      }
      return clean(buf);
    }
    return clean(node.textContent);
  }

  function resolveAriaLabelledBy(el) {
    const ids = String(el?.getAttribute?.('aria-labelledby') || '').trim();
    if (!ids || typeof document.getElementById !== 'function') return '';
    return clean(
      ids
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
    );
  }

  function resolveContainerLabel(el) {
    if (!el) return '';
    if (el.labels && el.labels.length) {
      const joined = Array.from(el.labels).map((x) => extractPureLabelText(x)).filter(Boolean).join(' / ');
      if (joined) return clean(joined);
    }
    if (el.id && typeof document.querySelector === 'function') {
      try {
        const assoc = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
        const txt = extractPureLabelText(assoc);
        if (txt) return txt;
      } catch (_) {}
    }
    const ancestorLabel = el.closest?.('label');
    if (ancestorLabel) {
      const txt = extractPureLabelText(ancestorLabel);
      if (txt) return txt;
    }

    const tag = el.localName || String(el.tagName || '').toLowerCase();
    const isFormControl =
      tag === 'input' || tag === 'select' || tag === 'textarea' || Boolean(el.isContentEditable);
    if (!isFormControl) return '';

    const cell = el.closest?.('td,th');
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev) {
        const txt = extractPureLabelText(prev);
        if (txt) return txt;
        prev = prev.previousElementSibling;
      }
    }

    const prevEl = el.previousElementSibling;
    if (prevEl) {
      const prevTag = prevEl.localName || String(prevEl.tagName || '').toLowerCase();
      if (['label', 'span', 'dt', 'th', 'strong', 'b', 'p', 'div'].includes(prevTag)) {
        const txt = extractPureLabelText(prevEl);
        if (txt && txt.length <= 40) return txt;
      }
    }

    const group = el.closest?.('.form-group,.field,.form-row,.form-item');
    if (group && typeof group.querySelector === 'function') {
      const lbl = group.querySelector('label,.label,.field-label');
      const txt = extractPureLabelText(lbl);
      if (txt) return txt;
    }
    return '';
  }

  function resolveAnchor(el) {
    if (!el) return '';
    const row = el.closest?.('tr');
    if (row) {
      const cells = Array.from(row.children || []);
      for (const c of cells) {
        if (c.contains?.(el)) continue;
        const txt = extractPureLabelText(c);
        if (txt) return txt;
      }
    }
    const section = el.closest?.('fieldset,section,.card,.panel,form');
    if (section && typeof section.querySelector === 'function') {
      const heading = section.querySelector('legend,h1,h2,h3,h4,.card-title');
      const txt = clean(heading?.textContent);
      if (txt) return txt;
    }
    return '';
  }

  function cssPath(el) {
    if (!el) return '';
    if (el.id && !isDynamicId(el.id)) return '#' + cssEscape(el.id);
    const testId = el.getAttribute?.('data-testid');
    if (testId) return `[data-testid="${cssEscape(testId)}"]`;
    const name = el.getAttribute?.('name');
    const tag = el.localName || String(el.tagName || '').toLowerCase();
    if (name && tag) {
      const s = `${tag}[name="${cssEscape(name)}"]`;
      try {
        if (document.querySelectorAll(s).length === 1) return s;
      } catch (_) {}
    }
    const path = [];
    let node = el;
    for (let count = 0; node && node.nodeType === 1 && count < 6; count++, node = node.parentElement) {
      if (node.id && !isDynamicId(node.id)) {
        path.unshift('#' + cssEscape(node.id));
        break;
      }
      const nTag = node.localName || String(node.tagName || '').toLowerCase();
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children || []).filter(
            (c) => (c.localName || String(c.tagName || '').toLowerCase()) === nTag
          )
        : [];
      const index = siblings.indexOf(node) + 1;
      const forceNth = siblings.length > 1 || nTag === 'tr' || nTag === 'td' || nTag === 'th';
      path.unshift(nTag + (forceNth ? `:nth-of-type(${index})` : ''));
    }
    return path.join(' > ');
  }

  function findAuthContainer(el) {
    if (!el) return null;
    const explicit = el.closest?.('#login-form, [data-auth-form], .login-form, [data-login-form]');
    if (explicit) return explicit;
    const form = el.closest?.('form');
    if (form) {
      if (form.querySelector?.('input[type="password"]')) return form;
      const inputs = Array.from(form.querySelectorAll?.('input') || []);
      if (inputs.some((inp) => AUTH_CREDENTIAL_RE.test(buildDescriptorText(inp, false)))) {
        return form;
      }
    }
    let cur = el.parentElement;
    for (let depth = 0; cur && depth < 3; depth++, cur = cur.parentElement) {
      const hint = `${cur.id || ''} ${cur.className || ''}`;
      if (/login|auth/i.test(hint) && cur.querySelector?.('input[type="password"]')) {
        return cur;
      }
    }
    return null;
  }

  function detectAuthSelectors(container) {
    const authSelector = container
      ? container.id && !isDynamicId(container.id)
        ? '#' + cssEscape(container.id)
        : container.hasAttribute?.('data-auth-form')
          ? '[data-auth-form]'
          : cssPath(container) || '#login-form'
      : '#login-form';
    const hasBadge = typeof document.querySelector === 'function' && Boolean(document.querySelector('#user-badge'));
    const loggedInIndicator = hasBadge ? '#user-badge' : '';
    return { authSelector, loggedInIndicator };
  }

  function buildDescriptorText(el, includeAuthContainer = true) {
    if (!el) return '';
    const ariaLabel = el.getAttribute?.('aria-label') || resolveAriaLabelledBy(el);
    const containerLabel = resolveContainerLabel(el);
    const parts = [
      el.getAttribute?.('type'),
      el.getAttribute?.('name'),
      el.id,
      el.getAttribute?.('autocomplete'),
      ariaLabel,
      el.getAttribute?.('placeholder'),
      containerLabel
    ];
    if (includeAuthContainer) {
      const btnText = el.localName === 'button' ? el.textContent : '';
      if (btnText) parts.push(btnText);
    }
    return parts.filter(Boolean).join(' ');
  }

  function classifyDescriptor(info) {
    if (!info || typeof info !== 'object') return 'normal';
    if (String(info.type || '').toLowerCase() === 'password') return 'auth';
    if (info.inAuthContainer) return 'auth';
    if (/current-password|new-password|one-time-code/i.test(String(info.autocomplete || ''))) {
      return 'auth';
    }
    const combined = [
      info.type,
      info.name,
      info.id,
      info.autocomplete,
      info.ariaLabel,
      info.placeholder,
      info.label,
      info.containerLabel
    ]
      .filter(Boolean)
      .join(' ');
    if (AUTH_CREDENTIAL_RE.test(combined)) return 'auth';
    if (SENSITIVE_PII_RE.test(combined)) return 'sensitive';
    return 'normal';
  }

  function isSensitiveFieldInfo(info) {
    return classifyDescriptor(info) !== 'normal';
  }

  function targetFor(el) {
    const tag = el.localName || String(el.tagName || '').toLowerCase();
    const type = clean(el.getAttribute?.('type') || '');
    const testId = clean(el.getAttribute?.('data-testid') || '');
    const stableId = el.id && !isDynamicId(el.id) ? '#' + cssEscape(el.id) : '';
    const ariaLabel = clean(el.getAttribute?.('aria-label') || resolveAriaLabelledBy(el));
    const containerLabel = resolveContainerLabel(el);
    const placeholder = clean(el.getAttribute?.('placeholder') || '');
    const name = clean(el.getAttribute?.('name') || '');
    const label = clean(ariaLabel || containerLabel || placeholder || name);
    const anchor = resolveAnchor(el);
    const text = clean(
      tag === 'input'
        ? type === 'button' || type === 'submit'
          ? el.value
          : ''
        : el.textContent
    );
    const path = cssPath(el);
    return {
      testId,
      stableId,
      ariaLabel,
      label,
      containerLabel,
      anchor,
      text,
      tag,
      type,
      name,
      placeholder,
      cssPath: path,
      css: path
    };
  }

  function descriptorFromElement(el) {
    const t = targetFor(el);
    return {
      type: t.type,
      name: t.name,
      id: el.id || '',
      autocomplete: el.getAttribute?.('autocomplete') || '',
      ariaLabel: t.ariaLabel,
      placeholder: t.placeholder,
      label: t.label,
      containerLabel: t.containerLabel,
      inAuthContainer: Boolean(findAuthContainer(el))
    };
  }

  function isAuthField(el) {
    return classifyDescriptor(descriptorFromElement(el)) === 'auth';
  }

  function isSensitive(el) {
    return classifyDescriptor(descriptorFromElement(el)) !== 'normal';
  }

  function emit(step) {
    if (!recording || !chrome?.runtime?.id) return;
    chrome.runtime.sendMessage({ type: 'RECORD_EVENT', step }).catch(() => {});
  }

  function emitAuthCheckpoint(el, authBox = null) {
    const box = authBox || findAuthContainer(el);
    const selectors = detectAuthSelectors(box);
    emit({
      action: 'auth_checkpoint',
      origin: globalThis.location?.origin || '',
      authSelector: selectors.authSelector,
      loggedInIndicator: selectors.loggedInIndicator,
      inAuthContainer: true,
      sensitive: true,
      target: targetFor(el)
    });
  }

  function isEditable(el) {
    return Boolean(el && (el.matches?.('input,textarea,select') || el.isContentEditable));
  }

  document.addEventListener(
    'focusin',
    (event) => {
      if (!recording || activePicker || !event.isTrusted) return;
      const el = event.target;
      if (!isEditable(el)) return;
      initialValues.set(el, el.isContentEditable ? el.textContent : el.value ?? '');
    },
    true
  );

  document.addEventListener(
    'click',
    (event) => {
      if (!recording || activePicker || !event.isTrusted) return;
      const el = event.target?.closest?.(
        'button,a,input,select,textarea,[role="button"],[role="link"],[role="tab"],[data-testid]'
      );
      if (!el) return;
      const authBox = findAuthContainer(el);
      if (authBox) {
        emitAuthCheckpoint(el, authBox);
        return;
      }
      if (isSensitive(el)) return;
      if (isEditable(el) && !el.matches?.('input[type="submit"],input[type="button"]')) return;
      emit({ action: 'click', target: targetFor(el) });
    },
    true
  );

  document.addEventListener(
    'input',
    (event) => {
      if (!recording || activePicker || !event.isTrusted) return;
      const el = event.target;
      if (!el) return;
      dirtyElements.add(el);
      const authBox = findAuthContainer(el);
      if (authBox || isAuthField(el)) {
        emitAuthCheckpoint(el, authBox);
        return;
      }
      if (isSensitive(el)) {
        emit({ action: 'manual', target: targetFor(el), sensitive: true });
        return;
      }
      if (!el.matches?.('input[type="date"],input[type="month"],input[type="time"],input[type="number"]')) {
        return;
      }
      emit({ action: 'fill', target: targetFor(el), value: el.value });
    },
    true
  );

  document.addEventListener(
    'change',
    (event) => {
      if (!recording || activePicker || !event.isTrusted) return;
      const el = event.target;
      if (!isEditable(el)) return;
      dirtyElements.add(el);
      const target = targetFor(el);
      const authBox = findAuthContainer(el);
      if (authBox || isAuthField(el)) {
        emitAuthCheckpoint(el, authBox);
        return;
      }
      if (isSensitive(el) || el.matches?.('input[type="file"]')) {
        emit({ action: 'manual', target, sensitive: true });
        return;
      }
      if (el.matches?.('input[type="checkbox"],input[type="radio"]')) {
        emit({ action: 'check', target, checked: el.checked });
      } else if (el.matches?.('select')) {
        emit({ action: 'select', target, value: el.value });
      } else {
        emit({ action: 'fill', target, value: el.isContentEditable ? el.textContent : el.value });
      }
    },
    true
  );

  document.addEventListener(
    'focusout',
    (event) => {
      if (!recording || activePicker || !event.isTrusted) return;
      const el = event.target;
      if (!el?.matches?.('input,textarea,select') || el.matches?.('input[type="file"],input[type="checkbox"],input[type="radio"]')) {
        return;
      }
      const currentVal = el.value ?? '';
      const hadChanged =
        dirtyElements.has(el) || (initialValues.has(el) && initialValues.get(el) !== currentVal);
      if (!hadChanged) return;
      dirtyElements.delete(el);

      const authBox = findAuthContainer(el);
      if (authBox || isAuthField(el)) {
        emitAuthCheckpoint(el, authBox);
        return;
      }
      if (isSensitive(el)) {
        emit({ action: 'manual', target: targetFor(el), sensitive: true });
        return;
      }
      emit({
        action: el.matches?.('select') ? 'select' : 'fill',
        target: targetFor(el),
        value: currentVal
      });
    },
    true
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (!recording || activePicker || !event.isTrusted || event.key !== 'Enter') return;
      const el = event.target;
      if (!isEditable(el)) return;
      const authBox = findAuthContainer(el);
      if (authBox || isAuthField(el)) {
        emitAuthCheckpoint(el, authBox);
        return;
      }
      if (isSensitive(el)) {
        emit({ action: 'manual', target: targetFor(el), sensitive: true });
        return;
      }
      emit({ action: 'keypress', target: targetFor(el), value: 'Enter' });
    },
    true
  );

  function isVisibleAndUsable(el) {
    if (!el || el.isConnected === false) return false;
    if (el.disabled || el.hasAttribute?.('disabled') || el.hasAttribute?.('hidden')) return false;
    if (el.getAttribute?.('aria-hidden') === 'true') return false;
    if (el.closest?.('[hidden],[aria-hidden="true"]')) return false;
    if (el.style?.display === 'none' || el.style?.visibility === 'hidden' || el.style?.opacity === '0') {
      return false;
    }
    if (typeof globalThis.getComputedStyle === 'function') {
      try {
        const style = globalThis.getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
          return false;
        }
      } catch (_) {}
    }
    const hasOffsetParent = el.offsetParent !== null && el.offsetParent !== undefined;
    const hasRects = typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
    return hasOffsetParent || hasRects;
  }

  function resolveUnique(candidates, strategy, anchor = '') {
    const visible = Array.from(new Set(candidates || [])).filter(isVisibleAndUsable);
    if (visible.length === 0) return null;
    if (visible.length === 1) {
      return { ok: true, element: visible[0], matchedLocator: strategy };
    }
    if (anchor) {
      const anchored = visible.filter((el) => resolveAnchor(el) === anchor);
      if (anchored.length === 1) {
        return { ok: true, element: anchored[0], matchedLocator: `${strategy}+anchor` };
      }
    }
    return {
      ok: false,
      errorCode: 'TARGET_AMBIGUOUS',
      matchCount: visible.length,
      strategy,
      message: `元素定位存在歧义（${strategy} 命中 ${visible.length} 个可见元素），已安全中止`
    };
  }

  function queryInteractiveNodes(tagFilter = '') {
    const base = Array.from(
      document.querySelectorAll(
        'input,textarea,select,button,a,[role="button"],[role="link"],[role="tab"],[data-testid]'
      )
    );
    if (!tagFilter) return base;
    const t = String(tagFilter).toLowerCase();
    return base.filter((el) => (el.localName || String(el.tagName || '').toLowerCase()) === t);
  }

  function hasDynamicIdToken(selector) {
    const tokens = String(selector || '').match(/#([a-zA-Z0-9_-]+)/g) || [];
    return tokens.some((tok) => isDynamicId(tok.slice(1)));
  }

  function locateTarget(target) {
    if (!target || typeof target !== 'object') {
      return { ok: false, errorCode: 'ACTION_FAILED', message: '缺少定位目标描述' };
    }
    const anchor = String(target.anchor || '');
    const allowReboundCssFallback = target.rebound === true;
    let deferredAmbiguous = null;

    // 1. testId（最高优先级）
    if (target.testId) {
      try {
        const hits = document.querySelectorAll(`[data-testid="${cssEscape(target.testId)}"]`);
        const res = resolveUnique(hits, 'testId', anchor);
        if (res) return res;
      } catch (_) {}
    }

    // 2. stableId（动态 ID 降权跳过）
    const stableIdRaw = String(target.stableId || '').replace(/^#/, '');
    if (stableIdRaw && !isDynamicId(stableIdRaw)) {
      try {
        const hits = document.querySelectorAll('#' + cssEscape(stableIdRaw));
        const res = resolveUnique(hits, 'stableId', anchor);
        if (res) return res;
      } catch (_) {}
    }

    // 3. ariaLabel / 关联 <label> + tag
    const nodes = queryInteractiveNodes(target.tag || '');
    if (target.ariaLabel) {
      const hits = nodes.filter((el) => targetFor(el).ariaLabel === target.ariaLabel);
      const res = resolveUnique(hits, 'ariaLabel', anchor);
      if (res) {
        if (res.ok || !allowReboundCssFallback) return res;
        deferredAmbiguous = deferredAmbiguous || res;
      }
    }
    if (target.label) {
      const hits = nodes.filter((el) => {
        const info = targetFor(el);
        return info.label === target.label || info.containerLabel === target.label;
      });
      const res = resolveUnique(hits, 'label+tag', anchor);
      if (res) {
        if (res.ok || !allowReboundCssFallback) return res;
        deferredAmbiguous = deferredAmbiguous || res;
      }
    }

    // 4. anchor + text / placeholder
    if (target.text) {
      const hits = nodes.filter((el) => targetFor(el).text === target.text);
      const res = resolveUnique(hits, 'text', anchor);
      if (res) {
        if (res.ok || !allowReboundCssFallback) return res;
        deferredAmbiguous = deferredAmbiguous || res;
      }
    }
    if (target.placeholder) {
      const hits = nodes.filter((el) => el.getAttribute?.('placeholder') === target.placeholder);
      const res = resolveUnique(hits, 'placeholder', anchor);
      if (res) {
        if (res.ok || !allowReboundCssFallback) return res;
        deferredAmbiguous = deferredAmbiguous || res;
      }
    }

    // 5. cssPath / css 回退（动态 ID 片段忽略，仅当可见唯一时命中）
    const selector = target.cssPath || target.css || '';
    if (selector && !hasDynamicIdToken(selector)) {
      try {
        const hits = document.querySelectorAll(selector);
        const strategy = deferredAmbiguous ? 'cssPath-rebound' : 'cssPath';
        const res = resolveUnique(hits, strategy, anchor);
        if (res) return res;
      } catch (_) {}
    }

    if (deferredAmbiguous) {
      return deferredAmbiguous;
    }

    return {
      ok: false,
      errorCode: 'ACTION_FAILED',
      message: `无法定位元素: ${target.label || target.text || target.cssPath || target.css || 'unknown'}`
    };
  }

  async function waitFor(target, timeout = 6000) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    do {
      const res = locateTarget(target);
      if (res.ok) return res;
      if (res.errorCode === 'TARGET_AMBIGUOUS') {
        const err = new Error(res.message);
        err.errorCode = 'TARGET_AMBIGUOUS';
        throw err;
      }
      lastError = res;
      await sleep(100);
    } while (Date.now() < deadline);

    const err = new Error(
      lastError?.message || `无法定位元素: ${target?.label || target?.text || target?.css || 'unknown'}`
    );
    err.errorCode = lastError?.errorCode || 'ACTION_FAILED';
    throw err;
  }

  function setInputValue(el, valueStr) {
    if (el.isContentEditable) {
      el.textContent = valueStr;
    } else if (typeof HTMLInputElement !== 'undefined') {
      const ctor =
        typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement
          : typeof HTMLSelectElement !== 'undefined' && el instanceof HTMLSelectElement
            ? HTMLSelectElement
            : HTMLInputElement;
      const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, 'value');
      if (descriptor?.set) descriptor.set.call(el, valueStr);
      else el.value = valueStr;
    } else {
      el.value = valueStr;
    }
    el.dispatchEvent?.(new Event('input', { bubbles: true }));
    el.dispatchEvent?.(new Event('change', { bubbles: true }));
  }

  function distillDomInPage(opts = {}) {
    const maxNodes = Math.min(Math.max(Number(opts?.maxNodes || 80), 1), 150);
    const html =
      document.documentElement?.outerHTML || document.body?.innerHTML || '';
    const rawBytes =
      typeof TextEncoder !== 'undefined'
        ? new TextEncoder().encode(String(html)).length
        : String(html).length * 2;

    const scopeRoot = opts?.focusSelector
      ? document.querySelector?.(opts.focusSelector) || document.body
      : document.body;

    const rawInteractive = scopeRoot?.querySelectorAll
      ? Array.from(
          scopeRoot.querySelectorAll(
            'input,textarea,select,button,a,[role="button"],[role="link"],[role="tab"],[data-testid]'
          )
        )
      : queryInteractiveNodes('');

    const visibleInteractive = rawInteractive.filter(isVisibleAndUsable).slice(0, maxNodes);
    const nodes = visibleInteractive.map((el, idx) => {
      const t = targetFor(el);
      return {
        idx: idx + 1,
        tag: t.tag,
        type: t.type,
        testId: t.testId,
        stableId: t.stableId,
        label: t.label,
        ariaLabel: t.ariaLabel,
        text: t.text,
        placeholder: t.placeholder,
        anchor: t.anchor,
        name: t.name,
        cssPath: t.cssPath,
        sensitive: isSensitive(el),
        auth: isAuthField(el)
      };
    });

    const headings = Array.from(document.querySelectorAll?.('h1,h2,h3') || [])
      .filter(isVisibleAndUsable)
      .map((h) => clean(h.textContent))
      .filter(Boolean)
      .slice(0, 8);

    const selectOptionsSample = {};
    for (const sel of Array.from(document.querySelectorAll?.('select') || [])) {
      if (!isVisibleAndUsable(sel)) continue;
      const t = targetFor(sel);
      const key = t.label || t.stableId || t.name || t.cssPath || 'select';
      selectOptionsSample[key] = Array.from(sel.options || sel.children || [])
        .map((opt) => clean(opt.textContent || opt.value))
        .filter(Boolean)
        .slice(0, 8);
    }

    const tables = Array.from(document.querySelectorAll?.('table') || [])
      .filter(isVisibleAndUsable)
      .slice(0, 6)
      .map((tbl) => ({
        selector: cssPath(tbl),
        headers: Array.from(tbl.querySelectorAll?.('thead th, tr:first-child th') || [])
          .map((th) => clean(th.textContent))
          .filter(Boolean),
        rowCount: Array.from(tbl.querySelectorAll?.('tbody tr') || []).length
      }));

    const statusContainers = Array.from(
      document.querySelectorAll?.('[data-status], #receipt-box, #result-summary, #result') || []
    )
      .filter(isVisibleAndUsable)
      .slice(0, 6)
      .map((el) => ({
        selector: cssPath(el),
        dataStatus: clean(el.getAttribute?.('data-status') || ''),
        text: clean(el.textContent).slice(0, 80)
      }));

    return {
      ok: true,
      rawBytes,
      nodes,
      pageContext: {
        title: clean(document.title || ''),
        headings,
        selectOptionsSample
      },
      tables,
      statusContainers
    };
  }

  function findVisibleAuthContainer(checkpoint = {}) {
    const selectors = [];
    if (checkpoint?.authSelector) selectors.push(checkpoint.authSelector);
    selectors.push('#login-form', '[data-auth-form]', '.login-form');
    for (const sel of selectors) {
      try {
        const el = document.querySelector?.(sel);
        if (el && isVisibleAndUsable(el)) return el;
      } catch (_) {}
    }
    const visiblePwd = Array.from(document.querySelectorAll?.('input[type="password"]') || []).find(
      isVisibleAndUsable
    );
    if (visiblePwd) return findAuthContainer(visiblePwd) || visiblePwd.parentElement || visiblePwd;
    return null;
  }

  function checkAuthStateInPage(checkpoint = {}) {
    const container = findVisibleAuthContainer(checkpoint);
    const hasVisiblePasswordInput = Boolean(
      Array.from(
        (container || document).querySelectorAll?.('input[type="password"]') || []
      ).find(isVisibleAndUsable)
    );

    const captchaCandidate = Array.from(
      (container || document).querySelectorAll?.('input') || []
    ).find((inp) => {
      if (!isVisibleAndUsable(inp)) return false;
      const desc = buildDescriptorText(inp, false);
      return /captcha|verify[-_.\s]?code|otp|sms[-_]?code|u-?key|验证码|校验码|动态码/i.test(desc);
    });
    const hasCaptcha = Boolean(captchaCandidate);

    if (container || hasVisiblePasswordInput) {
      return {
        ok: true,
        state: 'AUTH_REQUIRED',
        hasCaptcha,
        canEphemeralFill: Boolean(hasVisiblePasswordInput && !hasCaptcha),
        authSelector: container ? cssPath(container) || checkpoint?.authSelector || '' : ''
      };
    }

    const indicatorSel = String(checkpoint?.loggedInIndicator || '').trim();
    if (indicatorSel) {
      try {
        const badge = document.querySelector?.(indicatorSel);
        if (badge && isVisibleAndUsable(badge)) {
          const cls = String(badge.className || '');
          const txt = clean(badge.textContent);
          if (/\blogged-out\b/i.test(cls) || /未登录|会话已过期|已过期|请登录/.test(txt)) {
            return {
              ok: true,
              state: 'AUTH_REQUIRED',
              hasCaptcha: false,
              canEphemeralFill: false,
              authSelector: checkpoint?.authSelector || ''
            };
          }
        }
      } catch (_) {}
    }

    return {
      ok: true,
      state: 'AUTHENTICATED',
      hasCaptcha: false,
      canEphemeralFill: false,
      authSelector: ''
    };
  }

  function fillEphemeralAuthInPage(checkpoint = {}, credentials = {}) {
    try {
      const stateInfo = checkAuthStateInPage(checkpoint);
      if (stateInfo.state === 'AUTHENTICATED') {
        return { ok: true, alreadyAuthenticated: true };
      }
      if (stateInfo.hasCaptcha) {
        return {
          ok: false,
          errorCode: 'AUTH_CAPTCHA_DETECTED',
          downgradeToManual: true,
          message: '检测到图形/短信验证码或 U-Key，已自动降级为人工接管登录'
        };
      }

      const container = findVisibleAuthContainer(checkpoint) || document.body;
      const inputs = Array.from(container.querySelectorAll?.('input') || []).filter(isVisibleAndUsable);
      const pwdInput = inputs.find(
        (el) => String(el.getAttribute?.('type') || '').toLowerCase() === 'password'
      );
      if (!pwdInput) {
        return {
          ok: false,
          errorCode: 'AUTH_REQUIRED',
          downgradeToManual: true,
          message: '未找到可见密码输入框，已降级为人工接管登录'
        };
      }

      const userInput = inputs.find((el) => {
        if (el === pwdInput) return false;
        const t = String(el.getAttribute?.('type') || 'text').toLowerCase();
        return ['text', 'email', 'tel', ''].includes(t);
      });

      if (userInput && credentials?.username) {
        setInputValue(userInput, String(credentials.username));
      }
      if (credentials?.password !== undefined) {
        setInputValue(pwdInput, String(credentials.password));
      }

      const submitBtn = Array.from(
        container.querySelectorAll?.('button[type="submit"], input[type="submit"], button') || []
      ).find(isVisibleAndUsable);

      if (submitBtn) {
        submitBtn.click();
      } else if (typeof container.requestSubmit === 'function') {
        container.requestSubmit();
      } else {
        pwdInput.dispatchEvent?.(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
        );
      }

      return { ok: true, submitted: true };
    } finally {
      if (credentials && typeof credentials === 'object') {
        credentials.username = '';
        credentials.password = '';
      }
    }
  }

  function extractRecordsInPage(spec = {}) {
    const mode = spec?.mode === 'receipt' ? 'receipt' : 'table';

    if (mode === 'receipt') {
      const boxSel = spec?.containerSelector || '#receipt-box';
      let box = null;
      try {
        box = document.querySelector?.(boxSel);
      } catch (_) {}
      const statusEl = spec?.statusSelector
        ? document.querySelector?.(spec.statusSelector)
        : box?.querySelector?.('#receipt-status') || document.querySelector?.('#receipt-status');
      const errorEl = spec?.errorSelector
        ? document.querySelector?.(spec.errorSelector)
        : box?.querySelector?.('#receipt-error') || document.querySelector?.('#receipt-error');

      const extractedFields = {};
      for (const f of Array.isArray(spec?.fields) ? spec.fields : []) {
        if (f?.key && f?.selector) {
          try {
            const el = document.querySelector?.(f.selector);
            extractedFields[f.key] = clean(el?.textContent || '');
          } catch (_) {
            extractedFields[f.key] = '';
          }
        }
      }
      if (!('receiptNo' in extractedFields)) {
        const noEl = document.querySelector?.('#receipt-no');
        if (noEl) extractedFields.receiptNo = clean(noEl.textContent || '');
      }

      const statusAttr = clean(
        statusEl?.getAttribute?.('data-status') || box?.getAttribute?.('data-status') || ''
      );
      const statusText = clean(statusEl?.textContent || '');
      const errorText = clean(errorEl?.textContent || '');
      const boxText = clean(box?.textContent || '');

      return {
        ok: true,
        found: Boolean(box || statusEl),
        mode: 'receipt',
        statusAttr,
        statusText,
        errorText,
        boxText,
        extractedFields
      };
    }

    const tableSel = spec?.containerSelector || '#result-table';
    let tableEl = null;
    try {
      tableEl = document.querySelector?.(tableSel);
    } catch (_) {}
    if (!tableEl) {
      return { ok: true, found: false, mode: 'table', headers: [], rawRows: [], rowCount: 0 };
    }

    const headers = Array.from(
      tableEl.querySelectorAll?.('thead th, tr:first-child th') || []
    ).map((th) => clean(th.textContent || ''));

    const bodyRows = Array.from(tableEl.querySelectorAll?.('tbody tr') || []);
    const rawRows = [];
    for (const tr of bodyRows) {
      const cells = Array.from(tr.children || []).filter(
        (c) => ['td', 'th'].includes(c.localName || String(c.tagName || '').toLowerCase())
      );
      if (!cells.length) continue;
      if (cells.length === 1 && Number(cells[0].getAttribute?.('colspan') || 1) > 1) {
        continue;
      }
      const rowValues = cells.map((td) => clean(td.textContent || ''));
      if (rowValues.every((v) => !v)) continue;
      rawRows.push(rowValues);
    }

    return {
      ok: true,
      found: true,
      mode: 'table',
      headers,
      rawRows,
      rowCount: rawRows.length
    };
  }

  async function play(step) {
    if (step.action === 'auth_checkpoint') {
      const err = new Error('检测到登录认证检查点：请人工完成登录后再继续执行');
      err.errorCode = 'AUTH_REQUIRED';
      throw err;
    }
    if (step.action === 'manual') {
      const err = new Error('发现敏感字段或文件输入：请人工完成，插件不会保存或回放敏感值');
      err.errorCode = 'MANUAL_REQUIRED';
      throw err;
    }
    const { element: el, matchedLocator } = await waitFor(step.target);
    el.scrollIntoView?.({ block: 'center', inline: 'nearest' });

    if (step.action === 'extract') {
      const tag = el.localName || String(el.tagName || '').toLowerCase();
      const extractedValue = clean(
        tag === 'input' || tag === 'textarea' || tag === 'select' ? el.value : el.textContent
      );
      return {
        ok: true,
        action: 'extract',
        extractedValue,
        matched: cssPath(el),
        matchedLocator
      };
    }

    if (step.action === 'click') {
      el.click();
    } else if (step.action === 'fill' || step.action === 'select') {
      setInputValue(el, String(step.value ?? ''));
    } else if (step.action === 'check') {
      if (Boolean(el.checked) !== Boolean(step.checked)) el.click();
    } else if (step.action === 'keypress') {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    } else {
      const err = new Error('不支持的动作: ' + step.action);
      err.errorCode = 'ACTION_FAILED';
      throw err;
    }
    return {
      ok: true,
      action: step.action,
      matched: cssPath(el),
      matchedLocator
    };
  }

  function cancelElementPicker(reason = 'cancelled') {
    if (!activePicker) return { ok: true, cancelled: true };
    const picker = activePicker;
    activePicker = null;
    picker.cleanup();
    const res = {
      ok: false,
      cancelled: true,
      errorCode: 'USER_CANCELLED',
      message: reason === 'superseded' ? '已启动新的元素选点' : '用户取消元素重绑选点'
    };
    picker.finish(res);
    return res;
  }

  function startElementPicker(opts = {}, respond = null) {
    if (activePicker) {
      cancelElementPicker('superseded');
    }

    return new Promise((resolve) => {
      const isExtractMode = opts?.mode === 'extract';
      let highlighted = null;
      let prevOutline = '';
      let prevOffset = '';
      let done = false;

      let banner = null;
      if (typeof document.createElement === 'function' && document.body?.append) {
        banner = document.createElement('div');
        banner.id = 'skillflow-picker-banner';
        banner.textContent =
          opts?.prompt ||
          (isExtractMode
            ? 'SkillFlow 提取字段：请点击页面目标数据节点（按 Esc 取消）'
            : 'SkillFlow 重绑：请点击目标页面元素（按 Esc 取消）');
        if (banner.style) {
          banner.style.position = 'fixed';
          banner.style.top = '12px';
          banner.style.right = '12px';
          banner.style.zIndex = '2147483647';
          banner.style.background = isExtractMode ? '#0b5f6f' : '#162a55';
          banner.style.color = '#ffffff';
          banner.style.padding = '8px 12px';
          banner.style.borderRadius = '8px';
          banner.style.fontSize = '12px';
          banner.style.boxShadow = '0 4px 16px rgba(0,0,0,0.22)';
          banner.style.pointerEvents = 'none';
        }
        document.body.append(banner);
      }

      function restoreHighlight() {
        if (highlighted && highlighted.style) {
          highlighted.style.outline = prevOutline;
          highlighted.style.outlineOffset = prevOffset;
        }
        highlighted = null;
        prevOutline = '';
        prevOffset = '';
      }

      const pickCandidate = (raw) => {
        const node = raw?.nodeType === 3 ? raw.parentElement : raw;
        if (isExtractMode) return node;
        return (
          node?.closest?.(
            'button,a,input,select,textarea,[role="button"],[role="link"],[role="tab"],[data-testid]'
          ) || node
        );
      };

      const onMouseOver = (event) => {
        if (!activePicker) return;
        const target = pickCandidate(event.target);
        if (!target || target === document.body || (banner && banner.contains?.(target))) return;
        if (highlighted === target) return;
        restoreHighlight();
        highlighted = target;
        if (target.style) {
          prevOutline = target.style.outline || '';
          prevOffset = target.style.outlineOffset || '';
          target.style.outline = isExtractMode ? '2px solid #0b7285' : '2px solid #e03131';
          target.style.outlineOffset = '2px';
        }
      };

      const onKeyDown = (event) => {
        if (!activePicker) return;
        if (event.key === 'Escape') {
          event.preventDefault?.();
          event.stopPropagation?.();
          cancelElementPicker('cancelled');
        }
      };

      const onClick = (event) => {
        if (!activePicker) return;
        const raw = pickCandidate(event.target);
        if (!raw || (banner && banner.contains?.(raw))) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        restoreHighlight();
        const picker = activePicker;
        activePicker = null;
        picker.cleanup();
        picker.finish({
          ok: true,
          target: targetFor(raw),
          matched: cssPath(raw)
        });
      };

      function cleanup() {
        restoreHighlight();
        document.removeEventListener?.('mouseover', onMouseOver, true);
        document.removeEventListener?.('keydown', onKeyDown, true);
        document.removeEventListener?.('click', onClick, true);
        if (banner) {
          if (typeof banner.remove === 'function') banner.remove();
          else if (Array.isArray(banner.parentElement?.children)) {
            const idx = banner.parentElement.children.indexOf(banner);
            if (idx >= 0) banner.parentElement.children.splice(idx, 1);
          }
          banner = null;
        }
      }

      function finish(result) {
        if (done) return;
        done = true;
        try {
          if (typeof respond === 'function') respond(result);
        } finally {
          resolve(result);
        }
      }

      activePicker = { cleanup, finish };
      document.addEventListener?.('mouseover', onMouseOver, true);
      document.addEventListener?.('keydown', onKeyDown, true);
      document.addEventListener?.('click', onClick, true);
    });
  }

  chrome?.runtime?.onMessage?.addListener?.((msg, _sender, respond) => {
    if (msg?.type === 'SET_RECORDING') {
      recording = Boolean(msg.enabled);
      respond({ ok: true });
      return false;
    }
    if (msg?.type === 'PING') {
      respond({ ok: true, url: globalThis.location?.href || '' });
      return false;
    }
    if (msg?.type === 'DISTILL_DOM') {
      respond(distillDomInPage(msg.opts || {}));
      return false;
    }
    if (msg?.type === 'CHECK_AUTH_STATE') {
      respond(checkAuthStateInPage(msg.checkpoint || {}));
      return false;
    }
    if (msg?.type === 'FILL_EPHEMERAL_AUTH') {
      respond(fillEphemeralAuthInPage(msg.checkpoint || {}, msg.credentials || {}));
      return false;
    }
    if (msg?.type === 'EXTRACT_RECORDS') {
      respond(extractRecordsInPage(msg.spec || {}));
      return false;
    }
    if (msg?.type === 'START_PICK_ELEMENT') {
      startElementPicker(msg.opts || {}, respond);
      return true;
    }
    if (msg?.type === 'CANCEL_PICK_ELEMENT') {
      cancelElementPicker('cancelled');
      respond({ ok: true, cancelled: true });
      return false;
    }
    if (msg?.type === 'GET_RESULT') {
      const selector = String(msg.selector || '').trim();
      if (!selector) {
        respond({ ok: true, text: '未配置结果检查选择器', found: false });
        return false;
      }
      let el;
      try {
        el = document.querySelector(selector);
      } catch (_) {
        respond({ ok: false, errorCode: 'ACTION_FAILED', error: '无效的结果选择器' });
        return false;
      }
      respond({
        ok: true,
        found: Boolean(el),
        text: clean(el?.textContent),
        status: el?.getAttribute?.('data-status') || ''
      });
      return false;
    }
    if (msg?.type === 'PLAY_STEP') {
      play(msg.step)
        .then(respond)
        .catch((error) =>
          respond({
            ok: false,
            errorCode: error.errorCode || 'ACTION_FAILED',
            error: error.message
          })
        );
      return true;
    }
    return false;
  });

  globalThis.__skillflowTestHooks = Object.freeze({
    isDynamicId,
    resolveContainerLabel,
    resolveAnchor,
    findAuthContainer,
    targetFor,
    classifyDescriptor,
    isSensitiveFieldInfo,
    isAuthField,
    isSensitive,
    isVisibleAndUsable,
    locateTarget,
    distillDomInPage,
    checkAuthStateInPage,
    fillEphemeralAuthInPage,
    extractRecordsInPage,
    startElementPicker,
    cancelElementPicker
  });
})();
