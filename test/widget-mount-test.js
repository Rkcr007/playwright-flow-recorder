#!/usr/bin/env node
// Regression test for the two ways the on-page widget could fail to appear —
// both of which looked identical from the user's side ("recorder says attached,
// but there's no HUD") and left a session file containing only session-start.
//
//   1. TRUSTED TYPES. The widget used to be built with `root.innerHTML = ...`.
//      Any document sending `require-trusted-types-for 'script'` (Chrome's own
//      chrome:// pages, and plenty of hardened production apps) throws a
//      TypeError on that assignment — aborting makeWidget BEFORE the host was
//      appended. A named trustedTypes policy is not a workaround: strict
//      allow-lists reject createPolicy too. The widget is now built with
//      createElement/textContent, which Trusted Types never gates.
//
//   2. NO PAGE AT ALL. `record --launch` (and the automatic fallback when
//      nothing is listening on the CDP port) starts a browser with ZERO pages.
//      With no startUrl configured, nothing ever opened one, so the context
//      rendered no window — no browser, no widget, nothing to click.
//
//   node test/widget-mount-test.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP_PORT = 9227;
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (cond, label, detail) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (cond || !detail ? '' : '   → ' + detail));
  if (!cond) failures++;
};

// What the widget looks like from the page's point of view.
const probe = (page) =>
  page
    .evaluate(() => {
      const h = document.getElementById('__flow_rec_host');
      const bar = h && h.shadowRoot && h.shadowRoot.querySelector('.bar');
      const r = bar && bar.getBoundingClientRect();
      return {
        installed: !!window.__flowRecorderInstalled,
        host: !!h,
        buttons: h ? Array.from(h.shadowRoot.querySelectorAll('button')).map((b) => b.textContent) : [],
        width: r ? Math.round(r.width) : 0,
      };
    })
    .catch((e) => ({ error: e.message.split('\n')[0] }));

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-mount-'));
  const browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=' + CDP_PORT] });

  // A page that enforces Trusted Types, exactly as a hardened app would.
  const page = await browser.newPage();
  await page.route('**/tt-page*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'Content-Security-Policy': "require-trusted-types-for 'script'" },
      body: '<!doctype html><title>TT</title><div style="height:80px"></div><button id="b">Go</button>',
    })
  );
  await page.goto('https://example.test/tt-page');

  const enforced = await page.evaluate(() => {
    try {
      document.createElement('div').attachShadow({ mode: 'open' }).innerHTML = '<i>x</i>';
      return false;
    } catch (_) {
      return true;
    }
  });
  ok(enforced, 'the test page really does enforce Trusted Types', 'innerHTML was allowed — test is not proving anything');

  const rec = spawn('node', [CLI, 'record', '--attach', String(CDP_PORT), '--out', outDir, '--name', 'mount'], {
    stdio: 'inherit',
  });
  await sleep(3000); // attach + inject

  // The already-open page is injected via page.evaluate…
  let w = await probe(page);
  ok(w.host, 'widget mounts on a Trusted-Types page', JSON.stringify(w));
  ok(w.width > 0, 'widget bar has real width (it is actually visible)', JSON.stringify(w));
  ok(
    ['⏺ record', '✎ note', '⚡ create'].every((t) => w.buttons.includes(t)),
    'widget has its ⏺ / ✎ / ⚡ controls',
    JSON.stringify(w.buttons)
  );

  // …and it must survive a navigation into another Trusted-Types document,
  // which is the path that goes through addInitScript rather than evaluate.
  await page.goto('https://example.test/tt-page?second');
  await sleep(1200);
  w = await probe(page);
  ok(w.host, 'widget re-mounts after navigating within a Trusted-Types app', JSON.stringify(w));

  // The widget must be usable, not merely present: drive a whole segment
  // through it and check the events actually reached the recorder.
  await page.fill('#inp', 'tt-scenario');
  await page.click('#rec');
  await sleep(300);
  await page.click('#b');
  await sleep(300);
  await page.click('#rec'); // stop
  await sleep(600);

  rec.kill('SIGINT');
  await sleep(800);

  const file = fs.readFileSync(path.join(outDir, 'latest.txt'), 'utf8').trim();
  const events = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

  const started = events.find((e) => e.kind === 'marker' && e.value === 'recording-start');
  ok(started && started.note === 'tt-scenario', 'a segment can be started from the Trusted-Types widget');
  ok(
    events.some((e) => e.kind === 'click' && e.candidates && e.candidates.some((c) => c.sel === '#b')),
    'clicks inside the segment are captured'
  );
  ok(
    !events.some((e) => e.kind === 'warning' && String(e.value).startsWith('widget-')),
    'no widget-failure warning was emitted',
    JSON.stringify(events.filter((e) => e.kind === 'warning'))
  );

  await browser.close();

  // --- 2. the launch path must always produce a visible page ------------------
  // Mirrors recorder.js: launch → reuse-or-create context → ensure a page.
  // Before the fix this ended with zero pages and no window at all.
  const launched = await chromium.launch({ headless: true });
  let ctx = launched.contexts()[0];
  if (!ctx) ctx = await launched.newContext({ viewport: null });
  ok(ctx.pages().length === 0, 'a freshly launched browser genuinely starts with no pages');
  const ensured = ctx.pages()[0] || (await ctx.newPage());
  ok(ctx.pages().length === 1, 'recorder ensures a page exists even with no startUrl');
  ok(!!ensured, 'that page is a real, renderable page — the window (and widget) can show');
  await launched.close();

  fs.rmSync(outDir, { recursive: true, force: true });

  if (failures) {
    console.error('\nWIDGET MOUNT TEST FAILED (' + failures + ')');
    process.exit(1);
  }
  console.log('\nWIDGET MOUNT TEST PASSED');
})().catch((e) => {
  console.error('widget mount test error: ' + e.stack);
  process.exit(1);
});
