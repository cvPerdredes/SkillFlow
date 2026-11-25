"use strict";

/**
 * 公共 URL 脱敏、敏感字段判定与深度清洗模块（Chrome 116+ & Node ESM 通用）。
 * 注意：AUTH_CREDENTIAL_RE 与 SENSITIVE_PII_RE 必须与 content.js 中内联副本保持严格一致。
 */

export const DEFAULT_ALLOWED_QUERY_KEYS = Object.freeze([
  'menuId',
  'page',
  'tab',
  'view',
  'layout',
  'module',
  'section',
  'type',
  'month',
  'unit',
  'needAuth',
  'ambiguous'
]);

export const SENSITIVE_QUERY_KEY_RE =
  /(?:^|[_-])(token|access[_-]?token|id[_-]?token|refresh[_-]?token|ticket|st|session|sessid|jsessionid|phpsessid|password|passwd|pwd|passcode|auth|authorization|secret|api[_-]?key|access[_-]?key|sign|signature|cookie|credential|code[_-]?verifier|otp|jwt|bearer)(?:$|[_-])/i;

export const JWT_OR_SECRET_VALUE_RE =
  /^(?:bearer\s+.+|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;

export const AUTH_CREDENTIAL_RE =
  /password|passwd|pwd|passcode|one-time-code|otp|captcha|verify[-_.\s]?code|verification|sms[-_.\s]?code|auth[-_.\s]?code|验证码|校验码|动态码|动态验证码|密码|口令|密钥/i;

export const SENSITIVE_PII_RE =
  /token|secret|api[-_.\s]?key|access[-_.\s]?key|credential|cookie|session|id[-_.\s]?card|identity|phone|mobile|telephone|\btel\b|bank[-_.\s]?card|card[-_.\s]?no|\b(?:account|acct)(?:[-_.\s]?(?:no|num|number|id|name))?\b|salary|amount|money|\bcvv\b|\bssn\b|令牌|手机号|手机|联系电话|电话|户号|身份证|证件号|姓名|银行卡|卡号|账号|账户|余额|金额|工资|薪资/i;

function buildAllowedKeySet(allowedQueryKeys) {
  const source = Array.isArray(allowedQueryKeys)
    ? allowedQueryKeys
    : DEFAULT_ALLOWED_QUERY_KEYS;
  return new Set(source.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean));
}

function filterQueryString(queryStr, allowSet) {
  const input = new URLSearchParams(queryStr);
  const output = new URLSearchParams();
  for (const [key, value] of input.entries()) {
    if (SENSITIVE_QUERY_KEY_RE.test(key)) continue;
    if (JWT_OR_SECRET_VALUE_RE.test(String(value || '').trim())) continue;
    if (!allowSet.has(key.toLowerCase())) continue;
    output.append(key, value);
  }
  return output.toString();
}

/**
 * 清洗 URL：剥离凭据、JWT 与敏感参数；保留路由型 Hash 与白名单业务 Query。
 */
export function sanitizeUrl(raw, allowedQueryKeys = null) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.username = '';
    u.password = '';

    const allowSet = buildAllowedKeySet(allowedQueryKeys);
    const filteredQuery = filterQueryString(u.search, allowSet);
    u.search = filteredQuery ? `?${filteredQuery}` : '';

    if (u.hash && u.hash.length > 1) {
      const body = u.hash.slice(1);
      const qIndex = body.indexOf('?');
      if (qIndex >= 0) {
        const routePart = body.slice(0, qIndex);
        const hashQuery = body.slice(qIndex + 1);
        const safeHashQuery = filterQueryString(hashQuery, allowSet);
        if (SENSITIVE_QUERY_KEY_RE.test(routePart)) {
          u.hash = '';
        } else {
          u.hash = safeHashQuery
            ? `#${routePart}?${safeHashQuery}`
            : routePart
              ? `#${routePart}`
              : '';
        }
      } else if (body.includes('=')) {
        const safeFragment = filterQueryString(body, allowSet);
        u.hash = safeFragment ? `#${safeFragment}` : '';
      } else if (SENSITIVE_QUERY_KEY_RE.test(body) || JWT_OR_SECRET_VALUE_RE.test(body)) {
        u.hash = '';
      }
    }

    return u.toString();
  } catch (_) {
    return '';
  }
}

/**
 * 提取站点 Origin（仅允许 http/https）。
 */
export function safeOriginOf(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch (_) {
    return '';
  }
}

/**
 * 判断两个 URL 是否处于同一业务页面（同 origin + pathname），忽略 query 与 hash。
 * 用于保留测试/轻改版参数（如 ?layout=v2 / ?needAuth=1 / ?ambiguous=1），防止被强跳回 v1。
 */
