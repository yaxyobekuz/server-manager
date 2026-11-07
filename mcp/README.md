# Deploy panel — MCP server

Lets Claude on your own computer deploy and inspect the services this panel
manages: "deploy the API", "why did the last deploy fail", "show me the bot's
logs", "restart the admin".

It talks to the panel over its ordinary HTTPS API — the same endpoints the web
UI calls, with the same password and the same permission checks. It can never
do more than the identity whose password you give it.

## Setup

On the computer you run Claude on (not on the server):

```bash
git clone https://github.com/yaxyobekuz/server-manager
cd server-manager/mcp
npm install
```

Check that it can reach the panel before wiring it into Claude:

```bash
DEPLOY_URL=https://vm.mysrv.uz DEPLOY_PASSWORD='…' npm run check
```

```
server-manager 1.0.0
URL: https://vm.mysrv.uz
Connected. 1 project(s), 4 service(s):
  E Murojaat/server                  online   e-murojaat-server
  E Murojaat/bot                     online   e-murojaat-bot
  ...
18 tools ready.
```

### Claude Code

```bash
claude mcp add deploy \
  --env DEPLOY_URL=https://vm.mysrv.uz \
  --env DEPLOY_PASSWORD='…' \
  -- node /absolute/path/to/server-manager/mcp/index.js
```

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "deploy": {
      "command": "node",
      "args": ["/absolute/path/to/server-manager/mcp/index.js"],
      "env": {
        "DEPLOY_URL": "https://vm.mysrv.uz",
        "DEPLOY_PASSWORD": "…"
      }
    }
  }
}
```

Restart Claude Desktop afterwards. The panel's **Settings** page prints this
same block already filled in with your URL.

## Which password to use

Use a **dedicated admin**, not the owner password: open **Admins → New admin**
in the panel, give it only what it needs, and scope it to the projects it may
touch. Then the config file on your laptop cannot do more than that — and you
can disable it from the panel in one click if the laptop is lost.

| Tools | Permission the admin needs |
| --- | --- |
| `list_projects`, `get_service`, `list_deployments`, `get_deployment` | (none — any admin) |
| `get_logs` | View service logs |
| `get_variables`, `set_variables` | View & edit variables |
| `deploy_service`, `deploy_project`, `stop_service`, `start_service` | Deploy & restart services |
| `restart_service` | Process actions |
| `list_processes` | Processes page |
| `list_domains` | Global Domains page |
| `add_domain` | Manage service domains |
| `server_info` | Information page |
| `panel_status`, `update_panel` | owner only |

A tool whose permission is missing returns the panel's own refusal, so nothing
fails silently.

## Options

| Variable | Meaning |
| --- | --- |
| `DEPLOY_URL` | The panel's address, e.g. `https://vm.mysrv.uz`. Required. |
| `DEPLOY_PASSWORD` | Owner or admin password. Required. |
| `DEPLOY_INSECURE` | `1` skips TLS verification. Only for a self-signed certificate. |

## Tools

**Reading** — `list_projects` · `get_service` · `list_deployments` ·
`get_deployment` · `get_logs` · `get_variables` · `list_domains` ·
`list_processes` · `server_info` · `panel_status`

**Doing** — `deploy_service` · `deploy_project` · `restart_service` ·
`stop_service` · `start_service` · `set_variables` · `add_domain` ·
`update_panel`

Services are named `"Project/service"` — e.g. `"E Murojaat/server"`. A service
id or a pm2 name works too, and a bare service name works when it is
unambiguous.

`deploy_service` waits for the deployment to finish by default and comes back
with the final status and the tail of the build log, so a failure arrives
explained rather than as "started". Pass `wait: false` to return immediately.

Deleting a project, a service or a domain is deliberately **not** here: those
stay in the web UI, where you can see what you are about to lose.

## Notes

- The token is kept in memory only and renewed automatically, so a long
  session never stops working because a week passed.
- `set_variables` merges by default; pass `replace: true` to make the file
  exactly the keys you gave, and `null` as a value to delete a key. The app
  only sees the change after its next deploy or restart.
- Every write tool is marked as such, so Claude asks before running it.
