#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Vampire — WhatsApp Agent · one-line installer
#
#  Debian/Ubuntu:
#    curl -fsSL https://raw.githubusercontent.com/adhilNuckz/vampire/main/install.sh | sudo bash
#
#  RHEL / CentOS / Rocky / Alma / Fedora / Amazon Linux:
#    curl -fsSL https://raw.githubusercontent.com/adhilNuckz/vampire/main/install.sh | sudo bash
#
#  What it does
#    1. installs git, curl, ffmpeg, Node.js 20, Google Chrome, PM2
#    2. clones (or updates) the repo into /opt/vampire
#    3. npm install, generates .env, opens the firewall on port 5050
#    4. starts the bot under PM2 and enables it on boot
#    5. prints the dashboard URL — open it and scan the WhatsApp QR code
#
#  Overridable via environment, e.g.
#    VAMPIRE_PORT=8080 curl -fsSL .../install.sh | sudo bash
#    VAMPIRE_DIR=/srv/vampire ...  REPO_URL=...  VAMPIRE_BRANCH=main
#
#  Re-running the script is safe: it updates the code and restarts the bot.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/adhilNuckz/vampire.git}"
VAMPIRE_BRANCH="${VAMPIRE_BRANCH:-main}"
INSTALL_DIR="${VAMPIRE_DIR:-/opt/vampire}"
VAMPIRE_PORT="${VAMPIRE_PORT:-5050}"
PM2_NAME="vampire"
NODE_MAJOR=20

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[ OK ]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[FAIL]${NC}  $*" >&2; exit 1; }

echo
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}   🧛  Vampire — WhatsApp Agent · installer        ${NC}"
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo

# ── must be root ──────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || error "Please run as root:  curl -fsSL <url> | sudo bash"

# ── detect the package manager ────────────────────────────────────────────────
if   command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf     >/dev/null 2>&1; then PKG=dnf
elif command -v yum     >/dev/null 2>&1; then PKG=yum
elif command -v pacman  >/dev/null 2>&1; then PKG=pacman
else error "Unsupported distribution — no apt, dnf, yum or pacman found."
fi
info "Package manager: ${BOLD}${PKG}${NC}"

# Prompt only when a real terminal is attached; `curl | bash` has no stdin and
# a bare `read` would swallow the rest of this script.
ask() {
  local prompt="$1" default="${2:-}" answer=""
  if [ -t 1 ] && [ -r /dev/tty ]; then
    read -rp "$(echo -e "${BOLD}${prompt}${NC}")" answer </dev/tty || answer=""
  fi
  printf '%s' "${answer:-$default}"
}

pkg_install() {
  case "$PKG" in
    apt)    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf)    dnf install -y -q "$@" ;;
    yum)    yum install -y -q "$@" ;;
    pacman) pacman -Sy --noconfirm --needed "$@" ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────────────
#  1. Base packages
# ─────────────────────────────────────────────────────────────────────────────
info "Installing base packages…"
case "$PKG" in
  apt) apt-get update -qq ;;
  dnf) dnf makecache -q >/dev/null 2>&1 || true ;;
  yum) yum makecache -q >/dev/null 2>&1 || true ;;
  pacman) pacman -Sy --noconfirm >/dev/null 2>&1 || true ;;
esac

BASE_PKGS=(git curl ca-certificates ffmpeg)
[ "$PKG" = apt ] && BASE_PKGS+=(gnupg wget unzip)
pkg_install "${BASE_PKGS[@]}" || warn "Some base packages failed to install — continuing."
success "Base packages ready"

# ─────────────────────────────────────────────────────────────────────────────
#  2. Node.js 20+
# ─────────────────────────────────────────────────────────────────────────────
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ "$(node_major)" -ge 18 ] 2>/dev/null; then
  success "Node.js $(node --version) already installed"
else
  info "Installing Node.js ${NODE_MAJOR}…"
  case "$PKG" in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
      pkg_install nodejs
      ;;
    dnf|yum)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
      pkg_install nodejs
      ;;
    pacman)
      pkg_install nodejs npm
      ;;
  esac
  command -v node >/dev/null 2>&1 || error "Node.js installation failed."
  success "Node.js $(node --version) installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
