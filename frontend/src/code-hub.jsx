import './code-workspace.css';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import axios from 'axios';
import { TerminalPane, FolderBrowserModal } from './code-workspace.jsx';
import { AgentJobsPanel } from './agent-jobs.jsx';
import { CLIUsageTab } from './cli-usage.jsx';

const ACTIVE_KEY    = 'code_workspace_active_id';
const SESSIONS_KEY  = 'code_workspace_sessions';
const HISTORY_KEY   = 'code_workspace_history';
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

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function lsRead(key, fallback = []) {
  try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : fallback; }
  catch { return fallback; }
}
function lsWrite(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

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
  // Sessions are NOT auto-restored on load — they're surfaced as offers in the
  // empty-state UI so the user can consciously reconnect each one.
  const [terminals, setTerminals]       = useState([]);
  const [activeTermId, setActiveTermId] = useState(null);
  // Sessions from the previous browser visit, offered for reconnection
  const [savedSessions, setSavedSessions] = useState(() => lsRead(SESSIONS_KEY));
  // Closed-session history (last 10); only coding agents, not plain shell
  const [sessionHistory, setSessionHistory] = useState(() => lsRead(HISTORY_KEY));
  const termSeq = useRef((() => {
    const all = [...lsRead(SESSIONS_KEY), ...lsRead(HISTORY_KEY)];
    return all.reduce((m, t) => {
      const n = parseInt((t.id || '').replace('t', ''), 10);
      return isNaN(n) ? m : Math.max(m, n);
    }, 0);
  })());
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

  // Re-fit terminals when tab / sub-tab becomes visible.
  // Use two passes: rAF to let display:block paint, then a 100ms follow-up
  // to catch any further layout settling (sidebar collapse, etc.).
  useEffect(() => {
    if (!(isVisible && sub === 'terminal')) return;
    const raf = requestAnimationFrame(() => {
      Object.values(termFits.current).forEach(fn => { try { fn(); } catch {} });
      const t2 = setTimeout(() => {
        Object.values(termFits.current).forEach(fn => { try { fn(); } catch {} });
      }, 100);
      return () => clearTimeout(t2);
    });
    return () => cancelAnimationFrame(raf);
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
  const persistSessions = useCallback((list) => {
    lsWrite(SESSIONS_KEY, list);
  }, []);

  const launchSession = useCallback((agentId, customCwd) => {
    const targetCwd = customCwd || cwd;
    if (!targetCwd) {
      window.UI?.toast?.({ kind: 'err', title: 'No workspace', body: 'Select a workspace first.' });
      return;
    }
    const id  = 't' + (++termSeq.current);
    const ag  = agents.find(a => a.id === agentId);
    const entry = {
      id, agent: agentId === 'shell' ? null : agentId,
      title: ag?.label || 'Shell', cwd: targetCwd,
      workspaceId: activeWsId, sessionId: null,
    };
    setTerminals(prev => { const n = [...prev, entry]; persistSessions(n); return n; });
    setActiveTermId(id);
  }, [cwd, agents, activeWsId, persistSessions]);

  // Reconnect a savedSession (from previous browser visit) as a new tab
  const reconnectSession = useCallback((sess) => {
    const id = 't' + (++termSeq.current);
    const entry = { ...sess, id };
    setTerminals(prev => { const n = [...prev, entry]; persistSessions(n); return n; });
    setActiveTermId(id);
    setSavedSessions(prev => {
      const n = prev.filter(s => s.sessionId !== sess.sessionId);
      lsWrite(SESSIONS_KEY, n);
      return n;
    });
  }, [persistSessions]);

  // Resume from history — starts a fresh terminal in the same workspace + agent.
  // Claude Code / other agents will handle their own conversation-level resume.
  const resumeFromHistory = useCallback((hist) => {
    if (hist.workspaceId) setActiveWsId(hist.workspaceId);
    const agentId  = hist.agent || 'shell';
    const targetCwd = hist.cwd || cwd;
    if (!targetCwd) { window.UI?.toast?.({ kind: 'err', title: 'No workspace', body: 'Workspace no longer exists.' }); return; }
    const id = 't' + (++termSeq.current);
    const ag = agents.find(a => a.id === agentId);
    const entry = {
      id, agent: agentId === 'shell' ? null : agentId,
      title: ag?.label || hist.title || 'Shell',
      cwd: targetCwd, workspaceId: hist.workspaceId, sessionId: null,
    };
    setTerminals(prev => { const n = [...prev, entry]; persistSessions(n); return n; });
    setActiveTermId(id);
    setSub('terminal');
  }, [cwd, agents, setActiveWsId, persistSessions]);

  const closeTerminal = useCallback((id) => {
    setTerminals(prev => {
      const t = prev.find(x => x.id === id);
      if (t?.sessionId) {
        fetch(`/api/terminal-sessions/${t.sessionId}`, { method: 'DELETE' }).catch(() => {});
      }
      // Add coding-agent sessions to history so user can resume later
      if (t && t.agent) {
        setSessionHistory(prevHist => {
          const entry = { ...t, closedAt: Date.now() };
          const next = [entry, ...prevHist.filter(h => h.sessionId !== t.sessionId)].slice(0, 10);
          lsWrite(HISTORY_KEY, next);
          return next;
        });
      }
      const rest = prev.filter(x => x.id !== id);
      setActiveTermId(cur => cur === id ? (rest.length ? rest[rest.length - 1].id : null) : cur);
      persistSessions(rest);
      return rest;
    });
  }, [persistSessions]);

  const handleSessionId = useCallback((termId, sid) => {
    setTerminals(prev => {
      const next = prev.map(t => t.id === termId ? { ...t, sessionId: sid } : t);
      persistSessions(next);
      return next;
    });
  }, [persistSessions]);

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
    const tid = 't' + (++termSeq.current);
    const ag = agents.find(a => a.id === job.agentId) || { label: 'Shell' };
    const entry = { id: tid, agent: job.agentId === 'shell' ? null : job.agentId, title: ag.label, cwd: ws?.cwd || cwd, workspaceId: job.workspaceId, sessionId: null };
    setTerminals(prev => { const n = [...prev, entry]; persistSessions(n); return n; });
    setActiveTermId(tid);
  }, [workspaces, agents, cwd, setActiveWsId, persistSessions]);

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

                {/* ── Restore previous-visit sessions ───────────────────── */}
                {savedSessions.length > 0 && (
                  <div className="sess-recover-block">
                    <div className="sess-recover-header">
                      <span>Previous Sessions</span>
                      {savedSessions.length > 1 && (
                        <button className="sess-recover-all" onClick={() => {
                          savedSessions.forEach(s => reconnectSession(s));
                        }}>Restore All</button>
                      )}
                    </div>
                    {savedSessions.map(s => (
                      <div key={s.sessionId || s.id} className="sess-recover-row">
                        <span className="sess-recover-glyph">{s.agent ? (AGENT_GLYPHS[s.agent] || '✦') : '›_'}</span>
                        <div className="sess-recover-info">
                          <span className="sess-recover-title">{s.title || s.agent || 'Shell'}</span>
                          <span className="sess-recover-cwd">{s.cwd}</span>
                        </div>
                        <button className="sess-recover-btn" onClick={() => reconnectSession(s)}>↺ Reconnect</button>
                        <button className="sess-recover-dismiss" title="Dismiss" onClick={() => {
                          setSavedSessions(prev => { const n = prev.filter(x => x.sessionId !== s.sessionId); lsWrite(SESSIONS_KEY, n); return n; });
                        }}>×</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Last 3 closed coding-agent sessions ───────────────── */}
                {sessionHistory.filter(h => h.agent).slice(0, 3).length > 0 && (
                  <div className="sess-history-block">
                    <div className="sess-history-header">Recent Sessions</div>
                    {sessionHistory.filter(h => h.agent).slice(0, 3).map(h => (
                      <div key={(h.sessionId || h.id) + h.closedAt} className="sess-recover-row">
                        <span className="sess-recover-glyph">{AGENT_GLYPHS[h.agent] || '✦'}</span>
                        <div className="sess-recover-info">
                          <span className="sess-recover-title">{h.title || h.agent}</span>
                          <span className="sess-recover-cwd">{h.cwd}</span>
                        </div>
                        <span className="sess-history-age">{timeAgo(h.closedAt)}</span>
                        <button className="sess-recover-btn" onClick={() => resumeFromHistory(h)}>▶ Resume</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Quick-start new session ────────────────────────────── */}
                <div className="empty-body" style={{ marginTop: savedSessions.length || sessionHistory.filter(h=>h.agent).length ? 20 : 0 }}>
                  {savedSessions.length === 0 && sessionHistory.filter(h=>h.agent).length === 0
                    ? 'Pick a workspace and agent below, then Launch — or click an agent to quick-start.'
                    : 'Or start a new session:'}
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
                    sessionId={t.sessionId}
                    onSessionId={handleSessionId}
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
