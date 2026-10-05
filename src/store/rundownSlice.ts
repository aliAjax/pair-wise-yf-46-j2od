import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  BackupUse,
  BreakingChange,
  HistoryEntry,
  MakeupEntry,
  PendingChange,
  Role,
  RundownItem,
  SignalSource,
  SwitchRequest,
  SwitchStep,
} from "../types";
import { planBackup, switchConflicts } from "../engine/schedule";

const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 5, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控" },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, status: "待播", presenter: "陈默", source: "记者周岚", sourceId: "src-sng1", signal: "正常" },
  { id: "r3", title: "地铁早高峰连线", type: "连线", duration: 6, status: "待播", presenter: "林菲", source: "记者高远", sourceId: "src-sng2", signal: "正常" },
  { id: "r4", title: "政策发布会解读", type: "嘉宾", duration: 10, status: "待播", presenter: "陈默", source: "演播室A" },
  { id: "r5", title: "整点新闻", type: "新闻片", duration: 5, hardStart: "08:30", status: "待播", presenter: "林菲", source: "主控" },
  { id: "r6", title: "签约广告时段", type: "广告", duration: 4, hardStart: "08:35", status: "待播", presenter: "系统", source: "广告串" },
  { id: "r7", title: "天气与收束口播", type: "口播", duration: 4, status: "待播", presenter: "陈默", source: "主控" }
];

const seedSources: SignalSource[] = [
  { id: "src-sng1", name: "卫星车 SNG-1（周岚）", kind: "primary", capacity: 0, signal: "正常" },
  { id: "src-sng2", name: "卫星车 SNG-2（高远）", kind: "primary", capacity: 0, signal: "正常" },
  { id: "src-studio", name: "演播室主控", kind: "primary", capacity: 0, signal: "正常" },
  { id: "src-bak-a", name: "备用源 A · 备播演播室", kind: "backup", capacity: 6, signal: "正常" },
  { id: "src-bak-b", name: "备用源 B · 远端回传", kind: "backup", capacity: 5, signal: "正常" }
];

interface State {
  initialized: boolean;
  items: RundownItem[];
  sources: SignalSource[];
  uses: BackupUse[];
  makeup: MakeupEntry[];
  switches: SwitchRequest[];
  /** 切换进行中占用的连线 id（后到者看到冲突） */
  itemLocks: Record<string, string>;
  /** 切换进行中占用的信号源 id */
  sourceLocks: Record<string, string>;
  acknowledgedRisks: string[];
  history: HistoryEntry[];
  queue: PendingChange[];
  changes: BreakingChange[];
  role: Role;
  operator: string;
  online: boolean;
}

const initialState: State = {
  initialized: false,
  items: seed,
  sources: seedSources,
  uses: [],
  makeup: [],
  switches: [],
  itemLocks: {},
  sourceLocks: {},
  acknowledgedRisks: [],
  history: [],
  queue: [],
  changes: [],
  role: "导播",
  operator: "导播甲",
  online: true
};

function cloneItems(items: RundownItem[]): RundownItem[] {
  return JSON.parse(JSON.stringify(items)) as RundownItem[];
}

function snapshot(items: RundownItem[], label: string, detail: string): HistoryEntry {
  return { id: crypto.randomUUID(), label, detail, time: new Date().toISOString(), snapshot: cloneItems(items) };
}

const switchStepLabels: Array<SwitchStep["key"]> = ["prefade", "switch", "verify"];
export const switchStepText: Record<string, string> = {
  prefade: "预切备路",
  switch: "执行切换",
  verify: "确认信号"
};

export function freshSteps(): SwitchStep[] {
  return switchStepLabels.map((key) => ({ key, label: switchStepText[key], state: "待执行" }));
}

/** 在 draft 上执行一次切换：备用源只从被选中的那一路占容量，占不到则整体失败 */
function applySwitchOnDraft(state: State, req: SwitchRequest): boolean {
  const item = state.items.find((entry) => entry.id === req.itemId);
  if (!item) return false;
  const target = state.sources.find((s) => s.id === req.targetSourceId);
  if (!target) return false;

  if (target.kind === "backup") {
    const used = state.uses
      .filter((u) => u.sourceId === target.id)
      .reduce((sum, u) => sum + u.minutes, 0);
    if (used + item.duration > target.capacity) return false; // 容量不足，保留原排期
    state.uses.push({
      id: crypto.randomUUID(),
      itemId: item.id,
      sourceId: target.id,
      minutes: item.duration,
      reason: `手动切换备用顶播（${req.operator}）`,
      at: new Date().toISOString()
    });
    item.backupCovered = Math.max(item.backupCovered ?? 0, item.duration);
  }
  item.sourceId = target.id;
  item.source = target.name;
  item.signal = target.kind === "backup" ? "备播" : "正常";
  if (target.kind === "primary" && item.status === "备播中") item.status = "待播";
  if (target.kind === "backup" && item.status === "待播") item.status = "备播中";
  if (item.status === "排队补播") {
    item.status = target.kind === "backup" ? "备播中" : "待播";
    item.makeupId = undefined;
  }
  return true;
}

