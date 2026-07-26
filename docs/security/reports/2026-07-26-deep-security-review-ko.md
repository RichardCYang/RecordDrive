# 2026-07-26 RecordDrive 심층 보안 재검증 및 수정 보고서

## 결론

제공된 RecordDrive 2.1.0 소스를 독립적으로 재검토한 결과, **쓰기 가능한 SMB 공유에서 애플리케이션 쿼터가 적용되기 전에 실제 파일시스템 블록을 대량 할당할 수 있는 가용성 취약점 1건(높음)**과 **악성 압축 파일명이 미리보기 트리를 구조적으로 증폭시켜 브라우저 자원을 고갈시키는 취약점 1건(중간)**을 확인하고 수정했다. 또한 번들 Samba 진입 스크립트가 CRLF 줄바꿈으로 배포 환경에서 실행되지 않을 수 있는 운영 결함을 수정했다.

검토 범위에서 원격 코드 실행, 인증 우회, 임의 파일 읽기/쓰기, SQL 삽입, 저장형 XSS, 권한 없는 IDOR, CSRF 우회와 같은 **치명적(Critical) 취약점은 재현되지 않았다**. 이 결론은 본 검토 범위와 실행 제약 안에서의 결과이며, 완전한 침투 테스트나 모든 공급망 취약점의 부재를 보증하지는 않는다.

## 범위와 방법

- 압축파일 구조 및 경로 탈출 검사 후 별도 작업 사본에서 분석
- 인증, 세션, CSRF, 권한, 저장소 경로, 업로드, 다운로드, PDF/XLSX/ZIP/7z 미리보기, SMB 제어·동기화, 배포 설정 수동 추적
- 위험 패턴 정적 검색과 데이터 흐름 검토
- 제공 프로젝트 모듈을 사용한 로컬 전용 PoC 재현
- 수정 후 구문 검사, 집중 회귀 테스트, 전체 테스트 실행 시도
- 수정 전후 `.git` 파일·디렉터리·모드·크기·시간·SHA-256 비교 및 최종 ZIP 내부 재검증

검토 기준은 OWASP ASVS 5.0.0의 웹 애플리케이션 보안 통제 범주, OWASP 파일 업로드/자원 소비 지침, Samba 공식 설정 문서를 참고했다.

## 확인 및 수정한 취약점

### RD-2026-07-26-01: 쓰기 SMB의 사전 쿼터 우회에 의한 디스크 고갈

- **위험도:** 높음(가용성)
- **전제:** 유효한 저장소별 SMB 자격증명, 쓰기 공유 활성화
- **영향:** 서비스 데이터 볼륨 고갈, SQLite/업로드 실패, 서비스 중단 가능
- **관련 약점:** CWE-400, CWE-770

RecordDrive는 SMB 투영 파일과 정식 저장 파일을 하드링크로 연결한다. Samba는 파일시스템에 직접 쓰고, 애플리케이션은 기본 1초 주기로 변경을 감지한 뒤 DB 쿼터를 검사한다. 따라서 기존 하드링크 파일의 제자리 증가나 새 파일 쓰기는 애플리케이션 검사 전에 실제 블록을 할당한다. 다음 동기화에서 초과분을 잘라내더라도, 볼륨이 먼저 가득 차면 복구 로직과 서비스 자체가 실패할 수 있다.

로컬 PoC에서 DB의 커밋 크기가 1,024바이트인 파일을 SMB 투영 경로를 통해 8,388,608바이트로 늘렸고, 동기화 전 정식 inode가 즉시 8,388,608바이트를 차지함을 확인했다. 다음 조정 패스는 1,024바이트로 되돌렸지만 이는 사후 복구일 뿐 선제 쿼터가 아니다.

#### 수정

