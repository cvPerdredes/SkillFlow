import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  classifyFieldInfo,
  isAuthCredentialInfo,
  isSensitiveFieldInfo,
  redactObject,
  sanitizeUrl
} from '../extension/lib/sanitizer.js';
import {
  buildPlanSnapshot,
  canonicalJson,
  computePlanHashFromPayload,
  isRiskStep
} from '../extension/lib/plan-builder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.resolve(__dirname, '..');
const EXT_DIR = path.join(SOURCE_DIR, 'extension');

// ---------------------------------------------------------------------------
// 轻量零依赖 DOM 夹具（用于在 Node 中加载与实测 classic content.js）
// ---------------------------------------------------------------------------
function createMiniDom() {
  const listeners = new Map();

  class MockNode {
    constructor(tagName, attrs = {}, textContent = '') {
      this.nodeType = 1;
      this.localName = tagName.toLowerCase();
      this.tagName = tagName.toUpperCase();
      this.attrs = new Map(Object.entries(attrs));
      this.children = [];
      this.parentElement = null;
      this.style = {};
      this.isConnected = true;
      this.disabled = Boolean(attrs.disabled);
      this.checked = Boolean(attrs.checked);
      this.value = attrs.value || '';
      this._text = textContent;
      this._visible = attrs._visible !== false;
      this._listeners = new Map();
    }
    get id() {
      return this.attrs.get('id') || '';
    }
    set id(v) {
      this.attrs.set('id', String(v));
    }
    get className() {
      return this.attrs.get('class') || '';
    }
    set className(v) {
      this.attrs.set('class', String(v));
    }
    get childNodes() {
      if (this.children.length) return this.children;
      if (this._text) return [{ nodeType: 3, nodeValue: this._text }];
      return [];
    }
    get textContent() {
      if (!this.children.length) return this._text;
      return this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this._text = String(v ?? '');
    }
    get offsetParent() {
      return this._visible ? { tagName: 'BODY' } : null;
    }
    getClientRects() {
      return this._visible ? [{ width: 100, height: 30 }] : [];
    }
    get previousElementSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx > 0 ? this.parentElement.children[idx - 1] : null;
    }
    get labels() {
      const list = [];
      if (this.id) {
        for (const el of allNodes()) {
          if (el.localName === 'label' && el.getAttribute('for') === this.id) list.push(el);
        }
      }
      const anc = this.closest('label');
      if (anc && !list.includes(anc)) list.push(anc);
      return list;
    }
    append(...nodes) {
      for (const n of nodes) {
        n.parentElement = this;
        this.children.push(n);
      }
      return this;
    }
    getAttribute(k) {
      return this.attrs.has(k) ? this.attrs.get(k) : null;
    }
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
    }
    hasAttribute(k) {
      return this.attrs.has(k);
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    matches(selector) {
      return selector
        .split(',')
        .map((s) => s.trim())
        .some((part) => matchSimpleSelector(this, part));
    }
    closest(selector) {
      let cur = this;
      while (cur) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (child.matches(selector)) out.push(child);
          visit(child);
        }
      };
      visit(this);
      return out;
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    dispatchEvent() {}
    scrollIntoView() {}
    click() {}
  }

  function matchSimpleSelector(el, sel) {
    if (!sel) return false;
    if (sel.startsWith('#')) {
      return el.id === sel.slice(1).replace(/\\/g, '');
    }
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return el.className.split(/\s+/).includes(cls);
    }
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const eqIdx = sel.indexOf('=');
      if (eqIdx < 0) return el.hasAttribute(sel.slice(1, -1));
      const attr = sel.slice(1, eqIdx);
      const val = sel.slice(eqIdx + 1, -1).replace(/^"|"$/g, '').replace(/\\/g, '');
      return el.getAttribute(attr) === val;
    }
    // 支持 tag[attr="val"] 以及 tag[attr]
    const attrMatch = sel.match(/^([a-z0-9*]+)?\[([a-z0-9_-]+)(?:="([^"]*)")?\]$/i);
    if (attrMatch) {
      const [, tag, attr, val] = attrMatch;
      if (tag && tag !== '*' && el.localName !== tag.toLowerCase()) return false;
      if (val === undefined) return el.hasAttribute(attr);
      return (el.getAttribute(attr) || '') === val;
    }
    return el.localName === sel.toLowerCase();
  }

  const body = new MockNode('body');
  function allNodes() {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(body);
    return out;
  }

  const emitted = [];
  let messageHandler = null;

  const doc = {
    body,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    querySelector(sel) {
      return body.querySelector(sel);
    },
    querySelectorAll(sel) {
      return body.querySelectorAll(sel);
    },
    getElementById(id) {
      return allNodes().find((n) => n.id === id) || null;
    },
    createElement(tag, attrs, text) {
      return new MockNode(tag, attrs, text);
    }
  };

  function dispatch(type, target, extra = {}) {
    const fns = listeners.get(type) || [];
    const evt = { type, target, isTrusted: true, ...extra };
    for (const fn of fns) fn(evt);
  }

  const sandbox = {
    document: doc,
    location: { origin: 'http://127.0.0.1:18761', href: 'http://127.0.0.1:18761/sys_a_query.html' },
    chrome: {
      runtime: {
        id: 'test-ext',
        sendMessage: async (msg) => {
          emitted.push(msg);
          return { ok: true };
        },
        onMessage: {
          addListener: (fn) => {
            messageHandler = fn;
          }
        }
      }
    },
    getComputedStyle: (el) => el.style || {},
    CSS: { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') },
    WeakMap,
    WeakSet,
    Set,
    Array,
    Object,
    String,
    Boolean,
    Number,
    Date,
    Error,
    Promise,
    setTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8'), sandbox);

  return {
    doc,
    body,
    emitted,
    dispatch,
    hooks: sandbox.__skillflowTestHooks,
    setRecording: (enabled) =>
      new Promise((resolve) => messageHandler({ type: 'SET_RECORDING', enabled }, {}, resolve))
  };
}

// ---------------------------------------------------------------------------
// 1. sanitizer.js URL 清洗与深度脱敏测试
// ---------------------------------------------------------------------------
{
  assert.equal(
    sanitizeUrl('https://user:pass@grid.local:8443/app?token=abc&menuId=M101&month=2026-11#/page?ticket=xyz&tab=list'),
    'https://grid.local:8443/app?menuId=M101&month=2026-11#/page?tab=list'
  );
  assert.equal(
    sanitizeUrl('http://127.0.0.1:18761/sys_a_query.html?layout=v2#/marketing/query'),
    'http://127.0.0.1:18761/sys_a_query.html?layout=v2#/marketing/query'
  );
  assert.equal(sanitizeUrl('http://127.0.0.1:18761/#access_token=eyJhbGciOiJIUzI1NiJ9.payload'), 'http://127.0.0.1:18761/');
  assert.equal(sanitizeUrl('javascript:alert(1)'), '');

  const redacted = redactObject({
    apiKey: 'sk-test-123',
    steps: [
      { action: 'auth_checkpoint', sensitive: true, value: 'MUST_BE_GONE' },
      { action: 'fill', value: '杭州供电所', url: 'http://127.0.0.1:18761/?token=bad&menuId=M1' }
    ]
  });
  const dump = JSON.stringify(redacted);
  assert.equal(dump.includes('sk-test-123'), false);
  assert.equal(dump.includes('MUST_BE_GONE'), false);
  assert.equal(dump.includes('token=bad'), false);
  assert.equal(redacted.steps[1].value, '杭州供电所');
  console.log('PASS: sanitizer.js sanitizeUrl and redactObject');
}

// ---------------------------------------------------------------------------
// 2. 修正 2：sanitizer.js 与 content.js 敏感词判定 100% 双端一致性断言
// ---------------------------------------------------------------------------
{
  const dom = createMiniDom();
  const mustIntercept = [
    { label: '密码' },
    { label: '登录密码' },
    { label: '口令' },
    { label: '验证码' },
    { label: '动态验证码' },
    { label: 'OTP' },
    { label: '手机号' },
    { label: '联系电话' },
    { label: '户号' },
    { label: '用电户号' },
    { label: '身份证' },
    { label: '身份证号' },
    { label: '姓名' },
    { label: '真实姓名' },
    { label: '银行卡' },
    { label: '银行卡号' },
    { label: '员工账号' },
    { label: '支付金额' },
    { name: 'password', type: 'password' },
    { name: 'otp' },
    { name: 'captcha' },
    { name: 'token' },
    { name: 'phone' },
    { name: 'id_card' },
    { name: 'bank_card' }
  ];

  const mustAllow = [
    { label: '查询单位', name: 'unit', id: 'unit' },
    { label: '查询月份', name: 'month', id: 'month', type: 'month' },
    { label: '供电单位', name: 'orgName', id: 'orgName' },
    { label: '关联客户批号', name: 'batchCode', id: 'batchCode' },
    { label: '表计编号', name: 'meterNo', id: 'meterNo' },
    { label: '申报电量', name: 'kwh', id: 'kwh', type: 'number' },
    { label: '电压等级', name: 'voltage', id: 'voltage' },
    { label: '备注', name: 'remark', id: 'remark' }
  ];

  for (const sample of mustIntercept) {
    assert.equal(isSensitiveFieldInfo(sample), true, `sanitizer 必须拦截: ${JSON.stringify(sample)}`);
    assert.equal(
      dom.hooks.isSensitiveFieldInfo(sample),
      true,
      `content.js 必须拦截: ${JSON.stringify(sample)}`
    );
    assert.equal(
      classifyFieldInfo(sample),
      dom.hooks.classifyDescriptor(sample),
      `两端分类必须一致: ${JSON.stringify(sample)}`
    );
  }

  for (const sample of mustAllow) {
    assert.equal(isSensitiveFieldInfo(sample), false, `sanitizer 不得误伤演示字段: ${JSON.stringify(sample)}`);
    assert.equal(
      dom.hooks.isSensitiveFieldInfo(sample),
      false,
      `content.js 不得误伤演示字段: ${JSON.stringify(sample)}`
    );
    assert.equal(
      classifyFieldInfo(sample),
      dom.hooks.classifyDescriptor(sample),
      `两端分类必须一致: ${JSON.stringify(sample)}`
    );
  }

  // 验证真实 DOM <label> 与老旧 <table><td>户号</td><td><input></td></table> 识别
  const lbl = dom.doc.createElement('label', { for: 'legacy-hh' }, '户号');
  const hhInput = dom.doc.createElement('input', { id: 'legacy-hh', name: 'col_a' });
  const tr = dom.doc.createElement('tr');
  const tdLbl = dom.doc.createElement('td', {}, '身份证号');
  const tdVal = dom.doc.createElement('td');
  const sfzInput = dom.doc.createElement('input', { id: 'col_b', name: 'col_b' });
  tdVal.append(sfzInput);
  tr.append(tdLbl, tdVal);
  dom.body.append(lbl, hhInput, tr);

  assert.equal(dom.hooks.isSensitive(hhInput), true, 'label[for] 关联“户号”必须被识别为敏感');
  assert.equal(dom.hooks.isSensitive(sfzInput), true, '表格前序 <td>“身份证号”必须被识别为敏感');
  assert.equal(isAuthCredentialInfo({ label: '口令' }), true);
  console.log('PASS: 100% parity between sanitizer.js and content.js across all positive/negative fields');
}

// ---------------------------------------------------------------------------
// 3. Bug 5 + 修正 3: 登录容器折叠为 auth_checkpoint、v2 轻改版命中、歧义按钮拦截
// ---------------------------------------------------------------------------
{
  const dom = createMiniDom();
  await dom.setRecording(true);

  const loginForm = dom.doc.createElement('form', { id: 'login-form', 'data-auth-form': 'true' });
  const loginUser = dom.doc.createElement('input', { id: 'login-user', name: 'loginUser' });
  const loginPass = dom.doc.createElement('input', { id: 'login-pass', type: 'password' });
  const loginBtn = dom.doc.createElement('button', { id: 'login-submit', type: 'submit' }, '登录系统 A');
  loginForm.append(loginUser, loginPass, loginBtn);

  // 轻改版 v2 场景：ID 变成动态 ext-gen-9101/9103，无 data-testid，仅靠 <label> 和文本命中
  const lblUnit = dom.doc.createElement('label', { for: 'ext-gen-9101' }, '查询单位');
  const unitInput = dom.doc.createElement('input', { id: 'ext-gen-9101', name: 'unit' });
  const queryBtn = dom.doc.createElement('button', { id: 'ext-gen-9103', type: 'button' }, '查询数据');
  // 隐藏的同名按钮应被过滤
  const hiddenDupBtn = dom.doc.createElement('button', { id: 'hidden-btn', type: 'button', _visible: false }, '查询数据');

  dom.body.append(loginForm, lblUnit, unitInput, queryBtn, hiddenDupBtn);

  // 模拟在登录表单内输入账号、密码、按回车及点击登录按钮
  loginUser.value = 'sg_ops01';
  dom.dispatch('change', loginUser);
  loginPass.value = 'SECRET_PW_999';
  dom.dispatch('input', loginPass);
  dom.dispatch('keydown', loginPass, { key: 'Enter' });
  dom.dispatch('click', loginBtn);

  const recordedDump = JSON.stringify(dom.emitted);
  assert.equal(recordedDump.includes('SECRET_PW_999'), false, '绝不允许采集密码原值');
  assert.equal(dom.emitted.length >= 4, true);
  assert.equal(
    dom.emitted.every((m) => m.step?.action === 'auth_checkpoint'),
    true,
    '登录表单内账号/密码/回车/提交按钮必须统一归类为 auth_checkpoint'
  );

  // 动态 ID 判定
  assert.equal(dom.hooks.isDynamicId('ext-gen-9101'), true);
  assert.equal(dom.hooks.isDynamicId('unit'), false);

  // v1 录制的定位符在 v2 改版页面上必须准确命中（且自动忽略隐藏同名按钮）
  const hitUnit = dom.hooks.locateTarget({
    testId: 'unit-input',
    stableId: '#unit',
    label: '查询单位',
    tag: 'input',
    cssPath: '#unit'
  });
  assert.equal(hitUnit.ok, true);
  assert.equal(hitUnit.element, unitInput);
  assert.equal(hitUnit.matchedLocator, 'label+tag');

  const hitBtn = dom.hooks.locateTarget({
    testId: 'query-btn',
    stableId: '#query-btn',
    text: '查询数据',
    tag: 'button',
    cssPath: '#query-btn'
  });
  assert.equal(hitBtn.ok, true);
  assert.equal(hitBtn.element, queryBtn);
  assert.equal(hitBtn.matchedLocator, 'text');

  // 将第二个同名按钮设为可见 -> 必须安全报 TARGET_AMBIGUOUS 拦截
  hiddenDupBtn._visible = true;
  const ambiguous = dom.hooks.locateTarget({
    text: '查询数据',
    tag: 'button'
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.errorCode, 'TARGET_AMBIGUOUS');
  assert.equal(ambiguous.matchCount, 2);
  console.log('PASS: Login container collapse, v2 semantic fallback, visibility filter & TARGET_AMBIGUOUS');
}

// ---------------------------------------------------------------------------
// 4. plan-builder.js 契约测试
// ---------------------------------------------------------------------------
{
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  const skill = {
    id: 'skill-cross',
    version: 1,
    name: '跨系统测试',
    startUrl: 'http://127.0.0.1:18761/sys_a_query.html',
    allowedOrigins: ['http://127.0.0.1:18761', 'http://127.0.0.1:18762'],
    steps: [
      { id: 's1', action: 'fill', origin: 'http://127.0.0.1:18761', paramKey: 'unit', target: { label: '查询单位' } },
      { id: 's2', action: 'click', origin: 'http://127.0.0.1:18762', target: { text: '提交台账' } }
    ]
  };
  const snapA = await buildPlanSnapshot({ skill, args: { unit: '杭州供电所' } });
  const snapB = await buildPlanSnapshot({ skill, args: { unit: '杭州供电所' } });
  assert.equal(snapA.planHash, snapB.planHash);
  assert.equal(snapA.riskLevel, 'write_commit');
  assert.equal(isRiskStep(snapA.steps[1]), true);

  const altered = await computePlanHashFromPayload({
    skillId: skill.id,
    skillVersion: 1,
    targetOrigins: snapA.targetOrigins,
    writeMode: 'commit',
    args: { unit: '宁波供电所' },
    steps: snapA.steps
  });
  assert.notEqual(altered.planHash, snapA.planHash);
  console.log('PASS: plan-builder canonicalJson, deterministic planHash & tamper detection');
}

// ---------------------------------------------------------------------------
// 5. 静态红线门禁扫描（零 Chrome 117+ 语法 / 零 window.confirm / 零 eval）
// ---------------------------------------------------------------------------
{
  function collectJsFiles(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...collectJsFiles(full));
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) results.push(full);
    }
    return results;
  }

  const jsFiles = collectJsFiles(EXT_DIR);
  assert.ok(jsFiles.length >= 19, 'extension 下应包含全部 Phase 0/1/2/3 模块');

  const forbidden = [
    { name: 'Object.groupBy (Chrome 117+)', re: /\bObject\.groupBy\b/ },
    { name: 'Map.groupBy (Chrome 117+)', re: /\bMap\.groupBy\b/ },
    { name: 'window.confirm', re: /\bwindow\.confirm\b/ },
    { name: 'window.alert', re: /\bwindow\.alert\b/ },
    { name: 'eval()', re: /\beval\s*\(/ },
    { name: 'new Function', re: /\bnew\s+Function\b/ },
    { name: 'innerHTML/outerHTML write', re: /\.(innerHTML|outerHTML)\s*\+?=/ },
    { name: 'insertAdjacentHTML', re: /\.insertAdjacentHTML\s*\(/ },
    { name: 'document.write', re: /\bdocument\.write\s*\(/ }
  ];

  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  for (const file of jsFiles) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(EXT_DIR, file).replace(/\\/g, '/');
    for (const rule of forbidden) {
      assert.equal(
        rule.re.test(code),
        false,
        `红线门禁违例: ${path.relative(SOURCE_DIR, file)} 包含禁止语法 ${rule.name}`
      );
    }
    if (rel !== 'content.js') {
      assert.equal(
        /\binnerHTML\b/.test(code),
        false,
        `零 innerHTML 门禁违例: ${rel} 禁止出现 innerHTML`
      );
    }
  }

  // 严格 ExecutionDriver 解耦门禁：上层模块与 panel.js 不得直接调 tabs.update / scripting / PLAY_STEP
  for (const rel of [
    'lib/run-controller.js',
    'lib/batch-runner.js',
    'lib/table-extractor.js',
    'lib/result-evaluator.js',
    'lib/result-qa.js',
    'lib/plan-builder.js',
    'lib/skill-analyzer.js',
    'lib/clarification.js',
    'lib/skill-exporter.js',
    'lib/store.js',
    'lib/dom-distiller.js',
    'lib/ai-client.js'
  ]) {
    const code = stripComments(fs.readFileSync(path.join(EXT_DIR, rel), 'utf8'));
    assert.equal(/\bchrome\.(tabs|scripting)\b/.test(code), false, `${rel} 严禁直接调用 chrome.tabs/scripting`);
  }
  for (const rel of ['lib/run-controller.js', 'lib/batch-runner.js']) {
    const code = stripComments(fs.readFileSync(path.join(EXT_DIR, rel), 'utf8'));
    assert.equal(/drivers\//.test(code), false, `${rel} 不得直接引用具体驱动实现目录 drivers/`);
  }
  const batchCode = stripComments(fs.readFileSync(path.join(EXT_DIR, 'lib/batch-runner.js'), 'utf8'));
  assert.equal(/ai-client/.test(batchCode), false, 'batch-runner.js 循环体严禁耦合 AI 客户端');
  const panelCode = stripComments(fs.readFileSync(path.join(EXT_DIR, 'panel.js'), 'utf8'));
  assert.equal(/chrome\.tabs\.update|chrome\.scripting\.executeScript|PLAY_STEP/.test(panelCode), false, 'panel.js 执行与蒸馏必须完全经由 ExecutionDriver');

  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.equal(manifest.permissions.includes('unlimitedStorage'), true);
  assert.equal(manifest.background?.type, 'module');
  console.log('PASS: Static red-line guard scan & manifest.json compliance');
}

// ---------------------------------------------------------------------------
// 6. 仿真业务页与 sample_batch.csv 结构完整性检查
// ---------------------------------------------------------------------------
{
  const csvPath = path.join(SOURCE_DIR, 'demo-site', 'sample_batch.csv');
  const csvLines = fs
    .readFileSync(csvPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(csvLines.length, 13, 'sample_batch.csv 应包含 1 行表头 + 12 行样本数据');
  const dataRows = csvLines.slice(1).map((line) => line.split(','));
  assert.equal(Number(dataRows[0][2]) <= 50000 && dataRows[0][0] !== '未备案所', true, '前 2 条试跑样本必须合法');
  assert.equal(Number(dataRows[1][2]) <= 50000 && dataRows[1][0] !== '未备案所', true, '前 2 条试跑样本必须合法');
  const invalidRows = dataRows.filter(
    (cols) => cols[0] === '未备案所' || Number(cols[2]) <= 0 || Number(cols[2]) > 50000
  );
  assert.equal(invalidRows.length, 2, '12 条样本中应刻意包含 2 条校验失败用例');

  const sysA = fs.readFileSync(path.join(SOURCE_DIR, 'demo-site', 'sys_a_query.html'), 'utf8');
  const sysB = fs.readFileSync(path.join(SOURCE_DIR, 'demo-site', 'sys_b_form.html'), 'utf8');
  for (const html of [sysA, sysB]) {
    assert.equal(/\bwindow\.(alert|confirm)\b/.test(html), false, '仿真页面禁止使用 window.alert/confirm');
    assert.equal(html.includes('id="login-form"'), true);
    assert.equal(html.includes('id="user-badge"'), true);
  }
  for (const sel of ['id="result-table"', 'id="result-summary"']) {
    assert.equal(sysA.includes(sel), true, `sys_a_query.html 缺少 ${sel}`);
  }
  for (const sel of ['id="receipt-box"', 'id="receipt-status"', 'id="receipt-no"', 'id="receipt-error"', 'id="ledger-table"']) {
    assert.equal(sysB.includes(sel), true, `sys_b_form.html 缺少 ${sel}`);
  }
  console.log('PASS: Dual simulation pages & 12-row sample_batch.csv contract');
}
