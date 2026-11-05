import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchEvents, watchJob } from '../src/watch.mjs';

const job = (percent = 1, extra = {}) => ({ job_id: 'test-job', state: 'printing', matched: true,
  last_observation: { state: 'RUNNING', printError: 0, hms: [], progressPercent: percent,
    layer: percent, totalLayers: 100, remainingMinutes: 100 - percent }, ...extra });

test('healthy progress and changing ETA are silent; matching completion is emitted', () => {
  const classify = createWatchEvents();
  assert.deepEqual(classify(job()).map(e => e.event), ['watch_started']);
  for (let i = 2; i < 100; i++) assert.deepEqual(classify(job(i)), []);
  assert.deepEqual(classify(job(100, { state: 'completed' })).map(e => e.event), ['completed']);
});

test('warnings notify once despite reordered HMS and timestamps; clearing and recurrence notify', () => {
  const classify = createWatchEvents(); classify(job());
  const warning = (hms, printError = 0) => job(10, { last_observation: { printError, hms } });
  const a = { hex: 'A', timestamp: 1 }, b = { hex: 'B', timestamp: 1 };
  assert.equal(classify(warning([a, b]))[0].event, 'issue');
  assert.deepEqual(classify(warning([{ ...b, timestamp: 2 }, a])), []);
  assert.equal(classify(warning([a, b], 42))[0].event, 'issue');
  assert.equal(classify(job(20))[0].event, 'issues_cleared');
  assert.equal(classify(warning([a]))[0].event, 'issue');
});

test('mismatch, pause and missing fault telemetry surface without declaring another job completed', () => {
  const classify = createWatchEvents(); classify(job());
  assert.equal(classify(job(100, { state: 'completed', matched: false }))[0].event, 'issue');
  assert.deepEqual(classify(job(100, { state: 'completed', matched: false })), []);
  assert.equal(classify(job(50, { state: 'paused' }))[0].issues[0], 'paused');
  assert.deepEqual(classify(job(50, { last_observation: {} }))[0].issues,
    ['missing_error_telemetry', 'missing_hms_telemetry']);
});

test('milestone mode emits five updates and never replays milestones when attaching late', () => {
  const classify = createWatchEvents({ notify: 'milestones' }); classify(job(0));
  const events = [];
  for (let i = 1; i < 100; i++) events.push(...classify(job(i)));
  assert.deepEqual(events.map(e => e.milestone), [1, 2, 3, 4, 5]);
  const late = createWatchEvents({ notify: 'milestones' });
  assert.deepEqual(late(job(80)).map(e => e.event), ['watch_started']);
  assert.deepEqual(late(job(81)), []);
  assert.equal(late(job(90))[0].milestone, 5);
  assert.deepEqual(late(job(30)), []);
  assert.deepEqual(late(job(90)), []);
});

function run(sequence, options = {}) {
  let time = 0, calls = 0;
  const events = [], sleeps = [];
  const promise = watchJob({ verify: async () => {
    const result = sequence[Math.min(calls++, sequence.length - 1)];
    if (result instanceof Error) throw result;
    return result;
  }, emit: event => events.push(event), now: () => time,
  sleep: async ms => { sleeps.push(ms); time += ms; }, intervalMs: 1000, timeoutMs: 10000, ...options });
  return { promise, events, sleeps, calls: () => calls };
}

test('background completion mode exits once on an issue without further printer calls', async () => {
  const f = run([job(), job(10, { state: 'paused' }), job(20)], { untilEvent: true });
  assert.equal(await f.promise, 2); assert.equal(f.calls(), 2);
  assert.deepEqual(f.events.map(e => e.event), ['watch_started', 'issue']);
});

test('connection outages are deduplicated with bounded backoff and recovery; only reads are retried', async () => {
  const f = run([job(), new Error('timeout'), new Error('timeout again'), job(50), job(100, { state: 'completed' })]);
  assert.equal(await f.promise, 0);
  assert.deepEqual(f.events.map(e => e.event), ['watch_started', 'observation_unavailable', 'observation_restored', 'completed']);
  assert.deepEqual(f.sleeps, [1000, 1000, 2000, 1000]);
});

test('lost observation ends event-mode immediately; timeout and unmatched completion never report success', async () => {
  const lost = run([new Error('offline')], { untilEvent: true });
  assert.equal(await lost.promise, 1); assert.equal(lost.calls(), 1);
  assert.deepEqual(lost.events.map(e => e.event), ['observation_unavailable']);
  const mismatch = run([job(100, { state: 'completed', matched: false })]);
  assert.equal(await mismatch.promise, 1);
  assert.deepEqual(mismatch.events.map(e => e.event), ['watch_started', 'issue', 'watch_timeout']);
});

test('failed and unsubmitted jobs stop the watch with nonzero results', async () => {
  for (const [state, code, event] of [['failed', 2, 'failed'], ['prepared', 1, 'not_submitted']]) {
    const f = run([job(0, { state })]); assert.equal(await f.promise, code);
    assert.equal(f.calls(), 1); assert.equal(f.events.at(-1).event, event);
  }
});