#  3. Google Chrome (whatsapp-web.js drives a real browser)
# ─────────────────────────────────────────────────────────────────────────────
find_chrome() {
  local c
  for c in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium \
           /usr/bin/chromium-browser /snap/bin/chromium /opt/google/chrome/chrome; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

if CHROME_PATH="$(find_chrome)"; then
  success "Browser found: $CHROME_PATH"
else
  info "Installing Google Chrome…"
  case "$PKG" in
    apt)
      ARCH=$(dpkg --print-architecture 2>/dev/null || echo amd64)
      wget -q "https://dl.google.com/linux/direct/google-chrome-stable_current_${ARCH}.deb" -O /tmp/chrome.deb \
        && { DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/chrome.deb \
             || DEBIAN_FRONTEND=noninteractive apt-get install -y -f -qq; } \
        || warn "Chrome .deb install failed."
      rm -f /tmp/chrome.deb
      ;;
    dnf|yum)
      pkg_install "https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm" \
        || warn "Chrome .rpm install failed."
      ;;
    pacman)
      pkg_install chromium || warn "chromium install failed."
      ;;
  esac
  CHROME_PATH="$(find_chrome)" || error "Could not install a browser. Install Chrome or Chromium manually and set BROWSER_PATH in .env."
  success "Browser installed: $CHROME_PATH"
fi

# ─────────────────────────────────────────────────────────────────────────────
#  4. PM2
# ─────────────────────────────────────────────────────────────────────────────
if command -v pm2 >/dev/null 2>&1; then
  success "PM2 already installed ($(pm2 --version 2>/dev/null | tail -1))"
else
  info "Installing PM2…"
  npm install -g pm2 --quiet --no-audit --no-fund >/dev/null 2>&1
  command -v pm2 >/dev/null 2>&1 || error "PM2 installation failed."
  success "PM2 installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
