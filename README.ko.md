# iPhone WebKit Inspector

[English](README.md)

Claude가 **실제 아이폰의 Safari나 Chrome**을 개발자 도구 수준으로 들여다보고 조작하게 해 주는 Claude Code 플러그인입니다. USB와 Wi-Fi 둘 다 됩니다.

Playwright나 Chrome 개발자 도구로는 실제 아이폰의 Safari를 조종할 수 없어서, 이 플러그인은 Safari의 Web Inspector를 거쳐 들어갑니다. 작은 데몬이 [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)의 CDP 브리지를 띄우고, 탭마다 연결을 붙잡아 둔 채 콘솔, 네트워크, 디버거 이벤트를 모아 둡니다. Claude는 CLI 하나로 이 데몬과 주고받습니다.

## 비교

- **Chrome 개발자 도구**: 데스크톱 Chrome
- **Playwright**: macOS용 WebKit 빌드. Safari에 가장 가깝지만 실제 아이폰에는 붙지 못합니다.
- **이 플러그인**: 아이폰에서 실행 중인 Safari 또는 Chrome

✅ 지원 · ⚠️ 일부 지원 · ❌ 미지원

| 기능 | Chrome 개발자 도구 | Playwright | 이 플러그인 |
|---|:-:|:-:|:-:|
| **대상** | | | |
| 실기기의 iOS Safari / Chrome | ❌ | ❌ (macOS의 WebKit) | ✅ USB 또는 Wi-Fi |
| 여러 탭 | ✅ | ✅ | ⚠️ 어느 탭이든 검사 가능, 화면에 띄우는 탭은 못 바꿈 |
| **페이지와 입력** | | | |
| 이동, 새로고침, 탭 열기·닫기 | ✅ | ✅ | ✅ |
| JavaScript 실행 (`await` 포함) | ✅ | ✅ | ✅ |
| 에이전트용 요소 스냅샷과 번호 | ✅ (DevTools MCP) | ✅ (aria 스냅샷) | ✅ `snapshot`, `@e12` |
| 클릭·탭, 입력 | ✅ | ✅ 실제 입력 이벤트 | ⚠️ 페이지 안 이벤트 + 사용자 제스처 흉내 |
| 브라우저 자체 UI, 권한 팝업, 키보드 | ❌ | ⚠️ 대화상자만 | ❌ |
| 스크린샷 | ✅ | ✅ 전체 페이지 포함 | ✅ 페이지, 또는 Safari 막대까지 포함한 폰 화면 전체 |
| 화면 녹화 | ✅ screencast | ✅ 동영상 | ⚠️ JPEG 프레임, 초당 2~3장 |
| **Elements** | | | |
| DOM, outerHTML | ✅ | ✅ | ✅ |
| 적용된 CSS 규칙과 파일·줄 번호 | ✅ | ❌ | ✅ |
| Computed 스타일 | ✅ | ⚠️ JS로 | ✅ |
| CSS 실시간 수정 | ✅ | ⚠️ JS로 | ⚠️ `eval`로 |
| `:hover` / `:focus` 강제 | ✅ | ⚠️ hover만 | ✅ |
| 화면에 박스 모델 하이라이트 | ✅ | ❌ | ✅ 아이폰 화면에 표시 |
| 접근성 속성 | ✅ | ✅ | ✅ |
| 이벤트 리스너 | ✅ | ❌ | ✅ 부모 요소 포함 |
| 합성 레이어와 생성 이유 | ✅ | ❌ | ✅ |
| **콘솔과 네트워크** | | | |
| 콘솔, 예외, 브라우저 경고 | ✅ | ✅ | ✅ |
| 요청·응답 헤더와 본문 | ✅ | ✅ | ✅ |
| HAR 내보내기 | ✅ | ✅ | ✅ |
| WebSocket 메시지 | ✅ | ✅ | ⚠️ 기록은 되지만 시험을 많이 못 함 |
| 요청 차단·모킹 | ✅ | ✅ | ✅ |
| 캐시 끄기 | ✅ | ⚠️ | ✅ |
| 네트워크 속도 제한 | ✅ | ⚠️ Chromium만 | ❌ Network Link Conditioner 사용 |
| **Sources** | | | |
| 스크립트 목록과 소스 | ✅ | ❌ | ✅ |
| 브레이크포인트, 조건부 브레이크포인트 | ✅ | ❌ | ✅ |
| 예외에서 멈추기, 한 줄씩 실행, 지역 변수 보기 | ✅ | ❌ | ✅ |
| **Application** | | | |
| 쿠키 | ✅ | ✅ | ✅ |
| localStorage / sessionStorage | ✅ | ✅ | ✅ |
| IndexedDB | ✅ | ⚠️ JS로 | ✅ DB와 저장소 목록 |
| 서비스 워커, Cache Storage | ✅ | ⚠️ | ❌ |
| **성능** | | | |
| 페이지·리소스 로딩 시간 | ✅ | ⚠️ JS로 | ✅ `perf` |
| FCP, CLS | ✅ | ⚠️ JS로 | ✅ |
| LCP | ✅ | ⚠️ | ❌ Safari 18이 값을 주지 않음 |
| 성능 트레이스 | ✅ | ⚠️ Chromium만 | ✅ Chrome 형식, 개발자 도구에서 열림 |
| JS CPU 프로파일 | ✅ | ⚠️ Chromium만 | ⚠️ 샘플 비율, 정확한 ms는 없음 |
| 시간에 따른 CPU·메모리 사용량 | ✅ | ❌ | ✅ 스레드별, 종류별 |
| 실제 화면 프레임 수 | ⚠️ FPS 미터 | ❌ | ✅ `fps`, 기기에서 직접 |
| 힙 스냅샷 | ✅ | ⚠️ Chromium만 | ✅ |
| Lighthouse | ✅ | ❌ | ❌ |
| CPU 속도 제한 | ✅ | ⚠️ Chromium만 | ❌ |
| **렌더링과 에뮬레이션** | | | |
| 다크 모드, 인쇄 미디어 | ✅ | ✅ | ✅ |
| 다시 그려지는 영역 표시 (paint flashing) | ✅ | ❌ | ✅ 아이폰 화면에 표시 |
| User-Agent 바꾸기 | ✅ | ✅ | ✅ |
| JavaScript 끄기 | ✅ | ✅ | ✅ |
| 페이지 스크립트보다 먼저 스크립트 실행 | ✅ | ✅ | ✅ |
| 화면 크기·기기·위치·시간대 흉내 | ✅ | ✅ | ❌ 실제 기기라서 필요 없음 |
| **테스트** | | | |
| 테스트 러너와 assertion | ❌ | ✅ | ❌ |

