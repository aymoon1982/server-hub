import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import axios from 'axios';
import './App.css';

import { UIProvider, Modal } from './ui-bridge.jsx';
import { SessionsProvider, useSessions } from './sessions.jsx';
import { useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakColor, TweakButton, TweakText, TweakSlider } from './tweaks-panel.jsx';
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
import { PowerMenu, DockerContainersTab, DockerImagesTab, StacksTab } from './features.jsx';
import { CodeHubTab } from './code-hub.jsx';
import { EnvManagerTab } from './env-manager.jsx';
import {
  LayoutDashboard, Gauge, Globe, Server, Container, SquareTerminal,
  Sparkles, Share2, FolderOpen, FileCode, KeyRound,
} from 'lucide-react';

const TABS = [
  { id: 'overview', label: 'Overview', glyph: '◇', icon: LayoutDashboard, section: 'system' },
  { id: 'system',   label: 'System',   glyph: '⊟', icon: Gauge,           section: 'system', badge: true },
  { id: 'web',      label: 'Web UIs',  glyph: '▦', icon: Globe,           section: 'services' },
  { id: 'backend',  label: 'Backend',  glyph: '⇆', icon: Server,          section: 'services' },
  { id: 'docker',   label: 'Docker',   glyph: '◈', icon: Container,       section: 'services' },
  { id: 'code',     label: 'Code',     glyph: '⌘', icon: SquareTerminal,  section: 'shell' },
  { id: 'agents',   label: 'Agents',   glyph: '✦', icon: Sparkles,        section: 'services' },
  { id: 'samba',    label: 'Samba',    glyph: '◫', icon: Share2,          section: 'storage' },
  { id: 'files',    label: 'Files',    glyph: '▢', icon: FolderOpen,      section: 'storage' },
  { id: 'envfiles', label: 'Env',      glyph: '⊙', icon: FileCode,        section: 'storage' },
  { id: 'ssh',      label: 'SSH',      glyph: '⇄', icon: KeyRound,        section: 'shell' },
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
  "accent": "#d97757",
  "wallpaper": "none",
  "customWallpaperUrl": "",
  "wallpaperBlur": 0
};

const WALLPAPERS = {
  cosmic: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1920&q=80',
  sunset: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=1920&q=80',
  cyber: 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=1920&q=80'
};

const ACCENT_PRESETS = {
  '#d97757': { h: 45, c: 0.13, l: 0.68 },   // Claude clay (default)
  '#a78bfa': { h: 285, c: 0.13, l: 0.66 },
  '#5cc8e2': { h: 220, c: 0.11, l: 0.74 },
  '#6dd49a': { h: 150, c: 0.11, l: 0.78 },
  '#f0c75a': { h: 78, c: 0.13, l: 0.82 },
};
const ACCENT_OPTS = Object.keys(ACCENT_PRESETS);

