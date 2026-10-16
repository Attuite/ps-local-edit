const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MediaClient } = require('../plugin/api');
const { TaskQueue } = require('../plugin/task-queue');

test('status tracing separates headers and body without logging credentials or result URLs', async () => {
  const events = [];
  let finishBody, call;
  const api = new MediaClient('PRIVATE-KEY', async (url, options) => {
    call = { url, options };
    return { ok: true, status: 200, headers: { get: name => ({ age: '60', 'x-cache': 'HIT', authorization: 'PRIVATE-KEY' })[name] },
      json: () => new Promise(resolve => { finishBody = resolve; }) };
  });
  const pending = api.status('existing-task', event => events.push(event));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.map(e => e.phase), ['request-start', 'headers']);
  assert.equal(events[0].timeoutMs, 60000);
  finishBody({ state: 'success', is_final: true, result_url: 'https://private-result.example/image' });
  await pending;
  assert.equal(call.options.method, 'GET');
  assert.equal(call.options.body, undefined);
  assert.equal(events[2].serverState, 'success');
  assert.equal(events[1].cache.age, '60');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-KEY|private-result/);
});

test('aborting a stalled status query records the timeout and does not retry', async t => {
  let timer, requests = 0;
  t.mock.method(globalThis, 'setTimeout', callback => { timer = callback; return 1; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const events = [];
  const api = new MediaClient('PRIVATE-KEY', async (url, options) => {
    requests++;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  });
  const rejected = assert.rejects(api.status('existing-task', event => events.push(event)), /查询原任务.*超时/);
  timer();
  await rejected;
  assert.equal(requests, 1);
  assert.ok(events.some(event => event.phase === 'timeout'));
  assert.equal(events[events.length - 1].errorType, 'aborted');
});

test('pending queries record skipped polls and timer gaps instead of sending overlaps', async () => {
  let finish, requests = 0;
  const task = { id: 'existing-task', state: 'running', results: [] };
  const job = { id: 'region-1', prompt: 'PRIVATE-PROMPT', instruction: 'PRIVATE-INSTRUCTION', tasks: [task] };
  const api = new MediaClient('PRIVATE-KEY', async () => {
    requests++;
    return new Promise(resolve => { finish = () => resolve({ ok: true, status: 200, json: async () => ({ state: 'success', result_url: 'https://private-result.example/image' }) }); });
  });
  const queue = new TaskQueue({ jobs: [job], persist() {}, onChange() {}, client: async () => api });
  const pending = queue.query(job, task, 'timer', 4000);
  await new Promise(resolve => setImmediate(resolve));
  await queue.query(job, task, 'timer', 64000);
  finish();
  await pending;
  assert.equal(requests, 1);
  assert.equal(job.timing.queries[0].skippedPolls, 1);
  assert.equal(job.timing.maxTimerGapMs, 64000);
  assert.equal(job.timing.queries[0].outcome, 'ready');
  assert.ok(job.timing.queries[0].completedObservedAt);
  assert.doesNotMatch(JSON.stringify(queue.exportTimings()), /PRIVATE-|private-result/);
});

test('diagnostic checks never submit and preserve completed results even if a status has expired', async () => {
  const task = { id: 'existing-task', state: 'ready', results: [{ source: 'PRIVATE-RESULT' }] };
  const job = { id: 'region-1', state: 'ready', tasks: [task] };
  let calls = 0;
  const queue = new TaskQueue({ jobs: [job], persist() {}, onChange() {}, client: async () => ({
    submit: () => assert.fail('diagnostics must not generate'),
    status: async () => { calls++; return { state: 'failed', is_final: true }; }
  }) });
  for (let i = 0; i < 201; i++) await queue.query(job, task, 'diagnostic');
  assert.equal(calls, 201);
  assert.equal(job.timing.queryCount, 201);
  assert.equal(job.timing.queries.length, 200);
  assert.equal(task.state, 'ready');
  assert.equal(task.results[0].source, 'PRIVATE-RESULT');
  assert.equal(job.state, 'ready');
});
