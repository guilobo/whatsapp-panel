"use strict";
const crypto = require("node:crypto"),
  fs = require("node:fs"),
  fsp = require("node:fs/promises"),
  path = require("node:path");
const express = require("express"),
  helmet = require("helmet"),
  multer = require("multer"),
  QRCode = require("qrcode"),
  { Pool } = require("pg"),
  { rateLimit } = require("express-rate-limit"),
  { promisify } = require("node:util");
const {
  formatIncomingMessage,
  mediaLabel,
  shouldQueueTelegramMessage,
  splitTelegramText,
  telegramMediaMethod,
} = require("./telegram");
function env() {
  try {
    for (const l of fs
      .readFileSync(process.env.ENV_FILE || "/run/secrets/panel.env", "utf8")
      .split(/\r?\n/)) {
      const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}
env();
const C = {
  port: +(process.env.PORT || 3000),
  db: process.env.DATABASE_URL,
  evo: (process.env.EVOLUTION_URL || "http://evolution-go:8080").replace(
    /\/$/,
    "",
  ),
  key: process.env.EVOLUTION_API_KEY,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  enc: Buffer.from(process.env.APP_ENCRYPTION_KEY || "", "hex"),
  media: process.env.MEDIA_DIR || "/app/data/media",
};
if (!C.db || !C.key || C.enc.length !== 32) {
  console.error("Missing database/API/encryption configuration");
  process.exit(1);
}
const pool = new Pool({ connectionString: C.db, max: 10 }),
  app = express(),
  server = require("node:http").createServer(app),
  clients = new Set(),
  pending = new Map(),
  uploads = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  }),
  scrypt = promisify(crypto.scrypt);
const rand = (n = 32) => crypto.randomBytes(n).toString("base64url"),
  hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
