---
name: iphone-webkit-inspector
description: Inspect and drive Safari or Chrome on the user's real iPhone (USB or Wi-Fi) with DevTools-level access — open pages, snapshot elements and tap/type by ref, run JS, read console and network (headers, bodies, HAR, WebSockets), block or mock requests, matched CSS rules and box model, accessibility info, layers, cookies/storage/IndexedDB, breakpoints and stepping, screenshots and screen recording, and performance (Performance API timings, Chrome-format traces, JS CPU profiles, CPU/memory usage, heap snapshots). Use whenever something must be checked or debugged on a real iPhone or iOS Safari (iOS-only layout or 100vh bugs, touch, audio/video autoplay, Safari warnings, mobile performance), even if the user only says "on my phone", "아이폰에서 확인", "iOS에서 봐줘", "모바일 사파리", "실기기". Not for desktop Chrome (use Chrome DevTools) or WebKit/device emulation on the Mac (use Playwright).
argument-hint: "[what to check on the iPhone, e.g. a URL or 'why is this slow']"
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/ios.mjs *)
---

# iPhone WebKit Inspector

Playwright and Chrome DevTools can't attach to Safari on a real iPhone. This skill goes through Safari's Web
Inspector instead: `ios.mjs` runs a background daemon that starts the `pymobiledevice3` CDP bridge (via `uvx`),
keeps one connection per tab, and buffers console, network and debugger events.

## Running commands

Every command is `node ${CLAUDE_SKILL_DIR}/ios.mjs <command> [args]`. Always type that full path as the first
words of the Bash command, one command per call: that exact form is pre-approved while the skill is active, so it runs
without a permission prompt. A shell variable, `cd`, or a `&&` chain in front breaks the match and the user gets asked every time.
Below, `ios <command>` is shorthand for the full form.

Element targets (`<el>`): a CSS selector, `text=<label>`, `@e12` from `snapshot`, or `x y` coordinates.

The full command list with notes is in `references/commands.md`. Read it when you need a command not shown here or
the exact flags; `ios help` prints the same list.

## Before using

- `ios launch safari <url>` opens the URL in a new tab, but if a tab already shows that URL Safari brings that tab
  forward instead (and `close` can't close a tab the user opened). Check `ios tabs` after launching.
- The phone is on USB or the same Wi-Fi as the Mac (chosen automatically; `ios status` shows which), unlocked, with
  the browser in front. If `ios tabs` is empty or nothing is visible, try `ios launch safari`. If that doesn't help,
  run `ios doctor` and pass its ✗ fix on to the user rather than retrying.
- The first command starts the bridge (a few seconds). The first call on a tab can take 5–20s; after that ~10ms.
- A local dev server must listen on the LAN (`--host`); open `http://<Mac LAN IP>:<port>` (`ipconfig getifaddr en0`).
- iPhone Chrome works too (UA contains `CriOS`) once Chrome → Settings → Content Settings → Web Inspector is on and
  Chrome was restarted (`ios launch chrome --restart`).
- Other tabs can be the user's private pages (mail, banking, logins). Work only on the tab the user pointed at or a
  tab you opened yourself.

## How to work

Look before acting. `ios snapshot` lists what's on screen as `@eN` refs with role, name and box; act with
`ios tap @eN` / `ios type @eN <text>`. Refs reset on every snapshot and navigation, so snapshot again after the
page changes. If `tap` returns `covered: true`, nothing was tapped: snapshot again. If a command says the tab
closed, run `ios tabs` and `ios use` the right one; commands won't switch tabs on their own. `ios shot <path>` and reading the PNG is the fastest way to see the page; `ios shot <path> --device` shows the
whole screen as the user sees it, including Safari's address bar, toolbar and the keyboard.

Pick the tool by question:

| Question | Commands |
|---|---|
| What does it look like / why is it laid out that way? | `shot`, `shot --device` (whole screen with Safari's bars, for 100vh and keyboard issues), `dom <el>`, `styles <el> --computed`, `highlight <el>` |
| Is something broken? | `logs --errors`, `net --failed`, `req`/`body` |
| What does the app do on tap? | `listeners <el>`, `tap`, then `logs` / `net` |
| Why is it slow or janky? | `perf` first; `trace` around a reload for main-thread work; `profile` for hot JS; `fps 5` while it animates; `usage` for CPU/memory over time |
| What state is stored? | `cookies` (names only; `--values` when the user wants them), `storage local`, `idb` |
| Where does this JS go wrong? | `pause-on uncaught`, `break <url-part> <line>`, then `paused`, `step`, `frame-eval`, `resume` |
| How does it behave if…? | `mock`/`block`, `nocache on`, `media dark`, `ua <string>`, `js off`, `inject` |

Ask before anything destructive on the user's own tabs: `cookies --clear` and `storage --clear` can log them out
or wipe app state.

Some commands change the page on the phone. Undo them when done, because the user keeps using that tab:
`unmock`, `nocache off`, `media reset`, `ua reset`, `js on`, `inject --clear`, `paintflash off`, `highlight --off`,
`pause-on none`, `break clear`, `resume`, and `close` any tab you opened.

## Examples

**"아이폰에서 이 페이지 레이아웃 깨지는지 봐줘"**
```
ios launch safari https://example.com/pricing
ios shot                             → prints the PNG path; read the image
ios snapshot                         → find the element that overflows
ios dom @e9
ios styles @e9 --computed width,height,overflow
```
Report what's wrong, the CSS rule and file it comes from, and the screenshot path.

**"Why does the blog load slowly on my phone?"**
```
ios launch safari https://example.com/
ios tabs                             → check the new tab is current
ios perf --slow                      → TTFB, FCP, slowest resources
ios trace start
ios reload
ios trace stop                       → where time went, long events
```
Lead with the numbers, then name the biggest cost and the file that causes it.

## Limits

- Only the tab on the phone's screen renders. Background tabs still answer `eval`, `logs`, `net` and the debugger,
  but screenshots, recordings and snapshot boxes need the tab in front, and switching the visible tab isn't possible.
- `tap`/`type` are in-page events with WebKit's user-gesture emulation, which is enough for audio, fullscreen and
  popups. Safari's own UI, permission prompts, the keyboard, share sheets and the lock screen are out of reach; ask
  the user to do those.
- While the debugger is paused, the page is frozen and `eval` times out.
- A trace across a navigation to another site comes back nearly empty; trace a same-site reload.
- Safari on iOS 18 reports no LCP or CLS. There's no network or CPU throttling; for slow networks the user turns on
  Settings → Developer → Network Link Conditioner.
- If commands hang after the phone slept, `ios stop` and retry.

## When something breaks

If a command fails in a way that looks like a bug in this plugin (not a locked phone or a setting `doctor`
explains), say so and offer to report it. With the user's OK, run
`ios report --title "<summary>" --what "<command, expected, actual>"`. It writes a redacted report and prints a
prefilled GitHub issue link for `GUMBOKIM/iphone-webkit-inspector`. Give the user the link and the report path;
they read it and file the issue themselves. `report` runs `doctor`, which may bring Safari to the front and resets
which tab is current.

Daemon log: `~/.cache/iphone-webkit-inspector/daemon.log`.
