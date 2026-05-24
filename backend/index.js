const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const url = require('url');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

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
        };
    } catch (e) {
        return { manual: [], history: {} };
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
app.use(express.json());

const runCommand = (cmd) => new Promise((resolve) => {
    exec(cmd, (error, stdout) => {
        if (error) {
            console.error(`Error executing command: ${cmd}`, error.message);
            return resolve('');
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

const DISCOVERY_TTL_MS = parseInt(process.env.DISCOVERY_TTL_MS || '5000', 10);
let discoveryCache = null;
let discoveryCacheTime = 0;
let inflightDiscovery = null;
let serviceProcessMap = {};

const getTemperatures = async () => {
    const temps = { cpu: 0, gpu: 0, disk: 0 };
    let gpuUtil = 0;
    try {
        const cpuTempRaw = await runCommand("cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -n 1");
        if (cpuTempRaw) temps.cpu = parseFloat(cpuTempRaw) / 1000;

        const gpuRaw = await runCommand("nvidia-smi --query-gpu=temperature.gpu,utilization.gpu --format=csv,noheader,nounits 2>/dev/null");
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

const probePort = async (port) => {
    if (NON_HTTP_PORTS.has(port)) {
        return { isWebUi: false, status: 'skipped', protocol: null, title: null, faviconHref: null };
    }
    for (const protocol of ['http', 'https']) {
        try {
            const cfg = {
                timeout: 2000,
                validateStatus: () => true,
                maxRedirects: 3,
                headers: { Accept: 'text/html', 'User-Agent': 'ServiceProbe/1.0' },
            };
            if (protocol === 'https') cfg.httpsAgent = insecureHttpsAgent;
            const response = await axios.get(`${protocol}://127.0.0.1:${port}`, cfg);
            const contentType = response.headers['content-type'] || '';
            const isWebUi = contentType.includes('text/html') && response.status >= 200 && response.status < 400;
            if (isWebUi && typeof response.data === 'string') {
                const titleMatch = response.data.match(/<title>(.*?)<\/title>/i);
                const title = titleMatch && titleMatch[1] ? titleMatch[1].trim() : null;
                const faviconHref = extractFaviconHref(response.data);
                return { isWebUi: true, status: response.status, protocol, title, faviconHref };
            }
            if (typeof response.status === 'number') {
                return { isWebUi: false, status: response.status, protocol: null, title: null, faviconHref: null };
            }
        } catch (e) {
            // try next protocol
        }
    }
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

    const [dockerStatsOut, dockerPsOut, ssOutput] = await Promise.all([
        runCommand("docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemPerc}}' 2>/dev/null || true"),
        runCommand("docker ps -a --format '{{.Names}}|{{.Ports}}|{{.Status}}|{{.Label \"com.docker.compose.project\"}}'"),
        runCommand("ss -tlnp"),
    ]);

    const statsMap = {};
    if (dockerStatsOut) {
        dockerStatsOut.split('\n').filter(Boolean).forEach(line => {
            const [name, cpu, mem] = line.split('|');
            statsMap[name] = { cpu, mem };
        });
    }

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

const discoverServices = async () => {
    const now = Date.now();
    if (discoveryCache && (now - discoveryCacheTime) < DISCOVERY_TTL_MS) {
        return discoveryCache;
    }
    if (inflightDiscovery) {
        return inflightDiscovery;
    }
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
    const { name, action } = req.body;
    if (!name || !['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ error: 'Invalid name or action' });
    }
    try {
        await runCommand(`docker ${action} ${JSON.stringify(name)}`);
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
        const logs = await runCommand(`docker logs --tail 200 ${JSON.stringify(name)} 2>&1`);
        res.json({ logs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/stats', async (req, res) => {
    try {
        const cpuOutput = await runCommand("top -bn1 | grep 'Cpu(s)' | awk '{print $2 + $4}'");
        const memOutput = await runCommand("free -m | grep Mem | awk '{print ($3/$2)*100}'");
        const memDetailed = await runCommand("free -m | grep Mem | awk '{print $3 \"|\" $2}'");

        const formatName = (name) => {
            const mapped = serviceProcessMap[name];
            if (mapped) return mapped;
            return name.length > 15 ? name.substring(0, 12) + '...' : name;
        };

        const coreCount = os.cpus().length || 1;
        const processMap = {};

        const parsePsOutput = (output) => {
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

        const [cpuRawOut, memRawOut] = await Promise.all([
            runCommand("ps -eo comm,pid,pcpu,pmem --sort=-pcpu | head -n 25 | tail -n 24"),
            runCommand("ps -eo comm,pid,pcpu,pmem --sort=-pmem | head -n 25 | tail -n 24")
        ]);

        parsePsOutput(cpuRawOut);
        parsePsOutput(memRawOut);

        try {
            const nvidiaOutput = await runCommand("nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null");
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
        } catch (e) {}

        const sortedProcesses = Object.values(processMap)
            .sort((a, b) => (b.cpu + b.mem + (b.gpu ? (b.gpu / 100) : 0)) - (a.cpu + a.mem + (a.gpu ? (a.gpu / 100) : 0)))
            .slice(0, 20);

        const topCpu = sortedProcesses.map(p => ({ name: p.name, val: p.cpu }));
        const topMem = sortedProcesses.map(p => ({ name: p.name, val: p.mem }));

        const { temps, gpuUtil } = await getTemperatures();
        const [usedMem, totalMem] = memDetailed.trim().split('|');

        res.json({
            cpu: parseFloat(cpuOutput.trim()) || 0,
            ram: parseFloat(memOutput.trim()) || 0,
            ramRaw: { used: parseInt(usedMem), total: parseInt(totalMem) },
            gpu: gpuUtil,
            topCpu,
            topMem,
            processes: sortedProcesses,
            temps,
        });
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
    { id: 'continue', label: 'Continue', cmd: 'continue', vendor: 'Continue' },
];

const FALLBACK_SEARCH_DIRS = [
    '/home/linuxbrew/.linuxbrew/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
];

const AGENT_CACHE_TTL_MS = parseInt(process.env.AGENT_CACHE_TTL_MS || '60000', 10);
let agentCache = null;
let agentCacheTime = 0;
let inflightAgentScan = null;

const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

const runAsUser = (user, cmd, timeoutMs = 2000) => new Promise((resolve) => {
    exec(`sudo -n -u ${shellQuote(user)} -- bash -lc ${shellQuote(cmd)}`, { timeout: timeoutMs }, (error, stdout, stderr) => {
        if (error && !stdout) return resolve('');
        resolve((stdout || '').toString());
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
    const out = await runAsUser(user, `${shellQuote(absPath)} --version 2>&1`, 4000);
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
    const { action } = req.body;
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
    const { name, originalName, path, comment, writable, browsable, guestOk, validUsers, forceUser } = req.body;
    try {
        const result = await samba.saveShare(name, {
            originalName, path, comment, writable, browsable, guestOk, validUsers, forceUser
        });
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
    const { workgroup, serverString, mapToGuest } = req.body;
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
    const { username, password, createSystemUser } = req.body;
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
    const { path: dirPath, owner, mode } = req.body;
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

const frontendPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendPath)) {
    app.use(express.static(frontendPath));
    app.get(/.*/, (req, res) => res.sendFile(path.join(frontendPath, 'index.html')));
} else {
    app.get('/', (req, res) => res.send('Dashboard Backend is running. Frontend not built yet.'));
}

const server = http.createServer(app);

const TERMINAL_ALLOW_LAN = process.env.DASHBOARD_TERMINAL_ALLOW_LAN !== 'false';
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
    const tokenOk = AGENT_TOKEN && parsed.query.key === AGENT_TOKEN;
    const allow = loopback || tokenOk || (TERMINAL_ALLOW_LAN && sameOrigin);
    if (!allow) {
        const reason = !sameOrigin ? 'origin-mismatch' : 'lan-disabled';
        socket.write(`HTTP/1.1 403 Forbidden\r\nX-Reject-Reason: ${reason}\r\n\r\n`);
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, parsed.query));
});

const TERMINAL_USER = TARGET_USER;
const sanitizeAgent = (raw) => {
    if (!raw) return null;
    return KNOWN_AGENTS.find(a => a.id === raw || a.cmd === raw) || null;
};

wss.on('connection', (ws, req, query) => {
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
                    connectConfig.privateKey = privateKey;
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
            command = 'docker';
            args = ['exec', '-it', query.docker, 'sh'];
        }

        term = pty.spawn(command, args, {
            name: 'xterm-256color',
            cols,
            rows,
            env: { TERM: 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' },
            cwd: '/',
        });

        if (agent) {
            setTimeout(() => {
                try { term.write(`${agent.cmd}\n`); } catch (e) {}
            }, 250);
        }

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
