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

// Parse a 5-part cron string into { min, hour, dom, month, dow }
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

// Compute the next datetime a cron expression matches, starting after `from`.
// Brute-force forward in 1-minute steps with a 1-year ceiling.
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
      const stp = +step || 1;
      return (val - startV) % stp === 0;
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
  if (diff < 0) return 'now';
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

// Build a cron string from the Simple-mode state.
function buildSimpleCron({ kind, interval, unit, hour, minute, weekDays, monthDay }) {
  if (kind === 'manual') return '';
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
    case 'month':  return `${m} ${h} ${monthDay || 1} * *`;
    default:       return '';
  }
}

// Try to detect a Simple-mode state from a cron string. Returns null if not representable.
function detectSimple(cron) {
  if (!cron) return { kind: 'manual', interval: 1, unit: 'day', hour: 9, minute: 0, weekDays: [1,2,3,4,5], monthDay: 1 };
  const p = parseCronParts(cron);
  if (!p) return null;
  const { min: m, hour: h, dom, month, dow } = p;
  if (month !== '*') return null;

  const base = { kind: 'recurring', interval: 1, unit: 'day', hour: 9, minute: 0, weekDays: [1,2,3,4,5], monthDay: 1 };

  // every minute
  if (m === '*' && h === '*' && dom === '*' && dow === '*') return { ...base, unit: 'minute', interval: 1 };
  // every N minutes
  const minStep = m.match(/^\*\/(\d+)$/);
  if (minStep && h === '*' && dom === '*' && dow === '*') return { ...base, unit: 'minute', interval: +minStep[1] };

  if (!/^\d+$/.test(m)) return null;
  const minV = +m;

  // every hour at minute M
  if (h === '*' && dom === '*' && dow === '*') return { ...base, unit: 'hour', interval: 1, minute: minV };
  const hrStep = h.match(/^\*\/(\d+)$/);
  if (hrStep && dom === '*' && dow === '*') return { ...base, unit: 'hour', interval: +hrStep[1], minute: minV };

  if (!/^\d+$/.test(h)) return null;
  const hourV = +h;

  // Weekly: dow set, dom *
  if (dom === '*' && dow !== '*') {
    const days = parseDow(dow);
    if (!days.length) return null;
    return { ...base, unit: 'week', interval: 1, hour: hourV, minute: minV, weekDays: days };
  }
  // Daily
  if (dom === '*' && dow === '*') return { ...base, unit: 'day', interval: 1, hour: hourV, minute: minV };
  const domStep = dom.match(/^\*\/(\d+)$/);
  if (domStep && dow === '*') return { ...base, unit: 'day', interval: +domStep[1], hour: hourV, minute: minV };
  // Monthly
  if (/^\d+$/.test(dom) && dow === '*') return { ...base, unit: 'month', interval: 1, hour: hourV, minute: minV, monthDay: +dom };

  return null;
}

// Human-readable description of any cron.
function cronToEnglish(cron) {
  if (!cron) return 'Runs manually — no schedule.';
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
               names.length === 2 && names.every(n => ['Sat','Sun'].includes(n)) ? `Runs every weekend day at ${t}.` :
               `Runs on ${names.join(', ')} at ${t}.`;
      }
      case 'month':  return `Runs on the ${ORDINAL(detected.monthDay)} of each month at ${t}.`;
    }
  }
  return `Custom: ${cron}`;
}

const AGENT_GLYPHS = { claude: '💬', 'claude-code': '💬', gemini: '✦', antigravity: '🚀', codex: '⬡', opencode: '🔏', kilocode: '⚡', kilo: '⚡', ollama: '🦙', shell: '›_', aider: '🤖' };

