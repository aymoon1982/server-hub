# Server Hub

A self-hosted server management dashboard — auto-discover web services, monitor system resources, manage Docker containers, Samba shares, file browsing, and in-browser terminal. Single-page React app.

![Build](https://github.com/aymoon1982/Hosted-dashboard/actions/workflows/build.yml/badge.svg)

## Features

### Service Management
- **Auto discovery** — scans open ports, probes HTTP/HTTPS, surfaces web UIs with titles and favicons
- **Web + Backend tabs** — separates user-facing web UIs from internal backend services
- **Manual services** — add external/LAN services (e.g. `http://192.168.1.50:32400`)
- **Pinning & labeling** — pin favourites to top, rename any service with a custom label
- **Docker control** — start/stop/restart containers, view live logs (200 lines)

### System Monitoring
- **Resource stats** — real-time CPU, RAM, disk usage, and temperature
- **GPU monitoring** — NVIDIA GPU stats via `nvidia-smi`
- **Top processes** — per-process CPU and memory breakdown
- **Agent discovery** — detects installed AI coding agents (Claude Code, Codex CLI, Gemini, Aider, Cline, Ollama, etc.) with versions

### Samba Management
- **Share CRUD** — create, edit, delete Samba shares with path, permissions, and access controls
- **User management** — add/remove Samba users, set passwords
- **Service control** — start/stop/restart Samba service, view status
- **Active connections** — monitor connected clients
- **Global settings** — configure workgroup, server string, guest access
- **Service logs** — view Samba logs with optional grep filtering

### File Browser
- **Directory browsing** — navigate the filesystem with a tree view
- **Hidden files** — toggle to show/hide dotfiles
- **Permission management** — set owner and mode (chmod/chown) from the UI

### Web Terminal
- **In-browser shell** — full xterm.js terminal via WebSocket + node-pty
- **Optional token auth** — protect the terminal WebSocket with a bearer token
- **Live typing** — real-time input/output, no polling

### UI/UX
- **Dark / light theme** — persisted in localStorage
- **Tabbed navigation** — Web UIs · Backend · Agents · Resources · Samba · Files
- **Framer Motion animations** — smooth transitions throughout
- **Responsive layout** — works on desktop and tablet

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 19, Vite 8, xterm.js, Framer Motion, Lucide React, Axios |
| Backend | Node.js, Express 5, `ws`, `node-pty`, Axios |
| CI | GitHub Actions (Node 22, builds frontend on every push) |

## Project Structure

```
server-hub/
├── backend/
│   ├── index.js        # Express API: services, stats, docker, agents, terminal, samba
│   ├── samba.js        # Samba share/user/service management (613 lines)
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx     # Main dashboard UI with all tabs (2657+ lines)
│   │   └── App.css     # Full styling
│   └── package.json
└── .github/
    └── workflows/build.yml
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/services` | Discover running web/backend services |
| GET | `/api/stats` | CPU, RAM, disk, GPU, top processes |
| GET | `/api/health` | Version, uptime, auth status |
| GET | `/api/agents` | Discover installed AI coding agents |
| GET/POST | `/api/services/manual` | List/add manual services |
| DELETE | `/api/services/manual/:id` | Remove a manual service |
| POST | `/api/docker/control` | Start/stop/restart Docker containers |
| GET | `/api/docker/logs` | View container logs (last 200 lines) |
| GET | `/api/samba/status` | Samba service status |
| POST | `/api/samba/status` | Start/stop/restart Samba |
| GET/POST | `/api/samba/shares` | List/create/update shares |
| DELETE | `/api/samba/shares/:name` | Delete a share |
| GET/POST | `/api/samba/global` | Get/set global Samba settings |
| GET/POST | `/api/samba/users` | List/create Samba users |
| DELETE | `/api/samba/users/:username` | Remove a Samba user |
| GET | `/api/samba/connections` | Active Samba connections |
| POST | `/api/samba/permissions` | Set owner/mode on a path |
| GET | `/api/samba/logs` | View Samba logs |
| GET | `/api/samba/browse` | Browse filesystem directories |

## Getting Started

### Prerequisites
- Node.js 18+
- Linux host (reads `/proc`, uses `ss`/`lsof`, `docker`, `systemctl`)

### Install & run

```bash
# Backend
cd backend
npm install
sudo node index.js       # runs on port 80 by default

# Frontend (dev server with proxy)
cd frontend
npm install
npm run dev              # runs on http://localhost:5173
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `80` | Backend HTTP port |
| `DASHBOARD_USER` | auto-detected | User whose processes are shown |
| `DASHBOARD_TERMINAL_TOKEN` | *(none)* | Optional bearer token to protect the terminal WebSocket |
| `DISCOVERY_TTL_MS` | `5000` | Service discovery cache TTL (ms) |
| `AGENT_CACHE_TTL_MS` | `60000` | Agent discovery cache TTL (ms) |
| `VITE_BACKEND` | `http://localhost:80` | Backend URL for Vite dev proxy |

### Production build

```bash
cd frontend
npm run build            # outputs to frontend/dist/
```

The backend auto-serves `frontend/dist/` when it exists. Alternatively, serve it from any web server and proxy API calls to the backend.

## Running as root / with systemd

The backend reads `/proc`, spawns PTY shells, and controls system services — it needs root privileges.

```ini
[Unit]
Description=Server Hub
After=network.target

[Service]
ExecStart=/usr/bin/node /home/ayman/projects/server-hub/backend/index.js
Restart=always
Environment=PORT=80
WorkingDirectory=/home/ayman/projects/server-hub/backend

[Install]
WantedBy=multi-user.target
```

## License

ISC
