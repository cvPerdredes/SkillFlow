import assert from 'node:assert/strict';

import {
  createAiClient,
  DEFAULT_AI_TIMEOUT_MS,
  resolveChatEndpoint,
  resolveModelsEndpoint,
  stripThinkAndExtractJson
} from '../extension/lib/ai-client.js';
import { extractArgsFromInput } from '../extension/lib/clarification.js';
import { answerRunQuestion } from '../extension/lib/result-qa.js';
import { validateExtractArgsProposal } from '../extension/lib/schemas.js';
import { AI_PROVIDER_PRESETS, createStore, DEFAULT_AI_CONFIG } from '../extension/lib/store.js';

// ---------------------------------------------------------------------------
// 1. resolveChatEndpoint / resolveModelsEndpoint 端点规范化测试
// ---------------------------------------------------------------------------
{
  assert.equal(
    resolveChatEndpoint('https://api.siliconflow.cn/v1'),
    'https://api.siliconflow.cn/v1/chat/completions'
  );
  assert.equal(
    resolveChatEndpoint('https://api.siliconflow.cn/v1/'),
    'https://api.siliconflow.cn/v1/chat/completions'
  );
  assert.equal(
    resolveChatEndpoint('https://api.siliconflow.cn/v1/chat/completions'),
    'https://api.siliconflow.cn/v1/chat/completions'
  );
  assert.equal(
    resolveChatEndpoint('https://api.siliconflow.cn/v1/models'),
    'https://api.siliconflow.cn/v1/chat/completions'
  );

  assert.equal(
    resolveModelsEndpoint('https://api.siliconflow.cn/v1'),
    'https://api.siliconflow.cn/v1/models'
  );
  assert.equal(
    resolveModelsEndpoint('https://api.siliconflow.cn/v1/'),
    'https://api.siliconflow.cn/v1/models'
  );
  assert.equal(
    resolveModelsEndpoint('https://api.siliconflow.cn/v1/chat/completions'),
    'https://api.siliconflow.cn/v1/models'
  );
  assert.equal(
    resolveModelsEndpoint('https://api.siliconflow.cn/v1/models'),
    'https://api.siliconflow.cn/v1/models'
  );

  assert.throws(() => resolveChatEndpoint(''), /Base URL/);
  assert.throws(() => resolveModelsEndpoint('   '), /Base URL/);
  assert.equal(DEFAULT_AI_TIMEOUT_MS, 30000);
  console.log('PASS: resolveChatEndpoint & resolveModelsEndpoint handle /v1, trailing slash, and full paths');
}

// ---------------------------------------------------------------------------
// 2. store 多提供商 AI 配置、参数夹紧、hasAiApiKey 与 Key 零落盘隔离
// ---------------------------------------------------------------------------
{
  const localMem = {};
  const sessionMem = {};
  const chromeMock = {
    storage: {
      local: {
        get: async (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(arr.filter((k) => k in localMem).map((k) => [k, structuredClone(localMem[k])]));
        },
        set: async (patch) => Object.assign(localMem, structuredClone(patch))
      },
      session: {
        get: async (k) => (k in sessionMem ? { [k]: structuredClone(sessionMem[k]) } : {}),
        set: async (patch) => Object.assign(sessionMem, structuredClone(patch)),
        remove: async (k) => {
          delete sessionMem[k];
        }
      }
    }
  };
  const store = createStore(chromeMock);

  // 默认预设校验
  const initial = await store.getAiConfig();
  assert.equal(initial.provider, 'siliconflow');
  assert.equal(initial.baseUrl, AI_PROVIDER_PRESETS.siliconflow.baseUrl);
  assert.equal(initial.model, 'deepseek-v4-flash-0731');
  assert.equal(initial.timeoutMs, DEFAULT_AI_CONFIG.timeoutMs);
  assert.equal(initial.temperature, 0.1);
  assert.equal(initial.maxTokens, 2048);
  assert.equal(initial.thinkingMode, 'auto');
  assert.equal(await store.hasAiApiKey(), false);

  // 保存多提供商设置 + 越界夹紧 + 尝试注入 apiKey 绝不能落盘 local
  const saved = await store.saveAiConfig({
    mode: 'remote',
    provider: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1/',
    model: 'deepseek-v4-flash-0731',
    timeoutMs: 999999,
    temperature: 2.5,
    maxTokens: 9999,
    thinkingMode: 'off',
    apiKey: 'sk-MUST-NEVER-TOUCH-LOCAL'
  });
  assert.equal(saved.baseUrl, 'https://api.siliconflow.cn/v1');
  assert.equal(saved.timeoutMs, 60000);
  assert.equal(saved.temperature, 1);
  assert.equal(saved.maxTokens, 4096);
  assert.equal(saved.thinkingMode, 'off');
  assert.equal(JSON.stringify(localMem).includes('sk-MUST-NEVER-TOUCH-LOCAL'), false);

  // 仅 session 存储 Key 且 hasAiApiKey 只返布尔
  await store.setAiApiKey('sk-SESSION-KEY-ONLY');
  assert.equal(await store.hasAiApiKey(), true);
  assert.equal(JSON.stringify(localMem).includes('sk-SESSION-KEY-ONLY'), false);
  await store.clearAiApiKey();
  assert.equal(await store.hasAiApiKey(), false);
  console.log('PASS: store multi-provider config, clamping, hasAiApiKey() & local Key zero-leakage');
}

