#!/usr/bin/env node
// Regression: a typed value must never be lost to the debounce.
//
// Typing is debounced (TYPE_DEBOUNCE, default 900ms) so one `type` event carries
// the final value instead of one per keystroke. But whatever ENDS the typing —
// Enter, a click on Save, tabbing away, the page navigating — usually happens
// well inside that window and destroys the field, or the whole document, before
// the timer fires. The pending emit then never ran: the value was gone from the
// stream entirely, leaving only the ⏹ snapshot, and only for fields still present
// on the final page. A search box or login form typed-then-submitted mid-flow left
// no trace of what was typed.
//
// Every case below types and then immediately ends the typing, inside the debounce
// window. All of them must still produce the `type` event — and produce it BEFORE
// the click/key that ended it, since the converter reads the stream in order.
//
//   node test/type-flush-test.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP_PORT = 9229;
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Comfortably inside the 900ms debounce: if the flush is missing, the timer has
// not fired yet and the event is simply absent.
const INSIDE_DEBOUNCE = 150;

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-typeflush-'));
  const browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=' + CDP_PORT] });
  const page = await browser.newPage();
  await page.setContent(`
    <div style="height:80px"></div><!-- keep targets clear of the top-centre widget -->
    <h2>Type flush page</h2>
    <input id="search" name="q" placeholder="Search" />
    <input id="merchant" placeholder="Merchant name" />
    <input id="secret" type="password" placeholder="Password" />
    <input id="other" placeholder="Somewhere else" />
    <input id="patient" placeholder="Typed then left alone" />
    <input id="leaving" placeholder="Typed then navigated away" />
    <button data-testid="save-btn">Save</button>
    <script>
      // Enter in the search box submits, exactly like a real search form.
      document.getElementById('search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.title = 'searched';
      });
    </script>
  `);

  const rec = spawn('node', [CLI, 'record', '--attach', String(CDP_PORT), '--out', outDir, '--name', 'typeflush'], {
    stdio: 'inherit',
  });
  await sleep(3000); // let it attach + inject

  await page.fill('#inp', 'type-flush-scenario');
  await page.click('#rec'); // ⏺ start the segment
  await sleep(200);

  // 1. ENTER — the case seen in the wild: type a search term, hit Enter immediately.
  await page.click('#search');
  await page.type('#search', 'vvsvsv');
  await sleep(INSIDE_DEBOUNCE);
  await page.keyboard.press('Enter');
  await sleep(200);

  // 2. CLICK ELSEWHERE — type, then hit Save before pausing.
  await page.click('#merchant');
  await page.type('#merchant', 'Starbucks');
  await sleep(INSIDE_DEBOUNCE);
  await page.click('[data-testid=save-btn]');
  await sleep(200);

  // 3. BLUR — type a password, then tab/click into another field. Masking must
  //    still apply on the flush path, not just the timer path.
  await page.click('#secret');
  await page.type('#secret', 'supersecret');
  await sleep(INSIDE_DEBOUNCE);
  await page.click('#other');
  await sleep(200);

  // 4. NO INTERRUPTION — the ordinary debounce path must still emit exactly once,
  //    and the flush must not turn one pause into several events.
  await page.click('#patient');
  await page.type('#patient', 'left alone');
  await sleep(1400); // past the debounce, untouched
  await page.click('h2'); // a later click must not re-emit an already-flushed value
  await sleep(200);

  // 5. NAVIGATION with no gesture to hang a flush on — the beforeunload/pagehide
  //    backstop is the only thing that can save this one. Must be a real
  //    cross-document navigation: a hash change keeps the document alive and
  //    never fires either event.
  const nextPage = path.join(outDir, 'next.html');
  fs.writeFileSync(nextPage, '<h1>gone</h1>');
  await page.click('#leaving');
  await page.type('#leaving', 'about to navigate');
  await sleep(INSIDE_DEBOUNCE);
  await page.goto('file://' + nextPage);
  await sleep(600);

  rec.kill('SIGINT');
  await sleep(800);
  await browser.close();

  const file = fs.readFileSync(path.join(outDir, 'latest.txt'), 'utf8').trim();
  const events = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const types = events.filter((e) => e.kind === 'type');
  const typed = (v) => types.filter((e) => e.value === v);
  const seqOf = (pred) => {
    const e = events.find(pred);
    return e ? e.seq : Infinity;
  };

  const checks = {
    // 1. Enter
    'value survives Enter pressed inside the debounce': typed('vvsvsv').length >= 1,
    'the type event precedes the Enter key event':
      seqOf((e) => e.kind === 'type' && e.value === 'vvsvsv') <
      seqOf((e) => e.kind === 'key' && e.value === 'Enter'),

    // 2. Click elsewhere
    'value survives a click on another element inside the debounce': typed('Starbucks').length >= 1,
    'the type event precedes the click that ended it':
      seqOf((e) => e.kind === 'type' && e.value === 'Starbucks') <
      seqOf((e) => e.kind === 'click' && (e.candidates || []).some((c) => c.sel === '[data-testid="save-btn"]')),

    // 3. Blur, with masking intact on the flush path
    'value survives leaving the field inside the debounce': types.some(
      (e) => (e.candidates || []).some((c) => c.sel === '#secret')
    ),
    'a flushed password is still masked': typed('***masked***').length >= 1 &&
      !events.some((e) => JSON.stringify(e).includes('supersecret')),

    // 4. Ordinary debounce path, and no double-emit
    'an uninterrupted pause still emits the value': typed('left alone').length >= 1,
    'flushing never double-emits a value': typed('left alone').length === 1 &&
      typed('vvsvsv').length === 1 && typed('Starbucks').length === 1,

    // 5. Unload backstop
    'value survives a navigation with no click or keypress to flush on':
      typed('about to navigate').length >= 1,
  };

  let ok = true;
  for (const [label, pass] of Object.entries(checks)) {
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + label);
    if (!pass) ok = false;
  }
  if (!ok) console.log('\nEvents were:\n' + events.map((e) => JSON.stringify(e)).join('\n'));
  console.log(ok ? '\nTYPE-FLUSH TEST PASSED' : '\nTYPE-FLUSH TEST FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('type-flush test crashed: ' + e.message);
  process.exit(1);
});
