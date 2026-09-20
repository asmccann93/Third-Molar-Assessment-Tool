// tests/implant.mjs — the implant assessment page and its CBCT viewer core.
//
//   npm install jsdom --no-save
//   node tests/implant.mjs
//
// Offline and self-contained. The CBCT used here is a synthetic phantom built
// by this file, voxel by voxel, with known geometry: no scan of any person is
// involved, and none is needed to prove the ruler.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../implant/index.html'), 'utf8');
const viewerSrc = readFileSync(join(here, '../implant/viewer.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? '  — ' + detail : ''}`);
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://oralsurgeryassess.com/implant/',
    beforeParse(win) {
      win.scrollTo = () => {};
      win.__copied = null;
      win.navigator.clipboard = { writeText: async (t) => { win.__copied = t; } };
      win.print = () => {};
    }
  });
  return { dom, win: dom.window, doc: dom.window.document, L: dom.window.__implant };
}
const $ = (doc, sel) => doc.querySelector(sel);
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));

/* ------------------------------------------------------------------ */
section('Preview status and the promise to store nothing');
{
  ok('the page is not to be indexed while it is a preview',
    /<meta name="robots" content="noindex, nofollow"/.test(html.replace(/<!--[\s\S]*?-->/g, '')));
  ok('and it says on screen that it is not for clinical use', /Preview[^<]*not for clinical use/.test(html));
  const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const stores = ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie'].filter((a) => code.includes(a));
  ok('it references no browser storage', stores.length === 0, stores.join(', '));
  const sends = ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket'].filter((a) => code.includes(a));
  ok('and has no way to send anything anywhere', sends.length === 0, sends.join(', '));
}

section('Sites');
{
  const { L } = boot();
  const s36 = L.siteInfo(36), s26 = L.siteInfo(26), s11 = L.siteInfo(11), s41 = L.siteInfo(41), s45 = L.siteInfo(45);
  ok('a lower molar is limited by the canal, which is a nerve', s36.limit.key === 'canal' && s36.limit.vital);
  ok('a lower premolar names the mental foramen', /mental foramen/.test(s45.limit.label) && s45.limit.vital);
  ok('an upper molar is limited by the sinus floor, which can be augmented', s26.limit.key === 'sinus' && !s26.limit.vital);
  ok('an upper incisor is in the aesthetic zone and limited by the nasal floor', s11.aesthetic && s11.limit.key === 'nasal');
  ok('a lower incisor is not in the aesthetic zone', !s41.aesthetic && s41.limit.key === 'border');
}

section('Measurements');
{
  const { L } = boot();
  ok('a comma decimal is read', L.mm('6,5') === 6.5);
  ok('an empty box is "not measured", not zero', L.mm('') === null && L.mm('  ') === null);
  ok('nonsense is refused', Number.isNaN(L.mm('abc')));
  ok('an implausible figure is refused rather than used', Number.isNaN(L.mm('65')) && Number.isNaN(L.mm('0')) && Number.isNaN(L.mm('-3')));
}

