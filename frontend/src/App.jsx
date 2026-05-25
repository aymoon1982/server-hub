import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import axios from 'axios';
import './App.css';

import { UIProvider, Modal } from './ui-bridge.jsx';
import { SessionsProvider, useSessions } from './sessions.jsx';
import { useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakColor, TweakButton } from './tweaks-panel.jsx';
import {
  Overview,
  ServicesTab,
  AgentsTab,
  SambaTab,
  FilesTab,
  SSHTab,
  SystemTab,
  KBD
} from './tabs.jsx';
import { PowerMenu, DockerImagesTab } from './features.jsx';

const TABS = [
  { id: 'overview', label: 'Overview', glyph: '◇', section: 'system' },
  { id: 'system',   label: 'System',   glyph: '⊟', section: 'system', badge: true },
  { id: 'web',      label: 'Web UIs',  glyph: '▦', section: 'services' },
  { id: 'backend',  label: 'Backend',  glyph: '⇆', section: 'services' },
  { id: 'docker',   label: 'Images',   glyph: '◈', section: 'services' },
  { id: 'agents',   label: 'Agents',   glyph: '✦', section: 'services' },
  { id: 'samba',    label: 'Samba',    glyph: '◫', section: 'storage' },
  { id: 'files',    label: 'Files',    glyph: '▢', section: 'storage' },
  { id: 'ssh',      label: 'SSH',      glyph: '⇄', section: 'shell' },
];

const SECTIONS = [
  { id: 'system',   label: 'System' },
  { id: 'services', label: 'Services' },
  { id: 'storage',  label: 'Storage' },
  { id: 'shell',    label: 'Shell' },
];

const TWEAK_DEFAULTS = {
  "nav": "sidebar",
  "theme": "dark",
  "density": "comfortable",
  "cardStyle": "tile",
  "accent": "#a78bfa"
};

const ACCENT_PRESETS = {
  '#a78bfa': { h: 285, c: 0.13, l: 0.66 },
  '#5cc8e2': { h: 220, c: 0.11, l: 0.74 },
  '#6dd49a': { h: 150, c: 0.11, l: 0.78 },
  '#f0c75a': { h: 78, c: 0.13, l: 0.82 },
  '#f08a8a': { h: 18, c: 0.12, l: 0.72 },
};
const ACCENT_OPTS = Object.keys(ACCENT_PRESETS);

