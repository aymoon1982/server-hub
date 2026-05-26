const express = require('express');
const { exec, execFile, spawn } = require('child_process');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const url = require('url');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const fileUpload = require('express-fileupload');

function timingSafeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const A = Buffer.from(a);
    const B = Buffer.from(b);
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
}

const app = express();
const PORT = process.env.PORT || 80;
const pkg = require('./package.json');

const resolveTargetUser = () => {
    if (process.env.DASHBOARD_USER) return process.env.DASHBOARD_USER;
    try {
        const stat = fs.statSync(__dirname);
        if (stat.uid === 0) return 'root';
        const passwd = fs.readFileSync('/etc/passwd', 'utf8');
        for (const line of passwd.split('\n')) {
            const [name, , uid] = line.split(':');
            if (parseInt(uid, 10) === stat.uid) return name;
        }
    } catch (e) {}
    return process.env.SUDO_USER || os.userInfo().username || 'root';
};

const TARGET_USER = resolveTargetUser();
const AGENT_TOKEN = process.env.DASHBOARD_TERMINAL_TOKEN || null;
const SIGN_SECRET = process.env.DASHBOARD_SIGN_SECRET || (() => { const s = crypto.randomBytes(32).toString('hex'); console.warn('[sign] using ephemeral secret; set DASHBOARD_SIGN_SECRET for persistence'); return s; })();
const TRASH_DIR = path.resolve(process.env.DASHBOARD_TRASH_DIR || '/var/cache/hosted-dashboard/trash');
const WORKSPACES_FILE = process.env.DASHBOARD_WORKSPACES || '/var/lib/hosted-dashboard/workspaces.json';
const ALLOWED_ENV_PASSTHROUGH = ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','AZURE_OPENAI_API_KEY','OPENROUTER_API_KEY','MISTRAL_API_KEY','GROQ_API_KEY','XAI_API_KEY','DEEPSEEK_API_KEY','OLLAMA_HOST','EDITOR','VISUAL','PATH','HOME','USER','SHELL','LANG','LC_ALL','TERM','NODE_OPTIONS','GH_TOKEN','GITHUB_TOKEN','CLAUDE_CODE_USE_BEDROCK','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_REGION','AWS_PROFILE'];

const STATE_PATH = path.join(__dirname, 'data', 'state.json');
const ensureStateDir = () => {
    try { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); } catch (e) {}
};
const loadState = () => {
    try {
        const raw = fs.readFileSync(STATE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            manual: Array.isArray(parsed.manual) ? parsed.manual : [],
            history: parsed.history && typeof parsed.history === 'object' ? parsed.history : {},
            alerts: parsed.alerts && typeof parsed.alerts === 'object' ? parsed.alerts : { cpu: 90, ram: 90, disk: 90 },
            backups: Array.isArray(parsed.backups) ? parsed.backups : [],
        };
    } catch (e) {
        return { manual: [], history: {}, alerts: { cpu: 90, ram: 90, disk: 90 }, backups: [] };
    }
};
const state = loadState();
let saveTimer = null;
const saveState = () => {
    try {
        ensureStateDir();
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    } catch (e) {
        console.error('saveState failed', e.message);
    }
};
const saveStateDebounced = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveState(); }, 2000);
};
const newManualId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

app.use(cors());
app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
});
app.use(express.json());
app.use(fileUpload({
    createParentPath: true,
    defParamCharset: 'utf8'
}));

const runCommand = (cmd) => new Promise((resolve) => {
    exec(cmd, (error, stdout) => {
        if (error) {
            console.error(`Error executing command: ${cmd}`, error.message);
            return resolve('');
        }
        resolve(stdout);
    });
});

const runCommandThrow = (cmd) => new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            return reject(new Error(stderr || error.message));
        }
        resolve(stdout);
    });
});


const NON_HTTP_PORTS = new Set([
    22, 25, 53, 110, 143, 445, 465, 587, 993, 995,
    1433, 1521, 3306, 5432, 6379, 9092, 11211, 27017, 27018, 27019,
]);
const GENERIC_EXEC_NAMES = ['node', 'python', 'python3', 'MainThread', 'node-MainThread', 'deno', 'bun'];
const GENERIC_SCRIPT_NAMES = new Set(['index', 'main', 'server', 'app', 'run', 'start', 'cli']);
const SKIP_PATH_PARTS = new Set(['.', '..', 'src', 'dist', 'bin', '.bin', 'backend', 'frontend', 'node_modules', 'lib', '.local']);
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });

const DISCOVERY_TTL_MS = parseInt(process.env.DISCOVERY_TTL_MS || '30000', 10);
let discoveryCache = null;
let discoveryCacheTime = 0;
let inflightDiscovery = null;

// Background docker stats poller — avoids blocking service discovery with a 2s wait
let dockerStatsCache = {};
const refreshDockerStats = () => {
    exec("docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemPerc}}' 2>/dev/null", { timeout: 4000 }, (err, out) => {
        if (err || !out) return;
        const map = {};
        out.trim().split('\n').filter(Boolean).forEach(line => {
            const [name, cpu, mem] = line.split('|');
            if (name) map[name] = { cpu, mem };
        });
        dockerStatsCache = map;
    });
};
refreshDockerStats();
setInterval(refreshDockerStats, 8000);
let serviceProcessMap = {};
let nvidiaSmiFailing = false;
let lastNvidiaCheckTime = 0;

const getTemperatures = async () => {
    const temps = { cpu: 0, gpu: 0, disk: 0 };
    let gpuUtil = 0;
    try {
        const cpuTempRaw = await runCommand("cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -n 1");
        if (cpuTempRaw) temps.cpu = parseFloat(cpuTempRaw) / 1000;

        let gpuRaw = '';
        const now = Date.now();
        if (!nvidiaSmiFailing || (now - lastNvidiaCheckTime > 5 * 60 * 1000)) {
            try {
                gpuRaw = await runCommandThrow("nvidia-smi --query-gpu=temperature.gpu,utilization.gpu --format=csv,noheader,nounits 2>&1");
                nvidiaSmiFailing = false;
            } catch (e) {
                nvidiaSmiFailing = true;
                lastNvidiaCheckTime = now;
                if (!nvidiaSmiFailing) console.log('[nvidia] GPU monitoring disabled:', e.message.slice(0, 80));
            }
        }


        if (gpuRaw) {
            const lines = gpuRaw.trim().split('\n').filter(Boolean);
            let totalTemp = 0;
            let totalUtil = 0;
            for (const line of lines) {
                const [tempStr, utilStr] = line.split(',').map(s => s.trim());
                totalTemp += parseFloat(tempStr) || 0;
                totalUtil += parseFloat(utilStr) || 0;
            }
            if (lines.length > 0) {
                temps.gpu = totalTemp / lines.length;
                gpuUtil = totalUtil / lines.length;
            }
        }

        const hwmonNames = await runCommand("grep -l 'nvme' /sys/class/hwmon/hwmon*/name 2>/dev/null");
        if (hwmonNames) {
            const hwmonDir = path.dirname(hwmonNames.split('\n')[0]);
            const diskTempRaw = await runCommand(`cat ${hwmonDir}/temp1_input 2>/dev/null`);
            if (diskTempRaw) temps.disk = parseFloat(diskTempRaw) / 1000;
        }
    } catch (e) {}
    return { temps, gpuUtil };
};

