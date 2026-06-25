# Deploy — VPS deployment manager

A Railway-style GUI that runs **locally inside your VPS** and lets you deploy and
manage your projects without touching the terminal: clone from GitHub, build,
run with PM2, edit env variables, attach domains with HTTPS, and auto-deploy on
every push.

It is **not** a hosted service — it controls the single server it runs on.

## Concepts (same mental model as Railway)

```
Project          a group of related services (e.g. "bayyina")
  └─ Service     one deployable app: a GitHub repo or a local folder
       ├─ Deployments   build + release history, with live logs
       ├─ Variables     env vars, written to .env on every deploy
       ├─ Metrics       live CPU / memory from PM2
       ├─ Logs          live runtime logs (pm2 logs)
       ├─ Domains       nginx reverse-proxy + certbot HTTPS
       └─ Settings      source, build/start commands, auto-deploy
```

## Features

- **Projects → Services canvas** — Railway-style cards on a dotted canvas
- **Deploy pipeline** — `git pull/clone → write .env → build → pm2 start/restart`,
  every step streamed live to the UI and saved per deployment
- **GitHub auto-deploy** — webhook triggers a deploy on push; toggle per service
- **Variables** — table or raw `.env` editor, applied on each deploy
- **Domains** — generate nginx config + Let's Encrypt HTTPS in one click
- **Metrics & Logs** — live CPU/RAM sparklines and runtime logs over WebSocket
- **Processes** — global view of every PM2 process on the box

## Stack

- **server/** — Node.js + Express, talks to PM2 (programmatic API), git, nginx, certbot
- **client/** — React + Vite + Tailwind (Railway-inspired dark theme)

## Install on the VPS

```bash
git clone <repo> deploy && cd deploy
npm install
cp server/.env.example server/.env   # set ADMIN_PASSWORD, JWT_SECRET, GITHUB_WEBHOOK_SECRET
npm run build
pm2 start server/src/index.js --name deploy
```

Then point a domain at the platform's own port (default `4500`) — you can do this
from the **Domains** tab of a service, or by hand in nginx.

## Development

```bash
npm run dev    # server (4500) + client (5173) with proxy
```

Login uses a single `ADMIN_PASSWORD` from `server/.env`.

## GitHub auto-deploy

1. Create a service from a GitHub repo, set its **VPS path**, enable **Auto-deploy**.
2. In the repo: Settings → Webhooks → add
   `https://your-domain/api/github/webhook`, content type `application/json`,
   secret = `GITHUB_WEBHOOK_SECRET`, event `push`.
3. Every push now runs the deploy pipeline automatically.

## Security note

The platform runs commands on your server (git, pm2, nginx, certbot — the last
two need root/sudo). Expose it only over HTTPS with a strong `ADMIN_PASSWORD`.
