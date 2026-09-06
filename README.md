# שת"פ נולד — Business Matchmaker Game

Live-event networking game for **הבית לעסקים גליל מזרחי**. Pairs of participants play on their
phones, a projection screen shows the lobby QR, the live leaderboard, the anonymous judging and
the podium, and the host drives the flow from the projection page itself (or from a tablet showing
the same page).

Stack: Node.js + Express, vanilla JS, no build step. Dependencies: `express`, `qrcode`. No database,
no disk writes: the whole game lives in one in-memory object and is lost on restart (by design).

## ⚠️ Run exactly ONE instance

All state lives in the memory of a single process. **Two instances = two separate games**
with players randomly split between them. On Render keep the service at **1 instance**, never
enable autoscaling, and don't run a second copy locally against the same URL.

## Local run

```bash
npm install
npm start
# → http://localhost:3000
```

| Role | URL |
|------|-----|
| Players (phones) | `http://localhost:3000/` |
| Projection screen (with host controls) | `http://localhost:3000/screen` |
| Host tablet (same page, drives the same game) | `http://localhost:3000/host` |

The design puts every host control inside the projection screen (setup, launch, add a minute,
judging, export). `/host` serves the identical page so the host can operate from a tablet while
the projector shows `/screen`; both are live views of the same game.

To test with real phones on the same Wi-Fi, open `http://<your-LAN-IP>:3000/` on the phone
(find the IP with `ipconfig`). The lobby QR encodes whatever host the screen page was opened
with, so open `/screen` via the LAN IP too, or set `PUBLIC_URL` (below).

Optional environment variables:

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `3000` | Port to bind (Render sets this automatically). |
| `PUBLIC_URL` | request origin | Origin encoded in the QR codes, e.g. `https://matchmaker.onrender.com`. Set this on Render once you know the public URL. |

## Render deployment

1. Push this folder to a Git repo.
2. Render → **New → Web Service** → connect the repo.
3. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance count: **1** (see warning above)
4. Environment: add `PUBLIC_URL=https://<your-service>.onrender.com` (optional but recommended so
   the QR codes are right even behind proxies).
5. Deploy. Open `/screen` on the projector (or `/host` on a tablet) and follow the setup screen.

Notes:
- Free-tier services sleep after inactivity and take ~30–60 s to wake. Open the screen page a few
  minutes before the event. A restart wipes the game, so do not redeploy during the event.
- Server-Sent Events are used for realtime. Render supports long-lived connections; the server
  sends a heartbeat every 20 s. Clients auto-reconnect and fall back to polling if SSE fails.

## Businesses

The pool of businesses can come from two places:

1. **`businesses.json`** in the project root — loaded at startup as the default pool. It ships
   with 12 placeholder eastern-Galilee businesses. Replace the file and restart to change the default.
2. **Upload on the setup screen** (`/screen` or `/host`, before opening the lobby). The file
   replaces the pool in the server's memory for the current run only; it is not written to disk
   and is gone after a restart. The same screen has **⬇️ הורדת קובץ לדוגמה**, which downloads a
   ready-to-edit template in the expected structure (it also uploads as-is, to test the flow).

Both accept either shape:

```json
[{ "id": "b1", "name": "שם העסק", "description": "תיאור קצר" }]
```

or the spreadsheet export shape:

```json
[{ "שם העסק": "...", "פעילות עסקית – ניסוח קצר": "..." }]
```

Ids are assigned automatically, duplicate names are kept as separate entries, and stray
bidi/control characters are stripped. At least two valid entries are required.

## Game flow (for the host, all on the projection page)

1. **Setup**: choose the round length in minutes (− / +), optionally upload a businesses JSON,
   press **פתיחת הלובי 🚀**.
2. **Lobby**: the QR is shown; pairs scan, type their pair name and register. Press
   **🚀 הזנקת המשחק** (enabled from two registered pairs). A 3-2-1 countdown plays on every
   screen, then the round clock and each pair's 60-second decision timer start.
