// Auto-slowmode bot: raises/lowers channel slowmode based on message rate.
// The slowmode feature needs no privileged intents. The optional mash-up feature reads message text,
// so it needs the Message Content intent (and is held behind the safety layer below).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

// ---- Load token from environment, or from a local .env file ----
(function loadEnv() {
  // Accepts either ".env" or "token.env" (whichever you created).
  for (const name of ['.env', 'token.env']) {
    try {
      const p = path.join(__dirname, name);
      if (!fs.existsSync(p)) continue;
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && !(m[1] in process.env)) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch (err) {
      console.warn(`Could not read ${name}:`, err.message);
    }
  }
})();

const cfg = require('./config.json');

// Optional chat mash-up feature, configured in markov.json (off if the file is missing).
let mk = {};
try {
  mk = require('./markov.json');
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') console.warn('Problem reading markov.json:', err.message);
}
mk = {
  enabled: false,
  mode: 'test', // "test" = nothing is posted until you approve it in the console; "live" = posts on its own
  auditLog: true,
  approvalExpireMinutes: 15,
  channelIds: [],
  useToday: false,
  timezone: 'UTC',
  backfillOnStart: true,
  bufferMinutes: 20,
  maxBufferedMessages: 400,
  minBufferedMessages: 15,
  chaosChance: 0.35,
  minWords: 4,
  maxWords: 30,
  autoPost: true,
  chancePerMessage: 0.02,
  minIntervalMinutes: 10,
  repeatChance: 0,
  typoChance: 0,
  topicChance: 0,
  replyToMentions: true,
  replyToReplies: true,
  replyPool: 'all',
  replyRelevantMax: 40,
  replyCooldownSeconds: 3,
  blockedWords: [],
  ...mk,
};
if (mk.mode !== 'live') mk.mode = 'test'; // anything other than "live" is treated as test mode

// ---- Validate config ----
const tiers = [...cfg.tiers].sort((a, b) => a.minMessagesPerMinute - b.minMessagesPerMinute);
if (tiers.length < 2) throw new Error('config.json needs at least 2 tiers.');
if (tiers[0].minMessagesPerMinute !== 0) {
  throw new Error('The first tier must have minMessagesPerMinute set to 0.');
}
for (const t of tiers) {
  if (t.slowmodeSeconds < 0 || t.slowmodeSeconds > 21600) {
    throw new Error('slowmodeSeconds must be between 0 and 21600 (Discord limit).');
  }
}

const windowMs = cfg.windowSeconds * 1000;
const calmMs = cfg.calmSeconds * 1000;
const minChangeMs = cfg.minChangeIntervalSeconds * 1000;

// ---- State: one entry per channel that has recent activity ----
const states = new Map(); // channelId -> state

function getState(id) {
  let st = states.get(id);
  if (!st) {
    st = { times: [], tierIdx: 0, lastChange: 0, calmSince: null, busy: false, warnedPerms: false, unmanaged: false };
    states.set(id, st);
  }
  return st;
}

const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (mk.enabled) intents.push(GatewayIntentBits.MessageContent); // privileged: enable it in the Developer Portal
const client = new Client({ intents });

function isWatched(channel) {
  if (channel.type !== ChannelType.GuildText) return false;
  if (cfg.ignoreChannelIds.includes(channel.id)) return false;
  if (cfg.watchChannelIds.length > 0 && !cfg.watchChannelIds.includes(channel.id)) return false;
  return true;
}

client.on('messageCreate', (message) => {
  if (!message.guild) return;
  if (cfg.ignoreBots && message.author.bot) return;
  if (!isWatched(message.channel)) return;
  getState(message.channel.id).times.push(Date.now());
});

async function applyTier(channel, st, newIdx, rate) {
  const seconds = tiers[newIdx].slowmodeSeconds;
  st.busy = true;
  try {
    await channel.setRateLimitPerUser(
      seconds,
      `Auto-slowmode: ~${Math.round(rate)} msgs/min`
    );
    console.log(`#${channel.name}: slowmode ${tiers[st.tierIdx].slowmodeSeconds}s -> ${seconds}s (~${Math.round(rate)} msgs/min)`);
    st.tierIdx = newIdx;
    st.lastChange = Date.now();
  } catch (err) {
    console.warn(`Could not change slowmode in #${channel.name}: ${err.message}`);
    st.lastChange = Date.now(); // back off before retrying
  } finally {
    st.busy = false;
  }
}

