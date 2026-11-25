# ai-
SCH Univ 플랫폼 개발대회

# ScoreLab · AI 모델 성능평가 경진대회

참가자가 예측 CSV, Notebook, 모델 가중치를 제출하면 비공개 정답으로 채점합니다. 관리자1이 대표 후보의 코드를 검토하고, 관리자2가 승인하면 성적이 확정됩니다.

## 실행

Node.js 24와 npm이 필요합니다. 외부 npm 패키지 설치는 필요하지 않습니다.

```bash
git clone https://github.com/wjdekgur02/ai-.git scorelab
cd scorelab
npm run demo
```

브라우저에서 http://127.0.0.1:8080 을 여세요. 공통 시연 비밀번호는 `ScoreLab-demo-2026!`입니다.

| 역할 | 로그인 이메일 | 시연할 작업 |
|---|---|---|
| 참가자 | dahyeok@scorelab.test | 모터 이상 분류 → 파일 제출 → 점수 확인 |
| 관리자1 | reviewer@scorelab.test | 검토 연습 → 검토 대기열 → 코드 확인 → 판정 제안 |
| 관리자2 | admin@scorelab.test | 같은 기록 열기 → 제안 승인 또는 재검토 요청 |

참가자 계정에서 **모터 이상 분류** 프로젝트를 열고, 데모 실행 시 자동 생성된 `.demo-data/samples/`의 `prediction.csv`, `notebook.ipynb`, `model.safetensors`를 제출하세요. 채점 후 상세 화면에는 0.8333333333이 표시됩니다. 새 계정은 회원가입 시 코드 `SCORELAB-DEMO`를 입력하세요. **모터 이상 분류 · 검토 연습**은 마감된 별도 프로젝트이며 후보 3건을 미리 넣었습니다. 발표 자료는 [docs/presentation.html](docs/presentation.html)을 내려받아 브라우저로 열고 방향키로 넘기세요.

## 어떤 데이터로 어떤 결과가 나왔나

직접 구성한 모터 상태 관측 12건에 정상 6건과 이상 6건을 배정했습니다. 각 행에는 ID, 진동 RMS, 온도(°C), 전류(A)가 있습니다. 시연용 합성 데이터이며 실제 기체 측정 또는 독립 시험 결과는 없습니다. 고정 임곗값 규칙을 사용했고 별도 학습 단계는 없습니다. 전류는 입력 특성으로 제공하며 이번 세 규칙은 진동과 온도를 사용합니다.

| 이상으로 예측하는 조건 | 정답 | 정확도 | 오분류 ID |
|---|---:|---:|---|
| 진동 ≥ 2.25 | 9/12 | 75.00% | M05, M06, M08 |
| 진동 ≥ 2.00 | 10/12 | 83.33% | M05, M08 |
| 진동 ≥ 2.00 또는 온도 ≥ 80°C | 11/12 | 91.67% | M08 |

M05는 진동이 1.80으로 낮지만 온도가 83°C인 이상 사례입니다. 온도 조건을 추가하면 이 행을 맞힙니다. M08은 정상인데 진동이 2.25여서 세 규칙 모두 이상으로 분류합니다. 세 모델은 같은 12건으로 비교했습니다. 가장 높은 수치는 이 예제에 한정됩니다.

### 점수가 계산되는 과정

