// Shared by the UXP host and its existing image-input WebView.
(function(){
const MAX_UPLOAD_BYTES = 10000000;
const TARGET_UPLOAD_BYTES = 9500000;
const MAX_REFERENCE_BYTES = 60000000;

function imageBytes(source) {
 const prefix=typeof source==='string' && /^data:image\/(?:png|jpeg|webp);base64,/.exec(source);
 if(!prefix)throw new Error('图片必须为 PNG、JPEG 或 WebP 的 Base64 数据。');
 const payload=source.slice(prefix[0].length),padding=payload.endsWith('==')?2:payload.endsWith('=')?1:0;
 if(!payload.length || payload.length%4 || /[^A-Za-z0-9+/]/.test(payload.slice(0,payload.length-padding)))throw new Error('图片 Base64 数据无效。');
 return payload.length/4*3-padding;
}

async function compressUpload(source, frame) {
 const bytes=imageBytes(source);
 if(!frame && bytes<=MAX_UPLOAD_BYTES)return {data:source};
 const image=await new Promise((resolve,reject)=>{const node=new Image();node.onload=()=>resolve(node);node.onerror=()=>reject(new Error('图片读取失败，未提交生成。'));node.src=source;});
 const canvas=document.createElement('canvas');
 try {
  if(frame){
   if(!['width','height','sourceWidth','sourceHeight','unitWidth','unitHeight'].every(key=>Number.isInteger(frame[key]) && frame[key]>0) || !['left','top'].every(key=>Number.isInteger(frame[key]) && frame[key]>=0)
    || image.naturalWidth!==frame.sourceWidth || image.naturalHeight!==frame.sourceHeight || frame.left+frame.sourceWidth>frame.width || frame.top+frame.sourceHeight>frame.height
    || frame.width%frame.unitWidth || frame.height%frame.unitHeight || frame.width/frame.unitWidth!==frame.height/frame.unitHeight)throw new Error('上传补边尺寸无效，未提交生成。');
   if(frame.width===image.naturalWidth && frame.height===image.naturalHeight && bytes<=MAX_UPLOAD_BYTES)return {data:source,width:frame.width,height:frame.height};
  }
  const baseWidth=frame?frame.width:image.naturalWidth,baseHeight=frame?frame.height:image.naturalHeight;
  canvas.width=baseWidth;canvas.height=baseHeight;
  const context=canvas.getContext('2d');
  if(!context || !canvas.width || !canvas.height)throw new Error('图片尺寸无法处理，请缩小选区或参考图。');
  const draw=(white)=>{
   if(white || frame){context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);}
   if(frame){const scale=canvas.width/baseWidth;context.drawImage(image,frame.left*scale,frame.top*scale,image.naturalWidth*scale,image.naturalHeight*scale);}
   else context.drawImage(image,0,0,canvas.width,canvas.height);
  };
  draw(false);
  const encode=(type,quality)=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('图片压缩失败，未提交生成。')),type,quality));
  let blob=await encode('image/png');
  if(blob.size>TARGET_UPLOAD_BYTES){
   // JPEG upload copies use white behind transparency; originals and masks stay intact.
   draw(true);
   for(const quality of [.92,.82,.72]){blob=await encode('image/jpeg',quality);if(blob.size<=TARGET_UPLOAD_BYTES)break;}
   while(blob.size>TARGET_UPLOAD_BYTES && (canvas.width>1 || canvas.height>1)){
    const scale=Math.min(.85,Math.sqrt(TARGET_UPLOAD_BYTES/blob.size)*.95);
    if(frame){
     const units=Math.floor(canvas.width/frame.unitWidth*scale);
     if(units<1)throw new Error('图片无法在保持比例的同时压缩至 10MB，未提交生成。');
     canvas.width=units*frame.unitWidth;canvas.height=units*frame.unitHeight;
    }else{canvas.width=Math.max(1,Math.floor(canvas.width*scale));canvas.height=Math.max(1,Math.floor(canvas.height*scale));}
    draw(true);blob=await encode('image/jpeg',.82);
   }
  }
  if(blob.size>MAX_UPLOAD_BYTES)throw new Error('图片压缩后仍超过 10MB，未提交生成。');
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('无法读取压缩后的图片。'));reader.readAsDataURL(blob);});
  return {data,width:canvas.width,height:canvas.height};
 } finally {canvas.width=0;canvas.height=0;image.src='';}
}

const uploadImages={MAX_UPLOAD_BYTES,MAX_REFERENCE_BYTES,imageBytes,compressUpload};
if(typeof module!=='undefined' && module.exports)module.exports=uploadImages;
else window.uploadImages=uploadImages;
})();