section('Clearance checks');
{
  const { L } = boot();
  const D = L.DRAFT;
  const check = (a, key) => L.evaluate(a).checks.find((c) => c.key === key);

  let c = check({ tooth: 36, ht: '12', len: '10' }, 'ht');
  ok(`exactly ${D.vitalClearance} mm above the canal passes`, c && c.ok, c && c.text);
  c = check({ tooth: 36, ht: '12', len: '10.5' }, 'ht');
  ok('1.5 mm above the canal is flagged, and says to go shorter', c && !c.ok && /shorter/.test(c.text), c && c.text);

  c = check({ tooth: 26, ht: '8', len: '10' }, 'ht');
  ok('an implant 2 mm longer than the bone below the sinus is flagged as needing elevation',
    c && !c.ok && /2\.0 mm longer/.test(c.text) && /sinus floor elevation/i.test(c.text), c && c.text);
  c = check({ tooth: 26, ht: '10', len: '10' }, 'ht');
  ok('one that fits below the sinus floor passes', c && c.ok);

  c = check({ tooth: 36, md: '7', dia: '4' }, 'md');
  ok(`${D.toothClearance} mm to each tooth passes`, c && c.ok, c && c.text);
  c = check({ tooth: 36, md: '7', dia: '4.1' }, 'md');
  ok('less is flagged', c && !c.ok);

  c = check({ tooth: 36, bl: '6.5', dia: '4' }, 'bl');
  ok('1.25 mm of wall each side is flagged, shown as 1.25, and names grafting', c && !c.ok && /1\.25 mm/.test(c.text) && /Grafting/.test(c.text), c && c.text);

  const r = L.evaluate({ tooth: 36, dia: '4', len: '10' });
  ok('a blank measurement is never read as a pass: no check is made without it', r.checks.length === 0, JSON.stringify(r.checks));
  const r2 = L.evaluate({ tooth: 36, md: '7', ht: '12' });
  ok('and measurements with no proposed implant make no implant checks', r2.checks.length === 0);
  const r3 = L.evaluate({ tooth: 36, rest: '6' });
  ok(`restorative space under ${D.restorativeMin} mm is flagged without needing an implant`, r3.checks.some((x) => x.key === 'rest' && !x.ok));
  const r4 = L.evaluate({ tooth: 36, md: '65', dia: '4' });
  ok('an implausible measurement makes no check and is reported', r4.checks.length === 0 && r4.invalid.includes('md'));
}

section('Rating');
{
  const { L } = boot();
  ok('no findings is Straightforward', L.evaluate({ tooth: 36 }).rating === 'Straightforward');
  ok('the aesthetic zone adds to the score', L.evaluate({ tooth: 11 }).score === 2);
  const adv = L.evaluate({ tooth: 11, timing: 'present', smoking: 'light' });   // 2 + 2 + 1
  ok('a score of 5 is Advanced', adv.score === 5 && adv.rating === 'Advanced', `${adv.score} ${adv.rating}`);
  const cx = L.evaluate({ tooth: 26, timing: 'present', smoking: 'heavy', diabetes: 'poor', ht: '6', len: '10' });
  ok('a score of 8 or more is Complex', cx.score >= 8 && cx.rating === 'Complex', `${cx.score} ${cx.rating}`);
  const hard = L.evaluate({ tooth: 36, antires: 'cancer' });
  ok('a hard stop takes the case outside routine placement whatever the score', hard.score === 0 && hard.rating === 'Outside routine placement');
  ok('and it carries its own action (refer, here)', /Refer/.test(hard.hard[0].adv.action));
  ok('while growth still to complete says defer, not refer', /Defer/.test(L.evaluate({ tooth: 11, growth: 'no' }).hard[0].adv.action));
  const stale = L.evaluate({ tooth: 36, sinus: 'opaque' });
  ok('a finding that does not apply to the site is ignored by the assessment', !stale.advisories.some((x) => /sinus/i.test(x.q)) && stale.score === 0);
  const all = L.evaluate({});
  ok('unanswered questions are listed as not recorded, not treated as normal', all.unknown.length >= 10, String(all.unknown.length));
}

