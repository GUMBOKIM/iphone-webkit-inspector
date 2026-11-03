---
name: iphone-webkit-inspector
description: Inspect and drive Safari or Chrome on the user's iPhone (USB or Wi-Fi) through Web Inspector — open pages, run JS, tap and type, read console logs and network requests with headers and bodies, block or mock requests, take screenshots and screen recordings, and measure performance (Performance API timings, full Chrome-format traces, JS CPU profiles, CPU/memory usage, heap snapshots). Use whenever something must be checked on a real iPhone / iOS Safari (iOS-only layout or 100vh bugs, touch, audio/video autoplay, Safari warnings, mobile performance), or when the user says "아이폰에서 확인", "iOS에서 봐줘", "모바일 사파리", "실기기".
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/ios.mjs *)
---

# iPhone Safari / Chrome

Playwright can't drive real iOS Safari. This skill goes through Safari's Web Inspector instead:
`ios.mjs` runs a background daemon that starts the `pymobiledevice3` CDP bridge (via `uvx`, nothing installed),
keeps one connection per tab, and buffers console, network and other CDP events.

Run it as `node ${CLAUDE_SKILL_DIR}/ios.mjs <command>` — written out in full, that form is pre-approved, so no
permission prompt. `$I` below is shorthand for that path. `help` lists every command.

```bash
I="${CLAUDE_SKILL_DIR}/ios.mjs"

# setup and tabs
node $I doctor                    # Xcode, iPhone, Developer Mode, Safari/Chrome Web Inspector (~1 min)
node $I launch safari|chrome [url] [--restart]   # bring an app up; with a url it opens a new tab
node $I tabs | use <id|url-part>  # list tabs ("visible" = on screen) | pick one (default: the visible one)
node $I open <url> | reload | close

# page
node $I eval 'document.title'                         # expression → JSON
node $I eval 'const r = await fetch("/x"); return r.status'   # statements need `return`
node $I eval --gesture 'audio.play()'                 # run as a user gesture
node $I tap 'a.more' | tap text=텍스트 | tap 120 300   # touch + click, counts as a user gesture
node $I type 'input[name=q]' hello
node $I shot out.png                                  # screenshot, device resolution
node $I record start dir/ … record stop               # screen recording: JPEG frames <n>-<ms>ms.jpg (~2-3 fps)

# console and network
node $I logs [--errors] [--clear]
node $I net [url-part] [--failed] | req <id|url-part> | body <id|url-part> [--out file]
node $I block <url-part> | mock <url-part> <status> <body|@file> [--type ct] | mocks | unmock [url-part]
node $I nocache on|off
node $I events [Method.prefix] [--last n]             # raw CDP events from the tab

# performance
node $I perf [url-part] [--slow]                      # TTFB, DCL, load, FCP, CLS + resource waterfall
node $I trace start … trace stop out.json             # Chrome-format trace + main-thread summary
node $I profile start … profile stop out.cpuprofile   # JS CPU profile, hottest functions by sample share
node $I usage start … usage stop                      # CPU per thread + memory by category every ~0.5s
node $I heap out.heapsnapshot

# environment
node $I media dark|light|print|screen|reset
node $I inject '<js>' | inject @file.js | inject --clear   # runs before page scripts from the next load
node $I listeners <selector>                          # listeners on the element and its ancestors

node $I cdp <Method> '<json>'     # anything else; unknown methods go to WebKit's own protocol
node $I stop
```

## Before using

- iPhone connected by USB, or on the same Wi-Fi (picked automatically; `status` shows which), unlocked, the browser in the foreground. If `tabs` is empty or nothing is visible,
  try `launch safari`; if still nothing, run `doctor` and relay its ✗ fix to the user. Don't retry in a loop.
- The first command starts the bridge (a few seconds). The first call on a tab can take 5–20s; after that ~10ms.
- To reach a local dev server, run it with `--host` and open `http://<Mac LAN IP>:<port>` (`ipconfig getifaddr en0`).
- iPhone Chrome works too (UA contains `CriOS`). It needs Chrome → Settings → Content Settings → Web Inspector on,
  then `launch chrome --restart` once.
- Some tabs may be the user's private pages (logins, mail). Only work on the tab the user pointed at or one you opened.

## Tabs

- `launch safari <url>` opens a new tab on screen and commands follow it; `open <url>` navigates the current tab.
- Any open tab can be inspected with `use`, including background ones. eval/logs/net work there; screenshots,
  recordings and viewport sizes don't (a hidden tab isn't rendered, innerWidth is 0).
- Bringing a different tab onto the screen isn't possible. Use the visible tab or `launch <url>`.
- `close` closes tabs opened via `launch <url>`; clean those up when done.

## Performance notes

- `perf` reads the Performance API on the phone. Safari on iOS 18 has no LCP, so it shows `-`. Cross-origin resources
  without `Timing-Allow-Origin` show `x-orig` (sizes and phases hidden); `net` still has their headers and bodies.
- `trace`: start it, then `reload` (same site) or interact, then stop. Navigating to another site during a trace
  swaps Safari's process and the trace comes back nearly empty. The trace has tasks, layout, paint, composite,
  rAF, script evaluation and JS samples, but no FCP/DCL marks — take those from `perf`. The file opens in
  Chrome DevTools → Performance → Load profile, or ui.perfetto.dev.
- `profile` reports shares of samples, not ms (the bridge's sample timing is unreliable).
- No network throttling here. For slow-network tests the user turns on iPhone Settings → Developer →
  Network Link Conditioner.

## Limits

- `tap`/`type` are synthesized in the page, but run with WebKit's emulateUserGesture, so audio start, fullscreen and
  popups are allowed. Native UI (Safari's own buttons, settings, permission prompts, the keyboard) can't be touched,
  and the phone can't be unlocked — ask the user.
- The bridge ignores `awaitPromise`; `eval` handles `await` by polling, so keep async work under 30s.
- If commands hang after the phone slept, `node $I stop` and retry.
- Daemon log: `~/.cache/iphone-webkit-inspector/daemon.log`. Bridge source (what each CDP method maps to):
  `pymobiledevice3/services/web_protocol/cdp_target.py` in the uv cache.
