import React, { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { Terminal as XTermTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { TerminalKeyBar } from './term-keybar.jsx';

const SessionsCtx = createContext(null);

function SessionsProvider({ children }) {
  const [sessions, setSessions] = useState([]); // {id, type, title, subtitle, started, status, data}
  const [activeId, setActiveId] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const seq = useRef(0);

  const launch = useCallback((opts) => {
    const id = 's' + (++seq.current);
    const baseData = opts.data || null;
    const mergedData = (opts.cwd != null || opts.env != null || opts.agent != null)
      ? { ...(baseData || {}),
          ...(opts.cwd != null ? { cwd: opts.cwd } : {}),
          ...(opts.env != null ? { env: opts.env } : {}),
          ...(opts.agent != null ? { agent: opts.agent } : {}) }
      : baseData;
    const session = {
      id,
      type: opts.type || 'shell', // shell | agent | ssh | logs | docker
      title: opts.title || 'Shell',
      subtitle: opts.subtitle || '',
      glyph: opts.glyph || '›_',
      data: mergedData,
      status: 'connecting',
      started: Date.now(),
    };
    setSessions(arr => [...arr, session]);
    setActiveId(id);
    setFullscreen(true);
    return id;
  }, []);

  const close = useCallback((id) => {
    // Keep nested setState calls out of the updater — updaters must be pure
    // (StrictMode double-invokes them)
    const next = sessions.filter(s => s.id !== id);
    setSessions(next);
    if (id === activeId) {
      setActiveId(next.length ? next[next.length - 1].id : null);
      if (!next.length) setFullscreen(false);
    }
  }, [sessions, activeId]);

  const minimize = useCallback(() => setFullscreen(false), []);
  const restore = useCallback((id) => {
    if (id) setActiveId(id);
    setFullscreen(true);
  }, []);

  useEffect(() => {
    window.SESS = { launch, close, minimize, restore };
  }, [launch, close, minimize, restore]);

  // ⌘` toggles overlay if shells exist; otherwise opens a new one
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === '`' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (sessions.length === 0) {
          launch({ type: 'shell', title: 'shell · 1', glyph: '›_' });
        } else if (fullscreen) {
          minimize();
        } else {
          restore(activeId || sessions[sessions.length - 1].id);
        }
      }
      if (e.key === 'Escape' && fullscreen) {
        minimize();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessions, activeId, fullscreen, launch, minimize, restore]);

  return (
    <SessionsCtx.Provider value={{ sessions, activeId, fullscreen, launch, close, minimize, restore, setActiveId, setSessions }}>
      {children}
      {sessions.length > 0 && <SessionOverlay />}
      {!fullscreen && sessions.length > 0 && <SessionDock />}
    </SessionsCtx.Provider>
  );
}

function useSessions() {
  return useContext(SessionsCtx);
}