function Shell() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [activeTab, setActiveTab] = useState('overview');
  const [collapsed, setCollapsed] = useState(false);
  const [powerOpen, setPowerOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Live data states for badge counts
  const [hostName, setHostName] = useState('server');
  const [hostUptime, setHostUptime] = useState('');
  const [updateCount, setUpdateCount] = useState(0);
  const [webCount, setWebCount] = useState(0);
  const [backendCount, setBackendCount] = useState(0);
  const [agentCount, setAgentCount] = useState(0);
  const [sambaCount, setSambaCount] = useState(0);
  const [sshCount, setSshCount] = useState(0);

  // Fetch data for badges
  const fetchCounts = async () => {
    try {
      const [healthRes, updatesRes, servicesRes, sambaRes] = await Promise.all([
        axios.get('/api/health').catch(() => null),
        axios.get('/api/updates').catch(() => null),
        axios.get('/api/services').catch(() => null),
        axios.get('/api/samba/shares').catch(() => null),
      ]);

      if (healthRes?.data) {
        setHostName(healthRes.data.host?.name || 'server');
        if (healthRes.data.uptime) {
          const hours = Math.floor(healthRes.data.uptime / 3600);
          const mins = Math.floor((healthRes.data.uptime % 3600) / 60);
          setHostUptime(`${hours}h ${mins}m`);
        }
      }

      if (updatesRes?.data?.updates) {
        setUpdateCount(updatesRes.data.updates.length);
      }

      if (servicesRes?.data) {
        const web = servicesRes.data.filter(s => s.isWebUi).length;
        const back = servicesRes.data.filter(s => !s.isWebUi).length;
        setWebCount(web);
        setBackendCount(back);
      }

      if (sambaRes?.data?.shares) {
        setSambaCount(sambaRes.data.shares.length);
      } else if (Array.isArray(sambaRes?.data)) {
        setSambaCount(sambaRes.data.length);
      }

      const storedSsh = localStorage.getItem('dashboard_ssh_servers');
      if (storedSsh) {
        try { setSshCount((JSON.parse(storedSsh) || []).length); } catch (e) { setSshCount(0); }
      }
    } catch (e) {}
  };

  useEffect(() => {
    fetchCounts();
    const interval = setInterval(fetchCounts, 5000);
    return () => clearInterval(interval);
  }, []);

  // Apply theme + accent vars
  useEffect(() => {
    const root = document.documentElement;
    const a = ACCENT_PRESETS[t.accent] || ACCENT_PRESETS['#a78bfa'];
    root.style.setProperty('--accent-h', a.h);
    root.style.setProperty('--accent-c', a.c);
    root.style.setProperty('--accent-l', a.l);
    root.dataset.theme = t.theme;
    root.dataset.density = t.density;
  }, [t.accent, t.theme, t.density]);

  // Close power menu on outside click
  useEffect(() => {
    if (!powerOpen) return;
    const onClick = (e) => {
      if (!e.target.closest('.power-menu') && !e.target.closest('[data-power-trigger]')) setPowerOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [powerOpen]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const inField = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
      if (e.key === '/' && !inField) {
        e.preventDefault();
        document.querySelector('.top-search input')?.focus();
      }
      if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault(); setPaletteOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const counts = {
    overview: '',
    system:  updateCount > 0 ? updateCount.toString() : '',
    web:     webCount.toString(),
    backend: backendCount.toString(),
    docker:  '',
    agents:  agentCount.toString() || '6',
    samba:   sambaCount.toString(),
    files:   '',
    ssh:     sshCount.toString(),
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'overview': return <Overview onNav={setActiveTab} />;
      case 'system':   return <SystemTab />;
      case 'web':      return <ServicesTab kind="web" cardStyle={t.cardStyle} />;
      case 'backend':  return <ServicesTab kind="backend" cardStyle={t.cardStyle} />;
      case 'docker':   return <DockerImagesTab />;
      case 'agents':   return <AgentsTab />;
      case 'samba':    return <SambaTab />;
      case 'files':    return <FilesTab />;
      case 'ssh':      return <SSHTab />;
      default: return null;
    }
  };

  const tabDef = TABS.find(x => x.id === activeTab);
  const openTerminal = () => window.SESS.launch({ type: 'shell', title: 'shell · 1', glyph: '›_' });

  return (
    <div
      className="shell v-b"
      data-nav={t.nav}
      data-collapsed={collapsed && t.nav === 'sidebar'}
    >
      {t.nav === 'sidebar' && (
        <aside className="shell-sidebar">
          <div className="brand">
            <div className="brand-mark">⌘</div>
            {!collapsed && (
              <div className="brand-text">
                <span>Console</span>
                <small className="mono">{hostName}</small>
              </div>
            )}
          </div>
          <nav className="nav">
            {SECTIONS.map(sec => (
              <React.Fragment key={sec.id}>
                <div className="nav-section">{sec.label}</div>
                {TABS.filter(tab => tab.section === sec.id).map(tab => (
                  <button
                    key={tab.id}
                    className={`nav-item ${activeTab === tab.id ? 'is-active' : ''}`}
                    onClick={() => setActiveTab(tab.id)}
                    title={tab.label}
                  >
                    <span className="nav-glyph">{tab.glyph}</span>
                    <span className="nav-label">{tab.label}</span>
                    {counts[tab.id] !== '' && <span className={`nav-count ${tab.badge ? 'is-badge' : ''}`}>{counts[tab.id]}</span>}
                  </button>
                ))}
              </React.Fragment>
            ))}
          </nav>
          <div className="shell-foot">
            <div className="host-pill">
              <span className="dot dot-ok pulse" />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="host-pill-name">{hostName}</div>
                {hostUptime && <div className="host-pill-meta mono">up {hostUptime}</div>}
              </div>
            </div>
            <div style={{ position: 'relative' }}>
              <button className="icon-btn" data-power-trigger onClick={(e) => { e.stopPropagation(); setPowerOpen(!powerOpen); }} title="Power">⏻</button>
              {powerOpen && <PowerMenu onClose={() => setPowerOpen(false)} />}
            </div>
            <button className="icon-btn" onClick={() => setCollapsed(c => !c)} title="Collapse">
              {collapsed ? '›' : '‹'}
            </button>
          </div>
        </aside>
      )}

      <header className="shell-top">
        {t.nav === 'topbar' && (
          <div className="brand" style={{ borderBottom: 0, padding: 0, minHeight: 0, marginRight: 8 }}>
            <div className="brand-mark">⌘</div>
            <div className="brand-text">
              <span>Console</span>
              <small className="mono">{hostName}</small>
            </div>
          </div>
        )}
        <div className="top-search" onClick={() => setPaletteOpen(true)}>
          <span className="search-icon">⌕</span>
          <input
            value={globalSearch}
            onChange={(e) => { setGlobalSearch(e.target.value); setPaletteOpen(true); }}
            onFocus={() => setPaletteOpen(true)}
            placeholder="Search services, files, agents…  (⌘K)"
          />
          <KBD>⌘K</KBD>
        </div>
        <div className="top-actions">
          <button className="term-launch" onClick={openTerminal} title="Open terminal (⌘`)">
            <span>›_</span>
            <span style={{ color: 'var(--text-3)' }}>Terminal</span>
            <KBD>⌘`</KBD>
          </button>
          <div className="theme-toggle">
            <button className={t.theme === 'light' ? 'is-active' : ''} onClick={() => setTweak('theme', 'light')} title="Light">☀</button>
            <button className={t.theme === 'dark' ? 'is-active' : ''} onClick={() => setTweak('theme', 'dark')} title="Dark">☾</button>
          </div>
          <button
            className="icon-btn-top"
            title="Tweaks"
            onClick={() => window.dispatchEvent(new CustomEvent('toggle-tweaks'))}
          >◐</button>
          <div style={{ position: 'relative' }}>
            <button className="icon-btn-top" data-power-trigger onClick={(e) => { e.stopPropagation(); setPowerOpen(!powerOpen); }} title="Power">⏻</button>
            {powerOpen && t.nav === 'topbar' && <PowerMenu onClose={() => setPowerOpen(false)} />}
          </div>
          <div className="avatar">AY</div>
        </div>
      </header>

      {t.nav === 'topbar' && (
        <nav className="shell-tabs">
          {SECTIONS.map((sec, si) => (
            <React.Fragment key={sec.id}>
              {si > 0 && <span className="shell-tabs-sep" />}
              {TABS.filter(x => x.section === sec.id).map(tab => (
                <button
                  key={tab.id}
                  className={`tab-pill ${activeTab === tab.id ? 'is-active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="nav-glyph">{tab.glyph}</span>
                  <span>{tab.label}</span>
                  {counts[tab.id] !== '' && <span className={`nav-count ${tab.badge ? 'is-badge' : ''}`}>{counts[tab.id]}</span>}
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>
      )}

      <main className="shell-main">
        <div className="page-head">
          <h1>{tabDef?.label}</h1>
          <span className="page-sub">{pageSub(activeTab, hostName, hostUptime, updateCount)}</span>
        </div>
        <ErrorBoundary>{renderTab()}</ErrorBoundary>
      </main>

      {paletteOpen && (
        <CommandPalette
          query={globalSearch}
          setQuery={setGlobalSearch}
          onClose={() => setPaletteOpen(false)}
          onNavigate={(id) => { setActiveTab(id); setPaletteOpen(false); }}
          onLaunchTerminal={() => { openTerminal(); setPaletteOpen(false); }}
        />
      )}

      <TweaksPanel>
        <TweakSection label="Layout" />
        <TweakRadio
          label="Navigation"
          value={t.nav}
          options={['sidebar', 'topbar']}
          onChange={(v) => setTweak('nav', v)}
        />
        <TweakRadio
          label="Density"
          value={t.density}
          options={['dense', 'comfortable']}
          onChange={(v) => setTweak('density', v)}
        />
        <TweakRadio
          label="Service cards"
          value={t.cardStyle}
          options={['tile', 'list', 'preview']}
          onChange={(v) => setTweak('cardStyle', v)}
        />

        <TweakSection label="Theme" />
        <TweakRadio
          label="Mode"
          value={t.theme}
          options={['dark', 'light']}
          onChange={(v) => setTweak('theme', v)}
        />
        <TweakColor
          label="Accent"
          value={t.accent}
          options={ACCENT_OPTS}
          onChange={(v) => setTweak('accent', v)}
        />

        <TweakSection label="Alerts" />
        <AlertThresholds />

        <TweakSection label="Actions" />
        <TweakButton label="Open terminal" onClick={openTerminal} />
        <TweakButton label="Go to Overview" onClick={() => setActiveTab('overview')} secondary />
      </TweaksPanel>
    </div>
  );
}

function pageSub(tab, hostName, hostUptime, updateCount) {
  switch (tab) {
    case 'overview': return `${hostName} · up ${hostUptime || '—'} · live stats`;
    case 'system':   return `${updateCount > 0 ? `${updateCount} updates · ` : ''}processes, logs, network, units, cron`;
    case 'web':      return `Auto-discovered web UIs and manually added services`;
    case 'backend':  return `Internal TCP/UDP services bound to ports`;
    case 'docker':   return `Local Docker images · pull, remove, prune`;
    case 'agents':   return `AI coding agents detected on this host`;
    case 'samba':    return `Shares, users, connections and service control`;
    case 'files':    return `Browse, edit, copy, move and manage files`;
    case 'ssh':      return `Saved SSH connections, keys, and known_hosts`;
    default: return '';
  }
}

// ─── Alert Thresholds (in tweaks panel) ─────────────────────────────────────
function AlertThresholds() {
  const [disk, setDisk] = useState(90);
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    axios.get('/api/alerts/config').then(r => { if (mountedRef.current) setDisk(r.data.disk || 90); }).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await axios.post('/api/alerts/config', { cpu: 100, ram: 100, disk });
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch (e) {}
    if (mountedRef.current) setSaving(false);
  };

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ marginBottom: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '2px' }}>
          <span style={{ color: 'var(--text-2)' }}>Disk alert threshold</span>
          <span className="mono" style={{ color: 'var(--accent)' }}>{disk}%</span>
        </div>
        <input type="range" min="50" max="99" value={disk} style={{ width: '100%', accentColor: 'var(--accent)' }}
          onChange={e => setDisk(parseInt(e.target.value, 10))} />
      </div>
      <button className="btn-ghost" style={{ width: '100%', marginTop: '4px', fontSize: '12px' }} disabled={saving} onClick={save}>
        {saving ? 'Saving…' : 'Save threshold'}
      </button>
    </div>
  );
}