function DockerTab() {
  const [status, setStatus] = useState({ installed: true, version: '', composeVersion: '', running: true });
  const [loading, setLoading] = useState(true);
  const [sub, setSub] = useState('containers');
  const [logs, setLogs] = useState([]);
  const [installing, setInstalling] = useState(false);

  const checkStatus = () => {
    setLoading(true);
    axios.get('/api/docker/status')
      .then(r => {
        setStatus(r.data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    checkStatus();
  }, []);

  const handleInstall = () => {
    setInstalling(true);
    setLogs([]);
    const eventSource = new EventSource('/api/docker/install', { withCredentials: true });
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
          setLogs(prev => [...prev, data.text]);
        } else if (data.type === 'done') {
          eventSource.close();
          setInstalling(false);
          window.UI.toast({
            kind: data.code === 0 ? 'ok' : 'err',
            title: data.code === 0 ? 'Docker installed' : 'Installation failed',
            body: data.code === 0 ? 'Docker has been successfully installed!' : 'See log for details.'
          });
          checkStatus();
        }
      } catch (e) {
        console.error(e);
      }
    };

    eventSource.onerror = (e) => {
      eventSource.close();
      setInstalling(false);
      window.UI.toast({ kind: 'err', title: 'Connection lost', body: 'Failed to stream installation output.' });
    };
  };

  if (loading) {
    return <div className="loading" style={{ padding: 24, textAlign: 'center' }}>Checking Docker status...</div>;
  }

  if (!status.installed || !status.running) {
    return (
      <div className="card" style={{ padding: 24, maxWidth: 650, margin: '20px auto' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 12px 0', color: 'var(--text-1)' }}>
          <span style={{ fontSize: '24px' }}>🐳</span> Docker Management
        </h2>
        
        {!status.installed ? (
          <>
            <p className="muted" style={{ lineHeight: 1.5, marginBottom: 20 }}>
              Docker was not detected on this system. You can install it directly from here using the standard convenience script.
            </p>
            {installing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="spinner" />
                  <strong>Installing Docker... Please do not close this page.</strong>
                </div>
                <pre style={{
                  background: 'var(--surface-3)',
                  border: '1px solid var(--line)',
                  padding: 12,
                  borderRadius: 6,
                  maxHeight: 250,
                  overflowY: 'auto',
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  color: 'var(--text-2)',
                  whiteSpace: 'pre-wrap',
                  textAlign: 'left'
                }}>
                  {logs.join('')}
                </pre>
              </div>
            ) : (
              <button className="btn-accent" onClick={handleInstall}>
                Install Docker
              </button>
            )}
          </>
        ) : (
          <>
            <p className="muted" style={{ lineHeight: 1.5, marginBottom: 20 }}>
              Docker is installed but the Docker daemon is not running or the current user doesn't have permissions to access it.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn-accent" onClick={checkStatus}>
                ↻ Refresh Status
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, overflowX: 'auto', paddingBottom: 4 }}>
        {[
          { id: 'containers', label: '🗲 Containers' },
          { id: 'images', label: '◈ Images' },
          { id: 'stacks', label: '◰ Stacks' }
        ].map(s => (
          <button
            key={s.id}
            className={`tab-pill ${sub === s.id ? 'is-active' : ''}`}
            onClick={() => setSub(s.id)}
          >{s.label}</button>
        ))}
      </div>
      {sub === 'containers' && <DockerContainersTab />}
      {sub === 'images' && <DockerImagesTab />}
      {sub === 'stacks' && <StacksTab />}
    </div>
  );
}

function Shell() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [activeTab, setActiveTab] = useState('overview');
  const [collapsed, setCollapsed] = useState(false);
  const [powerOpen, setPowerOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Mobile swipe gestures
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);

  // Keep the active pill visible in the scrollable mobile bottom nav
  const tabsNavRef = useRef(null);
  useEffect(() => {
    const el = tabsNavRef.current?.querySelector('.tab-pill.is-active');
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [activeTab]);

  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e) => {
    const diffX = e.changedTouches[0].clientX - touchStartX.current;
    const diffY = e.changedTouches[0].clientY - touchStartY.current;

    // Detect horizontal swipes, avoiding conflicts with vertical scroll
    if (Math.abs(diffX) > 70 && Math.abs(diffY) < 50) {
      const target = e.target;
      // Do not trigger tab changes when swiping in interactive or terminal areas
      if (
        target.closest('.xterm-rows') ||
        target.closest('.xterm') ||
        target.closest('.term-display') ||
        target.closest('.ws-root') ||
        target.closest('.fb-list') ||
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('select') ||
        target.closest('.aj-output-pre')
      ) {
        return;
      }

      const currentIndex = TABS.findIndex(tab => tab.id === activeTab);
      if (diffX < 0) {
        // Swipe Left: Next Page
        if (currentIndex < TABS.length - 1) {
          setActiveTab(TABS[currentIndex + 1].id);
        }
      } else {
        // Swipe Right: Previous Page
        if (currentIndex > 0) {
          setActiveTab(TABS[currentIndex - 1].id);
        }
      }
    }
  };

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

  // Apply theme + accent + wallpaper vars
  useEffect(() => {
    const root = document.documentElement;
    const a = ACCENT_PRESETS[t.accent] || ACCENT_PRESETS['#d97757'];
    root.style.setProperty('--accent-h', a.h);
    root.style.setProperty('--accent-c', a.c);
    root.style.setProperty('--accent-l', a.l);
    root.dataset.theme = t.theme;
    root.dataset.density = t.density;
    root.dataset.wallpaper = (t.wallpaper && t.wallpaper !== 'none') ? 'true' : 'false';
  }, [t.accent, t.theme, t.density, t.wallpaper]);

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
      const t = e.target;
      // Never hijack keys while composing (IME) or while typing in a field,
      // terminal, or any open session/code surface. This is what caused "/"
      // to steal focus and drop/duplicate the next keystroke in agents.
      const inField =
        e.isComposing || e.keyCode === 229 ||
        t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable ||
        (t.closest && (t.closest('.xterm') || t.closest('.term-display') ||
                       t.closest('.sess-overlay') || t.closest('.hub-terminal-section')));
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

  const num = (n) => (n > 0 ? n.toString() : '');
  const counts = {
    overview: '',
    system:  updateCount > 0 ? updateCount.toString() : '',
    web:     num(webCount),
    backend: num(backendCount),
    docker:  '',
    agents:  num(agentCount),
    samba:   num(sambaCount),
    files:   '',
    ssh:     num(sshCount),
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'overview': return <Overview onNav={setActiveTab} />;
      case 'system':   return <SystemTab />;
      case 'web':      return <ServicesTab kind="web" cardStyle={t.cardStyle} />;
      case 'backend':  return <ServicesTab kind="backend" cardStyle={t.cardStyle} />;
      case 'docker':   return <DockerTab />;
      case 'agents':   return <AgentsTab />;
      case 'samba':    return <SambaTab />;
      case 'files':    return <FilesTab />;
      case 'envfiles': return <EnvManagerTab />;
      case 'ssh':      return <SSHTab />;
      default: return null;
    }
  };

  const tabDef = TABS.find(x => x.id === activeTab);
  const openTerminal = () => window.SESS.launch({ type: 'shell', title: 'shell · 1', glyph: '›_' });

  const wpUrl = t.wallpaper === 'custom' ? t.customWallpaperUrl : WALLPAPERS[t.wallpaper];
  const wpStyle = wpUrl ? {
    backgroundImage: `url(${wpUrl})`,
    filter: `blur(${t.wallpaperBlur || 0}px)`
  } : null;

  return (
    <div
      className="shell v-b"
      data-nav={t.nav}
      data-collapsed={collapsed && t.nav === 'sidebar'}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {wpUrl && <div className="shell-wallpaper" style={wpStyle} />}
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
                    <span className="nav-glyph">{tab.icon ? <tab.icon size={17} strokeWidth={1.75} /> : tab.glyph}</span>
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

      <nav ref={tabsNavRef} className={`shell-tabs${t.nav === 'sidebar' ? ' shell-tabs--sidebar-hidden' : ''}`}>
        {SECTIONS.map((sec, si) => (
          <React.Fragment key={sec.id}>
            {si > 0 && <span className="shell-tabs-sep" />}
            {TABS.filter(x => x.section === sec.id).map(tab => (
              <button
                key={tab.id}
                className={`tab-pill ${activeTab === tab.id ? 'is-active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="nav-glyph">{tab.icon ? <tab.icon size={18} strokeWidth={1.75} /> : tab.glyph}</span>
                <span>{tab.label}</span>
                {counts[tab.id] !== '' && <span className={`nav-count ${tab.badge ? 'is-badge' : ''}`}>{counts[tab.id]}</span>}
              </button>
            ))}
          </React.Fragment>
        ))}
      </nav>

      <main className={`shell-main${activeTab === 'code' ? ' shell-main--fullscreen' : ''}`}>
        {activeTab !== 'code' && (
          <div className="page-head">
            <h1>{tabDef?.label}</h1>
            <span className="page-sub">{pageSub(activeTab, hostName, hostUptime, updateCount)}</span>
          </div>
        )}
        {activeTab !== 'code' && <ErrorBoundary>{renderTab()}</ErrorBoundary>}
        <div style={{ display: activeTab === 'code' ? 'contents' : 'none' }}>
          <CodeHubTab isVisible={activeTab === 'code'} />
        </div>
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

        <TweakSection label="Wallpaper" />
        <TweakRadio
          label="Background"
          value={t.wallpaper || 'none'}
          options={['none', 'cosmic', 'sunset', 'cyber', 'custom']}
          onChange={(v) => setTweak('wallpaper', v)}
        />
        {t.wallpaper === 'custom' && (
          <TweakText
            label="Image URL"
            value={t.customWallpaperUrl || ''}
            placeholder="https://example.com/image.jpg"
            onChange={(v) => setTweak('customWallpaperUrl', v)}
          />
        )}
        {t.wallpaper !== 'none' && (
          <TweakSlider
            label="Blur amount"
            value={t.wallpaperBlur || 0}
            min={0}
            max={20}
            unit="px"
            onChange={(v) => setTweak('wallpaperBlur', v)}
          />
        )}

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
    case 'system':   return `${updateCount > 0 ? `${updateCount} updates · ` : ''}processes, packages, metrics, logs, network, units, cron`;
    case 'web':      return `Auto-discovered web UIs and manually added services`;
    case 'backend':  return `Internal TCP/UDP services bound to ports`;
    case 'docker':   return `Local Docker images and Compose stacks`;
    case 'agents':   return `AI coding agents detected on this host`;
    case 'samba':    return `Shares, users, connections and service control`;
    case 'files':    return `Browse, edit, copy, move and manage files`;
    case 'ssh':      return `Saved SSH connections, keys, and known_hosts`;
    case 'envfiles': return `Browse and edit .env files across projects`;
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
