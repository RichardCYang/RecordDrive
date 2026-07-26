# RecordDrive 후속 심층 보안 분석 및 수정 보고서

- 분석일: 2026-07-26
- 대상: RecordDrive 2.1.0 (`RecordDrive.zip`)
- 기준: OWASP ASVS 5.0.0, OWASP Web Security Testing Guide, OWASP Top 10:2025, Unicode UTS #39, MITRE CWE
- 방식: 압축 안전성 검사, 소스·설정·데이터 흐름 수동 검토, 정적 패턴 검사, 로컬 PoC, 회귀 테스트, 패키지 잠금파일 및 공개 보안 권고 대조

## 1. 결론

이번 범위에서 새로 확인된 **Critical/High 취약점은 없었습니다.** 다만 인증된 사용자가 파일·폴더·저장소 등 화면에 표시되는 이름에 Unicode 양방향 제어문자를 삽입하여 확장자나 대상을 시각적으로 위장할 수 있는 **Medium 등급 취약점 1건(CWE-451)**을 재현했고 수정했습니다. 또한 원본 ZIP의 `smb/entrypoint.sh`가 CRLF 줄바꿈이라 Linux 컨테이너에서 셸 구문 분석에 실패할 수 있는 배포 차단 문제 1건을 수정했습니다.

| 구분 | 건수 | 상태 |
|---|---:|---|
| Critical | 0 | 새로 확인되지 않음 |
| High | 0 | 새로 확인되지 않음 |
| Medium | 1 | 수정·PoC 회귀 검증 완료 |
| 운영/가용성 | 1 | 수정·셸 구문 검증 완료 |

이 결과는 “취약점이 전혀 없다”는 보증이 아닙니다. 외부 레지스트리 장애로 전체 의존성 설치·통합 테스트·전이 의존성 자동 감사는 완료하지 못했으며, 해당 한계는 8절에 명시했습니다.

## 2. 확인된 취약점 RD-2026-01

### 사용자 표시 이름의 Unicode 양방향 제어문자 허용

- 심각도: Medium
- 분류: CWE-451 (User Interface Misrepresentation of Critical Information)
- 공격 전제: 로그인 후 저장소 쓰기·생성 권한 등 해당 이름을 만들 수 있는 권한
- 영향 대상: 업로드 원본 파일명, SMB 동기화 파일명, 폴더명, 저장소명·설명, 사용자 표시명, 패스키명, 기존 DB 레코드의 화면 출력

원본 `safeOriginalName()`은 C0 제어문자와 DEL만 제거했고, `U+202E RIGHT-TO-LEFT OVERRIDE`, `U+2066 LEFT-TO-RIGHT ISOLATE` 같은 명시적 방향 제어문자를 유지했습니다. Linux의 `path.basename()`만 사용하여 브라우저가 Windows 전체 경로 형태의 파일명을 전달하는 경우 경로 구성요소도 표시명에 남았습니다.

이 문제는 서버 저장 경로 탈출이나 임의 코드 실행으로 이어지지는 않았습니다. 실제 저장 파일명은 임의화되어 있고 EJS 기본 escaping도 적용되어 있습니다. 그러나 사용자가 보는 확장자·저장소·대상 이름이 재정렬될 수 있어 관리자 또는 협업 사용자가 다른 파일 형식이나 대상을 선택했다고 오인할 수 있습니다.

### 원본 PoC

입력 예시:

```text
invoice.pdf<U+202E>exe
C:\Users\Public\report.docx<U+2066>fdp.exe<U+2069>
```

원본 동작:

```text
invoice.pdf<U+202E>exe           -> 제어문자를 포함한 채 저장
Windows 전체 경로 + isolate 문자 -> 전체 문자열과 제어문자를 포함한 채 저장
```

정확한 코드포인트와 JSON 결과는 `docs/security/evidence/2026-07-26-follow-up-audit/original-display-name-poc.txt`에 보관했습니다.

### 수정 내용