function SessionOverlay() {
  const { sessions, activeId, setActiveId, close, minimize, launch, fullscreen } = useSessions();
  const active = sessions.find(s => s.id === activeId) || sessions[0];
  const [hostname, setHostname] = useState('ayman-server');

  useEffect(() => {
    axios.get('/api/health')
      .then(res => {
        if (res.data?.host?.name) setHostname(res.data.host.name);
      })
      .catch(() => {});
  }, []);

  if (!active) return null;

  return (
    <div className={`sess-overlay ${!fullscreen ? 'is-minimized' : ''}`} role="dialog" aria-label="Session" style={!fullscreen ? { display: 'none' } : undefined}>
      <header className="sess-head">
        <div className="sess-tabs">
          {sessions.map(s => (
            <button
              key={s.id}
              className={`sess-tab sess-tab-${s.type} ${s.id === activeId ? 'is-active' : ''}`}
              onClick={() => setActiveId(s.id)}
              title={`${s.title} · ${s.subtitle}`}
            >
              <span className={`sess-status dot dot-${s.status === 'connected' ? 'ok' : s.status === 'connecting' ? 'warn' : 'mute'}`} />
              <span className="sess-tab-glyph mono">{s.glyph}</span>
              <span className="sess-tab-title">{s.title}</span>
              {s.subtitle && <span className="sess-tab-sub mono">{s.subtitle}</span>}
              <button
                className="sess-tab-x"
                onClick={(e) => { e.stopPropagation(); close(s.id); }}
                aria-label="Close session"
              >×</button>
            </button>
          ))}
          <button className="sess-tab-add" onClick={() => launch({ type: 'shell', title: `shell · ${sessions.length + 1}`, glyph: '›_' })}>
            <span>+</span><span className="mono">New shell</span>
          </button>
        </div>
        <div className="sess-ctrls">
          <span className="sess-host mono">{hostname}</span>
          <button className="sess-ctrl-btn" title="Minimize" onClick={minimize}>—</button>
          <button className="sess-ctrl-btn" title="Close all sessions" onClick={async () => {
            const ok = await window.UI.confirm({
              title: 'Close all sessions?',
              body: `${sessions.length} session${sessions.length === 1 ? '' : 's'} will be disconnected.`,
              confirmLabel: 'Close all',
              dangerous: true,
            });
            if (ok) sessions.forEach(s => close(s.id));
          }}>×</button>
        </div>
      </header>
      <div className="sess-body">
        {sessions.map(s => {
          const isActive = s.id === activeId;
          if (s.type === 'logs') {
            return <RealLogsPane key={s.id} session={s} active={isActive} />;
          }
          return <RealTerminalPane key={s.id} session={s} active={isActive} />;
        })}
      </div>
    </div>
  );
}

function SessionDock() {
  const { sessions, restore, close, activeId } = useSessions();
  return (
    <div className="sess-dock" role="toolbar" aria-label="Minimized sessions">
      <div className="sess-dock-label mono">sessions</div>
      {sessions.map(s => (
        <button
          key={s.id}
          className={`sess-dock-pill sess-dock-${s.type} ${s.id === activeId ? 'is-active' : ''}`}
          onClick={() => restore(s.id)}
          title={`Restore ${s.title}`}
        >
          <span className={`dot dot-${s.status === 'connected' ? 'ok' : s.status === 'connecting' ? 'warn' : 'mute'}`} />
          <span className="sess-dock-glyph mono">{s.glyph}</span>
          <span className="sess-dock-title">{s.title}</span>
          <span className="sess-dock-x" onClick={(e) => { e.stopPropagation(); close(s.id); }} aria-label="Close">×</span>
        </button>
      ))}
    </div>
  );
}