정리하면, 개발자 도구를 열어서 보통 하는 일은 실제 아이폰에서도 거의 다 됩니다. 안 되는 것은 OS 수준 입력(브라우저 UI, 키보드), 속도 제한, Lighthouse, LCP입니다.

## 명령

요소 지정(`<el>`): CSS 선택자, `text=<글자>`, `snapshot`에서 받은 `@e12`, 또는 `x y` 좌표

| 분류 | 명령 |
|---|---|
| 설정 | `doctor`, `launch safari\|chrome [url]`, `status`, `stop`, `report` |
| 페이지 | `tabs`, `use`, `open`, `reload`, `close`, `snapshot`, `eval`, `tap`, `type`, `shot`, `record` |
| Elements | `dom`, `styles`, `a11y`, `highlight`, `pseudo`, `listeners`, `layers` |
| 콘솔과 네트워크 | `logs`, `net`, `req`, `body`, `har`, `ws`, `block`, `mock`, `unmock`, `nocache`, `events` |
| Sources | `scripts`, `source`, `break`, `pause-on`, `pause`, `paused`, `step`, `frame-eval`, `resume` |
| Application | `cookies`, `storage`, `idb` |
| 성능 | `perf`, `trace`, `profile`, `usage`, `heap` |
| 렌더링 | `media`, `paintflash`, `ua`, `js`, `inject` |
| 그 밖의 모든 것 | `cdp <Method> <json>` |

