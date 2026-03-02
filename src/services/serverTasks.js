/**
 * src/services/serverTasks.js
 * ─────────────────────────────────────────────────────────────
 * All server-side utilities the bot can trigger:
 *   • Safe shell command execution (whitelist-gated)
 *   • Disk / CPU / RAM metrics
 *   • Log tailing
 *   • API / URL health check
 *   • Service restart (systemd / pm2)
 *   • Nmap scan (authorised IPs only)
 *   • Crypto price fetch (CoinGecko)
 *   • Weather fetch (OpenWeatherMap)
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const { exec }      = require('child_process');
const { promisify } = require('util');
const path          = require('path');
const fs            = require('fs-extra');
const axios         = require('axios');
const si            = require('systeminformation');
const { logger }    = require('../utils/logger');
require('dotenv').config();

const execAsync = promisify(exec);

// ── whitelisted shell commands ────────────────────────────────────────────────
const BASE_ALLOWED = [
  'uptime', 'uname', 'whoami', 'hostname', 'date',
  'df', 'du', 'free', 'top', 'ps', 'netstat', 'ss',
  'ifconfig', 'ip', 'ping', 'traceroute', 'curl', 'wget',
  'cat', 'tail', 'head', 'grep', 'ls', 'pwd',
  'systemctl', 'service', 'journalctl',
  'pm2', 'node', 'npm', 'nmap'
];

function getAllowedCommands() {
  const extra = (process.env.EXTRA_ALLOWED_CMDS || '')
    .split(',').map(c => c.trim()).filter(Boolean);
  return [...new Set([...BASE_ALLOWED, ...extra])];
}

function baseCommand(cmd) {
  return cmd.trim().split(/\s+/)[0];
}

function isAllowed(cmd) {
  return getAllowedCommands().includes(path.basename(baseCommand(cmd)));
}

// ── danger patterns ───────────────────────────────────────────────────────────
const DANGER_PATTERNS = [
  /rm\s+-[rRf]+/,
  />\s*\/dev\//,
  /mkfs/,
  /dd\s+if=/,
  /chmod\s+777/,
  /:\(\)\s*\{.*\}/,
  /curl.*\|\s*(ba)?sh/,
  /wget.*\|\s*(ba)?sh/,
  /eval\s*["`'(]/,
  /base64.*\|/
];

function isDangerous(cmd) {
  return DANGER_PATTERNS.some(p => p.test(cmd));
}

// ─────────────────────────────────────────────────────────────────────────────
//  SAFE SHELL EXECUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a whitelisted shell command safely.
 * @returns {Promise<{ success: boolean, output: string, error?: string }>}
 */