1. 관리자2가 ID, 정답 열, 지표, 허용 레이블, 기간별 제출 한도를 지정합니다. 공개용 CSV를 만들 때 정답 열을 제거합니다.
2. 예제 Notebook은 가중치 파일에서 두 임곗값을 읽고 각 ID의 예측을 CSV에 씁니다. 예제에는 Python 표준 라이브러리만 필요합니다. Jupyter에서 예제 디렉터리의 Notebook을 열고 셀을 순서대로 실행하면 재생성할 수 있습니다.
3. 서버는 파일 내부 구조, 헤더·행 수·ID·허용 레이블을 검사합니다. ID 순서로 정렬해 정답 일치 개수를 전체 개수로 나눕니다. Accuracy, Macro F1, MAE, RMSE를 지원합니다. Macro F1은 등록된 클래스별 F1의 단순 평균이며 분모가 0인 클래스는 0점입니다.
4. 채점 성공만 횟수에서 차감합니다. 마감 전 첫 데이터가 도착하면 마감 후 완료해도 채점하며 업로드 처리 제한은 120초입니다. 마감된 회차의 신규 제출은 파일 접수만 합니다.
5. 참가자끼리는 가명, 관리자에게는 실명이 표시됩니다. 같은 참가자의 최고점 동점은 최근 수신 완료 순, 참가자 간 동점은 공동 순위입니다. 최고점에 부적합 제안이 있어도 관리자2 승인 전까지 순위를 유지합니다. 승인 후 다음 후보를 검토합니다. 판정 제안자와 승인자는 서로 다른 계정이어야 합니다.

## 구현과 운영

| 경로 | 역할 |
|---|---|
| src/server.mjs | 인증, 대회, 파일 접수, 채점, 검토 API |
| src/evaluate.mjs | CSV 파싱, ID 매칭, 지표와 파일 구조 검증 |
| src/store.mjs | SQLite 스키마, 트랜잭션, 대표 제출 선택 |
| src/views.mjs / public/ | 한국어 화면, 업로드 진행률, 마감 설정 |
| src/demo.mjs | 합성 데이터, 제출 예시, 연습 계정 생성 |
| test/workflow.test.mjs | 제출·오류·마감·권한·승인 경로와 지표 검증 |
| docs/presentation.html | 오프라인 발표 자료 |

운영 데이터는 기본적으로 data/scorelab.sqlite, 데모 데이터는 .demo-data/에 저장합니다. 두 경로 모두 Git에서 제외합니다. 빈 운영 DB에는 아래처럼 관리자2 계정을 만든 뒤 시작합니다.

```bash
read -rsp '새 관리자 비밀번호 (12자 이상): ' admin_password
printf '%s' "$admin_password" | npm run admin -- admin@example.org 운영관리자
unset admin_password
npm start
```

관리자2가 대회를 개설한 뒤 회원 이메일에 연결한 일회용 코드로 관리자1을 초대합니다. 대회 참여 코드는 일반 참가자용입니다. 관리자1의 권한은 담당 대회로 제한됩니다. 모델과 Notebook은 서버에서 실행하지 않습니다. Notebook은 이스케이프한 원문과 텍스트 로그만 보여줍니다. 예측 전체가 같은 타 참가자의 기록 수를 검토 보조 정보로 표시하며 최종 판단은 관리자가 합니다. 지원 가중치 형식은 scikit-learn의 .skops, PyTorch 등에서 내보낸 .safetensors, Keras의 .keras입니다.

단일 Node 프로세스와 SQLite WAL을 기준으로 작성했습니다. 파일과 점수를 같은 트랜잭션에 저장합니다. 서버 중단으로 남은 업로드는 만료 후 실패 처리되어 재시도할 수 있습니다. 백업은 SQLite 온라인 백업 또는 정상 종료 후 DB 복사로 진행하세요. 외부 운영 시 HTTPS 역방향 프록시, SCORELAB_SECURE=1과 SCORELAB_ORIGIN 설정이 필요합니다. Nginx에서는 proxy_request_buffering off를 적용해야 서버가 수신 시작을 관측할 수 있습니다. 운영 전 실제 네트워크에서 업로드 시간과 동시 사용자 부하를 확인하세요.

검증 명령은 `npm test`입니다. 테스트는 임시 DB에서 서버 요청 처리기를 호출해 제출·채점, 정답 접근 차단, 가명 표시, 마감 후 접수, 파일 누락 시 미차감, 부적합 승인 후 후보 교체와 성적 확정을 확인합니다.

참고 자료: [행정안전부 소프트웨어 개발보안 가이드](https://www.mois.go.kr/frt/bbs/type001/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000015&nttId=88956), [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).