const extractFaviconHref = (html) => {
    const a = html.match(/<link\b[^>]*?\brel=["'][^"']*icon[^"']*["'][^>]*?\bhref=["']([^"']+)["']/i);
    if (a) return a[1];
    const b = html.match(/<link\b[^>]*?\bhref=["']([^"']+)["'][^>]*?\brel=["'][^"']*icon[^"']*["']/i);
    if (b) return b[1];
    return null;
};

const probeProtocol = async (protocol, port) => {
    const cfg = {
        timeout: 400,
        validateStatus: () => true,
        maxRedirects: 2,
        headers: { Accept: 'text/html', 'User-Agent': 'ServiceProbe/1.0' },
    };
    if (protocol === 'https') cfg.httpsAgent = insecureHttpsAgent;
    try {
        const response = await axios.get(`${protocol}://127.0.0.1:${port}`, cfg);
        const contentType = response.headers['content-type'] || '';
        const isWebUi = contentType.includes('text/html') && response.status >= 200 && response.status < 400;
        if (isWebUi && typeof response.data === 'string') {
            const titleMatch = response.data.match(/<title>(.*?)<\/title>/i);
            const title = titleMatch?.[1]?.trim() || null;
            const faviconHref = extractFaviconHref(response.data);
            return { isWebUi: true, status: response.status, protocol, title, faviconHref };
        }
        return { isWebUi: false, status: response.status, protocol: null, title: null, faviconHref: null };
    } catch (e) {
        return null;
    }
};

const probePort = async (port) => {
    if (NON_HTTP_PORTS.has(port)) {
        return { isWebUi: false, status: 'skipped', protocol: null, title: null, faviconHref: null };
    }
    // Probe http and https in parallel — half the latency vs sequential
    const [httpRes, httpsRes] = await Promise.all([probeProtocol('http', port), probeProtocol('https', port)]);
    if (httpRes?.isWebUi) return httpRes;
    if (httpsRes?.isWebUi) return httpsRes;
    if (httpRes) return httpRes;
    if (httpsRes) return httpsRes;
    return { isWebUi: false, status: 'down', protocol: null, title: null, faviconHref: null };
};

const resolveProcessName = (pid, rawProcessName) => {
    let processName = rawProcessName;
    try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmdline) {
            const parts = cmdline.split('\0').filter(Boolean);
            if (parts.length > 0) {
                const execName = path.basename(parts[0]);
                const isGeneric = GENERIC_EXEC_NAMES.some(g => rawProcessName.includes(g) || execName.includes(g));
                if (isGeneric) {
                    const scriptArg = parts.slice(1).find(p => !p.startsWith('-'));
                    if (scriptArg) {
                        let bestName = path.basename(scriptArg).replace(/\.[^/.]+$/, '');
                        if (GENERIC_SCRIPT_NAMES.has(bestName.toLowerCase())) {
                            const segments = scriptArg.split('/');
                            for (let i = segments.length - 2; i >= 0; i--) {
                                const dir = segments[i];
                                if (dir && !SKIP_PATH_PARTS.has(dir.toLowerCase()) && !/^[0-9a-f]{8,}$/.test(dir)) {
                                    bestName = dir;
                                    break;
                                }
                            }
                        }
                        processName = bestName;
                    } else {
                        try {
                            const cwd = fs.realpathSync(`/proc/${pid}/cwd`);
                            const folder = path.basename(cwd);
                            if (folder && !SKIP_PATH_PARTS.has(folder.toLowerCase())) {
                                processName = folder;
                            }
                        } catch (e) {}
                    }
                }
            }
        }
    } catch (e) {}
    return processName;
};

const discoverServicesRaw = async () => {
    const services = [];
    const seenPorts = new Set();
    const newMap = {};

    const [dockerPsOut, ssOutput] = await Promise.all([
        runCommand("docker ps -a --format '{{.Names}}|{{.Ports}}|{{.Status}}|{{.Label \"com.docker.compose.project\"}}'"),
        runCommand("ss -tlnp"),
    ]);

    const statsMap = dockerStatsCache;

    dockerPsOut.split('\n').filter(Boolean).forEach(line => {
        const [rawName, portsInfo, statusInfo, composeProject] = line.split('|');
        const name = rawName.split('.')[0];
        const isRunning = (statusInfo || '').toLowerCase().startsWith('up');
        
        let health = null;
        if (statusInfo) {
            const m = statusInfo.match(/\((healthy|unhealthy|starting)\)/i);
            if (m) health = m[1].toLowerCase();
        }

        const stats = statsMap[rawName] || { cpu: '0%', mem: '0%' };
        const coreCount = os.cpus().length || 1;

        const containerData = {
            name,
            containerName: rawName,
            type: 'docker',
            isRunning,
            pid: null,
            usage: {
                cpu: isRunning ? (parseFloat(stats.cpu) || 0) / coreCount : 0,
                mem: isRunning ? (parseFloat(stats.mem) || 0) : 0
            },
            composeProject: composeProject && composeProject.trim() ? composeProject.trim() : null,
            health,
            port: null
        };

        const portMatches = (portsInfo || '').match(/:(\d+)->/g);
        if (portMatches && portMatches.length > 0) {
            portMatches.forEach(match => {
                const port = parseInt(match.replace(/[:->]/g, ''));
                if (!seenPorts.has(port)) {
                    services.push({
                        ...containerData,
                        port
                    });
                    seenPorts.add(port);
                }
            });
        } else {
            services.push(containerData);
        }
    });

    const ssLines = ssOutput.split('\n').slice(1);
    const pendingProcessLookups = [];
    for (const line of ssLines) {
        const portMatch = line.match(/:(\d+)\s+/);
        const processMatch = line.match(/users:\(\("([^"]+)",(?:.*?)pid=(\d+)/);
        if (!portMatch) continue;
        const port = parseInt(portMatch[1]);
        if (seenPorts.has(port) || port === parseInt(PORT)) continue;

        let processName = 'Unknown Process';
        let rawProcessName = '';
        let pid = null;
        if (processMatch) {
            rawProcessName = processMatch[1];
            pid = processMatch[2];
            processName = resolveProcessName(pid, rawProcessName);
            if (rawProcessName && processName) newMap[rawProcessName] = processName;
        }
        if (processName === 'node-MainThread' || processName === 'MainThread') processName = 'Node App';
        if (processName === 'python' || processName === 'python3') processName = 'Python App';
        if (processName && /^[a-z]/.test(processName)) processName = processName.charAt(0).toUpperCase() + processName.slice(1);
        if (port === 80 || port === parseInt(PORT)) processName = 'Hosted Dashboard';

        const service = { name: processName, port, type: 'process', pid, usage: { cpu: 0, mem: 0 } };
        services.push(service);
        seenPorts.add(port);
        if (pid) pendingProcessLookups.push(service);
    }

    await Promise.all(pendingProcessLookups.map(async (s) => {
        const psOutput = await runCommand(`ps -p ${s.pid} -o %cpu,%mem --no-headers`);
        if (psOutput) {
            const [cpu, mem] = psOutput.trim().split(/\s+/);
            const coreCount = os.cpus().length || 1;
            s.usage = { cpu: (parseFloat(cpu) || 0) / coreCount, mem: parseFloat(mem) || 0 };
        }
    }));

    const probed = await Promise.all(services.map(async (s) => ({
        ...s,
        ...(await probePort(s.port)),
    })));

    serviceProcessMap = newMap;
    return probed;
};

const runDiscoveryInBackground = () => {
    if (inflightDiscovery) return;
    inflightDiscovery = (async () => {
        try {
            const result = await discoverServicesRaw();
            discoveryCache = result;
            discoveryCacheTime = Date.now();
            return result;
        } finally {
            inflightDiscovery = null;
        }
    })();
    inflightDiscovery.catch(err => console.error('[discovery]', err && err.message));
};

const discoverServices = async () => {
    const now = Date.now();
    const cacheAge = now - discoveryCacheTime;

    // Fresh cache — return immediately
    if (discoveryCache && cacheAge < DISCOVERY_TTL_MS) {
        return discoveryCache;
    }

    // Stale cache — return stale data immediately and refresh in background
    if (discoveryCache) {
        runDiscoveryInBackground();
        return discoveryCache;
    }

    // No cache at all (first request) — must wait
    if (!inflightDiscovery) runDiscoveryInBackground();
    return inflightDiscovery;
};

const buildFaviconUrl = (host, port, protocol, href) => {
    if (!href || !protocol) return null;
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('//')) return `${protocol}:${href}`;
    if (href.startsWith('/')) return `${protocol}://${host}:${port}${href}`;
    return `${protocol}://${host}:${port}/${href}`;
};

app.get('/api/services', async (req, res) => {
    try {
        const host = req.get('host').split(':')[0];
        const rawServices = await discoverServices();
        const grouped = rawServices.reduce((acc, s) => {
            if (!acc[s.name]) {
                acc[s.name] = {
                    name: s.name,
                    containerName: s.containerName || s.name,
                    type: s.type,
                    ports: [],
                    isWebUi: false,
                    urls: [],
                    titles: [],
                    favicons: [],
                    usage: { cpu: 0, mem: 0 },
                    composeProject: null,
                    health: null,
                    isRunning: s.isRunning !== undefined ? s.isRunning : true,
                    _seenUsages: new Set(),
                };
            }
            if (s.port) {
                acc[s.name].ports.push(s.port);
            }
            if (s.isRunning === false) {
                acc[s.name].isRunning = false;
            }
            
            const usageKey = s.type === 'docker' ? `docker-${s.name}` : `pid-${s.pid}`;
            if (!acc[s.name]._seenUsages.has(usageKey)) {
                acc[s.name].usage.cpu += s.usage.cpu;
                acc[s.name].usage.mem += s.usage.mem;
                acc[s.name]._seenUsages.add(usageKey);
            }

            if (s.composeProject && !acc[s.name].composeProject) acc[s.name].composeProject = s.composeProject;
            if (s.health && !acc[s.name].health) acc[s.name].health = s.health;
            if (s.isWebUi && s.port) {
                acc[s.name].isWebUi = true;
                acc[s.name].urls.push(`${s.protocol}://${host}:${s.port}`);
                if (s.title) acc[s.name].titles.push(s.title);
                const fav = buildFaviconUrl(host, s.port, s.protocol, s.faviconHref);
                if (fav) acc[s.name].favicons.push(fav);
            }
            return acc;
        }, {});
        const results = Object.values(grouped).map(s => ({
            ...s,
            port: s.ports.length > 0 ? (s.ports.length > 1 ? s.ports.sort((a, b) => a - b).join(', ') : s.ports[0]) : '—',
            url: s.isWebUi ? s.urls[0] : null,
            favicon: s.isWebUi && s.favicons.length > 0 ? s.favicons[0] : null,
            displayName: s.isWebUi && s.titles.length > 0 ? s.titles[0] : s.name,
        }));

        const now = Date.now();
        for (const r of results) {
            const id = `auto|${r.name}|${r.port}`;
            const h = state.history[id] || (state.history[id] = { firstSeen: now, lastSeen: now });
            h.lastSeen = now;
            r.firstSeen = h.firstSeen;
            r.lastSeen = h.lastSeen;
        }

        for (const m of state.manual) {
            const id = `manual|${m.id}`;
            const h = state.history[id] || (state.history[id] = { firstSeen: now, lastSeen: now });
            h.lastSeen = now;
            results.push({
                name: m.name,
                type: 'manual',
                ports: [],
                port: m.port || '—',
                isWebUi: true,
                url: m.url,
                displayName: m.label || m.name,
                favicon: m.favicon || null,
                usage: { cpu: 0, mem: 0 },
                composeProject: null,
                health: null,
                isRunning: true,
                manualId: m.id,
                firstSeen: h.firstSeen,
                lastSeen: h.lastSeen,
            });
        }
        saveStateDebounced();
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch services' });
    }
});

app.post('/api/services/manual', (req, res) => {
    const { name, url: serviceUrl, label, port } = req.body || {};
    if (!name || !serviceUrl) {
        return res.status(400).json({ error: 'name and url are required' });
    }
    try { new URL(serviceUrl); }
    catch (e) { return res.status(400).json({ error: 'invalid url' }); }
    const id = newManualId();
    const entry = {
        id,
        name: String(name).slice(0, 80),
        url: String(serviceUrl).slice(0, 500),
        label: label ? String(label).slice(0, 80) : null,
        port: port ? String(port).slice(0, 30) : null,
        createdAt: Date.now(),
    };
    state.manual.push(entry);
    saveState();
    res.json({ ok: true, entry });
});

app.delete('/api/services/manual/:id', (req, res) => {
    const id = req.params.id;
    const before = state.manual.length;
    state.manual = state.manual.filter(m => m.id !== id);
    if (state.manual.length === before) {
        return res.status(404).json({ error: 'manual entry not found' });
    }
    delete state.history[`manual|${id}`];
    saveState();
    res.json({ ok: true });
});

app.post('/api/docker/control', async (req, res) => {
    const { name, action } = req.body || {};
    if (!name || !['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ error: 'Invalid name or action' });
    }
    try {
        await runCommand(`docker ${action} ${shellQuote(name)}`);
        discoveryCache = null; // Clear cache to show new status instantly
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/docker/logs', async (req, res) => {
    const { name } = req.query;
    if (!name) {
        return res.status(400).json({ error: 'Missing container name' });
    }
    try {
        const logs = await runCommand(`docker logs --tail 200 ${shellQuote(name)} 2>&1`);
        res.json({ logs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const getHostInfo = async () => {
    const hostInfo = {
        name: os.hostname(),
        distro: 'Linux',
        kernel: os.release(),
        uptime: '',
        ip: '127.0.0.1',
        cores: os.cpus().length || 1,
        threads: os.cpus().length || 1,
        cpuModel: os.cpus()[0]?.model || 'Generic CPU',
        ramTotal: Math.round(os.totalmem() / 1024 / 1024 / 1024),
        diskTotal: 0,
        version: pkg.version,
        dashboardUptime: formatDuration(process.uptime()),
    };

    try {
        if (fs.existsSync('/etc/os-release')) {
            const release = fs.readFileSync('/etc/os-release', 'utf8');
            const match = release.match(/^PRETTY_NAME="([^"]+)"/m) || release.match(/^NAME="([^"]+)"/m);
            if (match) hostInfo.distro = match[1];
        }
    } catch (e) {}

    try {
        const uptimeRaw = os.uptime();
        const days = Math.floor(uptimeRaw / 86400);
        const hours = Math.floor((uptimeRaw % 86400) / 3600);
        const mins = Math.floor((uptimeRaw % 3600) / 60);
        hostInfo.uptime = `${days}d ${hours}h ${mins}m`;
    } catch (e) {
        hostInfo.uptime = `${Math.floor(os.uptime() / 60)}m`;
    }

    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    hostInfo.ip = iface.address;
                    break;
                }
            }
            if (hostInfo.ip !== '127.0.0.1') break;
        }
    } catch (e) {}

    try {
        const dfOut = await runCommand("df -BG / | tail -n 1 | awk '{print $2}'");
        if (dfOut) {
            hostInfo.diskTotal = parseInt(dfOut.trim().replace('G', ''), 10) || 0;
        }
    } catch (e) {}

    return hostInfo;
};

const getDiskInfo = async () => {
    const list = [];
    try {
        const dfOut = await runCommand("df -h --output=source,fstype,target,used,size,pcent");
        if (dfOut) {
            const allowedTypes = new Set(['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'vfat', 'exfat', 'ntfs', 'ntfs-3g', 'fuseblk', 'cifs', 'nfs', 'nfs4', 'hfsplus', 'apfs']);
            dfOut.trim().split('\n').forEach((line, idx) => {
                if (idx === 0) return;
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 6) {
                    const source = parts[0];
                    const fstype = parts[1];
                    const mount = parts[2];
                    const usedStr = parts[3];
                    const totalStr = parts[4];
                    const pctStr = parts[5].replace('%', '');

                    const isPhysical = source.startsWith('/dev/') || allowedTypes.has(fstype);
                    const isSystem = mount.startsWith('/sys') || mount.startsWith('/run') || mount.startsWith('/dev') || mount.startsWith('/proc') || mount === '/boot/efi';

                    if (isPhysical && !isSystem) {
                        const parseSize = (str) => {
                            const val = parseFloat(str) || 0;
                            if (str.includes('T')) return Math.round(val * 1024);
                            if (str.includes('M')) return Math.round(val / 1024);
                            return Math.round(val);
                        };

                        list.push({
                            device: source,
                            fstype,
                            mount,
                            used: parseSize(usedStr),
                            total: parseSize(totalStr),
                            pct: parseInt(pctStr, 10) || 0
                        });
                    }
                }
            });
        }
    } catch (e) {}

    if (list.length === 0) {
        list.push({ device: '/dev/nvme0n1p2', fstype: 'ext4', mount: '/', used: 155, total: 233, pct: 71 });
    }
    return list;
};

let lastNetBytes = null;
let lastNetTime = null;

const getNetworkRates = async () => {
    let rxRate = 0;
    let txRate = 0;
    try {
        const netOut = await runCommand("cat /proc/net/dev | grep -v -E 'lo|face|Inter-' | awk '{rx+=$2; tx+=$10} END {print rx \"|\" tx}'");
        if (netOut) {
            const [rxStr, txStr] = netOut.trim().split('|');
            const rx = parseInt(rxStr, 10) || 0;
            const tx = parseInt(txStr, 10) || 0;
            const now = Date.now();
            if (lastNetBytes && lastNetTime) {
                const dt = (now - lastNetTime) / 1000;
                if (dt > 0.1) {
                    rxRate = ((rx - lastNetBytes.rx) * 8) / (1024 * 1024 * dt);
                    txRate = ((tx - lastNetBytes.tx) * 8) / (1024 * 1024 * dt);
                }
            }
            lastNetBytes = { rx, tx };
            lastNetTime = now;
        }
    } catch (e) {}
    return { rxMbps: parseFloat(rxRate.toFixed(1)), txMbps: parseFloat(txRate.toFixed(1)) };
};

const formatDuration = (seconds) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${days}d ${hours}h ${mins}m`;
};

let cachedTopFolders = [];
let isTopFoldersUpdating = false;

const updateTopFolders = async () => {
    if (isTopFoldersUpdating) return;
    isTopFoldersUpdating = true;
    try {
        const output = await runCommand("du -hx --max-depth=1 / 2>/dev/null | sort -rh | head -n 11");
        if (output) {
            const list = [];
            output.trim().split('\n').forEach((line, idx) => {
                if (idx === 0) return; // skip '/' itself
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    const size = parts[0];
                    const path = parts[1];
                    list.push({ path, size });
                }
            });
            cachedTopFolders = list.slice(0, 10);
        }
    } catch (err) {
        console.error("Error calculating top folders in background:", err);
    } finally {
        isTopFoldersUpdating = false;
    }
};

// Start top folders calculation every 10 minutes, and once on start
setTimeout(updateTopFolders, 2000);
setInterval(updateTopFolders, 10 * 60 * 1000);

const getTopFolders = async () => {
    return cachedTopFolders;
};

const getActiveInterfaceInfo = async () => {
    let iface = '';
    try {
        const routeOut = await runCommand("ip route show | grep default");
        if (routeOut) {
            const match = routeOut.match(/dev\s+(\S+)/);
            if (match) {
                iface = match[1];
            }
        }
        if (!iface) {
            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                if (name !== 'lo' && !name.startsWith('docker') && !name.startsWith('br-')) {
                    iface = name;
                    break;
                }
            }
        }
    } catch (e) {}

    if (!iface) {
        return {
            interface: 'unknown',
            type: 'Unknown',
            currentSpeed: 0,
            maxSpeed: 0,
        };
    }

    let type = 'Ethernet';
    let isWifi = false;
    let isVirtual = false;

    if (iface.startsWith('wl') || iface.startsWith('wlan')) {
        isWifi = true;
        type = 'Wi-Fi';
    } else if (iface.startsWith('lo') || iface.startsWith('docker') || iface.startsWith('br-') || iface.startsWith('veth') || iface.startsWith('tun') || iface.startsWith('tap') || iface.startsWith('wg')) {
        isVirtual = true;
        type = 'Virtual';
    }

    try {
        if (fs.existsSync(`/sys/class/net/${iface}/uevent`)) {
            const uevent = fs.readFileSync(`/sys/class/net/${iface}/uevent`, 'utf8');
            if (uevent.includes('DEVTYPE=wlan')) {
                isWifi = true;
                type = 'Wi-Fi';
            }
        }
    } catch (e) {}

    let currentSpeedVal = 0;
    let maxSpeedVal = 0;

    if (isWifi) {
        let linkQuality = 70;
        try {
            if (fs.existsSync('/proc/net/wireless')) {
                const wireless = fs.readFileSync('/proc/net/wireless', 'utf8');
                const lines = wireless.split('\n');
                for (const line of lines) {
                    if (line.includes(iface)) {
                        const parts = line.trim().split(/\s+/);
                        const qualVal = parseFloat(parts[2]);
                        if (!isNaN(qualVal)) {
                            linkQuality = qualVal;
                        }
                        break;
                    }
                }
            }
        } catch (e) {}

        maxSpeedVal = 433; // Baseline 802.11ac max speed
        currentSpeedVal = Math.round(maxSpeedVal * Math.min(1, Math.max(0.1, linkQuality / 70)));
    } else if (isVirtual) {
        currentSpeedVal = 10000;
        maxSpeedVal = 10000;
    } else {
        try {
            if (fs.existsSync(`/sys/class/net/${iface}/speed`)) {
                const speedStr = fs.readFileSync(`/sys/class/net/${iface}/speed`, 'utf8').trim();
                const speedInt = parseInt(speedStr, 10);
                if (!isNaN(speedInt) && speedInt > 0) {
                    currentSpeedVal = speedInt;
                    maxSpeedVal = speedInt >= 1000 ? speedInt : 1000;
                }
            }
        } catch (e) {}

        if (currentSpeedVal === 0) {
            currentSpeedVal = 1000;
            maxSpeedVal = 1000;
        }
    }

    return {
        interface: iface,
        type,
        currentSpeed: currentSpeedVal,
        maxSpeed: maxSpeedVal,
    };
};

let currentSystemStats = null;
let isStatsUpdating = false;

const collectStats = async () => {
    if (isStatsUpdating) return;
    isStatsUpdating = true;
    try {
        const [
            cpuOutput,
            memOutput,
            memDetailed,
            [cpuRawOut, memRawOut],
            tempsAndGpu,
            host,
            disk,
            net,
            netInfo
        ] = await Promise.all([
            runCommand("top -bn1 | grep 'Cpu(s)' | awk '{print $2 + $4}'"),
            runCommand("free -m | grep Mem | awk '{print ($3/$2)*100}'"),
            runCommand("free -m | grep Mem | awk '{print $3 \"|\" $2}'"),
            Promise.all([
                runCommand("ps -eo comm,pid,pcpu,pmem --sort=-pcpu | head -n 25 | tail -n 24"),
                runCommand("ps -eo comm,pid,pcpu,pmem --sort=-pmem | head -n 25 | tail -n 24")
            ]),
            getTemperatures(),
            getHostInfo(),
            getDiskInfo(),
            getNetworkRates(),
            getActiveInterfaceInfo()
        ]);

        const formatName = (name) => {
            const mapped = serviceProcessMap[name];
            if (mapped) return mapped;
            return name.length > 15 ? name.substring(0, 12) + '...' : name;
        };

        const coreCount = os.cpus().length || 1;
        const processMap = {};

        const parsePsOutput = (output) => {
            if (!output) return;
            output.trim().split('\n').filter(Boolean).forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 4) {
                    const comm = parts[0];
                    const pid = parts[1];
                    const cpuVal = (parseFloat(parts[2]) || 0) / coreCount;
                    const memVal = parseFloat(parts[3]) || 0;

                    if (pid === 'PID' || comm === 'COMMAND') return;

                    const cleanPid = parseInt(pid, 10);
                    if (!cleanPid) return;

                    if (!processMap[cleanPid]) {
                        processMap[cleanPid] = {
                            name: formatName(comm),
                            pid: cleanPid,
                            cpu: cpuVal,
                            mem: memVal,
                            gpu: 0
                        };
                    } else {
                        processMap[cleanPid].cpu = Math.max(processMap[cleanPid].cpu, cpuVal);
                        processMap[cleanPid].mem = Math.max(processMap[cleanPid].mem, memVal);
                    }
                }
            });
        };

        parsePsOutput(cpuRawOut);
        parsePsOutput(memRawOut);

        const now = Date.now();
        let nvidiaOutput = '';
        if (!nvidiaSmiFailing || (now - lastNvidiaCheckTime > 5 * 60 * 1000)) {
            try {
                nvidiaOutput = await runCommandThrow("nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>&1");
                nvidiaSmiFailing = false;
            } catch (e) {
                nvidiaSmiFailing = true;
                lastNvidiaCheckTime = now;
            }
        }


        if (nvidiaOutput) {
            nvidiaOutput.trim().split('\n').filter(Boolean).forEach(line => {
                const [pidStr, memStr] = line.split(',').map(s => s.trim());
                const pidVal = parseInt(pidStr, 10);
                const memVal = parseFloat(memStr) || 0;
                if (pidVal) {
                    if (processMap[pidVal]) {
                        processMap[pidVal].gpu = memVal;
                    } else {
                        processMap[pidVal] = {
                            name: `GPU App (${pidVal})`,
                            pid: pidVal,
                            cpu: 0,
                            mem: 0,
                            gpu: memVal
                        };
                    }
                }
            });
        }

        const sortedProcesses = Object.values(processMap)
            .sort((a, b) => (b.cpu + b.mem + (b.gpu ? (b.gpu / 100) : 0)) - (a.cpu + a.mem + (a.gpu ? (a.gpu / 100) : 0)))
            .slice(0, 20);

        const topCpu = sortedProcesses.map(p => ({ name: p.name, val: p.cpu }));
        const topMem = sortedProcesses.map(p => ({ name: p.name, val: p.mem }));

        const { temps, gpuUtil } = tempsAndGpu;
        const [usedMem, totalMem] = memDetailed.trim().split('|');

        currentSystemStats = {
            cpu: parseFloat(cpuOutput.trim()) || 0,
            ram: parseFloat(memOutput.trim()) || 0,
            ramRaw: { used: parseInt(usedMem), total: parseInt(totalMem) },
            gpu: gpuUtil,
            topCpu,
            topMem,
            processes: sortedProcesses,
            temps,
            host,
            disk,
            topFolders: cachedTopFolders,
            network: {
                rxMbps: net.rxMbps,
                txMbps: net.txMbps,
                sparkRx: currentSystemStats ? [...(currentSystemStats.network?.sparkRx || []).slice(1), Math.round(net.rxMbps)] : Array.from({ length: 24 }, () => Math.round(net.rxMbps)),
                sparkTx: currentSystemStats ? [...(currentSystemStats.network?.sparkTx || []).slice(1), Math.round(net.txMbps)] : Array.from({ length: 24 }, () => Math.round(net.txMbps)),
                interface: netInfo.interface,
                type: netInfo.type,
                currentSpeed: netInfo.currentSpeed,
                maxSpeed: netInfo.maxSpeed
            }
        };
    } catch (error) {
        console.error('Failed to gather stats in background:', error);
    } finally {
        isStatsUpdating = false;
    }
};

// Start background stats collection loop
setInterval(collectStats, 2000);
setTimeout(collectStats, 500);

app.get('/api/stats', async (req, res) => {
    try {
        if (currentSystemStats) {
            return res.json(currentSystemStats);
        }
        // Fallback for initial load
        await collectStats();
        if (currentSystemStats) {
            return res.json(currentSystemStats);
        }
        res.status(503).json({ error: 'Stats not ready yet' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        version: pkg.version,
        uptime: process.uptime(),
        targetUser: TARGET_USER,
        terminalTokenRequired: !!AGENT_TOKEN,
    });
});

const KNOWN_AGENTS = [
    { id: 'claude', label: 'Claude Code', cmd: 'claude', vendor: 'Anthropic' },
    { id: 'claude-code', label: 'Claude Code (alias)', cmd: 'claude-code', vendor: 'Anthropic' },
    { id: 'gemini', label: 'Gemini CLI', cmd: 'gemini', vendor: 'Google' },
    { id: 'antigravity', label: 'Antigravity', cmd: 'agy', vendor: 'Google DeepMind' },
    { id: 'codex', label: 'OpenAI Codex CLI', cmd: 'codex', vendor: 'OpenAI' },
    { id: 'opencode', label: 'OpenCode', cmd: 'opencode', vendor: 'SST' },
    { id: 'kilocode', label: 'Kilo Code', cmd: 'kilocode', vendor: 'Kilo' },
    { id: 'kilo', label: 'Kilo (alias)', cmd: 'kilo', vendor: 'Kilo' },
    { id: 'aider', label: 'Aider', cmd: 'aider', vendor: 'Aider' },
    { id: 'cursor-agent', label: 'Cursor Agent', cmd: 'cursor-agent', vendor: 'Cursor' },
    { id: 'cody', label: 'Sourcegraph Cody', cmd: 'cody', vendor: 'Sourcegraph' },
    { id: 'amp', label: 'Sourcegraph Amp', cmd: 'amp', vendor: 'Sourcegraph' },
    { id: 'cline', label: 'Cline', cmd: 'cline', vendor: 'Cline' },
    { id: 'qwen-code', label: 'Qwen Code', cmd: 'qwen-code', vendor: 'Alibaba' },
    { id: 'ollama', label: 'Ollama', cmd: 'ollama', vendor: 'Ollama' },
    { id: 'goose', label: 'Goose', cmd: 'goose', vendor: 'Block' },
];

const FALLBACK_SEARCH_DIRS = [
    '/home/linuxbrew/.linuxbrew/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
];

const AGENT_CACHE_TTL_MS = parseInt(process.env.AGENT_CACHE_TTL_MS || '3600000', 10);
let agentCache = null;
let agentCacheTime = 0;
let inflightAgentScan = null;

const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

const FILE_API_ROOT = path.resolve(process.env.FILE_API_ROOT || '/');
const FILE_API_DENY = ['/etc','/root','/boot','/usr','/var','/proc','/sys','/dev','/lib','/lib64','/sbin','/bin'];
function safeFilePath(p) {
    if (typeof p !== 'string' || !p) throw Object.assign(new Error('Invalid path'), { status: 400 });
    const abs = path.resolve(FILE_API_ROOT, p);
    if (!abs.startsWith(FILE_API_ROOT)) throw Object.assign(new Error('Path outside allowed root'), { status: 403 });
    if (FILE_API_DENY.some(d => abs === d || abs.startsWith(d + path.sep))) throw Object.assign(new Error('Path denied'), { status: 403 });
    return abs;
}
function errMsg(e) {
    return process.env.NODE_ENV === 'production' ? 'Internal error' : e.message;
}

const runAsUser = (user, cmd, timeoutMs = 2000) => new Promise((resolve) => {
    exec(`sudo -n -u ${shellQuote(user)} -- bash -lc ${shellQuote(cmd)}`, { timeout: timeoutMs }, (error, stdout, stderr) => {
        if (error && !stdout) return resolve('');
        resolve((stdout || '').toString());
    });
});

const runAsUserDirect = (user, cmd, args = [], timeoutMs = 2000) => new Promise((resolve) => {
    const sudoArgs = ['-n', '-u', user, '--', cmd, ...args];
    execFile('sudo', sudoArgs, { timeout: timeoutMs }, (error, stdout, stderr) => {
        const out = (stdout || stderr || '').toString();
        resolve(out);
    });
});

const getUserPathDirs = async (user) => {
    const raw = await runAsUser(user, 'echo "$PATH"', 1500);
    const dirs = raw.trim().split(':').filter(Boolean);
    for (const fallback of FALLBACK_SEARCH_DIRS) {
        if (!dirs.includes(fallback)) dirs.push(fallback);
    }
    return dirs;
};

const findExecutable = (dirs, name) => {
    for (const dir of dirs) {
        try {
            const p = path.join(dir, name);
            const stat = fs.statSync(p);
            if (stat.isFile() && (stat.mode & 0o111)) {
                let real = p;
                try { real = fs.realpathSync(p); } catch (e) {}
                return { path: p, realPath: real };
            }
        } catch (e) {}
    }
    return null;
};

const probeAgentVersion = async (user, absPath) => {
    const out = await runAsUserDirect(user, absPath, ['--version'], 4000);
    if (!out) return null;
    const m = out.match(/\d+\.\d+(?:\.\d+)?(?:[\w.+-]+)?/);
    return m ? m[0] : null;
};

const discoverAgentsRaw = async () => {
    const dirs = await getUserPathDirs(TARGET_USER);
    const seen = new Map();
    const found = [];
    for (const agent of KNOWN_AGENTS) {
        const hit = findExecutable(dirs, agent.cmd);
        if (!hit) continue;
        if (seen.has(hit.realPath)) {
            const existing = seen.get(hit.realPath);
            if (!existing.aliases.includes(agent.cmd)) existing.aliases.push(agent.cmd);
            continue;
        }
        const record = { ...agent, path: hit.path, realPath: hit.realPath, aliases: [], version: null };
        seen.set(hit.realPath, record);
        found.push(record);
    }
    await Promise.all(found.map(async (a) => {
        a.version = await probeAgentVersion(TARGET_USER, a.path);
    }));
    return found;
};

const discoverAgents = async () => {
    const now = Date.now();
    if (agentCache && (now - agentCacheTime) < AGENT_CACHE_TTL_MS) return agentCache;
    if (inflightAgentScan) return inflightAgentScan;
    inflightAgentScan = (async () => {
        try {
            const result = await discoverAgentsRaw();
            agentCache = result;
            agentCacheTime = Date.now();
            return result;
        } finally {
            inflightAgentScan = null;
        }
    })();
    inflightAgentScan.catch(err => console.error('[agent-discovery]', err && err.message));
    return inflightAgentScan;
};

app.get('/api/agents', async (req, res) => {
    try {
        const agents = await discoverAgents();
        res.json({ user: TARGET_USER, agents });
    } catch (e) {
        res.status(500).json({ error: 'Failed to discover agents' });
    }
});

const samba = require('./samba');

app.get('/api/samba/status', async (req, res) => {
    try {
        const status = await samba.getStatus();
        res.json(status);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/samba/status', async (req, res) => {
    const { action } = req.body || {};
    try {
        await samba.controlService(action);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/samba/shares', async (req, res) => {
    try {
        const shares = await samba.getShares();
        res.json(shares);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/samba/shares', async (req, res) => {
    const { name } = req.body || {};
    try {
        const result = await samba.saveShare(name, req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/samba/shares/:name', async (req, res) => {
    const { name } = req.params;
    try {
        const result = await samba.deleteShare(name);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/samba/global', async (req, res) => {
    try {
        const settings = await samba.getGlobalSettings();
        res.json(settings);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/samba/global', async (req, res) => {
    const { workgroup, serverString, mapToGuest } = req.body || {};
    try {
        const result = await samba.saveGlobalSettings({ workgroup, serverString, mapToGuest });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/samba/users', async (req, res) => {
    try {
        const users = await samba.getUsers();
        res.json(users);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/samba/users', async (req, res) => {
    const { username, password, createSystemUser } = req.body || {};
    try {
        const result = await samba.saveUser(username, password, createSystemUser);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/samba/users/:username', async (req, res) => {
    const { username } = req.params;
    try {
        const result = await samba.deleteUser(username);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/samba/connections', async (req, res) => {
    try {
        const connections = await samba.getConnections();
        res.json(connections);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/samba/permissions', async (req, res) => {
    const { path: dirPath, owner, mode } = req.body || {};
    try {
        const result = await samba.fixPermissions(dirPath, owner, mode);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/samba/logs', async (req, res) => {
    try {
        const logs = await samba.getLogs();
        res.json({ logs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/samba/browse', async (req, res) => {
    const { path: dirPath, showHidden } = req.query;
    try {
        const result = await samba.browse(dirPath, showHidden === 'true');
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Power Controls Endpoint
app.post('/api/power', (req, res) => {
    const { action } = req.body || {};
    if (!['reboot', 'shutdown', 'sleep', 'logoff'].includes(action)) {
        return res.status(400).json({ error: 'Invalid power action' });
    }
    res.json({ ok: true, message: `Power action ${action} initiated` });
    
    if (action === 'logoff') return;
    
    setTimeout(() => {
        let cmd = '';
        if (action === 'reboot') cmd = 'reboot';
        else if (action === 'shutdown') cmd = 'poweroff';
        else if (action === 'sleep') cmd = 'systemctl suspend';
        
        if (cmd) {
            exec(cmd, (err) => {
                if (err) console.error(`Failed to execute power action ${action}:`, err);
            });
        }
    }, 500);
});

const SECURITY_KEYWORDS = ['security', 'cve', 'openssl', 'openssh', 'libssl', 'libcrypto', 'kernel', 'linux-image', 'sudo', 'polkit', 'dbus', 'systemd', 'nss', 'curl', 'wget'];
const classifyUpdate = (name) => {
    const n = name.toLowerCase();
    if (n.includes('linux-image') || n.includes('linux-headers')) return 'kernel';
    if (SECURITY_KEYWORDS.some(k => n.includes(k))) return 'security';
    return 'standard';
};

let updatesCache = null;
let updatesCacheTime = 0;
const UPDATES_TTL = 60 * 1000;

app.get('/api/updates', async (req, res) => {
    const now = Date.now();
    if (updatesCache && (now - updatesCacheTime) < UPDATES_TTL && req.query.refresh !== '1') {
        return res.json(updatesCache);
    }
    try {
        const out = await runCommand("apt list --upgradable 2>/dev/null | grep -v '^Listing'");
        const updates = [];
        for (const line of out.trim().split('\n').filter(Boolean)) {
            const m = line.match(/^([^/]+)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from:\s+([^\]]+)\]/);
            if (m) {
                updates.push({
                    name: m[1],
                    repo: m[2],
                    next: m[3],
                    arch: m[4],
                    current: m[5].trim(),
                    kind: classifyUpdate(m[1]),
                });
            }
        }
        updatesCache = { updates, lastCheck: new Date().toLocaleTimeString() };
        updatesCacheTime = now;
        res.json(updatesCache);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/updates/check', async (req, res) => {
    try {
        await runCommand('apt-get update -q 2>/dev/null');
        updatesCache = null;
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/updates/apply', (req, res) => {
    const { packages } = req.body || {};
    if (!packages || !Array.isArray(packages) || packages.length === 0) {
        return res.status(400).json({ error: 'Packages must be a non-empty array' });
    }
    const safe = packages.every(p => /^[a-zA-Z0-9][a-zA-Z0-9_.+\-:~]*$/.test(p));
    if (!safe) return res.status(400).json({ error: 'Invalid package names' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
    const pkgList = packages.map(p => shellQuote(p)).join(' ');
    const proc = exec(`DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y ${pkgList} 2>&1`);
    proc.stdout?.on('data', (d) => send({ type: 'log', text: d.toString() }));
    proc.on('close', (code) => {
        updatesCache = null;
        send({ type: 'done', code });
        res.end();
    });
    req.on('close', () => { try { proc.kill(); } catch {} });
});

// SSH Keys Management Endpoints
app.get('/api/ssh/keys', async (req, res) => {
    try {
        const sshDir = '/home/ayman/.ssh';
        if (!fs.existsSync(sshDir)) {
            return res.json({ keys: [] });
        }
        const files = fs.readdirSync(sshDir);
        const keys = [];
        
        for (const file of files) {
            if (file.endsWith('.pub')) {
                const pubPath = path.join(sshDir, file);
                try {
                    const pubContent = fs.readFileSync(pubPath, 'utf8').trim();
                    const keygenOut = await runCommand(`ssh-keygen -l -f ${shellQuote(pubPath)}`);
                    if (keygenOut) {
                        const parts = keygenOut.trim().split(/\s+/);
                        const bits = parts[0];
                        const fp = parts[1];
                        const type = parts[parts.length - 1].replace(/[()]/g, '');
                        const comment = parts.slice(2, -1).join(' ') || 'no comment';
                        
                        const stats = fs.statSync(pubPath);
                        const created = stats.birthtime ? stats.birthtime.toISOString().slice(0, 10) : stats.mtime.toISOString().slice(0, 10);
                        
                        keys.push({
                            id: file,
                            name: file.slice(0, -4),
                            type,
                            bits: parseInt(bits, 10) || 256,
                            fp,
                            comment,
                            created,
                            lastUsed: 'never',
                            pubContent
                        });
                    }
                } catch (e) {
                    console.error(`Error parsing SSH key ${file}:`, e);
                }
            }
        }
        res.json({ keys });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ssh/keys/generate', async (req, res) => {
    const { name, type, bits, comment, passphrase } = req.body || {};
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name)) {
        return res.status(400).json({ error: 'Invalid key name' });
    }
    const keyType = ['rsa', 'ed25519', 'ecdsa'].includes(typeof type === 'string' ? type.toLowerCase() : '')
        ? type.toLowerCase()
        : 'ed25519';
    const bitsVal = parseInt(bits, 10) || 2048;
    const commentVal = typeof comment === 'string' ? comment.slice(0, 100) : 'hosted-dashboard-key';
    const passVal = typeof passphrase === 'string' ? passphrase : '';

    const keyPath = `/home/ayman/.ssh/${name}`;

    try {
        if (fs.existsSync(keyPath)) {
            return res.status(400).json({ error: 'Key file already exists' });
        }

        const args = ['-n', '-u', 'ayman', '--', 'ssh-keygen',
            '-t', keyType,
            '-C', commentVal,
            '-N', passVal,
            '-f', keyPath];
        if (keyType === 'rsa' || keyType === 'ecdsa') {
            args.push('-b', String(bitsVal));
        }

        await new Promise((resolve, reject) => {
            execFile('sudo', args, { timeout: 15000 }, (error, stdout, stderr) => {
                if (error) return reject(error);
                resolve(stdout);
            });
        });
        res.json({ ok: true, name });
    } catch (e) {
        res.status(500).json({ error: errMsg(e) });
    }
});

app.post('/api/ssh/keys/deploy', async (req, res) => {
    const { keyId, host, port, username, password } = req.body || {};
    if (!keyId || !host || !username) {
        return res.status(400).json({ error: 'keyId, host, and username are required' });
    }
    
    const pubPath = path.join('/home/ayman/.ssh', keyId);
    if (!fs.existsSync(pubPath)) {
        return res.status(400).json({ error: 'Public key file not found' });
    }
    
    try {
        const pubKeyContent = fs.readFileSync(pubPath, 'utf8').trim();
        const { Client } = require('ssh2');
        const conn = new Client();
        
        conn.on('ready', () => {
            const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo ${shellQuote(pubKeyContent)} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
            conn.exec(cmd, (err, stream) => {
                if (err) {
                    conn.end();
                    return res.status(500).json({ error: `Command exec failed: ${err.message}` });
                }
                stream.on('close', (code, signal) => {
                    conn.end();
                    if (code === 0) {
                        res.json({ ok: true });
                    } else {
                        res.status(500).json({ error: `Deployment exited with code ${code}` });
                    }
                });
                stream.stderr.on('data', (data) => {
                    console.error(`ssh deploy stderr: ${data}`);
                });
            });
        });
        
        conn.on('error', (err) => {
            res.status(500).json({ error: `SSH Connection Error: ${err.message}` });
        });
        
        conn.connect({
            host,
            port: parseInt(port, 10) || 22,
            username,
            password,
            readyTimeout: 10000
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/ssh/keys/:id', async (req, res) => {
    const id = req.params.id;
    if (!id.endsWith('.pub') || id.includes('/') || id.includes('\\')) {
        return res.status(400).json({ error: 'Invalid key ID' });
    }
    try {
        const pubPath = path.join('/home/ayman/.ssh', id);
        const privPath = pubPath.slice(0, -4);
        
        if (fs.existsSync(pubPath)) fs.unlinkSync(pubPath);
        if (fs.existsSync(privPath)) fs.unlinkSync(privPath);
        
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/samba/connections/:pid', async (req, res) => {
    const pid = req.params.pid;
    if (!/^\d+$/.test(pid)) {
        return res.status(400).json({ error: 'Invalid PID' });
    }
    try {
        await runCommand(`sudo kill -9 ${pid}`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/files/view', (req, res) => {
    let filePath;
    try { filePath = safeFilePath(req.query.path); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    try {
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            return res.status(400).json({ error: 'Path is a directory' });
        }
        
        const ext = path.extname(filePath).toLowerCase();
        const textExtensions = new Set(['.txt', '.log', '.conf', '.json', '.js', '.jsx', '.css', '.html', '.sh', '.py', '.yml', '.yaml', '.md', '.ini', '.cfg', '.xml', '.env']);
        const isText = textExtensions.has(ext) || ext === '';
        
        if (isText) {
            const content = fs.readFileSync(filePath, 'utf8');
            return res.json({ isText: true, content });
        } else {
            return res.sendFile(filePath);
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/files/save', (req, res) => {
    const { path: rawPath, content } = req.body || {};
    let filePath;
    try { filePath = safeFilePath(rawPath); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    try {
        fs.writeFileSync(filePath, content, 'utf8');
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Systemd Units ────────────────────────────────────────────────────────────
app.get('/api/systemd/units', async (req, res) => {
    try {
        const [unitsOut, failedOut] = await Promise.all([
            runCommand("systemctl list-units --type=service --all --plain --no-pager --no-legend 2>/dev/null"),
            runCommand("systemctl list-units --state=failed --plain --no-pager --no-legend 2>/dev/null"),
        ]);
        const failedSet = new Set();
        for (const line of failedOut.trim().split('\n').filter(Boolean)) {
            const parts = line.trim().split(/\s+/);
            if (parts[0]) failedSet.add(parts[0]);
        }
        const units = [];
        for (const line of unitsOut.trim().split('\n').filter(Boolean)) {
            let cleanLine = line.trim();
            if (cleanLine.startsWith('●') || cleanLine.startsWith('*')) {
                cleanLine = cleanLine.substring(1).trim();
            }
            const parts = cleanLine.split(/\s+/);
            if (parts.length < 4) continue;
            const unit = parts[0].trim();
            if (!unit) continue;
            units.push({
                unit,
                load: parts[1],
                active: parts[2],
                sub: parts[3],
                description: parts.slice(4).join(' '),
                failed: failedSet.has(unit),
            });
        }
        res.json({ units });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/systemd/control', async (req, res) => {
    const { unit, action } = req.body || {};
    if (!unit || !['start', 'stop', 'restart', 'enable', 'disable', 'reload'].includes(action)) {
        return res.status(400).json({ error: 'Invalid unit or action' });
    }
    if (!/^[a-zA-Z0-9@._\-]+\.service$/.test(unit) && !/^[a-zA-Z0-9@._\-]+$/.test(unit)) {
        return res.status(400).json({ error: 'Invalid unit name' });
    }
    try {
        const out = await runCommand(`sudo systemctl ${action} ${shellQuote(unit)} 2>&1`);
        res.json({ ok: true, output: out });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/systemd/logs/:unit', async (req, res) => {
    const { unit } = req.params;
    if (!/^[a-zA-Z0-9@._\-]+$/.test(unit)) return res.status(400).json({ error: 'Invalid unit name' });
    const n = Math.min(parseInt(req.query.n || '200', 10), 1000);
    const since = req.query.since || '';
    try {
        let cmd = `journalctl -u ${shellQuote(unit)} --no-pager -n ${n} --output=short-iso 2>/dev/null`;
        if (since) cmd = `journalctl -u ${shellQuote(unit)} --no-pager --since=${shellQuote(since)} --output=short-iso 2>/dev/null`;
        const logs = await runCommand(cmd);
        res.json({ logs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Process Manager ──────────────────────────────────────────────────────────
app.get('/api/processes', async (req, res) => {
    try {
        const sort = req.query.sort || 'cpu';
        const sortFlag = sort === 'mem' ? '-pmem' : '-pcpu';
        const out = await runCommand(`ps aux --sort=${sortFlag} 2>/dev/null | head -n 101 | tail -n 100`);
        const procs = [];
        for (const line of out.trim().split('\n').filter(Boolean)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 11 || parts[0] === 'USER') continue;
            const cmd = parts.slice(10).join(' ').slice(0, 120);
            if (/^ps\b/.test(cmd)) continue;
            procs.push({
                user: parts[0],
                pid: parseInt(parts[1], 10),
                cpu: parseFloat(parts[2]) || 0,
                mem: parseFloat(parts[3]) || 0,
                vsz: parts[4],
                rss: parts[5],
                stat: parts[7],
                started: parts[8],
                time: parts[9],
                cmd,
            });
        }
        res.json({ processes: procs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/processes/:pid/signal', async (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    if (!pid || pid <= 1 || isNaN(pid)) return res.status(400).json({ error: 'Invalid PID' });
    const { signal } = req.body || {};
    const sigMap = { SIGTERM: '15', SIGKILL: '9', SIGHUP: '1' };
    const sig = sigMap[signal];
    if (!sig) return res.status(400).json({ error: 'Invalid signal. Use SIGTERM, SIGKILL, or SIGHUP' });
    try {
        await runCommandThrow(`kill -${sig} ${pid} 2>&1`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/processes/:pid/nice', async (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    const nice = parseInt(req.body.nice, 10);
    if (!pid || isNaN(pid)) return res.status(400).json({ error: 'Invalid PID' });
    if (isNaN(nice) || nice < -20 || nice > 19) return res.status(400).json({ error: 'Nice must be -20..19' });
    try {
        await runCommandThrow(`renice -n ${nice} -p ${pid} 2>&1`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Docker Images ────────────────────────────────────────────────────────────
app.get('/api/docker/images', async (req, res) => {
    try {
        const [imagesOut, containersOut] = await Promise.all([
            runCommand("docker images --format '{{json .}}' 2>/dev/null"),
            runCommand("docker ps -a --format '{{.Image}}' 2>/dev/null"),
        ]);
        const usedImages = new Set();
        containersOut.trim().split('\n').filter(Boolean).forEach(imgRef => {
            usedImages.add(imgRef);
            // normalise: if no tag, also add :latest variant
            if (!imgRef.includes(':')) usedImages.add(`${imgRef}:latest`);
            // if has :latest, also add without tag
            if (imgRef.endsWith(':latest')) usedImages.add(imgRef.slice(0, -7));
        });
        const images = imagesOut.trim().split('\n').filter(Boolean).map(line => {
            try {
                const obj = JSON.parse(line);
                const fullRef = `${obj.Repository}:${obj.Tag}`;
                obj.inUse = usedImages.has(fullRef) || usedImages.has(obj.Repository);
                return obj;
            } catch { return null; }
        }).filter(Boolean);
        res.json({ images });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/docker/images/pull', async (req, res) => {
    const { image } = req.body || {};
    if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9_.+\-/:@]*$/.test(image)) {
        return res.status(400).json({ error: 'Invalid image name' });
    }
    try {
        const out = await runCommandThrow(`docker pull ${shellQuote(image)} 2>&1`);
        res.json({ ok: true, output: out });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/docker/images/:id', async (req, res) => {
    const { id } = req.params;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.+\-/:@]*$/.test(id)) {
        return res.status(400).json({ error: 'Invalid image id' });
    }
    try {
        await runCommandThrow(`docker rmi ${shellQuote(id)} 2>&1`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/docker/images/prune', async (req, res) => {
    try {
        const out = await runCommandThrow('docker image prune -f 2>&1');
        res.json({ ok: true, output: out });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Docker Compose Stacks ────────────────────────────────────────────────────
const COMPOSE_SCAN_DIRS = (process.env.COMPOSE_SCAN_DIRS || '/opt/stacks:/srv/stacks:/etc/docker/compose')
    .split(':').map(s => s.trim()).filter(Boolean).map(s => path.resolve(s));
const COMPOSE_FILENAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const RE_COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

function assertProject(name) {
    if (typeof name !== 'string' || !RE_COMPOSE_PROJECT.test(name)) {
        throw Object.assign(new Error('Invalid project name'), { status: 400 });
    }
}

function findComposeFileForProject(project) {
    for (const dir of COMPOSE_SCAN_DIRS) {
        const stackDir = path.join(dir, project);
        try {
            if (!fs.statSync(stackDir).isDirectory()) continue;
        } catch { continue; }
        for (const fname of COMPOSE_FILENAMES) {
            const file = path.join(stackDir, fname);
            try {
                if (!fs.statSync(file).isFile()) continue;
            } catch { continue; }
            const abs = path.resolve(file);
            if (!COMPOSE_SCAN_DIRS.some(d => abs === d || abs.startsWith(d + path.sep))) continue;
            return { dir: stackDir, file: abs };
        }
    }
    return null;
}

function scanFilesystemForStacks() {
    const stacks = [];
    for (const root of COMPOSE_SCAN_DIRS) {
        let entries;
        try { entries = fs.readdirSync(root, { withFileTypes: true }); }
        catch { continue; }
        for (const entry of entries) {
            if (!entry.isDirectory() || !RE_COMPOSE_PROJECT.test(entry.name)) continue;
            const dir = path.join(root, entry.name);
            for (const fname of COMPOSE_FILENAMES) {
                const file = path.join(dir, fname);
                try {
                    if (fs.statSync(file).isFile()) {
                        stacks.push({ name: entry.name, dir, file });
                        break;
                    }
                } catch {}
            }
        }
    }
    return stacks;
}

const runComposeCmd = (args, timeoutMs = 30000) => new Promise((resolve) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: stdout || '', stderr: stderr || (error ? error.message : '') });
    });
});

app.get('/api/compose/stacks', async (req, res) => {
    try {
        const lsRes = await runComposeCmd(['compose', 'ls', '-a', '--format', 'json']);
        const running = {};
        if (lsRes.ok && lsRes.stdout.trim()) {
            try {
                const parsed = JSON.parse(lsRes.stdout);
                if (Array.isArray(parsed)) {
                    for (const s of parsed) {
                        if (s.Name) running[s.Name] = s;
                    }
                }
            } catch {}
        }
        const fsStacks = scanFilesystemForStacks();
        const seen = new Set();
        const stacks = [];
        for (const s of fsStacks) {
            seen.add(s.name);
            const r = running[s.name];
            stacks.push({
                name: s.name,
                dir: s.dir,
                file: s.file,
                status: r?.Status || 'down',
                source: 'filesystem'
            });
        }
        for (const name of Object.keys(running)) {
            if (seen.has(name)) continue;
            stacks.push({
                name,
                dir: null,
                file: running[name].ConfigFiles || null,
                status: running[name].Status || 'unknown',
                source: 'docker'
            });
        }
        stacks.sort((a, b) => a.name.localeCompare(b.name));
        res.json({ stacks, scanDirs: COMPOSE_SCAN_DIRS });
    } catch (e) {
        res.status(500).json({ error: errMsg(e) });
    }
});

app.get('/api/compose/stacks/:project', async (req, res) => {
    try {
        assertProject(req.params.project);
        const project = req.params.project;
        const found = findComposeFileForProject(project);
        const psArgs = ['compose', '-p', project];
        if (found) psArgs.push('-f', found.file);
        psArgs.push('ps', '-a', '--format', 'json');
        const psRes = await runComposeCmd(psArgs);
        const services = [];
        if (psRes.ok && psRes.stdout.trim()) {
            for (const line of psRes.stdout.trim().split('\n')) {
                try {
                    const obj = JSON.parse(line);
                    services.push({
                        name: obj.Service || obj.Name,
                        container: obj.Name,
                        image: obj.Image,
                        state: obj.State,
                        status: obj.Status,
                        ports: Array.isArray(obj.Publishers) ? obj.Publishers.filter(p => p.PublishedPort).map(p => `${p.PublishedPort}:${p.TargetPort}/${p.Protocol}`).join(', ') : ''
                    });
                } catch {}
            }
        }
        res.json({
            name: project,
            dir: found?.dir || null,
            file: found?.file || null,
            services
        });
    } catch (e) {
        res.status(e.status || 500).json({ error: errMsg(e) });
    }
});

app.get('/api/compose/stacks/:project/file', async (req, res) => {
    try {
        assertProject(req.params.project);
        const found = findComposeFileForProject(req.params.project);
        if (!found) return res.status(404).json({ error: 'Compose file not found' });
        const stat = fs.statSync(found.file);
        if (stat.size > 1024 * 1024) return res.status(413).json({ error: 'Compose file too large' });
        const content = fs.readFileSync(found.file, 'utf8');
        res.json({ path: found.file, content });
    } catch (e) {
        res.status(e.status || 500).json({ error: errMsg(e) });
    }
});

app.post('/api/compose/stacks/:project/file', async (req, res) => {
    try {
        assertProject(req.params.project);
        const { content } = req.body || {};
        if (typeof content !== 'string') return res.status(400).json({ error: 'Missing content' });
        if (content.length > 1024 * 1024) return res.status(413).json({ error: 'Content too large' });
        const found = findComposeFileForProject(req.params.project);
        if (!found) return res.status(404).json({ error: 'Compose file not found' });
        const tmp = found.file + '.tmp.' + process.pid;
        fs.writeFileSync(tmp, content, { mode: 0o644 });
        fs.renameSync(tmp, found.file);
        res.json({ ok: true });
    } catch (e) {
        res.status(e.status || 500).json({ error: errMsg(e) });
    }
});

app.get('/api/compose/stacks/:project/logs', async (req, res) => {
    try {
        assertProject(req.params.project);
        const tail = Math.min(2000, Math.max(50, parseInt(req.query.tail, 10) || 200));
        const found = findComposeFileForProject(req.params.project);
        const args = ['compose', '-p', req.params.project];
        if (found) args.push('-f', found.file);
        args.push('logs', '--no-color', '--tail', String(tail));
        const out = await runComposeCmd(args, 30000);
        res.json({ logs: (out.stdout || '') + (out.stderr || '') });
    } catch (e) {
        res.status(e.status || 500).json({ error: errMsg(e) });
    }
});

app.post('/api/compose/stacks/:project/action', async (req, res) => {
    try {
        assertProject(req.params.project);
        const { action } = req.body || {};
        const allowed = new Set(['up', 'down', 'restart', 'pull', 'stop', 'start']);
        if (!allowed.has(action)) return res.status(400).json({ error: 'Invalid action' });
        const found = findComposeFileForProject(req.params.project);
        if (!found && action !== 'down' && action !== 'stop') {
            return res.status(404).json({ error: 'Compose file not found' });
        }
        const args = ['compose', '-p', req.params.project];
        if (found) args.push('-f', found.file);
        args.push(action);
        if (action === 'up') args.push('-d', '--remove-orphans');
        if (action === 'down') args.push('--remove-orphans');
        const out = await runComposeCmd(args, 10 * 60 * 1000);
        if (!out.ok) {
            return res.status(500).json({ error: (out.stderr || 'Command failed').slice(0, 4000) });
        }
        res.json({ ok: true, output: ((out.stdout || '') + (out.stderr || '')).slice(0, 8000) });
    } catch (e) {
        res.status(e.status || 500).json({ error: errMsg(e) });
    }
});

// ─── File Search / Archive / Trash / Signed Links / Workspaces ────────────────
const RE_SEARCH_TERM = /^[A-Za-z0-9._ \-+@*?]{1,80}$/;

app.get('/api/files/search', async (req, res) => {
    try {
        const root = safeFilePath(req.query.path || '/');
        const q = String(req.query.q || '').trim();
        if (!q || !RE_SEARCH_TERM.test(q)) return res.status(400).json({ error: 'Invalid query' });
        const max = Math.min(500, Math.max(1, parseInt(req.query.max, 10) || 200));
        const pattern = q.includes('*') || q.includes('?') ? q : `*${q}*`;
        execFile('find', [root, '-maxdepth', '8', '-iname', pattern, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'],
            { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
                const lines = (stdout || '').split('\n').filter(Boolean).slice(0, max);
                const matches = lines.map((line) => {
                    try {
                        const st = fs.statSync(line);
                        return { path: line, name: path.basename(line), isDir: st.isDirectory() };
                    } catch { return { path: line, name: path.basename(line), isDir: false }; }
                });
                res.json({ matches });
            });
    } catch (e) {
        res.status(e.status || 500).json({ error: errMsg(e) });
    }
});

app.post('/api/files/archive', async (req, res) => {
    try {
        const { action, paths, target } = req.body || {};
        if (!['compress', 'extract'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
        if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: 'Missing paths' });
        const safePaths = paths.map(p => safeFilePath(p));
        const safeTarget = target ? safeFilePath(target) : null;
        if (action === 'compress') {
            if (!safeTarget) return res.status(400).json({ error: 'Missing target' });
            const ext = safeTarget.toLowerCase();
            const dirOfFirst = path.dirname(safePaths[0]);
            const relPaths = safePaths.map(p => path.relative(dirOfFirst, p) || path.basename(p));
            let cmd, args;
            if (ext.endsWith('.zip')) { cmd = 'zip'; args = ['-r', safeTarget, ...relPaths]; }
            else if (ext.endsWith('.tar.gz') || ext.endsWith('.tgz')) { cmd = 'tar'; args = ['-czf', safeTarget, ...relPaths]; }
            else if (ext.endsWith('.tar.bz2') || ext.endsWith('.tbz2')) { cmd = 'tar'; args = ['-cjf', safeTarget, ...relPaths]; }
            else return res.status(400).json({ error: 'Unsupported archive format' });
            for (const p of safePaths) {
                try { if (fs.statSync(p).size > 2 * 1024 * 1024 * 1024) return res.status(413).json({ error: 'Source too large' }); } catch {}
            }
            execFile(cmd, args, { cwd: dirOfFirst, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) return res.status(500).json({ error: (stderr || err.message).slice(0, 4000) });
                res.json({ ok: true, output: ((stdout || '') + (stderr || '')).slice(0, 8000), target: safeTarget });
            });
        } else {
            if (safePaths.length !== 1) return res.status(400).json({ error: 'Extract needs exactly one source' });
            if (!safeTarget) return res.status(400).json({ error: 'Missing target' });
            try { fs.mkdirSync(safeTarget, { recursive: true }); } catch {}
            const src = safePaths[0].toLowerCase();
            let cmd, args;
            if (src.endsWith('.zip')) { cmd = 'unzip'; args = ['-o', safePaths[0], '-d', safeTarget]; }
            else if (src.endsWith('.tar.gz') || src.endsWith('.tgz')) { cmd = 'tar'; args = ['-xzf', safePaths[0], '-C', safeTarget]; }
            else if (src.endsWith('.tar.bz2') || src.endsWith('.tbz2')) { cmd = 'tar'; args = ['-xjf', safePaths[0], '-C', safeTarget]; }
            else if (src.endsWith('.tar')) { cmd = 'tar'; args = ['-xf', safePaths[0], '-C', safeTarget]; }
            else return res.status(400).json({ error: 'Unsupported archive format' });
            execFile(cmd, args, { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) return res.status(500).json({ error: (stderr || err.message).slice(0, 4000) });
                res.json({ ok: true, output: ((stdout || '') + (stderr || '')).slice(0, 8000), target: safeTarget });
            });
        }
    } catch (e) {
        res.status(e.status || 500).json({ error: errMsg(e) });
    }
});

function ensureTrashDir() {
    try { fs.mkdirSync(TRASH_DIR, { recursive: true, mode: 0o700 }); } catch {}
}

app.post('/api/files/trash', (req, res) => {
    try {
        ensureTrashDir();
        const { path: p, paths } = req.body || {};
        const list = Array.isArray(paths) ? paths : (p ? [p] : []);
        if (list.length === 0) return res.status(400).json({ error: 'Missing path(s)' });
        const results = [];
        for (const item of list) {
            const safe = safeFilePath(item);
            const rand = crypto.randomBytes(4).toString('hex');
            const id = `${Date.now()}-${rand}-${path.basename(safe).replace(/[^A-Za-z0-9._\- ]/g, '_').slice(0, 200)}`;
            const dest = path.join(TRASH_DIR, id);
            const metaPath = dest + '.meta.json';
            try {
                const stat = fs.statSync(safe);
                fs.renameSync(safe, dest);
                fs.writeFileSync(metaPath, JSON.stringify({
                    id, originalPath: safe, deletedAt: Date.now(),
                    sizeBytes: stat.size, isDir: stat.isDirectory(),
                    mode: stat.mode, mtimeMs: stat.mtimeMs,
                }), { mode: 0o600 });
                results.push({ id, originalPath: safe });
            } catch (e) {
                results.push({ originalPath: safe, error: e.message });
            }
        }
        res.json({ ok: true, trashed: results });
    } catch (e) {
        res.status(e.status || 500).json({ error: errMsg(e) });
    }
});

app.get('/api/files/trash', (req, res) => {
    try {
        ensureTrashDir();
        const entries = fs.readdirSync(TRASH_DIR)
            .filter(name => name.endsWith('.meta.json'))
            .map(name => {
                try {
                    const meta = JSON.parse(fs.readFileSync(path.join(TRASH_DIR, name), 'utf8'));
                    return meta;
                } catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
            .slice(0, 500);
        res.json({ entries });
    } catch (e) {
        res.status(500).json({ error: errMsg(e) });
    }
});

app.post('/api/files/restore', (req, res) => {
    try {
        const { id } = req.body || {};
        if (typeof id !== 'string' || !/^[0-9]+-[a-f0-9]{8}-[A-Za-z0-9._\- ]{1,255}$/.test(id)) {
            return res.status(400).json({ error: 'Invalid id' });
        }
        const dest = path.join(TRASH_DIR, id);
        const metaPath = dest + '.meta.json';
        if (!fs.existsSync(dest) || !fs.existsSync(metaPath)) return res.status(404).json({ error: 'Not found' });
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const target = safeFilePath(meta.originalPath);
        if (fs.existsSync(target)) return res.status(409).json({ error: 'Destination exists' });
        fs.renameSync(dest, target);
        try { fs.unlinkSync(metaPath); } catch {}
        res.json({ ok: true, restoredTo: target });
    } catch (e) {
        res.status(e.status || 500).json({ error: errMsg(e) });
    }
});

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64').toString('utf8');
}

app.post('/api/files/sign', (req, res) => {
    try {
        const { path: p, ttl } = req.body || {};
        const safe = safeFilePath(p);
        if (!fs.statSync(safe).isFile()) return res.status(400).json({ error: 'Not a regular file' });
        const ttlSec = Math.min(86400, Math.max(60, parseInt(ttl, 10) || 3600));
        const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
        const sig = crypto.createHmac('sha256', SIGN_SECRET).update(`${safe}|${expiresAt}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 24);
        const token = `${expiresAt}.${b64url(safe)}.${sig}`;
        res.json({ url: `/d/${token}`, expiresAt });
    } catch (e) {
        res.status(e.status || 500).json({ error: errMsg(e) });
    }
});

app.get('/d/:token', (req, res) => {
    try {
        const parts = String(req.params.token).split('.');
        if (parts.length !== 3) return res.status(404).end();
        const expiresAt = parseInt(parts[0], 10);
        if (!Number.isFinite(expiresAt) || Date.now() / 1000 > expiresAt) return res.status(410).json({ error: 'Link expired' });
        let filePath;
        try { filePath = b64urlDecode(parts[1]); } catch { return res.status(404).end(); }
        const expected = crypto.createHmac('sha256', SIGN_SECRET).update(`${filePath}|${expiresAt}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 24);
        if (!timingSafeCompare(parts[2], expected)) return res.status(404).end();
        const safe = safeFilePath(filePath);
        if (!fs.statSync(safe).isFile()) return res.status(404).end();
        res.download(safe);
    } catch (e) {
        res.status(404).end();
    }
});

// ─── Workspaces (Web IDE) ──────────────────────────────────────────────────────
const RE_WORKSPACE_NAME = /^[A-Za-z0-9_. \-]{1,64}$/;
const RE_ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;

function ensureWorkspacesFile() {
    try { fs.mkdirSync(path.dirname(WORKSPACES_FILE), { recursive: true }); } catch {}
    if (!fs.existsSync(WORKSPACES_FILE)) {
        fs.writeFileSync(WORKSPACES_FILE, JSON.stringify({ workspaces: [] }, null, 2), { mode: 0o600 });
    }
}
function loadWorkspaces() {
    ensureWorkspacesFile();
    try {
        const data = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'));
        return Array.isArray(data.workspaces) ? data.workspaces : [];
    } catch { return []; }
}
function saveWorkspaces(list) {
    ensureWorkspacesFile();
    const tmp = WORKSPACES_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ workspaces: list }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, WORKSPACES_FILE);
}
function validateWorkspacePayload(body, partial = false) {
    const out = {};
    if (body.name !== undefined || !partial) {
        if (typeof body.name !== 'string' || !RE_WORKSPACE_NAME.test(body.name)) throw Object.assign(new Error('Invalid name'), { status: 400 });
        out.name = body.name;
    }
    if (body.cwd !== undefined || !partial) {
        const safeCwd = safeFilePath(body.cwd);
        if (!fs.existsSync(safeCwd) || !fs.statSync(safeCwd).isDirectory()) throw Object.assign(new Error('cwd is not a directory'), { status: 400 });
        out.cwd = safeCwd;
    }
    if (body.agent !== undefined) {
        if (body.agent === null || body.agent === '') out.agent = null;
        else {
            const ag = sanitizeAgent(body.agent);
            out.agent = ag ? ag.id : null;
        }
    }
    if (body.env !== undefined) {
        if (body.env && typeof body.env === 'object' && !Array.isArray(body.env)) {
            const clean = {};
            const keys = Object.keys(body.env).slice(0, 32);
            for (const k of keys) {
                if (!RE_ENV_KEY.test(k)) continue;
                const v = body.env[k];
                if (typeof v !== 'string' || v.length > 4096) continue;
                clean[k] = v;
            }
            out.env = clean;
        } else out.env = {};
    }
    if (body.openFiles !== undefined) {
        if (Array.isArray(body.openFiles)) {
            out.openFiles = body.openFiles.filter(p => typeof p === 'string').slice(0, 64);
        } else out.openFiles = [];
    }
    return out;
}

// ── Agent Scheduled Jobs ─────────────────────────────────────────────────────
const AGENT_JOBS_FILE = process.env.AGENT_JOBS_FILE || '/var/lib/hosted-dashboard/agent-jobs.json';
const AJ_MAX_RUNS = 25;
const AJ_MAX_OUTPUT = 256 * 1024; // 256 KB per run

function ensureJobsFile() {
    try { fs.mkdirSync(path.dirname(AGENT_JOBS_FILE), { recursive: true }); } catch {}
    if (!fs.existsSync(AGENT_JOBS_FILE)) {
        fs.writeFileSync(AGENT_JOBS_FILE, JSON.stringify({ jobs: [] }, null, 2), { mode: 0o600 });
    }
}
function loadJobs() {
    ensureJobsFile();
    try { const d = JSON.parse(fs.readFileSync(AGENT_JOBS_FILE, 'utf8')); return Array.isArray(d.jobs) ? d.jobs : []; }
    catch { return []; }
}
function saveJobs(list) {
    ensureJobsFile();
    const tmp = AGENT_JOBS_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ jobs: list }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, AGENT_JOBS_FILE);
}

const ajRunning = new Map(); // jobId -> { proc, runId, buf }

function ajBuildCmd(agentId, task) {
    switch (agentId) {
        case 'claude':
        case 'claude-code': return { cmd: 'claude',   args: ['--dangerously-skip-permissions', '--print', task], stdin: null };
        case 'gemini':      return { cmd: 'gemini',   args: ['-p', task, '--yolo'],                              stdin: null };
        case 'aider':       return { cmd: 'aider',    args: ['--message', task, '--yes', '--no-auto-commits'],   stdin: null };
        case 'antigravity': return { cmd: 'agy',      args: ['--dangerously-skip-permissions', '--print', task], stdin: null };
        case 'codex':       return { cmd: 'codex',    args: ['exec', '--dangerously-bypass-approvals-and-sandbox', task], stdin: null };
        case 'opencode':    return { cmd: 'opencode', args: ['run', task],                                       stdin: null };
        case 'kilocode':
        case 'kilo':        return { cmd: agentId === 'kilo' ? 'kilo' : 'kilocode', args: ['run', task],         stdin: null };
        case 'ollama': {
            // ollama needs <model> <prompt>. Conventions:
            //  - "model::prompt"  → split on the first '::'
            //  - first non-empty line is the model when it contains no spaces (e.g. "llama3.2")
            //  - otherwise default to OLLAMA_DEFAULT_MODEL env or 'llama3.2'
            const def = process.env.OLLAMA_DEFAULT_MODEL || 'llama3.2';
            let model = def, prompt = task;
            const sep = task.indexOf('::');
            if (sep > 0) { model = task.slice(0, sep).trim() || def; prompt = task.slice(sep + 2).trim(); }
            else {
                const firstLine = task.split('\n', 1)[0].trim();
                if (firstLine && !/\s/.test(firstLine) && /[a-zA-Z]/.test(firstLine)) {
                    model = firstLine;
                    prompt = task.slice(firstLine.length).trim();
                }
            }
            return { cmd: 'ollama', args: ['run', model, prompt], stdin: null };
        }
        case 'shell':       return { cmd: 'bash',     args: ['-c', task],                                        stdin: null };
        default: {
            const a = KNOWN_AGENTS.find(x => x.id === agentId);
            return { cmd: a?.cmd || agentId, args: [], stdin: task };
        }
    }
}

function ajFinalizeRun(jobId, runId, { status, output, exitCode }) {
    try {
        const jobs = loadJobs();
        const job = jobs.find(j => j.id === jobId);
        if (!job) return;
        const run = job.runs?.find(r => r.id === runId);
        if (run) { run.status = status; run.output = output; run.exitCode = exitCode; run.completedAt = new Date().toISOString(); }
        job.status = status === 'cancelled' ? 'idle' : status;
        saveJobs(jobs);
    } catch (e) { console.error('[agent-jobs] finalizeRun:', e.message); }
}

function ajExecute(jobOrId) {
    const jobs = loadJobs();
    const job = typeof jobOrId === 'string' ? jobs.find(j => j.id === jobOrId) : jobs.find(j => j.id === jobOrId.id);
    if (!job || ajRunning.has(job.id)) return;

    const ws = loadWorkspaces().find(w => w.id === job.workspaceId);
    const cwd = ws?.cwd || process.env.HOME || `/home/${TARGET_USER}`;

    const { cmd, args, stdin } = ajBuildCmd(job.agentId, job.task);
    const runId = require('crypto').randomBytes(6).toString('hex');
    const startedAt = new Date().toISOString();

    // Persist start
    {
        const jlist = loadJobs();
        const j = jlist.find(x => x.id === job.id);
        if (!j) return;
        j.runs = [{ id: runId, startedAt, completedAt: null, status: 'running', output: '', exitCode: null }, ...(j.runs || [])].slice(0, AJ_MAX_RUNS);
        j.status = 'running'; j.lastRunAt = startedAt;
        saveJobs(jlist);
    }

    const env = {};
    for (const k of ALLOWED_ENV_PASSTHROUGH) if (process.env[k] != null) env[k] = process.env[k];
    Object.assign(env, { TERM: 'dumb', HOME: process.env.HOME || `/home/${TARGET_USER}`, PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/linuxbrew/.linuxbrew/bin' });

    let proc;
    try {
        proc = spawn('sudo', ['-n', '-u', TARGET_USER, '--', cmd, ...args], { cwd, env });
    } catch (e) {
        ajFinalizeRun(job.id, runId, { status: 'failed', output: e.message, exitCode: -1 });
        return;
    }
    if (stdin) {
        try { proc.stdin?.write(stdin + '\n'); proc.stdin?.end(); } catch {}
    } else {
        // Close stdin so processes that read from it (TUIs like gemini, aider) don't hang
        try { proc.stdin?.end(); } catch {}
    }

    let buf = '';
    let flushTid = null;
    const schedFlush = () => {
        if (flushTid) return;
        flushTid = setTimeout(() => {
            flushTid = null;
            try {
                const jlist = loadJobs();
                const j = jlist.find(x => x.id === job.id);
                const r = j?.runs?.find(r => r.id === runId);
                if (r) { r.output = buf; saveJobs(jlist); }
            } catch {}
        }, 2000);
    };
    const onData = (d) => {
        buf += d.toString();
        if (buf.length > AJ_MAX_OUTPUT) buf = '…' + buf.slice(-(AJ_MAX_OUTPUT - 1));
        const entry = ajRunning.get(job.id);
        if (entry) entry.buf = buf;
        schedFlush();
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    ajRunning.set(job.id, { proc, runId, buf: '' });

    const killTimer = setTimeout(() => {
        if (ajRunning.has(job.id)) try { proc.kill('SIGTERM'); } catch {}
    }, (job.timeout || 300) * 1000);

    proc.on('close', (code, signal) => {
        clearTimeout(killTimer);
        if (flushTid) { clearTimeout(flushTid); flushTid = null; }
        ajRunning.delete(job.id);
        const status = signal ? 'timeout' : (code === 0 ? 'completed' : 'failed');
        ajFinalizeRun(job.id, runId, { status, output: buf, exitCode: code });
    });
    proc.on('error', (e) => {
        clearTimeout(killTimer);
        if (flushTid) { clearTimeout(flushTid); flushTid = null; }
        ajRunning.delete(job.id);
        ajFinalizeRun(job.id, runId, { status: 'failed', output: e.message, exitCode: -1 });
    });
}

// Agent-jobs scheduler (runs alongside backup scheduler)
let ajSchedMin = -1;
setInterval(() => {
    const now = new Date();
    const min = now.getMinutes();
    if (min === ajSchedMin) return;
    ajSchedMin = min;
    try {
        loadJobs().filter(j => j.enabled && j.schedule && !ajRunning.has(j.id))
            .forEach(j => { if (isCronDue(j.schedule, now)) { console.log(`[AgentJobs] trigger: ${j.name}`); ajExecute(j); } });
    } catch (e) { console.error('[AgentJobs] scheduler:', e.message); }
}, 10000);

// ── Agent Jobs API ────────────────────────────────────────────────────────────
app.get('/api/agent-jobs', (req, res) => {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || 'UTC';
        res.json({
            jobs: loadJobs().map(j => ({ ...j, isRunning: ajRunning.has(j.id), runs: (j.runs || []).map(r => ({ ...r, output: undefined })) })),
            tz,
        });
    } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

app.get('/api/agent-jobs/:id', (req, res) => {
    try {
        const job = loadJobs().find(j => j.id === req.params.id);
        if (!job) return res.status(404).json({ error: 'Not found' });
        // Inject live buffered output for the running run
        const live = ajRunning.get(job.id);
        const runs = (job.runs || []).map(r => live && r.id === live.runId ? { ...r, output: live.buf } : r);
        res.json({ job: { ...job, isRunning: !!live, runs } });
    } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

app.post('/api/agent-jobs', (req, res) => {
    try {
        const { name, agentId, workspaceId, task, schedule, timeout, enabled } = req.body || {};
        if (!name?.trim() || !agentId || !task?.trim()) return res.status(400).json({ error: 'name, agentId, task required' });
        const job = {
            id: crypto.randomBytes(8).toString('hex'),
            name: name.trim().slice(0, 80), agentId,
            workspaceId: workspaceId || null,
            task: task.trim().slice(0, 8000),
            schedule: schedule || null,
            timeout: Math.max(30, Math.min(7200, parseInt(timeout) || 300)),
            enabled: enabled !== false, status: 'idle',
            createdAt: Date.now(), updatedAt: Date.now(), lastRunAt: null, runs: [],
        };
        const list = loadJobs(); list.push(job); saveJobs(list);
        res.json({ job });
    } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

app.put('/api/agent-jobs/:id', (req, res) => {
    try {
        const list = loadJobs();
        const idx = list.findIndex(j => j.id === req.params.id);
        if (idx < 0) return res.status(404).json({ error: 'Not found' });
        const { name, agentId, workspaceId, task, schedule, timeout, enabled } = req.body || {};
        const j = list[idx];
        if (name !== undefined) j.name = name.trim().slice(0, 80);
        if (agentId !== undefined) j.agentId = agentId;
        if (workspaceId !== undefined) j.workspaceId = workspaceId;
        if (task !== undefined) j.task = task.trim().slice(0, 8000);
        if (schedule !== undefined) j.schedule = schedule || null;
        if (timeout !== undefined) j.timeout = Math.max(30, Math.min(7200, parseInt(timeout) || 300));
        if (enabled !== undefined) j.enabled = Boolean(enabled);
        j.updatedAt = Date.now();
        saveJobs(list);
        res.json({ job: j });
    } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

app.delete('/api/agent-jobs/:id', (req, res) => {
    try {
        const live = ajRunning.get(req.params.id);
        if (live) { try { live.proc.kill('SIGTERM'); } catch {} ajRunning.delete(req.params.id); }
        const list = loadJobs().filter(j => j.id !== req.params.id);
        saveJobs(list);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

app.post('/api/agent-jobs/:id/run', (req, res) => {
    try {
        const job = loadJobs().find(j => j.id === req.params.id);
        if (!job) return res.status(404).json({ error: 'Not found' });
        if (ajRunning.has(job.id)) return res.status(409).json({ error: 'Already running' });
        ajExecute(job);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

app.post('/api/agent-jobs/:id/clone', (req, res) => {
    try {
        const list = loadJobs();
        const src = list.find(j => j.id === req.params.id);
        if (!src) return res.status(404).json({ error: 'Not found' });
        const job = {
            ...src,
            id: crypto.randomBytes(8).toString('hex'),
            name: `${src.name} (copy)`.slice(0, 80),
            enabled: false,
            status: 'idle',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastRunAt: null,
            runs: [],
        };
        list.push(job);
        saveJobs(list);
        res.json({ job });
    } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

app.post('/api/agent-jobs/:id/cancel', (req, res) => {
    try {
        const live = ajRunning.get(req.params.id);
        if (!live) return res.status(404).json({ error: 'Not running' });
        try { live.proc.kill('SIGTERM'); } catch {}
        ajRunning.delete(req.params.id);
        ajFinalizeRun(req.params.id, live.runId, { status: 'cancelled', output: live.buf, exitCode: -1 });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

// Filesystem directory browser for workspace folder picker
app.get('/api/fs/browse', (req, res) => {
    const { path: dirPath } = req.query;
    if (!dirPath) return res.status(400).json({ error: 'path is required' });
    const targetPath = path.resolve(dirPath);
    try {
        const items = fs.readdirSync(targetPath, { withFileTypes: true });
        const folders = [];
        for (const item of items) {
            if (item.name.startsWith('.')) continue;
            let isDir = item.isDirectory();
            if (item.isSymbolicLink()) {
                try { isDir = fs.statSync(fs.realpathSync(path.join(targetPath, item.name))).isDirectory(); } catch {}
            }
            if (!isDir) continue;
            folders.push({ name: item.name, path: path.join(targetPath, item.name) });
        }
        folders.sort((a, b) => a.name.localeCompare(b.name));
        res.json({ currentPath: targetPath, parentPath: targetPath === '/' ? null : path.dirname(targetPath), folders });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/fs/mkdir', (req, res) => {
    const { parent, name } = req.body;
    if (!parent || !name) return res.status(400).json({ error: 'parent and name are required' });
    const safeName = name.replace(/[/\0]/g, '').trim();
    if (!safeName) return res.status(400).json({ error: 'Invalid folder name' });
    const newDir = path.join(path.resolve(parent), safeName);
    try {
        fs.mkdirSync(newDir, { recursive: false });
        res.json({ path: newDir, name: safeName });
    } catch (e) {
        res.status(400).json({ error: e.code === 'EEXIST' ? 'Folder already exists' : e.message });
    }
});

app.get('/api/workspaces', (req, res) => {
    try { res.json({ workspaces: loadWorkspaces() }); }
    catch (e) { res.status(500).json({ error: errMsg(e) }); }
});

app.post('/api/workspaces', (req, res) => {
    try {
        const patch = validateWorkspacePayload(req.body || {}, false);
        const list = loadWorkspaces();
        const ws = {
            id: crypto.randomBytes(8).toString('hex'),
            name: patch.name,
            cwd: patch.cwd,
            agent: patch.agent ?? null,
            env: patch.env || {},
            openFiles: patch.openFiles || [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        list.push(ws);
        saveWorkspaces(list);
        res.json({ workspace: ws });
    } catch (e) {
        res.status(e.status || 500).json({ error: errMsg(e) });
    }
});

app.put('/api/workspaces/:id', (req, res) => {
    try {
        if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
        const patch = validateWorkspacePayload(req.body || {}, true);
        const list = loadWorkspaces();
        const idx = list.findIndex(w => w.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Not found' });
        list[idx] = { ...list[idx], ...patch, updatedAt: Date.now() };
        saveWorkspaces(list);
        res.json({ workspace: list[idx] });
    } catch (e) {
        res.status(e.status || 500).json({ error: errMsg(e) });
    }
});

app.delete('/api/workspaces/:id', (req, res) => {
    try {
        if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
        const list = loadWorkspaces();
        const next = list.filter(w => w.id !== req.params.id);
        if (next.length === list.length) return res.status(404).json({ error: 'Not found' });
        saveWorkspaces(next);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: errMsg(e) });
    }
});

// ─── Log Viewer ───────────────────────────────────────────────────────────────
app.get('/api/logs/units', async (req, res) => {
    try {
        const out = await runCommand("journalctl --field=_SYSTEMD_UNIT 2>/dev/null | sort -u | head -n 300");
        const units = out.trim().split('\n').filter(Boolean);
        res.json({ units });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PRIORITY_NAMES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
app.get('/api/logs/query', async (req, res) => {
    const { unit, n = '200', priority, since, search } = req.query;
    if (unit && !/^[a-zA-Z0-9@._\-]+$/.test(unit)) return res.status(400).json({ error: 'Invalid unit' });
    const limit = Math.min(parseInt(n, 10) || 200, 2000);
    try {
        let cmd = `journalctl --no-pager --output=json -n ${limit}`;
        if (unit) cmd += ` -u ${shellQuote(unit)}`;
        if (priority && PRIORITY_NAMES.includes(priority)) cmd += ` -p ${shellQuote(priority)}`;
        if (since) cmd += ` --since=${shellQuote(since)}`;
        cmd += ' 2>/dev/null';

        const out = await runCommand(cmd);
        let entries = out.trim().split('\n').filter(Boolean).map(line => {
            try {
                const e = JSON.parse(line);
                return {
                    ts: Math.floor(parseInt(e.__REALTIME_TIMESTAMP, 10) / 1000),
                    msg: Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE).toString() : (e.MESSAGE || ''),
                    unit: e._SYSTEMD_UNIT || e.SYSLOG_IDENTIFIER || '',
                    priority: parseInt(e.PRIORITY, 10),
                    pid: e._PID || '',
                };
            } catch { return null; }
        }).filter(Boolean);

        if (search) {
            const q = search.toLowerCase();
            entries = entries.filter(e => e.msg.toLowerCase().includes(q));
        }
        res.json({ entries });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/logs/stream', async (req, res) => {
    const { unit } = req.query;
    if (unit && !/^[a-zA-Z0-9@._\-]+$/.test(unit)) return res.status(400).json({ error: 'Invalid unit' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
    let cmd = 'journalctl -f --output=json';
    if (unit) cmd += ` -u ${shellQuote(unit)}`;
    const proc = exec(cmd + ' 2>/dev/null');
    proc.stderr?.on('data', () => {});

    proc.stdout?.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
            try {
                const e = JSON.parse(line);
                send({
                    ts: Math.floor(parseInt(e.__REALTIME_TIMESTAMP, 10) / 1000),
                    msg: Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE).toString() : (e.MESSAGE || ''),
                    unit: e._SYSTEMD_UNIT || e.SYSLOG_IDENTIFIER || '',
                    priority: parseInt(e.PRIORITY, 10),
                    pid: e._PID || '',
                });
            } catch {}
        }
    });

    req.on('close', () => { try { proc.kill(); } catch {} });
});

// ─── Network Details ──────────────────────────────────────────────────────────
app.get('/api/network/connections', async (req, res) => {
    try {
        const out = await runCommand("ss -tulpn 2>/dev/null");
        const conns = [];
        for (const line of out.trim().split('\n').slice(1).filter(Boolean)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 5) continue;
            const procMatch = line.match(/users:\(\("([^"]+)",.*?pid=(\d+)/);
            conns.push({
                proto: parts[0],
                state: parts[1],
                recvQ: parts[2],
                sendQ: parts[3],
                local: parts[4],
                remote: parts[5] || '*',
                process: procMatch ? procMatch[1] : '',
                pid: procMatch ? procMatch[2] : '',
            });
        }
        res.json({ connections: conns });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/network/firewall', async (req, res) => {
    try {
        const ufw = await runCommand("ufw status verbose 2>/dev/null");
        if (ufw && ufw.trim() && !ufw.includes('command not found') && !ufw.includes('not found')) {
            return res.json({ tool: 'ufw', output: ufw.trim() });
        }
        const ipt = await runCommand("iptables -L -n --line-numbers 2>/dev/null");
        res.json({ tool: 'iptables', output: ipt.trim() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/network/interfaces', async (req, res) => {
    try {
        const out = await runCommand("cat /proc/net/dev 2>/dev/null");
        const ifaces = [];
        for (const line of out.trim().split('\n').slice(2).filter(Boolean)) {
            const colonIdx = line.indexOf(':');
            if (colonIdx < 0) continue;
            const name = line.slice(0, colonIdx).trim();
            if (!name) continue;
            const nums = line.slice(colonIdx + 1).trim().split(/\s+/).map(Number);
            if (nums.length < 16) continue;
            ifaces.push({
                name,
                rxBytes: nums[0], rxPackets: nums[1], rxErrors: nums[2], rxDrop: nums[3],
                txBytes: nums[8], txPackets: nums[9], txErrors: nums[10], txDrop: nums[11],
            });
        }
        res.json({ interfaces: ifaces });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/network/speedtest', async (req, res) => {
    try {
        const out = await runCommand("speedtest-cli --json");
        const parsed = JSON.parse(out);
        res.json(parsed);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Speedtest failed to run.' });
    }
});

// ─── Cron Manager ─────────────────────────────────────────────────────────────
const parseCrontab = (text, owner) => {
    const entries = [];
    let idx = 0;
    for (const line of (text || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const isCommented = trimmed.startsWith('#');
        const content = isCommented ? trimmed.slice(1).trim() : trimmed;
        if (!content) continue;
        const parts = content.split(/\s+/);
        if (parts.length >= 6) {
            const isCron = parts.slice(0, 5).every(p => /^[0-9*,/\-]+$/.test(p) || p.startsWith('@'));
            if (isCron) {
                entries.push({
                    id: `${owner}-${idx}`,
                    idx,
                    owner,
                    schedule: parts.slice(0, 5).join(' '),
                    command: parts.slice(5).join(' '),
                    active: !isCommented
                });
                idx++;
            }
        }
    }
    return entries;
};

const writeCrontab = (user, content) => new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `crontab-${user}-${Date.now()}.txt`);
    try {
        fs.writeFileSync(tmpFile, content.endsWith('\n') ? content : content + '\n', 'utf8');
        execFile('crontab', ['-u', user, tmpFile], (err, stdout, stderr) => {
            try { fs.unlinkSync(tmpFile); } catch {}
            if (err) return reject(new Error(stderr || err.message));
            resolve();
        });
    } catch (e) {
        try { fs.unlinkSync(tmpFile); } catch {}
        reject(e);
    }
});

app.get('/api/cron', async (req, res) => {
    try {
        const [userCron, rootCron, timersOut] = await Promise.all([
            runCommand(`crontab -l -u ${shellQuote(TARGET_USER)} 2>/dev/null`),
            runCommand('crontab -l -u root 2>/dev/null'),
            runCommand("systemctl list-timers --all --no-pager --plain --no-legend 2>/dev/null"),
        ]);
        const entries = [
            ...parseCrontab(userCron, TARGET_USER),
            ...(TARGET_USER !== 'root' ? parseCrontab(rootCron, 'root') : []),
        ];
        const timers = [];
        for (const line of timersOut.trim().split('\n').filter(Boolean)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 8) {
                timers.push({
                    next: parts.slice(0, 3).join(' '),
                    last: parts.slice(3, 6).join(' '),
                    passed: parts[6] || '',
                    unit: parts[7] || '',
                    activates: parts[8] || '',
                });
            }
        }
        res.json({ entries, timers });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/cron', async (req, res) => {
    const { schedule, command, user } = req.body || {};
    if (!schedule || !command) return res.status(400).json({ error: 'schedule and command are required' });
    const targetUser = user === 'root' ? 'root' : TARGET_USER;
    try {
        const existing = await runCommand(`crontab -l -u ${shellQuote(targetUser)} 2>/dev/null`);
        const newContent = (existing.trim() ? existing.trim() + '\n' : '') + `${schedule} ${command}\n`;
        await writeCrontab(targetUser, newContent);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/cron/toggle', async (req, res) => {
    const { id, active, user } = req.body || {};
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'Invalid id' });
    const targetUser = user === 'root' ? 'root' : TARGET_USER;
    const idxToToggle = parseInt(id.split('-').pop(), 10);
    if (isNaN(idxToToggle)) return res.status(400).json({ error: 'Invalid id' });
    try {
        const existing = await runCommand(`crontab -l -u ${shellQuote(targetUser)} 2>/dev/null`);
        let cronIdx = 0;
        const lines = existing.split('\n');
        const newLines = lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            const isCommented = trimmed.startsWith('#');
            const content = isCommented ? trimmed.slice(1).trim() : trimmed;
            if (!content) return line;
            const parts = content.split(/\s+/);
            if (parts.length >= 6) {
                const isCron = parts.slice(0, 5).every(p => /^[0-9*,/\-]+$/.test(p) || p.startsWith('@'));
                if (isCron) {
                    if (cronIdx === idxToToggle) {
                        cronIdx++;
                        return active ? content : `# ${content}`;
                    }
                    cronIdx++;
                }
            }
            return line;
        });
        await writeCrontab(targetUser, newLines.join('\n'));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/cron/run', async (req, res) => {
    const { command, user } = req.body || {};
    if (!command) return res.status(400).json({ error: 'command is required' });
    const targetUser = user === 'root' ? 'root' : TARGET_USER;
    try {
        const out = await new Promise((resolve) => {
            exec(`sudo -n -u ${shellQuote(targetUser)} -- bash -c ${shellQuote(command)}`, { timeout: 15000 }, (error, stdout, stderr) => {
                const logs = (stdout || '').toString() + (stderr || '').toString();
                resolve(logs || (error ? error.message : 'Command executed with no output.'));
            });
        });
        res.json({ ok: true, output: out });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/cron/:id', async (req, res) => {
    const { id } = req.params || {};
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'Invalid id' });
    const user = req.query.user === 'root' ? 'root' : TARGET_USER;
    const idxToDelete = parseInt(id.split('-').pop(), 10);
    if (isNaN(idxToDelete)) return res.status(400).json({ error: 'Invalid id' });
    try {
        const existing = await runCommand(`crontab -l -u ${shellQuote(user)} 2>/dev/null`);
        let cronIdx = 0;
        const newLines = existing.split('\n').filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return true;
            const isCommented = trimmed.startsWith('#');
            const content = isCommented ? trimmed.slice(1).trim() : trimmed;
            if (!content) return true;
            const parts = content.split(/\s+/);
            if (parts.length >= 6) {
                const isCron = parts.slice(0, 5).every(p => /^[0-9*,/\-]+$/.test(p) || p.startsWith('@'));
                if (isCron) {
                    if (cronIdx === idxToDelete) { cronIdx++; return false; }
                    cronIdx++;
                }
            }
            return true;
        });
        await writeCrontab(user, newLines.join('\n'));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Backup Manager ───────────────────────────────────────────────────────────
