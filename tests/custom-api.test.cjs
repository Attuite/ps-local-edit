const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MediaClient, normalizeConnection, connectionKey } = require('../plugin/api');
const { TaskQueue } = require('../plugin/task-queue');

test('custom API normalizes the base and isolates credentials between endpoints', () => {
  assert.deepEqual(normalizeConnection({ protocol: 'openai', baseUrl: 'https://example.com/' }), { protocol: 'openai', baseUrl: 'https://example.com/v1' });
  assert.notEqual(connectionKey({ protocol: 'openai', baseUrl: 'https://a.example/v1' }), connectionKey({ protocol: 'openai', baseUrl: 'https://b.example/v1' }));
  assert.equal(connectionKey({ protocol: 'lk888', baseUrl: 'https://api.lk888.ai' }), 'lk888-key');
  assert.throws(() => normalizeConnection({ protocol: 'openai', baseUrl: 'http://remote.example/v1' }), /HTTPS/);
  assert.throws(() => normalizeConnection({ protocol: 'openai', baseUrl: 'https://key@example.com/v1' }), /密钥/);
  assert.equal(normalizeConnection({ protocol: 'openai', baseUrl: 'http://127.0.0.1:8000/v1' }).baseUrl, 'http://127.0.0.1:8000/v1');
});

test('OpenAI editing uploads original binary images and returns synchronous results', async () => {
  let call;
  const api = new MediaClient('dummy', async (url, options) => {
    call = { url, options };
    return { ok: true, json: async () => ({ data: [{ b64_json: 'YWJj' }] }) };
  }, { protocol: 'openai', baseUrl: 'https://example.com/v1/' }, value => Buffer.from(value, 'base64'));
  const result = await api.submit('my-image-model', '修改中文与 😀', ['data:image/png;base64,YQ==', 'data:image/jpeg;base64,Yg=='], { quality: 'high', size: '1536x1024' });
  assert.equal(call.url, 'https://example.com/v1/images/edits');
  assert.equal(call.options.headers.Authorization, 'Bearer dummy');
  assert.equal(call.options.headers['Content-Type'], undefined);
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.body.get('prompt'), '修改中文与 😀');
  assert.equal(call.options.body.get('n'), '1');
  assert.equal(call.options.body.get('quality'), 'high');
  assert.equal(Buffer.from(await call.options.body.getAll('image[]')[0].arrayBuffer()).toString(), 'a');
  assert.equal(call.options.body.getAll('image[]')[1].type, 'image/jpeg');
  assert.deepEqual(result.results, ['data:image/png;base64,YWJj']);
});

test('synchronous generation runs in the background and is never polled or resubmitted on restart', async () => {
  let finish, calls = 0;
  const config = { protocol: 'openai', baseUrl: 'https://example.com/v1' };
  const queue = new TaskQueue({ jobs: [], persist() {}, onChange() {}, client: async connection => {
    assert.deepEqual(connection, config);
    return { submit: () => { calls++; return new Promise(resolve => { finish = resolve; }); }, status: () => assert.fail('synchronous requests must not be polled') };
  } });
  const record = { id: 'region-1', connection: config, state: 'submitting', count: 1, tasks: [] };
  await queue.submit(record, [], {});
  assert.equal(calls, 1);
  await queue.tick();
  const restored = JSON.parse(JSON.stringify(record));
  const restarted = new TaskQueue({ jobs: [restored], persist() {}, onChange() {}, client: () => assert.fail('restart must not send requests') });
  await restarted.tick();
  assert.equal(restored.state, 'uncertain');
  finish({ results: ['data:image/png;base64,YQ=='] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(record.state, 'ready');
  assert.equal(record.tasks[0].state, 'ready');
  assert.equal(calls, 1);
});
