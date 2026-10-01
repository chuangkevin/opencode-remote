#!/usr/bin/env node
// Container-only A/B harness. Intended invocation is documented in the companion report.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, chmod, symlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

const ROOTS = { baseline: '/baseline', candidate: '/candidate' };
const RUN_LIMIT_MS = 55_000;
const ACTIVE_WINDOW_MS = 8_000;
const DEADLINE_MS = 12_000;
const SECRET = 'dummy-fixture-password-never-real';
const ownedChildren = new Set();
const fixturePids = new Set();
const tempDirs = new Set();
const servers = new Set();
const reports = [];
let failed = false;

function assert(condition, message) { if (!condition) throw new Error(message); }
function json(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function randomPort() { return 20000 + Math.floor(Math.random() * 30000); }
async function freePort(excluded) {
  for (let i = 0; i < 100; i++) {
    const port = randomPort();
    if (excluded.has(port)) continue;
    const ok = await new Promise((resolveOk) => {
      const s = createServer(); s.once('error', () => resolveOk(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolveOk(true)));
    });
    if (ok) { excluded.add(port); return port; }
  }
  throw new Error('unable to allocate isolated loopback port');
}
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(80);
  }
  throw new Error(`timed out waiting for ${label} after ${ms}ms`);
}
function listen(server, port) {
  servers.add(server);
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
  });
}
function closeServer(server) {
  if (!server.listening) { servers.delete(server); return Promise.resolve(); }
  return new Promise((resolveClose) => server.close(() => { servers.delete(server); resolveClose(); }));
}
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeout ?? DEADLINE_MS) });
  const body = await response.text();
  return { status: response.status, body };
}
function launch(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  ownedChildren.add(child);
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk; });
  child.stderr?.on('data', (chunk) => { output += chunk; });
  child.fixtureOutput = () => output;
  return child;
}
async function exitResult(child, ms = 0) {
  if (child.exitCode !== null || child.signalCode !== null) return { alive: false, exitCode: child.exitCode, signal: child.signalCode };
  if (ms > 0) await Promise.race([new Promise((r) => child.once('exit', r)), delay(ms)]);
  return { alive: child.exitCode === null && child.signalCode === null, exitCode: child.exitCode, signal: child.signalCode };
}
async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([new Promise((r) => child.once('exit', () => r(true))), delay(4_000).then(() => false)]);
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.race([new Promise((r) => child.once('exit', r)), delay(2_000)]);
  ownedChildren.delete(child);
}
async function stopKnownFixturePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) {
    if (error?.code === 'ESRCH') { fixturePids.delete(pid); return; }
    throw error;
  }
  const end = Date.now() + 1_000;
  while (Date.now() < end) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error?.code === 'ESRCH') { fixturePids.delete(pid); return; }
      throw error;
    }
    await delay(50);
  }
  try { process.kill(pid, 'SIGKILL'); }
  catch (error) { if (error?.code !== 'ESRCH') throw error; }
  fixturePids.delete(pid);
}
async function compileStage(label, source, work) {
  const stage = join(work, label);
  await mkdir(stage, { recursive: true });
  await cp(source, stage, { recursive: true, filter: (src) => !src.split('/').includes('.git') && !src.split('/').includes('node_modules') });
  const packageDir = join(stage, 'packages/server');
  await symlink('/candidate/node_modules', join(stage, 'node_modules'), 'dir');
  const tsc = resolve('/candidate/node_modules/typescript/bin/tsc');
  assert(existsSync(tsc), 'candidate node_modules/typescript/bin/tsc is not mounted');
  const result = await new Promise((resolveCompile) => {
    const proc = spawn(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: packageDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; proc.stdout.on('data', (d) => { output += d; }); proc.stderr.on('data', (d) => { output += d; });
    proc.once('exit', (code) => resolveCompile({ code, output }));
  });
  assert(result.code === 0, `${label} TypeScript compilation failed:\n${result.output}`);
  const entry = join(packageDir, 'dist/index.js');
  const sourceHash = createHash('sha256').update(await readFile(entry)).digest('hex');
  const sourceFiles = [];
  async function collect(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) await collect(path);
      else if (item.isFile() && /\.(ts|json)$/.test(item.name)) sourceFiles.push(path);
    }
  }
  await collect(join(stage, 'packages/server/src'));
  sourceFiles.sort();
  const sourceDigest = createHash('sha256');
  for (const path of sourceFiles) sourceDigest.update(path.slice(stage.length)).update('\0').update(await readFile(path)).update('\0');
  return { stage, entry, buildHash: sourceHash, sourceHash: sourceDigest.digest('hex') };
}
function fixtureScript() {
  return `#!/usr/bin/env node
import http from 'node:http'; import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
const mode=process.env.FIXTURE_MODE, port=Number(process.env.FIXTURE_UPSTREAM_PORT), state=process.env.OPENCODE_SERVICE_STATE;
appendFileSync(process.env.SPAWN_COUNTER, 'spawn\\n');
const spawnNumber=readFileSync(process.env.SPAWN_COUNTER,'utf8').split('\\n').filter(Boolean).length;
if(mode==='restart-idle' && spawnNumber===2) writeFileSync(process.env.FIXTURE_CONTROL_FILE,'ok');
if(mode==='shared-spawn') process.exit(0);
const server=http.createServer(async(req,res)=>{
if(req.url==='/global/health'){let health='ok';try{health=readFileSync(process.env.FIXTURE_CONTROL_FILE,'utf8')}catch{} res.writeHead(health==='bad'?'503':'200',{'content-type':'application/json'});res.end('{}');return;}
  if(req.url==='/api/info'){let health='ok';try{health=readFileSync(process.env.FIXTURE_CONTROL_FILE,'utf8')}catch{} res.writeHead(health==='bad'?'503':'200',{'content-type':'application/json'});res.end(JSON.stringify({version:'fixture',pid:process.pid}));return;}
  if(req.url==='/api/session/active'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{ses_fixture:{type:process.env.FIXTURE_ACTIVITY||'idle'}}}));return;}
 if(req.url==='/api/session/ses_fixture/message' && req.method==='POST'){
   let body=''; for await(const chunk of req) body+=chunk;
   appendFileSync(process.env.DELIVERY_COUNTER, 'delivery\\n');
    if(process.env.FIXTURE_HOLD==='1') await new Promise(r=>setTimeout(r, Number(process.env.FIXTURE_HOLD_MS||16000)));
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,received:JSON.parse(body)}));return;
 }
 if(req.url==='/api/session'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'ses_fixture',time:{created:1,updated:1}}]}));return;}
 if(req.url==='/api/session/ses_fixture'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{id:'ses_fixture'}}));return;}
 if(req.url==='/api/provider?location%5bdirectory%5d='+encodeURIComponent(process.env.OPENCODE_DIRECTORY)){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{all:[],default:{}}}));return;}
 if(req.url==='/session/ses_fixture/message'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[]}));return;}
 if(req.url==='/event'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: server.connected\\ndata: {}\\n\\n');return;}
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{}}));
});
server.listen(port,'127.0.0.1',()=>{writeFileSync(state,JSON.stringify({url:'http://127.0.0.1:'+port,password:process.env.OPENCODE_SERVER_PASSWORD,pid:process.pid,version:'fixture'}));});
if(process.env.FIXTURE_IGNORE_SIGTERM==='1' && (mode!=='restart-idle' || spawnNumber===1)) process.on('SIGTERM',()=>{}); else process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
}
async function makeFixture(work, env) {
  const script = join(work, 'fake-opencode.mjs');
  await writeFile(script, fixtureScript()); await chmod(script, 0o755);
  const counter = join(work, `spawns-${Math.random().toString(16).slice(2)}`);
  const deliveries = join(work, `deliveries-${Math.random().toString(16).slice(2)}`);
  await writeFile(counter, ''); await writeFile(deliveries, '');
  const controlFile = join(work, `fixture-control-${Math.random().toString(16).slice(2)}`);
  await writeFile(controlFile, 'ok');
  return { script, counter, deliveries, env: { ...env, SPAWN_COUNTER: counter, DELIVERY_COUNTER: deliveries, FIXTURE_CONTROL_FILE: controlFile, FIXTURE_HOLD: '0' } };
}
async function lineCount(path) { return (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).length; }
function lifecycleEvents(logs) {
  return logs.split(/\r?\n/).flatMap((line) => {
    const prefix = '[opencode-remote] health-watchdog ';
    if (!line.startsWith(prefix)) return [];
    try { return [{ line, event: JSON.parse(line.slice(prefix.length)) }]; }
    catch { return [{ line, event: null }]; }
  });
}
const LIFECYCLE_FIELDS = new Set(['timestamp', 'ownership', 'action', 'reason', 'consecutiveFailures', 'activePrompts', 'graceRemainingMs', 'pid', 'probe']);
const LIFECYCLE_ACTIONS = new Set(['probe', 'defer', 'skipped', 'start', 'restart', 'exit', 'terminate', 'force-terminate', 'recovered']);
const LIFECYCLE_REASONS = new Set(['probe-result', 'failure-threshold', 'active-prompts', 'cooldown', 'shared-listener', 'shared-pid', 'ownership-unavailable', 'recovery-started', 'recovery-ready', 'recovery-failed', 'child-exit', 'termination', 'forced-termination', 'healthy-reset']);
const LIFECYCLE_PROBES = new Set(['healthy', 'unhealthy', 'unknown']);
function validateLifecycleEvent(event, ownership) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (Object.keys(event).some((key) => !LIFECYCLE_FIELDS.has(key))) return false;
  if (typeof event.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.timestamp)
    || !Number.isFinite(Date.parse(event.timestamp)) || new Date(event.timestamp).toISOString() !== event.timestamp) return false;
  if (event.ownership !== ownership || !LIFECYCLE_ACTIONS.has(event.action) || !LIFECYCLE_REASONS.has(event.reason)) return false;
   if (['consecutiveFailures', 'activePrompts', 'graceRemainingMs'].some((key) => !Number.isInteger(event[key]) || event[key] < 0 || event[key] > 1_000_000)) return false;
   if (event.pid !== undefined && (!Number.isSafeInteger(event.pid) || event.pid <= 0)) return false;
   if (!LIFECYCLE_PROBES.has(event.probe)) return false;
  return true;
}
function validateLifecycleDiagnostics(logs, { actions, ownership, reason }) {
  const parsed = lifecycleEvents(logs);
  const valid = parsed.filter(({ event }) => validateLifecycleEvent(event, ownership));
  const matching = valid.filter(({ event }) => actions.includes(event.action) && (!reason || event.reason === reason));
  return { pass: parsed.length > 0 && valid.length === parsed.length && matching.length > 0, count: parsed.length, validCount: valid.length, matchingCount: matching.length, events: valid.map(({ event }) => event) };
}

function runSelfTest() {
  const evt = (overrides = {}) => ({ timestamp: '2026-10-01T12:00:00.000Z', ownership: 'owned', action: 'probe', reason: 'probe-result', probe: 'healthy', consecutiveFailures: 0, activePrompts: 0, graceRemainingMs: 0, ...overrides });
  const logs = (...events) => events.map((event) => `[opencode-remote] health-watchdog ${JSON.stringify(event)}`).join('\n');
  const validate = (input, expected = { actions: ['defer'], ownership: 'owned', reason: 'active-prompts' }) => validateLifecycleDiagnostics(input, expected);
  const defer = evt({ action: 'defer', reason: 'active-prompts', probe: 'unknown', activePrompts: 1 });
  const otherwiseValidFailure = (extra) => validate(logs(defer, evt(extra))).pass;
  assert(validate(logs(evt(), defer)).pass, 'self-test: actual probe-result plus defer contract must pass');
  const ownedRestart = [
    evt({ reason: 'probe-result', probe: 'unhealthy', consecutiveFailures: 1, pid: 4101 }),
    evt({ action: 'start', reason: 'recovery-started', probe: 'unknown', pid: 4102 }),
    evt({ action: 'terminate', reason: 'termination', probe: 'unknown', pid: 4101 }),
    evt({ action: 'force-terminate', reason: 'forced-termination', probe: 'unknown', pid: 4101 }),
    evt({ action: 'restart', reason: 'recovery-ready', probe: 'healthy', pid: 4102 }),
  ];
  assert(validateLifecycleDiagnostics(logs(...ownedRestart), { actions: ['probe', 'start', 'terminate', 'force-terminate', 'restart'], ownership: 'owned' }).pass, 'self-test: complete actual owned restart lifecycle must pass');
  assert(!validate(logs(evt())).pass, 'self-test: missing required action must fail');
  assert(otherwiseValidFailure({ action: 'surprise' }) === false, 'self-test: arbitrary action must fail alongside a valid matching defer');
  assert(otherwiseValidFailure({ reason: 'surprise' }) === false, 'self-test: arbitrary reason must fail alongside a valid matching defer');
  assert(otherwiseValidFailure({ probe: 'passed' }) === false, 'self-test: arbitrary probe must fail alongside a valid matching defer');
  assert(otherwiseValidFailure({ probe: undefined }) === false, 'self-test: missing mandatory probe must fail alongside a valid matching defer');
  assert(!validate('[opencode-remote] health-watchdog {bad json').pass, 'self-test: malformed JSON must fail');
  assert(otherwiseValidFailure({ ownership: 'shared' }) === false, 'self-test: wrong ownership must fail alongside a valid matching defer');
  assert(otherwiseValidFailure({ timestamp: 'yesterday' }) === false, 'self-test: invalid timestamp must fail alongside a valid matching defer');
  assert(otherwiseValidFailure({ activePrompts: 1.5 }) === false, 'self-test: fractional counter must fail alongside a valid matching defer');
  assert(otherwiseValidFailure({ activePrompts: 1_000_001 }) === false, 'self-test: oversized counter must fail alongside a valid matching defer');
  assert(otherwiseValidFailure({ pid: 0 }) === false, 'self-test: invalid PID must fail alongside a valid matching defer');
  assert(otherwiseValidFailure({ password: SECRET }) === false, 'self-test: extra secret field must fail alongside a valid matching defer');
  json({ scenario: 'lifecycle-validator-self-test', conclusion: 'pass', cases: 14 });
}
function isolatedEnv(fixture, proxyPort, upstreamPort, state, mode, overrides = {}) {
  const home = overrides.home;
  return {
    ...process.env, HOME: home, USERPROFILE: home, OPENCODE_DIRECTORY: join(home, 'isolated-opencode'),
    OPENCODE_SERVICE_STATE: state, OPENCODE_CLI_PATH: fixture.script, OPENCODE_SERVICE_MODE: '1',
    OPENCODE_SERVER_PASSWORD: SECRET, OPENCODE_PORT: String(upstreamPort), PORT: String(proxyPort), BIND_ADDRESS: '127.0.0.1',
    FIXTURE_MODE: mode, FIXTURE_UPSTREAM_PORT: String(upstreamPort), FIXTURE_HEALTH: 'ok', FIXTURE_ACTIVITY: 'idle',
    OPENCODE_HEALTH_WATCHDOG_INTERVAL_MS: '300', OPENCODE_HEALTH_WATCHDOG_TIMEOUT_MS: '100',
    OPENCODE_HEALTH_WATCHDOG_FAILURES: '1', OPENCODE_HEALTH_WATCHDOG_COOLDOWN_MS: '0',
    OPENCODE_KEY_DRIFT_INTERVAL_MS: '0', DEAD_STREAM_WATCHDOG: '0', SESSION_REFRESH_INTERVAL_MS: '60000',
    ...fixture.env,
    HOME: home, USERPROFILE: home, OPENCODE_DIRECTORY: join(home, 'isolated-opencode'),
    OPENCODE_SERVICE_STATE: state, OPENCODE_CLI_PATH: fixture.script,
    OPENCODE_SERVER_PASSWORD: SECRET, OPENCODE_PORT: String(upstreamPort), PORT: String(proxyPort), BIND_ADDRESS: '127.0.0.1',
    FIXTURE_MODE: mode, FIXTURE_UPSTREAM_PORT: String(upstreamPort), FIXTURE_HEALTH: 'ok', FIXTURE_ACTIVITY: 'idle',
    ...overrides,
  };
}
async function remoteHealth(proxyPort) {
  const response = await request(`http://127.0.0.1:${proxyPort}/remote-health`, { timeout: 500 });
  let body;
  try { body = JSON.parse(response.body); } catch { body = null; }
  return { status: response.status, body };
}
async function startProxy(compiled, env) {
  const child = launch(process.execPath, [compiled.entry], { cwd: env.OPENCODE_DIRECTORY, env });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`proxy exited before readiness (${child.exitCode}): ${child.fixtureOutput()}`);
    try { const health = await remoteHealth(env.PORT); return health.status === 200 && health.body?.upstreamHealth?.healthy === true ? health : false; } catch { return false; }
  }, 15_000, 'proxy readiness');
  return child;
}
async function scenarioActive(label, compiled, work, reserved) {
  const started = Date.now(); const home = await mkdtemp(join(work, `${label}-home-`)); tempDirs.add(home);
  await mkdir(join(home, 'isolated-opencode'), { recursive: true });
  const state = join(home, 'service.json');
  const proxyPort = await freePort(reserved), upstreamPort = await freePort(reserved);
  const base = await makeFixture(work, { OPENCODE_SERVICE_STATE: state });
  const fixture = { ...base, env: { ...base.env, FIXTURE_MODE: 'owned', FIXTURE_HOLD: '1', FIXTURE_HOLD_MS: String(ACTIVE_WINDOW_MS + 2500), FIXTURE_ACTIVITY: 'busy' } };
  const env = isolatedEnv(fixture, proxyPort, upstreamPort, state, 'owned', { home, FIXTURE_ACTIVITY: 'busy' });
  let proxy, response;
  try {
    proxy = await startProxy(compiled, env);
    const readiness = await remoteHealth(proxyPort);
    // The proxy is ready before health changes; then wait for fixture's held request to reach upstream.
    const pending = request(`http://127.0.0.1:${proxyPort}/api/session/ses_fixture/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parts: [{ type: 'text', text: 'dummy prompt' }] }), timeout: RUN_LIMIT_MS,
    }).then((value) => { response = value; return value; }).catch((error) => { response = { error: String(error) }; return response; });
    await waitFor(async () => (await lineCount(fixture.deliveries)) === 1, 5_000, 'single upstream prompt delivery');
    const activeState = JSON.parse((await request(`http://127.0.0.1:${upstreamPort}/api/session/active`)).body).data.ses_fixture.type;
    assert(activeState === 'busy', `owned fixture activity was not busy: ${activeState}`);
    const beforeSpawn = await lineCount(fixture.counter);
    await writeFile(fixture.env.FIXTURE_CONTROL_FILE, 'bad');
    const inducedHealth = await waitFor(async () => {
      const upstreamInfo = await request(`http://127.0.0.1:${upstreamPort}/api/info`);
      const health = await remoteHealth(proxyPort).catch(() => ({ status: 0, body: null }));
      if (upstreamInfo.status === 503 && health.status === 502) return { upstreamInfoStatus: upstreamInfo.status, proxyHealth: health };
      return false;
    }, 2_500, 'real upstream /api/info health failure reflected by proxy');
    await delay(ACTIVE_WINDOW_MS);
    const during = await exitResult(proxy);
    await writeFile(fixture.env.FIXTURE_CONTROL_FILE, 'ok');
    const prompt = await Promise.race([pending, delay(10_000).then(() => ({ timeout: true }))]);
    const afterSpawn = await lineCount(fixture.counter);
    const deliveries = await lineCount(fixture.deliveries);
    const logs = proxy?.fixtureOutput() ?? '';
    const diagnostics = label === 'candidate' ? validateLifecycleDiagnostics(logs, { actions: ['defer'], ownership: 'owned', reason: 'active-prompts' }) : { pass: true, count: lifecycleEvents(logs).length, validCount: 0, events: [] };
    const secretAbsent = !lifecycleEvents(logs).some(({ line }) => line.includes(SECRET));
    const expectedPass = label === 'candidate';
    const behaviorSuccess = prompt.status === 200 && deliveries === 1 && during.alive && afterSpawn === beforeSpawn;
    const expectedBehaviorObserved = label === 'candidate' ? behaviorSuccess : !behaviorSuccess;
    const testAssertionPass = expectedBehaviorObserved && deliveries === 1 && Boolean(inducedHealth) && diagnostics.pass && secretAbsent;
    return { scenario: 'managed-owned-active-prompt', label, buildHash: compiled.buildHash, sourceHash: compiled.sourceHash, processExitCode: during.exitCode, processAliveDuringWindow: during.alive, promptHttpStatus: prompt.status ?? null, promptError: prompt.error, promptDeliveryCount: deliveries, spawnCountBeforeInduction: beforeSpawn, spawnCountAfterInduction: afterSpawn, readiness, inducedHealth, activityDuringHold: activeState, lifecycleDiagnostics: diagnostics, lifecycleEventCount: diagnostics.count, secretAbsentFromLifecycle: secretAbsent, elapsedMs: Date.now() - started, behaviorSuccess, expectedBehaviorObserved, testAssertionPass, assertions: { readyWithHealthyUpstream: readiness.status === 200 && readiness.body?.upstreamHealth?.healthy === true, exactlyOneDelivery: deliveries === 1, busyWhileHeld: activeState === 'busy', realHealthFailureObserved: inducedHealth.upstreamInfoStatus === 503 && inducedHealth.proxyHealth.status === 502, candidatePreservesRequestAndProcess: label !== 'candidate' || behaviorSuccess, candidateOwnedActivePromptDiagnostic: label !== 'candidate' || diagnostics.pass, lifecycleSecretAbsent: secretAbsent, baselineReproducesInterruptionOrTermination: label !== 'baseline' || !behaviorSuccess, full180SecondGraceNotMeasured: true }, conclusion: testAssertionPass ? 'pass' : 'inconclusive', logs };
  } finally { await stopOwned(proxy); }
}
async function scenarioShared(label, compiled, work, reserved) {
  const started = Date.now(); const home = await mkdtemp(join(work, `${label}-shared-home-`)); tempDirs.add(home);
  await mkdir(join(home, 'isolated-opencode'), { recursive: true });
  const state = join(home, 'service.json'); const proxyPort = await freePort(reserved), upstreamPort = await freePort(reserved);
  const fixture = await makeFixture(work, { OPENCODE_SERVICE_STATE: state, FIXTURE_MODE: 'shared-server' });
  const env = isolatedEnv(fixture, proxyPort, upstreamPort, state, 'shared-spawn', { home });
  let sharedServer, proxy;
  let unhealthy = false;
  const server = createServer(async (req, res) => {
    if (req.url === '/api/info') { res.writeHead(unhealthy ? 503 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version: 'fixture', pid: process.pid })); return; }
    if (req.url === '/api/session/active') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: { ses_fixture: { type: 'idle' } } })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: {} }));
  });
  sharedServer = server;
  try {
    await listen(server, upstreamPort);
    await writeFile(state, JSON.stringify({ url: `http://127.0.0.1:${upstreamPort}`, password: SECRET, pid: process.pid, version: 'fixture-shared' }));
    // Startup service invocation and its fast exit are allowed/reuse behavior, not a recovery attempt.
    proxy = await startProxy(compiled, env);
    const readiness = await remoteHealth(proxyPort);
    let startupCount = await lineCount(fixture.counter);
    let startupExitEvidence = null;
    if (label === 'baseline') {
      await waitFor(async () => (await lineCount(fixture.counter)) >= 1, 3_000, 'baseline startup shared-service CLI invocation');
      await delay(250);
      startupCount = await lineCount(fixture.counter);
      startupExitEvidence = { settled: true, counter: startupCount };
    } else {
      assert(startupCount === 0, `candidate spawned startup CLI unexpectedly (${startupCount})`);
    }
    const before = await lineCount(fixture.counter);
    unhealthy = true;
    const inducedHealth = await waitFor(async () => {
      const upstreamInfo = await request(`http://127.0.0.1:${upstreamPort}/api/info`);
      const proxyHealth = await remoteHealth(proxyPort).catch(() => ({ status: 0, body: null }));
      if (upstreamInfo.status === 503 && proxyHealth.status === 502) return { upstreamInfoStatus: upstreamInfo.status, proxyHealth };
      return false;
    }, 2_500, 'shared fixture /api/info failure reflected by proxy');
    await delay(3_000);
    const processState = await exitResult(proxy);
    const after = await lineCount(fixture.counter);
    const fixtureAlive = server.listening;
    const logs = proxy.fixtureOutput();
    const diagnostics = label === 'candidate' ? validateLifecycleDiagnostics(logs, { actions: ['defer'], ownership: 'shared', reason: 'shared-listener' }) : { pass: true, count: lifecycleEvents(logs).length, validCount: 0, events: [] };
    const secretAbsent = !lifecycleEvents(logs).some(({ line }) => line.includes(SECRET));
    const duplicateObserved = after > before;
    const behaviorSuccess = label === 'candidate' ? processState.alive && !duplicateObserved && fixtureAlive : !duplicateObserved;
    const expectedBehaviorObserved = label === 'candidate'
      ? behaviorSuccess && /shared recovery deferred|listener-occupied|shared-pid-live/.test(logs)
      : duplicateObserved && fixtureAlive;
    const testAssertionPass = expectedBehaviorObserved && Boolean(inducedHealth) && (label !== 'candidate' || processState.alive && fixtureAlive && diagnostics.pass && secretAbsent);
    return { scenario: 'shared-service-idle-health-failure', label, buildHash: compiled.buildHash, sourceHash: compiled.sourceHash, processExitCode: processState.exitCode, processAlive: processState.alive, promptHttpStatus: null, promptDeliveryCount: null, spawnCountAtStartupReady: startupCount, startupExitEvidence, spawnCountBeforeInduction: before, spawnCountAfterInduction: after, recoverySpawnDelta: after - before, fixturePidAlive: fixtureAlive, readiness, inducedHealth, lifecycleDiagnostics: diagnostics, lifecycleEventCount: diagnostics.count, secretAbsentFromLifecycle: secretAbsent, elapsedMs: Date.now() - started, behaviorSuccess, expectedBehaviorObserved, testAssertionPass, assertions: { readyWithHealthyUpstream: readiness.status === 200 && readiness.body?.upstreamHealth?.healthy === true, baselineStartupReuseSettled: label !== 'baseline' || startupExitEvidence?.settled === true, candidateZeroStartupSpawn: label !== 'candidate' || startupCount === 0, realHealthFailureObserved: inducedHealth.upstreamInfoStatus === 503 && inducedHealth.proxyHealth.status === 502, candidateSharedIdleDiagnostic: label !== 'candidate' || diagnostics.pass, lifecycleSecretAbsent: secretAbsent, candidateNoRecoverySpawnAndPreservesShared: label !== 'candidate' || !duplicateObserved && processState.alive && fixtureAlive, baselineDuplicateAttemptObservedWhileFixtureLives: label !== 'baseline' || duplicateObserved && fixtureAlive }, outcome: logs.match(/shared recovery deferred reason=[^;]+|starting our own/)?.[0] ?? null, conclusion: testAssertionPass ? 'pass' : 'inconclusive', logs };
  } finally { await stopOwned(proxy); if (sharedServer) await closeServer(sharedServer); }
}
async function scenarioOwnedIdleRestart(compiled, work, reserved) {
  const started = Date.now();
  const home = await mkdtemp(join(work, 'candidate-owned-idle-restart-home-')); tempDirs.add(home);
  await mkdir(join(home, 'isolated-opencode'), { recursive: true });
  const state = join(home, 'service.json');
  const proxyPort = await freePort(reserved), upstreamPort = await freePort(reserved);
  const fixture = await makeFixture(work, { OPENCODE_SERVICE_STATE: state });
  fixture.env.FIXTURE_MODE = 'restart-idle';
  fixture.env.FIXTURE_IGNORE_SIGTERM = '1';
  const env = isolatedEnv(fixture, proxyPort, upstreamPort, state, 'restart-idle', { home });
  let proxy;
  try {
    proxy = await startProxy(compiled, env);
    const initialDescriptor = JSON.parse(await readFile(state, 'utf8'));
    assert(Number.isSafeInteger(initialDescriptor.pid) && initialDescriptor.pid > 0, 'initial fixture descriptor has no owned PID');
    const initialPid = initialDescriptor.pid;
    fixturePids.add(initialPid);
    assert(await lineCount(fixture.counter) === 1, 'owned idle scenario must have exactly one initial spawn');
    assert(JSON.parse((await request(`http://127.0.0.1:${upstreamPort}/api/session/active`)).body).data.ses_fixture.type === 'idle', 'restart fixture must report strict idle');
    await writeFile(fixture.env.FIXTURE_CONTROL_FILE, 'bad');
    const recovery = await waitFor(async () => {
      const count = await lineCount(fixture.counter);
      if (count !== 2) return false;
      const descriptor = JSON.parse(await readFile(state, 'utf8'));
      const events = lifecycleEvents(proxy.fixtureOutput());
      const ready = events.some(({ event }) => event?.action === 'restart' && event?.reason === 'recovery-ready' && event?.ownership === 'owned' && event?.pid === descriptor.pid);
      return ready ? { descriptor, events } : false;
    }, 15_000, 'owned idle unhealthy restart lifecycle (bounded actual 3s termination grace and 2s follow-up)');
    const replacementPid = recovery.descriptor.pid;
    fixturePids.add(replacementPid);
    const ordered = recovery.events.map(({ event }) => event).filter((event) => event?.ownership === 'owned');
    const termIndex = ordered.findIndex((event) => event.action === 'terminate' && event.reason === 'termination' && event.pid === initialPid);
    const killIndex = ordered.findIndex((event, index) => index > termIndex && event.action === 'force-terminate' && event.reason === 'forced-termination' && event.pid === initialPid);
    const readyIndex = ordered.findIndex((event, index) => index > killIndex && event.action === 'restart' && event.reason === 'recovery-ready' && event.pid === replacementPid);
    const diagnostics = validateLifecycleDiagnostics(proxy.fixtureOutput(), { actions: ['probe', 'restart', 'terminate', 'force-terminate', 'defer'], ownership: 'owned' });
    const proxyAlive = (await exitResult(proxy)).alive;
    const health = await remoteHealth(proxyPort);
    const spawnCount = await lineCount(fixture.counter);
    const secretAbsent = !lifecycleEvents(proxy.fixtureOutput()).some(({ line }) => line.includes(SECRET));
    const testAssertionPass = spawnCount === 2 && replacementPid > 0 && replacementPid !== initialPid && proxyAlive && health.status === 200 && health.body?.upstreamHealth?.healthy === true && termIndex >= 0 && killIndex > termIndex && readyIndex > killIndex && diagnostics.pass && secretAbsent;
    return { scenario: 'managed-owned-idle-unhealthy-restart', label: 'candidate', buildHash: compiled.buildHash, sourceHash: compiled.sourceHash, initialPid, replacementPid, spawnCount, proxyAlive, recoveredHealth: health, lifecycleDiagnostics: diagnostics, lifecycleEventCount: diagnostics.count, lifecycleOrder: { terminateIndex: termIndex, forceTerminateIndex: killIndex, recoveryReadyIndex: readyIndex }, secretAbsentFromLifecycle: secretAbsent, elapsedMs: Date.now() - started, behaviorSuccess: testAssertionPass, expectedBehaviorObserved: testAssertionPass, testAssertionPass, assertions: { exactlyOneRecoverySpawn: spawnCount === 2, knownDistinctInitialAndReplacementPid: initialPid > 0 && replacementPid > 0 && replacementPid !== initialPid, proxyAliveAfterRecovery: proxyAlive, upstreamHealthyAgain: health.status === 200 && health.body?.upstreamHealth?.healthy === true, terminateThenForceThenRecoveryReady: termIndex >= 0 && killIndex > termIndex && readyIndex > killIndex, ownedLifecycleDiagnosticsValid: diagnostics.pass, lifecycleSecretAbsent: secretAbsent, boundedActualTimersOnly: true }, conclusion: testAssertionPass ? 'pass' : 'inconclusive', logs: proxy.fixtureOutput() };
  } finally {
    try { await stopOwned(proxy); }
    finally {
      const descriptor = JSON.parse(await readFile(state, 'utf8').catch(() => 'null'));
      if (Number.isSafeInteger(descriptor?.pid) && descriptor.pid > 0) fixturePids.add(descriptor.pid);
      for (const pid of [...fixturePids]) await stopKnownFixturePid(pid);
    }
  }
}
async function cleanup() {
  for (const child of [...ownedChildren]) await stopOwned(child);
  for (const server of [...servers]) await closeServer(server);
  for (const dir of [...tempDirs]) await rm(dir, { recursive: true, force: true });
}

