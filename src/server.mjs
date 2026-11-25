import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { InputError, LIMITS, MiB, METRICS, HIGHER, dataset, encodeCsv, evaluate, expect,
  comparePredictions, inspectModel, inspectNotebook, score } from './evaluate.mjs';
import { audit, connect, createProject, enroll, hash, opaque, passwordDigest, rejectStale, standings, verifyPassword } from './store.mjs';
import * as views from './views.mjs';

const HOUR = 3600000;
const SESSION = 12 * HOUR;
const TIMEOUT = 120000;
const secure = process.env.SCORELAB_SECURE === '1';
const csrfCookie = secure ? '__Host-sl_csrf' : 'sl_csrf';
const sessionCookie = secure ? '__Host-sl_session' : 'sl_session';
const bind = process.env.SCORELAB_HOST || '127.0.0.1';
if (!secure && !['127.0.0.1', '::1', 'localhost'].includes(bind)) {
  throw new Error('외부 주소 사용 시 HTTPS 설정 및 SCORELAB_SECURE=1이 필요합니다.');
}
process.umask(0o077);
const store = connect();
const dummyDigest = await passwordDigest(opaque());
const throttle = new Map();
let activeBodies = 0;
let activePasswords = 0;
const publicFiles = new Map([
  ['/assets/style.css', ['text/css; charset=utf-8', readFileSync(new URL('../public/style.css', import.meta.url))]],
  ['/assets/app.js', ['text/javascript; charset=utf-8', readFileSync(new URL('../public/app.js', import.meta.url))]],
]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const text = (form, key) => typeof form.get(key) === 'string' ? form.get(key) : '';
const shape = (data, max) => data.trim().length > 0 && data.trim().length <= max;
const emailValid = e => e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const file = async (form, name, allow, limit, displayName) => {
  const part = form.get(name);
  const ext = extname(part?.name || '').toLowerCase();
  expect(form.getAll(name).length === 1 && part && typeof part.arrayBuffer === 'function' && part.size &&
    part.size <= limit && allow.includes(ext), displayName + ' 파일의 확장자 또는 용량을 확인해 주세요.');
  return { ext, bytes: Buffer.from(await part.arrayBuffer()) };
};

function cookie(res, name, value, age) {
  res.appendHeader('Set-Cookie', `${name}=${value}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
}
function headers(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
function page(ctx, title, body, status = 200) {
  if (ctx.res.destroyed) return;
  ctx.res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(views.layout(ctx, title, body));
}
function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}
function output(res, status, payload) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
function download(res, name, bytes) {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"` });
  res.end(bytes);
}
function context(req, res) {
  const cookies = new Map((req.headers.cookie || '').split('; ').map(pair => pair.split('=')));
  const session = cookies.get(sessionCookie);
  let token = cookies.get(csrfCookie);
  if (!/^[\w-]{32}$/.test(token ?? '')) {
    token = opaque();
    cookie(res, csrfCookie, token, SESSION / 1000);
  }
  const user = /^[\w-]{32}$/.test(session ?? '') ?
    store.get('SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=? AND s.expires>?',
      hash(session), Date.now()) : null;
  return { req, res, user, csrf: token, session };
}
function sameCsrf(ctx, value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) !== 32 ||
    !timingSafeEqual(Buffer.from(value), Buffer.from(ctx.csrf))) fail(403, '보안 토큰이 만료되었습니다. 페이지를 새로고침해 주세요.');
}
async function body(req, limit, started) {
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined && Number(contentLength) > limit) fail(413, '업로드 용량 한도를 초과했습니다.');
  if (activeBodies >= 8) fail(503, '서버에서 여러 요청을 처리 중입니다. 잠시 뒤 다시 시도해 주세요.');
  activeBodies++;
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      if (!size && chunk.length) started?.(Date.now());
      size += chunk.length;
      if (size > limit) fail(413, '업로드 용량 한도를 초과했습니다.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally { activeBodies--; }
}
async function formData(ctx, limit, multipart = false, started) {
  const type = ctx.req.headers['content-type'] ?? '';
  if (multipart ? !type.toLowerCase().startsWith('multipart/form-data;') :
    !type.toLowerCase().startsWith('application/x-www-form-urlencoded')) fail(415, '제출 형식을 확인해 주세요.');
  const bytes = await body(ctx.req, limit, started);
  try { return await new Response(bytes, { headers: { 'Content-Type': type } }).formData(); }
  catch { fail(400, '파일 전송 양식이 올바르지 않습니다. 파일을 다시 선택해 주세요.'); }
}
async function form(ctx) {
  const result = await formData(ctx, 48 * 1024);
  sameCsrf(ctx, text(result, '_csrf'));
  return result;
}
function throttleAccount(ctx) {
  const now = Date.now();
  const ip = ctx.req.socket.remoteAddress;
  let entry = throttle.get(ip);
  if (!entry || entry.until <= now) {
    if (throttle.size >= 10000) fail(503, '잠시 후 다시 시도해 주세요.');
    entry = { count: 0, until: now + 60000 };
    throttle.set(ip, entry);
  }
  if (++entry.count > 20 || activePasswords >= 4) fail(429, '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
}
function newSession(ctx, userId) {
  const token = opaque();
  store.run('INSERT INTO sessions(digest,user_id,expires) VALUES (?,?,?)', hash(token), userId, Date.now() + SESSION);
  cookie(ctx.res, sessionCookie, token, SESSION / 1000);
  cookie(ctx.res, csrfCookie, opaque(), SESSION / 1000);
  redirect(ctx.res, '/');
}
function inviteFor(code, email) {
  return store.get('SELECT * FROM invitations WHERE digest=? AND email=? AND used_by IS NULL AND expires>?',
    hash(code), email, Date.now());
}
async function authenticate(ctx, signup) {
  throttleAccount(ctx);
  const data = await form(ctx);
  const email = text(data, 'email').trim().toLowerCase();
  const password = text(data, 'password');
  const code = text(data, 'code').trim();
  const name = text(data, 'name').trim();
  if (!emailValid(email) || !password || password.length > 128) fail(400, '이메일과 비밀번호를 확인해 주세요.');
  if (activePasswords >= 4) fail(429, '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
  activePasswords++;
  try {
    if (!signup) {
      const user = store.get('SELECT id,password FROM users WHERE email=?', email);
      const match = await verifyPassword(password, user?.password ?? dummyDigest);
      if (!user || !match) fail(401, '이메일 또는 비밀번호가 일치하지 않습니다.');
      return newSession(ctx, user.id);
    }
    expect(shape(name, 60) && password.length >= 12 && shape(code, 80), '이름, 비밀번호 12자 이상, 참여 코드를 확인해 주세요.');
    const passwordHash = await passwordDigest(password);
    const userId = store.transaction(() => {
      const invitation = inviteFor(code, email);
      const contest = invitation ?? store.get('SELECT id AS contest_id FROM contests WHERE join_code=?', code.toUpperCase());
      expect(contest, '이메일과 참여 코드가 유효한지 확인해 주세요.');
      expect(!store.get('SELECT id FROM users WHERE email=?', email), '이미 가입한 이메일입니다. 로그인해 주세요.');
      const userId = Number(store.run('INSERT INTO users(email,name,password,role) VALUES(?,?,?,?)',
        email, name, passwordHash, invitation ? 'reviewer' : 'participant').lastInsertRowid);
      enroll(store, contest.contest_id, userId);
      if (invitation) store.run('UPDATE invitations SET used_by=? WHERE digest=?', userId, invitation.digest);
      audit(store, contest.contest_id, userId, '회원 등록', userId);
      return userId;
    });
    newSession(ctx, userId);
  } finally { activePasswords--; }
}
function requireRole(ctx, ...roles) {
  if (!roles.includes(ctx.user.role)) fail(403, '이 작업을 수행할 권한이 없습니다.');
}
function membership(ctx, contestId) {
  if (ctx.user.role !== 'admin' && !store.get('SELECT 1 FROM members WHERE contest_id=? AND user_id=? AND suspended=0',
    contestId, ctx.user.id)) fail(404, '대회를 찾을 수 없습니다.');
}
function loadContest(ctx, contestId) {
  membership(ctx, contestId);
  const contest = store.get('SELECT * FROM contests WHERE id=?', contestId);
  if (!contest) fail(404, '대회를 찾을 수 없습니다.');
  return contest;
}
function loadProject(ctx, projectId) {
  const project = store.get(`SELECT id,contest_id,title,description,metric,direction,id_name,target_name,classes,created,
    json_array_length(ids) AS rowCount FROM projects WHERE id=?`, projectId);
  if (!project) fail(404, '프로젝트를 찾을 수 없습니다.');
  project.classes = JSON.parse(project.classes);
  return { project, contest: loadContest(ctx, project.contest_id) };
}
function contestPage(ctx, contest, invite) {
  const projects = store.all(`SELECT p.id,p.title,p.description,p.metric,MAX(r.cutoff) cutoff
    FROM projects p JOIN rounds r ON r.project_id=p.id WHERE p.contest_id=? GROUP BY p.id ORDER BY p.id DESC`, contest.id);
  const staff = ctx.user.role !== 'participant';
  const members = staff ? store.all(`SELECT u.id,u.name,u.email,u.role,m.suspended FROM members m
    JOIN users u ON u.id=m.user_id WHERE m.contest_id=? ORDER BY u.name`, contest.id) : [];
  const logs = staff ? store.all(`SELECT a.*,u.name FROM audit a JOIN users u ON u.id=a.actor_id
    WHERE a.contest_id=? ORDER BY a.id DESC LIMIT 50`, contest.id) : [];
  page(ctx, contest.title, views.contest(ctx, contest, projects, members, logs, invite));
}
function roundsFor(projectId, userId) {
  return store.all(`SELECT r.*,(SELECT count(*) FROM submissions s WHERE s.round_id=r.id AND s.user_id=? AND s.status='scored') AS used
    FROM rounds r WHERE r.project_id=? ORDER BY cutoff`, userId, projectId);
}
function reviewState(projectId) {
  const now = Date.now();
  const { cutoff } = store.get('SELECT max(cutoff) AS cutoff FROM rounds WHERE project_id=?', projectId);
  if (now < cutoff) return { open: false, message: '최종 마감 후 검토 가능' };
  if (store.get(`SELECT 1 FROM submissions s JOIN rounds r ON r.id=s.round_id WHERE s.project_id=?
    AND s.status='uploading' AND s.started<r.cutoff AND s.expires>? LIMIT 1`, projectId, now)) {
    return { open: false, message: '마감 전 업로드 수신 중' };
  }
  return { open: true, message: '' };
}
async function projectCreate(ctx, contest) {
  const data = await formData(ctx, LIMITS.csv + MiB, true);
  sameCsrf(ctx, text(data, '_csrf'));
  const title = text(data, 'title').trim();
  const description = text(data, 'description').trim();
  const metric = text(data, 'metric');
  const order = text(data, 'direction');
  const idName = text(data, 'id_name').trim();
  const targetName = text(data, 'target_name').trim();
  const classes = HIGHER.has(metric) ? text(data, 'classes').split(/\r?\n/).map(c => c.trim()).filter(Boolean) : [];
  expect(shape(title, 100) && description.length <= 2000 && shape(idName, 100) && shape(targetName, 100) &&
    Object.hasOwn(METRICS, metric) && ['auto', 'high', 'low'].includes(order), '프로젝트 설정을 확인해 주세요.');
  const deadlines = data.getAll('cutoff');
  const quotas = data.getAll('quota');
  const now = Date.now();
  expect(deadlines.length >= 1 && deadlines.length <= 12 && deadlines.length === quotas.length, '마감은 1~12개를 입력해 주세요.');
  const rounds = deadlines.map((deadline, i) => {
    const cutoff = Date.parse(deadline + ':00+09:00');
    const quota = Number(quotas[i]);
    expect(typeof deadline === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(deadline) &&
      Number.isFinite(cutoff) && new Date(cutoff + 9 * HOUR).toISOString().slice(0, 16) === deadline &&
      cutoff > now && Number.isInteger(quota) && quota >= 1 && quota <= 100, '미래 마감 시각과 1~100회 제출 한도를 입력해 주세요.');
    return { cutoff, quota };
  });
  expect(new Set(rounds.map(r => r.cutoff)).size === rounds.length, '각 회차의 마감은 달라야 합니다.');
  const { bytes } = await file(data, 'dataset', ['.csv'], LIMITS.csv, '테스트 CSV');
  const parsed = dataset(bytes, idName, targetName, metric, classes);
  const direction = order === 'auto' ? (HIGHER.has(metric) ? 'high' : 'low') : order;
  const projectId = store.transaction(() => {
    const id = createProject(store, contest.id, { title, description, metric, direction, idName, targetName, classes }, parsed, rounds, now);
    audit(store, contest.id, ctx.user.id, '프로젝트 개설', id);
    return id;
  });
  redirect(ctx.res, '/p/' + projectId);
}
function candidateAccess(ctx, project, record) {
  if (ctx.user.role === 'participant' || record.status !== 'scored' || record.decision) return {};
  const state = reviewState(project.id);
  if (!state.open) return { message: state.message };
  if (!standings(store, project).some(r => r.id === record.id)) return { message: '이 참가자의 상위 기록 검토를 먼저 완료하세요.' };
  if (!record.proposal) return { propose: true };
  if (ctx.user.role === 'admin' && record.reviewer_id !== ctx.user.id) return { approve: true };
  return { message: '판정을 제안한 계정과 다른 관리자2의 승인이 필요합니다.' };
}

async function upload(ctx, project, roundId) {
  requireRole(ctx, 'participant');
  sameCsrf(ctx, ctx.req.headers['x-csrf-token']);
  const id = opaque(18);
  let reserved = false;
  let late = false;
  const recordUrl = `/p/${project.id}/s/${id}`;
  try {
    const data = await formData(ctx, LIMITS.upload, true, started => {
      store.transaction(() => {
        const round = store.get('SELECT * FROM rounds WHERE project_id=? AND id=?', project.id, roundId);
        if (!round) fail(404, '제출 회차를 찾을 수 없습니다.');
        const prev = store.get('SELECT max(cutoff) AS cutoff FROM rounds WHERE project_id=? AND cutoff<?', project.id, round.cutoff);
        if (prev.cutoff && started < prev.cutoff) fail(409, '아직 시작하지 않은 회차입니다.');
        rejectStale(store, started);
        if (store.get("SELECT 1 FROM submissions WHERE project_id=? AND user_id=? AND status='uploading'",
          project.id, ctx.user.id)) fail(409, '같은 프로젝트에서 앞선 업로드를 처리 중입니다.');
        late = started >= round.cutoff;
        if (!late) {
          const used = store.get("SELECT count(*) AS n FROM submissions WHERE round_id=? AND user_id=? AND status='scored'", roundId, ctx.user.id);
          if (used.n >= round.quota) fail(409, '해당 회차의 채점 횟수를 모두 사용했습니다.');
        }
        store.run("INSERT INTO submissions(id,project_id,round_id,user_id,started,expires,status) VALUES(?,?,?,?,?,?,'uploading')",
          id, project.id, roundId, ctx.user.id, started, started + TIMEOUT);
      });
      reserved = true;
    });
    expect(reserved, '전송된 파일이 없습니다.');
    const receivedAt = Date.now();
    const prediction = await file(data, 'prediction', ['.csv'], LIMITS.csv, '예측 CSV');
    const notebook = await file(data, 'notebook', ['.ipynb'], LIMITS.notebook, 'Notebook');
    const model = await file(data, 'model', ['.safetensors', '.skops', '.keras'], LIMITS.model, '모델 가중치');
    const comment = text(data, 'comment').trim();
    expect(comment.length <= 1000, '코멘트는 1,000자까지 입력할 수 있습니다.');
    inspectNotebook(notebook.bytes);
    inspectModel(model.bytes, model.ext);
    const config = store.get('SELECT id_name,target_name,metric,ids,classes FROM projects WHERE id=?', project.id);
    const { values, digest } = evaluate(prediction.bytes, config);
    const rating = late ? null : score(config.metric, values,
      JSON.parse(store.get('SELECT actual FROM projects WHERE id=?', project.id).actual), JSON.parse(config.classes));
    store.transaction(() => {
      const updated = store.run(`UPDATE submissions SET status=?,finished=?,score=?,digest=?,comment=?
        WHERE id=? AND status='uploading' AND expires>?`, late ? 'late' : 'scored', receivedAt, rating,
        digest, comment, id, Date.now());
      if (updated.changes !== 1) fail(408, '업로드 처리 시간이 초과되었습니다.');
      for (const [kind, attachment] of Object.entries({ prediction, notebook, model })) {
        store.run('INSERT INTO artifacts(submission_id,kind,ext,payload) VALUES(?,?,?,?)', id, kind, attachment.ext, attachment.bytes);
      }
      audit(store, project.contest_id, ctx.user.id, late ? '마감 후 접수' : '채점 완료', id);
    });
    output(ctx.res, 201, { url: recordUrl });
  } catch (error) {
    if (!reserved && !(error instanceof HttpError || error instanceof InputError)) throw error;
    const expected = error instanceof HttpError || error instanceof InputError;
    const disconnected = ctx.req.aborted;
    const message = expected ? error.message : disconnected ? '업로드 연결이 중단되었습니다.' : '채점 중 오류가 발생했습니다. 다시 시도해 주세요.';
    if (reserved) {
      store.run("UPDATE submissions SET status='failed',finished=?,error=? WHERE id=? AND status='uploading'", Date.now(), message, id);
    }
    if (!expected && !disconnected) console.error('Upload processing error', id, error.name);
    if (!ctx.req.complete) ctx.res.setHeader('Connection', 'close');
    output(ctx.res, expected ? (error.status ?? 400) : 500, { message, ...(reserved ? { url: recordUrl } : {}) });
  }
}

async function handle(ctx, path) {
  const { req, res, user } = ctx;
  const method = req.method;
  const get = method === 'GET';
  if (!get && method !== 'POST') fail(405, '지원하지 않는 요청 방식입니다.');
  if (!get && (req.headers['sec-fetch-site'] === 'cross-site' ||
      (process.env.SCORELAB_ORIGIN && req.headers.origin && req.headers.origin !== process.env.SCORELAB_ORIGIN))) {
    fail(403, '이 사이트에서 제출을 다시 시도해 주세요.');
  }
  if (path === '/login' || path === '/signup') {
    if (user) return redirect(res, '/');
    const signup = path === '/signup';
    if (get) return page(ctx, signup ? '회원가입' : '로그인', views.account(ctx, signup));
    try { return await authenticate(ctx, signup); }
    catch (error) {
      if (!(error instanceof InputError || error instanceof HttpError)) throw error;
      return page(ctx, signup ? '회원가입' : '로그인', views.account(ctx, signup, { error: error.message }), error.status ?? 400);
    }
  }
  if (!user) {
    if (get) return redirect(res, '/login');
    fail(401, '로그인이 필요합니다.');
  }
  if (path === '/logout' && !get) {
    await form(ctx);
    store.run('DELETE FROM sessions WHERE digest=?', hash(ctx.session));
    cookie(res, sessionCookie, '', 0);
    return redirect(res, '/login');
  }
  if (path === '/' && get) {
    const select = 'SELECT c.id,c.title,(SELECT count(*) FROM projects p WHERE p.contest_id=c.id) AS projects FROM contests c';
    const contests = user.role === 'admin' ? store.all(select + ' ORDER BY c.id DESC') :
      store.all(select + ' JOIN members m ON m.contest_id=c.id WHERE m.user_id=? AND m.suspended=0 ORDER BY c.id DESC', user.id);
    return page(ctx, '대회 대시보드', views.home(ctx, contests));
  }
  if (path === '/contests' && !get) {
    requireRole(ctx, 'admin');
    const data = await form(ctx);
    const title = text(data, 'title').trim();
    expect(shape(title, 100), '대회명을 입력해 주세요.');
    const contestId = store.transaction(() => {
      const result = store.run('INSERT INTO contests(title,join_code,created) VALUES(?,?,?)', title,
        opaque(12).toUpperCase(), Date.now());
      audit(store, Number(result.lastInsertRowid), user.id, '대회 개설', result.lastInsertRowid);
      return Number(result.lastInsertRowid);
    });
    return redirect(res, '/c/' + contestId);
  }
  if (path === '/join' && !get) {
    requireRole(ctx, 'reviewer', 'participant');
    const code = text(await form(ctx), 'code').trim();
    expect(shape(code, 80), '참여 코드를 확인해 주세요.');
    const id = store.transaction(() => {
      const invitation = user.role === 'reviewer' ? inviteFor(code, user.email) : null;
      const contest = user.role === 'reviewer' ? invitation :
        store.get('SELECT id AS contest_id FROM contests WHERE join_code=?', code.toUpperCase());
      expect(contest, '올바른 참여 코드 또는 초대 코드를 입력해 주세요.');
      const member = store.get('SELECT suspended FROM members WHERE contest_id=? AND user_id=?', contest.contest_id, user.id);
      if (member?.suspended) fail(403, '이 대회의 참여가 정지되어 있습니다.');
      if (!member) {
        enroll(store, contest.contest_id, user.id);
        audit(store, contest.contest_id, user.id, '대회 등록', user.id);
      }
      if (invitation) store.run('UPDATE invitations SET used_by=? WHERE digest=?', user.id, invitation.digest);
      return contest.contest_id;
    });
    return redirect(res, '/c/' + id);
  }

  const contestMatch = /^\/c\/(\d+)(?:\/(create|invite|members\/\d+))?$/.exec(path);
  if (contestMatch) {
    const contest = loadContest(ctx, Number(contestMatch[1]));
    const action = contestMatch[2];
    if (!action && get) return contestPage(ctx, contest);
    if (action === 'create') {
      requireRole(ctx, 'admin');
      return get ? page(ctx, '프로젝트 개설', views.projectForm(ctx, contest)) : projectCreate(ctx, contest);
    }
    if (action === 'invite' && !get) {
      requireRole(ctx, 'admin');
      const email = text(await form(ctx), 'email').trim().toLowerCase();
      expect(emailValid(email), '관리자1 이메일을 확인해 주세요.');
      const code = opaque();
      store.transaction(() => {
        const existing = store.get('SELECT role FROM users WHERE email=?', email);
        expect(!existing || existing.role === 'reviewer', '이 이메일은 이미 다른 권한의 계정에 연결되어 있습니다.');
        store.run('DELETE FROM invitations WHERE contest_id=? AND email=? AND used_by IS NULL', contest.id, email);
        store.run('INSERT INTO invitations(digest,contest_id,email,expires) VALUES (?,?,?,?)', hash(code), contest.id, email, Date.now() + 72 * HOUR);
        audit(store, contest.id, user.id, '관리자1 초대 생성', contest.id);
      });
      return contestPage(ctx, contest, code);
    }
    if (action?.startsWith('members/') && !get) {
      requireRole(ctx, 'admin', 'reviewer');
      const id = Number(action.split('/')[1]);
      const target = text(await form(ctx), 'suspended');
      expect(target === '0' || target === '1', '참여 상태를 선택해 주세요.');
      store.transaction(() => {
        const change = store.run(`UPDATE members SET suspended=? WHERE contest_id=? AND user_id=?
          AND user_id IN (SELECT id FROM users WHERE role='participant')`, Number(target), contest.id, id);
        if (change.changes !== 1) fail(404, '참가자를 찾을 수 없습니다.');
        audit(store, contest.id, user.id, target === '1' ? '참여 정지' : '참여 복구', id);
      });
      return redirect(res, '/c/' + contest.id);
    }
  }

  const projectMatch = /^\/p\/(\d+)(?:\/(.*))?$/.exec(path);
  if (projectMatch) {
    const { project, contest } = loadProject(ctx, Number(projectMatch[1]));
    const action = projectMatch[2] ?? '';
    if (!action && get) {
      const rows = standings(store, project);
      const participants = user.role === 'participant';
      const history = participants ? store.all(`SELECT id,started,status,score,error,decision FROM submissions
        WHERE project_id=? AND user_id=? ORDER BY started DESC LIMIT 100`, project.id, user.id) : [];
      const rounds = roundsFor(project.id, user.id);
      const pending = rows.filter(r => !r.decision).length;
      const final = reviewState(project.id).open && !pending;
      const count = participants ? 0 : store.get('SELECT count(*) AS n FROM submissions WHERE project_id=?', project.id).n;
      return page(ctx, project.title, views.projectPage(ctx, contest, project, rounds, rows, history, pending, final, count));
    }
    if (get && /^files\/(features|template|labels)$/.test(action)) {
      const kind = action.split('/')[1];
      if (kind === 'labels') {
        requireRole(ctx, 'reviewer', 'admin');
        const p = store.get('SELECT id_name,target_name,ids,actual FROM projects WHERE id=?', project.id);
        const actual = JSON.parse(p.actual);
        return download(res, 'labels.csv', encodeCsv([[p.id_name, p.target_name], ...JSON.parse(p.ids).map((id, i) => [id, String(actual[i])])]));
      }
      const row = store.get('SELECT features,template FROM projects WHERE id=?', project.id);
      return download(res, kind + '.csv', row[kind]);
    }
    const roundMatch = /^upload\/(\d+)$/.exec(action);
    if (!get && roundMatch) return upload(ctx, project, Number(roundMatch[1]));
    if (action === 'review' && get) {
      requireRole(ctx, 'reviewer', 'admin');
      const logs = store.all(`SELECT s.id,s.started,s.status,s.decision,u.name FROM submissions
        s JOIN users u ON u.id=s.user_id WHERE s.project_id=? ORDER BY s.started DESC LIMIT 100`, project.id);
      return page(ctx, '검토 대기열', views.reviewQueue(ctx, contest, project, standings(store, project), logs, reviewState(project.id)));
    }
    const subMatch = /^s\/([\w-]{24})(?:\/(propose|decide|compare|file\/(?:prediction|notebook|model)))?$/.exec(action);
    if (subMatch) {
      const record = store.get(`SELECT s.*,u.name,r.name AS reviewer_name,a.name AS approver_name FROM submissions s
        JOIN users u ON u.id=s.user_id LEFT JOIN users r ON r.id=s.reviewer_id LEFT JOIN users a ON a.id=s.approver_id
        WHERE s.project_id=? AND s.id=?`, project.id, subMatch[1]);
      if (!record || (user.role === 'participant' && record.user_id !== user.id)) fail(404, '제출 기록을 찾을 수 없습니다.');
      const operation = subMatch[2];
      if (!operation && get) {
        const files = store.all('SELECT kind,ext FROM artifacts WHERE submission_id=? ORDER BY rowid', record.id);
        const staff = user.role !== 'participant';
        const cells = staff && files.some(f => f.kind === 'notebook') ?
          inspectNotebook(store.get("SELECT payload FROM artifacts WHERE submission_id=? AND kind='notebook'", record.id).payload) : [];
        const duplicates = staff && record.digest ? store.get(`SELECT count(*) AS n FROM submissions
          WHERE project_id=? AND user_id<>? AND digest=? AND status='scored'`, project.id, record.user_id, record.digest).n : 0;
        const comparison = staff && record.status === 'scored' ? store.get(`SELECT c.*,u.name AS reviewer_name
          FROM review_comparisons c JOIN users u ON u.id=c.reviewer_id
          WHERE c.submission_id=? ORDER BY c.id DESC LIMIT 1`, record.id) : null;
        const allowed = candidateAccess(ctx, project, record);
        return page(ctx, '제출 상세', views.submission(ctx, contest, project, record, files, cells, duplicates, comparison, allowed));
      }
      if (operation?.startsWith('file/') && get) {
        const kind = operation.slice(5);
        const artifact = store.get('SELECT ext,payload FROM artifacts WHERE submission_id=? AND kind=?', record.id, kind);
        if (!artifact) fail(404, '파일을 찾을 수 없습니다.');
        return download(res, kind + artifact.ext, artifact.payload);
      }
      if (operation === 'compare' && !get) {
        requireRole(ctx, 'reviewer', 'admin');
        if (!candidateAccess(ctx, project, record).propose) fail(409, '현재 검토 대상에 판정을 제안하기 전까지만 대조할 수 있습니다.');
        const data = await formData(ctx, LIMITS.csv + 32 * 1024, true);
        sameCsrf(ctx, text(data, '_csrf'));
        const note = text(data, 'source_note').trim();
        expect(shape(note, 500), '재생성 파일을 만든 방법을 500자 이내로 입력해 주세요.');
        const regenerated = await file(data, 'regenerated', ['.csv'], LIMITS.csv, '재생성 CSV');
        store.transaction(() => {
          const current = store.get('SELECT * FROM submissions WHERE id=?', record.id);
          if (!candidateAccess(ctx, project, current).propose) fail(409, '검토 대상 또는 판정 상태가 바뀌었습니다.');
          const source = store.get("SELECT payload FROM artifacts WHERE submission_id=? AND kind='prediction'", record.id);
          if (!source) fail(409, '원본 예측 CSV를 찾을 수 없습니다.');
          const spec = store.get('SELECT id_name,target_name,metric,ids,classes FROM projects WHERE id=?', project.id);
          const compared = comparePredictions(source.payload, regenerated.bytes, spec);
          store.run(`INSERT INTO review_comparisons(submission_id,reviewer_id,created,source_note,digest,total,matched,differences)
            VALUES (?,?,?,?,?,?,?,?)`, record.id, user.id, Date.now(), note, compared.digest,
          compared.total, compared.matched, JSON.stringify(compared.differences));
          audit(store, contest.id, user.id, '예측 CSV 대조', record.id);
        });
        return redirect(res, '/p/' + project.id + '/s/' + record.id);
      }
      if (['propose', 'decide'].includes(operation) && !get) {
        requireRole(ctx, ...(operation === 'propose' ? ['reviewer', 'admin'] : ['admin']));
        const data = await form(ctx);
        const choice = text(data, 'choice');
        const note = text(data, 'note').trim();
        expect(shape(note, 1500), '판정 사유를 입력해 주세요.');
        store.transaction(() => {
          const current = store.get('SELECT * FROM submissions WHERE id=?', record.id);
          const allowed = candidateAccess(ctx, project, current);
          if (operation === 'propose') {
            if (!allowed.propose) fail(409, allowed.message || '이미 처리된 기록입니다.');
            expect(['pass', 'fail'].includes(choice), '적합 또는 부적합을 선택해 주세요.');
            store.run('UPDATE submissions SET proposal=?,reviewer_id=?,review_note=?,reviewed=? WHERE id=?',
              choice, user.id, note, Date.now(), record.id);
            audit(store, contest.id, user.id, choice === 'pass' ? '적합 제안' : '부적합 제안', record.id);
          } else {
            if (!allowed.approve) fail(409, allowed.message || '이미 처리된 기록입니다.');
            expect(['approve', 'return'].includes(choice), '승인 또는 재검토 요청을 선택해 주세요.');
            if (choice === 'approve') {
              store.run('UPDATE submissions SET decision=proposal,approver_id=?,decision_note=?,decided=? WHERE id=?',
                user.id, note, Date.now(), record.id);
              audit(store, contest.id, user.id, current.proposal === 'pass' ? '적합 승인' : '부적합 승인', record.id);
            } else {
              store.run('UPDATE submissions SET proposal=NULL,reviewer_id=NULL,review_note=NULL,reviewed=NULL,decision_note=? WHERE id=?', note, record.id);
              audit(store, contest.id, user.id, '재검토 요청', record.id);
            }
          }
        });
        return redirect(res, '/p/' + project.id + '/s/' + record.id);
      }
    }
  }
  fail(404, '요청한 페이지를 찾을 수 없습니다.');
}

export const server = createServer({ headersTimeout: 15000, requestTimeout: TIMEOUT, keepAliveTimeout: 5000 }, async (req, res) => {
  headers(res);
  const path = (req.url ?? '/').split('?', 1)[0];
  if (req.method === 'GET' && publicFiles.has(path)) {
    const [type, bytes] = publicFiles.get(path);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public,max-age=300' });
    return res.end(bytes);
  }
  let ctx;
  try {
    ctx = context(req, res);
    await handle(ctx, path);
  } catch (error) {
    if (res.destroyed || res.headersSent) return;
    const expected = error instanceof HttpError || error instanceof InputError;
    const message = expected ? error.message : '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
    const status = expected ? (error.status ?? 400) : 500;
    if (!expected) console.error('Request error', req.method, error.name, error.code ?? '');
    if (!req.complete) res.setHeader('Connection', 'close');
    if (/\/upload\/\d+$/.test(path)) return output(res, status, { message });
    if (!ctx) {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(message);
    }
    page(ctx, '요청 오류', views.errorBody(message, /^\/p\/\d+/.exec(path)?.[0] ?? '/'), status);
  }
});
server.requestTimeout = TIMEOUT;
server.setTimeout(TIMEOUT, socket => socket.destroy());
if (process.env.SCORELAB_TEST !== '1') {
server.listen(Number(process.env.PORT || 8080), bind, () => console.log(`ScoreLab http://${bind}:${server.address().port}`));
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of throttle) if (entry.until <= now) throttle.delete(ip);
  try {
    rejectStale(store, now);
    store.run('DELETE FROM sessions WHERE expires<=?', now);
    store.run('DELETE FROM invitations WHERE expires<=? AND used_by IS NULL', now);
  } catch (error) { console.error('Cleanup error', error.name); }
}, 60000).unref();
}
