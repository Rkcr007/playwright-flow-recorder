// flow-recorder in-page capture script.
// Injected into every page by recorder.js. Captures user interactions and
// streams them to the Node side via the __flowRecorderEmit binding.
//
// Framework-agnostic by design: this file knows nothing about Cucumber, page
// objects, locator files, or any test runner. It only describes what the user
// did, as richly as possible. All framework knowledge lives in your config's
// `conventions` block and is consumed by the AI converter, never here.
//
// Runtime settings arrive as window.__flowRecorderConfig (see src/config.js →
// pageConfig): { maskPattern, typeDebounceMs, agentName }.
(() => {
  const CFG = window.__flowRecorderConfig || {};

  // --- install guard (version-aware) ---
  // The recorder re-injects into pages that are ALREADY OPEN when it attaches
  // (recorder.js does addInitScript for future pages AND page.evaluate for
  // existing ones). A plain "already installed → bail" guard turned that second
  // path into a no-op: restart the recorder after editing this file and every
  // open tab silently kept running the OLD script until someone reloaded it.
  // Worse, the stale instance kept emitting through the freshly bound
  // __flowRecorderEmit, so it looked like it was working.
  //
  // scriptVersion is a hash of this file's source AND the config it was injected
  // with (see recorder.js) — a stale config is as wrong as stale code. Same build →
  // leave the healthy instance alone, which is the common case since both inject
  // paths can fire on one page. Different build → tear the old instance down and
  // install this one. Without the teardown, re-installing would simply double
  // every listener and emit each event twice.
  const VERSION = CFG.scriptVersion || 'dev';
  if (window.__flowRecorderInstalled) {
    if (window.__flowRecorderInstalled === VERSION) return;
    try { window.__flowRecorderUninstall && window.__flowRecorderUninstall(); } catch (_) {}
  }
  window.__flowRecorderInstalled = VERSION;

  // Everything this instance must undo if a newer build replaces it. `on` wraps
  // addEventListener so a listener can never be registered without its removal.
  const teardown = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    teardown.push(() => target.removeEventListener(type, fn, opts));
  };
  window.__flowRecorderUninstall = () => {
    for (const undo of teardown.splice(0).reverse()) {
      try { undo(); } catch (_) { /* one failure must not strand the rest */ }
    }
  };

  const emit = (evt) => {
    try { window.__flowRecorderEmit(JSON.stringify(evt)); } catch (_) { /* binding not ready */ }
  };

  // Values typed into fields whose name/id/placeholder/type matches this are masked.
  // Configurable via `maskPattern` so teams can add their own sensitive field names.
  let MASK;
  try {
    MASK = new RegExp(CFG.maskPattern || 'pass|pwd|otp|pin|secret|token|cvv|card.?number', 'i');
  } catch (_) {
    MASK = /pass|pwd|otp|pin|secret|token|cvv|card.?number/i;
  }
  // Opt-in: mask every typed value regardless of field name. The only defence when
  // the field is called `j_idt42` and no pattern can tell what it holds.
  const MASK_ALL = !!CFG.maskAllInput;
  const TYPE_DEBOUNCE = Number(CFG.typeDebounceMs) > 0 ? Number(CFG.typeDebounceMs) : 900;
  const AGENT = CFG.agentName || 'the AI agent';
  // Whether an `onCreate` command is wired up Node-side. Drives the ⚡ readout:
  // with a hook the click really does start something, without one it only queues.
  const HAS_HOOK = !!CFG.createHook;
  // Basename of this session's queue file, so the panel can name the thing an
  // agent has to be pointed at. Without it "ask your agent to drain the queue"
  // is advice the user cannot act on.
  const QUEUE_NAME = CFG.queueName || '';

  // Page-side twin of redactUrl() in config.js — same contract, because `nav`
  // events are emitted from here while the per-event `url` stamp is added Node-side,
  // and a URL scrubbed on only one of those two paths is not scrubbed at all.
  // Keeps origin, path and parameter NAMES; replaces credential-bearing values.
  let REDACT;
  try {
    REDACT = new RegExp('^(?:' + (CFG.redactUrlParams || 'token|code|key|secret|session|auth') + ')$', 'i');
  } catch (_) {
    REDACT = /^(?:token|code|key|secret|session|auth)$/i;
  }
  // Per name-component, so access_token / id_token / apiKey are caught without
  // also redacting zipcode, monkey or keyword. Mirrors sensitive() in config.js.
  const sensitiveParam = (name) =>
    String(name)
      .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
      .some((part) => part && REDACT.test(part));
  const scrubPairs = (s) =>
    String(s).replace(/([?#&]|^)([^=&#?]+)=([^&#]*)/g, (m, lead, k) => {
      let name = k;
      try { name = decodeURIComponent(k); } catch (_) {}
      return sensitiveParam(name.trim()) ? lead + k + '=***' : m;
    });
  const redactUrl = (url) => {
    const raw = String(url == null ? '' : url);
    if (!raw) return raw;
    try {
      const u = new URL(raw);
      if (u.password) u.password = '***';
      Array.from(u.searchParams.keys()).forEach((k) => { if (sensitiveParam(k)) u.searchParams.set(k, '***'); });
      if (u.hash.length > 1) u.hash = scrubPairs(u.hash);
      return u.href;
    } catch (_) {
      return scrubPairs(raw);
    }
  };

  const ACTIONABLE =
    'button,a,[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],' +
    '[role="option"],[role="tab"],[role="checkbox"],[role="switch"],[role="radio"],' +
    '[role="combobox"],[role="listbox"],input,select,textarea,label,[contenteditable="true"],summary';

  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const attr = (el, n) => (el && el.getAttribute ? el.getAttribute(n) : null);

  // --- DOM building WITHOUT innerHTML ---
  // Any page that enforces Trusted Types — Chrome's own chrome:// pages, and any
  // app served with `require-trusted-types-for 'script'` — throws a TypeError on
  // innerHTML assignment. That used to abort widget construction on the very first
  // line, BEFORE the host was appended, so the recorder attached and captured
  // events fine but no HUD ever appeared and nothing said why. A named
  // trustedTypes policy is not a fix: strict allow-lists reject it too
  // ("Policy 'flowRecorder' disallowed"). createElement/textContent are never
  // gated by Trusted Types, so build every node the long way.
  const mk = (tag, props, children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null) continue;
      if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const c of children || []) if (c) n.appendChild(c);
    return n;
  };
  const styleTag = (css) => {
    const s = document.createElement('style');
    s.textContent = css;
    return s;
  };

  const visibleText = (el) => {
    const t = ((el.innerText != null ? el.innerText : el.textContent) || '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.length > 60 ? t.slice(0, 60) + '…' : t;
  };

  // Ids that look auto-generated (React/Radix/Ember/numeric suffixes) are unstable.
  const stableId = (id) => id && !/\d{3,}|^radix|^:|^ember|^react|^headlessui/.test(id);

  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

  const cssPath = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 6) {
      let part = n.tagName.toLowerCase();
      const id = attr(n, 'id');
      if (stableId(id)) { parts.unshift(part + '#' + cssEscape(id)); break; }
      const parent = n.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(part);
      if (part === 'body' || !parent) break;
      n = parent;
    }
    return parts.join(' > ');
  };

  // Multiple candidate selectors per element, best-first. The converter picks;
  // redundancy is what makes conversion reliable when one candidate is fragile.
  const candidates = (el) => {
    const out = [];
    const tag = el.tagName.toLowerCase();
    for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-test-id']) {
      const v = attr(el, a);
      if (v) out.push({ by: a, sel: '[' + a + '="' + esc(v) + '"]' });
    }
    const id = attr(el, 'id');
    if (stableId(id)) out.push({ by: 'id', sel: '#' + cssEscape(id) });
    const aria = attr(el, 'aria-label');
    if (aria) out.push({ by: 'aria-label', sel: tag + '[aria-label="' + esc(aria) + '"]' });
    const ph = attr(el, 'placeholder');
    if (ph) out.push({ by: 'placeholder', sel: tag + '[placeholder="' + esc(ph) + '"]' });
    const nm = attr(el, 'name');
    if (nm) out.push({ by: 'name', sel: tag + '[name="' + esc(nm) + '"]' });
    const txt = visibleText(el);
    if (txt && txt.length <= 50 && !txt.endsWith('…')) {
      out.push({ by: 'text', sel: '//' + tag + '[normalize-space(.)="' + txt + '"]' });
    }
    out.push({ by: 'css-path', sel: cssPath(el) });
    return out;
  };

  const accessibleName = (el) => {
    const lbl = el.labels && el.labels[0];
    return (
      attr(el, 'aria-label') ||
      (lbl && lbl.textContent.replace(/\s+/g, ' ').trim()) ||
      attr(el, 'placeholder') ||
      attr(el, 'title') ||
      null
    );
  };

  // Interactive state — lets asserts express "is editable / disabled / checked".
  const elState = (el) => {
    const s = {};
    const disabled = !!el.disabled || attr(el, 'aria-disabled') === 'true';
    const readonly = !!el.readOnly || attr(el, 'readonly') != null || attr(el, 'aria-readonly') === 'true';
    s.enabled = !disabled;
    if ('value' in el || el.isContentEditable) s.editable = !disabled && !readonly;
    if (typeof el.checked === 'boolean') s.checked = el.checked;
    else if (attr(el, 'aria-checked')) s.checked = attr(el, 'aria-checked') === 'true';
    s.visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return s;
  };

  // Table/list geometry — which row, of how many, with the row's cell texts and
  // the clicked cell's column header. Enables "first row of results" assertions.
  //
  // NOTE: this requires real <tr>/<td> or role="row"/role="cell". Many modern
  // React data grids render rows as plain <div>s with no row semantics — there
  // the `row` predicate is unavailable and per-cell asserts are the fallback.
  // See docs/EVENT-FORMAT.md → "Grids without row semantics".
  const rowContext = (el) => {
    const row = el.closest ? el.closest('tr,[role="row"]') : null;
    if (!row || !row.parentElement) return null;
    const siblings = Array.from(row.parentElement.children).filter(
      (c) => c.matches && c.matches('tr,[role="row"]')
    );
    const cells = Array.from(row.querySelectorAll('td,th,[role="cell"],[role="gridcell"]'))
      .map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 12);
    const cell = el.closest('td,th,[role="cell"],[role="gridcell"]');
    let colHeader = null;
    if (cell) {
      const idx = Array.from(row.children).indexOf(cell);
      const table = row.closest('table,[role="table"],[role="grid"]');
      const headerRow = table && table.querySelector('thead tr,[role="rowgroup"] [role="row"]');
      if (headerRow && idx >= 0 && headerRow.children[idx]) {
        colHeader = (headerRow.children[idx].innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      }
    }
    return { rowIndex: siblings.indexOf(row) + 1, rowCount: siblings.length, cells, colHeader };
  };

  // Page snapshot: emitted with recording-start/stop markers to give the
  // converter precise preamble/postcondition context beyond the URL.
  const pageSnapshot = (withFields) => {
    const snap = {
      title: document.title,
      headings: Array.from(document.querySelectorAll('h1,h2'))
        .slice(0, 5)
        .map((h) => (h.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    };
    const dlg = document.querySelector('[role="dialog"],dialog');
    if (dlg) {
      const h = dlg.querySelector('h1,h2,h3');
      snap.dialog = h ? (h.innerText || '').trim().slice(0, 60) : true;
    }
    if (withFields) {
      // final field values — catches autofill/paste that input events may have missed
      snap.fields = Array.from(document.querySelectorAll('input,textarea,select'))
        .slice(0, 25)
        .map((f) => {
          if (f.type === 'hidden' || !(f.offsetWidth || f.offsetHeight)) return null;
          const masked =
            MASK_ALL || f.type === 'password' || MASK.test([f.type, f.name, f.id, f.placeholder].join(' '));
          const label = accessibleName(f) || f.name || f.id || f.tagName.toLowerCase();
          const value = f.tagName === 'SELECT' ? (f.selectedOptions[0] || {}).textContent : f.value;
          return value
            ? { label: String(label).slice(0, 40), value: masked ? '***masked***' : String(value).slice(0, 60) }
            : null;
        })
        .filter(Boolean);
    }
    return snap;
  };

  const describe = (el) => {
    const dialog = el.closest
      ? el.closest('[role="dialog"],dialog,[class*="drawer"],[class*="modal"],[class*="Drawer"],[class*="Modal"]')
      : null;
    let dialogTitle = null;
    if (dialog) {
      const h = dialog.querySelector('h1,h2,h3,[class*="title"],[class*="Title"]');
      if (h) dialogTitle = h.textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
    }
    const d = {
      tag: el.tagName.toLowerCase(),
      role: attr(el, 'role'),
      type: attr(el, 'type'),
      text: visibleText(el),
      label: accessibleName(el),
      inDialog: !!dialog,
      dialogTitle,
      state: elState(el),
      candidates: candidates(el),
    };
    const row = rowContext(el);
    if (row) d.row = row;
    return d;
  };

  // From the deepest event target (shadow-DOM aware), climb to the nearest
  // actionable ancestor so a click on an <svg> inside a button reports the button.
  const resolveTarget = (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    let raw = path[0];
    if (raw && raw.nodeType !== 1) raw = raw.parentElement;
    if (!raw) return null;
    return (raw.closest && raw.closest(ACTIONABLE)) || raw;
  };

  const isWidgetEvent = (e) =>
    e.composedPath &&
    e.composedPath().some((n) => n && (n.id === '__flow_rec_host' || n.id === '__flow_rec_pal'));

  // --- focus-trap escape ---
  // App dialogs/drawers (Radix/React FocusScope, MUI, Headless UI …) install a
  // CAPTURE-phase document focusin/focusout handler that yanks focus back inside
  // themselves the instant it lands anywhere outside — which is exactly what makes
  // the widget's scenario-name / ✎ note box impossible to type into while a drawer
  // is open (names come out empty, notes never land). Stopping propagation at the
  // widget's shadow root (bubble phase) is too late — the trap runs in capture on
  // document first. So we register our OWN capture-phase guard at injection time.
  // Because inject runs before the app mounts its dialog, our listener precedes the
  // trap's in capture order and can stopImmediatePropagation for widget-targeted
  // focus events — the trap never sees focus leave, so it never steals it back.
  // Only widget/palette focus is intercepted; the app's own focus behaviour is
  // untouched. We check both the event target (focusin landing on the widget) and
  // relatedTarget (focusout FROM the dialog whose focus is heading INTO the widget —
  // Radix traps refocus on that too), so neither direction reaches the trap.
  // Regression-tested by test/focus-trap-test.js — do not "simplify" this away.
  const isWidgetNode = (n) => !!(n && n.closest && (n.closest('#__flow_rec_host') || n.closest('#__flow_rec_pal')));
  const focusGuard = (e) => {
    if (isWidgetEvent(e) || isWidgetNode(e.relatedTarget)) e.stopImmediatePropagation();
  };
  on(document, 'focusin', focusGuard, true);
  on(document, 'focusout', focusGuard, true);

  // --- assert palette: ⌥/Alt+Click captures a TARGET, the palette captures the
  // PREDICATE (visible / enabled / editable / text / checked / row / disappears).
  // Dismissing it (click elsewhere, Escape, 12s) falls back to a plain text assert.
  let palHost = null;
  let palPending = null;
  let palTimer = null;
  const closePalette = () => {
    if (palTimer) clearTimeout(palTimer);
    palTimer = null;
    if (palHost) palHost.remove();
    palHost = null;
    palPending = null;
  };
  // An open palette belongs to the instance being replaced — close it rather than
  // leaving an orphaned overlay with a 12s timer pointed at a dead binding.
  teardown.push(closePalette);
  const settlePaletteDefault = () => {
    if (!palPending) return closePalette();
    const p = palPending;
    closePalette();
    emit({ kind: 'assert', predicate: 'text', expected: p.text || null, ...p });
  };
  const openPalette = (el, x, y) => {
    closePalette();
    const d = describe(el);
    palPending = d;
    palHost = document.createElement('div');
    palHost.id = '__flow_rec_pal';
    palHost.style.cssText =
      'position:fixed;left:' + Math.max(8, Math.min(x, innerWidth - 250)) + 'px;top:' +
      Math.max(8, Math.min(y + 10, innerHeight - 260)) + 'px;z-index:2147483647;';
    const r = palHost.attachShadow({ mode: 'open' });
    // Same guard as the main widget: picking a predicate here must not dismiss the app
    // layer the asserted element lives in. Stop pointer/focus events at the palette's
    // shadow root so they don't reach the app's outside-click listeners.
    ['pointerdown', 'mousedown', 'touchstart', 'click', 'focusin'].forEach(
      (t) => r.addEventListener(t, (e) => e.stopPropagation())
    );
    const st = d.state || {};
    // The expected-text field sits directly above the button that consumes it, and
    // with everything sharing one dark surface it read as a fifth choice rather than
    // an editable value. A placeholder plus the inset field styling separates them.
    const rows = [
      mk('div', { class: 'hd', id: 'p_hd' }),
      mk('input', { id: 'p_exp', placeholder: 'expected text', 'aria-label': 'expected text', autocomplete: 'off', spellcheck: 'false' }),
    ];
    if (d.text) rows.push(mk('button', { id: 'p_text', text: 'has this text' }));
    rows.push(mk('button', { id: 'p_vis', text: 'is visible' }));
    rows.push(mk('button', { id: 'p_en', text: st.enabled === false ? 'is disabled' : 'is enabled' }));
    if ('editable' in st) rows.push(mk('button', { id: 'p_edit', text: st.editable ? 'is editable' : 'is read-only' }));
    if ('checked' in st) rows.push(mk('button', { id: 'p_chk', text: st.checked ? 'is checked' : 'is unchecked' }));
    if (d.row) rows.push(mk('button', { id: 'p_row', text: 'check this row' }));
    rows.push(mk('button', { id: 'p_gone', text: 'disappears later' }));
    // Same visual language as the bar — this palette is the other half of the HUD.
    r.appendChild(
      styleTag(
        '.pal{display:flex;flex-direction:column;gap:5px;min-width:196px;padding:8px;border-radius:12px;' +
          'color-scheme:dark;color:#e8eaed;' +
          "font:500 12px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,'Helvetica Neue',sans-serif;" +
          'background:linear-gradient(180deg,rgba(28,31,38,.95),rgba(17,19,24,.97));' +
          'border:1px solid rgba(255,255,255,.14);' +
          '-webkit-backdrop-filter:blur(14px) saturate(140%);backdrop-filter:blur(14px) saturate(140%);' +
          'box-shadow:0 12px 34px rgba(0,0,0,.46),inset 0 1px 0 rgba(255,255,255,.07);' +
          'animation:flowpalin 120ms ease-out}' +
          '.hd{color:rgba(232,234,237,.55);font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;' +
          'padding:1px 2px 3px;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
          'button{appearance:none;font:inherit;text-align:left;color:#e8eaed;cursor:pointer;' +
          'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 9px;' +
          'transition:background 120ms ease,border-color 120ms ease,transform 60ms ease}' +
          'button:hover{background:rgba(255,255,255,.13);border-color:rgba(255,255,255,.22)}' +
          'button:active{transform:translateY(.5px)}' +
          'button:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}' +
          // Recessed, not raised: a field must not look like the buttons under it.
          'input{font:inherit;font-weight:400;color:#f3f4f6;background:rgba(0,0,0,.42);' +
          'border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:6px 9px;margin-bottom:2px;' +
          'box-shadow:inset 0 1px 3px rgba(0,0,0,.5);' +
          'transition:border-color 120ms ease,box-shadow 120ms ease}' +
          'input::placeholder{color:rgba(232,234,237,.42)}' +
          'input:focus{outline:none;border-color:#60a5fa;' +
          'box-shadow:inset 0 1px 3px rgba(0,0,0,.5),0 0 0 3px rgba(96,165,250,.22)}' +
          '@keyframes flowpalin{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}' +
          '@media (prefers-reduced-motion:reduce){.pal{animation:none}button,input{transition:none}}'
      )
    );
    r.appendChild(mk('div', { class: 'pal' }, rows));
    r.getElementById('p_hd').textContent = 'assert: ' + (d.text || d.label || d.tag);
    const exp = r.getElementById('p_exp');
    exp.value = (d.text || '').slice(0, 60);
    ['keydown', 'input'].forEach((t) => exp.addEventListener(t, (e) => e.stopPropagation()));
    const choose = (predicate, expected) => {
      const p = palPending;
      closePalette();
      emit({ kind: 'assert', predicate, expected: expected === undefined ? null : expected, ...p });
    };
    const wire = (id, predicate, expectedFn) => {
      const b = r.getElementById(id);
      if (b) b.addEventListener('click', () => choose(predicate, expectedFn ? expectedFn() : undefined));
    };
    wire('p_text', 'text', () => exp.value.trim());
    wire('p_vis', 'visible');
    wire('p_en', st.enabled === false ? 'disabled' : 'enabled');
    wire('p_edit', st.editable ? 'editable' : 'readonly');
    wire('p_chk', 'checked', () => st.checked);
    wire('p_row', 'row', () => (d.row ? d.row.cells : null));
    wire('p_gone', 'absent-later');
    document.documentElement.appendChild(palHost);
    palTimer = setTimeout(settlePaletteDefault, 12000);
  };

  // --- clicks (⌥/Alt+Click = open assert palette WITHOUT triggering the element) ---
  on(
    document,
    'click',
    (e) => {
      if (isWidgetEvent(e)) return;
      if (palHost) settlePaletteDefault(); // clicking outside the palette settles it
      const el = resolveTarget(e);
      if (!el || el.nodeType !== 1) return;
      // A click elsewhere ends typing (Search button, Save, another field). Flush
      // every pending emit so the value survives the submit AND precedes the click.
      if (pendingTypes.size) flushTypes();
      if (e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        openPalette(el, e.clientX, e.clientY);
        return;
      }
      emit({ kind: 'click', ...describe(el) });
    },
    { capture: true }
  );

  // --- typing (debounced; emits the final value once you pause) ---
  // The debounce MUST NOT outlive the thing that ended the typing. Pressing Enter,
  // clicking away, blurring, or the page unloading all tear down the field — or the
  // whole document — well inside TYPE_DEBOUNCE, and a timer that fires after that
  // never emits. The typed value was then lost outright; the only trace left was the
  // ⏹ snapshot, and only for fields still present on the final page. Anything typed
  // and submitted mid-flow (a search box, a login form) vanished.
  //
  // So a pending emit is a flushable record, and every moment that ends typing
  // flushes it SYNCHRONOUSLY, before the value can disappear. Flushing also fixes
  // ordering: the `type` lands before the `click`/`key` that submitted it.
  const pendingTypes = new Map(); // el -> { timer, fire }

  // Flush one element's pending emit, or every pending emit when called bare.
  const flushTypes = (el) => {
    if (el) {
      const p = pendingTypes.get(el);
      if (p) p.fire();
      return;
    }
    for (const p of Array.from(pendingTypes.values())) p.fire();
  };

  on(
    document,
    'input',
    (e) => {
      if (isWidgetEvent(e)) return;
      const el = resolveTarget(e);
      if (!el || el.nodeType !== 1) return;
      if (!('value' in el) && !el.isContentEditable) return;
      if (el.tagName === 'SELECT' || el.type === 'file' || el.type === 'checkbox' || el.type === 'radio') return;
      const prev = pendingTypes.get(el);
      if (prev) clearTimeout(prev.timer);
      // Idempotent: deletes its own record first, so a flush racing the timer
      // (or two flush points firing back to back) can never double-emit.
      const fire = () => {
        const rec = pendingTypes.get(el);
        if (!rec) return;
        clearTimeout(rec.timer);
        pendingTypes.delete(el);
        const hint = [attr(el, 'type'), attr(el, 'name'), attr(el, 'id'), attr(el, 'placeholder'), accessibleName(el)].join(' ');
        const masked = MASK_ALL || attr(el, 'type') === 'password' || MASK.test(hint);
        const value = el.isContentEditable ? visibleText(el) : el.value;
        emit({ kind: 'type', value: masked ? '***masked***' : value, ...describe(el) });
      };
      pendingTypes.set(el, { timer: setTimeout(fire, TYPE_DEBOUNCE), fire });
    },
    { capture: true, passive: true }
  );

  // Leaving the field ends the typing — flush before the element can be detached.
  on(
    document,
    'focusout',
    (e) => {
      if (isWidgetEvent(e)) return;
      const el = resolveTarget(e);
      if (el) flushTypes(el);
    },
    { capture: true, passive: true }
  );

  // Last resort for values still pending when the document goes away (form submit,
  // full navigation, tab close). Best-effort: the binding may already be torn down.
  ['beforeunload', 'pagehide'].forEach((t) =>
    on(window, t, () => flushTypes(), { capture: true })
  );

  // A replaced instance must not leave debounce timers armed against a dead binding.
  teardown.push(() => {
    for (const p of pendingTypes.values()) clearTimeout(p.timer);
    pendingTypes.clear();
  });

  // --- selects, checkboxes, radios, file uploads ---
  on(
    document,
    'change',
    (e) => {
      if (isWidgetEvent(e)) return;
      const el = resolveTarget(e);
      if (!el || el.nodeType !== 1) return;
      if (el.tagName === 'SELECT') {
        const opt = el.selectedOptions && el.selectedOptions[0];
        emit({ kind: 'select', value: opt ? opt.textContent.replace(/\s+/g, ' ').trim() : el.value, ...describe(el) });
      } else if (el.type === 'file') {
        // File NAMES only — never contents.
        emit({ kind: 'upload', value: Array.from(el.files || []).map((f) => f.name).join(', '), ...describe(el) });
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        emit({ kind: el.type, value: String(el.checked), ...describe(el) });
      }
    },
    { capture: true, passive: true }
  );

  // --- meaningful keys ---
  on(
    document,
    'keydown',
    (e) => {
      if (isWidgetEvent(e)) return;
      if (e.key === 'Escape' && palHost) {
        settlePaletteDefault();
        return;
      }
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      const el = document.activeElement;
      // Enter usually submits, which navigates away long before the debounce
      // fires. Flush FIRST so the typed value is emitted, and emitted before
      // the key that submitted it.
      flushTypes(el && el.nodeType === 1 ? el : undefined);
      const extra = el && el !== document.body ? describe(el) : {};
      emit({ kind: 'key', value: e.key, ...extra });
    },
    { capture: true, passive: true }
  );

  // --- navigation (full loads + SPA route changes) ---
  const nav = (how) => emit({ kind: 'nav', how, value: redactUrl(location.href) });
  const _push = history.pushState;
  history.pushState = function (...a) { _push.apply(this, a); nav('pushState'); };
  const _replace = history.replaceState;
  history.replaceState = function (...a) { _replace.apply(this, a); nav('replaceState'); };
  on(window, 'popstate', () => nav('popstate'));
  // These are monkey-patches, not listeners — restore them or a replacing instance
  // stacks a second patch on top and every route change emits twice.
  teardown.push(() => {
    history.pushState = _push;
    history.replaceState = _replace;
  });
  nav('load');

  // --- floating widget: scenario markers + intent notes ---
  const makeWidget = () => {
    if (!document.documentElement || document.getElementById('__flow_rec_host')) return;
    const host = document.createElement('div');
    host.id = '__flow_rec_host';
    // pointer-events: only the visible bar swallows clicks, never the container box
    host.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });
    // Interacting with the widget must NOT dismiss whatever the app has open.
    // Radix/React "dismissable layers" (detail drawers, popovers, dialogs) close on any
    // pointerdown/focus that lands outside themselves — and the widget is always outside.
    // So clicking ✎ note / ⏺ / the name box while a drawer is open would close that
    // drawer before you could act on it. Stop these events at the shadow root: the
    // widget's own button handlers live on inner elements (earlier in the bubble path) and
    // still fire, but the event never reaches the app's document-level outside-click/focus
    // listeners.
    // Only "down"/click/focus events are stopped — NOT mouseup/pointerup: the grip drag ends
    // via a document-level mouseup listener (below) that clears `drag`, and the release usually
    // happens with the cursor over the widget. Stopping mouseup here would keep that event from
    // reaching document, so `drag` would never clear and the widget would stay stuck to the
    // cursor. Dismissable layers close on pointer-DOWN outside, so stopping the down events is
    // what prevents dismissal; letting the up events through is safe.
    ['pointerdown', 'mousedown', 'touchstart', 'click', 'focusin'].forEach(
      (t) => root.addEventListener(t, (e) => e.stopPropagation())
    );
    // No native prompt()/alert() here: Playwright auto-dismisses native dialogs
    // on attached pages, so the widget uses an inline input instead.
    // Presentation only. The ids, the `.bar` class, the exact button labels and the
    // `className` swaps in setRecUI/syncState are load-bearing (tests drive them and
    // setRecUI overwrites className wholesale, so state is styled by id + .on/.live,
    // never by adding a second static class).
    //
    // `:has()` lets the whole bar react to the record button's state without any JS
    // touching it — this runs only in Chrome via CDP, so :has() is always available.
    root.appendChild(
      styleTag(
        // On :host, not on .bar — the detail panel is a SIBLING of the bar, so a font
        // set only on .bar left the panel inheriting the page's default and rendering
        // in serif. Anything added to this shadow root inherits from here.
        ':host{color-scheme:dark;' +
          "font:500 12px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,'Helvetica Neue',sans-serif;" +
          'color:#e8eaed}' +
          '.bar{display:flex;gap:8px;align-items:center;pointer-events:auto;' +
          'padding:6px 8px;border-radius:12px;' +
          'background:linear-gradient(180deg,rgba(28,31,38,.93),rgba(17,19,24,.95));' +
          'border:1px solid rgba(255,255,255,.14);' +
          '-webkit-backdrop-filter:blur(14px) saturate(140%);backdrop-filter:blur(14px) saturate(140%);' +
          'box-shadow:0 10px 30px rgba(0,0,0,.4),0 1px 2px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.07);' +
          'animation:flowrecin 160ms ease-out}' +
          // Recording is the one state worth seeing from across the room.
          '.bar:has(#rec.on){border-color:rgba(239,68,68,.45);' +
          'box-shadow:0 10px 30px rgba(0,0,0,.4),0 0 0 1px rgba(239,68,68,.3),inset 0 1px 0 rgba(255,255,255,.07)}' +
          'button{appearance:none;font:inherit;white-space:nowrap;color:#e8eaed;cursor:pointer;' +
          'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px;' +
          'transition:background 120ms ease,border-color 120ms ease,box-shadow 120ms ease,transform 60ms ease}' +
          'button:hover{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.22)}' +
          'button:active{transform:translateY(.5px)}' +
          'button:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}' +
          'button:disabled{opacity:.32;cursor:default;background:rgba(255,255,255,.04);' +
          'border-color:rgba(255,255,255,.1);box-shadow:none;transform:none}' +
          // ⏺ is the primary action; it turns unmistakably red while capturing.
          '#rec{font-weight:600;background:rgba(255,255,255,.1)}' +
          '#rec:hover{background:rgba(255,255,255,.17)}' +
          '#rec.on{color:#fff;border-color:#f87171;background:linear-gradient(180deg,#ef4444,#dc2626);' +
          'box-shadow:0 0 0 1px rgba(239,68,68,.45),0 2px 12px rgba(239,68,68,.4)}' +
          '#rec.on:hover{background:linear-gradient(180deg,#f15b5b,#e02424)}' +
          // ⚡ only becomes a call to action once there is something to hand off.
          '#gen:not(:disabled){font-weight:600;color:#fff;border-color:rgba(129,140,248,.65);' +
          'background:linear-gradient(180deg,rgba(99,102,241,.92),rgba(79,70,229,.92));' +
          'box-shadow:0 2px 12px rgba(79,70,229,.32)}' +
          '#gen:not(:disabled):hover{background:linear-gradient(180deg,#6366f1,#4f46e5);' +
          'border-color:rgba(165,180,252,.8)}' +
          'input{width:172px;min-width:0;font:inherit;font-weight:400;color:#f3f4f6;' +
          'background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:6px 9px;' +
          'transition:border-color 120ms ease,box-shadow 120ms ease,background 120ms ease}' +
          'input::placeholder{color:rgba(232,234,237,.42)}' +
          'input:focus{outline:none;border-color:#60a5fa;background:rgba(0,0,0,.5);' +
          'box-shadow:0 0 0 3px rgba(96,165,250,.22)}' +
          '#grip{cursor:grab;color:rgba(232,234,237,.4);user-select:none;font-size:13px;line-height:1;' +
          'padding:3px;border-radius:5px;transition:color 120ms ease,background 120ms ease}' +
          '#grip:hover{color:rgba(232,234,237,.85);background:rgba(255,255,255,.08)}' +
          '#grip:active{cursor:grabbing}' +
          // Idle is neutral grey and recording is red — a red dot on an idle HUD reads
          // as "you are being recorded", which is the opposite of the truth.
          '#dot{width:9px;height:9px;border-radius:50%;flex:none;background:#6b7280;' +
          'box-shadow:inset 0 0 0 1px rgba(255,255,255,.2)}' +
          '#dot.live{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.22),0 0 10px rgba(239,68,68,.55);' +
          'animation:flowrecpulse 1.4s ease-in-out infinite}' +
          '#qs{color:#cbd5e1;font-size:11px;font-variant-numeric:tabular-nums;' +
          'max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
          // Only becomes a chip when it has something to say, so an empty HUD stays clean.
          '#qs:not(:empty){padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.07);' +
          'border:1px solid rgba(255,255,255,.1)}' +
          '#qs{cursor:pointer}' +
          // --- hand-off detail panel: same glass, hangs below the bar ---
          '#panel{display:none;margin-top:8px;max-width:380px;max-height:60vh;overflow-y:auto;font:inherit;color:inherit;' +
          'pointer-events:auto;padding:8px;border-radius:12px;text-align:left;' +
          'background:linear-gradient(180deg,rgba(28,31,38,.95),rgba(17,19,24,.97));' +
          'border:1px solid rgba(255,255,255,.14);' +
          '-webkit-backdrop-filter:blur(14px) saturate(140%);backdrop-filter:blur(14px) saturate(140%);' +
          'box-shadow:0 14px 38px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.07);' +
          'animation:flowrecin 140ms ease-out}' +
          '.phd{display:flex;align-items:center;justify-content:space-between;gap:8px;' +
          'color:rgba(232,234,237,.55);font-size:10px;font-weight:600;letter-spacing:.06em;' +
          'text-transform:uppercase;padding:1px 2px 6px}' +
          '.pclose{padding:2px 6px;font-size:11px;line-height:1;border-radius:6px}' +
          '.pcard{padding:7px 9px;border-radius:9px;margin-bottom:6px;' +
          'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);' +
          'border-left:3px solid rgba(255,255,255,.18)}' +
          '.pcard:last-child{margin-bottom:0}' +
          '.pcard.working{border-left-color:#6366f1;background:rgba(99,102,241,.1)}' +
          '.pcard.done{border-left-color:#22c55e}' +
          '.pcard.error{border-left-color:#ef4444;background:rgba(239,68,68,.1)}' +
          '.prow{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
          '.pname{font-weight:600;font-size:12px;color:#f3f4f6;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap}' +
          '.pill{flex:none;font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;' +
          'padding:2px 7px;border-radius:999px;background:rgba(255,255,255,.1);color:rgba(232,234,237,.75)}' +
          '.pill.working{background:rgba(99,102,241,.28);color:#c7d2fe}' +
          '.pill.done{background:rgba(34,197,94,.22);color:#bbf7d0}' +
          '.pill.error{background:rgba(239,68,68,.24);color:#fecaca}' +
          '.pmeta{font-size:10px;color:rgba(232,234,237,.4);margin-top:2px}' +
          '.pmsg{font-size:11px;color:#e2e8f0;margin-top:4px;line-height:1.45}' +
          '.pdet{font-size:11px;color:rgba(232,234,237,.62);margin-top:2px;line-height:1.45}' +
          '.pdet.dim{color:rgba(232,234,237,.42)}' +
          '.pfoot{margin-top:8px;padding:7px 9px 1px;border-top:1px solid rgba(255,255,255,.1);' +
          'font-size:11px;line-height:1.5;color:rgba(232,234,237,.66)}' +
          '.pfoot .dim{color:rgba(232,234,237,.42);margin-top:3px}' +
          '.pfoot .pfile{margin:4px 0 2px}' +
          '.pfile{font-size:10px;margin-top:4px;color:#a5b4fc;' +
          "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;" +
          'text-overflow:ellipsis;white-space:nowrap}' +
          '@keyframes flowrecpulse{50%{opacity:.5;box-shadow:0 0 0 5px rgba(239,68,68,.1),0 0 10px rgba(239,68,68,.3)}}' +
          '@keyframes flowrecin{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}' +
          '@media (prefers-reduced-motion:reduce){#dot.live{animation:none}' +
          '.bar,#panel{animation:none}button,input,#grip{transition:none}}'
      )
    );
    root.appendChild(
      // Labels and roles only — the button text is exactly what the tests assert and
      // what setRecUI rewrites, so it stays byte-identical.
      mk('div', { class: 'bar', role: 'toolbar', 'aria-label': 'flow-recorder' }, [
        mk('span', { id: 'grip', text: '⠿', title: 'drag the recorder out of the way', 'aria-hidden': 'true' }),
        mk('span', { id: 'dot', role: 'img', 'aria-label': 'recorder status' }),
        mk('input', { id: 'inp', placeholder: 'scenario name', 'aria-label': 'scenario name', autocomplete: 'off', spellcheck: 'false' }),
        mk('button', { id: 'rec', title: 'start / stop a scenario segment', text: '⏺ record' }),
        mk('button', { id: 'note', title: 'note your intent, or an assertion, in plain words', text: '✎ note' }),
        mk('button', {
          id: 'gen',
          disabled: '',
          title: 'queue this scenario for ' + AGENT + ' to create',
          text: '⚡ create',
        }),
        mk('span', { id: 'qs', role: 'status', 'aria-live': 'polite', title: 'click for details' }),
      ])
    );
    // Detail panel: a sibling of the bar so it can never change the bar's own layout
    // (the mount test measures `.bar`, and the drag positions the host).
    root.appendChild(
      mk('div', { id: 'panel', role: 'region', 'aria-label': 'hand-off details' })
    );
    const rec = root.getElementById('rec');
    const noteBtn = root.getElementById('note');
    const genBtn = root.getElementById('gen');
    const inp = root.getElementById('inp');
    const dot = root.getElementById('dot');
    const qs = root.getElementById('qs');
    const panel = root.getElementById('panel');
    let recording = false;
    let segments = 0;
    let noteMode = false;
    let lastRecClick = 0;
    // `live`, not `on` — `on` is the listener-registering helper at the top of this
    // file, and shadowing it here would break any future call to it from this scope.
    const setRecUI = (live, name) => {
      recording = live;
      rec.textContent = live ? '⏹ stop: ' + String(name || '').slice(0, 16) : '⏺ record';
      rec.className = live ? 'on' : '';
      dot.className = live ? 'live' : '';
    };
    // drag by the ⠿ grip to park the widget anywhere it isn't in the way
    let drag = null;
    root.getElementById('grip').addEventListener('mousedown', (e) => {
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    on(document, 'mousemove', (e) => {
      if (!drag) return;
      host.style.left = e.clientX - drag.dx + 'px';
      host.style.top = e.clientY - drag.dy + 'px';
      host.style.transform = 'none';
    });
    on(document, 'mouseup', () => { drag = null; });
    // ⚡ create is a QUEUE: each click enqueues the stopped-but-not-yet-queued
    // segment(s) into a durable file Node-side. The agent drains the queue one
    // scenario at a time and writes per-item status back, so the widget can show real
    // progress (queued → working → done/error) and nothing is lost even if the agent's
    // wake lags or you keep recording more scenarios while it works. A single always-on
    // poll of the Node-side state drives both the queue readout and the record-button
    // re-sync (so navigations that reload the widget never desync it).
    let enqueued = 0; // how many segments have been sent to the queue
    const renderQueue = (queue) => {
      if (!queue || !queue.length) { qs.textContent = ''; return; }
      const by = (s) => queue.filter((q) => q.status === s);
      const working = by('working')[0];
      const parts = [];
      if (working) parts.push('⏳ ' + String(working.scenario || '').slice(0, 20) + (working.message ? ' (' + String(working.message).slice(0, 24) + ')' : ''));
      const q = by('queued').length;
      // The steady-state readout has to carry the same honesty as the ⚡ click text,
      // because the poll overwrites that within a few hundred ms — this line is what
      // the user actually sits looking at. A queued item with no hook and nothing
      // working has been dispatched NOWHERE; saying only "1 queued" reads like
      // progress. With a hook, something really was started, so plain is accurate.
      if (q) parts.push(q + ' queued' + (!working && !HAS_HOOK ? ' · awaiting pickup' : ''));
      const d = by('done').length; if (d) parts.push('✓ ' + d);
      const er = by('error'); if (er.length) parts.push('⚠ ' + er.length);
      if (!working && !q && d && !er.length) qs.textContent = '✓ all ' + d + ' done';
      else qs.textContent = parts.join(' · ');
      renderPanel(queue);
    };

    // --- detail panel -----------------------------------------------------------
    // The chip in the bar can hold a couple of words, so a detailed ack had nowhere
    // to go: the user clicked ⚡ and got "1 queued" with no idea which scenario was
    // being worked, what the agent was doing, or where the output landed. This panel
    // is that answer — one card per queued scenario, fed by the same ack file.
    //
    // It opens itself on the transitions worth interrupting for (an item starts
    // working, finishes, or errors) and can be toggled from the chip. Once the user
    // closes it manually it stays closed until the next such transition, so it never
    // fights someone who dismissed it.
    let panelOpen = false;
    let panelPinnedShut = false;
    let lastSig = '';
    const statusLabel = { queued: 'queued', working: 'working', done: 'done', error: 'failed' };
    const renderPanel = (queue) => {
      // Finished items stay listed: "which of my three scenarios landed where" is
      // the question the panel exists to answer, and it survives the drain.
      const items = queue || [];
      // Auto-open when any item changes into a state the user is waiting to hear about.
      const sig = items.map((q) => q.id + ':' + q.status + ':' + q.message).join('|');
      // …including a queue with nothing wired to drain it. That case USED to be the
      // one the panel never opened for, which made it the one case the user was left
      // guessing about: the bar said "1 queued · awaiting pickup" indefinitely and
      // the explanation sat in a panel nobody knew to open. It is the moment that
      // most needs interrupting for — no agent is coming unless they go and get one.
      const notable = items.some(
        (q) =>
          q.status === 'working' ||
          q.status === 'error' ||
          q.status === 'done' ||
          (q.status === 'queued' && !HAS_HOOK)
      );
      if (sig !== lastSig) {
        const prev = lastSig;
        lastSig = sig;
        // A brand-new status (not just a message tweak) re-opens even after a dismiss.
        const statusesOf = (s) => s.split('|').map((x) => x.split(':').slice(0, 2).join(':')).join('|');
        if (statusesOf(sig) !== statusesOf(prev)) {
          panelPinnedShut = false;
          if (notable) panelOpen = true;
        }
      }
      if (!items.length) { panelOpen = false; panel.replaceChildren(); panel.style.display = 'none'; return; }
      panel.style.display = panelOpen && !panelPinnedShut ? 'block' : 'none';
      if (!panelOpen || panelPinnedShut) return;

      const cards = [
        mk('div', { class: 'phd' }, [
          mk('span', { text: 'hand-off to ' + AGENT }),
          mk('button', { id: 'pclose', class: 'pclose', title: 'hide details', text: '✕' }),
        ]),
      ];
      for (const q of items) {
        const st = q.status || 'queued';
        const rows = [
          mk('div', { class: 'prow' }, [
            mk('span', { class: 'pname', text: q.scenario || '(unnamed)' }),
            mk('span', { class: 'pill ' + st, text: statusLabel[st] || st }),
          ]),
          mk('div', { class: 'pmeta', text: 'segment ' + q.segment }),
        ];
        if (q.message) rows.push(mk('div', { class: 'pmsg', text: q.message }));
        for (const d of q.detail || []) rows.push(mk('div', { class: 'pdet', text: '· ' + d }));
        if (q.steps) {
          const s = q.steps;
          const bits = [];
          if (s.reuse != null) bits.push(s.reuse + ' reused');
          if (s.new != null) bits.push(s.new + ' new');
          if (s.healed != null) bits.push(s.healed + ' healed');
          if (bits.length) rows.push(mk('div', { class: 'pdet', text: '· steps: ' + bits.join(', ') }));
        }
        if (q.file) rows.push(mk('div', { class: 'pfile', text: q.file }));
        if (st === 'queued' && !HAS_HOOK) {
          rows.push(mk('div', { class: 'pdet dim', text: '· waiting for ' + AGENT + ' to pick this up' }));
        }
        cards.push(mk('div', { class: 'pcard ' + st }, rows));
      }
      // Said once at the foot rather than per card: with nothing wired to the queue,
      // "queued" is a state the user has to act on, and the action is not guessable.
      if (!HAS_HOOK && items.some((q) => q.status === 'queued')) {
        cards.push(
          mk('div', { class: 'pfoot' }, [
            mk('div', { text: 'Nothing is watching this queue — ' + AGENT + ' has to come and read it.' }),
            QUEUE_NAME ? mk('div', { class: 'pfile', text: QUEUE_NAME }) : null,
            mk('div', { class: 'dim', text: 'Set onCreate in flow-recorder.config.json to start it on every ⚡.' }),
          ].filter(Boolean))
        );
      }
      panel.replaceChildren(...cards);
      const close = panel.querySelector('#pclose');
      if (close) close.addEventListener('click', () => { panelPinnedShut = true; panelOpen = false; renderPanel(queue); });
    };
    qs.addEventListener('click', () => {
      panelPinnedShut = false;
      panelOpen = !panelOpen;
      poll();
    });
    const syncState = (st) => {
      if (!st) return;
      setRecUI(st.recording, st.scenario);
      segments = st.segments || 0;
      const queue = st.queue || [];
      enqueued = queue.length;
      // ⚡ is enabled whenever there's a stopped segment not yet queued.
      genBtn.disabled = segments <= enqueued;
      renderQueue(queue);
    };
    let statePoll = null;
    const poll = () => { try { window.__flowRecorderState().then(syncState).catch(() => {}); } catch (_) {} };
    const startPoll = () => { if (!statePoll) statePoll = setInterval(poll, 1500); };
    poll();
    startPoll();
    // A replaced instance leaves behind an interval polling a dead binding and a
    // widget the new instance can't mount over (makeWidget bails if the host
    // exists). Drop both, so the incoming build renders its own HUD.
    teardown.push(() => {
      clearInterval(statePoll);
      statePoll = null;
      if (host && host.parentNode) host.parentNode.removeChild(host);
    });
    const exitNoteMode = () => {
      noteMode = false;
      inp.placeholder = 'scenario name';
      inp.value = '';
    };
    // ⏺ is ONE click: uses whatever is in the name box (auto-names if empty).
    // Same button stops. Rapid double-clicks are ignored.
    rec.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastRecClick < 500) return;
      lastRecClick = now;
      if (recording) {
        setRecUI(false);
        segments += 1;
        genBtn.disabled = false;
        emit({ kind: 'marker', value: 'recording-stop', snapshot: pageSnapshot(true) });
      } else {
        const name = (noteMode ? '' : inp.value.trim()) || 'scenario-' + (segments + 1);
        exitNoteMode();
        setRecUI(true, name);
        emit({ kind: 'marker', value: 'recording-start', note: name, snapshot: pageSnapshot(false) });
      }
    });
    noteBtn.addEventListener('click', () => {
      noteMode = true;
      inp.value = '';
      inp.placeholder = 'note / assertion, then ⏎';
      inp.focus();
    });
    genBtn.addEventListener('click', () => {
      // Enqueue the stopped-but-not-yet-queued segment(s). Disable until the next
      // ⏹ makes a fresh segment available; the poll re-enables + shows queue depth.
      genBtn.disabled = true;
      // Say what actually happens. With no onCreate hook configured, nothing is
      // dispatched anywhere — the request is written to a file an agent has to come
      // and read. "waiting for the agent…" implied a delivery that never occurred,
      // and left users watching a spinner for something that was never coming.
      qs.textContent = HAS_HOOK
        ? '⚡ queued · starting ' + AGENT + '…'
        : '⚡ queued · ' + AGENT + ' reads this on its next check';
      emit({ kind: 'marker', value: 'create-scenario' });
      poll();
    });
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && noteMode) {
        const v = inp.value.trim();
        if (v) emit({ kind: 'note', note: v });
        exitNoteMode();
      }
      if (e.key === 'Escape') exitNoteMode();
    });
    inp.addEventListener('input', (e) => e.stopPropagation());
    document.documentElement.appendChild(host);
  };
  // A widget that fails to mount must never be silent: from the user's side "no
  // HUD" is indistinguishable from "the recorder never attached", and they will
  // sit there clicking a ⏺ that does not exist. Report it to the Node console.
  const mountWidget = () => {
    try {
      makeWidget();
      if (!document.getElementById('__flow_rec_host')) {
        emit({ kind: 'warning', value: 'widget-missing', note: 'widget did not mount on ' + redactUrl(location.href) });
      }
    } catch (e) {
      emit({
        kind: 'warning',
        value: 'widget-failed',
        note: String((e && e.message) || e).slice(0, 160) + ' @ ' + redactUrl(location.href),
      });
    }
  };
  if (document.readyState === 'loading') {
    on(document, 'DOMContentLoaded', mountWidget);
  } else {
    mountWidget();
  }
})()
