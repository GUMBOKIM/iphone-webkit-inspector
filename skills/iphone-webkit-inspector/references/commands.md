# ios.mjs command reference

Every command is run as `node ${CLAUDE_SKILL_DIR}/ios.mjs <command>` (written out in full). This is the same text as `help`, with notes below.

```text
ios.mjs — inspect and drive Safari/Chrome on an iPhone (USB or Wi-Fi)

Element targets (<el>): CSS selector | text=<label> | @e12 (from snapshot) | x y

 setup
  start | stop | status        background bridge (auto-starts on first command)
  doctor                       check Xcode, the iPhone, and the Safari/Chrome inspector settings
  launch [safari|chrome|<bundle-id>] [url] [--restart]   bring an app up; with a url Safari opens it in a new tab,
                               or brings forward a tab that already shows that URL
  report [--title t] [--what text]   collect redacted diagnostics and print a prefilled GitHub issue link

 tabs and pages
  tabs                         list tabs (visible = on the iPhone screen)
  use <id|n|url-part>          pick the tab to work on: full id, its last number (19), or part of the URL
  open <url> | reload | close  navigate (waits for load, clears logs/net) | reload | close tab
  snapshot [--all]             elements you can act on, as @eN refs
  eval <js> [--gesture]        run JS; expression, or statements with return/await
  tap <el>                     touch + click, run as a user gesture
  type <el> <text>             set an input's value and fire input/change
  shot [path] [--device]       screenshot of the page; --device = whole screen incl. Safari's bars and keyboard
  record start [dir] | record stop      screen recording as JPEG frames named <n>-<ms>ms.jpg

 elements
  dom <el>                     outerHTML, box, margin/padding, display
  styles <el> [--computed [p1,p2]]      matched CSS rules with file:line, inline style, computed values
  a11y <el>                    accessibility role, label, states
  highlight <el> | highlight --off      draw the box model on the phone screen
  pseudo <el> hover,active,focus|off    force pseudo-classes
  listeners <el>               event listeners on the element and its ancestors
  layers                       composited layers: memory, paint count, why they exist

 console and network
  logs [--errors] [--clear]    console messages, exceptions, Safari warnings
  net [url-part] [--failed]    requests: id status type size time url
  req <id|url-part>            request + response headers, post data
  body <id|url-part> [--out f] response body
  har [out.har]                export recorded requests as HAR
  ws                           WebSocket frames
  block <url-part>             fail matching requests
  mock <url-part> <status> <body|@file> [--type ct]   answer matching requests yourself
  mocks | unmock [url-part]    list | remove interception rules (all when no url-part)
  nocache [on|off]             disable the HTTP cache
  events [method-prefix] [--last n] [--clear]   raw CDP events received from the tab

 sources and debugger
  scripts [url-part]           loaded scripts
  source <id|url-part> [--line n] [--out f]   script source (or 11 lines around n)
  break <url-part> <line> [--if expr] | break list | break clear
  pause-on all|uncaught|none   pause on exceptions
  pause | resume | step [over|into|out]
  paused                       where it stopped: reason, line, stack, locals
  frame-eval <js>              evaluate in the paused frame

 application
  cookies [--values] [--clear [name]]   cookies for the page (values hidden unless --values)
  storage [local|session] [--clear]
  idb                          IndexedDB databases and object stores

 performance
  perf [url-part] [--slow] [--json]     Performance API: TTFB, DCL, load, FCP, CLS, resource waterfall
  trace start [--screenshots] | trace stop [out.json]   Chrome-format performance trace + summary
  profile start | profile stop [out.cpuprofile]         JS CPU profile + hottest functions
  fps [seconds]                display frame rate on the phone, one sample per second
  usage start | usage stop [out.json]   CPU (per thread) and memory by category every ~0.5s
  heap [out.heapsnapshot]      JS heap snapshot

 rendering and environment
  media dark|light|print|screen|reset   emulate prefers-color-scheme / media type
  paintflash on|off            flash repainted areas on the phone
  ua <string>|reset            override the User-Agent (from the next request)
  js on|off                    disable page JavaScript (from the next reload)
  inject <js|@file> | inject --clear   run a script in every new document before page scripts

  cdp <Method> [json-params]   any other CDP method (unknown ones are forwarded to WebKit's protocol)

```

## Notes per area

**cookies.** Prints names and attributes; values only with `--values`. `--clear [name]` deletes cookies for the
current page and can log the user out, so ask first.

**Pages.** `open` clears the console and network buffers and waits for `load`. `launch <app> <url>` opens a new tab, or brings
forward a tab already showing that URL; commands then follow the visible tab. `close` only closes tabs opened from a URL (Safari blocks closing tabs the user opened).

**snapshot.** Lists visible links, buttons, inputs, headings, media and anything with a role or `tabindex`, tagged as
`@e1`, `@e2`… on the page itself (`data-iwi-ref`). Refs change on every snapshot and navigation. `--all` includes
off-screen elements, marked `offscreen`. Boxes are `x,y,width,height` in CSS pixels.

**tap / type.** In-page events (pointer, touch, mouse, click) run with WebKit's user-gesture emulation, so things
that need a user gesture (audio start, fullscreen, `window.open`) are allowed. `tap` reports `covered: true` when
another element sits on top of the target at its center. `type` uses the native value setter, so React-style
inputs notice the change.

**styles.** Matched rules come back most specific first, with `file:line` (minified CSS is usually line 1).
Rules with no active properties are skipped. `--computed` alone prints every computed property; pass a comma list
to limit it.

**Debugger.** A pause freezes the page: `eval` and most commands time out until `resume`. `pause` stops at the next
JS that runs, which may be never on an idle page. Breakpoints match the script URL by substring and take 1-based
lines; minified files are one line, so prefer `pause-on uncaught` or `debugger;` via `inject` for those.

**trace.** Start, then `reload` or interact on the same site, then stop. A navigation to another site swaps Safari's
process and loses the trace. Summary shows main-thread time per event type and tasks over 50ms; the JSON opens in
Chrome DevTools → Performance → Load profile.

**profile.** Sample shares per function. The bridge's sample timing is unreliable, so there are no milliseconds.

**shot --device / fps.** Use the phone's developer services through the CoreDevice tunnel macOS keeps for Xcode.
`shot --device` is the full 1179×2556 screen including status bar, Safari's bars and the keyboard. `fps` reads
Core Animation's display frame rate once per second; 0 means nothing on screen changed. Device-level network
throttling (DVT condition inducer) was tested and did not slow Safari's traffic, so it isn't offered.

**usage.** Samples every ~0.5s: total and main-thread CPU %, memory per category (JS, JIT, images, layers, page).

**mock / block.** Rules match a URL substring and apply to every request of the current tab until `unmock`.
`mock` adds `Access-Control-Allow-Origin: *`.

**inject.** Uses WebKit's bootstrap script, which runs before page scripts from the next navigation. Several
`inject` calls are concatenated; `inject --clear` removes them.

**report.** Writes a redacted Markdown report (no device or Mac names, UDIDs, home paths, visited URLs) to the temp
folder and prints a prefilled GitHub issue link. The user files it.