async function tick() {
  const now = Date.now();

  for (const [id, st] of states) {
    // Drop old timestamps and compute the current rate.
    while (st.times.length && st.times[0] < now - windowMs) st.times.shift();
    const rate = (st.times.length * 60000) / windowMs;

    const channel = client.channels.cache.get(id);
    if (!channel) { states.delete(id); continue; }
    if (st.busy) continue;

    // Need Manage Channels permission here.
    const me = channel.guild.members.me;
    const perms = me && channel.permissionsFor(me);
    if (!perms || !perms.has(PermissionFlagsBits.ManageChannels)) {
      if (!st.warnedPerms) {
        console.warn(`Missing Manage Channels permission in #${channel.name}; skipping it.`);
        st.warnedPerms = true;
      }
      continue;
    }
    st.warnedPerms = false;

    // Stay in sync with the channel's real slowmode (e.g. a mod changed it).
    const actual = channel.rateLimitPerUser ?? 0;
    if (actual !== tiers[st.tierIdx].slowmodeSeconds) {
      const idx = tiers.findIndex((t) => t.slowmodeSeconds === actual);
      if (idx !== -1) {
        st.tierIdx = idx;
        st.unmanaged = false;
      } else if (cfg.leaveManualSlowmodeAlone) {
        // A custom value that isn't one of our tiers: assume a human set it.
        st.unmanaged = true;
        continue;
      } else {
        st.tierIdx = 0;
      }
    }

    // Pick the highest tier whose threshold the current rate has reached.
    let targetIdx = 0;
    for (let i = 0; i < tiers.length; i++) {
      if (rate >= tiers[i].minMessagesPerMinute) targetIdx = i;
    }

    if (targetIdx > st.tierIdx) {
      // Chat is heating up: react quickly.
      st.calmSince = null;
      if (now - st.lastChange >= minChangeMs) await applyTier(channel, st, targetIdx, rate);
    } else if (
      targetIdx < st.tierIdx &&
      rate < tiers[st.tierIdx].minMessagesPerMinute * cfg.dropThresholdFraction
    ) {
      // Chat has cooled down: step down ONE tier, but only after staying calm for a while.
      if (st.calmSince === null) st.calmSince = now;
      if (now - st.calmSince >= calmMs && now - st.lastChange >= minChangeMs) {
        await applyTier(channel, st, st.tierIdx - 1, rate);
        st.calmSince = now;
      }
    } else {
      st.calmSince = null;
    }

    // Forget quiet channels that are back at the base level.
    if (st.tierIdx === 0 && st.times.length === 0 && !st.busy) states.delete(id);
  }
}

// ======================================================================================
// Safety layer: everything the mash-up says on its own goes through here.
//   - blocklist.txt / watchlist.txt filters (blocklist: never posted; watchlist: held for approval)
//   - no links, invites, GIFs or attachments are ever posted
//   - "test" mode: every message waits for your approval in the console
//   - audit.log records everything sent, held, approved, rejected and blocked
//   - kill switch: the console command "kill" (or a file named KILL) stops everything
// ======================================================================================
const { createFilter, loadList } = require('./filter');
const filter = createFilter({
  blocklist: [...loadList(path.join(__dirname, 'blocklist.txt')), ...mk.blockedWords.map(String)],
  watchlist: loadList(path.join(__dirname, 'watchlist.txt')),
});

const AUDIT_FILE = path.join(__dirname, 'audit.log');
const KILL_FILE = path.join(__dirname, 'KILL');
const isKilled = () => fs.existsSync(KILL_FILE);