section('The figure shown never contradicts the verdict');
{
  const { L } = boot();
  const D = L.DRAFT;
  const check = (a, key) => L.evaluate(a).checks.find((c) => c.key === key);
  // Exact thresholds that floating point used to fail.
  ok('a 3.6 mm implant in a 6.6 mm gap has exactly 1.5 mm each side, and passes', check({ tooth: 36, md: '6.6', dia: '3.6' }, 'md').ok);
  ok('11.1 mm of bone and a 9.1 mm implant leave exactly 2 mm, and pass', check({ tooth: 36, ht: '11.1', len: '9.1' }, 'ht').ok);
  const c = check({ tooth: 36, md: '7', dia: '4.1' }, 'md');
  ok('1.45 mm is shown as 1.45, not rounded up to the threshold it fails', !c.ok && /1\.45 mm/.test(c.text), c.text);
  // Every one-decimal combination, both checks: the number on screen must agree with the verdict.
  const bad = [];
  for (let g = 50; g <= 90; g++) for (let d = 30; d <= 55; d++) {
    const md = (g / 10).toFixed(1), dia = (d / 10).toFixed(1);
    for (const key of ['md', 'bl']) {
      const r = check({ tooth: 36, [key]: md, dia }, key);
      const shown = parseFloat(r.text.match(/(-?\d+(\.\d+)?) mm/)[1]);
      if ((shown >= 1.5) !== r.ok) bad.push(`${key} ${md}/${dia}: shows ${shown}, ${r.ok ? 'passes' : 'fails'}`);
    }
  }
  for (let h = 60; h <= 180; h++) for (const len of ['6', '8', '10', '11.5', '13']) {
    const ht = (h / 10).toFixed(1), r = check({ tooth: 36, ht, len }, 'ht');
    const shown = parseFloat(r.text.match(/(-?\d+(\.\d+)?) mm/)[1]);
    if ((shown >= 2) !== r.ok) bad.push(`ht ${ht}/${len}: shows ${shown}, ${r.ok ? 'passes' : 'fails'}`);
  }
  ok('across every one-decimal case, the figure shown agrees with pass or fail', bad.length === 0, bad.slice(0, 3).join('; '));
  const h2 = check({ tooth: 36, ht: '11.96', len: '10' }, 'ht');
  ok('two-decimal entries are compared and shown at two decimals', !h2.ok && /1\.96 mm/.test(h2.text), h2.text);
}

section('A nerve breach is never rated straightforward');
{
  const { L } = boot();
  const r = L.evaluate({ tooth: 36, ht: '8', len: '10' });
  ok('an implant 2 mm into the canal is "Revise the proposed implant", not Straightforward',
    r.rating === 'Revise the proposed implant' && r.vitalBreach, `${r.rating} (score ${r.score})`);
  ok('and a hard stop still takes precedence', L.evaluate({ tooth: 36, ht: '8', len: '10', rt: 'jaw' }).rating === 'Outside routine placement');
  ok('an implant that clears the canal is rated normally', L.evaluate({ tooth: 36, ht: '12', len: '10' }).rating === 'Straightforward');
  ok('a sinus excess is not a nerve breach: it scores, and is rated', L.evaluate({ tooth: 26, ht: '8', len: '10' }).rating === 'Straightforward');
}

