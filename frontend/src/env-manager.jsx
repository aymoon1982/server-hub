import React, { useState } from 'react';
import axios from 'axios';

const SECRET_RE = /key|secret|token|pass|pwd|auth|credential|private|api/i;
const isSecret = key => SECRET_RE.test(key);

function EnvRow({ entry, idx, exampleKeys, showSecrets, onChangeKey, onChangeVal, onRemove }) {
  if (entry.type !== 'pair') return null;
  const secret = isSecret(entry.key);
  const inExample = exampleKeys.includes(entry.key);
  const dotColor = exampleKeys.length === 0 ? 'var(--line)' : inExample ? '#6dd49a' : '#f0c75a';

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 6px', borderRadius: 4 }}>
      <div title={inExample ? 'Key in .env.example' : exampleKeys.length ? 'Extra key (not in .env.example)' : ''}
        style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
      <input
        value={entry.key}
        onChange={e => onChangeKey(idx, e.target.value)}
        className="mono"
        style={KEY_INPUT}
        spellCheck={false}
      />
      <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>=</span>
      <input
        type={secret && !showSecrets ? 'password' : 'text'}
        value={entry.value}
        onChange={e => onChangeVal(idx, e.target.value)}
        className="mono"
        style={{ ...VAL_INPUT, color: secret ? '#f08a8a' : 'var(--text-1)' }}
        placeholder="(empty)"
        spellCheck={false}
      />
      {secret && <span title="Sensitive" style={{ fontSize: 12, flexShrink: 0 }}>🔑</span>}
      <button onClick={() => onRemove(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 16, padding: '0 4px', lineHeight: 1, flexShrink: 0 }} title="Remove">×</button>
    </div>
  );
}

