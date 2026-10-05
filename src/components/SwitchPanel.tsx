import { useEffect, useMemo, useState } from "react";
import { Button, Card, Empty, Select, Switch, Tag, Tooltip } from "antd";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { closeSwitch } from "../store/rundownSlice";
import { retrySwitchRequest, submitSwitch } from "../store/switchThunks";
import { remainingCapacity } from "../engine/schedule";
import type { SignalSource } from "../types";

const statusColor: Record<string, string> = {
  进行中: "processing",
  切换成功: "success",
  切换失败: "error",
  冲突驳回: "warning"
};

export function SwitchPanel({ focusItemId }: { focusItemId: string | null }) {
  const dispatch = useAppDispatch();
  const { items, sources, uses, switches, itemLocks, sourceLocks, operator } = useAppSelector((s) => s.rundown);
  const firstLink = items.find((i) => i.type === "连线" && i.status !== "已播出")?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(focusItemId ?? firstLink);
  const [targetId, setTargetId] = useState<string | undefined>();
  const [simulateFailure, setSimulateFailure] = useState(false);

  useEffect(() => { if (focusItemId) setSelectedId(focusItemId); }, [focusItemId]);

  const linkOptions = useMemo(
    () => items.filter((i) => i.type === "连线" && i.status !== "已播出").map((i) => ({ value: i.id, label: `${i.title}（信号${i.signal ?? "—"}）` })),
    [items]
  );
  const item = items.find((i) => i.id === selectedId) ?? null;
  const lockedHere = item ? Boolean(itemLocks[item.id]) : false;
  const targetLocked = targetId ? Boolean(sourceLocks[targetId]) : false;

  const sourceOptions = sources.map((source: SignalSource) => ({
    value: source.id,
    disabled: source.signal === "断",
    label: source.kind === "backup"
      ? `${source.name}（剩余 ${remainingCapacity(source, uses)}/${source.capacity} 分钟）${source.signal === "断" ? "· 信号断" : ""}`
      : `${source.name}${source.signal === "断" ? "· 信号断" : ""}`
  }));

  const submit = () => {
    if (!item || !targetId) return;
    void dispatch(submitSwitch({ itemId: item.id, targetSourceId: targetId, simulateFailure }));
  };

  return <Card title="连线切换（双导播抢源）" className="switch-card">
    <small>当前提交人：<b>{operator}</b>（顶栏切换导播甲 / 导播乙，可模拟两人同时提交）</small>
    <Select
      placeholder="选择连线条目"
      value={item?.id}
      options={linkOptions}
      onChange={setSelectedId}
      style={{ width: "100%" }}
    />
    <div className="switch-row">
      <Select
        placeholder="目标信号源"
        value={targetId}
        onChange={setTargetId}
        options={sourceOptions}
        style={{ flex: 1 }}
      />
      <Tooltip title="让「执行切换」这一步失败，用于验证：保留原排期、只重试未成功步骤">
        <label className="fail-toggle"><Switch size="small" checked={simulateFailure} onChange={setSimulateFailure} />模拟失败</label>
      </Tooltip>
    </div>
    <Button type="primary" block disabled={!item || !targetId || lockedHere || targetLocked} onClick={submit}>
      {lockedHere || targetLocked ? "信号源已被先到者占用" : "提交切换"}
    </Button>
    {item && <small className="hint">先到者占住连线与目标源；后到者看到冲突，切换失败则保留原排期。</small>}

    <div className="switch-list">
      {switches.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无切换请求" />}
      {switches.slice(0, 6).map((req) => (
        <article key={req.id} className={`switch-item switch-${req.status}`}>
          <header>
            <b>{req.itemTitle}</b>
            <Tag color={statusColor[req.status]}>{req.status}</Tag>
          </header>
          <small>→ {req.targetSourceName} · {req.operator}</small>
          {req.conflictWith && <small className="conflict-text">冲突：该连线/信号源已被先到的切换请求占住</small>}
          <div className="step-dots">
            {req.steps.map((step) => (
              <Tag key={step.key} color={step.state === "成功" ? "green" : step.state === "失败" ? "red" : "default"}>
                {step.label}{step.state === "成功" ? " ✓" : step.state === "失败" ? " ✗" : ""}
              </Tag>
            ))}
          </div>
          {req.status === "切换失败" && <small className="conflict-text">{req.steps.find((s) => s.state === "失败")?.error}（原排期已保留）</small>}
          <div className="switch-actions">
            {req.status === "切换失败" && <Button size="small" type="primary" onClick={() => void dispatch(retrySwitchRequest(req.id))}>只重试失败步骤</Button>}
            {(req.status === "切换成功" || req.status === "冲突驳回" || req.status === "切换失败") && <Button size="small" onClick={() => dispatch(closeSwitch({ requestId: req.id }))}>关闭</Button>}
          </div>
        </article>
      ))}
    </div>
  </Card>;
}
