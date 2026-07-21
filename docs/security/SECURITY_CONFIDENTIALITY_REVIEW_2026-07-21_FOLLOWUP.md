# RecordDrive 기밀성 보안 심층 검토 및 추가 보완 보고서

- 검토일: 2026-07-21 (KST)
- 검토 원본: `RecordDrive.zip`
- 원본 SHA-256: `18f56d3f7be8329189a4308fc0f74491fd04111d6221cd000b4410228ab3c11f`
- 범위: 인증·세션, 저장소 인가, 사용자 식별정보 노출, 오류 응답, 업로드·다운로드·미리보기, 파일시스템 경계, 비밀정보, 의존성, Git 이력
- 결론: **기밀성에 직접 영향을 주는 높은 우선순위 문제 2건을 수정했고, 세션 저장소에 방어 심층화 1건을 추가했습니다. 검토한 현재 소스에서 미해결 Critical 등급 기밀성 취약점은 확인되지 않았습니다.**

이 문서는 기존 `SECURITY_CONFIDENTIALITY_REVIEW_2026-07-21_FINAL.md` 이후 현재 업로드본을 다시 기준으로 수행한 추가 검토 결과입니다.

## 1. 검토 방법

1. ZIP 경로 이동, 심볼릭 링크, 비정상 압축률을 검사한 뒤 별도 작업 디렉터리에 안전하게 추출했습니다.
2. 수정 전에 `.git` 전체 파일의 SHA-256 목록을 생성하고 `git fsck --full --no-reflogs`를 실행했습니다.
3. Express 미들웨어 순서, 인증/MFA/세션 수명주기, 저장소별 권한 검사, 권한 부여 UI, 파일 다운로드·미리보기, 업로드 스트리밍, 저장 경로 검증, 오류 처리 흐름을 수동 추적했습니다.
4. 동적 코드 실행, 외부 프로세스, 동적 SQL, 경로 조작, 비밀정보 로그·응답, 사용자 디렉터리 노출, 정적 웹 루트 내 저장 여부를 정적 검색했습니다.
5. 작업 트리와 Git 32개 커밋의 텍스트 blob 553개를 고신뢰도 개인키·AWS·GitHub·Slack·Google 토큰 형식으로 검사했습니다.
6. npm 잠금파일 기준으로 의존성을 설치하고 운영 및 전체 의존성 감사를 수행했습니다.
7. 각 수정에 회귀 테스트를 추가하고 전체 테스트를 재실행했습니다.

## 2. 확인 및 수정한 사항

### RD-C-2026-07 — 일반 저장소 소유자가 전체 사용자 계정 디렉터리를 열람 가능

- 심각도: **High (다중 사용자·개인정보 민감 환경 기준)**
- 영향:
  - 일반 사용자는 누구나 개인 저장소를 만든 뒤 권한 관리 화면을 열 수 있었습니다.
  - 해당 화면의 드롭다운에는 권한이 아직 없는 모든 일반 사용자의 표시 이름과 로그인 사용자명이 일괄 노출되었습니다.
  - 조직 구성원 목록, 계정 식별자, 내부 명명 규칙을 수집해 피싱·계정 추측·표적 공격에 활용할 수 있었습니다.
- 원인:
  - 권한 페이지 데이터 조회가 `users` 테이블의 모든 대상 계정을 반환했습니다.
  - 렌더링 템플릿이 이를 `<select>` 목록으로 그대로 출력했습니다.
- 수정:
  - 전체 사용자 목록 조회를 제거했습니다.
  - 권한 부여는 소유자가 이미 알고 있는 **정확한 사용자명**을 입력하는 방식으로 변경했습니다.
  - 서버는 정규화·형식 검증 후 정확히 일치하는 일반 사용자만 조회하며, 소유자 본인과 관리자 계정은 계속 거부합니다.
  - 신규 부여 실패 응답은 기존의 일반화된 메시지를 유지합니다.
  - 이미 권한이 부여된 사용자는 해당 저장소의 명시적 관계 당사자이므로 현재 권한 목록에만 표시됩니다.
- 회귀 테스트:
  - 권한 페이지에 관련 없는 두 사용자 계정이 노출되지 않음을 확인합니다.
  - `userId` 드롭다운이 사라지고 `username` 정확 입력 필드만 존재함을 확인합니다.
  - 정확한 사용자명으로 부여한 뒤 대상 사용자만 현재 권한 목록에 나타나고 실제 접근이 허용됨을 확인합니다.

### RD-C-2026-08 — 외부에 노출된 development 실행에서도 내부 예외 메시지 반환 가능

- 심각도: **High (외부 리스너가 development 모드인 경우)**
- 영향:
  - 기존 런타임 정책은 development 모드라도 비루프백 리스너에 강한 비밀키와 HTTPS를 강제했습니다.
  - 그러나 일반 500 오류 응답은 오직 `isProduction` 여부만 확인해 development 모드에서 `error.message`를 클라이언트에 반환했습니다.
  - 외부에서 오류를 유발할 수 있으면 내부 파일 경로, 데이터베이스 제약, 파서·라이브러리 세부 정보가 노출될 수 있었습니다.
- 수정:
  - 상세 오류는 **비프로덕션이면서 루프백 전용**일 때만 허용하는 `exposeDetailedErrors` 정책을 추가했습니다.
  - production 또는 비루프백 리스너에서는 모든 예상 밖 500 응답이 일반화된 메시지만 반환합니다.
  - 상세 오류는 기존처럼 서버 측 로그에서 조사할 수 있습니다.
- 회귀 테스트:
  - 루프백 테스트 환경은 상세 오류 허용 상태임을 확인합니다.
  - 강한 비밀키와 HTTPS를 갖춘 외부 development 리스너도 상세 오류 비활성 상태임을 확인합니다.

