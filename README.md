# AI 모델 성능평가 경진대회
SCH Univ 플랫폼 개발대회

참가자가 예측 CSV, Notebook, 모델 가중치를 제출하면 비공개 정답으로 채점합니다. 관리자1이 대표 후보의 코드를 검토하고, 관리자2가 승인하면 성적이 확정됩니다.

## 실행과 역할별 확인

Node.js 24와 Python 3를 사용합니다. 별도 패키지 설치는 필요 없습니다. [Kaggle Input](https://www.kaggle.com/code/mobeenfatimah/gta-vi-trailer-frames-computer-vision-analytics/input)에서 `gta6_dataset.csv`를 내려받은 뒤 아래처럼 파일 위치를 지정하세요.

```bash
git clone https://github.com/wjdekgur02/ai-.git scorelab
cd scorelab
npm run demo -- "$HOME/Downloads/gta6_dataset.csv"
```

브라우저에서 http://127.0.0.1:8080 을 엽니다. 아래 계정의 공통 로컬 시연 비밀번호는 `ScoreLab-demo-2026!`입니다. 회원가입으로 시작하려면 참여 코드 `SCORELAB-DEMO`를 사용하세요.

| 로그인 이메일 | 확인할 기능 |
|---|---|
| dahyeok@scorelab.test | **GTA VI 장면 유형 분류**에서 예측 CSV, Notebook, 가중치를 제출하고 점수와 남은 횟수 확인 |
| reviewer@scorelab.test | **검토 연습**의 최고점 기록에서 Notebook 원문·로그를 검토하고 의견과 적합/부적합 판정 제안 |
| admin@scorelab.test | 같은 기록에서 근거를 확인하고 제안 승인 또는 재검토 요청 |

참가자가 업로드할 세 파일은 `.demo-data/gta6/samples/` 안의 `prediction.csv`, `notebook.ipynb`, `model.safetensors`입니다. 서버는 참가자에게 정답을 제거한 특성 CSV와 제출 양식을 제공합니다. 관리자용 정답은 samples 밖에 저장합니다. 첫 회차는 3회, 둘째 회차는 2회까지 채점합니다. 검토 연습은 이미 마감된 별도 프로젝트입니다. [발표 자료](docs/presentation.html)는 다운로드 후 브라우저에서 열고 방향키로 넘길 수 있습니다.

## Kaggle 데이터와 실제 채점

원본 CSV는 22열, 10,000행입니다. 같은 frame_id의 모든 열이 동일한지 확인하고 중복을 제거하자 **500개의 고유 프레임**이 남았습니다. 트레일러 번호로 묶어 1번의 245개로만 학습하고 2번의 255개로 평가했습니다. 원본 SHA-256은 `e325ab5b98dad6d2edf93ac81a411d8a1744522ce1990d416358a46b74cc24f8`입니다.

- **입력**은 등장인물·차량·물체의 텍스트 주석입니다. 장면명이 들어 있는 캡션과 키워드, 파일명, 프레임 번호는 모델 입력에서 제외했습니다.
- **정답**은 scene_type의 10개 장면 유형입니다. 모델은 학습 데이터에서 각 클래스의 빈도와 주석 단어의 조건부 빈도를 세는 다항 나이브 베이즈입니다. 라플라스 평활을 적용하고 학습된 로그 가중치를 저장한 뒤 다시 읽어 예측합니다.
- **재현**하려면 samples 디렉터리에서 생성된 Notebook을 실행하세요. train.csv와 features.csv만으로 가중치와 예측 CSV를 생성합니다.

| 동일한 평가 프레임 255개 | 맞힌 개수 | Accuracy |
|---|---:|---:|
| 학습 데이터의 최빈 장면 Swamp로 모두 예측 | 18 | 7.06% |
| 등장인물·차량·물체로 학습한 모델 | 26 | 10.20% |

예시로 F00002는 실제 Swamp를 맞혔고 F00003은 실제 Club을 City로 예측했습니다. 모델 정확도는 낮으며, 공식 채점값 0.1019607843은 예측 CSV 255행 중 정답과 일치한 26행에서 나옵니다. 평가 대상은 영상 픽셀이 아닌 제공된 주석을 이용한 분류입니다.

## RFP 구현 범위

| RFP | 웹에서 확인할 정책 |
|---|---|
| 3쪽 · 역할과 참여 | 참여 코드 필수 가입 및 추가 대회 등록, 담당 대회 관리자1의 회원 관리, 관리자2의 대회 개설 및 초대 |
| 4~5쪽 · 접수와 채점 | 필수 세 파일 내용 검사, 회차별 마감과 횟수, 마감 전 전송 시작 인정, 마감 후 접수만 허용, 실패 미차감 |
| 6쪽 · 순위와 성적 | 참가자 가명/담당 관리자 실명, 최고점과 공동 순위, 동점 최신 제출 우선 검토, 부적합 승인 뒤 차순위 후보 검토 |
| 7~8쪽 · 검토와 보안 | 대회별 접근 제어, 감사 기록, Notebook 원문과 텍스트 로그 표시, 동일 예측 기록 수 제공, 서로 다른 계정의 제안과 승인 |

### 점수가 계산되는 과정

1. 관리자2가 ID, 정답 열, 지표, 허용 레이블, 기간별 제출 한도를 지정합니다. 공개용 CSV를 만들 때 정답 열을 제거합니다.
2. 예제 Notebook은 학습한 장면 분류 가중치를 파일에 저장하고 다시 읽어 각 프레임의 예측을 CSV에 씁니다. 예제에는 Python 표준 라이브러리만 필요합니다. Jupyter에서 예제 디렉터리의 Notebook을 열고 셀을 순서대로 실행하면 재생성할 수 있습니다.
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
| src/gta-demo.mjs, examples/gta6/prepare.py | Kaggle 중복 제거, 학습·예측, 공식 채점 및 시연 대회 생성 |
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
