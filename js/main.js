import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { stateAt, samplePath, timeToApsis, meanMotion } from './orbits.js?v=20261008014049';

const POLL_MS = 60000;
const $ = (id) => document.getElementById(id);

// ---------- state ----------
let env = null;            // vessels.json
let bodies = {};           // name -> body
let history = { entries: {} };
let notes = {};            // id -> {text, ts}
let fetchedReal = 0;
let selected = null;       // {kind:'vessel'|'body', key}
const vesselObjs = new Map();   // id -> {label, lines:[{obj, body}], nodes:[{label, body, rel}]}
const bodyObjs = new Map();     // name -> {group, mesh, label, orbitLine}
const posCache = new Map();

// ---------- repo / data access ----------
function detectRepo() {
  const q = new URLSearchParams(location.search).get('repo');
  if (q) { try { localStorage.setItem('ft.repo', q); } catch {} return q; }
  if (location.hostname.endsWith('.github.io')) {
    const owner = location.hostname.split('.')[0];
    return `${owner}/${location.pathname.split('/')[1] || owner + '.github.io'}`;
  }
  try { return localStorage.getItem('ft.repo'); } catch { return null; }
}
const repo = detectRepo();
const DATA_BRANCH = 'data';

async function getJSON(name) {
  if (repo) {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/data/${name}?ref=${DATA_BRANCH}`,
        { headers: { Accept: 'application/vnd.github.raw+json' } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch { /* fall through to local */ }
  }
  try {
    const r = await fetch(`data/${name}?t=${Date.now()}`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ---------- time ----------
const DAY = 21600, YEAR = 426 * DAY;
function fmtDur(s, parts = 3) {
  if (!Number.isFinite(s)) return '—';
  const neg = s < 0; s = Math.abs(Math.round(s));
  const u = [['y', YEAR], ['d', DAY], ['h', 3600], ['m', 60], ['s', 1]];
  const out = [];
  for (const [n, v] of u) { const q = Math.floor(s / v); s -= q * v; if (q || (n === 's' && !out.length)) out.push(q + n); }
  return (neg ? '-' : '') + out.slice(0, parts).join(' ');
}
function fmtUT(ut) { const y = Math.floor(ut / YEAR) + 1, d = Math.floor((ut % YEAR) / DAY) + 1; return `Y${y}, Day ${d}`; }
const fmtDist = (m) => Math.abs(m) >= 1e9 ? (m / 1e9).toFixed(2) + ' Gm' : Math.abs(m) >= 1e6 ? (m / 1e6).toFixed(2) + ' Mm'
  : Math.abs(m) >= 1e3 ? (m / 1e3).toFixed(1) + ' km' : m.toFixed(0) + ' m';

function ageSeconds() { return env ? (Date.now() - Date.parse(env.savedAt)) / 1000 : Infinity; }
function isLive() { return env && ageSeconds() < (env.heartbeatSeconds || 300) * 1.5; }
function nowUT() {
  if (!env) return 0;
  if (env.paused) return env.ut;
  const dt = Math.min(ageSeconds(), env.heartbeatSeconds || 300);
  return env.ut + dt * (env.warp || 1);
}

// ---------- scene ----------
const sceneEl = $('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
sceneEl.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none';
sceneEl.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.001, 1e12);
camera.position.set(0, 4e6, 6e6);   // units are km; replaced once bodies load
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 0.02;
controls.maxDistance = 1e11;
controls.zoomSpeed = 1.4;
scene.add(new THREE.AmbientLight(0x8090b0, 0.55));
const sunLight = new THREE.PointLight(0xffffff, 2.2, 0, 0);
scene.add(sunLight);

// star field: follows the camera so it always sits at infinity
const stars = (() => {
  const g = new THREE.BufferGeometry(), n = 1800, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(5e11);
    p.set([v.x, v.y, v.z], i * 3);
  }
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9aa8c8, size: 1.4, sizeAttenuation: false, fog: false }));
  pts.frustumCulled = false;
  scene.add(pts);
  return pts;
})();

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h); labelRenderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// ---------- true scale ----------
// 1 scene unit = 1 km. Positions are exact (doubles on the CPU); the log depth buffer and a
// camera that always orbits its target keep both planets and low orbits renderable.
function isSun(b) { return !b.orbit; }
function toKm(rel) { return new THREE.Vector3(rel[0] / 1000, rel[1] / 1000, rel[2] / 1000); }

function bodyPos(name, t) {
  const key = name;
  if (posCache.has(key)) return posCache.get(key);
  const b = bodies[name];
  let p = new THREE.Vector3();
  if (b && b.orbit && bodies[b.orbit.body]) {
    const par = bodies[b.orbit.body];
    p = bodyPos(par.name, t).clone().add(toKm(stateAt(b.orbit, par.mu, t)));
  }
  posCache.set(key, p);
  return p;
}

function pathPoints(o, parent) {
  return samplePath(o, parent.mu, 360).map(toKm);
}

function makeLine(points, color, dashed) {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: dashed ? 0.95 : 0.7 }));
  l.frustumCulled = false;
  return l;
}

function makeLabel(text, cls, onClick) {
  const el = document.createElement('div');
  el.className = 'lbl ' + cls; el.textContent = text;
  el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return new CSS2DObject(el);
}

// ---------- textures (exported from the game by the mod) ----------
const texLoader = new THREE.TextureLoader();
function loadTexture(b, mesh) {
  const base = repo ? `https://raw.githubusercontent.com/${repo}/${DATA_BRANCH}/data/textures/` : 'data/textures/';
  texLoader.load(base + encodeURIComponent(b.name) + '.jpg', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const m = mesh.material;
    m.map = tex;
    m.color.set(0xffffff);
    m.needsUpdate = true;
  }, undefined, () => { /* no texture exported yet: keep flat colour */ });
}

