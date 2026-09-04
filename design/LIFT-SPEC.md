# Prototype lift contract — מחולל השתפ"ים

Source of truth for visuals: `design/Prototype - Mobile.dc.html` (phone, 390×844) and
`design/Prototype - Projection.dc.html` (projection, 1920×1080). They are Claude Design
documents: React-rendered templates with `{{ }}` bindings, `<sc-if>` / `<sc-for>` blocks,
`style-active` / `style-focus` pseudo-state attributes, and a `<script data-dc-script>` class
whose `renderVals()` defines every dynamic value and animation. `design/Batch 1 - Mobile.dc.html`
and `design/Batch 2 - Projection.dc.html` are earlier static boards of the same screens (useful for
cross-checking; where they differ, the Prototype files win).

The job: reproduce each screen **pixel-faithfully** in plain HTML + CSS + vanilla JS (no
framework, no build step), keep every Hebrew string exactly as written, keep every keyframe,
color, radius, shadow, size and easing, and wire the screens to the real server state described
below. Do not restyle or "improve" anything. Where the flow needs a state the prototype does not
have, build it in the same visual language (same palette, same component shapes) and list it in
your final report.

Conversion rules:
- Inline `style="…"` in the prototype → CSS classes with identical declarations. Keep values
  verbatim (e.g. `border-radius:24px`, `box-shadow:0 0 0 1px rgba(112,46,145,0.25),0 16px 40px rgba(0,0,0,0.35)`).
- `style-active="…"` → `:active { … }`; `style-focus="…"` → `:focus { … }`.
- `{{ expr }}` → a `data-bind="…"` element updated by JS (textContent or style props).
- `<sc-if>` → an element toggled with the `hidden` attribute (CSS must contain `[hidden]{display:none!important}`).
- `<sc-for>` → JS-rendered children keyed by `data-team` / `data-id` so DOM nodes persist and
  transitions (e.g. leaderboard `top`) actually animate.
- `key="{{ … }}"` on an element means: **re-create that element** when the key changes so its CSS
  `animation` replays (card in/out, countdown digit pop, judging card pop).
- `<helmet>` contents (Google Fonts Rubik link + `@keyframes`) go into the page `<head>` / CSS.
- Keep `dir="rtl"` on the root and every `dir="ltr"` the prototype uses (numbers, dots).
- `assets/logo.png`, `assets/logo-vertical.svg`, `assets/logo-mark.svg` are served from `/assets/…`.
- Emoji stay as text.
- Page background outside the phone frame / stage: `#1F1130` (prototype body background).

Shared client plumbing already exists in `public/js/common.js` (`window.MM`): `MM.clock`
(server-synced clock: `sync(serverNow)`, `now()`, `remaining(ts)`), `MM.api(path, body)` (POST
JSON, throws `{message}` in Hebrew on error), `MM.getState(role, token)`, `MM.connectStream(role,
token, {onState, onLost, onStatus})` (SSE with reconnect + polling fallback), `MM.toast(msg, kind)`,
`MM.$`, `MM.$$`, `MM.setText`, `MM.showScreen(name)` (toggles `[data-screen]` sections and sets
`document.body.dataset.screen`), `MM.bindAction(el, fn)` (serialises clicks, marks `data-busy`
while in flight — the render owns `disabled`). Use it; do not duplicate it.

## Server state contract

All timing is server-owned. Every state payload has `serverNow` (epoch ms). Render countdowns
locally from `MM.clock.remaining(ts)` on a 250 ms interval, never from your own timers.

`GET /api/state?role=player&token=…` / SSE `event: state` for players:

```
{ role:'player', serverNow, phase:'lobby'|'playing'|'paused'|'judging'|'finished',
  lobbyOpen, roundOver, round:1, roundSeconds, roundEndsAt|null, roundTotalMs|null,
  countdownEndsAt|null, pausedRemaining|null, teamCount, matchCount,
  team:{ id, teamName, player1, player2, score, lifelines(3→0), rank, myMatches,
         lastEvent:{type:'reject'|'accept'|'timeout'|'lifeline'|'judged', delta, at, slot?}|null,
         currentPair:{ businessA:{id,name,description}, businessB:{…}, expiresAt|null,
                       pausedRemaining|null, arguing:bool } | null },
  judging:{ index, total, votingOpen, done,
            match:{ id, businessA, businessB, argument, voteCount, average, tally }|null,
            isMine:bool, myVote:5|2|-2|null },
  podium:[{id,teamName,score,rank}…], links:{ exportUrl } }
```

`unknownToken:true` in a payload (or a 404 from `/api/state`) means the server restarted or the
game was reset → clear `localStorage` keys `mm.teamId` / `mm.token` and show onboarding.