/** 信号断掉：先让备用源顶上并记下占用；备用源容量占满就排队进补播清单 */
function failoverOnDraft(state: State, item: RundownItem, reason: string): { covered: number; needed: number } {
  const source = state.sources.find((s) => s.id === item.sourceId);
  if (source) source.signal = "断";
  item.signal = "断";

  const needed = item.duration;
  const plan = planBackup(state.sources, state.uses, needed);
  for (const use of plan.uses) {
    state.uses.push({ ...use, reason, id: crypto.randomUUID(), itemId: item.id, at: new Date().toISOString() });
  }
  item.backupCovered = plan.covered;
  if (plan.covered > 0) {
    const topSource = state.sources.find((s) => s.id === plan.uses[0].sourceId);
    if (topSource) {
      item.sourceId = topSource.id;
      item.source = `${topSource.name}（备用顶播）`;
    }
  }

  if (plan.covered >= needed) {
    item.status = "备播中";
    item.signal = "备播";
    return { covered: plan.covered, needed };
  }

  // 备用源容量占满（或根本没够）——缺口排队进补播清单
  const shortfall = needed - plan.covered;
  const entry: MakeupEntry = {
    id: crypto.randomUUID(),
    itemId: item.id,
    title: item.title,
    shortfall,
    reason: plan.covered > 0 ? `备用源仅覆盖 ${plan.covered} 分钟，缺口 ${shortfall} 分钟` : "备用源容量已满",
    queuedAt: new Date().toISOString(),
    status: "排队中"
  };
  state.makeup.unshift(entry);
  item.makeupId = entry.id;
  item.status = "排队补播";
  return { covered: plan.covered, needed };
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<RundownItem[]>) {
      if (!state.initialized) {
        state.items = action.payload.length ? action.payload : seed;
        state.initialized = true;
      }
    },
    setRole(state, action: PayloadAction<Role>) { state.role = action.payload; },
    setOperator(state, action: PayloadAction<string>) { state.operator = action.payload; },
    setOnline(state, action: PayloadAction<boolean>) { state.online = action.payload; },

    addItem(state, action: PayloadAction<Omit<RundownItem, "id" | "status">>) {
      state.history.unshift(snapshot(state.items, "新增条目", action.payload.title));
      state.items.push({ ...action.payload, id: crypto.randomUUID(), status: "草稿" });
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
      state.items.splice(index + 1, 0, { id: crypto.randomUUID(), title: change.headline, type: "新闻片", duration: change.duration, status: "待播", presenter: "值班主播", source: `插播：${change.reason}` });
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
      state.items = cloneItems(last.snapshot);
    },
    queueChange(state, action: PayloadAction<{ action: string; detail: string }>) {
      state.queue.unshift({ ...action.payload, id: crypto.randomUUID(), queuedAt: new Date().toISOString() });
    },
    syncQueue(state) { state.queue = []; },

    /** 点名风险已确认 */
    ackRisk(state, action: PayloadAction<string>) {
      if (!state.acknowledgedRisks.includes(action.payload)) state.acknowledgedRisks.push(action.payload);
    },

    /** 现场连线信号中断：自动走备用顶播 / 补播排队 */
    signalLost(state, action: PayloadAction<{ id: string; reason?: string }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item || item.type !== "连线" || item.signal === "断") return;
      state.history.unshift(snapshot(state.items, "连线信号中断", item.title));
      const result = failoverOnDraft(state, item, action.payload.reason ?? "信号中断备用顶播");
      state.history.unshift(snapshot(state.items, "备用源顶播", `${item.title}：备用覆盖 ${result.covered}/${result.needed} 分钟`));
    },

    /** 信号恢复：释放连线的断/备状态（占用台账保留作审计） */
    signalRestore(state, action: PayloadAction<{ id: string; sourceId?: string }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      const targetId = action.payload.sourceId ?? item.sourceId;
      const target = state.sources.find((s) => s.id === targetId);
      state.history.unshift(snapshot(state.items, "连线信号恢复", item.title));
      item.signal = "恢复";
      if (target) {
        if (target.kind === "primary") {
          item.sourceId = target.id;
          item.source = target.name;
          item.signal = "正常";
          if (item.status === "备播中") item.status = "待播";
        } else {
          item.sourceId = target.id;
          item.source = target.name;
          item.signal = "备播";
        }
      }
      if (item.status === "排队补播") {
        item.status = "待播";
        item.makeupId = undefined;
      }
    },

    /** 手动设置某路信号源的通断（关掉主源时其下连线会在组件侧逐条派发 signalLost） */
    toggleSourceSignal(state, action: PayloadAction<{ sourceId: string; signal: SignalSource["signal"] }>) {
      const source = state.sources.find((s) => s.id === action.payload.sourceId);
      if (!source) return;
      source.signal = action.payload.signal;
    },

    /** 补播清单：处理一条（已补播/放弃） */
    resolveMakeup(state, action: PayloadAction<{ makeupId: string; resolved: boolean }>) {
      const entry = state.makeup.find((m) => m.id === action.payload.makeupId);
      if (!entry) return;
      entry.status = "已处理";
      const item = state.items.find((i) => i.id === entry.itemId);
      if (item) {
        state.history.unshift(snapshot(state.items, action.payload.resolved ? "补播完成" : "放弃补播", item.title));
        item.makeupId = undefined;
        if (!action.payload.resolved) item.status = "已跳过";
      }
    },

    // —— 两名导播同时切换：先到者占住信号源，后到者看到冲突 ——

    createSwitch(state, action: PayloadAction<Omit<SwitchRequest, "id" | "submittedAt" | "status" | "steps"> & { id: string }>) {
      const payload = action.payload;
      const holder = state.switches.find(
        (r) => r.status === "进行中" && switchConflicts(r, payload)
      );
      const req: SwitchRequest = holder
        ? {
            ...payload,
            id: payload.id,
            submittedAt: new Date().toISOString(),
            status: "冲突驳回",
            steps: [],
            conflictWith: holder.id
          }
        : {
            ...payload,
            id: payload.id,
            submittedAt: new Date().toISOString(),
            status: "进行中",
            steps: freshSteps()
          };
      state.switches.unshift(req);
      if (!holder) {
        state.itemLocks[payload.itemId] = req.id;
        state.sourceLocks[payload.targetSourceId] = req.id;
      }
    },

    /** 推进一个切换步骤；失败时锁仍保留，排期不动 */
    advanceSwitch(state, action: PayloadAction<{ requestId: string; stepKey: string; ok: boolean; error?: string }>) {
      const req = state.switches.find((r) => r.id === action.payload.requestId);
      if (!req || req.status !== "进行中") return;
      const step = req.steps.find((s) => s.key === action.payload.stepKey);
      if (!step || step.state !== "待执行") return;
      if (!action.payload.ok) {
        step.state = "失败";
        step.error = action.payload.error ?? "切换失败";
        req.status = "切换失败";
        delete state.itemLocks[req.itemId];
        delete state.sourceLocks[req.targetSourceId];
        return;
      }
      step.state = "成功";
    },

    /** 全部步骤成功：套用切换（备用源在此刻登记占用）并释放锁 */
    completeSwitch(state, action: PayloadAction<{ requestId: string }>) {
      const req = state.switches.find((r) => r.id === action.payload.requestId);
      if (!req || req.status !== "进行中") return;
      if (req.steps.some((s) => s.state !== "成功")) return;
      state.history.unshift(snapshot(state.items, "连线切换", `${req.itemTitle} → ${req.targetSourceName}（${req.operator}）`));
      const applied = applySwitchOnDraft(state, req);
      if (applied) {
        req.status = "切换成功";
      } else {
        req.status = "切换失败";
        const failed = req.steps.find((s) => s.state !== "成功");
        if (failed) {
          failed.state = "失败";
          failed.error = "备用源容量不足";
        }
      }
      delete state.itemLocks[req.itemId];
      delete state.sourceLocks[req.targetSourceId];
    },

    /** 重试：只重跑没成功的步骤；先重新占锁，发现先到者则保持失败并记冲突 */
    retrySwitch(state, action: PayloadAction<{ requestId: string }>) {
      const req = state.switches.find((r) => r.id === action.payload.requestId);
      if (!req || req.status !== "切换失败") return;
      const holder = state.switches.find(
        (r) => r.status === "进行中" && r.id !== req.id && switchConflicts(r, req)
      );
      if (holder) {
        req.status = "冲突驳回";
        req.conflictWith = holder.id;
        return;
      }
      req.status = "进行中";
      req.conflictWith = undefined;
      req.simulateFailure = false; // 重试是真实再试，不再重演模拟故障
      for (const step of req.steps) {
        if (step.state === "失败") {
          step.state = "待执行";
          step.error = undefined;
        }
      }
      state.itemLocks[req.itemId] = req.id;
      state.sourceLocks[req.targetSourceId] = req.id;
    },

    closeSwitch(state, action: PayloadAction<{ requestId: string }>) {
      const req = state.switches.find((r) => r.id === action.payload.requestId);
      if (!req || req.status === "进行中") return;
      delete state.itemLocks[req.itemId];
      delete state.sourceLocks[req.targetSourceId];
    }
  }
});

export const {
  initialize,
  setRole,
  setOperator,
  setOnline,
  addItem,
  updateStatus,
  reorder,
  adjustDuration,
  insertBreaking,
  skipItem,
  undo,
  queueChange,
  syncQueue,
  ackRisk,
  signalLost,
  signalRestore,
  toggleSourceSignal,
  resolveMakeup,
  createSwitch,
  advanceSwitch,
  completeSwitch,
  retrySwitch,
  closeSwitch
} = slice.actions;
export default slice.reducer;
