"use strict";

import { validateTypedParamValue } from './schemas.js';

/**
 * 自然语言技能匹配（matchSkill）、一句话智能补参（extractArgs）与相对日期/格式校验模块。
 */

function parseToday(currentDate) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(currentDate || ''))) {
    const [y, m, d] = currentDate.split('-').map(Number);
    return { y, m, d };
  }
  const now = new Date();
  return {
    y: now.getFullYear(),
    m: now.getMonth() + 1,
    d: now.getDate()
  };
}

function formatYmd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 将相对日期/自然语言时间归一化为 YYYY-MM（month）或 YYYY-MM-DD（date）。
 * 非法月/日返回 { ok: false, errorCode: 'PARAMETER_INVALID', message }。
 */
export function normalizeRelativeDate(text, currentDate, targetType = 'month') {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, errorCode: 'MISSING_PARAMETER', message: '时间输入为空' };
  const { y, m, d } = parseToday(currentDate);

  if (targetType === 'month') {
    const explicit = raw.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*月?/);
    if (explicit) {
      const year = Number(explicit[1]);
      const mon = Number(explicit[2]);
      if (mon < 1 || mon > 12) {
        return {
          ok: false,
          errorCode: 'PARAMETER_INVALID',
          message: `非法月份 ${explicit[0]}，月份必须在 01–12 之间`
        };
      }
      return { ok: true, value: `${year}-${String(mon).padStart(2, '0')}` };
    }
    if (/上个?月/.test(raw)) {
      const pm = m === 1 ? 12 : m - 1;
      const py = m === 1 ? y - 1 : y;
      return { ok: true, value: `${py}-${String(pm).padStart(2, '0')}` };
    }
    if (/下个?月/.test(raw)) {
      const nm = m === 12 ? 1 : m + 1;
      const ny = m === 12 ? y + 1 : y;
      return { ok: true, value: `${ny}-${String(nm).padStart(2, '0')}` };
    }
    if (/本个?月|这个月|当月/.test(raw)) {
      return { ok: true, value: `${y}-${String(m).padStart(2, '0')}` };
    }
    return {
      ok: false,
      errorCode: 'PARAMETER_INVALID',
      message: `无法解析月份 "${raw}"，请提供 YYYY-MM 格式或“本月/上个月”`
    };
  }

  if (targetType === 'date') {
    const explicit = raw.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/);
    if (explicit) {
      const candidate = formatYmd(Number(explicit[1]), Number(explicit[2]), Number(explicit[3]));
      return validateTypedParamValue({ key: 'date', label: '日期', type: 'date', required: true }, candidate);
    }
    const baseUtc = new Date(Date.UTC(y, m - 1, d));
    if (/前天/.test(raw)) baseUtc.setUTCDate(baseUtc.getUTCDate() - 2);
    else if (/昨天|昨日/.test(raw)) baseUtc.setUTCDate(baseUtc.getUTCDate() - 1);
    else if (/明天|明日/.test(raw)) baseUtc.setUTCDate(baseUtc.getUTCDate() + 1);
    else if (!/今天|今日/.test(raw)) {
      return {
        ok: false,
        errorCode: 'PARAMETER_INVALID',
        message: `无法解析日期 "${raw}"，请提供 YYYY-MM-DD 格式`
      };
    }
    return {
      ok: true,
      value: formatYmd(baseUtc.getUTCFullYear(), baseUtc.getUTCMonth() + 1, baseUtc.getUTCDate())
    };
  }

  return { ok: true, value: raw };
}

/**
 * 本地规则版 matchSkill 兜底实现。
 */