// ─── Command palette (⌘K) ────────────────────────────────────────────────
function CommandPalette({ query, setQuery, onClose, onNavigate, onLaunchTerminal }) {
  const inputRef = useRef(null);
  const [services, setServices] = useState([]);
  const [agents, setAgents] = useState([]);
  const [sshServers, setSshServers] = useState([]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);

    // Fetch lists for command palette search
    axios.get('/api/services').then(res => setServices(res.data)).catch(() => {});
    axios.get('/api/agents').then(res => setAgents(res.data.agents || [])).catch(() => {});
    const storedSsh = localStorage.getItem('dashboard_ssh_servers');
    if (storedSsh) {
      try { setSshServers(JSON.parse(storedSsh) || []); } catch (e) { setSshServers([]); }
    }

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const allItems = useMemo(() => {
    const list = [];
    TABS.forEach(tab => list.push({ kind: 'page', id: tab.id, label: tab.label, hint: `Go to · ${tab.section}`, glyph: tab.glyph, action: () => onNavigate(tab.id) }));
    services.forEach(s => list.push({ kind: 'service', id: 'svc-' + s.name, label: s.displayName, hint: `${s.port} · ${s.type}`, glyph: '▦', action: () => onNavigate(s.isWebUi ? 'web' : 'backend') }));
    agents.forEach(a => list.push({ kind: 'agent', id: 'ag-' + a.id, label: a.label, hint: `Launch ${a.label} session`, glyph: a.glyph || '✦', action: () => { window.SESS.launch({ type: 'agent', title: a.label, subtitle: `v${a.version}`, glyph: a.glyph || '✦', data: a }); onClose(); } }));
    sshServers.forEach(s => list.push({ kind: 'ssh', id: 'sh-' + s.id, label: s.label, hint: `SSH ${s.username}@${s.host}`, glyph: '⇄', action: () => { window.SESS.launch({ type: 'ssh', title: s.label, subtitle: `${s.username}@${s.host}`, glyph: '⇄', data: s }); onClose(); } }));
    list.push({ kind: 'action', id: 'term', label: 'Open terminal', hint: 'New shell · ⌘`', glyph: '›_', action: onLaunchTerminal });
    list.push({ kind: 'action', id: 'updates',  label: 'Check for updates', hint: 'apt update',           glyph: '↻', action: () => onNavigate('system') });
    list.push({ kind: 'action', id: 'kill',     label: 'Manage processes',  hint: 'kill · renice',         glyph: '⊞', action: () => onNavigate('system') });
    list.push({ kind: 'action', id: 'logs-open',label: 'View system logs',  hint: 'journald · live tail',  glyph: '≡', action: () => onNavigate('system') });
    list.push({ kind: 'action', id: 'net-open', label: 'Network details',   hint: 'connections · firewall', glyph: '⇌', action: () => onNavigate('system') });
    return list;
  }, [services, agents, sshServers, onNavigate, onClose, onLaunchTerminal]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return allItems.slice(0, 12);
    return allItems.filter(i => i.label.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q)).slice(0, 30);
  }, [query, allItems]);

  const [idx, setIdx] = useState(0);
  useEffect(() => { setIdx(0); }, [query]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(filtered.length - 1, i + 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
      if (e.key === 'Enter' && filtered[idx]) { e.preventDefault(); filtered[idx].action(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, idx]);

  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette">
        <div className="palette-input">
          <span className="search-icon">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type to filter pages, services, agents, actions…"
          />
          <KBD>Esc</KBD>
        </div>
        <div className="palette-list">
          {filtered.map((it, i) => (
            <button
              key={it.id}
              className={`palette-item ${i === idx ? 'is-on' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => it.action()}
            >
              <span className="palette-glyph mono">{it.glyph}</span>
              <span className="palette-label">{it.label}</span>
              <span className="palette-hint mono muted">{it.hint}</span>
              <span className={`palette-kind palette-kind-${it.kind} mono`}>{it.kind}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="empty muted" style={{ padding: 24 }}>No matches</div>}
        </div>
        <div className="palette-foot mono muted">
          <span><KBD>↑↓</KBD> navigate</span>
          <span><KBD>↵</KBD> run</span>
          <span><KBD>Esc</KBD> close</span>
        </div>
      </div>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error, info) { console.error('UI error:', error, info); }
  render() {
    if (this.state.hasError) {
      return <div style={{ padding: 24, color: '#f88' }}>Something went wrong. <button onClick={() => location.reload()}>Reload</button></div>;
    }
    return this.props.children;
  }
}

// Root: providers + shell
export default function App() {
  return (
    <UIProvider>
      <SessionsProvider>
        <Shell />
      </SessionsProvider>
    </UIProvider>
  );
}