- `SMB_ALLOW_WRITES=false`를 기본값으로 추가했다.
- 애플리케이션 설정 저장 시 쓰기 공유 요청을 `SMB_WRITES_DISABLED`로 거부한다.
- 기존 DB에 쓰기 공유가 남아 있어도 생성되는 공유 매니페스트는 읽기 전용으로 강제한다.
- Samba 사이드카도 같은 환경변수를 독립적으로 검사해 `read only = yes`를 강제한다.
- Compose는 애플리케이션과 사이드카 양쪽에 동일한 fail-closed 기본값을 전달한다.
- 설정 UI는 서버가 쓰기를 허용하지 않으면 읽기 전용 체크를 고정한다.
- 문서와 `.env.example`에 독립적인 OS/파일시스템/볼륨 하드 쿼터가 있는 경우에만 쓰기를 명시적으로 켜도록 안내했다.

#### 잔여 위험

`SMB_ALLOW_WRITES=true`는 위험을 제거하는 설정이 아니라, 외부 하드 쿼터가 이미 적용됐음을 관리자가 명시적으로 승인하는 설정이다. 애플리케이션 조정기는 Samba의 실제 write 전에 개입할 수 없으므로, 이 값을 켠 상태에서 외부 쿼터가 없다면 디스크 고갈 창은 남는다.

### RD-2026-07-26-02: 압축 미리보기 경로 트리 증폭 및 파일명 스푸핑

- **위험도:** 중간
- **전제:** 악성 ZIP/7z 업로드 권한, 권한 있는 사용자가 미리보기 열기
- **영향:** 브라우저 탭 정지 또는 과도한 메모리/CPU 사용, 양방향 제어문자를 이용한 파일명 시각적 위장
- **관련 약점:** CWE-400, CWE-451

서버는 표시 엔트리 수와 파일명 바이트를 제한했지만, 클라이언트는 각 파일명을 `/`로 분할해 모든 고유 경로 구성요소를 DOM 노드로 만들었다. 2,000개 엔트리에 각각 64개의 고유 구성요소를 넣은 PoC는 엔트리 제한 안에서 **128,000개 트리 노드**를 생성했다. 또한 ZIP 쪽 파일명 정규화는 NUL 제거 외에 제어문자·양방향 텍스트 제어·점 경로를 일관되게 차단하지 않았다.

#### 수정

- 공용 서버 검증 모듈 `src/archive-preview-security.js`를 추가했다.
- 경로 구성요소 깊이를 64로, 고유 트리 노드를 10,000개로 제한했다.
- NFC 정규화, 역슬래시 통일, 절대 경로 선행 슬래시 제거 후 `.`/`..`, C0/C1 제어문자, Unicode bidi 제어문자를 거부한다.
- ZIP은 안전하지 않거나 구조 예산을 초과한 엔트리를 생략하고 `truncated`로 표시한다.
- 7z worker 결과도 동일한 서버측 구조 예산을 재검증한다.
- 클라이언트에도 독립적인 깊이/노드/문자 검사를 두어 서버 응답 변조나 향후 회귀에 대비한다.

수정 후 동일 PoC에서 허용된 트리는 9,984개 노드로 제한됐고 10,000개 상한을 넘지 않았다.

## 운영 결함 수정

### Samba 사이드카 진입 스크립트 CRLF

원본 `smb/entrypoint.sh`는 `#!/bin/sh\r\n`으로 저장되어 Linux 컨테이너에서 인터프리터 경로가 `/bin/sh\r`로 해석될 수 있었다. 스크립트를 Unix LF로 변환하고 실행 모드(0755)를 부여했다. 이는 직접적인 기밀성·무결성 취약점은 아니지만 SMB 기능 전체를 시작하지 못하게 할 수 있는 가용성/배포 결함이다.

## 기존 방어의 독립 검증 결과

다음 영역은 소스 흐름과 기존 회귀 테스트를 재검토했으며 새로운 치명적 우회는 확인하지 못했다.

