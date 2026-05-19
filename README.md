# Hosted Dashboard

A self-hosted server dashboard that auto-discovers running web services, monitors system resources, and provides an in-browser terminal — all in a single-page React app.

![Build](https://github.com/aymoon1982/Hosted-dashboard/actions/workflows/build.yml/badge.svg)

## Features

- **Auto service discovery** — scans open ports, probes HTTP/HTTPS, and surfaces web UIs with their titles and favicons
- **System stats** — real-time CPU, RAM, disk, and temperature monitoring (including NVIDIA GPU via `nvidia-smi`)
- **Web terminal** — full in-browser shell via WebSocket + `node-pty` (xterm.js)
- **Manual services** — add external or LAN services (e.g. `http://192.168.1.50:32400`) that won't be auto-discovered
- **Pinning & labels** — pin favourites to the top, rename any service with a custom label
- **Dark / light theme** — persisted in `localStorage`
- **Tabbed view** — Web UIs · Backend services · Agents · CPU · RAM

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 19, Vite 8, xterm.js, Framer Motion, Lucide React, Axios |
| Backend | Node.js, Express 5, `ws`, `node-pty`, Axios |
| CI | GitHub Actions (Node 22, builds frontend on every push) |

## Project Structure

```
hosted-dashboard/
├── backend/          # Express API + WebSocket terminal server
│   ├── index.js      # Service discovery, system stats, terminal routes
│   └── package.json
├── frontend/         # Vite + React SPA
│   ├── src/
│   │   ├── App.jsx   # Main dashboard UI
│   │   └── App.css
│   └── package.json
└── .github/
    └── workflows/build.yml
```

## Getting Started

### Prerequisites

- Node.js 18+
- Linux host (service discovery reads `/proc` and uses `ss`/`lsof`)

### Install & run

```bash
# Backend
cd backend
npm install
node index.js          # runs on port 80 by default

# Frontend (dev server with proxy)
cd frontend
npm install
npm run dev            # runs on http://localhost:5173
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `80` | Backend HTTP port |
| `DASHBOARD_USER` | auto-detected | User whose processes are shown |
| `DASHBOARD_TERMINAL_TOKEN` | *(none)* | Optional bearer token to protect the terminal WebSocket |
| `DISCOVERY_TTL_MS` | `5000` | How long to cache the service discovery scan (ms) |
| `VITE_BACKEND` | `http://localhost:80` | Backend URL for Vite dev proxy |

### Production build

```bash
cd frontend
npm run build          # outputs to frontend/dist/
```

Serve `frontend/dist/` as static files from any web server, or point Express at it.

## Running as root / with systemd

The backend reads `/proc` directly and spawns PTY shells, so it typically needs to run as root (or a user with sufficient permissions) when port 80 is required.

A minimal systemd unit:

```ini
[Unit]
Description=Hosted Dashboard
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/hosted-dashboard/backend/index.js
Restart=always
Environment=PORT=80

[Install]
WantedBy=multi-user.target
```

## License

ISC
