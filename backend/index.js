const express = require('express');
const { exec, execFile, spawn, execSync } = require('child_process');
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
const TRASH_DIR = path.resolve(process.env.DASHBOARD_TRASH_DIR || '/var/cache/server-hub/trash');
const WORKSPACES_FILE = process.env.DASHBOARD_WORKSPACES || '/var/lib/server-hub/workspaces.json';
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
            overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
        };
    } catch (e) {
        return { manual: [], history: {}, alerts: { cpu: 90, ram: 90, disk: 90 }, backups: [], overrides: {} };
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
    // frame-ancestors must be an HTTP header — <meta> CSP ignores it per spec.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    next();
});
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
const GENERIC_EXEC_NAMES = ['node', 'python', 'python3', 'MainThread', 'node-MainThread', 'deno', 'bun', 'next-server'];
const GENERIC_SCRIPT_NAMES = new Set(['index', 'main', 'server', 'app', 'run', 'start', 'cli']);
const SKIP_PATH_PARTS = new Set(['.', '..', 'src', 'dist', 'bin', '.bin', 'backend', 'frontend', 'node_modules', 'lib', '.local', 'app']);
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

// Known paths that signal a web UI even when the root returns non-HTML (JSON/text).
// Checked only when the root probe returns a non-HTML 2xx, saving probe time on
// services whose root is already HTML.
const WEB_UI_PATHS = ['/ui', '/dashboard', '/web', '/app', '/admin', '/console', '/webui'];

const probeProtocol = async (protocol, port, host = '127.0.0.1') => {
    const cfg = {
        timeout: 1500,
        validateStatus: () => true,
        maxRedirects: 3,
        headers: { Accept: 'text/html,application/xhtml+xml,*/*', 'User-Agent': 'ServiceProbe/1.0' },
    };
    if (protocol === 'https') cfg.httpsAgent = insecureHttpsAgent;
    const base = `${protocol}://${host}:${port}`;
    try {
        const response = await axios.get(base, cfg);
        const contentType = response.headers['content-type'] || '';
        const ok = response.status >= 200 && response.status < 400;
        if (ok && contentType.includes('text/html') && typeof response.data === 'string') {
            const titleMatch = response.data.match(/<title>(.*?)<\/title>/i);
            const title = titleMatch?.[1]?.trim() || null;
            const faviconHref = extractFaviconHref(response.data);
            return { isWebUi: true, status: response.status, protocol, title, faviconHref };
        }
        // Root returned non-HTML (JSON/text) — probe known web-UI paths before giving up.
        if (ok) {
            for (const uiPath of WEB_UI_PATHS) {
                try {
                    const r2 = await axios.get(`${base}${uiPath}`, { ...cfg, timeout: 800 });
                    const ct2 = r2.headers['content-type'] || '';
                    if (ct2.includes('text/html') && r2.status >= 200 && r2.status < 400 && typeof r2.data === 'string') {
                        const titleMatch = r2.data.match(/<title>(.*?)<\/title>/i);
                        return {
                            isWebUi: true, status: r2.status, protocol,
                            title: titleMatch?.[1]?.trim() || null,
                            faviconHref: extractFaviconHref(r2.data),
                        };
                    }
                } catch (_) {}
            }
        }
        return { isWebUi: false, status: response.status, protocol: null, title: null, faviconHref: null };
    } catch (e) {
        return null;
    }
};

const probePort = async (port, bindHost = '127.0.0.1') => {
    if (NON_HTTP_PORTS.has(port)) {
        return { isWebUi: false, status: 'skipped', protocol: null, title: null, faviconHref: null };
    }
    // Resolve which host to probe: if the service is bound to a specific non-loopback
    // address (LAN or Tailscale), probing 127.0.0.1 would always fail.
    const probeHost = (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '*' || !bindHost)
        ? '127.0.0.1'
        : bindHost;
    // Probe http and https in parallel — half the latency vs sequential
    const [httpRes, httpsRes] = await Promise.all([
        probeProtocol('http', port, probeHost),
        probeProtocol('https', port, probeHost),
    ]);
    if (httpRes?.isWebUi) return httpRes;
    if (httpsRes?.isWebUi) return httpsRes;
    if (httpRes) return httpRes;
    if (httpsRes) return httpsRes;
    return { isWebUi: false, status: 'down', protocol: null, title: null, faviconHref: null };
};

const findProjectIconInCwd = (cwd) => {
    if (!cwd || !fs.existsSync(cwd)) return null;
    const candidates = [
        'favicon.ico', 'favicon.png', 'favicon.svg',
        'logo.png', 'logo.svg', 'logo.jpg',
        'icon.png', 'icon.svg',
        'public/favicon.ico', 'public/favicon.png', 'public/favicon.svg',
        'public/logo.png', 'public/logo.svg',
        'src/assets/logo.svg', 'src/assets/logo.png',
        'assets/logo.svg', 'assets/logo.png'
    ];
    for (const cand of candidates) {
        const fullPath = path.join(cwd, cand);
        try {
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                return `/api/services/icon?path=${encodeURIComponent(fullPath)}`;
            }
        } catch (e) {}
    }
    return null;
};

const findLocalIcon = (pid) => {
    try {
        if (!pid) return null;
        const cwd = fs.realpathSync(`/proc/${pid}/cwd`);
        return findProjectIconInCwd(cwd);
    } catch (e) {}
    return null;
};

const findDockerComposeIcon = (composeProject) => {
    if (!composeProject) return null;
    try {
        const fsStacks = scanFilesystemForStacks();
        const match = fsStacks.find(s => s.name === composeProject);
        if (match && match.dir) {
            return findProjectIconInCwd(match.dir);
        }
    } catch (e) {}
    return null;
};

