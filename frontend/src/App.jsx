import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import './App.css';
import { motion, AnimatePresence } from 'framer-motion';
import pkg from '../package.json';
import {
  Server,
  Box,
  Globe,
  RefreshCcw,
  Terminal,
  Activity,
  ArrowUpRight,
  Shield,
  Cpu,
  Monitor,
  Zap,
  HardDrive,
  List,
  Thermometer,
  Star,
  Pencil,
  Copy,
  Eye,
  X,
  Search,
  Sun,
  Moon,
  Check,
  TerminalSquare,
  Play,
  Bot,
  Trash2,
  Plus,
  Layers,
  Heart,
  AlertTriangle,
  Minus,
  Maximize2,
  Folder,
  FolderOpen,
  UserPlus,
  Users,
  Settings,
  Power,
  FileText,
  CheckCircle2,
  Lock,
  Unlock,
  Network
} from 'lucide-react';

const relativeTime = (ms) => {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
};

const AddManualModal = ({ onSubmit, onClose, submitting }) => {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !url.trim()) {
      setError('Name and URL are required');
      return;
    }
    try {
      await onSubmit({ name: name.trim(), url: url.trim(), label: label.trim() || null });
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to add');
    }
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="preview-overlay"
      onClick={onClose}
    >
      <motion.form
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="manual-form"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="manual-form-header">
          <span>Add service</span>
          <button type="button" className="preview-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <label className="manual-field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Plex (LAN)" autoFocus />
        </label>
        <label className="manual-field">
          <span>URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.50:32400" type="url" />
        </label>
        <label className="manual-field">
          <span>Label (optional)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Plex Media Server" />
        </label>
        {error && <div className="manual-error">{error}</div>}
        <div className="manual-actions">
          <button type="button" className="action-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="action-button web" disabled={submitting}>
            {submitting ? 'Adding…' : 'Add service'}
          </button>
        </div>
      </motion.form>
    </motion.div>
  );
};
import { Terminal as XTermTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

const VALID_TABS = new Set(['web', 'backend', 'agents', 'cpu', 'ram', 'samba']);
const getInitialTab = () => {
  if (typeof window === 'undefined') return 'web';
  const t = new URLSearchParams(window.location.search).get('tab');
  return VALID_TABS.has(t) ? t : 'web';
};

const PINS_KEY = 'dashboard.pins';
const LABELS_KEY = 'dashboard.labels';
const THEME_KEY = 'dashboard.theme';

const serviceId = (s) => `${s.name}|${s.ports ? s.ports.join(',') : s.port}`;

const safeLoadJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const usePersistedSet = (key) => {
  const [set, setSet] = useState(() => new Set(safeLoadJSON(key, [])));
  const toggle = useCallback((id) => {
    setSet(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(key, JSON.stringify([...next])); } catch {}
      return next;
    });
  }, [key]);
  return [set, toggle];
};

