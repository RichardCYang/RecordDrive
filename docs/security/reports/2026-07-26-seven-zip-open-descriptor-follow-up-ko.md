# RecordDrive 7z 파일-디스크립터 경계 후속 보안 감사 및 수정 보고서

- 분석일: 2026-07-26
- 대상: 업로드된 `RecordDrive.zip` / RecordDrive 2.1.0
- 방식: 안전 압축 해제, 인증·권한·경로·업로드·미리보기·SMB·스토리지 흐름 수동 분석, 위험 패턴 검색, 로컬 경계 PoC, 회귀 테스트, 잠금파일과 공개 보안 권고 대조
- 기준선: 업로드된 ZIP의 파일 바이트. 작업 트리가 이미 Git 인덱스와 광범위하게 달라 Git diff는 기준선으로 사용하지 않았다.

## 1. 결론

이번 후속 검토에서 **새로운 Critical 또는 High 취약점은 확인되지 않았다.** 원격 웹 사용자만으로 재현되는 인증 우회, SQL 삽입, 임의 명령 실행, 저장형 XSS, 권한 없는 파일 읽기·쓰기, 경로 탈출도 확인하지 못했다.

다만 7z 미리보기에서 최초 권한검사를 통과한 열린 파일 디스크립터 대신 워커가 경로를 다시 열던 **조건부 TOCTOU 문제 1건**을 확인하고 수정했다. 기본 구성에서는 저장소 디렉터리가 `0700`이고 쓰기 SMB도 기본 비활성화되어 있어 원격 악용 경로가 확인되지 않았으므로 Critical/High로 평가하지 않았다. 그러나 별도 로컬 프로세스, 공유 스토리지, 잘못된 권한 설정 등으로 저장 파일 경로를 교체할 수 있으면, 워커가 같은 크기의 다른 inode 또는 심볼릭 링크 대상을 검사할 수 있었다.

또한 번들 Samba 진입 스크립트가 실제로 CRLF 줄바꿈이어서 Linux 컨테이너 실행 검사가 실패하는 운영 가용성 결함을 다시 확인하고 LF로 수정했다.

| 구분 | 건수 | 상태 |
| --- | ---: | --- |
| Critical | 0 | 새로 확인되지 않음 |
| High | 0 | 새로 확인되지 않음 |
| Medium (조건부/방어 심층) | 1 | 수정 및 PoC 검증 완료 |
| 운영 가용성 | 1 | 수정 및 셸/회귀 검증 완료 |

## 2. RD-2026-07-26-OD-01: 7z 미리보기 경로 재오픈 TOCTOU

- 분류: CWE-367 (Time-of-check Time-of-use Race Condition), CWE-363 (Race Condition Enabling Link Following)
- 평가: Medium, 단 기본 배포에서는 직접 원격 악용 경로가 확인되지 않은 조건부 방어 심층 문제
- 공격 전제: 미리보기 요청과 동시에 애플리케이션 저장 경로를 교체할 수 있는 로컬·공유 스토리지 쓰기 권한
- 가능한 영향: 권한검사 시 열었던 파일이 아닌 같은 크기의 다른 파일을 7z 메타데이터 파서가 검사하여 파일명·항목 수·크기 메타데이터를 잘못 노출하거나, 공격자가 선택한 입력을 파서에 전달
- 완화 요인: 메타데이터 전용 파서, worker 시간·메모리·읽기량·항목 제한, 저장 루트 `0700`, 경로 정규화, 기본 쓰기 SMB 비활성화

### 원본 흐름

