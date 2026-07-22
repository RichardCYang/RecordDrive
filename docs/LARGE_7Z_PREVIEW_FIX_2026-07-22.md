# 대용량 7z 미리보기 장애 수정 분석

**작성일:** 2026-07-22  
**대상:** RecordDrive 2.0.2, Windows/PM2 서버의 7z 메타데이터 미리보기

## 장애 증상

12 GB 이상의 7z 파일을 미리보기할 때 서버 로그에 다음 두 오류가 동시에 기록되었다.

1. `FilePreviewError: encoded-header unpacked size exceeds its safety limit.`
2. `EPERM: operation not permitted, futime`

라우트의 파일 작업 래퍼는 두 오류를 `AggregateError`로 합쳐 다시 던졌기 때문에, 원래의 7z 도메인 오류 코드인 `SEVEN_ZIP_METADATA_LIMIT`가 Express 오류 처리기에서 인식되지 않았다. 결과적으로 클라이언트에는 의도된 413 응답 대신 일반 서버 오류가 전달될 수 있었다.

## 근본 원인

### 1. 7z 압축 헤더의 확장 크기 제한이 너무 작음

7z는 파일 본문뿐 아니라 파일명, 디렉터리 구조, 크기, 시간 등의 아카이브 헤더도 LZMA/LZMA2로 압축할 수 있다. 기존 워커는 압축 해제된 encoded header를 16 MiB로 제한했고, 최대 허용값도 32 MiB였다.

대용량 아카이브의 물리적 크기 자체가 직접 문제인 것은 아니다. 파일 수가 많거나 경로명이 길면 메타데이터 헤더가 16 MiB를 넘을 수 있고, 이 경우 본문을 읽기 전의 안전성 사전 검사에서 즉시 `SEVEN_ZIP_METADATA_LIMIT`가 발생했다.

### 2. Windows에서 읽기 전용 파일 핸들의 `futime` 실패

저장 파일은 안전한 미리보기와 다운로드를 위해 `O_RDONLY`로 열렸다. Node.js의 `fs.futimesSync(fd, ...)`는 Windows에서 해당 핸들에 파일 시간 변경 권한이 없으면 `EPERM`을 반환할 수 있다. Windows의 `SetFileTime`은 `FILE_WRITE_ATTRIBUTES` 권한으로 생성된 핸들을 요구한다.

기존 구현은 파일 디스크립터만 접근시간 추적기에 전달했기 때문에, 경로 기반 `utimesSync`로 안전하게 재시도할 수 없었다.

### 3. 보조 오류가 원래 미리보기 오류를 가림

미리보기 파싱이 실패한 뒤 접근시간 완료 처리도 실패하면 다음 코드가 두 오류를 `AggregateError`로 교체했다.

```js
throw new AggregateError(
  [error, completionError],
  'The file operation and access time update both failed.'
);
```

라우트의 오류 매핑은 `FilePreviewError` 인스턴스만 처리하므로, 원래 코드와 상태가 사라졌다.

## 적용한 수정

### 원래 도메인 오류 보존

`withTrackedFileAccess`를 파일 접근시간 모듈로 이동하고 다음 정책으로 변경했다.

- 파일 작업이 실패하면 접근시간 완료를 최선 노력으로 실행한다.
- 접근시간 완료도 실패하면 별도로 기록한다.
- 호출자에게는 항상 원래 파일 작업 오류를 다시 던진다.
- 파일 작업이 성공했는데 접근시간 완료만 실패한 경우에는 그 완료 오류를 그대로 전달한다.

따라서 7z 제한 오류는 다시 `SEVEN_ZIP_METADATA_LIMIT`로 식별되고 413 응답으로 처리된다.

### Windows `futime` 폴백

접근시간 추적기에 `{ fd, filePath }`를 함께 전달하도록 변경했다.