function audit(event, details = {}) {
  if (!mk.auditLog) return;
  try {
    try {
      if (fs.statSync(AUDIT_FILE).size > 2 * 1024 * 1024) fs.renameSync(AUDIT_FILE, path.join(__dirname, 'audit.old.log'));
    } catch { /* no log yet */ }
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`);
  } catch (err) {
    console.warn('Could not write audit log:', err.message);
  }
}

const pending = new Map(); // id -> { t, channelId, name, text, replyTo, ping }
let pendingSeq = 0;

function mkHold(channel, text, opts, reason) {
  const now = Date.now();
  for (const [id, p] of pending) {
    if (now - p.t > mk.approvalExpireMinutes * 60000) {
      pending.delete(id);
      audit('expired', { id, channel: p.channelId, text: p.text });
    }
  }
  if (pending.size >= 20) {
    audit('dropped', { channel: channel.id, text, reason: 'approval queue full' });
    return;
  }
  const id = ++pendingSeq;
  pending.set(id, { t: now, channelId: channel.id, name: channel.name, text, replyTo: opts.replyTo || null, ping: Boolean(opts.ping) });
  audit('held', { id, channel: channel.id, text, reason });
  console.log(`[HELD #${id}] (#${channel.name}) ${reason}: "${text}"\n   -> type  approve ${id}  or  reject ${id}`);
}

async function mkSend(channel, text, opts = {}) {
  const payload = { content: text, allowedMentions: { parse: [], repliedUser: Boolean(opts.ping) } };
  if (opts.replyTo) payload.reply = { messageReference: opts.replyTo, failIfNotExists: false };
  await channel.send(payload);
}

// The single exit point for automatic messages.
async function mkDeliver(channel, text, opts = {}) {
  const where = { channel: channel.id, text };
  if (isKilled()) { audit('suppressed', { ...where, reason: 'kill switch is on' }); return false; }
  if (filter.hasLink(text)) { audit('blocked', { ...where, reason: 'contains a link' }); return false; }
  const bad = filter.blockedTerm(text);
  if (bad) { audit('blocked', { ...where, reason: `blocklist: ${bad}` }); return false; }
  const watch = filter.watchedTerm(text);
  if (mk.mode !== 'live' || watch) {
    mkHold(channel, text, opts, watch ? `watchlist: ${watch}` : 'test mode');
    return false;
  }
  await mkSend(channel, text, opts);
  audit('sent', { ...where, kind: opts.replyTo ? 'reply' : 'auto' });
  return true;
}

async function mkApprove(id) {
  const p = pending.get(id);
  if (!p) { console.log('No held message with that number (it may have expired).'); return; }
  if (isKilled()) { console.log('The kill switch is on. Type "resume" first.'); return; }
  pending.delete(id);
  const bad = filter.hasLink(p.text) ? 'link' : filter.blockedTerm(p.text);
  if (bad) {
    audit('blocked', { id, channel: p.channelId, text: p.text, reason: `failed re-check: ${bad}` });
    console.log(`Not sent: it matches the blocklist (${bad}).`);
    return;
  }
  try {
    const channel = await client.channels.fetch(p.channelId);
    await mkSend(channel, p.text, p);
    audit('approved', { id, channel: p.channelId, text: p.text });
    console.log(`Approved and sent #${id} to #${p.name}.`);
  } catch (err) {
    console.log(`Could not send #${id}: ${err.message}`);
  }
}

// ---- Chat mash-up (Markov chain) ----
// Keeps a short, in-memory buffer of recent messages from the channels you list (never written to disk,
// gone on restart) and stitches pieces of them together. Messages that contain links or anything on the
// blocklist/watchlist are never learned.
const mkBuffers = new Map(); // channelId -> [{ t, words }]
const mkLastPost = new Map(); // channelId -> timestamp
const mkPick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const mkUnsafe = (text) => filter.hasLink(text) || filter.blockedTerm(text) || filter.watchedTerm(text);

// Oldest message time the bot may draw from: start of today (in `timezone`) or `bufferMinutes` ago.
function mkCutoff() {
  if (!mk.useToday) return Date.now() - mk.bufferMinutes * 60000;
  let tz = mk.timezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.now() - ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000;
}

const MK_CUSTOM_EMOJI = /<a?:\w+:\d+>/g; // <:name:id> and <a:name:id>
const MK_UNICODE_EMOJI =
  /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu;

// Returns an array of words, or null if the message shouldn't be learned.
function mkClean(content) {
  if (!content) return null;
  if (/^\s*[!/.?$%&;~]/.test(content)) return null; // skip bot commands
  if (filter.hasLink(content)) return null; // never learn from messages with links
  const text = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<@[!&]?\d+>|<#\d+>/g, ' ') // user/role/channel mentions
    .replace(/@(everyone|here)/gi, ' ')
    .replace(MK_CUSTOM_EMOJI, ' $& ') // give emojis their own "word" so they mix freely
    .replace(MK_UNICODE_EMOJI, ' $& ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 400 || mkUnsafe(text)) return null;
  const words = text.split(' ');
  return words.length >= 3 ? words : null;
}

function mkLearn(channelId, words, t = Date.now()) {
  let buf = mkBuffers.get(channelId);
  if (!buf) { buf = []; mkBuffers.set(channelId, buf); }
  buf.push({ t, words });
  const cutoff = mkCutoff();
  while (buf.length && (buf[0].t < cutoff || buf.length > mk.maxBufferedMessages)) buf.shift();
}

// On startup, read today's earlier messages so the bot has material right away.
// Needs the View Channel and Read Message History permissions.
async function mkBackfill() {
  const cutoff = mkCutoff();
  for (const id of mk.channelIds) {
    try {
      const channel = await client.channels.fetch(id);
      if (!channel || !channel.isTextBased()) continue;
      const collected = [];
      let before;
      while (collected.length < mk.maxBufferedMessages) {
        const batch = await channel.messages.fetch({ limit: 100, before });
        if (batch.size === 0) break;
        let reachedOld = false;
        for (const m of batch.values()) {
          if (m.createdTimestamp < cutoff) { reachedOld = true; continue; }
          if (!m.author.bot) collected.push(m);
        }
        before = batch.last().id; // newest-first, so the last one is the oldest
        if (reachedOld) break;
      }
      collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp); // oldest first
      let learned = 0;
      for (const m of collected) {
        const words = mkClean(m.content);
        if (words) { mkLearn(id, words, m.createdTimestamp); learned++; }
      }
      console.log(`Mash-up: learned from ${learned} earlier messages in #${channel.name || id}.`);
    } catch (err) {
      console.warn(`Mash-up: could not read history for channel ${id}: ${err.message}`);
    }
  }
}

function mkWalk(msgs, order, cap, seed) {
  const chain = new Map();
  const starts = [];
  for (const { words } of msgs) {
    if (words.length < order) continue;
    starts.push(words.slice(0, order));
    for (let i = 0; i + order <= words.length; i++) {
      const key = words.slice(i, i + order).join(' ');
      const next = i + order < words.length ? words[i + order] : null; // null = end of a message
      if (!chain.has(key)) chain.set(key, []);
      chain.get(key).push(next);
    }
  }
  if (!starts.length) return null;

  let out = null;
  if (seed && seed.length) {
    // Jump in on something related to what was just said.
    const wanted = new Set(seed.map((w) => w.toLowerCase()));
    const keys = [...chain.keys()].filter((k) => wanted.has(k.split(' ')[0].toLowerCase()));
    if (keys.length) out = mkPick(keys).split(' ');
  }
  if (!out) out = [...mkPick(starts)];

  while (out.length < cap) {
    const options = chain.get(out.slice(-order).join(' '));
    if (!options) break;
    const next = mkPick(options);
    if (next === null) break;
    out.push(next);
  }
  return out;
}

// "teh", "wrod", "mesage": swap two letters or drop one. Only plain words, never emojis/mentions.
function mkDrunkTypo(word) {
  if (!/^[A-Za-z]{4,}$/.test(word)) return word;
  const i = 1 + Math.floor(Math.random() * (word.length - 2));
  if (Math.random() < 0.5) return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
  return word.slice(0, i) + word.slice(i + 1);
}

const MK_STOP = new Set(('that this with have what just your they them then than were been will would could should about ' +
  'there their from like dont cant know when where which while also very much more some into over only really still ' +
  'even because think going gonna thing things yeah okay').split(' '));

// Meaningful words (4+ letters, no filler) from a message, lowercase and de-duplicated.
function mkKeywords(words) {
  const cleaned = (words || []).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ''));
  return [...new Set(cleaned.filter((w) => w.length >= 4 && !MK_STOP.has(w)))];
}