// ─── Schedule Picker (Simple / Advanced two-mode) ─────────────────────────────
function SchedulePicker({ value, onChange, tz }) {
  const initial = useMemo(() => detectSimple(value), [value]);
  const [mode, setMode] = useState(initial ? 'simple' : 'advanced');

  // Simple-mode state
  const def = initial || { kind: 'manual', interval: 1, unit: 'day', hour: 9, minute: 0, weekDays: [1,2,3,4,5], monthDay: 1 };
  const [kind,     setKind]     = useState(def.kind);
  const [interval, setInterval] = useState(def.interval);
  const [unit,     setUnit]     = useState(def.unit);
  const [hour,     setHour]     = useState(def.hour);
  const [minute,   setMinute]   = useState(def.minute);
  const [weekDays, setWeekDays] = useState(def.weekDays);
  const [monthDay, setMonthDay] = useState(def.monthDay);
  const [advanced, setAdvanced] = useState(value || '');

  const cron = useMemo(() => {
    if (mode === 'advanced') return advanced.trim();
    return buildSimpleCron({ kind, interval, unit, hour, minute, weekDays, monthDay });
  }, [mode, advanced, kind, interval, unit, hour, minute, weekDays, monthDay]);

  // Notify parent when cron changes
  const lastRef = useRef(value);
  useEffect(() => {
    if (cron !== lastRef.current) { lastRef.current = cron; onChange(cron); }
  }, [cron, onChange]);

  // When user switches to Simple mode, try to parse the advanced cron back in
  const handleModeSwitch = (target) => {
    if (target === 'simple' && mode === 'advanced') {
      const parsed = detectSimple(advanced.trim());
      if (parsed) {
        setKind(parsed.kind); setInterval(parsed.interval); setUnit(parsed.unit);
        setHour(parsed.hour); setMinute(parsed.minute);
        setWeekDays(parsed.weekDays); setMonthDay(parsed.monthDay);
        setMode('simple');
      } else {
        window.UI?.toast?.({ kind: 'warn', title: 'Cannot simplify', body: 'This cron expression has no Simple equivalent.' });
      }
      return;
    }
    if (target === 'advanced' && mode === 'simple') {
      setAdvanced(cron);
    }
    setMode(target);
  };

  const toggleDay = (d) =>
    setWeekDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);

  const next = useMemo(() => nextRunFromCron(cron), [cron]);
  const advanceValid = mode !== 'advanced' || !advanced.trim() || parseCronParts(advanced.trim()) !== null;

  const showTimeRow = unit === 'day' || unit === 'week' || unit === 'month';
  const showMinuteOnly = unit === 'hour';

  return (
    <div className="sp-root">
      {/* Mode tabs */}
      <div className="sp-mode-tabs">
        <button type="button" className={`sp-mode-tab ${mode === 'simple' ? 'is-active' : ''}`} onClick={() => handleModeSwitch('simple')}>Simple</button>
        <button type="button" className={`sp-mode-tab ${mode === 'advanced' ? 'is-active' : ''}`} onClick={() => handleModeSwitch('advanced')}>Advanced</button>
      </div>

      {/* Simple mode */}
      {mode === 'simple' && (
        <div className="sp-body">
          <div className="sp-row sp-row--kind">
            <span className="sp-label">How often?</span>
            <label className={`sp-radio ${kind === 'manual' ? 'is-on' : ''}`}>
              <input type="radio" checked={kind === 'manual'} onChange={() => setKind('manual')} />
              <span>Manual only</span>
            </label>
            <label className={`sp-radio ${kind === 'recurring' ? 'is-on' : ''}`}>
              <input type="radio" checked={kind === 'recurring'} onChange={() => setKind('recurring')} />
              <span>Recurring</span>
            </label>
          </div>

          {kind === 'recurring' && (
            <>
              <div className="sp-row">
                <span className="sp-label">Repeat every</span>
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

              {showTimeRow && (
                <div className="sp-row">
                  <span className="sp-label">At time</span>
                  <input type="time"
                    className="sp-time"
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

              {showMinuteOnly && (
                <div className="sp-row">
                  <span className="sp-label">At minute</span>
                  <input type="number" className="sp-num" min={0} max={59}
                    value={minute} onChange={e => setMinute(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))} />
                  <span className="sp-hint">past each hour</span>
                </div>
              )}

              {unit === 'week' && (
                <div className="sp-row sp-row--days">
                  <span className="sp-label">On days</span>
                  <div className="sp-day-pills">
                    {WEEKDAYS.map(d => (
                      <button key={d.value} type="button"
                        className={`sp-day-btn ${weekDays.includes(d.value) ? 'is-on' : ''}`}
                        onClick={() => toggleDay(d.value)}
                        title={d.label}>
                        {d.short}
                      </button>
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
                  <span className="sp-label">Day of month</span>
                  <select className="sp-sel" value={monthDay} onChange={e => setMonthDay(+e.target.value)}>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                      <option key={d} value={d}>{ORDINAL(d)}</option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Advanced mode */}
      {mode === 'advanced' && (
        <div className="sp-body">
          <div className="sp-row">
            <span className="sp-label">Cron expression</span>
            <input className="sp-cron-input"
              value={advanced}
              onChange={e => setAdvanced(e.target.value)}
              placeholder="min hr dom mon dow   e.g. 0 9 * * 1-5"
              spellCheck={false} />
          </div>
          <div className="sp-advanced-help">
            <span className="sp-hint">{cronToEnglish(advanced.trim())}</span>
            {!advanceValid && <span className="sp-err">⚠ Invalid format (need 5 space-separated fields)</span>}
          </div>
        </div>
      )}

      {/* Footer: next run + cron pill */}
      <div className="sp-footer">
        {next ? (
          <span className="sp-next">⏰ Next: <strong>{fmtNextRun(next)}</strong> <span className="sp-muted">({fmtIn(next)}{tz ? ` · ${tz}` : ''})</span></span>
        ) : (
          <span className="sp-muted">{cron ? 'Cron is set but no upcoming match found.' : 'No automatic schedule.'}</span>
        )}
        {cron && <code className="sp-cron-pill" title="Cron expression">{cron}</code>}
      </div>
    </div>
  );
}

// ─── Status / Schedule labels ─────────────────────────────────────────────────
function StatusBadge({ status, size = 'md' }) {
  const m = STATUS_META[status] || STATUS_META.idle;
  return (
    <span className={`aj-badge aj-badge--${size}`} style={{ color: m.color, background: m.bg }}>
      <span className={`aj-dot${m.pulse ? ' aj-dot--pulse' : ''}`} style={{ background: m.dot }} />
      {m.label}
    </span>
  );
}

function ScheduleLabel({ schedule }) {
  if (!schedule) return <span className="aj-muted">Manual only</span>;
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
        const days = detected.weekDays.sort((a, b) => a - b).map(d => WEEKDAYS.find(w => w.value === d)?.short).join('');
        label = `${days || '—'} ${t}`;
        break;
      }
      case 'month': label = `${ORDINAL(detected.monthDay)} ${t}`; break;
    }
  }
  return <span className="aj-mono aj-schedule-tag" title={schedule}>{label}</span>;
}

// ─── Job Card ─────────────────────────────────────────────────────────────────
function JobCard({ job, isSelected, agents, workspaces, onClick }) {
  const agent = agents.find(a => a.id === job.agentId);
  const ws = workspaces.find(w => w.id === job.workspaceId);
  const glyph = AGENT_GLYPHS[job.agentId] || '✦';
  const lastRun = job.runs?.[0];
  const next = job.schedule && job.enabled ? nextRunFromCron(job.schedule) : null;

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
        <ScheduleLabel schedule={job.schedule} />
        <span className="aj-muted">
          {next ? `Next ${fmtIn(next)}` : lastRun ? `Last ${fmtAgo(lastRun.startedAt)}` : 'Never run'}
        </span>
      </div>
    </button>
  );
}

// ─── Run history item ─────────────────────────────────────────────────────────
function RunItem({ run, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const duration = run.completedAt
    ? fmtDuration(new Date(run.completedAt) - new Date(run.startedAt))
    : run.status === 'running' ? fmtDuration(Date.now() - new Date(run.startedAt)) : '—';

  return (
    <div className="aj-run-item">
      <button className="aj-run-summary" onClick={() => setOpen(o => !o)}>
        <StatusBadge status={run.status} size="sm" />
        <span className="aj-run-time">{new Date(run.startedAt).toLocaleString()}</span>
        <span className="aj-run-dur">{duration}</span>
        <span className="aj-run-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="aj-run-output">
          {run.output ? (
            <pre className="aj-output-pre">{run.output}</pre>
          ) : (
            <span className="aj-muted aj-run-no-output">
              {run.status === 'running' ? '⟳ Waiting for output…' : 'No output captured'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Job detail ───────────────────────────────────────────────────────────────
function JobDetail({ job, agents, workspaces, tz, onEdit, onRun, onCancel, onToggle, onDelete, onClone }) {
  const agent = agents.find(a => a.id === job.agentId);
  const ws = workspaces.find(w => w.id === job.workspaceId);
  const isRunning = job.isRunning;
  const glyph = AGENT_GLYPHS[job.agentId] || '✦';
  const next = job.schedule && job.enabled ? nextRunFromCron(job.schedule) : null;

  return (
    <div className="aj-detail">
      <div className="aj-detail-header">
        <span className="aj-detail-glyph">{glyph}</span>
        <div className="aj-detail-title-block">
          <h2 className="aj-detail-name">{job.name}</h2>
          <div className="aj-detail-sub">
            {agent?.label || job.agentId}
            {ws && <> · <span title={ws.cwd}>{ws.name}</span></>}
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
        <button className="aj-btn aj-btn--ghost" onClick={onEdit}>✏ Edit</button>
        <button className="aj-btn aj-btn--ghost" onClick={onClone}>⎘ Duplicate</button>
        <button
          className={`aj-btn aj-btn--ghost ${job.enabled ? '' : 'aj-btn--accent-outline'}`}
          onClick={() => onToggle(!job.enabled)}
        >
          {job.enabled ? '⏸ Disable' : '▶ Enable'}
        </button>
        <button className="aj-btn aj-btn--ghost aj-btn--red" onClick={onDelete}>🗑 Delete</button>
      </div>

      <div className="aj-info-grid">
        <div className="aj-info-row">
          <span className="aj-info-label">Schedule</span>
          <ScheduleLabel schedule={job.schedule} />
          {job.schedule && <span className="aj-muted aj-info-aside">{cronToEnglish(job.schedule)}</span>}
        </div>
        <div className="aj-info-row">
          <span className="aj-info-label">Next run</span>
          <span>
            {next ? (
              <>
                <strong>{fmtNextRun(next)}</strong>
                <span className="aj-muted"> · {fmtIn(next)}{tz ? ` · ${tz}` : ''}</span>
              </>
            ) : job.schedule && !job.enabled ? (
              <span className="aj-muted">Disabled</span>
            ) : (
              <span className="aj-muted">Manual only</span>
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
          <span title={ws?.cwd} className="aj-mono">{ws ? ws.cwd : '—'}</span>
        </div>
      </div>

      <div className="aj-task-block">
        <div className="aj-section-label">Task / Prompt</div>
        <pre className="aj-task-pre">{job.task}</pre>
      </div>

      <div className="aj-runs-block">
        <div className="aj-section-label">
          Run History
          <span className="aj-muted" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            {' '}· {job.runs?.length || 0} runs
          </span>
        </div>
        {(!job.runs || job.runs.length === 0) ? (
          <div className="aj-muted" style={{ padding: '12px 0', fontSize: 12 }}>No runs yet</div>
        ) : (
          <div className="aj-runs-list">
            {job.runs.map((r, i) => <RunItem key={r.id} run={r} defaultOpen={i === 0 && (r.status !== 'idle')} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Workspace Picker (with inline rename) ────────────────────────────────────
function WorkspacePicker({ workspaces, value, onChange, onWorkspacesChange }) {
  const [showBrowser, setShowBrowser] = useState(false);
  const [renameId, setRenameId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef(null);

  useEffect(() => {
    if (renameId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renameId]);

  const startRename = (e, ws) => {
    e.stopPropagation();
    setRenameId(ws.id);
    setRenameValue(ws.name);
  };

  const commitRename = async () => {
    const id = renameId;
    const name = renameValue.trim();
    if (!id) return;
    setRenameId(null);
    if (!name || name === workspaces.find(w => w.id === id)?.name) return;
    try {
      const r = await axios.put(`/api/workspaces/${id}`, { name });
      onWorkspacesChange(workspaces.map(w => w.id === id ? r.data.workspace : w));
      window.UI?.toast?.({ kind: 'ok', title: 'Workspace renamed', body: name });
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Rename failed', body: e.response?.data?.error || e.message });
    }
  };

  const handleConfirm = async (folderPath, wsName) => {
    setShowBrowser(false);
    const existing = workspaces.find(w => w.cwd === folderPath);
    if (existing) { onChange(existing.id); return; }
    try {
      const r = await axios.post('/api/workspaces', { name: wsName, cwd: folderPath });
      const newWs = r.data.workspace;
      onWorkspacesChange([...workspaces, newWs]);
      onChange(newWs.id);
      window.UI?.toast?.({ kind: 'ok', title: 'Workspace added', body: wsName });
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Failed to add workspace', body: e.response?.data?.error || e.message });
    }
  };

  const handleDelete = async (e, ws) => {
    e.stopPropagation();
    const ok = await window.UI.confirm({
      title: 'Remove Workspace',
      body: `Remove "${ws.name}" from the workspace list? This does not delete any files.`,
      confirmLabel: 'Remove',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await axios.delete(`/api/workspaces/${ws.id}`);
      onWorkspacesChange(workspaces.filter(w => w.id !== ws.id));
      if (value === ws.id) onChange('');
      window.UI?.toast?.({ kind: 'ok', title: 'Workspace removed', body: ws.name });
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Remove failed', body: e.response?.data?.error || e.message });
    }
  };

  const selectedWs = workspaces.find(w => w.id === value);

  return (
    <>
      {showBrowser && (
        <FolderBrowserModal
          initialPath={selectedWs?.cwd || '/home'}
          onConfirm={handleConfirm}
          onClose={() => setShowBrowser(false)}
        />
      )}

      <div className="ajwp-list">
        {workspaces.length === 0 && (
          <div className="ajwp-empty">No workspaces yet — add one below</div>
        )}
        {workspaces.map(w => (
          <div
            key={w.id}
            className={`ajwp-item ${w.id === value ? 'is-selected' : ''}`}
            onClick={() => renameId === w.id ? null : onChange(w.id === value ? '' : w.id)}
            onDoubleClick={(e) => startRename(e, w)}
          >
            <span className="ajwp-icon">📁</span>
            <div className="ajwp-info">
              {renameId === w.id ? (
                <input
                  ref={renameInputRef}
                  className="ajwp-rename-input"
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                    if (e.key === 'Escape') { e.preventDefault(); setRenameId(null); }
                  }}
                />
              ) : (
                <span className="ajwp-name">{w.name}</span>
              )}
              <span className="ajwp-path" title={w.cwd}>{w.cwd}</span>
            </div>
            {w.id === value && renameId !== w.id && <span className="ajwp-check">✓</span>}
            {renameId !== w.id && (
              <>
                <button type="button" className="ajwp-edit" onClick={(e) => startRename(e, w)} title="Rename">✎</button>
                <button type="button" className="ajwp-del" onClick={(e) => handleDelete(e, w)} title="Remove">×</button>
              </>
            )}
          </div>
        ))}
      </div>

      <button type="button" className="ajwp-add-btn" onClick={() => setShowBrowser(true)}>
        + Add Workspace
      </button>
    </>
  );
}

// ─── Job Form (modal-hosted) ──────────────────────────────────────────────────
function JobForm({ job, agents, workspaces: initialWorkspaces, activeWsId, tz, onSave, onCancel }) {
  const isEdit = !!job;
  const [name, setName] = useState(job?.name || '');
  const [agentId, setAgentId] = useState(job?.agentId || agents[0]?.id || 'claude');
  const [workspaceId, setWorkspaceId] = useState(job?.workspaceId || activeWsId || '');
  const [localWorkspaces, setLocalWorkspaces] = useState(initialWorkspaces);
  const [task, setTask] = useState(job?.task || '');
  const [schedule, setSchedule] = useState(job?.schedule || '');
  const [timeoutSec, setTimeoutSec] = useState(job?.timeout || 300);
  const [enabled, setEnabled] = useState(job?.enabled !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Sync external workspace updates
  useEffect(() => { setLocalWorkspaces(initialWorkspaces); }, [initialWorkspaces]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !task.trim()) { setError('Name and Task are required.'); return; }
    setSaving(true); setError('');
    try {
      await onSave({ name, agentId, workspaceId: workspaceId || null, task, schedule: schedule || null, timeout: parseInt(timeoutSec) || 300, enabled });
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setSaving(false);
    }
  };

  const taskPlaceholder = {
    claude:      'e.g. Review all uncommitted changes and suggest improvements. Run tests and report any failures.',
    'claude-code': 'e.g. Review all uncommitted changes and suggest improvements. Run tests and report any failures.',
    shell:       'e.g. git pull && npm install && npm test',
    gemini:      'e.g. Analyze the codebase for performance bottlenecks and suggest optimizations.',
    antigravity: 'e.g. Audit error handling across the backend and propose hardening fixes.',
    codex:       'e.g. Refactor src/utils/*.ts to use async/await instead of callbacks.',
    opencode:    'e.g. Add unit tests for the auth module.',
    kilo:        'e.g. Add unit tests for the auth module.',
    kilocode:    'e.g. Add unit tests for the auth module.',
    ollama:      'First line (optional) is the model name, then the prompt.\nExample:\n\nllama3.2\nSummarize the changes in the latest git log.',
    aider:       'e.g. Fix the failing tests in tests/ and commit the changes.',
  }[agentId] || 'Describe what the agent should do…';

  return (
    <form className="aj-form" onSubmit={handleSubmit}>
      <div className="aj-form-header">
        <h2>{isEdit ? 'Edit Job' : 'New Scheduled Job'}</h2>
        <button type="button" className="aj-form-close" onClick={onCancel}>×</button>
      </div>

      {error && <div className="aj-form-error">⚠ {error}</div>}

      <div className="aj-form-body">
        <div className="aj-field">
          <label className="aj-label">Job Name</label>
          <input className="aj-input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Daily Code Review" required />
        </div>

        <div className="aj-field-row">
          <div className="aj-field">
            <label className="aj-label">Coding Agent</label>
            <div className="aj-agent-picker">
              {[{ id: 'shell', label: 'Shell', cmd: 'shell' }, ...agents].map(a => (
                <button
                  key={a.id}
                  type="button"
                  className={`aj-agent-chip ${agentId === a.id ? 'is-selected' : ''}`}
                  onClick={() => setAgentId(a.id)}
                >
                  <span>{AGENT_GLYPHS[a.id] || '✦'}</span> {a.label}
                </button>
              ))}
            </div>
          </div>

          <div className="aj-field">
            <label className="aj-label">Workspace</label>
            <WorkspacePicker
              workspaces={localWorkspaces}
              value={workspaceId}
              onChange={setWorkspaceId}
              onWorkspacesChange={setLocalWorkspaces}
            />
          </div>
        </div>

        <div className="aj-field">
          <label className="aj-label">
            Task / Prompt
            <span className="aj-label-hint">This is sent to the agent as its initial instruction</span>
          </label>
          <textarea
            className="aj-textarea"
            value={task}
            onChange={e => setTask(e.target.value)}
            placeholder={taskPlaceholder}
            rows={6}
            required
          />
        </div>

        <div className="aj-field">
          <label className="aj-label">Schedule</label>
          <SchedulePicker value={schedule} onChange={setSchedule} tz={tz} />
        </div>

        <div className="aj-field-row">
          <div className="aj-field">
            <label className="aj-label">Timeout (seconds)</label>
            <input className="aj-input" type="number" min={30} max={7200} value={timeoutSec} onChange={e => setTimeoutSec(e.target.value)} />
          </div>
          <div className="aj-field aj-field--center">
            <label className="aj-label">Enabled</label>
            <label className="aj-toggle">
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              <span className="aj-toggle-track" />
            </label>
          </div>
        </div>
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

// ─── Form modal wrapper ───────────────────────────────────────────────────────
function JobFormModal(props) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') props.onCancel(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
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
export function AgentJobsPanel({ workspaces, agents, activeWsId, onWorkspacesChange }) {
  const [jobs, setJobs] = useState([]);
  const [tz, setTz] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editJob, setEditJob] = useState(null);
  const [filter, setFilter] = useState('all');
  const pollRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const hasRunning = useMemo(() => jobs.some(j => j.isRunning), [jobs]);

  const loadJobs = useCallback(async () => {
    try {
      const r = await axios.get('/api/agent-jobs');
      if (!mountedRef.current) return;
      setJobs(r.data.jobs || []);
      if (r.data.tz) setTz(r.data.tz);
    } catch {}
    finally { if (mountedRef.current) setLoading(false); }
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
    const tick = async () => {
      await loadJobs();
      if (selectedId && hasRunning) await loadSelected(selectedId);
    };
    const interval = hasRunning ? 2000 : 8000;
    pollRef.current = setInterval(tick, interval);
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
    setShowForm(false);
    setEditJob(null);
    window.UI?.toast?.({ kind: 'ok', title: 'Job created', body: r.data.job.name });
  };

  const handleUpdate = async (id, data) => {
    const r = await axios.put(`/api/agent-jobs/${id}`, data);
    await loadJobs();
    setShowForm(false);
    setEditJob(null);
    window.UI?.toast?.({ kind: 'ok', title: 'Job updated', body: r.data.job.name });
  };

  const handleDelete = async (id) => {
    const job = jobs.find(j => j.id === id);
    const ok = await window.UI.confirm({
      title: 'Delete Job',
      body: `Delete "${job?.name}"? This also removes all run history.`,
      confirmLabel: 'Delete',
      dangerous: true,
    });
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
      await loadJobs();
      await loadSelected(id);
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Run failed', body: e.response?.data?.error || e.message });
    }
  };

  const handleCancel = async (id) => {
    try {
      await axios.post(`/api/agent-jobs/${id}/cancel`);
      window.UI?.toast?.({ kind: 'ok', title: 'Job cancelled' });
      await loadJobs();
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Cancel failed', body: e.response?.data?.error || e.message });
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
      window.UI?.toast?.({ kind: 'ok', title: 'Job duplicated', body: r.data.job.name });
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Clone failed', body: e.response?.data?.error || e.message });
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
    scheduled: jobs.filter(j => j.schedule && j.enabled).length,
  }), [jobs]);

  return (
    <>
      <style>{`
        .aj-root {
          display: flex; height: 100%; min-height: 0;
          background: #08080c; color: #e5e7eb;
          font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
          font-size: 13px;
        }

        /* ── Left List Pane ── */
        .aj-list-pane {
          width: 300px; min-width: 300px;
          display: flex; flex-direction: column;
          border-right: 1px solid rgba(255,255,255,0.06);
          background: #0b0b13; overflow: hidden;
        }
        .aj-list-header {
          padding: 14px 14px 10px;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          flex-shrink: 0;
        }
        .aj-list-toprow {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 10px;
        }
        .aj-list-title { font-size: 13px; font-weight: 700; color: #f3f4f6; }
        .aj-tz-tag {
          font-size: 10px; color: #6b7280; font-family: ui-monospace, monospace;
          margin-left: 6px;
        }

        .aj-new-btn {
          background: linear-gradient(135deg, #a78bfa, #7c3aed);
          color: #fff; border: 0;
          padding: 6px 12px; border-radius: 6px;
          font-size: 12px; font-weight: 600;
          cursor: pointer; transition: filter 0.15s; white-space: nowrap;
        }
        .aj-new-btn:hover { filter: brightness(1.12); }

        .aj-stats { display: flex; gap: 8px; margin-bottom: 10px; }
        .aj-stat {
          flex: 1; background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 6px; padding: 6px 8px; text-align: center;
        }
        .aj-stat-value { display: block; font-size: 16px; font-weight: 700; color: #f3f4f6; line-height: 1.2; }
        .aj-stat-label { display: block; font-size: 9px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; }
        .aj-stat.is-running .aj-stat-value { color: #60a5fa; }
        .aj-stat.is-failed .aj-stat-value  { color: #f87171; }

        .aj-filters { display: flex; gap: 4px; flex-wrap: wrap; }
        .aj-filter-btn {
          background: none; border: 1px solid rgba(255,255,255,0.07);
          color: #6b7280; padding: 3px 8px;
          border-radius: 4px; font-size: 11px;
          cursor: pointer; transition: all 0.15s;
        }
        .aj-filter-btn:hover { color: #d1d5db; border-color: rgba(255,255,255,0.14); }
        .aj-filter-btn.is-active { background: rgba(167,139,250,0.15); color: #c4b5fd; border-color: rgba(167,139,250,0.35); }

        .aj-jobs-scroll { flex: 1; overflow-y: auto; padding: 6px 8px; }
        .aj-empty-list { text-align: center; color: #4b5563; padding: 40px 16px; font-size: 12px; line-height: 1.8; }

        .aj-job-card {
          display: flex; flex-direction: column; gap: 6px;
          width: 100%; background: none;
          border: 1px solid rgba(255,255,255,0.05);
          border-radius: 7px; padding: 10px 11px;
          margin-bottom: 5px; cursor: pointer;
          text-align: left; color: inherit;
          transition: background 0.15s, border-color 0.15s;
        }
        .aj-job-card:hover { background: rgba(255,255,255,0.03); border-color: rgba(255,255,255,0.09); }
        .aj-job-card.is-selected { background: rgba(167,139,250,0.07); border-color: rgba(167,139,250,0.3); }
        .aj-job-card.is-disabled { opacity: 0.5; }
        .aj-jc-top { display: flex; align-items: center; gap: 9px; }
        .aj-jc-glyph { font-size: 18px; flex-shrink: 0; }
        .aj-jc-info { flex: 1; min-width: 0; }
        .aj-jc-name { display: block; font-size: 12px; font-weight: 600; color: #e5e7eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .aj-jc-meta { display: block; font-size: 10px; color: #6b7280; margin-top: 1px; }
        .aj-jc-bottom { display: flex; justify-content: space-between; align-items: center; font-size: 10px; }

        /* ── Right pane ── */
        .aj-right-pane { flex: 1; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; }
        .aj-detail-empty {
          flex: 1; display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          color: #4b5563; text-align: center; padding: 40px; gap: 12px;
        }
        .aj-detail-empty-orb {
          width: 64px; height: 64px; border-radius: 50%;
          background: rgba(167,139,250,0.05);
          border: 1px solid rgba(167,139,250,0.12);
          display: flex; align-items: center; justify-content: center; font-size: 28px;
        }

        .aj-detail {
          flex: 1; padding: 20px 24px;
          display: flex; flex-direction: column; gap: 18px;
          min-height: 0; overflow-y: auto;
        }
        .aj-detail-header {
          display: flex; align-items: flex-start; gap: 14px;
          padding-bottom: 16px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .aj-detail-glyph { font-size: 28px; flex-shrink: 0; margin-top: 2px; }
        .aj-detail-title-block { flex: 1; min-width: 0; }
        .aj-detail-name { margin: 0 0 4px; font-size: 18px; font-weight: 700; color: #f3f4f6; }
        .aj-detail-sub { font-size: 12px; color: #6b7280; }

        .aj-detail-controls { display: flex; gap: 8px; flex-wrap: wrap; }

        .aj-info-grid {
          display: flex; flex-direction: column; gap: 4px;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.05);
          border-radius: 7px; padding: 10px 14px;
        }
        .aj-info-row { display: flex; align-items: center; gap: 12px; padding: 4px 0; }
        .aj-info-label { font-size: 11px; color: #6b7280; width: 80px; flex-shrink: 0; font-weight: 500; }
        .aj-info-aside { font-size: 11px; }

        .aj-task-block { display: flex; flex-direction: column; gap: 6px; }
        .aj-task-pre {
          background: #0a0a12;
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 6px; padding: 12px;
          font-family: ui-monospace, monospace; font-size: 12px;
          color: #d1d5db; white-space: pre-wrap; word-break: break-word;
          margin: 0; max-height: 140px; overflow-y: auto;
        }

        .aj-runs-block { display: flex; flex-direction: column; gap: 8px; }
        .aj-runs-list { display: flex; flex-direction: column; gap: 4px; }
        .aj-run-item { border: 1px solid rgba(255,255,255,0.05); border-radius: 6px; overflow: hidden; }
        .aj-run-summary {
          display: flex; align-items: center; gap: 10px;
          width: 100%; background: rgba(255,255,255,0.02);
          border: 0; color: #d1d5db; padding: 8px 12px;
          cursor: pointer; text-align: left;
          font-size: 12px; transition: background 0.1s;
        }
        .aj-run-summary:hover { background: rgba(255,255,255,0.05); }
        .aj-run-time { flex: 1; font-size: 11px; color: #9ca3af; }
        .aj-run-dur { font-family: ui-monospace, monospace; font-size: 11px; color: #6b7280; }
        .aj-run-chevron { color: #4b5563; font-size: 12px; }
        .aj-run-output { border-top: 1px solid rgba(255,255,255,0.05); background: #080810; }
        .aj-output-pre {
          margin: 0; padding: 12px;
          font-family: ui-monospace, monospace; font-size: 11.5px;
          color: #d1d5db; white-space: pre-wrap; word-break: break-word;
          max-height: 400px; overflow-y: auto; line-height: 1.55;
        }
        .aj-run-no-output { display: block; padding: 12px; font-size: 12px; }

        /* ── Form ── */
        .aj-form { display: flex; flex-direction: column; background: #0c0c18; overflow: hidden; max-height: 100%; }
        .aj-form-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 20px 14px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          flex-shrink: 0;
        }
        .aj-form-header h2 { margin: 0; font-size: 16px; font-weight: 700; color: #f3f4f6; }
        .aj-form-close {
          background: none; border: 0; color: #6b7280; font-size: 22px; line-height: 1;
          cursor: pointer; padding: 0 4px; border-radius: 4px; transition: all 0.15s;
        }
        .aj-form-close:hover { color: #f3f4f6; background: rgba(255,255,255,0.08); }
        .aj-form-error { background: rgba(248,113,113,0.1); border-left: 3px solid #f87171; color: #fca5a5; padding: 10px 16px; font-size: 12px; flex-shrink: 0; }
        .aj-form-body { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 16px; }
        .aj-form-footer {
          display: flex; justify-content: flex-end; gap: 8px;
          padding: 12px 20px;
          border-top: 1px solid rgba(255,255,255,0.06);
          flex-shrink: 0;
        }

        .aj-field { display: flex; flex-direction: column; gap: 6px; flex: 1; }
        .aj-field-row { display: flex; gap: 14px; }
        .aj-field--center { justify-content: flex-start; }
        .aj-label {
          font-size: 11px; font-weight: 600; text-transform: uppercase;
          letter-spacing: 0.07em; color: #9ca3af;
          display: flex; align-items: baseline; gap: 8px;
        }
        .aj-label-hint { font-size: 10px; color: #4b5563; text-transform: none; letter-spacing: 0; font-weight: 400; }

        .aj-input, .aj-select, .aj-textarea {
          background: #08080f; border: 1px solid rgba(255,255,255,0.09);
          color: #f3f4f6; padding: 8px 10px;
          border-radius: 6px; font-size: 13px; outline: none;
          transition: border-color 0.15s; width: 100%; box-sizing: border-box;
        }
        .aj-input:focus, .aj-select:focus, .aj-textarea:focus { border-color: rgba(167,139,250,0.55); }
        .aj-textarea { resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.55; }
        .aj-select { cursor: pointer; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px; }

        /* ── Form modal overlay ── */
        .aj-modal-overlay {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.65);
          display: flex; align-items: center; justify-content: center;
          z-index: 1000; backdrop-filter: blur(3px);
          animation: ajFadeIn 0.15s ease-out;
          padding: 24px;
        }
        @keyframes ajFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .aj-modal-dialog {
          background: #0c0c18;
          border: 1px solid rgba(167,139,250,0.2);
          border-radius: 10px;
          width: 720px;
          max-width: 100%;
          max-height: calc(100vh - 48px);
          display: flex; flex-direction: column;
          overflow: hidden;
          box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04);
          animation: ajSlideIn 0.2s cubic-bezier(0.34,1.56,0.64,1);
        }
        @keyframes ajSlideIn { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }

        /* ── WorkspacePicker ── */
        .ajwp-list { display: flex; flex-direction: column; gap: 3px; max-height: 180px; overflow-y: auto; }
        .ajwp-empty { font-size: 11px; color: #4b5563; text-align: center; padding: 10px 0; }
        .ajwp-item {
          display: flex; align-items: center; gap: 8px;
          padding: 7px 9px; border-radius: 6px;
          cursor: pointer; border: 1px solid transparent;
          transition: background 0.15s, border-color 0.15s;
        }
        .ajwp-item:hover { background: rgba(255,255,255,0.04); }
        .ajwp-item.is-selected { background: rgba(167,139,250,0.08); border-color: rgba(167,139,250,0.25); }
        .ajwp-icon { font-size: 14px; flex-shrink: 0; opacity: 0.75; }
        .ajwp-info { flex: 1; min-width: 0; }
        .ajwp-name { display: block; font-size: 12px; font-weight: 600; color: #e5e7eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ajwp-item.is-selected .ajwp-name { color: #c4b5fd; }
        .ajwp-path { display: block; font-size: 10px; color: #6b7280; font-family: ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ajwp-rename-input {
          background: #08080f; border: 1px solid rgba(167,139,250,0.4);
          color: #f3f4f6; padding: 2px 6px; border-radius: 4px;
          font-size: 12px; font-weight: 600; outline: none; width: 100%;
          box-sizing: border-box;
        }
        .ajwp-rename-input:focus { border-color: rgba(167,139,250,0.7); }
        .ajwp-check { font-size: 12px; color: #a78bfa; flex-shrink: 0; }
        .ajwp-edit, .ajwp-del {
          background: none; border: 0; color: #4b5563;
          line-height: 1; padding: 2px 4px;
          cursor: pointer; border-radius: 4px;
          opacity: 0; transition: opacity 0.15s, color 0.15s; flex-shrink: 0;
        }
        .ajwp-edit { font-size: 12px; }
        .ajwp-del  { font-size: 16px; }
        .ajwp-item:hover .ajwp-edit, .ajwp-item:hover .ajwp-del,
        .ajwp-item.is-selected .ajwp-edit, .ajwp-item.is-selected .ajwp-del { opacity: 1; }
        .ajwp-edit:hover { color: #a78bfa; background: rgba(167,139,250,0.1); }
        .ajwp-del:hover  { color: #ef4444; background: rgba(239,68,68,0.1); }
        .ajwp-add-btn {
          width: 100%;
          background: rgba(167,139,250,0.07);
          border: 1px dashed rgba(167,139,250,0.3);
          color: #a78bfa; padding: 7px;
          border-radius: 6px; font-size: 12px;
          cursor: pointer; transition: all 0.2s;
          text-align: center; margin-top: 4px;
        }
        .ajwp-add-btn:hover { background: rgba(167,139,250,0.13); border-style: solid; }

        .aj-agent-picker { display: flex; flex-wrap: wrap; gap: 6px; }
        .aj-agent-chip {
          display: flex; align-items: center; gap: 5px;
          background: #111120; border: 1px solid rgba(255,255,255,0.07); color: #9ca3af;
          padding: 5px 10px; border-radius: 6px;
          font-size: 12px; cursor: pointer; transition: all 0.15s;
        }
        .aj-agent-chip:hover { border-color: rgba(255,255,255,0.15); color: #d1d5db; }
        .aj-agent-chip.is-selected { background: rgba(167,139,250,0.1); border-color: rgba(167,139,250,0.4); color: #c4b5fd; }

        /* ── Schedule Picker (new design) ── */
        .sp-root {
          background: #0a0a14;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 8px; overflow: hidden;
        }
        .sp-mode-tabs {
          display: flex;
          background: rgba(255,255,255,0.03);
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .sp-mode-tab {
          flex: 0 0 auto;
          background: none; border: 0;
          color: #6b7280; padding: 9px 18px;
          font-size: 12px; font-weight: 600;
          cursor: pointer; transition: all 0.15s;
          border-bottom: 2px solid transparent;
        }
        .sp-mode-tab:hover { color: #d1d5db; }
        .sp-mode-tab.is-active { color: #c4b5fd; border-bottom-color: #a78bfa; background: rgba(167,139,250,0.06); }

        .sp-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
        .sp-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .sp-row--days { align-items: flex-start; }
        .sp-row--kind .sp-radio { flex-shrink: 0; }

        .sp-label {
          font-size: 11px; font-weight: 600;
          color: #9ca3af; min-width: 100px; flex-shrink: 0;
          text-transform: uppercase; letter-spacing: 0.05em;
        }
        .sp-hint { font-size: 11px; color: #6b7280; }
        .sp-tz   { font-size: 11px; color: #a78bfa; font-family: ui-monospace, monospace; }

        .sp-radio {
          display: inline-flex; align-items: center; gap: 6px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          padding: 6px 12px; border-radius: 6px;
          cursor: pointer; font-size: 12px;
          color: #9ca3af; transition: all 0.15s;
        }
        .sp-radio input { accent-color: #a78bfa; }
        .sp-radio:hover { border-color: rgba(255,255,255,0.15); color: #d1d5db; }
        .sp-radio.is-on { background: rgba(167,139,250,0.1); border-color: rgba(167,139,250,0.4); color: #c4b5fd; }

        .sp-num, .sp-sel, .sp-time {
          background: #08080f;
          border: 1px solid rgba(255,255,255,0.09);
          color: #f3f4f6; padding: 6px 10px;
          border-radius: 5px; font-size: 13px; outline: none;
          transition: border-color 0.15s;
        }
        .sp-num { width: 60px; text-align: center; }
        .sp-sel { cursor: pointer; min-width: 110px; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; padding-right: 24px; }
        .sp-time { width: 110px; font-family: ui-monospace, monospace; color-scheme: dark; }
        .sp-num:focus, .sp-sel:focus, .sp-time:focus { border-color: rgba(167,139,250,0.5); }

        .sp-day-pills { display: flex; gap: 5px; flex-wrap: wrap; }
        .sp-day-btn {
          width: 38px; height: 32px;
          border-radius: 6px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          color: #6b7280;
          font-size: 11px; font-weight: 600;
          cursor: pointer; transition: all 0.15s;
        }
        .sp-day-btn:hover { border-color: rgba(167,139,250,0.3); color: #c4b5fd; }
        .sp-day-btn.is-on { background: rgba(167,139,250,0.15); border-color: rgba(167,139,250,0.5); color: #c4b5fd; }

        .sp-day-presets {
          display: flex; gap: 10px;
          width: 100%;
          padding-left: 110px;
          margin-top: 4px;
        }
        .sp-preset-link {
          background: none; border: 0; color: #6b7280;
          font-size: 11px; cursor: pointer; padding: 0;
          text-decoration: underline; text-underline-offset: 2px;
          transition: color 0.15s;
        }
        .sp-preset-link:hover { color: #a78bfa; }

        .sp-cron-input {
          flex: 1;
          background: #08080f;
          border: 1px solid rgba(255,255,255,0.1);
          color: #e5e7eb; padding: 7px 11px;
          border-radius: 5px;
          font-family: ui-monospace, monospace; font-size: 13px;
          outline: none; transition: border-color 0.15s;
          min-width: 220px;
        }
        .sp-cron-input:focus { border-color: rgba(167,139,250,0.5); }
        .sp-cron-input::placeholder { color: #374151; }

        .sp-advanced-help {
          padding-left: 110px;
          display: flex; flex-direction: column; gap: 4px;
          font-size: 11px;
        }
        .sp-err { color: #f87171; }

        .sp-footer {
          display: flex; align-items: center; justify-content: space-between; gap: 10px;
          padding: 10px 16px;
          border-top: 1px solid rgba(255,255,255,0.05);
          background: rgba(255,255,255,0.015);
          flex-wrap: wrap;
        }
        .sp-next { font-size: 12px; color: #d1d5db; }
        .sp-next strong { color: #c4b5fd; font-weight: 600; }
        .sp-muted { color: #6b7280; }
        .sp-cron-pill {
          font-family: ui-monospace, monospace; font-size: 11px;
          color: #a78bfa;
          background: rgba(167,139,250,0.1);
          border: 1px solid rgba(167,139,250,0.2);
          padding: 3px 9px; border-radius: 4px;
          white-space: nowrap; flex-shrink: 0;
        }

        /* Toggle */
        .aj-toggle { display: flex; align-items: center; cursor: pointer; }
        .aj-toggle input { display: none; }
        .aj-toggle-track {
          width: 36px; height: 20px; border-radius: 10px;
          background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.1);
          position: relative; transition: all 0.2s;
        }
        .aj-toggle-track::after {
          content: ''; position: absolute; top: 2px; left: 2px;
          width: 14px; height: 14px; border-radius: 7px;
          background: #6b7280; transition: all 0.2s;
        }
        .aj-toggle input:checked + .aj-toggle-track { background: rgba(167,139,250,0.3); border-color: #a78bfa; }
        .aj-toggle input:checked + .aj-toggle-track::after { left: 18px; background: #a78bfa; }

        /* Badges & buttons */
        .aj-badge {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 2px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; white-space: nowrap;
        }
        .aj-badge--sm { padding: 2px 6px; font-size: 10px; }
        .aj-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .aj-dot--pulse { animation: aj-pulse 1.5s ease-in-out infinite; }
        @keyframes aj-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.75); } }

        .aj-btn {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 6px 13px; border-radius: 6px;
          font-size: 12px; font-weight: 500;
          cursor: pointer; border: 1px solid transparent;
          transition: all 0.15s; white-space: nowrap;
        }
        .aj-btn--primary { background: #7c3aed; color: #fff; }
        .aj-btn--primary:hover { filter: brightness(1.12); }
        .aj-btn--primary:disabled { background: #1f1f30; color: #4b5563; cursor: not-allowed; }
        .aj-btn--ghost { background: none; border-color: rgba(255,255,255,0.1); color: #d1d5db; }
        .aj-btn--ghost:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.18); }
        .aj-btn--danger { background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.3); color: #f87171; }
        .aj-btn--danger:hover { background: rgba(239,68,68,0.18); }
        .aj-btn--red { color: #f87171; }
        .aj-btn--red:hover { color: #fca5a5; border-color: rgba(248,113,113,0.3); }
        .aj-btn--accent-outline { border-color: rgba(167,139,250,0.4); color: #a78bfa; }

        .aj-section-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #a78bfa; }
        .aj-muted { color: #6b7280; font-size: 11px; }
        .aj-mono  { font-family: ui-monospace, monospace; }
        .aj-schedule-tag {
          background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.07);
          padding: 1px 6px; border-radius: 4px; font-size: 10px; color: #9ca3af;
        }

        /* Scrollbars */
        .aj-jobs-scroll::-webkit-scrollbar, .aj-detail::-webkit-scrollbar,
        .aj-form-body::-webkit-scrollbar, .aj-right-pane::-webkit-scrollbar { width: 5px; }
        .aj-jobs-scroll::-webkit-scrollbar-thumb, .aj-detail::-webkit-scrollbar-thumb,
        .aj-form-body::-webkit-scrollbar-thumb, .aj-right-pane::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.07); border-radius: 3px; }
      `}</style>

      <div className="aj-root">
        {/* Left list */}
        <div className="aj-list-pane">
          <div className="aj-list-header">
            <div className="aj-list-toprow">
              <span className="aj-list-title">
                Scheduled Jobs
                {tz && <span className="aj-tz-tag" title="Server timezone">· {tz}</span>}
              </span>
              <button className="aj-new-btn" onClick={() => { setEditJob(null); setShowForm(true); }}>
                + New Job
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
                <button
                  key={f.id}
                  className={`aj-filter-btn ${filter === f.id ? 'is-active' : ''}`}
                  onClick={() => setFilter(f.id)}
                >
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
                {jobs.length === 0 ? (
                  <>No jobs yet.<br />Click <strong>+ New Job</strong> to get started.</>
                ) : `No ${filter} jobs.`}
              </div>
            ) : (
              filteredJobs.map(job => (
                <JobCard
                  key={job.id}
                  job={job}
                  agents={agents}
                  workspaces={workspaces}
                  isSelected={selectedId === job.id}
                  onClick={() => handleSelect(job.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Right detail (form is now a modal) */}
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
            />
          ) : (
            <div className="aj-detail-empty">
              <div className="aj-detail-empty-orb">📋</div>
              <div>
                <strong style={{ color: '#9ca3af', fontSize: 14 }}>Select a job to view details</strong><br />
                <span style={{ fontSize: 12 }}>or create a new scheduled job</span>
              </div>
              <button className="aj-btn aj-btn--primary" onClick={() => { setEditJob(null); setShowForm(true); }}>
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
          activeWsId={activeWsId}
          tz={tz}
          onSave={editJob ? (data) => handleUpdate(editJob.id, data) : handleCreate}
          onCancel={() => { setShowForm(false); setEditJob(null); }}
        />
      )}
    </>
  );
}

// ─── Standalone tab wrapper ───────────────────────────────────────────────────
export function AgentJobsTab() {
  const [workspaces, setWorkspaces] = useState([]);
  const [agents, setAgents]         = useState([]);
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
