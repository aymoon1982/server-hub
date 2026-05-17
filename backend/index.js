const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
app.use(express.json());

const runCommand = (cmd) => {
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error executing command: ${cmd}`, error);
                return resolve('');
            }
            resolve(stdout);
        });
    });
};

let serviceProcessMap = {};

const getTemperatures = async () => {
    const temps = { cpu: 0, gpu: 0, disk: 0 };
    try {
        // CPU Temp
        const cpuTempRaw = await runCommand("cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -n 1");
        if (cpuTempRaw) temps.cpu = parseFloat(cpuTempRaw) / 1000;

        // GPU Temp (NVIDIA)
        const gpuTempRaw = await runCommand("nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader 2>/dev/null");
        if (gpuTempRaw) temps.gpu = parseFloat(gpuTempRaw);

        // Disk Temp (NVMe usually has a hwmon entry)
        const hwmonNames = await runCommand("grep -l 'nvme' /sys/class/hwmon/hwmon*/name 2>/dev/null");
        if (hwmonNames) {
            const hwmonDir = path.dirname(hwmonNames.split('\n')[0]);
            const diskTempRaw = await runCommand(`cat ${hwmonDir}/temp1_input 2>/dev/null`);
            if (diskTempRaw) temps.disk = parseFloat(diskTempRaw) / 1000;
        }
    } catch (e) {}
    return temps;
};

const discoverServices = async () => {
    const services = [];
    const seenPorts = new Set();
    const newMap = {};

    // 1. Docker Services
    try {
        const dockerStats = await runCommand("docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemPerc}}'");
        const statsMap = {};
        dockerStats.split('\n').filter(Boolean).forEach(line => {
            const [name, cpu, mem] = line.split('|');
            statsMap[name] = { cpu, mem };
        });

        const dockerOutput = await runCommand("docker ps --format '{{.Names}}|{{.Ports}}'");
        if (dockerOutput) {
            dockerOutput.split('\n').filter(Boolean).forEach(line => {
                const [rawName, portsInfo] = line.split('|');
                const name = rawName.split('.')[0];
                const portMatches = portsInfo.match(/:(\d+)->/g);
                if (portMatches) {
                    portMatches.forEach(match => {
                        const port = parseInt(match.replace(/[:->]/g, ''));
                        if (!seenPorts.has(port)) {
                            const stats = statsMap[rawName] || { cpu: '0%', mem: '0%' };
                            services.push({ 
                                name, 
                                port, 
                                type: 'docker',
                                usage: {
                                    cpu: parseFloat(stats.cpu),
                                    mem: parseFloat(stats.mem)
                                }
                            });
                            seenPorts.add(port);
                        }
                    });
                }
            });
        }
    } catch (e) {}

    // 2. Local Processes
    const ssOutput = await runCommand("ss -tlnp");
    if (ssOutput) {
        const lines = ssOutput.split('\n').slice(1);
        for (const line of lines) {
            const portMatch = line.match(/:(\d+)\s+/);
            const processMatch = line.match(/users:\(\("([^"]+)",(?:.*?)pid=(\d+)/);
            if (portMatch) {
                const port = parseInt(portMatch[1]);
                if (!seenPorts.has(port) && port !== PORT) {
                    let processName = 'Unknown Process';
                    let rawProcessName = '';
                    let pid = null;
                    if (processMatch) {
                        rawProcessName = processMatch[1];
                        processName = rawProcessName;
                        pid = processMatch[2];
                        try {
                            const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
                            if (cmdline) {
                                const parts = cmdline.split('\0').filter(Boolean);
                                if (parts.length > 0) {
                                    const execName = path.basename(parts[0]);
                                    const isGeneric = ['node', 'python', 'python3', 'MainThread', 'node-MainThread', 'deno', 'bun'].some(g => processName.includes(g) || execName.includes(g));
                                    if (isGeneric) {
                                        const scriptArg = parts.slice(1).find(p => !p.startsWith('-'));
                                        if (scriptArg) {
                                            let bestName = path.basename(scriptArg).replace(/\.[^/.]+$/, "");
                                            const genericFiles = ['index', 'main', 'server', 'app', 'run', 'start', 'cli'];
                                            if (genericFiles.includes(bestName.toLowerCase())) {
                                                const partsPath = scriptArg.split('/');
                                                if (partsPath.length > 1) {
                                                    for (let i = partsPath.length - 2; i >= 0; i--) {
                                                        const dir = partsPath[i];
                                                        if (dir && !['.', '..', 'src', 'dist', 'bin', '.bin', 'backend', 'frontend', 'node_modules', 'lib', '.local'].includes(dir.toLowerCase()) && !/^[0-9a-f]{8,}$/.test(dir)) {
                                                            bestName = dir;
                                                            break;
                                                        }
                                                    }
                                                }
                                            }
                                            processName = bestName;
                                        }
                                    }
                                }
                            }
                        } catch (e) {}
                        if (rawProcessName && processName) newMap[rawProcessName] = processName;
                    }

                    let usage = { cpu: 0, mem: 0 };
                    if (pid) {
                        const psOutput = await runCommand(`ps -p ${pid} -o %cpu,%mem --no-headers`);
                        if (psOutput) {
                            const [cpu, mem] = psOutput.trim().split(/\s+/);
                            usage = { cpu: parseFloat(cpu) || 0, mem: parseFloat(mem) || 0 };
                        }
                    }

                    if (processName === 'node-MainThread' || processName === 'MainThread') processName = 'Node App';
                    if (processName === 'python' || processName === 'python3') processName = 'Python App';
                    if (processName && /^[a-z]/.test(processName)) processName = processName.charAt(0).toUpperCase() + processName.slice(1);
                    if (port === 80 || port === parseInt(PORT)) processName = 'Hosted Dashboard';
                    
                    services.push({ name: processName, port, type: 'process', usage });
                    seenPorts.add(port);
                }
            }
        }
    }

    serviceProcessMap = newMap;

    const probeResults = await Promise.all(services.map(async (service) => {
        try {
            const response = await axios.get(`http://127.0.0.1:${service.port}`, { 
                timeout: 2000, 
                validateStatus: () => true,
                headers: { 'Accept': 'text/html', 'User-Agent': 'ServiceProbe/1.0' }
            });
            const contentType = response.headers['content-type'] || '';
            const isWebUi = contentType.includes('text/html') && response.status === 200;
            let title = null;
            if (isWebUi && typeof response.data === 'string') {
                const titleMatch = response.data.match(/<title>(.*?)<\/title>/i);
                if (titleMatch && titleMatch[1]) title = titleMatch[1].trim();
            }
            return { ...service, isWebUi, status: response.status, title: title };
        } catch (e) {
            return { ...service, isWebUi: false, status: 'down' };
        }
    }));
    return probeResults;
};

