import './code-workspace.css';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import axios from 'axios';
import { TerminalPane, FolderBrowserModal } from './code-workspace.jsx';
import { AgentJobsPanel } from './agent-jobs.jsx';
import { CLIUsageTab } from './cli-usage.jsx';

const ACTIVE_KEY  = 'code_workspace_active_id';
const ENV_CSV     = [
  'ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY',
  'OPENROUTER_API_KEY','GROQ_API_KEY','XAI_API_KEY','DEEPSEEK_API_KEY',
  'OLLAMA_HOST','GH_TOKEN','GITHUB_TOKEN','EDITOR','PATH','HOME','USER',
].join(',');

const AGENT_GLYPHS = {
  claude: '💬', 'claude-code': '💬', gemini: '✦', antigravity: '🚀',
  codex: '⬡', opencode: '🔏', kilocode: '⚡', kilo: '⚡',
  ollama: '🦙', shell: '›_', aider: '🤖',
};

// ─── Hub root ─────────────────────────────────────────────────────────────────
export function CodeHubTab({ isVisible = true }) {
  const [sub, setSub]         = useState('terminal');

  // ── Shared state (workspaces + agents live here, passed to both sub-tabs) ──
  const [workspaces, setWorkspaces]         = useState([]);
  const [agents, setAgents]                 = useState([]);
  const [activeWsId, setActiveWsIdRaw]      = useState(() => localStorage.getItem(ACTIVE_KEY) || '');
  const [selectedAgentId, setSelectedAgentId] = useState('shell');
  const [runningCount, setRunningCount]     = useState(0);

  const setActiveWsId = useCallback((id) => {
    setActiveWsIdRaw(id);
    localStorage.setItem(ACTIVE_KEY, id || '');
  }, []);

  // ── Terminal state ─────────────────────────────────────────────────────────
  const [terminals, setTerminals]   = useState([]);
  const [activeTermId, setActiveTermId] = useState(null);
  const termSeq   = useRef(0);
  const termFits  = useRef({});

  // ── Cross-tab state ────────────────────────────────────────────────────────
  const [jobPreset, setJobPreset]   = useState(null); // { workspaceId, agentId }

  // ── Popover / UI state ─────────────────────────────────────────────────────
  const [showWsPop, setShowWsPop]     = useState(false);
  const [showAgPop, setShowAgPop]     = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [renameId, setRenameId]       = useState(null);
  const [renameVal, setRenameVal]     = useState('');
  const renameRef   = useRef(null);
  const wsPopRef    = useRef(null);
  const agPopRef    = useRef(null);
  const mountedRef  = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const activeWs     = useMemo(() => workspaces.find(w => w.id === activeWsId) || null, [workspaces, activeWsId]);
  const cwd          = activeWs?.cwd || '';
  const selectedAgent = useMemo(() => agents.find(a => a.id === selectedAgentId), [agents, selectedAgentId]);

  // Focus rename input when it appears
  useEffect(() => { if (renameId && renameRef.current) { renameRef.current.focus(); renameRef.current.select(); } }, [renameId]);

  // Close popovers on outside click
  useEffect(() => {
    if (!showWsPop && !showAgPop) return;
    const h = (e) => {
      if (showWsPop && wsPopRef.current && !wsPopRef.current.contains(e.target)) setShowWsPop(false);
      if (showAgPop && agPopRef.current && !agPopRef.current.contains(e.target)) setShowAgPop(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showWsPop, showAgPop]);

  // Re-fit terminals when tab / sub-tab becomes visible
  useEffect(() => {
    if (isVisible && sub === 'terminal') {
      setTimeout(() => Object.values(termFits.current).forEach(fn => { try { fn(); } catch {} }), 50);
    }
  }, [isVisible, sub]);

  // ── Data loading ───────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    const [wsRes, agRes] = await Promise.all([
      axios.get('/api/workspaces').catch(() => null),
      axios.get('/api/agents').catch(() => null),
    ]);
    if (!mountedRef.current) return;

    const wsList = wsRes?.data?.workspaces || [];
    setWorkspaces(wsList);
    const stored = localStorage.getItem(ACTIVE_KEY);
    const initId = stored && wsList.find(w => w.id === stored) ? stored : wsList[0]?.id || '';
    setActiveWsIdRaw(initId);

    const rawAgents = agRes?.data?.agents || [];
    const agentList = [
      { id: 'shell', label: 'Shell', cmd: 'shell', vendor: 'System', version: '' },
      ...rawAgents,
    ];
    setAgents(agentList);
    if (rawAgents.length > 0) setSelectedAgentId(rawAgents[0].id);
    else setSelectedAgentId('shell');
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Terminal management ────────────────────────────────────────────────────
  const launchSession = useCallback((agentId, customCwd) => {
    const targetCwd = customCwd || cwd;
    if (!targetCwd) {
      window.UI?.toast?.({ kind: 'err', title: 'No workspace', body: 'Select a workspace first.' });
      return;
    }
    const id  = 't' + (++termSeq.current);
    const ag  = agents.find(a => a.id === agentId);
    setTerminals(prev => [...prev, { id, agent: agentId === 'shell' ? null : agentId, title: ag?.label || 'Shell', cwd: targetCwd }]);
    setActiveTermId(id);
  }, [cwd, agents]);

  const closeTerminal = useCallback((id) => {
    setTerminals(prev => {
      const rest = prev.filter(t => t.id !== id);
      setActiveTermId(cur => cur === id ? (rest.length ? rest[rest.length - 1].id : null) : cur);
      return rest;
    });
  }, []);

  // ── Workspace CRUD ─────────────────────────────────────────────────────────
  const addWorkspace = async (folderPath, name) => {
    setShowBrowser(false);
    try {
      const r = await axios.post('/api/workspaces', { name, cwd: folderPath });
      if (!mountedRef.current) return;
      setWorkspaces(prev => [...prev, r.data.workspace]);
      setActiveWsId(r.data.workspace.id);
      window.UI?.toast?.({ kind: 'ok', title: 'Workspace added', body: name });
    } catch (e) {
      window.UI?.toast?.({ kind: 'err', title: 'Failed', body: e.response?.data?.error || e.message });
    }
  };

  const deleteWorkspace = async (id, name, e) => {
    e?.stopPropagation();
    const ok = await window.UI.confirm({ title: 'Remove Workspace', body: `Remove "${name}"? Files are unaffected.`, confirmLabel: 'Remove', dangerous: true });
    if (!ok) return;
    try {
      await axios.delete(`/api/workspaces/${id}`);
      if (!mountedRef.current) return;
      setWorkspaces(prev => prev.filter(w => w.id !== id));
      if (activeWsId === id) setActiveWsId('');
    } catch (e) { window.UI?.toast?.({ kind: 'err', title: 'Failed', body: e.message }); }
  };

  const startRename = (e, w) => { e.stopPropagation(); setRenameId(w.id); setRenameVal(w.name); };
  const commitRename = async () => {
    const id = renameId, name = renameVal.trim();
    if (!id) return;
    setRenameId(null);
    const orig = workspaces.find(w => w.id === id);
    if (!name || !orig || name === orig.name) return;
    try {
      const r = await axios.put(`/api/workspaces/${id}`, { name });
      if (!mountedRef.current) return;
      setWorkspaces(prev => prev.map(w => w.id === id ? r.data.workspace : w));
    } catch {}
  };

  // ── Cross-tab actions ──────────────────────────────────────────────────────
  const scheduleJob = () => {
    setJobPreset({ workspaceId: activeWsId, agentId: selectedAgentId });
    setSub('jobs');
  };

  const openTerminalForJob = useCallback((job) => {
    const ws = workspaces.find(w => w.id === job.workspaceId);
    if (job.workspaceId) setActiveWsId(job.workspaceId);
    if (job.agentId) setSelectedAgentId(job.agentId);
    setSub('terminal');
    // Auto-launch a session after state updates (next tick)
    const tid = 't' + (++termSeq.current);
    const ag = agents.find(a => a.id === job.agentId) || { label: 'Shell' };
    setTerminals(prev => [...prev, { id: tid, agent: job.agentId === 'shell' ? null : job.agentId, title: ag.label, cwd: ws?.cwd || cwd }]);
    setActiveTermId(tid);
  }, [workspaces, agents, cwd, setActiveWsId]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="hub-root">

      {/* Sub-tab nav */}
      <div className="hub-nav">
        <button className={`hub-tab ${sub === 'terminal' ? 'is-active' : ''}`} onClick={() => setSub('terminal')}>
          <span style={{ opacity: 0.7 }}>⌘</span> Terminal
        </button>
        <button className={`hub-tab ${sub === 'jobs' ? 'is-active' : ''}`} onClick={() => setSub('jobs')}>
          <span style={{ opacity: 0.7 }}>◫</span> Jobs
          {runningCount > 0 && <span className="hub-running-badge">{runningCount}</span>}
        </button>
        <button className={`hub-tab ${sub === 'usage' ? 'is-active' : ''}`} onClick={() => setSub('usage')}>
          <span style={{ opacity: 0.7 }}>⚡</span> Usage
        </button>

        {/* Workspace + Agent context always visible in nav */}
        <div style={{ flex: 1 }} />
        {activeWs && (
          <span style={{ fontSize: 11, color: 'var(--text-3)', alignSelf: 'center', paddingRight: 8, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            📁 {activeWs.name}
            {selectedAgent && selectedAgent.id !== 'shell' && (
              <span style={{ marginLeft: 8 }}>{AGENT_GLYPHS[selectedAgent.id] || '✦'} {selectedAgent.label}</span>
            )}
          </span>
        )}
      </div>

      {/* ── Terminal section — always mounted ─────────────────────────────── */}
      <div className="hub-terminal-section" style={{ display: sub === 'terminal' ? 'flex' : 'none' }}>
        <div className="ws-main">
          {terminals.length > 0 && (
            <div className="term-tabs">
              {terminals.map(t => {
                const isActive = activeTermId === t.id;
                const glyph = t.agent ? (AGENT_GLYPHS[t.agent] || '✦') : '›_';
                return (
                  <button key={t.id} className={`term-tab ${isActive ? 'is-active' : ''}`} onClick={() => setActiveTermId(t.id)}>
                    <span>{glyph}</span>
                    <span>{t.title}</span>
                    <button className="term-tab-x" onClick={(e) => { e.stopPropagation(); closeTerminal(t.id); }}>×</button>
                  </button>
                );
              })}
              <div style={{ flex: 1 }} />
              <button className="btn-ghost sm" style={{ marginRight: 10, alignSelf: 'center' }} onClick={() => launchSession('shell')}>
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
                  Pick a workspace and agent below, then Launch — or click an agent to quick-start.
                </div>
                <div className="qs-grid">
                  {agents.map(a => (
                    <button key={a.id} className="qs-btn" disabled={!cwd} onClick={() => launchSession(a.id)}>
                      <span>{AGENT_GLYPHS[a.id] || '✦'}</span>{a.label}
                    </button>
                  ))}
                </div>
                {!cwd && (
                  <div style={{ marginTop: 16, color: '#f87171', fontSize: 12 }}>
                    ⚠ Select a workspace from the toolbar below
                  </div>
                )}
              </div>
            ) : (
              terminals.map(t => (
                <div key={t.id} style={{ position: 'absolute', inset: 0 }}>
                  <TerminalPane
                    id={t.id}
                    cwd={t.cwd || cwd}
                    agent={t.agent}
                    envCsv={ENV_CSV}
                    active={activeTermId === t.id}
                    onTitle={() => {}}
                    onRegisterFit={(tid, fn) => {
                      if (fn) termFits.current[tid] = fn;
                      else delete termFits.current[tid];
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
          <div className="ws-tb-section" ref={wsPopRef}>
            <button className={`ws-tb-btn${showWsPop ? ' is-open' : ''}`}
              onClick={() => { setShowWsPop(p => !p); setShowAgPop(false); }}>
              <span className="ws-tb-icon">📁</span>
              <span className="ws-tb-label">{activeWs?.name || 'Select Workspace'}</span>
              <span className="ws-tb-caret">▾</span>
            </button>
            {showWsPop && (
              <div className="ws-popover">
                <div className="ws-popover-header">Workspaces</div>
                <div className="ws-popover-body">
                  {workspaces.length === 0 && <div className="ws-no-workspaces">No workspaces yet</div>}
                  {workspaces.map(w => (
                    <div key={w.id}
                      className={`ws-item${w.id === activeWsId ? ' is-active' : ''}`}
                      onClick={() => { if (renameId !== w.id) { setActiveWsId(w.id); setShowWsPop(false); } }}
                      onDoubleClick={(e) => startRename(e, w)}
                    >
                      <span className="ws-item-icon">📁</span>
                      <div className="ws-item-info">
                        {renameId === w.id ? (
                          <input ref={renameRef} className="ws-item-rename" value={renameVal}
                            onChange={e => setRenameVal(e.target.value)}
                            onBlur={commitRename} onClick={e => e.stopPropagation()}
                            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenameId(null); }} />
                        ) : <span className="ws-item-name">{w.name}</span>}
                        <span className="ws-item-path">{w.cwd}</span>
                      </div>
                      {renameId !== w.id && (
                        <>
                          <button className="ws-item-edit" onClick={(e) => startRename(e, w)} title="Rename">✎</button>
                          <button className="ws-item-del" onClick={(e) => deleteWorkspace(w.id, w.name, e)} title="Remove">×</button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                <div className="ws-popover-footer">
                  <button className="ws-add-btn" onClick={() => { setShowBrowser(true); setShowWsPop(false); }}>
                    + Add Workspace
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="ws-tb-divider" />

          {/* Agent picker */}
          <div className="ws-tb-section" ref={agPopRef}>
            <button className={`ws-tb-btn${showAgPop ? ' is-open' : ''}`}
              onClick={() => { setShowAgPop(p => !p); setShowWsPop(false); }}>
              <span className="ws-tb-icon">{AGENT_GLYPHS[selectedAgentId] || '✦'}</span>
              <span className="ws-tb-label">{selectedAgent?.label || 'Select Agent'}</span>
              <span className="ws-tb-caret">▾</span>
            </button>
            {showAgPop && (
              <div className="ws-popover">
                <div className="ws-popover-header">Coding Agent</div>
                <div className="ws-popover-body">
                  {agents.map(a => (
                    <div key={a.id} className={`agent-card${selectedAgentId === a.id ? ' is-selected' : ''}`}
                      onClick={() => { setSelectedAgentId(a.id); setShowAgPop(false); }}>
                      <div className="agent-glyph">{AGENT_GLYPHS[a.id] || '✦'}</div>
                      <div className="agent-info">
                        <div className="agent-name">
                          <span>{a.label}</span>
                          {a.version && <span className="agent-ver">v{a.version}</span>}
                        </div>
                        <div className="agent-sub">{a.cmd === 'shell' ? 'bash' : (a.cmd || a.id)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div style={{ flex: 1 }} />

          {/* Schedule as job — cross-tab shortcut */}
          <button
            className="ws-tb-btn hub-schedule-btn"
            disabled={!activeWsId}
            onClick={scheduleJob}
            title="Create a scheduled job with this workspace + agent"
          >
            <span style={{ opacity: 0.8 }}>◫</span>
            <span>Schedule Job</span>
          </button>

          <div className="ws-tb-divider" />

          {/* Launch */}
          <button className="ws-launch-btn" disabled={!cwd}
            onClick={() => { launchSession(selectedAgentId); setShowWsPop(false); setShowAgPop(false); }}>
            <span>▶</span>
            {selectedAgent ? `Launch ${selectedAgent.label}` : 'Launch Session'}
          </button>
        </div>

        {showBrowser && (
          <FolderBrowserModal
            initialPath={cwd ? cwd.split('/').slice(0, -1).join('/') || '/' : '/home'}
            onConfirm={addWorkspace}
            onClose={() => setShowBrowser(false)}
          />
        )}
      </div>

      {/* ── Jobs section ──────────────────────────────────────────────────── */}
      {sub === 'jobs' && (
        <div className="hub-jobs-section">
          <AgentJobsPanel
            workspaces={workspaces}
            agents={agents}
            activeWsId={activeWsId}
            onWorkspacesChange={setWorkspaces}
            preset={jobPreset}
            onClearPreset={() => setJobPreset(null)}
            onOpenTerminal={openTerminalForJob}
            onRunningCountChange={setRunningCount}
          />
        </div>
      )}

      {/* ── Usage section ─────────────────────────────────────────────────── */}
      {sub === 'usage' && (
        <div className="hub-usage-section">
          <CLIUsageTab />
        </div>
      )}
    </div>
  );
}