function seal(b) {
  const iv = crypto.randomBytes(12),
    c = crypto.createCipheriv("aes-256-gcm", C.enc, iv),
    out = Buffer.concat([
      c.update(Buffer.isBuffer(b) ? b : Buffer.from(b)),
      c.final(),
    ]);
  return Buffer.concat([iv, c.getAuthTag(), out]).toString("base64");
}
function open(v) {
  const b = Buffer.from(v, "base64"),
    d = crypto.createDecipheriv("aes-256-gcm", C.enc, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}
function equal(a, b) {
  a = Buffer.from(String(a));
  b = Buffer.from(String(b));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const telegramEnabled =
  /^\d+:[A-Za-z0-9_-]{30,}$/.test(C.telegramToken) &&
  /^-?\d+$/.test(C.telegramChatId);
async function pwHash(s) {
  const salt = crypto.randomBytes(16),
    k = await scrypt(s, salt, 64, {
      N: 131072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
  return (
    "scrypt$" +
    salt.toString("base64") +
    "$" +
    Buffer.from(k).toString("base64")
  );
}
async function pwCheck(s, v) {
  const p = v.split("$"),
    k = await scrypt(s, Buffer.from(p[1], "base64"), 64, {
      N: 131072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
  return equal(Buffer.from(k).toString("base64"), p[2]);
}
async function migrate() {
  await fsp.mkdir(C.media, { recursive: true, mode: 0o700 });
  await pool.query(
    "CREATE TABLE IF NOT EXISTS admins(id bigserial primary key,username text unique not null,password_hash text not null); CREATE TABLE IF NOT EXISTS setup_tokens(token_hash text primary key,expires_at timestamptz not null,used_at timestamptz); CREATE TABLE IF NOT EXISTS sessions(token_hash text primary key,admin_id bigint references admins(id) on delete cascade,csrf text not null,created_at timestamptz default now(),last_seen timestamptz default now(),expires_at timestamptz not null); CREATE TABLE IF NOT EXISTS instances(id text primary key,name text not null,webhook_hash text not null,api_token_enc text,status text default 'unknown',qr_enc text,qr_expires timestamptz,last_event timestamptz,last_connected timestamptz,created_at timestamptz default now()); ALTER TABLE instances ADD COLUMN IF NOT EXISTS api_token_enc text; CREATE TABLE IF NOT EXISTS chats(instance_id text references instances(id) on delete cascade,jid text,name text default '',is_group boolean default false,last_at timestamptz,primary key(instance_id,jid)); ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_media_id text; ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_checked_at timestamptz; CREATE TABLE IF NOT EXISTS media(id text primary key,file_name text unique not null,mime text not null,original text not null,size bigint not null); CREATE TABLE IF NOT EXISTS messages(id bigserial primary key,instance_id text references instances(id) on delete cascade,chat_jid text,message_id text,sender text default '',sender_name text default '',from_me boolean default false,msg_type text default 'text',content_enc text not null,media_id text references media(id),deleted boolean default false,edited boolean default false,status text default 'received',ts timestamptz default now(),unique(instance_id,chat_jid,message_id)); ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_jid text; ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_alt text; CREATE TABLE IF NOT EXISTS message_reactions(instance_id text references instances(id) on delete cascade,chat_jid text not null,target_message_id text not null,reactor text not null,reactor_name text default '',emoji text not null,updated_at timestamptz default now(),primary key(instance_id,chat_jid,target_message_id,reactor)); CREATE INDEX IF NOT EXISTS message_reactions_target ON message_reactions(instance_id,chat_jid,target_message_id); CREATE TABLE IF NOT EXISTS message_replies(instance_id text references instances(id) on delete cascade,chat_jid text not null,message_id text not null,target_message_id text not null,reply_preview jsonb not null,created_at timestamptz default now(),primary key(instance_id,chat_jid,message_id)); CREATE INDEX IF NOT EXISTS msg_chat_ts ON messages(instance_id,chat_jid,ts desc); CREATE TABLE IF NOT EXISTS chat_aliases(instance_id text references instances(id) on delete cascade,alias_jid text not null,canonical_jid text not null,primary key(instance_id,alias_jid)); CREATE INDEX IF NOT EXISTS chat_alias_canonical ON chat_aliases(instance_id,canonical_jid); CREATE TABLE IF NOT EXISTS contact_avatars(instance_id text references instances(id) on delete cascade,jid text not null,media_id text,checked_at timestamptz,primary key(instance_id,jid)); CREATE TABLE IF NOT EXISTS versions(id bigserial primary key,message_row bigint references messages(id) on delete cascade,content_enc text not null,media_id text,deleted boolean default false,at timestamptz default now()); CREATE TABLE IF NOT EXISTS events(event_hash text primary key,instance_id text,event_name text,body_enc text,at timestamptz default now()); CREATE TABLE IF NOT EXISTS transfer_tokens(token_hash text primary key,media_id text references media(id) on delete cascade,expires_at timestamptz not null); ALTER TABLE admins DROP COLUMN IF EXISTS totp_enc",
  );
  await pool.query(
    "ALTER TABLE chats ADD COLUMN IF NOT EXISTS read_through_id bigint; UPDATE chats c SET read_through_id=coalesce((SELECT max(m.id) FROM messages m WHERE m.instance_id=c.instance_id AND m.chat_jid=c.jid),0) WHERE c.read_through_id IS NULL; ALTER TABLE chats ALTER COLUMN read_through_id SET DEFAULT 0; ALTER TABLE chats ALTER COLUMN read_through_id SET NOT NULL; CREATE INDEX IF NOT EXISTS msg_chat_unread ON messages(instance_id,chat_jid,id) WHERE from_me=false",
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS telegram_outbox(id bigserial primary key,instance_id text not null,chat_jid text not null,message_id text not null,status text not null default 'pending',attempts integer not null default 0,available_at timestamptz not null default now(),locked_at timestamptz,text_parts_sent integer not null default 0,media_sent boolean not null default false,last_error text,created_at timestamptz not null default now(),unique(instance_id,chat_jid,message_id)); CREATE INDEX IF NOT EXISTS telegram_outbox_pending ON telegram_outbox(status,available_at,created_at)",
  );
  await reconcileExistingChatAliases();
}
function emit(type, data) {
  const s = "event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n";
  for (const c of clients) {
    try {
      c.write(s);
    } catch {
      clients.delete(c);
    }
  }
}
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
  }),
);
app.use(
  express.json({
    limit: "32mb",
    verify: (q, r, b) => (q.raw = Buffer.from(b)),
  }),
);
app.use((q, r, n) => {
  r.set("Cache-Control", "no-store");
  n();
});
function cookie(q) {
  const c = (q.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("__Host-panel="));
  return c ? decodeURIComponent(c.slice(13)) : "";
}
async function auth(q, r, n) {
  try {
    const token = cookie(q);
    if (!token) return r.status(401).json({ error: "login_required" });
    const x = await pool.query(
        "select s.*,a.username,a.id as aid from sessions s join admins a on a.id=s.admin_id where token_hash=$1",
        [hash(token)],
      ),
      u = x.rows[0];
    if (
      !u ||
      new Date(u.expires_at) < new Date() ||
      new Date(u.last_seen) < new Date(Date.now() - 1800000)
    ) {
      if (u)
        await pool.query("delete from sessions where token_hash=$1", [
          u.token_hash,
        ]);
      return r.status(401).json({ error: "session_expired" });
    }
    q.user = u;
    q.csrf = u.csrf;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(q.method) &&
      !equal(q.headers["x-csrf-token"] || "", u.csrf)
    )
      return r.status(403).json({ error: "csrf_failed" });
    if (Date.now() - new Date(u.last_seen) > 60000)
      pool
        .query("update sessions set last_seen=now() where token_hash=$1", [
          u.token_hash,
        ])
        .catch(() => {});
    n();
  } catch (e) {
    n(e);
  }
}
const loginLimit = rateLimit({
    windowMs: 900000,
    limit: 8,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  setupLimit = rateLimit({
    windowMs: 900000,
    limit: 4,
    standardHeaders: true,
    legacyHeaders: false,
  });
app.get("/healthz", async (q, r) => {
  try {
    await pool.query("select 1");
    r.json({ ok: true });
  } catch {
    r.status(503).json({ ok: false });
  }
});
app.post("/api/setup/start", setupLimit, async (q, r) => {
  if ((await pool.query("select 1 from admins limit 1")).rowCount)
    return r.sendStatus(409);
  const th = hash(String(q.body.token || ""));
  if (
    !(
      await pool.query(
        "select 1 from setup_tokens where token_hash=$1 and used_at is null and expires_at>now()",
        [th],
      )
    ).rowCount
  )
    return r.sendStatus(401);
  const challenge = rand(24);
  pending.set(hash(challenge), { th, exp: Date.now() + 300000 });
  r.json({ challenge });
});
app.post("/api/setup/complete", setupLimit, async (q, r, n) => {
  const state = pending.get(hash(String(q.body.challenge || "")));
  if (!state || state.exp < Date.now()) return r.sendStatus(401);
  const name = String(q.body.username || ""),
    pass = String(q.body.password || "");
  if (
    !/^[A-Za-z0-9_.-]{3,32}$/.test(name) ||
    pass.length < 14 ||
    pass.length > 200
  )
    return r.status(400).json({ error: "invalid_setup_values" });
  const c = await pool.connect();
  try {
    await c.query("begin");
    if ((await c.query("select 1 from admins limit 1")).rowCount) {
      await c.query("rollback");
      return r.sendStatus(409);
    }
    const u = await c.query(
      "update setup_tokens set used_at=now() where token_hash=$1 and used_at is null and expires_at>now() returning token_hash",
      [state.th],
    );
    if (!u.rowCount) {
      await c.query("rollback");
      return r.sendStatus(401);
    }
    const a = await c.query(
        "insert into admins(username,password_hash) values($1,$2) returning id,username",
        [name, await pwHash(pass)],
      ),
      sess = rand(),
      csrf = rand(24);
    await c.query(
      "insert into sessions(token_hash,admin_id,csrf,expires_at) values($1,$2,$3,now()+interval '12 hours')",
      [hash(sess), a.rows[0].id, csrf],
    );
    await c.query("commit");
    pending.delete(hash(q.body.challenge));
    r.cookie("__Host-panel", sess, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 43200000,
    });
    r.json({ username: a.rows[0].username, csrf });
  } catch (e) {
    await c.query("rollback").catch(() => {});
    n(e);
  } finally {
    c.release();
  }
});
app.post("/api/login", loginLimit, async (q, r, n) => {
  try {
    const u = (
      await pool.query("select * from admins where username=$1", [
        String(q.body.username || "").slice(0, 40),
      ])
    ).rows[0];
    if (!u || !(await pwCheck(String(q.body.password || ""), u.password_hash)))
      return r.status(401).json({ error: "invalid_credentials" });
    const sess = rand(),
      csrf = rand(24);
    await pool.query(
      "insert into sessions(token_hash,admin_id,csrf,expires_at) values($1,$2,$3,now()+interval '12 hours')",
      [hash(sess), u.id, csrf],
    );
    r.cookie("__Host-panel", sess, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 43200000,
    });
    r.json({ username: u.username, csrf });
  } catch (e) {
    n(e);
  }
});
app.get("/api/me", auth, (q, r) =>
  r.json({ username: q.user.username, csrf: q.csrf }),
);
app.post("/api/logout", auth, async (q, r) => {
  await pool.query("delete from sessions where token_hash=$1", [
    hash(cookie(q)),
  ]);
  r.clearCookie("__Host-panel", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
  });
  r.sendStatus(204);
});
async function evo(p, o = {}) {
  const ac = new AbortController(),
    timer = setTimeout(() => ac.abort(), o.timeoutMs || 20000);
  try {
    const x = await fetch(C.evo + p, {
        method: o.method || "GET",
        signal: ac.signal,
        headers: {
          apikey: o.instanceToken || C.key,
          ...(o.id ? { instanceId: o.id } : {}),
          ...(o.body ? { "content-type": "application/json" } : {}),
          ...(o.headers || {}),
        },
        body: o.body ? JSON.stringify(o.body) : undefined,
      }),
      t = await x.text();
    let d;
    try {
      d = t ? JSON.parse(t) : {};
    } catch {
      d = { message: t.slice(0, 300) };
    }
    if (!x.ok) {
      const e = new Error(
        d.message || d.error || "Evolution Go HTTP " + x.status,
      );
      e.status = x.status;
      throw e;
    }
    return d;
  } finally {
    clearTimeout(timer);
  }
}
const unwrap = (x) => x?.data || x?.instance || x?.result || x;
function isInstanceConnected(value) {
  const s = value || {},
    connected = s.connected ?? s.Connected,
    loggedIn = s.loggedIn ?? s.logged_in ?? s.LoggedIn,
    state = String(
      s.status ?? s.Status ?? s.state ?? s.State ?? s.connection ?? "",
    ).toLowerCase();
  return (
    (connected === true && loggedIn !== false) ||
    ["connected", "open", "online"].includes(state)
  );
}
async function qrDataUrl(...values) {
  const candidates = values.flatMap((value) =>
    typeof value === "string"
      ? [value]
      : value && typeof value === "object"
        ? [value.code, value.qrcode, value.qr, value.base64].filter(
            (item) => typeof item === "string",
          )
        : [],
  );
  const image = candidates.find(
    (value) =>
      value.startsWith("data:image/") ||
      value.startsWith("iVBORw0KGgo") ||
      value.startsWith("/9j/"),
  );
  if (image)
    return image.startsWith("data:") ? image : "data:image/png;base64," + image;
  const text = candidates.find((value) => value.length > 0);
  return text ? QRCode.toDataURL(text) : null;
}
async function evoInstance(id, p, o = {}) {
  const row = (
    await pool.query("select api_token_enc from instances where id=$1", [id])
  ).rows[0];
  if (!row?.api_token_enc)
    throw Object.assign(new Error("Evolution Go instance token unavailable"), {
      status: 409,
    });
  return evo(p, { ...o, instanceToken: open(row.api_token_enc).toString() });
}
const isDirectJid = (jid) => /@(s\.whatsapp\.net|c\.us|lid)$/i.test(jid);
async function mergeChatJid(db, instanceId, source, target) {
  if (!source || !target || source === target) return;
  await db.query(
    "delete from messages old using messages current where old.instance_id=$1 and old.chat_jid=$2 and current.instance_id=$1 and current.chat_jid=$3 and old.message_id=current.message_id",
    [instanceId, source, target],
  );
  await db.query(
    "update messages set chat_jid=$3 where instance_id=$1 and chat_jid=$2",
    [instanceId, source, target],
  );
  await db.query(
    "insert into chats(instance_id,jid,name,is_group,last_at,avatar_media_id,avatar_checked_at,read_through_id) select instance_id,$3,name,is_group,last_at,avatar_media_id,avatar_checked_at,read_through_id from chats where instance_id=$1 and jid=$2 on conflict(instance_id,jid) do update set name=case when chats.name='' or chats.name ~ '^[0-9]+$' then excluded.name else chats.name end,last_at=greatest(chats.last_at,excluded.last_at),avatar_media_id=coalesce(chats.avatar_media_id,excluded.avatar_media_id),avatar_checked_at=coalesce(chats.avatar_checked_at,excluded.avatar_checked_at),read_through_id=greatest(chats.read_through_id,excluded.read_through_id)",
    [instanceId, source, target],
  );
  await db.query("delete from chats where instance_id=$1 and jid=$2", [
    instanceId,
    source,
  ]);
  await db.query(
    "update chat_aliases set canonical_jid=$3 where instance_id=$1 and canonical_jid=$2",
    [instanceId, source, target],
  );
}
async function linkDirectChatJids(db, instanceId, values, preferred = "") {
  const aliases = [
    ...new Set(values.map((x) => String(x || "")).filter(isDirectJid)),
  ];
  if (!aliases.length) return preferred || "";
  const phoneJid = aliases.find((x) => /@(s\.whatsapp\.net|c\.us)$/i.test(x));
  const known = (
    await db.query(
      "select canonical_jid from chat_aliases where instance_id=$1 and alias_jid=any($2::text[]) limit 1",
      [instanceId, aliases],
    )
  ).rows[0]?.canonical_jid;
  const canonical =
    phoneJid ||
    known ||
    (isDirectJid(preferred) ? preferred : "") ||
    aliases[0];
  for (const alias of [...aliases, canonical]) {
    const old = (
      await db.query(
        "select canonical_jid from chat_aliases where instance_id=$1 and alias_jid=$2",
        [instanceId, alias],
      )
    ).rows[0]?.canonical_jid;
    if (old && old !== canonical)
      await mergeChatJid(db, instanceId, old, canonical);
    if (alias !== canonical)
      await mergeChatJid(db, instanceId, alias, canonical);
    await db.query(
      "insert into chat_aliases(instance_id,alias_jid,canonical_jid) values($1,$2,$3) on conflict(instance_id,alias_jid) do update set canonical_jid=excluded.canonical_jid",
      [instanceId, alias, canonical],
    );
  }
  return canonical;
}
async function reconcileExistingChatAliases() {
  const rows = await pool.query(
    "select instance_id,event_name,body_enc from events where lower(event_name) in ('message','sendmessage') and at>now()-interval '90 days' order by at desc limit 5000",
  );
  const pairs = new Map(),
    messageUpdates = [];
  for (const row of rows.rows) {
    try {
      const payload = JSON.parse(open(row.body_enc).toString()),
        data = payload.data || {},
        info = infoOf(data),
        chat = String(info.Chat || info.chat || ""),
        messageId = String(info.ID || info.id || data.ID || ""),
        sender = String(info.Sender || info.sender || ""),
        senderAlt = String(info.SenderAlt || info.senderAlt || ""),
        group = /@g\.us$/i.test(chat) || info.IsGroup === true,
        fromMe =
          info.IsFromMe === true ||
          info.FromMe === true ||
          String(info.IsFromMe || info.FromMe || "").toLowerCase() === "true";
      if (chat && messageId && sender)
        messageUpdates.push([
          row.instance_id,
          chat,
          messageId,
          sender,
          senderAlt,
        ]);
      if (group || fromMe) continue;
      const values = [
          chat,
          info.Sender,
          info.SenderAlt,
          info.sender,
          info.senderAlt,
        ]
          .map((x) => String(x || ""))
          .filter(isDirectJid),
        pn = values.find((x) => /@(s\.whatsapp\.net|c\.us)$/i.test(x)),
        lid = values.find((x) => /@lid$/i.test(x));
      if (pn && lid) {
        const key = row.instance_id + "\n" + pn;
        if (!pairs.has(key))
          pairs.set(key, { instanceId: row.instance_id, pn, lid });
      }
    } catch {}
  }
  if (messageUpdates.length) {
    await pool.query(
      "update messages m set sender_jid=coalesce(nullif(m.sender_jid,''),x.sender_jid),sender_alt=coalesce(nullif(m.sender_alt,''),x.sender_alt) from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[]) as x(instance_id,chat_jid,message_id,sender_jid,sender_alt) where m.instance_id=x.instance_id and m.chat_jid=x.chat_jid and m.message_id=x.message_id",
      messageUpdates.reduce(
        (columns, row) => {
          row.forEach((value, index) => columns[index].push(value));
          return columns;
        },
        [[], [], [], [], []],
      ),
    );
  }
  if (pairs.size) {
    const db = await pool.connect();
    try {
      await db.query("begin");
      for (const pair of pairs.values()) {
        await linkDirectChatJids(
          db,
          pair.instanceId,
          [pair.pn, pair.lid],
          pair.pn,
        );
      }
      await db.query("commit");
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }
}
app.get("/api/instances", auth, async (q, r, n) => {
  try {
    r.json(
      (
        await pool.query("select * from instances order by created_at")
      ).rows.map((i) => ({
        id: i.id,
        name: i.name,
        status: i.status,
        qr:
          i.qr_enc && i.qr_expires && new Date(i.qr_expires) > new Date()
            ? open(i.qr_enc).toString()
            : null,
      })),
    );
  } catch (e) {
    n(e);
  }
});
app.get("/api/instances/:id/qr", auth, async (q, r, n) => {
  try {
    const row = (
      await pool.query("select id from instances where id=$1", [q.params.id])
    ).rows[0];
    if (!row) return r.sendStatus(404);
    const status = unwrap(await evoInstance(row.id, "/instance/status"));
    if (isInstanceConnected(status)) {
      await pool.query(
        "update instances set status='connected',qr_enc=null,qr_expires=null,last_connected=coalesce(last_connected,now()) where id=$1",
        [row.id],
      );
      emit("instance", { id: row.id, status: "connected" });
      return r.json({ qr: null, status: "connected" });
    }
    const result = unwrap(await evoInstance(row.id, "/instance/qr"));
    const qr = await qrDataUrl(
      result?.code,
      result?.qrcode,
      result?.qr,
      result,
    );
    if (qr) {
      await pool.query(
        "update instances set status='needs_pairing',qr_enc=$2,qr_expires=now()+interval '2 minutes' where id=$1",
        [row.id, seal(qr)],
      );
      return r.json({ qr });
    }
    r.json({ qr: null });
  } catch (e) {
    if (e.status === 404 || e.status === 409) return r.json({ qr: null });
    n(e);
  }
});
app.post("/api/instances", auth, async (q, r, n) => {
  try {
    const label = String(q.body.name || "")
      .trim()
      .slice(0, 80);
    if (!label) return r.sendStatus(400);
    const name = label
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50),
      token = rand(32),
      webhookToken = rand();
    if (!name)
      return r
        .status(400)
        .json({ error: "Use letters and numbers in the name." });
    const x = unwrap(
        await evo("/instance/create", {
          method: "POST",
          body: { name, token },
        }),
      ),
      id = String(x.instanceId || x.id || x.name || name);
    await pool.query(
      "insert into instances(id,name,webhook_hash,api_token_enc,status) values($1,$2,$3,$4,$5)",
      [id, label, hash(webhookToken), seal(token), "created"],
    );
    let connectionError = "";
    try {
      await evoInstance(id, "/instance/connect", {
        method: "POST",
        body: {
          webhookUrl:
            "http://whatsapp-panel:3000/api/webhook/" +
            encodeURIComponent(id) +
            "/" +
            webhookToken,
          subscribe: ["ALL"],
          immediate: true,
        },
      });
    } catch (e) {
      connectionError = e.message;
      console.warn("Instance connection start:", e.message);
      await pool.query(
        "update instances set status='disconnected' where id=$1",
        [id],
      );
    }
    r.status(201).json({
      id,
      name: label,
      status: connectionError ? "disconnected" : "connecting",
      ...(connectionError ? { connectionError } : {}),
    });
  } catch (e) {
    n(e);
  }
});
app.post("/api/instances/:id/connect", auth, async (q, r, n) => {
  try {
    const i = (
      await pool.query("select id from instances where id=$1", [q.params.id])
    ).rows[0];
    if (!i) return r.sendStatus(404);
    const t = rand();
    await pool.query(
      "update instances set webhook_hash=$2,status=$3 where id=$1",
      [i.id, hash(t), "connecting"],
    );
    const d = await evoInstance(i.id, "/instance/connect", {
      method: "POST",
      body: {
        webhookUrl:
          "http://whatsapp-panel:3000/api/webhook/" +
          encodeURIComponent(i.id) +
          "/" +
          t,
        subscribe: ["ALL"],
        immediate: true,
      },
    });
    r.json(d);
  } catch (e) {
    n(e);
  }
});
app.get("/api/chats", auth, async (q, r, n) => {
  try {
    if (!q.query.instanceId) return r.json([]);
    const a = await pool.query(
      "select c.jid,c.name,c.is_group,c.last_at,c.avatar_media_id,m.content_enc,m.media_id,m.msg_type,m.deleted,m.from_me,(select count(*)::int from messages u where u.instance_id=c.instance_id and u.chat_jid=c.jid and u.from_me=false and u.id>c.read_through_id) unread_count from chats c left join lateral(select content_enc,media_id,msg_type,deleted,from_me from messages where instance_id=c.instance_id and chat_jid=c.jid order by ts desc,id desc limit 1)m on true where c.instance_id=$1 order by c.last_at desc nulls last limit 500",
      [q.query.instanceId],
    );
    r.json(
      a.rows.map((x) => ({
        jid: x.jid,
        name: x.name || x.jid,
        group: x.is_group,
        avatarMediaId: x.avatar_media_id,
        time: x.last_at,
        unreadCount: x.unread_count,
        preview: x.deleted
          ? "Deleted message"
          : x.content_enc
            ? JSON.parse(open(x.content_enc).toString()).text ||
              (x.media_id ? "[" + x.msg_type + "]" : "")
            : "",
        fromMe: x.from_me,
      })),
    );
  } catch (e) {
    n(e);
  }
});
app.post("/api/chats/:jid/read", auth, async (q, r, n) => {
  try {
    const instanceId = String(q.body.instanceId || ""),
      jid = q.params.jid;
    if (!instanceId || !jid) return r.sendStatus(400);
    const result = await pool.query(
      "update chats c set read_through_id=greatest(c.read_through_id,coalesce((select max(m.id) from messages m where m.instance_id=c.instance_id and m.chat_jid=c.jid),0)) where c.instance_id=$1 and c.jid=$2 returning c.read_through_id",
      [instanceId, jid],
    );
    if (!result.rowCount) return r.sendStatus(404);
    emit("chat-read", { instanceId, chatJid: jid });
    r.json({ ok: true, readThroughId: result.rows[0].read_through_id });
  } catch (e) {
    n(e);
  }
});
app.post("/api/chats/start", auth, async (q, r, n) => {
  try {
    const instanceId = String(q.body.instanceId || ""),
      digits = String(q.body.phone || "").replace(/\D/g, "");
    if (!instanceId || digits.length < 7 || digits.length > 15)
      return r.status(400).json({
        error: "Enter a valid phone number with country code.",
      });
    const result = unwrap(
        await evoInstance(instanceId, "/user/check", {
          method: "POST",
          body: { number: [digits], formatJid: false },
        }),
      ),
      users = result.Users || result.users || [],
      contact = Array.isArray(users) ? users[0] : users[digits],
      exists = contact?.IsInWhatsapp ?? contact?.isInWhatsapp;
    if (!contact || exists === false)
      return r.status(404).json({
        error: "This number does not have a WhatsApp account.",
      });
    const jid = String(
        contact.RemoteJID ||
          contact.remoteJid ||
          contact.JID ||
          contact.jid ||
          `${digits}@s.whatsapp.net`,
      ),
      contactName = String(
        contact.VerifiedName || contact.PushName || contact.FullName || digits,
      ).slice(0, 100);
    const alternate = String(contact.LID || contact.lid || ""),
      db = await pool.connect();
    let canonical = jid;
    try {
      await db.query("begin");
      canonical = await linkDirectChatJids(
        db,
        instanceId,
        [jid, contact.JID || contact.jid, alternate],
        jid,
      );
      await db.query(
        "insert into chats(instance_id,jid,name,is_group,last_at) values($1,$2,$3,false,now()) on conflict(instance_id,jid) do update set name=case when chats.name='' or chats.name ~ '^[0-9]+$' then excluded.name else chats.name end,last_at=coalesce(chats.last_at,now())",
        [instanceId, canonical, contactName],
      );
      await db.query("commit");
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
    r.status(201).json({ jid: canonical, name: contactName, group: false });
  } catch (e) {
    n(e);
  }
});
app.get("/api/chats/:jid/avatar", auth, async (q, r, n) => {
  try {
    const jid = q.params.jid,
      instanceId = String(q.query.instanceId || ""),
      chat = (
        await pool.query(
          "select jid,is_group,avatar_media_id,avatar_checked_at from chats where instance_id=$1 and jid=$2",
          [instanceId, jid],
        )
      ).rows[0];
    if (!chat) return r.sendStatus(404);
    if (
      chat.avatar_checked_at &&
      Date.now() - new Date(chat.avatar_checked_at).getTime() <
        (chat.avatar_media_id ? 24 * 60 * 60 * 1000 : 15 * 60 * 1000)
    )
      return r.json({ mediaId: chat.avatar_media_id });
    try {
      const result = unwrap(
        await evoInstance(instanceId, "/user/avatar", {
          method: "POST",
          timeoutMs: 90000,
          body: {
            number: chat.is_group ? jid : number(jid),
            preview: true,
          },
        }),
      );
      const photo =
          result.Picture ||
          result.picture ||
          result.Photo ||
          result.photo ||
          result.GroupPicture ||
          result.groupPicture ||
          result.ProfilePicture ||
          result.profilePicture ||
          {},
        url = String(
          result.URL ||
            result.Url ||
            result.url ||
            result.PictureURL ||
            result.pictureURL ||
            result.PhotoURL ||
            result.photoURL ||
            photo.URL ||
            photo.Url ||
            photo.url ||
            photo.PictureURL ||
            photo.URLString ||
            "",
        );
      let image = null;
      if (url.startsWith("data:image/")) {
        const match = url.match(
          /^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/i,
        );
        if (match) {
          const buffer = Buffer.from(match[2], "base64");
          if (buffer.length <= 5 * 1024 * 1024)
            image = {
              mime: match[1].toLowerCase(),
              buffer,
            };
        }
      } else if (url) {
        const parsed = new URL(url);
        if (
          parsed.protocol === "https:" &&
          /(^|\.)whatsapp\.net$/i.test(parsed.hostname)
        ) {
          const controller = new AbortController(),
            timeout = setTimeout(() => controller.abort(), 10000);
          try {
            let response = await fetch(parsed, {
              signal: controller.signal,
              redirect: "manual",
            });
            for (
              let redirects = 0;
              redirects < 3 && response.status >= 300 && response.status < 400;
              redirects++
            ) {
              const next = response.headers.get("location");
              if (!next) break;
              const redirected = new URL(next, parsed);
              if (
                redirected.protocol !== "https:" ||
                !/(^|\.)whatsapp\.net$/i.test(redirected.hostname)
              )
                break;
              response = await fetch(redirected, {
                signal: controller.signal,
                redirect: "manual",
              });
            }
            const mime = (response.headers.get("content-type") || "")
                .split(";")[0]
                .toLowerCase(),
              length = Number(response.headers.get("content-length") || 0);
            if (
              response.ok &&
              ["image/jpeg", "image/png", "image/webp"].includes(mime) &&
              (!length || length <= 5 * 1024 * 1024)
            ) {
              const buffer = Buffer.from(await response.arrayBuffer());
              if (buffer.length <= 5 * 1024 * 1024) image = { mime, buffer };
            }
          } finally {
            clearTimeout(timeout);
          }
        }
      }
      let mediaId = chat.avatar_media_id;
      if (image) {
        const previous = mediaId;
        mediaId = await saveFile(image.buffer, image.mime, "profile-picture");
        await pool.query(
          "update chats set avatar_media_id=$3,avatar_checked_at=now() where instance_id=$1 and jid=$2",
          [instanceId, jid, mediaId],
        );
        if (previous && previous !== mediaId) await removeMedia(previous);
      } else {
        await pool.query(
          "update chats set avatar_checked_at=now() where instance_id=$1 and jid=$2",
          [instanceId, jid],
        );
      }
      r.json({ mediaId });
    } catch {
      await pool.query(
        "update chats set avatar_checked_at=now() where instance_id=$1 and jid=$2",
        [instanceId, jid],
      );
      r.json({ mediaId: chat.avatar_media_id });
    }
  } catch (e) {
    n(e);
  }
});
async function downloadProfilePhoto(url) {
  if (url.startsWith("data:image/")) {
    const match = url.match(
      /^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/i,
    );
    if (!match) return null;
    const buffer = Buffer.from(match[2], "base64");
    return buffer.length && buffer.length <= 5 * 1024 * 1024
      ? { mime: match[1].toLowerCase(), buffer }
      : null;
  }
  let current = new URL(url);
  if (
    current.protocol !== "https:" ||
    !/(^|\.)whatsapp\.net$/i.test(current.hostname)
  )
    return null;
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 10000);
  try {
    let response = await fetch(current, {
      signal: controller.signal,
      redirect: "manual",
    });
    for (
      let count = 0;
      count < 3 && response.status >= 300 && response.status < 400;
      count++
    ) {
      const location = response.headers.get("location");
      if (!location) break;
      const next = new URL(location, current);
      if (
        next.protocol !== "https:" ||
        !/(^|\.)whatsapp\.net$/i.test(next.hostname)
      )
        break;
      current = next;
      response = await fetch(next, {
        signal: controller.signal,
        redirect: "manual",
      });
    }
    const mime = (response.headers.get("content-type") || "")
        .split(";")[0]
        .toLowerCase(),
      length = Number(response.headers.get("content-length") || 0);
    if (
      !response.ok ||
      !["image/jpeg", "image/png", "image/webp"].includes(mime) ||
      (length && length > 5 * 1024 * 1024)
    )
      return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length && buffer.length <= 5 * 1024 * 1024
      ? { mime, buffer }
      : null;
  } finally {
    clearTimeout(timeout);
  }
}
app.get("/api/participants/:jid/avatar", auth, async (q, r, n) => {
  try {
    const instanceId = String(q.query.instanceId || ""),
      jid = q.params.jid,
      alternate = String(q.query.alt || "");
    if (
      !instanceId ||
      !isDirectJid(jid) ||
      (alternate && !isDirectJid(alternate))
    )
      return r.sendStatus(400);
    const aliases = [...new Set([jid, alternate].filter(isDirectJid))],
      mapped = await pool.query(
        "select alias_jid,canonical_jid from chat_aliases where instance_id=$1 and alias_jid=any($2::text[])",
        [instanceId, aliases],
      ),
      candidates = [
        ...new Set([...mapped.rows.map((x) => x.canonical_jid), ...aliases]),
      ].sort(
        (a, b) =>
          Number(/@(s\.whatsapp\.net|c\.us)$/i.test(b)) -
          Number(/@(s\.whatsapp\.net|c\.us)$/i.test(a)),
      ),
      cached = await pool.query(
        "select media_id,checked_at from contact_avatars where instance_id=$1 and jid=any($2::text[]) order by (media_id is not null) desc limit 1",
        [instanceId, candidates],
      ),
      entry = cached.rows[0];
    if (
      entry?.checked_at &&
      Date.now() - new Date(entry.checked_at).getTime() <
        (entry.media_id ? 86400000 : 900000)
    )
      return r.json({ mediaId: entry.media_id });
    let photo = null;
    for (const candidate of candidates.slice(0, 2)) {
      try {
        const data = unwrap(
          await evoInstance(instanceId, "/user/avatar", {
            method: "POST",
            timeoutMs: 90000,
            body: {
              number: /@lid$/i.test(candidate) ? candidate : number(candidate),
              preview: true,
            },
          }),
        );
        const url = String(data.URL || data.Url || data.url || "");
        if (url) photo = await downloadProfilePhoto(url);
        if (photo) break;
      } catch {}
    }
    const mediaId = photo
      ? await saveFile(photo.buffer, photo.mime, "participant-profile-picture")
      : null;
    for (const candidate of candidates) {
      await pool.query(
        "insert into contact_avatars(instance_id,jid,media_id,checked_at) values($1,$2,$3,now()) on conflict(instance_id,jid) do update set media_id=excluded.media_id,checked_at=now()",
        [instanceId, candidate, mediaId],
      );
    }
    r.json({ mediaId });
  } catch (e) {
    n(e);
  }
});
app.get("/api/chats/:jid/messages", auth, async (q, r, n) => {
  try {
    const x = await pool.query(
      "select m.*,med.mime,mr.reply_preview,coalesce(json_agg(json_build_object('content_enc',v.content_enc,'media_id',v.media_id,'deleted',v.deleted,'at',v.at) order by v.at) filter(where v.id is not null),'[]') versions,coalesce((select json_agg(json_build_object('emoji',rs.emoji,'count',rs.reaction_count,'mine',rs.mine) order by rs.emoji) from (select emoji,count(*)::int reaction_count,bool_or(reactor='__self__') mine from message_reactions r where r.instance_id=m.instance_id and r.chat_jid=m.chat_jid and r.target_message_id=m.message_id group by emoji) rs),'[]'::json) reactions from messages m left join media med on med.id=m.media_id left join versions v on v.message_row=m.id left join message_replies mr on mr.instance_id=m.instance_id and mr.chat_jid=m.chat_jid and mr.message_id=m.message_id where m.instance_id=$1 and m.chat_jid=$2 group by m.id,med.mime,mr.reply_preview order by m.ts desc limit 100",
      [q.query.instanceId, q.params.jid],
    );
    r.json(
      x.rows.reverse().map((m) => ({
        id: m.id,
        messageId: m.message_id,
        fromMe: m.from_me,
        sender: m.sender_name || m.sender,
        senderJid: m.sender_jid,
        senderAlt: m.sender_alt,
        type: m.msg_type,
        mime: m.mime,
        content: JSON.parse(open(m.content_enc).toString()),
        quoted:
          m.reply_preview ||
          quotePreview(JSON.parse(open(m.content_enc).toString()).raw),
        reactions: m.reactions || [],
        mediaId: m.media_id,
        deleted: m.deleted,
        edited: m.edited,
        time: m.ts,
        versions: m.versions.map((v) => ({
          content: JSON.parse(open(v.content_enc).toString()),
          mediaId: v.media_id,
          deleted: v.deleted,
          time: v.at,
        })),
      })),
    );
  } catch (e) {
    n(e);
  }
});
app.get("/api/chats/:jid/info", auth, async (q, r, n) => {
  try {
    const instanceId = String(q.query.instanceId || ""),
      jid = q.params.jid,
      chat = (
        await pool.query(
          "select name,is_group from chats where instance_id=$1 and jid=$2",
          [instanceId, jid],
        )
      ).rows[0];
    if (!chat) return r.sendStatus(404);
    if (chat.is_group) {
      const data = unwrap(
          await evoInstance(instanceId, "/group/info", {
            method: "POST",
            body: { groupJid: jid },
          }),
        ),
        groupName = data.GroupName?.Name || data.groupName || chat.name,
        topic = data.GroupTopic?.Topic || data.topic || data.description || "",
        rows = Array.isArray(data.Participants)
          ? data.Participants
          : Array.isArray(data.participants)
            ? data.participants
            : [],
        participants = rows
          .slice(0, 200)
          .map((p) => {
            const participantJid =
                typeof p === "string" ? p : String(p.JID || p.jid || ""),
              phone = /@(s\.whatsapp\.net|c\.us)$/i.test(participantJid)
                ? number(participantJid)
                : "";
            return {
              name:
                typeof p === "object"
                  ? String(p.PushName || p.Name || p.name || phone || "")
                  : phone,
              phone,
              admin: Boolean(p.IsAdmin || p.IsSuperAdmin || p.admin),
            };
          })
          .filter((p) => p.name || p.phone);
      return r.json({
        name: String(groupName),
        group: true,
        description: String(topic),
        participantCount: Number(data.ParticipantCount || participants.length),
        participants,
      });
    }
    const alias = (
        await pool.query(
          "select canonical_jid from chat_aliases where instance_id=$1 and alias_jid=$2",
          [instanceId, jid],
        )
      ).rows[0]?.canonical_jid,
      contactJid = alias || jid,
      phone = /@lid$/i.test(contactJid) ? "" : number(contactJid);
    if (!/^\d{7,15}$/.test(phone))
      return r.json({ name: chat.name, group: false, phone: "" });
    const data = unwrap(
        await evoInstance(instanceId, "/user/info", {
          method: "POST",
          body: { number: [phone] },
        }),
      ),
      users = data.Users || data.users || {},
      contact = Array.isArray(users)
        ? users[0] || {}
        : users[contactJid] || Object.values(users)[0] || {},
      verified =
        contact.VerifiedName?.Details?.VerifiedName ||
        contact.VerifiedName ||
        "";
    return r.json({
      name: chat.name,
      group: false,
      phone,
      verifiedName: typeof verified === "string" ? verified : "",
      about: String(contact.Status || contact.status || ""),
    });
  } catch (e) {
    n(e);
  }
});
app.get("/api/participants/:jid/info", auth, async (q, r, n) => {
  try {
    const instanceId = String(q.query.instanceId || ""),
      jid = String(q.params.jid || ""),
      alternate = String(q.query.alt || "");
    if (
      !instanceId ||
      !isDirectJid(jid) ||
      (alternate && !isDirectJid(alternate))
    )
      return r.sendStatus(400);
    const aliases = [...new Set([jid, alternate].filter(isDirectJid))],
      mapped = await pool.query(
        "select alias_jid,canonical_jid from chat_aliases where instance_id=$1 and alias_jid=any($2::text[])",
        [instanceId, aliases],
      ),
      candidates = [
        ...new Set([
          ...mapped.rows.map((row) => row.canonical_jid),
          ...aliases,
        ]),
      ],
      phoneJid = candidates.find((value) =>
        /@(s\.whatsapp\.net|c\.us)$/i.test(value),
      ),
      phone = phoneJid ? number(phoneJid) : "";
    let contact = {};
    if (/^\d{7,15}$/.test(phone)) {
      try {
        const data = unwrap(
            await evoInstance(instanceId, "/user/info", {
              method: "POST",
              body: { number: [phone] },
            }),
          ),
          users = data.Users || data.users || {};
        contact = Array.isArray(users)
          ? users[0] || {}
          : users[phoneJid] ||
            users[phone] ||
            candidates.map((candidate) => users[candidate]).find(Boolean) ||
            Object.values(users)[0] ||
            {};
      } catch {}
    }
    const verified =
      contact.VerifiedName?.Details?.VerifiedName || contact.VerifiedName || "";
    r.json({
      group: false,
      phone: /^\d{7,15}$/.test(phone) ? phone : "",
      verifiedName: typeof verified === "string" ? verified : "",
      about: String(contact.Status || contact.status || ""),
    });
  } catch (e) {
    n(e);
  }
});
async function saveFile(buf, mime, name) {
  const id = crypto.randomUUID(),
    fn = id + ".bin",
    iv = crypto.randomBytes(12),
    c = crypto.createCipheriv("aes-256-gcm", C.enc, iv),
    ct = Buffer.concat([c.update(buf), c.final()]),
    enc = Buffer.concat([iv, c.getAuthTag(), ct]);
  await fsp.writeFile(path.join(C.media, fn), enc, { mode: 0o600, flag: "wx" });
  await pool.query(
    "insert into media(id,file_name,mime,original,size) values($1,$2,$3,$4,$5)",
    [id, fn, mime, path.basename(name).slice(0, 200), buf.length],
  );
  return id;
}
async function removeMedia(id) {
  const result = await pool.query(
    "delete from media where id=$1 returning file_name",
    [id],
  );
  if (result.rows[0])
    await fsp
      .unlink(path.join(C.media, result.rows[0].file_name))
      .catch(() => {});
}
async function getFile(id) {
  const m = (await pool.query("select * from media where id=$1", [id])).rows[0];
  if (!m) return null;
  const b = await fsp.readFile(path.join(C.media, m.file_name)),
    d = crypto.createDecipheriv("aes-256-gcm", C.enc, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return { m, b: Buffer.concat([d.update(b.subarray(28)), d.final()]) };
}
class TelegramDeliveryError extends Error {
  constructor(status, retryAfter = 0) {
    super("Telegram delivery failed");
    this.status = status;
    this.retryAfter = retryAfter;
    this.permanent = status >= 400 && status < 500 && status !== 429;
  }
}
async function telegramRequest(method, fields, file = null) {
  const url = `https://api.telegram.org/bot${C.telegramToken}/${method}`;
  let body;
  if (file) {
    body = new FormData();
    body.append("chat_id", C.telegramChatId);
    body.append(
      file.field,
      new Blob([file.buffer], { type: file.mime }),
      path.basename(file.name || "attachment"),
    );
  } else {
    body = JSON.stringify({ chat_id: C.telegramChatId, ...fields });
  }
  let response, result;
  try {
    response = await fetch(url, {
      method: "POST",
      ...(file ? {} : { headers: { "Content-Type": "application/json" } }),
      body,
      signal: AbortSignal.timeout(20000),
    });
    result = await response.json();
  } catch {
    throw new TelegramDeliveryError(0);
  }
  if (!response.ok || !result.ok)
    throw new TelegramDeliveryError(
      Number(result.error_code || response.status),
      Number(result.parameters?.retry_after || 0),
    );
  return result;
}
function formatTelegramTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Sao_Paulo",
        dateStyle: "short",
        timeStyle: "short",
      }).format(date);
}
async function claimTelegramNotification() {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const result = await c.query(
      "with next as (select id from telegram_outbox where available_at<=now() and (status='pending' or (status='sending' and locked_at<now()-interval '5 minutes')) order by created_at for update skip locked limit 1) update telegram_outbox o set status='sending',attempts=attempts+1,locked_at=now() from next where o.id=next.id returning o.*",
    );
    await c.query("commit");
    return result.rows[0] || null;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
async function telegramNotificationData(id) {
  return (
    await pool.query(
      "select o.*,m.sender_name,m.sender_jid,m.sender_alt,m.content_enc,m.msg_type,m.media_id,m.ts,c.name chat_name,c.is_group,med.mime,med.original from telegram_outbox o join messages m on m.instance_id=o.instance_id and m.chat_jid=o.chat_jid and m.message_id=o.message_id join chats c on c.instance_id=o.instance_id and c.jid=o.chat_jid left join media med on med.id=m.media_id where o.id=$1",
      [id],
    )
  ).rows[0];
}
async function deliverTelegramNotification(queue) {
  const row = await telegramNotificationData(queue.id);
  if (!row) {
    await pool.query(
      "update telegram_outbox set status='delivered',locked_at=null,last_error='message_missing' where id=$1",
      [queue.id],
    );
    return;
  }
  let content = {};
  try {
    content = JSON.parse(open(row.content_enc).toString());
  } catch {}
  const bodyText = String(content.text || ""),
    text = formatIncomingMessage({
      senderName: row.sender_name,
      senderJid: row.sender_jid,
      senderAlt: row.sender_alt,
      chatJid: row.chat_jid,
      chatName: row.chat_name,
      isGroup: row.is_group,
      timestamp: formatTelegramTimestamp(row.ts),
      text: bodyText || (row.media_id ? mediaLabel(row.mime, row.msg_type) : ""),
      mime: row.mime,
      type: row.msg_type,
    }),
    parts = splitTelegramText(text);
  let sentParts = Number(queue.text_parts_sent || 0);
  while (sentParts < parts.length) {
    await telegramRequest("sendMessage", { text: parts[sentParts] });
    sentParts++;
    await pool.query(
      "update telegram_outbox set text_parts_sent=$2,locked_at=now() where id=$1",
      [queue.id, sentParts],
    );
  }
  let mediaSent = Boolean(queue.media_sent);
  if (!mediaSent && row.media_id) {
    const file = await getFile(row.media_id);
    if (file) {
      const [method, field] = telegramMediaMethod(file.m.mime, file.b.length),
        payload = {
          field,
          buffer: file.b,
          mime: file.m.mime,
          name: file.m.original,
        };
      try {
        await telegramRequest(method, {}, payload);
        mediaSent = true;
      } catch (e) {
        if (!e.permanent) throw e;
        if (method !== "sendDocument") {
          try {
            await telegramRequest("sendDocument", {}, payload);
            mediaSent = true;
          } catch (fallbackError) {
            if (!fallbackError.permanent) throw fallbackError;
          }
        }
        if (!mediaSent) {
          await telegramRequest("sendMessage", {
            text: `⚠️ Não foi possível anexar ${mediaLabel(file.m.mime, row.msg_type)}.`,
          });
          mediaSent = true;
        }
      }
    } else mediaSent = true;
  } else if (!row.media_id) mediaSent = true;
  await pool.query(
    "update telegram_outbox set status='delivered',media_sent=$2,locked_at=null,last_error=null where id=$1",
    [queue.id, mediaSent],
  );
}
let telegramWorkerRunning = false;
async function processTelegramOutbox() {
  if (!telegramEnabled || telegramWorkerRunning) return;
  telegramWorkerRunning = true;
  try {
    const queue = await claimTelegramNotification();
    if (!queue) return;
    try {
      await deliverTelegramNotification(queue);
    } catch (e) {
      const delay = Math.min(
          6 * 60 * 60 * 1000,
          e.retryAfter > 0
            ? e.retryAfter * 1000
            : 1000 * 2 ** Math.min(queue.attempts, 14),
        ),
        code = Number(e.status || 0);
      await pool.query(
        "update telegram_outbox set status='pending',available_at=now()+($2 * interval '1 millisecond'),locked_at=null,last_error=$3 where id=$1",
        [queue.id, delay, `telegram_http_${code}`],
      );
      console.warn(
        "Telegram notification delivery deferred",
        `queue=${queue.id}`,
        `http=${code}`,
      );
    }
  } catch {
    console.warn("Telegram notification queue unavailable");
  } finally {
    telegramWorkerRunning = false;
  }
}
async function transfer(id) {
  const t = rand();
  await pool.query(
    "insert into transfer_tokens(token_hash,media_id,expires_at) values($1,$2,now()+interval '5 minutes')",
    [hash(t), id],
  );
  return "http://whatsapp-panel:3000/internal/media/" + t;
}
const number = (j) =>
  String(j)
    .replace(/@s\.whatsapp\.net$|@c\.us$/i, "")
    .replace(/:\d+$/, "");
async function sendText(inst, j, text, forward, quoted = null) {
  return evoInstance(inst, "/send/text", {
    method: "POST",
    body: {
      number: number(j),
      text: text.slice(0, 12000),
      formatJid: true,
      ...(forward ? { forwardingScore: 1 } : {}),
      ...(quoted ? { quoted } : {}),
    },
  });
}
async function sendMedia(inst, j, id, caption, forward, quoted = null) {
  const f = await getFile(id);
  if (!f) throw Object.assign(new Error("Media not found"), { status: 404 });
  const type = f.m.mime.startsWith("image/")
    ? "image"
    : f.m.mime.startsWith("audio/")
      ? "audio"
      : f.m.mime.startsWith("video/")
        ? "video"
        : "document";
  return evoInstance(inst, "/send/media", {
    method: "POST",
    body: {
      number: number(j),
      url: await transfer(id),
      type,
      caption: caption || "",
      filename: f.m.original,
      formatJid: true,
      ...(forward ? { forwardingScore: 1 } : {}),
      ...(quoted ? { quoted } : {}),
    },
  });
}
app.post("/api/send/text", auth, async (q, r, n) => {
  try {
    const instanceId = String(q.body.instanceId || ""),
      jid = String(q.body.jid || ""),
      text = String(q.body.text || "").trim();
    if (!text || text.length > 12000 || !instanceId || !jid)
      return r.sendStatus(400);
    let quoted = null,
      replyPreview = null;
    if (q.body.replyTo !== undefined && q.body.replyTo !== null) {
      const target = (
        await pool.query(
          "select m.message_id,m.sender,m.sender_name,m.sender_jid,m.sender_alt,m.from_me,m.msg_type,m.content_enc,m.deleted,c.is_group,med.mime from messages m join chats c on c.instance_id=m.instance_id and c.jid=m.chat_jid left join media med on med.id=m.media_id where m.id=$1 and m.instance_id=$2 and m.chat_jid=$3",
          [String(q.body.replyTo), instanceId, jid],
        )
      ).rows[0];
      if (!target || target.deleted || !target.message_id)
        return r
          .status(400)
          .json({ error: "This message can no longer be quoted." });
      quoted = {
        messageId: target.message_id,
        ...(target.sender_jid || target.sender_alt
          ? { participant: target.sender_jid || target.sender_alt }
          : {}),
      };
      const original = JSON.parse(open(target.content_enc).toString()),
        type = String(target.msg_type || "").toLowerCase(),
        typeLabel =
          type.includes("image") || target.mime?.startsWith("image/")
            ? "Image"
            : type.includes("video") || target.mime?.startsWith("video/")
              ? "Video"
              : type.includes("audio") || target.mime?.startsWith("audio/")
                ? "Audio"
                : type.includes("document") ||
                    (target.mime && !target.mime.startsWith("text/"))
                  ? "Document"
                  : type.includes("sticker")
                    ? "Sticker"
                    : "Text";
      replyPreview = {
        messageId: target.message_id,
        participant: target.sender_jid || target.sender_alt || "",
        senderName: target.from_me
          ? "You"
          : target.sender_name || target.sender || "",
        text:
          original.text ||
          (typeLabel === "Text" ? "[Message]" : `[${typeLabel}]`),
        type: typeLabel,
      };
      quoted.message = replyPreview.text;
    }
    const sent = await sendText(instanceId, jid, text, false, quoted),
      sentId = String(
        sent?.data?.Info?.ID ||
          sent?.data?.info?.id ||
          sent?.Info?.ID ||
          sent?.info?.id ||
          "",
      );
    if (replyPreview && sentId)
      await pool.query(
        "insert into message_replies(instance_id,chat_jid,message_id,target_message_id,reply_preview) values($1,$2,$3,$4,$5::jsonb) on conflict(instance_id,chat_jid,message_id) do update set target_message_id=excluded.target_message_id,reply_preview=excluded.reply_preview",
        [
          instanceId,
          jid,
          sentId,
          replyPreview.messageId,
          JSON.stringify(replyPreview),
        ],
      );
    if (replyPreview && sentId) emit("message", { instanceId, chatJid: jid });
    r.status(202).json({ ok: true });
  } catch (e) {
    n(e);
  }
});
app.post("/api/send/media", auth, uploads.single("file"), async (q, r, n) => {
  try {
    if (!q.file) return r.sendStatus(400);
    const instanceId = String(q.body.instanceId || ""),
      jid = String(q.body.jid || "");
    let quoted = null,
      replyPreview = null;
    if (q.body.replyTo !== undefined && q.body.replyTo !== null) {
      const target = (
        await pool.query(
          "select m.message_id,m.sender,m.sender_name,m.sender_jid,m.sender_alt,m.from_me,m.msg_type,m.content_enc,m.deleted,c.is_group,med.mime from messages m join chats c on c.instance_id=m.instance_id and c.jid=m.chat_jid left join media med on med.id=m.media_id where m.id=$1 and m.instance_id=$2 and m.chat_jid=$3",
          [String(q.body.replyTo), instanceId, jid],
        )
      ).rows[0];
      if (!target || target.deleted || !target.message_id)
        return r
          .status(400)
          .json({ error: "This message can no longer be quoted." });
      quoted = {
        messageId: target.message_id,
        ...(target.sender_jid || target.sender_alt
          ? { participant: target.sender_jid || target.sender_alt }
          : {}),
      };
      const original = JSON.parse(open(target.content_enc).toString()),
        type = String(target.msg_type || "").toLowerCase(),
        typeLabel =
          type.includes("image") || target.mime?.startsWith("image/")
            ? "Image"
            : type.includes("video") || target.mime?.startsWith("video/")
              ? "Video"
              : type.includes("audio") || target.mime?.startsWith("audio/")
                ? "Audio"
                : type.includes("document") ||
                    (target.mime && !target.mime.startsWith("text/"))
                  ? "Document"
                  : type.includes("sticker")
                    ? "Sticker"
                    : "Text";
      replyPreview = {
        messageId: target.message_id,
        participant: target.sender_jid || target.sender_alt || "",
        senderName: target.from_me
          ? "You"
          : target.sender_name || target.sender || "",
        text:
          original.text ||
          (typeLabel === "Text" ? "[Message]" : `[${typeLabel}]`),
        type: typeLabel,
      };
      quoted.message = replyPreview.text;
    }
    const id = await saveFile(
      q.file.buffer,
      q.file.mimetype,
      q.file.originalname,
    );
    const sent = await sendMedia(
      instanceId,
      jid,
      id,
      String(q.body.caption || ""),
      false,
      quoted,
    );
    const sentId = String(
      sent?.data?.Info?.ID ||
        sent?.data?.info?.id ||
        sent?.Info?.ID ||
        sent?.info?.id ||
        "",
    );
    if (replyPreview && sentId)
      await pool.query(
        "insert into message_replies(instance_id,chat_jid,message_id,target_message_id,reply_preview) values($1,$2,$3,$4,$5::jsonb) on conflict(instance_id,chat_jid,message_id) do update set target_message_id=excluded.target_message_id,reply_preview=excluded.reply_preview",
        [
          instanceId,
          jid,
          sentId,
          replyPreview.messageId,
          JSON.stringify(replyPreview),
        ],
      );
    if (replyPreview && sentId) emit("message", { instanceId, chatJid: jid });
    r.status(202).json({ ok: true });
  } catch (e) {
    n(e);
  }
});
app.post("/api/forward/:id", auth, async (q, r, n) => {
  try {
    const m = (
        await pool.query("select * from messages where id=$1", [q.params.id])
      ).rows[0],
      to = String(q.body.to || "");
    if (!m || !to) return r.sendStatus(404);
    const c = JSON.parse(open(m.content_enc).toString());
    if (m.media_id)
      await sendMedia(m.instance_id, to, m.media_id, c.text, true);
    else await sendText(m.instance_id, to, c.text, true);
    r.status(202).json({ ok: true });
  } catch (e) {
    n(e);
  }
});
app.post("/api/messages/:id/react", auth, async (q, r, n) => {
  try {
    const instanceId = String(q.body.instanceId || ""),
      jid = String(q.body.jid || ""),
      reaction = String(q.body.reaction || ""),
      segments = [
        ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
          reaction,
        ),
      ];
    if (
      !instanceId ||
      !jid ||
      (reaction !== "remove" &&
        (segments.length !== 1 ||
          reaction.length > 32 ||
          !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(
            reaction,
          )))
    )
      return r.sendStatus(400);
    const target = (
      await pool.query(
        "select m.message_id,m.from_me,m.sender_jid,m.sender_alt,m.deleted,c.is_group from messages m join chats c on c.instance_id=m.instance_id and c.jid=m.chat_jid where m.id=$1 and m.instance_id=$2 and m.chat_jid=$3",
        [String(q.params.id), instanceId, jid],
      )
    ).rows[0];
    if (!target || target.deleted || !target.message_id)
      return r.sendStatus(404);
    const participant = target.sender_jid || target.sender_alt || "";
    await evoInstance(instanceId, "/message/react", {
      method: "POST",
      body: {
        number: number(jid),
        reaction,
        id: target.message_id,
        fromMe: target.from_me,
        ...(target.is_group && participant ? { participant } : {}),
      },
    });
    if (reaction === "remove")
      await pool.query(
        "delete from message_reactions where instance_id=$1 and chat_jid=$2 and target_message_id=$3 and reactor='__self__'",
        [instanceId, jid, target.message_id],
      );
    else
      await pool.query(
        "insert into message_reactions(instance_id,chat_jid,target_message_id,reactor,reactor_name,emoji) values($1,$2,$3,'__self__','You',$4) on conflict(instance_id,chat_jid,target_message_id,reactor) do update set reactor_name='You',emoji=excluded.emoji,updated_at=now()",
        [instanceId, jid, target.message_id, reaction],
      );
    emit("message", { instanceId, chatJid: jid });
    r.status(202).json({ ok: true });
  } catch (e) {
    n(e);
  }
});
app.get("/api/media/:id", auth, async (q, r, n) => {
  try {
    const f = await getFile(q.params.id);
    if (!f) return r.sendStatus(404);
    r.set({
      "Content-Type": f.m.mime,
      "Content-Disposition":
        "inline; filename*=UTF-8''" + encodeURIComponent(f.m.original),
      "X-Content-Type-Options": "nosniff",
    });
    r.send(f.b);
  } catch (e) {
    n(e);
  }
});
app.get("/api/media/:id/download", auth, async (q, r, n) => {
  try {
    const f = await getFile(q.params.id);
    if (!f) return r.sendStatus(404);
    r.set({
      "Content-Type": f.m.mime,
      "Content-Disposition":
        "attachment; filename*=UTF-8''" + encodeURIComponent(f.m.original),
      "X-Content-Type-Options": "nosniff",
    });
    r.send(f.b);
  } catch (e) {
    n(e);
  }
});
app.get("/api/events", auth, (q, r) => {
  r.set({
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  r.flushHeaders();
  r.write("event: ready\ndata: {}\n\n");
  clients.add(r);
  const t = setInterval(() => r.write(": keepalive\n\n"), 20000);
  q.on("close", () => {
    clearInterval(t);
    clients.delete(r);
  });
});
function clean(o) {
  if (Array.isArray(o)) return o.map(clean);
  if (!o || typeof o !== "object") return o;
  const x = {};
  for (const [k, v] of Object.entries(o))
    if (!/^(base64|qrcode)$/i.test(k)) x[k] = clean(v);
  return x;
}
const infoOf = (d) => d.Info || d.info || d.key || {},
  msgOf = (d) => d.Message || d.message || d.msg || {},
  txt = (m) =>
    String(
      m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        "",
    );
function quotePreview(raw) {
  if (!raw || typeof raw !== "object") return null;
  const findContext = (value, depth = 0) => {
      if (!value || typeof value !== "object" || depth > 5) return null;
      if (
        value.contextInfo?.stanzaId ||
        value.contextInfo?.quotedMessage ||
        value.contextInfo?.quoted_message
      )
        return value.contextInfo;
      for (const child of Object.values(value)) {
        const found = findContext(child, depth + 1);
        if (found) return found;
      }
      return null;
    },
    context = findContext(raw),
    quoted = context?.quotedMessage || context?.quoted_message;
  if (!context) return null;
  const kinds = [
      ["imageMessage", "Image"],
      ["videoMessage", "Video"],
      ["audioMessage", "Audio"],
      ["documentMessage", "Document"],
      ["stickerMessage", "Sticker"],
      ["locationMessage", "Location"],
      ["contactMessage", "Contact"],
    ],
    media = quoted && kinds.find(([key]) => quoted[key]),
    text = txt(quoted || {});
  return {
    messageId: String(context.stanzaId || context.StanzaID || ""),
    participant: String(context.participant || context.Participant || ""),
    senderName: String(context.pushName || context.PushName || ""),
    text: text || (media ? `[${media[1]}]` : "[Quoted message]"),
    type: media?.[1] || (text ? "Text" : "Message"),
  };
}
app.post("/api/webhook/:id/:token", async (q, r, n) => {
  const c = await pool.connect();
  let fp = "";
  const notifications = [];
  try {
    const ins = (
      await c.query("select webhook_hash from instances where id=$1", [
        q.params.id,
      ])
    ).rows[0];
    if (!ins || !equal(ins.webhook_hash, hash(q.params.token)))
      return r.sendStatus(404);
    const p = q.body || {},
      event = String(p.event || "Unknown"),
      d = p.data || {},
      i = infoOf(d),
      m = msgOf(d),
      mid = String(i.ID || i.id || d.ID || ""),
      evHash = hash(q.raw || JSON.stringify(p));
    let chat = String(i.Chat || i.chat || "");
    const isGroup =
        /@g\.us$/i.test(chat) ||
        i.IsGroup === true ||
        String(i.IsGroup || i.isGroup || "").toLowerCase() === "true",
      fromMe =
        i.IsFromMe === true ||
        i.fromMe === true ||
        String(i.IsFromMe || i.fromMe || "").toLowerCase() === "true",
      senderJid = String(i.Sender || i.sender || ""),
      senderAlt = String(i.SenderAlt || i.senderAlt || ""),
      groupInfo =
        d.groupData || d.GroupData || d.groupInfo || d.GroupInfo || {},
      groupName = String(
        groupInfo.GroupName?.Name ||
          groupInfo.GroupName?.name ||
          (typeof groupInfo.GroupName === "string"
            ? groupInfo.GroupName
            : "") ||
          groupInfo.groupName?.name ||
          groupInfo.groupName?.Name ||
          (typeof groupInfo.groupName === "string"
            ? groupInfo.groupName
            : "") ||
          groupInfo.Name ||
          groupInfo.name ||
          "",
      )
        .trim()
        .slice(0, 100),
      chatName = isGroup
        ? groupName
        : fromMe
          ? ""
          : String(i.PushName || i.pushName || "").slice(0, 100);
    await c.query("begin");
    const insEv = await c.query(
      "insert into events(event_hash,instance_id,event_name,body_enc) values($1,$2,$3,$4) on conflict do nothing returning event_hash",
      [evHash, q.params.id, event, seal(JSON.stringify(clean(p)))],
    );
    if (!insEv.rowCount) {
      await c.query("rollback");
      return r.sendStatus(200);
    }
    if (chat && !isGroup) {
      const aliases = fromMe
        ? [chat, i.ChatAlt, i.chatAlt]
        : [chat, senderJid, senderAlt, i.ChatAlt, i.chatAlt];
      chat = await linkDirectChatJids(c, q.params.id, aliases, chat);
    }
    await c.query("update instances set last_event=now() where id=$1", [
      q.params.id,
    ]);
    const eventKey = event.toLowerCase().replace(/[^a-z]/g, ""),
      hasQr = d.code || d.qrcode || d.qr || d.base64,
      reactionMessage =
        m.reactionMessage ||
        m.ReactionMessage ||
        d.reactionMessage ||
        d.ReactionMessage ||
        null;
    if ((eventKey.includes("qrcode") || eventKey === "disconnected") && hasQr) {
      const qr = await qrDataUrl(d.code, d.qrcode, d.qr, d.base64);
      await c.query(
        "update instances set status='needs_pairing',qr_enc=$2,qr_expires=now()+interval '2 minutes' where id=$1",
        [q.params.id, seal(qr)],
      );
      notifications.push(["qr", { id: q.params.id, qr }]);
    } else if (
      ["connected", "pairsuccess", "offlinesynccompleted"].includes(eventKey) ||
      (eventKey === "connectionupdate" && isInstanceConnected(d))
    ) {
      await c.query(
        "update instances set status='connected',qr_enc=null,qr_expires=null,last_connected=now() where id=$1",
        [q.params.id],
      );
      notifications.push([
        "instance",
        { id: q.params.id, status: "connected" },
      ]);
    } else if (/loggedout/i.test(event)) {
      await c.query("update instances set status='logged_out' where id=$1", [
        q.params.id,
      ]);
      notifications.push([
        "instance",
        { id: q.params.id, status: "logged_out" },
      ]);
    } else if (eventKey === "disconnected") {
      await c.query(
        "update instances set status='disconnected',qr_enc=null,qr_expires=null where id=$1",
        [q.params.id],
      );
      notifications.push([
        "instance",
        { id: q.params.id, status: "disconnected" },
      ]);
    }
    const revoke =
        /revoke|delete|retract/i.test(event) ||
        String(m.protocolMessage?.type || "")
          .toLowerCase()
          .includes("revoke"),
      target = String(
        m.protocolMessage?.key?.ID || m.protocolMessage?.key?.Id || mid,
      );
    if (reactionMessage) {
      const key = reactionMessage.key || reactionMessage.Key || {},
        targetId = String(key.ID || key.Id || key.id || ""),
        targetChat = String(
          key.remoteJID ||
            key.RemoteJID ||
            key.remoteJid ||
            key.RemoteJid ||
            chat,
        );
      let reactionChat = targetChat;
      const groupReaction = /@g\.us$/i.test(reactionChat) || isGroup,
        reactor = fromMe
          ? "__self__"
          : senderJid || senderAlt || (!groupReaction ? reactionChat : ""),
        emoji = String(reactionMessage.text || reactionMessage.Text || "");
      if (reactionChat && !groupReaction)
        reactionChat = await linkDirectChatJids(
          c,
          q.params.id,
          [reactionChat, chat, senderJid, senderAlt],
          reactionChat,
        );
      if (reactionChat && targetId && reactor) {
        if (!emoji || emoji === "remove")
          await c.query(
            "delete from message_reactions where instance_id=$1 and chat_jid=$2 and target_message_id=$3 and reactor=$4",
            [q.params.id, reactionChat, targetId, reactor],
          );
        else
          await c.query(
            "insert into message_reactions(instance_id,chat_jid,target_message_id,reactor,reactor_name,emoji) values($1,$2,$3,$4,$5,$6) on conflict(instance_id,chat_jid,target_message_id,reactor) do update set reactor_name=excluded.reactor_name,emoji=excluded.emoji,updated_at=now()",
            [
              q.params.id,
              reactionChat,
              targetId,
              reactor,
              fromMe ? "You" : String(i.PushName || i.pushName || ""),
              emoji,
            ],
          );
        notifications.push([
          "message",
          { instanceId: q.params.id, chatJid: reactionChat },
        ]);
      }
    } else if (eventKey === "groupinfo") {
      const eventGroup =
          d.groupData || d.GroupData || d.groupInfo || d.GroupInfo || d,
        groupJid = String(
          eventGroup.JID ||
            eventGroup.Jid ||
            eventGroup.jid ||
            eventGroup.GroupJID ||
            eventGroup.groupJid ||
            "",
        ),
        eventName = String(
          eventGroup.GroupName?.Name ||
            eventGroup.GroupName?.name ||
            (typeof eventGroup.GroupName === "string"
              ? eventGroup.GroupName
              : "") ||
            eventGroup.groupName?.name ||
            eventGroup.groupName?.Name ||
            (typeof eventGroup.groupName === "string"
              ? eventGroup.groupName
              : "") ||
            eventGroup.Name ||
            eventGroup.name ||
            eventGroup.Subject ||
            eventGroup.subject ||
            "",
        )
          .trim()
          .slice(0, 100);
      if (/@g\.us$/i.test(groupJid) && eventName) {
        await c.query(
          "update chats set name=$3 where instance_id=$1 and jid=$2 and is_group=true",
          [q.params.id, groupJid, eventName],
        );
        notifications.push([
          "message",
          { instanceId: q.params.id, chatJid: groupJid },
        ]);
      }
    } else if (revoke && chat && target) {
      const old = (
        await c.query(
          "select * from messages where instance_id=$1 and chat_jid=$2 and message_id=$3",
          [q.params.id, chat, target],
        )
      ).rows[0];
      if (old) {
        await c.query(
          "insert into versions(message_row,content_enc,media_id,deleted) values($1,$2,$3,$4)",
          [old.id, old.content_enc, old.media_id, old.deleted],
        );
        await c.query("update messages set deleted=true where id=$1", [old.id]);
        notifications.push([
          "message",
          { instanceId: q.params.id, chatJid: chat },
        ]);
      }
    } else if (/message/i.test(event.toLowerCase()) && chat && mid) {
      let mediaId = null,
        b64 =
          d.base64 ||
          m.base64 ||
          m.imageMessage?.base64 ||
          m.audioMessage?.base64 ||
          m.videoMessage?.base64 ||
          m.documentMessage?.base64;
      if (b64) {
        const raw = String(b64),
          buf = Buffer.from(
            raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw,
            "base64",
          );
        if (buf.length && buf.length < 24 * 1024 * 1024) {
          const mime = String(
              d.mimetype ||
                d.mimeType ||
                m.imageMessage?.mimetype ||
                m.audioMessage?.mimetype ||
                m.videoMessage?.mimetype ||
                m.documentMessage?.mimetype ||
                (raw.startsWith("data:")
                  ? raw.slice(5, raw.indexOf(";"))
                  : "application/octet-stream"),
            ).split(";")[0],
            id = crypto.randomUUID(),
            fn = id + ".bin",
            iv = crypto.randomBytes(12),
            ci = crypto.createCipheriv("aes-256-gcm", C.enc, iv),
            ct = Buffer.concat([ci.update(buf), ci.final()]),
            enc = Buffer.concat([iv, ci.getAuthTag(), ct]);
          fp = path.join(C.media, fn);
          await fsp.writeFile(fp, enc, { mode: 0o600, flag: "wx" });
          await c.query(
            "insert into media(id,file_name,mime,original,size) values($1,$2,$3,$4,$5)",
            [
              id,
              fn,
              mime,
              String(
                d.fileName ||
                  d.filename ||
                  m.documentMessage?.fileName ||
                  "media",
              ).slice(0, 200),
              buf.length,
            ],
          );
          mediaId = id;
        }
      }
      const content = seal(JSON.stringify({ text: txt(m), raw: clean(m) })),
        edit = Boolean(d.IsEdit || d.isEdit),
        old = (
          await c.query(
            "select * from messages where instance_id=$1 and chat_jid=$2 and message_id=$3 for update",
            [q.params.id, chat, mid],
          )
        ).rows[0],
        type = String(i.MediaType || i.Type || (mediaId ? "media" : "text")),
        ts = new Date(i.Timestamp || Date.now());
      if (old && edit) {
        await c.query(
          "insert into versions(message_row,content_enc,media_id,deleted) values($1,$2,$3,$4)",
          [old.id, old.content_enc, old.media_id, old.deleted],
        );
        await c.query(
          "update messages set content_enc=$2,media_id=coalesce($3,media_id),edited=true where id=$1",
          [old.id, content, mediaId],
        );
      } else
        await c.query(
          "insert into messages(instance_id,chat_jid,message_id,sender,sender_name,from_me,msg_type,content_enc,media_id,ts,status,sender_jid,sender_alt) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$13,$14) on conflict(instance_id,chat_jid,message_id) do update set content_enc=excluded.content_enc,edited=messages.edited or $12,sender_jid=coalesce(excluded.sender_jid,messages.sender_jid),sender_alt=coalesce(excluded.sender_alt,messages.sender_alt)",
          [
            q.params.id,
            chat,
            mid,
            String(i.Sender || ""),
            String(i.PushName || ""),
            fromMe,
            type,
            content,
            mediaId,
            isNaN(ts.getTime()) ? new Date() : ts,
            fromMe ? "sent" : "received",
            edit,
            senderJid,
            senderAlt,
          ],
        );
      await c.query(
        "insert into chats(instance_id,jid,name,is_group,last_at) values($1,$2,$3,$4,$5) on conflict(instance_id,jid) do update set name=case when excluded.name<> '' then excluded.name else chats.name end,last_at=greatest(chats.last_at,excluded.last_at)",
        [q.params.id, chat, chatName, isGroup, ts],
      );
      if (
        shouldQueueTelegramMessage({
          enabled: telegramEnabled,
          fromMe,
          edit,
          existing: old,
          eventName: event,
        })
      )
        await c.query(
          "insert into telegram_outbox(instance_id,chat_jid,message_id) values($1,$2,$3) on conflict(instance_id,chat_jid,message_id) do nothing",
          [q.params.id, chat, mid],
        );
      notifications.push([
        "message",
        { instanceId: q.params.id, chatJid: chat },
      ]);
    }
    await c.query("commit");
    for (const [type, data] of notifications) emit(type, data);
    r.sendStatus(200);
  } catch (e) {
    await c.query("rollback").catch(() => {});
    if (fp) await fsp.unlink(fp).catch(() => {});
    n(e);
  } finally {
    c.release();
  }
});
app.get("/internal/media/:token", async (q, r, n) => {
  try {
    const t = await pool.query(
      "delete from transfer_tokens where token_hash=$1 and expires_at>now() returning media_id",
      [hash(q.params.token)],
    );
    if (!t.rowCount) return r.sendStatus(404);
    const f = await getFile(t.rows[0].media_id);
    if (!f) return r.sendStatus(404);
    r.set({
      "Content-Type": f.m.mime,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    r.send(f.b);
  } catch (e) {
    n(e);
  }
});
async function health() {
  try {
    const rows = (
      await pool.query(
        "select id,status,qr_enc from instances where status<>'logged_out'",
      )
    ).rows;
    for (const i of rows) {
      try {
        const s = unwrap(await evoInstance(i.id, "/instance/status"));
        if (isInstanceConnected(s)) {
          if (i.status !== "connected" || i.qr_enc) {
            await pool.query(
              "update instances set status='connected',qr_enc=null,qr_expires=null,last_connected=now() where id=$1",
              [i.id],
            );
            emit("instance", { id: i.id, status: "connected" });
          }
          continue;
        }
        if (i.status === "needs_pairing") continue;
        health.last = health.last || {};
        if (Date.now() - (health.last[i.id] || 0) < 60000) continue;
        health.last[i.id] = Date.now();
        const t = rand();
        await pool.query(
          "update instances set webhook_hash=$2,status=$3 where id=$1",
          [i.id, hash(t), "connecting"],
        );
        await evoInstance(i.id, "/instance/connect", {
          method: "POST",
          body: {
            webhookUrl:
              "http://whatsapp-panel:3000/api/webhook/" +
              encodeURIComponent(i.id) +
              "/" +
              t,
            subscribe: ["ALL"],
            immediate: true,
          },
        });
      } catch (e) {
        console.warn("Instance health check:", e.message);
      }
    }
  } catch (e) {
    console.warn("Health check:", e.message);
  }
}
setTimeout(health, 5000).unref();
setInterval(health, 30000).unref();
setInterval(
  () =>
    pool
      .query(
        "delete from events where at < now() - interval '90 days'; delete from transfer_tokens where expires_at < now(); delete from sessions where expires_at < now() or last_seen < now() - interval '30 minutes'",
      )
      .catch(() => {}),
  3600000,
).unref();
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    index: "index.html",
    maxAge: "1h",
    setHeaders: (res, file) => {
      if (path.basename(file) === "index.html")
        res.setHeader("Cache-Control", "no-cache");
    },
  }),
);
app.get("*path", (q, r, n) =>
  q.path.startsWith("/api/") || q.path.startsWith("/internal/")
    ? r.sendStatus(404)
    : r.sendFile(
        path.join(__dirname, "..", "public", "index.html"),
        (e) => e && n(e),
      ),
);
app.use((e, q, r, n) => {
  if (r.headersSent) return n(e);
  console.error(
    q.method,
    q.path.startsWith("/api/webhook/") ? "/api/webhook/[redacted]" : q.path,
    e.message,
  );
  r.status(e.status || 500).json({
    error: e.status ? e.message : "internal_error",
  });
});
migrate()
  .then(() => {
    server.listen(C.port, "0.0.0.0", () =>
      console.log("WhatsApp Panel listening on " + C.port),
    );
    if (telegramEnabled) {
      console.log("Telegram notifications enabled");
      setTimeout(processTelegramOutbox, 1000).unref();
      setInterval(processTelegramOutbox, 1000).unref();
    } else if (C.telegramToken || C.telegramChatId)
      console.warn("Telegram notifications disabled: invalid configuration");
  })
  .catch((e) => {
    console.error("DB startup failed:", e.message);
    process.exit(1);
  });
process.on("SIGTERM", () => {
  server.close();
  pool.end().finally(() => process.exit(0));
});
