import { message } from "antd";
import type { AppDispatch, RootState } from ".";
import { advanceSwitch, completeSwitch, createSwitch, retrySwitch } from "./rundownSlice";
import type { SwitchRequest } from "../types";
import { remainingCapacity, switchConflicts } from "../engine/schedule";

const STEP_DELAY = 700;
const wait = () => new Promise((resolve) => setTimeout(resolve, STEP_DELAY));

interface SubmitPayload {
  itemId: string;
  targetSourceId: string;
  simulateFailure?: boolean;
}

function precheck(state: RootState, req: SwitchRequest): string | null {
  const item = state.rundown.items.find((i) => i.id === req.itemId);
  const target = state.rundown.sources.find((s) => s.id === req.targetSourceId);
  if (!item) return "连线条目不存在";
  if (!target) return "目标信号源不存在";
  if (target.signal === "断") return `「${target.name}」信号不可用`;
  if (item.sourceId === target.id) return "连线已挂在该信号源";
  if (target.kind === "backup") {
    const left = remainingCapacity(target, state.rundown.uses);
    if (left < item.duration) return `「${target.name}」剩余容量 ${left} 分钟，不足 ${item.duration} 分钟`;
  }
  return null;
}

/** 只推进还没成功的步骤；失败即停，保留原排期 */
async function runPendingSteps(dispatch: AppDispatch, getState: () => RootState, requestId: string) {
  for (;;) {
    const req = getState().rundown.switches.find((r) => r.id === requestId);
    if (!req || req.status !== "进行中") return req;
    const step = req.steps.find((s) => s.state === "待执行");
    if (!step) break;

    await wait();
    // 重试时锁可能被先到者抢走
    const holder = getState().rundown.switches.find(
      (r) => r.status === "进行中" && r.id !== requestId && switchConflicts(r, req)
    );
    if (holder) {
      dispatch(advanceSwitch({ requestId, stepKey: step.key, ok: false, error: "信号源已被先到的切换占用" }));
      return getState().rundown.switches.find((r) => r.id === requestId);
    }

    if (step.key === "prefade") {
      const error = precheck(getState(), req);
      if (error) {
        dispatch(advanceSwitch({ requestId, stepKey: step.key, ok: false, error }));
        return getState().rundown.switches.find((r) => r.id === requestId);
      }
    }
    if (step.key === "switch" && req.simulateFailure) {
      dispatch(advanceSwitch({ requestId, stepKey: step.key, ok: false, error: "模拟切换失败：切换台未应答" }));
      return getState().rundown.switches.find((r) => r.id === requestId);
    }
    dispatch(advanceSwitch({ requestId, stepKey: step.key, ok: true }));
  }

  const req = getState().rundown.switches.find((r) => r.id === requestId);
  if (req && req.status === "进行中" && req.steps.every((s) => s.state === "成功")) {
    dispatch(completeSwitch({ requestId }));
  }
  return getState().rundown.switches.find((r) => r.id === requestId);
}

/** 两名导播同时提交：先到者占住信号源，后到者直接看到冲突 */
export function submitSwitch(payload: SubmitPayload) {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const state = getState();
    const item = state.rundown.items.find((i) => i.id === payload.itemId);
    const target = state.rundown.sources.find((s) => s.id === payload.targetSourceId);
    if (!item || !target) return;

    const id = crypto.randomUUID();
    dispatch(createSwitch({
      id,
      itemId: item.id,
      itemTitle: item.title,
      targetSourceId: target.id,
      targetSourceName: target.name,
      operator: state.rundown.operator,
      simulateFailure: payload.simulateFailure
    }));

    const created = getState().rundown.switches.find((r) => r.id === id)!;
    if (created.status === "冲突驳回") {
      message.warning(`切换冲突：${item.title} / ${target.name} 已被先到的导播占住`);
      return created;
    }
    message.loading({ content: `正在切换「${item.title}」→ ${target.name}`, key: id });
    const done = await runPendingSteps(dispatch, getState, id);
    if (done?.status === "切换成功") message.success({ content: `「${item.title}」已切到 ${target.name}`, key: id });
    if (done?.status === "切换失败") message.error({ content: `切换失败，保留原排期：${done.steps.find((s) => s.state === "失败")?.error}`, key: id, duration: 4 });
    return done;
  };
}

/** 失败后重试：只重跑没成功的步骤 */
export function retrySwitchRequest(requestId: string) {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const req = getState().rundown.switches.find((r) => r.id === requestId);
    if (!req) return;
    dispatch(retrySwitch({ requestId }));
    const retried = getState().rundown.switches.find((r) => r.id === requestId);
    if (retried?.status === "冲突驳回") {
      message.warning("重试冲突：信号源此刻被先到者占住");
      return retried;
    }
    message.loading({ content: `重试「${req.itemTitle}」未完成的步骤`, key: requestId });
    const done = await runPendingSteps(dispatch, getState, requestId);
    if (done?.status === "切换成功") message.success({ content: `「${req.itemTitle}」切换成功`, key: requestId });
    if (done?.status === "切换失败") message.error({ content: `仍未成功：${done.steps.find((s) => s.state === "失败")?.error}`, key: requestId, duration: 4 });
    return done;
  };
}
