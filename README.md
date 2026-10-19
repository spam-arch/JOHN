# Auto-Slowmode Bot (with a locked-down chat mash-up)

Two features:
1. **Auto-slowmode.** Raises a text channel's slowmode when chat is busy and lowers it when it calms down. Reads no message text and needs no privileged intents. Tuned in `config.json`.
2. **Chat mash-up (optional).** Stitches pieces of recent chat into new sentences. It starts in **test mode**: nothing is posted until you approve it. Tuned in `markov.json`.

## Files
| File | What it is |
|---|---|
| `index.js` | The bot. |
| `filter.js` | The text filter and link detector. |
| `blocklist.txt` | Words and phrases the bot never learns from and never posts. Edit it. |
| `watchlist.txt` | Words the bot avoids; anything flagged is held for your approval. Edit it. |
| `config.json` | Slowmode settings. |
| `markov.json` | Mash-up settings (mode, channel IDs, etc). |
| `package.json` | Dependencies (discord.js). |
| `.env.example` | Copy to `.env` and fill in your bot token. |

Created while running: `audit.log` (a record of everything the mash-up sent, held, blocked or had approved) and a file named `KILL` when the kill switch is on.

## Setup
1. Discord Developer Portal > your app > **Bot**: reset the token and copy it. If the app was running on another host, resetting the token also cuts that old copy off.
2. Turn on **Message Content Intent** (only needed for the mash-up; leave `"enabled": false` in `markov.json` if you don't want it).
3. Invite permissions: **View Channels** and **Manage Channels** (slowmode). The mash-up also needs **Send Messages** and **Read Message History** in its channel. Don't grant more.
4. Upload everything in this archive to the host, in the main folder (not inside a subfolder).
5. Put your token in `.env` or `token.env` as `DISCORD_TOKEN=...`.
6. Start command: `node index.js`. Dependencies install with `npm install` (most panels do this automatically).

## Safeguards in the mash-up
- **No links, GIFs or attachments.** Messages containing links are never learned, and nothing containing a link, invite or domain-like text is ever posted. The bot never uploads files.
- **Blocklist** (`blocklist.txt`): explicit and abusive terms are never learned and never posted. Matching ignores capitals, symbols, stretched letters and lookalikes (`p0rn`, `p.o.r.n`, `pooorn`). Also checks the finished sentence, so recombinations like "kill" + "yourself" are caught.
- **Watchlist** (`watchlist.txt`): suggestive, self-harm, extremism and drug terms (and some emoji). Avoided when generating; if one still gets through, the message is held for approval instead of posted.
- **Test mode** (`"mode": "test"`, the default): every message is held. It shows in the console as `[HELD #3] ...`; type `approve 3` to send it or `reject 3` to discard it. Held messages expire after 15 minutes. Switch to `"mode": "live"` only after you have watched it for a while.
- **Audit log** (`audit.log`): one line per event, including the text and the reason it was blocked or held. It stores the bot's output only, never what members typed.
- **Kill switch**: `kill` in the console stops the mash-up from learning and talking, discards held messages, wipes its memory, and creates a `KILL` file so it stays off after restarts. `resume` (or deleting `KILL`) turns it back on. You can also just create a file named `KILL` in the folder.
- **Cleanup**: `cleanup <channelId> 20` deletes the bot's own last 20 messages in a channel.
- Pings are always blocked. The `say` command also refuses anything on the blocklist.

**Limits, honestly:** no word filter is perfect. A sentence made of harmless words can still be awkward or suggestive, and the starter lists are not complete and contain no slurs. Add your own terms, and for a large ready-made list in the same one-term-per-line format look up the open-source "LDNOOBW" list on GitHub. That is why test mode with approval is the default.

## Console commands
`status`, `pending`, `approve <id>`, `reject <id>`, `kill`, `resume`, `mash <channelId> [test]`, `say <channelId> <message>`, `cleanup <channelId> [n]`, `audit [n]`, `channels`, `help`.

## markov.json settings
| Setting | Meaning |
|---|---|
| `enabled` | Turns the mash-up on. |
| `mode` | `"test"` (everything needs approval) or `"live"`. |
| `channelIds` | Channels it learns from and posts in, as quoted strings. Keep this to one test channel at first. |
| `useToday` / `timezone` | Learn from everything since midnight (in an IANA timezone like `"Europe/London"`), or only the last `bufferMinutes`. |
| `backfillOnStart` | Read today's earlier messages on startup (needs Read Message History). |
| `maxBufferedMessages` / `minBufferedMessages` | How many messages it keeps, and how many it needs before it will speak. |
| `chaosChance` | 0 to 1. Higher = more nonsense. |
| `minWords` / `maxWords` | Length range, skewed short. |
| `autoPost`, `chancePerMessage`, `minIntervalMinutes` | Unprompted posting: on/off, chance per message, minimum gap. |
| `repeatChance`, `typoChance`, `topicChance` | Getting stuck on a word, typos, and starting from a word in the latest message. |
| `replyToMentions` / `replyToReplies` | Always answer when mentioned or replied to. |
| `replyPool` | `"all"` = search every listed channel when replying; `"channel"` = just that one. |
| `approvalExpireMinutes` | How long a held message waits. |
| `auditLog` | Write `audit.log`. |
| `blockedWords` | Extra blocked words, on top of `blocklist.txt`. |
