const fs = require('fs');
const path = require('path');
const { exec, execFile, spawn } = require('child_process');
const os = require('os');

const SMB_CONF_PATH = '/etc/samba/smb.conf';

const RE_USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const RE_SHARE_NAME = /^[A-Za-z0-9_.-]{1,80}$/;
const RE_MODE = /^[0-7]{3,4}$/;
const RE_OWNER = /^[a-z_][a-z0-9_-]*(?::[a-z_][a-z0-9_-]*)?$/;
const RESERVED_SECTIONS = new Set(['global', 'homes', 'printers', 'print$']);
function assertSafe(re, value, label) {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}
function hasUnsafeChars(s) { return typeof s !== 'string' || /[\r\n\[\]]/.test(s); }

const BROWSE_ROOT = path.resolve(process.env.SAMBA_BROWSE_ROOT || '/');

const FORBIDDEN_TARGETS = new Set(['/', '/etc', '/root', '/home', '/boot', '/usr', '/var', '/proc', '/sys', '/dev', '/bin', '/sbin', '/lib', '/lib64']);

// Helper to run shell commands
const runCommand = (cmd) => new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            const trimmedErr = (stderr || '').trim();
            const sanitizedError = new Error('Command failed' + (trimmedErr ? `: ${trimmedErr}` : ''));
            sanitizedError.code = error.code;
            resolve({ code: error.code, stdout: stdout || '', stderr: trimmedErr, error: sanitizedError });
        } else {
            resolve({ code: 0, stdout: stdout || '', stderr: stderr || '' });
        }
    });
});

const runExecFile = (file, args) => new Promise((resolve) => {
    execFile(file, args, (error, stdout, stderr) => {
        if (error) {
            const trimmedErr = (stderr || '').trim();
            const sanitizedError = new Error('Command failed' + (trimmedErr ? `: ${trimmedErr}` : ''));
            sanitizedError.code = error.code;
            resolve({ code: error.code, stdout: stdout || '', stderr: trimmedErr, error: sanitizedError });
        } else {
            resolve({ code: 0, stdout: stdout || '', stderr: stderr || '' });
        }
    });
});

/**
 * Parses smb.conf content into structured sections.
 * Returns array of objects: { name: string|null, lines: Array<string>, properties: Object, isModified: boolean }
 */
function parseConfig(content) {
    const lines = content.split('\n');
    const sections = [];
    let currentSection = { name: null, lines: [], properties: {}, isModified: false };

    for (let line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            // Push previous section
            if (currentSection.name !== null || currentSection.lines.length > 0) {
                sections.push(currentSection);
            }
            const name = trimmed.substring(1, trimmed.length - 1).trim();
            currentSection = { name, lines: [], properties: {}, isModified: false };
        } else {
            currentSection.lines.push(line);
            // Parse property if it's key = value and not a comment
            if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith(';')) {
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx !== -1) {
                    const key = trimmed.substring(0, eqIdx).trim().toLowerCase();
                    const val = trimmed.substring(eqIdx + 1).trim();
                    currentSection.properties[key] = val;
                }
            }
        }
    }
    if (currentSection.name !== null || currentSection.lines.length > 0) {
        sections.push(currentSection);
    }
    return sections;
}

/**
 * Serializes sections back to smb.conf format.
 */
function serializeConfig(sections) {
    return sections.map(sec => {
        if (sec.name === null) {
            // Header lines
            return sec.lines.join('\n');
        }
        if (!sec.isModified) {
            // Keep original lines exactly
            return `[${sec.name}]\n` + sec.lines.join('\n');
        }
        // Generate from properties
        let out = `[${sec.name}]\n`;
        for (const [key, val] of Object.entries(sec.properties)) {
            out += `   ${key} = ${val}\n`;
        }
        return out;
    }).join('\n');
}

/**
 * Reads the config file.
 */
async function readConfFile() {
    try {
        const content = fs.readFileSync(SMB_CONF_PATH, 'utf8');
        return parseConfig(content);
    } catch (e) {
        console.error('Failed to read Samba config', e.message);
        throw new Error(`Cannot read Samba config: ${e.message}`);
    }
}

/**
 * Writes the config file and reloads Samba.
 */