// ─── RealTerminalPane (xterm.js + WebSockets integration) ───────────────────
function RealTerminalPane({ session, active }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const ctrlRef = useRef(false);
  const [ctrlOn, setCtrlOn] = useState(false);
  const [kbFocused, setKbFocused] = useState(false);
  const { setSessions, fullscreen } = useSessions();

  const updateStatus = useCallback((status) => {
    setSessions(arr => arr.map(s => s.id === session.id ? { ...s, status } : s));
  }, [session.id, setSessions]);

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

  useEffect(() => {
    if (!hostRef.current) return;

    const isMobile = window.innerWidth <= 768;

    const term = new XTermTerminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: true,
      scrollback: isMobile ? 500 : 1000,
      smoothScrollDuration: 0,
      theme: {
        background: '#1f1e1d',
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

    // Track focus so the mobile key bar shows only with the keyboard open.
    let blurTimer = null;
    if (term.textarea) {
      term.textarea.addEventListener('focus', () => { clearTimeout(blurTimer); setKbFocused(true); });
      term.textarea.addEventListener('blur', () => { blurTimer = setTimeout(() => setKbFocused(false), 150); });
    }

    // Touch-scroll: translate vertical swipes into xterm scroll calls.
    // The xterm canvas intercepts pointer events so native viewport scroll
    // never fires on mobile — we have to drive it manually.
    let touchStartY = 0;
    const onTouchStart = (e) => { touchStartY = e.touches[0].clientY; };
    const onTouchMove = (e) => {
      const dy = touchStartY - e.touches[0].clientY;
      touchStartY = e.touches[0].clientY;
      const lines = Math.round(dy / (term.options.fontSize || 13));
      if (lines !== 0) {
        term.scrollLines(lines);
        e.preventDefault();
      }
    };
    const hostEl = hostRef.current;
    hostEl.addEventListener('touchstart', onTouchStart, { passive: true });
    hostEl.addEventListener('touchmove', onTouchMove, { passive: false });

    term.writeln('\x1b[2m· connecting …\x1b[0m');
    updateStatus('connecting');

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams();
    if (session.type === 'agent' && session.data?.id) params.set('agent', session.data.id);
    if (session.data?.agent) params.set('agent', session.data.agent);
    if (session.type === 'docker' && session.data?.container) params.set('docker', session.data.container);
    if (session.type === 'ssh') params.set('ssh', 'true');
    if (session.data?.cwd) params.set('cwd', session.data.cwd);
    if (session.data?.env != null) {
      const envCsv = Array.isArray(session.data.env) ? session.data.env.join(',') : String(session.data.env);
      if (envCsv) params.set('env', envCsv);
    }
    params.set('cols', String(term.cols));
    params.set('rows', String(term.rows));

    const ws = new WebSocket(`${proto}://${window.location.host}/ws/terminal?${params.toString()}`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    // Reuse decoder across messages to avoid per-message GC pressure.
    const decoder = new TextDecoder();

    let opened = false;
    ws.onopen = () => {
      opened = true;
      updateStatus('connected');
      if (session.type === 'ssh' && session.data) {
        try {
          ws.send(JSON.stringify({
            type: 'init-ssh',
            host: session.data.host,
            port: session.data.port,
            username: session.data.username || 'root',
            password: session.data.password || '',
            privateKey: session.data.privateKey || '',
            passphrase: session.data.passphrase || '',
            cols: term.cols,
            rows: term.rows
          }));
        } catch {}
      } else {
        try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {}
      }
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(decoder.decode(e.data));
      } else if (typeof e.data === 'string') {
        term.write(e.data);
      }
    };

    ws.onclose = (event) => {
      updateStatus('closed');
      if (!opened && event.code !== 1000) {
        term.writeln(`\r\n\x1b[31m✗ connection failed (code ${event.code})\x1b[0m`);
      }
    };

    ws.onerror = () => {
      updateStatus('error');
    };

    term.onData((d) => {
      let data = d;
      // Sticky Ctrl from the mobile key bar (a → ^A, c → ^C, …)
      if (ctrlRef.current && data.length === 1) {
        const c = data.charCodeAt(0);
        if (c >= 97 && c <= 122)      data = String.fromCharCode(c - 96);
        else if (c >= 64 && c <= 95)  data = String.fromCharCode(c - 64);
        ctrlRef.current = false;
        setCtrlOn(false);
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch {}
      }
    });

    // Debounced fit — avoids rapid-fire calls on window resize or keyboard open/close.
    let fitTimer = null;
    const scheduleFit = () => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => { try { fit.fit(); } catch {} }, 80);
    };

    window.addEventListener('resize', scheduleFit);

    // Refit when the soft keyboard opens/closes (mobile VisualViewport shrinks).
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleFit);
    }

    // Refit when the container itself changes size (e.g. overlay animation).
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(hostEl);

    const tid = setTimeout(scheduleFit, 60);

    return () => {
      clearTimeout(tid);
      clearTimeout(fitTimer);
      window.removeEventListener('resize', scheduleFit);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', scheduleFit);
      }
      ro.disconnect();
      hostEl.removeEventListener('touchstart', onTouchStart);
      hostEl.removeEventListener('touchmove', onTouchMove);
      try { ws.close(); } catch (e) {}
      try { term.dispose(); } catch (e) {}
    };
  }, [session.id]);

  useEffect(() => {
    if (active && fullscreen && fitRef.current) {
      const id = setTimeout(() => {
        try { fitRef.current.fit(); } catch {}
        try { termRef.current?.focus(); } catch {}
      }, 60);
      return () => clearTimeout(id);
    }
  }, [active, fullscreen]);

  return (
    <div className={`sh-pane mono`} style={{ display: active ? 'flex' : 'none', flexDirection: 'column', height: '100%', width: '100%', padding: 0, background: '#1f1e1d' }}>
      <div ref={hostRef} className="terminal-body" style={{ flex: 1, minHeight: 0, width: '100%', padding: '8px' }} />
      <TerminalKeyBar onKey={sendSeq} ctrlOn={ctrlOn} onToggleCtrl={toggleCtrl} visible={active && kbFocused} />
    </div>
  );
}

