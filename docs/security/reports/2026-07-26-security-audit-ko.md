# RecordDrive 서버 웹 프로젝트 심층 보안 감사 및 수정 보고서

- 감사일: 2026-07-26
- 대상: 사용자가 제공한 `RecordDrive.zip`
- 범위: Node.js/Express 웹 애플리케이션, 인증·인가, 세션, CSRF, Host 헤더/프록시 경계, 업로드, ZIP/7z 미리보기, 파일 저장 경로, SMB 사이드카와 동기화, Docker 기본 노출, 잠금파일 의존성
- 방법론: OWASP WSTG와 ASVS 5.0.0을 기준으로 정적 코드 검토, 데이터 흐름 추적, 경계값 분석, 로컬 회귀 테스트 및 결정적 PoC 재현을 수행했다.

## 1. 결론

확인된 보안 문제는 **High 2건, Medium 1건**이며 모두 수정했다.

1. **High — SMB 기존 파일 제자리 확장 시 저장 쿼터 영구 우회**
2. **High — SMB 암호화 선택적 허용 및 TCP 445 전체 인터페이스 기본 노출**
3. **Medium — SMB 투영 디렉터리 무제한 열거에 따른 메모리 고갈 가능성**

검토한 인증·인가·세션·CSRF·Host 검증·업로드·압축 미리보기·저장 경로에서는 별도의 재현 가능한 인증 우회, 원격 코드 실행, SQL 주입, 임의 경로 탈출을 확인하지 못했다. 이는 이번 범위와 환경에서 확인하지 못했다는 의미이며, 모든 운영 환경의 무결함을 보증하는 표현은 아니다.

## 2. 확인 및 수정한 취약점

### 2.1 High — SMB 하드링크 기존 파일의 제자리 확장으로 쿼터 우회

#### 영향과 전제 조건

저장소의 SMB 자격 증명을 가진 사용자가 기존 공유 파일을 같은 inode에서 확장할 수 있으면, 파일별·저장소별·서비스 전체 저장 용량 제한을 초과한 크기를 정식 파일과 SQLite 메타데이터에 영구 반영할 수 있었다. 반복 악용 시 호스트 디스크 고갈과 서비스 거부로 이어질 수 있다.

#### 근본 원인

SMB 투영 파일과 정식 저장 파일은 하드링크로 동일 inode를 공유한다. 원본 `src/smb-sync-service.js`의 동일 inode 분기에서는 파일 크기를 DB에 바로 반영했지만, 새 파일 및 inode 교체 분기에서 사용하던 `enforceSmbFileQuota()`를 호출하지 않았다.

원본의 핵심 흐름은 다음과 같았다.

- inode가 바뀐 파일: 쿼터 검사 수행
- 새 파일: 쿼터 검사 수행
- **동일 inode에서 커진 기존 파일: 쿼터 검사 없이 DB 크기 갱신**

#### 원본 PoC 재현 결과

테스트 제한: 약 104.86바이트

| 항목 | 결과 |
|---|---:|
| 최초 파일 크기 | 64바이트 |
| SMB 경로 제자리 쓰기 직후 | 2,112바이트 |
| 원본 동기화 후 저장 파일 | 2,112바이트 |
| 원본 동기화 후 DB 기록 | 2,112바이트 |
| 쿼터 거부 로그 | 0건 |

재현 결과는 `docs/security/evidence/2026-07-26/smb-quota-bypass-original.json`에 포함했다.

#### 수정

- 동일 inode 파일이 커졌을 때도 기존 파일 크기를 교체 크기로 전달해 파일·저장소·전체 용량 쿼터를 모두 검사한다.
- 제한 초과 시 파일을 마지막 DB 확정 크기로 되돌린다.
- 매핑의 inode/상태를 복구한다.
- `SMB_REJECT_FILE_QUOTA` 활동 로그를 남긴다.
- 축소 또는 동일 크기 변경은 기존 동작과 호환되도록 허용한다.

#### 수정 후 PoC

| 항목 | 결과 |
|---|---:|
| 최초 파일 크기 | 64바이트 |
| SMB 경로 제자리 쓰기 직후 | 2,112바이트 |
| 수정본 동기화 후 저장 파일 | 64바이트 |
| 수정본 동기화 후 DB 기록 | 64바이트 |
| 쿼터 거부 로그 | 1건 |

