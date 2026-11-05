// Local polling never calls a model. Only meaningful transitions become events.
// The host decides whether process output/completion should wake an agent.
export function createWatchEvents({ notify = 'important' } = {}) {
  if (!['important', 'milestones', 'all'].includes(notify)) throw new Error('notify must be important, milestones or all.');
  let started = false, previousIssues = '', highestMilestone = 0;
  return job => {
    const o = job.last_observation || {}, events = [];
    const base = { job_id: job.job_id, state: job.state, observation: o };
    const emit = (event, extra = {}) => events.push({ event, ...base, ...extra });
    const initial = !started;
    if (initial) { started = true; emit('watch_started'); }
    // A stored completed job is not proof when the current report mismatches.
    if (job.matched && ['completed', 'failed'].includes(job.state)) {
      emit(job.state); return events;
    }
    const issues = [];
    if (!job.matched) issues.push('job_not_observed');
    else {
      if (o.printError !== 0) issues.push(o.printError === undefined ? 'missing_error_telemetry' : `print_error:${o.printError}`);
      if (!Array.isArray(o.hms)) issues.push('missing_hms_telemetry');
      else for (const h of o.hms) issues.push(`hms:${h.hex || `${h.attr}:${h.code}`}`);
      if (job.state === 'paused') issues.push('paused');
    }
    // Ignore repeated timestamps/order in otherwise identical HMS warnings.
    const key = [...new Set(issues)].sort().join('|');
    if (key !== previousIssues) {
      emit(key ? 'issue' : 'issues_cleared', { issues: [...new Set(issues)].sort() });
      previousIssues = key;
    }
    const percent = Number.isFinite(o.progressPercent) ? o.progressPercent :
      Number.isFinite(o.layer) && o.totalLayers > 0 ? o.layer / o.totalLayers * 100 : 0;
    // At most five intermediate updates. Attaching late never replays history.
    const milestone = Math.min(5, Math.max(0, Math.floor(percent / (100 / 6))));
    if (job.matched && milestone > highestMilestone) {
      highestMilestone = milestone;
      if (!initial && notify === 'milestones' && !key) emit('milestone', { milestone, milestones: 5 });
    }
    if (notify === 'all' && !initial) emit('observation');
    return events;
  };
}

export async function watchJob({ verify, emit, notify = 'important', untilEvent = false,
  intervalMs = 60000, timeoutMs = 43200000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const classify = createWatchEvents({ notify }), deadline = now() + timeoutMs;
  let disconnected = false, failures = 0;
  while (now() < deadline) {
    let job;
    try { job = await verify(Math.max(1, Math.min(600000, deadline - now()))); }
    catch (error) {
      failures++;
      if (!disconnected) emit({ event: 'observation_unavailable', error: error.message,
        note: 'Printer state is unknown. No physical command was sent or retried.' });
      disconnected = true;
      if (untilEvent) return 1;
      await sleep(Math.max(0, Math.min(intervalMs * 2 ** Math.min(failures - 1, 3), 300000, deadline - now())));
      continue;
    }
    if (disconnected) emit({ event: 'observation_restored', job_id: job.job_id });
    disconnected = false; failures = 0;
    if (job.state === 'prepared') {
      emit({ event: 'not_submitted', job_id: job.job_id }); return 1;
    }
    const events = classify(job);
    for (const event of events) emit(event);
    if (job.matched && job.state === 'completed') return 0;
    if (job.matched && job.state === 'failed') return 2;
    if (untilEvent && events.some(e => e.event === 'issue')) return 2;
    await sleep(Math.max(0, Math.min(intervalMs, deadline - now())));
  }
  emit({ event: 'watch_timeout', note: 'Observation deadline reached; printer state is not inferred and no physical command was sent.' });
  return 1;
}
