/**
 * tests/auth.test.js
 * ─────────────────────────────────────────────────────────────
 * The dashboard gate. It protects an archive of every chat the account has
 * seen, so the negative cases matter more than the positive ones.
 *
 * Run:  npm test
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const { createAuth, parseBasic, parseCookies } = require('../src/dashboard/auth');

const USER = 'admin';
const PASS = 'correct horse battery staple';

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

test('parseBasic extracts credentials, and rejects anything else', () => {
  assert.deepStrictEqual(parseBasic(basic('a', 'b:c')), { user: 'a', pass: 'b:c' });  // colon in password
  assert.strictEqual(parseBasic('Bearer xyz'), null);
  assert.strictEqual(parseBasic(undefined), null);
  assert.strictEqual(parseBasic('Basic ' + Buffer.from('nocolon').toString('base64')), null);
});

test('parseCookies tolerates junk', () => {
  assert.deepStrictEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepStrictEqual(parseCookies('flag; a=1'), { a: '1' });   // bare token
  assert.deepStrictEqual(parseCookies(undefined), {});
  assert.deepStrictEqual(parseCookies('a=%E0%A4%A'), { a: '%E0%A4%A' }); // malformed escape survives
});

test('correct credentials are accepted', () => {
  const auth = createAuth({ user: USER, pass: PASS });
  assert.strictEqual(auth.checkRequest({ authorization: basic(USER, PASS) }), true);
});

test('wrong password, wrong user and missing header are all rejected', () => {
  const auth = createAuth({ user: USER, pass: PASS });
  assert.strictEqual(auth.checkRequest({ authorization: basic(USER, 'wrong') }), false);
  assert.strictEqual(auth.checkRequest({ authorization: basic('root', PASS) }), false);
  assert.strictEqual(auth.checkRequest({}), false);
  assert.strictEqual(auth.checkRequest({ authorization: 'Basic !!!not-base64!!!' }), false);
});

test('a password that is a prefix of the real one is rejected', () => {
  // Guards against a naive === or startsWith comparison.
  const auth = createAuth({ user: USER, pass: PASS });
  assert.strictEqual(auth.checkRequest({ authorization: basic(USER, PASS.slice(0, 10)) }), false);
  assert.strictEqual(auth.checkRequest({ authorization: basic(USER, PASS + 'x') }), false);
});

test('a valid session cookie is accepted without credentials', () => {
  const auth  = createAuth({ user: USER, pass: PASS });
  const token = auth.issueToken();
  assert.strictEqual(auth.checkRequest({ cookie: `vampire_auth=${token}` }), true);
});

test('a forged or truncated cookie is rejected', () => {
  const auth  = createAuth({ user: USER, pass: PASS });
  const token = auth.issueToken();
  const [issued] = token.split('.');

  for (const bad of [
    `${issued}.deadbeef`,              // wrong signature
    `${issued}`,                       // no signature
    `${issued}.`,                      // empty signature
    `9999999999999.${token.split('.')[1]}`,  // signature for a different timestamp
    'garbage',
    '',
  ]) {
    assert.strictEqual(auth.checkRequest({ cookie: `vampire_auth=${bad}` }), false, `should reject ${bad}`);
  }
});

test('an expired cookie is rejected', () => {
  let clock = 1_000_000;
  const auth = createAuth({ user: USER, pass: PASS, now: () => clock });
  const token = auth.issueToken();

  assert.strictEqual(auth.tokenIsValid(token), true);
  clock += 6 * 24 * 60 * 60 * 1000;          // 6 days — still valid
  assert.strictEqual(auth.tokenIsValid(token), true);
  clock += 2 * 24 * 60 * 60 * 1000;          // 8 days — expired
  assert.strictEqual(auth.tokenIsValid(token), false);
});

test('changing the password invalidates existing sessions', () => {
  const before = createAuth({ user: USER, pass: PASS });
  const token  = before.issueToken();

  const after = createAuth({ user: USER, pass: 'a new password' });
  assert.strictEqual(after.tokenIsValid(token), false, 'old sessions must not survive a password change');
});

test('a token minted for one user does not work for another', () => {
  const a = createAuth({ user: 'alice', pass: PASS });
  const b = createAuth({ user: 'bob',   pass: PASS });
  assert.strictEqual(b.tokenIsValid(a.issueToken()), false);
});

test('leaving the credentials blank disables auth rather than locking everyone out', () => {
  for (const opts of [{}, { user: 'admin' }, { pass: 'secret' }]) {
    const auth = createAuth(opts);
    assert.strictEqual(auth.enabled, false);
    assert.strictEqual(auth.checkRequest({}), true);
    assert.strictEqual(auth.issueToken(), null, 'no cookie when auth is off');
  }
});

// ── the middleware itself ────────────────────────────────────────────────────

/** Minimal res double for exercising the middleware. */
function fakeRes() {
  return {
    statusCode: null, headers: {}, cookies: [], body: null,
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    type() { return this; },
    send(b) { this.body = b; return this; },
    cookie(name, value, opts) { this.cookies.push({ name, value, opts }); return this; },
  };
}

