/* Video Enhancer 1.3.1 (оптимизированный): любые плееры, растяжение без обрезки, плавность.
   Инкрементальный поиск video, кэш стилей, троттлинг, один heartbeat-таймер. */
(() => {
'use strict';
const NS = (typeof browser !== 'undefined') ? browser : chrome;
if (!NS.storage || !NS.storage.local) return;
if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

const HOST = location.hostname;

/* ---------- Константы ---------- */
const NEUTRAL = () => ({ zoom: 'off', smooth: 'off' });
const ZOOM_OPTS = [
  ['off',  'Выкл'],
  ['sw',   'Растянуть по ширине'],
  ['sh',   'Растянуть по высоте'],
  ['fill', 'Заполнить экран (растянуть)']
];
const SM_LABEL = { off: 'Выкл', auto: 'Простой', 'auto+': 'Резкий' };

const ICONS = {
  zoom:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9V4h5M20 15v5h-5M4 4l6.2 6.2M20 20l-6.2-6.2"/></svg>',
  smooth:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2.5 12c2.6-6.5 5.4 6.5 8 0s5.4 6.5 8 0M6 17.5h12"/></svg>',
  gear:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8l1.2 2.6 2.8-.6 1 2.6 2.8.6-.4 2.9 2.2 1.9-1.6 2.4 1.2 2.6-2.6 1.3-.4 2.9-2.9-.1-1.9 2.2-2.5-1.4-2.5 1.4-1.9-2.2-2.9.1-.4-2.9L2.4 15l1.2-2.6L2 10.5l2.2-1.9-.4-2.9 2.8-.6 1-2.6 2.8.6z"/></svg>',
  pin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3h6l-1 6 3.5 3.5V15h-11v-2.5L10 9 9 3z"/><path d="M12 15v6"/></svg>'
};

/* ---------- Состояние ---------- */
const DEF_STATE = {
  current: NEUTRAL(),
  siteOverrides: {},
  settings: { autoApply: true, autoHide: true, rememberSite: true, compact: true }
};
const clone = o => JSON.parse(JSON.stringify(o));
const merge = (base, add) => { const r = clone(base); for (const k in add) if (Object.prototype.hasOwnProperty.call(add,k)) { if (r[k] && typeof r[k]==='object' && !Array.isArray(r[k])) r[k]=merge(r[k],add[k]); else r[k]=clone(add[k]); } return r; };
let S = clone(DEF_STATE);
let lastSavedJSON = '';
let live = null;
let ui = null;

const videos = new Set();
const openRoots = new Set();
const observed = new WeakSet();
const vmeta = new WeakMap();
const meta = v => { let m = vmeta.get(v); if (!m) { m = {}; vmeta.set(v, m); } return m; };

function save(){ lastSavedJSON = JSON.stringify(S); NS.storage.local.set({ veState: S }); }

NS.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !ch.veState) return;
  const js = JSON.stringify(ch.veState.newValue);
  if (js === lastSavedJSON) return;
  lastSavedJSON = js;
  S = merge(DEF_STATE, ch.veState.newValue || {});
  if (!ui) return;
  const ov = S.siteOverrides[HOST];
  if (ov) live = clone(ov);
  applyAll(); updateUI();
});

