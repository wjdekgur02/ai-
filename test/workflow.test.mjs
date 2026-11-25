import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { seed, demoFiles } from '../src/demo.mjs';
import { connect, hash, opaque, standings } from '../src/store.mjs';
import { score } from '../src/evaluate.mjs';
process.env.SCORELAB_TEST = '1';
process.env.SCORELAB_DB = join(mkdtempSync(join(tmpdir(),'scorelab-test-')),'demo.sqlite');
await seed(process.env.SCORELAB_DB);
const {server} = await import('../src/server.mjs');
const db=connect(process.env.SCORELAB_DB);
const csrf=opaque();
async function dispatch(role,path,data,upload=false) {
  const key=opaque();
  db.run('INSERT INTO sessions VALUES(?,?,?)',hash(key),role,Date.now()+60000);
  const wire=new Response(data);
  const bytes=Buffer.from(await wire.arrayBuffer());
  const req=Readable.from([bytes]);
  Object.assign(req,{method:data?'POST':'GET',url:path,headers:{cookie:'sl_session='+key+'; sl_csrf='+csrf,
    'x-csrf-token':csrf,'content-type':wire.headers.get('content-type')}});
  return await new Promise(resolve=>{
    const res={setHeader(){},appendHeader(){},writeHead(status,headers){this.status=status;this.headers=headers;},
      end(content){resolve({status:this.status,content:String(content??''),headers:this.headers});}};
    server.emit('request',req,res);
  });
}
test('upload, score, anonymous standings, invalid upload, late archive and two-person decision',async()=>{
  const parts=demoFiles();
  const upload=new FormData();
  for(const [key,ext] of Object.entries({prediction:'csv',notebook:'ipynb',model:'safetensors'}))
    upload.set(key,new Blob([parts[key]]),key+'.'+ext);
  const post=await dispatch(3,'/p/2/upload/2',upload,true);
  assert.equal(post.status,201,post.content);
  const record=JSON.parse(post.content).url;
  assert.match((await dispatch(3,record)).content,/0.8333333333/);
  assert.equal((await dispatch(3,'/p/2/files/labels')).status,403);
  assert.doesNotMatch((await dispatch(3,'/p/2')).content,/김지원/);
  assert.equal((await dispatch(3,'/p/1/upload/1',upload)).status,201);
  assert.equal(db.get("SELECT score FROM submissions WHERE status='late'").score,null);
  upload.delete('model');
  assert.equal((await dispatch(3,'/p/2/upload/2',upload)).status,400);
  assert.equal(db.get("SELECT count(*) n FROM submissions WHERE user_id=3 AND round_id=2 AND status='scored'").n,1);
  const project=db.get('SELECT * FROM projects WHERE id=1');
  const first=standings(db,project)[0];
  const path='/p/1/s/'+first.id;
  const original = db.get("SELECT payload FROM artifacts WHERE submission_id=? AND kind='prediction'", first.id);
  const [header, ...rows] = Buffer.from(original.payload).toString('utf8').trim().split(/\r?\n/);
  const csv = content => {
    const data = new FormData();
    data.set('_csrf', csrf);
    data.set('source_note', '모델에서 재생성한 예측');
    data.set('regenerated', new Blob([content]), 'regenerated.csv');
    return data;
  };
  const reordered = [header, ...rows.slice().reverse()].join('\n');
  assert.equal((await dispatch(first.user_id, path+'/compare', csv(reordered))).status, 403);
  assert.equal((await dispatch(2, path+'/compare', csv([header, ...rows.slice(1)].join('\n')))).status, 400);
  assert.equal((await dispatch(2, path+'/compare', csv(reordered))).status, 303);
  assert.match((await dispatch(2, path)).content, new RegExp(rows.length + ' / ' + rows.length + '건 일치'));

  const [changedId, oldLabel] = rows[0].split(',');
  const changed = [header, changedId+','+(oldLabel==='normal' ? 'fault' : 'normal'), ...rows.slice(1)].join('\n');
  assert.equal((await dispatch(2, path+'/compare', csv(changed))).status, 303);
  const approvalView = await dispatch(1, path);
  assert.match(approvalView.content, new RegExp((rows.length-1) + ' / ' + rows.length + '건 일치'));
  assert.match(approvalView.content, new RegExp('ID 예시 ' + changedId));
  assert.doesNotMatch((await dispatch(first.user_id, path)).content, /재생성 CSV 대조/);
  const comparisons = db.all('SELECT matched FROM review_comparisons WHERE submission_id=? ORDER BY id', first.id);
  assert.deepEqual(comparisons.map(row => row.matched), [rows.length, rows.length-1]);
  assert.equal(db.get('SELECT score FROM submissions WHERE id=?', first.id).score, first.score);
  const decision=choice=>new URLSearchParams({_csrf:csrf,choice,note:'시연 검토 기록'});
  assert.equal((await dispatch(2,path+'/propose',decision('fail'))).status,303);
  assert.equal((await dispatch(2, path+'/compare', csv(reordered))).status, 409);
  assert.equal(standings(db,project)[0].id,first.id);
  assert.equal((await dispatch(1,path+'/decide',decision('approve'))).status,303);
  assert.equal(standings(db,project)[0].score,0.8333333333);
  for(const r of standings(db,project)){
    const base='/p/1/s/'+r.id;
    assert.equal((await dispatch(2,base+'/propose',decision('pass'))).status,303);
    assert.equal((await dispatch(1,base+'/decide',decision('approve'))).status,303);
  }
  assert.match((await dispatch(3,'/p/1')).content,/최종 성적/);
});
test('metric arithmetic',()=>{
  assert.equal(score('mae',[1,4],[1,2],[]),1);
  assert.equal(score('rmse',[1,4],[1,2],[]),Number(Math.sqrt(2).toPrecision(10)));
  assert.equal(score('macro_f1',['a','b'],['a','a'],['a','b']),0.3333333333);
});
