"use strict";
const $ = (s) => document.querySelector(s),
  state = {
    csrf: "",
    user: "",
    instance: "",
    chat: "",
    chats: [],
    messages: [],
    setupChallenge: "",
    forwardId: "",
    qrPoll: "",
    avatarRequests: new Map(),
    participantAvatars: new Map(),
    participantObserver: null,
    drawerRequest: 0,
    replyTo: null,
    editingMessage: null,
    editDraft: "",
    emojiMode: "",
    reactionTarget: null,
    emojiData: null,
    emojiGroup: 0,
    imageViewerTrigger: null,
    sendingText: false,
    pendingImage: null,
    sendingImage: false,
    titleTimer: 0,
    titleUnreadCount: 0,
    titleShowingMessage: false,
    titleFaviconCount: 0,
    titleFaviconDataUrl: "",
  };
const BASE_PAGE_TITLE = document.title || "WhatsApp Panel";
const BASE_FAVICON_URL = "/favicon.svg?v=20261118-unread-icon";
function show(id, on) {
  $(id).classList.toggle("hidden", !on);
}
function updateUnreadFavicon() {
  const icon = $("#app-favicon");
  if (!icon) return;
  const count = state.titleUnreadCount;
  if (!count || state.titleShowingMessage) {
    if (icon.getAttribute("href") !== BASE_FAVICON_URL)
      icon.setAttribute("href", BASE_FAVICON_URL);
    return;
  }
  if (state.titleFaviconCount !== count) {
    const label = count > 9 ? "9+" : String(count),
      size = label.length > 1 ? 25 : 37,
      svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="31" fill="#0b806f"/><text x="32" y="44" text-anchor="middle" fill="#fff" font-family="Arial,Helvetica,sans-serif" font-size="' +
        size +
        '" font-weight="700">' +
        label +
        "</text></svg>";
    state.titleFaviconCount = count;
    state.titleFaviconDataUrl =
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  if (icon.getAttribute("href") !== state.titleFaviconDataUrl)
    icon.setAttribute("href", state.titleFaviconDataUrl);
}
function setUnreadTitle(count) {
  count = Math.max(0, Math.floor(Number(count) || 0));
  if (!state.user || !state.instance || !count) {
    if (state.titleTimer) clearInterval(state.titleTimer);
    state.titleTimer = 0;
    state.titleUnreadCount = 0;
    state.titleShowingMessage = false;
    document.title = BASE_PAGE_TITLE;
    updateUnreadFavicon();
    return;
  }
  if (count === state.titleUnreadCount && state.titleTimer) return;
  if (state.titleTimer) clearInterval(state.titleTimer);
  state.titleUnreadCount = count;
  state.titleShowingMessage = false;
  document.title = `(${count}) ${BASE_PAGE_TITLE}`;
  updateUnreadFavicon();
  state.titleTimer = window.setInterval(() => {
    state.titleShowingMessage = !state.titleShowingMessage;
    document.title = state.titleShowingMessage
      ? "New message"
      : `(${state.titleUnreadCount}) ${BASE_PAGE_TITLE}`;
    updateUnreadFavicon();
  }, 1500);
}
function updateUnreadTitle() {
  const total = state.chats.reduce(
    (sum, chat) => sum + Math.max(0, Number(chat.unreadCount) || 0),
    0,
  );
  setUnreadTitle(total);
}
const THEME_STORAGE_KEY = "whatsapp-panel-theme";
function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
function applyTheme(theme, persist = false) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const toggle = $("#theme-toggle");
  if (toggle) {
    const next = dark ? "light" : "dark";
    toggle.textContent = dark ? "☀" : "☾";
    toggle.setAttribute("aria-label", `Switch to ${next} mode`);
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.title = `Switch to ${next} mode`;
  }
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = dark ? "#102321" : "#075e54";
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, dark ? "dark" : "light");
    } catch {}
  }
}
function openImageViewer(mediaId, alt, trigger) {
  const viewer = $("#image-viewer"),
    mediaUrl = "/api/media/" + encodeURIComponent(mediaId);
  state.imageViewerTrigger = trigger;
  $("#image-viewer-image").src = mediaUrl;
  $("#image-viewer-image").alt = alt;
  $("#image-download").href = mediaUrl + "/download";
  if (!viewer.open) viewer.showModal();
  $("#image-viewer-close").focus();
}
function closeImageViewer() {
  const viewer = $("#image-viewer");
  if (viewer.open) viewer.close();
}
applyTheme(initialTheme());
function toast(s) {
  const t = $("#toast");
  t.textContent = s;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}
