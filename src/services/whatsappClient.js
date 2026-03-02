'use strict';

/**
 * Shared singleton holding the live whatsapp-web.js client.
 * bot/index.js calls setClient() once ready.
 * dashboard and scheduler import getClient() to send messages.
 */

let _client = null;

function setClient(c) { _client = c; }
function getClient()  { return _client; }

/**
 * Send a WhatsApp message.
 * @param {string} to       Phone number (e.g. "94783811114") — @c.us is added automatically
 * @param {string} message
 */
async function sendWhatsApp(to, message) {
  const client = getClient();
  if (!client) throw new Error('WhatsApp client not ready yet.');
  const chatId = to.includes('@') ? to : `${to}@c.us`;
  return client.sendMessage(chatId, message);
}

module.exports = { setClient, getClient, sendWhatsApp };