// ---------------------------------------------------------------------------
// 3. SiliconFlow / OpenAI-Compatible 协议加固（探针/模型列表/分片/reasoning截断/400剥离重试）
// ---------------------------------------------------------------------------
{
  const telemetryEvents = [];
  let probeCall = 0;
  const mockFetch = async (url, init = {}) => {
    if (url.endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: 'deepseek-v4-flash-0731' },
            { id: 'deepseek-ai/DeepSeek-R1' },
            { id: 'Qwen/Qwen2.5-72B-Instruct' }
          ]
        })
      };
    }

    const body = JSON.parse(init.body || '{}');
    probeCall++;
    // 第 1 次带 enable_thinking: false 模拟网关返回 HTTP 400 不支持该字段，触发自动剥离重试
    if (probeCall === 1 && body.enable_thinking === false) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'unknown field: enable_thinking' } })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: '<think>checking probe</think>\n' },
                { type: 'text', text: '{"ok":true,"echo":"pong"}' }
              ]
            }
          }
        ],
        usage: { prompt_tokens: 32, completion_tokens: 14 }
      })
    };
  };

  const ai = createAiClient({
    getConfig: async () => ({
      mode: 'remote',
      provider: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'deepseek-v4-flash-0731',
      timeoutMs: 30000,
      temperature: 0.1,
      maxTokens: 2048,
      thinkingMode: 'off'
    }),
    getApiKey: async () => 'sk-test-probe',
    fetchImpl: mockFetch,
    onTelemetry: (s) => telemetryEvents.push(s)
  });

  const probeRes = await ai.testConnection();
  assert.equal(probeRes.ok, true);
  assert.equal(probeRes.httpStatus, 200);
  assert.equal(probeRes.thinkingStripped, true, '400 unknown field enable_thinking 必须自动剥离并重试成功');
  assert.deepEqual(probeRes.parsedJson, { ok: true, echo: 'pong' });
  assert.equal(ai.getStats().lastTask, 'testConnection');
  assert.ok(telemetryEvents.length >= 1);

  const modelsRes = await ai.listModels();
  assert.equal(modelsRes.ok, true);
  assert.equal(modelsRes.count, 3);
  assert.deepEqual(modelsRes.deepseekModels, ['deepseek-v4-flash-0731', 'deepseek-ai/DeepSeek-R1']);
  assert.equal(ai.getStats().lastTask, 'listModels');

  // reasoning_content 有内容但正文 content 为空时的明确诊断报错
  const reasoningCutoffAi = createAiClient({
    getConfig: async () => ({
      mode: 'remote',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'deepseek-ai/DeepSeek-R1',
      timeoutMs: 10000
    }),
    getApiKey: async () => 'sk-r1',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: '',
              reasoning_content: '大量思考过程但未在 max_tokens 内输出正文...'
            }
          }
        ]
      })
    })
  });
  const cutoffProbe = await reasoningCutoffAi.testConnection();
  assert.equal(cutoffProbe.ok, false);
  assert.match(cutoffProbe.message, /reasoning_content.*maxTokens|关闭思考模式/);

  // 多段 <think> 与 Markdown 围栏剥离验证
  const parsed = stripThinkAndExtractJson('<think>foo</think>```json\n{"ok":true}\n```');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, { ok: true });
  console.log('PASS: ai-client endpoint probe, listModels, multipart content, reasoning diagnosis & 400 retry');
}