async function writeConfFile(sections) {
    let tmpDir = null;
    try {
        const content = serializeConfig(sections);
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samba-'));
        const tmpFile = path.join(tmpDir, 'smb.conf');
        fs.writeFileSync(tmpFile, content, { flag: 'w' });

        const cpRes = await runExecFile('sudo', ['install', '-m', '0644', tmpFile, SMB_CONF_PATH]);
        if (cpRes.code !== 0) {
            throw new Error(`Failed to copy config file: ${cpRes.stderr}`);
        }

        const reloadRes = await runExecFile('sudo', ['systemctl', 'reload', 'smbd']);
        if (reloadRes.code !== 0) {
            const fallback = await runExecFile('sudo', ['service', 'smbd', 'reload']);
            if (fallback.code !== 0) {
                throw new Error(`Failed to reload Samba service: ${fallback.stderr}`);
            }
        }

        return true;
    } catch (e) {
        console.error('Failed to write Samba config', e.message);
        throw e;
    } finally {
        if (tmpDir) {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (err) {}
        }
    }
}

/**
 * Gets Samba service status and IP addresses.
 */
async function getStatus() {
    const status = { active: false, enabled: false, version: 'Unknown', uptime: '', pid: null, ips: [] };
    
    // Check version
    const verRes = await runCommand('smbd -V');
    if (verRes.code === 0) {
        status.version = verRes.stdout.trim();
    }
    
    // Check service active state
    const actRes = await runExecFile('systemctl', ['is-active', 'smbd']);
    status.active = actRes.stdout.trim() === 'active';

    // Check service enabled state
    const enRes = await runCommand('systemctl is-enabled smbd');
    status.enabled = enRes.stdout.trim() === 'enabled';
    
    // Check uptime & PID
    const psRes = await runCommand('systemctl status smbd');
    if (psRes.code === 0 || psRes.stdout) {
        const pidMatch = psRes.stdout.match(/Main PID:\s*(\d+)/);
        if (pidMatch) status.pid = parseInt(pidMatch[1], 10);
        
        const sinceMatch = psRes.stdout.match(/active\s*\(running\)\s*since\s*(.*?);/);
        if (sinceMatch) status.uptime = sinceMatch[1].trim();
    }

    // Resolve IPs (LAN, Tailscale, etc.)
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                // Determine connection type/tag
                let tag = 'LAN';
                if (name.includes('tailscale') || iface.address.startsWith('100.')) {
                    tag = 'Tailscale';
                } else if (name.includes('docker') || name.includes('br-') || name.includes('veth')) {
                    continue; // Skip virtual bridge networks
                }
                status.ips.push({ name, address: iface.address, tag });
            }
        }
    }
    
    return status;
}

/**
 * Toggles or restarts the Samba service.
 */
async function controlService(action) {
    const allowed = new Set(['start', 'stop', 'restart', 'enable', 'disable']);
    if (!allowed.has(action)) throw new Error(`Invalid action`);

    const res = await runExecFile('sudo', ['systemctl', action, 'smbd']);
    if (res.code !== 0) {
        throw new Error(`Failed to ${action} Samba: ${res.stderr}`);
    }
    return { ok: true };
}

/**
 * Returns list of user-configured shares.
 */
async function getShares() {
    const sections = await readConfFile();
    const systemSections = new Set(['global', 'printers', 'print$', 'homes', 'netlogon', 'profiles']);
    
    const shares = [];
    for (const sec of sections) {
        if (sec.name && !systemSections.has(sec.name.toLowerCase())) {
            const props = sec.properties;
            const isWritable = props['writable'] === 'yes' || props['read only'] === 'no';
            const isBrowsable = props['browseable'] !== 'no' && props['browsable'] !== 'no';
            const isGuestOk = props['guest ok'] === 'yes' || props['public'] === 'yes';
            const vfs = props['vfs objects'] || '';
            
            shares.push({
                name: sec.name,
                path: props['path'] || '',
                comment: props['comment'] || '',
                writable: isWritable,
                browsable: isBrowsable,
                guestOk: isGuestOk,
                validUsers: props['valid users'] || '',
                forceUser: props['force user'] || '',
                
                // Frontend compatibility fields
                readOnly: !isWritable,
                guest: isGuestOk,
                browseable: isBrowsable,
                users: (props['valid users'] || '').split(/[\s,]+/).filter(Boolean),
                createMask: props['create mask'] || props['create mode'] || '0664',
                dirMask: props['directory mask'] || props['directory mode'] || '0775',
                recycle: vfs.includes('recycle'),
                hostsAllow: props['hosts allow'] || '',
                hideDotfiles: props['hide dot files'] !== 'no'
            });
        }
    }
    return shares;
}

/**
 * Creates or updates a share.
 */
