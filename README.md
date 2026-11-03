# iPhone WebKit Inspector

[한국어](README.ko.md)

A Claude Code plugin that gives Claude DevTools-level access to **Safari or Chrome on a real iPhone**, over USB or Wi-Fi.

Playwright and Chrome DevTools can't drive Safari on a physical iPhone. This plugin goes through Safari's Web
Inspector instead: a small daemon runs the [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) CDP bridge,
keeps a connection to each tab, and buffers console, network and debugger events. Claude talks to it through one CLI.

## How it compares

- **Chrome DevTools**: Chrome on your desktop.
- **Playwright**: its WebKit build on macOS, the closest it gets to Safari. It can't attach to a real iPhone.
- **This plugin**: Safari or Chrome running on your iPhone.

✅ supported · ⚠️ partial · ❌ not supported

| Feature | Chrome DevTools | Playwright | This plugin |
|---|:-:|:-:|:-:|
| **Target** | | | |
| Real iOS Safari / Chrome on a device | ❌ | ❌ (WebKit on macOS) | ✅ USB or Wi-Fi |
| Several tabs | ✅ | ✅ | ⚠️ inspect any tab, can't bring one on screen |
| **Pages and input** | | | |
| Navigate, reload, open and close tabs | ✅ | ✅ | ✅ |
| Run JavaScript (with `await`) | ✅ | ✅ | ✅ |
| Element snapshot with refs for the agent | ✅ (DevTools MCP) | ✅ (aria snapshot) | ✅ `snapshot`, `@e12` |
| Click / tap, type | ✅ | ✅ real input events | ⚠️ in-page events with user-gesture emulation |
| Native browser UI, permission prompts, keyboard | ❌ | ⚠️ dialogs only | ❌ |
| Screenshot | ✅ | ✅ incl. full page | ⚠️ visible viewport |
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
| FCP, CLS | ✅ | ⚠️ via JS | ✅ |
| LCP | ✅ | ⚠️ | ❌ Safari 18 doesn't report it |
| Performance trace | ✅ | ⚠️ Chromium only | ✅ Chrome-format, opens in DevTools |
| JS CPU profile | ✅ | ⚠️ Chromium only | ⚠️ sample shares, no exact ms |
| CPU and memory usage over time | ✅ | ❌ | ✅ per thread and per category |
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

In short: almost everything you'd open DevTools for works on the real phone. What's missing is OS-level input
(native UI, the keyboard), throttling, Lighthouse and LCP.

## Commands

Element targets (`<el>`): a CSS selector, `text=<label>`, `@e12` from `snapshot`, or `x y`.

| Area | Commands |
|---|---|
| Setup | `doctor`, `launch safari\|chrome [url]`, `status`, `stop`, `report` |
| Pages | `tabs`, `use`, `open`, `reload`, `close`, `snapshot`, `eval`, `tap`, `type`, `shot`, `record` |
| Elements | `dom`, `styles`, `a11y`, `highlight`, `pseudo`, `listeners`, `layers` |
| Console and network | `logs`, `net`, `req`, `body`, `har`, `ws`, `block`, `mock`, `unmock`, `nocache`, `events` |
| Sources | `scripts`, `source`, `break`, `pause-on`, `pause`, `paused`, `step`, `frame-eval`, `resume` |
| Application | `cookies`, `storage`, `idb` |
| Performance | `perf`, `trace`, `profile`, `usage`, `heap` |
| Rendering | `media`, `paintflash`, `ua`, `js`, `inject` |
| Anything else | `cdp <Method> <json>` |

Traces, CPU profiles, heap snapshots and HAR files open in Chrome DevTools. Run `ios.mjs help` for the full syntax.

## Requirements

- macOS with **Xcode** (for `devicectl`). Select it and accept the license once:
  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
  ```
- [**uv**](https://docs.astral.sh/uv/) (`brew install uv`). pymobiledevice3 runs through `uvx`; nothing is installed globally.
- **Node.js 22+** (built-in WebSocket and fetch; no npm dependencies).
- iPhone on iOS 17 or later, paired with the Mac (connect by USB once and tap Trust), with:
  - Settings → Privacy & Security → **Developer Mode** on
  - Settings → Apps → Safari → Advanced → **Web Inspector** on
  - For Chrome: Chrome → Settings → Content Settings → **Web Inspector** on, then restart Chrome

**USB or Wi-Fi:** the bridge picks USB when the phone is plugged in. Unplugged, it reuses the Wi-Fi connection
macOS already keeps to a paired iPhone on the same network (the one Xcode uses), so no Finder setting is needed.
Force one with `IOS_TRANSPORT=usb|wifi`.

Tested on an iPhone 15 Pro with iOS 18.6.2, Xcode 27.2, pymobiledevice3 11.49.2.

## Install

```bash
/plugin marketplace add GUMBOKIM/iphone-webkit-inspector
/plugin install iphone-webkit-inspector@iphone-webkit-inspector
```

Then ask Claude something like "check this page on my iPhone", or run `/iphone-webkit-inspector:iphone-webkit-inspector`.
To check your setup, ask Claude to run `doctor`.

## What it runs and connects to

- `node skills/iphone-webkit-inspector/ios.mjs` — the CLI Claude calls. Readable source, no npm dependencies.
  The first command starts a background daemon (same script) that listens on `127.0.0.1:9334` only.
- `uvx --from pymobiledevice3==11.49.2 pymobiledevice3 webinspector cdp --port 9333` — the Web Inspector bridge,
  listening on `127.0.0.1:9333` only. `uv` downloads that exact version from PyPI the first time.
- `xcrun devicectl` — lists the iPhone and launches Safari or Chrome on it.
- The bridge reaches the iPhone through macOS's `usbmuxd` over USB, or over Wi-Fi through the CoreDevice
  tunnel macOS already maintains for Xcode (`--native`). Both stay between your Mac and your phone.
- Pages you open on the phone load from the network as usual. The plugin itself sends nothing anywhere else.
  `report --submit` files a GitHub issue through your `gh` login, and only when you ask.
- Files written: `~/.cache/iphone-webkit-inspector/` (daemon pid and log) and the screenshots, traces, profiles,
  heap snapshots, HAR files and recordings you ask for (default: the system temp folder).
- `eval`, `tap`, `type`, `mock`, `block`, `inject`, `ua`, `js` and the debugger change the page on the phone the way
  DevTools would. Claude should only use them on tabs you point it at.

## Limits

- Only the tab on the iPhone screen renders, so screenshots, recordings and snapshot boxes need it in front.
  Background tabs still answer JS, console, network and the debugger.
- Claude can't switch which tab is on screen, press Safari's own buttons, answer permission prompts, or unlock the phone.
- `tap` and `type` run inside the page with WebKit's user-gesture emulation; they are not OS-level touches.
- A performance trace across a navigation to another site comes back nearly empty. Trace a same-site reload instead.

## Reporting a problem

Ask Claude to run `report`, or run it yourself:

```bash
node <plugin>/skills/iphone-webkit-inspector/ios.mjs report --title "..." --what "what you ran, expected, got"
```

It collects versions, `doctor` output and the daemon log, redacts device and Mac names, UDIDs, home paths and
visited URLs, saves the report, and prints a prefilled link to
[a new issue](https://github.com/GUMBOKIM/iphone-webkit-inspector/issues/new/choose). Add `--submit` to file it with `gh`.

## License

MIT. pymobiledevice3 is a separate GPL-3.0 project; this plugin runs it through `uvx` and doesn't bundle it.
