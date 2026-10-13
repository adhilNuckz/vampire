/**
 * src/utils/browserLock.js
 * ─────────────────────────────────────────────────────────────
 * Recovery from a browser profile that a previous run left locked.
 *
 * Chrome refuses to start when the profile still holds a SingletonLock
 * ("The browser is already running for …"). A bot that dies without closing
 * its browser — SIGKILL, an OOM kill, a hard reboot — leaves exactly that
 * state behind, and every later start fails the same way, so the bot never
 * comes back on its own.
 *
 * The lock is a symlink named "<hostname>-<pid>", which lets us be careful:
 * a lock owned by a live process on this machine is left alone (a concurrent
 * instance sharing the profile is not ours to break), and a lock from another
 * host is never touched.
 *
 * This deployment is single-instance and is the only launcher of a browser
 * against that directory, so a browser process still holding the profile when
 * we are not running one is a leftover from a crashed run and is reaped.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs-extra');
const { logger } = require('./logger');

const LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

/** The browser profile directory LocalAuth uses for this process. */
function sessionDir(cwd = process.cwd()) {
  return path.resolve(cwd, '.wwebjs_auth', 'session');
}

/** Is `pid` a live process on this machine? */
function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }   // EPERM => exists, just not ours
}

/** PIDs of browser processes holding `dir`. Linux only; [] elsewhere. */
async function findProfileBrowserPids(dir) {
  if (process.platform !== 'linux') return [];

  let entries;
  try { entries = await fs.readdir('/proc'); } catch (_) { return []; }

  const needle = `--user-data-dir=${dir}`;
  const pids   = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8');
      if (cmdline.includes(needle)) pids.push(Number(entry));
    } catch (_) { /* process exited while we were looking at it */ }
  }
  return pids;
}

/**
 * Terminate browsers still holding `dir`.
 * @returns {Promise<number>} how many were found
 */
async function killOrphanBrowsers(dir) {
  const pids = await findProfileBrowserPids(dir);
  if (!pids.length) return 0;

  logger.warn(`Terminating ${pids.length} leftover browser process(es) holding the WhatsApp profile…`);
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch (_) {} }
  await new Promise(resolve => setTimeout(resolve, 2_000));
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
  return pids.length;
}

/**
 * Remove lock files left by a process that is gone.
 *
 * Deliberately conservative: returns false and changes nothing when the lock
 * names a different host, or names a PID that is still alive.
 *
 * @returns {Promise<boolean>} true when a stale lock was removed
 */
async function clearStaleProfileLock(dir, hostname = os.hostname()) {
  const lockPath = path.join(dir, 'SingletonLock');

  // lstat, not pathExists: SingletonLock is a symlink to "<host>-<pid>", which
  // names no real file, so it is *always* dangling. pathExists follows symlinks
  // and would report "no lock" every time, making this whole function a no-op.
  let stat;
  try {
    stat = await fs.lstat(lockPath);
  } catch (_) {
    return false;   // no lock at all — nothing to do
  }
  if (!stat.isSymbolicLink()) return false;   // not the shape we know how to judge

  let target;
  try {
    target = await fs.readlink(lockPath);
  } catch (_) {
    return false;
  }

  // Split at the LAST hyphen. A greedy /^(.*)-(\d+)$/ would parse
  // "host-2147483646" as host "host-214748364" + pid 6, and every host
  // comparison would then fail, so no stale lock would ever be cleared.
  const sep = (target || '').lastIndexOf('-');
  if (sep === -1) return false;
  const ownerHost = target.slice(0, sep);
  const pidText   = target.slice(sep + 1);
  if (!/^\d+$/.test(pidText)) return false;
  const ownerPid = Number(pidText);

  if (ownerHost && ownerHost !== hostname) return false;   // another machine's profile
  if (pidIsAlive(ownerPid)) return false;                  // a live instance — hands off

  for (const name of LOCK_FILES) {
    try { await fs.remove(path.join(dir, name)); } catch (_) {}
  }
  logger.warn(`Removed stale browser profile lock left by dead process ${ownerPid}.`);
  return true;
}

module.exports = {
  LOCK_FILES,
  sessionDir,
  pidIsAlive,
  findProfileBrowserPids,
  killOrphanBrowsers,
  clearStaleProfileLock,
};
