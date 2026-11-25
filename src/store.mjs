import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
export const opaque = (size = 24) => randomBytes(size).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const filename = resolve(process.env.SCORELAB_DB || 'data/scorelab.sqlite');
const schema = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('participant','reviewer','admin'))
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  digest TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS contests (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, join_code TEXT NOT NULL UNIQUE, created INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS members (
  contest_id INTEGER NOT NULL REFERENCES contests(id), user_id INTEGER NOT NULL REFERENCES users(id),
  alias TEXT NOT NULL, suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN (0,1)),
  PRIMARY KEY(contest_id,user_id), UNIQUE(contest_id,alias)
) STRICT;
CREATE TABLE IF NOT EXISTS invitations (
  digest TEXT PRIMARY KEY, contest_id INTEGER NOT NULL REFERENCES contests(id),
  email TEXT NOT NULL, expires INTEGER NOT NULL, used_by INTEGER REFERENCES users(id)
) STRICT;
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, contest_id INTEGER NOT NULL REFERENCES contests(id),
  title TEXT NOT NULL, description TEXT NOT NULL, metric TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('high','low')), id_name TEXT NOT NULL,
  target_name TEXT NOT NULL, classes TEXT NOT NULL, ids TEXT NOT NULL, actual TEXT NOT NULL,
  features TEXT NOT NULL, template TEXT NOT NULL, created INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  cutoff INTEGER NOT NULL, quota INTEGER NOT NULL CHECK(quota BETWEEN 1 AND 100),
  UNIQUE(project_id, cutoff)
) STRICT;
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  round_id INTEGER NOT NULL REFERENCES rounds(id), user_id INTEGER NOT NULL REFERENCES users(id),
  started INTEGER NOT NULL, finished INTEGER, expires INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('uploading','failed','scored','late')),
  error TEXT, score REAL, digest TEXT, comment TEXT NOT NULL DEFAULT '',
  proposal TEXT CHECK(proposal IN ('pass','fail')), reviewer_id INTEGER REFERENCES users(id),
  review_note TEXT, reviewed INTEGER, decision TEXT CHECK(decision IN ('pass','fail')),
  approver_id INTEGER REFERENCES users(id), decision_note TEXT, decided INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS artifacts (
  submission_id TEXT NOT NULL REFERENCES submissions(id), kind TEXT NOT NULL,
  ext TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(submission_id,kind)
) STRICT;
CREATE TABLE IF NOT EXISTS review_comparisons (
  id INTEGER PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id),
  reviewer_id INTEGER NOT NULL REFERENCES users(id), created INTEGER NOT NULL,
  source_note TEXT NOT NULL, digest TEXT NOT NULL, total INTEGER NOT NULL,
  matched INTEGER NOT NULL CHECK(matched >= 0 AND matched <= total),
  differences TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS comparison_submission ON review_comparisons(submission_id,id DESC);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, contest_id INTEGER NOT NULL REFERENCES contests(id),
  actor_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL, target TEXT NOT NULL, happened INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS submission_round_user ON submissions(round_id,user_id,status);
CREATE INDEX IF NOT EXISTS submission_candidates ON submissions(project_id,status,decision,user_id);
CREATE INDEX IF NOT EXISTS submission_uploads ON submissions(project_id,user_id,status,expires);
CREATE INDEX IF NOT EXISTS submission_digest ON submissions(project_id,digest);
CREATE INDEX IF NOT EXISTS audit_contest ON audit(contest_id,id DESC);
CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
`;

export function connect(path = process.env.SCORELAB_DB || filename) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec(schema);
  return {
    db,
    get: (sql, ...args) => db.prepare(sql).get(...args),
    all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export async function passwordDigest(password) {
  const salt = opaque(16);
  const derived = await scryptAsync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return salt + ':' + derived.toString('hex');
}

export async function verifyPassword(password, digest) {
  const [salt, stored] = digest.split(':');
  const derived = await scryptAsync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(derived, Buffer.from(stored, 'hex'));
}

export function enroll(store, contestId, userId) {
  store.run('INSERT OR IGNORE INTO members(contest_id,user_id,alias) VALUES (?,?,?)',
    contestId, userId, '참가자 ' + randomBytes(5).toString('hex').toUpperCase());
}

export function audit(store, contestId, actorId, action, target) {
  store.run('INSERT INTO audit(contest_id,actor_id,action,target,happened) VALUES(?,?,?,?,?)',
    contestId, actorId, action, String(target), Date.now());
}

export function createProject(store, contestId, config, dataset, rounds, created = Date.now()) {
  const result = store.run(`INSERT INTO projects
    (contest_id,title,description,metric,direction,id_name,target_name,classes,ids,actual,features,template,created)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    contestId, config.title, config.description, config.metric, config.direction, config.idName, config.targetName,
    JSON.stringify(config.classes), JSON.stringify(dataset.ids), JSON.stringify(dataset.actual),
    dataset.features, dataset.template, created);
  const projectId = Number(result.lastInsertRowid);
  for (const round of rounds) {
    store.run('INSERT INTO rounds(project_id,cutoff,quota) VALUES(?,?,?)', projectId, round.cutoff, round.quota);
  }
  return projectId;
}

export function rejectStale(store, now) {
  store.run(`UPDATE submissions SET status='failed',error='업로드가 중단되었습니다. 다시 제출해 주세요.',finished=?
    WHERE status='uploading' AND expires <= ?`, now, now);
}

export function standings(store, project) {
  const direction = project.direction === 'high' ? 'DESC' : 'ASC';
  return store.all(`
    WITH ordered AS (
      SELECT s.id, s.user_id, u.name, m.alias, s.score, s.started, s.finished,
        s.proposal, s.decision, s.reviewer_id, s.review_note,
        ROW_NUMBER() OVER (
          PARTITION BY s.user_id
          ORDER BY CASE WHEN s.decision='pass' THEN 0 ELSE 1 END, s.score ${direction}, s.finished DESC, s.started DESC, s.id DESC
        ) AS position
      FROM submissions s
      JOIN projects p ON p.id=s.project_id
      JOIN members m ON m.contest_id=p.contest_id AND m.user_id=s.user_id
      JOIN users u ON u.id=s.user_id
      WHERE s.project_id=? AND s.status='scored' AND s.decision IS NOT 'fail'
    )
    SELECT *, RANK() OVER(ORDER BY score ${direction}) AS rank
    FROM ordered WHERE position=1 ORDER BY rank, finished DESC, id DESC`, project.id);
}
