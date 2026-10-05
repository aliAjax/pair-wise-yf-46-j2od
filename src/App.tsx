import { useEffect, useMemo, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Badge, Button, Card, Form, Input, InputNumber, Select, Switch, Tag, Timeline, message } from "antd";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { format } from "date-fns";
import { SortableItem } from "./components/SortableItem";
import { SwitchPanel } from "./components/SwitchPanel";
import { SourceBoard } from "./components/SourceBoard";
import { MakeupPage } from "./components/MakeupPage";
import { useGetRundownQuery, useSaveRundownMutation } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  ackRisk,
  addItem,
  adjustDuration,
  initialize,
  insertBreaking,
  queueChange,
  reorder,
  setOnline,
  setOperator,
  setRole,
  signalLost,
  signalRestore,
  skipItem,
  syncQueue,
  undo,
  updateStatus
} from "./store/rundownSlice";
import { computeSchedule, describeRisk } from "./engine/schedule";
import type { ItemType, Role, RundownItem } from "./types";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

function RundownPage() {
  const dispatch = useAppDispatch();
  const { items, role, online, sources, uses, makeup, itemLocks, acknowledgedRisks } = useAppSelector((state) => state.rundown);
  const saveMutation = useSaveRundownMutation()[0];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const canDirect = role === "导播";
  const schedule = useMemo(() => computeSchedule(items), [items]);
  const rowById = useMemo(() => new Map(schedule.map((row) => [row.item.id, row])), [schedule]);

  const total = items.filter((i) => i.status !== "已跳过" && i.status !== "排队补播").reduce((sum, item) => sum + item.duration, 0);
  const risks = schedule.filter((row) => row.atRisk);
  const unackedRisks = risks.filter((row) => !acknowledgedRisks.includes(row.item.id));
  const backupUsed = uses.reduce((sum, u) => sum + u.minutes, 0);
  const backupTotal = sources.filter((s) => s.kind === "backup").reduce((sum, s) => sum + s.capacity, 0);
  const pendingMakeup = makeup.filter((m) => m.status === "排队中").length;
  const { control, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "主控" } });

  const [focusSwitch, setFocusSwitch] = useState<string | null>(null);

  useEffect(() => { const timer = setTimeout(() => { void saveMutation(items); }, 250); return () => clearTimeout(timer); }, [items, saveMutation]);

  useEffect(() => {
    unackedRisks.forEach((row) => message.warning({ content: describeRisk(row), key: `risk-${row.item.id}`, duration: 3 }));
  }, [unackedRisks]);

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id || !canDirect) return;
    // 硬锚点不参与拖动，锚点之间的相对顺序保持不动
    const movable = items.filter((i) => !i.hardStart && i.status !== "已播出");
    const oldIndex = movable.findIndex((item) => item.id === event.active.id);
    const newIndex = movable.findIndex((item) => item.id === event.over!.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const moved = arrayMove(movable, oldIndex, newIndex);
    const next: RundownItem[] = [];
    let m = 0;
    for (const item of items) {
      if (!item.hardStart && item.status !== "已播出") next.push(moved[m++]);
      else next.push(item);
    }
    dispatch(reorder(next));
  };

  const submit = (values: FormValues) => {
    dispatch(addItem(values));
    if (!online) dispatch(queueChange({ action: "新增条目", detail: values.title }));
    reset();
  };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading"><div><small>2026-10-08 · 08:00 开播 · 整点新闻/签约广告时段钉死</small><h2>直播串联单</h2></div><div className="head-actions"><Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag><Button onClick={() => dispatch(undo())} disabled={!canDirect}>撤回上一步</Button></div></div>
      <div className="summary">
        <span><b>{items.length}</b> 条内容</span>
        <span><b>{total}</b> 分钟总时长</span>
        <span className={risks.length ? "danger-text" : ""}><b>{risks.length}</b> 个硬时间风险{unackedRisks.length ? `（${unackedRisks.length} 未点名）` : ""}</span>
        <span className={pendingMakeup ? "danger-text" : ""}><b>{pendingMakeup}</b> 条排队补播</span>
        <span className={backupUsed >= backupTotal ? "danger-text" : ""}><b>{backupUsed}/{backupTotal}</b> 备用容量（分钟）</span>
        <span><b>{schedule.at(-1)?.at ?? "--:--"}</b> 预计收播</span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className="rundown-list">{schedule.map(({ item, at, atRisk, riskMinutes }) => <SortableItem
            key={item.id}
            item={item}
            cumulative={at}
            atRisk={atRisk}
            riskMinutes={riskMinutes}
            riskAcked={acknowledgedRisks.includes(item.id)}
            locked={Boolean(itemLocks[item.id])}
            canDirect={canDirect}
            onDuration={(delta) => dispatch(adjustDuration({ id: item.id, delta }))}
            onStatus={() => dispatch(updateStatus({ id: item.id, status: "已播出" }))}
            onSkip={() => dispatch(skipItem(item.id))}
            onSignalLost={() => { dispatch(signalLost({ id: item.id })); message.warning(`「${item.title}」信号中断，已按备用容量处理`); }}
            onRestore={() => dispatch(signalRestore({ id: item.id }))}
            onSwitch={() => setFocusSwitch(item.id)}
            onAckRisk={() => { dispatch(ackRisk(item.id)); message.success(`已点名：${describeRisk(rowById.get(item.id)!)}`); }}
          />)}</div>
        </SortableContext>
      </DndContext>
    </Card>
    <aside className="side-stack">
      <SwitchPanel focusItemId={focusSwitch} />
      <Card title="信号源与备用容量" className="sources-card"><SourceBoard /></Card>
      <Card title="新增播出条目">
        <Form layout="vertical" onFinish={handleSubmit(submit)}>
          <Form.Item label="标题"><Controller name="title" control={control} render={({ field, fieldState }) => <><Input {...field} status={fieldState.error ? "error" : ""} /><small className="error">{fieldState.error?.message}</small></>} /></Form.Item>
          <div className="two-cols"><Form.Item label="类型"><Controller name="type" control={control} render={({ field }) => <Select {...field} options={["新闻片","连线","嘉宾","口播","广告"].map((v) => ({ value: v, label: v }))} />} /></Form.Item><Form.Item label="时长"><Controller name="duration" control={control} render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" />} /></Form.Item></div>
          <Form.Item label="主播"><Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Form.Item label="来源"><Controller name="source" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Button htmlType="submit" type="primary" block disabled={!canDirect}>加入串联单</Button>
        </Form>
      </Card>
      <BreakingForm />
    </aside>
  </div>;
}