1. HTTP 라우트가 `openStoredFile()`로 안전하게 파일을 열고 권한을 재확인했다.
2. PDF는 이 열린 파일 디스크립터를 그대로 스트리밍했고, XLSX/ZIP도 열린 디스크립터에서 읽었다.
3. 7z만 `opened.filePath`를 워커에 전달했다.
4. 워커는 `fs.openSync(filePath, 'r')`로 경로를 다시 열고 기존 파일 크기와 같은지만 확인했다.
5. 최초 파일 오픈과 워커 재오픈 사이에 경로가 같은 크기의 다른 파일로 바뀌면 크기 검사가 통과했다. Unix 계열에서는 심볼릭 링크로 바뀐 경로도 기존 코드가 따라갈 수 있었다.

### 경계 PoC

의존성 설치가 레지스트리 503으로 불가능했기 때문에 전체 HTTP/7z 파서 통합 PoC 대신, 취약 경계와 동일한 Node.js worker 동작을 독립적으로 재현했다.

- 최초 파일을 열어 신뢰 파일 디스크립터와 기대 크기 64바이트를 확보한다.
- 경로를 같은 크기의 다른 파일로 원자적으로 교체한다.
- 원본 방식의 워커는 경로를 다시 열고 크기만 확인하여 `UNAUTHORIZED-LOCAL-CONTENT...`를 읽었다.
- 수정 방식의 워커는 최초 파일 디스크립터를 전달받아 `AUTHORIZED-ARCHIVE-METADATA...`를 계속 읽었다.
- 워커 종료 후 부모의 파일 디스크립터가 여전히 열려 있음도 확인했다.

실행 결과:

```json
{
  "expectedSize": 64,
  "vulnerableAcceptedReplacement": true,
  "fixedStayedOnAuthorizedInode": true,
  "descriptorStillOpen": true
}
```

PoC: `security-poc/seven-zip-open-descriptor-race.mjs`  
원시 결과: `docs/security/evidence/2026-07-26-open-descriptor-follow-up/poc-seven-zip-open-descriptor-race.txt`

### 수정 내용

1. 저장소 미리보기 라우트가 7z 생성기에 `{ fd: opened.fd, filePath: opened.filePath }`를 전달한다.
2. 7z 워커는 전달받은 열린 파일 디스크립터를 빌려서 위치 지정 읽기를 수행한다.
3. 워커는 빌린 디스크립터를 닫지 않으며, 소유자인 HTTP 라우트가 미리보기 종료 후 닫는다.
4. 경로 기반 API 호환 경로에는 `O_NOFOLLOW`를 적용하고, 제공된 `dev`/`ino`와 다시 연 파일의 식별자가 일치하는지 확인한다.
5. 기존 regular-file, 기대 크기, 메타데이터 읽기량, 시간, 메모리, 엔트리 제한은 유지했다.

이 수정은 파일 이름을 다시 해석하지 않고 최초 보안 검사를 통과한 동일 커널 파일 객체를 사용하므로 경로 교체 창을 제거한다. Node.js 문서상 `O_NOFOLLOW`는 경로가 심볼릭 링크일 때 open을 실패시키는 플래그다.

## 3. RD-2026-07-26-OPS-01: Samba 진입 스크립트 CRLF

원본 ZIP의 `smb/entrypoint.sh` 첫 줄은 바이트 기준 `#!/bin/sh\r\n`이었다. Linux에서 직접 실행하면 인터프리터 경로가 `/bin/sh\r`로 해석될 수 있고, 프로젝트의 `bundled SMB entrypoint uses executable Unix line endings` 테스트도 실패했다.

내용과 실행 권한 `0755`는 유지하고 줄바꿈만 LF로 정규화했다. 다음 검증을 통과했다.

- `sh -n smb/entrypoint.sh`
- `node --test test/smb-sidecar-security.test.js`: 4/4 통과

## 4. 기존 고위험 영역 재검토 결과

현재 업로드된 소스에서 다음 통제를 독립적으로 확인했다.

