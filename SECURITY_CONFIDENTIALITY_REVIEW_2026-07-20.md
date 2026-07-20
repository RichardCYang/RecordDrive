# RecordDrive 기밀성 보안 심층 점검 및 수정 보고서

- 점검일: 2026-07-20 (KST)
- 점검 대상 원본: `RecordDrive.zip`
- 원본 SHA-256: `694c9cec67d5b9ea6c18c1eeae9a6c1846ccd4c0373060b03848a46ef2905bc8`
- 중점 범위: 인증·세션, 저장 파일 접근통제, 업로드 파일 파싱/미리보기, 비밀정보 노출, 사용자 개인정보 최소 공개, 의존성 취약점
- 결론: **확인된 Critical 등급 취약점은 없었으나, 실제 기밀정보 유출로 이어질 수 있는 High 1건, Medium 2건, Medium-Low 1건을 수정함.**

## 1. 점검 방법

1. ZIP 경로 조작·심볼릭 링크 여부를 확인한 뒤 별도 작업 디렉터리에 안전하게 압축 해제함.
2. Express 라우팅, 저장 경로 검증, 권한 미들웨어, 세션 저장소, MFA/WebAuthn 흐름, 파일 미리보기 파서를 수동 추적함.
3. 외부 프로세스 실행, 환경변수 전달, 동적 SQL, HTML 비이스케이프 출력, 정적 파일 노출, 민감 로그, 비밀 패턴을 정적 검색함.
4. 작업 트리와 `.git` 전체 blob을 대상으로 고신뢰 비밀 패턴(개인키, AWS/GitHub/Slack/Google 키 등)을 검사함.
5. `npm audit` 및 전체 Node 테스트를 실행함.
6. 수정 전후 `.git` 파일별 SHA-256 매니페스트를 비교함.

## 2. 수정한 취약점

### RD-C-01 — 비신뢰 7z 파일을 앱 권한과 전체 비밀 환경변수로 네이티브 파싱

- 심각도: **High**
- 영향: 업로드 사용자가 조작한 7z/NTFS 이미지를 7-Zip 네이티브 코드가 애플리케이션과 동일한 OS 사용자로 처리했음. 파서 취약점 악용 시 SQLite DB, 업로드 파일, 세션/MFA/TLS 관련 환경변수 등 애플리케이션이 읽을 수 있는 기밀정보 전체가 노출될 수 있었음.
- 근거:
  - 기존 Dockerfile은 버전을 고정하지 않은 Alpine `7zip` 패키지를 기본 설치했음.
  - 7z 미리보기는 설정 없이 자동 활성화되며 `spawn()`에 `process.env` 전체를 전달했음.
  - GitHub Security Lab은 7-Zip 26.00의 조작된 NTFS 입력으로 인한 heap buffer overflow와 잠재적 임의 코드 실행을 공개했고, 26.01에서 수정됐다고 밝힘.
- 수정:
  - `SEVEN_ZIP_PREVIEW_ENABLED=false`를 기본값으로 추가하고 명시적 opt-in 없이는 네이티브 파서를 실행하지 않음.
  - 기본 Docker 이미지에서 7-Zip 설치를 제거하고 `RECORDDRIVE_INSTALL_7ZIP=true` 빌드 인수로만 선택 설치함.
  - opt-in 상태에서도 자식 프로세스 환경을 실행에 필요한 `PATH`/임시 디렉터리/로캘 등으로 제한하고 앱 비밀 환경변수를 전달하지 않음.
  - 비활성화 상태와 환경변수 차단을 회귀 테스트로 추가함.
- 잔여 위험: opt-in 시 네이티브 파서는 여전히 RecordDrive OS 계정으로 실행됨. 별도 컨테이너/프로세스, 읽기 전용 파일시스템, 네트워크 차단, 최소 권한 계정 등 추가 격리를 권장함.

### RD-C-02 — 업로드 PDF의 동일 출처 무샌드박스 인라인 렌더링