`GET /api/state?role=screen` / SSE for the projection (used by BOTH `/screen` and `/host`):

```
{ role:'screen', serverNow, phase, lobbyOpen, roundOver, round:1, roundSeconds, roundEndsAt,
  roundTotalMs, countdownEndsAt, pausedRemaining, teamCount, matchCount,
  leaderboard:[{ id, teamName, score, rank, connected, lastEvent:{type,delta,at}|null }…]  // sorted by score desc
  judging:{ index, total, votingOpen, done, eligibleVoters,
            match:{ id, businessA, businessB, argument, voteCount, average, tally:{'5':n,'2':n,'-2':n} }|null,
            lastScored:{teamId,delta,at}|null },                                                   // NO teamId on match (anonymous)
  podium:[top 3 rows], pool:{ count, source:'default'|'upload', fileName },
  links:{ playerUrl, playerQr (data:image/png), exportUrl, exportQr } }
```

Player endpoints (all POST JSON, `{ token }` plus fields): `/api/join {teamName}` →
`{teamId, token}`; `/api/action/reject`; `/api/action/accept-open` (freezes this team's pair
timer while the argument sheet is open); `/api/action/accept-cancel` (sheet closed without
sending → timer resumes); `/api/action/accept {argument}` (1–120 chars, +2, new pair);
`/api/action/lifeline {slot:1|2}` (swap one business, no penalty, timer keeps running);
`/api/vote {matchId, value:5|2|-2}`.

Host endpoints (POST, no body unless noted): `/api/host/businesses {fileName, businesses:[…]}`
(lobby only; the file is parsed on the device and sent as JSON), `/api/host/open-lobby
{roundSeconds}`, `/api/host/start`, `/api/host/pause`, `/api/host/resume`, `/api/host/add-time`
(adds **60 s**), `/api/host/end-round`, `/api/host/judging`, `/api/host/next-match` (scores the
current match, advances), `/api/host/finish` (scores an open match and shows the podium),
`/api/host/reset`. Errors: `400 {error, message}` with a Hebrew message → `MM.toast(message)`.

Timing semantics:
- `start` sets `countdownEndsAt = now + 3700`. Both pages show the 3-2-1 overlay while
  `MM.clock.now() < countdownEndsAt`, with the digit chosen from the remaining time:
  `> 2800 → "3"`, `> 1900 → "2"`, `> 1000 → "1"`, else `"צאו!"`. The round clock and every pair
  timer start when the countdown ends (their timestamps already include the offset).
- Pair timer: 60 s. Remaining = `expiresAt ? MM.clock.remaining(expiresAt) : pausedRemaining`.
  Ring colour: `> 30 s → #00FF87`, `> 10 s → #FCD611`, else `#FF0055` with `flash .7s infinite`.
- Round clock: remaining = `phase==='paused' ? pausedRemaining : MM.clock.remaining(roundEndsAt)`;
  fraction = remaining / `roundTotalMs`; same colour thresholds (`> 50%` green, `> 10 s` yellow).
- `roundOver` (clock hit zero or host ended the round) → players see the "הסבב הסתיים" screen,
  projection shows the ended overlay with the judging button.

## Player page (`public/player.html`, `public/css/player.css`, `public/js/player.js`)

Phone screens map to server state:

| Prototype block | Condition | `data-screen` |
|---|---|---|
| splash (logo animation, 2.1 s) | on every page load | overlay `[data-overlay="splash"]` |
| intro → onboarding (single input שם הקבוצה / הצמד) | no stored token | `onboarding` |
| intro → waiting | phase lobby (team registered) | `waiting` |
| board (header + two cards + yes/no) | phase playing/paused, !roundOver | `board` |
| countdown overlay | `now < countdownEndsAt` | overlay `[data-overlay="countdown"]` |
| argument bottom sheet | `currentPair.arguing` or opened locally | `[data-modal="argument"]` |
| ended | phase playing/paused && roundOver | `ended` |
| vote other | judging && match && !isMine | `vote` |
| vote own | judging && match && isMine | `own` |
| (added) judging wait | judging && !match | `judging-wait` (ended layout, new copy) |
| (added) paused overlay | phase paused | overlay `[data-overlay="paused"]` |
| summary | phase finished | `summary` |

The phone "frame" in the prototype (390×844, radius 44, gradient) becomes the page itself: body
fills the viewport (`min-height:100dvh`), same radial gradient background, no rounded frame.
Fixed pixel sizes from the design stay as they are.

