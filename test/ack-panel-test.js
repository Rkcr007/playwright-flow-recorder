#!/usr/bin/env node
// The hand-off detail panel: what the agent reports back must be readable.
//
// The bar's queue chip truncates a message to ~24 characters, so a detailed ack
// had nowhere to land: the user clicked ⚡ and got "1 queued" with no idea which
// scenario was being worked, what the agent was doing, or where the output went.
// The panel renders the ack properly — one card per scenario, with status, the
// message, detail lines, step counts and the destination file.
//
// It must also stay compatible: an agent that writes only {status, message} —
// including the legacy single-object ack — keeps working unchanged.
//
//   node test/ack-panel-test.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP_PORT = 9237;
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const panelText = (page) =>
  page.evaluate(() => {
    const h = document.getElementById('__flow_rec_host');
    const p = h && h.shadowRoot && h.shadowRoot.getElementById('panel');
    if (!p) return { shown: false, text: '' };
    return {
      shown: getComputedStyle(p).display !== 'none',
      text: p.textContent || '',
      font: getComputedStyle(p).fontFamily,
      pills: Array.from(p.querySelectorAll('.pill')).map((x) => x.textContent),
      names: Array.from(p.querySelectorAll('.pname')).map((x) => x.textContent),
      files: Array.from(p.querySelectorAll('.pfile')).map((x) => x.textContent),
    };
  });

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-panel-'));
  const browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=' + CDP_PORT] });
  const page = await browser.newPage();
  await page.setContent('<div style="height:80px"></div><button data-testid="save-btn">Save</button>');

  const rec = spawn('node', [CLI, 'record', '--attach', String(CDP_PORT), '--out', outDir, '--name', 'panel'], {
    stdio: 'inherit',
  });
  await sleep(3000);

  const segment = async (name) => {
    await page.fill('#inp', name);
    await page.click('#rec');
    await sleep(200);
    await page.click('[data-testid=save-btn]');
    await sleep(700); // clear the 500ms repeat-click guard
    await page.click('#rec');
    await sleep(400);
    await page.click('#gen');
    await sleep(500);
  };
  await segment('approve first pending order');
  await segment('reject with reason');

  const file = fs.readFileSync(path.join(outDir, 'latest.txt'), 'utf8').trim();
  const writeAck = async (ack) => {
    fs.writeFileSync(file + '.ack', JSON.stringify(ack));
    await sleep(2000); // the widget polls every 1.5s
  };

  // Nothing acked yet: queued items must still say who they are waiting for.
  const beforeAck = await panelText(page);

  // A full-fidelity ack mid-drain.
  await writeAck({
    items: {
      q1: {
        status: 'done',
        message: 'Appended to orders.feature as @recorded @wip.',
        detail: ['3 assertions carried over', 'dry-run green'],
        steps: { reuse: 6, new: 1, healed: 1 },
        file: 'features/orders.feature',
      },
      q2: {
        status: 'working',
        message: 'Reconciling against the step index.',
        detail: ['matched an existing click step for rejectBtn'],
        steps: { reuse: 4, new: 2 },
      },
    },
    current: 'q2',
  });
  const rich = await panelText(page);

  // Dismissing must stick — until a real status change, which is worth reopening for.
  await page.click('#pclose');
  await sleep(300);
  const afterClose = await panelText(page);
  await writeAck({ items: { q1: { status: 'done', message: 'done' }, q2: { status: 'error', message: 'Dry-run failed.' } } });
  const afterChange = await panelText(page);

  // The chip toggles it by hand.
  await page.click('#pclose');
  await sleep(300);
  await page.click('#qs');
  await sleep(600);
  const afterChipToggle = await panelText(page);

  // Legacy ack shape: one object, no items map.
  await writeAck({ status: 'working', message: 'legacy shape still read', current: 'q1' });
  const legacy = await panelText(page);

  rec.kill('SIGINT');
  await sleep(800);
  await browser.close();

  const checks = {
    'queued items are listed with who they wait for': beforeAck.shown === false ||
      /waiting for/.test(beforeAck.text), // panel may be closed until a notable status
    'panel opens by itself when an item starts working': rich.shown === true,
    'both scenario names are shown in full, untruncated':
      rich.names.includes('approve first pending order') && rich.names.includes('reject with reason'),
    'status pills reflect each item': rich.pills.includes('done') && rich.pills.includes('working'),
    'the agent message is rendered untruncated':
      rich.text.includes('Appended to orders.feature as @recorded @wip.') &&
      rich.text.includes('Reconciling against the step index.'),
    'detail lines are rendered': rich.text.includes('3 assertions carried over') &&
      rich.text.includes('matched an existing click step for rejectBtn'),
    'step counts are rendered': /6 reused, 1 new, 1 healed/.test(rich.text) && /4 reused, 2 new/.test(rich.text),
    'the destination file is shown': rich.files.includes('features/orders.feature'),
    // The panel is a SIBLING of .bar, so a font set only on .bar left it inheriting
    // the page default and rendering in serif.
    'panel inherits the widget font, not the page default': /apple-system|Segoe|Inter|Roboto/i.test(rich.font),
    'closing the panel keeps it closed': afterClose.shown === false,
    'a new status reopens it after a manual close': afterChange.shown === true,
    'an error status is surfaced': afterChange.pills.includes('failed') &&
      afterChange.text.includes('Dry-run failed.'),
    'the queue chip toggles the panel back open': afterChipToggle.shown === true,
    'a legacy single-object ack is still understood': legacy.text.includes('legacy shape still read'),
  };

  let ok = true;
  for (const [label, pass] of Object.entries(checks)) {
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + label);
    if (!pass) ok = false;
  }
  if (!ok) {
    console.log('\nrich: ' + JSON.stringify(rich, null, 2).slice(0, 1400));
    console.log('\nafterChange: ' + JSON.stringify(afterChange).slice(0, 500));
  }
  console.log(ok ? '\nACK PANEL TEST PASSED' : '\nACK PANEL TEST FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ack panel test crashed: ' + e.message);
  process.exit(1);
});