section('Nothing entered is silently ignored');
{
  const { L } = boot();
  for (const t of ['12..5', '10-12', '4.1/4.3', '6,5,1', 'about 6']) ok(`"${t}" is refused, not read as a number`, Number.isNaN(L.mm(t)));
  ok('"6.5 mm" and ".5" are read', L.mm('6.5 mm') === 6.5 && L.mm('.5') === 0.5);
  const r = L.evaluate({ ht: '9', len: '10' });
  ok('with no tooth selected, the tooth is listed as not recorded', r.unknown[0] === 'Which tooth is being replaced?');
  const t = L.planText(L.evaluate({ tooth: 36, md: '65', dia: '4' }));
  ok('an invalid measurement is named in the copied plan', /Not used, not valid measurements: Space between the adjacent teeth/.test(t), t);
  const t2 = L.planText(L.evaluate({ tooth: 26, ht: '8' }));
  ok('the copied height names what it was measured to', /Available bone height, crest to the sinus floor: 8 mm/.test(t2), t2);
  ok('and the copied plan says it came from a preview with draft figures', /PREVIEW: DRAFT FIGURES, NOT FOR CLINICAL USE/.test(t2));
  const border = L.evaluate({ tooth: 41, ht: '10', len: '11' }).checks.find((c) => c.key === 'ht');
  ok('a lower incisor reads "the bone above the inferior border"', /above the inferior border/.test(border.text), border.text);
  ok('the preview banner is not hidden when printing', !/@media print\{\.preview\{display:none/.test(html));
}

section('Every advisory is complete');
{
  const { L } = boot();
  const missing = [];
  L.SECTIONS.forEach((s) => s.qs.forEach((q) => (q.opts || []).forEach((o) => {
    if (o.adv && !(o.adv.risk && o.adv.action)) missing.push(q.id + '/' + o.v);
    if (o.hard && !o.adv) missing.push(q.id + '/' + o.v + ' (hard, no advice)');
  })));
  ok('every advisory has a risk and an action, and every hard stop says what to do', missing.length === 0, missing.join(', '));
}

section('The page, driven through its own controls');
{
  const { win, doc, L } = boot();
  const leaving = () => { const ev = new win.Event('beforeunload', { cancelable: true }); win.dispatchEvent(ev); return ev.defaultPrevented; };
  ok('an untouched page lets you leave', !leaving());
  click($(doc, '[data-act="begin"]'));
  const sel = $(doc, '#tooth');
  sel.value = '26'; sel.dispatchEvent(new win.Event('change', { bubbles: true }));
  ok('choosing a tooth describes the site', /sinus floor/.test(doc.getElementById('root').textContent));
  ok('an assessment in progress warns before leaving', leaving());
  click($(doc, '[data-act="next"]')); click($(doc, '[data-act="next"]'));
  const sinusBtn = $(doc, '[data-q="sinus"][data-v="opaque"]');
  ok('an upper molar asks about the sinus', !!sinusBtn);
  click(sinusBtn);
  ok('and the advisory appears as soon as it is answered', /opacified sinus/i.test(doc.getElementById('root').textContent));
  // back to the site and change to a lower molar: the sinus finding must not follow
  click($(doc, '[data-act="back"]')); click($(doc, '[data-act="back"]'));
  const sel2 = $(doc, '#tooth');
  sel2.value = '36'; sel2.dispatchEvent(new win.Event('change', { bubbles: true }));
  click($(doc, '[data-act="next"]')); click($(doc, '[data-act="next"]'));
  ok('a lower molar does not ask about the sinus', !$(doc, '[data-q="sinus"]'));
  click($(doc, '[data-act="next"]')); click($(doc, '[data-act="next"]'));
  ok('and the sinus finding for the old site is gone from the plan', !/opacified/i.test(doc.getElementById('root').textContent));
  // and going back to the upper molar does not bring the old sinus answer back:
  // it was dropped, not merely hidden
  click($(doc, '[data-act="back"]')); click($(doc, '[data-act="back"]')); click($(doc, '[data-act="back"]')); click($(doc, '[data-act="back"]'));
  const sel3 = $(doc, '#tooth');
  sel3.value = '26'; sel3.dispatchEvent(new win.Event('change', { bubbles: true }));
  click($(doc, '[data-act="next"]')); click($(doc, '[data-act="next"]'));
  ok('changing the site back does not resurrect the old sinus answer', $(doc, '[data-q="sinus"][aria-pressed="true"]') === null);
  click($(doc, '[data-act="back"]')); click($(doc, '[data-act="back"]'));
  const sel5 = $(doc, '#tooth');
  sel5.value = '36'; sel5.dispatchEvent(new win.Event('change', { bubbles: true }));
  click($(doc, '[data-act="next"]')); click($(doc, '[data-act="next"]')); click($(doc, '[data-act="next"]')); click($(doc, '[data-act="next"]'));
  click($(doc, '[data-act="copy"]'));
  await tick();
  ok('Copy puts the plan on the clipboard', /IMPLANT CASE ASSESSMENT/.test(win.__copied || '') && /Site: 36/.test(win.__copied || ''));
}

section('Changing the tooth clears the old site');
{
  const { win, doc } = boot();
  const root = () => doc.getElementById('root').textContent;
  const setTooth = (t) => { const sel = $(doc, '#tooth'); sel.value = t; sel.dispatchEvent(new win.Event('change', { bubbles: true })); };
  const type = (id, v) => { const el = $(doc, '#in-' + id); el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); };
  click($(doc, '[data-act="begin"]'));
  setTooth('46');
  click($(doc, '[data-q="timing"][data-v="healed"]'));
  click($(doc, '[data-act="next"]'));
  click($(doc, '[data-q="smoking"][data-v="heavy"]'));
  click($(doc, '[data-act="next"]'));
  type('ht', '11');
  click($(doc, '[data-act="next"]'));
  type('len', '10');
  click($(doc, '[data-act="next"]'));
  ok('at 46, 11 mm of bone and a 10 mm implant is a nerve breach', /Revise the proposed implant/.test(root()));
  // back to the site, and change the tooth
  for (let i = 0; i < 4; i++) click($(doc, '[data-act="back"]'));
  setTooth('16');
  ok('changing the tooth says the old site\'s findings were cleared', /previous tooth were cleared/.test(root()));
  ok('and the healing answer for 46 is gone', !$(doc, '[data-q="timing"][aria-pressed="true"]'));
  click($(doc, '[data-act="next"]'));
  ok('patient factors are kept', !!$(doc, '[data-q="smoking"][data-v="heavy"][aria-pressed="true"]'));
  click($(doc, '[data-act="next"]'));
  ok('the height measured to the canal did not become a height to the sinus floor', $(doc, '#in-ht').value === '');
  click($(doc, '[data-act="next"]'));
  ok('nor did the implant planned for 46 carry over', $(doc, '#in-len').value === '');
}

section('The plan page surfaces what it could not use');
{
  const { win, doc } = boot();
  const root = () => doc.getElementById('root').textContent;
  const type = (id, v) => { const el = $(doc, '#in-' + id); el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); };
  click($(doc, '[data-act="begin"]'));
  click($(doc, '[data-act="next"]')); click($(doc, '[data-act="next"]'));
  type('md', '65');
  click($(doc, '[data-act="next"]'));
  type('dia', '4');
  click($(doc, '[data-act="next"]'));
  ok('an invalid entry is named on the plan page', /Not used:.*Space between the adjacent teeth \("65"\)/.test(root()), root().slice(0, 300));
  ok('and no tooth is called out', /No tooth was selected/.test(root()));
  ok('the measurements are listed on the page, so a printout has them', /Measurements recorded/.test(root()) && /Implant diameter: 4 mm/.test(root()));
}

