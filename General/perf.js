/* ==========================================================================
   General/perf.js — АДАПТИВНАЯ ПРОИЗВОДИТЕЛЬНОСТЬ «Колледж·ID»
   --------------------------------------------------------------------------
   Задача: следить за реальной плавностью интерфейса на устройстве пользователя
   и, ТОЛЬКО если наблюдаются настоящие подтормаживания, предложить включить
   «Лёгкий режим» — отключение тяжёлых эффектов (частицы, размытия, блики,
   параллакс, сложные переходы).

   Как определяется «виснет»:
   • измеряется FPS окнами по 1 секунде;
   • фиксируются «длинные задачи» (PerformanceObserver longtask), которые
     блокируют интерфейс;
   • предложение показывается, если подряд идут окна с низким FPS
     (по умолчанию 3 окна ниже 38 кадров) либо суммарная блокировка
     превышает лимит. На быстрых устройствах баннер не появится никогда.

   Уважается системная настройка «Уменьшить движение» (prefers-reduced-motion):
   в этом случае лёгкий режим включается сразу и молча.

   Выбор пользователя запоминается (localStorage). Отказ — не беспокоим сутки.

   API:  window.PerfMode
     .isLite()              — включён ли лёгкий режим
     .setLite(bool, quiet)  — включить/выключить
     .toggle()              — переключить
     .onChange(cb)          — подписка на изменение (cb(isLite))
     .fps()                 — последний замер FPS
     .suggest()             — показать предложение вручную
     .dismissForever()      — больше не предлагать
   ========================================================================== */