1. `src/display-text-security.js`를 추가해 C0/C1 제어문자와 명시적 Unicode 방향 제어문자를 중앙에서 탐지·제거합니다.
2. 파일명은 NFC 정규화 후 `\`를 `/`로 바꿔 POSIX basename을 적용하고, 위험 제어문자 제거·공백 축약·길이 제한을 수행합니다.
3. 폴더 ID·이름은 위험 제어문자가 있으면 거부합니다.
4. 저장소명·설명, 사용자 표시명, 패스키명은 저장 전에 정리합니다.
5. 기존 DB에 남은 레거시 값도 안전하게 보이도록 모든 보안 관련 EJS 출력 지점에 `safeDisplayText()`를 적용했습니다.
6. `Content-Disposition` 파일명도 동일한 안전화 함수를 사용합니다.
7. 내부 리다이렉트는 원문뿐 아니라 percent-decoding 후의 양방향 제어문자, 역슬래시, scheme-relative 형태도 거부합니다.

### 수정 후 PoC

```text
invoice.pdf<U+202E>exe                         -> invoice.pdfexe
C:\Users\Public\report.docx<isolate>...      -> report.docxfdp.exe
```

PoC: `security-poc/display-name-bidi-spoofing.mjs`  
회귀 테스트: `test/display-text-security.test.js`

## 3. 운영/가용성 수정 RD-2026-02

원본 ZIP의 `smb/entrypoint.sh`는 CRLF 줄바꿈이어서 Linux의 `sh -n`에서 구문 오류가 발생했습니다. 내용을 바꾸지 않고 LF로 정규화했으며 `sh -n smb/entrypoint.sh` 통과를 확인했습니다. 이는 직접적인 보안 취약점보다는 SMB sidecar 배포 실패를 유발하는 가용성 문제입니다.

## 4. 기존 보안 통제 독립 확인

현재 코드에서 다음 방어가 적용되어 있음을 소스 데이터 흐름 기준으로 확인했습니다.

- Helmet/CSP, Host allowlist, 외부 배포의 HTTPS fail-closed, 제한된 trust proxy 설정
- 전역 CSRF 및 multipart 업로드의 파일 쓰기 전 CSRF 검사
- 암호화·HMAC 보호 세션 저장, idle/absolute 만료, 세션 회전·폐기
- 로그인 오류 일반화, dummy hash, 입력 바이트 한도, 인증 rate-limit 로직
- MFA challenge 원자적 소비, TOTP replay 방지, 복구 코드 원자적 소비
- 저장소 권한 중앙화, 비인가 리소스의 404 은닉
- SQL parameter binding과 동적 정렬 allowlist
- canonical path, symlink ancestor 거부, `O_NOFOLLOW`, regular-file 검증 및 안정된 file descriptor 사용
- 스트리밍 중 재인가, PDF sandbox CSP, ZIP/XLSX/7z 미리보기의 크기·항목·깊이 제한
- 7z 파서 worker 격리, SMB 쓰기 모드 fail-closed 및 quota 방어
- 클라이언트 HTML 삽입 sink 부재, EJS unescaped 태그가 partial include에만 사용됨

## 5. 정적 분석 결과

- 애플리케이션 코드에서 `eval`, 동적 `Function`, 위험한 `child_process` 실행 경로를 새로 확인하지 못했습니다.
- 클라이언트/템플릿에서 `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` 사용을 확인하지 못했습니다.
- SQL 템플릿 문자열에 사용자 입력을 직접 보간하는 패턴을 확인하지 못했습니다.
- 작업 트리에서 실사용 private key, AWS access key, GitHub token, 결제 provider secret 패턴을 확인하지 못했습니다.
- ZIP 자체에 path traversal 항목과 symbolic-link 항목이 없음을 확인했습니다.

원시 결과: `docs/security/evidence/2026-07-26-follow-up-audit/static-scan-summary.txt`

## 6. 의존성 보안 확인

잠금파일의 직접 의존성 버전을 대조했습니다.

- `multer` 2.2.0: 2.2.0 미만에 영향을 주는 GHSA-3p4h-7m6x-2hcm 및 GHSA-72gw-mp4g-v24j의 수정 버전
- `yauzl` 3.4.0: 정확히 3.2.0에 영향을 주고 3.2.1에서 수정된 CVE-2026-31988/GHSA-6jvc-j5jv-xp3j의 영향 범위 밖

단, 레지스트리 audit API와 tarball 다운로드가 HTTP 503으로 실패하고 OSV API DNS도 사용할 수 없어 전이 의존성 전체에 대한 자동 감사 완료를 주장하지 않습니다.

## 7. 검증 결과

| 검증 | 결과 |
|---|---|
| 신규 PoC 원본 재현 | 성공: U+202E/U+2066/U+2069 유지 확인 |
| 수정 후 PoC | 성공: 위험 제어문자 제거 및 Windows 경로 basename 처리 |
| 독립 실행 가능한 집중 회귀 테스트 | 10/10 통과 |
| JavaScript 구문 검사 | 164개 파일 통과 |
| EJS 제어/표현식 구문 검사 | 21개 템플릿 통과 |
| SMB entrypoint 셸 구문 | 통과 |
| 전체 `node --test` 검색 | 77개 중 50 통과, 27 실패 |
| 전체 테스트 실패 원인 | 설치되지 않은 외부 모듈의 `ERR_MODULE_NOT_FOUND`; Assertion/Syntax 오류 0 |

집중 테스트 명령:

```sh
node --test \
  test/display-text-security.test.js \
  test/archive-preview-security.test.js \
  test/file-access-time-unit.test.js \
  test/password-policy.test.js
