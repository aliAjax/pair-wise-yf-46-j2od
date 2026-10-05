import { createSlice, current, type PayloadAction } from "@reduxjs/toolkit";
import type { BreakingChange, HistoryEntry, MakeupEntry, Role, RundownItem, SignalSource, SwitchAttempt, SwitchStep } from "../types";
import { riskTitles } from "../utils/rundownMath";

const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控", signalStatus: "正常", version: 0 },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, status: "待播", presenter: "陈默", source: "记者周岚", signalStatus: "正常", version: 0 },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, status: "待播", presenter: "陈默", source: "演播室A", signalStatus: "正常", version: 0 },
  { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串", signalStatus: "正常", version: 0 }
];

const seedSources: SignalSource[] = [
  { id: "src-main", name: "主控", kind: "主用", capacityMinutes: 240, occupiedMinutes: 0, online: true },
  { id: "src-fiber", name: "备用光纤A", kind: "备用", capacityMinutes: 30, occupiedMinutes: 0, online: true },
  { id: "src-studio", name: "演播室B垫片", kind: "备用", capacityMinutes: 20, occupiedMinutes: 0, online: true },
  { id: "src-sat", name: "备用卫星", kind: "备用", capacityMinutes: 15, occupiedMinutes: 0, online: false }
];

interface State {
  initialized: boolean;
  items: RundownItem[];
  history: HistoryEntry[];
  queue: PendingLike[];
  changes: BreakingChange[];
  sources: SignalSource[];
  makeup: MakeupEntry[];
  switchAttempts: SwitchAttempt[];
  role: Role;
  online: boolean;
}

type PendingLike = { id: string; action: string; detail: string; queuedAt: string };

const initialState: State = { initialized: false, items: seed, history: [], queue: [], changes: [], sources: seedSources, makeup: [], switchAttempts: [], role: "导播", online: true };

function snapshot(items: RundownItem[], label: string, detail: string): HistoryEntry {
  return { id: crypto.randomUUID(), label, detail, time: new Date().toISOString(), snapshot: structuredClone(current(items)) };
}

function defaultSteps(): SwitchStep[] {
  return [
    { name: "occupy", label: "占住备用源", status: "pending" },
    { name: "recompute", label: "按备用源时长重算", status: "pending" },
    { name: "anchor", label: "硬时间锚点校验", status: "pending" }
  ];
}

/** 容量占满或无可用源 → 补播清单 */
function queueMakeup(state: State, item: RundownItem, sourceName: string, duration: number, reason: string) {
  item.signalStatus = "补播";
  state.makeup.unshift({ id: crypto.randomUUID(), itemId: item.id, title: item.title, reason: `${sourceName}：${reason}`, duration, queuedAt: new Date().toISOString(), status: "待补播" });
}

/**
 * 连线切换三步：占住备用源 → 按备用源时长重算 → 硬时间锚点校验。
 * 任一步失败即回滚已变更的条目与信号源，原排期保留，只把失败步骤记入 attempt，供重试。
 */
