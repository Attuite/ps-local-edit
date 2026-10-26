const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {test}=require('node:test');
const {imageBytes,compressUpload,MAX_UPLOAD_BYTES}=require('../plugin/upload-image');
const oversized='data:image/png;base64,'+'AAAA'.repeat(Math.floor(MAX_UPLOAD_BYTES/3)+1);

test('image limit uses decoded bytes including Base64 padding and accepts exactly 10 MB',async()=>{
 assert.equal(imageBytes('data:image/png;base64,YQ=='),1);
 assert.equal(imageBytes('data:image/png;base64,YWI='),2);
 assert.equal(imageBytes('data:image/png;base64,YWJj'),3);
 assert.throws(()=>imageBytes('data:image/png;base64,A==='),/Base64/);
 assert.throws(()=>imageBytes('https://example.com/image.png'),/Base64/);
 const exact='data:image/png;base64,'+Buffer.alloc(MAX_UPLOAD_BYTES).toString('base64');
 assert.equal(imageBytes(exact),MAX_UPLOAD_BYTES);
 assert.deepEqual(await compressUpload(exact),{data:exact});
});

function encoder(sizes,{decodeFails=false,encodeFails=false}={}){
 const calls=[],canvases=[];
 class Image {constructor(){this.naturalWidth=4000;this.naturalHeight=2000;}set src(value){if(value)queueMicrotask(()=>decodeFails?this.onerror():this.onload());}}
 class FileReader {readAsDataURL(blob){this.result='data:'+blob.type+';base64,YQ==';this.onload();}}
 const context={module:{exports:{}},Image,FileReader,document:{createElement(){const canvas={width:0,height:0,getContext:()=>({drawImage(){},fillRect(){}}),toBlob(callback,type,quality){calls.push({type,quality,width:this.width,height:this.height});callback(encodeFails?null:{type,size:sizes.shift()});}};canvases.push(canvas);return canvas;}}};
 vm.runInNewContext(fs.readFileSync('plugin/upload-image.js','utf8'),context);
 return {...context.module.exports,calls,canvases};
}

test('oversized PNG is losslessly re-encoded first with its original dimensions',async()=>{
 const h=encoder([1000]),result=await h.compressUpload(oversized);
 assert.equal(result.width,4000);assert.equal(result.height,2000);
 assert.equal(result.data,'data:image/png;base64,YQ==');
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].type,'image/png');
 assert.equal(h.canvases[0].width,0);assert.equal(h.canvases[0].height,0);
});

test('quality reduction precedes proportional resizing and stops below the target',async()=>{
 const h=encoder([15000000,13000000,12000000,11000000,8000000]);
 const result=await h.compressUpload(oversized);
 assert.equal(h.calls.length,5);assert.equal(h.calls[0].type,'image/png');
 assert.deepEqual(h.calls.slice(1,4).map(call=>call.quality),[.92,.82,.72]);
 assert.ok(result.width<4000);assert.ok(result.height<2000);
 assert.ok(Math.abs(result.width/result.height-2)<.002);
 assert.ok(h.imageBytes(result.data)<=MAX_UPLOAD_BYTES);
});

test('decode and encoding failures reject instead of returning an oversized upload',async()=>{
 await assert.rejects(encoder([],{decodeFails:true}).compressUpload(oversized),/读取失败/);
 const h=encoder([],{encodeFails:true});
 await assert.rejects(h.compressUpload(oversized),/压缩失败/);
 assert.equal(h.canvases[0].width,0);
});