- 심각도: **Medium**
- 영향: 공격자가 업로드한 PDF가 애플리케이션과 같은 출처의 일반 iframe 및 새 탭에서 열렸음. 브라우저 PDF 처리 취약점이나 PDF 활성 콘텐츠 동작에 따라 사용자 세션이 존재하는 출처에서 위험한 동작이 수행될 가능성을 불필요하게 높였음.
- 수정:
  - PDF iframe에 빈 `sandbox` 속성과 `referrerPolicy=no-referrer`를 적용함.
  - PDF 응답에 전용 `Content-Security-Policy: sandbox; default-src 'none'; ...`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Resource-Policy`를 설정함.
  - 새 탭 링크에 `noopener noreferrer`를 적용함.
  - 헤더와 클라이언트 샌드박스 설정을 통합 테스트로 검증함.

### RD-C-03 — 민감 설정 재인증 후 세션 ID 미회전 및 MFA 변경 후 기존 세션 유지

- 심각도: **Medium**
- 영향: 이미 탈취된 세션 ID가 있을 때 사용자가 비밀번호를 재확인하면 동일한 세션이 민감 보안 설정 접근 권한을 얻을 수 있었음. 또한 TOTP/패스키를 추가·제거해도 다른 기존 로그인 세션이 계속 유효했음.
- 수정:
  - 비밀번호 재확인 성공 직후 `session.regenerate()`로 기존 세션 ID를 폐기하고 새 ID를 발급함.
  - 원래 로그인 시각과 절대 세션 수명은 유지하면서 보안 확인 시각만 새로 설정함.
  - TOTP 또는 패스키 추가·제거 시 현재 세션을 제외한 해당 사용자 세션을 서버 저장소에서 즉시 삭제함.
  - 관리자 계정 삭제 시 해당 사용자의 인증/MFA 진행 중 세션까지 삭제함.
  - 세션 ID 회전과 타 세션 폐기를 통합 테스트로 검증함.

### RD-C-04 — 보기 전용 공유 사용자에게 참여자 계정명·권한 구조 노출

- 심각도: **Medium-Low**
- 영향: 저장소 보기 권한만 가진 사용자가 다른 공유 사용자의 표시 이름, 로그인 사용자명, 세부 권한을 저장소 페이지에서 확인할 수 있었음. 업무 조직도·계정 식별자·권한 배치가 불필요하게 노출됐음.
- 수정:
  - 소유자/관리자만 전체 공유 사용자 목록과 권한 정보를 조회하도록 변경함.
  - 일반 공유 사용자는 공유 인원 수만 확인할 수 있게 함.
  - 사용되지 않던 업로더 사용자명 필드를 SQL 결과에서 제거함.
  - 비관리자 페이지에 다른 참여자의 사용자명이 나타나지 않는 테스트를 추가함.

## 3. 확인했으나 추가 수정이 필요하지 않았던 주요 항목

- 저장 파일은 웹 루트 외부에 난수 저장명으로 보관되고, DB/업로드 디렉터리에 소유자 전용 POSIX 권한이 적용됨.
- 경로 정규화, 저장 파일명 검증, 심볼릭 링크 거부, `O_NOFOLLOW` 기반 접근이 적용됨.
- 저장소별 view/upload/download/delete 권한이 각 라우트에서 다시 검증되며, 권한 없는 파일 미리보기/다운로드는 일반 404로 처리됨.
- 로그인 및 MFA 완료 시 세션 재생성, HttpOnly/SameSite/production Secure 쿠키, idle/absolute timeout, 사용자별 세션 상한이 구현돼 있음.
- CSRF 검증은 일반 폼·JSON·multipart 업로드에 적용됨.
- TOTP 비밀, 임시 복구키 번들, 저장 TLS passphrase는 인증 암호화로 보호되며 복구키는 해시로 저장됨.
- EJS의 비이스케이프 출력은 정적 partial include 용도로만 사용되고, 사용자 입력 출력은 escape 처리됨.
- 작업 트리 및 `.git` 기록에서 고신뢰 하드코딩 비밀 패턴은 발견되지 않음.

## 4. 검증 결과

- `node --check`: 변경 JavaScript 전부 통과
- `npm test`: **55/55 통과, 실패 0**
- `npm audit` (production 및 전체): **취약점 0건**
- 테스트 런타임: Node.js `v22.16.0`, npm `10.9.2`
- 주의: 프로젝트 선언 엔진은 Node.js `^22.23.0 || ^24.17.0 || ^26.3.1`이므로 로컬 테스트 런타임은 선언된 최소 패치 버전보다 낮음. 기능 테스트는 통과했지만 실제 배포는 Dockerfile의 Node.js 24 계열 등 지원 버전을 사용해야 함.
- Docker: 점검 환경에 Docker CLI가 없어 컨테이너 빌드는 실행하지 못함.

## 5. `.git` 보존 검증

- `.git` 파일 수: 28
- 수정 전 `.git` 전체 파일 매니페스트 SHA-256: `b0d680425129b617d0ed7a1a16676a60ebfb27783fbc2f01f2d4986976ca505e`
- 수정 후 `.git` 전체 파일 매니페스트 SHA-256: `b0d680425129b617d0ed7a1a16676a60ebfb27783fbc2f01f2d4986976ca505e`
- 최종 ZIP 생성 시 `.git` 항목은 원본 ZIP에서 직접 복사하여 파일 바이트와 경로·권한·타임스탬프 메타데이터를 재사용함.
- 결과: **파일 목록과 각 파일 내용이 모두 동일하며 `.git`은 삭제·변경하지 않음.**

## 6. 변경 파일

- `.env.example`
- `Dockerfile`
- `README.md`
- `public/js/app.js`
- `src/config.js`
- `src/file-preview.js`
- `src/i18n-preview.js`
- `src/routes/admin.js`
- `src/routes/repositories.js`
- `src/routes/settings.js`
- `src/session-store.js`
- `views/repository.ejs`
- `test/preview.test.js`
- `test/security-hardening.test.js`
- `test/seven-zip-preview.test.js`
- `SECURITY_CONFIDENTIALITY_REVIEW_2026-07-20.md` (본 보고서)

## 7. 참고 자료

- GitHub Security Lab, GHSL-2026-140 — https://securitylab.github.com/advisories/GHSL-2026-140_7-Zip/
- OWASP File Upload Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP Authentication Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
