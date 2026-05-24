'use strict';

const { generateAutoReply } = require('./autopilot');

async function processMessage(text, context = {}) {
  return generateAutoReply({
    senderName: context.senderName || context.chatName || 'friend',
    chatName: context.chatName || 'personal chat',
    messageText: text,
  });
}

async function transcribeAudio() {
  return '';
}

module.exports = { generateAutoReply, processMessage, transcribeAudio };
