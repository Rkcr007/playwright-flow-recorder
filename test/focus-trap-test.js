#!/usr/bin/env node
// Regression: the widget's scenario-name / ✎ note box must stay typeable while an
// app dialog with a focus-trap (Radix / React FocusScope / MUI / Headless UI) is
// open. Such a trap installs a CAPTURE-phase document focusin handler that yanks
// focus back inside itself the moment focus lands outside — which used to make the
// widget box impossible to type into (names came out empty, notes never landed).
//
// This test proves the fix DIFFERENTIALLY, in one page:
//   • a plain page input outside the dialog → trap DOES steal its focus (trap is real)
//   • the widget's note box                 → trap does NOT steal it (guard works)
//
//   node test/focus-trap-test.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP_PORT = 9225;
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-trap-'));
  const browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=' + CDP_PORT] });
  const page = await browser.newPage();
  await page.setContent(`
    <div style="height:80px"></div>
    <input id="outside" placeholder="outside dialog" />
    <div id="dlg" role="dialog" aria-modal="true">
      <h3>Detail drawer</h3>
      <input id="inside" placeholder="memo" />
    </div>
  `);

  const rec = spawn('node', [CLI, 'record', '--attach', String(CDP_PORT), '--out', outDir, '--name', 'trap'], {
    stdio: 'inherit',
  });
  await sleep(3000); // attach + inject widget + focusGuard (BEFORE the trap mounts)

  // Mount a Radix-like focus-trap AFTER injection, exactly as a real app would when
  // a drawer opens. Capture-phase focusin on document; pulls focus back in.
  await page.evaluate(() => {
    const dlg = document.getElementById('dlg');
    const inside = document.getElementById('inside');
    inside.focus();
    document.addEventListener(
      'focusin',
      (e) => { if (!dlg.contains(e.target)) inside.focus(); },
      true
    );
    window.__trapActive = true;
  });

  // Control: a normal outside input MUST be stolen by the trap (confirms it's live).
  await page.click('#outside');
  await sleep(150);
  const outsideStolen = await page.evaluate(() => document.activeElement && document.activeElement.id === 'inside');

  // The widget note box must NOT be stolen: ✎ note → type → ⏎ lands as a note event.
  await page.click('#note');
  await sleep(150);
  await page.keyboard.type('trap-proof note');
  await page.keyboard.press('Enter');
  await sleep(300);

  // And the dialog's own input must NOT have swallowed the widget's keystrokes.
  const insideValue = await page.evaluate(() => document.getElementById('inside').value);

  rec.kill('SIGINT');
  await sleep(600);
  await browser.close();

  const file = fs.readFileSync(path.join(outDir, 'latest.txt'), 'utf8').trim();
  const events = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const noteLanded = events.some((e) => e.kind === 'note' && e.note === 'trap-proof note');

  const checks = {
    'trap is real: plain outside input gets its focus stolen': outsideStolen === true,
    'widget note box keeps focus over the trap: note event captured': noteLanded,
    "widget keystrokes did NOT leak into the dialog's own input": insideValue !== 'trap-proof note',
  };
  let ok = true;
  for (const [label, pass] of Object.entries(checks)) {
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + label);
    if (!pass) ok = false;
  }
  if (!ok) console.log('\nEvents were:\n' + events.map((e) => JSON.stringify(e)).join('\n'));
  console.log(ok ? '\nFOCUS-TRAP TEST PASSED' : '\nFOCUS-TRAP TEST FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('focus-trap test crashed: ' + e.message);
  process.exit(1);
});
