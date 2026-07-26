# SMB 이름 변경 결합 쿼터 우회 심층 분석 및 수정 보고서

- 분석일: 2026-07-26
- 대상: 사용자 제공 `RecordDrive.zip`
- 범위: 서버 웹 애플리케이션, 인증·인가·세션·CSRF·Host 경계, 업로드·압축 미리보기·저장 경로, SMB 투영/동기화, 의존성 잠금파일, 컨테이너 시작 경로
- 방법: OWASP ASVS/WSTG 기반 정적 검토, 데이터 흐름·경계값 추적, 결정적 로컬 PoC, 수정 전후 회귀 검증

## 1. 결론

새로운 **High 심각도 취약점 1건**을 확인하고 수정했다.

- **SMB 기존 파일을 제한 초과로 확장한 뒤 동기화 전에 이름 변경/이동하면 저장 쿼터를 우회할 수 있음**

또한 압축본의 `smb/entrypoint.sh`가 CRLF 줄바꿈이어서 POSIX 셸 구문 검사가 실패하고 사이드카가 시작되지 않을 수 있는 가용성 결함을 수정했다.

검토 범위 내에서 별도의 재현 가능한 인증 우회, 수평/수직 권한 상승, SQL 주입, 경로 탈출, 임의 파일 읽기·쓰기, 서버 측 코드 실행, 세션 고정, CSRF 우회는 확인하지 못했다. 이는 이번 코드와 실행 환경에서 재현하지 못했다는 뜻이며 운영 환경 전체의 무결함을 보증하지 않는다.

## 2. High — SMB 확장 후 이름 변경으로 쿼터 검사 우회

### 2.1 공격 전제와 영향

전제 조건은 다음과 같다.

1. 저장소에서 SMB 기능이 활성화되어 있다.
2. 공격자가 해당 저장소의 SMB 쓰기 자격 증명을 보유한다.
3. 기존 웹/SMB 파일의 투영 하드링크를 수정할 수 있다.

공격자는 기존 파일을 파일별·저장소별·전체 저장 용량 제한보다 크게 확장하고, 다음 동기화 전에 파일 이름을 변경하거나 다른 폴더로 이동할 수 있었다. 취약한 코드는 이 작업을 “동일 inode의 이동”으로 먼저 처리하면서 제한 초과 크기를 DB에 반영했다. 이후 일반 동일 경로 분기에서는 이미 DB 크기가 커진 상태라 증가분이 없다고 판단했다.

결과적으로 제한 초과 데이터가 정식 저장 파일과 SQLite 메타데이터에 영구 반영될 수 있으며, 반복 시 호스트 디스크 고갈과 서비스 거부로 이어질 수 있다.

### 2.2 근본 원인

`syncProjectionToDatabase()`는 파일 처리 전에 inode 보존 이동을 먼저 적용한다. 원본의 `moveFileFromSmb()`는 폴더·이름·크기·접근 시각과 매핑 경로만 갱신했고 `enforceSmbFileQuota()`를 호출하지 않았다.

공격 흐름은 다음과 같다.

1. 64바이트 기존 파일을 SMB 경로에서 2,112바이트로 확장한다.
2. 동기화 전에 `quota-growth.bin`을 `renamed-growth.bin`으로 변경한다.
3. 스캐너가 동일 inode를 감지해 이동 분기를 먼저 실행한다.
4. 이동 분기가 DB 크기를 2,112바이트로 갱신한다.
5. 이어지는 동일 경로 분기는 DB와 스캔 크기가 같다고 보고 증가 쿼터 검사를 수행하지 않는다.

기존의 “같은 경로에서 제자리 확장” 방어만으로는 이 순서 결합을 막지 못했다.

### 2.3 결정적 원본 PoC

PoC는 네트워크를 사용하지 않고 임시 SQLite DB와 임시 저장소/SMB 투영 디렉터리에서 실행한다.

- 파일 제한: 약 104.86바이트
- 최초 파일: 64바이트
- 확장 및 이름 변경 후: 2,112바이트

원본 결과:

| 측정값 | 결과 |
|---|---:|
| 정식 저장 파일 | 2,112바이트 |
| DB 크기 | 2,112바이트 |
| DB 파일명 | `renamed-growth.bin` |
| `SMB_REJECT_FILE_QUOTA` 로그 | 0건 |
| 취약 판정 | `true` |

증거: `docs/security/evidence/2026-07-26-rename-growth/smb-rename-growth-original.json`

### 2.4 수정 내용

`src/smb-sync-service.js`의 inode 보존 파일 이동 경로를 다음과 같이 수정했다.

