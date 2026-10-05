import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Tag } from "antd";
import type { RundownItem } from "../types";

const signalColor: Record<string, string> = { 正常: "default", 中断: "red", 备用中: "blue", 补播: "orange", 已补播: "green" };

export function SortableItem({ item, cumulative, risk, onStatus, onSkip, onDuration, onSwitch, onReportLoss }: {
  item: RundownItem;
  cumulative: string;
  risk?: boolean;
  onStatus: () => void;
  onSkip: () => void;
  onDuration: (delta: number) => void;
  onSwitch: () => void;
  onReportLoss: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.id, disabled: item.status === "已播出" });
  const isLive = item.type === "连线" && item.status !== "已播出";
  return (
    <article ref={setNodeRef} className={`rundown-row status-${item.status} signal-${item.signalStatus ?? "正常"}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button className="drag-handle" {...attributes} {...listeners}>⠿</button>
      <time>{cumulative}</time>
      <div className="row-main">
        <b>{item.title}{item.hardStart ? <Tag color="red" className="anchor-tag">锚点 {item.hardStart}</Tag> : null}</b>
        <small>{item.source} · {item.presenter}{item.signalStatus === "备用中" && item.backupDuration ? ` · 备用源垫片 ${item.backupDuration} 分钟` : ""}</small>
      </div>
      <Tag color={item.type === "广告" ? "gold" : item.type === "连线" ? "blue" : "geekblue"}>{item.type}</Tag>
      {item.signalStatus ? <Tag color={signalColor[item.signalStatus]}>{item.signalStatus}</Tag> : <span />}
      <span>{item.duration} 分钟</span>
      <Tag color={item.status === "已播出" ? "green" : item.status === "已跳过" ? "red" : "default"}>{item.status}</Tag>
      {risk ? <Tag color="red">赶不上锚点</Tag> : <span />}
      <div className="row-actions">
        <Button size="small" onClick={() => onDuration(-1)}>-1</Button>
        <Button size="small" onClick={() => onDuration(1)}>+1</Button>
        <Button size="small" type="primary" disabled={item.status === "已播出"} onClick={onStatus}>播出</Button>
        {isLive ? <Button size="small" onClick={onReportLoss}>信号中断</Button> : null}
        {isLive ? <Button size="small" type="dashed" onClick={onSwitch}>切备用</Button> : null}
        <Button size="small" danger disabled={item.status === "已播出"} onClick={onSkip}>取消</Button>
      </div>
    </article>
  );
}
