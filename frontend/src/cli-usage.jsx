import React, { useState, useEffect, useRef } from 'react';

const GAUGE_CIRCUMFERENCE = 251.2;

function UsageGauge({ percent, status, label }) {
  const offset = GAUGE_CIRCUMFERENCE - (percent / 100) * GAUGE_CIRCUMFERENCE;
  const color = percent > 50 ? '#10b981' : percent > 20 ? '#f59e0b' : '#ef4444';
  
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ position: 'relative', width: 120, height: 120, margin: '0 auto' }}>
        <svg viewBox="0 0 100 100" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="10" />
          <circle cx="50" cy="50" r="40" fill="none" stroke={color} strokeWidth="10" 
            strokeLinecap="round" strokeDasharray={GAUGE_CIRCUMFERENCE} strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 1s ease' }} />
        </svg>
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{percent}%</div>
          <div style={{ fontSize: '0.65rem', color: '#64748b' }}>quota</div>
        </div>
      </div>
      <div style={{ marginTop: 8, fontSize: '0.8rem', color: '#94a3b8' }}>{label}</div>
    </div>
  );
}

function StatusBadge({ status }) {
  const colors = {
    available: { bg: 'rgba(16,185,129,0.15)', text: '#10b981' },
    limited: { bg: 'rgba(239,68,68,0.15)', text: '#ef4444' },
    unknown: { bg: 'rgba(245,158,11,0.15)', text: '#f59e0b' },
  };
  const c = colors[status] || colors.unknown;
  
  return (
    <span style={{ 
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 12px', borderRadius: 20, fontSize: '0.8rem', fontWeight: 500,
      background: c.bg, color: c.text 
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.text }} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function UsageChart({ data }) {
  const max = Math.max(...(data || []), 1);
  
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 60, marginTop: 12 }}>
      {(data || []).map((v, i) => (
        <div key={i} style={{ 
          flex: 1, 
          background: '#3b82f6', 
          borderRadius: '2px 2px 0 0',
          height: `${Math.max((v / max) * 100, 3)}%`,
          opacity: 0.7,
          minWidth: 2,
        }} title={`${v} calls`} />
      ))}
    </div>
  );
}

export function CLIUsageTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  const fetchData = async () => {
    try {
      const res = await fetch('/api/usage-status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);
  
  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>
        Loading usage data...
      </div>
    );
  }
  
  if (error) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#ef4444' }}>
        Error: {error}
      </div>
    );
  }
  
  const claude = data?.claude || {};
  const agy = data?.agy || {};
  
  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 600, marginBottom: 8 }}>⚡ CLI Usage Dashboard</h2>
        <p style={{ color: '#64748b', fontSize: '0.9rem' }}>Claude Code & agy (Antigravity) usage monitoring</p>
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
        {/* Claude Code Card */}
        <div style={{ 
          background: '#111827', borderRadius: 12, padding: 20,
          border: '1px solid rgba(255,255,255,0.06)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{ 
              width: 36, height: 36, borderRadius: 8, 
              background: 'rgba(139,92,246,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>🟣</div>
            <div>
              <div style={{ fontWeight: 600 }}>Claude Code</div>
              <div style={{ fontSize: '0.75rem', color: '#64748b' }}>Sonnet & Opus agents</div>
            </div>
          </div>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <StatusBadge status={claude.status || 'unknown'} />
            {claude.status === 'limited' && claude.reset_estimate && (
              <span style={{ fontSize: '0.85rem', color: '#f59e0b', fontWeight: 500 }}>
                ⏱ {claude.reset_estimate}
              </span>
            )}
          </div>
          
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
            <UsageGauge percent={claude.quota_percent || 0} status={claude.status} label="quota remaining" />
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: '0.7rem', color: '#64748b' }}>Calls (24h)</div>
              <div style={{ fontSize: '1rem', fontWeight: 500 }}>{claude.total_calls_24h || 0}</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: '0.7rem', color: '#64748b' }}>Last Check</div>
              <div style={{ fontSize: '1rem', fontWeight: 500 }}>
                {claude.checked_at ? new Date(claude.checked_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '--'}
              </div>
            </div>
          </div>
          
          <UsageChart data={claude.hourly_calls} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={{ fontSize: '0.6rem', color: '#64748b' }}>24h ago</span>
            <span style={{ fontSize: '0.6rem', color: '#64748b' }}>Now</span>
          </div>
        </div>
        
        {/* agy Card */}
        <div style={{ 
          background: '#111827', borderRadius: 12, padding: 20,
          border: '1px solid rgba(255,255,255,0.06)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{ 
              width: 36, height: 36, borderRadius: 8, 
              background: 'rgba(59,130,246,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>🔵</div>
            <div>
              <div style={{ fontWeight: 600 }}>agy (Antigravity)</div>
              <div style={{ fontSize: '0.75rem', color: '#64748b' }}>Multi-model CLI</div>
            </div>
          </div>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <StatusBadge status={agy.status || 'unknown'} />
            {agy.status === 'limited' && agy.reset_estimate && (
              <span style={{ fontSize: '0.8rem', color: '#64748b' }}>⏱ {agy.reset_estimate}</span>
            )}
          </div>
          
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
            <UsageGauge percent={agy.quota_percent || 0} status={agy.status} label="quota remaining" />
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: '0.7rem', color: '#64748b' }}>Calls (24h)</div>
              <div style={{ fontSize: '1rem', fontWeight: 500 }}>{agy.total_calls_24h || 0}</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: '0.7rem', color: '#64748b' }}>Last Check</div>
              <div style={{ fontSize: '1rem', fontWeight: 500 }}>
                {agy.checked_at ? new Date(agy.checked_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '--'}
              </div>
            </div>
          </div>
          
          <UsageChart data={agy.hourly_calls} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={{ fontSize: '0.6rem', color: '#64748b' }}>24h ago</span>
            <span style={{ fontSize: '0.6rem', color: '#64748b' }}>Now</span>
          </div>
        </div>
      </div>
      
      <div style={{ textAlign: 'center', color: '#64748b', fontSize: '0.75rem', marginTop: 24 }}>
        Last updated: {data?.timestamp ? new Date(data.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--'}
      </div>
    </div>
  );
}