- 외부 배포의 강한 세션 비밀키·관리자 암호·HTTPS·정확한 Host allowlist·제한된 trust proxy fail-closed 검증
- AES-256-GCM 암호화 세션, HMAC 기반 저장 키, 유휴·절대 만료, 철회 tombstone 및 세션 회전
- 로그인/보안 재인증/MFA 동시 요청을 포함하는 속도 제한과 일반화된 인증 오류
- 전역 CSRF, 로그인 익명 CSRF, multipart 업로드의 파일 쓰기 전 `_csrf` 검사와 파싱 후 재검사
- 저장소 소유자·관리자·명시적 grant 기반 중앙 권한검사 및 비인가 404 은닉
- SQL 값 파라미터화, 동적 정렬 allowlist, 동적 식별자 quoting
- 임의화된 저장 파일명, webroot 밖 저장, `0700`/`0600`, canonical path, symlink ancestor 거부, `O_NOFOLLOW`, regular-file 검사
- 업로드 파일 수·크기·저장소·전체 쿼터와 스트리밍 중 선제 예약
- PDF sandbox CSP, XLSX/ZIP/7z 압축·확장·엔트리·이름·트리·동시성·시간·메모리 제한
- 스트리밍 중 권한과 세션 재확인
- Samba SMB3 전용, 필수 서명·암호화, guest·wide link·follow symlink 비활성화, 쓰기 공유 fail-closed
- EJS 기본 escaping, unescaped EJS 태그의 partial include 한정, 클라이언트 HTML 삽입 sink 부재

수동 데이터 흐름과 정적 검색에서 `eval`, `new Function`, `vm`, `child_process` 실행 경로, 애플리케이션 외부 HTTP 요청/SSRF sink, 사용자 입력이 연결된 셸 명령, `innerHTML` 계열 sink, 운영 비밀키·클라우드 토큰 패턴은 확인되지 않았다.

## 5. 의존성 및 공개 권고 대조

잠금파일 기준 주요 버전은 다음과 같다.

- `multer` 2.2.0: 비정상 multipart 정리 DoS(GHSA-3p4h-7m6x-2hcm)의 패치 버전이며, 중첩 필드 DoS(GHSA-72gw-mp4g-v24j)의 패치 버전이다. 프로젝트는 `limits.fieldNestingDepth: 0`도 설정한다.
- `yauzl` 3.4.0: 3.2.0에 영향을 주고 3.2.1에서 수정된 CVE-2026-31988/GHSA-gmq8-994r-jv83의 영향 범위 밖이다.
- `exceljs` 4.4.0: `<1.6.0`에 영향을 주는 과거 XSS 권고 GHSA-2j2j-8rrv-264g의 영향 범위 밖이다. RecordDrive 화면은 셀 값을 HTML sink가 아니라 텍스트로 렌더링한다.
- 선택 전이 의존성: `qs` 6.15.3, `path-to-regexp` 8.4.2, `send` 1.2.1, `serve-static` 2.2.1, `on-headers` 1.1.0.

중요한 한계: 내부 npm 게이트웨이가 패키지 tarball 다운로드와 audit API 모두 HTTP 503을 반환하여 `npm ci`와 `npm audit --omit=dev`를 완료하지 못했다. 따라서 잠금파일 전체 전이 의존성에 취약점이 없다고 보증하지 않는다.

## 6. 검증 결과

| 검증 | 결과 |
| --- | --- |
| 7z 경로 교체 원본 경계 PoC | 같은 크기 교체 파일을 원본 방식이 읽음: 재현 성공 |
| 수정된 열린 디스크립터 경계 PoC | 최초 승인 inode 유지 및 부모 FD 생존: 성공 |
| 신규 회귀 테스트 | 2/2 통과 |
| 독립 실행 가능한 집중 회귀 묶음 | 24/24 통과 |
| SMB sidecar 회귀 테스트 | 4/4 통과 |
| JavaScript/MJS 구문 검사 | 164개 파일 통과 |
| `smb/entrypoint.sh` 셸 구문 | 통과 |
| package JSON/lockfile 파싱 | 통과 |
| 전체 `node --test` 검색 | 79개 중 52 통과, 27 실패 |
| 전체 테스트 실패 원인 | 설치되지 않은 외부 모듈의 `ERR_MODULE_NOT_FOUND`; 수정 후 assertion 실패 0 |
| `npm ci` / `npm audit` | 패키지 게이트웨이 HTTP 503으로 미완료 |

