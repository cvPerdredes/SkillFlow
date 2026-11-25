"use strict";

import { evaluateRunOutcome } from './result-evaluator.js';
import { isRiskStep } from './plan-builder.js';
import { isSamePageIgnoringQueryAndHash, redactObject } from './sanitizer.js';

/**
 * 执行状态机（RunController）：
 * - 严禁直接调用 chrome.tabs / chrome.scripting，全部通过 ExecutionDriver 驱动；
 * - 支持 outputVar 跨步/跨系统传值、prefill_only 预填不提交、每步检查点持久化；
 * - 支持 auth_checkpoint 双模式（manual_takeover 人工接管 / ephemeral_prompt 内存临时密文填单 + 自动降级）。
 */

function toVerifyPayload(snapshot) {
  return {
    skillId: snapshot.skillId,
    skillVersion: snapshot.skillVersion,
    targetOrigins: snapshot.targetOrigins,
    writeMode: snapshot.writeMode,
    args: snapshot.args,
    batchRows: snapshot.batchRows,
    steps: snapshot.steps,
    riskLevel: snapshot.riskLevel
  };
}

function describeRunStep(step) {
  if (!step) return '';
  if (step.action === 'navigate') return `导航至 ${step.url || ''}`;
  if (step.action === 'auth_checkpoint') return `登录检查点 (${step.origin || ''})`;
  if (step.action === 'manual') return `敏感输入人工步 (${step.target?.label || ''})`;
  if (step.action === 'extract') {
    return `提取字段 → ${step.outputVar || '(临时)'} (${step.target?.cssPath || step.target?.css || ''})`;
  }
  const target = step.target?.label || step.target?.text || step.target?.cssPath || step.target?.css || '目标';
  if (step.action === 'fill' || step.action === 'select') return `${target}: ${step.value ?? ''}`;
  return `${step.action} · ${target}`;
}

