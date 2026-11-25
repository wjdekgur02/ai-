import { METRICS } from './evaluate.mjs';

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' });
export const date = value => value ? time.format(value) : '—';
const score = x => x == null ? '—' : String(x);
const labels = { participant: '참가자', reviewer: '관리자1', admin: '관리자2',
  scored: '채점 완료', late: '마감 후 접수', uploading: '업로드 중', failed: '접수 실패',
  pass: '적합', fail: '부적합' };
const label = key => labels[key] ?? '—';
const csrf = ctx => `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`;
const chip = (value, kind = '') => `<span class="chip ${kind}">${esc(value)}</span>`;
const button = (text, url, variant = '') => `<a class="button ${variant}" href="${url}">${text}</a>`;

export function layout(ctx, title, content) {
  return `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ScoreLab</title><link rel="stylesheet" href="/assets/style.css"><script src="/assets/app.js" defer></script></head>
<body><a class="skip" href="#main">본문으로 이동</a>
<header class="top"><div class="frame bar"><a class="brand" href="/" aria-label="ScoreLab 홈">
<span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>ScoreLab</a>
${ctx.user ? `<nav aria-label="사용자 메뉴"><a href="/#competitions">대회 목록</a><span class="identity">${esc(ctx.user.name)} ${chip(label(ctx.user.role))}</span>
<form method="post" action="/logout">${csrf(ctx)}<button class="quiet" type="submit">로그아웃</button></form></nav>` : `<nav><a href="/login">로그인</a><a href="/signup">회원가입</a></nav>`}
</div></header>
<main id="main" class="frame">${content}</main>
<footer class="frame foot"><span>ScoreLab</span><span>AI 모델 성능평가 자동화</span></footer>
</body></html>`;
}

export function errorBody(message, back = '/') {
  return `<section class="panel narrow"><h1>요청을 처리할 수 없습니다</h1><p role="alert">${esc(message)}</p>${button('돌아가기', back)}</section>`;
}

export function account(ctx, signup, opts = {}) {
  const role = opts.reviewer ? '관리자1 등록' : signup ? '회원가입' : '로그인';
  return `<div class="auth-grid">
  <section class="hero hero-auth">
    <p class="eyebrow">AI 모델 성능평가 경진대회</p><h1>제출부터<br>최종 순위까지</h1>
    <p>예측 CSV를 제출하고 점수와 검증 상태를 확인하세요.</p>
  </section>
  <section class="panel auth-card"><h2>${role}</h2>
  ${opts.error ? `<p class="notice error" role="alert">${esc(opts.error)}</p>` : ''}
  <form class="stack" method="post" action="${signup ? '/signup' : '/login'}">${csrf(ctx)}
    ${signup ? '<label>이름<input name="name" autocomplete="name" maxlength="60" required></label>' : ''}
    <label>이메일<input name="email" type="email" autocomplete="email" maxlength="200" required></label>
    <label>비밀번호<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" ${signup ? 'minlength="12"' : ''} maxlength="128" required></label>
    ${signup ? `<label>${opts.reviewer ? '관리자1 초대 코드' : '대회 참여 코드'}<input name="code" value="${esc(opts.code)}" autocomplete="off" maxlength="80" required></label>` : ''}
    <button type="submit">${role}</button>
  </form>
  <p class="muted">${signup ? '이미 계정이 있나요? <a href="/login">로그인</a>' : '처음 참여하나요? <a href="/signup">회원가입</a>'}</p>
  </section>
  </div>`;
}