section('Copy never fails silently');
{
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://oralsurgeryassess.com/implant/',
    beforeParse(win) { win.scrollTo = () => {}; win.print = () => {}; } });   // no clipboard API at all
  const win = dom.window, doc = win.document;
  click($(doc, '[data-act="begin"]'));
  for (let i = 0; i < 4; i++) click($(doc, '[data-act="next"]'));
  click($(doc, '[data-act="copy"]'));
  await tick();
  const box = doc.getElementById('copy-fallback'), area = doc.getElementById('plan-text');
  ok('without a clipboard, the plan is shown to copy by hand', box && !box.hidden && /IMPLANT CASE ASSESSMENT/.test(area.value));
}

section('Keyboard focus survives an answer');
{
  const { win, doc } = boot();
  click($(doc, '[data-act="begin"]'));
  const b = $(doc, '[data-q="timing"][data-v="early"]');
  b.focus(); click(b);
  const a = doc.activeElement;
  ok('after answering, focus is on the answer just chosen, not the top of the page',
    a && a.dataset && a.dataset.q === 'timing' && a.dataset.v === 'early');
}

/* ------------------------------------------------------------------ */
section('CBCT viewer core, on a synthetic phantom');

// A minimal DICOM writer: Explicit VR Little Endian, one slice per file.
function dicomSlice({ rows, cols, ipp, iop, ps, raw, slope, intercept, instance, extra = {}, ts = '1.2.840.10008.1.2.1', bare = false, bits = 16, samples = 1 }) {
  const chunks = [];
  const enc = new TextEncoder();
  const el = (group, elem, vr, value) => {
    let bytes;
    if (value instanceof Uint8Array) bytes = value;
    else if (vr === 'US') { bytes = new Uint8Array(2); new DataView(bytes.buffer).setUint16(0, value, true); }
    else if (vr === 'UL') { bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); }
    else { bytes = enc.encode(String(value)); if (bytes.length % 2) bytes = Uint8Array.from([...bytes, vr === 'UI' ? 0 : 32]); }
    if (bare && group !== 2) {
      // implicit VR: tag, then a 4-byte length, no VR
      const head = new Uint8Array(8), dv = new DataView(head.buffer);
      dv.setUint16(0, group, true); dv.setUint16(2, elem, true); dv.setUint32(4, bytes.length, true);
      return [head, bytes];
    }
    const long = ['OB', 'OW', 'UN', 'SQ', 'UT'].includes(vr);
    const head = new Uint8Array(long ? 12 : 8), dv = new DataView(head.buffer);
    dv.setUint16(0, group, true); dv.setUint16(2, elem, true);
    head[4] = vr.charCodeAt(0); head[5] = vr.charCodeAt(1);
    if (long) dv.setUint32(8, bytes.length, true); else dv.setUint16(6, bytes.length, true);
    return [head, bytes];
  };
  const meta = [el(2, 1, 'OB', Uint8Array.from([0, 1])), el(2, 2, 'UI', '1.2.840.10008.5.1.4.1.1.2'),
    el(2, 3, 'UI', '1.2.3.' + instance), el(2, 0x10, 'UI', ts)].flat();
  const metaLen = meta.reduce((n, b) => n + b.length, 0);
  if (!bare) chunks.push(new Uint8Array(128), enc.encode('DICM'), ...el(2, 0, 'UL', metaLen), ...meta);
  const ds = [
    [8, 0x16, 'UI', '1.2.840.10008.5.1.4.1.1.2'], [8, 0x60, 'CS', 'CT'],
    [0x10, 0x10, 'PN', 'SENTINEL^MUST-NOT-DISPLAY'], [0x10, 0x20, 'LO', 'SENTINEL-ID'], [0x10, 0x30, 'DA', '19000101'],
    [0x20, 0x0e, 'UI', '1.2.3.999'], [0x20, 0x13, 'IS', String(instance)],
    [0x20, 0x32, 'DS', ipp.join('\\')], [0x20, 0x37, 'DS', iop.join('\\')],
    ...(extra.frames ? [[0x28, 0x08, 'IS', String(extra.frames)]] : []),
    [0x28, 0x02, 'US', samples], [0x28, 0x04, 'CS', samples === 3 ? 'RGB' : 'MONOCHROME2'], [0x28, 0x10, 'US', rows], [0x28, 0x11, 'US', cols],
    [0x28, 0x30, 'DS', ps.join('\\')], [0x28, 0x100, 'US', bits], [0x28, 0x101, 'US', bits], [0x28, 0x102, 'US', bits - 1], [0x28, 0x103, 'US', bits === 16 ? 1 : 0],
    [0x28, 0x1052, 'DS', String(intercept)], [0x28, 0x1053, 'DS', String(slope)],
    [0x7fe0, 0x10, 'OW', new Uint8Array(raw.buffer)]
  ];
  ds.forEach(([g, e, vr, v]) => chunks.push(...el(g, e, vr, v)));
  const total = chunks.reduce((n, b) => n + b.length, 0), out = new Uint8Array(total);
  let o = 0; chunks.forEach((b) => { out.set(b, o); o += b.length; });
  return out;
}

