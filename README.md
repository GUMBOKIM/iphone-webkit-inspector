# iPhone WebKit Inspector

[한국어](README.ko.md)

A Claude Code plugin that lets Claude use Safari or Chrome on a real iPhone the way you'd use DevTools, over USB or Wi-Fi.

Chrome DevTools can't reach Safari on a physical iPhone, and Playwright only half works there (see below), so this
goes through Safari's Web Inspector.
A small daemon runs the [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) CDP bridge, holds a connection
to each tab, and buffers console, network and debugger events. Claude talks to it through one CLI.

## How it compares

Chrome DevTools works on Chrome on your desktop. Playwright's closest thing to Safari is its WebKit build on macOS;
the table compares against that. This plugin works on Safari or Chrome running on your iPhone.

✅ supported · ⚠️ partial · ❌ not supported

| Feature | Chrome DevTools | Playwright | This plugin |
|---|:-:|:-:|:-:|
| **Target** | | | |
| Real iOS Safari / Chrome on a device | ❌ | ⚠️ through the same bridge, partly (below) | ✅ USB or Wi-Fi |
| Several tabs | ✅ | ✅ | ⚠️ inspect any tab, can't bring one on screen |
| **Pages and input** | | | |
| Navigate, reload, open and close tabs | ✅ | ✅ | ✅ |
| Run JavaScript (with `await`) | ✅ | ✅ | ✅ |
| Element snapshot with refs for the agent | ✅ (DevTools MCP) | ✅ (aria snapshot) | ✅ `snapshot`, `@e12` |
| Click / tap, type | ✅ | ✅ real input events | ⚠️ in-page events with user-gesture emulation |
| Native browser UI, permission prompts, keyboard | ❌ | ⚠️ dialogs only | ❌ |
| Screenshot | ✅ | ✅ incl. full page | ✅ page, or the whole phone screen with Safari's bars |
| Screen recording | ✅ screencast | ✅ video | ⚠️ JPEG frames, ~2–3 fps |
| **Elements** | | | |
| DOM and outerHTML | ✅ | ✅ | ✅ |
| Matched CSS rules with file and line | ✅ | ❌ | ✅ |
| Computed style | ✅ | ⚠️ via JS | ✅ |
| Edit CSS live | ✅ | ⚠️ via JS | ⚠️ via `eval` |
| Force `:hover` / `:focus` | ✅ | ⚠️ hover only | ✅ |
| Box-model highlight on screen | ✅ | ❌ | ✅ drawn on the phone |
| Accessibility properties | ✅ | ✅ | ✅ |
| Event listeners | ✅ | ❌ | ✅ incl. ancestors |
| Compositing layers and reasons | ✅ | ❌ | ✅ |
| **Console and network** | | | |
| Console, exceptions, browser warnings | ✅ | ✅ | ✅ |
| Requests with headers and bodies | ✅ | ✅ | ✅ |
| HAR export | ✅ | ✅ | ✅ |
| WebSocket frames | ✅ | ✅ | ⚠️ recorded, lightly tested |
| Block or mock requests | ✅ | ✅ | ✅ |
| Disable cache | ✅ | ⚠️ | ✅ |
| Network throttling | ✅ | ⚠️ Chromium only | ❌ use Network Link Conditioner |
| **Sources** | | | |
| Script list and source | ✅ | ❌ | ✅ |
| Breakpoints, conditional breakpoints | ✅ | ❌ | ✅ |
| Pause on exceptions, step, inspect locals | ✅ | ❌ | ✅ |
| **Application** | | | |
| Cookies | ✅ | ✅ | ✅ |
| localStorage / sessionStorage | ✅ | ✅ | ✅ |
| IndexedDB | ✅ | ⚠️ via JS | ✅ databases and stores |
| Service workers, Cache Storage | ✅ | ⚠️ | ❌ |
| **Performance** | | | |
| Navigation and resource timings | ✅ | ⚠️ via JS | ✅ `perf` |
| FCP | ✅ | ⚠️ via JS | ✅ |
| CLS | ✅ | ⚠️ via JS | ❌ Safari doesn't support layout-shift |
| LCP | ✅ | ⚠️ | ❌ Safari 18 doesn't report it |
| Performance trace | ✅ | ⚠️ Chromium only | ✅ Chrome-format, opens in DevTools |
| JS CPU profile | ✅ | ⚠️ Chromium only | ⚠️ sample shares, no exact ms |
| CPU and memory usage over time | ✅ | ❌ | ✅ per thread and per category |
| Real display frame rate | ⚠️ FPS meter | ❌ | ✅ `fps`, from the device |
| Heap snapshot | ✅ | ⚠️ Chromium only | ✅ |
| Lighthouse | ✅ | ❌ | ❌ |
| CPU throttling | ✅ | ⚠️ Chromium only | ❌ |
| **Rendering and emulation** | | | |
| Dark mode, print media | ✅ | ✅ | ✅ |
| Paint flashing | ✅ | ❌ | ✅ on the phone |
| User-Agent override | ✅ | ✅ | ✅ |
| Disable JavaScript | ✅ | ✅ | ✅ |
| Inject script before page scripts | ✅ | ✅ | ✅ |
| Viewport, device, geolocation, timezone emulation | ✅ | ✅ | ❌ it's a real device |
| **Testing** | | | |
| Test runner and assertions | ❌ | ✅ | ❌ |

