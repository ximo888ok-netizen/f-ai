import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, createReadStream, openSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { client, exerciseCustomer, exerciseFilesAndWorker, exerciseImagePreflight, exercisePsd, exerciseWorkspace, identityPayload, reviewPicture, verifyAsset } from './fixtures.mjs';
import { rotationFixture } from './credential-rotation.mjs';
import { publishFixtureTemplates } from './image-templates.mjs';
import { verifyOfflineRelease, sha256File } from '../src/verify-offline-release.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
let pgBin = process.env.FAI_QA_PG_BIN;
let pgClient = process.env.FAI_QA_PG_CLIENT_BIN || pgBin;
const cache = process.env.FAI_QA_NPM_CACHE || process.env.npm_config_cache;
const npm = process.env.npm_execpath;
const archive=process.env.FAI_QA_OFFLINE_ARCHIVE;
if (!archive && ![pgBin, pgClient, cache, npm].every(value => value && isAbsolute(value))) {
  throw new Error('Run via npm with absolute FAI_QA_PG_BIN and FAI_QA_NPM_CACHE; optional FAI_QA_PG_CLIENT_BIN supplies client tools.');
}
const osEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|systemroot|windir|temp|tmp|tmpdir|comspec|pathext|userprofile|localappdata|home|lang)$/i.test(key)));
function run(executable, args, env = osEnv, cwd = repo, stdio = 'pipe') {
  const result = spawnSync(executable, args, { cwd, env, stdio, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, executable + ' failed: ' + (result.stderr || result.stdout || '').slice(-1800));
  return (result.stdout || '').trim();
}
const executable = (dir, tool) => join(dir, tool + (process.platform === 'win32' ? '.exe' : ''));
const serverTool = name => executable(pgBin, name);
let sqlTool,node=process.execPath;
async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

const work = await mkdtemp(join(tmpdir(), 'fai-accept-'));
const application = join(work, 'backend');
const cluster = join(work, 'cluster');
const pgLog = join(work, 'postgres.log');
const backup = join(work, 'archive');
const appLog = join(work, 'service.log');
const cliLogs = [];
let clusterStarted = false;
let service;
let databaseEnv;
let packagedMedia;

function admin(...args) {
  const result = spawnSync(node, ['src/admin.js', ...args], { env: databaseEnv, cwd: application, windowsHide: true, encoding: 'utf8', timeout: 180000 });
  cliLogs.push(result.stdout || '', result.stderr || '');
  assert.equal(result.status, 0, 'Deployment admin command failed: ' + args[0]);
  return result.stdout.trim();
}
async function startService() {
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const fd = openSync(appLog, 'a', 0o600);
  try {
    service = spawn(node, ['src/server.js'], { cwd: application, windowsHide: true, stdio: ['ignore', fd, fd],
      env: { ...databaseEnv, HOST: '127.0.0.1', PORT: String(port) } });
  } finally { closeSync(fd); }
  await once(service, 'spawn');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && service.exitCode === null && service.signalCode === null) {
    try {
      if ((await fetch(origin + '/ready', { signal: AbortSignal.timeout(1000) })).ok) return origin;
    } catch { /* Startup may precede the listening socket. */ }
    await delay(150);
  }
  throw new Error('Isolated service failed its readiness check');
}
async function stopService() {
  if (service && service.pid && service.exitCode === null && service.signalCode === null) {
    const exited = once(service, 'exit');
    service.kill();
    await exited;
  }
  service = undefined;
}
try {
  const revision = run('git', ['rev-parse', 'HEAD']);
  const web = '前端设计审查';
  const gitDir = run('git', ['rev-parse', '--absolute-git-dir']);
  const indexEnv = { ...osEnv, GIT_INDEX_FILE: join(work, 'qa.index') };
  if (archive) {
    const digest=createHash('sha256');
    for await (const chunk of createReadStream(archive)) digest.update(chunk);
    assert.equal(digest.digest('hex'),process.env.FAI_QA_OFFLINE_SHA256,'Offline archive integrity');
    run('tar',['-xf',archive,'-C',work]);
    // The verified archive digest also pins its manifest for legacy invocations with only an archive hash.
    const manifestSha256=process.env.FAI_QA_OFFLINE_MANIFEST_SHA256 ?? await sha256File(join(work,'release.json'));
    const verified=await verifyOfflineRelease(work,{revision,manifestSha256});
    pgBin=join(work,'runtime','postgres','bin');
    pgClient=pgBin;
    node=join(work,'runtime','node.exe');
    const media=join(work,'runtime','media');
    const sample=join(work,'synthetic.mp4');
    packagedMedia={VIDEO_FFMPEG_PATH:executable(media,'ffmpeg'),VIDEO_FFPROBE_PATH:executable(media,'ffprobe'),VIDEO_EXPORT_ENCODER:'libopenh264'};
    run(packagedMedia.VIDEO_FFMPEG_PATH,['-v','error','-f','lavfi','-i','color=size=320x240:rate=24',
      '-f','lavfi','-i','sine=frequency=440','-t','2','-c:v','libopenh264','-threads','1','-c:a','aac','-pix_fmt','yuv420p',sample]);
    const info=JSON.parse(run(executable(media,'ffprobe'),['-v','error','-select_streams','v:0','-show_entries',
      'stream=codec_name,width,height','-of','json',sample]));
    assert.deepEqual(info.streams.map(({codec_name,width,height})=>[codec_name,width,height]),[['h264',320,240]]);
    console.log(JSON.stringify({offlineArchiveVerified:true,...verified}));
  } else {
    run('git', ['--git-dir=' + gitDir, '--work-tree=' + work, '-c', 'core.autocrlf=false',
    'restore', '--source=' + revision, '--worktree', '--', 'backend/package.json', 'backend/package-lock.json',
    'backend/src', 'backend/migrations', 'backend/sdk', 'backend/integrations', 'backend/media-runtime', web], indexEnv);
    run(node, [npm, 'ci', '--offline', '--omit=dev', '--no-audit', '--no-fund', '--cache', cache], osEnv, application);
  }
  const preflight = spawnSync(node, ['src/deployment-capacity.js', work], {
    cwd: application, env: osEnv, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  if (preflight.error) throw preflight.error;
  const capacity = JSON.parse(preflight.stdout);
  assert.ok(['meets','below','unknown'].includes(capacity.eligibility));
  assert.equal(preflight.status, {meets:0, below:1, unknown:2}[capacity.eligibility]);
  console.log(JSON.stringify({deploymentVolumeAssessment:capacity}));
  sqlTool=executable(pgClient,'psql');
  const inventory = JSON.parse(run(node, ['src/package-inventory.js'], osEnv, application));
  console.log(JSON.stringify({ revision, node: process.version, postgres: run(serverTool('postgres'), ['--version']),
    lockSha256: inventory.lockSha256, productionLockEntries: inventory.packages.length }));

  const port = await freePort();
  const password = randomBytes(24).toString('hex');
  const sqlEnv = { ...osEnv, PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'fai_qa', PGPASSWORD: password };
  const sql = (db, statement) => run(sqlTool, ['-XAt', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', statement], sqlEnv);
  const url = name => 'postgresql://fai_qa:' + password + '@127.0.0.1:' + port + '/' + name;
  const pwfile = join(work, 'init-password');
  await writeFile(pwfile, password + '\n', { mode: 0o600 });
  try {
    run(serverTool('initdb'), ['-D', cluster, '-U', 'fai_qa', '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C', '--pwfile=' + pwfile]);
  } finally { await unlink(pwfile); }
  // The long-lived Windows postgres process must not inherit a captured child pipe.
  run(serverTool('pg_ctl'), ['-D', cluster, '-l', pgLog, '-o', '-h 127.0.0.1 -p ' + port, '-w', 'start'], osEnv, work, 'inherit');
  clusterStarted = true;
  sql('postgres', 'CREATE ROLE fai_tenant_qa LOGIN');
  for (const db of ['control', 'restore_control']) sql('postgres', 'CREATE DATABASE ' + db);
  for (const db of ['tenant', 'restore_tenant']) sql('postgres', 'CREATE DATABASE ' + db + ' OWNER fai_tenant_qa');
  const { Client } = createRequire(join(application, 'package.json'))('pg');
  const rotation = await rotationFixture({ work, application, node, env: osEnv, port, Client, controlUrl: url('control'), sql, cliLogs });
  const connect = (control, version) => ({ ...osEnv, ...packagedMedia, DATABASE_URL: url(control), FAI_RELEASE_REVISION:revision, FAI_PG_BIN: pgClient, ...rotation.connection(version) });
  databaseEnv = connect('control', 1);
  admin('migrate');
  admin('migrate');
  const migrations = (await readdir(join(application, 'migrations'))).filter(file => file.endsWith('.sql')).sort();
  for (const db of ['control', 'tenant']) assert.deepEqual(sql(db, 'SELECT name FROM migrations ORDER BY name').split(/\r?\n/), migrations);

  let origin = await startService();
  const anonymous = client(origin);
  const workbench = await anonymous('GET', '/', 200);
  assert.match(workbench.toString(), /id="native-glass-design"/);
  assert.deepEqual(await anonymous('GET', '/ai.html', 200), workbench);
  assert.match((await anonymous('GET', '/merchant', 200)).toString(), /\/studio\/merchant\.js/);
  for (const file of ['live.js', 'studio-entry.js', 'image-generation/product-plans.js', 'image-generation/style.css']) {
    assert.ok((await anonymous('GET', '/studio/' + file, 200)).length, file);
  }
  const help=await anonymous('GET','/v1/help',200);
  assert.equal(help.revision,revision);
  const guide=await anonymous('GET',help.url,200);
  assert.equal(createHash('sha256').update(guide).digest('hex'),help.sha256);
  assert.match(guide.toString(),/商品草稿与运营台账/);
  const proofs = (action, details) => identityPayload(node, application, databaseEnv, action, details);
  const login = { email: 'deployment@example.test', password: randomBytes(24).toString('hex') };
  const registered = await anonymous('POST', '/v1/auth/register', 201, proofs('register', { ...login, displayName: 'QA', type: 'enterprise', workspaceName: 'Deployment QA' }));
  const workspace = registered.workspaces[0].id;
  const initial=client(origin,registered);
  await publishFixtureTemplates(initial);
  const reference=await initial('POST','/v1/assets',201,{name:'QA series reference',source:'synthetic',purpose:'release acceptance',
    mediaType:'image/png',dataBase64:reviewPicture(1024,0).toString('base64')});
  const seriesUrl='/v1/media/images/series-presets/'+workspace;
  const savedSeries=await initial('PUT',seriesUrl,200,{revision:0,name:'QA series',configuration:{
    productAssetId:reference.id,modelAssetId:null,background:'#ffffff',font:'sans',textColor:'#345678',
    subjectBox:{x:5,y:5,width:90,height:75}}});
  const memory=await initial('POST','/v1/memory',201,{scope:'enterprise',content:'Initial QA note'});
  await initial('PUT','/v1/memory/'+memory.id+'/changes/'+workspace,200,{revision:0,action:'update',content:'QA update'});
  await client(origin, registered)('POST', '/v1/studio/products', 201, { sku: 'QA-CUTOVER', name: 'Synthetic product' });
  await stopService();
  admin('workspace-cutover', workspace, 'qa', '--confirm');
  const marker = "SELECT count(*) FROM studio_products WHERE sku='QA-CUTOVER'";
  assert.equal(sql('control', marker), '0');
  assert.equal(sql('tenant', marker), '1');
  admin('credits', workspace, registered.account.id, '5', 'deployment-qa-funding');
  origin = await startService();
  const session = await client(origin)('POST', '/v1/auth/login', 200, proofs('login', login));
  const api = client(origin, session);
  const directories=(await api('GET','/v1/diagnostics',200)).directories;
  assert.ok(directories.some(d=>d.id==='credentials' && d.read==='ok'));
  assert.ok(directories.some(d=>d.id==='temporary' && d.write==='ok'));
  assert.ok(directories.every(d=>d.read==='ok' && ['ok','not-required'].includes(d.write)));
  assert.deepEqual(await api('GET',seriesUrl+'?revision=1',200),savedSeries);
  const seriesBatch=await api('POST','/v1/media/images/batches',201,{id:workspace,seriesPreset:{id:workspace,revision:1},
    items:[{key:'QA',width:120,height:120,caption:'QA'}]});
  assert.equal(seriesBatch.items[0].state,'succeeded');
  if (packagedMedia) {
    const sample=join(work,'synthetic.mp4'), delivery=join(work,'marked.mp4');
    const asset=await api('POST','/v1/assets',201,{name:'QA video',source:'synthetic',purpose:'delivery test',
      mediaType:'video/mp4',dataBase64:(await readFile(sample)).toString('base64')});
    await writeFile(delivery,await api('POST','/v1/assets/'+asset.id+'/video-export',200,{aiGenerated:true}));
    const audioHash=file=>run(packagedMedia.VIDEO_FFMPEG_PATH,['-v','error','-i',file,'-map','0:a:0','-c:a','copy','-f','hash','-hash','sha256','-']);
    const before=audioHash(sample);
    assert.match(before,/^SHA256=[0-9a-f]{64}$/i);
    assert.equal(audioHash(delivery),before);
    const probe=file=>JSON.parse(run(packagedMedia.VIDEO_FFPROBE_PATH,['-v','error','-show_entries',
      'format=duration:format_tags=fai_ai_generated:stream=codec_name,nb_frames','-of','json',file]));
    const output=probe(delivery);
    assert.equal(output.format.duration,probe(sample).format.duration);
    assert.equal(output.format.tags.fai_ai_generated,'true');
    assert.equal(Number(output.streams[0].nb_frames),48);
    console.log(JSON.stringify({packagedVideoExport:'passed',frames:48,aacPacketsPreserved:true}));
  }
  assert.deepEqual(await api('GET', '/v1/workspace/database', 200), { mode: 'dedicated', state: 'ready' });
  await exerciseWorkspace(origin, session, proofs);
  const { asset, taskId } = await exerciseFilesAndWorker(api);
  const {createWorkspaceHttpRequest,bindPluginV1}=await import(pathToFileURL(join(application,'sdk','workspace-v1.mjs')));
  const sdk=bindPluginV1(createWorkspaceHttpRequest({origin,workspaceId:workspace,getToken:()=>session.token}),
    {sdkVersion:1,permissions:['assets.read','tasks.read']},()=>true);
  assert.equal((await sdk.task(taskId)).state,'succeeded');
  assert.equal(createHash('sha256').update(await sdk.assetContent(asset.id)).digest('hex'),asset.sha256);
  const changes=await api('GET','/v1/memory/'+memory.id+'/changes',200);
  assert.equal(changes.items[0].revision,1);
  const logDir=join(work,'task-logs');
  const exported=JSON.parse(run(node,['src/task-log-export.js',workspace,logDir],databaseEnv,application));
  assert.ok(exported.events>=3);
  const logged=await readFile(join(logDir,workspace,'tasks-'+exported.lastDay+'.jsonl'),'utf8');
  assert.ok(logged.split('\n').some(line=>line && JSON.parse(line).taskId===taskId));
  assert.ok((await api('GET','/v1/diagnostics/task-events?taskId='+taskId+'&level=info',200)).items.some(e=>e.event==='succeeded'));
  const observed=JSON.parse(run(node,['src/ops-observation.js','once',join(work,'observations.sqlite')],
    {...databaseEnv,FAI_PROBE_ORIGIN:origin,FAI_PROBE_SESSION:session.token,FAI_PROBE_WORKSPACE_ID:workspace},application));
  assert.equal(observed.samples,1);assert.equal(observed.failures,0);assert.equal(observed.qualified,false);
  const report=JSON.parse(run(node,['src/ops-observation.js','report',join(work,'observations.sqlite')],
    {...osEnv,FAI_RELEASE_REVISION:revision,FAI_PROBE_ORIGIN:origin,FAI_PROBE_WORKSPACE_ID:workspace},application));
  assert.deepEqual(report.blockers,['INSUFFICIENT_CONTINUOUS_TIME']);
  assert.equal(report.samples,1);assert.equal(report.qualified,false);
  const { readPsd } = createRequire(join(application, 'package.json'))('ag-psd');
  await exercisePsd(api, asset, readPsd);
  await exerciseImagePreflight(api);
  // A child owns the candidate's native canvas library so Windows releases the DLL before cleanup.
  const imageCheck = spawnSync(node, [fileURLToPath(new URL('./image-templates.mjs', import.meta.url)), origin], {
    cwd: application, env: osEnv, input: JSON.stringify(session), encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  if (imageCheck.error) throw imageCheck.error;
  assert.equal(imageCheck.status, 0, 'Image fixture failed: ' + imageCheck.stderr.slice(-1200));
  const platformExports = JSON.parse(imageCheck.stdout);
  const sample = await exerciseCustomer(api);
  const probe = JSON.parse(run(node, ['src/ops-probe.js'], { ...osEnv, FAI_PROBE_ORIGIN: origin,
    FAI_PROBE_SESSION: session.token, FAI_PROBE_WORKSPACE_ID: workspace }, application));
  assert.deepEqual(probe.issues, []);
  assert.equal(probe.ok, true);
  console.log(JSON.stringify({ migrations: migrations.length, cutover: 'passed', platformAssetBytes: 10485760,
    fileSha256: asset.sha256, queuedTask: 'settled once', productDocuments: 20, faqDocuments: 20, questions: sample,
    followUps: 5, handoff: 'passed', workspaceProbe: 'healthy', projectGrants: 'passed', pluginToggles: 5, psdLayers: 3,
    sameNameProductVolumesMl:[350,750], imageSubmissionsRejected:6, rejectedImageLedgerDelta:0, platformExports }));

  await stopService();
  await rotation.exercise({ session, stop: stopService, start: version => {
    databaseEnv = connect('control', version);
    return startService();
  } });
  const manifest = JSON.parse(admin('backup', backup));
  assert.equal(manifest.archives.length, 2);
  for (const item of manifest.archives) assert.deepEqual(item.migrations, migrations);
  databaseEnv = connect('restore_control', 4);
  assert.deepEqual(JSON.parse(admin('restore-backup', backup, '--confirm-empty-targets')).restored, ['control', 'tenant:qa']);
  const restored = await startService();
  const restoredSession = await client(restored)('POST', '/v1/auth/login', 200, proofs('login', login));
  const restoredApi = client(restored, restoredSession);
  assert.equal(restoredSession.workspaces[0].id, workspace);
  assert.deepEqual(await restoredApi('GET',seriesUrl+'?revision=1',200),savedSeries);
  assert.deepEqual(await restoredApi('GET','/v1/media/images/batches/'+workspace,200),seriesBatch);
  console.log(JSON.stringify({versionGuide:help.version,checkedDirectories:directories.length,seriesPresetRestored:true}));
  assert.deepEqual((await restoredApi('GET','/v1/media/images/platform-templates',200)).items.map(t=>t.revision),[1,1,2]);
  await verifyAsset(restoredApi, asset);
  assert.equal((await restoredApi('GET', '/v1/tasks/' + taskId, 200)).state, 'succeeded');
  assert.deepEqual(await restoredApi('GET', '/v1/credits/wallet', 200), { balance: 4, reserved: 0, available: 4 });
  assert.equal(sql('restore_control', marker), '0');
  assert.equal(sql('restore_tenant', marker), '1');
  await stopService();
  await rotation.checkLogs({ appLog, pgLog, controlPassword: password });
  console.log(JSON.stringify({ restored: manifest.archives.map(({ name, sha256 }) => ({ name, sha256 })), result: 'passed' }));
} finally {
  try { await stopService(); } finally {
    if (clusterStarted) run(serverTool('pg_ctl'), ['-D', cluster, '-m', 'fast', '-w', 'stop']);
    await rm(work, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}
