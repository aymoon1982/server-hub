import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'react';
import axios from 'axios';
import Editor from '@monaco-editor/react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', php: 'php',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  md: 'markdown', mdx: 'markdown',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  sql: 'sql', dockerfile: 'dockerfile', env: 'ini', ini: 'ini', conf: 'ini',
};
const langOf = (name) => {
  if (!name) return 'plaintext';
  const lower = String(name).toLowerCase();
  if (lower === 'dockerfile' || lower.endsWith('/dockerfile')) return 'dockerfile';
  if (lower === 'makefile' || lower.endsWith('/makefile')) return 'makefile';
  const ext = lower.split('.').pop();
  return LANG_BY_EXT[ext] || 'plaintext';
};

const ENV_PASSTHROUGH_DEFAULT = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY',
  'OLLAMA_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'EDITOR', 'PATH', 'HOME', 'USER',
];

const LAYOUT_KEY = 'code_workspace_layout';
const ACTIVE_KEY = 'code_workspace_active_id';

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    return v;
  } catch { return null; }
}
function saveLayout(l) { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch {} }

// ─── File Tree ────────────────────────────────────────────────────────────────
function TreeNode({ node, depth, expanded, onToggle, onOpenFile, onContext, filter }) {
  const matches = !filter || node.name.toLowerCase().includes(filter.toLowerCase());
  const isExpanded = expanded.has(node.path);
  const icon = node.isDir ? (isExpanded ? '▾' : '▸') : '·';
  const hasFilteredChildren = node.children && node.children.some(c =>
    !filter || c.name.toLowerCase().includes(filter.toLowerCase()) ||
    (c.children && c.children.length > 0)
  );
  const shouldShow = matches || (node.isDir && filter && hasFilteredChildren);
  if (!shouldShow && filter) return null;

  return (
    <div>
      <div
        className="tree-row"
        style={{ paddingLeft: 6 + depth * 12, opacity: matches ? 1 : 0.6 }}
        onClick={() => node.isDir ? onToggle(node) : onOpenFile(node)}
        onContextMenu={(e) => { e.preventDefault(); onContext(e, node); }}
      >
        <span className="tree-icon">{icon}</span>
        <span className="tree-name" title={node.path}>{node.name}</span>
      </div>
      {node.isDir && isExpanded && node.children && (
        <div>
          {node.children.map(c => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onContext={onContext}
              filter={filter}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Embedded Terminal (single tab) ───────────────────────────────────────────
function TerminalPane({ id, cwd, agent, envCsv, active, onClose, onTitle }) {
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
      fontSize: 12,
      theme: { background: '#0d0d12', foreground: '#e8e8ee', cursor: '#a78bfa' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    try { fit.fit(); } catch {}
    termRef.current = term;
    fitRef.current = fit;

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
    ws.onerror = () => {
      try { term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n'); } catch {}
    };
    ws.onclose = () => {
      try { term.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n'); } catch {}
    };

    term.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(d); });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));
      } catch {}
    });
    ro.observe(containerRef.current);

    return () => {
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
      className="ide-term-pane"
      style={{ display: active ? 'block' : 'none', width: '100%', height: '100%', background: '#0d0d12' }}
    />
  );
}

// ─── Tab strip for editors / terminals ────────────────────────────────────────
function TabStrip({ tabs, activeId, onSelect, onClose, renderRight, getTitle, getDirty }) {
  return (
    <div className="ide-tabs">
      {tabs.map(t => (
        <div
          key={t.id}
          className={`ide-tab ${activeId === t.id ? 'is-active' : ''}`}
          onClick={() => onSelect(t.id)}
          title={getTitle ? getTitle(t) : t.title}
        >
          <span className="ide-tab-title">{getTitle ? getTitle(t) : t.title}</span>
          {getDirty && getDirty(t) && <span className="ide-tab-dirty">•</span>}
          <button
            className="ide-tab-close"
            onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
            title="Close"
          >×</button>
        </div>
      ))}
      {renderRight}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
function CodeWorkspaceTab() {
  const layout = loadLayout() || {};
  const [leftWidth, setLeftWidth] = useState(layout.leftWidth || 260);
  const [bottomHeight, setBottomHeight] = useState(layout.bottomHeight || 280);
  const [resizing, setResizing] = useState(null);

  const [workspaces, setWorkspaces] = useState([]);
  const [activeWsId, setActiveWsId] = useState(() => localStorage.getItem(ACTIVE_KEY) || '');
  const activeWs = useMemo(() => workspaces.find(w => w.id === activeWsId) || null, [workspaces, activeWsId]);
  const cwd = activeWs?.cwd || '';

  const [tree, setTree] = useState([]);
  const [expanded, setExpanded] = useState(new Set());
  const [treeFilter, setTreeFilter] = useState('');

  const [openFiles, setOpenFiles] = useState([]); // [{id, path, name, content, original, language}]
  const [activeFileId, setActiveFileId] = useState(null);

  const [terminals, setTerminals] = useState([]); // [{id, agent, title}]
  const [activeTermId, setActiveTermId] = useState(null);
  const termSeq = useRef(0);

  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState('');

  const [ctxMenu, setCtxMenu] = useState(null);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Persist layout
  useEffect(() => { saveLayout({ leftWidth, bottomHeight }); }, [leftWidth, bottomHeight]);

  // Load workspaces and agents on mount
  useEffect(() => {
    (async () => {
      try {
        const [wsRes, agRes] = await Promise.all([
          axios.get('/api/workspaces').catch(() => null),
          axios.get('/api/agents').catch(() => null),
        ]);
        if (!mountedRef.current) return;
        const list = wsRes?.data?.workspaces || [];
        setWorkspaces(list);
        const stored = localStorage.getItem(ACTIVE_KEY);
        if (stored && list.find(w => w.id === stored)) setActiveWsId(stored);
        else if (list.length > 0) setActiveWsId(list[0].id);
        const installed = (agRes?.data?.agents || []).filter(a => a.installed);
        setAgents(installed);
        if (installed.length > 0) setSelectedAgent(installed[0].id);
      } catch (e) {
        window.UI?.toast?.({ kind: 'err', title: 'Load failed', body: e.message });
      }
    })();
  }, []);

  useEffect(() => {
    if (activeWsId) localStorage.setItem(ACTIVE_KEY, activeWsId);
  }, [activeWsId]);

  // Listen for open-workspace events from FilesTab
  useEffect(() => {
    const handler = (e) => {
      const targetCwd = e.detail?.cwd;
      if (!targetCwd) return;
      const match = workspaces.find(w => w.cwd === targetCwd);
      if (match) {
        setActiveWsId(match.id);
      } else {
        const ok = window.confirm(`Create a new workspace for ${targetCwd}?`);
        if (!ok) return;
        const name = (targetCwd.split('/').filter(Boolean).pop() || 'workspace').slice(0, 64);
        createWorkspace(name, targetCwd);
      }
    };
    window.addEventListener('open-workspace', handler);
    return () => window.removeEventListener('open-workspace', handler);
  }, [workspaces]);

  // Fetch root of file tree when workspace changes
  useEffect(() => {
    if (!cwd) { setTree([]); return; }
    fetchTreeChildren(cwd).then((children) => {
      if (!mountedRef.current) return;
      setTree([{ name: cwd.split('/').filter(Boolean).pop() || '/', path: cwd, isDir: true, children }]);
      setExpanded(new Set([cwd]));
    });
  }, [cwd]);

  const fetchTreeChildren = useCallback(async (dirPath) => {
    try {
      const r = await axios.get('/api/samba/browse', { params: { path: dirPath, showHidden: false } });
      const folders = (r.data.folders || []).map(f => ({ name: f.name, path: f.path, isDir: true, children: null }));
      const files = (r.data.files || []).map(f => ({ name: f.name, path: f.path, isDir: false }));
      return [...folders, ...files];
    } catch { return []; }
  }, []);

  const toggleNode = useCallback(async (node) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
    if (node.isDir && node.children === null) {
      const children = await fetchTreeChildren(node.path);
      setTree(prev => updateNode(prev, node.path, n => ({ ...n, children })));
    }
  }, [fetchTreeChildren]);

  const updateNode = (nodes, target, fn) => nodes.map(n => {
    if (n.path === target) return fn(n);
    if (n.children) return { ...n, children: updateNode(n.children, target, fn) };
    return n;
  });

  // Open a file in the editor
  const openFile = useCallback(async (node) => {
    const existing = openFiles.find(f => f.path === node.path);
    if (existing) { setActiveFileId(existing.id); return; }
    try {
      const r = await axios.get('/api/files/view', { params: { path: node.path } });
      const content = r.data?.content ?? '';
      if (typeof content !== 'string') {
        window.UI?.toast?.({ kind: 'err', title: 'Binary file', body: 'Cannot open in editor' });
        return;
      }
      const id = 'f' + Date.now() + Math.random().toString(36).slice(2, 6);
      const newFile = {
        id, path: node.path, name: node.name, content, original: content,
        language: langOf(node.name),
      };
      setOpenFiles(prev => [...prev, newFile]);
      setActiveFileId(id);
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Open failed', body: e.response?.data?.error || e.message });
    }
  }, [openFiles]);

  // Save the active file
  const saveActiveFile = useCallback(async () => {
    const f = openFiles.find(x => x.id === activeFileId);
    if (!f) return;
    try {
      await axios.post('/api/files/save', { path: f.path, content: f.content });
      setOpenFiles(prev => prev.map(x => x.id === f.id ? { ...x, original: x.content } : x));
      window.UI?.toast?.({ kind: 'ok', title: 'Saved', body: f.name });
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Save failed', body: e.response?.data?.error || e.message });
    }
  }, [openFiles, activeFileId]);

  const closeFile = useCallback((id) => {
    const f = openFiles.find(x => x.id === id);
    if (!f) return;
    if (f.content !== f.original) {
      const ok = window.confirm(`Discard unsaved changes to ${f.name}?`);
      if (!ok) return;
    }
    setOpenFiles(prev => prev.filter(x => x.id !== id));
    if (activeFileId === id) {
      const rest = openFiles.filter(x => x.id !== id);
      setActiveFileId(rest.length ? rest[rest.length - 1].id : null);
    }
  }, [openFiles, activeFileId]);

  // ─── Workspace CRUD
  const createWorkspace = useCallback(async (nameArg, cwdArg) => {
    const name = nameArg || window.prompt('Workspace name:');
    if (!name) return;
    const cwdVal = cwdArg || window.prompt('Project directory (absolute path):');
    if (!cwdVal) return;
    try {
      const r = await axios.post('/api/workspaces', {
        name, cwd: cwdVal,
        agent: selectedAgent || null,
        env: {}, openFiles: [],
      });
      if (!mountedRef.current) return;
      setWorkspaces(prev => [...prev, r.data.workspace]);
      setActiveWsId(r.data.workspace.id);
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Create failed', body: e.response?.data?.error || e.message });
    }
  }, [selectedAgent]);

  const saveWorkspace = useCallback(async () => {
    if (!activeWs) return;
    try {
      const r = await axios.put(`/api/workspaces/${activeWs.id}`, {
        agent: selectedAgent || null,
        openFiles: openFiles.map(f => f.path),
      });
      setWorkspaces(prev => prev.map(w => w.id === activeWs.id ? r.data.workspace : w));
      window.UI?.toast?.({ kind: 'ok', title: 'Workspace saved', body: activeWs.name });
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Save failed', body: e.response?.data?.error || e.message });
    }
  }, [activeWs, selectedAgent, openFiles]);

  const deleteWorkspace = useCallback(async () => {
    if (!activeWs) return;
    const ok = window.confirm(`Delete workspace "${activeWs.name}"?`);
    if (!ok) return;
    try {
      await axios.delete(`/api/workspaces/${activeWs.id}`);
      setWorkspaces(prev => prev.filter(w => w.id !== activeWs.id));
      setActiveWsId('');
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Delete failed', body: e.response?.data?.error || e.message });
    }
  }, [activeWs]);

  // ─── Terminals
  const openTerminal = useCallback((agentId) => {
    if (!cwd) {
      window.UI?.toast?.({ kind: 'err', title: 'No workspace', body: 'Pick or create a workspace first.' });
      return;
    }
    const id = 't' + (++termSeq.current);
    const title = agentId ? agents.find(a => a.id === agentId)?.label || agentId : 'shell';
    setTerminals(prev => [...prev, { id, agent: agentId || null, title }]);
    setActiveTermId(id);
  }, [cwd, agents]);

  const closeTerminal = useCallback((id) => {
    setTerminals(prev => prev.filter(t => t.id !== id));
    setActiveTermId(prev => {
      if (prev !== id) return prev;
      const rest = terminals.filter(t => t.id !== id);
      return rest.length ? rest[rest.length - 1].id : null;
    });
  }, [terminals]);

  // Auto-open shell tab when cwd is first set
  useEffect(() => {
    if (cwd && terminals.length === 0) openTerminal(null);
  }, [cwd, terminals.length, openTerminal]);

  // ─── Resizing splitters
  useEffect(() => {
    if (!resizing) return;
    const move = (e) => {
      if (resizing === 'left') {
        const w = Math.min(500, Math.max(180, e.clientX));
        setLeftWidth(w);
      } else if (resizing === 'bottom') {
        const h = Math.min(window.innerHeight * 0.7, Math.max(120, window.innerHeight - e.clientY));
        setBottomHeight(h);
      }
    };
    const up = () => setResizing(null);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [resizing]);

  // ─── Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target;
      const inTerm = target?.closest && target.closest('.ide-term-pane');
      if (mod && e.key === 's' && !inTerm) {
        e.preventDefault(); saveActiveFile();
      } else if (mod && e.key === 'w' && !inTerm && activeFileId) {
        e.preventDefault(); closeFile(activeFileId);
      } else if (mod && e.key === '`') {
        e.preventDefault();
        if (terminals.length === 0) openTerminal(null);
        else document.querySelector('.ide-term-pane[style*="block"]')?.focus();
      } else if (mod && e.key === 'p' && !inTerm) {
        e.preventDefault();
        document.querySelector('.ide-tree-filter input')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveActiveFile, closeFile, activeFileId, terminals.length, openTerminal]);

  // ─── Tree context menu actions
  const onTreeContext = (e, node) => {
    setCtxMenu({ x: e.clientX, y: e.clientY, node });
  };
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [ctxMenu]);

  const newFile = async (parentDir) => {
    const name = window.prompt('New file name:');
    if (!name || name.includes('/')) return;
    const fullPath = parentDir.replace(/\/$/, '') + '/' + name;
    try {
      await axios.post('/api/files/save', { path: fullPath, content: '' });
      const children = await fetchTreeChildren(parentDir);
      setTree(prev => updateNode(prev, parentDir, n => ({ ...n, children })));
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Create failed', body: e.response?.data?.error || e.message });
    }
  };
  const newFolder = async (parentDir) => {
    const name = window.prompt('New folder name:');
    if (!name || name.includes('/')) return;
    const fullPath = parentDir.replace(/\/$/, '') + '/' + name;
    try {
      await axios.post('/api/files/mkdir', { path: fullPath });
      const children = await fetchTreeChildren(parentDir);
      setTree(prev => updateNode(prev, parentDir, n => ({ ...n, children })));
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Create failed', body: e.response?.data?.error || e.message });
    }
  };
  const renameNode = async (node) => {
    const newName = window.prompt('New name:', node.name);
    if (!newName || newName === node.name || newName.includes('/')) return;
    const parent = node.path.substring(0, node.path.lastIndexOf('/'));
    const dest = (parent || '') + '/' + newName;
    try {
      await axios.post('/api/files/move', { from: node.path, to: dest });
      const parentDir = parent || cwd;
      const children = await fetchTreeChildren(parentDir);
      setTree(prev => updateNode(prev, parentDir, n => ({ ...n, children })));
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Rename failed', body: e.response?.data?.error || e.message });
    }
  };
  const deleteNode = async (node) => {
    const ok = window.confirm(`Move ${node.name} to trash?`);
    if (!ok) return;
    try {
      await axios.post('/api/files/trash', { path: node.path });
      const parent = node.path.substring(0, node.path.lastIndexOf('/')) || cwd;
      const children = await fetchTreeChildren(parent);
      setTree(prev => updateNode(prev, parent, n => ({ ...n, children })));
      setOpenFiles(prev => prev.filter(f => f.path !== node.path));
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Delete failed', body: e.response?.data?.error || e.message });
    }
  };

  const activeFile = openFiles.find(f => f.id === activeFileId);
  const envCsv = ENV_PASSTHROUGH_DEFAULT.join(',');

  // ─── Render
  return (
    <div className="ide-root" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px)', overflow: 'hidden' }}>
      <style>{`
        .ide-root .ide-header { display: flex; gap: 8px; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--line); background: var(--surface-1); }
        .ide-root .ide-header select, .ide-root .ide-header input { background: var(--surface-2); border: 1px solid var(--line); color: var(--text-1); padding: 4px 8px; border-radius: 4px; font-size: 12px; }
        .ide-root .ide-main { flex: 1; display: flex; min-height: 0; }
        .ide-root .ide-left { background: var(--surface-1); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
        .ide-root .ide-tree-filter { padding: 6px; border-bottom: 1px solid var(--line); }
        .ide-root .ide-tree-filter input { width: 100%; }
        .ide-root .ide-tree { flex: 1; overflow: auto; font-size: 12px; }
        .ide-root .tree-row { display: flex; align-items: center; gap: 4px; padding: 2px 6px; cursor: pointer; user-select: none; white-space: nowrap; }
        .ide-root .tree-row:hover { background: var(--surface-2); }
        .ide-root .tree-icon { width: 12px; display: inline-block; color: var(--text-3); }
        .ide-root .tree-name { overflow: hidden; text-overflow: ellipsis; }
        .ide-root .ide-center { flex: 1; display: flex; flex-direction: column; min-width: 0; }
        .ide-root .ide-tabs { display: flex; align-items: center; background: var(--surface-1); border-bottom: 1px solid var(--line); overflow-x: auto; min-height: 30px; }
        .ide-root .ide-tab { display: flex; align-items: center; gap: 4px; padding: 4px 10px; border-right: 1px solid var(--line); cursor: pointer; font-size: 12px; user-select: none; white-space: nowrap; max-width: 240px; }
        .ide-root .ide-tab.is-active { background: var(--surface-2); color: var(--text-1); }
        .ide-root .ide-tab-title { overflow: hidden; text-overflow: ellipsis; }
        .ide-root .ide-tab-dirty { color: var(--accent); font-size: 14px; }
        .ide-root .ide-tab-close { background: none; border: 0; color: var(--text-3); cursor: pointer; padding: 0 4px; font-size: 14px; }
        .ide-root .ide-tab-close:hover { color: var(--text-1); }
        .ide-root .ide-editor { flex: 1; min-height: 0; min-width: 0; }
        .ide-root .ide-splitter-v { width: 4px; cursor: col-resize; background: var(--line); }
        .ide-root .ide-splitter-h { height: 4px; cursor: row-resize; background: var(--line); }
        .ide-root .ide-bottom { background: var(--surface-1); border-top: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
        .ide-root .ide-term-toolbar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--surface-2); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
        .ide-root .ide-term-toolbar .agent-pill { padding: 2px 8px; border: 1px solid var(--line); border-radius: 3px; font-size: 11px; cursor: pointer; background: var(--surface-1); }
        .ide-root .ide-term-toolbar .agent-pill:hover { background: var(--surface-2); border-color: var(--accent); }
        .ide-root .ide-term-area { flex: 1; min-height: 0; position: relative; }
        .ide-root .ide-ctx { position: fixed; background: var(--surface-1); border: 1px solid var(--line); border-radius: 4px; padding: 4px 0; z-index: 1000; min-width: 160px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
        .ide-root .ide-ctx button { display: block; width: 100%; background: none; border: 0; color: var(--text-1); padding: 5px 12px; text-align: left; cursor: pointer; font-size: 12px; }
        .ide-root .ide-ctx button:hover { background: var(--surface-2); }
        .ide-root .ide-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-3); font-size: 13px; padding: 24px; text-align: center; }
      `}</style>

      <div className="ide-header">
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Workspace:</span>
        <select value={activeWsId} onChange={(e) => setActiveWsId(e.target.value)}>
          <option value="">— pick —</option>
          {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <button className="btn-ghost" onClick={() => createWorkspace()}>+ New</button>
        <button className="btn-ghost" disabled={!activeWs} onClick={saveWorkspace}>Save</button>
        <button className="btn-ghost" disabled={!activeWs} onClick={deleteWorkspace} style={{ color: 'var(--err)' }}>Delete</button>
        {activeWs && (
          <span className="mono muted" style={{ fontSize: 11, marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cwd}>
            {cwd}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Agent:</span>
        <select value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)}>
          <option value="">(shell)</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.label}{a.version ? ` · ${a.version}` : ''}</option>)}
        </select>
        <button className="btn-accent" disabled={!cwd} onClick={() => openTerminal(selectedAgent || null)}>▶ Run</button>
      </div>

      <div className="ide-main">
        <div className="ide-left" style={{ width: leftWidth }}>
          <div className="ide-tree-filter">
            <input value={treeFilter} onChange={(e) => setTreeFilter(e.target.value)} placeholder="Filter files…" />
          </div>
          <div className="ide-tree">
            {!cwd && <div className="ide-empty">Pick or create a workspace to begin.</div>}
            {tree.map(n => (
              <TreeNode
                key={n.path}
                node={n}
                depth={0}
                expanded={expanded}
                onToggle={toggleNode}
                onOpenFile={openFile}
                onContext={onTreeContext}
                filter={treeFilter}
              />
            ))}
          </div>
        </div>

        <div className="ide-splitter-v" onMouseDown={() => setResizing('left')} />

        <div className="ide-center" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <TabStrip
              tabs={openFiles}
              activeId={activeFileId}
              onSelect={setActiveFileId}
              onClose={closeFile}
              getTitle={(t) => t.name}
              getDirty={(t) => t.content !== t.original}
            />
            <div className="ide-editor">
              {!activeFile && <div className="ide-empty">No file open. Click a file in the tree.</div>}
              {activeFile && (
                <Editor
                  height="100%"
                  theme="vs-dark"
                  language={activeFile.language}
                  value={activeFile.content}
                  onChange={(v) => setOpenFiles(prev => prev.map(f => f.id === activeFile.id ? { ...f, content: v ?? '' } : f))}
                  options={{
                    automaticLayout: true,
                    minimap: { enabled: true },
                    fontSize: 13,
                    tabSize: 2,
                    wordWrap: 'on',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  }}
                />
              )}
            </div>
          </div>

          <div className="ide-splitter-h" onMouseDown={() => setResizing('bottom')} />

          <div className="ide-bottom" style={{ height: bottomHeight }}>
            <div className="ide-term-toolbar">
              <TabStrip
                tabs={terminals}
                activeId={activeTermId}
                onSelect={setActiveTermId}
                onClose={closeTerminal}
                getTitle={(t) => t.title}
              />
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Quick:</span>
              <button className="agent-pill" disabled={!cwd} onClick={() => openTerminal(null)}>shell</button>
              {agents.map(a => (
                <button key={a.id} className="agent-pill" disabled={!cwd} onClick={() => openTerminal(a.id)} title={a.cmd}>
                  {a.label}{a.version ? ` ${a.version}` : ''}
                </button>
              ))}
            </div>
            <div className="ide-term-area">
              {terminals.length === 0 && <div className="ide-empty">No terminal open. Pick an agent above.</div>}
              {terminals.map(t => (
                <div key={t.id} style={{ position: 'absolute', inset: 0 }}>
                  <TerminalPane
                    id={t.id}
                    cwd={cwd}
                    agent={t.agent}
                    envCsv={envCsv}
                    active={activeTermId === t.id}
                    onClose={closeTerminal}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {ctxMenu && (
        <div className="ide-ctx" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          {ctxMenu.node.isDir && <button onClick={() => { newFile(ctxMenu.node.path); setCtxMenu(null); }}>New file</button>}
          {ctxMenu.node.isDir && <button onClick={() => { newFolder(ctxMenu.node.path); setCtxMenu(null); }}>New folder</button>}
          <button onClick={() => { renameNode(ctxMenu.node); setCtxMenu(null); }}>Rename</button>
          <button onClick={() => { deleteNode(ctxMenu.node); setCtxMenu(null); }} style={{ color: 'var(--err)' }}>Delete</button>
        </div>
      )}
    </div>
  );
}

export { CodeWorkspaceTab };