In short, most of what you'd open DevTools for works on the real phone. You don't get OS-level input (native UI,
the keyboard), throttling, Lighthouse, LCP or CLS.

### Playwright on the same bridge

The bridge speaks CDP, so Playwright can attach to a real iPhone with `chromium.connectOverCDP` while Safari is in
front. Tested on iOS 18.6.2 with pymobiledevice3 11.49.2: same-site navigation, the aria snapshot, typing, console,
screenshots and `evaluate` work. Clicks arrive as synthetic `click` events (`isTrusted: false`), so a link click may
not navigate; `page.tap()` needs `hasTouch`; `mouse.wheel`, `waitForResponse`, `route`, `setViewportSize`,
`cookies()`, `newPage()` and `alert()` handling fail or hang; navigating to another site drops the connection.
Playwright MCP (`--cdp-endpoint`) stalls if Safari has a background tab, and even with one tab its navigate, snapshot
and screenshot time out. This plugin uses the bridge's WebKit commands directly instead, so `tap` follows links and
responses, mocks, cookies and new tabs work. Neither can dismiss an `alert()`; someone has to tap Close on the phone.

## Commands

Element targets (`<el>`): a CSS selector, `text=<label>`, `@e12` from `snapshot`, or `x y`.

| Area | Commands |
|---|---|
| Setup | `doctor`, `launch safari\|chrome [url]`, `status`, `stop`, `report` |
| Pages | `tabs`, `use`, `open`, `reload`, `close`, `snapshot`, `eval`, `tap`, `type`, `shot`, `record` |
| Elements | `dom`, `styles`, `a11y`, `highlight`, `pseudo`, `listeners`, `layers` |
| Console and network | `logs`, `net`, `req`, `body`, `har`, `ws`, `block`, `mock`, `mocks`, `unmock`, `nocache`, `events` |
| Sources | `scripts`, `source`, `break`, `pause-on`, `pause`, `paused`, `step`, `frame-eval`, `resume` |
| Application | `cookies`, `storage`, `idb` |
| Performance | `perf`, `trace`, `profile`, `usage`, `heap`, `fps` |
| Rendering | `media`, `paintflash`, `ua`, `js`, `inject` |
| Anything else | `cdp <Method> <json>` |

Traces, CPU profiles, heap snapshots and HAR files open in Chrome DevTools. Run `ios.mjs help` for the full syntax.

## Requirements