const isCronDue = (cronExpr, date) => {
    const fields = cronExpr.trim().split(/\s+/);
    if (fields.length < 5) return false;
    const [min, hour, day, month, dayOfWeek] = fields;
    const m = date.getMinutes();
    const h = date.getHours();
    const d = date.getDate();
    const mo = date.getMonth() + 1;
    const dow = date.getDay();

    const matchField = (field, value) => {
        if (field === '*') return true;
        if (field.includes(',')) return field.split(',').some(f => matchField(f, value));
        if (field.includes('/')) {
            const [start, step] = field.split('/');
            const startVal = start === '*' ? 0 : parseInt(start, 10);
            return (value - startVal) % parseInt(step, 10) === 0;
        }
        if (field.includes('-')) {
            const [start, end] = field.split('-');
            return value >= parseInt(start, 10) && value <= parseInt(end, 10);
        }
        return parseInt(field, 10) === value;
    };

    return matchField(min, m) &&
           matchField(hour, h) &&
           matchField(day, d) &&
           matchField(month, mo) &&
           matchField(dayOfWeek, dow);
};

const runBackupJob = (job) => {
    return new Promise((resolve) => {
        job.lastStatus = 'running';
        job.lastRun = new Date().toISOString();
        saveState();

        let cmd = '';
        const src = job.src;
        const dest = job.dest;
        const extra = job.args || '';

        if (job.destType === 'rclone') {
            cmd = `rclone sync ${shellQuote(src)} ${shellQuote(dest)} ${extra}`;
        } else if (job.destType === 'rsync') {
            cmd = `rsync -avz -e "ssh -o StrictHostKeyChecking=no" ${shellQuote(src)}/ ${shellQuote(dest)} ${extra}`;
        } else if (job.destType === 'local') {
            if (dest.endsWith('.tar.gz') || dest.endsWith('.tgz')) {
                const destDir = path.dirname(dest);
                cmd = `mkdir -p ${shellQuote(destDir)} && tar -czf ${shellQuote(dest)} -C ${shellQuote(src)} .`;
            } else {
                cmd = `mkdir -p ${shellQuote(dest)} && rsync -avz ${shellQuote(src)}/ ${shellQuote(dest)} ${extra}`;
            }
        } else {
            job.lastStatus = 'failed';
            job.lastLog = 'Unknown destination type.';
            saveState();
            return resolve({ success: false, log: job.lastLog });
        }

        const execCmd = `sudo -n -u ${shellQuote(TARGET_USER)} -- bash -c ${shellQuote(cmd)}`;
        exec(execCmd, { timeout: 3600000 }, (error, stdout, stderr) => {
            const logs = (stdout || '').toString() + (stderr || '').toString();
            job.lastLog = logs || (error ? error.message : 'Completed successfully with no output.');
            if (error) {
                job.lastStatus = 'failed';
                saveState();
                resolve({ success: false, log: logs });
            } else {
                job.lastStatus = 'success';
                saveState();
                resolve({ success: true, log: logs });
            }
        });
    });
};