수정 결과는 `docs/security/evidence/2026-07-26/smb-quota-remediated.json`에 포함했다.

#### 잔여 위험

SMB 쓰기는 주기적 동기화 전에 하드링크 inode를 즉시 변경한다. 따라서 초과 확장은 다음 동기화 때 복구되지만, 동기화 간격 내에서는 임시 디스크 할당이 발생할 수 있다. 강한 즉시 디스크 고갈 방지가 필요한 운영 환경에서는 SMB를 신뢰 네트워크에만 노출하고, 전용 파일시스템·호스트 파일시스템 쿼터·예약 공간·저장공간 감시를 함께 적용해야 한다.

### 2.2 High — SMB 암호화 선택적 허용 및 TCP 445 광범위 기본 노출

#### 원본 상태

- Samba: `server min protocol = SMB2_10`
- Samba: `smb encrypt = desired`
- Compose: `${SMB_BIND_ADDRESS:-0.0.0.0}:445:445`
- 예제 환경 파일: `SMB_BIND_ADDRESS=0.0.0.0`

Samba의 `desired` 정책은 암호화를 지원하는 클라이언트에는 암호화를 사용하지만, 지원하지 않는 클라이언트의 비암호화 접속을 반드시 차단하지 않는다. Docker의 `0.0.0.0` 포트 게시 기본값은 모든 호스트 인터페이스에 노출한다.

#### 수정

- `server min protocol = SMB3_00`
- `server max protocol = SMB3`
- `server signing = mandatory`
- `server smb encrypt = required`
- Compose 기본 게시 주소를 `127.0.0.1`로 변경
- `.env.example`도 `127.0.0.1`로 일치시킴
- 원격 SMB가 필요한 경우에만 정확한 신뢰 LAN 인터페이스 주소를 명시하도록 문서화
- 보안 설정이 후퇴하지 않도록 정적 회귀 테스트 추가

`entrypoint.sh`는 원본 CRLF 줄바꿈 때문에 POSIX 셸 실행이 실패할 수 있어 LF로 정규화했다. 컨테이너 빌드의 기존 `chmod 0755` 실행 절차는 그대로 유지했다.

### 2.3 Medium — SMB 투영 항목 무제한 누적

#### 근본 원인과 영향

원본 `scanProjection()`은 `readdirSync()`로 각 디렉터리의 모든 항목을 배열로 읽고, 전체 재귀 결과를 다시 메모리에 누적했다. 인증된 SMB 사용자가 매우 많은 파일·폴더를 생성하면 동기화 프로세스의 메모리 사용량과 처리 시간을 비정상적으로 키울 수 있었다.

#### 수정

- `fs.opendirSync()` 기반 순차 열거로 변경
- `SMB_SYNC_MAX_SCANNED_ENTRIES` 하드 상한 추가
- 기본값 20,000, 허용 범위 1,000–1,000,000
- 상한 초과 시 `SMB_PROJECTION_SCAN_LIMIT` 오류로 해당 패스를 중단
- 6개 항목/상한 5의 결정적 회귀 테스트 추가

## 3. 주요 점검 영역

### 인증·세션

- 로그인 실패 시 더미 해시를 사용하는지 확인
- 세션 ID 재생성, 유휴/절대 만료, 세션 철회, 동시 세션 제한 확인
- 쿠키 Secure/HttpOnly/SameSite 및 이름 충돌 방어 확인
- MFA 및 WebAuthn 챌린지의 세션·사용자·목적 바인딩과 1회 소비 확인
- 관리자 비활성화 경계 확인

### 요청 경계와 인가

- 저장소 권한 미들웨어와 관리자/일반 사용자 분리 확인
- CSRF 토큰 검증과 업로드 단계 검증 확인
- 비신뢰 Host 및 DNS rebinding 방어 확인
- `TRUST_PROXY` 와일드카드·hop-count 거부, 명시적 IP/서브넷만 허용 확인
- HTTPS 강제와 비루프백 배포의 fail-closed 설정 확인

### 파일·업로드·압축