export function EnvManagerTab() {
  const [dir, setDir]               = useState('/home/ayman/projects');
  const [scanning, setScanning]     = useState(false);
  const [files, setFiles]           = useState([]);
  const [selectedFile, setSelected] = useState(null);
  const [entries, setEntries]       = useState([]);
  const [exampleKeys, setExKeys]    = useState([]);
  const [saving, setSaving]         = useState(false);
  const [dirty, setDirty]           = useState(false);
  const [showSecrets, setShowSec]   = useState(false);

  const scan = () => {
    setScanning(true);
    setFiles([]);
    setSelected(null);
    setEntries([]);
    axios.get('/api/envfiles/find', { params: { dir } })
      .then(r => { setFiles(r.data.files || []); setScanning(false); })
      .catch(e => { window.UI?.toast({ kind: 'err', title: 'Scan failed', body: e.response?.data?.error || e.message }); setScanning(false); });
  };

  const openFile = (filePath) => {
    axios.get('/api/envfiles/read', { params: { path: filePath } })
      .then(r => { setSelected(filePath); setEntries(r.data.entries || []); setExKeys(r.data.exampleKeys || []); setDirty(false); })
      .catch(e => window.UI?.toast({ kind: 'err', title: 'Open failed', body: e.response?.data?.error || e.message }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await axios.post('/api/envfiles/save', { path: selectedFile, entries });
      setDirty(false);
      window.UI?.toast({ kind: 'ok', title: 'Saved', body: selectedFile });
    } catch (e) {
      window.UI?.toast({ kind: 'err', title: 'Save failed', body: e.response?.data?.error || e.message });
    }
    setSaving(false);
  };

  const changeKey = (idx, key) => { setEntries(prev => prev.map((e, i) => i === idx ? { ...e, key } : e)); setDirty(true); };
  const changeVal = (idx, value) => { setEntries(prev => prev.map((e, i) => i === idx ? { ...e, value } : e)); setDirty(true); };
  const removeRow = (idx) => { setEntries(prev => prev.filter((_, i) => i !== idx)); setDirty(true); };
  const addPair = () => { setEntries(prev => [...prev, { type: 'pair', key: 'NEW_KEY', value: '', quoted: false, raw: 'NEW_KEY=' }]); setDirty(true); };

  const pairs = entries.filter(e => e.type === 'pair');
  const missingKeys = exampleKeys.filter(k => !pairs.some(p => p.key === k));
  const displayDir = dir.replace(/^\/home\/[^/]+/, '~');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Directory scanner */}
      <div className="card" style={{ padding: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>Scan a directory for .env files</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={dir}
            onChange={e => setDir(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && scan()}
            placeholder="/path/to/project"
            style={{ ...SEARCH_INPUT, flex: 1 }}
          />
          <button className="btn-accent" onClick={scan} disabled={scanning}>
            {scanning ? <><span className="spinner" style={{ marginRight: 6 }} />Scanning…</> : '⌕ Find'}
          </button>
        </div>
        {files.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {files.map(f => (
              <button
                key={f}
                className={`chip ${selectedFile === f ? 'is-active' : ''}`}
                onClick={() => openFile(f)}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
                title={f}
              >
                {f.replace(dir.replace(/\/$/, '') + '/', '')}
              </button>
            ))}
          </div>
        )}
        {files.length === 0 && !scanning && dir && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Click Find to scan for .env files.</div>
        )}
      </div>

      {/* Editor */}
      {selectedFile && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Header bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedFile}
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: 'var(--text-3)', userSelect: 'none' }}>
              <input type="checkbox" checked={showSecrets} onChange={e => setShowSec(e.target.checked)} />
              Show secrets
            </label>
            <button className="btn-ghost" onClick={addPair} style={{ fontSize: 12 }}>+ Add key</button>
            <button className="btn-accent" onClick={save} disabled={saving || !dirty} style={{ fontSize: 12 }}>
              {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
          </div>

          {/* Missing keys warning */}
          {missingKeys.length > 0 && (
            <div style={{ padding: '8px 14px', background: 'rgba(240,199,90,0.08)', borderBottom: '1px solid var(--line)' }}>
              <span style={{ fontSize: 12, color: '#f0c75a' }}>⚠ Keys in .env.example but missing here: </span>
              <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>{missingKeys.join(', ')}</span>
            </div>
          )}

          {/* Legend */}
          {exampleKeys.length > 0 && (
            <div style={{ padding: '6px 14px', display: 'flex', gap: 14, borderBottom: '1px solid var(--line)', fontSize: 11 }}>
              <span><span style={{ color: '#6dd49a' }}>●</span> in .env.example</span>
              <span><span style={{ color: '#f0c75a' }}>●</span> extra key</span>
            </div>
          )}

          {/* Rows */}
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {entries.map((entry, idx) => (
              <EnvRow
                key={idx}
                entry={entry}
                idx={idx}
                exampleKeys={exampleKeys}
                showSecrets={showSecrets}
                onChangeKey={changeKey}
                onChangeVal={changeVal}
                onRemove={removeRow}
              />
            ))}
            {pairs.length === 0 && (
              <div className="muted" style={{ padding: '16px 6px', fontSize: 13 }}>File is empty — click "+ Add key" to add variables.</div>
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: '8px 14px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)' }}>
            <span>{pairs.length} variable{pairs.length !== 1 ? 's' : ''}</span>
            {dirty && <span style={{ color: '#f0c75a' }}>● unsaved changes</span>}
          </div>
        </div>
      )}
    </div>
  );
}

const SEARCH_INPUT = {
  padding: '6px 10px',
  background: 'var(--surface-3)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  fontSize: 13,
  color: 'var(--text-1)',
  outline: 'none',
  fontFamily: 'monospace',
};
const KEY_INPUT = {
  width: 200,
  flexShrink: 0,
  padding: '4px 8px',
  background: 'var(--surface-3)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  fontSize: 12,
  color: 'var(--text-1)',
  outline: 'none',
};
const VAL_INPUT = {
  flex: 1,
  padding: '4px 8px',
  background: 'var(--surface-3)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  fontSize: 12,
  outline: 'none',
};