// ---------- build bodies ----------
function buildBodies() {
  for (const o of bodyObjs.values()) { scene.remove(o.group); scene.remove(o.orbitGroup); }
  bodyObjs.clear();
  for (const b of Object.values(bodies)) {
    const col = new THREE.Color('#' + (b.color || '8899aa'));
    const group = new THREE.Group();
    const sun = isSun(b);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(b.radius / 1000, 96, 64),
      sun ? new THREE.MeshBasicMaterial({ color: 0xffd27a })
          : new THREE.MeshStandardMaterial({ color: col.clone().lerp(new THREE.Color(0xffffff), 0.25), roughness: 0.95, metalness: 0 }));
    group.add(mesh);
    loadTexture(b, mesh);
    const label = makeLabel(b.name, 'body', () => select('body', b.name));
    group.add(label);
    scene.add(group);

    const orbitGroup = new THREE.Group();
    if (b.orbit && bodies[b.orbit.body]) {
      orbitGroup.add(makeLine(pathPoints(b.orbit, bodies[b.orbit.body]), col, false));
    }
    scene.add(orbitGroup);
    bodyObjs.set(b.name, { group, mesh, label, orbitGroup, parent: b.orbit && b.orbit.body });
  }
}

// ---------- build vessels ----------
const TYPE_ICON = { Ship: 'Ship', Probe: 'Probe', Rover: 'Rover', Lander: 'Lander', Station: 'Station', Base: 'Base', Plane: 'Plane', Relay: 'Relay' };

function buildVessels() {
  for (const v of vesselObjs.values()) { v.group.parent && v.group.parent.remove(v.group); v.root.forEach((o) => scene.remove(o)); }
  vesselObjs.clear();
  if (!env) return;
  for (const v of env.vessels) {
    const group = new THREE.Group();
    const label = makeLabel(v.name, 'vessel', () => select('vessel', String(v.id)));
    group.add(label);
    scene.add(group);
    const root = [];       // orbit-line groups that follow a body
    const nodeLabels = [];
    (v.patches || []).forEach((p, i) => {
      const par = bodies[p.body];
      if (!par) return;
      const g = new THREE.Group();
      g.add(makeLine(pathPoints(p, par), i === 0 ? 0x5cc8ff : 0xffb454, i > 0));
      scene.add(g);
      root.push(g);
      g.userData.body = p.body;
    });
    (v.maneuvers || []).forEach((m) => {
      const patch = (v.patches || []).find((p) => m.ut >= p.startUT && m.ut <= p.endUT) || (v.patches || [])[0];
      if (!patch || !bodies[patch.body]) return;
      const rel = stateAt(patch, bodies[patch.body].mu, m.ut);
      const l = makeLabel(`ΔV ${m.dvMag.toFixed(0)} m/s`, 'node', () => select('vessel', String(v.id)));
      l.position.copy(toKm(rel));
      const g = new THREE.Group(); g.add(l); scene.add(g); root.push(g);
      g.userData.body = patch.body;
    });
    vesselObjs.set(String(v.id), { group, label, root, v });
  }
}

