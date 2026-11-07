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

Servers          other machines running this same panel, linked once by
                 their address + admin password, so a whole project can be
                 moved from one to the other
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
- **Move a project to another server** — one press copies code, `.env`,
  databases and domains to a second machine running this panel, deploys it
  there and removes the original

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

## Deploy from Claude (MCP)

The panel is also an [MCP](https://modelcontextprotocol.io) server, so Claude
on your own machine can drive it. Nothing to install and no second secret:
the panel's address and the password you log in with.

**Claude Desktop** — Settings → Connectors → *Add custom connector*:

```
https://your-domain/mcp?password=<your panel password>
```

**Claude Code** — sends the password as a header, so it stays out of the URL:

```bash
claude mcp add --transport http deploy https://your-domain/mcp \
  --header "Authorization: Bearer <your panel password>"
```

The **Settings** page prints both, filled in with this panel's own address,
and will fill in the password too at one click.

Then ask for what you want: *deploy E Murojaat/server*, *why did the last
deploy fail*, *show me the bot's logs*, *restart the admin*.

Eighteen tools. Reading: projects and services, deployments with their build
logs, runtime logs, variables, domains, pm2 processes, server info, and the
panel's own update state. Doing: deploy a service or a whole project,
restart/stop/start, patch `.env`, attach a domain, update the panel. Deleting
anything is deliberately absent — that stays in the web UI, where you can see
what you are about to lose.

Services are named `"Project/service"`; an id or a pm2 name works too.
`deploy_service` waits for the deployment and returns the final status with
the tail of the build log, so a failure comes back explained.

The password is checked by the same function the login box uses, so an admin
password works too — and then the tools run with exactly that admin's
permissions, because they go through the panel's own HTTP API with the token
that login issued. There is no second copy of the permission rules.

## Moving a project to another server

Both machines run this panel. On the one you are looking at, open **Servers →
Link a server** and give it the other panel's address and the password you log
into it with. That password is asked once: it is verified, stored encrypted and
replayed for every later transfer.

From then on a project moves in one press — **Move** in a project's header, or
**Servers → Import a project** to pull one the other way. What happens:

```
plan → check the destination → pause the project → bundle → restore there
     → deploy → attach domains → delete the original
```

Everything that makes the project itself travels: every file in its folder
(the git repo, uploads, whatever the app wrote), each service's `.env` byte
for byte, ports, build/start commands, pm2 names, creation dates and
deployment history. Tick-box extras, all with sane defaults:

| option | default | what it does |
| --- | --- | --- |
| Databases | on | dumps every local MySQL / PostgreSQL / MongoDB named in a `.env` and restores it there under the same name, user and password — so the `.env` keeps working untouched |
| Domains & HTTPS | on | rebuilds each nginx vhost on the new server and puts HTTPS back; the old vhost and certificate go with the original |
| Deploy on arrival | on | builds and starts everything there, so the project comes up by itself |
| Deployment history | on | past deploys and their logs come along |
| Dependencies | off | `node_modules`, `vendor`, `.venv` … — the deploy reinstalls them, which is almost always faster than sending them |
| Build caches | off | `.next`, `.cache`, `.turbo` … — the deploy regenerates them |
| Pause while copying | on | stops the project during the copy, so files and database dumps are one consistent snapshot |
| Remove from the old server | on | what makes it a move; turn it off to leave a copy behind |

Safety rules worth knowing:

- the original is deleted **only** after the new server reports the project
  up. Anything else leaves it running, untouched, and offers a one-press
  "remove it now" once you have checked the new copy yourself;
- a destination that fails halfway removes what it already created, so you
  never have to clean up a half-import;
- a port already taken on the destination is moved to the next free one (the
  `.env` is updated with it) and reported;
- **DNS is yours**: HTTPS can only be issued once the domain points at the
  new server. Until then the new vhost serves plain HTTP and its Domains tab
  offers *Repair*, which finishes the certificate.

Databases on the old server are left in place after a move — drop them
yourself once you trust the new copy.

## HTTPS when port 80 is not yours

By default a domain gets its certificate through certbot's nginx/HTTP-01
challenge, which needs port 80 of the public name to reach this nginx. That
fails — silently, with "still HTTP only" — when something in front owns the
ports: a proxying CDN (Cloudflare's orange cloud), a NAT box, a host-level
reverse proxy, or a provider that intercepts 80/443.

Point the panel at a certbot DNS plugin and ownership is proven with a DNS
TXT record instead, so **Add a domain** and **Repair** work regardless of how
inbound HTTP is routed (and wildcards become possible):

```bash
apt install python3-certbot-dns-cloudflare        # or your DNS provider's plugin
# server/.env
CERTBOT_DNS_PLUGIN=cloudflare
CERTBOT_DNS_CREDENTIALS=/root/.secrets/cloudflare.ini   # chmod 600
```

A certificate already in `/etc/letsencrypt` is still just installed, offline,
without asking any ACME server — so a domain re-attached after a move needs
no challenge at all.

### A domain shows the panel instead of the app

Its vhost exists and `nginx -t` is happy, yet the hostname serves the Deploy
panel. The request never reached that vhost: nginx answered from a different
server block — the `default_server` of the listener the request arrived on.
Almost always this means **the domain has no certificate yet**. Browsers go
to 443, the vhost only has a port 80 block, so nginx falls back to the first
block that does terminate TLS, which on most boxes is the panel's own. Give
the domain HTTPS (above) and it starts matching by SNI.

The panel's log format makes this visible: the request shows up in ANOTHER
domain's access log, under its own hostname.

```bash
grep -l app.example.com /var/log/nginx/sm-*.access.log
# a hit in sm-<other-domain>.access.log = that block answered for you
```

The rarer cause is a vhost listening where traffic does not arrive: when
something in front forwards to an internal address, `NGINX_LISTEN` has to
match it exactly. Set it only if you know that is your setup — pointing
project vhosts at a handoff listener while the public 443 really lands on
this nginx takes every domain offline. To see where traffic actually comes
in, compare `/var/log/nginx/access.log` (real client IPs = direct) with the
handoff listener's own log.

## Security note

The platform runs commands on your server (git, pm2, nginx, certbot — the last
two need root/sudo). Expose it only over HTTPS with a strong `ADMIN_PASSWORD`.

The MCP endpoint (`/mcp`) authenticates every single request against the panel
password, so changing `ADMIN_PASSWORD` cuts off anything that held the old
one. A password in a URL is written to logs by whatever sits in front of the
panel, so prefer the header form where the client supports it; nginx blocks
this panel writes drop the query string for exactly that reason.

Project transfer is **owner-only on both sides** — a bundle carries source
code, `.env` files and database dumps. A linked server's password is stored
encrypted with a key derived from `JWT_SECRET`; rotating that secret makes the
panel ask for the password again instead of silently failing.