test('the middleware 401s unauthenticated requests and sets a challenge', () => {
  const auth = createAuth({ user: USER, pass: PASS });
  const res  = fakeRes();
  let nexted = false;

  auth.middleware({ headers: {} }, res, () => { nexted = true; });

  assert.strictEqual(nexted, false, 'must not fall through');
  assert.strictEqual(res.statusCode, 401);
  assert.match(res.headers['WWW-Authenticate'], /^Basic realm="/);
});

test('the middleware passes a valid login through and issues a cookie', () => {
  const auth = createAuth({ user: USER, pass: PASS });
  const res  = fakeRes();
  let nexted = false;

  auth.middleware({ headers: { authorization: basic(USER, PASS) } }, res, () => { nexted = true; });

  assert.strictEqual(nexted, true);
  assert.deepStrictEqual(res.cookies.map(c => c.name), ['vampire_auth']);
  assert.strictEqual(res.cookies[0].opts.httpOnly, true, 'cookie must not be readable by scripts');
  assert.ok(res.cookies[0].value, 'cookie must carry a token');
});

test('the middleware does not re-issue a cookie on every request', () => {
  const auth  = createAuth({ user: USER, pass: PASS });
  const token = auth.issueToken();
  const res   = fakeRes();
  let nexted  = false;

  auth.middleware(
    { headers: { authorization: basic(USER, PASS), cookie: `vampire_auth=${token}` } },
    res, () => { nexted = true; }
  );

  assert.strictEqual(nexted, true);
  assert.deepStrictEqual(res.cookies, [], 'a valid session should not be rewritten each time');
});

test('when auth is disabled the middleware never blocks or sets a cookie', () => {
  const auth = createAuth({});
  const res  = fakeRes();
  let nexted = false;

  auth.middleware({ headers: {} }, res, () => { nexted = true; });

  assert.strictEqual(nexted, true);
  assert.deepStrictEqual(res.cookies, []);
});

// ── the socket gate ──────────────────────────────────────────────────────────

test('the socket handshake accepts valid credentials and a valid cookie', () => {
  const auth = createAuth({ user: USER, pass: PASS });

  assert.strictEqual(auth.checkHandshake({ headers: { authorization: basic(USER, PASS) } }), true);
  assert.strictEqual(auth.checkHandshake({ headers: { cookie: `vampire_auth=${auth.issueToken()}` } }), true);
});

test('the socket handshake rejects an anonymous client', () => {
  // The WebSocket upgrade bypasses Express entirely, so this is the only thing
  // standing between the archive and anyone who can reach the port.
  const auth = createAuth({ user: USER, pass: PASS });

  assert.strictEqual(auth.checkHandshake({ headers: {} }), false);
  assert.strictEqual(auth.checkHandshake({}), false);
  assert.strictEqual(auth.checkHandshake({ headers: { authorization: basic(USER, 'nope') } }), false);

  let err = null;
  auth.socketMiddleware({ handshake: { headers: {} } }, e => { err = e; });
  assert.ok(err instanceof Error, 'anonymous socket must be refused');
});