/* ---------- SVG-фильтр резкости ---------- */
function ensureSharpen(){
  if (document.getElementById('veSharpenSvg')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.id = 'veSharpenSvg';
  svg.setAttribute('width','0'); svg.setAttribute('height','0');
  svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
  svg.innerHTML = '<filter id="veSharpen"><feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0" preserveAlpha="true"/></filter>';
  (document.body || document.documentElement).appendChild(svg);
}

/* ---------- Применение эффектов (с кэшем: пишем в style только при изменении) ---------- */
function applyVideo(v){
  const m = meta(v);
  const w = v.offsetWidth, h = v.offsetHeight;
  let sx = 1, sy = 1, use = false;
  if (w && h){
    if (live.zoom === 'sw'){ sx = innerWidth / w; sy = 1; use = true; }
    else if (live.zoom === 'sh'){ sx = 1; sy = innerHeight / h; use = true; }
    else if (live.zoom === 'fill'){ sx = innerWidth / w; sy = innerHeight / h; use = true; }
  }
  const tr = use ? 'scale(' + sx + ',' + sy + ')' : '';
  const of = use ? 'fill' : '';
  const fl = (live.smooth === 'auto+') ? 'url(#veSharpen)' : '';
  if (!m.originSet){ v.style.transformOrigin = 'center center'; m.originSet = true; }
  if (m.apTr !== tr){ v.style.transform = tr; m.apTr = tr; }
  if (m.apOf !== of){ v.style.objectFit = of; m.apOf = of; }
  if (m.apFl !== fl){ v.style.filter = fl; m.apFl = fl; }
}
function applyAll(){
  ensureSharpen();
  videos.forEach(v => {
    if (!v.isConnected){ videos.delete(v); stopSmooth(v); return; }
    applyVideo(v); syncSmooth(v);
  });
}

/* ---------- Инкрементальный поиск video ---------- */
function registerVideo(v){
  if (!v || v.tagName !== 'VIDEO' || videos.has(v)) return;
  videos.add(v);
  const m = meta(v);
  m.onRate = () => {
    if (m.ctlState === 'on' && m.lastApplied != null && Math.abs(v.playbackRate - m.lastApplied) > 1e-3){
      m.baseRate = v.playbackRate / (m.factor || 1);
      setTimeout(() => { if (m.ctlState === 'on') applyRate(v); }, 0);
    }
  };
  m.onMeta = () => { if (live && live.smooth !== 'off'){ stopSmooth(v); startSmooth(v); } };
  v.addEventListener('ratechange', m.onRate);
  v.addEventListener('loadedmetadata', m.onMeta);
  if (live){ applyVideo(v); syncSmooth(v); }
  if (!ui && videos.size) buildUI();
}
function registerAll(list){ for (let i = 0; i < list.length; i++) registerVideo(list[i]); }

function addOpenRoot(sr){
  if (openRoots.has(sr)) return;
  openRoots.add(sr);
  observeRoot(sr);
  registerAll(sr.getElementsByTagName('video'));
}
function adoptShadow(el){
  if (el.shadowRoot) addOpenRoot(el.shadowRoot);
  if (!el.querySelectorAll) return;
  const els = el.querySelectorAll('*');
  for (let i = 0; i < els.length; i++) if (els[i].shadowRoot) addOpenRoot(els[i].shadowRoot);
}
function observeRoot(r){
  if (observed.has(r)) return;
  observed.add(r);
  new MutationObserver(records => {
    for (let k = 0; k < records.length; k++){
      const added = records[k].addedNodes;
      for (let i = 0; i < added.length; i++){
        const n = added[i];
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'VIDEO') registerVideo(n);
        if (n.querySelectorAll) registerAll(n.querySelectorAll('video'));  // только внутри добавленного узла
        adoptShadow(n);
      }
    }
  }).observe(r, { childList: true, subtree: true });
}
function sweep(){   // редкая страховка: быстрые нативные выборки, без обхода всех элементов
  registerAll(document.getElementsByTagName('video'));
  openRoots.forEach(r => {
    if (r.host && !r.host.isConnected){ openRoots.delete(r); return; }
    registerAll(r.getElementsByTagName('video'));
  });
}
observeRoot(document);
setInterval(sweep, 4000);

/* видео от probe.js (закрытые Shadow DOM) */
window.addEventListener('__veVideo', e => { registerVideo(e.detail); });
try { window.dispatchEvent(new Event('__veDump')); } catch (e) {}

/* ---------- Позиционирование по центру видео + fullscreen + heartbeat ---------- */
function mainVideo(){
  let best = null, bestArea = 0;
  videos.forEach(v => {
    if (!v.isConnected) return;
    const r = (v.parentElement || v).getBoundingClientRect();
    const a = r.width * r.height;
    if (a > bestArea){ bestArea = a; best = v; }
  });
  return best;
}
let lastCx = -1, lastTy = -1;
function positionUI(force){
  if (!ui) return;
  const v = mainVideo();
  let cx = innerWidth / 2, ty = 26;
  if (v){
    const r = (v.parentElement || v).getBoundingClientRect();
    if (r.width > 0){
      cx = Math.min(Math.max(r.left + r.width / 2, 170), innerWidth - 170);
      ty = Math.max(8, r.top + 10);
    }
  }
  cx = Math.round(cx); ty = Math.round(ty);
  if (!force && cx === lastCx && ty === lastTy) return;   // не трогаем CSS-переменные без нужды
  lastCx = cx; lastTy = ty;
  ui.host.style.setProperty('--ve-cx', cx + 'px');
  ui.host.style.setProperty('--ve-ty', ty + 'px');
}
function ensureHostParent(){
  if (!ui) return;
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  const target = fs ? fs : (document.body || document.documentElement);
  if (target && ui.host.parentElement !== target) target.appendChild(ui.host);
}

