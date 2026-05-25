import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import { Modal } from './ui-bridge.jsx';

// ─── Samba: New / Edit Share modal ─────────────────────────────────────────
function ShareEditor({ share, onSave, onClose }) {
  const isEdit = !!share;
  const [name, setName] = useState(share?.name || '');
  const [path, setPath] = useState(share?.path || '');
  const [comment, setComment] = useState(share?.comment || '');
  const [readOnly, setReadOnly] = useState(share?.readOnly || false);
  const [guest, setGuest] = useState(share?.guest || false);
  const [users, setUsers] = useState(share?.users || []);
  const [browseable, setBrowseable] = useState(share?.browseable ?? true);
  const [hideDotfiles, setHideDotfiles] = useState(share?.hideDotfiles ?? true);
  const [recycle, setRecycle] = useState(share?.recycle ?? false);
  const [hostsAllow, setHostsAllow] = useState(share?.hostsAllow || '192.168.1.0/24');
  const [createMask, setCreateMask] = useState(share?.createMask || '0664');
  const [dirMask, setDirMask] = useState(share?.dirMask || '0775');
  const [advanced, setAdvanced] = useState(false);
  const [userInput, setUserInput] = useState('');
  const [allUsers, setAllUsers] = useState([]);
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    axios.get('/api/samba/users')
      .then(res => {
        if (Array.isArray(res.data.users)) {
          setAllUsers(res.data.users.map(u => u.name));
        } else if (Array.isArray(res.data)) {
          setAllUsers(res.data.map(u => u.name));
        }
      })
      .catch(() => {});
  }, []);

  const submit = async () => {
    if (!name.trim() || !path.trim()) {
      window.UI.toast({ kind: 'err', title: 'Missing fields', body: 'Name and path are required.' });
      return;
    }
    const payload = {
      name: name.trim(),
      path: path.trim(),
      comment,
      readOnly,
      guest,
      users,
      browseable,
      hideDotfiles,
      recycle,
      hostsAllow,
      createMask,
      dirMask,
    };
    try {
      await axios.post('/api/samba/shares', payload);
      window.UI.toast({ kind: 'ok', title: `Share ${isEdit ? 'updated' : 'created'}`, body: `//${window.location.hostname}/${name.trim()}` });
      if (onSave) onSave(payload);
      onClose();
    } catch (err) {
      window.UI.toast({ kind: 'err', title: 'Error saving share', body: err.response?.data?.error || err.message });
    }
  };

  const addUser = (u) => {
    if (!u || users.includes(u)) return;
    setUsers([...users, u]);
    setUserInput('');
  };

  return (
    <>
      <Modal
        title={isEdit ? `Edit share · ${share.name}` : 'New Samba share'}
        subtitle={isEdit ? share.path : 'Configure a new SMB share and its access controls'}
        icon={isEdit ? '✎' : '+'}
        onClose={onClose}
        size="lg"
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-accent" onClick={submit}>{isEdit ? 'Save & reload' : 'Create share'}</button>
          </>
        }
      >
        <div className="form-cols">
          <FormField label="Share name" hint="The name clients see (no spaces)">
            <input value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, '_').toLowerCase())} placeholder="media" autoFocus={!isEdit} disabled={isEdit} />
          </FormField>
          <FormField label="Path" hint="Absolute path on the host">
            <div className="path-input" style={{ display: 'flex', gap: '8px' }}>
              <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/storage/media" style={{ flex: 1 }} />
              <button type="button" className="btn-ghost sm" onClick={() => setBrowsing(true)}>Browse</button>
            </div>
          </FormField>
          <FormField label="Comment" hint="Description shown in network browser" span={2}>
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Family media library" />
          </FormField>
        </div>

        <SectionLabel>Access</SectionLabel>
        <div className="form-cols">
          <ToggleField label="Read-only" hint="Clients can browse but not write" value={readOnly} onChange={setReadOnly} />
          <ToggleField label="Guest access" hint="Allow connections without authentication" value={guest} onChange={setGuest} />
          <ToggleField label="Browseable" hint="List in the network neighborhood" value={browseable} onChange={setBrowseable} />
          <ToggleField label="Hide dotfiles" hint="Hide files starting with '.'" value={hideDotfiles} onChange={setHideDotfiles} />
        </div>

        <FormField label="Valid users" hint="Only these users can connect (empty = anyone authenticated)">
          <div className="user-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', marginTop: '4px' }}>
            {users.map(u => (
              <span key={u} className="user-chip mono" style={{ display: 'inline-flex', alignItems: 'center', background: 'var(--line)', padding: '2px 8px', borderRadius: '4px', gap: '6px' }}>
                {u}
                <button type="button" className="user-chip-x" onClick={() => setUsers(users.filter(x => x !== u))} aria-label={`Remove ${u}`} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
              </span>
            ))}
            <div className="user-add">
              <input
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addUser(userInput))}
                placeholder="add user…"
                list="samba-users"
                style={{ background: 'none', border: '1px solid var(--border)', borderRadius: '4px', padding: '2px 6px', width: '100px' }}
              />
              <datalist id="samba-users">
                {allUsers.filter(u => !users.includes(u)).map(u => <option key={u} value={u} />)}
              </datalist>
            </div>
          </div>
        </FormField>

        <FormField label="Hosts allow" hint="CIDR ranges or IPs, comma-separated (empty = any)">
          <input value={hostsAllow} onChange={(e) => setHostsAllow(e.target.value)} className="mono" placeholder="192.168.1.0/24" />
        </FormField>

        <button type="button" className="advanced-toggle" onClick={() => setAdvanced(!advanced)} style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '12px', padding: 0 }}>
          <span>{advanced ? '▾' : '▸'}</span> Advanced
        </button>
        {advanced && (
          <>
            <SectionLabel>Permissions & behavior</SectionLabel>
            <div className="form-cols">
              <FormField label="Create mask" hint="Octal permissions for new files">
                <input value={createMask} onChange={(e) => setCreateMask(e.target.value)} className="mono" />
              </FormField>
              <FormField label="Directory mask" hint="Octal permissions for new dirs">
                <input value={dirMask} onChange={(e) => setDirMask(e.target.value)} className="mono" />
              </FormField>
              <ToggleField label="Recycle bin" hint="Move deletions to .recycle/" value={recycle} onChange={setRecycle} />
            </div>
          </>
        )}
      </Modal>
      {browsing && (
        <div className="modal-backdrop" style={{ zIndex: 9000 }} onMouseDown={(e) => { if (e.target === e.currentTarget) setBrowsing(false); }}>
          <FolderSelectorModal
            initialPath={path || '/'}
            onSelect={(selectedPath) => { setPath(selectedPath); setBrowsing(false); }}
            onClose={() => setBrowsing(false)}
          />
        </div>
      )}
    </>
  );
}

