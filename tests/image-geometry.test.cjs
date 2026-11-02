const assert = require('node:assert/strict');
const {test} = require('node:test');
const {generationFrame, uniformScale} = require('../plugin/image-geometry');

test('Banana input padding matches actual output pixels without stretching the source', () => {
 const frame = generationFrame(2022,1348,'lk888','banana-2','original');
 assert.deepEqual(frame.params,{aspect_ratio:'3:2'});
 assert.equal(frame.width,2054);assert.equal(frame.height,1378);
 assert.equal(frame.left,16);assert.equal(frame.top,15);
 const scale = uniformScale(2528,1696,frame);
 assert.equal(2528*scale,frame.width);assert.equal(1696*scale,frame.height);
});

test('clipped and portrait selections get padding on the correct axes', () => {
 for(const [w,h] of [[1996,1568],[1348,2022],[307,307],[1,1]]){
  const f=generationFrame(w,h,'lk888','banana-2','original');
  assert.ok(f.width>=w && f.height>=h);
  assert.ok(f.left>=0 && f.top>=0);
  assert.ok(f.left+w<=f.width && f.top+h<=f.height);
  assert.equal(f.width*f.unitHeight,f.height*f.unitWidth);
 }
 const f=generationFrame(1996,1568,'lk888','banana-2','original');
 assert.deepEqual(f.params,{aspect_ratio:'5:4'});
 assert.equal(f.width*1856,f.height*2304);
});

test('explicit sizes and OpenAI auto both constrain generation and preserve the entire input', () => {
 for(const [protocol,selected,params] of [
  ['lk888','16:9',{aspect_ratio:'16:9'}],
  ['openai','auto',{size:'1536x1024'}],
  ['openai','1024x1536',{size:'1024x1536'}]
 ]){
  const f=generationFrame(2022,1348,protocol,'banana-2',selected);
  assert.deepEqual(f.params,params);
  assert.ok(f.width>=2022 && f.height>=1348);
 }
});

test('old mismatched results and invalid sizes are rejected rather than stretched', () => {
 assert.throws(()=>uniformScale(2528,1696,{width:2022,height:1348}),/比例不一致/);
 assert.throws(()=>uniformScale(2304,1856,{width:1996,height:1568}),/比例不一致/);
 assert.equal(uniformScale(2048,2048,{width:307,height:307}),307/2048);
 assert.ok(uniformScale(400,200,{width:200,height:101})>0);
 for(const value of [0,-1,NaN,Infinity]) assert.throws(()=>uniformScale(value,100,{width:100,height:100}),/尺寸无效/);
 assert.throws(()=>generationFrame(100,100,'openai','custom','4:3'),/不支持/);
});