/* watchdog: обычный тик 1/с + burst 120ms после fullscreen/resize */
let burstUntil = 0;
const kick = ms => { burstUntil = performance.now() + ms; };

function onFullscreenChange(){
  kick(2500);
  ensureHostParent();
  sweep();
  if (live) applyAll();
  positionUI(true);
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

let posQueued = false;
addEventListener('scroll', () => {
  if (posQueued) return;
  posQueued = true;
  requestAnimationFrame(() => { posQueued = false; positionUI(false); });
}, { passive: true, capture: true });

addEventListener('resize', () => {
  kick(1500);
  if (live && live.zoom !== 'off') applyAll();
  positionUI(true);
});

setInterval(() => {           // heartbeat: единственная периодическая проверка в покое
  if (!live) return;
  applyAll();
  ensureHostParent();
  positionUI(false);
}, 1000);
setInterval(() => {           // burst: только несколько секунд после fullscreen/resize
  if (!live || performance.now() > burstUntil) return;
  applyAll();
}, 120);

/* ---------- Плавность ---------- */
let displayHz = 0;
function measureHz(cb){
  if (displayHz) return cb(displayHz);
  let frames = 0; const t0 = performance.now();
  const tick = t => { frames++; if (t - t0 < 1000) requestAnimationFrame(tick); else { displayHz = frames * 1000 / (t - t0); cb(displayHz); } };
  requestAnimationFrame(tick);
}
function applyRate(v){ const m = meta(v); m.lastApplied = (m.baseRate || 1) * (m.factor || 1); try { v.playbackRate = m.lastApplied; } catch(e){} }
function startSmooth(v){
  const m = meta(v);
  if (m.ctlState === 'on' || m.ctlState === 'meas') return;
  m.ctlState = 'meas'; m.baseRate = v.playbackRate || 1; m.factor = 1;
  if (typeof v.requestVideoFrameCallback !== 'function'){ m.ctlState = 'on'; return; }
  let n = 0, t0 = 0, t1 = 0, done = false;
  const finish = () => {
    if (done) return; done = true;
    const dur = t1 - t0;
    if (dur <= 0 || n < 4){ m.factor = 1; m.ctlState = 'on'; return; }
    const fps = n / dur;
    measureHz(hz => {
      let best = 1, bestErr = 0.02;
      for (let r = 0.97; r <= 1.0301; r += 0.0005){
        const p = hz / (fps * r);
        const err = Math.abs(p - Math.round(p));
        if (Math.round(p) >= 1 && err < bestErr){ bestErr = err; best = r; }
      }
      m.factor = best; m.ctlState = 'on'; applyRate(v);
    });
  };
  const cb = (now, md) => {
    if (m.ctlState === 'off') return;
    if (n === 0) t0 = md.mediaTime;
    t1 = md.mediaTime; n++;
    if (t1 - t0 < 1.6 && n < 500) v.requestVideoFrameCallback(cb); else finish();
  };
  v.requestVideoFrameCallback(cb);
}
function stopSmooth(v){
  const m = meta(v);
  if (!m || m.ctlState === 'off') return;
  m.ctlState = 'off'; m.factor = 1; m.lastApplied = null;
  try { if (m.baseRate) v.playbackRate = m.baseRate; } catch(e){}
}
function syncSmooth(v){ if (live.smooth === 'off') stopSmooth(v); else startSmooth(v); }

/* ---------- Коммит ---------- */
function commit(change){
  Object.assign(live, change);
  S.current = { zoom: live.zoom, smooth: live.smooth };
  if (S.settings.rememberSite) S.siteOverrides[HOST] = clone(S.current);
  save(); applyAll(); updateUI();
}

/* ---------- UI ---------- */
const CSS = `
:host{all:initial}
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.tb{position:fixed;top:var(--ve-ty,26px);left:var(--ve-cx,50%);transform:translateX(-50%);display:flex;align-items:center;gap:4px;
 background:rgba(10,11,13,.93);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.09);border-radius:16px;
 padding:6px;box-shadow:0 12px 34px rgba(0,0,0,.55);color:#e9ecef;user-select:none;white-space:nowrap;
 max-width:460px;overflow:hidden;transition:max-width .28s ease}
.tb.compact{max-width:60px}
.tb.compact:not(:hover) .mod[data-mod="smooth"],
.tb.compact:not(:hover) .gear,
.tb.compact:not(:hover) .mt,
.tb.compact:not(:hover) .ms{display:none}
.tb.compact:hover{max-width:460px}
button{background:none;border:0;color:inherit;cursor:pointer;font:inherit}
.mod{display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:12px;text-align:left;flex:none}
.mod:hover{background:rgba(255,255,255,.07)}
.mod .mi{width:20px;height:20px;flex:none;opacity:.92}
.mod .mt{display:block;font-weight:600;font-size:13.5px}
.mod .ms{display:block;color:#8b9198;font-size:11.5px;margin-top:2px}
.mod.on .ms{color:#a9c6ff}
.gear{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;flex:none}
.gear:hover{background:rgba(255,255,255,.08)}
.gear svg{width:20px;height:20px}
.panel{position:fixed;top:calc(var(--ve-ty,26px) + 62px);left:var(--ve-cx,50%);transform:translateX(-50%);
 background:rgba(12,13,16,.97);backdrop-filter:blur(16px);
 border:1px solid rgba(255,255,255,.09);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.6);color:#e9ecef;padding:16px 18px;z-index:2;
 max-height:calc(100vh - 120px);overflow:auto}
.panel[hidden]{display:none}
.menu{width:290px;padding:8px}
.menu .mh{font-size:12px;color:#8b9198;padding:6px 12px 8px;font-weight:600}
.mitem{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;padding:9px 12px;border-radius:10px;font-size:13.5px;text-align:left}
.mitem:hover{background:rgba(255,255,255,.07)}
.mitem.sel{background:rgba(255,255,255,.11);font-weight:600}
.mitem .ck{opacity:0;width:14px}
.mitem.sel .ck{opacity:1}
.psmooth{width:min(560px,94vw)}
.smhead{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.smhead .t{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px}
.smhead .t svg{width:18px;height:18px}
.sw{width:38px;height:22px;border-radius:999px;background:#2a2e34;position:relative;flex:none;border:1px solid rgba(255,255,255,.14);cursor:pointer}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#8b9198;transition:.18s}
.sw.on{background:#3d6dff;border-color:transparent}
.sw.on::after{left:18px;background:#fff}
.pill{display:flex;align-items:center;gap:8px;background:#1a1d21;border:1px solid rgba(255,255,255,.13);
 border-radius:999px;padding:9px 14px;font-size:11px;letter-spacing:.07em;font-weight:700;color:#dfe3e8}
.pill:hover{background:#22262b}
.pill.on{background:#31373f;color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.25)}
.pill svg{width:14px;height:14px}
.fpsbox{margin-left:auto;background:#1a1d21;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:7px 14px;font-size:11px;color:#9aa0a6}
.fpsbox b{font-size:18px;color:#fff;font-weight:800;margin-right:5px}
.gpu{margin-top:14px;background:#14171b;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px 14px}
.gh{font-size:11px;letter-spacing:.08em;color:#8b9198;font-weight:700}
.gv{display:flex;gap:20px;margin-top:8px;font-size:12.5px;color:#cfd4da}
.gv b{color:#fff}
.bar{margin-top:10px;height:6px;border-radius:999px;background:#262a30;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3d6dff,#7aa2ff);transition:width .3s}
.qual{display:flex;align-items:center;justify-content:space-between;margin-top:14px;font-size:13px;color:#9aa0a6}
.seg{display:flex;background:#1a1d21;border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:3px;gap:3px}
.seg button{padding:7px 16px;border-radius:999px;font-size:12.5px;color:#cfd4da}
.seg button.on{background:#fff;color:#111;font-weight:700}
.setrow{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:10px 12px;border-radius:10px;font-size:13.5px}
.setrow:hover{background:rgba(255,255,255,.05)}
.danger{margin:8px 12px 4px;padding:9px 12px;border-radius:10px;color:#ff9d9d;font-size:13px;width:calc(100% - 24px);text-align:left}
.danger:hover{background:rgba(255,80,80,.12)}
.plain{margin:4px 12px;padding:9px 12px;border-radius:10px;color:#cfd4da;font-size:13px;width:calc(100% - 24px);text-align:left}
.plain:hover{background:rgba(255,255,255,.07)}
`;

function buildUI(){
  if (ui) return;
  const host = document.createElement('div');
  host.id = 've-enhancer-host';
  host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>' + CSS + '</style>' +
  '<div class="tb" id="tb">' +
    '<button class="mod" data-mod="zoom"><span class="mi">' + ICONS.zoom + '</span><span><span class="mt">Масштаб</span><span class="ms" id="st-zoom"></span></span></button>' +
    '<button class="mod" data-mod="smooth"><span class="mi">' + ICONS.smooth + '</span><span><span class="mt">Плавность</span><span class="ms" id="st-smooth"></span></span></button>' +
    '<button class="gear" id="gear" title="Настройки">' + ICONS.gear + '</button>' +
  '</div>' +
  '<div class="panel menu" id="pmenu" hidden><div class="mh">Масштаб — растяжение без обрезки</div><div id="pmenu-items"></div></div>' +
  '<div class="panel psmooth" id="psm" hidden>' +
    '<div class="smhead"><span class="t">' + ICONS.smooth + 'Плавность</span>' +
      '<span class="sw" id="smSw" title="Вкл/Выкл"></span>' +
      '<button class="pill" id="pin">' + ICONS.pin + '<span>ЗАКРЕПИТЬ НА ВИДЕО</span></button>' +
      '<span class="fpsbox"><b id="fpsVal">--</b>FPS</span></div>' +
    '<div class="gpu"><div class="gh">ЗАПАС GPU</div>' +
      '<div class="gv"><span>сред. <b id="gpuAvg">--</b> ms</span><span>бюджет <b id="gpuBud">--</b> ms</span></div>' +
      '<div class="bar"><i id="gpuBar"></i></div></div>' +
    '<div class="qual"><span>Качество</span><div class="seg">' +
      '<button data-q="auto">Простой</button><button data-q="auto+">Резкий</button></div></div>' +
  '</div>' +
  '<div class="panel menu" id="pset" hidden><div class="mh">Настройки</div><div id="set-items"></div>' +
    '<button class="plain" id="rsite">Сбросить настройки этого сайта</button>' +
    '<button class="danger" id="wipe">Сбросить всё расширение</button></div>';
  (document.body || document.documentElement).appendChild(host);

  const $ = id => root.getElementById(id);
  ui = { host, root, $, tb: $('tb'), gear: $('gear'), pmenu: $('pmenu'), psm: $('psm'), pset: $('pset'),
         menuItems: $('pmenu-items'), setItems: $('set-items'), pinned: false };

  let gpuTimer = 0, rafId = 0, deltas = [], lastT = 0;
  function startGpu(){
    if (gpuTimer) return;
    lastT = performance.now(); deltas = [];
    const loop = t => { deltas.push(t - lastT); lastT = t; if (deltas.length > 240) deltas.shift(); rafId = requestAnimationFrame(loop); };
    rafId = requestAnimationFrame(loop);
    gpuTimer = setInterval(() => {
      if (!deltas.length) return;
      const avg = deltas.reduce((a,b)=>a+b,0) / deltas.length;
      const hz = displayHz || 60, bud = 1000 / hz;
      $('gpuAvg').textContent = avg.toFixed(1);
      $('gpuBud').textContent = bud.toFixed(1);
      $('gpuBar').style.width = Math.min(100, avg / bud * 100).toFixed(0) + '%';
    }, 500);
    measureHz(hz => { $('fpsVal').textContent = String(Math.round(hz)); });
  }
  function stopGpu(){ cancelAnimationFrame(rafId); clearInterval(gpuTimer); gpuTimer = 0; rafId = 0; }

  const closeAll = force => {
    ui.pmenu.hidden = true; ui.pset.hidden = true;
    if (force || !ui.pinned){ ui.psm.hidden = true; stopGpu(); }
  };

  ui.gear.addEventListener('click', e => { e.stopPropagation(); const was = !ui.pset.hidden; closeAll(true); if (!was){ renderSettings(); ui.pset.hidden = false; } });
  root.querySelectorAll('.mod').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    if (b.dataset.mod === 'zoom'){ const was = !ui.pmenu.hidden; closeAll(true); if (!was){ openZoomMenu(); ui.pmenu.hidden = false; } }
    else { const was = !ui.psm.hidden; closeAll(true); if (!was){ ui.psm.hidden = false; startGpu(); } }
  }));
  $('smSw').addEventListener('click', e => { e.stopPropagation(); commit({ smooth: live.smooth === 'off' ? 'auto' : 'off' }); });
  $('pin').addEventListener('click', e => { e.stopPropagation(); ui.pinned = !ui.pinned; $('pin').classList.toggle('on', ui.pinned); });
  root.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); commit({ smooth: b.dataset.q }); }));
  $('rsite').addEventListener('click', e => { e.stopPropagation(); delete S.siteOverrides[HOST]; live = NEUTRAL(); S.current = NEUTRAL(); save(); applyAll(); updateUI(); });
  $('wipe').addEventListener('click', e => { e.stopPropagation(); S = clone(DEF_STATE); live = NEUTRAL(); save(); applyAll(); updateUI(); closeAll(true); });

  function openZoomMenu(){
    ui.menuItems.innerHTML = ZOOM_OPTS.map(o => '<button class="mitem" data-v="' + o[0] + '"><span>' + o[1] + '</span><span class="ck">✓</span></button>').join('');
    ui.menuItems.querySelectorAll('.mitem').forEach(it => it.addEventListener('click', ev => {
      ev.stopPropagation(); commit({ zoom: it.dataset.v }); closeAll(true);
    }));
    updateUI();
  }

  function renderSettings(){
    const items = [
      ['autoApply',    'Автоприменение при загрузке'],
      ['rememberSite', 'Запоминать настройки для сайта'],
      ['autoHide',     'Скрывать панель при бездействии'],
      ['compact',      'Компактная панель (сворачиваться без курсора)']
    ];
    ui.setItems.innerHTML = items.map(i => '<div class="setrow" data-k="' + i[0] + '"><span>' + i[1] + '</span><span class="sw' + (S.settings[i[0]] ? ' on' : '') + '"></span></div>').join('');
    ui.setItems.querySelectorAll('.setrow').forEach(r => r.addEventListener('click', e => {
      e.stopPropagation();
      const k = r.dataset.k;
      S.settings[k] = !S.settings[k];
      save(); renderSettings(); updateUI();
    }));
  }

  document.addEventListener('click', () => { if (ui) closeAll(false); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ui) closeAll(true); });

  let idleT = 0;
  const poke = () => {
    ui.tb.style.opacity = '';
    clearTimeout(idleT);
    idleT = setTimeout(() => {
      if (S.settings.autoHide && ui.pmenu.hidden && ui.pset.hidden && ui.psm.hidden) ui.tb.style.opacity = '.25';
    }, 2600);
  };
  document.addEventListener('mousemove', poke, { passive: true });
  ui.tb.addEventListener('mouseenter', () => { ui.tb.style.opacity = ''; });
  poke();

  ensureHostParent();
  positionUI(true);
  updateUI();
}

