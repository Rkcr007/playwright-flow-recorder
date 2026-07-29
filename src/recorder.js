#!/usr/bin/env node
// flow-recorder — capture a browser walkthrough as a JSONL event stream.
//
//   flow-recorder record [--attach <port>] [--launch] [--headless]
//                        [--url <startUrl>] [--out <dir>] [--name <session>]
//
// Recording is SEGMENT-BASED: the session is idle from the moment it attaches.
// Nothing is captured until you press ⏺ in the on-page widget, so logins and
// navigation preambles never end up in the stream.
//
// Output: <outDir>/<name>-<timestamp>.jsonl  (+ <outDir>/latest.txt pointer,
//         plus <file>.queue.json and <file>.ack sidecars for agent hand-off)

const fs = require('fs');
const path = require('path');
const { loadConfig, makeFlag, pageConfig } = require('./config');

const PW_MISSING =
  'flow-recorder needs Playwright.\n' +
  '  In your project:   npm i -D playwright  &&  npx playwright install chromium\n' +
  '  Or run standalone: npx playwright-flow-recorder record   (bundles playwright-core)';

const loadPlaywright = () => {
  for (const mod of ['playwright', 'playwright-core']) {
    try {
      return require(mod);
    } catch (_) {
      /* try the next one */
    }
  }
  console.error(PW_MISSING);
  process.exit(1);
};

const HELP = `
flow-recorder record — record a browser walkthrough as a JSONL event stream

Usage
  flow-recorder record [options]

Options
  --attach <port>   Attach to a Chrome already listening for CDP (default: config attachPort, 9222)
  --launch          Skip attaching; launch a fresh Playwright browser instead
  --headless        With --launch, run headless (for CI)
  --url <url>       Open this URL after connecting
  --out <dir>       Where to write recordings (default: .flow-recorder/recordings)
  --name <name>     Session file prefix (default: "session")
  -h, --help        Show this help

Attach mode is recommended: it uses YOUR browser, so existing logins persist.
Start one with:  flow-recorder chrome
`;