- 이동 대상의 현재 DB 파일 레코드를 먼저 조회한다.
- 스캔 크기가 DB 확정 크기보다 커졌다면 파일·저장소·전체 용량 쿼터를 검사한다.
- 제한 초과 시 동일 inode 파일을 마지막 DB 확정 크기로 `truncate`한다.
- 복원 후 실제 `lstat` 값을 이동 처리와 후속 분기에 공유한다.
- 복원된 크기와 새 이름/경로를 하나의 DB 트랜잭션에서 반영한다.
- `SMB_REJECT_FILE_QUOTA` 활동 로그를 정확히 1건 남긴다.

주요 구현 위치:

- 쿼터 검사·복원: `src/smb-sync-service.js:753-780`
- 복원된 메타데이터의 트랜잭션 반영: `src/smb-sync-service.js:782-816`
- 이동 호출부에 설정 전달: `src/smb-sync-service.js:920-932`

### 2.5 수정 후 PoC

수정본 결과:

| 측정값 | 결과 |
|---|---:|
| 동기화 직전 투영 파일 | 2,112바이트 |
| 동기화 후 투영 파일 | 64바이트 |
| 동기화 후 정식 저장 파일 | 64바이트 |
| 동기화 후 DB 크기 | 64바이트 |
| DB 파일명 | `renamed-growth.bin` |
| `SMB_REJECT_FILE_QUOTA` 로그 | 1건 |
| 취약 판정 | `false` |

증거: `docs/security/evidence/2026-07-26-rename-growth/smb-rename-growth-remediated.json`

### 2.6 회귀 테스트

`test/smb-sync.test.js:266-322`에 다음 순서를 고정한 테스트를 추가했다.

1. 64바이트 정식 파일과 SMB 하드링크 생성
2. SMB 경로에 2,048바이트 추가
3. 동기화 전 파일 이름 변경
4. 동기화 수행
5. 정식/투영 파일 모두 64바이트인지 확인
6. 원본 내용 보존, 새 이름 반영, DB 크기 복원, 거부 로그 생성 확인

## 3. SMB 사이드카 CRLF 가용성 결함

원본 `smb/entrypoint.sh`는 CRLF 줄바꿈이었다. Linux POSIX 셸에서 `sh -n smb/entrypoint.sh` 실행 시 다음 오류가 재현됐다.

```text
smb/entrypoint.sh: 74: Syntax error: "&&" unexpected
```

컨테이너가 이 파일을 직접 엔트리포인트로 실행하므로 SMB 사이드카가 시작되지 않을 수 있다. 파일을 LF로 정규화하고 다음 회귀 검사를 추가했다.

- 첫 10바이트가 정확히 `#!/bin/sh\n`인지 확인
- 파일에 `\r\n`이 없는지 확인
- `sh -n smb/entrypoint.sh` 통과 확인

이 항목은 원격 공격 취약점이라기보다 배포 가용성과 보안 설정 적용을 막는 패키징 결함이다.

## 4. 그 밖의 심층 검토 결과

### 인증·세션·MFA

- 로그인 성공 시 세션 재생성, 실패 시 더미 해시 사용을 확인했다.
- 세션 유휴/절대 만료, 서버 측 암호화 저장, 철회 tombstone, 사용자·세션 바인딩을 확인했다.
- WebAuthn 챌린지의 사용자·세션·목적 바인딩과 원자적 1회 소비를 확인했다.
- 임시 비밀번호 변경 강제와 민감 MFA 재료의 노출 만료 경계를 확인했다.

### 인가·요청 경계

- 저장소 접근은 소유자/관리자/명시적 권한을 기준으로 중앙 검사하며 비인가 대상은 404로 숨긴다.
- CSRF 검사는 일반 요청뿐 아니라 업로드 파일 스트리밍 시작 전에 수행된다.
- Host 헤더는 세션 처리 전에 단일 값과 명시적 허용 목록을 검증한다.
- 비루프백 운영의 HTTPS fail-closed, 쿠키 `Secure`/`HttpOnly`/`SameSite=Strict`, `__Host-` 접두사 정책을 확인했다.

### 파일·업로드·미리보기

- 업로드에 파일 수, 크기, 파트, 필드, 헤더 쌍, 중첩 깊이 제한이 적용된다.
- 저장 파일명은 서버 생성 UUID이며, 저장 루트·심볼릭 링크·no-follow 경계를 확인했다.
- PDF는 sandbox CSP와 same-origin 정책으로 제공된다.
- XLSX/ZIP/7z 미리보기는 압축 크기, 항목 수, 이름 길이, 메타데이터, 시간 및 동시성 상한을 둔다.
- ZIP은 추출하지 않고 메타데이터만 순회한다.