function updateUI(){
  if (!ui || !live) return;
  const $ = ui.$;
  $('st-zoom').textContent = (ZOOM_OPTS.find(o => o[0] === live.zoom) || ZOOM_OPTS[0])[1];
  $('st-smooth').textContent = SM_LABEL[live.smooth] || 'Выкл';
  ui.root.querySelectorAll('.mod').forEach(b => b.classList.toggle('on', live[b.dataset.mod] !== 'off'));
  if (!ui.pmenu.hidden) ui.menuItems.querySelectorAll('.mitem').forEach(it => it.classList.toggle('sel', it.dataset.v === live.zoom));
  $('smSw').classList.toggle('on', live.smooth !== 'off');
  ui.root.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.q === live.smooth));
  ui.tb.classList.toggle('compact', !!S.settings.compact);
}

/* ---------- Старт ---------- */
NS.storage.local.get('veState', res => {
  if (res.veState) S = merge(DEF_STATE, res.veState);
  lastSavedJSON = JSON.stringify(S);
  const ov = S.siteOverrides[HOST];
  live = ov ? clone(ov) : (S.settings.autoApply ? clone(S.current) : NEUTRAL());
  if (!live.zoom) live.zoom = 'off';
  if (!live.smooth) live.smooth = 'off';
  adoptShadow(document.documentElement || document.body || document);
  sweep();
  videos.forEach(v => { applyVideo(v); syncSmooth(v); });
  if (videos.size) buildUI();
  if (ui) updateUI();
});
})();