// ─── Simple Folder Selector Modal for Share Editor ──────────────────────────
function FolderSelectorModal({ initialPath, onSelect, onClose }) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [parentPath, setParentPath] = useState(null);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadPath = async (p) => {
    setLoading(true);
    try {
      const res = await axios.get('/api/samba/browse', { params: { path: p } });
      setCurrentPath(res.data.currentPath);
      setParentPath(res.data.parentPath);
      setFolders(res.data.folders || []);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Read error', body: e.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPath(initialPath);
  }, [initialPath]);

  return (
    <Modal
      title="Select folder"
      subtitle={currentPath}
      onClose={onClose}
      size="md"
      footer={<>
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-accent" onClick={() => onSelect(currentPath)}>Choose this folder</button>
      </>}
    >
      <div className="folder-selector-list" style={{ maxHeight: '300px', overflowY: 'auto' }}>
        {parentPath && (
          <div
            className="folder-item parent"
            onClick={() => loadPath(parentPath)}
            style={{ padding: '8px', cursor: 'pointer', borderBottom: '1px solid var(--border)', display: 'flex', gap: '8px' }}
          >
            <span>▣</span> <b>.. (Go up)</b>
          </div>
        )}
        {loading ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
        ) : (
          folders.map(f => (
            <div
              key={f.name}
              className="folder-item"
              onClick={() => loadPath(f.path)}
              style={{ padding: '8px', cursor: 'pointer', borderBottom: '1px solid var(--border)', display: 'flex', gap: '8px' }}
            >
              <span>▣</span> {f.name}/
            </div>
          ))
        )}
        {!loading && folders.length === 0 && (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-3)' }}>No subfolders</div>
        )}
      </div>
    </Modal>
  );
}