async function main() {
  assert(existsSync('/baseline') && existsSync('/candidate'), 'read-only /baseline and /candidate mounts are required');
  assert(existsSync('/evidence'), 'read-only /evidence mount is required by invocation contract');
  const work = await mkdtemp(join(tmpdir(), 'watchdog-ab-')); tempDirs.add(work);
  const reserved = new Set([49374, 9223]);
  const baseline = await compileStage('baseline-stage', ROOTS.baseline, work);
  const candidate = await compileStage('candidate-stage', ROOTS.candidate, work);
  for (const [label, build] of [['baseline', baseline], ['candidate', candidate]]) {
    const active = await scenarioActive(label, build, work, reserved); reports.push(active); json(active);
    const shared = await scenarioShared(label, build, work, reserved); reports.push(shared); json(shared);
  }
  const idleRestart = await scenarioOwnedIdleRestart(candidate, work, reserved); reports.push(idleRestart); json(idleRestart);
  const a = reports.filter((r) => r.scenario === 'managed-owned-active-prompt');
  const s = reports.filter((r) => r.scenario === 'shared-service-idle-health-failure');
  const pairOk = (items) => items.length === 2 && items[0].label === 'baseline' && items[1].label === 'candidate'
    && items[0].behaviorSuccess === false && items[0].expectedBehaviorObserved === true && items[0].testAssertionPass === true
    && items[1].behaviorSuccess === true && items[1].expectedBehaviorObserved === true && items[1].testAssertionPass === true;
  const paired = pairOk(a) && pairOk(s);
  const summary = { scenario: 'paired-ab-summary', baselineCommit: 'a3f0c37d41f36f48bb98a8441afff25e9df02767', candidateBuildHash: candidate.buildHash, conclusions: reports.map(({ scenario, label, behaviorSuccess, expectedBehaviorObserved, testAssertionPass }) => ({ scenario, label, behaviorSuccess, expectedBehaviorObserved, testAssertionPass })), assertions: { baselineCandidatePairingProvesExpectedContrast: paired, candidateOwnedIdleRestartPassed: idleRestart.testAssertionPass }, conclusion: paired && idleRestart.testAssertionPass ? 'pass' : 'inconclusive' };
  json(summary);
  if (!paired || reports.some((r) => !r.testAssertionPass)) failed = true;
}
if (process.argv.includes('--self-test')) {
  try { runSelfTest(); }
  catch (error) { json({ scenario: 'lifecycle-validator-self-test', conclusion: 'fail', error: String(error?.stack ?? error) }); process.exitCode = 1; }
} else try { await main(); }
catch (error) { failed = true; json({ scenario: 'harness-failure', conclusion: 'fail', error: String(error?.stack ?? error), reports }); }
finally { if (!process.argv.includes('--self-test')) await cleanup(); }
if (!process.argv.includes('--self-test')) process.exitCode = failed ? 1 : 0;
