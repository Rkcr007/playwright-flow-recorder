#!/usr/bin/env node
// Two recorders, one output directory.
//
// Easy to do by accident: a forgotten session in another terminal tab, or a
// second `record` started because the first seemed unresponsive. Both attach to
// the same browser, both capture every click, and `latest.txt` — the pointer an
// agent follows — names whichever started last. The user sees one HUD and assumes
// one recording; the agent converts a duplicate or the wrong session, and it reads
// as a recorder bug.
//
// The second session is warned, loudly, and told how to keep itself separate. A
// crashed session must not lock the directory forever, so the lock is validated
// against a live pid rather than mere existence.
//
//   node test/concurrent-test.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP_PORT = 9241;
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const start = (dir, name, extra = []) => {
  const rec = spawn('node', [CLI, 'record', '--attach', String(CDP_PORT), '--name', name, ...extra], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  rec.stdout.on('data', (d) => (out += d));
  rec.stderr.on('data', (d) => (out += d));
  return { rec, out: () => out };
};

let browser;
(async () => {
  browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=' + CDP_PORT] });
  const page = await browser.newPage();
  await page.setContent('<div style="height:80px"></div><button data-testid="b">Save</button>');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-conc-'));
  fs.writeFileSync(path.join(dir, 'flow-recorder.config.json'), JSON.stringify({ outDir: 'rec' }));
  const recDir = path.join(dir, 'rec');

  // --- 1. first session takes the lock ----------------------------------------
  const a = start(dir, 'alpha');
  await sleep(3000);
  const lockAfterFirst = fs.existsSync(path.join(recDir, '.session.lock'));
  const firstWarned = /already recording into this directory/.test(a.out());

  // --- 2. second session into the same dir is warned --------------------------
  const b = start(dir, 'beta');
  await sleep(3000);
  const secondWarned = /already recording into this directory/.test(b.out());
  const namesTheOther = /alpha-/.test(b.out());
  const offersFix = /--out/.test(b.out());
  b.rec.kill('SIGINT');
  await sleep(700);

  // The second session exiting must NOT release the first session's lock.
  const lockSurvivesOther = fs.existsSync(path.join(recDir, '.session.lock'));
  const lockStillFirst = JSON.parse(fs.readFileSync(path.join(recDir, '.session.lock'), 'utf8')).pid === a.rec.pid;

  a.rec.kill('SIGINT');
  await sleep(700);
  const lockReleased = !fs.existsSync(path.join(recDir, '.session.lock'));

  // --- 3. a stale lock from a dead process must not block anyone ---------------
  fs.writeFileSync(
    path.join(recDir, '.session.lock'),
    JSON.stringify({ pid: 999999, file: 'ghost.jsonl', startedAt: new Date().toISOString() })
  );
  const c = start(dir, 'gamma');
  await sleep(3000);
  const staleIgnored = !/already recording into this directory/.test(c.out());
  const retook = JSON.parse(fs.readFileSync(path.join(recDir, '.session.lock'), 'utf8')).pid === c.rec.pid;
  c.rec.kill('SIGINT');
  await sleep(700);

  // --- 4. --out keeps a second session genuinely separate ----------------------
  const d1 = start(dir, 'one');
  await sleep(2500);
  const sep = path.join(dir, 'separate');
  const d2 = start(dir, 'two', ['--out', sep]);
  await sleep(3000);
  const separateIsQuiet = !/already recording into this directory/.test(d2.out());
  d1.rec.kill('SIGINT');
  d2.rec.kill('SIGINT');
  await sleep(700);

  await browser.close();

  const checks = {
    'the first session takes the lock': lockAfterFirst,
    'the first session is not warned about itself': !firstWarned,
    'a second session into the same dir IS warned': secondWarned,
    'the warning names the session already running': namesTheOther,
    'the warning says how to keep them separate (--out)': offersFix,
    'a second session exiting leaves the first lock alone': lockSurvivesOther && lockStillFirst,
    'the holding session releases its lock on exit': lockReleased,
    'a stale lock from a dead pid does not block a new session': staleIgnored,
    'the new session takes over the stale lock': retook,
    '--out into a different dir is not treated as a clash': separateIsQuiet,
  };

  let ok = true;
  for (const [label, pass] of Object.entries(checks)) {
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + label);
    if (!pass) ok = false;
  }
  if (!ok) console.log('\nsecond session output:\n' + b.out().slice(0, 1200));
  console.log(ok ? '\nCONCURRENT SESSION TEST PASSED' : '\nCONCURRENT SESSION TEST FAILED');
  process.exit(ok ? 0 : 1);
})().catch(async (e) => {
  if (browser) await browser.close().catch(() => {});
  console.error('concurrent test crashed: ' + e.message);
  process.exit(1);
});
