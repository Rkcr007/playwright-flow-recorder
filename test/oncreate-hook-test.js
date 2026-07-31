#!/usr/bin/env node
// The ⚡ hand-off hook: `onCreate` must turn a ⚡ click into a real spawn.
//
// Before this existed, ⚡ appended to the queue file and printed a line — durable,
// but delivered to nobody unless an agent happened to be tailing the JSONL. Users
// reasonably read the widget's "waiting for the AI agent…" as "a request was sent",
// and sat watching a scenario that was never going to be converted.
//
// What must hold:
//   • no `onCreate` → nothing is ever spawned (this is the default; it must stay
//     silent, because a config file can arrive with a cloned repo);
//   • `onCreate` set → the command runs, with the queue/session paths and scenario
//     names available as FLOW_* env vars rather than interpolated into a string;
//   • --no-hooks wins over a configured command;
//   • a second ⚡ while the hook is still running does NOT start a second agent.
//
//   node test/oncreate-hook-test.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP_PORT = 9235;
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for `claude -p …`: appends one line per invocation recording the
// context it was handed, so the test can prove both the firing and the env.
const HOOK_SCRIPT = (logFile, holdMs) => `#!/bin/sh
printf '%s\\n' "FIRED queue=$FLOW_QUEUE_FILE depth=$FLOW_QUEUE_DEPTH added=$FLOW_ENQUEUED scenarios=$(printf '%s' "$FLOW_SCENARIOS" | tr '\\n' ',') root=$FLOW_PROJECT_ROOT" >> ${logFile}
sleep ${holdMs}
`;