// ---------- per-frame update ----------
function vesselRel(v, t) {
  // returns {body, vec} where vec is the offset from that body in km
  const patches = v.patches || [];
  if (['LANDED', 'SPLASHED', 'PRELAUNCH'].includes(v.situation) || !patches.length) {
    const b = bodies[v.body]; if (!b) return null;
    const la = v.lat * Math.PI / 180, lo = v.lon * Math.PI / 180;
    const R = b.radius + Math.max(0, v.alt || 0);
    return { body: b, vec: toKm([Math.cos(la) * Math.cos(lo) * R, Math.sin(la) * R, -Math.cos(la) * Math.sin(lo) * R]) };
  }
  let p = patches.find((q) => t >= q.startUT && t < q.endUT) || (t < patches[0].startUT ? patches[0] : patches[patches.length - 1]);
  const b = bodies[p.body]; if (!b) return null;
  return { body: b, vec: toKm(stateAt(p, b.mu, t)) };
}

function frame() {
  requestAnimationFrame(frame);
  posCache.clear();
  const t = nowUT();
  for (const [name, o] of bodyObjs) {
    o.group.position.copy(bodyPos(name, t));
    if (o.parent) o.orbitGroup.position.copy(bodyPos(o.parent, t));
  }
  sunLight.position.copy([...bodyObjs.values()].find((o) => !o.parent)?.group.position ?? new THREE.Vector3());
  for (const o of vesselObjs.values()) {
    const r = vesselRel(o.v, t);
    if (r) o.group.position.copy(bodyPos(r.body.name, t)).add(r.vec);
    o.root.forEach((g) => g.position.copy(bodyPos(g.userData.body, t)));
  }
  followSelection(t);
  controls.update();
  stars.position.copy(camera.position);
  camera.near = Math.max(1e-3, camera.position.distanceTo(controls.target) * 1e-3);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

let followPrev = null;
function followSelection(t) {
  if (!selected) { followPrev = null; return; }
  const obj = selected.kind === 'vessel' ? vesselObjs.get(selected.key)?.group : bodyObjs.get(selected.key)?.group;
  if (!obj) return;
  const target = obj.position;
  if (followPrev && followPrev.key === selected.key) {
    const d = target.clone().sub(controls.target);
    camera.position.add(d); controls.target.copy(target);
  } else {
    // new selection: glide the target and zoom in
    const host = selected.kind === 'body' ? bodies[selected.key] : bodies[vesselObjs.get(selected.key)?.v.body];
    const dist = host ? host.radius / 1000 * (selected.kind === 'body' ? 3.2 : 2.6) : 1000;
    controls.target.copy(target);
    const dir = camera.position.clone().sub(target).normalize();
    camera.position.copy(target).addScaledVector(dir, dist);
    followPrev = { key: selected.key };
  }
}

// ---------- sidebar & panel ----------
function select(kind, key) {
  selected = { kind, key };
  followPrev = null;
  document.querySelectorAll('.lbl').forEach((e) => e.classList.remove('sel'));
  const lab = kind === 'vessel' ? vesselObjs.get(key)?.label : bodyObjs.get(key)?.label;
  lab?.element.classList.add('sel');
  renderLists();
  renderPanel();
}
function deselect() { selected = null; $('panel').hidden = true; renderLists(); }

function renderLists() {
  const f = $('filter').value.trim().toLowerCase();
  const vl = $('vessel-list'); vl.innerHTML = '';
  const vs = (env?.vessels || []).filter((v) => v.name.toLowerCase().includes(f)).sort((a, b) => a.name.localeCompare(b.name));
  if (!vs.length) vl.innerHTML = '<li class="empty">' + (env ? 'No matching vessels' : 'No data yet') + '</li>';
  for (const v of vs) {
    const li = document.createElement('li');
    li.className = 'row' + (selected?.kind === 'vessel' && selected.key === String(v.id) ? ' sel' : '');
    li.innerHTML = `<span class="nm"></span><span class="sub"></span>`;
    li.firstChild.textContent = v.name; li.lastChild.textContent = v.body;
    li.onclick = () => select('vessel', String(v.id));
    vl.appendChild(li);
  }
  const bl = $('body-list'); bl.innerHTML = '';
  for (const b of Object.values(bodies)) {
    const li = document.createElement('li');
    li.className = 'row' + (selected?.kind === 'body' && selected.key === b.name ? ' sel' : '');
    li.innerHTML = '<span class="nm"></span>'; li.firstChild.textContent = b.name;
    li.onclick = () => select('body', b.name);
    bl.appendChild(li);
  }
  const hl = $('history-list'); hl.innerHTML = '';
  const flying = new Set((env?.vessels || []).map((v) => v.name));
  const past = Object.entries(history.entries || {}).filter(([k]) => !flying.has(k)).sort((a, b) => b[1].recoveries - a[1].recoveries);
  if (!past.length) hl.innerHTML = '<li class="empty">Name vessels Type:Name to track recoveries</li>';
  for (const [k, e] of past) {
    const li = document.createElement('li'); li.className = 'row';
    li.innerHTML = '<span class="nm"></span><span class="sub"></span>';
    li.firstChild.textContent = k; li.lastChild.textContent = `${e.recoveries}× recovered`;
    hl.appendChild(li);
  }
}

function nextEvent(v, t) {
  const man = (v.maneuvers || []).filter((m) => m.ut > t).sort((a, b) => a.ut - b.ut)[0];
  if (man) return { text: `Maneuver in ${fmtDur(man.ut - t)}`, detail: `ΔV ${man.dvMag.toFixed(1)} m/s` };
  if (['LANDED', 'SPLASHED', 'PRELAUNCH'].includes(v.situation)) return { text: `${v.situation.toLowerCase()} on ${v.body}`, detail: '' };
  const patches = v.patches || [];
  const idx = patches.findIndex((q) => t >= q.startUT && t < q.endUT);
  const cur = patches[idx >= 0 ? idx : 0];
  if (cur) {
    const next = patches[(idx >= 0 ? idx : 0) + 1];
    if (next && ['ENCOUNTER', 'ESCAPE'].includes(cur.trans)) {
      const verb = cur.trans === 'ESCAPE' ? 'Escape' : 'Encounter';
      return { text: `${verb} ${cur.trans === 'ESCAPE' ? 'from ' + cur.body : 'with ' + next.body} in ${fmtDur(cur.endUT - t)}`, detail: `then orbiting ${next.body}` };
    }
    if (cur.trans === 'IMPACT') return { text: `Impact on ${cur.body} in ${fmtDur(cur.endUT - t)}`, detail: '' };
    if (cur.ecc < 1 && bodies[cur.body]) {
      const a = timeToApsis(cur, bodies[cur.body].mu, t);
      return a.pe < a.ap ? { text: `Periapsis in ${fmtDur(a.pe)}`, detail: fmtDist(cur.peA) + ' altitude' }
                         : { text: `Apoapsis in ${fmtDur(a.ap)}`, detail: fmtDist(cur.apA) + ' altitude' };
    }
  }
  return { text: 'No planned events', detail: '' };
}

function renderPanel() {
  const el = $('panel');
  if (!selected) { el.hidden = true; return; }
  el.hidden = false;
  const t = nowUT();
  if (selected.kind === 'body') {
    const b = bodies[selected.key];
    el.innerHTML = `<button class="close" aria-label="Close">×</button><h3></h3><div class="kind">Celestial body</div>
      <dl class="kv"><dt>Radius</dt><dd>${fmtDist(b.radius)}</dd><dt>SOI</dt><dd>${b.soi && isFinite(b.soi) ? fmtDist(b.soi) : '—'}</dd>
      <dt>Atmosphere</dt><dd>${b.atmosphere ? 'Yes' : 'No'}</dd>
      ${b.orbit ? `<dt>Orbits</dt><dd>${b.orbit.body}</dd><dt>Semi-major axis</dt><dd>${fmtDist(b.orbit.sma)}</dd><dt>Inclination</dt><dd>${b.orbit.inc.toFixed(2)}°</dd>` : ''}</dl>
      <h4 class="hint">Vessels here</h4><div>${(env?.vessels || []).filter((v) => v.body === b.name).map((v) => v.name).join('<br>') || '<span class="hint">None</span>'}</div>`;
    el.querySelector('h3').textContent = b.name;
    el.querySelector('.close').onclick = deselect;
    return;
  }
  const v = vesselObjs.get(selected.key)?.v;
  if (!v) { el.hidden = true; return; }
  const ev = nextEvent(v, t);
  const p0 = (v.patches || [])[0];
  const key = v.tracked ? `${v.tracked.type}:${v.tracked.name}` : null;
  const ent = key && history.entries?.[key];
  const flown = ent ? ent.recoveries : 0;
  const flightsHtml = v.tracked
    ? `<div class="card flights"><h4>Flight record</h4>Flown <b>${flown}</b> time${flown === 1 ? '' : 's'} before · this is flight <b>#${flown + 1}</b>
        <div class="hint">${v.tracked.type} · ${v.tracked.name}${ent?.lastRecoveredAt ? ' · last recovered ' + fmtUT(ent.lastRecoveredUT) : ''}</div></div>`
    : `<div class="card"><h4>Flight record</h4><span class="hint">Name it <code>Type:Name</code> in game to track recoveries.</span></div>`;
  const res = Object.entries(v.resources || {}).filter(([, r]) => r.max > 0)
    .map(([n, r]) => `<div class="res"><span>${n}</span><span>${r.amount.toFixed(r.max > 100 ? 0 : 1)} / ${r.max.toFixed(r.max > 100 ? 0 : 1)}</span></div>
      <div class="bar"><i style="width:${Math.min(100, (r.amount / r.max) * 100)}%"></i></div>`).join('') || '<span class="hint">None</span>';
  const crew = (v.crew || []).map((c) => `<div class="crew"><span></span><span class="hint">${c.trait} · L${c.level}</span></div>`).join('') || '<span class="hint">Uncrewed</span>';
  const mt = v.missionTime + (t - env.ut);
  el.innerHTML = `<button class="close" aria-label="Close">×</button><h3></h3><div class="kind">${v.type} · ${v.situation.toLowerCase().replace('_', ' ')} · ${v.body}</div>
    <div class="card"><h4>Next event</h4><div class="event">${ev.text}</div><div class="hint">${ev.detail}</div></div>
    ${flightsHtml}
    <div class="card"><h4>Flight</h4><dl class="kv"><dt>Mission time</dt><dd>${fmtDur(mt, 4)}</dd><dt>Launched</dt><dd>${v.launchUT > 0 ? fmtUT(v.launchUT) : '—'}</dd></dl></div>
    ${p0 ? `<div class="card"><h4>Trajectory</h4><dl class="kv"><dt>Apoapsis</dt><dd>${p0.ecc < 1 ? fmtDist(p0.apA) : '—'}</dd><dt>Periapsis</dt><dd>${fmtDist(p0.peA)}</dd>
      <dt>Inclination</dt><dd>${p0.inc.toFixed(2)}°</dd><dt>Eccentricity</dt><dd>${p0.ecc.toFixed(3)}</dd><dt>Period</dt><dd>${p0.ecc < 1 ? fmtDur(p0.period) : '—'}</dd>
      <dt>Patches</dt><dd>${v.patches.map((q) => q.body).join(' → ')}</dd></dl></div>` : ''}
    <div class="card"><h4>Crew</h4>${crew}</div>
    <div class="card"><h4>Resources</h4>${res}</div>
    <div class="card"><h4>Description</h4><textarea id="desc" placeholder="Mission notes…"></textarea>
      <button class="btn" id="save-desc">Save</button><button class="btn" id="exp">Export</button><button class="btn" id="imp">Import</button><button class="btn" id="sync">Sync to repo</button>
      <div class="hint" id="desc-msg"></div></div>`;
  el.querySelector('h3').textContent = v.name;
  el.querySelectorAll('.crew')?.forEach((n, i) => { n.firstElementChild.textContent = v.crew[i].name; });
  el.querySelector('.close').onclick = deselect;
  wireNotes(String(v.id));
}

// ---------- notes (localStorage + optional repo sync) ----------
function loadLocalNotes() { try { return JSON.parse(localStorage.getItem('ft.notes') || '{}'); } catch { return {}; } }
function saveLocalNotes(n) { try { localStorage.setItem('ft.notes', JSON.stringify(n)); } catch {} }

function wireNotes(id) {
  const ta = $('desc'), msg = $('desc-msg');
  ta.value = notes[id]?.text || '';
  const save = () => { notes[id] = { text: ta.value, ts: Date.now() }; saveLocalNotes(notes); msg.textContent = 'Saved in this browser.'; };
  $('save-desc').onclick = save;
  ta.onblur = () => { if ((notes[id]?.text || '') !== ta.value) save(); };
  $('exp').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' }));
    a.download = 'notes.json'; a.click();
  };
  $('imp').onclick = () => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'application/json';
    i.onchange = async () => {
      try { mergeNotes(JSON.parse(await i.files[0].text())); saveLocalNotes(notes); ta.value = notes[id]?.text || ''; msg.textContent = 'Imported.'; }
      catch { msg.textContent = 'Not a valid notes file.'; }
    };
    i.click();
  };
  $('sync').onclick = async () => {
    save();
    if (!repo) { msg.textContent = 'Open the site via your github.io URL (or add ?repo=owner/name) to sync.'; return; }
    let tok; try { tok = localStorage.getItem('ft.token'); } catch {}
    if (!tok) {
      tok = prompt('GitHub token with Contents: write on this repo (stored only in this browser):');
      if (!tok) return;
      try { localStorage.setItem('ft.token', tok); } catch {}
    }
    msg.textContent = 'Syncing…';
    try { await pushNotes(tok); msg.textContent = 'Synced to repo.'; }
    catch (e) { msg.textContent = 'Sync failed: ' + e.message; if (/401|403/.test(e.message)) try { localStorage.removeItem('ft.token'); } catch {} }
  };
}

