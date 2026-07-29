#!/usr/bin/env node
// Regression: restarting the recorder must UPDATE the script in tabs that are
// already open.
//
// recorder.js injects two ways: addInitScript for pages opened later, and
// page.evaluate for pages already open at attach time. The install guard used to
// be a bare `if (window.__flowRecorderInstalled) return;`, which made that second
// path a no-op — an open tab kept running whatever build was injected first, and
// kept emitting through the newly bound __flowRecorderEmit, so it looked healthy
// while silently ignoring every change to inject.js. Anyone editing the capture
// script had to know to reload each tab by hand.
//
// The guard now compares a hash of the script source. This test drives the real
// failure: attach, change the script, re-attach against the SAME open page, and
// require the new build to be live. The second half is the risk the fix creates —
// replacing an instance without tearing the old one down would leave two sets of
// listeners on the document and emit every event twice.
//
//   node test/reinject-test.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP_PORT = 9231;
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const INJECT = path.join(__dirname, '..', 'src', 'inject.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const record = (outDir, name, cwd) =>
  spawn('node', [CLI, 'record', '--attach', String(CDP_PORT), '--out', outDir, '--name', name], {
    stdio: 'inherit',
    cwd: cwd || path.join(__dirname, '..'),
  });

// Drive one segment through the widget and return this session's events.
const runSegment = async (page, outDir, scenario) => {
  await page.fill('#inp', scenario);
  await page.click('#rec');
  await sleep(200);
  await page.click('[data-testid=save-btn]');
  // ⏺ and ⏹ are the same button, and it ignores repeat clicks within 500ms. Stop
  // too soon after start and the segment never ends — which surfaces later as a
  // missing marker, not as an error.
  await sleep(700);
  await page.click('#rec'); // ⏹
  await sleep(700); // the stop marker is written asynchronously — read after it lands
  const file = fs.readFileSync(path.join(outDir, 'latest.txt'), 'utf8').trim();
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
};

const original = fs.readFileSync(INJECT, 'utf8');
let browser;
const restore = () => fs.writeFileSync(INJECT, original);

(async () => {
  const outA = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-reinject-a-'));
  const outB = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-reinject-b-'));
  browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=' + CDP_PORT] });
  const page = await browser.newPage();
  await page.setContent(`
    <div style="height:80px"></div>
    <h2>Reinject page</h2>
    <button data-testid="save-btn">Save</button>
  `);

  // --- session A: the build the page installs first ---
  const recA = record(outA, 'reinject-a');
  await sleep(3000);
  const eventsA = await runSegment(page, outA, 'before-restart');
  recA.kill('SIGINT');
  await sleep(800);

  // --- change the script, exactly as an author editing inject.js would ---
  // A marker event no build before this one could possibly emit.
  fs.writeFileSync(
    INJECT,
    original.replace(
      "  const emit = (evt) => {",
      "  window.__flowRecorderBuildProbe = 'B';\n  const emit = (evt) => {"
    )
  );
  if (fs.readFileSync(INJECT, 'utf8') === original) throw new Error('probe injection failed — anchor not found');

  // --- session B: same browser, SAME already-open page, never reloaded ---
  const recB = record(outB, 'reinject-b');
  await sleep(3000);

  const probe = await page.evaluate(() => window.__flowRecorderBuildProbe || null);
  const installedVersion = await page.evaluate(() => window.__flowRecorderInstalled || null);
  const eventsB = await runSegment(page, outB, 'after-restart');

  // Re-injecting the SAME build must be a no-op, not another teardown/install cycle.
  // Built and evaluated exactly the way recorder.js does it (one expression, as a
  // string), because that is the path that actually runs twice in a real session.
  const raw = fs.readFileSync(INJECT, 'utf8').trim().replace(/;\s*$/, '');
  const version = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
  await page.evaluate(
    '(function(){window.__flowRecorderConfig={scriptVersion:"' + version + '"};' + raw + ';})()'
  );
  await sleep(200);
  const eventsAfterSameBuild = await runSegment(page, outB, 'same-build-again');

  recB.kill('SIGINT');
  await sleep(800);

  // --- session C: IDENTICAL script source, different config --------------------
  // A stale config is as wrong as stale code and fails more quietly — same file,
  // changed settings, and the open tab keeps answering with the previous run's
  // values. inject.js is deliberately NOT restored yet, so the source matches
  // session B exactly and the config is the only thing that differs.
  const outC = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-reinject-c-'));
  const cwdC = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-reinject-cfg-'));
  fs.writeFileSync(
    path.join(cwdC, 'flow-recorder.config.json'),
    JSON.stringify({ maskPattern: 'onlyinsessionc' })
  );
  const recC = record(outC, 'reinject-c', cwdC);
  await sleep(3000);
  const cfgInPage = await page.evaluate(() => (window.__flowRecorderConfig || {}).maskPattern || null);
  recC.kill('SIGINT');
  await sleep(800);

  await browser.close();
  restore();

  const clicksIn = (events, scenario) => {
    const start = events.findIndex((e) => e.value === 'recording-start' && e.note === scenario);
    if (start === -1) return [];
    const found = events.findIndex((e, i) => i > start && e.value === 'recording-stop');
    // A missing stop marker must not silently truncate the segment — that read as
    // "zero clicks captured" and looked like a teardown bug rather than a slow write.
    const stop = found === -1 ? events.length : found;
    return events
      .slice(start, stop)
      .filter((e) => e.kind === 'click' && (e.candidates || []).some((c) => c.sel === '[data-testid="save-btn"]'));
  };

  const checks = {
    'session A captured its segment normally': clicksIn(eventsA, 'before-restart').length === 1,

    // The core fix: the open page is running the NEW build after a restart.
    'a restart replaces the script in an already-open page': probe === 'B',
    'the install guard records the build version, not a bare true':
      typeof installedVersion === 'string' && installedVersion !== 'true' && installedVersion.length >= 8,

    // The risk the fix introduces.
    'the replaced instance still captures': clicksIn(eventsB, 'after-restart').length >= 1,
    'replacing does NOT double-emit (old listeners were torn down)':
      clicksIn(eventsB, 'after-restart').length === 1,

    // Same build re-injected must not tear down and reinstall.
    're-injecting the same build is a no-op, not a reinstall':
      clicksIn(eventsAfterSameBuild, 'same-build-again').length === 1,

    // A config-only change must also replace the instance.
    'a config change alone replaces the instance in an open page': cfgInPage === 'onlyinsessionc',

    'the widget survives replacement (segment could be driven at all)': eventsB.some(
      (e) => e.value === 'recording-start' && e.note === 'after-restart'
    ),
  };

  let ok = true;
  for (const [label, pass] of Object.entries(checks)) {
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + label);
    if (!pass) ok = false;
  }
  if (!ok) {
    console.log('\nprobe=' + probe + ' installed=' + installedVersion);
    console.log('session B events:\n' + eventsB.map((e) => JSON.stringify(e)).join('\n'));
  }
  console.log(ok ? '\nREINJECT TEST PASSED' : '\nREINJECT TEST FAILED');
  process.exit(ok ? 0 : 1);
})().catch(async (e) => {
  restore(); // never leave a probe in the real inject.js
  if (browser) await browser.close().catch(() => {});
  console.error('reinject test crashed: ' + e.message);
  process.exit(1);
});
