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
  const decision=choice=>new URLSearchParams({_csrf:csrf,choice,note:'시연 검토 기록'});
  assert.equal((await dispatch(2,path+'/propose',decision('fail'))).status,303);
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
