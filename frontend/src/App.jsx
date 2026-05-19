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
  Maximize2
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

const VALID_TABS = new Set(['web', 'backend', 'agents', 'cpu', 'ram']);
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
                  <span className="terminal-tab-label">{t.agent ? t.agent.label : `Shell ${t.shellIndex}`}</span>
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

const ServiceCard = ({ service, pinned, customLabel, onTogglePin, onEditLabel, onCopyUrl, onPreview, onDelete }) => {
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
              <div className="dot active" />
              <span>{service.type === 'manual' ? 'Manual' : 'Running'}</span>
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
        </div>
      ) : (
        <div className="action-button backend">
          <Shield size={16} />
          <span>System Protected</span>
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

function App() {
  const [services, setServices] = useState([]);
  const [stats, setStats] = useState({
    cpu: 0,
    ram: 0,
    gpu: 0,
    ramRaw: { used: 0, total: 0 },
    topCpu: [],
    topMem: [],
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

  const deleteManualService = useCallback(async (service) => {
    if (!service.manualId) return;
    if (!window.confirm(`Remove "${service.displayName || service.name}"?`)) return;
    try {
      await axios.delete(`/api/services/manual/${service.manualId}`);
      fetchServices();
    } catch (e) {
      console.error('Delete failed', e);
    }
  }, [fetchServices]);

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

  const webServices = services.filter(s => s.isWebUi).filter(matchesQuery).sort(sortPinned);
  const backendServices = services.filter(s => !s.isWebUi).filter(matchesQuery).sort(sortPinned);
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
                active={activeTab === 'cpu'}
                onClick={() => setActiveTab('cpu')}
              />
              <MetricCard 
                label="RAM Usage" 
                value={stats.ram} 
                unit="%" 
                icon={HardDrive} 
                color="#8b5cf6"
                raw={`${(stats.ramRaw.used / 1024).toFixed(1)}GB / ${(stats.ramRaw.total / 1024).toFixed(1)}GB`}
                active={activeTab === 'ram'}
                onClick={() => setActiveTab('ram')}
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
              className={`nav-tab ${activeTab === 'cpu' ? 'active' : ''}`}
              onClick={() => setActiveTab('cpu')}
            >
              <Zap size={18} />
              <span>CPU Status</span>
            </button>
            <button 
              className={`nav-tab ${activeTab === 'ram' ? 'active' : ''}`}
              onClick={() => setActiveTab('ram')}
            >
              <HardDrive size={18} />
              <span>RAM Status</span>
            </button>
          </div>
          
          <div className="refresh-status">
            {(activeTab === 'web' || activeTab === 'backend') && (
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
            {activeTab === 'cpu' && (
              <ProcessList 
                key="cpu-list"
                title="Top CPU Consumers" 
                data={stats.topCpu} 
                unit="%" 
                color="#3b82f6" 
              />
            )}
            {activeTab === 'ram' && (
              <ProcessList 
                key="ram-list"
                title="Top RAM Consumers" 
                data={stats.topMem} 
                unit="%" 
                color="#8b5cf6" 
              />
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