let lastCheckedMinute = -1;
setInterval(() => {
    const now = new Date();
    const currentMin = now.getMinutes();
    if (currentMin === lastCheckedMinute) return;
    lastCheckedMinute = currentMin;

    const activeJobs = (state.backups || []).filter(j => j.active && j.schedule);
    activeJobs.forEach(job => {
        if (job.lastStatus === 'running') return;
        if (isCronDue(job.schedule, now)) {
            console.log(`[BackupScheduler] Triggering job: ${job.name} (${job.id})`);
            runBackupJob(job).catch(err => {
                console.error(`[BackupScheduler] Job ${job.name} failed:`, err);
            });
        }
    });
}, 10000);

app.get('/api/backups', (req, res) => {
    res.json({ backups: state.backups || [] });
});

app.post('/api/backups', (req, res) => {
    const { id, name, src, destType, dest, schedule, active, args } = req.body || {};
    if (!name || !src || !destType || !dest) {
        return res.status(400).json({ error: 'name, src, destType, and dest are required' });
    }
    
    let job = null;
    if (id) {
        job = (state.backups || []).find(j => j.id === id);
    }
    
    if (job) {
        job.name = name;
        job.src = src;
        job.destType = destType;
        job.dest = dest;
        job.schedule = schedule || '';
        job.active = active !== false;
        job.args = args || '';
    } else {
        job = {
            id: `bk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            src,
            destType,
            dest,
            schedule: schedule || '',
            active: active !== false,
            args: args || '',
            lastRun: null,
            lastStatus: 'never',
            lastLog: ''
        };
        if (!state.backups) state.backups = [];
        state.backups.push(job);
    }
    saveState();
    res.json({ ok: true, job });
});

app.delete('/api/backups/:id', (req, res) => {
    const { id } = req.params;
    const initialLength = (state.backups || []).length;
    state.backups = (state.backups || []).filter(j => j.id !== id);
    if (state.backups.length === initialLength) {
        return res.status(404).json({ error: 'Job not found' });
    }
    saveState();
    res.json({ ok: true });
});

app.post('/api/backups/run/:id', async (req, res) => {
    const { id } = req.params;
    const job = (state.backups || []).find(j => j.id === id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.lastStatus === 'running') return res.status(400).json({ error: 'Job is already running' });
    
    runBackupJob(job).catch(e => console.error(e));
    res.json({ ok: true, status: 'running' });
});


// ─── SMART Disk Health ────────────────────────────────────────────────────────
app.get('/api/disk/smart', async (req, res) => {
    try {
        // Use smartctl --scan to find SMART-capable physical drives
        const SMARTCTL = '/usr/sbin/smartctl';
        const scanOut = await runCommand(`${SMARTCTL} --scan 2>/dev/null || true`);
        const devices = [];
        for (const line of scanOut.trim().split('\n').filter(Boolean)) {
            // e.g. "/dev/sda -d scsi # /dev/sda, SCSI device"
            const m = line.match(/^(\S+)(\s+-d\s+\S+)?/);
            if (m) devices.push({ path: m[1], typeFlag: m[2] ? m[2].trim() : '' });
        }
        // Fallback: use lsblk to find disk devices
        if (devices.length === 0) {
            const lsblkOut = await runCommand("lsblk -d -n -o NAME,TYPE 2>/dev/null");
            for (const line of lsblkOut.trim().split('\n').filter(Boolean)) {
                const [name, type] = line.trim().split(/\s+/);
                if (type === 'disk') devices.push({ path: `/dev/${name}`, typeFlag: '' });
            }
        }

        const results = await Promise.all(devices.map(async ({ path: devPath, typeFlag }) => {
            // smartctl exits non-zero on warnings, use || true to always get stdout
            let allOut = await runCommand(`${SMARTCTL} -a ${shellQuote(devPath)} 2>/dev/null || true`);
            if (allOut.length < 100 && typeFlag) {
                allOut = await runCommand(`${SMARTCTL} -a ${typeFlag} ${shellQuote(devPath)} 2>/dev/null || true`);
            }

            const healthMatch = allOut.match(/SMART overall-health[^:]*:\s*(\w+)/i)
                || allOut.match(/overall-health self-assessment[^:]*:\s*(\w+)/i)
                || allOut.match(/SMART Health Status:\s*(\w+)/i);
            const health = healthMatch ? healthMatch[1] : (allOut.length > 100 ? 'UNKNOWN' : 'N/A');

            const tempMatch = allOut.match(/Temperature_Celsius[^\n]*?(\d+)\s+\(/m)
                || allOut.match(/Airflow_Temperature_Cel[^\n]*?(\d+)\s+\(/m)
                || allOut.match(/Temperature:\s+(\d+)/m)
                || allOut.match(/194\s+\S+[^\n]+?(\d+)\s+\(/m);
            const temperature = tempMatch ? parseInt(tempMatch[1], 10) : null;

            const reallocMatch = allOut.match(/5\s+Reallocated_Sector_Ct[^\n]*?([\d]+)\s*$/m);
            const reallocatedSectors = reallocMatch ? parseInt(reallocMatch[1], 10) : 0;

            const powerOnMatch = allOut.match(/9\s+Power_On_Hours[^\n]*?([\d]+)\s*$/m)
                || allOut.match(/Power On Hours:\s+([\d,]+)/m);
            const powerOnHours = powerOnMatch ? parseInt(powerOnMatch[1].replace(/,/g, ''), 10) : null;

            const model = allOut.match(/Device Model:\s*(.+)/)?.[1]?.trim()
                || allOut.match(/Model Number:\s*(.+)/)?.[1]?.trim()
                || devPath;
            const serial = allOut.match(/Serial Number:\s*(.+)/)?.[1]?.trim() || '';
            const capacity = allOut.match(/User Capacity:\s*(.+)/)?.[1]?.trim()
                || allOut.match(/Namespace 1 Size\/Capacity:\s*(.+)/)?.[1]?.trim() || '';
            const rotation = allOut.match(/Rotation Rate:\s*(.+)/)?.[1]?.trim() || '';

            return {
                device: devPath, model, serial, capacity, rotation,
                health, temperature, reallocatedSectors, powerOnHours,
                available: allOut.length > 100,
            };
        }));

        res.json({ disks: results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── File Operations (delete, move, copy, mkdir) ──────────────────────────────
app.delete('/api/files', (req, res) => {
    let filePath;
    try { filePath = safeFilePath(req.query.path); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    if (filePath === '/') return res.status(400).json({ error: 'Invalid path' });
    try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(filePath);
        }
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/files/upload-chunk', async (req, res) => {
    console.log('[upload-chunk] received chunk upload request:', req.body);
    try {
        if (!req.files || !req.files.chunk) {
            console.error('[upload-chunk] req.files.chunk is missing!');
            return res.status(400).json({ error: 'No chunk file was uploaded.' });
        }
        const { dir, fileName, chunkIndex, totalChunks } = req.body || {};
        if (!dir || !fileName || chunkIndex === undefined || totalChunks === undefined) {
            console.error('[upload-chunk] missing parameters:', { dir, fileName, chunkIndex, totalChunks });
            return res.status(400).json({ error: 'Missing parameters.' });
        }

        const safeFileName = path.basename(fileName);
        const chunkIdx = parseInt(chunkIndex, 10);
        const totalCh = parseInt(totalChunks, 10);

        let resolvedDir;
        try { resolvedDir = safeFilePath(dir); }
        catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
        
        const tempDir = path.join(__dirname, 'data', 'temp_uploads', safeFileName);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const chunkPath = path.join(tempDir, `chunk_${chunkIdx}`);
        await req.files.chunk.mv(chunkPath);

        // Check if all chunks are uploaded
        let allUploaded = true;
        for (let i = 0; i < totalCh; i++) {
            if (!fs.existsSync(path.join(tempDir, `chunk_${i}`))) {
                allUploaded = false;
                break;
            }
        }

        if (allUploaded) {
            const destPath = path.join(resolvedDir, safeFileName);
            console.log('[upload-chunk] assembling file to:', destPath);
            
            const writeStream = fs.createWriteStream(destPath);
            await new Promise((resolve, reject) => {
                writeStream.on('error', (err) => {
                    console.error('[upload-chunk] Write stream error:', err);
                    reject(err);
                });
                writeStream.on('finish', () => {
                    resolve();
                });
                
                for (let i = 0; i < totalCh; i++) {
                    const p = path.join(tempDir, `chunk_${i}`);
                    const data = fs.readFileSync(p);
                    writeStream.write(data);
                }
                writeStream.end();
            });

            // Clean up chunks
            for (let i = 0; i < totalCh; i++) {
                const p = path.join(tempDir, `chunk_${i}`);
                if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                }
            }
            // Clean up folder recursively to remove any leftovers from previous attempts
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (cleanupErr) {
                console.error('[upload-chunk] Temp dir cleanup failed:', cleanupErr.message);
            }
            
            console.log('[upload-chunk] file assembly completed successfully:', destPath);
            res.json({ ok: true, completed: true });
        } else {
            res.json({ ok: true, completed: false });
        }
    } catch (err) {
        console.error('[upload-chunk] Error processing chunk:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/files/download', (req, res) => {
    let filePath;
    try { filePath = safeFilePath(req.query.path); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    try {
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            return res.status(400).json({ error: 'Path is a directory' });
        }
        res.download(filePath);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/files/move', (req, res) => {
    const { from, to } = req.body || {};
    let safeFrom, safeTo;
    try { safeFrom = safeFilePath(from); safeTo = safeFilePath(to); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    try {
        fs.renameSync(safeFrom, safeTo);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/files/copy', async (req, res) => {
    const { from, to } = req.body || {};
    let safeFrom, safeTo;
    try { safeFrom = safeFilePath(from); safeTo = safeFilePath(to); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    try {
        const stat = fs.statSync(safeFrom);
        if (stat.isDirectory()) {
            await runCommandThrow(`cp -a ${shellQuote(safeFrom)} ${shellQuote(safeTo)}`);
        } else {
            fs.copyFileSync(safeFrom, safeTo);
        }
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/files/mkdir', (req, res) => {
    const { path: dirPath } = req.body || {};
    let safeDir;
    try { safeDir = safeFilePath(dirPath); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    try {
        fs.mkdirSync(safeDir, { recursive: true });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Alert Config ─────────────────────────────────────────────────────────────
app.get('/api/alerts/config', (req, res) => {
    res.json(state.alerts || { cpu: 90, ram: 90, disk: 90 });
});

app.post('/api/alerts/config', (req, res) => {
    const { cpu, ram, disk } = req.body || {};
    state.alerts = {
        cpu: Math.min(100, Math.max(1, parseInt(cpu, 10) || 90)),
        ram: Math.min(100, Math.max(1, parseInt(ram, 10) || 90)),
        disk: Math.min(100, Math.max(1, parseInt(disk, 10) || 90)),
    };
    saveState();
    res.json({ ok: true, alerts: state.alerts });
});

const frontendPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendPath)) {
    app.use(express.static(frontendPath));
    app.get(/.*/, (req, res) => res.sendFile(path.join(frontendPath, 'index.html')));
} else {
    app.get('/', (req, res) => res.send('Dashboard Backend is running. Frontend not built yet.'));
}

const server = http.createServer(app);

const TERMINAL_ALLOW_LAN = process.env.DASHBOARD_TERMINAL_ALLOW_LAN === 'true';
const wss = new WebSocketServer({ noServer: true });

const isLoopback = (addr) => {
    if (!addr) return false;
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
};

const isSameOriginUpgrade = (req) => {
    const host = (req.headers.host || '').toLowerCase().split(':')[0];
    const origin = req.headers.origin || '';
    if (!host || !origin) return false;
    try {
        return new URL(origin).hostname.toLowerCase() === host;
    } catch (e) {
        return false;
    }
};

server.on('upgrade', (req, socket, head) => {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname !== '/ws/terminal') {
        socket.destroy();
        return;
    }
    const remote = req.socket.remoteAddress;
    const loopback = isLoopback(remote);
    const sameOrigin = isSameOriginUpgrade(req);
    const tokenOk = AGENT_TOKEN && timingSafeCompare(parsed.query.key || '', AGENT_TOKEN);
    const allow = loopback || tokenOk || (TERMINAL_ALLOW_LAN && sameOrigin);
    
    console.log(`[WS Upgrade] remote=${remote} loopback=${loopback} sameOrigin=${sameOrigin} allow=${allow}`);
    if (!allow) {
        const reason = !sameOrigin ? 'origin-mismatch' : 'lan-disabled';
        console.warn(`[WS Upgrade] Rejected: reason=${reason}`);
        socket.write(`HTTP/1.1 403 Forbidden\r\nX-Reject-Reason: ${reason}\r\n\r\n`);
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
});

const TERMINAL_USER = TARGET_USER;
const sanitizeAgent = (raw) => {
    if (!raw) return null;
    return KNOWN_AGENTS.find(a => a.id === raw || a.cmd === raw) || null;
};

wss.on('connection', (ws, req) => {
    const parsed = url.parse(req.url, true);
    const query = parsed.query;
    if (query && query.ssh === 'true') {
        let conn;
        let stream;
        
        ws.once('message', (msg) => {
            try {
                const text = msg.toString();
                const evt = JSON.parse(text);
                if (evt.type !== 'init-ssh') {
                    throw new Error('Expected init-ssh message');
                }
                
                const { host, port, username, password, privateKey, passphrase, cols, rows } = evt;
                if (!host || !username) {
                    throw new Error('Host and Username are required');
                }
                
                ws.send('\x1b[2m· establishing SSH connection …\x1b[0m\r\n');
                
                const { Client } = require('ssh2');
                conn = new Client();
                
                conn.on('ready', () => {
                    ws.send('\x1b[2m· SSH connection established. Requesting shell …\x1b[0m\r\n');
                    conn.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, sshStream) => {
                        if (err) {
                            ws.send(`\r\n\x1b[31m[SSH Shell Request Failed: ${err.message}]\x1b[0m\r\n`);
                            ws.close();
                            conn.end();
                            return;
                        }
                        stream = sshStream;
                        
                        stream.on('data', (data) => {
                            if (ws.readyState === ws.OPEN) ws.send(data);
                        });
                        stream.on('close', () => {
                            if (ws.readyState === ws.OPEN) {
                                ws.send(`\r\n\x1b[33m[SSH connection closed by remote host]\x1b[0m\r\n`);
                                ws.close();
                            }
                            conn.end();
                        });
                        
                        ws.on('message', (msg) => {
                            try {
                                const text = msg.toString();
                                if (text.startsWith('{')) {
                                    const evt = JSON.parse(text);
                                    if (evt.type === 'resize' && evt.cols && evt.rows) {
                                        stream.setWindow(evt.rows, evt.cols, 0, 0);
                                        return;
                                    }
                                    if (evt.type === 'data' && typeof evt.data === 'string') {
                                        stream.write(evt.data);
                                        return;
                                    }
                                }
                                stream.write(text);
                            } catch (e) {
                                console.error('SSH stream write error', e);
                            }
                        });
                    });
                });
                
                conn.on('error', (err) => {
                    try { ws.send(`\r\n\x1b[31m[SSH Connection Error: ${err.message}]\x1b[0m\r\n`); } catch {}
                    try { ws.close(); } catch {}
                });
                
                conn.on('close', () => {
                    try { ws.close(); } catch {}
                });
                
                const connectConfig = {
                    host,
                    port: port || 22,
                    username,
                    readyTimeout: 15000,
                };
                
                if (privateKey && privateKey.trim()) {
                    let keyContent = privateKey;
                    if (!privateKey.includes('-----BEGIN')) {
                        const keyName = privateKey.trim();
                        if (!/^[A-Za-z0-9_.-]+$/.test(keyName)) {
                            ws.send(JSON.stringify({ type: 'error', message: 'Invalid key name' }));
                            return;
                        }
                        const SSH_DIR = '/home/ayman/.ssh';
                        const localKeyPath = path.resolve(SSH_DIR, keyName);
                        if (!localKeyPath.startsWith(SSH_DIR + path.sep)) {
                            ws.send(JSON.stringify({ type: 'error', message: 'Invalid key name' }));
                            return;
                        }
                        if (fs.existsSync(localKeyPath)) {
                            keyContent = fs.readFileSync(localKeyPath, 'utf8');
                        }
                    }
                    connectConfig.privateKey = keyContent;
                    if (passphrase) connectConfig.passphrase = passphrase;
                } else if (password) {
                    connectConfig.password = password;
                }
                
                conn.connect(connectConfig);
                
            } catch (e) {
                try { ws.send(`\r\n\x1b[31m[SSH Initialization Failed: ${e.message}]\x1b[0m\r\n`); } catch {}
                try { ws.close(); } catch {}
                if (conn) try { conn.end(); } catch {}
            }
        });
        
        ws.on('close', () => {
            if (stream) try { stream.end(); } catch {}
            if (conn) try { conn.end(); } catch {}
        });
        
        return;
    }

    let term;
    try {
        const agent = sanitizeAgent(query && query.agent);
        const cols = Math.min(parseInt(query.cols, 10) || 100, 400);
        const rows = Math.min(parseInt(query.rows, 10) || 30, 200);

        let command = 'sudo';
        let args = ['-n', '-u', TERMINAL_USER, '-i'];
        if (TERMINAL_USER === 'root') {
            command = 'bash';
            args = ['-l'];
        }

        if (query && query.docker) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(query.docker)) {
                ws.close(1008, 'Invalid container');
                return;
            }
            command = 'docker';
            args = ['exec', '-it', query.docker, 'sh'];
        }

        let spawnCwd = '/';
        if (typeof query.cwd === 'string' && query.cwd) {
            try {
                const safe = safeFilePath(query.cwd);
                if (fs.existsSync(safe) && fs.statSync(safe).isDirectory()) {
                    spawnCwd = safe;
                }
            } catch (e) {}
        }

        const spawnEnv = {
            TERM: 'xterm-256color',
            LANG: process.env.LANG || 'en_US.UTF-8',
            PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            HOME: process.env.HOME || `/home/${TARGET_USER}`,
        };
        if (typeof query.env === 'string' && query.env) {
            const requested = query.env.split(',').map(s => s.trim()).filter(Boolean);
            for (const name of requested) {
                if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name)) continue;
                if (!ALLOWED_ENV_PASSTHROUGH.includes(name)) continue;
                if (process.env[name] != null) spawnEnv[name] = process.env[name];
            }
        }

        term = pty.spawn(command, args, {
            name: 'xterm-256color',
            cols,
            rows,
            env: spawnEnv,
            cwd: spawnCwd,
        });

        setTimeout(() => {
            try {
                if (spawnCwd && spawnCwd !== '/') {
                    term.write(`cd ${shellQuote(spawnCwd)}\n`);
                }
                if (agent) {
                    term.write(`${agent.cmd}\n`);
                }
            } catch (e) {}
        }, 500);

        term.onData((data) => {
            if (ws.readyState === ws.OPEN) ws.send(data);
        });
        term.onExit(({ exitCode, signal }) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(`\r\n\x1b[33m[process exited code=${exitCode} signal=${signal || 0}]\x1b[0m\r\n`);
                ws.close();
            }
        });

        ws.on('message', (msg) => {
            try {
                const text = msg.toString();
                if (text.startsWith('{')) {
                    const evt = JSON.parse(text);
                    if (evt.type === 'resize' && evt.cols && evt.rows) {
                        term.resize(Math.min(evt.cols, 400), Math.min(evt.rows, 200));
                        return;
                    }
                    if (evt.type === 'data' && typeof evt.data === 'string') {
                        term.write(evt.data);
                        return;
                    }
                }
                term.write(text);
            } catch (e) {
                console.error('terminal message error', e);
            }
        });
        ws.on('close', () => {
            try { term.kill(); } catch (e) {}
        });
    } catch (e) {
        console.error('terminal spawn failed', e);
        try { ws.send(`\r\n\x1b[31m[failed to start terminal: ${e.message}]\x1b[0m\r\n`); } catch {}
        try { ws.close(); } catch {}
        if (term) try { term.kill(); } catch {}
    }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Hosted Dashboard v${pkg.version} on port ${PORT} (terminal user=${TARGET_USER}, lan-terminal=${TERMINAL_ALLOW_LAN})`));