export function home(ctx, contests) {
  return `<section class="hero">
    <p class="eyebrow">대회 대시보드</p><h1>AI 모델 성능평가</h1>
    <p>${ctx.user.role === 'participant' ? '프로젝트별 데이터, 남은 제출 횟수, 실시간 순위를 확인하세요.' : '프로젝트 운영 현황과 제출물 검토 상태를 확인하세요.'}</p>
  </section>
  <div class="wide-grid">
    <section id="competitions" class="section"><h2>대회 목록</h2>
      ${contests.length ? `<div class="cards">${contests.map(c =>
        `<article class="panel card"><h3><a href="/c/${c.id}">${esc(c.title)}</a></h3><p class="muted">프로젝트 ${c.projects}개</p><a class="cover-link" href="/c/${c.id}" aria-label="${esc(c.title)} 열기">열기 <span aria-hidden="true">↗</span></a></article>`
      ).join('')}</div>` : '<p class="empty">참여 중인 대회가 없습니다.</p>'}</section>
    <aside class="panel sidebar">
    ${ctx.user.role === 'admin' ? `<h2>대회 개설</h2><form method="post" action="/contests" class="stack">${csrf(ctx)}
        <label>대회명<input name="title" required maxlength="100"></label><button>대회 만들기</button></form>`
      : `<h2>대회 추가</h2><form method="post" action="/join" class="stack">${csrf(ctx)}
        <label>${ctx.user.role === 'reviewer' ? '관리자1 초대 코드' : '대회 참여 코드'}<input name="code" maxlength="80" autocomplete="off" required></label><button>대회 추가하기</button></form>`}
    </aside>
  </div>`;
}

function crumbs(contest, project) {
  return `<nav class="crumb" aria-label="현재 위치"><a href="/">대회 목록</a><span aria-hidden="true">/</span>
  ${project ? `<a href="/c/${contest.id}">${esc(contest.title)}</a><span aria-hidden="true">/</span><a href="/p/${project.id}">${esc(project.title)}</a>` : esc(contest.title)}</nav>`;
}