async function saveShare(name, config) {
    if (!name || typeof name !== 'string' || !name.trim()) throw new Error('Share name is required');
    const trimmedName = name.trim();
    if (RESERVED_SECTIONS.has(trimmedName.toLowerCase())) {
        throw new Error('Invalid share name');
    }
    assertSafe(RE_SHARE_NAME, trimmedName, 'share name');
    const sections = await readConfFile();

    // Check if share exists (case insensitive)
    const existingIndex = sections.findIndex(s => s.name && s.name.toLowerCase() === trimmedName.toLowerCase());

    const isWritable = config.writable !== undefined ? config.writable : (config.readOnly !== undefined ? !config.readOnly : true);
    const isBrowsable = config.browsable !== undefined ? config.browsable : (config.browseable !== undefined ? config.browseable : true);
    const isGuestOk = config.guestOk !== undefined ? config.guestOk : (config.guest !== undefined ? config.guest : false);

    const createMask = config.createMask || (isWritable ? '0664' : '0644');
    const dirMask = config.dirMask || (isWritable ? '0775' : '0755');
    assertSafe(RE_MODE, createMask, 'create mask');
    assertSafe(RE_MODE, dirMask, 'directory mask');

    const pathStr = config.path || '';
    const commentStr = config.comment || '';
    if (hasUnsafeChars(pathStr)) throw new Error('Invalid value for path');
    if (hasUnsafeChars(commentStr)) throw new Error('Invalid value for comment');

    // Create new section object
    const newSec = {
        name: trimmedName,
        isModified: true,
        properties: {
            path: pathStr,
            comment: commentStr,
            writable: isWritable ? 'yes' : 'no',
            'read only': isWritable ? 'no' : 'yes',
            browseable: isBrowsable ? 'yes' : 'no',
            'guest ok': isGuestOk ? 'yes' : 'no',
            'create mask': createMask,
            'directory mask': dirMask
        }
    };

    const usersStr = config.validUsers !== undefined ? config.validUsers : (Array.isArray(config.users) ? config.users.join(' ') : config.users || '');
    if (typeof usersStr === 'string' && usersStr.trim()) {
        if (hasUnsafeChars(usersStr)) throw new Error('Invalid value for validUsers');
        newSec.properties['valid users'] = usersStr.trim();
    }

    if (config.forceUser && typeof config.forceUser === 'string' && config.forceUser.trim()) {
        if (hasUnsafeChars(config.forceUser)) throw new Error('Invalid value for forceUser');
        newSec.properties['force user'] = config.forceUser.trim();
    }
    if (config.hostsAllow && typeof config.hostsAllow === 'string' && config.hostsAllow.trim()) {
        if (hasUnsafeChars(config.hostsAllow)) throw new Error('Invalid value for hostsAllow');
        newSec.properties['hosts allow'] = config.hostsAllow.trim();
    }
    if (config.hideDotfiles !== undefined) {
        newSec.properties['hide dot files'] = config.hideDotfiles ? 'yes' : 'no';
    }
    if (config.recycle) {
        newSec.properties['vfs objects'] = 'recycle';
        newSec.properties['recycle:repository'] = '.recycle';
        newSec.properties['recycle:keeptree'] = 'yes';
        newSec.properties['recycle:versions'] = 'yes';
    }

    for (const [key, value] of Object.entries(newSec.properties)) {
        if (typeof value === 'string' && hasUnsafeChars(value)) {
            throw new Error('Invalid value for ' + key);
        }
    }

    if (existingIndex !== -1) {
        // If we are renaming the share, we might have an originalName
        if (config.originalName && typeof config.originalName === 'string' && config.originalName.toLowerCase() !== trimmedName.toLowerCase()) {
            assertSafe(RE_SHARE_NAME, config.originalName.trim(), 'original share name');
            const origIndex = sections.findIndex(s => s.name && s.name.toLowerCase() === config.originalName.toLowerCase());
            if (origIndex !== -1) sections.splice(origIndex, 1);
            sections.push(newSec);
        } else {
            sections[existingIndex] = newSec;
        }
    } else {
        sections.push(newSec);
    }

    await writeConfFile(sections);
    return { ok: true };
}

/**
 * Deletes a share.
 */
async function deleteShare(name) {
    if (!name || typeof name !== 'string') throw new Error('Share name is required');
    assertSafe(RE_SHARE_NAME, name.trim(), 'share name');
    if (RESERVED_SECTIONS.has(name.trim().toLowerCase())) {
        throw new Error('Invalid share name');
    }
    const sections = await readConfFile();

    const index = sections.findIndex(s => s.name && s.name.toLowerCase() === name.toLowerCase());
    if (index === -1) throw new Error(`Share not found`);

    sections.splice(index, 1);
    await writeConfFile(sections);
    return { ok: true };
}