export function createRunController({
  driver,
  store,
  approvalClient,
  onStateChange = () => {},
  onLog = () => {}
}) {
  let state = {
    runId: '',
    status: 'IDLE',
    skill: null,
    snapshot: null,
    payload: null,
    approvedPlanHash: null,
    authPolicyOverride: null,
    confirmRiskStep: async () => true,
    currentStepIndex: 0,
    vars: {},
    records: [],
    recordSchema: [],
    evidenceLevel: 'L0',
    logs: [],
    authPauseInfo: null,
    lastResult: null,
    failedStepIndex: null,
    failedStepId: null,
    locatorStats: { totalAttempts: 0, hits: 0, ambiguousCount: 0, failedCount: 0, byStrategy: {} },
    error: null,
    errorCode: null,
    startTime: 0,
    elapsedMs: 0,
    cancelled: false
  };

  function getState() {
    return {
      runId: state.runId,
      status: state.status,
      skillId: state.skill?.id || '',
      skillName: state.skill?.name || '',
      planHash: state.approvedPlanHash || state.snapshot?.planHash || '',
      writeMode: state.snapshot?.writeMode || 'commit',
      currentStepIndex: state.currentStepIndex,
      totalSteps: state.snapshot?.steps?.length || 0,
      vars: { ...state.vars },
      records: [...state.records],
      recordSchema: [...state.recordSchema],
      evidenceLevel: state.evidenceLevel,
      logs: [...state.logs],
      authPauseInfo: state.authPauseInfo ? { ...state.authPauseInfo } : null,
      lastResult: state.lastResult ? { ...state.lastResult } : null,
      failedStepIndex: state.failedStepIndex,
      failedStepId: state.failedStepId,
      locatorStats: structuredClone(state.locatorStats),
      error: state.error,
      errorCode: state.errorCode,
      elapsedMs: state.elapsedMs
    };
  }

  function appendLog(entry) {
    const safeEntry = redactObject(entry);
    state.logs.push(safeEntry);
    onLog(safeEntry);
  }

  async function persistCheckpoint(nextStepIndex) {
    if (!store?.saveRunCheckpoint || !state.runId) return;
    await store.saveRunCheckpoint({
      runId: state.runId,
      skillId: state.skill?.id || '',
      planHash: state.approvedPlanHash || '',
      status: state.status,
      nextStepIndex,
      vars: state.vars,
      logs: state.logs,
      authPauseInfo: state.authPauseInfo
        ? {
            mode: state.authPauseInfo.mode,
            stepIndex: state.authPauseInfo.stepIndex,
            hasCaptcha: state.authPauseInfo.hasCaptcha,
            downgraded: state.authPauseInfo.downgraded
          }
        : null,
      updatedAt: new Date().toISOString()
    });
  }

  async function finalizeRun(finalStatus, errorMsg = null, errorCode = null) {
    state.status = finalStatus;
    state.error = errorMsg;
    state.errorCode = errorCode;
    state.elapsedMs = Date.now() - state.startTime;
    state.authPauseInfo = null;

    const record = {
      id: state.runId,
      skillId: state.skill?.id || '',
      skillName: state.skill?.name || '',
      planHash: state.approvedPlanHash || state.snapshot?.planHash || '',
      status: finalStatus,
      ok: finalStatus === 'VERIFIED_SUCCESS',
      actionCompleted:
        finalStatus === 'VERIFIED_SUCCESS' || finalStatus === 'ACTIONS_COMPLETED_UNVERIFIED',
      evidenceLevel: state.evidenceLevel,
      ts: new Date().toISOString(),
      args: state.snapshot?.args || {},
      vars: state.vars,
      records: state.records,
      recordSchema: state.recordSchema,
      logs: state.logs,
      result: state.lastResult,
      failedStepIndex: state.failedStepIndex,
      failedStepId: state.failedStepId,
      locatorStats: structuredClone(state.locatorStats),
      elapsedMs: state.elapsedMs,
      error: errorMsg,
      errorCode
    };

    if (store?.saveRun) {
      await store.saveRun(record);
    }
    if (store?.clearRunCheckpoint && state.runId) {
      await store.clearRunCheckpoint(state.runId);
    }
    if (state.approvedPlanHash && approvalClient?.revokePlan) {
      await approvalClient.revokePlan({ planHash: state.approvedPlanHash }).catch(() => {});
    }
    onStateChange(getState());
    return getState();
  }

  async function runFromIndex(startIdx) {
    const steps = state.snapshot?.steps || [];
    state.status = 'RUNNING';
    state.error = null;
    state.errorCode = null;
    onStateChange(getState());

    try {
      for (let i = startIdx; i < steps.length; i++) {
        if (state.cancelled) {
          return await finalizeRun('CANCELLED', 'USER_CANCELLED: 用户主动中止执行', 'USER_CANCELLED');
        }
        state.currentStepIndex = i;

        // 每步执行前向 background.js 校验不可变 planHash
        const verifyRes = await approvalClient.verifyPlan({
          planHash: state.approvedPlanHash,
          payload: state.payload
        });
        if (!verifyRes?.ok) {
          const code = verifyRes?.errorCode || 'PLAN_NOT_APPROVED';
          const err = new Error(`${code}: ${verifyRes?.message || '计划审批已失效'}`);
          err.errorCode = code;
          throw err;
        }

        const rawStep = steps[i];

        // 1. auth_checkpoint 双模式状态机
        if (rawStep.action === 'auth_checkpoint') {
          const authInfo = await driver.checkAuthState(rawStep);
          if (authInfo.state === 'AUTHENTICATED') {
            appendLog({
              ok: true,
              stepIndex: i,
              message: `${i + 1}. SKIPPED_AUTHENTICATED: 已处于登录态，跳过认证检查点`
            });
            await persistCheckpoint(i + 1);
            continue;
          }

          const policy = state.authPolicyOverride || state.skill?.authPolicy || 'manual_takeover';
          const canEphemeral =
            policy === 'ephemeral_prompt' && authInfo.canEphemeralFill && !authInfo.hasCaptcha;
          const mode = canEphemeral ? 'ephemeral_prompt' : 'manual_takeover';
          const downgraded = policy === 'ephemeral_prompt' && mode === 'manual_takeover';

          state.status = 'PAUSED_AUTH_REQUIRED';
          state.authPauseInfo = {
            mode,
            stepIndex: i,
            step: rawStep,
            hasCaptcha: Boolean(authInfo.hasCaptcha),
            downgraded
          };
          appendLog({
            ok: true,
            stepIndex: i,
            message:
              mode === 'ephemeral_prompt'
                ? `${i + 1}. PAUSED_AUTH_REQUIRED: 等待侧边栏纯本地临时填入账号口令（用后即毁）`
                : `${i + 1}. PAUSED_AUTH_REQUIRED: 请在右侧业务网页完成登录/验证码后点击继续${downgraded ? '（已自动降级为人工接管）' : ''}`
          });
          await persistCheckpoint(i);
          onStateChange(getState());
          return getState();
        }

        // 2. prefill_only 预填不提交模式：自动跳过最终提交动作
        if (
          state.snapshot.writeMode === 'prefill_only' &&
          (rawStep.risk === 'write_commit' || (isRiskStep(rawStep) && rawStep.action === 'click'))
        ) {
          appendLog({
            ok: true,
            stepIndex: i,
            skipped: true,
            message: `${i + 1}. SKIPPED_PREFILL_ONLY: 预填不提交模式已跳过高危提交动作`
          });
          await persistCheckpoint(i + 1);
          continue;
        }

        // 3. 高危步骤内联确认
        if (
          isRiskStep(rawStep) &&
          rawStep.action !== 'manual' &&
          state.snapshot.writeMode !== 'prefill_only'
        ) {
          state.status = 'PAUSED_CONFIRM_REQUIRED';
          onStateChange(getState());
          const confirmed = await state.confirmRiskStep(rawStep, i);
          if (!confirmed) {
            const err = new Error('USER_CANCELLED: 用户拒绝执行高危步骤');
            err.errorCode = 'USER_CANCELLED';
            throw err;
          }
          state.status = 'RUNNING';
          onStateChange(getState());
        }

        // 4. 动态解析变量引用（支持跨步/跨系统 outputVar 传值）
        const resolvedStep = structuredClone(rawStep);
        if (resolvedStep.valueRef?.var) {
          const varName = resolvedStep.valueRef.var;
          if (!(varName in state.vars) || state.vars[varName] === undefined) {
            const err = new Error(`MISSING_PARAMETER: 缺少前序提取变量 ${varName}`);
            err.errorCode = 'MISSING_PARAMETER';
            throw err;
          }
          resolvedStep.value = state.vars[varName];
        } else if (
          resolvedStep.valueRef?.param &&
          Object.prototype.hasOwnProperty.call(state.snapshot.args || {}, resolvedStep.valueRef.param)
        ) {
          resolvedStep.value = state.snapshot.args[resolvedStep.valueRef.param];
        } else if (resolvedStep.valueRef?.literal !== undefined) {
          resolvedStep.value = resolvedStep.valueRef.literal;
        }

        // 5. 通过 ExecutionDriver 执行单步
        const stepRes = await driver.executeStep(resolvedStep);
        if (resolvedStep.action !== 'navigate') {
          state.locatorStats.totalAttempts += 1;
          if (stepRes?.ok) {
            state.locatorStats.hits += 1;
            const strat = stepRes.matchedLocator || 'unknown';
            state.locatorStats.byStrategy[strat] = (state.locatorStats.byStrategy[strat] || 0) + 1;
          } else {
            state.failedStepIndex = i;
            state.failedStepId = rawStep.id || null;
            if (stepRes?.errorCode === 'TARGET_AMBIGUOUS') state.locatorStats.ambiguousCount += 1;
            else state.locatorStats.failedCount += 1;
          }
        }
        if (!stepRes?.ok) {
          const code = stepRes?.errorCode || 'ACTION_FAILED';
          const err = new Error(`${code}: 第 ${i + 1} 步失败 — ${stepRes?.message || '未知错误'}`);
          err.errorCode = code;
          throw err;
        }

        if (resolvedStep.action === 'extract' && resolvedStep.outputVar) {
          state.vars[resolvedStep.outputVar] = stepRes.extractedValue ?? '';
        }

        appendLog({
          ok: true,
          stepIndex: i,
          matchedLocator: stepRes.matchedLocator || '',
          message: `${i + 1}. ${describeRunStep(resolvedStep)}${stepRes.matchedLocator ? ` [${stepRes.matchedLocator}]` : ''}${
            resolvedStep.action === 'extract' && resolvedStep.outputVar
              ? ` = "${state.vars[resolvedStep.outputVar]}"`
              : ''
          }`
        });
        await persistCheckpoint(i + 1);
      }

      if (state.snapshot.writeMode === 'prefill_only') {
        appendLog({
          ok: true,
          message: '预填不提交模式执行完毕：已填充表单并停在提交前，待人工核对后手动提交'
        });
        state.evidenceLevel = 'L1';
        return await finalizeRun('ACTIONS_COMPLETED_UNVERIFIED');
      }

      let extractedEvidenceLevel = 'L0';
      if (state.skill?.extractSpec) {
        const ext = await driver.extractRecords(state.skill.extractSpec, state.snapshot?.args || {});
        state.records = Array.isArray(ext?.records) ? ext.records : [];
        state.recordSchema = Array.isArray(ext?.recordSchema) ? ext.recordSchema : [];
        extractedEvidenceLevel = ext?.evidenceLevel || 'L0';
        appendLog({
          ok: true,
          message: `结构化采集完成：共 ${state.records.length} 条明细 (${extractedEvidenceLevel})`
        });
      }

      if (state.skill?.resultSelector) {
        state.lastResult = await driver.getResult(state.skill.resultSelector);
      }

      const outcome = evaluateRunOutcome({
        skill: state.skill,
        writeMode: state.snapshot.writeMode,
        actionCompleted: true,
        result: state.lastResult,
        records: state.records,
        extractedEvidenceLevel,
        args: state.snapshot?.args || {}
      });
      state.evidenceLevel = outcome.evidenceLevel || 'L0';

      if (outcome.status === 'VERIFIED_SUCCESS') {
        appendLog({ ok: true, message: outcome.reason });
        return await finalizeRun('VERIFIED_SUCCESS');
      }
      if (outcome.status === 'ACTIONS_COMPLETED_UNVERIFIED') {
        appendLog({ ok: true, message: outcome.reason });
        return await finalizeRun('ACTIONS_COMPLETED_UNVERIFIED');
      }
      appendLog({ ok: false, message: outcome.reason });
      return await finalizeRun(
        'FAILED',
        `${outcome.errorCode || 'OUTCOME_UNVERIFIED'}: ${outcome.reason}`,
        outcome.errorCode || 'OUTCOME_UNVERIFIED'
      );
    } catch (err) {
      const code = err?.errorCode || 'ACTION_FAILED';
      appendLog({ ok: false, message: err.message });
      return await finalizeRun(
        code === 'USER_CANCELLED' ? 'CANCELLED' : 'FAILED',
        err.message,
        code
      );
    }
  }

  async function start({
    skill,
    snapshot,
    authPolicyOverride = null,
    confirmRiskStep = async () => true
  }) {
    if (!skill || !snapshot) {
      throw new Error('缺少技能或执行计划快照');
    }

    state = {
      runId: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `run-${Date.now()}`,
      status: 'RUNNING',
      skill,
      snapshot,
      payload: toVerifyPayload(snapshot),
      approvedPlanHash: snapshot.planHash,
      authPolicyOverride,
      confirmRiskStep,
      currentStepIndex: 0,
      vars: {},
      records: [],
      recordSchema: [],
      evidenceLevel: 'L0',
      logs: [],
      authPauseInfo: null,
      lastResult: null,
      failedStepIndex: null,
      failedStepId: null,
      locatorStats: { totalAttempts: 0, hits: 0, ambiguousCount: 0, failedCount: 0, byStrategy: {} },
      error: null,
      errorCode: null,
      startTime: Date.now(),
      elapsedMs: 0,
      cancelled: false
    };

    try {
      const approveRes = await approvalClient.approvePlan({
        expectedPlanHash: snapshot.planHash,
        payload: state.payload
      });
      if (!approveRes?.ok || approveRes.planHash !== snapshot.planHash) {
        const err = new Error(
          `${approveRes?.errorCode || 'PLAN_NOT_APPROVED'}: ${approveRes?.message || '计划审批失败'}`
        );
        err.errorCode = approveRes?.errorCode || 'PLAN_NOT_APPROVED';
        throw err;
      }

      const session = await driver.ensureSession(snapshot.targetOrigins);

      // 微瑕 1 修复：同 origin + pathname（如带了 ?layout=v2 / ?needAuth=1）保持当前页不强跳回旧 Query
      if (skill.startUrl) {
        if (isSamePageIgnoringQueryAndHash(session.currentUrl, skill.startUrl)) {
          appendLog({
            ok: true,
            message: '保持当前同路径业务页（保留 layout/needAuth 等参数），直接开始执行'
          });
        } else {
          await driver.navigate(skill.startUrl, { allowedOrigins: snapshot.targetOrigins });
        }
      }

      return await runFromIndex(0);
    } catch (err) {
      const code = err?.errorCode || 'ACTION_FAILED';
      appendLog({ ok: false, message: err.message });
      return await finalizeRun('FAILED', err.message, code);
    }
  }

  async function resumeAfterManualAuth() {
    if (state.status !== 'PAUSED_AUTH_REQUIRED' || !state.authPauseInfo) {
      return { ok: false, errorCode: 'ACTION_FAILED', message: '当前并未处于登录等待暂停状态' };
    }
    const pause = state.authPauseInfo;
    const authInfo = await driver.checkAuthState(pause.step);
    if (authInfo.state === 'AUTH_REQUIRED') {
      state.authPauseInfo.hasCaptcha = Boolean(authInfo.hasCaptcha);
      onStateChange(getState());
      return {
        ok: false,
        errorCode: 'AUTH_REQUIRED',
        message: '检测到业务网页仍停留在登录状态，请先完成登录后再点击继续',
        state: getState()
      };
    }

    appendLog({
      ok: true,
      stepIndex: pause.stepIndex,
      message: `${pause.stepIndex + 1}. AUTH_RESUMED_MANUAL: 人工登录已核验，原位续跑后续步骤`
    });
    state.authPauseInfo = null;
    const nextState = await runFromIndex(pause.stepIndex + 1);
    return { ok: true, state: nextState };
  }

  async function submitEphemeralAuth(credentials = {}) {
    if (state.status !== 'PAUSED_AUTH_REQUIRED' || !state.authPauseInfo) {
      if (credentials) {
        credentials.username = '';
        credentials.password = '';
      }
      return { ok: false, errorCode: 'ACTION_FAILED', message: '当前并未处于登录等待暂停状态' };
    }
    const pause = state.authPauseInfo;
    try {
      const fillRes = await driver.fillEphemeralAuth(pause.step, credentials);
      if (!fillRes?.ok || fillRes.downgradeToManual) {
        state.authPauseInfo = {
          ...pause,
          mode: 'manual_takeover',
          downgraded: true,
          hasCaptcha: fillRes?.errorCode === 'AUTH_CAPTCHA_DETECTED' || pause.hasCaptcha
        };
        appendLog({
          ok: false,
          stepIndex: pause.stepIndex,
          message: `${pause.stepIndex + 1}. ${fillRes?.message || '已自动降级为人工接管登录'}`
        });
        await persistCheckpoint(pause.stepIndex);
        onStateChange(getState());
        return {
          ok: false,
          downgraded: true,
          errorCode: fillRes?.errorCode || 'AUTH_REQUIRED',
          message: fillRes?.message || '已自动降级为人工接管登录',
          state: getState()
        };
      }

      const afterAuth = await driver.checkAuthState(pause.step);
      if (afterAuth.state === 'AUTH_REQUIRED') {
        state.authPauseInfo = {
          ...pause,
          mode: 'manual_takeover',
          downgraded: true,
          hasCaptcha: Boolean(afterAuth.hasCaptcha)
        };
        appendLog({
          ok: false,
          stepIndex: pause.stepIndex,
          message: `${pause.stepIndex + 1}. 提交后仍停留在登录态（可能需验证码或核对口令），已降级为人工接管`
        });
        await persistCheckpoint(pause.stepIndex);
        onStateChange(getState());
        return {
          ok: false,
          downgraded: true,
          errorCode: 'AUTH_REQUIRED',
          message: '提交后仍需完成验证，已自动切换为人工接管模式',
          state: getState()
        };
      }

      appendLog({
        ok: true,
        stepIndex: pause.stepIndex,
        message: `${pause.stepIndex + 1}. AUTH_RESUMED_EPHEMERAL: 临时内存登录完成（凭据已立即销毁）`
      });
      state.authPauseInfo = null;
      const nextState = await runFromIndex(pause.stepIndex + 1);
      return { ok: true, state: nextState };
    } finally {
      if (credentials && typeof credentials === 'object') {
        credentials.username = '';
        credentials.password = '';
      }
    }
  }

  async function switchAuthToManual() {
    if (state.status !== 'PAUSED_AUTH_REQUIRED' || !state.authPauseInfo) {
      return getState();
    }
    state.authPauseInfo = {
      ...state.authPauseInfo,
      mode: 'manual_takeover',
      downgraded: true
    };
    appendLog({
      ok: true,
      stepIndex: state.authPauseInfo.stepIndex,
      message: `${state.authPauseInfo.stepIndex + 1}. 已主动切换为人工接管登录模式`
    });
    await persistCheckpoint(state.authPauseInfo.stepIndex);
    onStateChange(getState());
    return getState();
  }

  async function cancel() {
    state.cancelled = true;
    if (state.status === 'PAUSED_AUTH_REQUIRED' || state.status === 'PAUSED_CONFIRM_REQUIRED') {
      return await finalizeRun('CANCELLED', 'USER_CANCELLED: 用户主动中止执行', 'USER_CANCELLED');
    }
    return getState();
  }

  return {
    getState,
    start,
    resumeAfterManualAuth,
    submitEphemeralAuth,
    switchAuthToManual,
    cancel
  };
}
