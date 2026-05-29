import './agent-jobs.css';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { FolderBrowserModal } from './code-workspace.jsx';

// ─── helpers ──────────────────────────────────────────────────────────────────
const STATUS_META = {
  idle:      { label: 'Idle',      color: '#6b7280', bg: 'rgba(107,114,128,0.12)', dot: '#6b7280' },
  running:   { label: 'Running',   color: '#60a5fa', bg: 'rgba(96,165,250,0.12)',  dot: '#60a5fa', pulse: true },
  completed: { label: 'Done',      color: '#34d399', bg: 'rgba(52,211,153,0.12)',  dot: '#34d399' },
  failed:    { label: 'Failed',    color: '#f87171', bg: 'rgba(248,113,113,0.12)', dot: '#f87171' },
  timeout:   { label: 'Timeout',   color: '#fb923c', bg: 'rgba(251,146,60,0.12)',  dot: '#fb923c' },
  cancelled: { label: 'Cancelled', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)', dot: '#a78bfa' },
};

const WEEKDAYS = [
  { label: 'Mon', short: 'Mo', value: 1 },
  { label: 'Tue', short: 'Tu', value: 2 },
  { label: 'Wed', short: 'We', value: 3 },
  { label: 'Thu', short: 'Th', value: 4 },
  { label: 'Fri', short: 'Fr', value: 5 },
  { label: 'Sat', short: 'Sa', value: 6 },
  { label: 'Sun', short: 'Su', value: 0 },
];

const ORDINAL = (n) => {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

function parseCronParts(cron) {
  if (!cron) return null;
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return null;
  return { min: p[0], hour: p[1], dom: p[2], month: p[3], dow: p[4] };
}

function parseDow(dow) {
  if (!dow || dow === '*') return [];
  const nums = [];
  for (const seg of dow.split(',')) {
    if (seg.includes('-')) {
      const [s, e] = seg.split('-').map(Number);
      for (let i = s; i <= e; i++) nums.push(i);
    } else {
      const n = parseInt(seg, 10);
      if (!isNaN(n)) nums.push(n);
    }
  }
  return nums;
}

function nextRunFromCron(cron, from = new Date()) {
  if (!cron) return null;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const match = (field, val) => {
    if (field === '*') return true;
    if (field.includes(',')) return field.split(',').some(f => match(f, val));
    if (field.includes('/')) {
      const [s, step] = field.split('/');
      const startV = s === '*' ? 0 : +s;
      return (val - startV) % (+step || 1) === 0;
    }
    if (field.includes('-')) {
      const [s, e] = field.split('-').map(Number);
      return val >= s && val <= e;
    }
    return +field === val;
  };
  const test = (d) =>
    match(fields[0], d.getMinutes()) &&
    match(fields[1], d.getHours()) &&
    match(fields[2], d.getDate()) &&
    match(fields[3], d.getMonth() + 1) &&
    match(fields[4], d.getDay());

  const cur = new Date(from);
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (test(cur)) return new Date(cur);
    cur.setMinutes(cur.getMinutes() + 1);
  }
  return null;
}