(function (global) {
  'use strict';

  var LS_LITE = 'collegeid_lite';
  var LS_DECLINED = 'collegeid_lite_declined';
  var DECLINE_COOLDOWN = 24 * 60 * 60 * 1000;   // сутки не беспокоим после отказа

  /* пороги детекции */
  var CFG = {
    startDelay: 2500,      // не измеряем первые мс (загрузка, шрифты)
    window: 1000,          // длительность окна замера, мс
    lowFps: 38,            // окно считается «просевшим» ниже этого FPS
    badWindows: 3,         // столько просевших окон подряд → предложение
    blockedMs: 1400,       // суммарная блокировка longtask за 6 сек → предложение
    monitorMs: 60000       // сколько всего следим (затем прекращаем)
  };

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* noop */ } }
  var root = document.documentElement;
  var listeners = [];
  var lastFps = 60;
  var banner = null;
  var monitoring = false;

  /* ------------------------------------------------------------ стили lite */
  function injectCSS() {
    if (document.getElementById('perf-lite-css')) return;
    var css = document.createElement('style');
    css.id = 'perf-lite-css';
    css.textContent = [
      /* отключаем тяжёлую графику */
      'html.lite canvas#fx{display:none!important}',
      'html.lite .noise{display:none!important}',
      'html.lite .grid-overlay,html.lite .gridln{opacity:.5}',
      'html.lite .orb{animation:none!important;filter:blur(64px)!important;opacity:.55!important;translate:none!important}',
      'html.lite .ring-spin{animation:none!important}',
      'html.lite .marquee-inner{animation:none!important}',
      /* убираем дорогие размытия стекла */
      'html.lite *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
      'html.lite .card{background:rgba(13,13,21,.96)!important;box-shadow:0 20px 50px -30px rgba(0,0,0,.8)!important}',
      'html.lite .dock{background:rgba(16,16,26,.97)!important}',
      'html.lite .menu{background:rgba(16,16,26,.99)!important}',
      /* отключаем входные анимации, контент сразу видим */
      'html.lite .in .it,html.lite .view.on .st{animation:none!important;opacity:1!important;transform:none!important}',
      'html.lite .view.out{animation:none!important;display:none!important}',
      'html.lite .view.on.enter{animation:none!important}',
      'html.lite #viewport{transition:none!important}',
      'html.lite #formsWrap{transition:none!important}',
      /* блики, пульсации, свечения */
      'html.lite .btn-primary::after{display:none!important}',
      'html.lite .app-tile::after{display:none!important}',
      'html.lite .ring-pulse{animation:none!important;opacity:0!important}',
      'html.lite .nav-pulse{display:none!important}',
      'html.lite .pop{animation:none!important}',
      'html.lite .draw-circle,html.lite .draw-check{animation:none!important;stroke-dashoffset:0!important}',
      'html.lite .logo{animation:none!important}',
      /* короткие и дешёвые переходы */
      'html.lite *{transition-duration:.14s!important;animation-duration:.2s!important}',
      'html.lite .app-tile:hover,html.lite .panel:hover,html.lite .lesson:hover{transform:none!important}',
      /* баннер */
      '#perf-banner{position:fixed;left:12px;right:12px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:200;',
      ' display:flex;gap:14px;align-items:flex-start;padding:16px;border-radius:22px;',
      ' background:rgba(16,16,26,.97);border:1px solid rgba(255,255,255,.12);',
      ' box-shadow:0 24px 60px -16px rgba(0,0,0,.85);color:#fff;',
      ' font-family:Manrope,system-ui,sans-serif;max-width:430px;margin:0 auto;',
      ' opacity:0;transform:translateY(18px);transition:opacity .35s ease,transform .35s cubic-bezier(.22,1,.36,1)}',
      '#perf-banner.show{opacity:1;transform:none}',
      '#perf-banner.above-dock{bottom:calc(96px + env(safe-area-inset-bottom,0px))}',
      '#perf-banner .pb-ic{width:40px;height:40px;flex:none;border-radius:13px;display:flex;align-items:center;justify-content:center;',
      ' background:linear-gradient(135deg,#f59e0b,#f43f5e);box-shadow:0 10px 24px -8px rgba(244,63,94,.6)}',
      '#perf-banner h4{margin:0 0 4px;font-size:14.5px;font-weight:800;letter-spacing:-.01em}',
      '#perf-banner p{margin:0;font-size:12.5px;line-height:1.5;color:rgba(255,255,255,.55)}',
      '#perf-banner .pb-fps{font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:.14em;',
      ' color:rgba(255,255,255,.3);margin-top:7px;text-transform:uppercase}',
      '#perf-banner .pb-row{display:flex;gap:8px;margin-top:13px;flex-wrap:wrap}',
      '#perf-banner button{border:0;cursor:pointer;font-family:inherit;font-weight:700;font-size:12.5px;',
      ' padding:9px 15px;border-radius:11px;transition:filter .2s,background .2s}',
      '#perf-banner .pb-yes{background:linear-gradient(120deg,#6366f1,#a855f7);color:#fff;box-shadow:0 10px 24px -8px rgba(124,58,237,.6)}',
      '#perf-banner .pb-yes:hover{filter:brightness(1.12)}',
      '#perf-banner .pb-no{background:rgba(255,255,255,.07);color:rgba(255,255,255,.65)}',
      '#perf-banner .pb-no:hover{background:rgba(255,255,255,.12)}',
      '#perf-banner .pb-x{position:absolute;top:10px;right:12px;background:none;color:rgba(255,255,255,.3);padding:4px}',
      '#perf-banner .pb-x:hover{color:rgba(255,255,255,.7)}',
      '@media (min-width:1024px){#perf-banner{left:auto;right:24px;bottom:24px;margin:0}}'
    ].join('\n');
    document.head.appendChild(css);
  }

  /* ---------------------------------------------------------------- режим */
  function applyClass(on) { root.classList.toggle('lite', !!on); }

  function isLite() { return root.classList.contains('lite'); }

  function setLite(on, quiet) {
    var changed = isLite() !== !!on;
    applyClass(on);
    set(LS_LITE, on ? '1' : '0');
    if (changed) listeners.forEach(function (cb) { try { cb(!!on); } catch (e) { /* noop */ } });
    if (!quiet && changed) {
      notify(on ? 'Лёгкий режим включён — анимации упрощены'
                : 'Лёгкий режим выключен — анимации восстановлены');
    }
    if (on) stopMonitor();
  }

  /* короткое уведомление: используем тост страницы, если он есть */
  function notify(msg) {
    var t = document.getElementById('toast'), m = document.getElementById('toastMsg');
    if (t && m) {
      m.textContent = msg;
      t.classList.add('show');
      clearTimeout(notify._t);
      notify._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
    }
  }

  /* --------------------------------------------------------------- баннер */
  var ICON_WARN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>';
  var ICON_X = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  function suggest() {
    if (banner || isLite()) return;
    injectCSS();
    banner = document.createElement('div');
    banner.id = 'perf-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-live', 'polite');
    banner.style.position = 'fixed';
    banner.innerHTML =
      '<span class="pb-ic">' + ICON_WARN + '</span>' +
      '<div style="min-width:0;flex:1">' +
        '<h4>Интерфейс подтормаживает</h4>' +
        '<p>Мы заметили просадку плавности на вашем устройстве. Включить лёгкий режим? ' +
        'Отключим фоновые частицы, размытия и сложные переходы — станет заметно быстрее.</p>' +
        '<div class="pb-fps">ЗАМЕР: ~' + Math.round(lastFps) + ' FPS</div>' +
        '<div class="pb-row">' +
          '<button class="pb-yes" type="button">Включить лёгкий режим</button>' +
          '<button class="pb-no" type="button">Оставить как есть</button>' +
        '</div>' +
      '</div>' +
      '<button class="pb-x" type="button" aria-label="Закрыть">' + ICON_X + '</button>';

    /* поднимаем над нижней навигацией на мобильных */
    if (document.querySelector('.dock') && innerWidth < 1024) banner.classList.add('above-dock');
    document.body.appendChild(banner);
    requestAnimationFrame(function () { banner.classList.add('show'); });

    banner.querySelector('.pb-yes').addEventListener('click', function () {
      setLite(true, true);
      close();
      notify('Лёгкий режим включён — выключить можно в разделе «Аккаунт»');
    });
    banner.querySelector('.pb-no').addEventListener('click', decline);
    banner.querySelector('.pb-x').addEventListener('click', decline);

    /* автоскрытие через 20 секунд — не мешаем работать */
    setTimeout(function () { if (banner) decline(); }, 20000);
  }

  function decline() {
    set(LS_DECLINED, String(Date.now()));
    stopMonitor();
    close();
  }

  function close() {
    if (!banner) return;
    var b = banner; banner = null;
    b.classList.remove('show');
    setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 350);
  }

  /* ------------------------------------------------------------ мониторинг */
  var frames = 0, winStart = 0, badRun = 0, blocked = 0, rafId = null, stopAt = 0;

  function loop(ts) {
    if (!monitoring) return;
    frames++;
    if (!winStart) winStart = ts;
    var elapsed = ts - winStart;
    if (elapsed >= CFG.window) {
      lastFps = (frames * 1000) / elapsed;
      frames = 0; winStart = ts;
      if (lastFps < CFG.lowFps) badRun++; else badRun = 0;
      if (badRun >= CFG.badWindows) { stopMonitor(); return suggest(); }
    }
    if (ts > stopAt) { stopMonitor(); return; }
    rafId = requestAnimationFrame(loop);
  }

  function startMonitor() {
    if (monitoring || isLite() || !shouldAsk()) return;
    monitoring = true;
    frames = 0; winStart = 0; badRun = 0; blocked = 0;
    stopAt = performance.now() + CFG.monitorMs;
    rafId = requestAnimationFrame(loop);

    /* длинные задачи, блокирующие поток */
    try {
      if ('PerformanceObserver' in global) {
        var po = new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (e) { blocked += e.duration; });
          if (blocked > CFG.blockedMs) { stopMonitor(); suggest(); }
        });
        po.observe({ entryTypes: ['longtask'] });
        startMonitor._po = po;
        setTimeout(function () { blocked = 0; }, 6000);
      }
    } catch (e) { /* не поддерживается — не страшно */ }
  }

  function stopMonitor() {
    monitoring = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    try { if (startMonitor._po) startMonitor._po.disconnect(); } catch (e) { /* noop */ }
  }

  function shouldAsk() {
    var d = Number(get(LS_DECLINED) || 0);
    if (d && Date.now() - d < DECLINE_COOLDOWN) return false;
    return get(LS_LITE) !== '0' || true;   // явное «выкл» не блокирует повторный совет позже
  }

  /* ------------------------------------------------------------------ init */
  injectCSS();

  var saved = get(LS_LITE);
  var reduced = false;
  try { reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* noop */ }

  if (saved === '1' || (saved === null && reduced)) {
    applyClass(true);                 // восстанавливаем выбор / системную настройку
  } else {
    /* запускаем наблюдение, когда страница «успокоится» */
    var kick = function () { setTimeout(startMonitor, CFG.startDelay); };
    if (document.readyState === 'complete') kick();
    else global.addEventListener('load', kick);
  }

  /* не тратим ресурсы в фоновой вкладке */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopMonitor();
  });

  global.PerfMode = {
    isLite: isLite,
    setLite: setLite,
    toggle: function () { setLite(!isLite()); return isLite(); },
    onChange: function (cb) { if (typeof cb === 'function') listeners.push(cb); },
    fps: function () { return Math.round(lastFps); },
    suggest: suggest,
    dismissForever: function () { set(LS_DECLINED, String(Date.now() + 3650 * 24 * 3600 * 1000)); stopMonitor(); close(); }
  };

})(window);
