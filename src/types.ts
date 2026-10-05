export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿";
export type SignalStatus = "正常" | "中断" | "备用中" | "补播" | "已补播";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
  /** 连线信号状态 */
  signalStatus?: SignalStatus;
  /** 切换时占用的备用源 */
  backupSourceId?: string;
  /** 备用源垫片时长（重算用） */
  backupDuration?: number;
  /** 乐观并发版本：切换提交时比对，先到者占住信号源 */
  version: number;
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
}

export interface PendingChange {
  id: string;
  action: string;
  detail: string;
  queuedAt: string;
}

export interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  time: string;
  snapshot: RundownItem[];
}

export interface SignalSource {
  id: string;
  name: string;
  kind: "主用" | "备用";
  /** 容量：可占用分钟数 */
  capacityMinutes: number;
  /** 已占用分钟数 */
  occupiedMinutes: number;
  online: boolean;
}

export type MakeupStatus = "待补播" | "已补播" | "已放弃";

export interface MakeupEntry {
  id: string;
  itemId: string;
  title: string;
  reason: string;
  /** 备用源时长 */
  duration: number;
  queuedAt: string;
  status: MakeupStatus;
}

export type SwitchStepName = "occupy" | "recompute" | "anchor";
export type SwitchStepStatus = "done" | "failed" | "pending";

export interface SwitchStep {
  name: SwitchStepName;
  label: string;
  status: SwitchStepStatus;
  error?: string;
}

export interface SwitchAttempt {
  id: string;
  itemId: string;
  itemTitle: string;
  backupSourceId: string;
  backupSourceName: string;
  backupDuration: number;
  /** 提交时携带的版本号，用于冲突判定 */
  expectedVersion: number;
  steps: SwitchStep[];
  error?: string;
  warning?: string;
  createdAt: string;
}