// The phantom: a 7.0 mm wide ridge of bone (1200) from z 5 to 30, running at 30
// degrees to the scanner's x axis, with a canal (0) of radius 1.5 centred at z 15.
// Voxels 0.25 x 0.25 x 0.30 mm. Each voxel is the mean of 2x2x2 sub-samples, so
// edges are partial-volume as in a real scan.
function phantom() {
  const NX = 160, NY = 160, NZ = 110, PX = 0.25, PZ = 0.30, O = [-20, -20, 0];
  const A = Math.PI / 6, n = [-Math.sin(A), Math.cos(A)];
  const off = [-0.25, 0.25];
  const files = [];
  const order = [...Array(NZ).keys()].sort((a, b) => ((a * 7919) % 211) - ((b * 7919) % 211));  // not spatial
  for (const k of order) {
    const raw = new Int16Array(NX * NY);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      let acc = 0;
      for (const ox of off) for (const oy of off) for (const oz of off) {
        const x = O[0] + (i + ox) * PX, y = O[1] + (j + oy) * PX, z = O[2] + (k + oz) * PZ;
        const across = x * n[0] + y * n[1];
        const ridge = Math.abs(across) <= 3.5 && z >= 5 && z <= 30;
        const canal = across * across + (z - 15) ** 2 <= 2.25;
        acc += ridge ? (canal ? 0 : 1200) : -1000;
      }
      raw[i + NX * j] = Math.round(acc / 8 + 1024);
    }
    files.push(dicomSlice({ rows: NY, cols: NX, ipp: [O[0], O[1], O[2] + k * PZ], iop: [1, 0, 0, 0, 1, 0],
      ps: [PX, PX], raw, slope: 1, intercept: -1024, instance: files.length + 1 }));
  }
  return files;
}