async function api(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  if (state.csrf) opts.headers["x-csrf-token"] = state.csrf;
  if (opts.body && !(opts.body instanceof FormData))
    opts.headers["Content-Type"] = "application/json";
  const r = await fetch(url, opts);
  if (r.status === 401 && state.user) {
    logoutLocal();
    throw new Error("Your session expired. Please sign in again.");
  }
  if (r.status === 204) return null;
  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (!r.ok) throw new Error(data.error || "Request failed (" + r.status + ")");
  return data;
}
function loginScreen() {
  setUnreadTitle(0);
  show("#login", true);
  show("#setup", false);
  show("#app", false);
}
function logoutLocal() {
  state.user = "";
  state.csrf = "";
  loginScreen();
}
async function login(e) {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  $("#login-error").textContent = "";
  try {
    const x = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: f.get("username"),
        password: f.get("password"),
      }),
    });
    state.csrf = x.csrf;
    state.user = x.username;
    await enterPanel();
  } catch (e) {
    $("#login-error").textContent = e.message;
  }
}
async function startSetup(e) {
  e.preventDefault();
  const token = new FormData(e.currentTarget).get("token");
  $("#token-error").textContent = "";
  try {
    const d = await fetch("/api/setup/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!d.ok)
      throw new Error(
        "The setup code is invalid or expired. Generate a new one on the server.",
      );
    const x = await d.json();
    state.setupChallenge = x.challenge;
    show("#setup-token-form", false);
    show("#setup-password", true);
  } catch (e) {
    $("#token-error").textContent = e.message;
  }
}
async function finishSetup(e) {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  $("#complete-error").textContent = "";
  try {
    const x = await fetch("/api/setup/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challenge: state.setupChallenge,
        username: f.get("username"),
        password: f.get("password"),
      }),
    });
    const d = await x.json();
    if (!x.ok) throw new Error("Check your username and password.");
    state.csrf = d.csrf;
    state.user = d.username;
    show("#setup", false);
    await enterPanel();
  } catch (e) {
    $("#complete-error").textContent = e.message;
  }
}
async function enterPanel() {
  show("#login", false);
  show("#setup", false);
  show("#app", true);
  $("#logout").textContent = state.user.slice(0, 1).toUpperCase();
  await refreshInstances();
  listen();
}
function listen() {
  if (state.es) state.es.close();
  state.es = new EventSource("/api/events");
  state.es.onopen = () => {
    refreshInstances();
    if (state.chat) loadMessages();
  };
  state.es.addEventListener("message", (e) => {
    const d = JSON.parse(e.data);
    if (d.instanceId === state.instance && d.chatJid === state.chat)
      loadMessages();
    if (d.instanceId === state.instance) loadChats();
  });
  state.es.addEventListener("chat-read", (e) => {
    const d = JSON.parse(e.data);
    if (d.instanceId === state.instance) loadChats();
  });
  state.es.addEventListener("instance", (e) => {
    const d = JSON.parse(e.data);
    if (d.id === state.instance) setState(d.status);
    refreshInstances();
  });
  state.es.addEventListener("qr", (e) => {
    const d = JSON.parse(e.data);
    if (d.id === state.instance && state.connectionStatus !== "connected")
      showQr(d.qr);
  });
  state.es.onerror = () => setState("api_unavailable");
}
function setState(s) {
  state.connectionStatus = s;
  const x = $("#connection-state");
  x.className =
    "state " +
    (s === "connected"
      ? "online"
      : s === "disconnected" || s === "api_unavailable"
        ? "offline"
        : "");
  x.querySelector("span").textContent =
    {
      connected: "Connected",
      connecting: "Connecting…",
      needs_pairing: "Waiting for QR code",
      logged_out: "Logged out",
      disconnected: "Disconnected",
      api_unavailable: "API unavailable",
    }[s] || "Waiting for connection";
  $("#connect-btn").classList.toggle(
    "hidden",
    ![
      "disconnected",
      "logged_out",
      "api_unavailable",
      "needs_pairing",
    ].includes(s),
  );
  if (s === "connected") {
    stopQrRefresh();
    show("#qr-modal", false);
    $("#qr-image").removeAttribute("src");
  }
}
function stopQrRefresh() {
  state.qrPoll = "";
}
async function refreshInstances() {
  try {
    const rows = await api("/api/instances");
    const sel = $("#instance-select"),
      old = state.instance;
    sel.replaceChildren();
    rows.forEach((i) => {
      const o = document.createElement("option");
      o.value = i.id;
      o.textContent = i.name;
      sel.append(o);
    });
    if (!rows.length) {
      clearReply();
      clearEdit(false);
      state.instance = "";
      state.chat = "";
      state.chats = [];
      updateUnreadTitle();
      $("#empty-chats").textContent = "Add an instance to get started.";
      $("#chat-list").replaceChildren();
      return;
    }
    state.instance = rows.some((x) => x.id === old) ? old : rows[0].id;
    sel.value = state.instance;
    const inst = rows.find((x) => x.id === state.instance);
    setState(inst.status);
    if (["needs_pairing", "connecting"].includes(inst.status)) {
      show("#qr-modal", true);
      if (inst.qr) showQr(inst.qr);
      else $("#qr-state").textContent = "Waiting for QR code…";
      startQrRefresh(inst.id);
    }
    await loadChats();
  } catch (e) {
    toast(e.message);
  }
}
async function loadChats() {
  if (!state.instance) {
    updateUnreadTitle();
    return;
  }
  const instanceId = state.instance;
  try {
    const chats = await api(
      "/api/chats?instanceId=" + encodeURIComponent(instanceId),
    );
    if (state.instance !== instanceId) return;
    state.chats = chats;
    renderChats();
    updateUnreadTitle();
  } catch (e) {
    toast(e.message);
  }
}
function initials(s) {
  return String(s || "?")
    .trim()
    .slice(0, 1)
    .toUpperCase();
}
function renderChats() {
  const root = $("#chat-list");
  root.replaceChildren();
  const query = $("#search").value.toLowerCase();
  const list = state.chats.filter((c) =>
    (c.name + " " + c.preview).toLowerCase().includes(query),
  );
  show("#empty-chats", !list.length);
  if (!list.length)
    $("#empty-chats").textContent = state.chats.length
      ? "No chats found."
      : "Chats will appear here when messages arrive.";
  list.forEach((c) => {
    const row = document.createElement("div");
    row.className = "chat-item" + (c.jid === state.chat ? " active" : "");
    row.addEventListener("click", () => openChat(c));
    const av = document.createElement("div");
    av.className = "chat-avatar";
    av.textContent = initials(c.name);
    if (c.avatarMediaId) displayAvatar(av, c.avatarMediaId, c.name);
    else observeAvatar(av, c);
    const meta = document.createElement("div");
    meta.className = "chat-meta";
    const name = document.createElement("strong");
    name.textContent = c.name;
    const preview = document.createElement("small");
    preview.textContent = c.preview || "No messages";
    const metaHead = document.createElement("div");
    metaHead.className = "chat-meta-head";
    const time = document.createElement("span");
    time.className = "chat-time";
    time.textContent = c.time
      ? new Date(c.time).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    metaHead.append(name, time);
    meta.append(metaHead, preview);
    row.append(av, meta);
    if (c.unreadCount > 0) {
      row.classList.add("has-unread");
      const badge = document.createElement("span"),
        count = Number(c.unreadCount),
        label = count + (count === 1 ? " unread message" : " unread messages");
      badge.className = "unread-badge";
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.setAttribute("role", "status");
      badge.setAttribute("aria-label", label);
      badge.title = label;
      row.append(badge);
    }
    root.append(row);
  });
}
async function openChat(c) {
  closeContactInfo();
  closeEmojiPicker();
  clearReply();
  clearEdit(false);
  state.chat = c.jid;
  $("#contact-name").textContent = c.name;
  const avatar = $("#contact-avatar");
  avatar.textContent = initials(c.name);
  if (c.avatarMediaId) displayAvatar(avatar, c.avatarMediaId, c.name);
  else loadAvatar(avatar, c);
  $("#contact-subtitle").textContent = c.group ? "Group" : "Chat";
  show("#chat-placeholder", false);
  show("#chat-view", true);
  $(".conversation").classList.add("open");
  renderChats();
  await loadMessages();
}
function displayAvatar(element, mediaId, name) {
  const image = document.createElement("img");
  image.src = "/api/media/" + encodeURIComponent(mediaId);
  image.alt = name + " profile photo";
  image.addEventListener(
    "error",
    () => {
      element.textContent = initials(name);
    },
    { once: true },
  );
  element.replaceChildren(image);
}
function observeAvatar(element, chat) {
  if ("IntersectionObserver" in window) {
    if (!state.avatarObserver) {
      state.avatarObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            state.avatarObserver.unobserve(entry.target);
            loadAvatar(entry.target, entry.target._chat);
          }
        },
        { root: $("#chat-list"), rootMargin: "120px" },
      );
    }
    element._chat = chat;
    state.avatarObserver.observe(element);
  } else loadAvatar(element, chat);
}
async function loadAvatar(element, chat) {
  if (!chat || element.dataset.avatarLoading || chat.avatarMediaId) return;
  const instanceId = state.instance,
    key = instanceId + "\n" + chat.jid;
  element.dataset.avatarLoading = "true";
  try {
    let request = state.avatarRequests.get(key);
    if (!request) {
      request = api(
        "/api/chats/" +
          encodeURIComponent(chat.jid) +
          "/avatar?instanceId=" +
          encodeURIComponent(instanceId),
      );
      state.avatarRequests.set(key, request);
    }
    const result = await request;
    if (state.instance !== instanceId) return;
    if (result.mediaId) {
      chat.avatarMediaId = result.mediaId;
      const current = state.chats.find((x) => x.jid === chat.jid);
      if (current) current.avatarMediaId = result.mediaId;
      if (element.isConnected)
        displayAvatar(element, result.mediaId, chat.name);
    }
  } catch {
  } finally {
    state.avatarRequests.delete(key);
    delete element.dataset.avatarLoading;
  }
}
async function loadParticipantAvatar(element, message) {
  const jid = message.senderJid,
    alt = message.senderAlt || "",
    instanceId = state.instance,
    key = instanceId + "\n" + jid;
  if (!jid || state.participantAvatars.has(key)) {
    const cached = state.participantAvatars.get(key);
    if (cached && element.isConnected)
      displayAvatar(element, cached, message.sender);
    return;
  }
  let request = state.avatarRequests.get("participant\n" + key);
  if (!request) {
    request = api(
      "/api/participants/" +
        encodeURIComponent(jid) +
        "/avatar?instanceId=" +
        encodeURIComponent(instanceId) +
        (alt ? "&alt=" + encodeURIComponent(alt) : ""),
    );
    state.avatarRequests.set("participant\n" + key, request);
  }
  try {
    const result = await request;
    state.participantAvatars.set(key, result.mediaId || "");
    if (result.mediaId && element.isConnected)
      displayAvatar(element, result.mediaId, message.sender);
  } catch {
    state.participantAvatars.set(key, "");
  } finally {
    state.avatarRequests.delete("participant\n" + key);
  }
}
function observeParticipantAvatar(element, message) {
  if ("IntersectionObserver" in window) {
    if (!state.participantObserver) {
      state.participantObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            state.participantObserver.unobserve(entry.target);
            loadParticipantAvatar(entry.target, entry.target._message);
          }
        },
        { root: $("#messages"), rootMargin: "100px" },
      );
    }
    element._message = message;
    state.participantObserver.observe(element);
  } else loadParticipantAvatar(element, message);
}
function drawerField(label, value) {
  if (!value) return null;
  const row = document.createElement("div"),
    caption = document.createElement("small"),
    content = document.createElement("strong");
  row.className = "drawer-field";
  caption.textContent = label;
  content.textContent = value;
  row.append(caption, content);
  return row;
}
async function openContactInfo(person = null) {
  const chat = state.chats.find((item) => item.jid === state.chat);
  if (!chat) return;
  const requestId = ++state.drawerRequest,
    name = person?.name || chat.name;
  $("#drawer-name").textContent = name;
  $("#drawer-avatar").textContent = initials(name);
  if (!person && chat.avatarMediaId)
    displayAvatar($("#drawer-avatar"), chat.avatarMediaId, chat.name);
  $("#drawer-subtitle").textContent = person
    ? "Contact"
    : chat.group
      ? "Group"
      : "Contact";
  $("#drawer-details").replaceChildren();
  $("#drawer-details").append(drawerField("Details", "Loading…"));
  $("#drawer-error").textContent = "";
  show("#contact-backdrop", true);
  show("#contact-drawer", true);
  try {
    const data = await api(
      person?.jid
        ? "/api/participants/" +
            encodeURIComponent(person.jid) +
            "/info?instanceId=" +
            encodeURIComponent(state.instance) +
            (person.alt ? "&alt=" + encodeURIComponent(person.alt) : "")
        : "/api/chats/" +
            encodeURIComponent(chat.jid) +
            "/info?instanceId=" +
            encodeURIComponent(state.instance),
    );
    if (requestId !== state.drawerRequest || state.chat !== chat.jid) return;
    $("#drawer-name").textContent = data.name || name;
    $("#drawer-subtitle").textContent = data.group
      ? "Group · " + (data.participantCount || 0) + " participants"
      : "Contact";
    const details = $("#drawer-details");
    details.replaceChildren();
    if (data.group) {
      const description = drawerField("Description", data.description);
      if (description) details.append(description);
      const heading = drawerField(
        "Participants",
        String(data.participantCount || 0),
      );
      if (heading) details.append(heading);
      (data.participants || []).forEach((person) => {
        const row = document.createElement("div"),
          name = document.createElement("strong"),
          phone = document.createElement("small");
        row.className = "drawer-participant";
        name.textContent = person.name || person.phone || "Contact";
        phone.textContent = person.phone
          ? person.phone + (person.admin ? " · Admin" : "")
          : person.admin
            ? "Admin"
            : "";
        row.append(name, phone);
        details.append(row);
      });
    } else {
      const phone = drawerField("Phone number", data.phone || "Not available");
      const verified = drawerField("Verified name", data.verifiedName);
      const about = drawerField("About", data.about);
      [phone, verified, about]
        .filter(Boolean)
        .forEach((item) => details.append(item));
    }
    if (!details.childElementCount)
      details.append(
        drawerField("Details", "No additional information available."),
      );
  } catch {
    if (requestId !== state.drawerRequest) return;
    $("#drawer-details").replaceChildren();
    $("#drawer-error").textContent =
      "Could not load contact details right now.";
  }
}
function closeContactInfo() {
  state.drawerRequest++;
  show("#contact-backdrop", false);
  show("#contact-drawer", false);
}
function messagePreviewText(message) {
  if (message.deleted) return "This message was deleted";
  if (message.content?.text) return message.content.text;
  const type = String(message.type || "").toLowerCase();
  if (type.includes("image") || message.mime?.startsWith("image/"))
    return "[Image]";
  if (type.includes("video") || message.mime?.startsWith("video/"))
    return "[Video]";
  if (type.includes("audio") || message.mime?.startsWith("audio/"))
    return "[Audio]";
  if (type.includes("sticker")) return "[Sticker]";
  if (type.includes("document")) return "[Document]";
  return "[Message]";
}
function closeMessageMenus() {
  document
    .querySelectorAll(".message-context-menu")
    .forEach((menu) => menu.classList.add("hidden"));
}
function closeEmojiPicker() {
  const picker = $("#emoji-picker"),
    composer = $("#composer");
  if (!picker || !composer) return;
  picker.classList.add("hidden");
  picker.classList.remove("reaction-picker");
  picker.style.removeProperty("left");
  picker.style.removeProperty("top");
  if (picker.parentElement !== composer) composer.append(picker);
  state.emojiMode = "";
  state.reactionTarget = null;
}
function clearReply() {
  state.replyTo = null;
  const composer = $("#composer");
  if (composer && !state.editingMessage)
    composer.classList.remove("reply-active");
  show("#reply-composer", false);
}
function clearEdit(restoreDraft = true) {
  const wasEditing = Boolean(state.editingMessage),
    composer = $("#composer"),
    input = $("#message-input"),
    sendButton = $("#send-message");
  state.editingMessage = null;
  if (wasEditing && input)
    input.value = restoreDraft ? state.editDraft : "";
  state.editDraft = "";
  if (composer) {
    composer.classList.remove("edit-active");
    if (!state.replyTo) composer.classList.remove("reply-active");
  }
  show("#edit-composer", false);
  if (sendButton) {
    sendButton.textContent = "➤";
    sendButton.setAttribute("aria-label", "Send");
    sendButton.title = "Send";
  }
  if (input) resizeMessageInput();
}
function resizeMessageInput() {
  const input = $("#message-input");
  if (!input) return;
  input.style.height = "auto";
  const maxHeight = Math.min(168, Math.max(72, window.innerHeight * 0.32)),
    height = Math.min(input.scrollHeight, maxHeight);
  input.style.height = height + "px";
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
}
function startReply(message) {
  if (!message || message.deleted) return;
  clearEdit(false);
  closeMessageMenus();
  closeEmojiPicker();
  state.replyTo = message;
  $("#reply-composer-sender").textContent = message.fromMe
    ? "You"
    : message.sender || "Contact";
  $("#reply-composer-text").textContent = messagePreviewText(message);
  $("#composer").classList.add("reply-active");
  show("#reply-composer", true);
  $("#message-input").focus();
}
const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;
function canEditMessage(message) {
  const sentAt = new Date(message?.time).getTime();
  return (
    Boolean(message?.fromMe) &&
    !message.deleted &&
    !message.mediaId &&
    Boolean(String(message.content?.text || "").trim()) &&
    Number.isFinite(sentAt) &&
    Date.now() - sentAt < MESSAGE_EDIT_WINDOW_MS
  );
}
function startEdit(message) {
  if (
    !canEditMessage(message)
  )
    return;
  closeMessageMenus();
  closeEmojiPicker();
  clearReply();
  const input = $("#message-input"),
    composer = $("#composer"),
    sendButton = $("#send-message");
  state.editDraft = input.value;
  state.editingMessage = message;
  input.value = message.content.text;
  $("#edit-composer-text").textContent = messagePreviewText(message);
  composer.classList.add("reply-active", "edit-active");
  show("#edit-composer", true);
  sendButton.textContent = "✓";
  sendButton.setAttribute("aria-label", "Save edited message");
  sendButton.title = "Save edited message";
  resizeMessageInput();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
function showReactionPicker(message, bubble) {
  openEmojiPicker("reaction", message.id, bubble);
}
const emojiCategories = [
  [0, "😀", "Smileys"],
  [1, "👋", "People"],
  [2, "🦰", "Components"],
  [3, "🐻", "Animals and nature"],
  [4, "🍔", "Food and drink"],
  [5, "🚗", "Travel and places"],
  [6, "⚽", "Activities"],
  [7, "💡", "Objects"],
  [8, "🔣", "Symbols"],
  [9, "🏳️", "Flags"],
];
async function loadEmojiData() {
  if (state.emojiData) return;
  const response = await fetch("/emoji-data.json", {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("The emoji catalog could not be loaded.");
  const data = await response.json();
  state.emojiData = data.flatMap((item) => [
    item,
    ...(item.skins || []).map((skin) => ({
      ...item,
      emoji: skin.emoji,
      annotation:
        item.annotation +
        " " +
        ["light", "medium-light", "medium", "medium-dark", "dark"][
          skin.tone - 1
        ] +
        " skin tone",
    })),
  ]);
}
function renderEmojiPicker() {
  const query = $("#emoji-search").value.trim().toLowerCase(),
    data = state.emojiData || [],
    matches = data
      .filter((item) => {
        if (!query && item.group !== state.emojiGroup) return false;
        if (!query) return true;
        return (
          String(item.annotation || "")
            .toLowerCase()
            .includes(query) ||
          (item.tags || []).some((tag) => tag.toLowerCase().includes(query)) ||
          (item.shortcodes || []).some((code) =>
            code.toLowerCase().includes(query),
          )
        );
      })
      .slice(0, 240),
    grid = $("#emoji-grid");
  grid.replaceChildren();
  matches.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji-choice";
    button.setAttribute("role", "option");
    button.setAttribute("aria-label", item.annotation || "Emoji");
    button.title = item.annotation || "Emoji";
    button.dataset.emoji = item.emoji;
    button.textContent = item.emoji;
    grid.append(button);
  });
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "emoji-empty muted";
    empty.textContent = "No emoji found.";
    grid.append(empty);
  }
  $("#emoji-categories")
    .querySelectorAll("button")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        Number(button.dataset.group) === state.emojiGroup,
      ),
    );
}
async function openEmojiPicker(mode, target, parent) {
  closeMessageMenus();
  closeEmojiPicker();
  const picker = $("#emoji-picker");
  state.emojiMode = mode;
  state.reactionTarget = mode === "reaction" ? target : null;
  if (mode === "reaction") {
    picker.classList.add("reaction-picker");
    document.body.append(picker);
  } else {
    picker.classList.remove("reaction-picker");
    parent.append(picker);
  }
  picker.classList.remove("hidden");
  if (mode === "reaction") {
    const rect = parent.getBoundingClientRect(),
      sidebar = $(".sidebar").getBoundingClientRect(),
      width = picker.getBoundingClientRect().width,
      height = picker.getBoundingClientRect().height,
      minLeft = Math.min(sidebar.right + 12, window.innerWidth - width - 12),
      maxLeft = Math.max(12, window.innerWidth - width - 12),
      left = Math.max(minLeft, Math.min(rect.right - width, maxLeft)),
      preferredTop = rect.top - height - 8,
      top = Math.max(
        12,
        Math.min(
          preferredTop >= 12 ? preferredTop : rect.bottom + 8,
          window.innerHeight - height - 12,
        ),
      );
    picker.style.left = left + "px";
    picker.style.top = top + "px";
  }
  try {
    await loadEmojiData();
    renderEmojiPicker();
  } catch (e) {
    closeEmojiPicker();
    toast(e.message);
  }
}
function insertEmoji(emoji) {
  const input = $("#message-input"),
    start = input.selectionStart ?? input.value.length,
    end = input.selectionEnd ?? start;
  if (input.value.length + emoji.length - (end - start) > 12000) return;
  input.setRangeText(emoji, start, end, "end");
  resizeMessageInput();
  input.focus();
}
async function sendReaction(id, reaction) {
  if (!state.chat || !state.instance) return;
  try {
    await api("/api/messages/" + encodeURIComponent(id) + "/react", {
      method: "POST",
      body: JSON.stringify({
        instanceId: state.instance,
        jid: state.chat,
        reaction,
      }),
    });
  } catch (e) {
    toast(e.message);
  }
}
async function loadMessages() {
  if (!state.chat || !state.instance) return;
  const jid = state.chat,
    instanceId = state.instance;
  try {
    const messages = await api(
      "/api/chats/" +
        encodeURIComponent(jid) +
        "/messages?instanceId=" +
        encodeURIComponent(instanceId),
    );
    if (state.chat !== jid || state.instance !== instanceId) return;
    state.messages = messages;
    renderMessages();
    if (chatIsForeground(jid, instanceId)) markChatRead(jid, instanceId);
  } catch (e) {
    toast(e.message);
  }
}
function chatIsForeground(jid = state.chat, instanceId = state.instance) {
  return (
    !!jid &&
    jid === state.chat &&
    instanceId === state.instance &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  );
}
async function markChatRead(jid, instanceId) {
  if (!chatIsForeground(jid, instanceId)) return;
  try {
    await api("/api/chats/" + encodeURIComponent(jid) + "/read", {
      method: "POST",
      body: JSON.stringify({ instanceId }),
    });
  } catch {}
}
function renderMessages() {
  closeEmojiPicker();
  closeMessageMenus();
  const box = $("#messages");
  box.replaceChildren();
  state.messages.forEach((m) => {
    const b = document.createElement("div");
    b.className =
      "bubble" + (m.fromMe ? " mine" : "") + (m.deleted ? " deleted" : "");
    b.tabIndex = 0;
    b.setAttribute("aria-haspopup", "menu");
    if (!m.fromMe && m.sender) {
      const groupChat = state.chats.find((c) => c.jid === state.chat)?.group,
        row = document.createElement("div"),
        s = document.createElement(
          m.senderJid || m.senderAlt ? "button" : "div",
        );
      row.className = "sender-row";
      s.className = "sender";
      if (s instanceof HTMLButtonElement) s.type = "button";
      s.textContent = m.sender;
      if (s instanceof HTMLButtonElement) {
        s.setAttribute(
          "aria-label",
          "Open contact information for " + m.sender,
        );
        s.addEventListener("click", () =>
          openContactInfo({
            name: m.sender,
            jid: m.senderJid || m.senderAlt,
            alt: m.senderJid ? m.senderAlt : "",
          }),
        );
      }
      if (groupChat && (m.senderJid || m.senderAlt)) {
        const avatar = document.createElement("div");
        avatar.className = "sender-avatar";
        avatar.textContent = initials(m.sender);
        row.append(avatar);
        observeParticipantAvatar(avatar, {
          ...m,
          senderJid: m.senderJid || m.senderAlt,
          senderAlt: m.senderJid ? m.senderAlt : "",
        });
      }
      row.append(s);
      b.append(row);
    }
    if (m.quoted) {
      const original = state.messages.find(
          (item) => item.messageId === m.quoted.messageId,
        ),
        quote = document.createElement("button"),
        sender = document.createElement("strong"),
        preview = document.createElement("small");
      quote.type = "button";
      quote.className = "reply-quote";
      sender.textContent = original?.fromMe
        ? "You"
        : original?.sender ||
          m.quoted.senderName ||
          m.quoted.participant ||
          "Quoted message";
      preview.textContent = original
        ? messagePreviewText(original)
        : m.quoted.text || "[Quoted message]";
      quote.append(sender, preview);
      if (original)
        quote.addEventListener("click", () => {
          const index = state.messages.findIndex(
            (item) => item.messageId === m.quoted.messageId,
          );
          box.children[index]?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        });
      b.append(quote);
    }
    if (m.deleted) {
      const t = document.createElement("span");
      t.textContent = "This message was deleted";
      b.append(t);
    } else {
      if (m.mediaId) {
        const url = "/api/media/" + encodeURIComponent(m.mediaId);
        const rawVideo = m.content?.raw?.videoMessage || {},
          isGifPlayback = [
            rawVideo.gifPlayback,
            rawVideo.GIFPlayback,
            rawVideo.gif_playback,
          ].some(
            (value) =>
              value === true ||
              value === 1 ||
              String(value || "").toLowerCase() === "true",
          );
        if (
          String(m.mime || "")
            .toLowerCase()
            .startsWith("audio/") ||
          String(m.type).toLowerCase().includes("audio")
        ) {
          const a = document.createElement("audio");
          a.controls = true;
          a.preload = "metadata";
          a.src = url;
          b.append(a);
          const download = document.createElement("a");
          download.href =
            "/api/media/" + encodeURIComponent(m.mediaId) + "/download";
          download.className = "audio-download";
          download.textContent = "Download audio";
          download.download = "";
          b.append(download);
        } else if (
          String(m.type).toLowerCase().includes("image") ||
          String(m.mime || "")
            .toLowerCase()
            .startsWith("image/")
        ) {
          const im = document.createElement("img");
          im.src = url;
          im.alt = "Image from " + (m.fromMe ? "you" : m.sender || "contact");
          const preview = document.createElement("button");
          preview.type = "button";
          preview.className = "message-image-trigger";
          preview.setAttribute("aria-label", "View " + im.alt.toLowerCase());
          preview.addEventListener("click", () =>
            openImageViewer(m.mediaId, im.alt, preview),
          );
          preview.append(im);
          b.append(preview);
        } else if (
          String(m.type).toLowerCase().includes("video") ||
          String(m.mime || "").toLowerCase().startsWith("video/") ||
          isGifPlayback
        ) {
          const v = document.createElement("video");
          v.controls = !isGifPlayback;
          v.autoplay = isGifPlayback;
          v.loop = isGifPlayback;
          v.muted = isGifPlayback;
          v.playsInline = true;
          v.preload = isGifPlayback ? "auto" : "metadata";
          v.src = url;
          b.append(v);
        } else {
          const a = document.createElement("a");
          a.href = "/api/media/" + encodeURIComponent(m.mediaId) + "/download";
          a.textContent = "Download " + (m.content.text || "file");
          a.download = "";
          b.append(a);
        }
      }
      if (m.content && m.content.text) {
        const t = document.createElement("div");
        t.textContent = m.content.text;
        b.append(t);
      }
    }
    const tm = document.createElement("small");
    tm.textContent =
      new Date(m.time).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      }) + (m.edited ? " · edited" : "");
    b.append(tm);
    if (m.reactions?.length) {
      const reactions = document.createElement("div");
      reactions.className = "reaction-list";
      m.reactions.forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "reaction-chip" + (item.mine ? " mine" : "");
        button.textContent = item.emoji + " " + item.count;
        button.title = item.mine
          ? "Remove your reaction"
          : "React with " + item.emoji;
        button.setAttribute("aria-label", button.title);
        button.addEventListener("click", () =>
          sendReaction(m.id, item.mine ? "remove" : item.emoji),
        );
        reactions.append(button);
      });
      b.append(reactions);
    }
    if (m.versions && m.versions.length) {
      const tools = document.createElement("div");
      tools.className = "message-tools";
      const v = document.createElement("button");
      v.type = "button";
      v.textContent = "View previous versions (" + m.versions.length + ")";
      v.title = m.versions
        .map(
          (x) =>
            new Date(x.time).toLocaleString("en-US") +
            ": " +
            (x.deleted ? "deleted" : x.content.text || "[media]"),
        )
        .join("\n");
      v.addEventListener("click", () => alert(v.title));
      tools.append(v);
      b.append(tools);
    }
    const f = document.createElement("div");
    f.className = "message-tools";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Forward";
    btn.addEventListener("click", () => openForward(m.id));
    f.append(btn);
    b.append(f);
    if (!m.deleted) {
      const menu = document.createElement("div"),
        quick = document.createElement("div");
      menu.className = "message-context-menu hidden";
      menu.setAttribute("role", "menu");
      quick.className = "quick-reactions";
      ["👍", "❤️", "😂", "😮", "😢", "🙏"].forEach((emoji) => {
        const reaction = document.createElement("button");
        reaction.type = "button";
        reaction.textContent = emoji;
        reaction.title = "React with " + emoji;
        reaction.setAttribute("aria-label", reaction.title);
        reaction.addEventListener("click", () => {
          closeMessageMenus();
          sendReaction(m.id, emoji);
        });
        quick.append(reaction);
      });
      const reply = document.createElement("button"),
        react = document.createElement("button");
      reply.type = react.type = "button";
      reply.setAttribute("role", "menuitem");
      react.setAttribute("role", "menuitem");
      reply.textContent = "Reply";
      react.textContent = "More reactions…";
      reply.addEventListener("click", () => startReply(m));
      react.addEventListener("click", () => showReactionPicker(m, b));
      menu.append(quick, reply, react);
      if (m.fromMe) {
        if (canEditMessage(m)) {
          const edit = document.createElement("button");
          edit.type = "button";
          edit.setAttribute("role", "menuitem");
          edit.textContent = "Edit";
          edit.addEventListener("click", () => startEdit(m));
          menu.append(edit);
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.setAttribute("role", "menuitem");
        remove.textContent = "Delete for everyone";
        remove.addEventListener("click", () => {
          closeMessageMenus();
          deleteForEveryone(m);
        });
        menu.append(remove);
      }
      b.append(menu);
      b.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        closeEmojiPicker();
        closeMessageMenus();
        menu.classList.remove("hidden");
      });
      b.addEventListener("keydown", (event) => {
        if (
          event.key === "ContextMenu" ||
          (event.key === "F10" && event.shiftKey)
        ) {
          event.preventDefault();
          closeMessageMenus();
          menu.classList.remove("hidden");
          menu.querySelector('[role="menuitem"]')?.focus();
        }
      });
    }
    box.append(b);
  });
  box.scrollTop = box.scrollHeight;
}
async function sendText(e) {
  e.preventDefault();
  if (state.sendingText) return;
  if (state.editingMessage) return saveEditedMessage();
  const input = $("#message-input"),
    draft = input.value,
    text = draft.trim(),
    instanceId = state.instance,
    chatJid = state.chat,
    replyTo = state.replyTo;
  if (!text || !chatJid || !instanceId) return;
  state.sendingText = true;
  const composer = $("#composer"),
    sendButton = $("#send-message");
  composer.setAttribute("aria-busy", "true");
  sendButton.disabled = true;
  sendButton.setAttribute("aria-label", "Sending message");
  try {
    await api("/api/send/text", {
      method: "POST",
      body: JSON.stringify({
        instanceId,
        jid: chatJid,
        text,
        ...(replyTo ? { replyTo: replyTo.id } : {}),
      }),
    });
    if (input.value === draft) {
      input.value = "";
      resizeMessageInput();
    }
    if (replyTo && state.replyTo?.id === replyTo.id) clearReply();
    toast("Message sent");
  } catch (e) {
    toast(e.message);
  } finally {
    state.sendingText = false;
    composer.removeAttribute("aria-busy");
    sendButton.disabled = false;
    sendButton.setAttribute("aria-label", "Send");
  }
}
async function saveEditedMessage() {
  const message = state.editingMessage,
    input = $("#message-input"),
    text = input.value.trim(),
    composer = $("#composer"),
    sendButton = $("#send-message"),
    instanceId = state.instance,
    chatJid = state.chat;
  if (!message || !text) {
    if (!text) toast("Message text cannot be empty.");
    return;
  }
  state.sendingText = true;
  composer.setAttribute("aria-busy", "true");
  sendButton.disabled = true;
  sendButton.setAttribute("aria-label", "Saving edited message");
  try {
    await api("/api/messages/" + encodeURIComponent(message.id) + "/edit", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (state.editingMessage?.id === message.id) {
      clearEdit(false);
      input.value = "";
      resizeMessageInput();
    }
    if (state.instance === instanceId && state.chat === chatJid)
      await loadMessages();
    toast("Message edited");
  } catch (e) {
    toast(e.message);
  } finally {
    state.sendingText = false;
    composer.removeAttribute("aria-busy");
    sendButton.disabled = false;
  }
}
async function deleteForEveryone(message) {
  if (!message?.fromMe || message.deleted) return;
  if (
    !window.confirm("Delete this message for everyone? This cannot be undone.")
  )
    return;
  try {
    await api("/api/messages/" + encodeURIComponent(message.id) + "/delete", {
      method: "POST",
    });
    if (state.editingMessage?.id === message.id) clearEdit(false);
    await loadMessages();
    toast("Message deleted for everyone");
  } catch (e) {
    toast(e.message);
  }
}
async function sendFile(e) {
  const file = e.target.files[0];
  if (!file || !state.chat) return;
  if (file.type.startsWith("image/")) {
    queueImagePreview(file);
    e.target.value = "";
    return;
  }
  if (await sendMediaFile(file)) toast("File sent");
  e.target.value = "";
}
async function sendMediaFile(file, options = {}) {
  const f = new FormData();
  const instanceId = options.instanceId || state.instance,
    jid = options.jid || state.chat,
    replyTo = options.replyTo === undefined ? state.replyTo?.id : options.replyTo;
  f.append("instanceId", instanceId);
  f.append("jid", jid);
  f.append("file", file);
  if (options.caption) f.append("caption", options.caption);
  if (replyTo) f.append("replyTo", replyTo);
  try {
    await api("/api/send/media", { method: "POST", body: f });
    if (state.instance === instanceId && state.chat === jid) clearReply();
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}
function queueImagePreview(file) {
  if (!state.chat || !state.instance || !file?.type?.startsWith("image/")) return;
  if (state.sendingImage) {
    toast("Wait for the current image to finish sending.");
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    toast("Images must be 20 MB or smaller.");
    return;
  }
  closeImagePreview();
  const url = URL.createObjectURL(file);
  state.pendingImage = {
    file,
    url,
    instanceId: state.instance,
    jid: state.chat,
    replyTo: state.replyTo?.id || "",
  };
  $("#image-send-preview").src = url;
  $("#image-send-preview").alt = file.name || "Image to send";
  $("#image-caption").value = "";
  $("#image-send-error").textContent = "";
  show("#image-send-modal", true);
  $("#image-caption").focus();
}
function closeImagePreview() {
  if (state.pendingImage?.url) URL.revokeObjectURL(state.pendingImage.url);
  state.pendingImage = null;
  state.sendingImage = false;
  $("#image-send-preview")?.removeAttribute("src");
  $("#image-caption").value = "";
  $("#image-send-error").textContent = "";
  $("#image-send-confirm").disabled = false;
  $("#image-send-confirm").textContent = "Send";
  $("#image-send-cancel").disabled = false;
  $("#image-send-close").disabled = false;
  $("#image-caption").disabled = false;
  $("#image-send-modal").removeAttribute("aria-busy");
  show("#image-send-modal", false);
}
async function sendPendingImage() {
  const pending = state.pendingImage;
  if (!pending || state.sendingImage) return;
  state.sendingImage = true;
  const button = $("#image-send-confirm");
  button.disabled = true;
  button.textContent = "Sending…";
  $("#image-send-cancel").disabled = true;
  $("#image-send-close").disabled = true;
  $("#image-caption").disabled = true;
  $("#image-send-modal").setAttribute("aria-busy", "true");
  $("#image-send-error").textContent = "";
  const result = await sendMediaFile(pending.file, {
    instanceId: pending.instanceId,
    jid: pending.jid,
    replyTo: pending.replyTo,
    caption: $("#image-caption").value,
  });
  if (result) {
    if (state.pendingImage === pending) closeImagePreview();
    toast("Image sent");
  } else {
    state.sendingImage = false;
    button.disabled = false;
    button.textContent = "Send";
    $("#image-send-cancel").disabled = false;
    $("#image-send-close").disabled = false;
    $("#image-caption").disabled = false;
    $("#image-send-modal").removeAttribute("aria-busy");
    $("#image-send-error").textContent =
      "The image could not be sent. Check the connection and try again.";
  }
}
function imageFromClipboard(event) {
  if (!state.chat || !event.clipboardData) return;
  const items = Array.from(event.clipboardData.items || []),
    image = items.find(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
  if (!image) return;
  const file = image.getAsFile();
  if (!file) return;
  event.preventDefault();
  queueImagePreview(file);
}
function imageFromDrop(event) {
  $(".conversation").classList.remove("drag-over");
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  event.preventDefault();
  if (!state.chat) {
    toast("Open a chat before dropping an image.");
    return;
  }
  const file = files.find((item) => item.type.startsWith("image/"));
  if (!file) {
    toast("Only images can be dropped into the chat.");
    return;
  }
  queueImagePreview(file);
}
function showQr(data) {
  if (!data) return;
  $("#qr-image").src = data.startsWith("data:")
    ? data
    : "data:image/png;base64," + data;
  $("#qr-state").textContent = "Scan this QR code with WhatsApp";
  show("#qr-modal", true);
}
function startQrRefresh(id) {
  stopQrRefresh();
  const poll = (state.qrPoll = `${id}:${Date.now()}`);
  (async () => {
    while (
      state.qrPoll === poll &&
      state.instance === id &&
      !$("#qr-modal").classList.contains("hidden") &&
      state.connectionStatus !== "connected"
    ) {
      try {
        const result = await api(
          "/api/instances/" + encodeURIComponent(id) + "/qr",
        );
        if (result.status === "connected") {
          setState("connected");
          return;
        }
        if (result.qr) showQr(result.qr);
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 12000));
    }
  })();
}
async function newInstance(e) {
  e.preventDefault();
  const name = new FormData(e.currentTarget).get("name");
  $("#instance-error").textContent = "";
  try {
    const x = await api("/api/instances", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    show("#instance-modal", false);
    await refreshInstances();
    $("#instance-select").value = x.id;
    state.instance = x.id;
    setState(x.status || "connecting");
    if (x.status === "connecting") {
      show("#qr-modal", true);
      $("#qr-state").textContent = "Waiting for QR code…";
      startQrRefresh(x.id);
    }
    if (x.connectionError)
      toast("Instance created, but could not connect: " + x.connectionError);
  } catch (err) {
    $("#instance-error").textContent = err.message;
  }
}
async function startNewChat(e) {
  e.preventDefault();
  const form = e.currentTarget,
    phone = String(new FormData(form).get("phone") || "").replace(/\D/g, "");
  $("#new-chat-error").textContent = "";
  try {
    const result = await api("/api/chats/start", {
      method: "POST",
      body: JSON.stringify({ instanceId: state.instance, phone }),
    });
    show("#new-chat-modal", false);
    form.reset();
    await refreshInstances();
    const chat = state.chats.find((item) => item.jid === result.jid) || {
      jid: result.jid,
      name: result.name,
      group: false,
      preview: "",
      time: null,
    };
    await openChat(chat);
  } catch (error) {
    $("#new-chat-error").textContent = error.message;
  }
}
function formatPhoneNumber(value) {
  const digits = String(value).replace(/\D/g, "").slice(0, 15);
  if (!digits) return "";
  if (!digits.startsWith("55")) return digits.replace(/(\d{3})(?=\d)/g, "$1 ");

  const area = digits.slice(2, 4),
    local = digits.slice(4),
    subscriber =
      local.length > 8
        ? local.slice(0, 5) + (local.length > 5 ? "-" + local.slice(5) : "")
        : local.slice(0, 4) + (local.length > 4 ? "-" + local.slice(4) : "");
  return (
    "55" +
    (area ? " (" + area + (area.length === 2 ? ")" : "") : "") +
    (subscriber ? " " + subscriber : "")
  );
}
function maskPhoneInput(input) {
  const digitsBeforeCaret = input.value
    .slice(0, input.selectionStart || 0)
    .replace(/\D/g, "").length;
  input.value = formatPhoneNumber(input.value);
  let caret = 0,
    digits = 0;
  while (caret < input.value.length && digits < digitsBeforeCaret) {
    if (/\d/.test(input.value[caret])) digits++;
    caret++;
  }
  while (caret < input.value.length && !/\d/.test(input.value[caret])) caret++;
  input.setSelectionRange(caret, caret);
}
async function reconnect() {
  try {
    await api(
      "/api/instances/" + encodeURIComponent(state.instance) + "/connect",
      { method: "POST", body: "{}" },
    );
    setState("connecting");
    show("#qr-modal", true);
    $("#qr-state").textContent = "Waiting for QR code…";
    startQrRefresh(state.instance);
    toast("Connection request sent");
  } catch (e) {
    toast(e.message);
  }
}
function openForward(id) {
  state.forwardId = id;
  const sel = $("#forward-form select");
  sel.replaceChildren();
  state.chats
    .filter((c) => c.jid !== state.chat)
    .forEach((c) => {
      const o = document.createElement("option");
      o.value = c.jid;
      o.textContent = c.name;
      sel.append(o);
    });
  if (!sel.options.length)
    return toast("There is no other chat to forward this message to.");
  show("#forward-modal", true);
}
async function forward(e) {
  e.preventDefault();
  try {
    await api("/api/forward/" + state.forwardId, {
      method: "POST",
      body: JSON.stringify({ to: new FormData(e.currentTarget).get("to") }),
    });
    show("#forward-modal", false);
    toast("Message forwarded");
  } catch (e) {
    $("#forward-error").textContent = e.message;
  }
}
document.addEventListener("DOMContentLoaded", async () => {
  $("#theme-toggle").addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;
    applyTheme(current === "dark" ? "light" : "dark", true);
  });
  const imageViewer = $("#image-viewer");
  $("#image-viewer-close").addEventListener("click", closeImageViewer);
  imageViewer.addEventListener("click", (event) => {
    if (event.target === imageViewer) closeImageViewer();
  });
  imageViewer.addEventListener("close", () => {
    $("#image-viewer-image").removeAttribute("src");
    $("#image-viewer-image").alt = "";
    $("#image-download").removeAttribute("href");
    const trigger = state.imageViewerTrigger;
    state.imageViewerTrigger = null;
    if (trigger?.isConnected) trigger.focus();
  });
  const token = location.hash.startsWith("#setup=")
    ? location.hash.slice(7)
    : new URLSearchParams(location.search).get("token") || "";
  if (token) {
    history.replaceState(null, "", location.pathname);
    show("#setup", true);
    show("#login", false);
    show("#app", false);
    $("#token-form [name=token]").value = token;
    $("#token-form").addEventListener("submit", startSetup);
    $("#token-form").requestSubmit();
    return;
  }
  $("#login-form").addEventListener("submit", login);
  $("#token-form").addEventListener("submit", startSetup);
  $("#complete-form").addEventListener("submit", finishSetup);
  $("#instance-form").addEventListener("submit", newInstance);
  $("#composer").addEventListener("submit", sendText);
  $("#message-input").addEventListener("input", resizeMessageInput);
  window.addEventListener("resize", resizeMessageInput);
  $("#message-input").addEventListener("keydown", (event) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.isComposing ||
      event.keyCode === 229
    )
      return;
    event.preventDefault();
    $("#composer").requestSubmit();
  });
  $("#file-input").addEventListener("change", sendFile);
  $("#image-send-confirm").addEventListener("click", sendPendingImage);
  $("#image-send-cancel").addEventListener("click", closeImagePreview);
  $("#image-send-close").addEventListener("click", closeImagePreview);
  const conversation = $(".conversation");
  conversation.addEventListener("paste", imageFromClipboard);
  conversation.addEventListener("dragenter", (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
    event.preventDefault();
    if (state.chat) conversation.classList.add("drag-over");
  });
  conversation.addEventListener("dragover", (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (state.chat) conversation.classList.add("drag-over");
  });
  conversation.addEventListener("dragleave", (event) => {
    if (!conversation.contains(event.relatedTarget))
      conversation.classList.remove("drag-over");
  });
  conversation.addEventListener("drop", imageFromDrop);
  $("#search").addEventListener("input", renderChats);
  $("#instance-select").addEventListener("change", async (e) => {
    clearReply();
    clearEdit(false);
    state.instance = e.target.value;
    state.chat = "";
    state.chats = [];
    updateUnreadTitle();
    await refreshInstances();
  });
  $("#new-instance").addEventListener("click", () =>
    show("#instance-modal", true),
  );
  $("#new-chat").addEventListener("click", () => {
    $("#new-chat-error").textContent = "";
    show("#new-chat-modal", true);
    $("#new-chat-form [name=phone]").focus();
  });
  $("#new-chat-form").addEventListener("submit", startNewChat);
  const phoneInput = $("#new-chat-form [name=phone]");
  phoneInput.addEventListener("beforeinput", (e) => {
    if (
      e.inputType.startsWith("insert") &&
      !e.inputType.includes("Paste") &&
      e.data &&
      /\D/.test(e.data)
    )
      e.preventDefault();
  });
  phoneInput.addEventListener("input", () => maskPhoneInput(phoneInput));
  $("#reply-cancel").addEventListener("click", clearReply);
  $("#edit-cancel").addEventListener("click", () => clearEdit(true));
  emojiCategories.forEach(([group, icon, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.group = group;
    button.textContent = icon;
    button.title = label;
    button.setAttribute("aria-label", label);
    $("#emoji-categories").append(button);
  });
  $("#emoji-search").addEventListener("input", renderEmojiPicker);
  $("#emoji-categories").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-group]");
    if (!button) return;
    state.emojiGroup = Number(button.dataset.group);
    $("#emoji-search").value = "";
    renderEmojiPicker();
  });
  $("#emoji-grid").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-emoji]");
    if (!button) return;
    const emoji = button.dataset.emoji,
      mode = state.emojiMode,
      target = state.reactionTarget;
    closeEmojiPicker();
    if (mode === "reaction" && target) sendReaction(target, emoji);
    else if (mode === "message") insertEmoji(emoji);
  });
  $("#emoji-button").addEventListener("click", () => {
    const picker = $("#emoji-picker");
    if (!picker.classList.contains("hidden") && state.emojiMode === "message") {
      closeEmojiPicker();
      return;
    }
    openEmojiPicker("message", null, $("#composer"));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".message-context-menu")) closeMessageMenus();
    if (
      !event.target.closest(".emoji-picker") &&
      !event.target.closest("#emoji-button") &&
      !event.target.closest(".message-context-menu")
    )
      closeEmojiPicker();
  });
  $("#contact-info-btn").addEventListener("click", () => openContactInfo());
  $("#contact-drawer-close").addEventListener("click", closeContactInfo);
  $("#contact-backdrop").addEventListener("click", closeContactInfo);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("#image-viewer").open) closeImageViewer();
    else if (!$("#image-send-modal").classList.contains("hidden")) {
      if (!state.sendingImage) closeImagePreview();
      return;
    }
    else if (!$("#emoji-picker").classList.contains("hidden"))
      closeEmojiPicker();
    else if (document.querySelector(".message-context-menu:not(.hidden)"))
      closeMessageMenus();
    else if (!$("#contact-drawer").classList.contains("hidden"))
      closeContactInfo();
    else if (state.replyTo) clearReply();
  });
  $("#refresh").addEventListener("click", loadChats);
  const refreshReadChat = () => {
    if (state.chat && chatIsForeground()) loadMessages();
  };
  window.addEventListener("focus", refreshReadChat);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshReadChat();
  });
  $("#connect-btn").addEventListener("click", reconnect);
  $("#forward-form").addEventListener("submit", forward);
  $("#logout").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
    } catch {}
    logoutLocal();
  });
  document.querySelectorAll("[data-close]").forEach((x) =>
    x.addEventListener("click", () => {
      show("#" + x.dataset.close, false);
      if (x.dataset.close === "qr-modal") stopQrRefresh();
    }),
  );
  try {
    const me = await fetch("/api/me");
    if (me.ok) {
      const d = await me.json();
      state.user = d.username;
      state.csrf = d.csrf;
      await enterPanel();
    } else loginScreen();
  } catch {
    loginScreen();
  }
});