const usePersistedMap = (key) => {
  const [map, setMap] = useState(() => safeLoadJSON(key, {}));
  const setEntry = useCallback((id, value) => {
    setMap(prev => {
      const next = { ...prev };
      if (value === null || value === '') delete next[id];
      else next[id] = value;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [key]);
  return [map, setEntry];
};

const PreviewModal = ({ url, title, onClose }) => {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="preview-overlay"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="preview-frame"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="preview-header">
          <div className="preview-title">
            <Eye size={14} />
            <span>{title || url}</span>
          </div>
          <div className="preview-actions">
            <a href={url} target="_blank" rel="noopener noreferrer" className="preview-open">
              Open in new tab <ArrowUpRight size={14} />
            </a>
            <button type="button" className="preview-close" onClick={onClose} aria-label="Close preview">
              <X size={16} />
            </button>
          </div>
        </div>
        <iframe
          title={title || 'Service preview'}
          src={url}
          className="preview-iframe"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
        />
        <div className="preview-fallback">
          Some apps refuse to be embedded (X-Frame-Options/CSP). If the panel stays blank, use "Open in new tab".
        </div>
      </motion.div>
    </motion.div>
  );
};

const TerminalPane = ({ session, active, onStatusChange }) => {
  const hostRef = React.useRef(null);
  const termRef = React.useRef(null);
  const fitRef = React.useRef(null);
  const wsRef = React.useRef(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new XTermTerminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: true,
      theme: {
        background: '#0a0a0a',
        foreground: '#f5f5f5',
        cursor: '#3b82f6',
        selectionBackground: 'rgba(59,130,246,0.35)',
      },
      allowTransparency: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    try { fit.fit(); } catch (e) {}
    termRef.current = term;
    fitRef.current = fit;

    term.writeln('\x1b[2m· connecting …\x1b[0m');

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams();
    if (session.agent) params.set('agent', session.agent.id);
    if (session.docker) params.set('docker', session.docker);
    params.set('cols', String(term.cols));
    params.set('rows', String(term.rows));
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/terminal?${params.toString()}`);
    wsRef.current = ws;
    let opened = false;
    onStatusChange?.('connecting');
    ws.onopen = () => {
      opened = true;
      onStatusChange?.('connected');
      try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {}
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        term.write(e.data);
      } else if (e.data instanceof Blob) {
        e.data.text().then((t) => term.write(t));
      }
    };
    ws.onclose = (event) => {
      onStatusChange?.('closed');
      if (!opened && term && event.code !== 1000) {
        term.writeln(`\r\n\x1b[31m✗ connection refused (code ${event.code}). The backend may not allow this origin.\x1b[0m`);
      }
    };
    ws.onerror = () => onStatusChange?.('error');

    term.onData((d) => {
      if (ws.readyState === ws.OPEN) ws.send(d);
    });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch {}
      }
    });

    const onWinResize = () => {
      try { fit.fit(); } catch (e) {}
    };
    window.addEventListener('resize', onWinResize);
    setTimeout(onWinResize, 60);
    setTimeout(onWinResize, 250);

    return () => {
      window.removeEventListener('resize', onWinResize);
      try { ws.close(); } catch (e) {}
      try { term.dispose(); } catch (e) {}
    };
  }, [session.id]);

  useEffect(() => {
    if (active && fitRef.current) {
      const id = setTimeout(() => {
        try { fitRef.current.fit(); } catch {}
        try { termRef.current?.focus(); } catch {}
      }, 60);
      return () => clearTimeout(id);
    }
  }, [active]);

  return (
    <div className={`terminal-pane ${active ? 'is-active' : ''}`}>
      <div ref={hostRef} className="terminal-body" />
    </div>
  );
};

const TerminalOverlay = ({
  terminals,
  activeId,
  statuses,
  minimized,
  onSwitchTab,
  onCloseTab,
  onNewTerminal,
  onMinimize,
  onRestore,
  onCloseAll,
  onStatusChange,
}) => {
  const activeTerminal = terminals.find(t => t.id === activeId);
  const activeStatus = statuses[activeId] || 'connecting';
  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: '4%' }}
        animate={minimized
          ? { opacity: 0, y: '100%' }
          : { opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: '4%' }}
        transition={{ duration: 0.18 }}
        className="terminal-overlay"
        style={{
          pointerEvents: minimized ? 'none' : 'auto',
          visibility: minimized ? 'hidden' : 'visible',
        }}
        aria-hidden={minimized}
      >
        <div className="terminal-overlay-header">
          <div className="terminal-tabs">
            {terminals.map(t => {
              const status = statuses[t.id] || 'connecting';
              const isActive = t.id === activeId;
              return (
                <div
                  key={t.id}
                  className={`terminal-tab ${isActive ? 'is-active' : ''}`}
                  onClick={() => onSwitchTab(t.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSwitchTab(t.id); }}
                >
                  <span className={`terminal-tab-dot terminal-status-${status}`} />
                  <TerminalSquare size={12} />
                  <span className="terminal-tab-label">{t.docker ? `🐳 ${t.docker}` : t.agent ? t.agent.label : `Shell ${t.shellIndex}`}</span>
                  <button
                    type="button"
                    className="terminal-tab-close"
                    onClick={(e) => { e.stopPropagation(); onCloseTab(t.id); }}
                    aria-label="Close tab"
                    title="Close tab"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="terminal-tab-add"
              onClick={() => onNewTerminal(null)}
              aria-label="New terminal"
              title="New terminal"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="terminal-overlay-controls">
            <button
              type="button"
              className="icon-button"
              onClick={onMinimize}
              aria-label="Minimize"
              title="Minimize (terminals keep running)"
            >
              <Minus size={14} />
            </button>
            <button
              type="button"
              className="icon-button danger"
              onClick={onCloseAll}
              aria-label="Close all terminals"
              title="Close all terminals"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="terminal-panes">
          {terminals.map(t => (
            <TerminalPane
              key={t.id}
              session={t}
              active={t.id === activeId}
              onStatusChange={(s) => onStatusChange(t.id, s)}
            />
          ))}
        </div>
      </motion.div>
      {minimized && terminals.length > 0 && (
        <div
          className="terminal-chip"
          role="button"
          tabIndex={0}
          onClick={onRestore}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onRestore(); }}
          title="Restore terminal"
        >
          <TerminalSquare size={14} />
          <span className="terminal-chip-title">
            {activeTerminal?.agent?.label || `Shell ${activeTerminal?.shellIndex || ''}`}
          </span>
          {terminals.length > 1 && (
            <span className="terminal-chip-count">+{terminals.length - 1}</span>
          )}
          <span className={`terminal-status terminal-status-${activeStatus}`}>{activeStatus}</span>
          <button
            type="button"
            className="terminal-chip-action"
            onClick={(e) => { e.stopPropagation(); onRestore(); }}
            aria-label="Restore"
            title="Restore"
          >
            <Maximize2 size={12} />
          </button>
          <button
            type="button"
            className="terminal-chip-action danger"
            onClick={(e) => { e.stopPropagation(); onCloseAll(); }}
            aria-label="Close all"
            title="Close all terminals"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </>
  );
};

const AgentCard = ({ agent, onRun }) => (
  <motion.div
    layout
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, scale: 0.95 }}
    whileHover={{ y: -5, boxShadow: '0 20px 25px -5px rgba(0,0,0,0.12)' }}
    className="service-card"
  >
    <div className="card-header">
      <div className="icon-box web">
        <Bot size={22} />
      </div>
      <div className="card-actions">
        <div className="status-indicator">
          <div className="dot active" />
          <span>Installed</span>
        </div>
      </div>
    </div>
    <div className="card-content">
      <div className="type-badge">{agent.vendor || 'CLI Agent'}</div>
      <h3 title={agent.realPath}>{agent.label}</h3>
      <div className="port-info">
        <TerminalSquare size={12} />
        <span>{agent.cmd}{agent.version ? ` · v${agent.version}` : ''}</span>
      </div>
      <div className="agent-path" title={agent.path}>{agent.path}</div>
    </div>
    <div className="action-row">
      <button
        type="button"
        className="action-button web"
        onClick={() => onRun(agent)}
      >
        Run <Play size={14} />
      </button>
    </div>
  </motion.div>
);

const TempIndicator = ({ label, value, color }) => {
  const getTempColor = (t) => {
    if (t > 70) return '#ef4444'; // Red
    if (t > 55) return '#f59e0b'; // Amber
    return color || '#10b981'; // Green
  };

  return (
    <div className="temp-stat">
      <div className="temp-icon" style={{ color: getTempColor(value) }}>
        <Thermometer size={14} />
      </div>
      <span className="temp-label">{label}:</span>
      <span className="temp-value" style={{ color: getTempColor(value) }}>{value.toFixed(1)}°C</span>
    </div>
  );
};

const MetricCard = ({ label, value, unit, icon: Icon, color, raw, active, onClick }) => {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -5 }}
      onClick={onClick}
      className={`metric-card ${active ? 'active' : ''}`}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <div className="metric-header">
        <div className="metric-icon" style={{ backgroundColor: `${color}15`, color }}>
          <Icon size={18} />
        </div>
        <span className="metric-label">{label}</span>
      </div>
      <div className="metric-body">
        <div className="metric-value-wrapper">
          <span className="metric-value">{value.toFixed(1)}</span>
          <span className="metric-unit">{unit}</span>
        </div>
        <div className="metric-progress-bg">
          <motion.div 
            className="metric-progress-fill"
            initial={{ width: 0 }}
            animate={{ width: `${value}%` }}
            style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}40` }}
          />
        </div>
        {raw && <div className="metric-raw">{raw}</div>}
      </div>
      {active && <div className="metric-active-dot" style={{ backgroundColor: color }} />}
    </motion.div>
  );
};

const ProcessList = ({ title, data, unit, color }) => {
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="process-list-container"
    >
      <div className="process-list-header">
        <List size={18} />
        <span>{title}</span>
      </div>
      <div className="process-items">
        {data.map((proc, i) => (
          <div key={`${proc.name}-${i}`} className="process-item">
            <div className="proc-info">
              <span className="proc-rank">#{i + 1}</span>
              <span className="proc-name">{proc.name}</span>
            </div>
            <div className="proc-stats">
              <div className="proc-bar-bg">
                <div 
                  className="proc-bar-fill" 
                  style={{ width: `${Math.min(proc.val, 100)}%`, backgroundColor: color }} 
                />
              </div>
              <span className="proc-val">{proc.val.toFixed(1)}{unit}</span>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
};

const DockerLogsModal = ({ containerName, logs, loading, onClose }) => {
  const logsRef = React.useRef(null);
  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);
  if (!containerName) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div
        className="modal-container"
        style={{ maxWidth: '860px', width: '95vw' }}
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <FileText size={16} />
            Logs — <code style={{ fontSize: '0.85em', color: 'var(--accent)' }}>{containerName}</code>
          </span>
          <button className="modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div
          ref={logsRef}
          style={{
            background: '#0a0a0a',
            borderRadius: '8px',
            padding: '1rem',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: '0.72rem',
            color: '#d4d4d4',
            lineHeight: 1.6,
            maxHeight: '60vh',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            border: '1px solid rgba(255,255,255,0.06)'
          }}
        >
          {loading ? (
            <span style={{ color: 'var(--text-muted)' }}>Loading logs…</span>
          ) : (
            logs || <span style={{ color: 'var(--text-muted)' }}>No logs available.</span>
          )}
        </div>
      </motion.div>
    </div>
  );
};

const ResourcesMonitor = ({ processes, gpuUtil, stats }) => {
  const maxGpu = processes.reduce((m, p) => Math.max(m, p.gpu || 0), 1);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="process-list-container" style={{ maxWidth: '900px', margin: '0 auto' }}>
      <div className="process-list-header">
        <Activity size={18} />
        <span>Application Resource Usage</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', gap: '1.5rem' }}>
          <span>CPU: <strong style={{ color: '#3b82f6' }}>{stats.cpu.toFixed(1)}%</strong></span>
          <span>RAM: <strong style={{ color: '#8b5cf6' }}>{stats.ram.toFixed(1)}%</strong></span>
          {gpuUtil > 0 && <span>GPU: <strong style={{ color: '#10b981' }}>{gpuUtil.toFixed(1)}%</strong></span>}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px 90px', gap: '0 0.5rem', padding: '0.4rem 0.75rem', fontSize: '0.68rem', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        <span>Process</span><span style={{ textAlign: 'right' }}>CPU</span><span style={{ textAlign: 'right' }}>RAM</span><span style={{ textAlign: 'right' }}>GPU VRAM</span>
      </div>
      <div className="process-items">
        {processes.map((proc, i) => (
          <div key={`${proc.name}-${proc.pid}-${i}`} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px 90px', gap: '0 0.5rem', padding: '0.5rem 0.75rem', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
              <span className="proc-rank" style={{ flexShrink: 0 }}>#{i + 1}</span>
              <span className="proc-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{proc.name}</span>
            </div>
            {/* CPU */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', justifyContent: 'flex-end' }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(59,130,246,0.15)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(proc.cpu, 100)}%`, background: '#3b82f6', borderRadius: 2, transition: 'width 0.4s' }} />
              </div>
              <span style={{ fontSize: '0.72rem', color: '#3b82f6', minWidth: 34, textAlign: 'right' }}>{proc.cpu.toFixed(1)}%</span>
            </div>
            {/* RAM */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', justifyContent: 'flex-end' }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(139,92,246,0.15)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(proc.mem, 100)}%`, background: '#8b5cf6', borderRadius: 2, transition: 'width 0.4s' }} />
              </div>
              <span style={{ fontSize: '0.72rem', color: '#8b5cf6', minWidth: 34, textAlign: 'right' }}>{proc.mem.toFixed(1)}%</span>
            </div>
            {/* GPU */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', justifyContent: 'flex-end' }}>
              {proc.gpu > 0 ? (
                <>
                  <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(16,185,129,0.15)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min((proc.gpu / maxGpu) * 100, 100)}%`, background: '#10b981', borderRadius: 2, transition: 'width 0.4s' }} />
                  </div>
                  <span style={{ fontSize: '0.72rem', color: '#10b981', minWidth: 44, textAlign: 'right' }}>{proc.gpu}MB</span>
                </>
              ) : (
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', minWidth: 44, textAlign: 'right' }}>—</span>
              )}
            </div>
          </div>
        ))}
        {processes.length === 0 && (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>No process data available.</div>
        )}
      </div>
    </motion.div>
  );
};

const ServiceCard = ({ service, pinned, customLabel, onTogglePin, onEditLabel, onCopyUrl, onPreview, onDelete, onDockerControl, onDockerLogs, onDockerTerminal }) => {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const showFavicon = service.isWebUi && service.favicon && !faviconFailed;
  const heading = customLabel || service.displayName || service.name;

  const handleCopy = async () => {
    if (!service.url) return;
    await onCopyUrl(service.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      whileHover={{ y: -5, boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)' }}
      className={`service-card ${pinned ? 'pinned' : ''}`}
    >
      <div className="card-header">
        <div className={`icon-box ${service.isWebUi ? 'web' : 'backend'}`}>
          {showFavicon ? (
            <img
              src={service.favicon}
              alt=""
              className="service-favicon"
              onError={() => setFaviconFailed(true)}
            />
          ) : (
            service.isWebUi ? <Globe size={22} /> : (service.type === 'docker' ? <Box size={22} /> : <Cpu size={22} />)
          )}
        </div>
        <div className="card-actions">
          <button
            type="button"
            className={`icon-button ${pinned ? 'active' : ''}`}
            onClick={onTogglePin}
            aria-label={pinned ? 'Unpin service' : 'Pin service'}
            title={pinned ? 'Unpin' : 'Pin to top'}
          >
            <Star size={14} fill={pinned ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onEditLabel}
            aria-label="Edit label"
            title={customLabel ? 'Edit label' : 'Add custom label'}
          >
            <Pencil size={14} />
          </button>
          {service.type === 'manual' && (
            <button
              type="button"
              className="icon-button"
              onClick={onDelete}
              aria-label="Delete manual service"
              title="Remove this manual entry"
            >
              <Trash2 size={14} />
            </button>
          )}
          {service.health && (
            <span className={`health-badge health-${service.health}`} title={`Container health: ${service.health}`}>
              {service.health === 'unhealthy' ? <AlertTriangle size={12} /> : <Heart size={12} />}
              <span>{service.health}</span>
            </span>
          )}
          {!service.health && (
            <div className="status-indicator">
              <div className={`dot ${service.isRunning === false ? 'stopped' : 'active'}`} />
              <span>{service.type === 'manual' ? 'Manual' : service.isRunning === false ? 'Stopped' : 'Running'}</span>
            </div>
          )}
        </div>
      </div>

      <div className="card-content">
        <div className="badge-row">
          <span className="type-badge">
            {service.type === 'docker' ? 'Container' : service.type === 'manual' ? 'Manual' : 'Native Process'}
          </span>
          {service.composeProject && (
            <span className="compose-badge" title={`Compose project: ${service.composeProject}`}>
              <Layers size={11} />
              {service.composeProject}
            </span>
          )}
        </div>
        <h3 title={service.displayName || service.name}>{heading}</h3>
        <div className="port-info">
          <Terminal size={12} />
          <span>Port: {service.port}</span>
        </div>
        
        <div className="card-usage-stats">
          <div className="usage-item">
            <span className="usage-label">CPU</span>
            <div className="usage-bar-bg">
              <motion.div 
                className="usage-bar-fill cpu" 
                animate={{ width: `${Math.min(service.usage.cpu, 100)}%` }} 
              />
            </div>
            <span className="usage-val">{service.usage.cpu.toFixed(1)}%</span>
          </div>
          <div className="usage-item">
            <span className="usage-label">RAM</span>
            <div className="usage-bar-bg">
              <motion.div 
                className="usage-bar-fill ram" 
                animate={{ width: `${Math.min(service.usage.mem, 100)}%` }} 
              />
            </div>
            <span className="usage-val">{service.usage.mem.toFixed(1)}%</span>
          </div>
        </div>
      </div>

      {service.isWebUi ? (
        <div className="action-row">
          <a
            href={service.url}
            target="_blank"
            rel="noopener noreferrer"
            className="action-button web"
          >
            Launch <ArrowUpRight size={16} />
          </a>
          <button
            type="button"
            className="action-secondary"
            onClick={() => onPreview(service)}
            aria-label="Preview in dashboard"
            title="Preview here"
          >
            <Eye size={14} />
          </button>
          <button
            type="button"
            className="action-secondary"
            onClick={handleCopy}
            aria-label="Copy URL"
            title={copied ? 'Copied!' : 'Copy URL'}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {service.type === 'docker' && onDockerLogs && (
            <button type="button" className="action-secondary" onClick={() => onDockerLogs(service.containerName || service.name)} title="View logs"><FileText size={14} /></button>
          )}
          {service.type === 'docker' && service.isRunning && onDockerTerminal && (
            <button type="button" className="action-secondary" onClick={() => onDockerTerminal(service.containerName || service.name)} title="Open terminal in container"><Terminal size={14} /></button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {service.type === 'docker' ? (
            <div className="action-row" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
              {service.isRunning ? (
                <>
                  <button type="button" className="action-button backend" style={{ cursor: 'pointer', background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }} onClick={() => onDockerControl && onDockerControl(service.containerName || service.name, 'stop')} title="Stop container">
                    <Minus size={14} /><span>Stop</span>
                  </button>
                  <button type="button" className="action-button backend" style={{ cursor: 'pointer', background: 'rgba(251,191,36,0.12)', color: '#f59e0b', border: '1px solid rgba(251,191,36,0.3)' }} onClick={() => onDockerControl && onDockerControl(service.containerName || service.name, 'restart')} title="Restart container">
                    <RefreshCcw size={14} /><span>Restart</span>
                  </button>
                </>
              ) : (
                <button type="button" className="action-button backend" style={{ cursor: 'pointer', background: 'rgba(34,197,94,0.12)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)' }} onClick={() => onDockerControl && onDockerControl(service.containerName || service.name, 'start')} title="Start container">
                  <Play size={14} /><span>Start</span>
                </button>
              )}
              <button type="button" className="action-secondary" onClick={() => onDockerLogs && onDockerLogs(service.containerName || service.name)} title="View logs"><FileText size={14} /></button>
              {service.isRunning && <button type="button" className="action-secondary" onClick={() => onDockerTerminal && onDockerTerminal(service.containerName || service.name)} title="Open shell in container"><Terminal size={14} /></button>}
            </div>
          ) : (
            <div className="action-button backend">
              <Shield size={16} />
              <span>System Protected</span>
            </div>
          )}
        </div>
      )}
      {service.firstSeen && (
        <div className="last-seen" title={`First seen: ${new Date(service.firstSeen).toLocaleString()}`}>
          Seen {relativeTime(service.lastSeen)}
        </div>
      )}
    </motion.div>
  );
};

const FolderPickerModal = ({ isOpen, onClose, onSelect, initialPath = '' }) => {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [parentPath, setParentPath] = useState(null);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showHidden, setShowHidden] = useState(false);

  const fetchPath = async (targetPath, forceShowHidden) => {
    const isHiddenEnabled = forceShowHidden !== undefined ? forceShowHidden : showHidden;
    setLoading(true);
    setError(null);
    try {
      const basePath = targetPath ? encodeURIComponent(targetPath) : '';
      const url = `/api/samba/browse?path=${basePath}&showHidden=${isHiddenEnabled}`;
      const res = await axios.get(url);
      setCurrentPath(res.data.currentPath);
      setParentPath(res.data.parentPath);
      setFolders(res.data.folders || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleHidden = (e) => {
    const val = e.target.checked;
    setShowHidden(val);
    fetchPath(currentPath, val);
  };

  useEffect(() => {
    if (isOpen) {
      fetchPath(initialPath);
    }
  }, [isOpen, initialPath]);

  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="preview-overlay"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="preview-frame folder-picker-frame"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="preview-header">
          <div className="preview-title">
            <FolderOpen size={16} />
            <span>Select Shared Folder</span>
          </div>
          <button className="preview-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        
        <div className="folder-picker-body">
          <div className="folder-picker-path" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <div style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', flex: 1 }}>
              <strong>Current Path:</strong> <code>{currentPath}</code>
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', cursor: 'pointer', userSelect: 'none', color: 'var(--text-muted)', flexShrink: 0 }}>
              <input type="checkbox" checked={showHidden} onChange={handleToggleHidden} style={{ cursor: 'pointer' }} />
              <span>Show hidden folders</span>
            </label>
          </div>

          {error && <div className="manual-error">{error}</div>}

          <div className="folder-picker-list-container">
            {loading ? (
              <div className="empty-state"><RefreshCcw className="spinning" /> Loading directories...</div>
            ) : (
              <div className="folder-picker-list">
                {parentPath && (
                  <div className="folder-picker-item parent-dir" onClick={() => fetchPath(parentPath)}>
                    <Folder size={16} className="parent-folder-icon" />
                    <span>.. (Go Up)</span>
                  </div>
                )}
                {folders.length === 0 ? (
                  <div className="empty-state">No subdirectories found</div>
                ) : (
                  folders.map((f) => (
                    <div key={f.path} className="folder-picker-item" onDoubleClick={() => fetchPath(f.path)} onClick={() => setCurrentPath(f.path)}>
                      <Folder size={16} className="folder-icon" />
                      <span>{f.name}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        <div className="manual-actions folder-picker-actions">
          <button className="action-secondary" onClick={onClose}>Cancel</button>
          <button className="action-button web" onClick={() => { onSelect(currentPath); onClose(); }}>
            Select Current Folder
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};

const FixPermissionsModal = ({ isOpen, onClose, dirPath, onSubmit }) => {
  const [owner, setOwner] = useState('ayman');
  const [mode, setMode] = useState('0775');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ path: dirPath, owner, mode });
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="preview-overlay"
      onClick={onClose}
    >
      <motion.form
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="manual-form"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="manual-form-header">
          <span>Set Folder Permissions</span>
          <button type="button" className="preview-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-description-text">
          Adjust owner and access privileges for path:<br /><code>{dirPath}</code>
        </div>
        
        <label className="manual-field">
          <span>Owner (Linux User)</span>
          <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. ayman" required />
        </label>
        
        <label className="manual-field">
          <span>Permission Mode (Octal)</span>
          <input value={mode} onChange={(e) => setMode(e.target.value)} placeholder="e.g. 0775 or 0777" required />
        </label>
        
        <div className="hint-text">
          Use <code>0777</code> to allow completely anonymous read/write access, or <code>0775</code> to restrict edits to users in the same group.
        </div>

        {error && <div className="manual-error">{error}</div>}

        <div className="manual-actions">
          <button type="button" className="action-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="action-button web" disabled={submitting}>
            {submitting ? 'Applying...' : 'Apply Permissions'}
          </button>
        </div>
      </motion.form>
    </motion.div>
  );
};

const ConfirmModal = ({ isOpen, title, message, onConfirm, onCancel, confirmText = "Confirm", cancelText = "Cancel", isDanger = false }) => {
  if (!isOpen) return null;

  return (
    <div className="preview-overlay" style={{ zIndex: 110 }} onClick={onCancel}>
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="preview-frame folder-picker-frame"
        style={{ height: 'auto', maxHeight: '80vh', width: 'min(450px, 90%)', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="preview-header">
          <span className="preview-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: isDanger ? '#ef4444' : 'var(--text-main)' }}>
            <AlertTriangle size={18} />
            {title}
          </span>
          <button type="button" className="preview-close" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        
        <div className="preview-body" style={{ padding: '1.5rem', fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
          {message}
        </div>
        
        <div className="folder-picker-actions" style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', padding: '1.25rem', borderTop: '1px solid var(--border)' }}>
          <button type="button" className="action-secondary" onClick={onCancel} style={{ width: 'auto', padding: '0.55rem 1.25rem', marginTop: 0 }}>
            {cancelText}
          </button>
          <button 
            type="button" 
            className={`action-button web ${isDanger ? 'danger-btn' : ''}`}
            onClick={onConfirm} 
            style={{ width: 'auto', padding: '0.55rem 1.25rem', marginTop: 0 }}
          >
            {confirmText}
          </button>
        </div>
      </motion.div>
    </div>
  );
};

const SambaPanel = ({ showAlert, showConfirm }) => {
  const [subTab, setSubTab] = useState('shares');
  const [status, setStatus] = useState(null);
  const [shares, setShares] = useState([]);
  const [users, setUsers] = useState({ sambaUsers: [], systemUsers: [] });
  const [connections, setConnections] = useState([]);
  const [globalSettings, setGlobalSettings] = useState({ workgroup: 'WORKGROUP', serverString: '', mapToGuest: 'bad user' });
  const [logs, setLogs] = useState('Loading logs...');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Modal triggers
  const [showShareModal, setShowShareModal] = useState(false);
  const [editingShare, setEditingShare] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerTarget, setPickerTarget] = useState('share');
  const [pickerPath, setPickerPath] = useState('');
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [permissionsTarget, setPermissionsTarget] = useState('');
  
  // Users state
  const [showUserModal, setShowUserModal] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [createSysUser, setCreateSysUser] = useState(false);
  const [mapExistingUser, setMapExistingUser] = useState('');

  // Share form state
  const [shareName, setShareName] = useState('');
  const [shareOriginalName, setShareOriginalName] = useState('');
  const [sharePath, setSharePath] = useState('');
  const [shareComment, setShareComment] = useState('');
  const [shareWritable, setShareWritable] = useState(true);
  const [shareBrowsable, setShareBrowsable] = useState(true);
  const [shareGuestOk, setShareGuestOk] = useState(false);
  const [shareValidUsers, setShareValidUsers] = useState('');
  const [shareForceUser, setShareForceUser] = useState('');
  const [createFolder, setCreateFolder] = useState(true);
  const [shareError, setShareError] = useState(null);

  // Global settings form state
  const [globalWorkgroup, setGlobalWorkgroup] = useState('WORKGROUP');
  const [globalDesc, setGlobalDesc] = useState('');
  const [globalGuestMap, setGlobalGuestMap] = useState('bad user');
  const [globalError, setGlobalError] = useState(null);
  const [globalSuccess, setGlobalSuccess] = useState(false);

  // Connection guide expander state
  const [expandedGuide, setExpandedGuide] = useState(null);

  const refreshAll = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await Promise.all([
        fetchStatus(),
        fetchShares(),
        fetchUsers(),
        fetchConnections(),
        fetchGlobalSettings(),
        fetchLogs()
      ]);
    } catch (err) {
      setError('Failed to fetch Samba details: ' + err.message);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  };

  const fetchStatus = async () => {
    const res = await axios.get('/api/samba/status');
    setStatus(res.data);
  };

  const fetchShares = async () => {
    const res = await axios.get('/api/samba/shares');
    setShares(res.data);
  };

  const fetchUsers = async () => {
    const res = await axios.get('/api/samba/users');
    setUsers(res.data);
  };

  const fetchConnections = async () => {
    const res = await axios.get('/api/samba/connections');
    setConnections(res.data);
  };

  const fetchGlobalSettings = async () => {
    const res = await axios.get('/api/samba/global');
    setGlobalSettings(res.data);
    setGlobalWorkgroup(res.data.workgroup || 'WORKGROUP');
    setGlobalDesc(res.data.serverString || '');
    setGlobalGuestMap(res.data.mapToGuest || 'bad user');
  };

  const fetchLogs = async () => {
    const res = await axios.get('/api/samba/logs');
    setLogs(res.data.logs);
  };

  useEffect(() => {
    refreshAll();
    const interval = setInterval(() => {
      fetchConnections();
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleServiceToggle = async (action) => {
    try {
      await axios.post('/api/samba/status', { action });
      await fetchStatus();
    } catch (err) {
      showAlert('Command Failed', 'Failed to execute command: ' + (err.response?.data?.error || err.message), 'error');
    }
  };

  const openAddShare = () => {
    setEditingShare(null);
    setShareName('');
    setShareOriginalName('');
    setSharePath('/home/ayman/');
    setShareComment('');
    setShareWritable(true);
    setShareBrowsable(true);
    setShareGuestOk(false);
    setShareValidUsers('');
    setShareForceUser('');
    setCreateFolder(true);
    setShareError(null);
    setShowShareModal(true);
  };

  const openEditShare = (share) => {
    setEditingShare(share);
    setShareName(share.name);
    setShareOriginalName(share.name);
    setSharePath(share.path);
    setShareComment(share.comment);
    setShareWritable(share.writable);
    setShareBrowsable(share.browsable);
    setShareGuestOk(share.guestOk);
    setShareValidUsers(share.validUsers);
    setShareForceUser(share.forceUser);
    setCreateFolder(false);
    setShareError(null);
    setShowShareModal(true);
  };

  const handleShareSubmit = async (e) => {
    e.preventDefault();
    setShareError(null);
    if (!shareName.trim() || !sharePath.trim()) {
      setShareError('Share name and path are required');
      return;
    }
    try {
      if (createFolder) {
        await axios.post('/api/samba/permissions', {
          path: sharePath.trim(),
          owner: shareForceUser || 'ayman',
          mode: shareWritable ? '0775' : '0755'
        });
      }
      
      await axios.post('/api/samba/shares', {
        name: shareName.trim(),
        originalName: shareOriginalName,
        path: sharePath.trim(),
        comment: shareComment.trim(),
        writable: shareWritable,
        browsable: shareBrowsable,
        guestOk: shareGuestOk,
        validUsers: shareValidUsers,
        forceUser: shareForceUser
      });
      
      setShowShareModal(false);
      refreshAll();
    } catch (err) {
      setShareError(err.response?.data?.error || err.message);
    }
  };

  const handleDeleteShare = (name) => {
    showConfirm(
      'Delete Share',
      `Are you sure you want to delete share "${name}"? This removes its configuration but does NOT delete files.`,
      async () => {
        try {
          await axios.delete(`/api/samba/shares/${encodeURIComponent(name)}`);
          refreshAll();
        } catch (err) {
          showAlert('Delete Failed', 'Delete failed: ' + (err.response?.data?.error || err.message), 'error');
        }
      },
      true
    );
  };

  const handleSaveGlobal = async (e) => {
    e.preventDefault();
    setGlobalError(null);
    setGlobalSuccess(false);
    try {
      await axios.post('/api/samba/global', {
        workgroup: globalWorkgroup.trim(),
        serverString: globalDesc.trim(),
        mapToGuest: globalGuestMap
      });
      setGlobalSuccess(true);
      fetchStatus();
    } catch (err) {
      setGlobalError(err.response?.data?.error || err.message);
    }
  };

  const handleSaveUser = async (e) => {
    e.preventDefault();
    const username = createSysUser ? newUsername.trim() : mapExistingUser;
    if (!username) {
      showAlert('Input Required', 'Please select or specify a user.', 'error');
      return;
    }
    if (!newUserPassword) {
      showAlert('Input Required', 'Please specify a password.', 'error');
      return;
    }
    try {
      await axios.post('/api/samba/users', {
        username,
        password: newUserPassword,
        createSystemUser: createSysUser
      });
      setShowUserModal(false);
      setNewUsername('');
      setNewUserPassword('');
      setMapExistingUser('');
      setCreateSysUser(false);
      refreshAll();
    } catch (err) {
      showAlert('Save Failed', 'Failed to save user: ' + (err.response?.data?.error || err.message), 'error');
    }
  };

  const handleDeleteUser = (username) => {
    showConfirm(
      'Remove Samba Credentials',
      `Remove Samba credentials for "${username}"? (The Linux system user account will remain untouched).`,
      async () => {
        try {
          await axios.delete(`/api/samba/users/${encodeURIComponent(username)}`);
          refreshAll();
        } catch (err) {
          showAlert('Delete Failed', 'Delete failed: ' + (err.response?.data?.error || err.message), 'error');
        }
      },
      true
    );
  };

  const handlePermissionsSubmit = async (permData) => {
    try {
      await axios.post('/api/samba/permissions', permData);
      showAlert('Success', 'Folder permissions updated successfully!', 'success');
    } catch (err) {
      showAlert('Update Failed', 'Permissions update failed: ' + (err.response?.data?.error || err.message), 'error');
    }
  };

  return (
    <div className="samba-panel-container">
      <div className="samba-overview">
        {status ? (
          <div className="samba-overview-card">
            <div className="status-header-row">
              <div className="samba-title-group">
                <div className={`status-indicator ${status.active ? 'active' : 'inactive'}`}>
                  <div className="dot" />
                  <span>{status.active ? 'Samba Online' : 'Samba Stopped'}</span>
                </div>
                <h3>Samba Server (smbd)</h3>
              </div>
              <div className="samba-action-buttons">
                {status.active ? (
                  <>
                    <button type="button" className="refresh-button" onClick={() => handleServiceToggle('restart')}>
                      <RefreshCcw size={12} /> Restart
                    </button>
                    <button type="button" className="refresh-button danger-btn" onClick={() => handleServiceToggle('stop')}>
                      <Power size={12} /> Stop
                    </button>
                  </>
                ) : (
                  <button type="button" className="refresh-button success-btn" onClick={() => handleServiceToggle('start')}>
                    <Power size={12} /> Start
                  </button>
                )}
              </div>
            </div>
            
            <div className="samba-meta-grid">
              <div className="samba-meta-item">
                <span className="meta-label">Version</span>
                <span className="meta-value">{status.version}</span>
              </div>
              <div className="samba-meta-item">
                <span className="meta-label">Service PID</span>
                <span className="meta-value">{status.pid || '—'}</span>
              </div>
              <div className="samba-meta-item">
                <span className="meta-label">Uptime Since</span>
                <span className="meta-value">{status.uptime || '—'}</span>
              </div>
              <div className="samba-meta-item">
                <span className="meta-label">Workgroup</span>
                <span className="meta-value">{globalSettings.workgroup}</span>
              </div>
            </div>

            {status.ips.length > 0 && (
              <div className="samba-ip-list">
                <strong>Addresses:</strong>
                {status.ips.map(ip => (
                  <span key={ip.address} className="samba-ip-badge">
                    <Network size={10} /> {ip.address} ({ip.tag})
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="empty-state">Loading Samba Service Status...</div>
        )}
      </div>

      <div className="samba-tabs">
        <button type="button" className={`samba-tab-item ${subTab === 'shares' ? 'active' : ''}`} onClick={() => setSubTab('shares')}>
          <Folder size={14} /> Shares ({shares.length})
        </button>
        <button type="button" className={`samba-tab-item ${subTab === 'users' ? 'active' : ''}`} onClick={() => setSubTab('users')}>
          <Users size={14} /> Samba Users ({users.sambaUsers.length})
        </button>
        <button type="button" className={`samba-tab-item ${subTab === 'connections' ? 'active' : ''}`} onClick={() => setSubTab('connections')}>
          <Network size={14} /> Connections ({connections.length})
        </button>
        <button type="button" className={`samba-tab-item ${subTab === 'global' ? 'active' : ''}`} onClick={() => setSubTab('global')}>
          <Settings size={14} /> Global Configuration
        </button>
        <button type="button" className={`samba-tab-item ${subTab === 'logs' ? 'active' : ''}`} onClick={() => setSubTab('logs')}>
          <FileText size={14} /> Daemon Logs
        </button>
      </div>

      <div className="samba-content">
        {loading ? (
          <div className="empty-state"><RefreshCcw className="spinning" /> Loading dashboard...</div>
        ) : error ? (
          <div className="error-banner">{error}</div>
        ) : (
          <>
            {subTab === 'shares' && (
              <div className="samba-shares-view">
                <div className="shares-actions-header">
                  <h4>Configured Folders</h4>
                  <button type="button" className="refresh-button success-btn" onClick={openAddShare}>
                    <Plus size={14} /> Add Share
                  </button>
                </div>

                <div className="grid-layout">
                  {shares.length === 0 ? (
                    <div className="empty-state col-span-all">No Samba shares defined. Click Add Share to create one.</div>
                  ) : (
                    shares.map(share => (
                      <div key={share.name} className="service-card samba-share-card">
                        <div className="card-header">
                          <div className="icon-box backend">
                            <FolderOpen size={22} />
                          </div>
                          <div className="card-actions">
                            <button type="button" className="icon-button" title="Fix folder Unix permissions" onClick={() => { setPermissionsTarget(share.path); setShowPermissionsModal(true); }}>
                              <Lock size={14} />
                            </button>
                            <button type="button" className="icon-button" title="Edit Share config" onClick={() => openEditShare(share)}>
                              <Pencil size={14} />
                            </button>
                            <button type="button" className="icon-button danger" title="Delete Share config" onClick={() => handleDeleteShare(share.name)}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>

                        <div className="card-content">
                          <span className="type-badge">Samba Share</span>
                          <h3>[{share.name}]</h3>
                          <p className="share-comment">{share.comment || 'No description'}</p>
                          <div className="port-info share-path-info" title={share.path}>
                            <strong>Path:</strong> <code>{share.path}</code>
                          </div>

                          <div className="share-badges-row">
                            <span className={`badge-pill ${share.writable ? 'success' : 'muted'}`}>
                              {share.writable ? 'Read/Write' : 'Read-Only'}
                            </span>
                            <span className={`badge-pill ${share.browsable ? 'info' : 'muted'}`}>
                              {share.browsable ? 'Browsable' : 'Hidden'}
                            </span>
                            <span className={`badge-pill ${share.guestOk ? 'warning' : 'danger'}`}>
                              {share.guestOk ? 'Guest Access' : 'Login Required'}
                            </span>
                          </div>

                          {share.validUsers && (
                            <div className="share-meta-details">
                              <strong>Valid Users:</strong> <code>{share.validUsers}</code>
                            </div>
                          )}
                          {share.forceUser && (
                            <div className="share-meta-details">
                              <strong>Force User:</strong> <code>{share.forceUser}</code>
                            </div>
                          )}
                        </div>

                        <div className="connection-guide-box">
                          <button type="button" className="action-button web" onClick={() => setExpandedGuide(expandedGuide === share.name ? null : share.name)}>
                            {expandedGuide === share.name ? 'Hide Connection Info' : 'Show Connection Info'}
                          </button>
                          
                          {expandedGuide === share.name && status && (
                            <div className="connection-instructions">
                              {status.ips.length === 0 ? (
                                <p>No IP addresses detected to resolve connection strings.</p>
                              ) : (
                                <>
                                  <p className="guide-subtitle">Use these paths to connect from other devices:</p>
                                  {status.ips.map(ip => (
                                    <div key={ip.address} className="ip-instructions-group">
                                      <span className="ip-tag-title">{ip.tag} ({ip.address}):</span>
                                      <div className="string-copy-box">
                                        <span>Windows:</span>
                                        <code>\\{ip.address}\{share.name}</code>
                                      </div>
                                      <div className="string-copy-box">
                                        <span>macOS / Linux:</span>
                                        <code>smb://{ip.address}/{share.name}</code>
                                      </div>
                                    </div>
                                  ))}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {subTab === 'users' && (
              <div className="samba-users-view">
                <div className="split-layout">
                  <div className="samba-users-list-panel">
                    <h4>Active Samba Credentials</h4>
                    <table className="samba-table">
                      <thead>
                        <tr>
                          <th>Username</th>
                          <th>UID</th>
                          <th>Full Name</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {users.sambaUsers.length === 0 ? (
                          <tr><td colSpan="4" className="text-center">No Samba credentials configured.</td></tr>
                        ) : (
                          users.sambaUsers.map(user => (
                            <tr key={user.username}>
                              <td><strong>{user.username}</strong></td>
                              <td>{user.uid}</td>
                              <td>{user.fullName}</td>
                              <td>
                                <div className="table-actions">
                                  <button type="button" className="refresh-button" onClick={() => {
                                    setMapExistingUser(user.username);
                                    setNewUserPassword('');
                                    setCreateSysUser(false);
                                    setShowUserModal(true);
                                  }}>Change Pass</button>
                                  <button type="button" className="refresh-button danger-btn" onClick={() => handleDeleteUser(user.username)}>Delete</button>
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="samba-add-user-panel">
                    <h4>Add Samba User credentials</h4>
                    <form className="samba-embedded-form" onSubmit={handleSaveUser}>
                      <div className="toggle-checkbox-row">
                        <label>
                          <input type="checkbox" checked={createSysUser} onChange={(e) => setCreateSysUser(e.target.checked)} />
                          <span>Create new Linux system user first (Samba-only)</span>
                        </label>
                      </div>

                      {createSysUser ? (
                        <label className="manual-field">
                          <span>System Username</span>
                          <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="e.g. guestshare" required />
                          <small className="help-text">Will create unix account with disabled shell access.</small>
                        </label>
                      ) : (
                        <label className="manual-field">
                          <span>Select System Unix User</span>
                          <select value={mapExistingUser} onChange={(e) => setMapExistingUser(e.target.value)} required>
                            <option value="">-- Choose Unix User --</option>
                            {users.systemUsers.map(u => (
                              <option key={u.username} value={u.username}>{u.username} (UID: {u.uid})</option>
                            ))}
                          </select>
                        </label>
                      )}

                      <label className="manual-field">
                        <span>Samba Password</span>
                        <input type="password" value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} placeholder="••••••••" required />
                      </label>

                      <button type="submit" className="action-button web">
                        <UserPlus size={14} /> Save Credentials
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            )}

            {subTab === 'connections' && (
              <div className="samba-connections-view">
                <div className="shares-actions-header">
                  <h4>Active Client Sessions</h4>
                  <button type="button" className="refresh-button" onClick={fetchConnections}>
                    <RefreshCcw size={12} /> Refresh
                  </button>
                </div>

                <table className="samba-table">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Share</th>
                      <th>Client Machine</th>
                      <th>PID</th>
                      <th>Connected Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {connections.length === 0 ? (
                      <tr><td colSpan="5" className="text-center">No active connections. Samba is idle.</td></tr>
                    ) : (
                      connections.map((c, idx) => (
                        <tr key={`${c.pid}-${c.service}-${idx}`}>
                          <td><strong>{c.username}</strong></td>
                          <td><span className="badge-pill info">[{c.service}]</span></td>
                          <td><code>{c.machine}</code></td>
                          <td>{c.pid}</td>
                          <td>{c.connectedAt}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {subTab === 'global' && (
              <div className="samba-global-view">
                <form className="manual-form samba-global-form" onSubmit={handleSaveGlobal}>
                  <h4>Server Identity (Global properties)</h4>
                  
                  {globalError && <div className="manual-error">{globalError}</div>}
                  {globalSuccess && <div className="success-banner">Global parameters saved and Samba reloaded!</div>}

                  <label className="manual-field">
                    <span>Workgroup</span>
                    <input value={globalWorkgroup} onChange={(e) => setGlobalWorkgroup(e.target.value)} placeholder="WORKGROUP" required />
                  </label>

                  <label className="manual-field">
                    <span>Server String / Description</span>
                    <input value={globalDesc} onChange={(e) => setGlobalDesc(e.target.value)} placeholder="Samba Server Description" />
                  </label>

                  <label className="manual-field">
                    <span>Guest Logins policy</span>
                    <select value={globalGuestMap} onChange={(e) => setGlobalGuestMap(e.target.value)}>
                      <option value="bad user">Allow Guest Logins (bad user)</option>
                      <option value="never">Require Accounts (never guest)</option>
                    </select>
                    <small className="help-text">
                      "Allow Guest Logins" maps anonymous connection attempts to guest automatically, enabling Guest OK shares.
                    </small>
                  </label>

                  <button type="submit" className="action-button web">
                    <CheckCircle2 size={14} /> Update Global Configuration
                  </button>
                </form>
              </div>
            )}

            {subTab === 'logs' && (
              <div className="samba-logs-view">
                <div className="shares-actions-header">
                  <h4>Systemd / Samba Log Output (Last 100 lines)</h4>
                  <button type="button" className="refresh-button" onClick={fetchLogs}>
                    <RefreshCcw size={12} /> Refresh
                  </button>
                </div>
                <pre className="samba-log-viewer">{logs}</pre>
              </div>
            )}
          </>
        )}
      </div>

      {showShareModal && (
        <div className="preview-overlay" onClick={() => setShowShareModal(false)}>
          <form className="manual-form samba-share-form" onClick={(e) => e.stopPropagation()} onSubmit={handleShareSubmit}>
            <div className="manual-form-header">
              <span>{editingShare ? `Edit Share: ${shareOriginalName}` : 'Add Samba Share'}</span>
              <button type="button" className="preview-close" onClick={() => setShowShareModal(false)}><X size={16} /></button>
            </div>

            {shareError && <div className="manual-error">{shareError}</div>}

            <label className="manual-field">
              <span>Share name</span>
              <input value={shareName} onChange={(e) => setShareName(e.target.value)} placeholder="e.g. shared-music" required disabled={!!editingShare} />
            </label>

            <label className="manual-field">
              <span>Comment / Description</span>
              <input value={shareComment} onChange={(e) => setShareComment(e.target.value)} placeholder="e.g. Folder containing music files" />
            </label>

            <div className="manual-field folder-picker-input-group">
              <span>Folder Directory Path</span>
              <div className="path-input-row">
                <input value={sharePath} onChange={(e) => setSharePath(e.target.value)} placeholder="/home/ayman/Share" required />
                <button type="button" className="refresh-button" onClick={() => { setPickerPath(sharePath); setPickerTarget('share'); setShowPicker(true); }}>
                  Browse...
                </button>
              </div>
            </div>

            <div className="form-checkbox-row">
              <label>
                <input type="checkbox" checked={shareWritable} onChange={(e) => setShareWritable(e.target.checked)} />
                <span>Writable (Allow clients to write/edit files)</span>
              </label>
              
              <label>
                <input type="checkbox" checked={shareBrowsable} onChange={(e) => setShareBrowsable(e.target.checked)} />
                <span>Browsable (Visible in network listings)</span>
              </label>

              <label>
                <input type="checkbox" checked={shareGuestOk} onChange={(e) => setShareGuestOk(e.target.checked)} />
                <span>Guest OK (Allow anonymous logins without password)</span>
              </label>
            </div>

            <div className="collapsible-form-fields">
              <label className="manual-field">
                <span>Restrict to Valid Users (Optional)</span>
                <input value={shareValidUsers} onChange={(e) => setShareValidUsers(e.target.value)} placeholder="e.g. ayman, family" />
                <small className="help-text">Space or comma separated list of usernames allowed to access.</small>
              </label>

              <label className="manual-field">
                <span>Force File Owner (Optional)</span>
                <input value={shareForceUser} onChange={(e) => setShareForceUser(e.target.value)} placeholder="e.g. ayman" />
                <small className="help-text">Forces all newly created files to be owned by this Unix account.</small>
              </label>
            </div>

            {!editingShare && (
              <div className="toggle-checkbox-row padding-top">
                <label>
                  <input type="checkbox" checked={createFolder} onChange={(e) => setCreateFolder(e.target.checked)} />
                  <span>Automatically create directory and configure Linux permission tags</span>
                </label>
              </div>
            )}

            <div className="manual-actions">
              <button type="button" className="action-secondary" onClick={() => setShowShareModal(false)}>Cancel</button>
              <button type="submit" className="action-button web">
                {editingShare ? 'Save Changes' : 'Create Share'}
              </button>
            </div>
          </form>
        </div>
      )}

      {showUserModal && !createSysUser && (
        <div className="preview-overlay" onClick={() => setShowUserModal(false)}>
          <form className="manual-form" onClick={(e) => e.stopPropagation()} onSubmit={handleSaveUser}>
            <div className="manual-form-header">
              <span>Change Samba Password: {mapExistingUser}</span>
              <button type="button" className="preview-close" onClick={() => setShowUserModal(false)}><X size={16} /></button>
            </div>
            
            <label className="manual-field">
              <span>New Samba Password</span>
              <input type="password" value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} placeholder="••••••••" required />
            </label>

            <div className="manual-actions">
              <button type="button" className="action-secondary" onClick={() => setShowUserModal(false)}>Cancel</button>
              <button type="submit" className="action-button web">Save Password</button>
            </div>
          </form>
        </div>
      )}

      <FolderPickerModal
        isOpen={showPicker}
        onClose={() => setShowPicker(false)}
        initialPath={pickerPath}
        onSelect={(selectedPath) => {
          if (pickerTarget === 'share') {
            setSharePath(selectedPath);
          }
        }}
      />

      <FixPermissionsModal
        isOpen={showPermissionsModal}
        onClose={() => setShowPermissionsModal(false)}
        dirPath={permissionsTarget}
        onSubmit={handlePermissionsSubmit}
      />
    </div>
  );
};

function App() {
  const [services, setServices] = useState([]);
  const [stats, setStats] = useState({
    cpu: 0,
    ram: 0,
    gpu: 0,
    ramRaw: { used: 0, total: 0 },
    topCpu: [],
    topMem: [],
    processes: [],
    temps: { cpu: 0, gpu: 0, disk: 0 }
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTabState] = useState(getInitialTab);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [query, setQuery] = useState('');
  const [pins, togglePin] = usePersistedSet(PINS_KEY);
  const [labels, setLabel] = usePersistedMap(LABELS_KEY);
  const [previewService, setPreviewService] = useState(null);
  const [agents, setAgents] = useState([]);
  const [terminals, setTerminals] = useState([]);
  const [activeTerminalId, setActiveTerminalId] = useState(null);
  const [terminalStatuses, setTerminalStatuses] = useState({});
  const [terminalMinimized, setTerminalMinimized] = useState(false);
  const shellCounterRef = React.useRef(0);
  const [showAddManual, setShowAddManual] = useState(false);
  const [submittingManual, setSubmittingManual] = useState(false);
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'dark';
    return localStorage.getItem(THEME_KEY) || 'dark';
  });

  const [dialogState, setDialogState] = useState({
    isOpen: false,
    title: '',
    message: '',
    type: 'confirm',
    onConfirm: null,
    onCancel: null,
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    isDanger: false
  });

  const [dockerFilter, setDockerFilter] = useState('all');
  const [dockerLogsContainer, setDockerLogsContainer] = useState(null);
  const [dockerLogs, setDockerLogs] = useState('');
  const [loadingLogs, setLoadingLogs] = useState(false);

  const showConfirm = useCallback((title, message, onConfirm, isDanger = false) => {
    setDialogState({
      isOpen: true,
      title,
      message,
      type: 'confirm',
      confirmText: isDanger ? 'Delete' : 'Confirm',
      cancelText: 'Cancel',
      isDanger,
      onConfirm: () => {
        setDialogState(prev => ({ ...prev, isOpen: false }));
        if (onConfirm) onConfirm();
      },
      onCancel: () => {
        setDialogState(prev => ({ ...prev, isOpen: false }));
      }
    });
  }, []);

  const showAlert = useCallback((title, message, type = 'error') => {
    setDialogState({
      isOpen: true,
      title,
      message,
      type: 'alert',
      confirmText: 'OK',
      cancelText: 'Close',
      isDanger: type === 'error',
      onConfirm: () => {
        setDialogState(prev => ({ ...prev, isOpen: false }));
      },
      onCancel: () => {
        setDialogState(prev => ({ ...prev, isOpen: false }));
      }
    });
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);

  const handleEditLabel = useCallback((service) => {
    const id = serviceId(service);
    const current = labels[id] || '';
    const next = window.prompt(`Custom label for "${service.displayName || service.name}":`, current);
    if (next === null) return;
    setLabel(id, next.trim());
  }, [labels, setLabel]);

  const handleCopyUrl = useCallback(async (url) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
    } catch (e) {
      console.error('Copy failed', e);
    }
  }, []);

  const setActiveTab = useCallback((tab) => {
    setActiveTabState(tab);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', tab);
      window.history.replaceState({}, '', url);
    }
  }, []);

  const fetchServices = useCallback(async () => {
    try {
      const response = await axios.get('/api/services');
      setServices(response.data);
      setLastUpdated(new Date());
      setError(null);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching services:', err);
      setError('Connection lost. Attempting to reconnect...');
      setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const response = await axios.get('/api/stats');
      setStats(response.data);
    } catch (err) {
      console.error('Error fetching stats:', err);
    }
  }, []);

  const fetchAgents = useCallback(async () => {
    try {
      const response = await axios.get('/api/agents');
      setAgents(response.data.agents || []);
    } catch (err) {
      console.error('Error fetching agents:', err);
    }
  }, []);

  const openDockerLogs = useCallback(async (containerName) => {
    setDockerLogsContainer(containerName);
    setDockerLogs('');
    setLoadingLogs(true);
    try {
      const res = await axios.get('/api/docker/logs', { params: { name: containerName } });
      setDockerLogs(res.data.logs || '');
    } catch (e) {
      setDockerLogs(`Error fetching logs: ${e.response?.data?.error || e.message}`);
    } finally {
      setLoadingLogs(false);
    }
  }, []);

  const dockerControl = useCallback(async (containerName, action) => {
    try {
      await axios.post('/api/docker/control', { name: containerName, action });
      setTimeout(() => fetchServices(), 800);
    } catch (e) {
      showAlert('Docker Error', e.response?.data?.error || e.message);
    }
  }, [fetchServices, showAlert]);

  const openDockerTerminal = useCallback((containerName) => {
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setTerminals(prev => [...prev, { id, agent: null, shellIndex: 0, docker: containerName }]);
    setActiveTerminalId(id);
    setTerminalMinimized(false);
  }, []);

  useEffect(() => {
    fetchAgents();
    const interval = setInterval(() => {
      if (!document.hidden) fetchAgents();
    }, 60000);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  const openTerminal = useCallback((agent) => {
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let shellIndex = 0;
    if (!agent) {
      shellCounterRef.current += 1;
      shellIndex = shellCounterRef.current;
    }
    setTerminals(prev => [...prev, { id, agent: agent || null, shellIndex }]);
    setActiveTerminalId(id);
    setTerminalMinimized(false);
  }, []);

  const switchTerminal = useCallback((id) => {
    setActiveTerminalId(id);
    setTerminalMinimized(false);
  }, []);

  const closeTerminalTab = useCallback((id) => {
    setTerminals(prev => {
      const next = prev.filter(t => t.id !== id);
      setActiveTerminalId(curr => {
        if (curr !== id) return curr;
        if (next.length === 0) return null;
        return next[next.length - 1].id;
      });
      if (next.length === 0) setTerminalMinimized(false);
      return next;
    });
    setTerminalStatuses(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const closeAllTerminals = useCallback(() => {
    setTerminals([]);
    setActiveTerminalId(null);
    setTerminalStatuses({});
    setTerminalMinimized(false);
  }, []);

  const updateTerminalStatus = useCallback((id, status) => {
    setTerminalStatuses(prev => (prev[id] === status ? prev : { ...prev, [id]: status }));
  }, []);

  const submitManualService = useCallback(async (entry) => {
    setSubmittingManual(true);
    try {
      await axios.post('/api/services/manual', entry);
      setShowAddManual(false);
      fetchServices();
    } finally {
      setSubmittingManual(false);
    }
  }, [fetchServices]);

  const deleteManualService = useCallback((service) => {
    if (!service.manualId) return;
    showConfirm(
      'Remove Service',
      `Remove "${service.displayName || service.name}"?`,
      async () => {
        try {
          await axios.delete(`/api/services/manual/${service.manualId}`);
          fetchServices();
        } catch (e) {
          console.error('Delete failed', e);
          showAlert('Delete Failed', e.response?.data?.error || e.message, 'error');
        }
      },
      true
    );
  }, [fetchServices, showConfirm, showAlert]);

  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([fetchServices(), fetchStats()]);
    } finally {
      setRefreshing(false);
    }
  }, [fetchServices, fetchStats]);

  useEffect(() => {
    fetchServices();
    fetchStats();
    const serviceInterval = setInterval(() => {
      if (!document.hidden) fetchServices();
    }, 10000);
    const statsInterval = setInterval(() => {
      if (!document.hidden) fetchStats();
    }, 5000);
    const onVisibility = () => {
      if (!document.hidden) {
        fetchServices();
        fetchStats();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(serviceInterval);
      clearInterval(statsInterval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchServices, fetchStats]);

  const matchesQuery = (s) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const id = serviceId(s);
    const label = (labels[id] || '').toLowerCase();
    return (
      (s.name || '').toLowerCase().includes(q) ||
      (s.displayName || '').toLowerCase().includes(q) ||
      label.includes(q) ||
      String(s.port).includes(q)
    );
  };

  const sortPinned = (a, b) => {
    const ap = pins.has(serviceId(a));
    const bp = pins.has(serviceId(b));
    if (ap !== bp) return ap ? -1 : 1;
    return (labels[serviceId(a)] || a.displayName || a.name).localeCompare(
      labels[serviceId(b)] || b.displayName || b.name
    );
  };

  const applyDockerFilter = (s) => {
    if (dockerFilter === 'docker') return s.type === 'docker';
    if (dockerFilter === 'system') return s.type !== 'docker';
    return true;
  };

  const webServices = services.filter(s => s.isWebUi).filter(matchesQuery).filter(applyDockerFilter).sort(sortPinned);
  const backendServices = services.filter(s => !s.isWebUi).filter(matchesQuery).filter(applyDockerFilter).sort(sortPinned);
  const currentServices = activeTab === 'web' ? webServices : (activeTab === 'backend' ? backendServices : []);
  const totalWeb = services.filter(s => s.isWebUi).length;
  const totalBackend = services.filter(s => !s.isWebUi).length;

  return (
    <div className="app-container">
      <div className="background-glow" />
      
      <main className="main-content">
        <header className="app-header">
          <div className="vitals-bar">
            <TempIndicator label="CPU" value={stats.temps.cpu} />
            <TempIndicator label="GPU" value={stats.temps.gpu} />
            <TempIndicator label="NVMe" value={stats.temps.disk} />
          </div>

          <div className="header-top">
            <div className="header-titles">
              <motion.div 
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                className="system-status"
              >
                <div className="pulse-dot" />
                <span>Infrastructure Monitoring</span>
              </motion.div>
              
              <motion.h1
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                Service <span className="text-gradient">Registry</span>
              </motion.h1>
            </div>

            <div className="metrics-grid">
              <MetricCard 
                label="CPU Load" 
                value={stats.cpu} 
                unit="%" 
                icon={Zap} 
                color="#3b82f6" 
                active={activeTab === 'resources'}
                onClick={() => setActiveTab('resources')}
              />
              <MetricCard 
                label="RAM Usage" 
                value={stats.ram} 
                unit="%" 
                icon={HardDrive} 
                color="#8b5cf6"
                raw={`${(stats.ramRaw.used / 1024).toFixed(1)}GB / ${(stats.ramRaw.total / 1024).toFixed(1)}GB`}
                active={activeTab === 'resources'}
                onClick={() => setActiveTab('resources')}
              />
              {stats.gpu !== undefined && (
                <MetricCard 
                  label="GPU Load" 
                  value={stats.gpu} 
                  unit="%" 
                  icon={Monitor} 
                  color="#10b981" 
                />
              )}
            </div>
          </div>
          
          <motion.p 
            className="header-desc"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            Automated discovery of all active endpoints and system processes.
          </motion.p>
        </header>

        <nav className="nav-container">
          <div className="tabs-wrapper">
            <button 
              className={`nav-tab ${activeTab === 'web' ? 'active' : ''}`}
              onClick={() => setActiveTab('web')}
            >
              <Monitor size={18} />
              <span>Web Interfaces</span>
              <span className="count-badge">{query ? `${webServices.length}/${totalWeb}` : totalWeb}</span>
            </button>
            <button
              className={`nav-tab ${activeTab === 'backend' ? 'active' : ''}`}
              onClick={() => setActiveTab('backend')}
            >
              <Server size={18} />
              <span>Backend Services</span>
              <span className="count-badge">{query ? `${backendServices.length}/${totalBackend}` : totalBackend}</span>
            </button>
            <button
              className={`nav-tab ${activeTab === 'agents' ? 'active' : ''}`}
              onClick={() => setActiveTab('agents')}
            >
              <Bot size={18} />
              <span>Coding Agents</span>
              <span className="count-badge">{agents.length}</span>
            </button>
            <button
              className={`nav-tab ${activeTab === 'resources' ? 'active' : ''}`}
              onClick={() => setActiveTab('resources')}
            >
              <Activity size={18} />
              <span>Resources</span>
            </button>
            <button
              className={`nav-tab ${activeTab === 'samba' ? 'active' : ''}`}
              onClick={() => setActiveTab('samba')}
            >
              <FolderOpen size={18} />
              <span>Samba Share</span>
            </button>
            <button
              className={`nav-tab ${activeTab === 'files' ? 'active' : ''}`}
              onClick={() => setActiveTab('files')}
            >
              <Folder size={18} />
              <span>Files</span>
            </button>
          </div>
          
          <div className="refresh-status">
            {(activeTab === 'web' || activeTab === 'backend') && (
              <>
                <div className="search-bar">
                  <Search size={14} />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name, label, or port…"
                    aria-label="Search services"
                  />
                  {query && (
                    <button
                      type="button"
                      className="search-clear"
                      onClick={() => setQuery('')}
                      aria-label="Clear search"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
                <div className="docker-filter-pills">
                  {['all', 'docker', 'system'].map(f => (
                    <button
                      key={f}
                      type="button"
                      className={`docker-filter-pill ${dockerFilter === f ? 'active' : ''}`}
                      onClick={() => setDockerFilter(f)}
                    >
                      {f === 'all' ? 'All' : f === 'docker' ? '🐳 Docker' : '⚙️ System'}
                    </button>
                  ))}
                </div>
              </>
            )}
            <button
              type="button"
              className="refresh-button"
              onClick={refreshNow}
              disabled={refreshing}
              aria-label="Refresh now"
              title="Refresh now"
            >
              <RefreshCcw className={refreshing || loading ? 'spinning' : ''} size={14} />
              <span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
            </button>
            <button
              type="button"
              className="refresh-button"
              onClick={() => openTerminal(null)}
              aria-label="Open terminal"
              title="Open terminal"
            >
              <TerminalSquare size={14} />
              <span>Terminal</span>
            </button>
            <button
              type="button"
              className="refresh-button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle theme"
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </nav>

        {error && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="error-banner"
          >
            {error}
          </motion.div>
        )}

        <div className="content-area">
          <AnimatePresence mode="wait">
            {activeTab === 'resources' && (
              <motion.div
                key="resources-view"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <ResourcesMonitor
                  processes={stats.processes || []}
                  gpuUtil={stats.gpu || 0}
                  stats={stats}
                />
              </motion.div>
            )}
            {activeTab === 'samba' && (
              <motion.div
                key="samba-view"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <SambaPanel showAlert={showAlert} showConfirm={showConfirm} />
              </motion.div>
            )}
            {activeTab === 'files' && (
              <motion.div
                key="files-view"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                style={{ 
                  height: 'calc(100vh - 280px)', 
                  minHeight: '600px',
                  borderRadius: '12px', 
                  overflow: 'hidden', 
                  border: '1px solid var(--border)',
                  background: 'rgba(255, 255, 255, 0.03)',
                  backdropFilter: 'blur(10px)',
                  boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.3)'
                }}
              >
                <iframe
                  src={`${window.location.protocol}//${window.location.hostname}:8084`}
                  style={{ width: '100%', height: '100%', border: 'none' }}
                  title="File Manager"
                />
              </motion.div>
            )}
            {activeTab === 'agents' && (
              <motion.div
                key="agents-view"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="grid-layout"
              >
                {agents.length > 0 ? (
                  agents.map(a => (
                    <AgentCard key={a.id} agent={a} onRun={openTerminal} />
                  ))
                ) : (
                  <div className="empty-state">
                    <p>No coding agents detected on PATH for the dashboard user.</p>
                  </div>
                )}
              </motion.div>
            )}
            {(activeTab === 'web' || activeTab === 'backend') && (
              <motion.div
                key="grid-view"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="grid-layout"
              >
                {currentServices.length > 0 ? (
                  <>
                    {currentServices.map((s) => {
                      const id = serviceId(s);
                      return (
                        <ServiceCard
                          key={s.manualId || `${s.name}-${s.port}`}
                          service={s}
                          pinned={pins.has(id)}
                          customLabel={labels[id]}
                          onTogglePin={() => togglePin(id)}
                          onEditLabel={() => handleEditLabel(s)}
                          onCopyUrl={handleCopyUrl}
                          onPreview={() => setPreviewService(s)}
                          onDelete={() => deleteManualService(s)}
                          onDockerControl={dockerControl}
                          onDockerLogs={openDockerLogs}
                          onDockerTerminal={openDockerTerminal}
                        />
                      );
                    })}
                    {activeTab === 'web' && (
                      <button
                        type="button"
                        className="add-service-card"
                        onClick={() => setShowAddManual(true)}
                      >
                        <Plus size={18} />
                        <span>Add service</span>
                      </button>
                    )}
                  </>
                ) : (
                  !loading && (
                    <div className="empty-state">
                      <p>
                        {query
                          ? `No ${activeTab} services match "${query}".`
                          : `No active ${activeTab} services detected.`}
                      </p>
                    </div>
                  )
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <AnimatePresence>
        {previewService && (
          <PreviewModal
            url={previewService.url}
            title={labels[serviceId(previewService)] || previewService.displayName || previewService.name}
            onClose={() => setPreviewService(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {terminals.length > 0 && (
          <TerminalOverlay
            key="terminal-overlay"
            terminals={terminals}
            activeId={activeTerminalId}
            statuses={terminalStatuses}
            minimized={terminalMinimized}
            onSwitchTab={switchTerminal}
            onCloseTab={closeTerminalTab}
            onNewTerminal={openTerminal}
            onMinimize={() => setTerminalMinimized(true)}
            onRestore={() => setTerminalMinimized(false)}
            onCloseAll={closeAllTerminals}
            onStatusChange={updateTerminalStatus}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAddManual && (
          <AddManualModal
            submitting={submittingManual}
            onSubmit={submitManualService}
            onClose={() => setShowAddManual(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {dialogState.isOpen && (
          <ConfirmModal
            isOpen={dialogState.isOpen}
            title={dialogState.title}
            message={dialogState.message}
            confirmText={dialogState.confirmText}
            cancelText={dialogState.cancelText}
            isDanger={dialogState.isDanger}
            onConfirm={dialogState.onConfirm}
            onCancel={dialogState.onCancel}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {dockerLogsContainer && (
          <DockerLogsModal
            containerName={dockerLogsContainer}
            logs={dockerLogs}
            loading={loadingLogs}
            onClose={() => setDockerLogsContainer(null)}
          />
        )}
      </AnimatePresence>

      <footer className="app-footer">
        <div className="footer-left">
          <Shield size={14} />
          <span>Secure Instance</span>
        </div>
        <div className="footer-right">
          <span>Last sync: {lastUpdated.toLocaleTimeString()}</span>
          <span className="version-tag">v{pkg.version}</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
