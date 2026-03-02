/**
 * get-token.js  —  One-time OAuth2 setup for Gmail API
 * ──────────────────────────────────────────────────────
 * Run this script ONCE to get your refresh token.
 * After running it, paste the three values into your .env file.
 *
 * Usage:
 *   node get-token.js
 *
 * Pre-requisites (takes ~5 minutes):
 *   1. Go to https://console.cloud.google.com/
 *   2. Create a project (or select an existing one)
 *   3. Enable "Gmail API":
 *        APIs & Services → Library → search "Gmail API" → Enable
 *   4. Create OAuth2 credentials:
 *        APIs & Services → Credentials → Create Credentials
 *        → OAuth client ID → Application type: Desktop app → Create
 *   5. Copy the Client ID and Client Secret shown on screen
 *   6. Paste them below when prompted
 * ──────────────────────────────────────────────────────
 */

'use strict';

const { google }   = require('googleapis');
const readline     = require('readline');
const http         = require('http');
const { URL }      = require('url');

const SCOPES = ['https://mail.google.com/'];
const REDIRECT = 'http://localhost:3999/oauth2callback';

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

(async () => {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  Gmail OAuth2 Token Setup');
  console.log('═══════════════════════════════════════════════════════\n');

  const clientId     = await prompt('Paste your Client ID     : ');
  const clientSecret = await prompt('Paste your Client Secret : ');

  if (!clientId || !clientSecret) {
    console.error('\nError: Both Client ID and Client Secret are required.');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',        // force consent screen so we always get a refresh token
  });

  console.log('\n──────────────────────────────────────────────────────');
  console.log('1. Open this URL in your browser:\n');
  console.log('   ' + authUrl);
  console.log('\n2. Log in with adhilnuckz@gmail.com and click Allow.');
  console.log('   (The page will try to load localhost:3999 — that\'s fine,');
  console.log('    this script will catch it automatically.)');
  console.log('──────────────────────────────────────────────────────\n');

  // Start a tiny local HTTP server to catch the redirect with the auth code
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost:3999');
      const code = u.searchParams.get('code');
      const err  = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (code) {
        res.end('<h2 style="font-family:sans-serif;color:green">✅ Authorized! You can close this tab.</h2>');
        server.close();
        resolve(code);
      } else {
        res.end(`<h2 style="font-family:sans-serif;color:red">❌ Auth error: ${err}</h2>`);
        server.close();
        reject(new Error('OAuth2 denied: ' + err));
      }
    });
    server.listen(3999, () => console.log('Waiting for browser redirect on http://localhost:3999 …\n'));
    server.on('error', reject);
  });

  console.log('Authorization code received. Exchanging for tokens…\n');

  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    console.warn('⚠️  No refresh_token in response.');
    console.warn('   This usually means you already authorized this app once before.');
    console.warn('   Fix: Go to https://myaccount.google.com/permissions, revoke the app, then re-run this script.\n');
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  SUCCESS — Add these lines to your .env file:');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log(`GMAIL_CLIENT_ID=${clientId}`);
  console.log(`GMAIL_CLIENT_SECRET=${clientSecret}`);
  if (tokens.refresh_token) {
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
  } else {
    console.log('GMAIL_REFRESH_TOKEN=<run script again after revoking app>');
  }
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  After updating .env, restart the bot: node start.js');
  console.log('═══════════════════════════════════════════════════════\n');
})().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
