import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProject, connect, enroll, opaque, passwordDigest } from './store.mjs';
import { dataset, encodeCsv, evaluate, score } from './evaluate.mjs';

const DAY = 86400000;
export const demoPassword = 'ScoreLab-demo-2026!';
export const demoCode = 'SCORELAB-DEMO';
export const addresses = {
  admin: ['admin@scorelab.test', '운영 관리자', 'admin'],
  reviewer: ['reviewer@scorelab.test', '검토 관리자', 'reviewer'],
  da: ['dahyeok@scorelab.test', '정다혁', 'participant'],
  ji: ['jiwon@scorelab.test', '김지원', 'participant'],
};
const cases = [
  ['M01', '1.10', '54', '2.1', 'normal'],
  ['M02', '2.35', '77', '3.5', 'fault'],
  ['M03', '1.55', '59', '2.5', 'normal'],
  ['M04', '2.62', '86', '4.1', 'fault'],
  ['M05', '1.80', '83', '3.9', 'fault'],
  ['M06', '2.12', '75', '3.3', 'fault'],
  ['M07', '1.32', '55', '2.0', 'normal'],
  ['M08', '2.25', '67', '2.9', 'normal'],
  ['M09', '2.80', '89', '4.3', 'fault'],
  ['M10', '1.70', '63', '2.6', 'normal'],
  ['M11', '2.42', '81', '3.8', 'fault'],
  ['M12', '1.43', '57', '2.2', 'normal'],
];
const config = { title: '모터 이상 분류', description: '모터의 진동, 온도, 전류 특성으로 정상(normal)과 이상(fault)을 분류합니다.',
  metric: 'accuracy', direction: 'high', idName: 'id', targetName: 'label', classes: ['normal', 'fault'] };
export const labeled = encodeCsv([['id', 'vibration_rms', 'temperature_c', 'current_a', 'label'], ...cases]);
export const predictionData = (threshold, temp = 1000) => encodeCsv([['id', 'label'],
  ...cases.map(r => [r[0], Number(r[1]) >= threshold || Number(r[2]) >= temp ? 'fault' : 'normal'])]);

export function demoFiles(threshold = 2, temp = 1000) {
  const spec = JSON.stringify({ thresholds: { dtype: 'F32', shape: [2], data_offsets: [0, 8] } });
  const padded = spec.padEnd(Math.ceil(spec.length / 8) * 8, ' ');
  const header = Buffer.alloc(8);
  header.writeBigUInt64LE(BigInt(padded.length));
  const weights = Buffer.alloc(8);
  weights.writeFloatLE(threshold, 0);
  weights.writeFloatLE(temp, 4);
  const model = Buffer.concat([header, Buffer.from(padded), weights]);
  const source = [
    'import csv, struct\n',
    'from pathlib import Path\n',
    '\n',
    '# Read the two F32 thresholds from our safetensors export.\n',
    'raw = Path("model.safetensors").read_bytes()\n',
    'header_len, = struct.unpack_from("<Q", raw)\n',
    'vibration_cutoff, temperature_cutoff = struct.unpack_from("<ff", raw, 8 + header_len)\n',
    'count = 0\n',
    'with open("features.csv", newline="", encoding="utf-8") as inputs, \\\n',
    '     open("prediction.csv", "w", newline="", encoding="utf-8") as out:\n',
    '    writer = csv.DictWriter(out, fieldnames=["id", "label"])\n',
    '    writer.writeheader()\n',
    '    for row in csv.DictReader(inputs):\n',
    '        fault = (float(row["vibration_rms"]) >= vibration_cutoff or\n',
    '                 float(row["temperature_c"]) >= temperature_cutoff)\n',
    '        writer.writerow({"id": row["id"], "label": "fault" if fault else "normal"})\n',
    '        count += 1\n',
    'print(f"Generated prediction.csv with {count} rows")\n',
  ];
  const notebook = Buffer.from(JSON.stringify({
    nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      { id: 'approach', cell_type: 'markdown', metadata: {}, source: ['# 모터 이상 분류\n', '진동과 온도에 임곗값을 적용하는 기준 모델입니다.'] },
      { id: 'inference', cell_type: 'code', metadata: {}, execution_count: 1, source,
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['Generated prediction.csv with 12 rows\n'] }] },
    ],
  }, null, 2));
  return { prediction: Buffer.from(predictionData(threshold, temp)), notebook, model };
}