실행 환경 Node.js는 v22.16.0이었고 프로젝트의 선언된 지원 범위는 `^22.23.0 || ^24.17.0 || ^26.3.1`이다. 네트워크가 정상인 CI에서 지원 Node.js 버전으로 전체 설치·감사를 다시 실행해야 한다.

## 7. 수정 파일

- `src/routes/repositories.js`
- `src/file-preview.js`
- `src/seven-zip-parser-worker.js`
- `smb/entrypoint.sh`
- `security-poc/seven-zip-open-descriptor-race.mjs`
- `test/seven-zip-open-descriptor-race.test.js`
- 본 보고서, 보안 문서 인덱스 및 검증 증적

정확한 원본 ZIP 대비 목록은 `docs/security/evidence/2026-07-26-open-descriptor-follow-up/changed-files.txt`에 기록한다.

## 8. `.git` 보존 방식

분석 중 Git 명령이 인덱스 stat 캐시를 갱신할 가능성이 있으므로 최종 패키징 전에 작업 사본의 `.git`을 원본 ZIP에서 다시 복원한다. 최종 ZIP 생성 시에는 `.git` 44개 항목(파일 28, 디렉터리 16)을 원본 ZIP 항목에서 직접 복사하고 다음 메타데이터를 항목별로 비교한다.

- 파일 바이트 SHA-256와 크기
- 디렉터리 항목 포함 경로 목록
- ZIP 압축 방식과 timestamp
- external attributes, extra field, comment, create system, flag bits

원본 `.git` canonical manifest SHA-256: `3537a7bec9f2d20f158def118f17e1e6b7ad2741f071fccf32511336a4509290`

## 9. 잔여 위험 및 배포 권고

1. `SMB_ALLOW_WRITES=false` 기본값을 유지한다. 쓰기 SMB가 필요하면 애플리케이션 조정 전에 작동하는 OS/파일시스템 하드 쿼터를 먼저 적용한다.
2. 업로드 저장 루트와 데이터베이스는 RecordDrive 전용 OS 계정만 쓰도록 하고 공유 쓰기 권한을 부여하지 않는다.
3. 지원 Node.js 버전에서 `npm ci`, `npm test`, `npm run test:security`, `npm audit --omit=dev`를 재실행한다.
4. 운영 reverse proxy, TLS, 실제 Samba 클라이언트, NFS/SMB 마운트, 백업·복원 절차를 포함한 환경 침투 테스트를 별도로 수행한다.
5. 파일 업로드에는 악성코드 검사/CDR가 포함되어 있지 않으므로 업무 요구에 따라 별도 격리 스캐너를 추가한다.

## 10. 참고 자료

- MITRE CWE-367: https://cwe.mitre.org/data/definitions/367.html
- MITRE CWE-363: https://cwe.mitre.org/data/definitions/363.html
- Node.js File System documentation (`O_NOFOLLOW`): https://nodejs.org/api/fs.html
- OWASP File Upload Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- Multer GHSA-3p4h-7m6x-2hcm: https://github.com/expressjs/multer/security/advisories/GHSA-3p4h-7m6x-2hcm
- Multer GHSA-72gw-mp4g-v24j: https://github.com/expressjs/multer/security/advisories/GHSA-72gw-mp4g-v24j
- yauzl GHSA-gmq8-994r-jv83: https://github.com/advisories/GHSA-gmq8-994r-jv83
- ExcelJS GHSA-2j2j-8rrv-264g: https://github.com/advisories/GHSA-2j2j-8rrv-264g
