export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿" | "备播中" | "排队补播";
export type SignalKind = "primary" | "backup";
export type SignalState = "正常" | "断" | "占用中";
export type LinkSignalState = "正常" | "断" | "备播" | "恢复";

export interface SignalSource {
  id: string;
  name: string;
  kind: SignalKind;
  /** 备用源容量（分钟）；主源容量不参与分配 */
  capacity: number;
  signal: SignalState;
}

export interface BackupUse {
  id: string;
  itemId: string;
  sourceId: string;
  minutes: number;
  reason: string;
  at: string;
}

export type MakeupStatus = "排队中" | "已处理";

export interface MakeupEntry {
  id: string;
  itemId: string;
  title: string;
  shortfall: number;
  reason: string;
  queuedAt: string;
  status: MakeupStatus;
}

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
  /** 连线当前挂在哪个信号源上（主源/备用源 id） */
  sourceId?: string;
  /** 连线信号状态 */
  signal?: LinkSignalState;
  /** 备用源实际能覆盖的分钟数（覆盖不全时为部分时长） */
  backupCovered?: number;
  /** 补播清单条目 id */
  makeupId?: string;
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

export type SwitchStatus = "进行中" | "切换成功" | "切换失败" | "冲突驳回";

export interface SwitchStep {
  key: string;
  label: string;
  state: "成功" | "失败" | "待执行";
  error?: string;
}

export interface SwitchRequest {
  id: string;
  itemId: string;
  itemTitle: string;
  targetSourceId: string;
  targetSourceName: string;
  operator: string;
  submittedAt: string;
  status: SwitchStatus;
  steps: SwitchStep[];
  /** 驳回原因（如：与先到的切换请求冲突） */
  conflictWith?: string;
  /** 演示用：模拟"执行切换"步骤失败，便于验证保留排期与只重试失败步骤 */
  simulateFailure?: boolean;
}
