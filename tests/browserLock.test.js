/**
 * tests/browserLock.test.js
 * ─────────────────────────────────────────────────────────────
 * The lock-clearing logic decides whether the bot can recover from a crash —
 * and, just as importantly, when it must keep its hands off a profile that a
 * live process is legitimately using.
 *
 * Run:  npm test
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const os     = require('node:os');
const fs     = require('node:fs');

// logger writes to LOG_DIR relative to cwd, so isolate before requiring.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vampire-lock-'));
process.chdir(sandbox);

const {
  LOCK_FILES, sessionDir, pidIsAlive, clearStaleProfileLock,
} = require('../src/utils/browserLock');

const HOSTNAME = 'testhost';

/** Build a profile dir holding a SingletonLock pointing at `<host>-<pid>`. */
function makeProfile(name, lockTarget) {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of LOCK_FILES) fs.symlinkSync('x', path.join(dir, file));
  if (lockTarget) {
    fs.rmSync(path.join(dir, 'SingletonLock'));
    fs.symlinkSync(lockTarget, path.join(dir, 'SingletonLock'));
  }
  return dir;
}

// lstatSync, not existsSync: these are symlinks to "<host>-<pid>", which name
// no real file, and existsSync follows symlinks — it would call every lock
// "gone" and the negative assertions below would pass vacuously.
const locksGone = dir => LOCK_FILES.every(
  f => !fs.lstatSync(path.join(dir, f), { throwIfNoEntry: false })
);

test('sessionDir resolves the profile from the working directory', () => {
  assert.strictEqual(sessionDir('/srv/app'), path.resolve('/srv/app/.wwebjs_auth/session'));
});

test('pidIsAlive is true for this process and false for an unused pid', () => {
  assert.strictEqual(pidIsAlive(process.pid), true);
  // PID 0x7FFFFFFF is above any real pid on Linux.
  assert.strictEqual(pidIsAlive(2147483646), false);
});

test('a lock from a dead process on this host is cleared', async () => {
  const dir = makeProfile('dead-owner', `${HOSTNAME}-2147483646`);
  assert.strictEqual(await clearStaleProfileLock(dir, HOSTNAME), true);
  assert.ok(locksGone(dir), 'all lock files removed');
});

test('a lock held by a LIVE process is left alone', async () => {
  const dir = makeProfile('live-owner', `${HOSTNAME}-${process.pid}`);
  assert.strictEqual(await clearStaleProfileLock(dir, HOSTNAME), false);
  assert.ok(!locksGone(dir), 'a running instance must not have its profile stolen');
});

test("a lock belonging to another host is never touched", async () => {
  const dir = makeProfile('other-host', `someotherbox-2147483646`);
  assert.strictEqual(await clearStaleProfileLock(dir, HOSTNAME), false);
  assert.ok(!locksGone(dir), "another machine's profile is not ours to break");
});

test('a profile with no lock is a no-op', async () => {
  const dir = makeProfile('no-lock', null);
  fs.rmSync(path.join(dir, 'SingletonLock'));
  assert.strictEqual(await clearStaleProfileLock(dir, HOSTNAME), false);
});

test('a missing profile directory is a no-op rather than a crash', async () => {
  assert.strictEqual(await clearStaleProfileLock(path.join(sandbox, 'nope'), HOSTNAME), false);
});

test('an unrecognised lock target is left alone', async () => {
  // No "-<pid>" suffix, so we cannot prove the owner is gone.
  const dir = makeProfile('weird', 'not-a-pid');
  assert.strictEqual(await clearStaleProfileLock(dir, HOSTNAME), false);
  assert.ok(!locksGone(dir));
});

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
