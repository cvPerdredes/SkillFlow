"use strict";

import { isSensitiveFieldInfo, redactObject, safeOriginOf } from './sanitizer.js';
import { normalizeSkillIR, STEP_ACTIONS, validateSkillIR } from './schemas.js';

/**
 * 统一存储封装：
 * - chrome.storage.local：技能库、脱敏运行日志、断点账本、非敏感 AI 配置（写前强制经过 redactObject）。
 * - chrome.storage.session：临时模型 API Key（严禁写入 local），关闭浏览器自动清空。
 */

const SKILLS_KEY = 'skills';
const RUNS_KEY = 'runs';
const CHECKPOINTS_KEY = 'runCheckpoints';
const AI_CONFIG_KEY = 'aiConfig';
const AI_API_KEY_SESSION_KEY = 'sf_ai_api_key';

const MAX_SKILLS = 50;
const MAX_RUNS = 100;
const MAX_CHECKPOINTS = 20;

const DEFAULT_AI_CONFIG = Object.freeze({
  mode: 'mock',
  baseUrl: '',
  model: 'deepseek-v4-flash',
  timeoutMs: 15000
});

/**
 * 校验远程 OpenAI-Compatible 模型网关地址是否合法 http/https URL。
 */
export function validateRemoteAiBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    return { ok: false, message: '远程模式必须填写接口 Base URL' };
  }
  try {
    const u = new URL(trimmed);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.host) {
      return { ok: false, message: '模型接口 Base URL 仅支持合法的 http:// 或 https:// 地址' };
    }
    return {
      ok: true,
      origin: u.origin,
      normalizedUrl: u.toString().replace(/\/+$/, '')
    };
  } catch (_) {
    return { ok: false, message: '模型接口 Base URL 格式不合法，请输入完整 http(s):// 地址' };
  }
}

/**
 * 创建隔离存储实例（支持浏览器 MV3 与 Node 单测）。
 */