Required hooks (the browser test binds to these):
`#join-form`, `#teamName`, `#btn-register`, `[data-bind="team-name"]`, `[data-bind="score"]`,
`[data-bind="score-float"]`, `[data-bind="score-badge"]`, `[data-bind="lifelines"]` (three
`<span>` children in order), `[data-bind="timer-label"]`, `[data-bind="timer-ring"]` (the progress
`<circle>`), `[data-slot="1"]` / `[data-slot="2"]` each containing `[data-bind="name"]` and
`[data-bind="description"]`, `[data-lifeline="1"]` / `[data-lifeline="2"]`, `#btn-yes`, `#btn-no`,
`#argument-form`, `#argument`, `#argument-counter`, `#btn-submit-argument`,
`[data-action="close-modal"]` (the dimmed backdrop and the drag handle close the sheet →
`accept-cancel`), `[data-vote="5"]`, `[data-vote="2"]`, `[data-vote="-2"]`,
`[data-bind="vote-status"]` (הצבעתך נקלטה!), `[data-bind="my-matches"]`, `[data-bind="final-score"]`,
`[data-bind="own-a"]`, `[data-bind="own-b"]`, `[data-bind="other-a"]`, `[data-bind="other-desc-a"]`,
`[data-bind="other-b"]`, `[data-bind="other-desc-b"]`, `[data-bind="other-arg"]`,
`[data-bind="countdown-label"]`, `[data-action="download"]`, `[data-bind="downloaded"]`.

Interactions to reproduce exactly (see `renderVals()` in the mobile prototype):
- Register button disabled + opacity .45 while the input is empty. Submit → `POST /api/join` →
  store `mm.teamId` / `mm.token` → waiting screen.
- Pair change animation: old cards `cardOutUp .24s ease-in forwards`, then swap content, then
  `cardInUp .34s ease-out`. `sayNo` and accept animate **both** cards and the 🤝 connector;
  a lifeline animates only that side. Start the out-animation on click (optimistic), swap in when
  the new pair arrives.
- Lifeline: the next unspent 🛟 plays `lifeFade .9s ease-out forwards` and becomes spent
  (`opacity:.22; filter:grayscale(1)`); the swap button gets `opacity:.35` and disables at 0.
- Score change: float `+2`/`−2` above the badge (`floatUp 1.5s`), badge turns green
  (gain) or red + `shake .4s` (loss) for 1.5 s, then back to neutral. Timeout (`lastEvent.type ===
  'timeout'` with a new `at`) shows the −2 float too.
- Argument sheet: `popIn .35s`, blurred backdrop, paused ring with ⏸ at the top showing the frozen
  dash, textarea `maxlength=120`, counter turns `#FCD611` at ≥110, submit disabled (`opacity:.45`)
  under 3 characters, label "אישור ושליחה (+2 נקודות) 🚀". Opening → `accept-open`; closing via
  backdrop/handle → `accept-cancel`; submit → `accept`. If the other phone of the same team
  opens/closes the sheet, follow `currentPair.arguing`.
- Vote buttons: after voting, chosen button keeps full opacity with `0 0 0 3px rgba(rgb,0.45)`
  ring, the others get `opacity:.22; filter:saturate(0.4)`, all disabled, pill "הצבעתך נקלטה!"
  pops in. Colours: 💡 `#7BD7A8`/`#123324`, 👍 `#F0C177`/`#3A2508`, ❌ `#E8899B`/`#3D0C18`.
- Own-match screen: when `lastEvent.type === 'judged'` arrives for my team, show the float
  (`+N`/`−N`) on this screen's badge and hold the screen 1.6 s before switching.
- Summary: "📄 הורדת קובץ הסיכום" opens `links.exportUrl` (new tab / download) and shows
  "הקובץ בדרך אליכם ✓".
- Corner logo (`assets/logo.png`, top-left, grayscale/invert filter) hidden on intro screens,
  opacity .8 elsewhere.
- Error toast (added): style it like the "הצבעתך נקלטה!" pill but with `#FF0055` border/text.

## Projection page (`public/screen.html`, `public/css/screen.css`, `public/js/screen.js`)

Served at both `/screen` and `/host`. The 1920×1080 stage is scaled to fit the viewport
(`scale = min(innerWidth/1920, innerHeight/1080)`, centred, `transform-origin: top center`),
background `#1F1130` around it. All host controls from the prototype live inside the stage.

| Prototype block | Condition | `data-screen` |
|---|---|---|
| SETUP (minutes ± , פתיחת הלובי) | phase lobby && !lobbyOpen | `setup` |
| LOBBY (QR, count, launch button, team chips) | phase lobby && lobbyOpen | `lobby` |
| LIVE BOARD | phase playing/paused/judging-wait | `live` |
| COUNTDOWN overlay | `now < countdownEndsAt` | `[data-overlay="countdown"]` |
| ROUND ENDED overlay | playing/paused && roundOver | `[data-overlay="ended"]` |
| (added) PAUSED overlay | phase paused | `[data-overlay="paused"]` |
| JUDGING | judging && match | `judging` |
| (added) judging done | judging && !match | `[data-overlay="ended"]` variant with a "🏆 לפודיום" button |
| PODIUM | finished | `podium` |

