import './code-workspace.css';
import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'react';
import axios from 'axios';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { TerminalKeyBar } from './term-keybar.jsx';

const ENV_PASSTHROUGH_DEFAULT = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY',
  'OLLAMA_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'EDITOR', 'PATH', 'HOME', 'USER',
];

const ACTIVE_KEY = 'code_workspace_active_id';

const AGENT_GLYPHS = {
  claude: '💬',
  'claude-code': '💬',
  gemini: '✦',
  antigravity: '🚀',
  codex: '⬡',
  opencode: '🔏',
  kilocode: '⚡',
  kilo: '⚡',
  ollama: '🦙',
  shell: '›_',
};

// ─── Terminal Pane ────────────────────────────────────────────────────────────
export function TerminalPane({ id, cwd, agent, envCsv, active, onTitle, onRegisterFit, sessionId, onSessionId }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef(sessionId || null);
  const reconnectTimer = useRef(null);
  // Sticky Ctrl modifier for the mobile key bar
  const ctrlRef = useRef(false);
  const [ctrlOn, setCtrlOn] = useState(false);
  const [kbFocused, setKbFocused] = useState(false);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // Send a raw byte sequence to the PTY (used by the mobile key bar)
  const sendSeq = useCallback((seq) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(seq);
    try { termRef.current?.focus(); } catch {}
  }, []);

  const toggleCtrl = useCallback(() => {
    ctrlRef.current = !ctrlRef.current;
    setCtrlOn(ctrlRef.current);
    try { termRef.current?.focus(); } catch {}
  }, []);

  useLayoutEffect(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new Terminal({
      allowProposedApi: true,
      scrollback: 5000,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#1f1e1d', foreground: '#faf9f5', cursor: '#d97757', selectionBackground: 'rgba(217, 119, 87, 0.25)' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    try { fit.fit(); } catch {}
    termRef.current = term;
    fitRef.current = fit;

    // Track terminal focus so the mobile key bar only shows with the keyboard.
    // A short blur delay avoids flicker when a key-bar tap re-focuses the term.
    let blurTimer = null;
    if (term.textarea) {
      term.textarea.addEventListener('focus', () => { clearTimeout(blurTimer); setKbFocused(true); });
      term.textarea.addEventListener('blur', () => { blurTimer = setTimeout(() => setKbFocused(false), 150); });
    }
    if (onRegisterFit) onRegisterFit(id, () => {
      try {
        fit.fit();
        // Must also tell the backend PTY the new dimensions, otherwise it keeps
        // using the old column count and text re-wraps incorrectly.
        const ws = wsRef.current;
        const t  = termRef.current;
        if (ws && ws.readyState === WebSocket.OPEN && t) {
          ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
        }
        t?.refresh(0, (t.rows || 1) - 1);
      } catch {}
    });

    const decoder = new TextDecoder();

    const connect = (isReconnect = false) => {
      if (!mountedRef.current) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const params = new URLSearchParams();
      if (cwd) params.set('cwd', cwd);
      if (agent) params.set('agent', agent);
      if (envCsv) params.set('env', envCsv);
      params.set('cols', String(term.cols));
      params.set('rows', String(term.rows));
      if (sessionIdRef.current) params.set('sid', sessionIdRef.current);
      const ws = new WebSocket(`${proto}://${window.location.host}/ws/terminal?${params.toString()}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          term.write(decoder.decode(e.data));
        } else if (typeof e.data === 'string') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'session' && msg.id) {
              sessionIdRef.current = msg.id;
              if (onSessionId) onSessionId(id, msg.id);
              return;
            }
          } catch {}
          term.write(e.data);
        }
      };
      ws.onopen = () => {
        if (isReconnect) {
          try { term.write('\r\n\x1b[2m[reconnected]\x1b[0m\r\n'); } catch {}
        }
        term.focus();
        if (onTitle) onTitle(id, agent ? `${agent}` : 'shell');
        try { fit.fit(); } catch {}
      };
      ws.onerror = () => { try { term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n'); } catch {} };
      ws.onclose = () => {
        if (!mountedRef.current) return;
        if (sessionIdRef.current) {
          try { term.write('\r\n\x1b[33m[disconnected — reconnecting in 3s…]\x1b[0m\r\n'); } catch {}
          reconnectTimer.current = setTimeout(() => {
            if (mountedRef.current) connect(true);
          }, 3000);
        } else {
          try { term.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n'); } catch {}
        }
      };
      return ws;
    };

    // Registered once — connect() runs again on every reconnect, and a handler
    // per call would stack up (each stale one also consuming the sticky-Ctrl flag).
    term.onData((d) => {
      let data = d;
      // Sticky Ctrl from the mobile key bar: fold the next single char into
      // its control code (a → ^A, c → ^C, etc.), then release the modifier.
      if (ctrlRef.current && data.length === 1) {
        const c = data.charCodeAt(0);
        if (c >= 97 && c <= 122)      data = String.fromCharCode(c - 96); // a-z
        else if (c >= 64 && c <= 95)  data = String.fromCharCode(c - 64); // @,A-Z,[\]^_
        ctrlRef.current = false;
        setCtrlOn(false);
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    connect(!!sessionId);

    let resizeTimer = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          fit.fit();
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        } catch {}
      }, 60);
    });
    ro.observe(containerRef.current);

    return () => {
      clearTimeout(resizeTimer);
      clearTimeout(reconnectTimer.current);
      if (onRegisterFit) onRegisterFit(id, null);
      try { ro.disconnect(); } catch {}
      // Close WS but don't send DELETE — backend session stays alive for reconnect
      try { wsRef.current?.close(); } catch {}
      try { term.dispose(); } catch {}
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    // rAF defers until after display:block is painted so fit measures correctly
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const ws = wsRef.current;
        const term = termRef.current;
        if (ws && ws.readyState === WebSocket.OPEN && term) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
        termRef.current?.refresh(0, (termRef.current.rows || 1) - 1);
      } catch {}
      try { termRef.current?.focus(); } catch {}
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div
      className="tp-wrap"
      style={{ display: active ? 'flex' : 'none', flexDirection: 'column', width: '100%', height: '100%', background: '#1f1e1d' }}
    >
      <div ref={containerRef} className="tp-term-host" style={{ flex: 1, minHeight: 0, width: '100%' }} />
      <TerminalKeyBar onKey={sendSeq} ctrlOn={ctrlOn} onToggleCtrl={toggleCtrl} visible={active && kbFocused} />
    </div>
  );
}

// ─── Folder Browser Modal ─────────────────────────────────────────────────────
export function FolderBrowserModal({ initialPath, onConfirm, onClose }) {
  const [browsePath, setBrowsePath] = useState('');
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [wsName, setWsName] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderErr, setNewFolderErr] = useState('');
  const newFolderRef = useRef(null);
  const filterRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const navigateTo = useCallback(async (p) => {
    setLoading(true);
    setError('');
    setFilter('');
    try {
      const res = await axios.get('/api/fs/browse', { params: { path: p } });
      if (!mountedRef.current) return;
      const { currentPath, folders: flds } = res.data;
      setBrowsePath(currentPath);
      setPathInput(currentPath);
      setFolders(flds || []);
      const autoName = currentPath.split('/').filter(Boolean).pop() || '';
      setWsName(prev => prev || autoName);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e.response?.data?.error || e.message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    navigateTo(initialPath || '/home');
  }, []);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const openNewFolder = () => {
    setNewFolderName('');
    setNewFolderErr('');
    setNewFolderMode(true);
    setTimeout(() => newFolderRef.current?.focus(), 50);
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setNewFolderErr('');
    try {
      await axios.post('/api/fs/mkdir', { parent: browsePath, name });
      setNewFolderMode(false);
      await navigateTo(browsePath);
    } catch (e) {
      setNewFolderErr(e.response?.data?.error || e.message);
    }
  };

  const breadcrumbs = useMemo(() => {
    if (!browsePath) return [];
    const parts = browsePath.split('/').filter(Boolean);
    return [
      { label: '/', path: '/' },
      ...parts.map((seg, i) => ({
        label: seg,
        path: '/' + parts.slice(0, i + 1).join('/'),
      })),
    ];
  }, [browsePath]);

  const filtered = useMemo(
    () => folders.filter(f => !filter || f.name.toLowerCase().includes(filter.toLowerCase())),
    [folders, filter]
  );

  const handleConfirm = () => {
    if (!wsName.trim() || !browsePath) return;
    onConfirm(browsePath, wsName.trim());
  };

  const parentPath = useMemo(() => {
    if (!browsePath || browsePath === '/') return null;
    const parts = browsePath.split('/').filter(Boolean);
    parts.pop();
    return parts.length === 0 ? '/' : '/' + parts.join('/');
  }, [browsePath]);

  return (
    <div className="fb-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fb-dialog">
        <div className="fb-header">
          <span className="fb-header-title">
            <span style={{ marginRight: 8 }}>📁</span>Select Project Folder
          </span>
          <button className="fb-close" onClick={onClose}>×</button>
        </div>

        <div className="fb-path-row">
          {parentPath && (
            <button className="fb-up-btn" onClick={() => navigateTo(parentPath)} title="Go up">↑</button>
          )}
          <input
            className="fb-path-input"
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') navigateTo(pathInput); }}
            placeholder="Type a path and press Enter…"
            spellCheck={false}
          />
          <button className="fb-go-btn" onClick={() => navigateTo(pathInput)}>Go</button>
        </div>

        <div className="fb-breadcrumbs">
          {breadcrumbs.map((b, i) => (
            <React.Fragment key={b.path}>
              {i > 0 && <span className="fb-sep">›</span>}
              <button
                className={`fb-crumb ${i === breadcrumbs.length - 1 ? 'is-current' : ''}`}
                onClick={() => navigateTo(b.path)}
              >
                {b.label}
              </button>
            </React.Fragment>
          ))}
        </div>

        <div className="fb-filter-row">
          <input
            ref={filterRef}
            className="fb-filter"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter folders…"
          />
          {loading && <span className="fb-spinner">⟳</span>}
          {!newFolderMode && (
            <button className="fb-newfolder-btn" onClick={openNewFolder} title="Create new folder here">
              + New
            </button>
          )}
        </div>

        {newFolderMode && (
          <div className="fb-newfolder-row">
            <span className="fb-folder-icon" style={{ flexShrink: 0 }}>📁</span>
            <input
              ref={newFolderRef}
              className="fb-newfolder-input"
              value={newFolderName}
              onChange={e => { setNewFolderName(e.target.value); setNewFolderErr(''); }}
              onKeyDown={e => {
                if (e.key === 'Enter') createFolder();
                if (e.key === 'Escape') setNewFolderMode(false);
              }}
              placeholder="New folder name…"
            />
            <button className="fb-go-btn" onClick={createFolder} disabled={!newFolderName.trim()}>
              Create
            </button>
            <button className="fb-close" style={{ fontSize: 18, padding: '0 6px' }} onClick={() => setNewFolderMode(false)}>
              ×
            </button>
            {newFolderErr && <span className="fb-newfolder-err">{newFolderErr}</span>}
          </div>
        )}

        <div className="fb-list">
          {error && <div className="fb-error-msg">⚠ {error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="fb-empty-msg">{filter ? 'No matches' : 'Empty directory'}</div>
          )}
          {filtered.map(f => (
            <button
              key={f.path}
              className="fb-folder-item"
              onClick={() => {
                setWsName(f.name);
                navigateTo(f.path);
              }}
              title={f.path}
            >
              <span className="fb-folder-icon">📁</span>
              <span className="fb-folder-name">{f.name}</span>
              <span className="fb-folder-chevron">›</span>
            </button>
          ))}
        </div>

        <div className="fb-footer">
          <div className="fb-selected-display">
            <span className="fb-sel-label">Folder:</span>
            <span className="fb-sel-path" title={browsePath}>{browsePath}</span>
          </div>
          <div className="fb-name-row">
            <span className="fb-sel-label">Name:</span>
            <input
              className="fb-name-input"
              value={wsName}
              onChange={e => setWsName(e.target.value)}
              placeholder="Workspace name"
              onKeyDown={e => { if (e.key === 'Enter') handleConfirm(); }}
            />
          </div>
          <div className="fb-footer-actions">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className="btn-primary"
              disabled={!wsName.trim() || !browsePath || loading}
              onClick={handleConfirm}
            >
              Add Workspace
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Code Workspace Tab ──────────────────────────────────────────────────
function CodeWorkspaceTab({ isVisible = true }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWsId, setActiveWsId] = useState(() => localStorage.getItem(ACTIVE_KEY) || '');
  const activeWs = useMemo(() => workspaces.find(w => w.id === activeWsId) || null, [workspaces, activeWsId]);
  const cwd = activeWs?.cwd || '';

  const [agents, setAgents] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState('shell');

  const [terminals, setTerminals] = useState([]);
  const [activeTermId, setActiveTermId] = useState(null);
  const termSeq = useRef(0);

  const [showBrowser, setShowBrowser] = useState(false);
  const [showWsPopover, setShowWsPopover] = useState(false);
  const [showAgentPopover, setShowAgentPopover] = useState(false);
  const [renameId, setRenameId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef(null);

  const wsContainerRef = useRef(null);
  const agentContainerRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (renameId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renameId]);

  const startRename = (e, w) => {
    e.stopPropagation();
    setRenameId(w.id);
    setRenameValue(w.name);
  };

  const commitRename = async () => {
    const id = renameId;
    const name = renameValue.trim();
    if (!id) return;
    setRenameId(null);
    const orig = workspaces.find(w => w.id === id);
    if (!name || !orig || name === orig.name) return;
    try {
      const r = await axios.put(`/api/workspaces/${id}`, { name });
      if (!mountedRef.current) return;
      setWorkspaces(prev => prev.map(w => w.id === id ? r.data.workspace : w));
      window.UI?.toast?.({ kind: 'ok', title: 'Workspace renamed', body: name });
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Rename failed', body: e.response?.data?.error || e.message });
    }
  };

  const terminalFitRefs = useRef({});
  useEffect(() => {
    if (!isVisible) return;
    Object.values(terminalFitRefs.current).forEach(fn => { try { fn(); } catch {} });
  }, [isVisible]);

  // Close popovers on outside click
  useEffect(() => {
    if (!showWsPopover && !showAgentPopover) return;
    const handler = (e) => {
      if (showWsPopover && wsContainerRef.current && !wsContainerRef.current.contains(e.target)) {
        setShowWsPopover(false);
      }
      if (showAgentPopover && agentContainerRef.current && !agentContainerRef.current.contains(e.target)) {
        setShowAgentPopover(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showWsPopover, showAgentPopover]);

  const loadData = useCallback(async () => {
    try {
      const [wsRes, agRes] = await Promise.all([
        axios.get('/api/workspaces').catch(() => null),
        axios.get('/api/agents').catch(() => null),
      ]);
      if (!mountedRef.current) return;

      const wsList = wsRes?.data?.workspaces || [];
      setWorkspaces(wsList);
      const stored = localStorage.getItem(ACTIVE_KEY);
      if (stored && wsList.find(w => w.id === stored)) {
        setActiveWsId(stored);
      } else if (wsList.length > 0) {
        setActiveWsId(wsList[0].id);
      }

      const rawAgents = agRes?.data?.agents || [];
      const formattedAgents = [
        { id: 'shell', label: 'Standard Shell', cmd: 'shell', vendor: 'System', version: '' },
        ...rawAgents,
      ];
      setAgents(formattedAgents);
      if (formattedAgents.length > 1) setSelectedAgentId(formattedAgents[1].id);
      else if (formattedAgents.length > 0) setSelectedAgentId(formattedAgents[0].id);
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Loading failed', body: e.message });
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { if (activeWsId) localStorage.setItem(ACTIVE_KEY, activeWsId); }, [activeWsId]);

  const handleBrowserConfirm = async (folderPath, name) => {
    setShowBrowser(false);
    try {
      const r = await axios.post('/api/workspaces', { name, cwd: folderPath });
      if (!mountedRef.current) return;
      setWorkspaces(prev => [...prev, r.data.workspace]);
      setActiveWsId(r.data.workspace.id);
      window.UI?.toast?.({ kind: 'ok', title: 'Workspace added', body: name });
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Failed to add workspace', body: e.response?.data?.error || e.message });
    }
  };

  const handleDeleteWorkspace = async (id, name, e) => {
    e?.stopPropagation();
    const ok = await window.UI.confirm({
      title: 'Delete Workspace',
      body: `Remove "${name}" from your workspace list? This does not delete any files.`,
      confirmLabel: 'Delete',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await axios.delete(`/api/workspaces/${id}`);
      if (!mountedRef.current) return;
      setWorkspaces(prev => prev.filter(w => w.id !== id));
      if (activeWsId === id) setActiveWsId('');
      window.UI?.toast?.({ kind: 'ok', title: 'Workspace removed', body: name });
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Delete failed', body: e.response?.data?.error || e.message });
    }
  };

  const launchSession = useCallback((agentId) => {
    if (!cwd) {
      window.UI?.toast?.({ kind: 'err', title: 'No workspace', body: 'Select a workspace first.' });
      return;
    }
    const agentObj = agents.find(a => a.id === agentId);
    const id = 't' + (++termSeq.current);
    const title = agentObj?.label || 'Shell';
    const paramAgent = agentId === 'shell' ? null : agentId;
    setTerminals(prev => [...prev, { id, agent: paramAgent, title }]);
    setActiveTermId(id);
  }, [cwd, agents]);

  const closeTerminal = useCallback((id) => {
    setTerminals(prev => {
      const rest = prev.filter(t => t.id !== id);
      setActiveTermId(cur => cur === id ? (rest.length ? rest[rest.length - 1].id : null) : cur);
      return rest;
    });
  }, []);

  const envCsv = ENV_PASSTHROUGH_DEFAULT.join(',');
  const selectedAgent = useMemo(() => agents.find(a => a.id === selectedAgentId) || null, [agents, selectedAgentId]);

  return (
    <div className="ws-root">


      {showBrowser && (
        <FolderBrowserModal
          initialPath={cwd ? cwd.split('/').slice(0, -1).join('/') || '/' : '/home'}
          onConfirm={handleBrowserConfirm}
          onClose={() => setShowBrowser(false)}
        />
      )}

      {/* Terminal area */}
      <div className="ws-main">
        {terminals.length > 0 && (
          <div className="term-tabs">
            {terminals.map(t => {
              const isActive = activeTermId === t.id;
              const glyph = t.agent ? (AGENT_GLYPHS[t.agent] || '✦') : '›_';
              return (
                <button
                  key={t.id}
                  className={`term-tab ${isActive ? 'is-active' : ''}`}
                  onClick={() => setActiveTermId(t.id)}
                >
                  <span>{glyph}</span>
                  <span>{t.title}</span>
                  <button
                    className="term-tab-x"
                    onClick={(e) => { e.stopPropagation(); closeTerminal(t.id); }}
                  >
                    ×
                  </button>
                </button>
              );
            })}
            <div style={{ flex: 1 }} />
            <button
              className="btn-ghost sm"
              style={{ marginRight: 10, alignSelf: 'center' }}
              onClick={() => launchSession('shell')}
            >
              + Shell
            </button>
          </div>
        )}

        <div className="term-display">
          {terminals.length === 0 ? (
            <div className="term-empty">
              <div className="empty-orb">✦</div>
              <div className="empty-title">Ready to Code</div>
              <div className="empty-body">
                Pick a workspace and agent in the toolbar below, then click Launch — or quick-start with an agent.
              </div>
              <div className="qs-grid">
                {agents.map(a => (
                  <button
                    key={a.id}
                    className="qs-btn"
                    disabled={!cwd}
                    onClick={() => launchSession(a.id)}
                  >
                    <span>{AGENT_GLYPHS[a.id] || '✦'}</span>
                    {a.label}
                  </button>
                ))}
              </div>
              {!cwd && (
                <div style={{ marginTop: 16, color: '#f87171', fontSize: '12px' }}>
                  ⚠ Select a workspace using the toolbar below.
                </div>
              )}
            </div>
          ) : (
            terminals.map(t => (
              <div key={t.id} style={{ position: 'absolute', inset: 0 }}>
                <TerminalPane
                  id={t.id}
                  cwd={cwd}
                  agent={t.agent}
                  envCsv={envCsv}
                  active={activeTermId === t.id}
                  onTitle={() => {}}
                  onRegisterFit={(tid, fn) => {
                    if (fn) terminalFitRefs.current[tid] = fn;
                    else delete terminalFitRefs.current[tid];
                  }}
                />
              </div>
            ))
          )}
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="ws-toolbar">
        {/* Workspace picker */}
        <div className="ws-tb-section" ref={wsContainerRef}>
          <button
            className={`ws-tb-btn${showWsPopover ? ' is-open' : ''}`}
            onClick={() => { setShowWsPopover(p => !p); setShowAgentPopover(false); }}
          >
            <span className="ws-tb-icon">📁</span>
            <span className="ws-tb-label">{activeWs?.name || 'Select Workspace'}</span>
            <span className="ws-tb-caret">▾</span>
          </button>
          {showWsPopover && (
            <div className="ws-popover">
              <div className="ws-popover-header">Workspaces</div>
              <div className="ws-popover-body">
                {workspaces.length === 0 && (
                  <div className="ws-no-workspaces">No workspaces yet</div>
                )}
                {workspaces.map(w => (
                  <div
                    key={w.id}
                    className={`ws-item${w.id === activeWsId ? ' is-active' : ''}`}
                    onClick={() => {
                      if (renameId === w.id) return;
                      setActiveWsId(w.id);
                      setShowWsPopover(false);
                    }}
                    onDoubleClick={(e) => startRename(e, w)}
                  >
                    <span className="ws-item-icon">📁</span>
                    <div className="ws-item-info">
                      {renameId === w.id ? (
                        <input
                          ref={renameInputRef}
                          className="ws-item-rename"
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
                        <span className="ws-item-name">{w.name}</span>
                      )}
                      <span className="ws-item-path">{w.cwd}</span>
                    </div>
                    {renameId !== w.id && (
                      <>
                        <button
                          className="ws-item-edit"
                          onClick={(e) => startRename(e, w)}
                          title="Rename workspace"
                        >✎</button>
                        <button
                          className="ws-item-del"
                          onClick={(e) => handleDeleteWorkspace(w.id, w.name, e)}
                          title="Remove workspace"
                        >×</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div className="ws-popover-footer">
                <button
                  className="ws-add-btn"
                  onClick={() => { setShowBrowser(true); setShowWsPopover(false); }}
                >
                  + Add Workspace
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="ws-tb-divider" />

        {/* Agent picker */}
        <div className="ws-tb-section" ref={agentContainerRef}>
          <button
            className={`ws-tb-btn${showAgentPopover ? ' is-open' : ''}`}
            onClick={() => { setShowAgentPopover(p => !p); setShowWsPopover(false); }}
          >
            <span className="ws-tb-icon">{AGENT_GLYPHS[selectedAgentId] || '✦'}</span>
            <span className="ws-tb-label">{selectedAgent?.label || 'Select Agent'}</span>
            <span className="ws-tb-caret">▾</span>
          </button>
          {showAgentPopover && (
            <div className="ws-popover">
              <div className="ws-popover-header">Coding Agent</div>
              <div className="ws-popover-body">
                {agents.map(a => {
                  const glyph = AGENT_GLYPHS[a.id] || '✦';
                  const isSel = selectedAgentId === a.id;
                  return (
                    <div
                      key={a.id}
                      className={`agent-card${isSel ? ' is-selected' : ''}`}
                      onClick={() => { setSelectedAgentId(a.id); setShowAgentPopover(false); }}
                    >
                      <div className="agent-glyph">{glyph}</div>
                      <div className="agent-info">
                        <div className="agent-name">
                          <span>{a.label}</span>
                          {a.version && <span className="agent-ver">v{a.version}</span>}
                        </div>
                        <div className="agent-sub">{a.cmd === 'shell' ? 'bash' : a.cmd}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {/* Launch */}
        <button
          className="ws-launch-btn"
          disabled={!cwd}
          onClick={() => {
            launchSession(selectedAgentId);
            setShowWsPopover(false);
            setShowAgentPopover(false);
          }}
        >
          <span>▶</span>
          {selectedAgent ? `Launch ${selectedAgent.label}` : 'Launch Session'}
        </button>
      </div>
    </div>
  );
}

export { CodeWorkspaceTab };