const resolveProcessName = (pid, rawProcessName) => {
    let processName = rawProcessName;
    try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmdline) {
            const parts = cmdline.split('\0').filter(Boolean);
            if (parts.length > 0) {
                const execName = path.basename(parts[0]);
                const isGeneric = GENERIC_EXEC_NAMES.some(g => rawProcessName.includes(g) || execName.includes(g) || rawProcessName.startsWith('next-server'));
                if (isGeneric) {
                    // Specific check for next-server / 9router combination
                    if (cmdline.includes('9router') || cmdline.includes('next-server')) {
                        return '9router';
                    }
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
        const processMatch = line.match(/users:\(\("([^"]+)",(?:.*?)pid=(\d+)/);
        // Extract local address:port from column 4 (0-indexed col 3 after splitting on whitespace).
        // ss format: State Recv-Q Send-Q Local-Addr:Port Peer-Addr:Port [Process]
        const cols = line.trim().split(/\s+/);
        const localAddrPort = cols[3];
        if (!localAddrPort) continue;
        const lastColon = localAddrPort.lastIndexOf(':');
        if (lastColon === -1) continue;
        const bindHost = localAddrPort.substring(0, lastColon);  // e.g. 10.1.1.100
        const port = parseInt(localAddrPort.substring(lastColon + 1));
        if (!port || isNaN(port)) continue;
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
        if (port === 80 || port === parseInt(PORT)) processName = 'Server Hub';

        const service = { name: processName, port, type: 'process', pid, usage: { cpu: 0, mem: 0 }, bindHost };
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
        ...(await probePort(s.port, s.bindHost)),
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
    let target = '';
    if (/^https?:\/\//i.test(href)) {
        target = href;
    } else if (href.startsWith('//')) {
        target = `${protocol}:${href}`;
    } else if (href.startsWith('/')) {
        target = `${protocol}://127.0.0.1:${port}${href}`;
    } else {
        target = `${protocol}://127.0.0.1:${port}/${href}`;
    }
    
    try {
        const parsed = new URL(target);
        if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname.startsWith('192.168.')) {
            return `/api/services/favicon-proxy?url=${encodeURIComponent(target)}`;
        }
    } catch (e) {}
    return target;
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
        const results = Object.values(grouped).map(s => {
            const override = (state.overrides && state.overrides[s.name]) || {};
            let localIcon = null;
            if (s.type === 'process' && s.pid) {
                localIcon = findLocalIcon(s.pid);
            } else if (s.type === 'docker' && s.composeProject) {
                localIcon = findDockerComposeIcon(s.composeProject);
            }
            return {
                ...s,
                port: s.ports.length > 0 ? (s.ports.length > 1 ? s.ports.sort((a, b) => a - b).join(', ') : s.ports[0]) : '—',
                url: s.isWebUi ? s.urls[0] : null,
                favicon: override.favicon || (s.isWebUi && s.favicons.length > 0 ? s.favicons[0] : null) || localIcon,
                displayName: override.label || (s.isWebUi && s.titles.length > 0 ? s.titles[0] : s.name),
            };
        });

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

app.post('/api/services/override', (req, res) => {
    const { name, isManual, manualId, label, favicon, url } = req.body || {};
    
    if (isManual || manualId) {
        const id = manualId;
        const m = (state.manual || []).find(x => x.id === id);
        if (m) {
            if (label !== undefined) m.label = label ? String(label).slice(0, 80) : null;
            if (favicon !== undefined) m.favicon = favicon ? String(favicon).slice(0, 500) : null;
            if (url !== undefined) {
                try {
                    new URL(url);
                    m.url = String(url).slice(0, 500);
                } catch (e) {
                    return res.status(400).json({ error: 'invalid url' });
                }
            }
            saveState();
            return res.json({ ok: true });
        }
        return res.status(404).json({ error: 'Manual service not found' });
    } else if (name) {
        if (!state.overrides) state.overrides = {};
        state.overrides[name] = {
            label: label ? String(label).slice(0, 80) : undefined,
            favicon: favicon ? String(favicon).slice(0, 500) : undefined,
        };
        saveState();
        return res.json({ ok: true });
    }
    
    res.status(400).json({ error: 'name or manualId is required' });
});

app.get('/api/services/icon', (req, res) => {
    const { path: filePath } = req.query;
    if (!filePath) return res.status(400).send('path required');
    const resolvedPath = path.resolve(filePath);
    
    const isSafePath = resolvedPath.startsWith('/home/ayman') || 
                       resolvedPath.startsWith('/opt/stacks') || 
                       resolvedPath.startsWith('/srv/stacks') || 
                       resolvedPath.startsWith('/etc/docker/compose');
                       
    if (!isSafePath) {
        return res.status(403).send('Forbidden');
    }
    
    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.webp': 'image/webp'
    };
    
    const mime = mimeTypes[ext];
    if (!mime) return res.status(400).send('Not an image');
    
    if (!fs.existsSync(resolvedPath)) {
        return res.status(404).send('Not found');
    }
    
    res.setHeader('Content-Type', mime);
    fs.createReadStream(resolvedPath).pipe(res);
});

app.get('/api/services/favicon-proxy', async (req, res) => {
    const { url: targetUrl } = req.query;
    if (!targetUrl) return res.status(400).send('url required');
    try {
        const parsed = new URL(targetUrl);
        if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && !parsed.hostname.startsWith('192.168.')) {
            return res.status(403).send('Forbidden target');
        }
        
        const response = await axios.get(targetUrl, {
            responseType: 'stream',
            timeout: 2000,
            httpsAgent: insecureHttpsAgent,
            validateStatus: () => true
        });
        
        res.setHeader('Content-Type', response.headers['content-type'] || 'image/x-icon');
        response.data.pipe(res);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/api/docker/control', async (req, res) => {
    const { name, action } = req.body || {};
    if (!name || !['start', 'stop', 'restart', 'remove'].includes(action)) {
        return res.status(400).json({ error: 'Invalid name or action' });
    }
    try {
        if (action === 'remove') {
            await runCommand(`docker rm -f ${shellQuote(name)}`);
        } else {
            await runCommand(`docker ${action} ${shellQuote(name)}`);
        }
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

const getSubnetRange = async () => {
    try {
        const routeOut = await runCommand("ip route show | grep default");
        if (routeOut) {
            const match = routeOut.match(/dev\s+(\S+)/);
            if (match) {
                const iface = match[1];
                const subnetOut = await runCommand(`ip route show | grep "dev ${iface}" | grep -v default | head -n 1`);
                if (subnetOut) {
                    const subnetMatch = subnetOut.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2})/);
                    if (subnetMatch) {
                        return subnetMatch[1];
                    }
                }
            }
        }
    } catch (e) {}
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    const parts = iface.address.split('.');
                    if (parts.length === 4) {
                        return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
                    }
                }
            }
        }
    } catch (e) {}
    return '192.168.1.0/24';
};

app.get('/api/health', async (req, res) => {
    const subnetRange = await getSubnetRange();
    res.json({
        ok: true,
        version: pkg.version,
        uptime: process.uptime(),
        targetUser: TARGET_USER,
        terminalTokenRequired: !!AGENT_TOKEN,
        subnetRange: subnetRange
    });
});

// Weather proxy — fetches wttr.in server-side (avoids CSP restrictions).
// Priority: ?city= (manual) > ?lat=&lon= (browser GPS) > server IP fallback.
let weatherCache = { key: '', at: 0, data: null };
app.get('/api/weather', async (req, res) => {
    const city = (req.query.city || '').toString().trim();
    const lat  = parseFloat(req.query.lat);
    const lon  = parseFloat(req.query.lon);

    // Build cache key and wttr.in location segment.
    let location = '';
    let key = '';
    if (city) {
        location = encodeURIComponent(city);
        key = `city:${city.toLowerCase()}`;
    } else if (!isNaN(lat) && !isNaN(lon)) {
        // wttr.in accepts coordinates as "-25.5,28.1"
        location = `${lat.toFixed(4)},${lon.toFixed(4)}`;
        // Round to ~1km grid so nearby refreshes hit the same cache slot.
        key = `geo:${lat.toFixed(2)},${lon.toFixed(2)}`;
    } else {
        // No location from client — fall back to server IP geolocation.
        key = 'ip';
    }

    const now = Date.now();
    if (weatherCache.data && weatherCache.key === key && (now - weatherCache.at) < 600000) {
        return res.json(weatherCache.data);
    }
    try {
        const target = `https://wttr.in/${location}?format=j1`;
        const r = await axios.get(target, {
            timeout: 8000,
            headers: { 'User-Agent': 'curl/8.0', 'Accept-Language': 'en' },
        });
        const current = r.data?.current_condition?.[0];
        const area    = r.data?.nearest_area?.[0];
        if (!current) return res.status(502).json({ error: 'No weather data' });
        const out = {
            temp:      current.temp_C,
            feelsLike: current.FeelsLikeC,
            desc:      current.weatherDesc?.[0]?.value || 'Unknown',
            humidity:  current.humidity,
            wind:      current.windspeedKmph,
            city:      area?.areaName?.[0]?.value || city || 'Here',
            region:    area?.region?.[0]?.value || '',
            country:   area?.country?.[0]?.value || '',
        };
        weatherCache = { key, at: now, data: out };
        res.json(out);
    } catch (e) {
        // Return stale cache rather than an error if we have any previous data.
        if (weatherCache.data) return res.json({ ...weatherCache.data, stale: true });
        res.status(502).json({ error: e.message || 'Weather fetch failed' });
    }
});