### SMB 네트워크 경계

- SMB3 최소/최대, 강제 서명, `server smb encrypt = required`를 확인했다.
- Docker Compose의 TCP 445 기본 게시 주소는 `127.0.0.1`이다.
- Samba 공식 문서상 전역 `server smb encrypt = required`는 암호화 미지원 클라이언트 접속을 거부한다.

## 5. 의존성 검토

잠금파일의 주요 버전:

- `multer` 2.2.0
- `yauzl` 3.4.0
- `express` 5.2.1
- `express-session` 1.19.0
- `helmet` 8.3.0
- `ejs` 6.0.1
- `@simplewebauthn/server` 13.3.2

현재 공개 권고와 대조한 결과:

- Multer GHSA-3p4h-7m6x-2hcm은 `<2.2.0`에 영향; 프로젝트는 2.2.0이다.
- Multer GHSA-72gw-mp4g-v24j은 `<2.2.0`에 영향하며 2.2.0과 최소 `fieldNestingDepth` 설정을 권고한다. 프로젝트는 2.2.0과 `fieldNestingDepth: 0`을 사용한다.
- yauzl GHSA-gmq8-994r-jv83은 정확히 3.2.0에 영향; 프로젝트는 3.4.0이다.

`npm audit`은 감사 환경의 패키지 레지스트리 게이트웨이가 HTTP 503을 반환해 완료하지 못했다. 따라서 정상 레지스트리와 프로젝트가 요구하는 Node.js 버전에서 배포 전 재실행해야 한다.

## 6. 검증 결과

| 검증 | 결과 |
|---|---|
| 원본 이름 변경 결합 PoC | 재현 성공 (`vulnerable: true`) |
| 수정본 동일 PoC | 차단 성공 (`vulnerable: false`) |
| SMB 표적 회귀 테스트 | 11/11 통과 |
| `sh -n smb/entrypoint.sh` | 통과 |
| 전체 JS 구문 검사 | 통과 |
| 전체 `node --test` 시도 | 68 통과, 20은 의존성 미설치로 로딩 불가 |
| `npm audit` | 레지스트리 HTTP 503으로 미완료 |
| 실제 Samba 클라이언트 협상 | Docker/Samba 런타임 부재로 정적 검증만 수행 |

전체 테스트의 20개 실패는 `supertest`, `express`, `exceljs`, `otplib` 미설치에 따른 모듈 해석/서버 시작 실패였으며 애플리케이션 assertion 실패로 확인된 항목은 없다. 감사 런타임 Node.js v22.16.0은 프로젝트의 엔진 조건 `^22.23.0 || ^24.17.0 || ^26.3.1`보다 낮다.

## 7. 변경 파일

- `src/smb-sync-service.js`
- `test/smb-sync.test.js`
- `smb/entrypoint.sh`
- `test/smb-sidecar-security.test.js`
- `security-poc/smb-rename-growth-quota-bypass.mjs`
- `docs/security/reports/2026-07-26-smb-rename-growth-quota-bypass-ko.md`
- `docs/security/evidence/2026-07-26-rename-growth/*`

## 8. 잔여 위험과 운영 권고

SMB 투영은 정식 저장 파일과 하드링크이므로 제한 초과 쓰기가 발생한 순간부터 다음 동기화 전까지는 실제 디스크 블록이 임시 할당된다. 애플리케이션 복구만으로 이 짧은 창의 호스트 디스크 고갈을 완전히 막을 수 없다.

운영 시 다음을 병행해야 한다.

- SMB 포트는 루프백 또는 정확한 신뢰 LAN 주소에만 바인딩
- SMB 자격 증명 최소 권한·주기적 회전
- SMB 동기화 주기 단축과 실패 경보
- 전용 파일시스템 또는 OS/볼륨 쿼터
- 호스트 여유 공간과 inode 사용량 경보
- 정상 레지스트리에서 `npm ci && npm test && npm audit`
- 지원 Node.js 버전과 실제 Docker/Samba 환경에서 통합 테스트

## 9. 참고 자료

- OWASP ASVS 5.0.0
- OWASP Web Security Testing Guide
- Samba `smb.conf(5)` 공식 문서
- GitHub Advisory Database: GHSA-3p4h-7m6x-2hcm
- GitHub Advisory Database: GHSA-72gw-mp4g-v24j
- GitHub Advisory Database: GHSA-gmq8-994r-jv83
