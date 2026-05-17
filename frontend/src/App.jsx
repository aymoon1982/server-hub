import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Server, 
  Box, 
  Globe, 
  RefreshCcw, 
  Terminal,
  Activity,
  ArrowUpRight,
  Shield,
  Cpu,
  Monitor,
  Zap,
  HardDrive,
  List,
  Thermometer
} from 'lucide-react';

const TempIndicator = ({ label, value, color }) => {
  const getTempColor = (t) => {
    if (t > 70) return '#ef4444'; // Red
    if (t > 55) return '#f59e0b'; // Amber
    return color || '#10b981'; // Green
  };

  return (
    <div className="temp-stat">
      <div className="temp-icon" style={{ color: getTempColor(value) }}>
        <Thermometer size={14} />
      </div>
      <span className="temp-label">{label}:</span>
      <span className="temp-value" style={{ color: getTempColor(value) }}>{value.toFixed(1)}°C</span>
    </div>
  );
};

const MetricCard = ({ label, value, unit, icon: Icon, color, raw, active, onClick }) => {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -5 }}
      onClick={onClick}
      className={`metric-card ${active ? 'active' : ''}`}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <div className="metric-header">
        <div className="metric-icon" style={{ backgroundColor: `${color}15`, color }}>
          <Icon size={18} />
        </div>
        <span className="metric-label">{label}</span>
      </div>
      <div className="metric-body">
        <div className="metric-value-wrapper">
          <span className="metric-value">{value.toFixed(1)}</span>
          <span className="metric-unit">{unit}</span>
        </div>
        <div className="metric-progress-bg">
          <motion.div 
            className="metric-progress-fill"
            initial={{ width: 0 }}
            animate={{ width: `${value}%` }}
            style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}40` }}
          />
        </div>
        {raw && <div className="metric-raw">{raw}</div>}
      </div>
      {active && <div className="metric-active-dot" style={{ backgroundColor: color }} />}
    </motion.div>
  );
};

const ProcessList = ({ title, data, unit, color }) => {
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="process-list-container"
    >
      <div className="process-list-header">
        <List size={18} />
        <span>{title}</span>
      </div>
      <div className="process-items">
        {data.map((proc, i) => (
          <div key={`${proc.name}-${i}`} className="process-item">
            <div className="proc-info">
              <span className="proc-rank">#{i + 1}</span>
              <span className="proc-name">{proc.name}</span>
            </div>
            <div className="proc-stats">
              <div className="proc-bar-bg">
                <div 
                  className="proc-bar-fill" 
                  style={{ width: `${Math.min(proc.val, 100)}%`, backgroundColor: color }} 
                />
              </div>
              <span className="proc-val">{proc.val.toFixed(1)}{unit}</span>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
};

const ServiceCard = ({ service }) => {
  return (
    <motion.div 
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      whileHover={{ y: -5, boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)' }}
      className="service-card"
    >
      <div className="card-header">
        <div className={`icon-box ${service.isWebUi ? 'web' : 'backend'}`}>
          {service.isWebUi ? <Globe size={22} /> : (service.type === 'docker' ? <Box size={22} /> : <Cpu size={22} />)}
        </div>
        <div className="status-indicator">
          <div className="dot active" />
          <span>Running</span>
        </div>
      </div>
      
      <div className="card-content">
        <div className="type-badge">{service.type === 'docker' ? 'Container' : 'Native Process'}</div>
        <h3>{service.displayName || service.name}</h3>
        <div className="port-info">
          <Terminal size={12} />
          <span>Port: {service.port}</span>
        </div>
        
        <div className="card-usage-stats">
          <div className="usage-item">
            <span className="usage-label">CPU</span>
            <div className="usage-bar-bg">
              <motion.div 
                className="usage-bar-fill cpu" 
                animate={{ width: `${Math.min(service.usage.cpu, 100)}%` }} 
              />
            </div>
            <span className="usage-val">{service.usage.cpu.toFixed(1)}%</span>
          </div>
          <div className="usage-item">
            <span className="usage-label">RAM</span>
            <div className="usage-bar-bg">
              <motion.div 
                className="usage-bar-fill ram" 
                animate={{ width: `${Math.min(service.usage.mem, 100)}%` }} 
              />
            </div>
            <span className="usage-val">{service.usage.mem.toFixed(1)}%</span>
          </div>
        </div>
      </div>

      {service.isWebUi ? (
        <a 
          href={service.url} 
          target="_blank" 
          rel="noopener noreferrer" 
          className="action-button web"
        >
          Launch Application <ArrowUpRight size={16} />
        </a>
      ) : (
        <div className="action-button backend">
          <Shield size={16} />
          <span>System Protected</span>
        </div>
      )}
    </motion.div>
  );
};

function App() {
  const [services, setServices] = useState([]);
  const [stats, setStats] = useState({ 
    cpu: 0, 
    ram: 0, 
    ramRaw: { used: 0, total: 0 },
    topCpu: [],
    topMem: [],
    temps: { cpu: 0, gpu: 0, disk: 0 }
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('web');
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const fetchServices = async () => {
    try {
      const response = await axios.get('/api/services');
      setServices(response.data);
      setLastUpdated(new Date());
      setError(null);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching services:', err);
      setError('Connection lost. Attempting to reconnect...');
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await axios.get('/api/stats');
      setStats(response.data);
    } catch (err) {
      console.error('Error fetching stats:', err);
    }
  };

  useEffect(() => {
    fetchServices();
    fetchStats();
    const serviceInterval = setInterval(fetchServices, 10000);
    const statsInterval = setInterval(fetchStats, 5000);
    return () => {
      clearInterval(serviceInterval);
      clearInterval(statsInterval);
    };
  }, []);

  const webServices = services.filter(s => s.isWebUi);
  const backendServices = services.filter(s => !s.isWebUi);
  const currentServices = activeTab === 'web' ? webServices : (activeTab === 'backend' ? backendServices : []);

  return (
    <div className="app-container">
      <div className="background-glow" />
      
      <main className="main-content">
        <header className="app-header">
          <div className="vitals-bar">
            <TempIndicator label="CPU" value={stats.temps.cpu} />
            <TempIndicator label="GPU" value={stats.temps.gpu} />
            <TempIndicator label="NVMe" value={stats.temps.disk} />
          </div>

          <div className="header-top">
            <div className="header-titles">
              <motion.div 
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                className="system-status"
              >
                <div className="pulse-dot" />
                <span>Infrastructure Monitoring</span>
              </motion.div>
              
              <motion.h1
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                Service <span className="text-gradient">Registry</span>
              </motion.h1>
            </div>

            <div className="metrics-grid">
              <MetricCard 
                label="CPU Load" 
                value={stats.cpu} 
                unit="%" 
                icon={Zap} 
                color="#3b82f6" 
                active={activeTab === 'cpu'}
                onClick={() => setActiveTab('cpu')}
              />
              <MetricCard 
                label="RAM Usage" 
                value={stats.ram} 
                unit="%" 
                icon={HardDrive} 
                color="#8b5cf6"
                raw={`${(stats.ramRaw.used / 1024).toFixed(1)}GB / ${(stats.ramRaw.total / 1024).toFixed(1)}GB`}
                active={activeTab === 'ram'}
                onClick={() => setActiveTab('ram')}
              />
            </div>
          </div>
          
          <motion.p 
            className="header-desc"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            Automated discovery of all active endpoints and system processes.
          </motion.p>
        </header>

        <nav className="nav-container">
          <div className="tabs-wrapper">
            <button 
              className={`nav-tab ${activeTab === 'web' ? 'active' : ''}`}
              onClick={() => setActiveTab('web')}
            >
              <Monitor size={18} />
              <span>Web Interfaces</span>
              <span className="count-badge">{webServices.length}</span>
            </button>
            <button 
              className={`nav-tab ${activeTab === 'backend' ? 'active' : ''}`}
              onClick={() => setActiveTab('backend')}
            >
              <Server size={18} />
              <span>Backend Services</span>
              <span className="count-badge">{backendServices.length}</span>
            </button>
            <button 
              className={`nav-tab ${activeTab === 'cpu' ? 'active' : ''}`}
              onClick={() => setActiveTab('cpu')}
            >
              <Zap size={18} />
              <span>CPU Status</span>
            </button>
            <button 
              className={`nav-tab ${activeTab === 'ram' ? 'active' : ''}`}
              onClick={() => setActiveTab('ram')}
            >
              <HardDrive size={18} />
              <span>RAM Status</span>
            </button>
          </div>
          
          <div className="refresh-status">
            {loading ? <RefreshCcw className="spinning" size={14} /> : <Activity size={14} />}
            <span>Auto-refreshing</span>
          </div>
        </nav>

        {error && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="error-banner"
          >
            {error}
          </motion.div>
        )}

        <div className="content-area">
          <AnimatePresence mode="wait">
            {activeTab === 'cpu' && (
              <ProcessList 
                key="cpu-list"
                title="Top CPU Consumers" 
                data={stats.topCpu} 
                unit="%" 
                color="#3b82f6" 
              />
            )}
            {activeTab === 'ram' && (
              <ProcessList 
                key="ram-list"
                title="Top RAM Consumers" 
                data={stats.topMem} 
                unit="%" 
                color="#8b5cf6" 
              />
            )}
            {(activeTab === 'web' || activeTab === 'backend') && (
              <motion.div 
                key="grid-view"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="grid-layout"
              >
                {currentServices.length > 0 ? (
                  currentServices.map((s) => (
                    <ServiceCard key={`${s.name}-${s.port}`} service={s} />
                  ))
                ) : (
                  !loading && (
                    <div className="empty-state">
                      <p>No active {activeTab} services detected.</p>
                    </div>
                  )
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <footer className="app-footer">
        <div className="footer-left">
          <Shield size={14} />
          <span>Secure Instance</span>
        </div>
        <div className="footer-right">
          <span>Last sync: {lastUpdated.toLocaleTimeString()}</span>
          <span className="version-tag">v2.4.0-PRO</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