export async function seed(path, examples) {
  const store = connect(path);
  const parsed = dataset(Buffer.from(labeled), config.idName, config.targetName, config.metric, config.classes);
  const allowed = store.get('SELECT id FROM contests WHERE join_code=?', demoCode);
  if (!allowed) {
    if (store.get('SELECT id FROM users LIMIT 1')) throw new Error('데모는 비어 있는 별도 데이터베이스가 필요합니다.');
    const now = Date.now();
    const pwd = await passwordDigest(demoPassword);
    store.transaction(() => {
      const uid = {};
      for (const [key, [email, name, role]] of Object.entries(addresses)) {
        uid[key] = Number(store.run('INSERT INTO users(email,name,password,role) VALUES(?,?,?,?)', email, name, pwd, role).lastInsertRowid);
      }
      const contest = Number(store.run('INSERT INTO contests(title,join_code,created) VALUES(?,?,?)',
        'AI 모델 성능평가 데모 대회', demoCode, now - 3 * DAY).lastInsertRowid);
      for (const user of [uid.reviewer, uid.da, uid.ji]) enroll(store, contest, user);
      const completed = createProject(store, contest, { ...config, title: '모터 이상 분류 · 검토 연습' }, parsed,
        [{ cutoff: now - DAY, quota: 3 }], now - 3 * DAY);
      const current = createProject(store, contest, config, parsed,
        [{ cutoff: now + 7 * DAY, quota: 3 }, { cutoff: now + 14 * DAY, quota: 2 }], now - DAY);
      const fixtures = [
        [completed, uid.da, 2, 1000, -2 * DAY],
        [completed, uid.da, 2, 80, -2 * DAY + 5000],
        [completed, uid.ji, 2.25, 1000, -2 * DAY + 15000],
        [current, uid.ji, 2.25, 1000, -3600000],
      ];
      for (const [projectId, user, threshold, temperature, offset] of fixtures) {
        const parts = demoFiles(threshold, temperature);
        const project = store.get('SELECT * FROM projects WHERE id=?', projectId);
        const result = evaluate(parts.prediction, project);
        const rating = score(project.metric, result.values, parsed.actual, config.classes);
        const round = store.get('SELECT id FROM rounds WHERE project_id=? ORDER BY cutoff LIMIT 1', projectId);
        const id = opaque(18);
        const start = now + offset;
        store.run(`INSERT INTO submissions(id,project_id,round_id,user_id,started,finished,expires,status,score,digest,comment)
          VALUES(?,?,?,?,?,?,?,'scored',?,?,?)`, id, projectId, round.id, user, start, start + 1500, start + 120000,
          rating, result.digest, '시연용으로 생성한 제출입니다.');
        for (const [kind, ext] of Object.entries({ prediction: '.csv', notebook: '.ipynb', model: '.safetensors' })) {
          store.run('INSERT INTO artifacts(submission_id,kind,ext,payload) VALUES(?,?,?,?)', id, kind, ext, parts[kind]);
        }
      }
    });
  }
  if (examples) {
    mkdirSync(examples, { recursive: true });
    const sample = demoFiles();
    for (const [name, data] of Object.entries({ 'features.csv': parsed.features, 'prediction_template.csv': parsed.template,
      'labeled_admin.csv': labeled, 'prediction.csv': sample.prediction, 'notebook.ipynb': sample.notebook, 'model.safetensors': sample.model })) {
      writeFileSync(join(examples, name), data);
    }
  }
  store.db.close();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  if (process.env.SCORELAB_SECURE === '1' || !['127.0.0.1', '::1', 'localhost'].includes(process.env.SCORELAB_HOST || '127.0.0.1')) {
    throw new Error('공개 계정이 포함된 데모는 로컬에서만 실행할 수 있습니다.');
  }
  const path = resolve(process.env.SCORELAB_DB || '.demo-data/scorelab.sqlite');
  const examples = join(resolve(path, '..'), 'samples');
  process.env.SCORELAB_DB = path;
  await seed(path, examples);
  console.log('시연 자료:', examples);
  console.log('참가자 dahyeok@scorelab.test | 관리자1 reviewer@scorelab.test | 관리자2 admin@scorelab.test');
  console.log('공통 데모 비밀번호:', demoPassword);
  if (!process.argv.includes('--seed-only')) await import('./server.mjs');
}
