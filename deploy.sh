#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  deploy.sh — Vampire WhatsApp Agent — DigitalOcean / Ubuntu setup
#  Usage: bash deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

echo -e "\n${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}   🧛 Vampire WhatsApp Agent — Deployment Script   ${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}\n"

# ── must be root ──────────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  error "Please run as root:  sudo bash deploy.sh"
fi

# ─────────────────────────────────────────────────────────────────────────────
#  1. System packages
# ─────────────────────────────────────────────────────────────────────────────
info "Updating system packages…"
apt-get update -qq && apt-get upgrade -y -qq
success "System packages up to date"

# ─────────────────────────────────────────────────────────────────────────────
#  2. Node.js 20
# ─────────────────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.version.split(".")[0].slice(1))')" -lt 18 ]]; then
  info "Installing Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - -qq
  apt-get install -y -qq nodejs
  success "Node.js $(node --version) installed"
else
  success "Node.js $(node --version) already installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
#  3. Google Chrome
# ─────────────────────────────────────────────────────────────────────────────
if ! command -v google-chrome &>/dev/null; then
  info "Installing Google Chrome…"
  apt-get install -y -qq wget gnupg ca-certificates
  wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb
  apt-get install -y -qq /tmp/chrome.deb || apt-get install -yf -qq
  rm -f /tmp/chrome.deb
  success "Chrome $(google-chrome --version) installed"
else
  success "Chrome already installed: $(google-chrome --version)"
fi

# ─────────────────────────────────────────────────────────────────────────────
#  4. PM2
# ─────────────────────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  info "Installing PM2…"
  npm install -g pm2 --quiet
  success "PM2 installed"
else
  success "PM2 already installed: $(pm2 --version)"
fi

# ─────────────────────────────────────────────────────────────────────────────
#  5. Git
# ─────────────────────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  info "Installing git…"
  apt-get install -y -qq git
fi

# ─────────────────────────────────────────────────────────────────────────────
#  6. Clone / update repo
# ─────────────────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/adhilNuckz/vampire.git"
INSTALL_DIR="/opt/vampire"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Repo already exists — pulling latest changes…"
  cd "$INSTALL_DIR"
  git pull --ff-only
  success "Repo updated"
else
  info "Cloning repo → $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
  success "Repo cloned"
fi

cd "$INSTALL_DIR"

# ─────────────────────────────────────────────────────────────────────────────
#  7. npm install
# ─────────────────────────────────────────────────────────────────────────────
info "Installing npm dependencies…"
npm install --omit=dev --quiet
success "Dependencies installed"

# ─────────────────────────────────────────────────────────────────────────────
#  8. Create .env from .env.example (if not already present)
# ─────────────────────────────────────────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  warn ".env created from .env.example — you MUST fill in your values!"
  warn "Edit now:  nano $INSTALL_DIR/.env"
  echo ""
  echo -e "${YELLOW}┌─────────────────────────────────────────────────────┐${NC}"
  echo -e "${YELLOW}│  Fill in these required keys in .env before you     │${NC}"
  echo -e "${YELLOW}│  start the bot:                                     │${NC}"
  echo -e "${YELLOW}│                                                     │${NC}"
  echo -e "${YELLOW}│  GEMINI_API_KEY=...                                 │${NC}"
  echo -e "${YELLOW}│  ADMIN_NUMBERS=...  (your WhatsApp number)          │${NC}"
  echo -e "${YELLOW}│  GMAIL_CLIENT_ID=...                                │${NC}"
  echo -e "${YELLOW}│  GMAIL_CLIENT_SECRET=...                            │${NC}"
  echo -e "${YELLOW}│  GMAIL_REFRESH_TOKEN=...                            │${NC}"
  echo -e "${YELLOW}│                                                     │${NC}"
  echo -e "${YELLOW}│  HEADLESS=true       (already set)                  │${NC}"
  echo -e "${YELLOW}│  BROWSER_PATH=/usr/bin/google-chrome  (already set) │${NC}"
  echo -e "${YELLOW}└─────────────────────────────────────────────────────┘${NC}"
  echo ""
  read -rp "Press Enter after you have finished editing .env to continue, or Ctrl+C to exit and edit manually: "