```

## 8. 검증 한계와 후속 필수 작업

1. 네트워크가 정상인 CI에서 지원 Node.js 버전으로 `npm ci`, `npm test`, `npm run test:security`, `npm audit --omit=dev`를 다시 실행해야 합니다.
2. 샌드박스 Node.js는 v22.16.0이었으나 프로젝트 요구사항은 `^22.23.0 || ^24.17.0 || ^26.3.1`입니다.
3. 실제 운영 DB, reverse proxy, TLS 인증서, SMB 서버, 브라우저 조합을 포함한 운영 환경 침투 테스트는 범위 밖입니다.
4. 표시 이름 정리로 제어문자만 다른 기존 레코드가 동일하게 보일 수 있으므로, 운영 DB에서 해당 코드포인트를 검색해 관리자 검토 후 정리하는 것을 권장합니다.

## 9. `.git` 보존

- 원본 ZIP의 `.git` 항목 수: 44
- 원본 `.git` ZIP manifest SHA-256: `4262e75ced2adabf6659407cdeff1d5e1a8ef56b6c787c2167a6235577f909b7`
- HEAD: `742293d7807bfde7b477970545c0ba5c3f13e01b`

수정 압축파일은 `.git`의 각 항목을 원본 ZIP에서 바이트와 ZIP 메타데이터 그대로 복사하는 방식으로 생성했습니다. 최종 검증에서 44개 항목의 파일명, 바이트 SHA-256, 크기, 압축 방식, timestamp, 속성, extra/comment 메타데이터가 원본 manifest와 모두 일치하도록 검사했습니다. `.git` 내부 파일을 생성·삭제·수정하지 않았습니다.

## 10. 수정 파일

정확한 목록은 `docs/security/evidence/2026-07-26-follow-up-audit/changed-files.txt`에 포함되어 있습니다. 핵심 변경은 다음과 같습니다.

- 신규: `src/display-text-security.js`
- 수정: `src/utils.js`, `src/repository-folders.js`, 관련 route와 EJS 화면
- 신규: `test/display-text-security.test.js`
- 신규: `security-poc/display-name-bidi-spoofing.mjs`
- 수정: `smb/entrypoint.sh` 줄바꿈 정규화
- 신규: 본 보고서와 검증 증적