#  5. Fetch the code
# ─────────────────────────────────────────────────────────────────────────────
# Running from inside a checkout of this project (`bash install.sh`) installs in
# place. The package name check matters: under `curl | bash` the "script dir"
# resolves to the caller's cwd, and we must not hijack an unrelated Node app.
is_vampire_checkout() {
  [ -f "$1/package.json" ] && [ -f "$1/start.js" ] \
    && grep -q '"name"[[:space:]]*:[[:space:]]*"whatsapp-agent-system"' "$1/package.json"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
if [ -n "$SCRIPT_DIR" ] && is_vampire_checkout "$SCRIPT_DIR"; then
  INSTALL_DIR="$SCRIPT_DIR"
  info "Installing from this checkout: $INSTALL_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing install in $INSTALL_DIR…"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$VAMPIRE_BRANCH" -q
  git -C "$INSTALL_DIR" checkout -q "$VAMPIRE_BRANCH" 2>/dev/null || true
  git -C "$INSTALL_DIR" reset --hard -q "origin/$VAMPIRE_BRANCH" || warn "Could not fast-forward — using the code already on disk."
  success "Code updated"
else
  info "Cloning into $INSTALL_DIR…"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch "$VAMPIRE_BRANCH" "$REPO_URL" "$INSTALL_DIR" -q
  success "Code cloned"
fi

cd "$INSTALL_DIR"
[ -f package.json ] || error "$INSTALL_DIR does not look like the Vampire repo (no package.json)."

# ─────────────────────────────────────────────────────────────────────────────
#  6. npm install
# ─────────────────────────────────────────────────────────────────────────────
# Puppeteer would otherwise download its own Chromium (~150 MB); we point
# whatsapp-web.js at the system Chrome through BROWSER_PATH instead.
info "Installing npm dependencies (this can take a minute)…"
export PUPPETEER_SKIP_DOWNLOAD=true
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund --quiet 2>/dev/null \
    || npm install --omit=dev --no-audit --no-fund --quiet
else
  npm install --omit=dev --no-audit --no-fund --quiet
fi
success "Dependencies installed"

# ─────────────────────────────────────────────────────────────────────────────
#  7. .env
# ─────────────────────────────────────────────────────────────────────────────
ENV_FILE="$INSTALL_DIR/.env"
FRESH_ENV=0

if [ ! -f "$ENV_FILE" ]; then
  cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
  FRESH_ENV=1
  info "Created .env from .env.example"
else
  success ".env already exists — leaving your settings alone"
fi

# set_env KEY VALUE — replace the active line if present, otherwise append.
# Only uncommented lines are touched: the explanatory comments in .env.example
# also contain things like "#   HEADLESS=false", and rewriting those would
# leave the file full of duplicate keys.
set_env() {
  local key="$1" value="$2"
  if grep -qE "^[[:space:]]*${key}=" "$ENV_FILE"; then
    # `|` as the delimiter: values are paths and legitimately contain `/`
    sed -i "s|^[[:space:]]*${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

set_env HEADLESS       "true"
set_env BROWSER_PATH   "$CHROME_PATH"
set_env DASHBOARD_PORT "$VAMPIRE_PORT"
set_env DASHBOARD_HOST "0.0.0.0"

# A fresh .env still carries the example secret — mint a real one.
if [ "$FRESH_ENV" -eq 1 ]; then
  SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  set_env DASHBOARD_SECRET "$SECRET"
fi

# ── optional first-run configuration ─────────────────────────────────────────
if [ "$FRESH_ENV" -eq 1 ]; then
  GEMINI_KEY="$(ask 'Gemini API key (Enter to skip): ' '')"
  [ -n "$GEMINI_KEY" ] && set_env GEMINI_API_KEY "$GEMINI_KEY"

  ADMIN_NUMS="$(ask 'Your WhatsApp number(s), comma-separated (Enter to allow all): ' '')"
  [ -n "$ADMIN_NUMS" ] && set_env ADMIN_NUMBERS "$ADMIN_NUMS"
fi

mkdir -p "$INSTALL_DIR/logs" "$INSTALL_DIR/public/media" "$INSTALL_DIR/data"
success ".env configured (port ${VAMPIRE_PORT})"

# ─────────────────────────────────────────────────────────────────────────────
#  8. Firewall
# ─────────────────────────────────────────────────────────────────────────────
firewall_open() {
  local port="$1"
  if command -v ufw >/dev/null 2>&1; then
    ufw allow "${port}"/tcp >/dev/null 2>&1 || true
    ufw allow OpenSSH      >/dev/null 2>&1 || true
    ufw --force enable     >/dev/null 2>&1 || true
    info "ufw: port ${port}/tcp opened"
  elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
    info "firewalld: port ${port}/tcp opened"
  else
    warn "No ufw/firewalld found — open port ${port} in your cloud provider's firewall."
  fi
}
firewall_open "$VAMPIRE_PORT"

# ─────────────────────────────────────────────────────────────────────────────
#  9. Start under PM2
# ─────────────────────────────────────────────────────────────────────────────
info "Starting the bot with PM2…"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env >/dev/null
  success "Restarted PM2 process '$PM2_NAME'"
else
  pm2 start ecosystem.config.js >/dev/null
  success "Started PM2 process '$PM2_NAME'"
fi
pm2 save --force >/dev/null 2>&1 || true

info "Enabling PM2 on boot…"
STARTUP_CMD="$(pm2 startup systemd -u root --hp /root 2>&1 | grep -oE 'sudo env .*' | head -1 || true)"
[ -n "$STARTUP_CMD" ] && eval "$STARTUP_CMD" >/dev/null 2>&1 || true
pm2 save --force >/dev/null 2>&1 || true
success "PM2 will restart the bot on reboot"

# ─────────────────────────────────────────────────────────────────────────────
#  10. Health check
# ─────────────────────────────────────────────────────────────────────────────
info "Waiting for the dashboard to come up…"
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${VAMPIRE_PORT}/api/status" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 1
done

SERVER_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
          || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null \
          || hostname -I 2>/dev/null | awk '{print $1}' \
          || echo '<server-ip>')"

echo
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
if [ "$HEALTHY" -eq 1 ]; then
  echo -e "${GREEN}${BOLD}   ✅  Install complete — dashboard is live         ${NC}"
else
  echo -e "${YELLOW}${BOLD}   ⚠   Install finished, dashboard not answering yet${NC}"
fi
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo
echo -e "   ${BOLD}Open in your browser:${NC}"
echo -e "      ${CYAN}${BOLD}http://${SERVER_IP}:${VAMPIRE_PORT}${NC}"
echo
if [ "$HEALTHY" -ne 1 ]; then
  echo -e "   ${YELLOW}Not loading? Check the logs (the bot may still be starting):${NC}"
  echo -e "      ${CYAN}pm2 logs ${PM2_NAME} --lines 50${NC}"
  echo
fi
echo -e "   ${BOLD}Then: scan the QR code on that page${NC} with WhatsApp"
echo -e "   (WhatsApp → Settings → Linked Devices → Link a Device)"
echo
echo -e "   ${BOLD}Useful commands${NC}"
echo -e "      Logs:    ${CYAN}pm2 logs ${PM2_NAME}${NC}"
echo -e "      Status:  ${CYAN}pm2 status${NC}"
echo -e "      Restart: ${CYAN}pm2 restart ${PM2_NAME}${NC}"
echo -e "      Config:  ${CYAN}nano ${INSTALL_DIR}/.env${NC}"
echo
echo -e "   ${BOLD}Re-running this installer later updates the code.${NC}"
echo