const setup = async ({ onCreate, extraArgs = [], holdSeconds = 0 }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-hook-'));
  const outDir = path.join(dir, 'recordings');
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = path.join(dir, 'hook.log');
  const hookPath = path.join(dir, 'hook.sh');
  fs.writeFileSync(hookPath, HOOK_SCRIPT(logFile, holdSeconds));
  fs.chmodSync(hookPath, 0o755);

  // A real project config, since resolving onCreate from the config file is part
  // of what's under test.
  fs.writeFileSync(
    path.join(dir, 'flow-recorder.config.json'),
    JSON.stringify({ outDir: 'recordings', onCreate: onCreate === 'SCRIPT' ? hookPath : onCreate }, null, 2)
  );

  const rec = spawn('node', [CLI, 'record', '--attach', String(CDP_PORT), '--name', 'hook', ...extraArgs], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  rec.stdout.on('data', (d) => { stdout += d.toString(); });
  rec.stderr.on('data', (d) => { stdout += d.toString(); });
  return { dir, outDir, logFile, rec, out: () => stdout };
};

const hookLines = (logFile) => {
  try {
    return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
};

let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=' + CDP_PORT] });
  const page = await browser.newPage();
  await page.setContent('<div style="height:80px"></div><button data-testid="save-btn">Save</button>');

  // One stopped segment, then ⚡.
  const segmentThenCreate = async (name) => {
    await page.fill('#inp', name);
    await page.click('#rec');
    await sleep(200);
    await page.click('[data-testid=save-btn]');
    await sleep(700); // clear the 500ms repeat-click guard before ⏹
    await page.click('#rec');
    await sleep(400);
    await page.click('#gen'); // ⚡
    await sleep(900); // long enough for the state poll to overwrite the click text
  };

  // What the widget SAYS after ⚡ has settled — the poll replaces the click-time
  // text almost immediately, so this steady-state line is what a user reads.
  const queueReadout = () =>
    page.evaluate(() => {
      const h = document.getElementById('__flow_rec_host');
      return h && h.shadowRoot ? h.shadowRoot.getElementById('qs').textContent : 'NO HOST';
    });

  // --- 1. no hook configured: ⚡ must spawn nothing -----------------------------
  const plain = await setup({ onCreate: '' });
  await sleep(3000);
  await segmentThenCreate('no-hook');
  const plainReadout = await queueReadout();
  const plainFired = hookLines(plain.logFile).length;
  const plainQueue = JSON.parse(
    fs.readFileSync(fs.readFileSync(path.join(plain.outDir, 'latest.txt'), 'utf8').trim() + '.queue.json', 'utf8')
  );
  const plainSaysSo = /nothing is spawned/.test(plain.out());
  // With nothing wired to the queue, the detail panel is the ONLY place that can
  // explain why "queued" is not going to become "done" on its own. It used to open
  // for working/done/error only — i.e. never in this case — so the bar sat on
  // "awaiting pickup" indefinitely with the explanation hidden behind a click
  // nobody knew to make.
  const plainPanel = await page.evaluate(() => {
    const h = document.getElementById('__flow_rec_host');
    const p = h && h.shadowRoot && h.shadowRoot.getElementById('panel');
    if (!p) return { shown: false, text: '' };
    return { shown: getComputedStyle(p).display !== 'none', text: (p.textContent || '').replace(/\s+/g, ' ') };
  });
  plain.rec.kill('SIGINT');
  await sleep(800);
  // …and the console has to repeat it on the way out, for the user who quit the
  // session and would otherwise never learn the scenario is still sitting there.
  const plainExit = plain.out();

  // --- 2. hook configured: ⚡ runs it, with context in the environment ----------
  const hooked = await setup({ onCreate: 'SCRIPT' });
  await sleep(3000);
  await segmentThenCreate('with-hook');
  const hookedReadout = await queueReadout();
  const fired = hookLines(hooked.logFile);
  const announced = /⚡ on create:/.test(hooked.out());
  hooked.rec.kill('SIGINT');
  await sleep(600);

  // --- 3. --no-hooks overrides a configured command ----------------------------
  const disabled = await setup({ onCreate: 'SCRIPT', extraArgs: ['--no-hooks'] });
  await sleep(3000);
  await segmentThenCreate('disabled');
  const disabledFired = hookLines(disabled.logFile).length;
  const disabledSaysSo = /--no-hooks was passed/.test(disabled.out());
  disabled.rec.kill('SIGINT');
  await sleep(600);

  // --- 4. a second ⚡ mid-run must not start a second agent ---------------------
  // The hook sleeps, so it is still alive for the second click. Spawning again
  // would mean two agents draining one queue.
  const busy = await setup({ onCreate: 'SCRIPT', holdSeconds: 4 });
  await sleep(3000);
  await segmentThenCreate('first');
  await segmentThenCreate('second'); // ⚡ again while the first hook still runs
  const busyFired = hookLines(busy.logFile).length;
  const busySaysSo = /hook already running/.test(busy.out());
  const busyQueue = JSON.parse(
    fs.readFileSync(fs.readFileSync(path.join(busy.outDir, 'latest.txt'), 'utf8').trim() + '.queue.json', 'utf8')
  );
  busy.rec.kill('SIGINT');
  await sleep(600);

  await browser.close();

  const first = fired[0] || '';
  const checks = {
    // 1
    'no onCreate → nothing is spawned': plainFired === 0,
    'no onCreate → the request is still queued (durable as before)':
      Array.isArray(plainQueue) && plainQueue.length === 1 && plainQueue[0].scenario === 'no-hook',
    'no onCreate → startup says ⚡ dispatches nothing': plainSaysSo,
    'no onCreate → widget does not claim delivery, it says awaiting pickup':
      /awaiting pickup/.test(plainReadout),
    'no onCreate → the panel opens itself, unprompted': plainPanel.shown,
    'no onCreate → the panel says nothing is watching the queue':
      /Nothing is watching this queue/.test(plainPanel.text),
    'no onCreate → the panel names the queue file to point an agent at':
      /\.queue\.json/.test(plainPanel.text),
    'no onCreate → the panel gives the fix (onCreate)': /Set onCreate/.test(plainPanel.text),
    'no onCreate → quitting lists what was never converted':
      /1 queued scenario\(s\) not converted/.test(plainExit) && /· no-hook/.test(plainExit),
    'no onCreate → quitting says why, and what to do about it':
      /Nothing was watching the queue/.test(plainExit),

    // 2
    'onCreate set → ⚡ actually runs the command': fired.length === 1,
    'the hook is announced at startup': announced,
    'with a hook the widget does NOT say awaiting pickup': !/awaiting pickup/.test(hookedReadout),
    'hook gets FLOW_QUEUE_FILE pointing at the real queue file':
      /queue=\S+\.queue\.json/.test(first) &&
      fs.existsSync((first.match(/queue=(\S+)/) || [])[1] || ''),
    'hook gets the scenario name it must convert': /scenarios=with-hook,?/.test(first),
    'hook gets queue depth and how many were just added': /depth=1 added=1/.test(first),
    'hook gets the project root as cwd context': /root=\S+/.test(first),

    // 3
    '--no-hooks beats a configured command': disabledFired === 0,
    '--no-hooks is reported, not silent': disabledSaysSo,

    // 4
    'a second ⚡ does not spawn a second agent': busyFired === 1,
    'the skipped spawn is reported': busySaysSo,
    'both scenarios are still queued for the running agent to find':
      Array.isArray(busyQueue) && busyQueue.length === 2,
  };

  let ok = true;
  for (const [label, pass] of Object.entries(checks)) {
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + label);
    if (!pass) ok = false;
  }
  if (!ok) {
    console.log('\nreadouts: no-hook=' + JSON.stringify(plainReadout) + ' hooked=' + JSON.stringify(hookedReadout));
    console.log('\nhook log (case 2):\n' + fired.join('\n'));
    console.log('\nrecorder output (case 2):\n' + hooked.out().slice(-1500));
  }
  console.log(ok ? '\nONCREATE HOOK TEST PASSED' : '\nONCREATE HOOK TEST FAILED');
  process.exit(ok ? 0 : 1);
})().catch(async (e) => {
  if (browser) await browser.close().catch(() => {});
  console.error('oncreate hook test crashed: ' + e.message);
  process.exit(1);
});
