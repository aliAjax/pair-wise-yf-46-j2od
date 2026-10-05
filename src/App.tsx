import { useEffect, useMemo, useRef, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Button, Card, Form, Input, InputNumber, Modal, Progress, Select, Switch, Tag, Timeline, message } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { useGetRundownQuery, useSaveRundownMutation } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { addItem, addSource, adjustDuration, initialize, insertBreaking, queueChange, reorder, reportSignalLoss, resolveMakeup, retrySwitch, setOnline, setRole, setSourceOnline, skipItem, switchToBackup, syncQueue, undo, updateStatus } from "./store/rundownSlice";
import type { Role, RundownItem } from "./types";
import { computeTimeline } from "./utils/rundownMath";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

function RundownPage({ onSwitch }: { onSwitch: (item: RundownItem) => void }) {
  const dispatch = useAppDispatch();
  const { items, role, online } = useAppSelector((state) => state.rundown);
  const saveMutation = useSaveRundownMutation()[0];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const timeline = useMemo(() => computeTimeline(items), [items]);
  const total = items.reduce((sum, item) => sum + item.duration, 0);
  const riskCount = timeline.filter((entry) => entry.risk).length;
  const { control, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "主控" } });

  useEffect(() => { const timer = setTimeout(() => { void saveMutation(items); }, 250); return () => clearTimeout(timer); }, [items, saveMutation]);

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id || role !== "导播") return;
    const oldIndex = items.findIndex((item) => item.id === event.active.id);
    const newIndex = items.findIndex((item) => item.id === event.over!.id);
    dispatch(reorder(arrayMove(items, oldIndex, newIndex)));
  };

  const submit = (values: FormValues) => {
    dispatch(addItem(values));
    if (!online) dispatch(queueChange({ action: "新增条目", detail: values.title }));
    reset();
  };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading"><div><small>2026-10-08 · 08:00 开播</small><h2>直播串联单</h2></div><div className="head-actions"><Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag><Button onClick={() => dispatch(undo())} disabled={!role || role === "字幕"}>撤回上一步</Button></div></div>
      <div className="summary"><span><b>{items.length}</b> 条内容</span><span><b>{total}</b> 分钟总时长</span><span className={riskCount ? "danger-text" : ""}><b>{riskCount}</b> 个锚点风险</span><span><b>{timeline.at(-1)?.at ?? "--:--"}</b> 预计收播</span></div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className="rundown-list">{timeline.map(({ item, at, risk }) => <SortableItem key={item.id} item={item} cumulative={at} risk={risk} onDuration={(delta) => dispatch(adjustDuration({ id: item.id, delta }))} onStatus={() => dispatch(updateStatus({ id: item.id, status: "已播出" }))} onSkip={() => dispatch(skipItem(item.id))} onSwitch={() => onSwitch(item)} onReportLoss={() => dispatch(reportSignalLoss(item.id))} />)}</div>
        </SortableContext>
      </DndContext>
    </Card>
    <aside className="side-stack">
      <Card title="新增播出条目">
        <Form layout="vertical" onFinish={handleSubmit(submit)}>
          <Form.Item label="标题"><Controller name="title" control={control} render={({ field, fieldState }) => <><Input {...field} status={fieldState.error ? "error" : ""} /><small className="error">{fieldState.error?.message}</small></>} /></Form.Item>
          <div className="two-cols"><Form.Item label="类型"><Controller name="type" control={control} render={({ field }) => <Select {...field} options={["新闻片","连线","嘉宾","口播","广告"].map((v) => ({ value: v, label: v }))} />} /></Form.Item><Form.Item label="时长"><Controller name="duration" control={control} render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" />} /></Form.Item></div>
          <Form.Item label="主播"><Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Form.Item label="来源"><Controller name="source" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Button htmlType="submit" type="primary" block disabled={role === "字幕"}>加入串联单</Button>
        </Form>
      </Card>
      <BreakingForm />
    </aside>
  </div>;
}

