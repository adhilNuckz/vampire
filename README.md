# Vampire — WhatsApp Agent

A Node.js WhatsApp Web agent built on [`whatsapp-web.js`](https://github.com/pedrolopez/whatsapp-web.js),
with a real-time web dashboard, an anti-delete message archive, Auto Pilot
(Gemini-backed) replies, and server task tooling.

---

## One-line install

On a fresh Debian/Ubuntu or RHEL/CentOS/Rocky/Alma/Fedora/Amazon Linux server:

```bash
curl -fsSL https://raw.githubusercontent.com/adhilNuckz/vampire/main/install.sh | sudo bash
```

That single command:

1. installs `git`, `curl`, `ffmpeg`, **Node.js 20**, **Google Chrome** and **PM2**
2. clones the repo into `/opt/vampire` (or updates it if already present)
3. installs npm dependencies
4. writes `.env`, including a randomly generated dashboard secret
5. opens the firewall on **port 5050**
6. starts the bot under PM2, on boot, and health-checks the dashboard
7. prints your URL

Then open:

```
http://<your-server-ip>:5050
```

and scan the QR code shown on the page with WhatsApp
(**Settings → Linked Devices → Link a Device**). The scan is a one-time step —
the session persists in `.wwebjs_auth/`.

The QR is rendered **server-side** into a PNG and pushed over Socket.IO, so the
page needs no CDN or outbound access of its own, and the code stays visible
after a reconnect. It refreshes itself as WhatsApp rotates it; once you are
authenticated the overlay disappears and is not shown again.

> **Upgrading from an earlier version?** Run the installer again (it pulls the
> code and installs the new `qrcode` dependency), or manually:
> `git pull && npm install && pm2 restart vampire --update-env`.

### Options

Any of these can be set on the same line, e.g.
`VAMPIRE_PORT=8080 curl -fsSL … | sudo bash`:

| Variable | Default | Meaning |
|---|---|---|
| `VAMPIRE_PORT` | `5050` | Dashboard HTTP port |
| `VAMPIRE_DIR` | `/opt/vampire` | Install location |
| `REPO_URL` | this repo | Fork/branch to install from |
| `VAMPIRE_BRANCH` | `main` | Branch to install |

Re-running the installer is safe — it updates the code and restarts the bot.

### Local install (from a checkout)

```bash
sudo bash install.sh        # or: sudo bash deploy.sh
```

---

## ⚠️ Before you push anything: rotate your secrets

`.env.example` previously contained **real** credentials (a Gemini API key and a
Gmail app password) and this repository is **public**. The file has been
scrubbed, but values committed to git remain in the history forever.

**Treat both as compromised and rotate them now:**

- Gemini API key → https://aistudio.google.com/apikey (delete, create a new one)
- Gmail app password → https://myaccount.google.com/apppasswords (revoke)

Real credentials belong only in `.env`, which is gitignored.

---

## Features

| Feature | Details |
|---|---|
| **WhatsApp Web bot** | QR login, persistent session, auto-reconnect with backoff |
| **Anti-delete archive** | Messages deleted for everyone stay readable, with the original text and media |
| **Chat history** | Every chat captured to SQLite (or MySQL), browsable in the dashboard |
| **Auto Pilot** | Gemini replies while you are away — falls back to canned replies with no API key |
| **Dashboard** | Express + Socket.IO: chats, messages, contacts, logs, health, scheduling |
| **Scheduling + Ping** | Send a message later, or repeat one N times |
| **Server tasks** | Whitelisted shell commands, disk/CPU/RAM metrics, API checks, nmap |
| **Email** | Gmail REST API over HTTPS (no SMTP ports needed) |
| **PM2 deployment** | 24/7 uptime, auto-restart, survives reboot |

---

## Project structure

```
vampire/
├── start.js                    # entry point — dashboard + bot in one process
├── install.sh                  # one-line server installer
├── deploy.sh                   # wrapper around install.sh
├── get-token.js                # one-time Gmail OAuth2 helper
├── ecosystem.config.js         # PM2 process definition
├── src/
│   ├── bot/index.js            # WhatsApp client, capture + anti-delete handlers
│   ├── dashboard/index.js      # Express + Socket.IO server
│   ├── services/
│   │   ├── db.js               # SQLite (sql.js) / MySQL persistence
│   │   ├── chatStore.js        # message ring buffer + de-duplication
│   │   ├── revokeResolver.js   # resolves which message a revoke refers to
│   │   ├── autopilot.js        # Gemini replies + fallbacks
│   │   ├── email.js            # Gmail API
│   │   ├── serverTasks.js      # shell/metrics/nmap/crypto/weather
│   │   └── whatsappClient.js   # shared client singleton
│   └── utils/logger.js         # Winston logger + in-process event bus
├── public/
│   ├── index.html              # dashboard UI (vanilla JS)
│   └── media/                  # captured media (gitignored)
├── tests/                      # node:test suites
├── data/                       # SQLite database + autopilot state
└── logs/                       # Winston logs (gitignored)
```

---

## How the anti-delete feature works

When someone deletes a message "for everyone", WhatsApp sends a revocation
event rather than the original message. Vampire keeps the original content:

1. **Every** message is captured as it arrives, into `chat_messages`
   (`msg_id`, `sender`, `body`, `type`, `media_url`, `ts`).
2. `whatsapp-web.js` emits `message_revoke_everyone(message, revoked_msg)`.
   Neither argument is reliable on its own — `revoked_msg` is frequently
   `undefined`, and the first argument may carry the id of the *revocation*
   rather than the deleted message. `src/services/revokeResolver.js` therefore
   collects every id the event could refer to and the first one that matches a
   stored row wins.
3. That row is flagged `is_deleted = 1` with a `deleted_at` timestamp. **The
   body and media are never cleared** — the dashboard marks the message with a
   🗑️ badge and keeps showing what was sent.
4. If the message was never captured (the bot was offline, or WhatsApp Web had
   already dropped it), it is reconstructed from the pre-revocation snapshot so
   the deletion is still visible rather than silently lost.

Messages deleted "for me" are also handled — but only ever flag a message
already on record, since WhatsApp Web fires that event when a chat is cleared
too.

### Delivery de-duplication

WhatsApp Web announces the same logical message more than once — `message_create`
for everything, then `message` again for incoming ones, and twice more when an
encrypted (ciphertext) message later decrypts into its real content. Captures
are therefore keyed on `msg_id` and **upserted**, so a re-delivery enriches the
existing row (a ciphertext message finally gains its image) instead of creating
a duplicate bubble.

---

## Tests

```bash
npm test          # anti-delete + storage logic (no WhatsApp needed)
npm run test:live # end-to-end: Express + Socket.IO + a real socket client
npm run test:all
```

`npm test` covers id resolution from malformed revoke events, de-duplication,
recovered deletions, and the guarantee that a revoke never clears text/media.
`npm run test:live` boots the real dashboard and asserts a real browser client
receives `chat_message_revoked` with the original body intact.

---

## Configuration

All settings live in `.env` (created by the installer; see `.env.example`).

| Variable | Default | Description |
|---|---|---|
| `DASHBOARD_PORT` | `5050` | Dashboard HTTP port |
| `DASHBOARD_HOST` | `0.0.0.0` | Interface to bind |
| `DASHBOARD_SECRET` | — | Generated by the installer |
| `HEADLESS` | `true` | Run the browser headless |
| `BROWSER_PATH` | auto-detected | Path to Chrome/Chromium |
| `GEMINI_API_KEY` | — | Optional; falls back to canned replies |
| `ADMIN_NUMBERS` | all | Comma-separated authorised WhatsApp numbers |
| `AGENT_CHAT_NAME` | `Agent` | Chat name the bot monitors |
| `COMMAND_PREFIX` | `!` | Required command prefix |
| `BOSS_NAME` | `my boss` | Name used in Auto Pilot replies |
| `GMAIL_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | — | Optional; run `node get-token.js` |
| `DB_USE_MYSQL` | `false` | Set `true` to use MySQL instead of SQLite |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | — | MySQL connection |
| `LOG_LEVEL` | `info` | Winston log level |
| `LOG_DIR` | `./logs` | Log output directory |
| `WEATHER_API_KEY` | — | OpenWeatherMap key |
| `NMAP_ALLOWED_TARGETS` | `127.0.0.1` | Authorised nmap targets |
| `EXTRA_ALLOWED_CMDS` | — | Extra whitelisted shell commands |

`BROWSER_PATH` is optional: the bot auto-detects Chrome/Chromium in the usual
locations, so a fresh install works without editing `.env`.

---

## Dashboard API

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/api/status` | — | Health check |
| `GET` | `/api/logs` | `?level=error&limit=200` | Recent log entries |
| `GET` | `/api/chats` | `?limit=1000` | Message history (incl. deleted) |
| `GET` | `/api/contacts` | `?q=` | Contact search |
| `POST` | `/api/send` | `{ to, message }` | Send a message |
| `POST` | `/api/ping` | `{ to, message, count }` | Repeat a message |
| `POST` | `/api/schedule` | `{ to, message, sendAt }` | Schedule a message |
| `GET` | `/api/schedule` | — | List schedules |
| `DELETE` | `/api/schedule/:id` | — | Cancel a schedule |
| `GET`/`POST` | `/api/autopilot` | `{ enabled }` | Read / set Auto Pilot |

Socket.IO events: `qr`, `status`, `new_chat_message`, `chat_message_revoked`,
`log`, `autopilot_update`, `schedule_update`, `ping_sent`.

---

## Operations

```bash
pm2 logs vampire        # follow the logs
pm2 status              # process state
pm2 restart vampire     # restart
nano /opt/vampire/.env  # change settings, then: pm2 restart vampire --update-env
```

Logs: `logs/combined.log` (all), `logs/error.log` (errors only), plus PM2's own
`logs/vampire-out.log` / `logs/vampire-err.log`.

---

## Security notes

- Only numbers listed in `ADMIN_NUMBERS` can trigger commands (all, if unset).
- Requests are rate-limited to 10 per minute per sender.
- Shell execution is whitelist-gated, with dangerous patterns (`rm -rf`, fork
  bombs, pipe-to-shell downloads) blocked.
- `nmap` is restricted to `NMAP_ALLOWED_TARGETS`.
- The dashboard has **no authentication** and binds `0.0.0.0`. Anyone who can
  reach port 5050 can read every archived chat and send messages. Restrict it
  with a firewall rule, an SSH tunnel, or a reverse proxy with auth before
  exposing it to the internet.

---

## License

MIT