1. 우선 기존처럼 `futimesSync(fd, ...)`를 시도한다.
2. `EPERM` 또는 `EACCES`가 발생하면 열린 파일과 현재 경로를 각각 `fstat`/`lstat`으로 조회한다.
3. 둘 다 일반 파일이고 심볼릭 링크가 아니며 `dev`와 `ino`가 동일한지 확인한다.
4. 동일 파일인 경우에만 `utimesSync(filePath, ...)`로 재시도한다.
5. 경로가 다른 파일로 바뀌었으면 `ESTALE`로 중단해 교체 파일의 시간을 수정하지 않는다.

이 방식은 Windows 호환성을 확보하면서 경로 교체 경쟁 조건에 대한 기존 방어 수준을 유지한다.

### 대용량 7z의 bounded limit 확장

기본값과 상한을 다음과 같이 조정했다.

| 항목 | 기존 | 수정 기본값 | 허용 상한 |
|---|---:|---:|---:|
| encoded/expanded metadata header | 16 MiB | 128 MiB | 256 MiB |
| parser timeout | 20초 | 60초 | 300초 |
| scanned entries | 10,000 | 100,000 | 250,000 |
| 동시 7z 워커 | 2 | 1 | 1 |
| old-generation heap | 96 MiB 고정 | 기본 384 MiB | 설정에 따라 최대 640 MiB |

단일 읽기 및 누적 읽기 상한도 메타데이터 헤더 상한에서 계산되며, 최대값이 고정되어 있으므로 무제한 메모리 사용으로 바뀌지 않는다. 워커는 계속 일회성이며 아카이브 본문을 추출하지 않는다.

### 엔트리 수가 많은 아카이브의 부분 결과

파서가 메타데이터를 정상적으로 읽었지만 후처리 대상 엔트리가 설정값을 넘는 경우, 더 이상 전체 미리보기를 오류로 폐기하지 않는다.

- 설정된 개수까지만 검사한다.
- `totalEntriesExact=false`, `totalsExact=false`, `truncated=true`를 반환한다.
- UI는 개수와 용량 뒤에 `+`를 붙여 부분 합계임을 표시한다.
- 화면에 표시하는 이름은 기존처럼 최대 2,500개 및 총 1 MiB로 제한된다.

## 새 환경 변수

```dotenv
SEVEN_ZIP_PREVIEW_ENABLED=true
SEVEN_ZIP_PREVIEW_TIMEOUT_MS=60000
SEVEN_ZIP_PREVIEW_MAX_HEADER_MB=128
SEVEN_ZIP_PREVIEW_MAX_SCANNED_ENTRIES=100000
```

실제 아카이브가 기본 128 MiB 메타데이터 상한을 넘는다는 새 로그가 확인될 때에만 `SEVEN_ZIP_PREVIEW_MAX_HEADER_MB=256`으로 올리는 것이 권장된다. 256 MiB를 초과하는 값은 자동으로 256으로 제한된다.

## 회귀 검증

추가된 독립 단위 테스트는 다음을 검증한다.

- `SEVEN_ZIP_METADATA_LIMIT`와 `futime EPERM`이 함께 발생해도 원래 오류가 유지된다.
- `futimesSync`의 Windows형 `EPERM` 뒤에 동일 파일 경로의 `utimesSync` 폴백이 성공한다.
- 파일 경로가 다른 inode로 교체된 경우 폴백이 `ESTALE`로 중단된다.
- 대용량 7z 설정값의 기본값과 최소/최대 클램프가 유지된다.
- 엔트리 검사 상한 도달 시 오류 대신 부분 결과가 반환된다.

## 배포 확인

```powershell
npm ci --ignore-scripts
npm test
pm2 restart ecosystem.config.cjs --env production
pm2 logs RecordDrive
```

운영 서버는 `package.json`에 명시된 Node.js 버전 범위를 사용해야 한다. 실제 문제가 발생한 12 GB 7z 파일로 최종 수용 테스트를 수행하고, 로그에 표시되는 declared header size가 128 MiB를 넘을 때만 위 환경 변수로 상한을 조정한다.

## 참고 자료

- Microsoft `SetFileTime`: https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-setfiletime
- Node.js file system API: https://nodejs.org/api/fs.html
- 7-Zip 7z format overview: https://www.7-zip.org/7z.html