export function isSamePageIgnoringQueryAndHash(urlA, urlB) {
  try {
    const a = new URL(String(urlA || ''));
    const b = new URL(String(urlB || ''));
    if ((a.protocol !== 'http:' && a.protocol !== 'https:') || a.protocol !== b.protocol) {
      return false;
    }
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch (_) {
    return false;
  }
}

/**
 * 汇总控件或 Target 描述的所有文本特征（含关联 <label> 与容器标签）。
 */
export function collectFieldDescriptorText(info) {
  if (!info || typeof info !== 'object') return '';
  return [
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
}

/**
 * 判断是否属于认证凭据控件（密码、OTP、验证码或处于登录表单容器内的控件）。
 */
export function isAuthCredentialInfo(info) {
  if (!info || typeof info !== 'object') return false;
  if (String(info.type || '').toLowerCase() === 'password') return true;
  if (info.inAuthContainer) return true;
  if (/current-password|new-password|one-time-code/i.test(String(info.autocomplete || ''))) {
    return true;
  }
  const text = collectFieldDescriptorText(info);
  return AUTH_CREDENTIAL_RE.test(text);
}

/**
 * 判断是否属于敏感字段（覆盖认证凭据 + <label>/周边容器 + 电网 PII 词库）。
 */
export function isSensitiveFieldInfo(info) {
  if (!info || typeof info !== 'object') return false;
  if (isAuthCredentialInfo(info)) return true;
  const text = collectFieldDescriptorText(info);
  return SENSITIVE_PII_RE.test(text);
}

/**
 * 统一字段分类：'auth' | 'sensitive' | 'normal'。
 */
export function classifyFieldInfo(info) {
  if (isAuthCredentialInfo(info)) return 'auth';
  if (isSensitiveFieldInfo(info)) return 'sensitive';
  return 'normal';
}

function sanitizeTarget(target) {
  if (!target || typeof target !== 'object') return {};
  const cleanStr = (v, max = 160) =>
    v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max);

  const out = {};
  const fields = [
    'testId',
    'stableId',
    'ariaLabel',
    'label',
    'anchor',
    'text',
    'tag',
    'type',
    'name',
    'placeholder',
    'cssPath',
    'css',
    'containerLabel'
  ];
  for (const key of fields) {
    const val = cleanStr(target[key], key === 'cssPath' || key === 'css' ? 240 : 140);
    if (val) out[key] = val;
  }
  if (!out.css && out.cssPath) out.css = out.cssPath;
  if (!out.cssPath && out.css) out.cssPath = out.css;
  return out;
}

/**
 * 后台接收 RECORD_EVENT 时的纵深兜底清洗：
 * 即使来自 content.js 的事件携带敏感原值，在此也会被强行剥离并降级为 auth_checkpoint / manual。
 */
export function sanitizeRecordedStep(rawStep, senderUrl) {
  const url = sanitizeUrl(senderUrl);
  const origin = safeOriginOf(senderUrl);
  const target = sanitizeTarget(rawStep?.target);

  const fieldInfo = {
    ...target,
    inAuthContainer: Boolean(rawStep?.inAuthContainer || rawStep?.action === 'auth_checkpoint')
  };
  const fieldClass = classifyFieldInfo(fieldInfo);

  if (fieldClass === 'auth' || rawStep?.action === 'auth_checkpoint') {
    return {
      action: 'auth_checkpoint',
      origin,
      url,
      authSelector: String(rawStep?.authSelector || '#login-form').slice(0, 120),
      loggedInIndicator:
        rawStep && Object.prototype.hasOwnProperty.call(rawStep, 'loggedInIndicator')
          ? String(rawStep.loggedInIndicator ?? '').slice(0, 120)
          : '',
      sensitive: true,
      risk: 'auth',
      target
    };
  }

  if (fieldClass === 'sensitive' || rawStep?.sensitive === true || rawStep?.action === 'manual') {
    return {
      action: 'manual',
      origin,
      url,
      sensitive: true,
      risk: 'auth',
      target
    };
  }

  const safe = {
    action: String(rawStep?.action || ''),
    origin,
    url,
    target
  };

  if (rawStep?.value !== undefined) {
    const rawVal = String(rawStep.value).slice(0, 2048);
    if (JWT_OR_SECRET_VALUE_RE.test(rawVal.trim())) {
      return {
        action: 'manual',
        origin,
        url,
        sensitive: true,
        risk: 'auth',
        target
      };
    }
    safe.value = rawVal;
  }
  if (typeof rawStep?.checked === 'boolean') {
    safe.checked = rawStep.checked;
  }
  return safe;
}

/**
 * 递归脱敏日志、技能或外发模型载荷，确保任何密码/Token/敏感字段不外泄。
 */
export function redactObject(input, seen = new WeakSet()) {
  if (input === null || typeof input !== 'object') {
    if (typeof input === 'string' && JWT_OR_SECRET_VALUE_RE.test(input.trim())) {
      return '[REDACTED]';
    }
    return input;
  }
  if (seen.has(input)) return '[Circular]';
  seen.add(input);

  try {
    if (Array.isArray(input)) {
      return input.map((item) => redactObject(item, seen));
    }

    const isSensitiveStep =
      input.sensitive === true ||
      input.action === 'auth_checkpoint' ||
      input.action === 'manual' ||
      (input.target && isSensitiveFieldInfo(input.target));

    const out = {};
    for (const [key, val] of Object.entries(input)) {
      if (SENSITIVE_QUERY_KEY_RE.test(key) || AUTH_CREDENTIAL_RE.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      if (isSensitiveStep && (key === 'value' || key === 'default' || key === 'defaultValue')) {
        continue;
      }
      if (key === 'url' && typeof val === 'string') {
        out[key] = sanitizeUrl(val);
        continue;
      }
      out[key] = redactObject(val, seen);
    }
    return out;
  } finally {
    seen.delete(input);
  }
}