// CLI Usage Status — returns Claude CLI and agy usage data
app.get('/api/usage-status', async (req, res) => {
    try {
        const trackerPath = '/home/ayman/.openclaw/workspace/scripts/usage-api.sh';
        if (!fs.existsSync(trackerPath)) {
            return res.json({
                timestamp: new Date().toISOString(),
                claude: { status: 'unknown', reset_estimate: 'N/A', total_calls_24h: 0, hourly_calls: Array(24).fill(0), quota_percent: 0, checked_at: null },
                agy: { status: 'unknown', reset_estimate: 'N/A', total_calls_24h: 0, hourly_calls: Array(24).fill(0), quota_percent: 0, checked_at: null }
            });
        }
        exec(`bash ${trackerPath}`, { timeout: 10000 }, (error, stdout) => {
            if (error) {
                console.error('[usage-status] Error:', error.message);
                return res.json({
                    timestamp: new Date().toISOString(),
                    claude: { status: 'unknown', reset_estimate: 'N/A', total_calls_24h: 0, hourly_calls: Array(24).fill(0), quota_percent: 0, checked_at: null },
                    agy: { status: 'unknown', reset_estimate: 'N/A', total_calls_24h: 0, hourly_calls: Array(24).fill(0), quota_percent: 0, checked_at: null }
                });
            }
            try {
                res.json(JSON.parse(stdout));
            } catch (e) {
                console.error('[usage-status] Parse error:', e.message);
                res.json({
                    timestamp: new Date().toISOString(),
                    claude: { status: 'unknown', reset_estimate: 'N/A', total_calls_24h: 0, hourly_calls: Array(24).fill(0), quota_percent: 0, checked_at: null },
                    agy: { status: 'unknown', reset_estimate: 'N/A', total_calls_24h: 0, hourly_calls: Array(24).fill(0), quota_percent: 0, checked_at: null }
                });
            }
        });
    } catch (e) {
        console.error('[usage-status] Error:', e.message);
        res.json({
            timestamp: new Date().toISOString(),
            claude: { status: 'unknown', reset_estimate: 'N/A', total_calls_24h: 0, hourly_calls: Array(24).fill(0), quota_percent: 0, checked_at: null },
            agy: { status: 'unknown', reset_estimate: 'N/A', total_calls_24h: 0, hourly_calls: Array(24).fill(0), quota_percent: 0, checked_at: null }
        });
    }
});

const KNOWN_AGENTS = [
// jobArgs(task): returns { args, stdin } for non-interactive / batch execution.
// Every entry must suppress all permission prompts and exit when done.
    { id: 'claude',       label: 'Claude Code',           cmd: 'claude',      vendor: 'Anthropic',
      jobArgs: (t) => ({ args: ['--dangerously-skip-permissions', '--print', t], stdin: null }) },
    { id: 'claude-code',  label: 'Claude Code (alias)',   cmd: 'claude-code', vendor: 'Anthropic',
      jobArgs: (t) => ({ args: ['--dangerously-skip-permissions', '--print', t], stdin: null }) },
    { id: 'gemini',       label: 'Gemini CLI',             cmd: 'gemini',      vendor: 'Google',
      jobArgs: (t) => ({ args: ['-p', t, '--yolo'],                             stdin: null }) },
    { id: 'antigravity',  label: 'Antigravity (agy)',      cmd: 'agy',         vendor: 'Google DeepMind', altCmds: ['antigravity'],
      jobArgs: (t) => ({ args: ['--dangerously-skip-permissions', '--print', t], stdin: null }) },
    { id: 'codex',        label: 'OpenAI Codex CLI',       cmd: 'codex',       vendor: 'OpenAI',
      jobArgs: (t) => ({ args: ['exec', '--dangerously-bypass-approvals-and-sandbox', t], stdin: null }) },
    { id: 'opencode',     label: 'OpenCode',               cmd: 'opencode',    vendor: 'SST',
      jobArgs: (t) => ({ args: ['run', '--dangerously-skip-permissions', t], stdin: null }) },
    { id: 'kilocode',     label: 'Kilo Code',              cmd: 'kilocode',    vendor: 'Kilo',
      jobArgs: (t) => ({ args: ['run', '--dangerously-skip-permissions', '--auto', t], stdin: null }) },
    { id: 'kilo',         label: 'Kilo (alias)',            cmd: 'kilo',        vendor: 'Kilo',
      jobArgs: (t) => ({ args: ['run', '--dangerously-skip-permissions', '--auto', t], stdin: null }) },
    { id: 'aider',        label: 'Aider',                  cmd: 'aider',       vendor: 'Aider',
      jobArgs: (t) => ({ args: ['--message', t, '--yes', '--no-auto-commits'],  stdin: null }) },
    { id: 'cursor-agent', label: 'Cursor Agent',           cmd: 'cursor-agent',vendor: 'Cursor',
      jobArgs: (t) => ({ args: [],                                              stdin: t }) },
    { id: 'cody',         label: 'Sourcegraph Cody',       cmd: 'cody',        vendor: 'Sourcegraph',
      jobArgs: (t) => ({ args: [],                                              stdin: t }) },
    { id: 'amp',          label: 'Sourcegraph Amp',        cmd: 'amp',         vendor: 'Sourcegraph',
      jobArgs: (t) => ({ args: [],                                              stdin: t }) },
    { id: 'cline',        label: 'Cline',                  cmd: 'cline',       vendor: 'Cline',
      jobArgs: (t) => ({ args: [],                                              stdin: t }) },
    { id: 'qwen-code',    label: 'Qwen Code',              cmd: 'qwen-code',   vendor: 'Alibaba', altCmds: ['qwen'],
      jobArgs: (t) => ({ args: ['--dangerously-skip-permissions', '--print', t], stdin: null }) },
    { id: 'ollama',       label: 'Ollama',                 cmd: 'ollama',      vendor: 'Ollama',
      jobArgs: (t) => {
          const def = process.env.OLLAMA_DEFAULT_MODEL || 'llama3.2';
          let model = def, prompt = t;
          const sep = t.indexOf('::');
          if (sep > 0) { model = t.slice(0, sep).trim() || def; prompt = t.slice(sep + 2).trim(); }
          else { const fl = t.split('\n', 1)[0].trim(); if (fl && !/\s/.test(fl) && /[a-zA-Z]/.test(fl)) { model = fl; prompt = t.slice(fl.length).trim(); } }
          return { args: ['run', model, prompt], stdin: null };
      }},
    { id: 'goose',        label: 'Goose',                  cmd: 'goose',       vendor: 'Block',
      jobArgs: (t) => ({ args: ['run', '--no-session', '-m', t],               stdin: null }) },
];

const FALLBACK_SEARCH_DIRS = [
    '/home/linuxbrew/.linuxbrew/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
];

// Expand a single `*` segment in a path into all matching subdirectories.
// Used to cover version-manager layouts like ~/.nvm/versions/node/*/bin.
function globOnce(pattern) {
    const idx = pattern.indexOf('*');
    if (idx === -1) return [pattern];
    const before = pattern.slice(0, idx);
    const after = pattern.slice(idx + 1);
    const baseDir = before.endsWith('/') ? before.slice(0, -1) : path.dirname(before);
    let entries = [];
    try { entries = fs.readdirSync(baseDir); } catch { return []; }
    return entries.map(e => path.join(baseDir, e) + after);
}

// Every place a coding-agent binary might land, across package managers,
// version managers and OS install methods. Globs (nvm/fnm/n) are expanded.
function homeDirsFor(user) {
    const home = user === 'root' ? '/root' : `/home/${user}`;
    return [
        // system
        '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin',
        '/snap/bin', '/var/lib/flatpak/exports/bin',
        // homebrew
        '/opt/homebrew/bin', '/home/linuxbrew/.linuxbrew/bin', `${home}/.linuxbrew/bin`,
        // generic user bins
        `${home}/.local/bin`, `${home}/bin`, `${home}/.local/share/../bin`,
        // rust / go / deno / bun
        `${home}/.cargo/bin`, `${home}/go/bin`, `${home}/.deno/bin`, `${home}/.bun/bin`,
        // npm-style globals
        `${home}/.npm-global/bin`, `${home}/.npm-packages/bin`, `${home}/node_modules/.bin`,
        // pnpm
        `${home}/.local/share/pnpm`, `${home}/Library/pnpm`,
        // yarn (classic + berry global)
        `${home}/.yarn/bin`, `${home}/.config/yarn/global/node_modules/.bin`,
        // node version managers
        `${home}/.volta/bin`,
        `${home}/.nvm/versions/node/*/bin`,
        `${home}/.fnm/node-versions/*/installation/bin`,
        `${home}/.local/share/fnm/node-versions/*/installation/bin`,
        `${home}/n/bin`, '/usr/local/n/versions/node/*/bin',
        // polyglot version managers (shims)
        `${home}/.asdf/shims`, `${home}/.asdf/bin`,
        `${home}/.local/share/mise/shims`,
        // python toolchains
        `${home}/.pyenv/shims`, `${home}/.rye/shims`, `${home}/.pixi/bin`,
    ];
}