async function runCommand(cmd, opts = {}) {
  const trimmed = cmd.trim();

  if (!isAllowed(trimmed)) {
    const msg = `Command not whitelisted: "${baseCommand(trimmed)}"`;
    logger.warn(msg);
    return { success: false, output: '', error: msg };
  }

  if (isDangerous(trimmed)) {
    const msg = `Dangerous pattern blocked: "${trimmed}"`;
    logger.warn(msg);
    return { success: false, output: '', error: msg };
  }

  try {
    const { stdout, stderr } = await execAsync(trimmed, {
      timeout:   (opts.timeout || 15) * 1000,
      maxBuffer: 512 * 1024,
      ...opts
    });
    const output = (stdout + (stderr ? `\n[stderr]: ${stderr}` : '')).trim();
    logger.logCommand({ command: trimmed, result: output.slice(0, 200), success: true });
    return { success: true, output };
  } catch (err) {
    const errMsg = err.stderr || err.message || 'Unknown error';
    logger.logCommand({ command: trimmed, result: errMsg.slice(0, 200), success: false });
    return { success: false, output: '', error: errMsg };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SYSTEM METRICS
// ─────────────────────────────────────────────────────────────────────────────

async function getSystemMetrics() {
  try {
    const [cpu, mem, disk, load] = await Promise.all([
      si.cpu(), si.mem(), si.fsSize(), si.currentLoad()
    ]);

    const toGB      = b => (b / 1024 ** 3).toFixed(2);
    const toPct     = n => n.toFixed(1);
    const diskLines = disk
      .filter(d => d.use > 0)
      .map(d => `  ${d.fs} → ${toPct(d.use)}% used  (${toGB(d.used)}/${toGB(d.size)} GB)`)
      .join('\n');

    return [
      `*System Metrics* — ${new Date().toLocaleString()}`,
      '',
      `*CPU:* ${cpu.manufacturer} ${cpu.brand} (${cpu.cores} cores)`,
      `  Load: ${toPct(load.currentLoadUser)}% user | ${toPct(load.currentLoadSystem)}% sys`,
      `  Avg:  ${toPct(load.avgLoad * 100)}%`,
      '',
      `*Memory:*`,
      `  Total : ${toGB(mem.total)} GB`,
      `  Used  : ${toGB(mem.active)} GB  (${toPct((mem.active / mem.total) * 100)}%)`,
      `  Free  : ${toGB(mem.available)} GB`,
      '',
      `*Disk:*`,
      diskLines || '  (no mounted filesystems found)'
    ].join('\n');
  } catch (err) {
    return `Failed to retrieve system metrics: ${err.message}`;
  }
}

async function getDiskUsage() {
  const res = await runCommand('df -h');
  return res.success ? res.output : res.error;
}

async function tailLog(filePath, lines = 20) {
  const safePath = path.resolve(filePath);
  const allowed  = ['/var/log', '/home', path.resolve('./logs')];

  if (!allowed.some(d => safePath.startsWith(d))) {
    return `Access denied: "${safePath}" is outside allowed directories.`;
  }

  const exists = await fs.pathExists(safePath);
  if (!exists) return `File not found: ${safePath}`;

  const res = await runCommand(`tail -n ${parseInt(lines)} "${safePath}"`);
  return res.success ? res.output : res.error;
}

// ─────────────────────────────────────────────────────────────────────────────
//  API HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────

async function checkApiHealth(urls) {
  const list    = Array.isArray(urls) ? urls : [urls];
  const results = [];

  for (const url of list) {
    const start = Date.now();
    try {
      const res = await axios.get(url, { timeout: 10_000, validateStatus: () => true });
      const ms  = Date.now() - start;
      const ok  = res.status >= 200 && res.status < 400;
      results.push(`${ok ? '✅' : '⚠️'} ${url}  →  HTTP ${res.status}  (${ms} ms)`);
      logger.logApiCheck({ url, status: res.status, ok });
    } catch (err) {
      results.push(`❌ ${url}  →  ERROR: ${err.message}  (${Date.now() - start} ms)`);
      logger.logApiCheck({ url, status: 0, ok: false });
    }
  }

  return results.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  SERVICE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

async function restartService(service) {
  const cmd = service.startsWith('pm2:')
    ? `pm2 restart ${service.slice(4)}`
    : `systemctl restart ${service}`;

  const res = await runCommand(cmd, { timeout: 30 });
  return res.success
    ? `✅ Service "${service}" restarted.`
    : `❌ Failed to restart "${service}": ${res.error}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  NMAP SCAN
// ─────────────────────────────────────────────────────────────────────────────

async function nmapScan(target, flags = '-sV --top-ports 100') {
  const allowed = (process.env.NMAP_ALLOWED_TARGETS || '127.0.0.1')
    .split(',').map(t => t.trim());

  if (!allowed.some(a => target.startsWith(a) || a === target)) {
    return `❌ Target "${target}" is not in the authorised list (${allowed.join(', ')}).`;
  }

  const safeFlags = flags.replace(/--script[= ].+/g, '').trim();
  const res = await runCommand(`nmap ${safeFlags} ${target}`, { timeout: 120 });
  return res.success ? res.output : `Nmap error: ${res.error}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CRYPTO PRICES
// ─────────────────────────────────────────────────────────────────────────────

async function getCryptoPrices(coins) {
  const ids = Array.isArray(coins)
    ? coins.join(',')
    : (coins || process.env.CRYPTO_DEFAULT || 'bitcoin,ethereum');

  try {
    const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params:  { ids, vs_currencies: 'usd', include_24hr_change: true },
      timeout: 10_000
    });

    const lines = Object.entries(data).map(([coin, info]) => {
      const change = info.usd_24h_change;
      return `${change >= 0 ? '📈' : '📉'} *${coin.toUpperCase()}*: $${info.usd.toLocaleString()}  (${change ? change.toFixed(2) + '%' : 'n/a'} 24h)`;
    });

    return lines.length ? lines.join('\n') : 'No price data returned.';
  } catch (err) {
    return `Failed to fetch crypto prices: ${err.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  WEATHER
// ─────────────────────────────────────────────────────────────────────────────

async function getWeather(city) {
  const apiKey = process.env.WEATHER_API_KEY;
  if (!apiKey) return '❌ WEATHER_API_KEY is not configured in .env';

  try {
    const { data } = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
      params:  { q: city || process.env.WEATHER_DEFAULT_CITY || 'London', appid: apiKey, units: 'metric' },
      timeout: 10_000
    });
    const { name, sys, main, weather, wind } = data;
    return [
      `*Weather in ${name}, ${sys.country}*`,
      `🌤 ${weather[0].description}`,
      `🌡 Temp: ${main.temp}°C (feels like ${main.feels_like}°C)`,
      `💧 Humidity: ${main.humidity}%`,
      `💨 Wind: ${wind.speed} m/s`,
      `👁 Visibility: ${(data.visibility / 1000).toFixed(1)} km`
    ].join('\n');
  } catch (err) {
    return `Failed to fetch weather: ${err.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  UPTIME & PROCESSES
// ─────────────────────────────────────────────────────────────────────────────

async function getUptime() {
  const res = await runCommand('uptime -p 2>/dev/null || uptime');
  return res.success ? `⏱ *Server uptime:* ${res.output}` : res.error;
}

async function getTopProcesses() {
  const res = await runCommand('ps aux --sort=-%cpu --no-headers | head -6');
  return res.success ? '```\n' + res.output + '\n```' : res.error;
}

module.exports = {
  runCommand,
  isAllowed,
  getSystemMetrics,
  getDiskUsage,
  tailLog,
  checkApiHealth,
  restartService,
  nmapScan,
  getCryptoPrices,
  getWeather,
  getUptime,
  getTopProcesses
};
