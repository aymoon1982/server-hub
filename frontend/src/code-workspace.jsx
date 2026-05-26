import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'react';
import axios from 'axios';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

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
function TerminalPane({ id, cwd, agent, envCsv, active, onTitle, onRegisterFit }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  useLayoutEffect(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new Terminal({
      allowProposedApi: true,
      scrollback: 4000,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#08080c', foreground: '#f3f4f6', cursor: '#a78bfa', selectionBackground: 'rgba(167, 139, 250, 0.2)' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    try { fit.fit(); } catch {}
    termRef.current = term;
    fitRef.current = fit;
    if (onRegisterFit) onRegisterFit(id, () => { try { fit.fit(); } catch {} });

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams();
    if (cwd) params.set('cwd', cwd);
    if (agent) params.set('agent', agent);
    if (envCsv) params.set('env', envCsv);
    params.set('cols', String(term.cols));
    params.set('rows', String(term.rows));
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/terminal?${params.toString()}`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    const decoder = new TextDecoder();
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) term.write(decoder.decode(e.data));
      else if (typeof e.data === 'string') term.write(e.data);
    };
    ws.onopen = () => {
      term.focus();
      if (onTitle) onTitle(id, agent ? `${agent}` : 'shell');
    };
    ws.onerror = () => { try { term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n'); } catch {} };
    ws.onclose = () => { try { term.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n'); } catch {} };
    term.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(d); });

    let resizeTimer = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          fit.fit();
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        } catch {}
      }, 60);
    });
    ro.observe(containerRef.current);

    return () => {
      clearTimeout(resizeTimer);
      if (onRegisterFit) onRegisterFit(id, null);
      try { ro.disconnect(); } catch {}
      try { ws.close(); } catch {}
      try { term.dispose(); } catch {}
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (active && termRef.current) {
      try { fitRef.current?.fit(); } catch {}
      try { termRef.current.focus(); } catch {}
    }
  }, [active]);

  return (
    <div
      ref={containerRef}
      style={{ display: active ? 'block' : 'none', width: '100%', height: '100%', background: '#08080c' }}
    />
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
      <style>{`
        .ws-root {
          display: flex;
          flex-direction: column;
          height: calc(100vh - 56px);
          background: #08080c;
          color: #f3f4f6;
          font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
          overflow: hidden;
        }

        /* ── Terminal area ── */
        .ws-main {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          background: #08080c;
        }

        .term-tabs {
          display: flex;
          align-items: center;
          background: #0d0d18;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          min-height: 38px;
          padding-left: 8px;
          overflow-x: auto;
        }

        .term-tab {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 12px;
          height: 38px;
          background: none;
          border: 0;
          border-right: 1px solid rgba(255,255,255,0.04);
          color: #6b7280;
          cursor: pointer;
          font-size: 12px;
          transition: all 0.15s;
          white-space: nowrap;
          position: relative;
          flex-shrink: 0;
        }

        .term-tab:hover { color: #d1d5db; }

        .term-tab.is-active {
          background: #08080c;
          color: #f3f4f6;
          font-weight: 600;
        }

        .term-tab.is-active::after {
          content: '';
          position: absolute;
          bottom: 0; left: 0; right: 0;
          height: 2px;
          background: #a78bfa;
        }

        .term-tab-x {
          background: none;
          border: 0;
          color: #4b5563;
          font-size: 15px;
          padding: 0 3px;
          cursor: pointer;
          border-radius: 3px;
          line-height: 1;
          transition: all 0.15s;
        }

        .term-tab-x:hover { color: #f3f4f6; background: rgba(255,255,255,0.08); }

        .term-display {
          flex: 1;
          position: relative;
          min-height: 0;
        }

        /* Empty state */
        .term-empty {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px;
          text-align: center;
          background: radial-gradient(circle at center, rgba(167,139,250,0.03) 0%, transparent 70%);
        }

        .empty-orb {
          width: 72px;
          height: 72px;
          border-radius: 50%;
          background: rgba(167,139,250,0.05);
          border: 1px solid rgba(167,139,250,0.15);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 32px;
          margin-bottom: 20px;
          box-shadow: 0 0 30px rgba(167,139,250,0.1);
        }

        .empty-title {
          font-size: 18px;
          font-weight: 700;
          color: #f3f4f6;
          margin-bottom: 8px;
        }

        .empty-body {
          font-size: 13px;
          color: #6b7280;
          max-width: 400px;
          line-height: 1.6;
          margin-bottom: 24px;
        }

        .qs-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
          justify-content: center;
          max-width: 520px;
        }

        .qs-btn {
          background: #0f0f1e;
          border: 1px solid rgba(255,255,255,0.06);
          color: #d1d5db;
          padding: 7px 13px;
          border-radius: 6px;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.15s;
          display: flex;
          align-items: center;
          gap: 5px;
        }

        .qs-btn:hover:not(:disabled) {
          background: #141430;
          border-color: rgba(167,139,250,0.4);
          transform: translateY(-1px);
        }

        .qs-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        /* ── Bottom toolbar ── */
        .ws-toolbar {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 14px;
          height: 56px;
          min-height: 56px;
          background: #0b0b14;
          border-top: 1px solid rgba(255,255,255,0.07);
        }

        .ws-tb-section {
          position: relative;
          flex-shrink: 0;
        }

        .ws-tb-btn {
          display: flex;
          align-items: center;
          gap: 7px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          color: #d1d5db;
          padding: 7px 13px;
          border-radius: 7px;
          font-size: 13px;
          cursor: pointer;
          transition: all 0.15s;
          white-space: nowrap;
          max-width: 230px;
          height: 36px;
        }

        .ws-tb-btn:hover {
          background: rgba(255,255,255,0.07);
          border-color: rgba(255,255,255,0.14);
          color: #f3f4f6;
        }

        .ws-tb-btn.is-open {
          background: rgba(167,139,250,0.1);
          border-color: rgba(167,139,250,0.4);
          color: #c4b5fd;
        }

        .ws-tb-icon { font-size: 14px; flex-shrink: 0; }

        .ws-tb-label {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 160px;
          font-weight: 500;
        }

        .ws-tb-caret { color: #6b7280; font-size: 10px; flex-shrink: 0; margin-left: 1px; }

        .ws-tb-divider {
          width: 1px;
          height: 22px;
          background: rgba(255,255,255,0.08);
          flex-shrink: 0;
          margin: 0 2px;
        }

        /* Upward popovers */
        .ws-popover {
          position: absolute;
          bottom: calc(100% + 8px);
          left: 0;
          background: #0f0f1d;
          border: 1px solid rgba(167,139,250,0.2);
          border-radius: 9px;
          box-shadow: 0 -4px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04);
          z-index: 300;
          min-width: 270px;
          max-height: 400px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          animation: popUp 0.15s cubic-bezier(0.34,1.56,0.64,1);
        }

        @keyframes popUp {
          from { opacity: 0; transform: translateY(6px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        .ws-popover-header {
          padding: 9px 12px 7px;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #a78bfa;
          flex-shrink: 0;
        }

        .ws-popover-body {
          flex: 1;
          overflow-y: auto;
          padding: 6px;
        }

        .ws-popover-footer {
          padding: 6px;
          border-top: 1px solid rgba(255,255,255,0.05);
          flex-shrink: 0;
        }

        /* Workspace items in popover */
        .ws-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 9px;
          border-radius: 6px;
          cursor: pointer;
          border: 1px solid transparent;
          transition: background 0.15s, border-color 0.15s;
          position: relative;
        }

        .ws-item:hover { background: rgba(255,255,255,0.04); }

        .ws-item.is-active {
          background: rgba(167,139,250,0.08);
          border-color: rgba(167,139,250,0.25);
        }

        .ws-item-icon { font-size: 14px; flex-shrink: 0; opacity: 0.75; }
        .ws-item-info { flex: 1; min-width: 0; }
        .ws-item-name {
          font-size: 12px; font-weight: 600; color: #e5e7eb;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block;
        }
        .ws-item.is-active .ws-item-name { color: #c4b5fd; }
        .ws-item-path {
          font-size: 10px; color: #6b7280; font-family: ui-monospace, monospace;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block;
        }
        .ws-item-edit, .ws-item-del {
          background: none; border: 0; color: #4b5563;
          line-height: 1; padding: 2px 4px;
          cursor: pointer; border-radius: 4px;
          opacity: 0; transition: opacity 0.15s, color 0.15s; flex-shrink: 0;
        }
        .ws-item-edit { font-size: 12px; }
        .ws-item-del  { font-size: 16px; }
        .ws-item:hover .ws-item-edit, .ws-item:hover .ws-item-del,
        .ws-item.is-active .ws-item-edit, .ws-item.is-active .ws-item-del { opacity: 1; }
        .ws-item-edit:hover { color: #a78bfa; background: rgba(167,139,250,0.1); }
        .ws-item-del:hover  { color: #ef4444; background: rgba(239,68,68,0.1); }
        .ws-item-rename {
          background: #08080f; border: 1px solid rgba(167,139,250,0.4);
          color: #f3f4f6; padding: 2px 6px; border-radius: 4px;
          font-size: 12px; font-weight: 600; outline: none; width: 100%;
          box-sizing: border-box;
        }
        .ws-item-rename:focus { border-color: rgba(167,139,250,0.7); }

        .ws-no-workspaces {
          font-size: 11px; color: #4b5563; text-align: center; padding: 14px 0;
        }

        .ws-add-btn {
          width: 100%;
          background: rgba(167,139,250,0.07);
          border: 1px dashed rgba(167,139,250,0.3);
          color: #a78bfa;
          padding: 7px;
          border-radius: 6px;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
          text-align: center;
        }
        .ws-add-btn:hover { background: rgba(167,139,250,0.13); border-style: solid; }

        /* Agent cards in popover */
        .agent-card {
          display: flex; align-items: center; gap: 9px;
          background: #111120;
          border: 1px solid rgba(255,255,255,0.05);
          border-radius: 6px; padding: 8px 10px;
          cursor: pointer; transition: all 0.15s; margin-bottom: 3px;
        }
        .agent-card:last-child { margin-bottom: 0; }
        .agent-card:hover { background: #151528; border-color: rgba(255,255,255,0.09); }
        .agent-card.is-selected {
          background: rgba(167,139,250,0.08);
          border-color: rgba(167,139,250,0.4);
        }

        .agent-glyph {
          font-size: 17px; width: 28px; height: 28px;
          display: flex; align-items: center; justify-content: center;
          background: rgba(255,255,255,0.03); border-radius: 5px; flex-shrink: 0;
        }
        .agent-card.is-selected .agent-glyph { background: rgba(167,139,250,0.12); }

        .agent-info { flex: 1; min-width: 0; }
        .agent-name {
          font-size: 12px; font-weight: 600; color: #e5e7eb;
          display: flex; align-items: center; justify-content: space-between;
        }
        .agent-card.is-selected .agent-name { color: #c4b5fd; }
        .agent-sub {
          font-size: 10px; color: #6b7280; font-family: ui-monospace, monospace; margin-top: 1px;
        }
        .agent-ver {
          background: rgba(255,255,255,0.06); color: #6b7280;
          font-size: 9px; padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, monospace;
        }
        .agent-card.is-selected .agent-ver { background: rgba(167,139,250,0.18); color: #a78bfa; }

        /* Launch button */
        .ws-launch-btn {
          background: linear-gradient(135deg, #a78bfa, #7c3aed);
          color: #fff;
          border: 0;
          padding: 9px 22px;
          border-radius: 7px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          box-shadow: 0 3px 12px rgba(124,58,237,0.3);
          flex-shrink: 0;
          white-space: nowrap;
          height: 36px;
        }
        .ws-launch-btn:hover:not(:disabled) {
          filter: brightness(1.1);
          transform: translateY(-1px);
          box-shadow: 0 5px 18px rgba(124,58,237,0.4);
        }
        .ws-launch-btn:disabled {
          background: #1a1a2a; color: #4b5563; cursor: not-allowed; box-shadow: none;
        }

        /* Shared buttons */
        .btn-ghost {
          background: none;
          border: 1px solid rgba(255,255,255,0.1);
          color: #d1d5db;
          padding: 6px 12px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12px;
          transition: all 0.15s;
        }
        .btn-ghost:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.18); }
        .btn-ghost.sm { padding: 4px 8px; font-size: 11px; }

        .btn-primary {
          background: #7c3aed; color: #fff; border: 0;
          padding: 7px 16px; border-radius: 6px;
          font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s;
        }
        .btn-primary:hover:not(:disabled) { filter: brightness(1.15); }
        .btn-primary:disabled { background: #2a2a3a; color: #4b5563; cursor: not-allowed; }

        /* ── Folder Browser Modal ── */
        .fb-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.65);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          backdrop-filter: blur(3px);
          animation: fbFadeIn 0.15s ease-out;
        }

        @keyframes fbFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .fb-dialog {
          background: #0f0f1d;
          border: 1px solid rgba(167,139,250,0.2);
          border-radius: 10px;
          width: 540px;
          max-width: calc(100vw - 32px);
          max-height: calc(100vh - 64px);
          display: flex;
          flex-direction: column;
          box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04);
          animation: fbSlideIn 0.2s cubic-bezier(0.34,1.56,0.64,1);
          overflow: hidden;
        }

        @keyframes fbSlideIn {
          from { opacity: 0; transform: scale(0.95) translateY(8px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }

        .fb-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px 12px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }

        .fb-header-title {
          font-size: 14px;
          font-weight: 700;
          color: #f3f4f6;
          display: flex;
          align-items: center;
        }

        .fb-close {
          background: none;
          border: 0;
          color: #6b7280;
          font-size: 22px;
          line-height: 1;
          cursor: pointer;
          padding: 0 4px;
          border-radius: 4px;
          transition: all 0.15s;
        }
        .fb-close:hover { color: #f3f4f6; background: rgba(255,255,255,0.08); }

        .fb-path-row {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 10px 12px 6px;
        }

        .fb-up-btn {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.08);
          color: #d1d5db;
          width: 30px; height: 30px;
          border-radius: 6px; cursor: pointer; font-size: 16px;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0; transition: all 0.15s;
        }
        .fb-up-btn:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.15); }

        .fb-path-input {
          flex: 1;
          background: #080810;
          border: 1px solid rgba(255,255,255,0.08);
          color: #e5e7eb;
          padding: 6px 10px;
          border-radius: 6px;
          font-size: 12px;
          font-family: ui-monospace, monospace;
          outline: none;
          transition: border-color 0.15s;
        }
        .fb-path-input:focus { border-color: rgba(167,139,250,0.5); }

        .fb-go-btn {
          background: rgba(167,139,250,0.12);
          border: 1px solid rgba(167,139,250,0.25);
          color: #a78bfa;
          padding: 6px 10px;
          border-radius: 6px; font-size: 12px; cursor: pointer;
          flex-shrink: 0; transition: all 0.15s;
        }
        .fb-go-btn:hover { background: rgba(167,139,250,0.2); }

        .fb-breadcrumbs {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 1px;
          padding: 2px 12px 8px;
          min-height: 26px;
        }

        .fb-crumb {
          background: none; border: 0; color: #6b7280;
          font-size: 11px; cursor: pointer; padding: 2px 4px;
          border-radius: 3px; transition: all 0.1s; white-space: nowrap;
        }
        .fb-crumb:hover { color: #d1d5db; background: rgba(255,255,255,0.06); }
        .fb-crumb.is-current { color: #c4b5fd; font-weight: 600; cursor: default; pointer-events: none; }

        .fb-sep { color: #374151; font-size: 11px; margin: 0 1px; }

        .fb-filter-row {
          display: flex; align-items: center; gap: 8px; padding: 0 12px 8px;
        }

        .fb-filter {
          flex: 1;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.06);
          color: #d1d5db; padding: 5px 10px;
          border-radius: 5px; font-size: 12px; outline: none; transition: border-color 0.15s;
        }
        .fb-filter:focus { border-color: rgba(167,139,250,0.35); }
        .fb-filter::placeholder { color: #374151; }

        .fb-newfolder-btn {
          background: rgba(167,139,250,0.1);
          border: 1px solid rgba(167,139,250,0.25);
          color: #a78bfa;
          padding: 4px 9px;
          border-radius: 5px;
          font-size: 11px;
          cursor: pointer;
          white-space: nowrap;
          flex-shrink: 0;
          transition: all 0.15s;
        }
        .fb-newfolder-btn:hover { background: rgba(167,139,250,0.18); }

        .fb-newfolder-row {
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 6px 12px 6px;
          background: rgba(167,139,250,0.04);
          border-top: 1px solid rgba(167,139,250,0.1);
          border-bottom: 1px solid rgba(167,139,250,0.1);
          flex-wrap: wrap;
        }

        .fb-newfolder-input {
          flex: 1;
          min-width: 120px;
          background: #080810;
          border: 1px solid rgba(167,139,250,0.35);
          color: #f3f4f6;
          padding: 5px 9px;
          border-radius: 5px;
          font-size: 12px;
          outline: none;
          transition: border-color 0.15s;
        }
        .fb-newfolder-input:focus { border-color: rgba(167,139,250,0.6); }
        .fb-newfolder-input::placeholder { color: #4b5563; }

        .fb-newfolder-err {
          width: 100%;
          font-size: 11px;
          color: #f87171;
          padding-left: 24px;
        }

        .fb-spinner {
          color: #a78bfa; font-size: 16px;
          animation: spin 0.8s linear infinite; flex-shrink: 0;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .fb-list {
          flex: 1; overflow-y: auto;
          border-top: 1px solid rgba(255,255,255,0.05);
          border-bottom: 1px solid rgba(255,255,255,0.05);
          min-height: 180px; max-height: 280px;
        }

        .fb-folder-item {
          display: flex; align-items: center; gap: 9px;
          width: 100%; background: none; border: 0; color: #d1d5db;
          padding: 7px 14px; cursor: pointer; font-size: 13px;
          text-align: left; transition: background 0.1s;
          border-bottom: 1px solid rgba(255,255,255,0.03);
        }
        .fb-folder-item:hover { background: rgba(167,139,250,0.07); color: #e5e7eb; }
        .fb-folder-item:last-child { border-bottom: 0; }
        .fb-folder-icon { flex-shrink: 0; font-size: 14px; }
        .fb-folder-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fb-folder-chevron { color: #374151; flex-shrink: 0; font-size: 16px; }
        .fb-error-msg { color: #f87171; font-size: 12px; padding: 14px 16px; }
        .fb-empty-msg { color: #4b5563; font-size: 12px; padding: 24px 16px; text-align: center; }

        .fb-footer {
          padding: 12px 14px;
          display: flex; flex-direction: column; gap: 8px;
        }
        .fb-selected-display, .fb-name-row {
          display: flex; align-items: center; gap: 8px;
        }
        .fb-sel-label {
          font-size: 11px; color: #6b7280; font-weight: 600;
          flex-shrink: 0; width: 38px; text-align: right;
        }
        .fb-sel-path {
          font-family: ui-monospace, monospace; font-size: 11px; color: #9ca3af;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
        }
        .fb-name-input {
          flex: 1;
          background: #080810;
          border: 1px solid rgba(255,255,255,0.1);
          color: #f3f4f6; padding: 6px 10px; border-radius: 5px;
          font-size: 13px; outline: none; transition: border-color 0.15s;
        }
        .fb-name-input:focus { border-color: rgba(167,139,250,0.5); }
        .fb-footer-actions {
          display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px;
        }

        /* Scrollbars */
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: rgba(0,0,0,0.1); }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.14); }
      `}</style>

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
