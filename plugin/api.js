/* LK888 media protocol, independently implemented from public client evidence.
 * Protocol reference: Corkery520/ComfyUI-MengBaoAI/api/image_client.py.
 * No API keys, prompts or image payloads are logged.
 */
const MODELS = [
  { id: 'banana-2', label: 'Nano Banana 2' },
  { id: 'banana-pro', label: 'Nano Banana Pro' },
  { id: 'tt-image-2', label: 'GPT Image 2' },
  { id: 'tt-image-2.5', label: 'GPT Image 2.5' }
];
function unwrap(value) { return value && value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : value; }
const DEFAULT_CONNECTION = { protocol: 'lk888', baseUrl: 'https://api.lk888.ai' };
function normalizeConnection(value = DEFAULT_CONNECTION) {
  const protocol = value.protocol;
  if (!['lk888', 'openai'].includes(protocol)) throw new Error('请选择支持的接口类型。');
  let baseUrl = String(value.baseUrl || '').trim().replace(/\/+$/, '');
  const match = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/.exec(baseUrl);
  if (!match || match[2].includes('@') || /\s/.test(baseUrl)) throw new Error('请填写有效的 Base URL，不要包含密钥、查询参数或片段。');
  if (match[1] !== 'https' && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(match[2])) throw new Error('远程 API 必须使用 HTTPS；本机 localhost 可使用 HTTP。');
  if (protocol === 'openai' && !match[3]) baseUrl += '/v1';
  return { protocol, baseUrl };
}
function connectionKey(connection) {
  const config = normalizeConnection(connection);
  return config.protocol === 'lk888' && config.baseUrl === DEFAULT_CONNECTION.baseUrl ? 'lk888-key' : 'api-key:' + config.protocol + ':' + config.baseUrl;
}
function imageSources(payload) {
  const output = [];
  function visit(value, key) {
    if (typeof value === 'string') {
      if (value.startsWith('data:image/')) output.push(value);
      else if (['b64_json', 'base64', 'image_base64'].includes(key)) output.push('data:image/png;base64,' + value);
      else if (['image_url', 'output_url', 'image_output_url', 'result_url', 'fileuri', 'file_uri', 'url'].includes(key)) {
        if (/^https:\/\//.test(value)) output.push(value);
        else if (/^[\[{]/.test(value)) { try { visit(JSON.parse(value), key); } catch (_) {} }
      }
    } else if (Array.isArray(value)) value.forEach(item => visit(item, key));
    else if (value && typeof value === 'object') {
      const inline = value.inlineData || value.inline_data;
      if (inline && inline.data) output.push('data:' + (inline.mimeType || inline.mime_type || 'image/png') + ';base64,' + inline.data);
      Object.keys(value).forEach(name => { if (name !== 'inlineData' && name !== 'inline_data') visit(value[name], name.toLowerCase()); });
    }
  }
  visit(payload, '');
  return [...new Set(output)];
}
class MediaClient {
  constructor(key, fetchImpl = fetch, connection = DEFAULT_CONNECTION, decodeImage) {
    this.key = key; this.fetch = fetchImpl; this.connection = normalizeConnection(connection);
    this.base = this.connection.baseUrl; this.decodeImage = decodeImage;
  }
  async request(path, body, multipart = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), multipart ? 300000 : 60000);
    try {
      const response = await this.fetch(this.base + path, {
        method: body ? 'POST' : 'GET', signal: controller.signal,
        credentials: 'omit', redirect: 'error',
        headers: { Authorization: 'Bearer ' + this.key, ...(!multipart ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: multipart ? body : JSON.stringify(body) } : {})
      });
      let payload;
      try { payload = await response.json(); } catch (_) { throw new Error('平台返回了无法识别的响应。'); }
      if (!response.ok || payload.error) {
        const error = payload.error;
        throw new Error((error && (error.message || error.type)) || ('接口请求失败：' + response.status));
      }
      return payload;
    } catch (error) {
      const phase = body ? '提交生图任务' : path.startsWith('/v1/media/status') ? '查询原任务' : '检查连接';
      if (/network|fetch|abort|timeout/i.test(error.message || '') || error.name === 'AbortError') {
        throw new Error(phase + '时网络连接失败或超时。' + (body ? '提交结果不确定，请到平台确认任务，勿重复生成。' : '可再次查询，不会重复提交生图任务。'));
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
  async submit(model, prompt, images, params = {}) {
    if (this.connection.protocol === 'openai') {
      const form = new FormData();
      form.append('model', model); form.append('prompt', prompt); form.append('n', '1');
      if (params.quality && params.quality !== 'auto') form.append('quality', params.quality);
      if (params.size && params.size !== 'auto') form.append('size', params.size);
      if (!images.length || !this.decodeImage) throw new Error('缺少输入图片或图片解码器。');
      images.forEach((source, index) => {
        const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(source);
        if (!match) throw new Error('参考图必须为 PNG、JPEG 或 WebP 图片。');
        const ext = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
        form.append(images.length === 1 ? 'image' : 'image[]', new Blob([this.decodeImage(match[2])], { type: match[1] }), 'image-' + (index + 1) + '.' + ext);
      });
      const payload = await this.request('/images/edits', form, true);
      const results = imageSources({ data: payload.data });
      if (!results.length) throw new Error('接口没有返回图片。此模式需要同步返回 data[].b64_json 或 data[].url，不能使用聊天、Responses 或异步任务接口。请先核对平台记录，勿重复生成。');
      return { results };
    }
    const payload = await this.request('/v1/media/generate', { model, prompt, params: { ...params, images } });
    const taskId = unwrap(payload).task_id || payload.task_id;
    if (!taskId) throw new Error('未收到任务编号。请先到平台确认任务，避免重复计费。');
    return String(taskId);
  }
  async status(taskId) { return this.request('/v1/media/status?task_id=' + encodeURIComponent(taskId)); }
  async balance() { return this.connection.protocol === 'openai' ? this.models() : this.request('/api/v1/skills/balance'); }
  async models() {
    const payload = await this.request(this.connection.protocol === 'openai' ? '/models' : '/v1/models');
    const items = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : null;
    if (!items) throw new Error('平台未返回标准模型列表，可在设置中手动维护模型。');
    return items.map(item => typeof item === 'string' ? {id:item,label:item} : {id:item.id || item.name,label:item.name || item.id}).filter(item => typeof item.id === 'string' && item.id.trim());
  }
}
module.exports = { MODELS, MediaClient, imageSources, unwrap, DEFAULT_CONNECTION, normalizeConnection, connectionKey };
