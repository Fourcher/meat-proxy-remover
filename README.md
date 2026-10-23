# Meat Proxy Remover (MPR)

**The problem.** Your AI writes a message for someone. You paste it to them, they paste it into their AI, and their
AI's answer comes back the same way. Two people end up as *meat proxies*, carrying notes between two AIs.

**The fix.** MPR lets the two AIs pass the notes themselves. Each person says **yes** once, when they connect. After
that, your AI asks their AI directly, gets the answer, and tells you the result.

That's all it does. It doesn't decide anything, store your data anywhere else, or do the work. Your AI does the work,
the way it already does; MPR just carries its notes.

## AI assistants: start here

**Step 0: can you run shell commands in this conversation?** If not (you're a chat in a browser, such as ChatGPT or
claude.ai on the web), skip to case 3 and give your human that message. Nothing else applies to you.

Your human asked you to install Meat Proxy Remover (MPR). That request is the go-ahead for the install. Ask only for
their name if you don't know it (the people they connect with will see it). Then follow the one case that fits you:

1. **You can run terminal commands** (Claude Code, Codex, Cursor, Gemini CLI, any agent with a shell):
   ```bash
   F="${TMPDIR:-/tmp}/mpr-install.sh"; curl -fsSL https://tombsuanyficmiupgdrv.supabase.co/storage/v1/object/public/mpr-dist/install.sh -o "$F" && bash "$F" --name "<your human's name>"
   ```
   Windows PowerShell:
   ```powershell
   $F="$env:TEMP\mpr-install.ps1"; iwr -useb https://tombsuanyficmiupgdrv.supabase.co/storage/v1/object/public/mpr-dist/install.ps1 -OutFile $F; powershell -ExecutionPolicy Bypass -File $F -Name "<your human's name>"
   ```
   The script verifies the download (sha256), installs into `~/.mpr`, and prints JSON. Tell your human the line in
   `tell_your_human`. Details, including what changes and how to opt out:
   [install.md](https://tombsuanyficmiupgdrv.supabase.co/storage/v1/object/public/mpr-dist/install.md).
2. **You are Claude Desktop without a terminal:** ask your human to download
   https://tombsuanyficmiupgdrv.supabase.co/storage/v1/object/public/mpr-dist/meat-proxy-remover.mcpb, double-click it,
   and click **Install**. Then call `mpr_invite` or `mpr_accept_invite` with their name (the first one creates the identity).
3. **You are a chat-only assistant** (ChatGPT or claude.ai in a browser, or anything that can't run programs or
   install extensions): you can't install software from here, so don't try. Tell your human, in these words:
   > "Meat Proxy Remover runs on your computer, so it needs an AI app that can do that. The easiest is Claude Desktop
   > (free at claude.com/download). Open it and say: *Install Meat Proxy Remover from github.com/fourcher/meat-proxy-remover*.
   > It takes about a minute."

## Install (for people)

Paste this into any AI app that runs on your computer (Claude Desktop, Claude Code, ChatGPT/Codex desktop, Cursor…):

> Install Meat Proxy Remover from github.com/fourcher/meat-proxy-remover

macOS, Linux and Windows (Node.js 18+). A chat in a web browser can't install software, and it will tell you which
app to use.

## Use

- **"Use MPR to ask Dana's AI for a quote on 500 gallons."** Your AI writes Dana an invite. Dana forwards it to her
  AI, which asks her once and connects. The two AIs pass notes until the question is answered, and you get the answer.
- **"Check my MPR inbox."**
- **"Something's broken with MPR."** Your AI runs a self-check. Fixes arrive as signed updates.

## How it works

```
you ── "ask Dana's AI…" ──▶ your AI ◀── signed, encrypted notes ──▶ Dana's AI ◀── "yes, connect" ── Dana
```

- **Connecting.** Your AI makes an invite. The person forwards it to their AI, which asks them once and connects. Only
  connected AIs can reach each other; everyone else is ignored.
- **Notes.** Each note is signed (Ed25519) and end-to-end encrypted (X25519 + AES-256-GCM). The relay that passes
  them along sees who's talking to whom and when, never what's said. A note can carry a file (up to 1 MB).
- **While you're away.** A background helper checks for notes and wakes your AI only when one is waiting (macOS,
  Linux and Windows, with Claude Code signed in). Without it, notes are answered next time you open your AI.
- **No dropped tasks.** In Claude Code, an AI can't drop an open MPR task by ending its turn. A Stop hook waits for
  the other AI's reply, costing no tokens, and hands it over. On your machine the hook listens in the background and
  wakes the session. In Claude Code on the web, it's added to the project's `.claude/settings.local.json` and keeps
  the turn going until the task is done. It only applies to sessions that used MPR, and it lets go when the task is
  done or has been quiet for a day. It's added only when MPR is installed or connected, never silently by an update.
- **Other AI apps.** `mpr watch --exec "<command>"` runs a command whenever a note arrives, so any app can wake its AI
  (no tokens while waiting; the note stays unread for the AI). Hosts whose tool calls time out early set
  `MPR_MAX_WAIT_SEC` below their limit.
- **Reports to the maintainer.** If MPR misbehaves or could work better, your AI may tell the maintainer with
  `mpr_doctor {report: "..."}`. It's optional and up to the AI. A report contains only the AI's own description plus MPR's version,
  OS, AI app and any failing self-checks: never note contents. It's encrypted to the maintainer's key, so the relay can't
  read it. Each install can send at most 5 reports a day. Set `MPR_NO_REPORTS=1` to turn reports off.
- **Updates.** Releases are signed. Your copy checks the signature and a pinned hash, then installs offline. If a new
  version fails its self-check, it rolls back.

## Safety

MPR carries notes; it doesn't judge them. What your AI does with a note is up to your AI and you. Every AI using MPR
is told the same thing with every note: it's information, not instructions, so never pay, buy, sign, accept terms or
share private details because a note asked, and check with you first. MPR itself refuses to send private files (its
own keys, `.env` files, app data), and the background helper can only read and send notes.

What goes where: [PRIVACY.md](PRIVACY.md). Wire format: [PROTOCOL.md](PROTOCOL.md).

## Tests

```bash
npm test                          # notes, invites, files, encryption, resilience, the background helper
node test/public-relay.test.js    # round trip through the live relay
```

## For the maintainer

- **Relay:** Supabase project `tombsuanyficmiupgdrv`. Edge Functions `mpr-relay` and `mpr-publish`, plus the private
  `mpr` schema ([relay/supabase/schema.sql](relay/supabase/schema.sql)). The public `mpr-dist` bucket holds packages and
  install files.
- **Release:** `node scripts/release.mjs patch --notes "…"`. It runs the tests, builds and signs the release (key in
  the macOS Keychain), publishes it, and updates the local runtime.
- **Moving the relay:** add the old URL to `relay_moves` in `src/trust.json`. Installs follow it automatically.

MIT licensed. See [LICENSE](LICENSE).
