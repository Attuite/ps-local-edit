const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const api = require('../plugin/api');
const {TaskQueue}=require('../plugin/task-queue');const {pngRGBA}=require('../plugin/png');

function harness({ switchDocument = false, submissionFails = false, jobs = [], snapshots = {} } = {}) {
  const nodes = {}, local = new Map(), calls = [], writes = [], requests = [];
  local.set('lk888-jobs',JSON.stringify(jobs));
  const document = { readyState: 'interactive', addEventListener() {}, getElementById(id) { return nodes[id] ||= { value: id === 'prompt' ? '改成红色' : id === 'model' ? 'banana-2' : '', textContent: '', selectedIndex: -1, hidden: false, style: {}, postMessage(message) { this.lastMessage=JSON.parse(message); }, addEventListener(event, fn) { this[event] = fn; } }; } };
  const originalDoc = { id: 12, name: 'sample.psd', width: 1000, height: 800, mode: 'RGB', selection: { bounds: {left:150,top:120,right:350,bottom:240} } };
  const app = { activeDocument: originalDoc };
  const bounds = { left: 120, top: 90, right: 420, bottom: 290, width: 300, height: 200 };
  const mask = { width: 300, height: 200, components: 1, imageData: new Uint8Array(60000) };
  const capture = { bounds, maskData: mask, context: { documentId: 12, documentName: 'sample.psd', originalBounds: { left: 150, top: 120, right: 350, bottom: 240 } }, imageData: { sourceBounds: bounds, imageData: { width: 300, height: 200, components:4,getData:async()=>new Uint8Array(300*200*4), dispose() {} } } };
  const ps = { captureSelection: async () => capture, placeBack: async (...args) => calls.push(args) };
  const dataFiles=new Map(Object.entries(snapshots));const folder={createFile:async name=>({write:async value=>dataFiles.set(name,value)}),getEntry:async name=>({read:async()=>dataFiles.get(name)})};
  const storage = { formats: { binary: 'binary' }, secureStorage: { getItem: async () => new Uint8Array(Buffer.from('test-key')) }, localFileSystem: { getDataFolder:async()=>folder,getTemporaryFolder: async () => ({ createFile: async () => ({ write: async value => writes.push(value) }) }), createSessionToken: () => 'session-token' } };
  const fetch = async (url, options) => {
    if (url.endsWith('/generate')) { requests.push(JSON.parse(options.body)); if (submissionFails) throw new Error('connection lost'); return { ok: true, json: async () => ({ task_id: requests.length===1?'existing-task':'task-'+requests.length }) }; }
    if (switchDocument) app.activeDocument = { ...originalDoc, id: 99 };
    return { ok: true, json: async () => ({ is_final: true, state: 'success', result_url: 'data:image/png;base64,YWJj' }) };
  };
  class Client extends api.MediaClient { constructor(key) { super(key, fetch); } }
  const context = { document, localStorage: { getItem: k => local.get(k) || null, setItem: (k, v) => local.set(k, v), removeItem: k => local.delete(k) }, setTimeout, clearTimeout, Uint8Array, console, fetch, require(name) {
    if (name === 'photoshop') return { app, imaging: { encodeImageData: async () => 'YWJj' }, constants: { DocumentMode: { RGB: 'RGB' } } };
    if (name === 'uxp') return { storage };
    if (name === './modules/ps') return ps;
    if(name==='./task-queue')return require('../plugin/task-queue');if(name==='./png')return {pngRGBA};
    if (name === './modules/fs') return { arrayBufferToBase64:v=>Buffer.from(v).toString('base64'), base64ToArrayBuffer: v => Uint8Array.from(Buffer.from(v, 'base64')).buffer };
    if (name === './api') return { ...api, MediaClient: Client };
    throw new Error(name);
  } };
  vm.runInNewContext(fs.readFileSync('plugin/main.js', 'utf8'), context);
  // init loads saved prompt; restore the user's entry for this run.
  nodes.prompt ||= document.getElementById('prompt');nodes.prompt.value = '改成红色';
  document.getElementById('quality'); document.getElementById('output-size');
  return { nodes, calls, writes, local, capture, requests, ready:async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));if(!jobs.length)nodes.prompt.value='改成红色';} };
}


