// Synthetic local images only: exercises real browser encoding and the UXP message bridge.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
const {pngRGBA}=require('../plugin/png');

(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.sent=[];window.uxpHost={postMessage:data=>window.sent.push(JSON.parse(data))};});
  await page.goto(pathToFileURL(path.resolve('plugin/inputs.html')).href);
  const raw='data:image/png;base64,'+Buffer.from(pngRGBA(2000,1600,new Uint8Array(2000*1600*4).fill(255),4)).toString('base64');
  const lossless=await page.evaluate(async source=>{
   window.testSource=source;
   const result=await window.uploadImages.compressUpload(source);
   return {before:window.uploadImages.imageBytes(source),after:window.uploadImages.imageBytes(result.data),width:result.width,height:result.height,png:result.data.startsWith('data:image/png;')};
  },raw);
  assert.ok(lossless.before>10000000);assert.ok(lossless.after<9500000);assert.ok(lossless.png);
  assert.equal(lossless.width,2000);assert.equal(lossless.height,1600);
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'prepareUploads',requestId:123,images:[window.testSource]}})));
  await page.waitForFunction(()=>window.sent.some(message=>message.type==='uploadsPrepared' && message.requestId===123));
  const bridge=await page.evaluate(()=>{const reply=window.sent.find(message=>message.type==='uploadsPrepared' && message.requestId===123);return {error:reply.error,count:reply.images?.length,bytes:reply.images?window.uploadImages.imageBytes(reply.images[0].data):null};});
  assert.equal(bridge.error,undefined);assert.equal(bridge.count,1);assert.ok(bridge.bytes<10000000);
  for(const eventType of ['drop','paste']){
   await page.evaluate(eventType=>{
    const bytes=Uint8Array.from(atob(window.testSource.split(',')[1]),char=>char.charCodeAt(0)),transfer=new DataTransfer();
    transfer.items.add(new File([bytes],eventType+'.png',{type:'image/png'}));
    const event=eventType==='drop'?new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}):new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer});
    document.dispatchEvent(event);
   },eventType);
   await page.waitForFunction(name=>window.sent.some(message=>message.type==='addReferences' && message.references[0].name===name),eventType+'.png');
  }
  assert.ok(await page.evaluate(()=>window.sent.filter(message=>message.type==='addReferences').every(message=>window.uploadImages.imageBytes(message.references[0].data)<=10000000)));
  const jpeg=await page.evaluate(async()=>{
   const canvas=document.createElement('canvas');canvas.width=4000;canvas.height=3000;
   const context=canvas.getContext('2d'),pixels=context.createImageData(canvas.width,canvas.height);let seed=123456789;
   for(let i=0;i<pixels.data.length;i+=4){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;pixels.data[i]=seed&255;pixels.data[i+1]=(seed>>>8)&255;pixels.data[i+2]=(seed>>>16)&255;pixels.data[i+3]=255;}
   context.putImageData(pixels,0,0);const source=canvas.toDataURL('image/png');canvas.width=0;canvas.height=0;
   const calls=[],encode=HTMLCanvasElement.prototype.toBlob;
   HTMLCanvasElement.prototype.toBlob=function(callback,type,quality){calls.push({type,quality,width:this.width,height:this.height});return encode.call(this,callback,type,quality);};
   try{const result=await window.uploadImages.compressUpload(source);return {before:window.uploadImages.imageBytes(source),after:window.uploadImages.imageBytes(result.data),width:result.width,height:result.height,jpeg:result.data.startsWith('data:image/jpeg;'),calls};}
   finally{HTMLCanvasElement.prototype.toBlob=encode;}
  });
  assert.ok(jpeg.before>10000000);assert.ok(jpeg.after<=9500000);assert.ok(jpeg.jpeg);
  assert.ok(jpeg.width<=4000 && jpeg.height<=3000);assert.equal(jpeg.calls[0].type,'image/png');
  assert.ok(jpeg.calls.some(call=>call.type==='image/jpeg'));
  assert.deepEqual(errors,[]);
  fs.mkdirSync('.tools',{recursive:true});fs.writeFileSync('.tools/upload-compression-check.json',JSON.stringify({lossless,bridge,jpeg,drop:true,paste:true,errors},null,2));
  console.log(JSON.stringify({lossless,jpeg,bridge:true,drop:true,paste:true,errors}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