// ---------------------------------------------------------------------------
// 4. 修复 extractArgs 真模型空串 / null / 多余键暗坑，确保“查 B 单位”真实追问 month
// ---------------------------------------------------------------------------
{
  const params = [
    { key: 'unit', label: '查询单位', type: 'string', required: true },
    { key: 'month', label: '查询月份', type: 'month', required: true }
  ];

  // 4a. Schema 层必须安全跳过 null / "" 与未声明多余键，不误判失败
  const schemaRes = validateExtractArgsProposal(
    {
      providedArgs: {
        unit: 'B单位',
        month: '',
        nullPlaceholder: null,
        extraHallucinatedKey: 'ignore-me'
      },
      missingRequired: ['month'],
      nextQuestion: '请补充查询月份(YYYY-MM)'
    },
    params
  );
  assert.equal(schemaRes.ok, true);
  assert.deepEqual(schemaRes.value.providedArgs, { unit: 'B单位' });

  // 4b. UI 传入空白默认占位 { unit: '', month: '' } + 真模型只抽出 unit 时，仍必须追问 month
  let receivedCollectedArgs = null;
  const extractAi = createAiClient({
    getConfig: async () => ({
      mode: 'remote',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'deepseek-v4-flash-0731',
      timeoutMs: 10000
    }),
    getApiKey: async () => 'sk-ext',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const userMsg = body.messages[1].content;
      const jsonMatch = userMsg.match(/<untrusted_page_data>\n([\s\S]*?)\n<\/untrusted_page_data>/);
      receivedCollectedArgs = JSON.parse(jsonMatch[1]).collectedArgs;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  providedArgs: { unit: 'B单位', month: '' },
                  missingRequired: ['month'],
                  nextQuestion: '请补充查询月份(YYYY-MM)',
                  ambiguities: []
                })
              }
            }
          ],
          usage: { prompt_tokens: 180, completion_tokens: 45 }
        })
      };
    }
  });

  const extRes = await extractArgsFromInput({
    userText: '查 B 单位',
    parameters: params,
    collectedArgs: { unit: '', month: '   ' },
    lastQuestion: null,
    currentDate: '2026-11-25',
    aiClient: extractAi
  });
  assert.deepEqual(receivedCollectedArgs, {}, '外发给模型的 collectedArgs 不得含空白占位键');
  assert.deepEqual(extRes.providedArgs, { unit: 'B单位' });
  assert.deepEqual(extRes.missingRequired, ['month']);
  assert.ok(extRes.nextQuestion && extRes.nextQuestion.includes('月'));
  assert.equal(extRes.mode, 'remote');
  assert.equal(extRes.model, 'deepseek-v4-flash-0731');
  console.log('PASS: extractArgs safely ignores empty/null/extra keys and preserves missing month follow-up');
}

// ---------------------------------------------------------------------------
// 5. 远程模式 answerRunQuestion (planQuery -> reduce -> explainRun) 与空明细 0 调用护栏
// ---------------------------------------------------------------------------
{
  let remoteHits = 0;
  const qaAi = createAiClient({
    getConfig: async () => ({
      mode: 'remote',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'deepseek-v4-flash-0731',
      timeoutMs: 10000
    }),
    getApiKey: async () => 'sk-qa',
    fetchImpl: async (_url, init) => {
      remoteHits++;
      const sys = JSON.parse(init.body).messages[0].content;
      const content = sys.includes('统计查询规划器')
        ? JSON.stringify({ op: 'groupCount', groupBy: 'orgName', filterStatus: null })
        : JSON.stringify({
            answer: '已根据确定性统计核对：杭州所 2 条、宁波所 1 条（均已核验）。',
            evidenceRefs: ['records:1..3'],
            caveats: []
          });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 100, completion_tokens: 40 }
        })
      };
    }
  });

  // 空明细必须护栏拒答，0 次远端模型调用
  const guardRes = await answerRunQuestion({
    question: '按单位分布统计',
    records: [],
    recordSchema: [{ key: 'orgName', type: 'string' }],
    aiClient: qaAi
  });
  assert.equal(guardRes.cannotCompute, true);
  assert.equal(guardRes.mode, 'guard');
  assert.equal(remoteHits, 0);

  // 非空明细走通 planQuery -> reduce -> explainRun 并返回 meta 与 evidenceRefs
  const qaRes = await answerRunQuestion({
    question: '按单位分布统计成功条数',
    records: [
      { rowIndex: 1, orgName: '杭州所', status: 'verified' },
      { rowIndex: 2, orgName: '杭州所', status: 'verified' },
      { rowIndex: 3, orgName: '宁波所', status: 'verified' }
    ],
    recordSchema: [
      { key: 'orgName', type: 'string' },
      { key: 'status', type: 'string' }
    ],
    aiClient: qaAi
  });
  assert.equal(remoteHits, 2);
  assert.equal(qaRes.mode, 'remote');
  assert.equal(qaRes.meta.model, 'deepseek-v4-flash-0731');
  assert.equal(qaRes.meta.usage.prompt_tokens, 200);
  assert.equal(qaRes.meta.usage.completion_tokens, 80);
  assert.ok(qaRes.evidenceRefs.includes('records:1..3'));
  console.log('PASS: remote answerRunQuestion end-to-end flow + telemetry meta + empty-records zero-call guard');
}