function staticSearchDirs(user) {
    const raw = [];
    for (const p of homeDirsFor(user)) for (const d of globOnce(p)) raw.push(d);
    // The server runs as root, so agents installed under /root are reachable too.
    if (user !== 'root') {
        for (const p of homeDirsFor('root')) for (const d of globOnce(p)) raw.push(d);
    }
    const seen = new Set();
    const out = [];
    for (const d of raw) { if (d && !seen.has(d)) { seen.add(d); out.push(d); } }
    return out;
}

// Resolve a command name to an absolute path by scanning known dirs synchronously.
// sudo uses its own secure_path which doesn't include user dirs like ~/.local/bin or
// /home/linuxbrew, so we must resolve the full path before handing it to spawn+sudo.
function resolveCmdSync(cmd) {
    if (path.isAbsolute(cmd)) return cmd;
    const envDirs = (process.env.PATH || '').split(':').filter(Boolean);
    const searchDirs = [...envDirs, ...staticSearchDirs(TARGET_USER)];
    for (const dir of searchDirs) {
        try {
            const full = path.join(dir, cmd);
            const st = fs.statSync(full);
            if (st.isFile() && (st.mode & 0o111)) return full;
        } catch {}
    }
    return cmd;
}

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
    const pathDirs = raw.trim().split(':').filter(Boolean);
    const all = [...pathDirs, ...staticSearchDirs(user)];
    const seen = new Set();
    const out = [];
    for (const d of all) { if (d && !seen.has(d)) { seen.add(d); out.push(d); } }
    return out;
};

