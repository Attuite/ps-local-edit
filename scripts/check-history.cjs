// Browser integration check with synthetic records; never contacts an image API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');
const {pngRGBA} = require('../plugin/png');
const root = path.resolve(__dirname, '..');
const sources = Object.fromEntries(['api','task-queue','png','upload-image','main'].map(name=>[name,fs.readFileSync(path.join(root,'plugin',name+'.js'),'utf8')]));
const jobs = [35,34,33].map(number=>({id:'fixture-'+number,captureRef:'fixture-'+number,title:'局部改图 '+number,number,prompt:'测试记录 '+number,model:'banana-2',quality:number===35?'auto':'2K',ratio:number===35?'original':'3:4',count:1,state:'ready',tasks:[]}));
const snapshots = {};
for(const job of jobs){
 const source='data:image/png;base64,'+Buffer.from(pngRGBA(1,1,new Uint8Array([job.number*7,30,150,255]),4)).toString('base64');
 job.tasks=[{id:'task-'+job.number,state:'ready',results:[{source}]}];
 snapshots[job.captureRef+'.json']=JSON.stringify({bounds:{left:0,top:0,right:1,bottom:1,width:1,height:1},context:{documentId:-1,documentName:'test'},documentWidth:1,documentHeight:1,sourceImage:source,references:[{name:'参考图 '+job.number,data:source}],mask:{width:1,height:1,components:1}});
}
let html=fs.readFileSync(path.join(root,'plugin/index.html'),'utf8').replace('<script src="main.js"></script>','');
const tags={'sp-dropdown':'select','sp-menu':'optgroup','sp-menu-item':'option','sp-action-button':'button','sp-button':'button','sp-checkbox':'button','webview':'iframe'};
html=html.replace(/<(\/?)(sp-dropdown|sp-menu-item|sp-menu|sp-action-button|sp-button|sp-checkbox|webview)(?=[\s>])/g,(_,slash,tag)=>'<'+slash+tags[tag]).replaceAll('plugin:/','/');
html=html.replace('</head>','<style>iframe{border:0}button,select{background:#353535;color:white;border:1px solid #666;border-radius:4px;padding:6px}#history-webview{flex-basis:0}</style></head>');
const server=http.createServer((request,response)=>{
 const url=new URL(request.url,'http://localhost');
 if(url.pathname==='/fixture'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end(html);return;}
 const name=url.pathname.slice(1);
 if(!['history.html','inputs.html','tasks.html','panel.css','upload-image.js'].includes(name)){response.writeHead(404);response.end();return;}
 response.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html; charset=utf-8');response.end(fs.readFileSync(path.join(root,'plugin',name)));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage({viewport:{width:340,height:850}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{if(window!==window.top)window.uxpHost={postMessage:data=>window.parent.postMessage(data,'*')};});
  await page.goto('http://127.0.0.1:'+server.address().port+'/fixture');
  await page.evaluate(({sources,jobs,snapshots})=>{
   const create=document.createElement.bind(document);
   document.createElement=(name,...args)=>create({'sp-menu':'optgroup','sp-menu-item':'option'}[name]||name,...args);
   const views=Array.from(document.querySelectorAll('iframe'));
   for(const view of views)view.postMessage=data=>view.contentWindow.postMessage(data,'*');
   const listen=window.addEventListener.bind(window);
   window.addEventListener=(type,handler,...args)=>listen(type,type==='message'?event=>handler({data:event.data,source:views.find(view=>view.contentWindow===event.source)||event.source}):handler,...args);
   const dataFiles=new Map(Object.entries(snapshots));
   for(const job of jobs)dataFiles.set(job.captureRef+'.bin',new Uint8Array([255]).buffer);
   const folder={getEntry:async name=>{if(!dataFiles.has(name))throw Error('missing fixture');return {read:async()=>dataFiles.get(name)};},createFile:async name=>({write:async value=>dataFiles.set(name,value)})};
   const cache={photoshop:{app:{activeDocument:null}},uxp:{storage:{formats:{binary:'binary'},localFileSystem:{getDataFolder:async()=>folder},secureStorage:{getItem:async()=>{throw Error('Test must not read keys');}}}},'./modules/ps':{},'./modules/fs':{}};
   function load(name){if(cache[name])return cache[name];const key=name.replace('./','');if(!sources[key])throw Error('Unexpected module '+name);const module={exports:{}};new Function('require','module','exports',sources[key])(load,module,module.exports);return cache[name]=module.exports;}
   window.fetch=()=>{throw Error('Test must not contact APIs');};
   localStorage.clear();localStorage.setItem('lk888-jobs',JSON.stringify(jobs));
   new Function('require',sources.main)(load);
  },{sources,jobs,snapshots});
  const history=page.frameLocator('#history-webview'),inputs=page.frameLocator('#input-webview');
  await history.locator('select').waitFor();
  const report=[];
  for(const number of [35,34,33,35,34]){
   await history.locator('select').selectOption('fixture-'+number);
   await inputs.locator('#text').waitFor();
   await page.waitForFunction(number=>document.querySelector('#panel-title').textContent==='局部改图 '+number,number);
   await page.waitForFunction(number=>document.querySelector('#input-webview').contentDocument.querySelector('#text').value==='测试记录 '+number,number);
   assert.equal(await history.locator('select option:checked').textContent(),'历史记录 · 局部改图 '+number);
   assert.equal(await inputs.locator('.tile .name').nth(1).textContent(),'参考图 '+number);
   assert.equal(await page.locator('#quality').inputValue(),number===35?'auto':'2K');
   assert.equal(await page.locator('#output-size').inputValue(),number===35?'original':'3:4');
   const source=jobs.find(job=>job.number===number).tasks[0].results[0].source;
   await page.waitForFunction(source=>document.querySelector('#task-webview').contentDocument.querySelector('.result img')?.src===source,source);
   assert.equal(await inputs.locator('.tile img').first().getAttribute('src'),source);
   report.push({number,title:true,prompt:true,source:true,references:true,options:true,results:true});
  }
  await inputs.locator('#text').fill('修改后保留的 34');
  await page.waitForFunction(()=>document.querySelector('#prompt').value==='修改后保留的 34');
  await history.locator('select').selectOption('fixture-35');
  await page.waitForFunction(()=>document.querySelector('#panel-title').textContent==='局部改图 35');
  await history.locator('select').selectOption('fixture-34');
  await page.waitForFunction(()=>document.querySelector('#input-webview').contentDocument.querySelector('#text').value==='修改后保留的 34');
  assert.equal(await history.locator('select').isDisabled(),false);
  assert.equal(await history.locator('select option').count(),3);
  const menuStable=await history.locator('select').evaluate(select=>{const option=select.options[0],data={type:'history',jobs:Array.from(select.options).map(item=>({id:item.value,title:item.textContent.replace('历史记录 · ', '')})),selectedJobId:select.value,busy:false};window.dispatchEvent(new MessageEvent('message',{data}));return select.options[0]===option;});
  assert.ok(menuStable);
  await history.locator('select').evaluate(select=>{window.dispatchEvent(new MessageEvent('message',{data:{type:'history',jobs:[{id:'fixture-34',title:'局部改图 34'}],selectedJobId:select.value,busy:true}}));});
  assert.equal(await history.locator('select').isDisabled(),true);
  await history.locator('select').evaluate(()=>{window.dispatchEvent(new MessageEvent('message',{data:{type:'history',jobs:[],selectedJobId:null,busy:false}}));});
  assert.equal(await history.locator('select').isDisabled(),true);
  assert.equal(await history.locator('select option').textContent(),'暂无历史记录');
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'historyReady'},source:document.getElementById('history-webview').contentWindow})));
  await history.locator('select option[value="fixture-34"]').waitFor({state:'attached'});
  assert.equal(await history.locator('select').inputValue(),'fixture-34');
  assert.deepEqual(errors,[]);
  const output=path.join(root,'.tools');fs.mkdirSync(output,{recursive:true});
  await page.screenshot({path:path.join(output,'history-switch.png'),fullPage:true});
  fs.writeFileSync(path.join(output,'history-check.json'),JSON.stringify({environment:'Chrome, real main.js and WebView pages, simulated UXP bridge and storage',report,editsPreserved:true,menuStable,errors},null,2));
  console.log(JSON.stringify({switches:report.length,editsPreserved:true,menuStable,errors}));
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