app.get('/api/services', async (req, res) => {
    try {
        const host = req.get('host').split(':')[0];
        const rawServices = await discoverServices();
        const grouped = rawServices.reduce((acc, s) => {
            if (!acc[s.name]) acc[s.name] = { name: s.name, type: s.type, ports: [], isWebUi: false, urls: [], titles: [], usage: { cpu: 0, mem: 0 } };
            acc[s.name].ports.push(s.port);
            acc[s.name].usage.cpu += s.usage.cpu;
            acc[s.name].usage.mem += s.usage.mem;
            if (s.isWebUi) {
                acc[s.name].isWebUi = true;
                acc[s.name].urls.push(`http://${host}:${s.port}`);
                if (s.title) acc[s.name].titles.push(s.title);
            }
            return acc;
        }, {});
        const results = Object.values(grouped).map(s => ({
            ...s,
            port: s.ports.length > 1 ? s.ports.sort((a, b) => a - b).join(', ') : s.ports[0],
            url: s.isWebUi ? s.urls[0] : null,
            displayName: s.isWebUi && s.titles.length > 0 ? s.titles[0] : s.name
        }));
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch services' });
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

        const topCpuOutput = await runCommand("ps -eo comm,pcpu --sort=-pcpu | head -n 11 | tail -n 10");
        const topCpu = topCpuOutput.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.trim().split(/\s+/);
            return { name: formatName(parts[0]), val: parseFloat(parts[1]) || 0 };
        });

        const topMemOutput = await runCommand("ps -eo comm,pmem --sort=-pmem | head -n 11 | tail -n 10");
        const topMem = topMemOutput.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.trim().split(/\s+/);
            return { name: formatName(parts[0]), val: parseFloat(parts[1]) || 0 };
        });

        const temps = await getTemperatures();
        const [usedMem, totalMem] = memDetailed.trim().split('|');
        
        res.json({
            cpu: parseFloat(cpuOutput.trim()) || 0,
            ram: parseFloat(memOutput.trim()) || 0,
            ramRaw: { used: parseInt(usedMem), total: parseInt(totalMem) },
            topCpu,
            topMem,
            temps
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

const frontendPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendPath)) {
    app.use(express.static(frontendPath));
    app.get(/.*/, (req, res) => res.sendFile(path.join(frontendPath, 'index.html')));
} else {
    app.get('/', (req, res) => res.send('Dashboard Backend is running. Frontend not built yet.'));
}

app.listen(PORT, '0.0.0.0', () => console.log(`Hosted Dashboard running on port ${PORT}`));