export function fallbackMatchSkill({ userQuery, skills = [] }) {
  const q = String(userQuery || '').trim().toLowerCase();
  if (!q || !skills.length) {
    return { matchedSkillId: null, candidates: [], confidence: 'low' };
  }

  const scored = skills
    .map((s) => {
      const name = String(s.name || '').toLowerCase();
      const intent = String(s.intent || '').toLowerCase();
      const paramText = (s.paramKeys || (s.parameters || []).map((p) => `${p.key} ${p.label || ''}`))
        .join(' ')
        .toLowerCase();
      const hay = `${name} ${intent} ${paramText}`;

      let score = 0;
      if (name && q.includes(name)) score += 0.6;
      if (/查|查询|台账|电量|汇总/.test(q) && /查|查询|台账|电量|汇总/.test(hay)) score += 0.45;
      if (/录|填|报|批量/.test(q) && /录|填|报|批量/.test(hay)) score += 0.45;
      if (/单位/.test(q) && /单位|unit|org/.test(hay)) score += 0.15;
      if (/月/.test(q) && /月|month/.test(hay)) score += 0.15;

      let charHits = 0;
      const chars = Array.from(new Set(q.replace(/\s+/g, '')));
      for (const ch of chars) {
        if (hay.includes(ch)) charHits++;
      }
      if (chars.length > 0) score += (charHits / chars.length) * 0.25;

      return {
        skillId: s.id,
        score: Number(Math.min(0.99, score).toFixed(2)),
        reason: '本地关键词与意图匹配'
      };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const matchedSkillId = top && top.score >= 0.35 ? top.skillId : null;
  const confidence = !matchedSkillId ? 'low' : top.score >= 0.7 ? 'high' : 'medium';
  return { matchedSkillId, candidates: scored.slice(0, 3), confidence };
}

/**
 * 调用 matchSkill（支持 AI 与自动规则降级）。
 */
export async function matchSkillByQuery({ userQuery, skills = [], aiClient = null }) {
  const compactSkills = skills.map((s) => ({
    id: s.id,
    name: s.name,
    intent: s.intent || '',
    paramKeys: (s.parameters || []).map((p) => p.key)
  }));

  if (!aiClient) {
    return { ok: true, mode: 'fallback', degraded: true, ...fallbackMatchSkill({ userQuery, skills: compactSkills }) };
  }

  const res = await aiClient.matchSkill({ userQuery, skills: compactSkills });
  if (res.ok) {
    return { ok: true, mode: res.mode, degraded: false, usage: res.usage || null, ...res.data };
  }
  return {
    ok: true,
    mode: 'fallback',
    degraded: true,
    errorCode: res.errorCode,
    errorMessage: res.message,
    ...fallbackMatchSkill({ userQuery, skills: compactSkills })
  };
}

function cleanUnitMatch(raw) {
  return String(raw || '')
    .replace(/^(?:请|帮我|我要|我想)?(?:查询|录入|填报|查|按)\s*/, '')
    .replace(/([A-Za-z0-9])\s+(单位|供电所|供电公司|部门)/g, '$1$2')
    .trim();
}

/**
 * 本地规则版 extractArgs：支持已有槽位继承、相对日期解析、多轮缺参追问与格式拦截。
 */
export function fallbackExtractArgs({
  userText,
  parameters = [],
  collectedArgs = {},
  lastQuestion = null,
  currentDate
}) {
  const text = String(userText || '').trim();
  const rawCandidates = {};
  const invalidArgs = [];
  const ambiguities = [];

  for (const [k, v] of Object.entries(collectedArgs || {})) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      rawCandidates[k] = v;
    }
  }

  const paramList = Array.isArray(parameters) ? parameters : [];
  const remainingBefore = paramList.filter(
    (p) => p.required !== false && (rawCandidates[p.key] === undefined || rawCandidates[p.key] === '')
  );

  // 1. 显式 key: value 解析
  for (const p of paramList) {
    const escapedLabel = String(p.label || p.key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const kvRe = new RegExp(`(?:${p.key}|${escapedLabel})\\s*[:：=]\\s*([^\\s，,；;]+)`, 'i');
    const hit = text.match(kvRe);
    if (hit) rawCandidates[p.key] = hit[1].trim();
  }

  // 2. 月份与日期参数识别（支持相对日期与显式格式，非法格式记入 invalidArgs）
  for (const p of paramList) {
    if (p.type === 'month' || p.key === 'month') {
      const mToken = text.match(/(\d{4}\s*[-/年]\s*\d{1,2}\s*月?|上个?月|本个?月|这个月|当月|下个?月)/);
      if (mToken) {
        const norm = normalizeRelativeDate(mToken[1], currentDate, 'month');
        if (norm.ok) rawCandidates[p.key] = norm.value;
        else invalidArgs.push({ key: p.key, errorCode: norm.errorCode, message: norm.message });
      }
    } else if (p.type === 'date' || p.key === 'date') {
      const dToken = text.match(/(\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?|今天|今日|昨天|昨日|前天|明天|明日)/);
      if (dToken) {
        const norm = normalizeRelativeDate(dToken[1], currentDate, 'date');
        if (norm.ok) rawCandidates[p.key] = norm.value;
        else invalidArgs.push({ key: p.key, errorCode: norm.errorCode, message: norm.message });
      }
    } else if (/unit|org/i.test(p.key) || /单位|供电所|部门/.test(p.label || '')) {
      const unitHit = text.match(/([A-Za-z0-9\u4e00-\u9fa5]+\s*(?:供电所|供电公司|单位|部门))/);
      if (unitHit) {
        const cleaned = cleanUnitMatch(unitHit[1]);
        if (cleaned) rawCandidates[p.key] = cleaned;
      }
    } else if (p.type === 'number' || /kwh|电量/.test(p.key)) {
      const numHit = text.match(/(?:电量|数值|kwh)?\s*[:：=]?\s*(\d+(?:\.\d+)?)\s*(?:kwh|度)?/i);
      if (numHit && (/电量|kwh|度/.test(text) || remainingBefore.length === 1)) {
        rawCandidates[p.key] = numHit[1];
      }
    }
  }

  // 3. 上下文单槽追问回复绑定（例如上一轮问“请补充查询月份”，本轮直接回复“2026-13”或“上个月”）
  if (lastQuestion && text && remainingBefore.length === 1) {
    const targetParam = remainingBefore[0];
    if (
      rawCandidates[targetParam.key] === undefined &&
      !invalidArgs.some((x) => x.key === targetParam.key)
    ) {
      if (targetParam.type === 'month' || targetParam.type === 'date') {
        const norm = normalizeRelativeDate(text, currentDate, targetParam.type);
        if (norm.ok) rawCandidates[targetParam.key] = norm.value;
        else invalidArgs.push({ key: targetParam.key, errorCode: norm.errorCode, message: norm.message });
      } else {
        rawCandidates[targetParam.key] = text;
      }
    }
  }

  // 4. 按 ParameterSchema 类型严格校验全部提取值
  const providedArgs = {};
  for (const p of paramList) {
    if (!(p.key in rawCandidates)) continue;
    const checked = validateTypedParamValue(p, rawCandidates[p.key]);
    if (!checked.ok) {
      if (!invalidArgs.some((x) => x.key === p.key)) {
        invalidArgs.push({ key: p.key, errorCode: checked.errorCode, message: checked.message });
      }
    } else if (checked.value !== '') {
      providedArgs[p.key] = checked.value;
    }
  }

  const missingRequired = paramList
    .filter((p) => p.required !== false && p.type !== 'dataset' && !(p.key in providedArgs))
    .map((p) => p.key);

  const missingLabels = paramList
    .filter((p) => missingRequired.includes(p.key))
    .map((p) => `${p.label || p.key}${p.type === 'month' ? '(YYYY-MM)' : p.type === 'date' ? '(YYYY-MM-DD)' : ''}`);

  let nextQuestion = null;
  if (invalidArgs.length > 0) {
    nextQuestion = invalidArgs.map((e) => e.message).join('；');
  } else if (missingLabels.length > 0) {
    nextQuestion = `请补充以下必填参数：${missingLabels.join('、')}`;
  }

  return {
    providedArgs,
    invalidArgs,
    missingRequired,
    nextQuestion,
    ambiguities
  };
}

/**
 * 调用 extractArgs 解析用户输入；支持 AI 与规则兜底（含非法格式校验拦截）。
 */
export async function extractArgsFromInput({
  userText,
  parameters = [],
  collectedArgs = {},
  lastQuestion = null,
  currentDate,
  aiClient = null
}) {
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(currentDate || ''))
    ? currentDate
    : new Date().toISOString().slice(0, 10);

  if (!aiClient) {
    return {
      ok: true,
      mode: 'fallback',
      degraded: true,
      ...fallbackExtractArgs({
        userText,
        parameters,
        collectedArgs,
        lastQuestion,
        currentDate: dateStr
      })
    };
  }

  const res = await aiClient.extractArgs({
    userText,
    parameters,
    collectedArgs,
    lastQuestion,
    currentDate: dateStr
  });

  if (res.ok) {
    const mergedArgs = { ...(collectedArgs || {}), ...(res.data.providedArgs || {}) };
    const invalidArgs = [...(res.data.invalidArgs || [])];
    // 再用规则校验补强，防止模型对非法格式（如 2026-13）漏检
    const localCheck = fallbackExtractArgs({
      userText,
      parameters,
      collectedArgs: mergedArgs,
      lastQuestion,
      currentDate: dateStr
    });
    for (const inv of localCheck.invalidArgs) {
      if (!invalidArgs.some((x) => x.key === inv.key)) invalidArgs.push(inv);
    }
    const missingRequired = (parameters || [])
      .filter((p) => p.required !== false && p.type !== 'dataset' && !(p.key in mergedArgs))
      .map((p) => p.key);

    return {
      ok: true,
      mode: res.mode,
      degraded: false,
      usage: res.usage || null,
      providedArgs: mergedArgs,
      invalidArgs,
      missingRequired,
      nextQuestion:
        invalidArgs.length > 0
          ? invalidArgs.map((e) => e.message).join('；')
          : res.data.nextQuestion || localCheck.nextQuestion,
      ambiguities: res.data.ambiguities || []
    };
  }

  return {
    ok: true,
    mode: 'fallback',
    degraded: true,
    errorCode: res.errorCode,
    errorMessage: res.message,
    ...fallbackExtractArgs({
      userText,
      parameters,
      collectedArgs,
      lastQuestion,
      currentDate: dateStr
    })
  };
}