function BreakingForm() {
  const dispatch = useAppDispatch();
  const { items, online } = useAppSelector((state) => state.rundown);
  const [values, setValues] = useState({ headline: "", duration: 5, insertAfter: items[0]?.id ?? "", reason: "突发新闻" });
  return <Card title="突发插播" className="breaking-card">
    <Input value={values.headline} onChange={(event) => setValues({ ...values, headline: event.target.value })} placeholder="插播标题" />
    <div className="two-cols"><InputNumber value={values.duration} onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })} addonAfter="分钟" /><Select value={values.insertAfter} onChange={(value) => setValues({ ...values, insertAfter: value })} options={items.map((item) => ({ value: item.id, label: `插在「${item.title}」后` }))} /></div>
    <Input value={values.reason} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="插播原因" />
    <Button type="primary" danger block disabled={values.headline.length < 2} onClick={() => { dispatch(insertBreaking(values)); if (!online) message.warning("已进入本地应急队列"); setValues({ ...values, headline: "" }); }}>立即插入并重算时长</Button>
    {!online && <small>离线操作将在主链路恢复后统一提交，当前顺序仍可用于本地播出。</small>}
  </Card>;
}

function ChainPage({ mode }: { mode: "changes" | "queue" | "history" }) {
  const state = useAppSelector((root) => root.rundown);
  const dispatch = useAppDispatch();
  if (mode === "queue") return <Card title="本地应急队列"><div className="queue-list">{state.queue.length ? state.queue.map((item) => <article key={item.id}><Tag color="red">{item.action}</Tag><b>{item.detail}</b><small>{format(new Date(item.queuedAt), "HH:mm:ss")}</small></article>) : <p>当前没有待同步操作。</p>}</div><Button type="primary" disabled={state.online} onClick={() => { dispatch(syncQueue()); message.success("应急队列已同步"); }}>主链路恢复后提交</Button></Card>;
  if (mode === "changes") return <Card title="突发变更记录"><Timeline items={state.changes.map((item) => ({ children: <div><b>{item.headline}</b><p>{item.reason} · 插播 {item.duration} 分钟</p><small>{format(new Date(item.createdAt), "HH:mm:ss")}</small></div> }))} /></Card>;
  return <Card title="操作历史"><Timeline items={state.history.map((entry) => ({ color: "blue", children: <div><b>{entry.label}</b><p>{entry.detail}</p><small>{format(new Date(entry.time), "HH:mm:ss")}</small></div> }))} /></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { data = [] } = useGetRundownQuery();
  const { t, i18n } = useTranslation();
  useEffect(() => { if (data.length) dispatch(initialize(data)); }, [data, dispatch]);

  const pendingMakeup = state.makeup.filter((m) => m.status === "排队中").length;
  const schedule = useMemo(() => computeSchedule(state.items), [state.items]);
  const riskCount = schedule.filter((r) => r.atRisk).length;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Control room</small></div></div>
      <nav>
        <NavLink to="/">{t("rundown")}</NavLink>
        <NavLink to="/makeup"><Badge count={pendingMakeup} size="small" offset={[10, 0]}>{t("makeup")}</Badge></NavLink>
        <NavLink to="/changes">{t("changes")}</NavLink>
        <NavLink to="/queue">{t("queue")} {state.queue.length ? <em>{state.queue.length}</em> : null}</NavLink>
        <NavLink to="/history">{t("history")}</NavLink>
      </nav>
      <Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button>
    </aside>
    <main>
      <header className="topbar">
        <div><small>直播运行中 · 风险 {riskCount} · 补播 {pendingMakeup} · 紧急操作均保留审计记录</small><h1>{t("title")}</h1></div>
        <div className="top-actions">
          <label>在线模式 <Switch checked={state.online} onChange={(value) => dispatch(setOnline(value))} /></label>
          <label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={[{value:"导播"},{value:"主编"},{value:"字幕"},{value:"演播室"}]} /></label>
          <label>导播席位 <Select value={state.operator} onChange={(value) => dispatch(setOperator(value))} options={[{value:"导播甲"},{value:"导播乙"}]} style={{width:100}} /></label>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<RundownPage />} />
        <Route path="/makeup" element={<MakeupPage />} />
        <Route path="/changes" element={<ChainPage mode="changes" />} />
        <Route path="/queue" element={<ChainPage mode="queue" />} />
        <Route path="/history" element={<ChainPage mode="history" />} />
      </Routes>
    </main>
  </div>;
}
