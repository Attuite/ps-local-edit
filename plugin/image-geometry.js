const RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16'];
// Gemini's named ratios use rounded pixel grids, not exact mathematical ratios.
// https://ai.google.dev/gemini-api/docs/image-generation#aspect_ratios_and_image_size
const BANANA_PIXELS = [[1024,1024], [1264,848], [848,1264], [1200,896], [896,1200], [1152,928], [928,1152], [1376,768], [768,1376]];
const OPENAI_SIZES = ['1024x1024', '1536x1024', '1024x1536'];

function positiveDimensions(width, height) {
 if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error('图片尺寸无效。');
}

function generationFrame(width, height, protocol, model, selected) {
 positiveDimensions(width, height);
 const options = protocol === 'openai'
  ? OPENAI_SIZES.map(value => ({value, pixels:value.split('x').map(Number)}))
  : RATIOS.map((value, index) => ({value, pixels:/^banana-(2(?:\.1)?|pro)$/.test(model) ? BANANA_PIXELS[index] : value.split(':').map(Number)}));
 let option;
 if (selected === 'original' || selected === 'auto') {
  const distance = item => Math.abs(Math.log(width * item.pixels[1] / (height * item.pixels[0])));
  option = options.reduce((best, item) => distance(item) < distance(best) ? item : best);
 } else option = options.find(item => item.value === selected);
 if (!option) throw new Error('此接口不支持所选输出比例，请重新选择尺寸。');
 const gcd = (a, b) => b ? gcd(b, a % b) : a;
 const divisor = gcd(...option.pixels), unitWidth = option.pixels[0] / divisor, unitHeight = option.pixels[1] / divisor;
 const units = Math.ceil(Math.max(width / unitWidth, height / unitHeight));
 const frameWidth = units * unitWidth, frameHeight = units * unitHeight;
 return {width:frameWidth, height:frameHeight, left:Math.floor((frameWidth-width)/2), top:Math.floor((frameHeight-height)/2), sourceWidth:width, sourceHeight:height, unitWidth, unitHeight,
  params:protocol === 'openai' ? {size:option.value} : {aspect_ratio:option.value}};
}

function uniformScale(width, height, bounds) {
 positiveDimensions(width, height);
 positiveDimensions(bounds.width, bounds.height);
 const scale = Math.min(bounds.width / width, bounds.height / height);
 // Allow at most one destination pixel of host rounding; never stretch either axis.
 if (bounds.width - width * scale > 1 || bounds.height - height * scale > 1) {
  throw new Error(`生成图 ${width} × ${height} 与输入画布 ${bounds.width} × ${bounds.height} 的比例不一致，已停止回填以避免拉伸和接缝。可保存原图手动处理；旧结果不会自动修复。`);
 }
 return scale;
}

module.exports = {RATIOS, generationFrame, uniformScale};
