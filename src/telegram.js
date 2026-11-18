"use strict";

const TELEGRAM_TEXT_LIMIT = 3900;

function phoneFromJids(values) {
  for (const value of values) {
    const jid = String(value || "").trim();
    if (!jid || /@lid$/i.test(jid)) continue;
    const local = jid.split("@")[0].replace(/:\d+$/, "");
    const digits = local.replace(/\D/g, "");
    if (/^\d{7,15}$/.test(digits)) return digits;
  }
  return "";
}

function mediaLabel(mime, type) {
  const value = String(mime || type || "").toLowerCase();
  if (value.startsWith("image/") || value.includes("image"))
    return "🖼️ Photo";
  if (value.startsWith("audio/") || value.includes("audio"))
    return "🎤 Audio";
  if (value.startsWith("video/") || value.includes("video"))
    return "🎬 Video";
  if (value.includes("sticker")) return "✨ Sticker";
  if (value.includes("location")) return "📍 Location";
  if (value.includes("contact")) return "👤 Contact";
  if (value.includes("document") || value === "media") return "📎 File";
  return "💬 Message";
}

function formatIncomingMessage(message) {
  const phone = phoneFromJids([
    message.senderJid,
    message.senderAlt,
    message.chatJid,
  ]);
  const label = mediaLabel(message.mime, message.type);
  const lines = [
    "📨 NEW WHATSAPP MESSAGE",
    `👤 Contact: ${message.senderName || "Unknown contact"}`,
    `📱 Phone: ${phone ? `+${phone}` : "Not available"}`,
  ];
  if (message.isGroup)
    lines.push(`👥 Group: ${message.chatName || "Unnamed group"}`);
  if (message.timestamp) lines.push(`🕒 Time: ${message.timestamp}`);
  lines.push("", `${label}:`, message.text || "(No text)");
  return lines.join("\n");
}

function splitTelegramText(text, limit = TELEGRAM_TEXT_LIMIT) {
  const remaining = String(text || "");
  const parts = [];
  let offset = 0;
  while (offset < remaining.length) {
    let end = Math.min(offset + limit, remaining.length);
    if (end < remaining.length && end > offset) {
      const last = remaining.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
    }
    parts.push(remaining.slice(offset, end));
    offset = end;
  }
  return parts.length ? parts : [""];
}

function shouldQueueTelegramMessage({
  enabled,
  fromMe,
  edit,
  existing,
  eventName,
}) {
  return Boolean(
    enabled &&
      !fromMe &&
      !edit &&
      !existing &&
      /message/i.test(String(eventName || "")) &&
      !/(update|edit|delete|revoke|receipt|ack|status)/i.test(
        String(eventName || ""),
      ),
  );
}

function telegramMediaMethod(mime, size) {
  const type = String(mime || "").toLowerCase();
  if (
    (type === "image/jpeg" || type === "image/png") &&
    size <= 10 * 1024 * 1024
  )
    return ["sendPhoto", "photo"];
  if (type === "audio/ogg" || type === "audio/opus")
    return ["sendVoice", "voice"];
  if (type === "audio/mpeg" || type === "audio/mp4")
    return ["sendAudio", "audio"];
  if (type === "video/mp4") return ["sendVideo", "video"];
  return ["sendDocument", "document"];
}

module.exports = {
  TELEGRAM_TEXT_LIMIT,
  formatIncomingMessage,
  mediaLabel,
  phoneFromJids,
  shouldQueueTelegramMessage,
  splitTelegramText,
  telegramMediaMethod,
};
