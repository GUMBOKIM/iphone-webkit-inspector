# iPhone WebKit Inspector

[English](README.md)

Claude가 **실제 아이폰의 Safari나 Chrome**을 개발자 도구 수준으로 들여다보고 조작하게 해 주는 Claude Code 플러그인입니다. USB와 Wi-Fi 둘 다 됩니다.

Playwright와 Chrome 개발자 도구로는 아이폰 실기기의 Safari를 조종할 수 없습니다. 이 플러그인은 대신 Safari의 Web Inspector를 거칩니다. 작은 데몬이 [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)의 CDP 브리지를 띄우고, 탭마다 연결을 유지하면서 콘솔, 네트워크, 디버거 이벤트를 모아 둡니다. Claude는 CLI 하나로 이 데몬과 통신합니다.

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
| 스크린샷 | ✅ | ✅ 전체 페이지 포함 | ⚠️ 보이는 화면만 |
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

정리하면, 개발자 도구를 여는 이유가 되는 기능은 실제 아이폰에서도 거의 다 됩니다. 빠진 것은 OS 수준 입력(브라우저 UI, 키보드), 속도 제한, Lighthouse, LCP입니다.

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

- **Xcode**가 설치된 macOS (`devicectl` 때문에 필요합니다). 한 번만 지정하고 라이선스에 동의하면 됩니다.
  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
  ```
- [**uv**](https://docs.astral.sh/uv/) (`brew install uv`). pymobiledevice3는 `uvx`로 실행되고, 시스템에는 아무것도 설치되지 않습니다.
- **Node.js 22 이상** (내장 WebSocket과 fetch를 씁니다. npm 의존성은 없습니다)
- iOS 17 이상 아이폰. Mac과 페어링되어 있어야 합니다(한 번 USB로 연결하고 "신뢰"를 누르면 됩니다). 그리고 아래 설정을 켭니다.
  - 설정 → 개인정보 보호 및 보안 → **개발자 모드**
  - 설정 → 앱 → Safari → 고급 → **웹 속성(Web Inspector)**
  - Chrome을 쓸 때: Chrome → 설정 → 콘텐츠 설정 → **Web Inspector**를 켠 뒤 Chrome 재시작

**USB 또는 Wi-Fi:** 케이블이 꽂혀 있으면 USB를 씁니다. 케이블이 없으면 macOS가 같은 네트워크의 페어링된 아이폰과 이미 유지하고 있는 Wi-Fi 연결(Xcode가 쓰는 연결)을 그대로 씁니다. 그래서 Finder 설정은 필요 없습니다. `IOS_TRANSPORT=usb|wifi`로 고정할 수도 있습니다.

iPhone 15 Pro, iOS 18.6.2, Xcode 27.2, pymobiledevice3 11.49.2에서 시험했습니다.

## 설치

```bash
/plugin marketplace add GUMBOKIM/iphone-webkit-inspector
/plugin install iphone-webkit-inspector@iphone-webkit-inspector
```

설치한 뒤 Claude에게 "이 페이지 아이폰에서 확인해 줘"처럼 말하거나 `/iphone-webkit-inspector:iphone-webkit-inspector`를 실행하면 됩니다. 설정이 맞는지 보려면 Claude에게 `doctor`를 돌려 달라고 하세요.

## 무엇을 실행하고 어디에 연결하나

- `node skills/iphone-webkit-inspector/ios.mjs`: Claude가 호출하는 CLI입니다. 읽을 수 있는 소스이고 npm 의존성이 없습니다. 첫 명령을 실행하면 같은 스크립트로 백그라운드 데몬이 뜨고, `127.0.0.1:9334`에서만 대기합니다.
- `uvx --from pymobiledevice3==11.49.2 pymobiledevice3 webinspector cdp --port 9333`: Web Inspector 브리지입니다. `127.0.0.1:9333`에서만 대기합니다. 처음 실행할 때 `uv`가 이 버전을 PyPI에서 받습니다.
- `xcrun devicectl`: 아이폰을 찾고 Safari나 Chrome을 실행합니다.
- 브리지는 USB일 때 macOS의 `usbmuxd`로, Wi-Fi일 때 macOS가 Xcode용으로 유지하는 CoreDevice 터널(`--native`)로 아이폰에 연결합니다. 둘 다 Mac과 아이폰 사이에서만 오갑니다.
- 아이폰에서 여는 페이지는 평소처럼 인터넷에서 불러옵니다. 플러그인 자체는 다른 곳으로 아무것도 보내지 않습니다. `report --submit`은 요청했을 때만 사용자의 `gh` 로그인으로 GitHub 이슈를 올립니다.
- 쓰는 파일: `~/.cache/iphone-webkit-inspector/`(데몬 pid와 로그), 그리고 요청한 스크린샷, 트레이스, 프로파일, 힙 스냅샷, HAR, 녹화 파일(기본 위치는 시스템 임시 폴더)
- `eval`, `tap`, `type`, `mock`, `block`, `inject`, `ua`, `js`, 디버거는 개발자 도구처럼 아이폰의 페이지를 바꿉니다. Claude는 사용자가 지정한 탭에서만 써야 합니다.

## 한계

- 아이폰 화면에 떠 있는 탭만 그려집니다. 그래서 스크린샷, 녹화, 스냅샷의 위치 정보는 그 탭이 앞에 있어야 합니다. 뒤쪽 탭도 JS, 콘솔, 네트워크, 디버거는 됩니다.
- 화면에 보이는 탭 바꾸기, Safari 자체 버튼 누르기, 권한 팝업 응답, 잠금 해제는 할 수 없습니다.
- `tap`과 `type`은 WebKit의 사용자 제스처 흉내를 켠 채 페이지 안에서 실행됩니다. OS 수준의 터치는 아닙니다.
- 성능 트레이스 중에 다른 사이트로 이동하면 기록이 거의 비어서 돌아옵니다. 같은 사이트를 새로고침하면서 기록하세요.

## 문제 신고

Claude에게 `report`를 실행해 달라고 하거나 직접 실행하세요.

```bash
node <plugin>/skills/iphone-webkit-inspector/ios.mjs report --title "..." --what "실행한 것, 기대한 결과, 실제 결과"
```

버전 정보, `doctor` 결과, 데몬 로그를 모으고, 기기·Mac 이름, UDID, 홈 경로, 방문한 주소를 가린 뒤 저장합니다. 그리고 내용이 채워진 [새 이슈](https://github.com/GUMBOKIM/iphone-webkit-inspector/issues/new/choose) 링크를 출력합니다. `--submit`을 붙이면 `gh`로 바로 올립니다.

## 라이선스

MIT. pymobiledevice3는 별도의 GPL-3.0 프로젝트입니다. 이 플러그인은 그것을 `uvx`로 실행할 뿐 포함하지 않습니다.