export function contest(ctx, contest, projects, members, logs, invite) {
  const staff = ctx.user.role !== 'participant';
  const admin = ctx.user.role === 'admin';
  return `${crumbs(contest)}<section class="hero">
    <p class="eyebrow">경진대회</p><h1>${esc(contest.title)}</h1>
    ${staff ? `<p>참여 코드 <code>${esc(contest.join_code)}</code></p>` : ''}
    ${admin ? button('프로젝트 개설', '/c/' + contest.id + '/create', 'light') : ''}
  </section>
  <section class="section"><h2>프로젝트</h2>
  ${projects.length ? `<div class="cards">${projects.map(p => `<article class="panel card">
    ${chip(METRICS[p.metric])}<h3><a href="/p/${p.id}">${esc(p.title)}</a></h3>
    ${p.description ? `<p class="clamp muted">${esc(p.description)}</p>` : ''}
    <p class="muted small">최종 마감 ${date(p.cutoff)}</p><a class="cover-link" href="/p/${p.id}">프로젝트 열기 <span aria-hidden="true">↗</span></a>
  </article>`).join('')}</div>` : '<p class="empty">개설된 프로젝트가 없습니다.</p>'}</section>
  ${staff ? `<section class="panel section"><h2>대회 회원</h2>
    ${members.length ? `<div class="scroll"><table><thead><tr><th>이름</th><th>이메일</th><th>권한</th><th>참여 상태</th></tr></thead>
    <tbody>${members.map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td><td>${label(m.role)}</td><td>
      ${m.role === 'participant' ? `<form method="post" action="/c/${contest.id}/members/${m.id}">${csrf(ctx)}
      <input type="hidden" name="suspended" value="${m.suspended ? 0 : 1}"><button class="quiet" aria-label="${esc(m.name)} ${m.suspended ? '참여 복구' : '참여 정지'}">${m.suspended ? '정지됨 · 복구' : '참여 중 · 정지'}</button></form>` : '참여 중'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">등록된 회원이 없습니다.</p>'}
  </section>` : ''}
  ${admin ? `<section class="panel section"><h2>관리자1 초대</h2>
    ${invite ? `<p class="notice" role="status">초대 코드를 해당 관리자에게 전달하세요. 코드 유효 기간은 72시간입니다. <code>${esc(invite)}</code></p>` : ''}
    <form method="post" action="/c/${contest.id}/invite" class="inline">${csrf(ctx)}
    <label>관리자1 이메일<input type="email" name="email" required maxlength="200"></label><button>초대 코드 생성</button></form></section>` : ''}
  ${staff ? `<section class="panel section"><h2>최근 운영 기록</h2>
    ${logs.length ? `<div class="scroll"><table><thead><tr><th>시각 (KST)</th><th>처리자</th><th>작업</th><th>대상 ID</th></tr></thead>
    <tbody>${logs.map(l => `<tr><td>${date(l.happened)}</td><td>${esc(l.name)}</td><td>${esc(l.action)}</td><td class="mono">${esc(l.target)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">기록된 작업이 없습니다.</p>'}</section>` : ''}`;
}

const deadlineFields = `<label>마감 시각 (KST)<input name="cutoff" type="datetime-local" required></label>
  <label>제출 한도<input type="number" name="quota" value="3" min="1" max="100" step="1" required></label>`;

export function projectForm(ctx, contest) {
  return `${crumbs(contest)}<section class="panel section form-sheet"><h1>프로젝트 개설</h1>
  <form method="post" enctype="multipart/form-data" action="/c/${contest.id}/create" class="stack">${csrf(ctx)}
    <label>프로젝트 이름<input name="title" maxlength="100" required></label>
    <label>참가자 안내<textarea name="description" rows="3" maxlength="2000"></textarea></label>
    <div class="form-grid"><label>평가 지표<select name="metric">${Object.entries(METRICS).map(([key, text]) => `<option value="${key}">${text}</option>`).join('')}</select></label>
    <label>순위 기준<select name="direction"><option value="auto">지표 기본 방향</option><option value="high">높은 점수 우선</option><option value="low">낮은 점수 우선</option></select></label></div>
    <div class="form-grid"><label>ID 열 이름<input name="id_name" value="id" maxlength="100" required></label>
    <label>정답 및 예측 열 이름<input name="target_name" value="label" maxlength="100" required></label></div>
    <label>분류 레이블 <small>분류 지표에서 사용합니다. 한 줄에 하나씩 입력하세요.</small>
    <textarea name="classes" rows="3" maxlength="13000" placeholder="normal&#10;fault"></textarea></label>
    <label>정답이 포함된 테스트 CSV <small>지정한 정답 열을 제거한 파일만 참가자에게 제공됩니다. 최대 4 MiB.</small>
      <input type="file" name="dataset" accept=".csv,text/csv" required></label>
    <fieldset><legend>마감 및 제출 한도</legend><p class="muted">입력한 마감은 시간순으로 적용됩니다. 다음 회차는 직전 마감 이후 시작합니다.</p>
    <div id="deadline-list"><div class="deadline-row">${deadlineFields}</div></div>
    <template id="deadline-template"><div class="deadline-row">${deadlineFields}<button class="quiet remove" type="button">삭제</button></div></template>
    <button id="add-deadline" class="secondary" type="button">마감 추가</button>
    </fieldset><button>프로젝트 개설</button>
  </form></section>`;
}

function ranking(ctx, rows, final) {
  const staff = ctx.user.role !== 'participant';
  return `<section class="panel section"><div class="head"><h2>리더보드</h2>${chip(final ? '최종 성적' : '잠정 순위', final ? 'okay' : 'hint')}</div>
  ${rows.length ? `<div class="scroll"><table><thead><tr><th scope="col">순위</th><th scope="col">${staff ? '참가자 이름' : '참가자'}</th><th scope="col">점수</th><th scope="col">검증 상태</th></tr></thead><tbody>
  ${rows.map(r => `<tr${r.user_id === ctx.user.id ? ' class="mine"' : ''}><td class="rank">${r.rank}</td>
  <td>${esc(staff ? r.name : r.alias)} ${r.user_id === ctx.user.id ? chip('나') : ''}</td><td class="mono">${score(r.score)}</td>
  <td>${r.decision === 'pass' ? chip('검증 통과', 'okay') : chip(r.proposal ? '승인 대기' : '검증 대기', 'hint')}</td></tr>`).join('')}
  </tbody></table></div>` : '<p class="empty">아직 순위에 반영된 제출이 없습니다.</p>'}</section>`;
}

export function projectPage(ctx, contest, project, rounds, rows, history, pending, final, auditCount) {
  const staff = ctx.user.role !== 'participant';
  const active = rounds.find(r => r.cutoff > Date.now()) ?? rounds.at(-1);
  return `${crumbs(contest, project)}<section class="hero">
    <p class="eyebrow">${esc(contest.title)}</p><h1>${esc(project.title)}</h1>
    ${project.description ? `<p class="preserve">${esc(project.description)}</p>` : ''}
    <div class="actions">${button('특성 CSV 다운로드', '/p/' + project.id + '/files/features', 'light')}${button('예측 CSV 양식', '/p/' + project.id + '/files/template', 'ghost')}
    ${staff ? button('검토 대기열', '/p/' + project.id + '/review', 'ghost') + button('정답 열 다운로드', '/p/' + project.id + '/files/labels', 'ghost') : ''}</div>
  </section>
  <div class="stats">
  <div class="stat"><span>평가 지표</span><strong>${METRICS[project.metric]}</strong><small>${project.direction === 'high' ? '높은 점수 우선' : '낮은 점수 우선'}</small></div>
  <div class="stat"><span>테스트 데이터</span><strong>${project.rowCount.toLocaleString('ko-KR')}개</strong><small>예측 열 ${esc(project.target_name)}</small></div>
  <div class="stat"><span>${staff ? '검증 대기' : '선택된 회차의 남은 횟수'}</span><strong>${staff ? pending : active.quota - active.used}건</strong><small>${staff ? '참가자별 현재 검토 대상' : date(active.cutoff) + ' 마감'}</small></div>
  </div>
  ${staff ? '' : `<div class="wide-grid"><section class="panel section"><h2>제출 파일 업로드</h2>
    <form id="upload" class="stack" action="/p/${project.id}/upload" method="post" enctype="multipart/form-data">
    ${csrf(ctx)}<label>제출 회차<select name="round">
      ${rounds.map((r, i) => `<option value="${r.id}" ${r.id === active.id ? 'selected' : ''}>${i + 1}차 · ${date(r.cutoff)} · ${r.cutoff <= Date.now() ? '마감 후 접수' : '잔여 ' + (r.quota - r.used) + '회'}</option>`).join('')}
      </select></label>
      <label>예측 CSV <small>최대 4 MiB</small><input type="file" name="prediction" accept=".csv,text/csv" required></label>
      <label>Notebook <small>최대 3 MiB</small><input type="file" name="notebook" accept=".ipynb" required></label>
      <label>모델 가중치 <small>.safetensors, .skops, .keras · 최대 24 MiB</small><input type="file" name="model" accept=".safetensors,.skops,.keras" required></label>
      <label>코멘트 <small>선택</small><textarea name="comment" maxlength="1000" rows="2"></textarea></label>
      <button>제출하기</button>
      <progress max="100" value="0" aria-label="업로드 진행률" hidden></progress><p id="upload-status" class="muted" role="status" hidden></p>
      <noscript><p class="notice error">업로드에 JavaScript가 필요합니다.</p></noscript>
    </form>
  </section><aside class="panel section"><h2>제출 안내</h2>
    <ul class="guide"><li>예측 양식의 <code>${esc(project.id_name)}</code>와 <code>${esc(project.target_name)}</code> 열을 유지하세요.</li>
    <li>마감 전에 서버가 업로드 수신을 시작하면 완료 시각이 마감 이후여도 채점합니다.</li>
    <li>마감 후 해당 회차에 제출한 파일은 접수 상태만 표시합니다.</li>
    <li>정상 채점되어야 제출 횟수가 차감됩니다.</li></ul>
    ${project.classes.length ? `<h3>허용 레이블</h3><div class="actions">${project.classes.map(c => chip(c)).join('')}</div>` : ''}</aside></div>`}
  <section class="panel section"><h2>마감 일정</h2><div class="scroll"><table><thead><tr><th>회차</th><th>마감 (KST)</th><th>제출 한도</th>${staff ? '' : '<th>채점 완료</th><th>남은 횟수</th>'}</tr></thead>
    <tbody>${rounds.map((r, i) => `<tr><td>${i + 1}차</td><td>${date(r.cutoff)}</td><td>${r.quota}회</td>${staff ? '' : `<td>${r.used}회</td><td>${r.quota - r.used}회</td>`}</tr>`).join('')}</tbody></table></div></section>
  ${ranking(ctx, rows, final)}
  ${staff ? `<p class="muted small">이 프로젝트의 접수 기록 ${auditCount}건</p>` : `<section class="panel section"><h2>내 제출 기록</h2>
    ${history.length ? `<div class="scroll"><table><thead><tr><th>업로드 시작 (KST)</th><th>접수 상태</th><th>점수</th><th>결과</th></tr></thead><tbody>
    ${history.map(r => `<tr><td>${date(r.started)}</td><td>${chip(label(r.status), r.status === 'failed' ? 'danger' : '')}</td>
    <td class="mono">${score(r.score)}</td><td><a href="/p/${project.id}/s/${r.id}">상세</a> ${r.error ? esc(r.error) : r.decision ? esc(label(r.decision)) : ''}</td></tr>`).join('')}</tbody></table></div>` :
    '<p class="empty">제출한 파일이 없습니다.</p>'}</section>`}`;
}

export function reviewQueue(ctx, contest, project, rows, history, state) {
  return `${crumbs(contest, project)}<section class="hero"><p class="eyebrow">${esc(project.title)}</p><h1>검토 대기열</h1>
  <p>참가자별 최고 기록을 검토합니다. 같은 참가자의 동점 기록은 가장 최근에 수신 완료된 기록이 먼저 표시됩니다.</p></section>
  <section class="panel section"><div class="head"><h2>현재 검토 대상</h2>${chip(state.open ? '검토 가능' : state.message, state.open ? 'okay' : 'hint')}</div>
  ${rows.length ? `<div class="scroll"><table><thead><tr><th>순위</th><th>참가자</th><th>점수</th><th>단계</th><th>상세</th></tr></thead><tbody>
  ${rows.map(r => `<tr><td class="rank">${r.rank}</td><td>${esc(r.name)}</td><td class="mono">${score(r.score)}</td>
  <td>${r.decision ? chip('확정', 'okay') : r.proposal ? chip('승인 대기', 'hint') : chip('검토 대기')}</td>
  <td><a href="/p/${project.id}/s/${r.id}">제출 검토</a></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">채점된 제출이 없습니다.</p>'}</section>
  <section class="panel section"><h2>최근 접수 기록</h2>
  ${history.length ? `<div class="scroll"><table><thead><tr><th>참가자</th><th>시각 (KST)</th><th>접수</th><th>최종 판정</th><th>상세</th></tr></thead><tbody>
  ${history.map(r => `<tr><td>${esc(r.name)}</td><td>${date(r.started)}</td><td>${label(r.status)}</td><td>${label(r.decision)}</td>
  <td><a href="/p/${project.id}/s/${r.id}">상세</a></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">접수 기록이 없습니다.</p>'}</section>`;
}

export function submission(ctx, contest, project, record, files, cells, duplicates, allowed) {
  const staff = ctx.user.role !== 'participant';
  const root = '/p/' + project.id + '/s/' + record.id;
  const fileTitles = { prediction: '예측 CSV', notebook: 'Notebook', model: '모델 가중치' };
  return `${crumbs(contest, project)}<section class="hero"><p class="eyebrow">${staff ? esc(record.name) : '내 제출 기록'}</p><h1>제출 상세</h1>
    <p>업로드 수신 시작 ${date(record.started)} · ${label(record.status)}</p></section>
  <div class="wide-grid"><section class="panel section"><div class="head"><h2>채점 결과</h2>
    ${chip(record.decision ? label(record.decision) : label(record.status), record.decision === 'pass' ? 'okay' : '')}</div>
    <dl class="details"><dt>${METRICS[project.metric]} 점수</dt><dd class="mono">${score(record.score)}</dd>
    <dt>수신 완료</dt><dd>${date(record.finished)}</dd>
    ${record.error ? `<dt>사유</dt><dd>${esc(record.error)}</dd>` : ''}
    ${record.comment ? `<dt>제출 코멘트</dt><dd class="preserve">${esc(record.comment)}</dd>` : ''}
    ${staff && record.proposal ? `<dt>검토 제안</dt><dd>${label(record.proposal)} · ${esc(record.reviewer_name)}<p class="preserve">${esc(record.review_note)}</p></dd>` : ''}
    ${record.decision ? `<dt>최종 판정</dt><dd>${label(record.decision)}${staff ? ' · ' + esc(record.approver_name) : ''}${staff ? `<p class="preserve">${esc(record.decision_note)}</p>` : ''}</dd>` : ''}
    </dl><div class="actions">${files.map(f => button(fileTitles[f.kind], root + '/file/' + f.kind, 'secondary')).join('')}</div>
    </section>
    ${staff && record.status === 'scored' ? `<aside class="panel section"><h2>검토 보조 정보</h2>
    <p>예측값 전체가 동일한 다른 참가자 기록 <strong>${duplicates}건</strong></p>
    <p class="muted small">동일 예측은 확인이 필요한 신호입니다. Notebook의 모델 로드, 추론 및 CSV 생성 과정을 같이 확인하세요.</p>
    ${allowed.propose ? `<form class="stack" method="post" action="${root}/propose">${csrf(ctx)}<label>제안 판정<select name="choice"><option value="pass">적합</option><option value="fail">부적합</option></select></label>
    <label>검토 의견<textarea name="note" rows="3" maxlength="1500" required></textarea></label><button>판정 제안 저장</button></form>` : ''}
    ${allowed.approve ? `<form class="stack" method="post" action="${root}/decide">${csrf(ctx)}
    <label>최종 판단 근거<textarea name="note" rows="3" maxlength="1500" required></textarea></label>
    <div class="actions"><button name="choice" value="approve">제안 승인</button><button class="secondary" name="choice" value="return">재검토 요청</button></div></form>` : ''}
    ${!allowed.propose && !allowed.approve && !record.decision ? `<p class="notice">${esc(allowed.message)}</p>` : ''}
    ${record.decision_note && !record.decision ? `<p class="notice preserve">재검토 사유 · ${esc(record.decision_note)}</p>` : ''}
    </aside>` : ''}</div>
  ${cells.length ? `<section class="panel section"><h2>Notebook 검토</h2><p class="muted">셀 원문과 텍스트 로그를 표시합니다. Notebook은 실행하지 않습니다.</p>
  ${cells.map((c, i) => `<details class="cell"${i === 0 ? ' open' : ''}><summary>${i + 1}. ${esc(c.type)}${c.outputCount ? ' · 출력 ' + c.outputCount + '개' : ''}</summary>
  <pre><code>${esc(c.source)}</code></pre>${c.logs ? `<pre class="log"><code>${esc(c.logs)}</code></pre>` : ''}</details>`).join('')}</section>` : ''}`;
}