- macOS with Xcode, which provides `devicectl`. Select it and accept the license once:
  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
  ```
- [uv](https://docs.astral.sh/uv/) (`brew install uv`). pymobiledevice3 runs through `uvx`, so nothing gets installed globally.
- Node.js 22+, for its built-in WebSocket and fetch. There are no npm dependencies.
- An iPhone on iOS 17 or later, paired with the Mac (connect by USB once and tap Trust), with these turned on:
  - Settings → Privacy & Security → Developer Mode
  - Settings → Apps → Safari → Advanced → Web Inspector
  - For Chrome: Chrome → Settings → Content Settings → Web Inspector, then restart Chrome

The bridge uses USB when the phone is plugged in. When it isn't, the bridge reuses the Wi-Fi connection macOS
already keeps to a paired iPhone on the same network (the one Xcode uses), so you don't need to change anything in
Finder. To pick one yourself, run `ios.mjs stop`, then `ios.mjs start --usb` or `--wifi`.

Tested on an iPhone 15 Pro with iOS 18.6.2, Xcode 27.2, pymobiledevice3 11.49.2.

## Install

```bash
/plugin marketplace add GUMBOKIM/iphone-webkit-inspector
/plugin install iphone-webkit-inspector@gumbokim
```

Then ask Claude something like "check this page on my iPhone", or run `/iphone-webkit-inspector:iphone-webkit-inspector`.
To check your setup, ask Claude to run `doctor`.

## What it runs and connects to

- `node skills/iphone-webkit-inspector/ios.mjs` is the CLI Claude calls. It's plain readable source with no npm
  dependencies. The first command starts a background daemon (same script) that listens on a Unix socket,
  `~/.cache/iphone-webkit-inspector/daemon.sock`. It opens no network port.
- `uvx --from pymobiledevice3==11.49.2 python bridge_guard.py <socket> webinspector cdp` is the Web Inspector
  bridge. The first time, `uv` downloads that exact pymobiledevice3 version from PyPI, and a uv-managed Python 3.12
  if you don't have one.
- `bridge_guard.py` makes the bridge listen on `~/.cache/iphone-webkit-inspector/bridge.sock` instead of the TCP
  port pymobiledevice3 would open, and refuses any request with an `Origin` header. Both sockets sit in a folder only
  you can open (mode 700), so other users on the Mac can't reach your phone through them, and web pages can't reach
  Unix sockets at all. There are no tokens or secrets.
- `xcrun devicectl` lists the iPhone and launches Safari or Chrome on it.
- The bridge reaches the iPhone through macOS's `usbmuxd` over USB, or over Wi-Fi through the CoreDevice
  tunnel macOS already keeps up for Xcode (`--native`). Either way the traffic stays between your Mac and your phone.
- Pages you open on the phone load from the network as usual. The plugin itself doesn't send anything anywhere.
  `report` only prints a link; you decide whether to open it and file the issue.
- It writes the daemon pid, the two sockets and the log to `~/.cache/iphone-webkit-inspector/`. Screenshots, traces, profiles, heap
  snapshots, HAR files and recordings you ask for go to the system temp folder by default.
- `eval`, `tap`, `type`, `mock`, `block`, `inject`, `ua`, `js` and the debugger change the page on the phone the way
  DevTools would. Claude should only use them on tabs you point it at.

## Privacy

Everything the commands return goes into your Claude Code session, and from there to the model provider like any
other tool output. That includes what you ask for from the phone: page text and HTML, console messages, request and
response headers and bodies, localStorage, sessionStorage and IndexedDB contents, and cookie names (cookie values
only with `cookies --values`). `snapshot` never shows what's typed into password fields. Only point it at tabs
you're fine sharing that way.

The daemon connects to every open tab so it can tell which one is on screen, but it only turns on console and
network recording for the tab it's working on. If that tab closes, commands stop with an error instead of moving to
another tab. Private tabs (mail, banking) are still reachable through the inspector while they're open, so close
them if you don't want them anywhere near a session.

Nothing is stored except the daemon's state in `~/.cache/iphone-webkit-inspector/` (owner-only; the log keeps
the site origin of each tab, not full URLs) and the files you ask for. The
daemon keeps recent console and network events in memory until it stops (`ios.mjs stop`, or when the bridge exits).

## Limits

- Only the tab that's on the iPhone screen renders, so screenshots, recordings and snapshot boxes need that tab in
  front. Background tabs still respond to JS, console, network and the debugger.
- Claude can't switch which tab is on screen, press Safari's own buttons, answer permission prompts, or unlock the phone.
- `tap` and `type` run inside the page using WebKit's user-gesture emulation. They aren't OS-level touches.
- If a performance trace spans a navigation to another site, it comes back nearly empty. Trace a same-site reload instead.

## Reporting a problem

Ask Claude to run `report`, or run it yourself:

```bash
node <plugin>/skills/iphone-webkit-inspector/ios.mjs report --title "..." --what "what you ran, expected, got"
```

It gathers versions, `doctor` output and the daemon log, and strips out device and Mac names, UDIDs, home paths and
visited URLs. Then it saves the report and prints a prefilled link to
[a new issue](https://github.com/GUMBOKIM/iphone-webkit-inspector/issues/new/choose). Read it before you submit.

Security problems go through [private reporting](SECURITY.md), not public issues.

## License

Not affiliated with or endorsed by Apple. iPhone, Safari and WebKit are used only to describe what the tool works with.

MIT. pymobiledevice3 is a separate GPL-3.0 project; this plugin runs it through `uvx` and doesn't bundle it.