{
  const V = await import('data:text/javascript;base64,' + Buffer.from(viewerSrc).toString('base64'));
  const files = phantom();
  const vol = V.loadSeries(files, V.dicomParser);
  ok('slices are put in spatial order, and spacing comes from their positions', Math.abs(vol.spacing[2] - 0.3) < 1e-6 && vol.nz === 110);
  ok('no identifying value reaches anything the viewer returns',
    !/SENTINEL|19000101/.test(JSON.stringify({ ...vol, hu: undefined })));

  const crossings = (a, b, thr) => {
    const L = V.distanceMm(a, b), n = Math.round(L / 0.01), out = [];
    let prev = V.sampleMm(vol, a) >= thr;
    for (let i = 1; i <= n; i++) {
      const t = i / n, v = V.sampleMm(vol, a.map((x, k) => x + (b[k] - x) * t)) >= thr;
      if (v !== prev) out.push(t * L);
      prev = v;
    }
    return out;
  };
  const A = Math.PI / 6, across = [-Math.sin(A), Math.cos(A), 0];
  const cs = V.crossSection(vol, [0, 0, 17.5], [Math.cos(A), Math.sin(A), 0], 20, 40, 0.1);
  ok('the cross-section is cut across the ridge, not along it', Math.abs(Math.abs(cs.u[0] * across[0] + cs.u[1] * across[1]) - 1) < 1e-9);
  const w = crossings([0, 0, 25].map((c, k) => c - across[k] * 8), [0, 0, 25].map((c, k) => c + across[k] * 8), 100);
  ok('ridge width reads 7.0 mm (within 0.1)', w.length === 2 && Math.abs(w[1] - w[0] - 7) < 0.1, w.length === 2 ? (w[1] - w[0]).toFixed(3) : JSON.stringify(w));
  const crest = crossings([0, 0, 35], [0, 0, 10], 100)[0], roof = crossings([0, 0, 35], [0, 0, 10], 600)[1];
  ok('crest to canal reads 13.5 mm (within 0.1)', Math.abs(roof - crest - 13.5) < 0.1, (roof - crest).toFixed(3));
  const col = cs.w / 2 - 0.5, row = (z) => cs.h / 2 - 0.5 - (z - 17.5) / cs.step;
  ok('two points placed on the section image measure 13.5 mm exactly',
    Math.abs(V.distanceMm(V.imageToMm(cs, col, row(30)), V.imageToMm(cs, col, row(16.5))) - 13.5) < 1e-9);

  const refuse = (label, list, re) => {
    try { V.loadSeries(list, V.dicomParser); ok(label, false, 'loaded'); }
    catch (e) { ok(label, e instanceof V.ScanError && re.test(e.message), e.message); }
  };
  refuse('a series with a missing slice is refused, not stretched', files.filter((_, i) => i !== 40), /uneven/i);
  refuse('a single slice is refused', files.slice(0, 1), /one slice/i);
  const raw = new Int16Array(4);
  refuse('a compressed export is refused with a reason',
    [dicomSlice({ rows: 2, cols: 2, ipp: [0, 0, 0], iop: [1, 0, 0, 0, 1, 0], ps: [1, 1], raw, slope: 1, intercept: 0, instance: 1, ts: '1.2.840.10008.1.2.4.90' })], /compressed/i);
  refuse('a multi-frame export is refused with a reason',
    [dicomSlice({ rows: 2, cols: 2, ipp: [0, 0, 0], iop: [1, 0, 0, 0, 1, 0], ps: [1, 1], raw, slope: 1, intercept: 0, instance: 1, extra: { frames: 2 } })], /multi-frame/i);
  refuse('files that are not DICOM are refused, and the reason given', [new TextEncoder().encode('not a scan')], /No usable CBCT slices.*not DICOM/i);

  // Small hand-made series for the edge cases: 4 x 4 pixels, n slices.
  const small = (n, { iop = [1, 0, 0, 0, 1, 0], shift = 0, bare = false } = {}) =>
    [...Array(n).keys()].map((k) => dicomSlice({ rows: 4, cols: 4, ipp: [k * shift, 0, k * 0.5], iop, ps: [0.5, 0.5],
      raw: new Int16Array(16).fill(1024), slope: 1, intercept: -1024, instance: k + 1, bare }));

  ok('the volume is held as 16-bit, not 32 (half the memory for a large scan)', vol.hu instanceof Int16Array);

  const thumb = dicomSlice({ rows: 2, cols: 2, ipp: [0, 0, 0], iop: [1, 0, 0, 0, 1, 0], ps: [1, 1],
    raw: new Int16Array(6), slope: 1, intercept: 0, instance: 999, bits: 8, samples: 3 });
  let v2 = null;
  try { v2 = V.loadSeries([...files, thumb], V.dicomParser); } catch (e) { v2 = e; }
  ok('a colour thumbnail in the folder is set aside, not fatal',
    v2 && v2.nz === 110 && v2.warnings.some((w) => /set aside/.test(w)), v2 && (v2.message || JSON.stringify(v2.warnings)));

  let v3 = null;
  try { v3 = V.loadSeries(small(3, { bare: true }), V.dicomParser); } catch (e) { v3 = e; }
  ok('files with no DICOM preamble are read', v3 && v3.nz === 3, v3 && v3.message);

  let v4 = null;
  try { v4 = V.loadSeries(small(3, { iop: [0.999, 0.017, 0, -0.017, 0.999, 0] }), V.dicomParser); } catch (e) { v4 = e; }
  ok('an orientation written to three decimals still loads', v4 && v4.nz === 3, v4 && v4.message);

  refuse('a sheared series (slices drifting sideways) is refused, not measured short', small(4, { shift: 1 }), /offset sideways/i);

  const deg = (dir) => { try { V.crossSection(vol, [0, 0, 17.5], dir, 20, 40, 0.1); return 'drew'; } catch (e) { return e instanceof V.ScanError ? e.message : 'crashed: ' + e.message; } };
  ok('two clicks on the same spot are refused, saying what to do, not drawn as NaN', /two different points/.test(deg([0, 0, 0])), deg([0, 0, 0]));
  ok('and so is a direction straight up and down', /two different points/.test(deg([0, 0, 1])), deg([0, 0, 1]));
  let rs = 'drew';
  try { V.reslice(vol, [0, 0, 17.5], [0, 0, 0], [0, 0, 1], 10, 10, 0.1); } catch (e) { rs = e instanceof V.ScanError ? 'refused' : 'crashed'; }
  ok('a plane with no direction is refused by the reslicer itself too', rs === 'refused', rs);
}

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