function mergeNotes(remote) {
  for (const [k, v] of Object.entries(remote || {})) if (!notes[k] || (v.ts || 0) > (notes[k].ts || 0)) notes[k] = v;
}

async function pushNotes(tok) {
  const url = `https://api.github.com/repos/${repo}/contents/data/notes.json`;
  const hdr = { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' };
  const cur = await fetch(`${url}?ref=${DATA_BRANCH}`, { headers: hdr });
  let sha;
  if (cur.ok) {
    const j = await cur.json(); sha = j.sha;
    try { mergeNotes(JSON.parse(decodeURIComponent(escape(atob(j.content.replace(/\n/g, '')))))); saveLocalNotes(notes); } catch {}
  } else if (cur.status !== 404) throw new Error(cur.status);
  const body = { message: 'notes update', branch: DATA_BRANCH,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(notes, null, 2)))), ...(sha ? { sha } : {}) };
  const r = await fetch(url, { method: 'PUT', headers: hdr, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(r.status);
}

// ---------- data loop ----------
async function refresh() {
  const [b, v, h, n] = await Promise.all([getJSON('bodies.json'), getJSON('vessels.json'), getJSON('history.json'), getJSON('notes.json')]);
  let rebuildBodies = false;
  if (b?.bodies && JSON.stringify(Object.keys(bodies)) !== JSON.stringify(b.bodies.map((x) => x.name))) {
    bodies = Object.fromEntries(b.bodies.map((x) => [x.name, x])); rebuildBodies = true;
  }
  if (rebuildBodies) {
    buildBodies();
    if (!selected) {
      const far = Math.max(...Object.values(bodies).map((x) => (x.orbit ? Math.abs(x.orbit.sma) * (1 + x.orbit.ecc) : 0)), 1) / 1000;
      controls.target.set(0, 0, 0);
      camera.position.set(0, far * 1.1, far * 1.6);
    }
  }
  if (h) history = h;
  if (n) { mergeNotes(n); saveLocalNotes(notes); }
  if (v) {
    const changed = !env || env.savedAt !== v.savedAt;
    for (const x of v.vessels) for (const q of x.patches || []) { // JSON null = infinite
      if (q.endUT == null) q.endUT = Infinity;
      if (q.startUT == null) q.startUT = -Infinity;
    }
    env = v; fetchedReal = Date.now();
    if (changed) { buildVessels(); if (selected?.kind === 'vessel' && !vesselObjs.has(selected.key)) deselect(); }
  }
  renderLists();
  if (selected) renderPanelLive();
}

// refresh the dynamic parts of an open panel without clobbering the textarea
function renderPanelLive() {
  const ta = $('desc');
  if (ta && document.activeElement === ta) return;
  const draft = ta?.value;
  renderPanel();
  if (draft != null && $('desc') && (notes[selected.key]?.text || '') !== draft) $('desc').value = draft;
}

function tickClock() {
  const live = isLive();
  const badge = $('live');
  badge.className = 'badge ' + (env ? (live ? 'live' : 'stale') : '');
  badge.textContent = !env ? 'NO DATA' : live ? 'LIVE' : 'OFFLINE · ' + fmtDur(ageSeconds(), 2) + ' ago';
  $('clock').textContent = env ? fmtUT(nowUT()) + (env.warp > 1 && live ? ` · ${env.warp}×` : '') : '';
  if (selected?.kind === 'vessel') renderPanelLive();
}

$('filter').addEventListener('input', renderLists);
notes = loadLocalNotes();
renderLists();
refresh();
setInterval(refresh, POLL_MS);
setInterval(tickClock, 1000);
frame();
