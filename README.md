# WhatsApp Agent System

A production-ready Node.js WhatsApp Web automation agent powered by Google Gemini, with a real-time web dashboard.

---

## Features

| Feature | Details |
|---------|---------|
| **WhatsApp Web bot** | `whatsapp-web.js` — QR login, persistent session |
| **Gemini NLP** | Intent classification + voice-to-text (STT) |
| **Text commands** | Natural language → action routing |
| **Voice commands** | OGG → WAV (ffmpeg) → Gemini STT → command |
| **Email** | Nodemailer + SMTP (`send email to …`) |
| **Server tasks** | Whitelisted shell commands, disk/CPU/RAM metrics |
| **API health checks** | HTTP GET checks with latency |
| **Nmap scans** | Authorised targets only |
| **Crypto prices** | CoinGecko (no API key required) |
| **Weather** | OpenWeatherMap |
| **Dashboard** | Express + Socket.IO — real-time log/message/metrics feed |
| **PM2 deployment** | 24/7 uptime, auto-restart, startup persistence |

---

## Project Structure

```
vampire/
├── bot.js              # WhatsApp bot entry point
├── processor.js        # Gemini NLP command router
├── dashboard.js        # Express + Socket.IO server
├── email.js            # Nodemailer email utility
├── serverTasks.js      # Shell commands, metrics, crypto, weather
├── logger.js           # Winston logger + event bus
├── ecosystem.config.js # PM2 process definitions
├── public/
│   └── index.html      # Dashboard UI (vanilla JS)
├── logs/               # Created automatically at runtime
├── .env.example        # Environment variable template
├── .gitignore
└── package.json
```

---

## Prerequisites

- **Node.js** ≥ 18
- **ffmpeg** installed and available in `PATH`  
  - Linux: `sudo apt install ffmpeg`  
  - macOS: `brew install ffmpeg`  
  - Windows: download from [ffmpeg.org](https://ffmpeg.org/download.html)
- A personal **WhatsApp** account
- A **Gemini API key** (free at <https://aistudio.google.com/>)
- Optional: **PM2** — `npm install -g pm2`

---

## Quick Start

### 1. Install dependencies

```bash
cd vampire
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and fill in your values
```

Required fields:

```env
GEMINI_API_KEY=your_key_here
SMTP_HOST=smtp.gmail.com
SMTP_USER=you@gmail.com
SMTP_PASS=your_app_password
ADMIN_NUMBERS=15551234567
```

### 3. Run the bot

```bash
node bot.js
```

Scan the QR code printed in the terminal with WhatsApp (Linked Devices → Link a Device).  
The session is saved to `.wwebjs_auth/` so you only need to scan once.

### 4. Run the dashboard (separate terminal)

```bash
node dashboard.js
```

Open your browser at **http://localhost:5555**

---

## PM2 Deployment (24/7)

```bash
# Install PM2
npm install -g pm2

# Start both processes
pm2 start ecosystem.config.js

# Save process list
pm2 save

# Generate startup script (run the printed command)
pm2 startup

# Monitor
pm2 status
pm2 logs
```

---

## WhatsApp Commands

The bot listens to messages from **authorised numbers** (set in `ADMIN_NUMBERS`) or any chat named after `AGENT_CHAT_NAME`.

By default a `!` prefix is required (configurable via `COMMAND_PREFIX` in `.env`). Set it to empty string to respond to all messages.

### Examples

```
!send email to alice@example.com subject Weekly Report body Please find the weekly report attached.

!check API https://api.example.com/health https://other.service.io/ping

!nmap scan 192.168.1.1

!bitcoin price

!weather in Tokyo

!system metrics

!run df -h

!restart service nginx

!tail /var/log/syslog 30

!help
```

### Voice Commands

Send a WhatsApp voice note with the same natural language — it is automatically:
1. Downloaded from WhatsApp
2. Converted from OGG/OPUS → WAV via `ffmpeg`
3. Transcribed by Gemini STT
4. Processed like a text command

---

## Dashboard API

The dashboard exposes a REST API for manual triggering:

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET`  | `/api/status`   | — | Server health |
| `GET`  | `/api/metrics`  | — | Raw system info JSON |
| `GET`  | `/api/system`   | — | Formatted system metrics string |
| `GET`  | `/api/logs`     | `?limit=100` | Recent log history |
| `GET`  | `/api/crypto`   | `?coins=bitcoin,ethereum` | Crypto prices |
| `GET`  | `/api/weather`  | `?city=London` | Current weather |
| `POST` | `/api/command`  | `{ text }` | Run NLP command |
| `POST` | `/api/email`    | `{ to, subject, body }` | Send email |
| `POST` | `/api/shell`    | `{ command }` | Run whitelisted shell command |
| `POST` | `/api/health-check` | `{ urls: [] }` | HTTP health check |

---

## Security Notes

- Only whitelisted shell commands can be executed (see `BASE_ALLOWED` in `serverTasks.js`).
- Dangerous patterns (`rm -rf`, fork bombs, pipe-to-shell downloads …) are detected and blocked.
- `nmap` scans are restricted to `NMAP_ALLOWED_TARGETS` (`.env`).
- Only numbers listed in `ADMIN_NUMBERS` can trigger commands.
- Rate-limited to 10 requests/minute per sender.
- All secrets are in `.env` — never commit that file.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | ✅ | — | Google Gemini API key |
| `SMTP_HOST` | ✅ | — | SMTP server hostname |
| `SMTP_PORT` | | `587` | SMTP port |
| `SMTP_SECURE` | | `false` | Use TLS (true for port 465) |
| `SMTP_USER` | ✅ | — | SMTP username / email |
| `SMTP_PASS` | ✅ | — | SMTP password / app password |
| `EMAIL_FROM` | | SMTP_USER | Sender display name + address |
| `ADMIN_NUMBERS` | | (all) | Comma-separated authorised WhatsApp numbers |
| `AGENT_CHAT_NAME` | | `Agent` | WhatsApp chat name to monitor |
| `COMMAND_PREFIX` | | `!` | Prefix required for commands |
| `DASHBOARD_PORT` | | `5555` | Dashboard HTTP port |
| `WEATHER_API_KEY` | | — | OpenWeatherMap API key |
| `WEATHER_DEFAULT_CITY` | | `New York` | Default city for weather |
| `CRYPTO_DEFAULT` | | `bitcoin,ethereum,solana` | Default coins |
| `NMAP_ALLOWED_TARGETS` | | `127.0.0.1` | Comma-separated authorised nmap targets |
| `LOG_LEVEL` | | `info` | Winston log level |
| `LOG_DIR` | | `./logs` | Log output directory |
| `EXTRA_ALLOWED_CMDS` | | — | Additional whitelisted shell commands |

---

## Logs

- `logs/combined.log` — all log levels (rotated at 10 MB, 7 files)
- `logs/error.log`    — errors only
- `logs/bot-out.log` / `logs/bot-err.log` — PM2 process output
- `logs/dashboard-out.log` / `logs/dashboard-err.log` — PM2 process output

---

## License

MIT