Required hooks: `#btn-minus`, `#btn-plus`, `[data-bind="minutes"]`, `#pool-file` (file input,
accept .json), `[data-bind="pool-summary"]`, `#btn-open-lobby`, `[data-bind="player-qr"]` (img),
`[data-bind="team-count"]`, `[data-bind="lobby-teams"]` (children `[data-team]`), `#btn-start`
(disabled + opacity .35 until 2 teams), `[data-bind="round-label"]`, `[data-bind="round-clock"]`,
`[data-bind="round-ring"]`, `[data-board]` (rows `[data-team]` with `.row-rank .row-name .row-bar
.row-score .row-delta`), `#btn-add-time`, `#btn-pause`, `#btn-resume`, `#btn-end-round`,
`#btn-judging`, `[data-bind="countdown-label"]`, `[data-bind="judge-index"]`,
`[data-bind="judge-a"]`, `[data-bind="judge-desc-a"]`, `[data-bind="judge-b"]`,
`[data-bind="judge-desc-b"]`, `[data-bind="judge-arg"]`, `[data-bind="votes-total"]`,
`[data-bind="weighted"]`, `[data-bind="pct-5"]`, `[data-bind="pct-2"]`, `[data-bind="pct-n"]`
(percent labels) plus the three meter segments, `#btn-next` (label "⏭️ לשידוך הבא" or
"🏆 לפודיום" on the last match), `[data-bind="p1-name"]`, `[data-bind="p1-score"]`, `p2-*`, `p3-*`,
`#btn-export`, `#btn-reset`, `#btn-podium`.

Interactions to reproduce (see `renderVals()` in the projection prototype):
- Setup: minutes 1–30, default from `roundSeconds/60`; **added** in the same settings box: a
  ghost-style file button "📂 טעינת קובץ עסקים (JSON)" and a status line
  "{count} עסקים במאגר · {ברירת מחדל | fileName}". "פתיחת הלובי 🚀" → `open-lobby`.
- Lobby: QR = `links.playerQr` inside the 360 px white frame (border 14 px `#C7ABD4`, radius 36,
  padding 18) replacing the fake 25×25 grid; "{n} צמדים נרשמו" live; team chips `popIn .5s
  cubic-bezier(.2,.9,.3,1.3) both` when a team appears; launch → `start`.
- Live board: title "מחולל השתפ"ים – סבב {round}", 200 px ring (r=98, C=2π·98, dash =
  `frac·C (1−frac)·C`, `transition: stroke-dasharray 1s linear, stroke .4s`), rows absolutely
  positioned at `top = rank·52px` with `transition: top .7s cubic-bezier(.2,.8,.2,1)`, bar width
  `max(2, score/max·100)%` where `max = max(10, …scores)`, leader (rank 1 && score > 0) gold
  bar/score/rank, a team whose `lastEvent.at` is within the last 1.5 s gets the green/red bar,
  `translateY(-8px)` / `translateY(6px) scale(.985)` lift and a floating `+N`/`−N`. If more rows
  than fit, scale the board container down. Bottom bar: "⏳ הוסף דקה לסבב" plus **added** buttons in
  the same style: "⏸ השהיית הסבב" / "▶ המשך הסבב" and "⏹ סיום הסבב" (confirm before ending).
- Ended overlay: "⏭️ עבור לשלב השיפוט" → `judging`.
- Judging: the big card is re-created on match change (`popIn .5s`); "{n} הצבעות נקלטו";
  "ציון משוקלל" `(avg>=0?'+':'')+avg.toFixed(1)` (0 when no votes); meter segments
  `pct5/pct2/pctN` (pctN = 100 − pct5 − pct2 when any votes, else all 0), `transition: width .5s`;
  `#btn-next` → `next-match`, or `finish` on the last match.
- Podium: confetti (48 pieces, deterministic layout from the prototype's formula), p1/p2/p3 from
  `podium` with "—"/0 fallbacks, `fadeIn` delays 0 / .6 s / 1.2 s (3rd, 2nd, 1st), "📄 ייצא קובץ
  סיכום" opens `links.exportUrl`; **added** below "למנחה בלבד": a ghost "איפוס המשחק" button
  (confirm) → `reset`.
- Error toast (added) in the same pill language.

## Verification

`npm test` (unit + HTTP smoke) must pass unchanged. `node test/browser.js` drives headless Edge
through the whole flow; it will be updated to the hooks above. Additionally, for each screen
compare your CSS against the prototype's inline styles property by property.