const record = async (argv = []) => {
  const flag = makeFlag(argv);
  if (flag('help', false) || argv.includes('-h')) {
    console.log(HELP.trim());
    return;
  }

  const loaded = loadConfig({
    overrides: {
      attachPort: flag('attach', undefined) === true ? undefined : flag('attach', undefined),
      startUrl: flag('url', undefined),
    },
  });
  const cfg = loaded.cfg;
  const pw = loadPlaywright();

  const doLaunch = !!flag('launch', false);
  const headless = !!flag('headless', false);
  const port = Number(cfg.attachPort) || 9222;
  const url = typeof cfg.startUrl === 'string' && cfg.startUrl ? cfg.startUrl : null;
  // Flags are relative to where the user is standing; config paths to the project root.
  const outFlag = flag('out', null);
  const outDir = outFlag && outFlag !== true ? path.resolve(process.cwd(), String(outFlag)) : loaded.outDir;
  const name = String(flag('name', 'session')).replace(/[^\w.-]/g, '_') || 'session';

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(outDir, name + '-' + stamp + '.jsonl');

  // --- agent hand-off sidecars -------------------------------------------------
  // <file>.ack       written by the AGENT: per-item conversion status.
  //                  {"items":{"q1":{"status":"working","message":"…"}},"current":"q1"}
  //                  (a legacy single-object {"status","message"} ack is still read)
  // <file>.queue.json written by the RECORDER: durable list of ⚡ create requests.
  // The widget shows a merge of the two, so the user always sees where each
  // scenario is. Two writers, two files, no locking needed.
  const ackFile = file + '.ack';
  const readAck = () => {
    try {
      return JSON.parse(fs.readFileSync(ackFile, 'utf8'));
    } catch (_) {
      return null;
    }
  };
  const queueFile = file + '.queue.json';
  const persistQueue = (queue) => {
    try {
      fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2) + '\n');
    } catch (_) {}
  };
  fs.writeFileSync(path.join(outDir, 'latest.txt'), file + '\n');

  let seq = 0;
  const write = (evt) => {
    seq += 1;
    fs.appendFileSync(file, JSON.stringify({ seq, t: new Date().toISOString(), ...evt }) + '\n');
    const what = evt.note || evt.label || evt.text || evt.value || '';
    console.log('  ' + String(seq).padStart(4) + '  ' + String(evt.kind).padEnd(8) + ' ' + String(what).slice(0, 70));
  };

  const launchFresh = async () => {
    try {
      return await pw.chromium.launch({ headless, args: ['--start-maximized'] });
    } catch (e) {
      console.error('\nCould not launch a browser: ' + e.message);
      console.error('If the browser binary is missing, install it with:  npx playwright install chromium');
      process.exit(1);
    }
  };

  let browser;
  let launched = false;
  if (doLaunch) {
    browser = await launchFresh();
    launched = true;
  } else {
    try {
      // 127.0.0.1, not "localhost": on hosts that resolve localhost to ::1 first,
      // Chrome's CDP listener (IPv4-only by default) is missed entirely.
      browser = await pw.chromium.connectOverCDP('http://127.0.0.1:' + port);
      console.log('Attached to the browser on CDP port ' + port + '.');
    } catch (_) {
      console.log('\n' + '─'.repeat(68));
      console.log('No browser is listening for CDP on port ' + port + '.');
      console.log('Launching a temporary browser instead — it starts logged OUT.');
      console.log('To record in your own logged-in browser, quit this and run:');
      console.log('    flow-recorder chrome            (starts Chrome on port ' + port + ')');
      console.log('    flow-recorder record            (then attach)');
      console.log('─'.repeat(68) + '\n');
      browser = await launchFresh();
      launched = true;
    }
  }

  // The in-page script is injected as ONE expression so the same string works for
  // both addInitScript (future pages) and page.evaluate (already-open pages).
  const rawInject = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8').trim().replace(/;\s*$/, '');
  const injectSrc =
    '(function(){window.__flowRecorderConfig=' + JSON.stringify(pageConfig(cfg)) + ';' + rawInject + ';})()';

  // Recording is segment-based: idle until the user hits ⏺ in the widget.
  // State lives here (not in the page) so it survives navigations and origin changes.
  const state = {
    recording: false,
    scenario: null,
    segments: 0,
    suppressedClicks: 0,
    segmentNames: [], // scenario name per stopped segment, in order
    queue: [], // enqueued conversion requests: {id, scenario, segment, status, enqueuedAt}
  };
  let qseq = 0;

  const wireContext = async (context) => {
    await context
      .exposeBinding('__flowRecorderEmit', ({ page }, payload) => {
        try {
          const evt = JSON.parse(payload);
          if (evt.kind === 'marker' && evt.value === 'recording-start') {
            state.recording = true;
            state.scenario = evt.note || null;
            state.suppressedClicks = 0;
            console.log('\n  ⏺ recording segment: ' + (state.scenario || '(unnamed)'));
          } else if (evt.kind === 'marker' && evt.value === 'recording-stop') {
            state.recording = false;
            state.segments += 1;
            state.segmentNames.push(state.scenario || 'scenario-' + state.segments);
            console.log('  ⏹ segment stopped (' + state.segments + ' total)\n');
          } else if (evt.kind === 'marker' && evt.value === 'create-scenario') {
            // Enqueue every stopped-but-not-yet-queued segment. Durable: the queue
            // file survives even if the agent isn't watching this instant, so the ⚡
            // click is never lost — it's drained on the agent's next wake.
            let added = 0;
            for (let i = state.queue.length; i < state.segmentNames.length; i++) {
              qseq += 1;
              state.queue.push({
                id: 'q' + qseq,
                scenario: state.segmentNames[i],
                segment: i + 1,
                status: 'queued',
                enqueuedAt: new Date().toISOString(),
              });
              added += 1;
            }
            persistQueue(state.queue);
            const pending = state.queue.filter((q) => q.status !== 'done').length;
            console.log(
              '  ⚡ create — enqueued ' + added + ' (queue depth ' + pending + ', ' + path.basename(queueFile) + ')\n'
            );
          }
          // A widget that could not mount is exactly what the user is staring at
          // when they say "I see no HUD" — surface it loudly, and never gate it on
          // `recording`, since without the widget they cannot start a segment.
          if (evt.kind === 'warning' && String(evt.value).startsWith('widget-')) {
            console.log('\n  ⚠ the on-page widget did not appear: ' + (evt.note || evt.value));
            console.log('    Try a normal app page — browser-internal pages block injection.\n');
            write({ ...evt, url: page.url() });
            return;
          }
          // markers + notes always land; interaction events only while recording
          if (!state.recording && evt.kind !== 'marker' && evt.kind !== 'note') {
            // forgot-⏺ detection: sustained clicking while idle is usually a
            // user who thinks they're recording. Warn once per idle period.
            if (evt.kind === 'click') {
              state.suppressedClicks += 1;
              if (state.suppressedClicks === 15) {
                write({
                  kind: 'warning',
                  value: 'idle-activity',
                  note: '15+ clicks while NOT recording — user may have forgotten ⏺',
                });
                console.log('  ⚠ 15+ clicks while idle — forgot ⏺?');
              }
            }
            return;
          }
          write({ ...evt, url: page.url() });
        } catch (_) {}
      })
      .catch(() => {});
    await context
      .exposeBinding('__flowRecorderState', () => {
        // Merge the recorder-owned queue (what was requested) with the agent's ack
        // status map (how far each conversion has got) into one view for the widget.
        const ack = readAck() || {};
        const items = ack.items || {};
        // Legacy single-object ack → treat as status for the current working item.
        const legacy = !ack.items && ack.status ? ack : null;
        const queue = state.queue.map((q) => {
          const st = items[q.id] || (legacy && q.id === ack.current ? legacy : null);
          return {
            id: q.id,
            scenario: q.scenario,
            segment: q.segment,
            status: (st && st.status) || q.status,
            message: (st && st.message) || '',
          };
        });
        return { recording: state.recording, scenario: state.scenario, segments: state.segments, queue };
      })
      .catch(() => {});
    // Future pages / navigations get the script automatically…
    await context.addInitScript(injectSrc).catch(() => {});
    // …already-open pages need it evaluated once now.
    for (const page of context.pages()) {
      await page.evaluate(injectSrc).catch(() => {});
    }
    context.on('page', async (page) => {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.evaluate(injectSrc).catch(() => {});
    });
    // Network capture during segments only: which API calls the flow triggers.
    // Lets the converter generate response-based waits instead of sleeps, and
    // spot seeding needs. XHR/fetch only, deduped, method + path + status, no bodies.
    if (cfg.captureNetwork !== false) {
      let lastNet = { key: '', ts: 0 };
      context.on('response', (res) => {
        try {
          if (!state.recording) return;
          const req = res.request();
          const rt = req.resourceType();
          if (rt !== 'xhr' && rt !== 'fetch') return;
          const u = new URL(req.url());
          const key = req.method() + ' ' + u.pathname;
          const now = Date.now();
          if (key === lastNet.key && now - lastNet.ts < 2000) return; // polling dedupe
          lastNet = { key, ts: now };
          write({
            kind: 'net',
            value: req.method() + ' ' + (u.pathname + u.search).slice(0, 140),
            status: res.status(),
          });
        } catch (_) {}
      });
    }
  };

  let context = browser.contexts()[0];
  if (!context) context = await browser.newContext({ viewport: null });
  for (const c of browser.contexts()) await wireContext(c);

  // A freshly launched browser has ZERO pages, and a context with no page renders
  // no window at all — so with no startUrl the user got an invisible browser, no
  // widget, and a session file containing nothing but session-start. Always make
  // sure one page exists: blank when there is no startUrl, which still carries the
  // widget and gives an address bar to navigate from (addInitScript re-injects on
  // every navigation).
  const page = context.pages()[0] || (await context.newPage());
  if (url) {
    await page.goto(url).catch((e) => console.log('Could not open ' + url + ': ' + e.message));
  }

  write({ kind: 'marker', value: 'session-start', note: name });
  console.log('\nSession file: ' + file);
  if (loaded.configFile) console.log('Config:       ' + loaded.configFile);
  else console.log('Config:       (none — using defaults; run `flow-recorder init` to add one)');
  console.log('\nIDLE — nothing is captured until you press ⏺ record in the on-page widget (top-centre).');
  console.log('  ⏺  name + start a scenario segment      ⏹  end it (same button)');
  console.log('  ✎  note / intent                        ⌥/Alt+Click  assert an element');
  console.log('  ⚡  queue the finished segment(s) for ' + (cfg.agentName || 'the AI agent'));
  console.log('  ⠿  drag the widget out of the way       Ctrl+C  finish the session\n');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    write({ kind: 'marker', value: 'session-end' });
    console.log('\nRecording saved: ' + file);
    if (launched) await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  browser.on('disconnected', () => {
    if (stopping) return;
    console.log('\nBrowser closed — recording saved: ' + file);
    process.exit(0);
  });
};

module.exports = { record, HELP };

if (require.main === module) {
  record(process.argv.slice(2)).catch((e) => {
    console.error('flow-recorder failed: ' + e.message);
    process.exit(1);
  });
}