function runSwitch(state: State, item: RundownItem, backupSourceId: string, backupDuration: number, expectedVersion: number): SwitchAttempt {
  const source = state.sources.find((entry) => entry.id === backupSourceId);
  const attempt: SwitchAttempt = {
    id: crypto.randomUUID(),
    itemId: item.id,
    itemTitle: item.title,
    backupSourceId,
    backupSourceName: source?.name ?? "未知备用源",
    backupDuration,
    expectedVersion,
    steps: defaultSteps(),
    createdAt: new Date().toISOString()
  };

  const beforeItem = structuredClone(current(item));
  const beforeSource = source ? structuredClone(current(source)) : null;
  const fail = (stepIndex: number, error: string) => {
    attempt.steps[stepIndex].status = "failed";
    attempt.steps[stepIndex].error = error;
    attempt.error = `${error}（原排期保留，可只重试未完成步骤）`;
    // 回滚已完成步骤的全部变更，已完成步骤复位为待重试，避免重复占用信号源
    for (let s = 0; s < stepIndex; s++) attempt.steps[s].status = "pending";
    Object.assign(item, beforeItem);
    if (source && beforeSource) Object.assign(source, beforeSource);
    state.switchAttempts.unshift(attempt);
  };

  // 第一步：占住备用源（乐观并发：版本不一致说明已被其他导播占住）
  if (item.version !== expectedVersion) {
    fail(0, `版本冲突：信号源已被其他导播占住（提交版本 v${expectedVersion} 已过期，当前 v${item.version}）`);
    return attempt;
  }
  if (!source || !source.online) {
    fail(0, "备用源不可用或已下线");
    return attempt;
  }
  if (source.occupiedMinutes + backupDuration > source.capacityMinutes) {
    queueMakeup(state, item, source.name, backupDuration, `容量已满（占用 ${source.occupiedMinutes}/${source.capacityMinutes} 分钟，需 ${backupDuration} 分钟），已排队进补播清单`);
    attempt.steps[0].status = "done";
    attempt.steps[1].status = "done";
    attempt.steps[2].status = "done";
    attempt.error = "备用源容量已满，已排入补播清单";
    state.switchAttempts.unshift(attempt);
    return attempt;
  }
  source.occupiedMinutes += backupDuration;
  item.signalStatus = "备用中";
  item.backupSourceId = source.id;
  item.backupDuration = backupDuration;
  item.version += 1;
  attempt.steps[0].status = "done";

  // 第二步：按备用源时长重算
  if (backupDuration <= 0 || !Number.isFinite(backupDuration)) {
    fail(1, "备用源时长无效，无法重算时间线");
    return attempt;
  }
  attempt.steps[1].status = "done";

  // 第三步：硬时间锚点校验（整点新闻、签约广告时段不动；赶不上的点名）
  const risks = riskTitles(state.items);
  attempt.steps[2].status = "done";
  if (risks.length) attempt.warning = `重算后 ${risks.length} 条内容赶不上硬时间锚点：${risks.join("、")}`;

  state.switchAttempts.unshift(attempt);
  return attempt;
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<RundownItem[]>) {
      if (!state.initialized) {
        state.items = action.payload.length ? action.payload.map((item) => ({ ...item, signalStatus: item.signalStatus ?? "正常", version: item.version ?? 0 })) : seed;
        state.initialized = true;
      }
    },
    setRole(state, action: PayloadAction<Role>) { state.role = action.payload; },
    setOnline(state, action: PayloadAction<boolean>) { state.online = action.payload; },
    addItem(state, action: PayloadAction<Omit<RundownItem, "id" | "status" | "version" | "signalStatus">>) {
      state.history.unshift(snapshot(state.items, "新增条目", action.payload.title));
      state.items.push({ ...action.payload, id: crypto.randomUUID(), status: "草稿", signalStatus: "正常", version: 0 });
    },
    updateStatus(state, action: PayloadAction<{ id: string; status: RundownItem["status"] }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "播出状态", `${item.title} → ${action.payload.status}`));
      item.status = action.payload.status;
    },
    reorder(state, action: PayloadAction<RundownItem[]>) {
      state.history.unshift(snapshot(state.items, "调整顺序", "直播串联单顺序变化"));
      state.items = action.payload;
    },
    adjustDuration(state, action: PayloadAction<{ id: string; delta: number }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "调整时长", `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`));
      item.duration = Math.max(1, item.duration + action.payload.delta);
    },
    insertBreaking(state, action: PayloadAction<Omit<BreakingChange, "id" | "createdAt">>) {
      const change: BreakingChange = { ...action.payload, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      const index = state.items.findIndex((item) => item.id === change.insertAfter);
      state.history.unshift(snapshot(state.items, "突发插播", change.headline));
      state.items.splice(index + 1, 0, { id: crypto.randomUUID(), title: change.headline, type: "新闻片", duration: change.duration, status: "待播", presenter: "值班主播", source: `插播：${change.reason}`, signalStatus: "正常", version: 0 });
      state.changes.unshift(change);
      if (!state.online) state.queue.unshift({ id: crypto.randomUUID(), action: "突发插播", detail: change.headline, queuedAt: change.createdAt });
    },
    skipItem(state, action: PayloadAction<string>) {
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "取消条目", item.title));
      item.status = "已跳过";
      if (!state.online) state.queue.unshift({ id: crypto.randomUUID(), action: "取消条目", detail: item.title, queuedAt: new Date().toISOString() });
    },
    undo(state) {
      const last = state.history.shift();
      if (!last) return;
      state.items = structuredClone(last.snapshot);
    },
    queueChange(state, action: PayloadAction<{ action: string; detail: string }>) {
      state.queue.unshift({ ...action.payload, id: crypto.randomUUID(), queuedAt: new Date().toISOString() });
    },
    syncQueue(state) { state.queue = []; },

    /** 连线切换：两名导播同时提交时，先到者占住信号源，后到者看到冲突 */
    switchToBackup(state, action: PayloadAction<{ itemId: string; backupSourceId: string; backupDuration: number; expectedVersion: number }>) {
      const item = state.items.find((entry) => entry.id === action.payload.itemId);
      if (!item || item.type !== "连线") return;
      state.history.unshift(snapshot(state.items, "连线切换", `${item.title} → 备用源`));
      runSwitch(state, item, action.payload.backupSourceId, action.payload.backupDuration, action.payload.expectedVersion);
    },

    /** 信号断掉：自动顶上第一个容量足够的在线备用源；占满则排队进补播清单 */
    reportSignalLoss(state, action: PayloadAction<string>) {
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item || item.type !== "连线") return;
      state.history.unshift(snapshot(state.items, "信号中断", item.title));
      const candidate = state.sources.find((source) => source.kind === "备用" && source.online && source.occupiedMinutes + item.duration <= source.capacityMinutes);
      if (!candidate) {
        queueMakeup(state, item, "无可用备用源", item.duration, "所有备用源容量占满或下线，已排队进补播清单");
        state.switchAttempts.unshift({
          id: crypto.randomUUID(), itemId: item.id, itemTitle: item.title, backupSourceId: "", backupSourceName: "无", backupDuration: item.duration, expectedVersion: item.version,
          steps: [
            { name: "occupy", label: "占住备用源", status: "done" },
            { name: "recompute", label: "按备用源时长重算", status: "done" },
            { name: "anchor", label: "硬时间锚点校验", status: "done" }
          ],
          error: "无可用备用源，已排入补播清单",
          createdAt: new Date().toISOString()
        });
        return;
      }
      runSwitch(state, item, candidate.id, item.duration, item.version);
    },

    /** 切换失败后只重试没成功的步骤，已完成的步骤不重复执行 */
    retrySwitch(state, action: PayloadAction<string>) {
      const attempt = state.switchAttempts.find((entry) => entry.id === action.payload);
      if (!attempt) return;
      const item = state.items.find((entry) => entry.id === attempt.itemId);
      if (!item) return;
      const source = state.sources.find((entry) => entry.id === attempt.backupSourceId);
      const beforeItem = structuredClone(current(item));
      const beforeSource = source ? structuredClone(current(source)) : null;
      const occupyWasDone = attempt.steps[0].status === "done";
      const rollback = () => {
        if (!occupyWasDone && attempt.steps[0].status === "done") attempt.steps[0].status = "pending";
        Object.assign(item, beforeItem);
        if (source && beforeSource) Object.assign(source, beforeSource);
      };

      if (attempt.steps[0].status !== "done") {
        if (item.version !== attempt.expectedVersion) {
          attempt.steps[0].status = "failed";
          attempt.steps[0].error = `版本冲突仍在：信号源已被占住（当前 v${item.version}），请更换备用源`;
          attempt.error = `${attempt.steps[0].error}（重试失败，原排期保留）`;
          rollback();
          return;
        }
        if (!source || !source.online) {
          attempt.steps[0].status = "failed";
          attempt.steps[0].error = "备用源不可用或已下线";
          attempt.error = `${attempt.steps[0].error}（重试失败，原排期保留）`;
          rollback();
          return;
        }
        if (source.occupiedMinutes + attempt.backupDuration > source.capacityMinutes) {
          queueMakeup(state, item, source.name, attempt.backupDuration, `容量已满（占用 ${source.occupiedMinutes}/${source.capacityMinutes} 分钟，需 ${attempt.backupDuration} 分钟），已排队进补播清单`);
          attempt.steps[0].status = "done";
          attempt.steps[1].status = "done";
          attempt.steps[2].status = "done";
          attempt.error = "备用源容量已满，已排入补播清单";
          return;
        }
        source.occupiedMinutes += attempt.backupDuration;
        item.signalStatus = "备用中";
        item.backupSourceId = source.id;
        item.backupDuration = attempt.backupDuration;
        item.version += 1;
        attempt.steps[0].status = "done";
      }

      if (attempt.steps[1].status !== "done") {
        if (attempt.backupDuration <= 0 || !Number.isFinite(attempt.backupDuration)) {
          attempt.steps[1].status = "failed";
          attempt.steps[1].error = "备用源时长无效，无法重算时间线";
          attempt.error = `${attempt.steps[1].error}（重试失败，原排期保留）`;
          rollback();
          return;
        }
        attempt.steps[1].status = "done";
      }

      if (attempt.steps[2].status !== "done") {
        const risks = riskTitles(state.items);
        attempt.steps[2].status = "done";
        attempt.warning = risks.length ? `重算后 ${risks.length} 条内容赶不上硬时间锚点：${risks.join("、")}` : undefined;
      }

      attempt.error = undefined;
    },

    /** 补播清单处理：补播 → 条目回到在线流程；放弃 → 取消条目 */
    resolveMakeup(state, action: PayloadAction<{ entryId: string; resolution: "补播" | "放弃" }>) {
      const entry = state.makeup.find((makeup) => makeup.id === action.payload.entryId);
      if (!entry || entry.status !== "待补播") return;
      const item = state.items.find((entryItem) => entryItem.id === entry.itemId);
      state.history.unshift(snapshot(state.items, "补播处理", `${entry.title} → ${action.payload.resolution}`));
      if (action.payload.resolution === "补播") {
        entry.status = "已补播";
        if (item) {
          item.signalStatus = "已补播";
          item.status = "待播";
        }
      } else {
        entry.status = "已放弃";
        if (item) item.status = "已跳过";
      }
    },

    addSource(state, action: PayloadAction<{ name: string; capacityMinutes: number }>) {
      state.sources.push({ id: crypto.randomUUID(), name: action.payload.name, kind: "备用", capacityMinutes: action.payload.capacityMinutes, occupiedMinutes: 0, online: true });
    },

    setSourceOnline(state, action: PayloadAction<{ id: string; online: boolean }>) {
      const source = state.sources.find((entry) => entry.id === action.payload.id);
      if (source) source.online = action.payload.online;
    }
  }
});

export const { initialize, setRole, setOnline, addItem, updateStatus, reorder, adjustDuration, insertBreaking, skipItem, undo, queueChange, syncQueue, switchToBackup, reportSignalLoss, retrySwitch, resolveMakeup, addSource, setSourceOnline } = slice.actions;
export default slice.reducer;