// ─── Samba: Browse share modal ─────────────────────────────────────────────
function ShareBrowser({ share, onClose }) {
  const [cwd, setCwd] = useState(share.path);
  const [parentPath, setParentPath] = useState(null);
  const [folders, setFolders] = useState([]);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchFiles = async (p) => {
    setLoading(true);
    try {
      const res = await axios.get('/api/samba/browse', { params: { path: p, showHidden: true } });
      setCwd(res.data.currentPath);
      setParentPath(res.data.parentPath);
      setFolders(res.data.folders || []);
      setFiles(res.data.files || []);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Browse error', body: e.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles(share.path);
  }, [share.path]);

  const changePermissions = async (item) => {
    const mode = prompt(`Change permissions mode for "${item.name}" (octal):`, item.perm === '—' ? '0755' : '0755');
    if (!mode) return;
    if (!/^0?[0-7]{3,4}$/.test(mode.trim())) {
      window.UI.toast({ kind: 'err', title: 'Invalid mode', body: 'Mode must be an octal value like 0755 or 755.' });
      return;
    }
    try {
      await axios.post('/api/samba/permissions', { path: item.path, mode });
      window.UI.toast({ kind: 'ok', title: 'Permissions updated', body: item.name });
      fetchFiles(cwd);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed to set permissions', body: e.response?.data?.error || e.message });
    }
  };

  return (
    <Modal
      title={`Browse · //${window.location.hostname}/${share.name}`}
      subtitle={cwd}
      icon="▢"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={() => window.UI.toast({ kind: 'info', title: 'Upload', body: 'File upload is simulated' })}>↑ Upload</button>
          <button type="button" className="btn-ghost" onClick={() => window.UI.toast({ kind: 'ok', title: 'New folder' })}>+ Folder</button>
          <button type="button" className="btn-accent" onClick={onClose}>Done</button>
        </>
      }
    >
      <div className="browse-toolbar">
        <button type="button" className="btn-ghost sm" onClick={() => {
          if (parentPath) fetchFiles(parentPath);
        }} disabled={cwd === share.path || !parentPath}>← Up</button>
        <div className="crumbs mono">
          {cwd.split('/').filter(Boolean).map((p, i, arr) => {
            const crumbPath = arr.slice(0, i + 1).join('/');
            return (
              <React.Fragment key={crumbPath}>
                <span className="crumb-sep">/</span>
                <button type="button" className="crumb" onClick={() => fetchFiles('/' + crumbPath)}>{p}</button>
              </React.Fragment>
            );
          })}
        </div>
      </div>
      <div className="browse-list" style={{ maxHeight: '400px', overflowY: 'auto' }}>
        <div className="browse-head mono">
          <span></span><span>Name</span><span>Size</span><span>Modified</span><span>Permissions</span><span></span>
        </div>
        {loading ? (
          <div style={{ padding: '24px', textAlign: 'center' }}>Loading…</div>
        ) : (
          <>
            {folders.map(it => (
              <div key={it.name} className="browse-row is-dir" onDoubleClick={() => fetchFiles(it.path)}>
                <span className="file-icon">▣</span>
                <span className="file-name" style={{ cursor: 'pointer' }} onClick={() => fetchFiles(it.path)}>{it.name}/</span>
                <span className="mono muted">—</span>
                <span className="mono muted">{it.mtime}</span>
                <span className="mono muted">{it.perm}</span>
                <span className="browse-row-actions">
                  <button type="button" className="icon-btn" title="Permissions" onClick={() => changePermissions(it)}>⚙</button>
                  <button type="button" className="icon-btn" title="Delete" onClick={async () => {
                    const ok = await window.UI.confirm({
                      title: `Delete ${it.name}?`,
                      body: 'This folder will be permanently deleted.',
                      confirmLabel: 'Delete',
                      dangerous: true,
                    });
                    if (ok) window.UI.toast({ kind: 'info', title: 'Deleted', body: 'File deletions are read-only' });
                  }}>×</button>
                </span>
              </div>
            ))}
            {files.map(it => (
              <div key={it.name} className="browse-row">
                <span className="file-icon">▢</span>
                <span className="file-name">{it.name}</span>
                <span className="mono muted">{it.size}</span>
                <span className="mono muted">{it.mtime}</span>
                <span className="mono muted">{it.perm}</span>
                <span className="browse-row-actions">
                  <button type="button" className="icon-btn" title="Permissions" onClick={() => changePermissions(it)}>⚙</button>
                  <button type="button" className="icon-btn" title="Delete" onClick={async () => {
                    const ok = await window.UI.confirm({
                      title: `Delete ${it.name}?`,
                      body: 'This file will be permanently deleted.',
                      confirmLabel: 'Delete',
                      dangerous: true,
                    });
                    if (ok) window.UI.toast({ kind: 'info', title: 'Deleted', body: 'File deletions are read-only' });
                  }}>×</button>
                </span>
              </div>
            ))}
            {folders.length === 0 && files.length === 0 && (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-3)' }}>Empty directory</div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ─── Form atoms ────────────────────────────────────────────────────────────
function FormField({ label, hint, children, span }) {
  return (
    <label className={`fld ${span === 2 ? 'fld-span-2' : ''}`}>
      <span className="fld-label">{label}</span>
      {children}
      {hint && <span className="fld-hint">{hint}</span>}
    </label>
  );
}

function ToggleField({ label, hint, value, onChange }) {
  return (
    <div className="fld fld-toggle">
      <div className="fld-toggle-text">
        <span className="fld-label">{label}</span>
        {hint && <span className="fld-hint">{hint}</span>}
      </div>
      <button type="button" className={`switch ${value ? 'on' : ''}`} onClick={() => onChange(!value)} aria-pressed={value}>
        <span className="thumb" />
      </button>
    </div>
  );
}

function SectionLabel({ children }) {
  return <div className="section-label">{children}</div>;
}

// ─── System Updates ────────────────────────────────────────────────────────
function SystemUpdatesTab() {
  const [updates, setUpdates] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [running, setRunning] = useState(false);
  const [checking, setChecking] = useState(false);
  const [log, setLog] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [lastCheck, setLastCheck] = useState('—');
  const logEndRef = useRef(null);
  const logContainerRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const fetchUpdates = async () => {
    try {
      const res = await axios.get('/api/updates');
      const list = res.data.updates || [];
      setUpdates(list);
      setSelected(new Set(list.map(u => u.name)));
      setLastCheck(res.data.lastCheck || new Date().toLocaleTimeString());
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Load failed', body: e.message });
    }
  };

  useEffect(() => { fetchUpdates(); }, []);
  useEffect(() => {
    const c = logContainerRef.current;
    const nearBottom = !c || (c.scrollHeight - c.scrollTop - c.clientHeight) < 80;
    if (nearBottom) logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  const checkNow = async () => {
    setChecking(true);
    window.UI.toast({ kind: 'info', title: 'Running apt-get update…' });
    try {
      await axios.post('/api/updates/check');
      await fetchUpdates();
      window.UI.toast({ kind: 'ok', title: 'Package index refreshed' });
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Check failed', body: e.message });
    }
    setChecking(false);
  };

  const securityCount = updates.filter(u => u.kind === 'security').length;
  const kernelCount = updates.filter(u => u.kind === 'kernel').length;

  const toggle = (name) => {
    const s = new Set(selected);
    if (s.has(name)) s.delete(name); else s.add(name);
    setSelected(s);
  };

  const apply = async () => {
    const selectedList = updates.filter(u => selected.has(u.name));
    if (selectedList.length === 0) return;
    const isKernel = selectedList.some(u => u.kind === 'kernel');

    const ok = await window.UI.confirm({
      title: `Apply ${selected.size} update${selected.size === 1 ? '' : 's'}?`,
      body: isKernel
        ? 'A kernel update is included — a reboot will be required to activate the new kernel.'
        : 'Selected packages will be downloaded and installed via apt.',
      confirmLabel: 'Apply updates',
    });
    if (!ok) return;

    setRunning(true);
    setLog([]);
    setShowLog(true);

    try {
      const names = selectedList.map(u => u.name);
      const resp = await fetch('/api/updates/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packages: names }),
      });
      if (!resp.ok) { const err = await resp.json(); throw new Error(err.error || 'Failed'); }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          let parseFailed = false;
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const obj = JSON.parse(line.slice(6));
              if (obj.type === 'log' && mountedRef.current) setLog(prev => [...prev, obj.text]);
              if (obj.type === 'done') {
                if (mountedRef.current) setRunning(false);
                if (obj.code === 0) {
                  window.UI.toast({ kind: 'ok', title: 'Updates applied', body: `${names.length} package${names.length > 1 ? 's' : ''} updated${isKernel ? ' · Reboot recommended' : ''}`, ttl: 6000 });
                } else {
                  window.UI.toast({ kind: 'err', title: 'Some packages failed', body: `apt exit code ${obj.code}` });
                }
                fetchUpdates();
              }
            } catch {
              parseFailed = true;
            }
          }
          if (parseFailed) break;
        }
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    } catch (e) {
      if (mountedRef.current) setRunning(false);
      window.UI.toast({ kind: 'err', title: 'Install failed', body: e.message });
    }
  };

  return (
    <div className="tab-updates">
      <div className="updates-head">
        <div className="updates-stats">
          <div className="updates-stat">
            <div className="updates-stat-num mono">{updates.length}</div>
            <div className="updates-stat-lbl">total</div>
          </div>
          <div className="updates-stat warn">
            <div className="updates-stat-num mono">{securityCount}</div>
            <div className="updates-stat-lbl">security</div>
          </div>
          <div className="updates-stat accent">
            <div className="updates-stat-num mono">{kernelCount}</div>
            <div className="updates-stat-lbl">kernel</div>
          </div>
          <div className="updates-stat">
            <div className="updates-stat-num mono">{selected.size}</div>
            <div className="updates-stat-lbl">selected</div>
          </div>
        </div>
        <div className="updates-actions">
          <span className="muted mono updates-when">last check: {lastCheck}</span>
          <button type="button" className="btn-ghost" disabled={checking} onClick={checkNow}>{checking ? '↻ Checking…' : '↻ apt update'}</button>
          <button type="button" className="btn-ghost" onClick={() => setSelected(new Set(updates.map(u => u.name)))}>Select all</button>
          <button type="button" className="btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
          <button type="button" className="btn-accent" disabled={selected.size === 0 || running} onClick={apply}>
            {running ? '● Installing…' : `Apply ${selected.size} update${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>

      {showLog && log.length > 0 && (
        <div style={{ margin: '12px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <span className="mono muted" style={{ fontSize: '11px' }}>apt output {running && '● live'}</span>
            <button className="btn-ghost" style={{ fontSize: '10px', padding: '2px 8px' }} onClick={() => setShowLog(false)}>hide</button>
          </div>
          <pre ref={logContainerRef} style={{ fontFamily: 'monospace', fontSize: '11px', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: '8px', padding: '10px', maxHeight: '240px', overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}>
            {log.join('')}
            <span ref={logEndRef} />
          </pre>
        </div>
      )}

      <div className="updates-list">
        <div className="updates-list-head mono">
          <span></span><span>Package</span><span>Installed</span><span>Available</span><span>Repo</span><span>Type</span>
        </div>
        {updates.map(u => (
          <div key={u.name} className={`update-row ${selected.has(u.name) ? 'is-sel' : ''}`}>
            <input type="checkbox" checked={selected.has(u.name)} onChange={() => toggle(u.name)} />
            <button type="button" className="update-name">
              <span className="mono">{u.name}</span>
            </button>
            <span className="mono muted">{u.current}</span>
            <span className="mono">{u.next}</span>
            <span className="mono muted" style={{ fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.repo}</span>
            <span className={`kind-pill kind-${u.kind}`}>{u.kind}</span>
          </div>
        ))}
        {updates.length === 0 && (
          <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-3)' }}>
            {checking ? 'Checking for updates…' : 'System is up to date'}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SSH Keys ──────────────────────────────────────────────────────────────
function SSHKeysPanel() {
  const [keys, setKeys] = useState([]);
  const [revealed, setRevealed] = useState(null);

  const fetchKeys = async () => {
    try {
      const res = await axios.get('/api/ssh/keys');
      setKeys(res.data.keys || []);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Load keys failed', body: e.message });
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const generate = async () => {
    window.UI.modal(
      <GenerateKeyModal
        onCreate={() => {
          fetchKeys();
        }}
        onClose={() => window.UI.closeModal()}
      />
    );
  };

  const deploy = (key) => {
    window.UI.modal(<DeployKeyModal sshKey={key} onClose={() => window.UI.closeModal()} />);
  };

  const remove = async (key) => {
    const ok = await window.UI.confirm({
      title: `Delete key '${key.name}'?`,
      body: 'This key will be removed from this host. Any remote hosts still authorizing it will be unaffected.',
      confirmLabel: 'Delete key',
      dangerous: true,
    });
    if (ok) {
      try {
        await axios.delete(`/api/ssh/keys/${encodeURIComponent(key.id)}`);
        window.UI.toast({ kind: 'ok', title: 'Key removed', body: key.name });
        fetchKeys();
      } catch (e) {
        window.UI.toast({ kind: 'err', title: 'Delete failed', body: e.response?.data?.error || e.message });
      }
    }
  };

  return (
    <div className="ssh-keys">
      <div className="ssh-keys-head">
        <div>
          <h3>SSH keys</h3>
          <p className="muted">Generate, store and deploy SSH keys to remote hosts.</p>
        </div>
        <button type="button" className="btn-accent" onClick={generate}>+ Generate key</button>
      </div>
      <div className="key-list">
        {keys.map(k => (
          <div key={k.id} className="key-row">
            <div className="key-glyph mono">⚷</div>
            <div className="key-meta">
              <div className="key-name">
                <span className="mono">{k.name}</span>
                <span className="key-type">{k.type} · {k.bits}b</span>
              </div>
              <div className="key-fp mono muted">{k.fp}</div>
              <div className="key-extra mono muted">comment: {k.comment} · created {k.created} · used {k.lastUsed}</div>
            </div>
            <div className="key-actions">
              <button type="button" className="btn-ghost sm" onClick={() => deploy(k)}>Deploy →</button>
              <button type="button" className="btn-ghost sm" onClick={() => {
                navigator.clipboard?.writeText(k.pubContent).catch(() => {});
                window.UI.toast({ kind: 'ok', title: 'Public key copied', body: k.name });
              }}>Copy pub</button>
              <button type="button" className="btn-ghost sm" onClick={() => setRevealed(revealed === k.id ? null : k.id)}>{revealed === k.id ? 'Hide' : 'View'}</button>
              <button type="button" className="btn-ghost sm danger" onClick={() => remove(k)}>Delete</button>
            </div>
            {revealed === k.id && (
              <div className="key-reveal mono">
                <div className="muted">public key</div>
                <code style={{ wordBreak: 'break-all', display: 'block', padding: '6px', background: 'var(--line)', borderRadius: '4px' }}>{k.pubContent}</code>
              </div>
            )}
          </div>
        ))}
        {keys.length === 0 && (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-3)' }}>No keys found in ~/.ssh</div>
        )}
      </div>
    </div>
  );
}

function GenerateKeyModal({ onCreate, onClose }) {
  const [name, setName] = useState('id_new');
  const [type, setType] = useState('ED25519');
  const [bits, setBits] = useState(256);
  const [comment, setComment] = useState('ayman@server');
  const [passphrase, setPassphrase] = useState('');
  const [running, setRunning] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      window.UI.toast({ kind: 'err', title: 'Name required' });
      return;
    }
    setRunning(true);
    try {
      await axios.post('/api/ssh/keys/generate', {
        name: name.trim(),
        type,
        bits: type === 'ED25519' ? 256 : bits,
        comment: comment.trim(),
        passphrase
      });
      window.UI.toast({ kind: 'ok', title: 'Key generated', body: name.trim() });
      onCreate();
      onClose();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Generation failed', body: e.response?.data?.error || e.message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title="Generate SSH key"
      subtitle={`A new keypair will be stored in ~/.ssh/`}
      icon="⚷"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={running}>Cancel</button>
        <button type="button" className="btn-accent" onClick={submit} disabled={running}>{running ? 'Generating…' : 'Generate'}</button>
      </>}
    >
      <div className="form-cols">
        <FormField label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className="mono" disabled={running} /></FormField>
        <FormField label="Type">
          <div className="seg" style={{ display: 'flex', gap: '4px' }}>
            {['ED25519', 'RSA', 'ECDSA'].map(t => (
              <button type="button" key={t} className={`seg-btn ${type === t ? 'is-active' : ''}`} onClick={() => setType(t)} disabled={running} style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: '4px', background: type === t ? 'var(--accent)' : 'none', color: type === t ? '#000' : 'inherit', cursor: 'pointer' }}>{t}</button>
            ))}
          </div>
        </FormField>
        {type === 'RSA' && (
          <FormField label="Bits">
            <div className="seg" style={{ display: 'flex', gap: '4px' }}>
              {[2048, 3072, 4096].map(b => (
                <button type="button" key={b} className={`seg-btn ${bits === b ? 'is-active' : ''}`} onClick={() => setBits(b)} disabled={running} style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: '4px', background: bits === b ? 'var(--accent)' : 'none', color: bits === b ? '#000' : 'inherit', cursor: 'pointer' }}>{b}</button>
              ))}
            </div>
          </FormField>
        )}
        <FormField label="Comment" span={2}><input value={comment} onChange={(e) => setComment(e.target.value)} disabled={running} /></FormField>
        <FormField label="Passphrase" hint="Optional — protects the private key on disk" span={2}>
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="(none)" disabled={running} />
        </FormField>
      </div>
    </Modal>
  );
}

function DeployKeyModal({ sshKey, onClose }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [user, setUser] = useState('root');
  const [password, setPassword] = useState('');
  const [running, setRunning] = useState(false);

  const submit = async () => {
    const insecure = window.location.protocol !== 'https:' &&
                     window.location.hostname !== 'localhost' &&
                     window.location.hostname !== '127.0.0.1';
    if (insecure) {
      window.UI.toast({ kind: 'err', title: 'Insecure connection', body: 'Refusing to send credentials over plain HTTP. Use HTTPS.' });
      return;
    }
    if (!host) { window.UI.toast({ kind: 'err', title: 'Host required' }); return; }
    if (!password) { window.UI.toast({ kind: 'err', title: 'Password required' }); return; }
    if (!(port >= 1 && port <= 65535)) {
      window.UI.toast({ kind: 'err', title: 'Invalid port', body: 'Port must be between 1 and 65535.' });
      return;
    }
    setRunning(true);
    try {
      await axios.post('/api/ssh/keys/deploy', {
        keyId: sshKey.id,
        host,
        port,
        username: user,
        password
      });
      window.UI.toast({ kind: 'ok', title: 'Key deployed', body: `${sshKey.name} → ${user}@${host}` });
      onClose();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Deployment failed', body: e.response?.data?.error || e.message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={`Deploy '${sshKey.name}'`}
      subtitle="Appends the public key to ~/.ssh/authorized_keys on the remote host (ssh-copy-id)"
      icon="→"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={running}>Cancel</button>
        <button type="button" className="btn-accent" onClick={submit} disabled={running}>{running ? 'Deploying…' : 'Deploy'}</button>
      </>}
    >
      <div className="form-cols">
        <FormField label="Remote host"><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="prod.aymoon.dev" autoFocus className="mono" disabled={running} /></FormField>
        <FormField label="Port"><input type="number" value={port} onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          setPort(Number.isFinite(n) ? n : 22);
        }} className="mono" disabled={running} /></FormField>
        <FormField label="Remote user"><input value={user} onChange={(e) => setUser(e.target.value)} className="mono" disabled={running} /></FormField>
        <FormField label="Authentication" hint="One-time auth required to install the new key" span={2}>
          <div className="seg">
            <button type="button" className="seg-btn is-active" style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--accent)', color: '#000' }}>Password</button>
          </div>
        </FormField>
        <FormField label="Password" span={2}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" disabled={running} />
        </FormField>
      </div>
    </Modal>
  );
}

// ─── Power controls (menu) ─────────────────────────────────────────────────
function PowerMenu({ onClose }) {
  const power = async (action) => {
    onClose();
    const labels = {
      reboot: { title: 'Reboot system?', body: `The host will shut down and restart. Services will be unavailable for ~60s.`, confirmLabel: 'Reboot', dangerous: true },
      shutdown: { title: 'Shut down system?', body: `The host will power off. Remote access will be lost until physical power-on.`, confirmLabel: 'Shut down', dangerous: true },
      sleep: { title: 'Put system to sleep?', body: `The host will suspend to RAM. Wake-on-LAN required to resume.`, confirmLabel: 'Sleep', dangerous: false },
      logoff: { title: 'Log out dashboard?', body: `End your dashboard session. SSH and active services are unaffected.`, confirmLabel: 'Log out', dangerous: false },
    };
    const ok = await window.UI.confirm(labels[action]);
    if (ok) {
      try {
        if (action !== 'logoff') {
          await axios.post('/api/power', { action });
        }
        window.UI.toast({
          kind: action === 'logoff' ? 'info' : 'warn',
          title: ({ reboot: 'Rebooting…', shutdown: 'Shutting down…', sleep: 'Suspending…', logoff: 'Logged out' })[action],
          body: action === 'sleep' ? 'Send a magic packet to wake.' : action === 'logoff' ? 'Session ended.' : 'Connection will drop in a moment.',
          ttl: 6000,
        });
      } catch (err) {
        window.UI.toast({ kind: 'err', title: 'Power action failed', body: err.response?.data?.error || err.message });
      }
    }
  };
  return (
    <div className="power-menu" onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className="power-item" onClick={() => power('logoff')}>
        <span className="power-glyph">⎋</span>
        <div>
          <div className="power-name">Log out</div>
          <div className="power-sub muted">End dashboard session</div>
        </div>
      </button>
      <div className="power-sep" />
      <button type="button" className="power-item" onClick={() => power('sleep')}>
        <span className="power-glyph">☾</span>
        <div>
          <div className="power-name">Sleep</div>
          <div className="power-sub muted">Suspend to RAM</div>
        </div>
      </button>
      <button type="button" className="power-item" onClick={() => power('reboot')}>
        <span className="power-glyph">↻</span>
        <div>
          <div className="power-name">Reboot</div>
          <div className="power-sub muted">Restart the host</div>
        </div>
      </button>
      <button type="button" className="power-item danger" onClick={() => power('shutdown')}>
        <span className="power-glyph">⏻</span>
        <div>
          <div className="power-name">Shut down</div>
          <div className="power-sub muted">Power off the host</div>
        </div>
      </button>
    </div>
  );
}

// ─── Docker Images ─────────────────────────────────────────────────────────
function DockerImagesTab() {
  const [images, setImages] = useState([]);
  const [pulling, setPulling] = useState(false);
  const [pullImage, setPullImage] = useState('');
  const [pruning, setPruning] = useState(false);

  const load = () => axios.get('/api/docker/images').then(r => setImages(r.data.images || [])).catch(() => {});
  useEffect(() => { load(); }, []);

  const pull = async () => {
    if (!pullImage.trim()) return;
    setPulling(true);
    try {
      await axios.post('/api/docker/images/pull', { image: pullImage.trim() });
      window.UI.toast({ kind: 'ok', title: 'Image pulled', body: pullImage.trim() });
      setPullImage('');
      load();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Pull failed', body: e.response?.data?.error || e.message });
    }
    setPulling(false);
  };

  const remove = async (img) => {
    const tag = `${img.Repository}:${img.Tag}`;
    const ok = await window.UI.confirm({ title: 'Remove image?', body: tag, confirmLabel: 'Remove', dangerous: true });
    if (!ok) return;
    try {
      await axios.delete(`/api/docker/images/${encodeURIComponent(img.ID)}`);
      window.UI.toast({ kind: 'ok', title: 'Image removed', body: tag });
      load();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Remove failed', body: e.response?.data?.error || e.message });
    }
  };

  const prune = async () => {
    const ok = await window.UI.confirm({ title: 'Prune unused images?', body: 'All dangling images not referenced by any container will be deleted.', confirmLabel: 'Prune', dangerous: true });
    if (!ok) return;
    setPruning(true);
    try {
      const r = await axios.post('/api/docker/images/prune');
      window.UI.toast({ kind: 'ok', title: 'Prune complete', body: r.data.output?.trim()?.slice(0, 80) || 'Done' });
      load();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Prune failed', body: e.response?.data?.error || e.message });
    }
    setPruning(false);
  };

  const fmtDate = (s) => { try { return new Date(s).toLocaleDateString(); } catch { return s || '—'; } };

  return (
    <div className="tab-docker-images">
      <div className="services-toolbar">
        <div className="search" style={{ flex: 1 }}>
          <span className="search-icon">⊕</span>
          <input
            value={pullImage}
            onChange={e => setPullImage(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && pull()}
            placeholder="Pull image (e.g. nginx:latest, ubuntu:24.04)…"
          />
        </div>
        <button className="btn-accent" disabled={pulling || !pullImage.trim()} onClick={pull}>{pulling ? 'Pulling…' : 'Pull ↓'}</button>
        <button className="btn-ghost" onClick={load}>↻ Refresh</button>
        <button className="btn-ghost" disabled={pruning} onClick={prune}>{pruning ? 'Pruning…' : '⊘ Prune'}</button>
      </div>
      <div className="card" style={{ overflow: 'auto' }}>
        <table className="proc-table mono" style={{ width: '100%', fontSize: '12px' }}>
          <thead>
            <tr>
              <th style={{ width: '80px' }}>Status</th>
              <th>Repository</th>
              <th style={{ width: '100px' }}>Tag</th>
              <th style={{ width: '90px' }}>Image ID</th>
              <th style={{ width: '90px' }}>Created</th>
              <th style={{ width: '80px' }}>Size</th>
              <th style={{ width: '48px', textAlign: 'right' }}></th>
            </tr>
          </thead>
          <tbody>
            {images.map((img, i) => (
              <tr key={img.ID || i}>
                <td>
                  {img.inUse
                    ? <span title="Used by a container" style={{ padding: '1px 6px', borderRadius: '3px', fontSize: '10px', background: 'oklch(0.25 0.06 145)', border: '1px solid oklch(0.45 0.12 145)', color: 'oklch(0.75 0.15 145)' }}>in use</span>
                    : <span title="Not referenced by any container" style={{ padding: '1px 6px', borderRadius: '3px', fontSize: '10px', background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text-3)' }}>unused</span>
                  }
                </td>
                <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={img.Repository}>{img.Repository}</td>
                <td>
                  <span style={{ padding: '1px 5px', borderRadius: '3px', fontSize: '10px', background: img.Tag === 'latest' ? 'oklch(0.28 0.06 220)' : 'var(--surface-2)', border: '1px solid var(--line)', color: img.Tag === 'latest' ? 'oklch(0.78 0.1 220)' : 'var(--text-2)' }}>
                    {img.Tag || '<none>'}
                  </span>
                </td>
                <td className="muted" style={{ fontSize: '11px' }}>{img.ID?.replace('sha256:', '').slice(0, 12)}</td>
                <td className="muted">{fmtDate(img.CreatedAt || img.CreatedSince)}</td>
                <td>{img.Size}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="icon-btn" title="Remove" onClick={() => remove(img)} style={{ color: 'var(--err)' }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {images.length === 0 && <div className="empty muted" style={{ padding: 24 }}>No local Docker images found</div>}
      </div>
      <div className="mono muted" style={{ fontSize: '10px', marginTop: '6px' }}>{images.length} image{images.length !== 1 ? 's' : ''}</div>
    </div>
  );
}

// ─── Docker Compose Stacks ─────────────────────────────────────────────────
function StacksTab() {
  const [stacks, setStacks] = useState([]);
  const [scanDirs, setScanDirs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState({});
  const [expanded, setExpanded] = useState(null);
  const [detail, setDetail] = useState(null);
  const [editor, setEditor] = useState(null);
  const [logs, setLogs] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const load = async () => {
    setLoading(true);
    try {
      const r = await axios.get('/api/compose/stacks');
      if (!mountedRef.current) return;
      setStacks(r.data.stacks || []);
      setScanDirs(r.data.scanDirs || []);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed to load stacks', body: e.response?.data?.error || e.message });
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const loadDetail = async (project) => {
    try {
      const r = await axios.get(`/api/compose/stacks/${encodeURIComponent(project)}`);
      if (!mountedRef.current) return;
      setDetail(r.data);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed to load stack', body: e.response?.data?.error || e.message });
    }
  };

  const toggleExpand = (name) => {
    if (expanded === name) {
      setExpanded(null);
      setDetail(null);
    } else {
      setExpanded(name);
      setDetail(null);
      loadDetail(name);
    }
  };

  const action = async (project, act) => {
    if (act === 'down') {
      const ok = await window.UI.confirm({ title: 'Bring stack down?', body: `${project} containers will be stopped and removed.`, confirmLabel: 'Down', dangerous: true });
      if (!ok) return;
    }
    setBusy(b => ({ ...b, [project]: act }));
    try {
      const r = await axios.post(`/api/compose/stacks/${encodeURIComponent(project)}/action`, { action: act });
      window.UI.toast({ kind: 'ok', title: `${act} complete`, body: project });
      const out = (r.data.output || '').trim();
      if (out) console.log(`[${project} ${act}]\n${out}`);
      await load();
      if (expanded === project) await loadDetail(project);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: `${act} failed`, body: e.response?.data?.error || e.message });
    } finally {
      if (mountedRef.current) setBusy(b => { const n = { ...b }; delete n[project]; return n; });
    }
  };

  const viewFile = async (project) => {
    try {
      const r = await axios.get(`/api/compose/stacks/${encodeURIComponent(project)}/file`);
      setEditor({ project, path: r.data.path, content: r.data.content, original: r.data.content });
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Cannot read file', body: e.response?.data?.error || e.message });
    }
  };

  const saveFile = async () => {
    if (!editor) return;
    try {
      await axios.post(`/api/compose/stacks/${encodeURIComponent(editor.project)}/file`, { content: editor.content });
      window.UI.toast({ kind: 'ok', title: 'Saved', body: editor.path });
      setEditor(null);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Save failed', body: e.response?.data?.error || e.message });
    }
  };

  const viewLogs = async (project) => {
    setLogs({ project, content: 'Loading…' });
    try {
      const r = await axios.get(`/api/compose/stacks/${encodeURIComponent(project)}/logs`, { params: { tail: 500 } });
      setLogs({ project, content: r.data.logs || '(no output)' });
    } catch (e) {
      setLogs({ project, content: `Error: ${e.response?.data?.error || e.message}` });
    }
  };

  const statusBadge = (status) => {
    const s = (status || '').toLowerCase();
    let color = 'var(--text-3)', bg = 'var(--surface-2)';
    if (s.includes('running')) { color = 'oklch(0.75 0.15 145)'; bg = 'oklch(0.25 0.06 145)'; }
    else if (s.includes('exited') || s.includes('stopped')) { color = 'oklch(0.78 0.1 30)'; bg = 'oklch(0.25 0.06 30)'; }
    else if (s.includes('partial')) { color = 'oklch(0.8 0.12 80)'; bg = 'oklch(0.25 0.06 80)'; }
    return <span style={{ padding: '1px 6px', borderRadius: '3px', fontSize: '10px', background: bg, border: '1px solid var(--line)', color }}>{status || 'down'}</span>;
  };

  return (
    <div className="tab-stacks">
      <div className="services-toolbar">
        <div style={{ flex: 1 }} className="muted mono">
          {scanDirs.length > 0 ? `Scanning: ${scanDirs.join('  ·  ')}` : 'No scan directories configured'}
        </div>
        <button className="btn-ghost" onClick={load} disabled={loading}>{loading ? 'Loading…' : '↻ Refresh'}</button>
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        <table className="proc-table mono" style={{ width: '100%', fontSize: '12px' }}>
          <thead>
            <tr>
              <th style={{ width: '24px' }}></th>
              <th>Project</th>
              <th style={{ width: '120px' }}>Status</th>
              <th>Location</th>
              <th style={{ width: '320px', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {stacks.map((s) => (
              <React.Fragment key={s.name}>
                <tr style={{ cursor: 'pointer' }} onClick={() => toggleExpand(s.name)}>
                  <td>{expanded === s.name ? '▾' : '▸'}</td>
                  <td>{s.name}</td>
                  <td>{statusBadge(s.status)}</td>
                  <td className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 0 }} title={s.file || s.dir || ''}>{s.file || s.dir || '—'}</td>
                  <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn-ghost" disabled={!!busy[s.name]} onClick={() => action(s.name, 'up')} title="Bring up">{busy[s.name] === 'up' ? '…' : '▲ Up'}</button>
                    <button className="btn-ghost" disabled={!!busy[s.name]} onClick={() => action(s.name, 'restart')} title="Restart">{busy[s.name] === 'restart' ? '…' : '↻'}</button>
                    <button className="btn-ghost" disabled={!!busy[s.name]} onClick={() => action(s.name, 'pull')} title="Pull images">{busy[s.name] === 'pull' ? '…' : '↓'}</button>
                    <button className="btn-ghost" disabled={!!busy[s.name]} onClick={() => action(s.name, 'down')} style={{ color: 'var(--err)' }} title="Down">{busy[s.name] === 'down' ? '…' : '▼'}</button>
                  </td>
                </tr>
                {expanded === s.name && (
                  <tr>
                    <td colSpan={5} style={{ padding: 0 }}>
                      <div style={{ padding: '12px 16px', background: 'var(--surface-2)', borderTop: '1px solid var(--line)' }}>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                          {s.file && <button className="btn-ghost" onClick={() => viewFile(s.name)}>View / Edit compose</button>}
                          <button className="btn-ghost" onClick={() => viewLogs(s.name)}>Logs</button>
                        </div>
                        {!detail && <div className="muted">Loading services…</div>}
                        {detail && detail.name === s.name && (
                          detail.services.length === 0
                            ? <div className="muted">No services running. Press Up to start.</div>
                            : (
                              <table style={{ width: '100%', fontSize: '11px' }}>
                                <thead>
                                  <tr style={{ textAlign: 'left', color: 'var(--text-3)' }}>
                                    <th>Service</th>
                                    <th>Container</th>
                                    <th>Image</th>
                                    <th>State</th>
                                    <th>Ports</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {detail.services.map((sv) => (
                                    <tr key={sv.container || sv.name}>
                                      <td>{sv.name}</td>
                                      <td className="muted">{sv.container}</td>
                                      <td className="muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sv.image}>{sv.image}</td>
                                      <td>{statusBadge(sv.state)}</td>
                                      <td className="muted">{sv.ports || '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
        {stacks.length === 0 && !loading && (
          <div className="empty muted" style={{ padding: 24 }}>
            No compose stacks found. Place a <code>compose.yaml</code> under one of the scan directories above, or override with the <code>COMPOSE_SCAN_DIRS</code> env var.
          </div>
        )}
      </div>
      <div className="mono muted" style={{ fontSize: '10px', marginTop: '6px' }}>{stacks.length} stack{stacks.length !== 1 ? 's' : ''}</div>

      {editor && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setEditor(null)}>
          <div className="modal" style={{ width: 'min(900px, 90vw)', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-head">
              <div style={{ flex: 1 }}>
                <div>{editor.project}</div>
                <div className="muted mono" style={{ fontSize: 11 }}>{editor.path}</div>
              </div>
              <button className="icon-btn" onClick={() => setEditor(null)}>✕</button>
            </div>
            <textarea
              className="mono"
              value={editor.content}
              onChange={(e) => setEditor({ ...editor, content: e.target.value })}
              style={{ flex: 1, minHeight: 400, fontSize: 12, padding: 12, border: '1px solid var(--line)', borderRadius: 4, background: 'var(--surface-2)', color: 'var(--text-1)', resize: 'none' }}
              spellCheck={false}
            />
            <div className="modal-foot">
              <button className="btn-ghost" onClick={() => setEditor(null)}>Cancel</button>
              <button className="btn-accent" onClick={saveFile} disabled={editor.content === editor.original}>Save</button>
            </div>
          </div>
        </div>
      )}

      {logs && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setLogs(null)}>
          <div className="modal" style={{ width: 'min(900px, 90vw)', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-head">
              <div>Logs · {logs.project}</div>
              <button className="icon-btn" onClick={() => setLogs(null)}>✕</button>
            </div>
            <pre className="mono" style={{ flex: 1, minHeight: 400, maxHeight: '70vh', overflow: 'auto', padding: 12, fontSize: 11, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {logs.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export {
  ShareEditor, ShareBrowser,
  SystemUpdatesTab, SSHKeysPanel,
  DockerImagesTab,
  StacksTab,
  PowerMenu, FormField, ToggleField, SectionLabel,
};