- 외부 배포의 강한 비밀키·HTTPS·정확한 Host/프록시 신뢰 fail-closed 검증
- HMAC 키 기반 세션 ID 저장, AES-GCM 세션 페이로드 보호, 절대/유휴 만료, 철회 tombstone
- 로그인 CSRF와 인증 세션 CSRF, 멀티파트 업로드에서 파일 쓰기 전 CSRF 검사
- 비밀번호/MFA/보안 재인증의 동시 요청 예약 기반 속도 제한
- WebAuthn challenge의 세션·사용자·용도 바인딩 및 원자적 1회 소비
- 저장소 권한의 중앙 검사, 안정 파일 디스크립터와 `O_NOFOLLOW`, 스트리밍 중 청크 단위 권한 재검증
- 파일/폴더 이름 검증, 저장 이름 분리, SMB 루트와 `.git`/소스/DB/업로드 경로 중첩 거부
- EJS 사용자 데이터 이스케이프 및 클라이언트 `textContent` 사용
- SQL 값 파라미터화와 제한된 동적 정렬 allowlist
- ZIP/7z 미리보기의 파일 크기, 엔트리 수, 메타데이터 크기, 동시성, worker 시간·메모리 제한

## 의존성 검토

격리 환경의 npm 레지스트리 연결 실패로 `npm audit`를 완료하지 못했다. 대신 lockfile과 현재 공개된 주요 상위 advisories를 대조했다.

- Multer는 2.2.0이며, 2026년 6월 공개된 중첩 필드 DoS(CVE-2026-5079)와 중단/비정상 업로드 정리 DoS(CVE-2026-5038)의 패치 버전이다. 업로드 설정은 권고대로 `limits.fieldNestingDepth: 0`을 사용한다.
- yauzl은 3.4.0이며, `getLastModDate()` DoS(CVE-2026-31988)의 영향 버전 3.2.0보다 높다.
- ExcelJS는 4.4.0이며, 과거 XSS(CVE-2018-16459)의 수정 버전 1.6.0보다 높다. 추가로 렌더링은 HTML 삽입 대신 텍스트 노드를 사용한다.
- transitive `unzipper`는 0.10.14로 과거 Zip Slip 영향 범위 `<0.8.13`보다 높으며, RecordDrive는 업로드 압축을 서버 파일시스템에 추출하지 않고 메타데이터만 표시한다.

이 검토는 전체 공급망 스캐너를 대체하지 않는다. 네트워크가 가능한 CI에서 `npm ci`와 `npm audit --omit=dev`를 다시 실행해야 한다.

## 검증 결과

- 수정 파일 JavaScript/MJS `node --check`: 통과
- `smb/entrypoint.sh` `sh -n`: 통과
- package JSON/lockfile 파싱: 통과
- 집중 회귀 테스트: **23/23 통과**
- 전체 `node --test` 시도: **73개 통과**, **20개 테스트 파일은 의존성 미설치로 로드 실패**; 실행된 애플리케이션 assertion 실패는 없음
- SMB 사전 조정 쿼터 PoC: 통과
- 압축 트리 증폭 PoC: 통과
- `.git` 원본/작업본/최종 ZIP 비교: 별도 무결성 증거 파일 참조

## 배포 시 필수 조치

1. 기본값 `SMB_ALLOW_WRITES=false`를 유지한다.
2. 쓰기 SMB가 반드시 필요하면 `/data` 또는 SMB 투영이 위치한 파일시스템/볼륨에 컨테이너 내부 사용자가 우회할 수 없는 하드 쿼터를 먼저 설정한다.
3. 그 후에만 애플리케이션과 Samba 사이드카에 동일하게 `SMB_ALLOW_WRITES=true`를 전달한다.
4. TCP 445는 신뢰된 LAN 인터페이스에만 바인딩하고 인터넷에는 공개하지 않는다.
5. 네트워크가 가능한 CI에서 전체 의존성 설치, `npm audit`, 전체 테스트, 실제 Docker/Samba/Windows 통합 테스트를 수행한다.

## 참고 자료

- OWASP ASVS 5.0.0: https://owasp.org/www-project-application-security-verification-standard/
- OWASP API4:2023 Unrestricted Resource Consumption: https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/
- OWASP File Upload Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- Samba `smb.conf` manual: https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html
- Multer GHSA-72gw-mp4g-v24j: https://github.com/expressjs/multer/security/advisories/GHSA-72gw-mp4g-v24j
- Multer GHSA-3p4h-7m6x-2hcm: https://github.com/expressjs/multer/security/advisories/GHSA-3p4h-7m6x-2hcm
- yauzl GHSA-gmq8-994r-jv83: https://github.com/advisories/GHSA-gmq8-994r-jv83