/**
 * Gets global properties.
 */
async function getGlobalSettings() {
    const sections = await readConfFile();
    const globalSec = sections.find(s => s.name && s.name.toLowerCase() === 'global');
    if (!globalSec) return { workgroup: 'WORKGROUP', 'server string': 'Samba Server', 'map to guest': 'bad user' };
    
    return {
        workgroup: globalSec.properties['workgroup'] || 'WORKGROUP',
        serverString: globalSec.properties['server string'] || '',
        mapToGuest: globalSec.properties['map to guest'] || 'bad user'
    };
}

/**
 * Saves global settings.
 */
async function saveGlobalSettings(config) {
    const sections = await readConfFile();
    let globalIndex = sections.findIndex(s => s.name && s.name.toLowerCase() === 'global');
    
    if (globalIndex === -1) {
        // Create global section if missing
        sections.unshift({
            name: 'global',
            isModified: true,
            properties: {}
        });
        globalIndex = 0;
    }
    
    const globalSec = sections[globalIndex];
    globalSec.isModified = true;

    const workgroup = config.workgroup || 'WORKGROUP';
    if (hasUnsafeChars(workgroup)) throw new Error('Invalid value for workgroup');
    globalSec.properties['workgroup'] = workgroup;
    if (config.serverString !== undefined) {
        if (hasUnsafeChars(config.serverString)) throw new Error('Invalid value for serverString');
        globalSec.properties['server string'] = config.serverString;
    }
    if (config.mapToGuest !== undefined) {
        if (hasUnsafeChars(config.mapToGuest)) throw new Error('Invalid value for mapToGuest');
        globalSec.properties['map to guest'] = config.mapToGuest;
    }

    for (const [key, value] of Object.entries(globalSec.properties)) {
        if (typeof value === 'string' && hasUnsafeChars(value)) {
            throw new Error('Invalid value for ' + key);
        }
    }

    await writeConfFile(sections);
    return { ok: true };
}

/**
 * Lists Samba users and system users.
 */
async function getUsers() {
    const sambaUsers = [];
    const systemUsers = [];

    // 1. Get Samba users from pdbedit
    const pdbRes = await runCommand('sudo pdbedit -L');
    if (pdbRes.code === 0) {
        const lines = pdbRes.stdout.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
                // Format: ayman:1000:Ayman
                const parts = trimmed.split(':');
                if (parts.length >= 2) {
                    sambaUsers.push({
                        username: parts[0],
                        uid: parts[1],
                        fullName: parts[2] || parts[0]
                    });
                }
            }
        }
    }

    // 2. Get system Unix users from /etc/passwd (UID >= 1000)
    try {
        const passwdContent = fs.readFileSync('/etc/passwd', 'utf8');
        const lines = passwdContent.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const parts = trimmed.split(':');
                // parts[0]: name, parts[2]: uid, parts[5]: home
                if (parts.length >= 6) {
                    const uid = parseInt(parts[2], 10);
                    if (uid >= 1000 && parts[0] !== 'nobody' && !parts[0].startsWith('snap')) {
                        systemUsers.push({
                            username: parts[0],
                            uid,
                            home: parts[5]
                        });
                    }
                }
            }
        }
    } catch (e) {
        console.error('Failed to read /etc/passwd', e.message);
    }

    return { sambaUsers, systemUsers };
}

/**
 * Creates or updates a Samba user.
 * Toggles system Unix user creation if user doesn't exist.
 */
async function saveUser(username, password, createSystemUser = false) {
    if (!username || typeof username !== 'string' || !username.trim()) throw new Error('Username is required');
    if (!password || typeof password !== 'string') throw new Error('Password is required');
    assertSafe(RE_USERNAME, username.trim(), 'username');
    if (password.includes('\n') || password.includes('\0')) {
        throw new Error('Invalid password');
    }
    const safeUser = username.trim();

    // Check if system user exists
    const usersInfo = await getUsers();
    const systemUserExists = usersInfo.systemUsers.some(u => u.username === safeUser);

    if (!systemUserExists) {
        if (!createSystemUser) {
            throw new Error(`Unix user does not exist. Enable "Create system user" first.`);
        }
        const userAddRes = await runExecFile('sudo', ['useradd', '-M', '-s', '/usr/sbin/nologin', safeUser]);
        if (userAddRes.code !== 0) {
            throw new Error(`Failed to create system user: ${userAddRes.stderr}`);
        }
    }

    // Configure Samba password (non-interactive) via stdin so it never touches argv/shell
    await new Promise((resolve, reject) => {
        const child = spawn('sudo', ['smbpasswd', '-s', '-a', safeUser]);
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', () => reject(new Error('Failed to set Samba password')));
        child.on('close', (code) => {
            if (code === 0) resolve();
            else {
                const trimmed = stderr.trim();
                reject(new Error('Failed to set Samba password' + (trimmed ? `: ${trimmed}` : '')));
            }
        });
        child.stdin.on('error', () => {});
        child.stdin.write(`${password}\n${password}\n`);
        child.stdin.end();
    });

    return { ok: true };
}