- 업로드 파일 수·크기·파트·필드·헤더 제한 확인
- 중단·실패한 업로드 임시 파일 정리 확인
- 저장 경로의 심볼릭 링크 및 루트 탈출 방어 확인
- ZIP/7z 미리보기의 추출 미사용, 스캔 항목·헤더·시간 제한 확인
- 파일 다운로드 중 권한 철회 재검증과 보호 스트림 확인

## 4. 의존성 검토

잠금파일에서 확인한 주요 버전:

- `express` 5.2.1
- `express-session` 1.19.0
- `helmet` 8.3.0
- `multer` 2.2.0
- `yauzl` 3.4.0
- `ejs` 6.0.1
- `bcryptjs` 3.0.3
- `@simplewebauthn/server` 13.3.2

2026년 공개 권고 중 보안상 중요한 항목을 확인했다.

- Multer CVE-2026-5038은 2.2.0에서 수정되었고 본 프로젝트는 2.2.0이다.
- Multer CVE-2026-5079는 2.2.0 이상과 최소 `limits.fieldNestingDepth` 설정을 요구하며, 본 프로젝트는 2.2.0 및 `fieldNestingDepth: 0`을 사용한다.
- yauzl CVE-2026-31988은 정확히 3.2.0에 영향을 주고 3.2.1에서 수정되었으며, 본 프로젝트는 3.4.0이다.

다만 감사 환경의 패키지 레지스트리가 HTTP 503을 반환하여 `npm ci`와 완전한 실시간 `npm audit`을 끝까지 수행하지 못했다. 잠금파일 및 공개 권고를 별도 대조했지만, 정상 레지스트리와 프로젝트가 요구하는 Node.js 버전에서 `npm ci && npm test && npm audit`을 다시 수행하는 것이 필요하다.

## 5. 검증 결과

| 검증 | 결과 |
|---|---|
| 원본 SMB 쿼터 우회 PoC | 재현 성공 |
| 수정본 동일 PoC | 차단 및 64바이트 복구 성공 |
| SMB 설정·동기화 표적 테스트 | 9/9 통과 |
| 전체 JavaScript 구문 검사 | 통과 |
| `npm run check` | 통과 |
| `sh -n smb/entrypoint.sh` | 통과 |
| 전체 `npm test` | 의존성 설치 불가로 완전 검증하지 못함 |
| Samba 실제 클라이언트 암호화 협상 | Docker/Samba 런타임 부재로 정적 설정 검증만 수행 |

표적 테스트는 레지스트리 장애 때문에 모듈 로딩에 필요한 최소 테스트 전용 스텁을 사용했다. 해당 스텁은 최종 압축파일에서 제거했다.

## 6. 변경 파일

- `.env.example`
- `README.md`
- `docker-compose.yml`
- `docs/SMB.md`
- `docs/security/reports/2026-07-26-security-audit.md`
- `docs/security/reports/2026-07-26-security-audit-ko.md`
- `docs/security/evidence/2026-07-26/*`
- `smb/entrypoint.sh`
- `src/config.js`
- `src/smb-sync-service.js`
- `test/smb-settings.test.js`
- `test/smb-sidecar-security.test.js`
- `test/smb-sync.test.js`

## 7. `.git` 보존 정책

수정 과정에서는 수정본 트리의 `.git` 안에서 Git 명령을 실행하지 않았고, `.git` 파일을 직접 수정하거나 제거하지 않았다. 최종 ZIP을 만들 때 `.git/` 항목은 원본 ZIP에서 직접 가져오며, 항목 목록·파일 내용·CRC·크기·타임스탬프·권한/외부 속성·압축 방식을 원본과 비교 검증한다. 최종 검증 결과는 함께 제공하는 `RecordDrive_archive_verification_2026-07-26.json`에 기록한다.

## 8. 참고 자료

- OWASP Web Security Testing Guide: https://owasp.org/www-project-web-security-testing-guide/
- OWASP ASVS: https://owasp.org/www-project-application-security-verification-standard/
- Samba `smb.conf` manual: https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html
- Docker port publishing: https://docs.docker.com/engine/network/port-publishing/
- Multer CVE-2026-5038: https://github.com/advisories/GHSA-3p4h-7m6x-2hcm
- Multer CVE-2026-5079: https://github.com/advisories/GHSA-72gw-mp4g-v24j
- yauzl CVE-2026-31988: https://github.com/advisories/GHSA-gmq8-994r-jv83