export function createStore(chromeApi = globalThis.chrome) {
  let volatileApiKey = '';

  async function localGet(keys) {
    if (!chromeApi?.storage?.local?.get) return {};
    return (await chromeApi.storage.local.get(keys)) || {};
  }

  async function localSet(patch) {
    if (!chromeApi?.storage?.local?.set) return;
    await chromeApi.storage.local.set(redactObject(patch));
  }

  async function getSkills() {
    const data = await localGet(SKILLS_KEY);
    return Array.isArray(data[SKILLS_KEY]) ? data[SKILLS_KEY] : [];
  }

  async function saveSkill(skill) {
    const safeSkill = redactObject(skill);
    const existing = await getSkills();
    const updated = [safeSkill, ...existing.filter((x) => x.id !== safeSkill.id)].slice(0, MAX_SKILLS);
    await localSet({ [SKILLS_KEY]: updated });
    return safeSkill;
  }

  async function deleteSkill(skillId) {
    const existing = await getSkills();
    const updated = existing.filter((x) => x.id !== skillId);
    await localSet({ [SKILLS_KEY]: updated });
    return updated;
  }

  async function getRuns() {
    const data = await localGet(RUNS_KEY);
    return Array.isArray(data[RUNS_KEY]) ? data[RUNS_KEY] : [];
  }

  async function saveRun(runRecord) {
    const safeRun = redactObject(runRecord);
    const existing = await getRuns();
    const updated = [safeRun, ...existing.filter((x) => x.id !== safeRun.id)].slice(0, MAX_RUNS);
    await localSet({ [RUNS_KEY]: updated });
    return safeRun;
  }

  async function getRunCheckpoints() {
    const data = await localGet(CHECKPOINTS_KEY);
    return Array.isArray(data[CHECKPOINTS_KEY]) ? data[CHECKPOINTS_KEY] : [];
  }

  async function saveRunCheckpoint(checkpoint) {
    const safeCp = redactObject(checkpoint);
    const existing = await getRunCheckpoints();
    const updated = [safeCp, ...existing.filter((x) => x.runId !== safeCp.runId)].slice(
      0,
      MAX_CHECKPOINTS
    );
    await localSet({ [CHECKPOINTS_KEY]: updated });
    return safeCp;
  }

  async function clearRunCheckpoint(runId) {
    const existing = await getRunCheckpoints();
    const updated = existing.filter((x) => x.runId !== runId);
    await localSet({ [CHECKPOINTS_KEY]: updated });
  }

  async function getRecordingBundle() {
    const data = await localGet(['recording', 'currentSession']);
    return {
      recording: data.recording || null,
      currentSession: data.currentSession || null
    };
  }

  async function setRecordingBundle(patch) {
    await localSet(patch);
  }

  async function getAiConfig() {
    const data = await localGet(AI_CONFIG_KEY);
    const saved = data[AI_CONFIG_KEY];
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_AI_CONFIG };
    return {
      mode: saved.mode === 'remote' ? 'remote' : 'mock',
      baseUrl: String(saved.baseUrl || '').trim(),
      model: String(saved.model || DEFAULT_AI_CONFIG.model).trim(),
      timeoutMs: Math.min(Math.max(Number(saved.timeoutMs || DEFAULT_AI_CONFIG.timeoutMs), 2000), 15000)
    };
  }

  async function saveAiConfig(cfg) {
    // 铁律：严禁将 apiKey / token / secret 落盘 chrome.storage.local
    const mode = cfg?.mode === 'remote' ? 'remote' : 'mock';
    let baseUrl = String(cfg?.baseUrl || '').trim();
    if (mode === 'remote') {
      const checked = validateRemoteAiBaseUrl(baseUrl);
      if (!checked.ok) {
        throw new Error(checked.message);
      }
      baseUrl = checked.normalizedUrl;
    }
    const sanitized = {
      mode,
      baseUrl,
      model: String(cfg?.model || DEFAULT_AI_CONFIG.model).trim(),
      timeoutMs: Math.min(Math.max(Number(cfg?.timeoutMs || DEFAULT_AI_CONFIG.timeoutMs), 2000), 15000)
    };
    await localSet({ [AI_CONFIG_KEY]: sanitized });
    return sanitized;
  }

  async function getAiApiKey() {
    const sessionApi = chromeApi?.storage?.session;
    if (sessionApi?.get) {
      const data = await sessionApi.get(AI_API_KEY_SESSION_KEY);
      return String(data?.[AI_API_KEY_SESSION_KEY] || '');
    }
    return volatileApiKey;
  }

  async function setAiApiKey(apiKey) {
    const trimmed = String(apiKey || '').trim();
    const sessionApi = chromeApi?.storage?.session;
    if (sessionApi?.set) {
      await sessionApi.set({ [AI_API_KEY_SESSION_KEY]: trimmed });
    } else {
      volatileApiKey = trimmed;
    }
  }

  async function clearAiApiKey() {
    volatileApiKey = '';
    const sessionApi = chromeApi?.storage?.session;
    if (sessionApi?.remove) {
      await sessionApi.remove(AI_API_KEY_SESSION_KEY);
    } else if (sessionApi?.set) {
      await sessionApi.set({ [AI_API_KEY_SESSION_KEY]: '' });
    }
  }

  function exportSkillJson(skill) {
    return JSON.stringify(redactObject(skill), null, 2);
  }

  /**
   * 从用户导入的 JSON 文本解析、强校验并脱敏落盘技能（同 id 去重覆盖）。
   * 显式拦截非法动作（如 executeScript）、非法 origin 与敏感凭据投毒。
   */
  async function importSkillJson(jsonText) {
    let parsed;
    try {
      parsed = JSON.parse(String(jsonText || ''));
    } catch (err) {
      return {
        ok: false,
        errorCode: 'SKILL_IMPORT_INVALID',
        errors: [`JSON 解析失败：${err.message}`],
        message: `技能文件不是合法 JSON：${err.message}`
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        errorCode: 'SKILL_IMPORT_INVALID',
        errors: ['技能 JSON 根节点必须是对象'],
        message: '技能文件格式非法：根节点必须是 JSON 对象'
      };
    }

    const errors = [];
    const forbiddenTopKeys = [
      'apiKey',
      'password',
      'passwd',
      'token',
      'secret',
      'cookie',
      'accessToken',
      'authToken'
    ];
    for (const fk of forbiddenTopKeys) {
      if (parsed[fk] !== undefined && parsed[fk] !== null && parsed[fk] !== '') {
        errors.push(`禁止导入包含敏感凭据字段 ${fk} 的技能文件`);
      }
    }

    if (parsed.startUrl && !safeOriginOf(parsed.startUrl)) {
      errors.push(`非法 startUrl 协议或地址: ${parsed.startUrl}`);
    }
    if (Array.isArray(parsed.allowedOrigins)) {
      for (const o of parsed.allowedOrigins) {
        if (!safeOriginOf(o)) errors.push(`非法站点 origin: ${o}`);
      }
    }

    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      errors.push('steps 不能为空');
    } else {
      for (let i = 0; i < parsed.steps.length; i++) {
        const s = parsed.steps[i];
        if (!s || typeof s !== 'object') {
          errors.push(`第 ${i + 1} 步结构非法`);
          continue;
        }
        if (!STEP_ACTIONS.includes(s.action)) {
          errors.push(`禁止的或未知的动作类型: ${s.action}`);
        }
        if (s.url && !safeOriginOf(s.url)) {
          errors.push(`第 ${i + 1} 步包含非法 URL: ${s.url}`);
        }
        const hasRawVal = s.value !== undefined && s.value !== null && s.value !== '';
        const isSens =
          s.action === 'auth_checkpoint' ||
          s.action === 'manual' ||
          Boolean(s.sensitive) ||
          isSensitiveFieldInfo(s.target || {});
        if (isSens && hasRawVal) {
          errors.push(`第 ${i + 1} 步为敏感/认证步骤，严禁包含原始 value`);
        }
      }
    }

    if (errors.length > 0) {
      return {
        ok: false,
        errorCode: 'SKILL_IMPORT_INVALID',
        errors,
        message: errors.join('；')
      };
    }

    const normalized = normalizeSkillIR(parsed);
    const validation = validateSkillIR(normalized);
    if (!validation.ok) {
      return {
        ok: false,
        errorCode: 'SKILL_IMPORT_INVALID',
        errors: validation.errors || [],
        message: (validation.errors || []).join('；')
      };
    }

    const saved = await saveSkill(redactObject(normalized));
    return { ok: true, skill: saved };
  }

  return {
    getSkills,
    saveSkill,
    deleteSkill,
    importSkillJson,
    getRuns,
    saveRun,
    getRunCheckpoints,
    saveRunCheckpoint,
    clearRunCheckpoint,
    getRecordingBundle,
    setRecordingBundle,
    getAiConfig,
    saveAiConfig,
    getAiApiKey,
    setAiApiKey,
    clearAiApiKey,
    exportSkillJson
  };
}

export const defaultStore = createStore();