3. **Live**: the leaderboard animates every score change. **⏳ הוסף דקה לסבב** adds one minute,
   **⏸ השהיית הסבב** freezes the round and every pair timer (resume restores the exact remaining
   time), **⏹ סיום הסבב** ends the round early. When the clock hits zero the phones show
   "הסבב הסתיים" and the screen shows **⏭️ עבור לשלב השיפוט**.
4. **Judging**: one match at a time, anonymously; every other pair votes from their phone and the
   meter updates live. **⏭️ לשידוך הבא** adds the rounded average to the submitting pair; on the
   last match the button becomes **🏆 לפודיום**. **⏹ סיום השיפוט** ends judging early: the match
   on screen is scored, the ones after it stay unranked (blank score in the CSV) and the podium
   is shown.
5. **Podium**: top three with confetti; **📄 ייצא קובץ סיכום** downloads the CSV (the phones get
   the same download button).

**↺ איפוס המשחק** sits in the top-right corner of every screen and returns to setup, keeping the
uploaded business pool. Every destructive control (end round, end judging, reset) asks for
confirmation in an in-app dialog.

Scoring: skip −1, timeout −2 (running the clock out costs more than deciding), accepted
match +4 (with a ≤120-char argument), judging adds round(mean of 💡 +5 / 👍 +2 / ❌ −2),
0 if nobody voted. 3 lifelines (🛟) per pair swap one business with no penalty.

**Business uniqueness.** A business is never shown to the same pair twice, two pairs never
hold the same business at the same moment, and once a business is part of an accepted match
it is locked out of everybody’s game for the rest of the round. Draws fall back to looser
rules only when the pool runs dry mid-round — a repeat beats a dead screen — so size the pool
generously: a fast pair burns two businesses a minute, so budget roughly
`2 × pairs × round-minutes` businesses to keep every draw unique.

**Judging order.** Matches are judged round-robin — one from each pair in turn, then
everyone’s second, and so on — so no pair sits through another’s whole backlog. Pairs that
ran out of matches are skipped.

## API

```
POST /api/join                  { teamName } (player1/player2 optional) → { teamId, token }
GET  /api/state?role=&token=    state for the role (player needs token)
GET  /api/stream?role=&token=   Server-Sent Events, `event: state`, heartbeat every 20 s
POST /api/action/reject         { token }
POST /api/action/accept-open    { token }         freezes the pair timer while writing
POST /api/action/accept-cancel  { token }         resumes with the remaining time
POST /api/action/accept         { token, argument }
POST /api/action/lifeline       { token, slot: 1|2 }
POST /api/vote                  { token, matchId, value: 5|2|-2 }

GET  /api/host/businesses-template.json   sample businesses file for the host to edit
POST /api/host/businesses       { fileName?, businesses: [...] }   lobby only
POST /api/host/open-lobby       { roundSeconds }                   setup → QR lobby
POST /api/host/start            starts the 3.7 s countdown, then the round
POST /api/host/pause | resume | add-time (60 s) | end-round | judging | next-match | finish | reset
GET  /api/host/export.csv       UTF-8 BOM, all fields quoted, sorted by judging score
```

Every action is validated against the current phase; stale or out-of-phase requests get a
`400 { error, message }` with a Hebrew message. The server owns all timing and scoring.

`/host`, `/screen` and `/api/host/*` are currently open. To protect them, gate them on a single
env-var passcode (planned, not implemented).

## Tests

```bash
npm test              # unit tests for game.js + HTTP smoke test (boots the server on port 3101)
npm run test:browser  # end-to-end in headless Edge/Chrome via DevTools protocol (port 3102), screenshots in test/shots/
```

## Project layout

```
server.js          Express app, routes, SSE fan-out, tick loop, QR + CSV
game.js            state machine + scoring (pure functions, no I/O)
businesses.json    default business pool
design/            the Claude Design prototypes the UI was lifted from (reference only, not served)
public/
  player.html / screen.html          (screen.html is served at both /screen and /host)
  css/  player.css / screen.css
  js/   common.js (SSE + polling client, clock, API) / player.js / screen.js
  assets/ logo-mark.svg / logo-vertical.svg / logo.png
test/              unit.js, smoke.js, browser.js, fixtures/
```