// Returns a new mashed-up message, or null if there isn't enough recent chat yet.
// seedWords (optional) = words from the message that was just sent, to stay roughly on topic.
function mkGenerate(channelId, seedWords, focus = false) {
  // focus = true is used for replies to the bot: search the recent messages (across all
  // listed channels when replyPool is "all") for ones related to what was just said.
  const ids = focus && mk.replyPool === 'all' ? mk.channelIds : [channelId];
  const cutoff = mkCutoff();
  const allText = ids.flatMap((id) => (mkBuffers.get(id) || []).filter((m) => m.t >= cutoff));
  if (allText.length < mk.minBufferedMessages) return null;

  let textMsgs = allText;
  let focusSeed = null;
  if (focus) {
    const kws = mkKeywords(seedWords);
    if (kws.length) {
      const scored = allText
        .map((m) => {
          const lower = m.words.map((w) => w.toLowerCase());
          return { m, hits: kws.filter((k) => lower.some((w) => w.includes(k))).length, r: Math.random() };
        })
        .filter((x) => x.hits > 0)
        .sort((x, y) => y.hits - x.hits || x.r - y.r)
        .slice(0, mk.replyRelevantMax)
        .map((x) => x.m);
      if (scored.length) {
        // Related messages first, plus a random sample of everything else so sentences can wander.
        const extra = [...allText].sort(() => Math.random() - 0.5).slice(0, 80);
        textMsgs = [...new Set([...scored, ...extra])];
        focusSeed = kws;
      }
    }
  }
  const originals = new Set(textMsgs.map((m) => m.words.join(' ').toLowerCase()));
  const minWords = Math.max(2, mk.minWords);
  const maxWords = Math.max(minWords, mk.maxWords);

  // Sometimes just get stuck on one word: "react react react react react"
  if (Math.random() < mk.repeatChance) {
    const word = mkPick(textMsgs.flatMap((m) => m.words));
    const stuck = Array(4 + Math.floor(Math.random() * 6)).fill(word).join(' ');
    if (!mkUnsafe(stuck)) return stuck;
  }

  const seed =
    focusSeed ||
    (seedWords && Math.random() < mk.topicChance
      ? seedWords.filter((w) => /^[\p{L}\p{N}']{4,}$/u.test(w)) // meaningful words only
      : null);

  for (let attempt = 0; attempt < 15; attempt++) {
    // Order 2 follows the original wording closely (more coherent); order 1 jumps around (more chaotic).
    const order = Math.random() < mk.chaosChance ? 1 : 2;
    // Random length, skewed towards short.
    const cap = minWords + Math.floor(Math.random() ** 2 * (maxWords - minWords + 1));
    const out = mkWalk(textMsgs, order, cap, seed);
    if (!out || out.length < minWords) continue;
    const text = out.join(' ');
    const lower = text.toLowerCase();
    // Don't just repeat someone: skip exact copies, and long stretches lifted straight out of one message.
    if (originals.has(lower)) continue;
    if (out.length >= 5 && [...originals].some((o) => o.includes(lower))) continue;
    // Recombining safe words can still make something unsafe ("kill" + "yourself"): check the result too.
    if (mkUnsafe(text)) continue;
    const drunk = out.map((w) => (Math.random() < mk.typoChance ? mkDrunkTypo(w) : w)).join(' ');
    if (mkUnsafe(drunk)) continue;
    return drunk.slice(0, 1900);
  }
  return null;
}

// Is this message a Discord "reply" to one of the bot's own messages?
async function mkIsReplyToBot(message) {
  if (!mk.replyToReplies || !message.reference || !message.reference.messageId) return false;
  if ((message.reference.type ?? 0) !== 0) return false; // ignore forwards
  try {
    const original = await message.fetchReference();
    return original.author.id === client.user.id;
  } catch {
    return false;
  }
}

const mkLastForced = new Map(); // channelId -> timestamp

client.on('messageCreate', async (message) => {
  if (!mk.enabled || !message.guild || message.author.bot) return;
  const channelId = message.channel.id;
  if (!mk.channelIds.includes(channelId)) return;
  if (isKilled()) return; // kill switch: no learning, no talking

  const words = mkClean(message.content);
  if (words) mkLearn(channelId, words);

  const now = Date.now();
  const replyToBot = await mkIsReplyToBot(message);
  const mentioned = mk.replyToMentions && message.mentions.users.has(client.user.id);
  const forced = replyToBot || mentioned; // someone is talking to the bot: always answer
  const cooledDown = now - (mkLastPost.get(channelId) || 0) >= mk.minIntervalMinutes * 60000;
  const auto = mk.autoPost && cooledDown && Math.random() < mk.chancePerMessage;
  if (!forced && !auto) return;
  if (forced && now - (mkLastForced.get(channelId) || 0) < mk.replyCooldownSeconds * 1000) return;

  const text = forced
    ? mkGenerate(channelId, (message.content || '').split(/\s+/), true) || mkGenerate(channelId, [], false)
    : mkGenerate(channelId, words);
  if (!text) return;

  mkLastPost.set(channelId, now);
  if (forced) mkLastForced.set(channelId, now);
  try {
    await mkDeliver(message.channel, text, { replyTo: forced ? message.id : null, ping: replyToBot });
  } catch (err) {
    console.warn(`Could not deliver mash-up in #${message.channel.name}: ${err.message}`);
  }
});

// ---- Console commands (type these in the panel's console) ----
//   status                      Show mode, kill switch state, held messages
//   pending                     List messages waiting for your approval
//   approve <id> / reject <id>  Send or discard a held message
//   kill / resume               Emergency stop for the mash-up / turn it back on
//   mash <channelId> [test]     Make a mash-up now (held for approval in test mode); 'test' only previews it
//   say <channelId> <message>   Send a message as the bot (still checked against the blocklist)
//   cleanup <channelId> [n]     Delete the bot's own last n messages in a channel (default 10, max 50)
//   audit [n]                   Show the last n lines of audit.log
//   channels                    List text channels and their IDs
//   help                        Show commands
async function handleConsoleLine(line) {
  const input = line.trim();
  if (!input) return;
  const cmd = input.split(/\s+/)[0].toLowerCase();

  if (cmd === 'help') {
    console.log(
      'Commands:\n  status\n  pending\n  approve <id>\n  reject <id>\n  kill\n  resume\n  mash <channelId> [test]\n' +
      '  say <channelId> <message>\n  cleanup <channelId> [n]\n  audit [n]\n  channels\n  help'
    );
    return;
  }

  if (cmd === 'status') {
    console.log(
      `Mash-up: ${mk.enabled ? 'enabled' : 'disabled'} | mode: ${mk.mode.toUpperCase()}` +
      `${mk.mode === 'test' ? ' (nothing posts without approval)' : ''} | kill switch: ${isKilled() ? 'ON (paused)' : 'off'}\n` +
      `Held messages: ${pending.size} | blocklist entries: ${filter.counts.blocklist} | watchlist entries: ${filter.counts.watchlist}\n` +
      `Channels: ${mk.channelIds.join(', ') || '(none)'}`
    );
    return;
  }

  if (cmd === 'pending') {
    if (!pending.size) { console.log('Nothing is waiting for approval.'); return; }
    for (const [id, p] of pending) console.log(`#${id} (#${p.name}): "${p.text}"`);
    return;
  }

  if (cmd === 'approve' || cmd === 'reject') {
    const id = Number(input.split(/\s+/)[1]);
    if (!Number.isInteger(id)) { console.log(`Usage: ${cmd} <number>`); return; }
    if (cmd === 'approve') { await mkApprove(id); return; }
    const p = pending.get(id);
    if (!p) { console.log('No held message with that number.'); return; }
    pending.delete(id);
    audit('rejected', { id, channel: p.channelId, text: p.text });
    console.log(`Rejected #${id}.`);
    return;
  }

  if (cmd === 'kill') {
    try { fs.writeFileSync(KILL_FILE, `Kill switch turned on ${new Date().toISOString()}\n`); } catch (err) {
      console.log(`Could not create the KILL file: ${err.message}`);
    }
    pending.clear();
    mkBuffers.clear();
    audit('kill', {});
    console.log('KILL SWITCH ON. The mash-up has stopped talking and learning, held messages were discarded, and its memory was wiped.');
    console.log('It stays off across restarts until you type "resume" (or delete the file named KILL).');
    return;
  }

  if (cmd === 'resume') {
    try { fs.unlinkSync(KILL_FILE); } catch { /* already gone */ }
    audit('resume', {});
    console.log('Kill switch off. The mash-up will start learning again from new messages.');
    return;
  }

  if (cmd === 'audit') {
    const n = Math.min(Math.max(Number(input.split(/\s+/)[1]) || 10, 1), 100);
    try {
      const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n');
      console.log(lines.slice(-n).join('\n'));
    } catch {
      console.log('The audit log is empty or missing.');
    }
    return;
  }

  if (cmd === 'channels') {
    for (const guild of client.guilds.cache.values()) {
      console.log(`== ${guild.name} ==`);
      for (const ch of guild.channels.cache.values()) {
        if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
          console.log(`  #${ch.name}  ${ch.id}`);
        }
      }
    }
    return;
  }

  if (cmd === 'mash') {
    const m = input.match(/^mash\s+(\d{15,25})(\s+test)?\s*$/i);
    if (!m) { console.log('Usage: mash <channelId> [test]'); return; }
    if (!mk.enabled) { console.log('Mash-up is off. Set "enabled": true in markov.json and restart.'); return; }
    const text = mkGenerate(m[1]);
    if (!text) {
      console.log('Not enough recent messages from that channel yet (or it is not listed in markov.json channelIds).');
      return;
    }
    if (m[2]) { console.log(`Preview: ${text}`); return; }
    try {
      const channel = await client.channels.fetch(m[1]);
      const sent = await mkDeliver(channel, text);
      if (sent) console.log(`Sent mash-up to #${channel.name}: ${text}`);
    } catch (err) {
      console.log(`Could not send: ${err.message}`);
    }
    return;
  }

  if (cmd === 'cleanup') {
    const m = input.match(/^cleanup\s+(\d{15,25})(?:\s+(\d{1,2}))?\s*$/i);
    if (!m) { console.log('Usage: cleanup <channelId> [how many, up to 50]'); return; }
    const count = Math.min(Number(m[2]) || 10, 50);
    try {
      const channel = await client.channels.fetch(m[1]);
      const batch = await channel.messages.fetch({ limit: 100 });
      const mine = [...batch.values()].filter((x) => x.author.id === client.user.id).slice(0, count);
      for (const msg of mine) await msg.delete();
      audit('cleanup', { channel: m[1], deleted: mine.length });
      console.log(`Deleted ${mine.length} of the bot's recent messages in #${channel.name}.`);
    } catch (err) {
      console.log(`Could not clean up: ${err.message}`);
    }
    return;
  }

  if (cmd === 'say') {
    const m = input.match(/^say\s+(\d{15,25})\s+([\s\S]+)$/i);
    if (!m) { console.log('Usage: say <channelId> <message>'); return; }
    const [, channelId, rawText] = m;
    const text = rawText.replace(/\\n/g, '\n'); // type \n for a line break
    if (text.length > 2000) { console.log(`Message is ${text.length} characters; Discord's limit is 2000.`); return; }
    const bad = filter.blockedTerm(text);
    if (bad) { console.log(`Not sent: it matches the blocklist (${bad}). Edit blocklist.txt if that's a mistake.`); return; }
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
        console.log('That ID is not a channel I can send messages in.');
        return;
      }
      await channel.send({ content: text, allowedMentions: cfg.sayAllowMentions ? undefined : { parse: [] } });
      audit('say', { channel: channelId, text });
      console.log(`Sent to #${channel.name || channelId}.`);
    } catch (err) {
      console.log(`Could not send: ${err.message}`);
    }
    return;
  }

  console.log(`Unknown command "${cmd}". Type "help" for commands.`);
}

function startConsole() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    handleConsoleLine(line).catch((e) => console.error('Console command error:', e));
  });
}

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}. Watching chat activity...`);
  if (mk.enabled) {
    console.log(
      `Mash-up is ON in ${mk.mode.toUpperCase()} mode` +
      `${mk.mode === 'test' ? ': nothing is posted until you approve it with "approve <id>"' : ''}` +
      `${isKilled() ? ' (KILL SWITCH IS ON: paused)' : ''}.`
    );
    audit('startup', { mode: mk.mode, killed: isKilled(), channels: mk.channelIds });
  }
  console.log('Console ready. Type "help" for commands.');
  startConsole();
  if (mk.enabled && mk.backfillOnStart && !isKilled()) {
    mkBackfill().catch((e) => console.warn('Mash-up backfill failed:', e.message));
  }
  setInterval(() => tick().catch((e) => console.error('Tick error:', e)), cfg.checkIntervalSeconds * 1000);
});

client.on('error', (e) => console.error('Client error:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('No DISCORD_TOKEN found. Set it as an environment variable or in a .env / token.env file.');
  process.exit(1);
}
client.login(token);