// Method B: ask the user's login shell where a command resolves. Catches
// shims, wrapper functions and anything on PATH that a static dir scan misses.
const whichViaShell = async (user, name) => {
    const out = (await runAsUser(user, `command -v ${shellQuote(name)} 2>/dev/null`, 1500)).trim();
    const line = out.split('\n').map(s => s.trim()).find(s => s.startsWith('/'));
    if (!line) return null;
    try {
        const st = fs.statSync(line);
        if (st.isFile() && (st.mode & 0o111)) {
            let real = line;
            try { real = fs.realpathSync(line); } catch (e) {}
            return { path: line, realPath: real };
        }
    } catch (e) {}
    return null;
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

// Try several conventional version flags — agents are inconsistent here.
const VERSION_FLAGS = [['--version'], ['-v'], ['version'], ['-V']];
const probeAgentVersion = async (user, absPath) => {
    for (const flags of VERSION_FLAGS) {
        const out = await runAsUserDirect(user, absPath, flags, 3000);
        if (out) {
            const m = out.match(/\d+\.\d+(?:\.\d+)?(?:[\w.+-]+)?/);
            if (m) return m[0];
        }
    }
    return null;
};

const discoverAgentsRaw = async () => {
    const dirs = await getUserPathDirs(TARGET_USER);
    const seen = new Map();   // realPath -> record
    const found = [];

    const register = (agent, hit, source) => {
        if (seen.has(hit.realPath)) {
            const existing = seen.get(hit.realPath);
            if (existing.id !== agent.id && !existing.aliases.includes(agent.cmd)) {
                existing.aliases.push(agent.cmd);
            }
            return;
        }
        const record = { ...agent, path: hit.path, realPath: hit.realPath, source, aliases: [], version: null };
        delete record.jobArgs; delete record.altCmds; // not serializable / not needed client-side
        seen.set(hit.realPath, record);
        found.push(record);
    };

    for (const agent of KNOWN_AGENTS) {
        const names = [agent.cmd, ...(agent.altCmds || [])];
        let hit = null, source = '';
        // Method A: scan every known install dir
        for (const name of names) {
            hit = findExecutable(dirs, name);
            if (hit) { source = path.dirname(hit.path); break; }
        }
        // Method B: fall back to the login shell's resolver (shims, functions, PATH)
        if (!hit) {
            for (const name of names) {
                hit = await whichViaShell(TARGET_USER, name);
                if (hit) { source = 'PATH'; break; }
            }
        }
        if (hit) register(agent, hit, source);
    }

    await Promise.all(found.map(async (a) => {
        a.version = await probeAgentVersion(TARGET_USER, a.path);
    }));
    return found;
};

const discoverAgents = async (force = false) => {
    const now = Date.now();
    if (!force && agentCache && (now - agentCacheTime) < AGENT_CACHE_TTL_MS) return agentCache;
    if (force) { agentCache = null; agentCacheTime = 0; }
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
        const force = req.query.refresh === '1' || req.query.refresh === 'true';
        const agents = await discoverAgents(force);
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
        const out = await runCommand("apt list --upgradable 2>/dev/null | grep -v '^Listing' || true");
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
        await runCommandThrow('apt-get update -q 2>&1');
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
    const { spawn } = require('child_process');
    const proc = spawn('apt-get', ['install', '--only-upgrade', '-y', ...packages], {
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => send({ type: 'log', text: d.toString() }));
    proc.stderr.on('data', (d) => send({ type: 'log', text: d.toString() }));
    proc.on('close', (code) => {
        updatesCache = null;
        send({ type: 'done', code });
        res.end();
    });
    res.on('close', () => { try { proc.kill(); } catch {} });
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
    const commentVal = typeof comment === 'string' ? comment.slice(0, 100) : 'server-hub-key';
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

// ─── Docker Status & Installation & Containers ──────────────────────────────────
app.get('/api/docker/status', async (req, res) => {
    try {
        const dockerVer = await runCommand('docker --version');
        const installed = !!dockerVer && dockerVer.trim().startsWith('Docker version');
        let composeVer = '';
        let running = false;
        if (installed) {
            const composeOut = await runCommand('docker compose version');
            composeVer = composeOut ? composeOut.trim() : '';
            const pingOut = await runCommand('docker info 2>/dev/null');
            running = !!pingOut && pingOut.includes('Containers:');
        }
        res.json({
            installed,
            version: dockerVer ? dockerVer.trim() : '',
            composeVersion: composeVer,
            running
        });
    } catch (e) {
        res.json({ installed: false, version: '', composeVersion: '', running: false });
    }
});

app.post('/api/docker/install', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
    
    const { spawn } = require('child_process');
    const shellScript = `
        echo "=== Updating package lists ==="
        sudo apt-get update -y
        
        echo "=== Installing dependencies ==="
        sudo apt-get install -y curl ca-certificates gnupg
        
        echo "=== Installing Docker via convenience script ==="
        curl -fsSL https://get.docker.com -o get-docker.sh
        sudo sh get-docker.sh
        rm -f get-docker.sh
        
        echo "=== Enabling and starting Docker service ==="
        sudo systemctl enable --now docker
        
        echo "=== Adding current user to docker group ==="
        sudo usermod -aG docker ayman
        
        echo "=== Verification ==="
        docker --version
        docker compose version
        
        echo "=== Done! Please restart or refresh the page if permission errors occur ==="
    `;
    
    const proc = spawn('bash', ['-c', shellScript], {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout.on('data', (d) => send({ type: 'log', text: d.toString() }));
    proc.stderr.on('data', (d) => send({ type: 'log', text: d.toString() }));
    proc.on('close', (code) => {
        send({ type: 'done', code });
        res.end();
    });
    res.on('close', () => { try { proc.kill(); } catch {} });
});

app.get('/api/docker/containers', async (req, res) => {
    try {
        const out = await runCommand("docker ps -a --format '{{json .}}' 2>/dev/null");
        const containers = out.trim().split('\n').filter(Boolean).map(line => {
            try {
                return JSON.parse(line);
            } catch { return null; }
        }).filter(Boolean);
        res.json({ containers });
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
const AGENT_JOBS_FILE = process.env.AGENT_JOBS_FILE || '/var/lib/server-hub/agent-jobs.json';
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

// Strip ANSI escape sequences from agent output so stored text is readable.
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*[\x07\x1b\\]|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
function stripAnsi(str) { return str.replace(ANSI_RE, ''); }

function ajBuildCmd(agentId, task) {
    if (agentId === 'shell') return { cmd: 'bash', args: ['-c', task], stdin: null };

    // Look up metadata from KNOWN_AGENTS — driven entirely by the registry entry
    const meta = KNOWN_AGENTS.find(a => a.id === agentId);
    if (meta?.jobArgs) {
        const { args, stdin } = meta.jobArgs(task);
        return { cmd: meta.cmd, args, stdin };
    }

    // Unknown / future agent: try common patterns based on help probe (best-effort)
    const cmd = meta?.cmd || agentId;
    return { cmd, args: [], stdin: task };
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

    const { cmd: rawCmd, args, stdin } = ajBuildCmd(job.agentId, job.task);
    const cmd = resolveCmdSync(rawCmd);
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

    // Build subprocess env.
    // IMPORTANT: The server runs as root so process.env.HOME=/root.
    // We always force HOME/USER/LOGNAME to the target user so agents find
    // their credentials/config in the right place (~/.gemini, ~/.claude, etc.).
    const userHome = `/home/${TARGET_USER}`;
    const env = {};
    for (const k of ALLOWED_ENV_PASSTHROUGH) if (process.env[k] != null) env[k] = process.env[k];
    Object.assign(env, {
        TERM: 'dumb',
        HOME: userHome,
        USER: TARGET_USER,
        LOGNAME: TARGET_USER,
        XDG_CONFIG_HOME: `${userHome}/.config`,
        XDG_DATA_HOME: `${userHome}/.local/share`,
        XDG_CACHE_HOME: `${userHome}/.cache`,
        PATH: process.env.PATH || `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${userHome}/.local/bin:/home/linuxbrew/.linuxbrew/bin`,
    });

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
        buf += stripAnsi(d.toString());
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

// Agent-jobs scheduler — handles both cron (recurring) and runAt (one-time)
let ajSchedMin = -1;
setInterval(() => {
    const now = new Date();
    const min = now.getMinutes();
    try {
        const jobs = loadJobs();
        let dirty = false;
        for (const j of jobs) {
            if (ajRunning.has(j.id)) continue;
            // One-time: runAt is set and due
            if (j.enabled && j.runAt && new Date(j.runAt) <= now) {
                console.log(`[AgentJobs] one-time trigger: ${j.name}`);
                j.runAt = null;
                dirty = true;
                ajExecute(j);
            }
            // Recurring: cron expression, only fire once per minute
            if (min !== ajSchedMin && j.enabled && j.schedule && !j.runAt) {
                if (isCronDue(j.schedule, now)) {
                    console.log(`[AgentJobs] cron trigger: ${j.name}`);
                    ajExecute(j);
                }
            }
        }
        if (dirty) saveJobs(jobs);
    } catch (e) { console.error('[AgentJobs] scheduler:', e.message); }
    ajSchedMin = min;
}, 10000);

// ── Agent Jobs API ────────────────────────────────────────────────────────────
app.get('/api/agent-jobs', (req, res) => {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || 'UTC';
        res.json({
            jobs: loadJobs().map(j => ({ ...j, isRunning: ajRunning.has(j.id), runs: (j.runs || []).map((r, i) => ({ ...r, output: i === 0 ? r.output : undefined })) })),
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
        const { name, agentId, workspaceId, task, schedule, runAt, timeout, enabled } = req.body || {};
        if (!name?.trim() || !agentId || !task?.trim()) return res.status(400).json({ error: 'name, agentId, task required' });
        const job = {
            id: crypto.randomBytes(8).toString('hex'),
            name: name.trim().slice(0, 80), agentId,
            workspaceId: workspaceId || null,
            task: task.trim().slice(0, 8000),
            schedule: schedule || null,
            runAt: runAt || null,
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
        const { name, agentId, workspaceId, task, schedule, runAt, timeout, enabled } = req.body || {};
        const j = list[idx];
        if (name !== undefined) j.name = name.trim().slice(0, 80);
        if (agentId !== undefined) j.agentId = agentId;
        if (workspaceId !== undefined) j.workspaceId = workspaceId;
        if (task !== undefined) j.task = task.trim().slice(0, 8000);
        if (schedule !== undefined) j.schedule = schedule || null;
        if (runAt !== undefined) j.runAt = runAt || null;
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

// SSE stream of live job output (polls buffer every 300ms until job finishes)
app.get('/api/agent-jobs/:id/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
    let lastLen = 0;
    let done = false;

    const tick = () => {
        if (done) return;
        const live = ajRunning.get(req.params.id);
        if (live) {
            if (live.buf.length > lastLen) {
                send({ type: 'chunk', text: live.buf.slice(lastLen) });
                lastLen = live.buf.length;
            }
            return;
        }
        // Job finished (or never ran) — flush any tail that wasn't streamed yet
        const job = loadJobs().find(j => j.id === req.params.id);
        const lastRun = job?.runs?.[0];
        if (lastRun?.output && lastLen < lastRun.output.length) {
            send({ type: 'chunk', text: lastRun.output.slice(lastLen) });
        }
        send({ type: 'done', status: lastRun?.status || 'idle', exitCode: lastRun?.exitCode ?? null });
        done = true;
        clearInterval(iv);
        res.end();
    };

    const iv = setInterval(tick, 300);
    tick();

    res.on('close', () => { done = true; clearInterval(iv); });
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

// ─── Metrics History ──────────────────────────────────────────────────────────
const METRICS_FILE = process.env.METRICS_FILE || '/var/lib/server-hub/metrics.jsonl';

function appendMetricSample(s) {
    try {
        fs.mkdirSync(path.dirname(METRICS_FILE), { recursive: true });
        fs.appendFileSync(METRICS_FILE, JSON.stringify(s) + '\n');
    } catch (e) {}
}

let metricsLastTrim = 0;
function maybeTrimMetrics() {
    const now = Date.now();
    if (now - metricsLastTrim < 3_600_000) return;
    metricsLastTrim = now;
    try {
        const lines = fs.readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean);
        const max = 20160; // 7 days at 30 s intervals
        if (lines.length > max) fs.writeFileSync(METRICS_FILE, lines.slice(-max).join('\n') + '\n');
    } catch (e) {}
}

setInterval(() => {
    if (!currentSystemStats) return;
    appendMetricSample({
        t: Date.now(),
        cpu: +(currentSystemStats.cpu || 0).toFixed(1),
        ram: +(currentSystemStats.ram || 0).toFixed(1),
        rx: +(currentSystemStats.network?.rxMbps || 0).toFixed(2),
        tx: +(currentSystemStats.network?.txMbps || 0).toFixed(2),
        gpu: +(currentSystemStats.gpu || 0).toFixed(1),
    });
    maybeTrimMetrics();
}, 30000);

app.get('/api/metrics/history', (req, res) => {
    const range = req.query.range || '1h';
    const rangeMs = { '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000 }[range] || 3_600_000;
    const cutoff = Date.now() - rangeMs;
    try {
        if (!fs.existsSync(METRICS_FILE)) return res.json({ samples: [], range });
        let samples = fs.readFileSync(METRICS_FILE, 'utf8')
            .split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(s => s && s.t >= cutoff);
        const maxPts = 300;
        if (samples.length > maxPts) {
            const step = Math.ceil(samples.length / maxPts);
            samples = samples.filter((_, i) => i % step === 0);
        }
        res.json({ samples, range });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── LAN Scanner (Enhanced) ───────────────────────────────────────────────────
const { promises: dnsPromises } = require('dns');
const dgram = require('dgram');
const LAN_LABELS_FILE = '/var/lib/server-hub/lan-labels.json';

const COMMON_OUIS = {
    '00:50:56': 'VMware',      '00:0C:29': 'VMware',      '00:15:5D': 'Hyper-V',
    'DC:A6:32': 'Raspberry Pi','B8:27:EB': 'Raspberry Pi','E4:5F:01': 'Raspberry Pi',
    '00:11:32': 'Synology',    '00:08:9B': 'QNAP',        'D8:D6:68': 'Western Digital',
    '74:DA:38': 'TP-Link',     'C4:6E:1F': 'TP-Link',     '50:C7:BF': 'TP-Link',    '98:DA:C4': 'TP-Link',
    '18:D6:C7': 'ASUS',        '04:D4:C4': 'ASUS',        'F8:32:E4': 'ASUS',
    'FC:34:97': 'Amazon',      '40:B4:CD': 'Amazon',       '50:F5:DA': 'Amazon',
    '00:1A:11': 'Google',      'F4:F5:D8': 'Google',       '20:DF:B9': 'Google',     'CC:F4:11': 'Google',
    'AC:BC:32': 'Apple',       'A4:83:E7': 'Apple',        'F0:18:98': 'Apple',      '28:6D:CD': 'Samsung',
    '14:91:82': 'Xiaomi',      '64:64:4A': 'Xiaomi',       '28:6C:07': 'Xiaomi',
    '70:5A:0F': 'Netgear',     'C4:04:15': 'Netgear',
    'C8:D3:A3': 'D-Link',      'B0:C5:54': 'D-Link',
    '00:1D:7E': 'Cisco-Linksys','00:25:9C': 'Cisco',
    '80:2A:A8': 'Ubiquiti',    'F4:92:BF': 'Ubiquiti',    'FC:EC:DA': 'Ubiquiti',
    '08:65:F0': 'JM Zengge',
};
function getMfr(mac) {
    if (!mac) return null;
    const u = mac.toUpperCase();
    return COMMON_OUIS[u.slice(0, 8)] || COMMON_OUIS[u.slice(0, 5)] || null;
}

function loadLanLabels() {
    try { return JSON.parse(fs.readFileSync(LAN_LABELS_FILE, 'utf8')); } catch { return {}; }
}
function saveLanLabels(labels) {
    fs.mkdirSync(path.dirname(LAN_LABELS_FILE), { recursive: true });
    fs.writeFileSync(LAN_LABELS_FILE, JSON.stringify(labels, null, 2));
}

async function reverseDns(ip) {
    try { const n = await dnsPromises.reverse(ip); return n[0] || null; } catch { return null; }
}

async function nmblookupName(ip) {
    return new Promise(resolve => {
        exec(`nmblookup -A ${shellQuote(ip)} 2>/dev/null`, { timeout: 1500 }, (err, out) => {
            if (!out) return resolve(null);
            const m = out.match(/^\s+(\S+)\s+<00>\s+-\s+B\s+<ACTIVE>/m);
            resolve(m ? m[1].trim() : null);
        });
    });
}

function sendWolPacket(mac, broadcast = '255.255.255.255') {
    const hex = mac.replace(/[:\-]/g, '');
    if (hex.length !== 12) throw new Error('Invalid MAC');
    const macBuf = Buffer.from(hex, 'hex');
    const magic = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBuf)]);
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        sock.bind(() => {
            sock.setBroadcast(true);
            sock.send(magic, 0, magic.length, 9, broadcast, err => { sock.close(); err ? reject(err) : resolve(); });
        });
    });
}

const IP_VALID_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const MAC_VALID_RE = /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/;
const isValidIp = ip => IP_VALID_RE.test(ip) && ip.split('.').every(n => +n <= 255);

// GET /api/network/lan — ARP table with parallel hostname resolution
app.get('/api/network/lan', async (req, res) => {
    try {
        const neighOut = await runCommand('ip neigh show 2>/dev/null');
        const devices = {};
        for (const line of neighOut.trim().split('\n').filter(Boolean)) {
            const m = line.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+dev\s+(\S+)\s+(?:lladdr\s+([a-f0-9:]+)\s+)?(\S+)/i);
            if (!m) continue;
            const [, ip, iface, mac, state] = m;
            if (state === 'FAILED') continue;
            devices[ip] = { ip, mac: mac ? mac.toUpperCase() : null, iface, state: state.toLowerCase(), hostname: null, vendor: getMfr(mac), latency: null };
        }
        const labels = loadLanLabels();
        await Promise.all(Object.keys(devices).map(async ip => {
            const d = devices[ip];
            d.hostname = await reverseDns(ip);
            if (!d.hostname) d.hostname = await nmblookupName(ip);
            if (d.mac && labels[d.mac.toUpperCase()]) d.label = labels[d.mac.toUpperCase()];
        }));
        res.json({ devices: Object.values(devices), scannedAt: Date.now() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/network/lan/scan — active nmap scan, SSE
app.post('/api/network/lan/scan', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };

    try {
        const customSubnet = typeof req.body?.subnet === 'string' && req.body.subnet.trim() ? req.body.subnet.trim() : null;
        const subnet = customSubnet || await getSubnetRange();
        send({ type: 'status', msg: `Scanning ${subnet}…` });

        const nmapBin = (await runCommand('which nmap 2>/dev/null')).trim();
        if (nmapBin) {
            const proc = spawn('nmap', ['-sn', '-T4', subnet]);
            let buf = '';
            let cur = null;
            const labels = loadLanLabels();
            const flush = async () => {
                if (!cur) return;
                const d = cur; cur = null;
                if (!d.hostname) d.hostname = await reverseDns(d.ip);
                if (!d.hostname && d.mac) d.hostname = await nmblookupName(d.ip);
                if (d.mac && labels[d.mac]) d.label = labels[d.mac];
                send({ type: 'device', ...d });
            };
            proc.stdout.on('data', d => {
                buf += d.toString();
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    const hm = line.match(/^Nmap scan report for (.+)/);
                    if (hm) {
                        // fire-and-forget flush of previous device so we don't block stream
                        if (cur) { const prev = cur; cur = null; (async () => { if (!prev.hostname) prev.hostname = await reverseDns(prev.ip); send({ type: 'device', ...prev }); })(); }
                        const wh = hm[1].match(/^(.+?)\s+\((\d+\.\d+\.\d+\.\d+)\)$/);
                        cur = wh ? { ip: wh[2], hostname: wh[1], mac: null, vendor: null, latency: null }
                                 : { ip: hm[1].trim(), hostname: null, mac: null, vendor: null, latency: null };
                        continue;
                    }
                    if (!cur) continue;
                    const lm = line.match(/Host is up \(([0-9.]+)s latency\)/);
                    if (lm) { cur.latency = Math.round(parseFloat(lm[1]) * 1000); continue; }
                    const mm = line.match(/MAC Address: ([0-9A-Fa-f:]{17})\s+\(([^)]+)\)/);
                    if (mm) { cur.mac = mm[1].toUpperCase(); cur.vendor = mm[2] !== 'Unknown' ? mm[2] : null; }
                }
            });
            proc.stderr.on('data', () => {});
            proc.on('close', async () => {
                await flush();
                send({ type: 'done', subnet }); res.end();
            });
            res.on('close', () => { try { proc.kill(); } catch {} });
        } else {
            const base = subnet.replace(/\.\d+\/\d+$/, '');
            send({ type: 'status', msg: `nmap not found — ping sweep of ${base}.1-254…` });
            const proc = spawn('bash', ['-c', `for i in $(seq 1 254); do (ping -c1 -W1 ${base}.$i &>/dev/null && echo ${base}.$i) & done; wait`]);
            let buf = '';
            proc.stdout.on('data', d => {
                buf += d.toString();
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines.filter(Boolean)) send({ type: 'device', ip: line.trim(), hostname: null, mac: null, vendor: null, latency: null });
            });
            proc.stderr.on('data', () => {});
            proc.on('close', () => { send({ type: 'done', subnet }); res.end(); });
            res.on('close', () => { try { proc.kill(); } catch {} });
        }
    } catch (e) {
        send({ type: 'error', msg: e.message });
        res.end();
    }
});

// POST /api/network/lan/portscan — per-device port scan, SSE
const DEFAULT_SCAN_PORTS = '21,22,23,25,53,80,443,445,3306,3389,5900,8080,8443,9000,9090,27017';
app.post('/api/network/lan/portscan', (req, res) => {
    const { ip, ports } = req.body || {};
    if (!ip || !isValidIp(ip)) return res.status(400).json({ error: 'Invalid IP' });
    const portList = (typeof ports === 'string' && /^[\d,\-]+$/.test(ports)) ? ports : DEFAULT_SCAN_PORTS;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };

    send({ type: 'status', msg: `Scanning ${ip}…` });
    const proc = spawn('nmap', ['-sV', '--version-intensity', '0', '-T4', '--open', '-p', portList, ip]);
    let buf = '';
    const open = [];
    let inTable = false;
    proc.stdout.on('data', d => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
            if (/^PORT\s+STATE\s+SERVICE/.test(line)) { inTable = true; continue; }
            if (!inTable) continue;
            const pm = line.match(/^(\d+)\/(tcp|udp)\s+(\S+)\s+(\S+)\s*(.*)/);
            if (pm) {
                const p = { port: +pm[1], proto: pm[2], state: pm[3], service: pm[4], version: pm[5].trim() };
                open.push(p);
                send({ type: 'port', ...p });
            }
        }
    });
    proc.stderr.on('data', () => {});
    proc.on('close', code => { send({ type: 'done', open, code }); res.end(); });
    res.on('close', () => { try { proc.kill(); } catch {} });
});

// GET /api/network/lan/labels
app.get('/api/network/lan/labels', (req, res) => res.json({ labels: loadLanLabels() }));

// POST /api/network/lan/labels
app.post('/api/network/lan/labels', (req, res) => {
    const { mac, label } = req.body || {};
    if (!mac || !MAC_VALID_RE.test(mac)) return res.status(400).json({ error: 'Invalid MAC' });
    const labels = loadLanLabels();
    const key = mac.toUpperCase().replace(/-/g, ':');
    if (label && label.trim()) labels[key] = label.trim(); else delete labels[key];
    saveLanLabels(labels);
    res.json({ ok: true });
});

// POST /api/network/lan/wol — Wake-on-LAN magic packet
app.post('/api/network/lan/wol', async (req, res) => {
    const { mac } = req.body || {};
    if (!mac || !MAC_VALID_RE.test(mac)) return res.status(400).json({ error: 'Invalid MAC' });
    try { await sendWolPacket(mac); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Environment Variables Manager ────────────────────────────────────────────
const ENV_DENIED = ['/etc', '/root', '/boot', '/usr', '/var', '/proc', '/sys', '/dev'];
function safeEnvPath(p) {
    if (typeof p !== 'string' || !p) throw Object.assign(new Error('Invalid path'), { status: 400 });
    const abs = path.resolve(p);
    if (ENV_DENIED.some(d => abs === d || abs.startsWith(d + path.sep))) {
        throw Object.assign(new Error('Path denied'), { status: 403 });
    }
    return abs;
}

function parseEnvFile(content) {
    return content.split('\n').map(raw => {
        const line = raw.trimEnd();
        if (!line || line.startsWith('#')) return { type: line.startsWith('#') ? 'comment' : 'blank', raw: line };
        const eq = line.indexOf('=');
        if (eq < 1) return { type: 'unknown', raw: line };
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        const quoted = (val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"));
        if (quoted) val = val.slice(1, -1);
        return { type: 'pair', key, value: val, quoted, raw: line };
    });
}

function serializeEnvFile(entries) {
    return entries.map(e => {
        if (e.type !== 'pair') return e.raw;
        const needsQuote = /[ #"]/.test(e.value);
        const val = needsQuote ? `"${e.value.replace(/"/g, '\\"')}"` : e.value;
        return `${e.key}=${val}`;
    }).join('\n') + '\n';
}

app.get('/api/envfiles/find', (req, res) => {
    const { dir } = req.query;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    let safe;
    try { safe = safeEnvPath(dir); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const found = [];
    const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv']);
    function scan(d, depth) {
        if (depth > 4 || found.length >= 50) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (entry.isFile() && /^\.env/.test(entry.name)) found.push(path.join(d, entry.name));
            else if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith('.')) scan(path.join(d, entry.name), depth + 1);
        }
    }
    scan(safe, 0);
    res.json({ files: found });
});

app.get('/api/envfiles/read', (req, res) => {
    let safe;
    try { safe = safeEnvPath(req.query.path); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    try {
        const content = fs.readFileSync(safe, 'utf8');
        const entries = parseEnvFile(content);
        const examplePath = safe.replace(/\.env(\.[^.]+)?$/, '.env.example');
        let exampleKeys = [];
        if (fs.existsSync(examplePath)) {
            exampleKeys = parseEnvFile(fs.readFileSync(examplePath, 'utf8')).filter(e => e.type === 'pair').map(e => e.key);
        }
        res.json({ path: safe, entries, exampleKeys });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/envfiles/save', (req, res) => {
    const { path: p, entries } = req.body || {};
    let safe;
    try { safe = safeEnvPath(p); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries required' });
    try {
        fs.writeFileSync(safe, serializeEnvFile(entries), 'utf8');
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Package Manager ──────────────────────────────────────────────────────────
const PKG_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9.+\-:~]*$/;

app.get('/api/packages/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2 || q.length > 80) return res.status(400).json({ error: 'q must be 2–80 chars' });
    try {
        const [searchOut, installedOut] = await Promise.all([
            runCommand(`apt-cache search ${shellQuote(q)} 2>/dev/null | head -n 100`),
            runCommand("dpkg-query -W -f='${Package}\\n' 2>/dev/null"),
        ]);
        const installed = new Set(installedOut.trim().split('\n').filter(Boolean));
        const packages = searchOut.trim().split('\n').filter(Boolean).map(line => {
            const i = line.indexOf(' - ');
            if (i < 0) return null;
            return { name: line.slice(0, i).trim(), desc: line.slice(i + 3).trim(), installed: installed.has(line.slice(0, i).trim()) };
        }).filter(Boolean);
        res.json({ packages, query: q });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/packages/installed', async (req, res) => {
    const filter = (req.query.q || '').toLowerCase();
    try {
        const out = await runCommand("dpkg-query -W -f='${Package}\\t${Version}\\t${Installed-Size}\\t${Status}\\n' 2>/dev/null | head -n 2000");
        const packages = out.trim().split('\n').filter(Boolean).map(line => {
            const [name, version, size, ...statusParts] = line.split('\t');
            const status = statusParts.join('\t').trim();
            return { name: (name || '').trim(), version: (version || '').trim(), size: parseInt(size, 10) || 0, status };
        }).filter(p => p.name && p.status.startsWith('install ok') && (!filter || p.name.includes(filter)));
        res.json({ packages });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/packages/info', async (req, res) => {
    const { name } = req.query;
    if (!name || !PKG_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid package name' });
    try {
        const out = await runCommand(`apt-cache show ${shellQuote(name)} 2>/dev/null | head -n 50`);
        if (!out.trim()) return res.status(404).json({ error: 'Package not found' });
        const fields = {};
        let cur = null;
        for (const line of out.split('\n')) {
            if (/^\w/.test(line)) {
                const col = line.indexOf(':');
                if (col > 0) { cur = line.slice(0, col); fields[cur] = line.slice(col + 1).trim(); }
            } else if (cur && line.startsWith(' ') && ['Description', 'Depends', 'Recommends'].includes(cur)) {
                fields[cur] += ' ' + line.trim();
            }
        }
        res.json({ info: fields });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

function pkgSse(action, packages, req, res) {
    if (!Array.isArray(packages) || !packages.length) return res.status(400).json({ error: 'packages required' });
    if (!packages.every(p => PKG_NAME_RE.test(p))) return res.status(400).json({ error: 'Invalid package name(s)' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
    const proc = spawn('apt-get', [action, '-y', ...packages], {
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', d => send({ type: 'log', text: d.toString() }));
    proc.stderr.on('data', d => send({ type: 'log', text: d.toString() }));
    proc.on('close', code => { send({ type: 'done', code }); res.end(); });
    req.on('close', () => { try { proc.kill(); } catch {} });
}

app.post('/api/packages/install', (req, res) => pkgSse('install', req.body?.packages, req, res));
app.post('/api/packages/remove',  (req, res) => pkgSse('remove',  req.body?.packages, req, res));

// ─── Tmux-backed Terminal Session Store (declared here so API routes below can use it) ───
const TMUX_PREFIX           = 'sh-';
const TERM_SESSION_IDLE_TTL = 4 * 60 * 60 * 1000;
const termSessions          = new Map();

function tmuxRun(...args) {
    const cmd = TERMINAL_USER === 'root'
        ? ['tmux', ...args]
        : ['sudo', '-n', '-u', TERMINAL_USER, '--', 'tmux', ...args];
    try { execSync(cmd.join(' '), { stdio: 'ignore', timeout: 3000 }); return true; }
    catch { return false; }
}
function tmuxSessionExists(name) { return tmuxRun('has-session', '-t', name); }
function tmuxKillSession(name)   { tmuxRun('kill-session', '-t', name); }

// Pick up tmux sessions that survived a server restart
(function restoreOrphanedSessions() {
    try {
        const listCmd = TERMINAL_USER === 'root'
            ? `tmux list-sessions -F '#S' 2>/dev/null`
            : `sudo -n -u ${TERMINAL_USER} -- tmux list-sessions -F '#S' 2>/dev/null`;
        const out = execSync(listCmd, { encoding: 'utf8', timeout: 3000 });
        for (const line of out.split('\n').filter(l => l.startsWith(TMUX_PREFIX))) {
            const sid = line.slice(TMUX_PREFIX.length);
            if (sid && !termSessions.has(sid)) {
                termSessions.set(sid, { tmuxName: line, ws: null, lastActivity: Date.now(), cwd: null, agent: null, created: Date.now() });
            }
        }
        if (termSessions.size > 0)
            console.log(`[term-sessions] restored ${termSessions.size} orphaned tmux session(s)`);
    } catch {}
})();

setInterval(() => {
    const now = Date.now();
    for (const [sid, sess] of termSessions) {
        if (!sess.ws && now - sess.lastActivity > TERM_SESSION_IDLE_TTL) {
            console.log(`[term-sessions] evicting idle session ${sid}`);
            tmuxKillSession(sess.tmuxName);
            termSessions.delete(sid);
        }
    }
}, 15 * 60 * 1000);

// These must live before the SPA catch-all below
app.get('/api/terminal-sessions', (req, res) => {
    const list = [];
    for (const [id, s] of termSessions) {
        list.push({ id, agent: s.agent, cwd: s.cwd, connected: !!s.ws, created: s.created, lastActivity: s.lastActivity });
    }
    res.json({ sessions: list });
});
app.delete('/api/terminal-sessions/:sid', (req, res) => {
    const { sid } = req.params;
    const sess = termSessions.get(sid);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    try { if (sess.ws) sess.ws.close(); } catch {}
    tmuxKillSession(sess.tmuxName);
    termSessions.delete(sid);
    res.json({ ok: true });
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

    // ── Resolve session ID and decide new vs reconnect ─────────────────────
    const requestedSid = (query && query.sid) || null;
    let sid, isReconnect;

    if (requestedSid) {
        const tmuxName = TMUX_PREFIX + requestedSid;
        if (tmuxSessionExists(tmuxName)) {
            // tmux session is still alive — reattach to it
            sid         = requestedSid;
            isReconnect = true;
        } else {
            // Session died (server restart or idle eviction) — start fresh
            sid         = crypto.randomBytes(16).toString('hex');
            isReconnect = false;
        }
    } else {
        sid         = crypto.randomBytes(16).toString('hex');
        isReconnect = false;
    }

    const tmuxName = TMUX_PREFIX + sid;

    // ── Common setup: parse params, build env ──────────────────────────────
    let term;
    try {
        const agent = sanitizeAgent(query && query.agent);
        const cols  = Math.min(parseInt(query.cols, 10) || 100, 400);
        const rows  = Math.min(parseInt(query.rows, 10) || 30, 200);

        let spawnCwd = process.env.HOME || `/home/${TARGET_USER}`;
        if (typeof query.cwd === 'string' && query.cwd) {
            try {
                const safe = safeFilePath(query.cwd);
                if (fs.existsSync(safe) && fs.statSync(safe).isDirectory()) spawnCwd = safe;
            } catch {}
        }

        const spawnEnv = {
            TERM: 'xterm-256color',
            LANG: process.env.LANG || 'en_US.UTF-8',
            PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            HOME: process.env.HOME || `/home/${TARGET_USER}`,
        };
        if (typeof query.env === 'string' && query.env) {
            for (const name of query.env.split(',').map(s => s.trim()).filter(Boolean)) {
                if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name)) continue;
                if (!ALLOWED_ENV_PASSTHROUGH.includes(name)) continue;
                if (process.env[name] != null) spawnEnv[name] = process.env[name];
            }
        }

        // Docker sessions bypass tmux (containers manage their own lifecycle)
        if (query && query.docker) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(query.docker)) {
                ws.close(1008, 'Invalid container'); return;
            }
            term = pty.spawn('docker', ['exec', '-it', query.docker, 'sh'], {
                name: 'xterm-256color', cols, rows, env: spawnEnv, cwd: '/',
            });
            try { ws.send(JSON.stringify({ type: 'session', id: sid })); } catch {}
            term.onData(data => { if (ws.readyState === ws.OPEN) try { ws.send(Buffer.from(data)); } catch {} });
            term.onExit(() => { try { ws.close(); } catch {} });
            ws.on('message', msg => { try { term.write(msg.toString()); } catch {} });
            ws.on('close', () => { try { term.kill(); } catch {} });
            return;
        }

        // ── Spawn the PTY that attaches to our tmux session ────────────────
        // The outer shell is just a login wrapper so the env is correct for
        // the user. Once ready, it either creates (new) or attaches (reconnect)
        // to the named tmux session. The agent lives inside tmux, surviving
        // any number of browser disconnects and even server restarts.
        let shellCmd, shellArgs;
        if (TERMINAL_USER === 'root') {
            shellCmd  = 'bash';
            shellArgs = ['-l'];
        } else {
            shellCmd  = 'sudo';
            shellArgs = ['-n', '-u', TERMINAL_USER, '-i'];
        }

        term = pty.spawn(shellCmd, shellArgs, {
            name: 'xterm-256color', cols, rows, env: spawnEnv, cwd: spawnCwd,
        });

        // Register session BEFORE sending the session-id message so the
        // frontend can always reconnect with the id we are about to announce.
        const existingMeta = termSessions.get(sid);
        termSessions.set(sid, {
            tmuxName,
            ws,
            lastActivity: Date.now(),
            cwd:   existingMeta?.cwd   ?? spawnCwd,
            agent: existingMeta?.agent ?? (agent ? agent.id : null),
            created: existingMeta?.created ?? Date.now(),
        });

        try { ws.send(JSON.stringify({ type: 'session', id: sid })); } catch {}

        // Wait for the login shell to be ready, then hook into tmux
        setTimeout(() => {
            try {
                if (isReconnect) {
                    // Attach to the still-running tmux session
                    term.write(`tmux attach-session -t ${tmuxName}\n`);
                } else {
                    // Create a detached tmux session with the right cwd + agent,
                    // then attach to it. Using -A: attach if already exists (safety).
                    const agentCmd = agent ? agent.cmd : 'bash';
                    const cwdFlag  = `-c ${shellQuote(spawnCwd)}`;
                    term.write(
                        `tmux new-session -A -d -s ${tmuxName} ${cwdFlag} ${shellQuote(agentCmd)} ` +
                        `&& tmux attach-session -t ${tmuxName}\n`
                    );
                }
            } catch {}
        }, 600);

        const sess = termSessions.get(sid);
        term.onData(data => {
            sess.lastActivity = Date.now();
            if (sess.ws && sess.ws.readyState === sess.ws.OPEN) {
                try { sess.ws.send(Buffer.from(data)); } catch {}
            }
        });
        term.onExit(({ exitCode, signal }) => {
            // The PTY shell exited (user typed 'exit' inside tmux, or detached).
            // Don't remove the session from the Map — the tmux session may still be alive.
            const s = termSessions.get(sid);
            if (s && s.ws === ws) {
                const msg = `\r\n\x1b[33m[shell exited — click ↺ Reconnect to re-attach]\x1b[0m\r\n`;
                try { s.ws.send(msg); s.ws.close(); } catch {}
                s.ws = null;
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
            } catch (e) { console.error('terminal message error', e); }
        });
        ws.on('close', () => {
            // Kill the tmux-attach PTY shell, but the tmux session lives on.
            try { term.kill(); } catch {}
            const s = termSessions.get(sid);
            if (s && s.ws === ws) { s.ws = null; s.lastActivity = Date.now(); }
        });
    } catch (e) {
        console.error('terminal spawn failed', e);
        try { ws.send(`\r\n\x1b[31m[failed to start terminal: ${e.message}]\x1b[0m\r\n`); } catch {}
        try { ws.close(); } catch {}
        if (term) try { term.kill(); } catch {}
    }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server Hub v${pkg.version} on port ${PORT} (terminal user=${TARGET_USER}, lan-terminal=${TERMINAL_ALLOW_LAN})`));
