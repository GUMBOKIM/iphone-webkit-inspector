---
name: iphone-webkit-inspector
description: Inspect and drive Safari or Chrome on the user's real iPhone (USB or Wi-Fi) with DevTools-level access — open pages, snapshot elements and tap/type by ref, run JS, read console and network (headers, bodies, HAR, WebSockets), block or mock requests, matched CSS rules and box model, accessibility info, layers, cookies/storage/IndexedDB, breakpoints and stepping, screenshots and screen recording, and performance (Performance API timings, Chrome-format traces, JS CPU profiles, CPU/memory usage, heap snapshots). Use whenever something must be checked or debugged on a real iPhone / iOS Safari (iOS-only layout or 100vh bugs, touch, audio/video autoplay, Safari warnings, mobile performance), or when the user says "아이폰에서 확인", "iOS에서 봐줘", "모바일 사파리", "실기기".
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/ios.mjs *)
---

# iPhone WebKit Inspector

Playwright can't drive Safari on a real iPhone. This goes through Safari's Web Inspector instead: `ios.mjs` runs a
background daemon that starts the `pymobiledevice3` CDP bridge (via `uvx`, nothing installed globally), keeps one
connection per tab, and buffers console, network and debugger events.

Run it as `node ${CLAUDE_SKILL_DIR}/ios.mjs <command>`. Written out in full, that form is pre-approved, so there's
no permission prompt. `$I` below is shorthand for that path. `help` lists every command.

**Element targets** (`<el>`): a CSS selector, `text=<label>`, `@e12` from `snapshot`, or `x y` coordinates.

```bash
I="${CLAUDE_SKILL_DIR}/ios.mjs"

# setup and pages
node $I doctor                      # Xcode, iPhone, Developer Mode, Web Inspector (~1 min)
node $I launch safari|chrome [url]  # bring the browser up; with a url it opens a new tab
node $I tabs | use <id|url-part>    # list tabs ("visible" = on screen) | pick one
node $I open <url> | reload | close
node $I snapshot [--all]            # what's on screen as @eN refs: role, name, state, box
node $I tap @e7 | tap text=로그인 | type 'input[name=q]' hello
node $I eval 'document.title'       # statements need `return`; `await` works; --gesture = user gesture
node $I shot out.png | record start dir/ … record stop

# elements
node $I dom <el> | styles <el> [--computed color,font-size] | a11y <el>
node $I highlight <el> | highlight --off | pseudo <el> hover,focus | pseudo <el> off
node $I listeners <el> | layers

# console and network
node $I logs [--errors] | net [url-part] [--failed] | req <id> | body <id> [--out f]
node $I har out.har | ws | events [Method.prefix]
node $I block <url-part> | mock <url-part> <status> <body|@file> [--type ct] | mocks | unmock
node $I nocache on|off

# sources and debugger
node $I scripts [url-part] | source <id|url-part> [--line n] [--out f]
node $I break <url-part> <line> [--if expr] | break list | break clear
node $I pause-on uncaught|all|none | pause | paused | step over|into|out | frame-eval <js> | resume

# application
node $I cookies [--clear [name]] | storage local|session [--clear] | idb

# performance
node $I perf [--slow]                                   # TTFB, DCL, load, FCP, CLS + resource waterfall
node $I trace start … reload or interact … trace stop out.json
node $I profile start … profile stop out.cpuprofile
node $I usage start … usage stop | heap out.heapsnapshot

# rendering and environment
node $I media dark|light|print|reset | paintflash on|off | ua <string>|reset | js off|on
node $I inject '<js>' | inject --clear

node $I cdp <Method> '<json>'       # anything else; unknown methods go to WebKit's own protocol
node $I report --title "..." --what "..."   # when something breaks (see below)
```

## Before using

- The iPhone is on USB or the same Wi-Fi (picked automatically; `status` shows which), unlocked, browser in front.
  If `tabs` is empty or nothing is visible, try `launch safari`; if still nothing, run `doctor` and relay its ✗ fix.
  Don't retry in a loop.
- The first command starts the bridge (a few seconds). The first call on a tab can take 5–20s; after that ~10ms.
- To reach a local dev server, run it with `--host` and open `http://<Mac LAN IP>:<port>` (`ipconfig getifaddr en0`).
- iPhone Chrome works too (UA contains `CriOS`). It needs Chrome → Settings → Content Settings → Web Inspector on,
  then `launch chrome --restart` once.
- Some tabs may be the user's private pages (logins, mail). Only work on the tab the user pointed at or one you opened.

## How to work

- Start with `snapshot` to see what's on screen, then act with `tap @eN` / `type @eN`. Refs reset on every snapshot
  and navigation, so take a new snapshot after the page changes.
- For layout bugs: `shot`, then `dom` / `styles` / `highlight` on the suspect element.
- Debugger: a pause freezes the page, so `eval` times out while paused. Use `paused`, `frame-eval`, `step`, and
  always `resume` (and `pause-on none`, `break clear`) when done. `pause` waits for the next JS that runs.
- Clean up what changes the page: `unmock`, `nocache off`, `media reset`, `ua reset`, `js on`, `inject --clear`,
  `paintflash off`, `highlight --off`, and `close` tabs you opened.

## Tabs

- Any open tab can be inspected with `use`, including background ones. JS, console, network and debugger work there;
  screenshots, recordings, snapshot boxes and viewport sizes need the tab on screen.
- Bringing a different tab onto the screen isn't possible. Use the visible tab or `launch <url>`.

## Performance notes

- `perf` reads the Performance API on the phone. Safari on iOS 18 has no LCP, so it shows `-`.
- `trace`: start it, then `reload` (same site) or interact, then stop. Navigating to another site during a trace swaps
  Safari's process and the trace comes back nearly empty. The trace has tasks, layout, paint, composite, rAF, script
  evaluation and JS samples, but no FCP/DCL marks; take those from `perf`. Opens in Chrome DevTools → Performance.
- `profile` reports shares of samples, not ms (the bridge's sample timing is unreliable).
- No network or CPU throttling. For slow networks the user turns on iPhone Settings → Developer → Network Link Conditioner.

## Limits

- `tap`/`type` run inside the page with WebKit's user-gesture emulation, so audio start, fullscreen and popups are
  allowed. Native UI (Safari's own buttons, permission prompts, the keyboard, share sheets) can't be touched, and the
  phone can't be unlocked. Ask the user.
- `eval` ignores `awaitPromise` in the bridge and polls instead, so keep async work under 30s.
- If commands hang after the phone slept, `node $I stop` and retry.

## When something breaks

If a command fails in a way that looks like a bug in this plugin (not a locked phone or a missing setting that
`doctor` explains), tell the user and offer to report it. With their OK, run
`node $I report --title "<short summary>" --what "<command, expected, actual>"`. It writes a redacted report
(no device or Mac names, UDIDs, home paths or visited URLs) and prints a prefilled GitHub issue link for
`GUMBOKIM/iphone-webkit-inspector`. Show the user the report before anything is filed; add `--submit` only when
they ask you to file it with `gh`.

Daemon log: `~/.cache/iphone-webkit-inspector/daemon.log`. Bridge source (what each CDP method maps to):
`pymobiledevice3/services/web_protocol/cdp_target.py` in the uv cache.