### RD-C-2026-09 — SQLite 세션 저장 키의 방어 심층화

- 심각도: **Medium / Defense in Depth**
- 영향:
  - 기존 `sessions.sid`에는 브라우저가 사용하는 무작위 세션 ID가 그대로 저장되었습니다.
  - 쿠키 서명은 별도 보호를 제공하지만, 세션 저장소·백업과 서명 비밀키가 함께 유출되는 복합 사고에서 원본 ID를 직접 보관하지 않는 편이 안전합니다.
- 수정:
  - 브라우저 세션 ID는 SQLite에 직접 저장하지 않습니다.
  - `SESSION_SECRET`에서 용도 분리된 키를 도출하고, 세션 ID의 HMAC-SHA-256 결과만 `sessions.sid`에 저장합니다.
  - 조회, 갱신, 폐기, 사용자별 세션 제한, MFA 변경 후 다른 세션 폐기 로직을 모두 동일한 저장 식별자 체계로 변경했습니다.
  - 저장된 값만으로 브라우저 세션 ID를 역산할 수 없습니다.
- 운영 영향:
  - 배포 전의 기존 원시 세션 행은 새 저장 키로 조회되지 않으므로 사용자는 한 번 다시 로그인해야 합니다.
  - 기존 행은 만료 정리 시 제거됩니다.
- 회귀 테스트:
  - 브라우저 쿠키의 세션 ID와 DB의 `sid`가 다름을 확인합니다.
  - DB 값이 기대한 HMAC 결과 및 64자리 16진수 형식임을 확인합니다.
  - 변환 후에도 인증 세션이 정상 동작하고 세션 회전·제한·폐기가 유지됨을 확인합니다.

## 3. 추가로 검토했으며 현재 중대한 결함을 확인하지 않은 영역

- 저장소의 보기, 업로드, 다운로드, 삭제, 관리 권한은 각 요청에서 다시 검사되며 권한 없는 저장소는 404로 처리됩니다.
- 다운로드와 미리보기의 파일 조회는 인가된 저장소 ID에 종속됩니다.
- 업로드 파일은 공개 웹 루트 밖에 무작위 저장명으로 보관되며 디렉터리·파일 권한이 제한됩니다.
- 저장 경로 정규화, 보호 디렉터리 중첩 차단, 심볼릭 링크 거부, `O_NOFOLLOW` 기반 열기가 적용되어 있습니다.
- 인증 응답은 존재하지 않는 사용자와 잘못된 비밀번호에 같은 메시지와 더미 bcrypt 비교를 사용합니다.
- 로그인·MFA 완료·보안 재확인 시 세션이 회전하고, idle/absolute 만료와 사용자별 세션 제한이 적용됩니다.
- 인증된 응답은 `Cache-Control: private, no-store`이며 쿠키는 HttpOnly, SameSite=Strict, 필요 시 Secure입니다.
- TOTP 비밀, 임시 복구 코드 묶음, TLS 비밀번호는 인증 암호화되고 복구 코드는 해시로 저장됩니다.
- PDF 응답은 sandbox CSP와 no-referrer/CORP 정책을 적용하며, ZIP/XLSX/7z 미리보기는 항목·크기·시간 제한을 둡니다.
- 사용자 입력이 SQL 구문으로 직접 연결되는 경로는 확인되지 않았고 동적 구문은 허용 목록 또는 고정 조각으로 제한됩니다.
- 애플리케이션 런타임에서 업로드 파일 처리를 위한 외부 명령 실행 경로는 확인되지 않았습니다.
- 현재 작업 트리 및 Git 이력에서 고신뢰도 실제 비밀키·토큰 패턴은 확인되지 않았습니다.

## 4. 검증 결과

- `npm run check`: 통과
- 전체 Node 테스트: **64/64 통과, 실패 0**
- 새 기밀성 회귀 테스트: 사용자 디렉터리 비노출, HMAC 세션 저장, 외부 오류 상세 비활성화 모두 통과
- `npm audit --omit=dev`: Critical 0 / High 0 / Moderate 0 / Low 0
- `npm audit` 전체 그래프: Critical 0 / High 0 / Moderate 0 / Low 0
- Git 이력 비밀 검사: 32개 커밋, 553개 텍스트 blob, 고신뢰도 탐지 0
- `.git` 파일 수: 28
- 수정 전·후 `.git` 파일별 SHA-256 목록: 완전 일치
- `.git` 콘텐츠 매니페스트 SHA-256: `bd13838247694374f8456371eb9b834eefd6883d6d5cca7f99e1211caaba013d`
- 최종 `git fsck --full --no-reflogs`: 통과

테스트 런타임 Node.js `v22.16.0`은 프로젝트가 선언한 최소 패치 버전 `^22.23.0`보다 낮습니다. 모든 테스트는 통과했지만 실제 배포는 `package.json`의 엔진 범위에 포함되는 버전을 사용해야 합니다.

## 5. 변경 파일

- `src/app.js`
- `src/config.js`
- `src/i18n.js`
- `src/routes/auth.js`
- `src/routes/repositories.js`
- `src/routes/settings.js`
- `src/session-store.js`
- `views/repository-permissions.ejs`
- `test/file-access-time.test.js`
- `test/preview.test.js`
- `test/security-hardening.test.js`
- `test/smoke.test.js`
- `docs/security/SECURITY_CONFIDENTIALITY_REVIEW_2026-07-21_FOLLOWUP.md`

## 6. 참고한 공식 보안 지침

- OWASP Authorization Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP Authentication Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Error Handling Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP File Upload Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- MITRE CWE-200 — https://cwe.mitre.org/data/definitions/200.html
