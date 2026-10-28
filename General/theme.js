/* ==========================================================================
   General/theme.js — ОФОРМЛЕНИЕ «Колледж·ID»
   --------------------------------------------------------------------------
   Применяет выбранные пользователем настройки внешнего вида на всех
   страницах сайта. Подключается ПЕРВЫМ, до остальных скриптов:

     <script src="../General/theme.js"></script>

   Хранит: акцентный цвет, фон, плотность, скругления, эффекты.
   Настройки сохраняются в браузере и применяются мгновенно.
   ========================================================================== */

(function (global) {
  'use strict';

  var KEY = 'collegeid_theme';

  var ACCENTS = [
    { id: 'indigo',  name: 'Индиго',    c1: '#6366f1', c2: '#a855f7' },
    { id: 'ocean',   name: 'Океан',     c1: '#0ea5e9', c2: '#2563eb' },
    { id: 'emerald', name: 'Изумруд',   c1: '#10b981', c2: '#14b8a6' },
    { id: 'sunset',  name: 'Закат',     c1: '#f59e0b', c2: '#f43f5e' },
    { id: 'rose',    name: 'Роза',      c1: '#f43f5e', c2: '#ec4899' },
    { id: 'violet',  name: 'Фиалка',    c1: '#8b5cf6', c2: '#d946ef' },
    { id: 'lime',    name: 'Лайм',      c1: '#84cc16', c2: '#22c55e' },
    { id: 'mono',    name: 'Графит',    c1: '#64748b', c2: '#94a3b8' }
  ];

  var THEMES = [
    { id: 'midnight', name: 'Полночь', desc: 'Классический тёмный',
      preview: 'linear-gradient(135deg,#0b0b14,#15152a)', bg: '#07070d', soft: '13,13,21' },
    { id: 'obsidian', name: 'Обсидиан', desc: 'Глубокий чёрный',
      preview: 'linear-gradient(135deg,#000,#101014)', bg: '#000000', soft: '10,10,14' },
    { id: 'nebula',   name: 'Туманность', desc: 'С фиолетовым отливом',
      preview: 'linear-gradient(135deg,#0d0a1a,#1c1333)', bg: '#0a0714', soft: '18,14,32' },
    { id: 'deepsea',  name: 'Глубина', desc: 'Синие тона',
      preview: 'linear-gradient(135deg,#050b14,#0d1b2e)', bg: '#050a12', soft: '11,19,31' },
    { id: 'forest',   name: 'Хвоя', desc: 'Тёмно-зелёный',
      preview: 'linear-gradient(135deg,#06110d,#0e2019)', bg: '#050f0b', soft: '10,24,19' },
    { id: 'carbon',   name: 'Карбон', desc: 'Нейтральный серый',
      preview: 'linear-gradient(135deg,#0f0f11,#1b1b20)', bg: '#0c0c0f', soft: '22,22,27' }
  ];

  /* Эксклюзивные темы — выдаются поимённо из панели управления.
     Меняют и фон, и акцент: это цельные образы, а не просто подложка. */
  var EXCLUSIVE = [
    {
      id: 'crimson-eclipse', name: 'Багровое Затмение',
      desc: 'Чёрный обсидиан и алое свечение',
      preview: 'linear-gradient(135deg,#000 35%,#7f1d1d 75%,#ef4444)',
      bg: '#050003', soft: '20,5,8', c1: '#ef4444', c2: '#991b1b', glow: '239,68,68'
    },
    {
      id: 'sakura-mirage', name: 'Сакура Мираж',
      desc: 'Полностью розовый рассвет',
      preview: 'linear-gradient(135deg,#4a1033,#be185d 60%,#f9a8d4)',
      bg: '#1a0613', soft: '48,12,36', c1: '#f472b6', c2: '#ec4899', glow: '244,114,182'
    },
    {
      id: 'emerald-abyss', name: 'Изумрудная Бездна',
      desc: 'Глубокая зелень в чёрной толще',
      preview: 'linear-gradient(135deg,#000 35%,#064e3b 75%,#10b981)',
      bg: '#000805', soft: '6,26,20', c1: '#10b981', c2: '#047857', glow: '16,185,129'
    }
  ];

  /* Какие эксклюзивы выданы этому пользователю (пишет Data/users.js) */
  function granted() {
    try {
      var g = JSON.parse(localStorage.getItem('collegeid_grants')) || {};
      return Array.isArray(g.themes) ? g.themes : [];
    } catch (e) { return []; }
  }
  function exclusiveById(id) {
    for (var i = 0; i < EXCLUSIVE.length; i++) if (EXCLUSIVE[i].id === id) return EXCLUSIVE[i];
    return null;
  }

  var DEFAULTS = {
    accent: 'indigo', bg: 'midnight', density: 'normal', radius: 'normal',
    anim: true, particles: true, blur: true,
    nGrades: true, nAtt: true, nSched: true, nSupport: true, nNotice: true,
    nSound: false, nTitle: true
  };

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY)) || {};
      var out = {};
      Object.keys(DEFAULTS).forEach(function (k) {
        out[k] = (s[k] === undefined) ? DEFAULTS[k] : s[k];
      });
      return out;
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); }
  }
  var cfg = load();
  var listeners = [];

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* noop */ }
  }

  function injectCSS() {
    if (document.getElementById('theme-css')) return;
    var st = document.createElement('style');
    st.id = 'theme-css';
    st.textContent = [
      ':root{--accent:#6366f1;--accent2:#a855f7;--bg:#07070d;--soft:13,13,21;--radius:1}',
      'body{background:var(--bg)!important}',
      /* акцент подменяет индиго/фиолетовый по всему интерфейсу */
      'html[data-accent] .text-indigo-300,html[data-accent] .text-indigo-300\\/70,',
      'html[data-accent] .text-indigo-300\\/80{color:var(--accent-l)!important}',
      'html[data-accent] .bg-indigo-500{background:var(--accent)!important}',
      'html[data-accent] .from-indigo-500{--tw-gradient-from:var(--accent)!important}',
      'html[data-accent] .to-purple-600,html[data-accent] .to-purple-500{--tw-gradient-to:var(--accent2)!important}',
      'html[data-accent] .border-indigo-400\\/25{border-color:color-mix(in srgb,var(--accent) 35%,transparent)!important}',
      /* фон карточек подстраивается под выбранную тему */
      'html[data-bg] .card{background:rgba(var(--soft),.82)!important}',
      /* плотность */
      'html[data-density="compact"]{font-size:14.5px}',
      'html[data-density="cozy"]{font-size:16.5px}',
      'html[data-density="compact"] .card{padding-top:.85rem;padding-bottom:.85rem}',
      /* скругления */
      'html[data-radius="sharp"] .card,html[data-radius="sharp"] .panel,',
      'html[data-radius="sharp"] .row,html[data-radius="sharp"] .lcard{border-radius:10px!important}',
      'html[data-radius="soft"] .card{border-radius:32px!important}',
      'html[data-radius="soft"] .panel,html[data-radius="soft"] .row{border-radius:24px!important}',
      /* выключатели эффектов */
      'html.no-anim *{animation:none!important;transition-duration:.08s!important}',
      'html.no-blur *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
      'html.no-blur .card{background:rgba(var(--soft),.97)!important}',
      'html.no-particles canvas#fx{display:none!important}',

      /* ===== сквозная перекраска интерфейса под акцент ===== */
      'html[data-accent] .grad-text{background:linear-gradient(100deg,var(--accent),var(--accent2))!important;',
      ' -webkit-background-clip:text!important;background-clip:text!important;color:transparent!important}',
      /* градиентные плашки и индикаторы */
      'html[data-accent] .btn-primary,html[data-accent] .tab-ind,html[data-accent] .seg-ind,',
      'html[data-accent] .day.sel,html[data-accent] .nav-btn.on .nv-ic,html[data-accent] .dock-btn.on,',
      'html[data-accent] .gcard.sel .gic,html[data-accent] .les.on .les-n,html[data-accent] .ava,',
      'html[data-accent] .gear,html[data-accent] .logo{',
      ' background-image:linear-gradient(120deg,var(--accent),var(--accent2))!important}',
      'html[data-accent] .btn-primary,html[data-accent] .seg button.on,html[data-accent] .sw.on{',
      ' box-shadow:0 12px 30px -10px rgba(var(--glow),.55)!important}',
      'html[data-accent] .sw.on{background:var(--accent)!important}',
      'html[data-accent] .sw.on .knob::before{background:var(--accent)!important}',
      'html[data-accent] .nv-bar,html[data-accent] .prog,html[data-accent] .bar i,',
      'html[data-accent] .rebar{background-image:linear-gradient(120deg,var(--accent),var(--accent2))!important}',
      /* акцентные тексты и иконки */
      'html[data-accent] .text-indigo-300,html[data-accent] .text-indigo-200,',
      'html[data-accent] [class*="text-indigo-300/"],html[data-accent] [class*="text-indigo-400/"],',
      'html[data-accent] .text-purple-300,html[data-accent] [class*="text-purple-300/"]{',
      ' color:var(--accent-l)!important}',
      'html[data-accent] .mono.text-indigo-300\\/70{color:var(--accent-l)!important;opacity:.85}',
      /* рамки, фоны и состояния */
      'html[data-accent] .bg-indigo-500,html[data-accent] .bg-indigo-500\\/10,',
      'html[data-accent] .bg-indigo-500\\/15{background-color:var(--accent)!important}',
      'html[data-accent] .border-indigo-400\\/25,html[data-accent] .border-indigo-400\\/30{',
      ' border-color:rgba(var(--glow),.35)!important}',
      'html[data-accent] .from-indigo-500,html[data-accent] .from-indigo-600{',
      ' --tw-gradient-from:var(--accent)!important}',
      'html[data-accent] .to-purple-600,html[data-accent] .to-purple-500,',
      'html[data-accent] .to-indigo-500{--tw-gradient-to:var(--accent2)!important}',
      'html[data-accent] input:focus,html[data-accent] textarea:focus,html[data-accent] select:focus,',
      'html[data-accent] .fld input:focus{border-color:rgba(var(--glow),.65)!important;',
      ' box-shadow:0 0 0 4px rgba(var(--glow),.14)!important}',
      'html[data-accent] .sec-tile.on,html[data-accent] .row.me,html[data-accent] .lcard.open,',
      'html[data-accent] .cat.on,html[data-accent] .th.on{',
      ' border-color:rgba(var(--glow),.55)!important;',
      ' background:linear-gradient(100deg,rgba(var(--glow),.18),rgba(var(--glow),.07))!important}',
      'html[data-accent] .app-tile:hover{border-color:rgba(var(--glow),.45)!important;',
      ' background:rgba(var(--glow),.08)!important}',
      'html[data-accent] .app-tile::after{background:radial-gradient(400px circle at var(--mx,50%) var(--my,50%),',
      ' rgba(var(--glow),.16),transparent 45%)!important}',

      /* ===== эксклюзивные темы: цельный образ ===== */
      'html.exclusive-theme .orb{background:radial-gradient(circle,rgba(var(--glow),.34),transparent 65%)!important}',
      'html.exclusive-theme .card{box-shadow:0 0 0 1px rgba(var(--glow),.18),',
      ' 0 40px 90px -30px rgba(0,0,0,.9)!important;border-color:rgba(var(--glow),.24)!important}',
      'html.exclusive-theme .panel,html.exclusive-theme .row,html.exclusive-theme .lcard,',
      'html.exclusive-theme .scard,html.exclusive-theme .slot{border-color:rgba(var(--glow),.16)!important}',
      'html.exclusive-theme .pill{border-color:rgba(var(--glow),.28)!important;',
      ' background:rgba(var(--glow),.08)!important}',
      'html.exclusive-theme .back,html.exclusive-theme .btn-ghost{',
      ' border-color:rgba(var(--glow),.3)!important}',
      'html.exclusive-theme .gridln,html.exclusive-theme .grid-overlay{opacity:.75}',
      'html.exclusive-theme .ai{box-shadow:0 10px 26px -10px rgba(var(--glow),.6)}',
      /* контрастность текста на цветных фонах */
      'html.exclusive-theme .text-white\\/40,html.exclusive-theme .text-white\\/45{',
      ' color:rgba(255,255,255,.62)!important}',
      'html.exclusive-theme .text-white\\/35,html.exclusive-theme .text-white\\/30{',
      ' color:rgba(255,255,255,.55)!important}',

      /* ===== плитки приложений: текст не должен ломаться ===== */
      '.app-tile{min-width:0}',
      '.app-tile>span{min-width:0;max-width:100%}',
      '.app-tile .block{overflow-wrap:anywhere;word-break:normal}',
      '.app-tile span[class*="mono"]{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  function apply() {
    injectCSS();
    var a = ACCENTS.filter(function (x) { return x.id === cfg.accent; })[0] || ACCENTS[0];
    var t = THEMES.filter(function (x) { return x.id === cfg.bg; })[0] || THEMES[0];
    var r = document.documentElement;

    /* Эксклюзив задаёт палитру целиком и работает только если выдан */
    var ex = exclusiveById(cfg.bg);
    if (ex) {
      if (granted().indexOf(ex.id) > -1) {
        t = ex;
        a = { c1: ex.c1, c2: ex.c2 };
      } else {
        cfg.bg = DEFAULTS.bg; save();
        t = THEMES[0]; ex = null;
      }
    }
    r.classList.toggle('exclusive-theme', !!ex);
    r.style.setProperty('--glow', ex ? ex.glow : '99,102,241');

    r.style.setProperty('--accent', a.c1);
    r.style.setProperty('--accent2', a.c2);
    r.style.setProperty('--accent-l', a.c2);
    r.style.setProperty('--bg', t.bg);
    r.style.setProperty('--soft', t.soft);
    r.setAttribute('data-accent', cfg.accent);
    r.setAttribute('data-bg', cfg.bg);
    r.setAttribute('data-density', cfg.density);
    r.setAttribute('data-radius', cfg.radius);
    r.classList.toggle('no-anim', cfg.anim === false);
    r.classList.toggle('no-blur', cfg.blur === false);
    r.classList.toggle('no-particles', cfg.particles === false);

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.bg);

    listeners.forEach(function (cb) { try { cb(cfg); } catch (e) { /* noop */ } });
  }

  global.CollegeTheme = {
    ACCENTS: ACCENTS, THEMES: THEMES, EXCLUSIVE: EXCLUSIVE,
    /** Эксклюзивные темы, доступные этому пользователю */
    myExclusive: function () {
      var g = granted();
      return EXCLUSIVE.filter(function (t) { return g.indexOf(t.id) > -1; });
    },
    isExclusive: function (id) { return !!exclusiveById(id); },
    all: function () { return JSON.parse(JSON.stringify(cfg)); },
    get: function (k) { return cfg[k]; },
    set: function (k, v) { cfg[k] = v; save(); apply(); },
    reset: function () { cfg = JSON.parse(JSON.stringify(DEFAULTS)); save(); apply(); },
    onChange: function (cb) { if (typeof cb === 'function') listeners.push(cb); }
  };

  apply();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  }

})(window);
