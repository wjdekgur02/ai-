import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataset, evaluate, inspectModel, inspectNotebook, score } from './evaluate.mjs';
import { connect, createProject, enroll, opaque, passwordDigest } from './store.mjs';

process.umask(0o077);
if (process.env.SCORELAB_SECURE === '1' || !['127.0.0.1','localhost','::1'].includes(process.env.SCORELAB_HOST || '127.0.0.1')) {
  throw new Error('데모 계정은 로컬 환경에서만 사용할 수 있습니다.');
}
const input = resolve(process.argv.slice(2).find(arg => arg !== '--seed-only') || 'gta6_dataset.csv');
if (!existsSync(input)) throw new Error('npm run demo -- "/path/to/gta6_dataset.csv" 형식으로 Kaggle CSV를 지정하세요.');
const dir = resolve('.demo-data/gta6');
const samples = join(dir, 'samples');
const script = fileURLToPath(new URL('../examples/gta6/prepare.py', import.meta.url));
const report = JSON.parse((await promisify(execFile)('python3', [script, input, samples], { encoding:'utf8' })).stdout);
const config = {title:'GTA VI 장면 유형 분류', description:'등장인물·차량·물체 주석으로 10개 장면 유형을 예측합니다.',
  metric:'accuracy',direction:'high',idName:'frame_id',targetName:'scene_type',classes:report.classes};
const parsed = dataset(readFileSync(join(dir,'labeled_admin.csv')),config.idName,config.targetName,config.metric,config.classes);
const parts = { prediction: readFileSync(join(samples,'prediction.csv')), notebook: readFileSync(join(samples,'notebook.ipynb')),
  model: readFileSync(join(samples,'model.safetensors')) };
inspectNotebook(parts.notebook);
inspectModel(parts.model,'.safetensors');
const result = evaluate(parts.prediction,{id_name:config.idName,target_name:config.targetName,metric:config.metric,
  ids:JSON.stringify(parsed.ids),classes:JSON.stringify(config.classes)});
const rating = score(config.metric,result.values,parsed.actual,config.classes);
if (rating !== Number((report.correct/report.test).toPrecision(10))) throw new Error('Notebook 및 공식 점수가 일치하지 않습니다.');
process.env.SCORELAB_DB = join(dir,'competition.sqlite');
const store = connect(process.env.SCORELAB_DB);
const old = store.get('SELECT ids,actual,features FROM projects ORDER BY id LIMIT 1');
if (old && (old.ids !== JSON.stringify(parsed.ids) || old.actual !== JSON.stringify(parsed.actual) || old.features !== parsed.features)) {
  throw new Error('기존 데모와 입력 데이터가 다릅니다. .demo-data/gta6 폴더를 백업 후 새로 시작하세요.');
}
if (!old) {
  const password = await passwordDigest('ScoreLab-demo-2026!');
  const day = 86400000;
  const now = Date.now();
  store.transaction(() => {
    const contest = Number(store.run('INSERT INTO contests(title,join_code,created) VALUES(?,?,?)','Kaggle 장면 분류 경진대회','SCORELAB-DEMO',now-3*day).lastInsertRowid);
    let author;
    for (const [email,name,role] of [['admin','운영 관리자','admin'],['reviewer','검토 관리자','reviewer'],['dahyeok','정다혁','participant'],['jiwon','김지원','participant']]) {
      const id = Number(store.run('INSERT INTO users(email,name,password,role) VALUES(?,?,?,?)',email+'@scorelab.test',name,password,role).lastInsertRowid);
      if(role !== 'admin') enroll(store,contest,id);
      if(email === 'jiwon') author = id;
    }
    createProject(store,contest,config,parsed,[{cutoff:now+7*day,quota:3},{cutoff:now+14*day,quota:2}]);
    const closed = createProject(store,contest,{...config,title:config.title+' · 검토 연습'},parsed,[{cutoff:now-day,quota:3}],now-3*day);
    const round = store.get('SELECT id FROM rounds WHERE project_id=?',closed).id;
    const id=opaque(18);
    store.run("INSERT INTO submissions(id,project_id,round_id,user_id,started,finished,expires,status,score,digest,comment) VALUES(?,?,?,?,?,?,?,'scored',?,?,?)",
      id,closed,round,author,now-2*day,now-2*day+1000,now-2*day+120000,rating,result.digest,'Kaggle 프레임 주석 기반 학습 예시');
    for(const [kind,ext] of Object.entries({prediction:'.csv',notebook:'.ipynb',model:'.safetensors'}))
      store.run('INSERT INTO artifacts(submission_id,kind,ext,payload) VALUES(?,?,?,?)',id,kind,ext,parts[kind]);
  });
}
store.db.close();
console.log('학습', report.train, '평가', report.test, '정답', report.correct, 'ScoreLab Accuracy',rating);
console.log('제출 파일:',samples);
if(!process.argv.includes('--seed-only')) await import('./server.mjs');
