#!/usr/bin/env node
// End-to-end verification of the recorder without a visible browser.
//
// Launches headless Chromium with a CDP port, attaches the real CLI to it,
// simulates a complete session — idle clicks, a ⏺ segment with clicks / typing /
// a ✎ note / an ⌥Alt+Click assert, ⏹, a second segment, two ⚡ create clicks —
// then asserts the JSONL stream contains exactly what it should and nothing it
// shouldn't (no idle events, no plaintext passwords).
//
//   node test/smoke-test.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP_PORT = 9223;
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrec-smoke-'));
  const browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=' + CDP_PORT] });
  const page = await browser.newPage();
  await page.setContent(`
    <div style="height:80px"></div><!-- keep targets clear of the top-centre widget -->
    <h2>Smoke page</h2>
    <button id="pre">Before recording</button>
    <button data-testid="save-btn">Save</button>
    <input placeholder="Merchant name" />
    <input type="password" placeholder="Password" />
    <select name="team"><option>Alpha</option><option>Beta</option></select>
    <table><thead><tr><th>Merchant</th><th>Amount</th></tr></thead>
      <tbody>
        <tr><td id="cell-a">Starbucks</td><td>42.00</td></tr>
        <tr><td>Costa</td><td>17.50</td></tr>
      </tbody></table>
  `);

  // Run the real CLI, not the module — this also covers command dispatch.
  const rec = spawn('node', [CLI, 'record', '--attach', String(CDP_PORT), '--out', outDir, '--name', 'smoke'], {
    stdio: 'inherit',
  });
  await sleep(3000); // let it attach + inject

  // idle phase — must NOT be captured; 16 clicks also triggers the forgot-⏺ warning
  for (let i = 0; i < 16; i++) await page.click('#pre');
  await sleep(300);

  // start a segment via the widget (shadow DOM — Playwright pierces it):
  // type the name, then ONE click on ⏺
  await page.fill('#inp', 'smoke-scenario');
  await page.click('#rec');

  // ✎ note flow: click ✎, type into the box, ⏎ — must land as a `note` event
  await page.click('#note');
  await page.fill('#inp', 'this dropdown is flaky');
  await page.keyboard.press('Enter');
  await sleep(200);

  // recorded phase
  await page.click('[data-testid=save-btn]');
  await page.fill('input[placeholder="Merchant name"]', 'Starbucks');
  await page.fill('input[type=password]', 'supersecret');
  await page.selectOption('select', 'Beta');
  // ⌥/Alt+Click opens the assert palette; pick "is visible"
  await page.click('h2', { modifiers: ['Alt'] });
  await page.click('#p_vis');
  // ⌥/Alt+Click a table cell; dismiss palette with Escape → default text assert with row context
  await page.click('#cell-a', { modifiers: ['Alt'] });
  await page.keyboard.press('Escape');
  await sleep(1600); // let the type debounce flush

  // stop the segment, then click again — must NOT be captured
  await page.click('#rec');
  await sleep(300);
  await page.click('#pre');
  await sleep(300);
  await page.click('#gen'); // ⚡ — enqueues segment 1
  await sleep(300);

  // second scenario → second ⚡: the queue must accumulate, not overwrite
  await page.fill('#inp', 'second-scenario');
  await page.click('#rec');
  await page.click('[data-testid=save-btn]');
  await sleep(700); // clear the 500ms rapid-⏺ debounce before stopping
  await page.click('#rec'); // stop segment 2
  await sleep(300);
  await page.click('#gen'); // ⚡ — enqueues segment 2
  await sleep(300);

  // durable queue file should now hold BOTH requests
  const file = fs.readFileSync(path.join(outDir, 'latest.txt'), 'utf8').trim();
  const queue = JSON.parse(fs.readFileSync(file + '.queue.json', 'utf8'));

  // simulate the agent draining one-by-one: write a per-item ack status map and confirm
  // the widget's Node-side state merges it (so the on-page readout can show progress).
  fs.writeFileSync(
    file + '.ack',
    JSON.stringify({
      items: { q1: { status: 'done', message: 'added to X.feature' }, q2: { status: 'working', message: 'converting…' } },
      current: 'q2',
    })
  );
  await sleep(200);
  const mergedState = await page.evaluate(() => window.__flowRecorderState());

  rec.kill('SIGINT');
  await sleep(800);
  await browser.close();

  const events = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const kinds = (k) => events.filter((e) => e.kind === k);

  const checks = {
    'idle clicks NOT captured (before/after segment)': !kinds('click').some((e) =>
      (e.candidates || []).some((c) => c.sel === '#pre')
    ),
    'recording-start marker with scenario name': events.some(
      (e) => e.kind === 'marker' && e.value === 'recording-start' && e.note === 'smoke-scenario'
    ),
    'recording-stop marker present': events.some((e) => e.kind === 'marker' && e.value === 'recording-stop'),
    'in-segment click captured with data-testid candidate': kinds('click').some((e) =>
      (e.candidates || []).some((c) => c.by === 'data-testid' && c.sel === '[data-testid="save-btn"]')
    ),
    'typed value captured': kinds('type').some((e) => e.value === 'Starbucks'),
    'password masked': kinds('type').some((e) => e.value === '***masked***') &&
      !events.some((e) => JSON.stringify(e).includes('supersecret')),
    'select captured': kinds('select').some((e) => e.value === 'Beta'),
    'palette assert with predicate=visible': kinds('assert').some(
      (e) => e.text === 'Smoke page' && e.predicate === 'visible'
    ),
    'dismissed palette defaults to text assert with row context': kinds('assert').some(
      (e) => e.predicate === 'text' && e.row && e.row.rowIndex === 1 && e.row.rowCount === 2 &&
        e.row.colHeader === 'Merchant' && (e.row.cells || []).includes('42.00')
    ),
    'forgot-⏺ warning after sustained idle clicking': events.some(
      (e) => e.kind === 'warning' && e.value === 'idle-activity'
    ),
    'recording-start marker carries page snapshot': events.some(
      (e) => e.value === 'recording-start' && e.snapshot && (e.snapshot.headings || []).includes('Smoke page')
    ),
    'recording-stop snapshot has final field values (masked)': events.some(
      (e) => e.value === 'recording-stop' && e.snapshot && (e.snapshot.fields || []).some((f) => f.value === 'Starbucks') &&
        (e.snapshot.fields || []).some((f) => f.value === '***masked***')
    ),
    'element state captured on interactions': kinds('click').some(
      (e) => e.state && e.state.enabled === true && e.state.visible === true
    ),
    'create-scenario marker present': events.some((e) => e.kind === 'marker' && e.value === 'create-scenario'),
    '✎ note flow captured as note event': kinds('note').some((e) => e.note === 'this dropdown is flaky'),
    'second segment recorded with its scenario name': events.some(
      (e) => e.value === 'recording-start' && e.note === 'second-scenario'
    ),
    'durable queue accumulates BOTH scenarios (not overwritten)': Array.isArray(queue) && queue.length === 2 &&
      queue[0].scenario === 'smoke-scenario' && queue[1].scenario === 'second-scenario' &&
      queue.every((q) => q.id && q.status === 'queued'),
    'widget state merges agent ack statuses per item': mergedState && Array.isArray(mergedState.queue) &&
      mergedState.queue.length === 2 &&
      mergedState.queue.find((q) => q.id === 'q1' && q.status === 'done') &&
      mergedState.queue.find((q) => q.id === 'q2' && q.status === 'working'),
  };

  let ok = true;
  for (const [label, pass] of Object.entries(checks)) {
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + label);
    if (!pass) ok = false;
  }
  if (!ok) console.log('\nEvents were:\n' + events.map((e) => JSON.stringify(e)).join('\n'));
  console.log(ok ? '\nSMOKE TEST PASSED (' + events.length + ' events, ' + file + ')' : '\nSMOKE TEST FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('smoke test crashed: ' + e.message);
  process.exit(1);
});