else
  success ".env already exists — skipping"
fi

# ─────────────────────────────────────────────────────────────────────────────
#  9. Ensure server .env has correct headless/browser settings
# ─────────────────────────────────────────────────────────────────────────────
grep -q "^HEADLESS=" "$INSTALL_DIR/.env" \
  && sed -i 's/^HEADLESS=.*/HEADLESS=true/' "$INSTALL_DIR/.env" \
  || echo "HEADLESS=true" >> "$INSTALL_DIR/.env"

grep -q "^BROWSER_PATH=" "$INSTALL_DIR/.env" \
  && sed -i 's|^BROWSER_PATH=.*|BROWSER_PATH=/usr/bin/google-chrome|' "$INSTALL_DIR/.env" \
  || echo "BROWSER_PATH=/usr/bin/google-chrome" >> "$INSTALL_DIR/.env"

success "HEADLESS=true and BROWSER_PATH set for Linux"

# ─────────────────────────────────────────────────────────────────────────────
#  10. Ensure public/media directory exists
# ─────────────────────────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR/public/media"
mkdir -p "$INSTALL_DIR/logs"

# ─────────────────────────────────────────────────────────────────────────────
#  11. UFW firewall — open dashboard port
# ─────────────────────────────────────────────────────────────────────────────
DASHBOARD_PORT=$(grep -E "^DASHBOARD_PORT=" "$INSTALL_DIR/.env" | cut -d= -f2 | tr -d '[:space:]')
DASHBOARD_PORT="${DASHBOARD_PORT:-5555}"

if command -v ufw &>/dev/null; then
  info "Opening port $DASHBOARD_PORT in firewall…"
  ufw allow "$DASHBOARD_PORT"/tcp >/dev/null
  ufw allow OpenSSH >/dev/null
  ufw --force enable >/dev/null
  success "UFW: port $DASHBOARD_PORT open"
else
  warn "ufw not found — make sure port $DASHBOARD_PORT is open in your DigitalOcean firewall rules"
fi

# ─────────────────────────────────────────────────────────────────────────────
#  12. Start / restart with PM2
# ─────────────────────────────────────────────────────────────────────────────
info "Starting bot with PM2…"
cd "$INSTALL_DIR"

if pm2 describe vampire &>/dev/null; then
  pm2 restart vampire --update-env
  success "Bot restarted via PM2"
else
  pm2 start ecosystem.config.js
  success "Bot started via PM2"
fi

pm2 save --force >/dev/null

# ─────────────────────────────────────────────────────────────────────────────
#  13. PM2 startup (survives server reboot)
# ─────────────────────────────────────────────────────────────────────────────
info "Configuring PM2 to start on reboot…"
PM2_STARTUP=$(pm2 startup systemd -u root --hp /root 2>&1 | grep "sudo" | tail -1)
if [ -n "$PM2_STARTUP" ]; then
  eval "$PM2_STARTUP" >/dev/null 2>&1 || true
fi
success "PM2 startup configured"

# ─────────────────────────────────────────────────────────────────────────────
#  Done
# ─────────────────────────────────────────────────────────────────────────────
SERVER_IP=$(curl -s https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}   ✅  Deployment complete!                        ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Dashboard:   ${CYAN}http://${SERVER_IP}:${DASHBOARD_PORT}${NC}"
echo -e "  Logs:        ${CYAN}pm2 logs vampire${NC}"
echo -e "  Restart:     ${CYAN}pm2 restart vampire${NC}"
echo -e "  Status:      ${CYAN}pm2 status${NC}"
echo ""
echo -e "  ${YELLOW}⚠  Open the dashboard, scan the QR code with WhatsApp${NC}"
echo -e "  ${YELLOW}   to authenticate the bot.${NC}"
echo ""