트레이스, CPU 프로파일, 힙 스냅샷, HAR 파일은 Chrome 개발자 도구에서 열 수 있습니다. 전체 문법은 `ios.mjs help`로 볼 수 있습니다.

## 필요한 것

- **Xcode**가 깔린 macOS (`devicectl` 때문에 필요합니다). 처음에 한 번 경로를 지정하고 라이선스에 동의해 두면 됩니다.
  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
  ```
- [**uv**](https://docs.astral.sh/uv/) (`brew install uv`). pymobiledevice3를 `uvx`로 돌리기 때문에 시스템에는 아무것도 설치하지 않습니다.
- **Node.js 22 이상** (내장 WebSocket과 fetch를 쓰고, npm 의존성은 없습니다)
- iOS 17 이상 아이폰. Mac과 페어링이 돼 있어야 합니다(USB로 한 번 연결해서 "신뢰"를 누르면 됩니다). 아이폰에서는 아래 설정을 켜 둡니다.
  - 설정 → 개인정보 보호 및 보안 → **개발자 모드**
  - 설정 → 앱 → Safari → 고급 → **웹 속성(Web Inspector)**
  - Chrome을 쓸 때: Chrome → 설정 → 콘텐츠 설정 → **Web Inspector**를 켜고 Chrome을 다시 시작

**USB 또는 Wi-Fi:** 케이블이 꽂혀 있으면 USB로 붙습니다. 케이블이 없으면 같은 네트워크에 있는 페어링된 아이폰과 macOS가 이미 맺어 둔 Wi-Fi 연결(Xcode가 쓰는 그 연결)을 그대로 씁니다. 그래서 Finder에서 따로 설정할 것은 없습니다. `IOS_TRANSPORT=usb|wifi`로 한쪽에 고정할 수도 있습니다.

iPhone 15 Pro, iOS 18.6.2, Xcode 27.2, pymobiledevice3 11.49.2에서 시험했습니다.

## 설치

```bash
/plugin marketplace add GUMBOKIM/iphone-webkit-inspector
/plugin install iphone-webkit-inspector@iphone-webkit-inspector
```

설치한 뒤 Claude에게 "이 페이지 아이폰에서 확인해 줘"처럼 말하거나 `/iphone-webkit-inspector:iphone-webkit-inspector`를 실행하면 됩니다. 설정이 맞는지 보려면 Claude에게 `doctor`를 돌려 달라고 하세요.

## 무엇을 실행하고 어디에 연결하나

- `node skills/iphone-webkit-inspector/ios.mjs`: Claude가 부르는 CLI입니다. 소스를 그대로 읽어 볼 수 있고 npm 의존성도 없습니다. 첫 명령을 실행할 때 같은 스크립트가 백그라운드 데몬으로 뜨는데, 이 데몬은 `127.0.0.1:9334`에서만 연결을 받습니다.
- `uvx --from pymobiledevice3==11.49.2 python bridge_guard.py webinspector cdp --port 9333`: Web Inspector 브리지입니다. 이쪽도 `127.0.0.1:9333`에서만 연결을 받습니다. 처음 실행하면 `uv`가 PyPI에서 이 버전의 pymobiledevice3를 내려받고, Python 3.12가 없으면 uv가 관리하는 Python 3.12도 받습니다.
- `bridge_guard.py`는 브리지 앞에서 웹페이지가 보낸 요청(`Origin` 헤더가 있는 요청)과 Host가 `127.0.0.1`/`localhost`가 아닌 요청을 막습니다. 그래서 Mac에 열어 둔 웹사이트가 브리지를 거쳐 아이폰에 닿을 수 없습니다. 데몬도 실행할 때마다 만드는 랜덤 토큰이 있어야 명령을 받습니다. 토큰은 `~/.cache/iphone-webkit-inspector/token`에 본인만 읽을 수 있게(권한 600) 저장합니다.
- `xcrun devicectl`: 아이폰을 찾고 Safari나 Chrome을 실행합니다.
- 브리지가 아이폰에 붙는 길은 USB면 macOS의 `usbmuxd`, Wi-Fi면 macOS가 Xcode용으로 열어 두는 CoreDevice 터널(`--native`)입니다. 어느 쪽이든 Mac과 아이폰 사이에서만 오갑니다.
- 아이폰에서 여는 페이지는 평소처럼 인터넷에서 불러오지만, 플러그인 자체가 바깥으로 보내는 것은 없습니다. `report`도 링크만 출력하고, 이슈를 올릴지는 사용자가 정합니다.
- 디스크에 쓰는 파일: `~/.cache/iphone-webkit-inspector/`(데몬 pid, 토큰, 로그), 그리고 요청한 스크린샷, 트레이스, 프로파일, 힙 스냅샷, HAR, 녹화 파일(기본 위치는 시스템 임시 폴더)
- `eval`, `tap`, `type`, `mock`, `block`, `inject`, `ua`, `js`, 디버거는 개발자 도구에서처럼 아이폰의 페이지를 실제로 바꿉니다. 그래서 Claude는 이 명령들을 사용자가 지정한 탭에서만 써야 합니다.

## 개인정보

명령이 돌려주는 내용은 모두 Claude Code 세션에 들어가고, 다른 도구 결과와 마찬가지로 모델 제공자에게 전달됩니다. 아이폰에서 요청한 내용도 포함됩니다. 페이지 텍스트와 HTML, 콘솔 메시지, 요청·응답 헤더와 본문, localStorage·sessionStorage·IndexedDB 내용, 쿠키 이름이 해당합니다(쿠키 값은 `cookies --values`를 쓸 때만 보입니다). 그렇게 공유해도 괜찮은 탭에서만 쓰고, 메일이나 은행 같은 개인 탭은 닫아 두거나 뒤에 두세요.

`~/.cache/iphone-webkit-inspector/`의 데몬 상태와 요청한 파일 말고는 아무것도 저장하지 않습니다. 데몬은 최근 콘솔·네트워크 이벤트를 메모리에만 들고 있다가, 멈추면(`ios.mjs stop`, 또는 브리지 종료) 버립니다.

## 한계

- 아이폰은 화면에 떠 있는 탭만 그립니다. 스크린샷, 녹화, 스냅샷의 위치 정보를 얻으려면 그 탭이 앞에 나와 있어야 합니다. 뒤에 있는 탭이라도 JS, 콘솔, 네트워크, 디버거는 쓸 수 있습니다.
- 화면에 보이는 탭 바꾸기, Safari 자체 버튼 누르기, 권한 팝업 응답, 잠금 해제는 할 수 없습니다.
- `tap`과 `type`은 WebKit의 사용자 제스처 흉내를 켜고 페이지 안에서 돌아갑니다. OS 수준에서 화면을 터치하는 것과는 다릅니다.
- 성능 트레이스를 뜨는 도중에 다른 사이트로 넘어가면 기록이 거의 빈 채로 돌아옵니다. 같은 사이트에서 새로고침하며 기록하세요.

## 문제 신고

Claude에게 `report`를 실행해 달라고 하거나 직접 실행하세요.

```bash
node <plugin>/skills/iphone-webkit-inspector/ios.mjs report --title "..." --what "실행한 것, 기대한 결과, 실제 결과"
```

`report`는 버전 정보, `doctor` 결과, 데몬 로그를 모은 다음 기기·Mac 이름, UDID, 홈 경로, 방문한 주소를 가려서 저장합니다. 그다음 내용이 미리 채워진 [새 이슈](https://github.com/GUMBOKIM/iphone-webkit-inspector/issues/new/choose) 링크를 출력합니다. 올리기 전에 내용을 한 번 읽어 보세요.

보안 문제는 공개 이슈 대신 [비공개 신고](SECURITY.md)로 알려 주세요.

## 라이선스

Apple과 관련이 없고 Apple의 승인을 받지 않았습니다. iPhone, Safari, WebKit이라는 이름은 이 도구가 다루는 대상을 설명하려고만 씁니다.

MIT. pymobiledevice3는 별도의 GPL-3.0 프로젝트입니다. 이 플러그인은 그것을 `uvx`로 실행만 할 뿐 코드를 포함하지는 않습니다.