test('selection uses lossless PNG and does not submit a task',async()=>{const h=harness();await h.ready();await h.nodes['capture-selection'].click();assert.match(h.nodes.preview.src,/^data:image\/png/);assert.equal(h.requests.length,0);});
test('generation releases editor and never auto imports results',async()=>{const h=harness();await h.ready();await h.nodes.generate.click();await h.ready();assert.equal(h.requests.length,1);assert.equal(h.calls.length,0);assert.equal(h.nodes.generate.disabled,false);assert.ok(JSON.parse(h.local.get('lk888-jobs'))[0].tasks[0].results.length);});
test('another region can submit while previous task remains in history',async()=>{const h=harness();await h.ready();await h.nodes.generate.click();await h.ready();await h.nodes['capture-selection'].click();h.nodes.prompt.value='修改另一区域';await h.nodes.generate.click();await h.ready();assert.equal(h.requests.length,2);assert.equal(JSON.parse(h.local.get('lk888-jobs')).length,2);assert.equal(h.calls.length,0);});
test('model quality aspect and four tasks are preserved',async()=>{const h=harness();await h.ready();h.nodes.count.value='4';h.nodes.quality.value='2K';h.nodes['output-size'].value='16:9';await h.nodes.generate.click();await h.ready();assert.equal(h.requests.length,4);assert.equal(h.requests[0].params.image_size,'2K');assert.equal(h.requests[0].params.aspect_ratio,'16:9');assert.equal(h.calls.length,0);});

test('completed candidate can be added repeatedly into its original bounds',async()=>{const h=harness();await h.ready();await h.nodes.generate.click();await h.ready();const record=JSON.parse(h.local.get('lk888-jobs'))[0],message={type:'import',jobId:record.id,taskId:record.tasks[0].id,index:0};h.nodes['task-webview'].message({data:JSON.stringify(message)});await h.ready();assert.equal(h.calls.length,1);assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0][2])),h.capture.bounds);h.nodes['task-webview'].message({data:JSON.stringify(message)});await h.ready();assert.equal(h.calls.length,2);assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1][2])),h.capture.bounds);assert.equal(h.requests.length,1);});
test('candidate cannot be inserted into a different Photoshop document',async()=>{const h=harness({switchDocument:true});await h.ready();await h.nodes.generate.click();await h.ready();const record=JSON.parse(h.local.get('lk888-jobs'))[0];h.nodes['task-webview'].message({data:JSON.stringify({type:'import',jobId:record.id,taskId:record.tasks[0].id,index:0})});await h.ready();assert.equal(h.calls.length,0);assert.match(h.nodes.status.textContent,/原文档/);});

test('history restores prompt and generation options in the same editor',async()=>{const h=harness();await h.ready();h.nodes.quality.value='2K';h.nodes['output-size'].value='3:4';await h.nodes.generate.click();await h.ready();const record=JSON.parse(h.local.get('lk888-jobs'))[0];await h.nodes['tab-edit'].click();assert.equal(h.nodes.prompt.value,'');h.nodes['task-webview'].message({data:JSON.stringify({type:'openJob',jobId:record.id})});await h.ready();assert.equal(h.nodes.prompt.value,'改成红色');assert.equal(h.nodes.quality.value,'2K');assert.equal(h.nodes['output-size'].value,'3:4');assert.equal(h.nodes.editor.style.display,'block');assert.equal(h.nodes['panel-title'].textContent,'局部改图 1');});
test('deleting history removes only the chosen local record',async()=>{const h=harness();await h.ready();await h.nodes.generate.click();await h.ready();const record=JSON.parse(h.local.get('lk888-jobs'))[0];h.nodes['task-webview'].message({data:JSON.stringify({type:'deleteJob',jobId:record.id})});await h.ready();assert.equal(JSON.parse(h.local.get('lk888-jobs')).length,0);assert.equal(h.requests.length,1);assert.equal(h.calls.length,0);});