function fmtDuration(ms) {
  if (ms < 0) return '—';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function fmtAgo(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function fmtIn(ts) {
  if (!ts) return '—';
  const diff = new Date(ts).getTime() - Date.now();
  if (diff < 0) return 'due now';
  if (diff < 60000) return 'in <1m';
  if (diff < 3600000) return `in ${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `in ${Math.floor(diff / 3600000)}h ${Math.floor((diff % 3600000) / 60000)}m`;
  return `in ${Math.floor(diff / 86400000)}d`;
}

function fmtNextRun(date) {
  if (!date) return '—';
  const opts = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  return new Intl.DateTimeFormat(undefined, opts).format(date);
}

function buildSimpleCron({ kind, interval, unit, hour, minute, weekDays, monthDay }) {
  if (kind !== 'recurring') return '';
  const i = Math.max(1, parseInt(interval, 10) || 1);
  const m = Math.max(0, Math.min(59, parseInt(minute, 10) || 0));
  const h = Math.max(0, Math.min(23, parseInt(hour, 10) || 0));
  switch (unit) {
    case 'minute': return i === 1 ? '* * * * *' : `*/${i} * * * *`;
    case 'hour':   return i === 1 ? `${m} * * * *` : `${m} */${i} * * *`;
    case 'day':    return i === 1 ? `${m} ${h} * * *` : `${m} ${h} */${i} * *`;
    case 'week': {
      if (!weekDays?.length) return `${m} ${h} * * *`;
      return `${m} ${h} * * ${[...weekDays].sort((a, b) => a - b).join(',')}`;
    }
    case 'month': return `${m} ${h} ${monthDay || 1} * *`;
    default: return '';
  }
}

function detectSimple(cron) {
  if (!cron) return { kind: 'manual', interval: 1, unit: 'day', hour: 9, minute: 0, weekDays: [1,2,3,4,5], monthDay: 1 };
  const p = parseCronParts(cron);
  if (!p) return null;
  const { min: m, hour: h, dom, month, dow } = p;
  if (month !== '*') return null;
  const base = { kind: 'recurring', interval: 1, unit: 'day', hour: 9, minute: 0, weekDays: [1,2,3,4,5], monthDay: 1 };
  if (m === '*' && h === '*' && dom === '*' && dow === '*') return { ...base, unit: 'minute', interval: 1 };
  const minStep = m.match(/^\*\/(\d+)$/);
  if (minStep && h === '*' && dom === '*' && dow === '*') return { ...base, unit: 'minute', interval: +minStep[1] };
  if (!/^\d+$/.test(m)) return null;
  const minV = +m;
  if (h === '*' && dom === '*' && dow === '*') return { ...base, unit: 'hour', interval: 1, minute: minV };
  const hrStep = h.match(/^\*\/(\d+)$/);
  if (hrStep && dom === '*' && dow === '*') return { ...base, unit: 'hour', interval: +hrStep[1], minute: minV };
  if (!/^\d+$/.test(h)) return null;
  const hourV = +h;
  if (dom === '*' && dow !== '*') {
    const days = parseDow(dow);
    if (!days.length) return null;
    return { ...base, unit: 'week', interval: 1, hour: hourV, minute: minV, weekDays: days };
  }
  if (dom === '*' && dow === '*') return { ...base, unit: 'day', interval: 1, hour: hourV, minute: minV };
  const domStep = dom.match(/^\*\/(\d+)$/);
  if (domStep && dow === '*') return { ...base, unit: 'day', interval: +domStep[1], hour: hourV, minute: minV };
  if (/^\d+$/.test(dom) && dow === '*') return { ...base, unit: 'month', interval: 1, hour: hourV, minute: minV, monthDay: +dom };
  return null;
}

function cronToEnglish(cron) {
  if (!cron) return 'No schedule — run manually.';
  const p = parseCronParts(cron);
  if (!p) return 'Invalid cron expression.';
  const detected = detectSimple(cron);
  const pad = (n) => String(n).padStart(2, '0');
  if (detected && detected.kind === 'recurring') {
    const t = `${pad(detected.hour)}:${pad(detected.minute)}`;
    const everyN = (label) => detected.interval === 1 ? `every ${label}` : `every ${detected.interval} ${label}s`;
    switch (detected.unit) {
      case 'minute': return `Runs ${everyN('minute')}.`;
      case 'hour':   return `Runs ${everyN('hour')} at :${pad(detected.minute)}.`;
      case 'day':    return `Runs ${everyN('day')} at ${t}.`;
      case 'week': {
        const names = [...detected.weekDays].sort((a, b) => a - b).map(d => WEEKDAYS.find(w => w.value === d)?.label).filter(Boolean);
        return names.length === 7 ? `Runs every day at ${t}.` :
               names.length === 5 && names.every(n => ['Mon','Tue','Wed','Thu','Fri'].includes(n)) ? `Runs every weekday at ${t}.` :
               `Runs on ${names.join(', ')} at ${t}.`;
      }
      case 'month':  return `Runs on the ${ORDINAL(detected.monthDay)} of each month at ${t}.`;
    }
  }
  return `Custom: ${cron}`;
}

// Local datetime string for <input type="datetime-local">
function toLocalDTString(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Default datetime ~5min from now
function defaultRunAt() {
  const d = new Date(Date.now() + 5 * 60000);
  d.setSeconds(0, 0);
  return d.toISOString();
}

const AGENT_GLYPHS = { claude: '💬', 'claude-code': '💬', gemini: '✦', antigravity: '🚀', codex: '⬡', opencode: '🔏', kilocode: '⚡', kilo: '⚡', ollama: '🦙', shell: '›_', aider: '🤖' };

// ─── Schedule Picker ──────────────────────────────────────────────────────────
// Emits { schedule, runAt } — schedule is cron string (recurring), runAt is ISO (one-time)
function SchedulePicker({ schedule: initSchedule, runAt: initRunAt, onChange, tz }) {
  const initial = useMemo(() => detectSimple(initSchedule), [initSchedule]);
  const initMode = initRunAt ? 'once' : (initSchedule ? (initial ? 'simple' : 'advanced') : 'manual');

  const [mode, setMode]         = useState(initMode);
  const [runAt, setRunAt]       = useState(initRunAt || defaultRunAt());
  const [advanced, setAdvanced] = useState(initSchedule || '');

  const def = initial || { kind: 'recurring', interval: 1, unit: 'day', hour: 9, minute: 0, weekDays: [1,2,3,4,5], monthDay: 1 };
  const [interval, setInterval] = useState(def.interval);
  const [unit,     setUnit]     = useState(def.unit);
  const [hour,     setHour]     = useState(def.hour);
  const [minute,   setMinute]   = useState(def.minute);
  const [weekDays, setWeekDays] = useState(def.weekDays);
  const [monthDay, setMonthDay] = useState(def.monthDay);

  const simpleCron = useMemo(() =>
    buildSimpleCron({ kind: 'recurring', interval, unit, hour, minute, weekDays, monthDay }),
    [interval, unit, hour, minute, weekDays, monthDay]
  );

  const emitRef = useRef(null);
  useEffect(() => {
    let schedule = null, newRunAt = null;
    if (mode === 'once')     newRunAt = runAt ? new Date(runAt).toISOString() : null;
    else if (mode === 'simple')   schedule = simpleCron || null;
    else if (mode === 'advanced') schedule = advanced.trim() || null;
    const val = { schedule, runAt: newRunAt };
    const key = JSON.stringify(val);
    if (emitRef.current !== key) { emitRef.current = key; onChange(val); }
  }, [mode, runAt, simpleCron, advanced, onChange]);

  const toggleDay = (d) =>
    setWeekDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);

  const next = mode === 'simple' ? nextRunFromCron(simpleCron) : mode === 'advanced' ? nextRunFromCron(advanced.trim()) : null;
  const cronDisplay = mode === 'simple' ? simpleCron : advanced.trim();

  const MODES = [
    { id: 'manual',   label: 'Manual' },
    { id: 'once',     label: 'Run Once' },
    { id: 'simple',   label: 'Recurring' },
    { id: 'advanced', label: 'Cron' },
  ];

  return (
    <div className="sp-root">
      <div className="sp-mode-tabs">
        {MODES.map(m => (
          <button key={m.id} type="button"
            className={`sp-mode-tab ${mode === m.id ? 'is-active' : ''}`}
            onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'manual' && (
        <div className="sp-body sp-body--empty">
          <span className="sp-muted">▶ Run manually using the Run Now button.</span>
        </div>
      )}

      {mode === 'once' && (
        <div className="sp-body">
          <div className="sp-row">
            <span className="sp-label">Date &amp; time</span>
            <input
              type="datetime-local"
              className="sp-datetime"
              value={toLocalDTString(runAt)}
              min={toLocalDTString(new Date().toISOString())}
              onChange={e => {
                const v = e.target.value;
                if (v) setRunAt(new Date(v).toISOString());
              }}
            />
            {tz && <span className="sp-tz">{tz}</span>}
          </div>
          {runAt && (
            <div className="sp-footer">
              <span className="sp-next">⏰ <strong>{fmtNextRun(new Date(runAt))}</strong> <span className="sp-muted">({fmtIn(runAt)})</span></span>
            </div>
          )}
        </div>
      )}

      {mode === 'simple' && (
        <div className="sp-body">
          <div className="sp-row">
            <span className="sp-label">Every</span>
            <input type="number" className="sp-num" min={1} max={59}
              value={interval} onChange={e => setInterval(Math.max(1, parseInt(e.target.value) || 1))} />
            <select className="sp-sel" value={unit} onChange={e => setUnit(e.target.value)}>
              <option value="minute">{interval === 1 ? 'minute' : 'minutes'}</option>
              <option value="hour">{interval === 1 ? 'hour' : 'hours'}</option>
              <option value="day">{interval === 1 ? 'day' : 'days'}</option>
              <option value="week">week</option>
              <option value="month">month</option>
            </select>
          </div>

          {(unit === 'day' || unit === 'week' || unit === 'month') && (
            <div className="sp-row">
              <span className="sp-label">At</span>
              <input type="time" className="sp-time"
                value={`${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`}
                onChange={e => {
                  const [h, m] = e.target.value.split(':').map(Number);
                  if (!isNaN(h)) setHour(h);
                  if (!isNaN(m)) setMinute(m);
                }}
              />
              {tz && <span className="sp-tz">{tz}</span>}
            </div>
          )}

          {unit === 'hour' && (
            <div className="sp-row">
              <span className="sp-label">At minute</span>
              <input type="number" className="sp-num" min={0} max={59}
                value={minute} onChange={e => setMinute(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))} />
              <span className="sp-hint">past each hour</span>
            </div>
          )}

          {unit === 'week' && (
            <div className="sp-row sp-row--days">
              <span className="sp-label">On</span>
              <div className="sp-day-pills">
                {WEEKDAYS.map(d => (
                  <button key={d.value} type="button"
                    className={`sp-day-btn ${weekDays.includes(d.value) ? 'is-on' : ''}`}
                    onClick={() => toggleDay(d.value)}>{d.short}</button>
                ))}
              </div>
              <div className="sp-day-presets">
                <button type="button" className="sp-preset-link" onClick={() => setWeekDays([1,2,3,4,5])}>Weekdays</button>
                <button type="button" className="sp-preset-link" onClick={() => setWeekDays([6,0])}>Weekend</button>
                <button type="button" className="sp-preset-link" onClick={() => setWeekDays([0,1,2,3,4,5,6])}>All</button>
              </div>
            </div>
          )}

          {unit === 'month' && (
            <div className="sp-row">
              <span className="sp-label">Day</span>
              <select className="sp-sel" value={monthDay} onChange={e => setMonthDay(+e.target.value)}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                  <option key={d} value={d}>{ORDINAL(d)}</option>
                ))}
              </select>
              <span className="sp-hint">of each month</span>
            </div>
          )}

          <div className="sp-footer">
            {next ? (
              <span className="sp-next">⏰ Next: <strong>{fmtNextRun(next)}</strong> <span className="sp-muted">({fmtIn(next)})</span></span>
            ) : <span className="sp-muted">No upcoming match.</span>}
            {cronDisplay && <code className="sp-cron-pill">{cronDisplay}</code>}
          </div>
        </div>
      )}

      {mode === 'advanced' && (
        <div className="sp-body">
          <div className="sp-row">
            <span className="sp-label">Cron</span>
            <input className="sp-cron-input"
              value={advanced}
              onChange={e => setAdvanced(e.target.value)}
              placeholder="min hr dom mon dow — e.g. 0 9 * * 1-5"
              spellCheck={false} />
          </div>
          <div className="sp-footer">
            <span className="sp-hint">{cronToEnglish(advanced.trim())}</span>
            {next && <span className="sp-next"> · Next: <strong>{fmtNextRun(next)}</strong> <span className="sp-muted">({fmtIn(next)})</span></span>}
            {cronDisplay && <code className="sp-cron-pill">{cronDisplay}</code>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status, size = 'md' }) {
  const m = STATUS_META[status] || STATUS_META.idle;
  return (
    <span className={`aj-badge aj-badge--${size}`} style={{ color: m.color, background: m.bg }}>
      <span className={`aj-dot${m.pulse ? ' aj-dot--pulse' : ''}`} style={{ background: m.dot }} />
      {m.label}
    </span>
  );
}

function ScheduleLabel({ schedule, runAt }) {
  if (runAt) {
    const d = new Date(runAt);
    if (d > new Date()) return <span className="aj-mono aj-schedule-tag" title={runAt}>⏰ {fmtNextRun(d)}</span>;
    return <span className="aj-muted">Once (past)</span>;
  }
  if (!schedule) return <span className="aj-muted">Manual</span>;
  const detected = detectSimple(schedule);
  const p = parseCronParts(schedule);
  let label = schedule;
  if (detected && p) {
    const pad = (n) => String(n).padStart(2, '0');
    const t = `${pad(detected.hour)}:${pad(detected.minute)}`;
    switch (detected.unit) {
      case 'minute': label = detected.interval === 1 ? 'Every min' : `Every ${detected.interval}m`; break;
      case 'hour':   label = detected.interval === 1 ? `Hourly :${pad(detected.minute)}` : `Every ${detected.interval}h`; break;
      case 'day':    label = detected.interval === 1 ? `Daily ${t}` : `Every ${detected.interval}d ${t}`; break;
      case 'week': {
        const days = detected.weekDays.sort((a,b)=>a-b).map(d=>WEEKDAYS.find(w=>w.value===d)?.short).join('');
        label = `${days || '—'} ${t}`; break;
      }
      case 'month': label = `${ORDINAL(detected.monthDay)} ${t}`; break;
    }
  }
  return <span className="aj-mono aj-schedule-tag" title={schedule}>{label}</span>;
}

// ─── Live output via SSE ──────────────────────────────────────────────────────
function LiveOutput({ jobId, runId, isRunning, existingOutput }) {
  const [text, setText] = useState(existingOutput || '');
  const [status, setStatus] = useState(isRunning ? 'running' : null);
  const scrollRef = useRef(null);
  const esRef = useRef(null);

  // Reset only when switching to a different job/run — preserves SSE-accumulated text
  // across the isRunning true→false transition so output isn't wiped on completion.
  useEffect(() => {
    setText(existingOutput || '');
    setStatus(isRunning ? 'running' : null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, runId]);

  // Once the server confirms saved output for a completed run, display it.
  useEffect(() => {
    if (!isRunning && existingOutput) setText(existingOutput);
  }, [isRunning, existingOutput]);

  // SSE lifecycle — open on run start, close on completion.
  useEffect(() => {
    if (!isRunning) {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      setStatus(null);
      return;
    }

    const es = new EventSource(`/api/agent-jobs/${jobId}/stream`);
    esRef.current = es;
    let buf = '';

    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'chunk') { buf += d.text; setText(buf); }
        else if (d.type === 'done') { setStatus(d.status); es.close(); }
      } catch {}
    };
    es.onerror = () => es.close();

    return () => { es.close(); esRef.current = null; };
  }, [jobId, runId, isRunning]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [text]);

  if (!text && !isRunning) return <span className="aj-muted aj-run-no-output">No output captured</span>;

  return (
    <div className="aj-live-output" ref={scrollRef}>
      <pre className="aj-output-pre">{text}</pre>
      {isRunning && <span className="aj-live-cursor">▌</span>}
    </div>
  );
}

// ─── Run history item ─────────────────────────────────────────────────────────
function RunItem({ run, jobId, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const duration = run.completedAt
    ? fmtDuration(new Date(run.completedAt) - new Date(run.startedAt))
    : run.status === 'running' ? fmtDuration(Date.now() - new Date(run.startedAt)) : '—';
  const isRunning = run.status === 'running';

  return (
    <div className={`aj-run-item ${isRunning ? 'is-live' : ''}`}>
      <button className="aj-run-summary" onClick={() => setOpen(o => !o)}>
        <StatusBadge status={run.status} size="sm" />
        <span className="aj-run-time">{new Date(run.startedAt).toLocaleString()}</span>
        <span className="aj-run-dur">{duration}</span>
        <span className="aj-run-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="aj-run-output">
          <LiveOutput
            jobId={jobId}
            runId={run.id}
            isRunning={isRunning}
            existingOutput={run.output}
          />
        </div>
      )}
    </div>
  );
}

// ─── Job card (list item) ─────────────────────────────────────────────────────
function JobCard({ job, isSelected, agents, workspaces, onClick }) {
  const agent = agents.find(a => a.id === job.agentId);
  const ws = workspaces.find(w => w.id === job.workspaceId);
  const glyph = AGENT_GLYPHS[job.agentId] || '✦';
  const lastRun = job.runs?.[0];
  const nextCron = job.schedule && job.enabled ? nextRunFromCron(job.schedule) : null;
  const nextRun = job.runAt && new Date(job.runAt) > new Date() ? new Date(job.runAt) : nextCron;

  return (
    <button className={`aj-job-card ${isSelected ? 'is-selected' : ''} ${!job.enabled ? 'is-disabled' : ''}`} onClick={onClick}>
      <div className="aj-jc-top">
        <span className="aj-jc-glyph">{glyph}</span>
        <div className="aj-jc-info">
          <span className="aj-jc-name">{job.name}</span>
          <span className="aj-jc-meta">
            {agent?.label || job.agentId}
            {ws && <> · <span title={ws.cwd}>{ws.name}</span></>}
          </span>
        </div>
        <StatusBadge status={job.isRunning ? 'running' : job.status} size="sm" />
      </div>
      <div className="aj-jc-bottom">
        <ScheduleLabel schedule={job.schedule} runAt={job.runAt} />
        <span className="aj-muted">
          {nextRun ? `Next ${fmtIn(nextRun)}` : lastRun ? `Last ${fmtAgo(lastRun.startedAt)}` : 'Never run'}
        </span>
      </div>
    </button>
  );
}

// ─── Job detail (right pane) ──────────────────────────────────────────────────
function JobDetail({ job, agents, workspaces, tz, onEdit, onRun, onCancel, onToggle, onDelete, onClone, onOpenTerminal }) {
  const agent = agents.find(a => a.id === job.agentId);
  const ws = workspaces.find(w => w.id === job.workspaceId);
  const isRunning = job.isRunning;
  const glyph = AGENT_GLYPHS[job.agentId] || '✦';
  const nextCron = job.schedule && job.enabled ? nextRunFromCron(job.schedule) : null;
  const nextRun = job.runAt && new Date(job.runAt) > new Date() ? new Date(job.runAt) : nextCron;

  return (
    <div className="aj-detail">
      <div className="aj-detail-header">
        <span className="aj-detail-glyph">{glyph}</span>
        <div className="aj-detail-title-block">
          <h2 className="aj-detail-name">{job.name}</h2>
          <div className="aj-detail-sub">
            {agent?.label || job.agentId}
            {ws && <> · <span title={ws.cwd}>{ws.name}</span></>}
            {tz && <> · <span className="aj-tz-inline">{tz}</span></>}
          </div>
        </div>
        <StatusBadge status={isRunning ? 'running' : job.status} />
      </div>

      <div className="aj-detail-controls">
        {isRunning ? (
          <button className="aj-btn aj-btn--danger" onClick={onCancel}>⏹ Cancel</button>
        ) : (
          <button className="aj-btn aj-btn--primary" onClick={onRun}>▶ Run Now</button>
        )}
        {onOpenTerminal && (
          <button className="aj-btn aj-btn--ghost" onClick={() => onOpenTerminal(job)} title="Open terminal">
            ⌘ Terminal
          </button>
        )}
        <button className="aj-btn aj-btn--ghost" onClick={onEdit}>✏ Edit</button>
        <button className="aj-btn aj-btn--ghost" onClick={onClone}>⎘ Duplicate</button>
        <button className={`aj-btn aj-btn--ghost ${job.enabled ? '' : 'aj-btn--accent-outline'}`} onClick={() => onToggle(!job.enabled)}>
          {job.enabled ? '⏸ Disable' : '▶ Enable'}
        </button>
        <button className="aj-btn aj-btn--ghost aj-btn--red" onClick={onDelete}>🗑 Delete</button>
      </div>

      <div className="aj-info-grid">
        <div className="aj-info-row">
          <span className="aj-info-label">Schedule</span>
          <span>
            <ScheduleLabel schedule={job.schedule} runAt={job.runAt} />
            {job.schedule && <span className="aj-muted aj-info-aside">{cronToEnglish(job.schedule)}</span>}
          </span>
        </div>
        <div className="aj-info-row">
          <span className="aj-info-label">Next run</span>
          <span>
            {nextRun ? (
              <><strong>{fmtNextRun(nextRun)}</strong> <span className="aj-muted">· {fmtIn(nextRun)}</span></>
            ) : (
              <span className="aj-muted">{job.schedule && !job.enabled ? 'Disabled' : 'Manual only'}</span>
            )}
          </span>
        </div>
        <div className="aj-info-row">
          <span className="aj-info-label">Timeout</span>
          <span>{fmtDuration(job.timeout * 1000)}</span>
        </div>
        <div className="aj-info-row">
          <span className="aj-info-label">Last run</span>
          <span>{fmtAgo(job.lastRunAt)}</span>
        </div>
        <div className="aj-info-row">
          <span className="aj-info-label">Workspace</span>
          <span className="aj-mono" title={ws?.cwd}>{ws ? ws.cwd : <span className="aj-muted">—</span>}</span>
        </div>
      </div>

      <div className="aj-task-block">
        <div className="aj-section-label">Task / Prompt</div>
        <pre className="aj-task-pre">{job.task}</pre>
      </div>

      <div className="aj-runs-block">
        <div className="aj-section-label">
          Run History <span className="aj-muted" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· {job.runs?.length || 0} runs</span>
        </div>
        {(!job.runs || job.runs.length === 0) ? (
          <div className="aj-muted" style={{ padding: '12px 0', fontSize: 12 }}>No runs yet — click <strong>Run Now</strong> to start</div>
        ) : (
          <div className="aj-runs-list">
            {job.runs.map((r, i) => (
              <RunItem key={r.id} run={r} jobId={job.id} defaultOpen={i === 0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Workspace picker ─────────────────────────────────────────────────────────
function WorkspacePicker({ workspaces, value, onChange, onWorkspacesChange }) {
  const [showBrowser, setShowBrowser] = useState(false);
  const [renameId, setRenameId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef(null);

  useEffect(() => {
    if (renameId && renameInputRef.current) { renameInputRef.current.focus(); renameInputRef.current.select(); }
  }, [renameId]);

  const startRename = (e, ws) => { e.stopPropagation(); setRenameId(ws.id); setRenameValue(ws.name); };

  const commitRename = async () => {
    const id = renameId, name = renameValue.trim();
    if (!id) return;
    setRenameId(null);
    if (!name || name === workspaces.find(w => w.id === id)?.name) return;
    try {
      const r = await axios.put(`/api/workspaces/${id}`, { name });
      onWorkspacesChange(workspaces.map(w => w.id === id ? r.data.workspace : w));
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Rename failed', body: e.message });
    }
  };

  const handleConfirm = async (folderPath, wsName) => {
    setShowBrowser(false);
    const existing = workspaces.find(w => w.cwd === folderPath);
    if (existing) { onChange(existing.id); return; }
    try {
      const r = await axios.post('/api/workspaces', { name: wsName, cwd: folderPath });
      onWorkspacesChange([...workspaces, r.data.workspace]);
      onChange(r.data.workspace.id);
    } catch (e) { window.UI?.toast?.({ kind: 'err', title: 'Failed', body: e.message }); }
  };

  const handleDelete = async (e, ws) => {
    e.stopPropagation();
    const ok = await window.UI.confirm({ title: 'Remove Workspace', body: `Remove "${ws.name}"? Files are unaffected.`, confirmLabel: 'Remove', dangerous: true });
    if (!ok) return;
    try {
      await axios.delete(`/api/workspaces/${ws.id}`);
      onWorkspacesChange(workspaces.filter(w => w.id !== ws.id));
      if (value === ws.id) onChange('');
    } catch (e) { window.UI?.toast?.({ kind: 'err', title: 'Remove failed', body: e.message }); }
  };

  return (
    <>
      {showBrowser && <FolderBrowserModal initialPath={workspaces.find(w=>w.id===value)?.cwd || '/home'} onConfirm={handleConfirm} onClose={() => setShowBrowser(false)} />}
      <div className="ajwp-list">
        {workspaces.length === 0 && <div className="ajwp-empty">No workspaces — add one below</div>}
        {workspaces.map(w => (
          <div key={w.id} className={`ajwp-item ${w.id === value ? 'is-selected' : ''}`}
            onClick={() => renameId === w.id ? null : onChange(w.id === value ? '' : w.id)}
            onDoubleClick={(e) => startRename(e, w)}>
            <span className="ajwp-icon">📁</span>
            <div className="ajwp-info">
              {renameId === w.id ? (
                <input ref={renameInputRef} className="ajwp-rename-input" value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={commitRename} onClick={e => e.stopPropagation()}
                  onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenameId(null); }} />
              ) : <span className="ajwp-name">{w.name}</span>}
              <span className="ajwp-path" title={w.cwd}>{w.cwd}</span>
            </div>
            {w.id === value && renameId !== w.id && <span className="ajwp-check">✓</span>}
            {renameId !== w.id && (
              <>
                <button type="button" className="ajwp-edit" onClick={e => startRename(e, w)}>✎</button>
                <button type="button" className="ajwp-del" onClick={e => handleDelete(e, w)}>×</button>
              </>
            )}
          </div>
        ))}
      </div>
      <button type="button" className="ajwp-add-btn" onClick={() => setShowBrowser(true)}>+ Add Workspace</button>
    </>
  );
}

// ─── Job Form ─────────────────────────────────────────────────────────────────
function JobForm({ job, agents, workspaces: initialWorkspaces, activeWsId, defaultAgentId, tz, onSave, onCancel }) {
  const isEdit = !!job;
  const [name,       setName]       = useState(job?.name || '');
  const [agentId,    setAgentId]    = useState(job?.agentId || defaultAgentId || agents[0]?.id || 'claude');
  const [workspaceId,setWorkspaceId]= useState(job?.workspaceId || activeWsId || '');
  const [localWs,    setLocalWs]    = useState(initialWorkspaces);
  const [task,       setTask]       = useState(job?.task || '');
  const [schedule,   setSchedule]   = useState(job?.schedule || null);
  const [runAt,      setRunAt]      = useState(job?.runAt || null);
  const [timeoutSec, setTimeoutSec] = useState(job?.timeout || 300);
  const [enabled,    setEnabled]    = useState(job?.enabled !== false);
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');
  const [tab,        setTab]        = useState('basic');

  useEffect(() => { setLocalWs(initialWorkspaces); }, [initialWorkspaces]);

  const handleScheduleChange = useCallback(({ schedule: s, runAt: r }) => {
    setSchedule(s);
    setRunAt(r);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !task.trim()) { setError('Name and Task are required.'); return; }
    setSaving(true); setError('');
    try {
      await onSave({ name, agentId, workspaceId: workspaceId || null, task, schedule: schedule || null, runAt: runAt || null, timeout: parseInt(timeoutSec) || 300, enabled });
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setSaving(false);
    }
  };

  const taskPlaceholder = {
    claude: 'e.g. Review uncommitted changes and suggest improvements.',
    shell:  'e.g. git pull && npm install && npm test',
    gemini: 'e.g. Analyze the codebase for performance bottlenecks.',
    antigravity: 'e.g. Audit error handling across the backend.',
    aider:  'e.g. Fix the failing tests in tests/ and commit the changes.',
  }[agentId] || 'Describe what the agent should do…';

  const TABS = [{ id: 'basic', label: 'Task' }, { id: 'schedule', label: 'Schedule' }, { id: 'advanced', label: 'Settings' }];

  return (
    <form className="aj-form" onSubmit={handleSubmit}>
      <div className="aj-form-header">
        <h2>{isEdit ? 'Edit Job' : 'New Job'}</h2>
        <button type="button" className="aj-form-close" onClick={onCancel}>×</button>
      </div>

      <div className="aj-form-tabs">
        {TABS.map(t => (
          <button key={t.id} type="button"
            className={`aj-form-tab ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {error && <div className="aj-form-error">⚠ {error}</div>}

      <div className="aj-form-body">
        {/* ── Task tab ── */}
        {tab === 'basic' && (
          <>
            <div className="aj-field">
              <label className="aj-label">Job Name</label>
              <input className="aj-input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Daily Code Review" required />
            </div>

            <div className="aj-field">
              <label className="aj-label">Agent</label>
              <div className="aj-agent-picker">
                {[{ id: 'shell', label: 'Shell', cmd: 'shell' }, ...agents].map(a => (
                  <button key={a.id} type="button"
                    className={`aj-agent-chip ${agentId === a.id ? 'is-selected' : ''}`}
                    onClick={() => setAgentId(a.id)}>
                    <span>{AGENT_GLYPHS[a.id] || '✦'}</span> {a.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="aj-field">
              <label className="aj-label">Workspace</label>
              <WorkspacePicker workspaces={localWs} value={workspaceId} onChange={setWorkspaceId} onWorkspacesChange={setLocalWs} />
            </div>

            <div className="aj-field">
              <label className="aj-label">
                Task / Prompt
                <span className="aj-label-hint">Sent to the agent as its starting instruction</span>
              </label>
              <textarea className="aj-textarea" value={task} onChange={e => setTask(e.target.value)}
                placeholder={taskPlaceholder} rows={6} required />
            </div>
          </>
        )}

        {/* ── Schedule tab ── */}
        {tab === 'schedule' && (
          <div className="aj-field">
            <SchedulePicker
              schedule={schedule}
              runAt={runAt}
              onChange={handleScheduleChange}
              tz={tz}
            />
          </div>
        )}

        {/* ── Settings tab ── */}
        {tab === 'advanced' && (
          <>
            <div className="aj-field">
              <label className="aj-label">Timeout</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input className="aj-input" type="number" min={30} max={7200} value={timeoutSec}
                  onChange={e => setTimeoutSec(e.target.value)} style={{ width: 100 }} />
                <span className="aj-muted">seconds ({fmtDuration(timeoutSec * 1000)})</span>
              </div>
            </div>
            <div className="aj-field aj-field--inline">
              <label className="aj-label">Enabled</label>
              <label className="aj-toggle">
                <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
                <span className="aj-toggle-track" />
              </label>
              <span className="aj-muted" style={{ fontSize: 12 }}>
                {enabled ? 'Will run on schedule automatically' : 'Disabled — manual run only'}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="aj-form-footer">
        <button type="button" className="aj-btn aj-btn--ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="aj-btn aj-btn--primary" disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Job'}
        </button>
      </div>
    </form>
  );
}

// ─── Modal wrapper ────────────────────────────────────────────────────────────
function JobFormModal(props) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') props.onCancel(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [props.onCancel]);

  return (
    <div className="aj-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) props.onCancel(); }}>
      <div className="aj-modal-dialog">
        <JobForm {...props} />
      </div>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────
export function AgentJobsPanel({ workspaces, agents, activeWsId, onWorkspacesChange, preset, onClearPreset, onOpenTerminal, onRunningCountChange }) {
  const [jobs,       setJobs]       = useState([]);
  const [tz,         setTz]         = useState('');
  const [loading,    setLoading]    = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [showForm,   setShowForm]   = useState(false);
  const [editJob,    setEditJob]    = useState(null);
  const [formDefaults, setFormDefaults] = useState(null);
  const [filter,     setFilter]     = useState('all');
  const pollRef   = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const runningCount = useMemo(() => jobs.filter(j => j.isRunning).length, [jobs]);
  const hasRunning   = runningCount > 0;

  useEffect(() => { onRunningCountChange?.(runningCount); }, [runningCount, onRunningCountChange]);

  useEffect(() => {
    if (!preset) return;
    setFormDefaults({ workspaceId: preset.workspaceId, agentId: preset.agentId });
    setEditJob(null);
    setShowForm(true);
    onClearPreset?.();
  }, [preset]);

  const loadJobs = useCallback(async () => {
    try {
      const r = await axios.get('/api/agent-jobs');
      if (!mountedRef.current) return;
      setJobs(r.data.jobs || []);
      if (r.data.tz) setTz(r.data.tz);
    } catch {} finally { if (mountedRef.current) setLoading(false); }
  }, []);

  const loadSelected = useCallback(async (id) => {
    if (!id) return;
    try {
      const r = await axios.get(`/api/agent-jobs/${id}`);
      if (!mountedRef.current) return;
      setJobs(prev => prev.map(j => j.id === id ? r.data.job : j));
    } catch {}
  }, []);

  useEffect(() => {
    loadJobs();
    if (selectedId) loadSelected(selectedId);
    const tick = async () => {
      await loadJobs();
      if (selectedId) await loadSelected(selectedId);
    };
    pollRef.current = setInterval(tick, hasRunning ? 3000 : 10000);
    return () => clearInterval(pollRef.current);
  }, [loadJobs, loadSelected, selectedId, hasRunning]);

  const handleSelect = useCallback(async (id) => {
    setSelectedId(id);
    if (id) await loadSelected(id);
  }, [loadSelected]);

  const handleCreate = async (data) => {
    const r = await axios.post('/api/agent-jobs', data);
    await loadJobs();
    setSelectedId(r.data.job.id);
    setShowForm(false); setEditJob(null);
    window.UI?.toast?.({ kind: 'ok', title: 'Job created', body: r.data.job.name });
  };

  const handleUpdate = async (id, data) => {
    await axios.put(`/api/agent-jobs/${id}`, data);
    await loadJobs();
    setShowForm(false); setEditJob(null);
    window.UI?.toast?.({ kind: 'ok', title: 'Job updated' });
  };

  const handleDelete = async (id) => {
    const job = jobs.find(j => j.id === id);
    const ok = await window.UI.confirm({ title: 'Delete Job', body: `Delete "${job?.name}"? This removes all run history.`, confirmLabel: 'Delete', dangerous: true });
    if (!ok) return;
    await axios.delete(`/api/agent-jobs/${id}`);
    await loadJobs();
    if (selectedId === id) setSelectedId(null);
    window.UI?.toast?.({ kind: 'ok', title: 'Job deleted' });
  };

  const handleRun = async (id) => {
    try {
      await axios.post(`/api/agent-jobs/${id}/run`);
      window.UI?.toast?.({ kind: 'ok', title: 'Job started' });
      await loadSelected(id);
      await loadJobs();
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Run failed', body: e.response?.data?.error || e.message });
    }
  };

  const handleCancel = async (id) => {
    try {
      await axios.post(`/api/agent-jobs/${id}/cancel`);
      window.UI?.toast?.({ kind: 'ok', title: 'Cancelled' });
      await loadJobs();
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Cancel failed', body: e.message });
    }
  };

  const handleToggle = async (id, enabled) => {
    await axios.put(`/api/agent-jobs/${id}`, { enabled });
    await loadJobs();
  };

  const handleClone = async (id) => {
    try {
      const r = await axios.post(`/api/agent-jobs/${id}/clone`);
      await loadJobs();
      setSelectedId(r.data.job.id);
      window.UI?.toast?.({ kind: 'ok', title: 'Duplicated', body: r.data.job.name });
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Clone failed', body: e.message });
    }
  };

  const FILTERS = [
    { id: 'all',       label: 'All' },
    { id: 'running',   label: 'Running' },
    { id: 'completed', label: 'Done' },
    { id: 'failed',    label: 'Failed' },
    { id: 'idle',      label: 'Idle' },
  ];

  const filteredJobs = useMemo(() => {
    if (filter === 'all') return jobs;
    return jobs.filter(j => (j.isRunning ? 'running' : j.status) === filter);
  }, [jobs, filter]);

  const selectedJob = useMemo(() => jobs.find(j => j.id === selectedId), [jobs, selectedId]);

  const stats = useMemo(() => ({
    total: jobs.length,
    running: jobs.filter(j => j.isRunning).length,
    failed: jobs.filter(j => j.status === 'failed').length,
    scheduled: jobs.filter(j => (j.schedule || j.runAt) && j.enabled).length,
  }), [jobs]);

  return (
    <>
      <div className="aj-root">
        {/* Left: job list */}
        <div className="aj-list-pane">
          <div className="aj-list-header">
            <div className="aj-list-toprow">
              <span className="aj-list-title">
                Jobs
                {tz && <span className="aj-tz-tag">· {tz}</span>}
              </span>
              <button className="aj-new-btn" onClick={() => { setEditJob(null); setFormDefaults(null); setShowForm(true); }}>
                + New
              </button>
            </div>

            <div className="aj-stats">
              <div className="aj-stat"><span className="aj-stat-value">{stats.total}</span><span className="aj-stat-label">Total</span></div>
              <div className={`aj-stat ${stats.running > 0 ? 'is-running' : ''}`}><span className="aj-stat-value">{stats.running}</span><span className="aj-stat-label">Running</span></div>
              <div className={`aj-stat ${stats.failed > 0 ? 'is-failed' : ''}`}><span className="aj-stat-value">{stats.failed}</span><span className="aj-stat-label">Failed</span></div>
              <div className="aj-stat"><span className="aj-stat-value">{stats.scheduled}</span><span className="aj-stat-label">Scheduled</span></div>
            </div>

            <div className="aj-filters">
              {FILTERS.map(f => (
                <button key={f.id} className={`aj-filter-btn ${filter === f.id ? 'is-active' : ''}`} onClick={() => setFilter(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="aj-jobs-scroll">
            {loading ? (
              <div className="aj-empty-list">Loading…</div>
            ) : filteredJobs.length === 0 ? (
              <div className="aj-empty-list">
                {jobs.length === 0 ? <>No jobs yet.<br />Click <strong>+ New</strong> to create one.</> : `No ${filter} jobs.`}
              </div>
            ) : (
              filteredJobs.map(job => (
                <JobCard key={job.id} job={job} agents={agents} workspaces={workspaces}
                  isSelected={selectedId === job.id} onClick={() => handleSelect(job.id)} />
              ))
            )}
          </div>
        </div>

        {/* Right: detail */}
        <div className="aj-right-pane">
          {selectedJob ? (
            <JobDetail
              job={selectedJob}
              agents={agents}
              workspaces={workspaces}
              tz={tz}
              onEdit={() => { setEditJob(selectedJob); setShowForm(true); }}
              onRun={() => handleRun(selectedJob.id)}
              onCancel={() => handleCancel(selectedJob.id)}
              onToggle={(enabled) => handleToggle(selectedJob.id, enabled)}
              onDelete={() => handleDelete(selectedJob.id)}
              onClone={() => handleClone(selectedJob.id)}
              onOpenTerminal={onOpenTerminal}
            />
          ) : (
            <div className="aj-detail-empty">
              <div className="aj-detail-empty-orb">📋</div>
              <div>
                <strong style={{ color: 'var(--text-2)', fontSize: 14 }}>Select a job to view details</strong><br />
                <span style={{ fontSize: 12 }}>or create a new job</span>
              </div>
              <button className="aj-btn aj-btn--primary" onClick={() => { setEditJob(null); setFormDefaults(null); setShowForm(true); }}>
                + New Job
              </button>
            </div>
          )}
        </div>
      </div>

      {showForm && (
        <JobFormModal
          job={editJob}
          agents={agents}
          workspaces={workspaces}
          activeWsId={formDefaults?.workspaceId || activeWsId}
          defaultAgentId={formDefaults?.agentId}
          tz={tz}
          onSave={editJob ? (data) => handleUpdate(editJob.id, data) : handleCreate}
          onCancel={() => { setShowForm(false); setEditJob(null); setFormDefaults(null); }}
        />
      )}
    </>
  );
}

// ─── Standalone tab wrapper ───────────────────────────────────────────────────
export function AgentJobsTab() {
  const [workspaces, setWorkspaces] = useState([]);
  const [agents,     setAgents]     = useState([]);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    Promise.all([
      axios.get('/api/workspaces').catch(() => null),
      axios.get('/api/agents').catch(() => null),
    ]).then(([wsRes, agRes]) => {
      if (!mountedRef.current) return;
      setWorkspaces(wsRes?.data?.workspaces || []);
      setAgents(agRes?.data?.agents || []);
    });
  }, []);

  return (
    <AgentJobsPanel
      workspaces={workspaces}
      agents={agents}
      activeWsId={workspaces[0]?.id || ''}
      onWorkspacesChange={setWorkspaces}
    />
  );
}
