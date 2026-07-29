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
  if (window.__flowRecorderInstalled) return;
  window.__flowRecorderInstalled = true;

  const CFG = window.__flowRecorderConfig || {};

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
  const TYPE_DEBOUNCE = Number(CFG.typeDebounceMs) > 0 ? Number(CFG.typeDebounceMs) : 900;
  const AGENT = CFG.agentName || 'the AI agent';

  const ACTIONABLE =
    'button,a,[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],' +
    '[role="option"],[role="tab"],[role="checkbox"],[role="switch"],[role="radio"],' +
    '[role="combobox"],[role="listbox"],input,select,textarea,label,[contenteditable="true"],summary';

  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const attr = (el, n) => (el && el.getAttribute ? el.getAttribute(n) : null);

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
          const masked = f.type === 'password' || MASK.test([f.type, f.name, f.id, f.placeholder].join(' '));
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
  document.addEventListener('focusin', focusGuard, true);
  document.addEventListener('focusout', focusGuard, true);

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
    const btns = [];
    btns.push('<input id="p_exp">');
    if (d.text) btns.push('<button id="p_text">has this text</button>');
    btns.push('<button id="p_vis">is visible</button>');
    btns.push('<button id="p_en">' + (st.enabled === false ? 'is disabled' : 'is enabled') + '</button>');
    if ('editable' in st) btns.push('<button id="p_edit">' + (st.editable ? 'is editable' : 'is read-only') + '</button>');
    if ('checked' in st) btns.push('<button id="p_chk">' + (st.checked ? 'is checked' : 'is unchecked') + '</button>');
    if (d.row) btns.push('<button id="p_row">check this row</button>');
    btns.push('<button id="p_gone">disappears later</button>');
    r.innerHTML =
      '<style>' +
      '.pal{display:flex;flex-direction:column;gap:4px;background:rgba(17,17,17,.95);border:1px solid #555;' +
      'border-radius:8px;padding:8px;font:12px -apple-system,sans-serif;min-width:190px}' +
      '.hd{color:#aaa;font-size:11px;padding-bottom:2px;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      'button{background:#222;color:#fff;border:1px solid #555;border-radius:6px;padding:5px 8px;cursor:pointer;text-align:left}' +
      'button:hover{background:#333}' +
      'input{background:#222;color:#fff;border:1px solid #666;border-radius:6px;padding:4px 8px;font:12px -apple-system,sans-serif}' +
      '</style>' +
      '<div class="pal"><div class="hd" id="p_hd"></div>' + btns.join('') + '</div>';
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
  document.addEventListener(
    'click',
    (e) => {
      if (isWidgetEvent(e)) return;
      if (palHost) settlePaletteDefault(); // clicking outside the palette settles it
      const el = resolveTarget(e);
      if (!el || el.nodeType !== 1) return;
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
  const timers = new WeakMap();
  document.addEventListener(
    'input',
    (e) => {
      if (isWidgetEvent(e)) return;
      const el = resolveTarget(e);
      if (!el || el.nodeType !== 1) return;
      if (!('value' in el) && !el.isContentEditable) return;
      if (el.tagName === 'SELECT' || el.type === 'file' || el.type === 'checkbox' || el.type === 'radio') return;
      clearTimeout(timers.get(el));
      timers.set(
        el,
        setTimeout(() => {
          const hint = [attr(el, 'type'), attr(el, 'name'), attr(el, 'id'), attr(el, 'placeholder'), accessibleName(el)].join(' ');
          const masked = attr(el, 'type') === 'password' || MASK.test(hint);
          const value = el.isContentEditable ? visibleText(el) : el.value;
          emit({ kind: 'type', value: masked ? '***masked***' : value, ...describe(el) });
        }, TYPE_DEBOUNCE)
      );
    },
    { capture: true, passive: true }
  );

  // --- selects, checkboxes, radios, file uploads ---
  document.addEventListener(
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
  document.addEventListener(
    'keydown',
    (e) => {
      if (isWidgetEvent(e)) return;
      if (e.key === 'Escape' && palHost) {
        settlePaletteDefault();
        return;
      }
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      const el = document.activeElement;
      const extra = el && el !== document.body ? describe(el) : {};
      emit({ kind: 'key', value: e.key, ...extra });
    },
    { capture: true, passive: true }
  );

  // --- navigation (full loads + SPA route changes) ---
  const nav = (how) => emit({ kind: 'nav', how, value: location.href });
  const _push = history.pushState;
  history.pushState = function (...a) { _push.apply(this, a); nav('pushState'); };
  const _replace = history.replaceState;
  history.replaceState = function (...a) { _replace.apply(this, a); nav('replaceState'); };
  window.addEventListener('popstate', () => nav('popstate'));
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
    root.innerHTML =
      '<style>' +
      '.bar{display:flex;gap:6px;font:12px -apple-system,BlinkMacSystemFont,sans-serif;align-items:center;' +
      'background:rgba(17,17,17,.92);border:1px solid #444;border-radius:8px;padding:4px 8px;pointer-events:auto}' +
      'button{background:#111;color:#fff;border:1px solid #555;border-radius:6px;padding:6px 10px;cursor:pointer;opacity:.85}' +
      'button:hover{opacity:1}.on{background:#b91c1c;border-color:#b91c1c}' +
      'input{width:160px;background:#222;color:#fff;border:1px solid #666;border-radius:6px;padding:5px 8px;font:12px -apple-system,sans-serif}' +
      '#grip{cursor:move;color:#888;user-select:none;padding:0 2px;font-size:14px}' +
      '#dot{width:10px;height:10px;border-radius:50%;background:#ef4444;flex:none}' +
      '#dot.live{background:#22c55e;animation:pulse 1.2s infinite}' +
      'button:disabled{opacity:.35;cursor:default}' +
      '#qs{color:#bbb;font-size:11px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '@keyframes pulse{50%{opacity:.35}}' +
      '</style>' +
      '<div class="bar"><span id="grip">⠿</span><span id="dot"></span><input id="inp" placeholder="scenario name">' +
      '<button id="rec">⏺ record</button><button id="note">✎ note</button>' +
      '<button id="gen" disabled title="queue this scenario for ' + AGENT + ' to create">⚡ create</button>' +
      '<span id="qs"></span></div>';
    const rec = root.getElementById('rec');
    const noteBtn = root.getElementById('note');
    const genBtn = root.getElementById('gen');
    const inp = root.getElementById('inp');
    const dot = root.getElementById('dot');
    const qs = root.getElementById('qs');
    let recording = false;
    let segments = 0;
    let noteMode = false;
    let lastRecClick = 0;
    const setRecUI = (on, name) => {
      recording = on;
      rec.textContent = on ? '⏹ stop: ' + String(name || '').slice(0, 16) : '⏺ record';
      rec.className = on ? 'on' : '';
      dot.className = on ? 'live' : '';
    };
    // drag by the ⠿ grip to park the widget anywhere it isn't in the way
    let drag = null;
    root.getElementById('grip').addEventListener('mousedown', (e) => {
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      host.style.left = e.clientX - drag.dx + 'px';
      host.style.top = e.clientY - drag.dy + 'px';
      host.style.transform = 'none';
    });
    document.addEventListener('mouseup', () => { drag = null; });
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
      const q = by('queued').length; if (q) parts.push(q + ' queued');
      const d = by('done').length; if (d) parts.push('✓ ' + d);
      const er = by('error'); if (er.length) parts.push('⚠ ' + er.length);
      if (!working && !q && d && !er.length) qs.textContent = '✓ all ' + d + ' done';
      else qs.textContent = parts.join(' · ');
    };
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
      qs.textContent = '⚡ queued · waiting for ' + AGENT + '…';
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
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', makeWidget);
  } else {
    makeWidget();
  }
})()