test('history selector restores by record ID and saves the previous editor',async()=>{
 const h=harness();await h.ready();await h.nodes['tab-edit'].click();
 h.nodes.prompt.value='第一条修改';h.nodes.quality.value='2K';h.nodes['output-size'].value='3:4';
 const first=JSON.parse(h.local.get('lk888-jobs'))[0];
 await new Promise(resolve=>setTimeout(resolve,2));
 await h.nodes['tab-edit'].click();h.nodes.prompt.value='第二条修改';
 const current=JSON.parse(h.local.get('lk888-jobs'))[0];
 await h.nodes['history-webview'].message({data:JSON.stringify({type:'historySelect',jobId:first.id})});
 assert.equal(h.nodes['history-webview'].lastMessage.selectedJobId,first.id);
 assert.equal(h.nodes['history-webview'].lastMessage.busy,false);
 assert.equal(h.nodes['task-webview'].lastMessage.selectedJobId,first.id);
 assert.equal(h.nodes['input-webview'].lastMessage.prompt,'第一条修改');
 assert.equal(h.nodes.prompt.value,'第一条修改');assert.equal(h.nodes.quality.value,'2K');assert.equal(h.nodes['output-size'].value,'3:4');
 const jobs=JSON.parse(h.local.get('lk888-jobs'));
 assert.equal(jobs.length,2);assert.equal(jobs[0].prompt,'第二条修改');
 assert.equal(h.requests.length,0);assert.equal(h.calls.length,0);
});

test('switching 35 to 34 to 33 and back restores each title, image, prompt, options and results',async()=>{
 const jobs=[35,34,33].map(number=>({id:'fixture-'+number,captureRef:'fixture-'+number,title:'局部改图 '+number,number,prompt:'修改 '+number,model:'banana-2',quality:number===35?'auto':'2K',ratio:number===35?'original':'3:4',count:number===33?2:1,state:'ready',tasks:[{id:'task-'+number,state:'ready',results:[{source:'result-'+number}]}]}));
 const snapshots={};
 for(const job of jobs){snapshots[job.captureRef+'.json']=JSON.stringify({bounds:{width:job.number,height:10},context:{documentId:12},sourceImage:'source-'+job.number,references:[{name:'ref-'+job.number,data:'ref-image-'+job.number}],mask:{width:1,height:1}});snapshots[job.captureRef+'.bin']=new Uint8Array([255]).buffer;}
 const h=harness({jobs,snapshots});await h.ready();
 for(const number of [34,33,35,34]){
  await h.nodes['history-webview'].message({data:{type:'historySelect',jobId:'fixture-'+number}});
  const record=jobs.find(job=>job.number===number),input=h.nodes['input-webview'].lastMessage,results=h.nodes['task-webview'].lastMessage;
  assert.equal(h.nodes['history-webview'].lastMessage.selectedJobId,record.id);
  assert.equal(h.nodes['panel-title'].textContent,record.title);
  assert.equal(h.nodes.prompt.value,record.prompt);assert.equal(input.prompt,record.prompt);
  assert.equal(input.source.data,'source-'+number);assert.equal(input.references[0].name,'ref-'+number);
  assert.equal(h.nodes.quality.value,record.quality);assert.equal(h.nodes['output-size'].value,record.ratio);assert.equal(h.nodes.count.value,String(record.count));
  assert.equal(results.selectedJobId,record.id);assert.equal(results.jobs.find(job=>job.id===results.selectedJobId).tasks[0].results[0].source,'result-'+number);
 }
 assert.equal(h.requests.length,0);assert.equal(h.calls.length,0);
});

test('history ignores unknown IDs, malformed messages and other webviews',async()=>{
 const h=harness();await h.ready();await h.nodes['tab-edit'].click();const selected=h.nodes['history-webview'].lastMessage.selectedJobId;
 for(const event of [{data:'{'},{data:null},{data:{type:'historySelect',jobId:'missing'}},{source:h.nodes['input-webview'],data:{type:'historySelect',jobId:'missing'}}])await h.nodes['history-webview'].message(event);
 assert.equal(h.nodes['history-webview'].lastMessage.selectedJobId,selected);
 assert.equal(h.nodes['history-webview'].lastMessage.busy,false);
 assert.equal(h.requests.length,0);
});

test('old history without an input snapshot still restores prompt and selected results',async()=>{
 const record={id:'old-record',title:'局部改图 1',number:1,captureRef:'missing',prompt:'旧提示词',model:'banana-2',state:'ready',tasks:[{id:'old-task',state:'ready',results:[{source:'old-result'}]}]};
 const h=harness({jobs:[record]});await h.ready();await h.nodes['tab-edit'].click();
 await h.nodes['history-webview'].message({data:{type:'historySelect',jobId:record.id}});
 assert.equal(h.nodes.prompt.value,record.prompt);assert.equal(h.nodes['input-webview'].lastMessage.source,null);
 assert.equal(h.nodes['task-webview'].lastMessage.selectedJobId,record.id);
 assert.match(h.nodes.status.textContent,/提示词和结果已恢复/);
 assert.equal(h.requests.length,0);
});