/**
 * Deletes a Samba user.
 */
async function deleteUser(username) {
    if (!username || typeof username !== 'string') throw new Error('Username is required');
    assertSafe(RE_USERNAME, username.trim(), 'username');

    const res = await runExecFile('sudo', ['smbpasswd', '-x', username.trim()]);
    if (res.code !== 0) {
        throw new Error(`Failed to delete Samba user: ${res.stderr}`);
    }
    return { ok: true };
}

/**
 * Lists active connections. Matches smbstatus -S with smbstatus -p.
 */
async function getConnections() {
    const pRes = await runCommand('sudo smbstatus -p');
    const sRes = await runCommand('sudo smbstatus -S');
    
    const sessions = [];
    let parsingP = false;
    if (pRes.code === 0 && pRes.stdout) {
        const lines = pRes.stdout.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('PID') && trimmed.includes('Username')) {
                parsingP = true;
                continue;
            }
            if (parsingP) {
                if (trimmed.startsWith('---') || trimmed.length === 0) continue;
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 4 && /^\d+$/.test(parts[0])) {
                    sessions.push({
                        pid: parts[0],
                        username: parts[1],
                        group: parts[2],
                        machine: parts.slice(3).join(' ')
                    });
                }
            }
        }
    }
    
    const conns = [];
    let parsingS = false;
    if (sRes.code === 0 && sRes.stdout) {
        const lines = sRes.stdout.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('Service') && trimmed.includes('pid') && trimmed.includes('Connected at')) {
                parsingS = true;
                continue;
            }
            if (parsingS) {
                if (trimmed.startsWith('---') || trimmed.length === 0) continue;
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
                    const pid = parts[1];
                    // Find corresponding username from sessions
                    const session = sessions.find(s => s.pid === pid);
                    const username = session ? session.username : 'Unknown';
                    
                    conns.push({
                        service: parts[0],
                        pid,
                        machine: parts[2],
                        username,
                        connectedAt: parts.slice(3).join(' ')
                    });
                }
            }
        }
    }
    
    return conns;
}

/**
 * Fixes directory permissions and creates path if missing.
 */
async function fixPermissions(dirPath, owner, mode) {
    if (!dirPath || typeof dirPath !== 'string' || !dirPath.trim()) throw new Error('Path is required');
    const targetPath = path.resolve(dirPath.trim());

    if (FORBIDDEN_TARGETS.has(targetPath)) {
        throw new Error('Modifying permissions on system critical paths is not allowed.');
    }
    for (const denied of FORBIDDEN_TARGETS) {
        if (targetPath.startsWith(denied + path.sep)) {
            throw new Error('Modifying permissions on system critical paths is not allowed.');
        }
    }

    if (fs.existsSync(targetPath)) {
        try {
            const lst = fs.lstatSync(targetPath);
            if (lst.isSymbolicLink()) {
                throw new Error('Refusing to operate on a symbolic link');
            }
        } catch (e) {
            if (e.message.startsWith('Refusing')) throw e;
        }
    } else {
        const mkdirRes = await runExecFile('sudo', ['mkdir', '-p', targetPath]);
        if (mkdirRes.code !== 0) {
            throw new Error(`Failed to create directory: ${mkdirRes.stderr}`);
        }
    }

    if (owner && typeof owner === 'string' && owner.trim()) {
        const ownerVal = owner.trim();
        assertSafe(RE_OWNER, ownerVal, 'owner');
        const chownRes = await runExecFile('sudo', ['chown', '-R', '-h', ownerVal, targetPath]);
        if (chownRes.code !== 0) {
            throw new Error(`Failed to set owner: ${chownRes.stderr}`);
        }
    }

    if (mode && typeof mode === 'string' && mode.trim()) {
        const modeVal = mode.trim();
        assertSafe(RE_MODE, modeVal, 'mode');
        const chmodRes = await runExecFile('sudo', ['chmod', '-R', modeVal, targetPath]);
        if (chmodRes.code !== 0) {
            throw new Error(`Failed to set mode: ${chmodRes.stderr}`);
        }
    }

    return { ok: true };
}