/** 连线切换：选择备用源与垫片时长；两名导播同时提交时先到者占住信号源 */
function SwitchModal({ target, onClose }: { target: RundownItem; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const sources = useAppSelector((state) => state.rundown.sources);
  const backups = sources.filter((source) => source.kind === "备用");
  const [backupSourceId, setBackupSourceId] = useState(backups.find((source) => source.online)?.id ?? "");
  const [backupDuration, setBackupDuration] = useState(target.duration);
  const source = sources.find((entry) => entry.id === backupSourceId);
  const fit = source ? source.occupiedMinutes + backupDuration <= source.capacityMinutes : false;

  const submit = () => {
    dispatch(switchToBackup({ itemId: target.id, backupSourceId, backupDuration, expectedVersion: target.version }));
    onClose();
  };
  const demoDoubleSubmit = () => {
    // 模拟两名导播同时提交同一条连线的切换：携带相同版本，先到者占住信号源，后到者看到冲突
    dispatch(switchToBackup({ itemId: target.id, backupSourceId, backupDuration, expectedVersion: target.version }));
    dispatch(switchToBackup({ itemId: target.id, backupSourceId, backupDuration, expectedVersion: target.version }));
    onClose();
  };

  return <Modal title={`连线切换 · ${target.title}`} open onCancel={onClose} onOk={submit} okText="占住备用源并切换" cancelText="取消">
    <div className="switch-form">
      <p>当前版本 <b>v{target.version}</b>，硬时间锚点：{target.hardStart ? <Tag color="red">{target.hardStart} 时段不动</Tag> : <Tag>无</Tag>}</p>
      <label>备用源
        <Select value={backupSourceId} onChange={setBackupSourceId} options={backups.map((entry) => ({ value: entry.id, label: `${entry.name}（占用 ${entry.occupiedMinutes}/${entry.capacityMinutes} 分钟${entry.online ? "" : " · 已下线"}）`, disabled: !entry.online }))} />
      </label>
      <label>备用源垫片时长
        <InputNumber value={backupDuration} onChange={(value) => setBackupDuration(Number(value ?? 1))} min={1} max={120} addonAfter="分钟" />
      </label>
      {source ? <Tag color={fit ? "green" : "orange"}>{fit ? "容量可容纳，切换后立即重算" : "容量占满，将排队进补播清单"}</Tag> : null}
      <Button block onClick={demoDoubleSubmit}>模拟两名导播同时提交（并发冲突演示）</Button>
    </div>
  </Modal>;
}

function SignalsPage() {
  const dispatch = useAppDispatch();
  const { sources, makeup, switchAttempts } = useAppSelector((state) => state.rundown);
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState(20);
  return <div className="signals-grid">
    <Card title="信号源与备用容量">
      <div className="source-list">{sources.map((source) => <article key={source.id} className="source-row">
        <div className="source-head"><b>{source.name}</b><Tag color={source.kind === "主用" ? "geekblue" : "blue"}>{source.kind}</Tag><Tag color={source.online ? "green" : "default"}>{source.online ? "在线" : "下线"}</Tag></div>
        <Progress percent={Math.round(source.occupiedMinutes / source.capacityMinutes * 100)} size="small" format={() => `${source.occupiedMinutes}/${source.capacityMinutes} 分钟`} />
        {source.kind === "备用" ? <Switch checked={source.online} onChange={(value) => dispatch(setSourceOnline({ id: source.id, online: value }))} checkedChildren="在线" unCheckedChildren="下线" /> : null}
      </article>)}</div>
      <Form layout="inline" onFinish={() => { if (name.trim()) { dispatch(addSource({ name: name.trim(), capacityMinutes: capacity })); setName(""); } }}>
        <Form.Item label="新增备用源"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="名称" /></Form.Item>
        <Form.Item label="容量"><InputNumber value={capacity} onChange={(value) => setCapacity(Number(value ?? 1))} min={1} max={600} addonAfter="分钟" /></Form.Item>
        <Button htmlType="submit" type="primary">添加</Button>
      </Form>
    </Card>
    <Card title="补播清单"><div className="queue-list">{makeup.length ? makeup.map((entry) => <article key={entry.id}>
      <Tag color={entry.status === "待补播" ? "orange" : entry.status === "已补播" ? "green" : "default"}>{entry.status}</Tag>
      <b>{entry.title}</b><small>{entry.reason} · 垫片 {entry.duration} 分钟 · {format(new Date(entry.queuedAt), "HH:mm:ss")}</small>
      {entry.status === "待补播" ? <span className="makeup-actions"><Button size="small" type="primary" onClick={() => dispatch(resolveMakeup({ entryId: entry.id, resolution: "补播" }))}>补播</Button><Button size="small" danger onClick={() => dispatch(resolveMakeup({ entryId: entry.id, resolution: "放弃" }))}>放弃</Button></span> : null}
    </article>) : <p>备用源容量占满时，未播内容将排队到这里。</p>}</div></Card>
    <Card title="连线切换记录"><Timeline items={switchAttempts.map((attempt) => ({ color: attempt.error ? "red" : attempt.warning ? "orange" : "green", children: <div>
      <b>{attempt.itemTitle}</b> <Tag>{attempt.backupSourceName}</Tag> <small>垫片 {attempt.backupDuration} 分钟 · v{attempt.expectedVersion}</small>
      <div className="step-line">{attempt.steps.map((step) => <Tag key={step.name} color={step.status === "done" ? "green" : step.status === "failed" ? "red" : "default"}>{step.label}{step.status === "failed" ? " ✗" : step.status === "done" ? " ✓" : " …"}{step.error ? `：${step.error}` : ""}</Tag>)}</div>
      {attempt.error ? <small className="danger-text">{attempt.error}</small> : null}{attempt.warning ? <small className="warning-text">{attempt.warning}</small> : null}
      {attempt.steps.some((step) => step.status === "failed") ? <Button size="small" type="primary" onClick={() => dispatch(retrySwitch(attempt.id))}>只重试未完成步骤</Button> : null}
      <small>{format(new Date(attempt.createdAt), "HH:mm:ss")}</small>
    </div> }))} /></Card>
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

function ChainPage({ mode }: { mode: "changes" | "queue" | "history" | "signals" }) {
  const state = useAppSelector((root) => root.rundown);
  if (mode === "signals") return <SignalsPage />;
  if (mode === "queue") return <Card title="本地应急队列"><div className="queue-list">{state.queue.length ? state.queue.map((item) => <article key={item.id}><Tag color="red">{item.action}</Tag><b>{item.detail}</b><small>{format(new Date(item.queuedAt), "HH:mm:ss")}</small></article>) : <p>当前没有待同步操作。</p>}</div><Button type="primary" disabled={state.online} onClick={() => { dispatchSync(); }}>主链路恢复后提交</Button></Card>;
  if (mode === "changes") return <Card title="突发变更记录"><Timeline items={state.changes.map((item) => ({ children: <div><b>{item.headline}</b><p>{item.reason} · 插播 {item.duration} 分钟</p><small>{format(new Date(item.createdAt), "HH:mm:ss")}</small></div> }))} /></Card>;
  return <Card title="操作历史"><Timeline items={state.history.map((entry) => ({ color: "blue", children: <div><b>{entry.label}</b><p>{entry.detail}</p><small>{format(new Date(entry.time), "HH:mm:ss")}</small></div> }))} /></Card>;
}

function dispatchSync() {
  window.dispatchEvent(new Event("sync-queue"));
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { data = [] } = useGetRundownQuery();
  const { t, i18n } = useTranslation();
  const [switchTarget, setSwitchTarget] = useState<RundownItem | null>(null);
  const attempts = useAppSelector((root) => root.rundown.switchAttempts);
  const lastAttemptRef = useRef<string>("");

  useEffect(() => { if (data.length) dispatch(initialize(data)); }, [data, dispatch]);
  useEffect(() => {
    const handler = () => { dispatch(syncQueue()); message.success("应急队列已同步"); };
    window.addEventListener("sync-queue", handler);
    return () => window.removeEventListener("sync-queue", handler);
  }, [dispatch]);
  useEffect(() => {
    const latest = attempts[0];
    if (latest && latest.id !== lastAttemptRef.current) {
      lastAttemptRef.current = latest.id;
      if (latest.error?.includes("冲突")) message.warning(latest.error);
      else if (latest.error) message.info(latest.error);
      else if (latest.warning) message.warning(latest.warning);
      else message.success(`已切至备用源「${latest.backupSourceName}」，时长已按 ${latest.backupDuration} 分钟重算`);
    }
  }, [attempts]);

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Control room</small></div></div><nav><NavLink to="/">{t("rundown")}</NavLink><NavLink to="/signals">{t("signals")}</NavLink><NavLink to="/changes">{t("changes")}</NavLink><NavLink to="/queue">{t("queue")} {state.queue.length ? <em>{state.queue.length}</em> : null}</NavLink></nav><Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside>
    <main><header className="topbar"><div><small>直播运行中 · 紧急操作均保留审计记录</small><h1>{t("title")}</h1></div><div className="top-actions"><label>在线模式 <Switch checked={state.online} onChange={(value) => dispatch(setOnline(value))} /></label><label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={[{value:"导播"},{value:"主编"},{value:"字幕"},{value:"演播室"}]} /></label></div></header><Routes><Route path="/" element={<RundownPage onSwitch={setSwitchTarget} />} /><Route path="/signals" element={<ChainPage mode="signals" />} /><Route path="/changes" element={<ChainPage mode="changes" />} /><Route path="/queue" element={<ChainPage mode="queue" />} /><Route path="/history" element={<ChainPage mode="history" />} /></Routes></main>
    {switchTarget ? <SwitchModal key={switchTarget.id} target={switchTarget} onClose={() => setSwitchTarget(null)} /> : null}
  </div>;
}
