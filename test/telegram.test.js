"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatIncomingMessage,
  phoneFromJids,
  shouldQueueTelegramMessage,
  splitTelegramText,
  telegramMediaMethod,
} = require("../src/telegram");

test("phone extraction prefers phone JIDs and ignores LIDs", () => {
  assert.equal(
    phoneFromJids(["opaque@lid", "5511999999999:4@s.whatsapp.net"]),
    "5511999999999",
  );
  assert.equal(phoneFromJids(["opaque@lid"]), "");
});

test("group alert uses English labels and omits the instance", () => {
  const value = formatIncomingMessage({
    instanceName: "Work",
    senderName: "Rafa",
    senderJid: "5511999999999@s.whatsapp.net",
    chatName: "Support",
    chatJid: "120000000000@g.us",
    isGroup: true,
    timestamp: "18/11/26 10:00",
    text: "Need help <today>",
  });
  assert.match(value, /👤 Contact: Rafa/);
  assert.match(value, /📱 Phone: \+5511999999999/);
  assert.match(value, /👥 Group: Support/);
  assert.doesNotMatch(value, /instance|instância/i);
  assert.match(value, /📨 NEW WHATSAPP MESSAGE/);
  assert.match(value, /🕒 Time: 18\/11\/26 10:00/);
  assert.match(value, /Need help <today>/);
});

test("media labels and empty message fallback use English", () => {
  assert.match(formatIncomingMessage({ mime: "image/jpeg" }), /🖼️ Photo:/);
  assert.match(formatIncomingMessage({}), /💬 Message:\n\(No text\)/);
});

test("long plain-text alerts split within Telegram message size", () => {
  const value = "A".repeat(9000) + "😀";
  const parts = splitTelegramText(value, 3900);
  assert.equal(parts.join(""), value);
  assert.ok(parts.every((part) => part.length <= 3900));
  assert.ok(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part)));
});

test("media selects Telegram methods and preserves large images as documents", () => {
  assert.deepEqual(telegramMediaMethod("image/jpeg", 1000), [
    "sendPhoto",
    "photo",
  ]);
  assert.deepEqual(telegramMediaMethod("image/jpeg", 11 * 1024 * 1024), [
    "sendDocument",
    "document",
  ]);
  assert.deepEqual(telegramMediaMethod("audio/ogg", 1000), [
    "sendVoice",
    "voice",
  ]);
  assert.deepEqual(telegramMediaMethod("video/mp4", 1000), [
    "sendVideo",
    "video",
  ]);
});

test("only new inbound message events are eligible for Telegram", () => {
  const eligible = {
    enabled: true,
    fromMe: false,
    edit: false,
    existing: null,
    eventName: "Message",
  };
  assert.equal(shouldQueueTelegramMessage(eligible), true);
  assert.equal(shouldQueueTelegramMessage({ ...eligible, fromMe: true }), false);
  assert.equal(shouldQueueTelegramMessage({ ...eligible, edit: true }), false);
  assert.equal(
    shouldQueueTelegramMessage({ ...eligible, existing: { id: 1 } }),
    false,
  );
  assert.equal(
    shouldQueueTelegramMessage({ ...eligible, eventName: "MessageUpdate" }),
    false,
  );
});
