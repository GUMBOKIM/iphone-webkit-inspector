# iphone-webkit-inspector

A Claude Code plugin that lets Claude inspect and drive **Safari or Chrome on a real iPhone**, over USB or Wi-Fi.

Playwright can't automate iOS Safari on a device, so this goes through Safari's Web Inspector instead.
A small daemon runs the [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) CDP bridge,
keeps a connection to each tab, and buffers console and network events. Claude talks to it through one CLI.

## What Claude can do with it

| Area | Commands |
|---|---|
| Tabs and pages | `launch safari\|chrome [url]`, `tabs`, `use`, `open`, `reload`, `close` |
| Page | `eval` (supports `await`), `tap` (selector, text, or x/y; counts as a user gesture), `type`, `shot`, `record` |
| Console and network | `logs`, `net`, `req`, `body`, `block`, `mock`, `nocache`, `events` |
| Performance | `perf` (TTFB, DCL, load, FCP, CLS, resource waterfall), `trace` (Chrome-format trace), `profile` (.cpuprofile), `usage` (CPU and memory), `heap` |
| Environment | `media dark\|light\|print`, `inject` (script before page scripts), `listeners` |
| Anything else | `cdp <Method> <json>` |

Traces, profiles and heap snapshots are saved as files that open in Chrome DevTools.

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

Tested on an iPhone 15 Pro with iOS 18.6.2, Xcode 27.2, pymobiledevice3 11.49.

## Install

```bash
/plugin marketplace add GUMBOKIM/iphone-webkit-inspector
/plugin install iphone-webkit-inspector@iphone-webkit-inspector
```

Then ask Claude something like "check this page on my iPhone" or run `/iphone-webkit-inspector:iphone-webkit-inspector`.
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
- Files written: `~/.cache/iphone-webkit-inspector/` (daemon pid and log) and the screenshots, traces, profiles,
  heap snapshots and recordings you ask for, at the paths you give (default: the system temp folder).
- `eval`, `tap`, `type`, `mock`, `block` and `inject` change the page on the phone the way DevTools would.
  Claude should only use them on tabs you point it at.

## Limits

- Only the tab on the iPhone screen renders, so screenshots, recordings and viewport sizes need it in front.
  Background tabs still answer JS, console and network.
- Claude can't switch which tab is on screen, press Safari's own buttons, answer permission prompts, or unlock the phone.
- No network throttling. Use iPhone Settings → Developer → Network Link Conditioner.
- Safari on iOS 18 doesn't report LCP.
- `tap` and `type` run inside the page with WebKit's user-gesture emulation; they are not OS-level touches.

## License

MIT. pymobiledevice3 is a separate GPL-3.0 project; this plugin runs it through `uvx` and doesn't bundle it.