/**
 * Reads Samba logs.
 */
async function getLogs() {
    // Try systemd journal first (much more reliable and structured)
    const journalRes = await runCommand('sudo journalctl -u smbd -n 100 --no-pager');
    if (journalRes.code === 0 && journalRes.stdout.trim()) {
        return journalRes.stdout;
    }
    
    // Fallback to reading file
    try {
        if (fs.existsSync('/var/log/samba/log.smbd')) {
            const content = fs.readFileSync('/var/log/samba/log.smbd', 'utf8');
            const lines = content.split('\n');
            return lines.slice(-100).join('\n');
        }
    } catch (e) {}
    
    return 'No log data available.';
}

async function browse(dirPath, showHidden = false) {
    let targetPath = BROWSE_ROOT;
    try {
        if (dirPath !== undefined && dirPath !== null && typeof dirPath !== 'string') {
            throw new Error('Invalid path');
        }
        targetPath = dirPath ? path.resolve(BROWSE_ROOT, dirPath) : BROWSE_ROOT;
        
        // Ensure path is within BROWSE_ROOT
        const relative = path.relative(BROWSE_ROOT, targetPath);
        const isOutside = relative.startsWith('..') || path.isAbsolute(relative);
        if (targetPath !== BROWSE_ROOT && isOutside) {
            throw new Error('Path outside allowed root');
        }
        
        const items = fs.readdirSync(targetPath, { withFileTypes: true });
        const folders = [];
        const files = [];
        
        const parent = path.dirname(targetPath);
        
        for (const item of items) {
            let isDir = item.isDirectory();
            if (item.isSymbolicLink()) {
                try {
                    const realPath = fs.realpathSync(path.join(targetPath, item.name));
                    isDir = fs.statSync(realPath).isDirectory();
                } catch (e) {}
            }
            
            const itemPath = path.join(targetPath, item.name);
            let size = '—';
            let mtime = '—';
            let perm = '—';
            let owner = 'root';
            
            try {
                const stats = fs.statSync(itemPath);
                if (!isDir) {
                    const bytes = stats.size;
                    if (bytes < 1024) size = bytes + ' B';
                    else if (bytes < 1024 * 1024) size = (bytes / 1024).toFixed(1) + ' KB';
                    else if (bytes < 1024 * 1024 * 1024) size = (bytes / (1024 * 1024)).toFixed(1) + ' MB';
                    else size = (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
                }
                const d = new Date(stats.mtime);
                mtime = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                
                const mode = stats.mode;
                const isDirChar = isDir ? 'd' : '-';
                const rwx = (m) => [
                    m & 4 ? 'r' : '-',
                    m & 2 ? 'w' : '-',
                    m & 1 ? 'x' : '-'
                ].join('');
                perm = isDirChar + rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7);
                
                owner = stats.uid === 0 ? 'root' : (stats.uid === 1000 ? 'ayman' : stats.uid.toString());
            } catch (e) {}

            if (isDir) {
                if (showHidden || !item.name.startsWith('.')) {
                    folders.push({
                        name: item.name,
                        path: itemPath,
                        size: '—',
                        mtime,
                        perm,
                        owner,
                        type: 'dir'
                    });
                }
            } else {
                if (showHidden || !item.name.startsWith('.')) {
                    files.push({
                        name: item.name,
                        path: itemPath,
                        size,
                        mtime,
                        perm,
                        owner,
                        type: 'file'
                    });
                }
            }
        }
        
        folders.sort((a, b) => a.name.localeCompare(b.name));
        files.sort((a, b) => a.name.localeCompare(b.name));
        
        return {
            currentPath: targetPath,
            parentPath: targetPath === '/' ? null : parent,
            folders,
            files
        };
    } catch (e) {
        throw new Error(`Failed to read path "${targetPath}": ${e.message}`);
    }
}

module.exports = {
    getStatus,
    controlService,
    getShares,
    saveShare,
    deleteShare,
    getGlobalSettings,
    saveGlobalSettings,
    getUsers,
    saveUser,
    deleteUser,
    getConnections,
    fixPermissions,
    getLogs,
    browse
};