// ─── RealLogsPane (Docker container logs tailing) ───────────────────────────
function RealLogsPane({ session, active }) {
  const container = session.data?.container || 'plex';
  const [logLines, setLogLines] = useState([]);
  const bodyRef = useRef(null);
  const { setSessions } = useSessions();
  const mountedRef = useRef(true);
  const ctrlRef = useRef(null);
  useEffect(() => () => { mountedRef.current = false; ctrlRef.current?.abort(); }, []);

  useEffect(() => {
    if (active) {
      setSessions(arr => arr.map(s => s.id === session.id ? { ...s, status: 'connected' } : s));
    }
  }, [active, session.id, setSessions]);

  useEffect(() => {
    // Don't keep refetching full log payloads while the pane is hidden
    if (!active) return;
    const fetchLogs = async () => {
      try {
        if (ctrlRef.current) ctrlRef.current.abort();
        ctrlRef.current = new AbortController();
        const res = await axios.get('/api/docker/logs', { params: { name: container }, signal: ctrlRef.current.signal });
        const text = res.data.logs || '';
        const lines = text.split('\n').filter(Boolean);
        if (mountedRef.current) setLogLines(lines);
      } catch (e) {
        if (mountedRef.current) setLogLines([`Failed to fetch logs: ${e.message}`]);
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [container, active]);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logLines, active]);

  if (!active) return null;

  return (
    <div className="logs-pane mono" style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#1f1e1d', color: '#f5f5f5' }}>
      <div className="logs-head" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-3)' }}>
        <span>Tailing logs · <b>{container}</b></span>
        <span className="muted">last 200 lines · live</span>
      </div>
      <div className="logs-body" ref={bodyRef} style={{ flex: 1, padding: '12px', overflowY: 'auto', fontSize: '12px', lineHeight: '1.4', fontFamily: 'monospace' }}>
        {logLines.map((line, i) => {
          let lvl = 'INFO';
          let msg = line;
          let ts = '';

          // Try standard log line parsing
          const match = line.match(/^(\S+\s+\S+)\s+\[?(INFO|DEBUG|WARN|ERROR|ERR|FATAL)\]?\s+(.*)$/i) ||
                        line.match(/^([\d-T:.Z]+)\s+(\S+)\s+(.*)$/);
          if (match) {
            ts = match[1];
            lvl = match[2].toUpperCase();
            msg = match[3];
          }

          return (
            <div key={i} className="logs-line" style={{ display: 'flex', gap: '8px', marginBottom: '2px' }}>
              {ts && <span className="logs-ts" style={{ color: 'var(--text-3)', flexShrink: 0 }}>{ts}</span>}
              <span className={`logs-lvl logs-lvl-${lvl.toLowerCase()}`} style={{
                color: lvl.includes('ERR') || lvl.includes('FATAL') ? '#ef4444' : lvl.includes('WARN') ? '#f59e0b' : '#10b981',
                fontWeight: 'bold',
                flexShrink: 0
              }}>{lvl}</span>
              <span className="logs-msg" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{msg}</span>
            </div>
          );
        })}
        {logLines.length === 0 && <div style={{ color: 'var(--text-3)' }}>No logs available.</div>}
      </div>
    </div>
  );
}

export { SessionsProvider, useSessions };
