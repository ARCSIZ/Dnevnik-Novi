/* ==========================================================================
   General/pwa.js — УСТАНОВКА ПРИЛОЖЕНИЯ «Колледж·ID»
   --------------------------------------------------------------------------
   Подключается на всех страницах после остальных скриптов:
     <script src="../General/pwa.js"></script>

   Что делает:
   • регистрирует Service Worker (офлайн-режим и установка);
   • подставляет manifest, theme-color и iOS-мета — страницам не нужно
     ничего добавлять в <head>;
   • Android/Chrome: показывает кнопку «Установить приложение» и системное
     окно установки (beforeinstallprompt);
   • iPhone/iPad (Safari): показывает понятную инструкцию «Поделиться →
     На экран "Домой"», потому что iOS не даёт автоустановку;
   • если приложение уже установлено и открыто в режиме standalone —
     подсказка не появляется никогда.

   Повторно не навязывается: после закрытия подсказки не показываем 14 дней.
   ========================================================================== */

(function (global) {
  'use strict';

  var KEY_HIDE = 'collegeid_pwa_hidden_until';
  var HIDE_DAYS = 14;

  var isStandalone = global.matchMedia('(display-mode: standalone)').matches
    || global.navigator.standalone === true
    || /source=pwa/.test(location.search);
  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  var deferred = null;

  function root() {
    /* путь к корню сайта относительно текущей страницы */
    var s = document.currentScript && document.currentScript.src;
    try { return new URL('..', s || location.href).href.replace(/\/$/, ''); }
    catch (e) { return ''; }
  }
  var ROOT = root();

  function hidden() {
    try { return Number(localStorage.getItem(KEY_HIDE) || 0) > Date.now(); }
    catch (e) { return false; }
  }
  function hideFor(days) {
    try { localStorage.setItem(KEY_HIDE, String(Date.now() + days * 864e5)); } catch (e) { /* noop */ }
  }

  /* ----------------------------------------------- мета-теги и манифест */
  function head() {
    function add(tag, attrs) {
      var el = document.createElement(tag);
      Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
      document.head.appendChild(el);
      return el;
    }
    if (!document.querySelector('link[rel="manifest"]')) {
      add('link', { rel: 'manifest', href: ROOT + '/manifest.webmanifest' });
    }
    if (!document.querySelector('meta[name="theme-color"]')) {
      add('meta', { name: 'theme-color', content: '#07070d' });
    }
    /* iOS: полноэкранный режим и иконка на домашнем экране */
    add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
    add('meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' });
    add('meta', { name: 'apple-mobile-web-app-title', content: 'Колледж·ID' });
    add('meta', { name: 'mobile-web-app-capable', content: 'yes' });
    if (!document.querySelector('link[rel="apple-touch-icon"]')) {
      add('link', { rel: 'apple-touch-icon', href: ROOT + '/icons/icon-192.png' });
    }
  }

  /* ---------------------------------------------------- стили подсказки */
  function css() {
    if (document.getElementById('pwa-css')) return;
    var st = document.createElement('style');
    st.id = 'pwa-css';
    st.textContent = [
      '#pwa-bar{position:fixed;left:12px;right:12px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:250;',
      ' max-width:430px;margin:0 auto;padding:14px;border-radius:22px;color:#fff;',
      ' background:rgba(16,16,26,.97);border:1px solid rgba(255,255,255,.13);',
      ' box-shadow:0 26px 60px -18px rgba(0,0,0,.85);font-family:Manrope,system-ui,sans-serif;',
      ' opacity:0;transform:translateY(16px);transition:opacity .35s,transform .35s cubic-bezier(.22,1,.36,1)}',
      '#pwa-bar.show{opacity:1;transform:none}',
      '#pwa-bar.above-dock{bottom:calc(94px + env(safe-area-inset-bottom,0px))}',
      '#pwa-bar .h{display:flex;align-items:center;gap:10px;margin-bottom:8px}',
      '#pwa-bar .ic{width:34px;height:34px;flex:none;border-radius:11px;display:flex;align-items:center;',
      ' justify-content:center;background:linear-gradient(135deg,#6366f1,#a855f7);font-size:16px}',
      '#pwa-bar h4{margin:0;flex:1;min-width:0;font-size:14.5px;font-weight:800;letter-spacing:-.01em}',
      '#pwa-bar .x{flex:none;width:28px;height:28px;border:0;border-radius:9px;cursor:pointer;font-size:15px;',
      ' background:rgba(255,255,255,.06);color:rgba(255,255,255,.5)}',
      '#pwa-bar .x:hover{background:rgba(255,255,255,.12);color:#fff}',
      '#pwa-bar p{margin:0;font-size:12.5px;line-height:1.5;color:rgba(255,255,255,.58);hyphens:auto}',
      '#pwa-bar ol{margin:10px 0 0;padding-left:18px;font-size:12.5px;line-height:1.7;color:rgba(255,255,255,.6)}',
      '#pwa-bar b{color:#fff}',
      '#pwa-bar .go{margin-top:12px;width:100%;height:44px;border:0;border-radius:14px;cursor:pointer;',
      ' font-family:inherit;font-weight:700;font-size:13.5px;color:#fff;',
      ' background:linear-gradient(120deg,#6366f1,#a855f7);box-shadow:0 12px 28px -10px rgba(124,58,237,.6)}',
      '#pwa-bar .go:hover{filter:brightness(1.12)}',
      '@media (min-width:1024px){#pwa-bar{left:auto;right:24px;bottom:24px;margin:0;width:390px}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------ баннер */
  function bar(html) {
    if (document.getElementById('pwa-bar') || hidden()) return null;
    css();
    var el = document.createElement('div');
    el.id = 'pwa-bar';
    el.innerHTML = html;
    if (document.querySelector('.dock') && innerWidth < 1024) el.classList.add('above-dock');
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    el.querySelector('.x').addEventListener('click', function () {
      hideFor(HIDE_DAYS); close(el);
    });
    return el;
  }
  function close(el) {
    el.classList.remove('show');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 360);
  }

  function showAndroid() {
    var el = bar(
      '<div class="h"><span class="ic">📲</span><h4>Установить приложение</h4>'
      + '<button class="x" aria-label="Закрыть">✕</button></div>'
      + '<p>Колледж·ID откроется как обычное приложение: ярлык на экране, '
      + 'полноэкранный режим и быстрый запуск.</p>'
      + '<button class="go">Установить</button>');
    if (!el) return;
    el.querySelector('.go').addEventListener('click', function () {
      if (!deferred) { close(el); return; }
      deferred.prompt();
      deferred.userChoice.then(function (r) {
        if (r && r.outcome === 'accepted') hideFor(3650);
        else hideFor(HIDE_DAYS);
        deferred = null; close(el);
      });
    });
  }

  function showIOS() {
    var el = bar(
      '<div class="h"><span class="ic">📲</span><h4>Установить на iPhone</h4>'
      + '<button class="x" aria-label="Закрыть">✕</button></div>'
      + '<p>Safari не умеет устанавливать автоматически — добавьте ярлык вручную, это 5 секунд:</p>'
      + '<ol><li>Нажмите <b>Поделиться</b> <span style="opacity:.7">(квадрат со стрелкой вверх)</span></li>'
      + '<li>Выберите <b>На экран «Домой»</b></li>'
      + '<li>Нажмите <b>Добавить</b></li></ol>'
      + '<button class="go">Понятно</button>');
    if (!el) return;
    el.querySelector('.go').addEventListener('click', function () { hideFor(HIDE_DAYS); close(el); });
  }

  /* --------------------------------------------------------------- init */
  head();

  if ('serviceWorker' in navigator) {
    global.addEventListener('load', function () {
      navigator.serviceWorker.register(ROOT + '/sw.js', { scope: '/' })
        .catch(function () { /* сайт работает и без офлайн-режима */ });
    });
  }

  global.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    if (!isStandalone) setTimeout(showAndroid, 2500);
  });

  global.addEventListener('appinstalled', function () {
    hideFor(3650);
    var el = document.getElementById('pwa-bar');
    if (el) close(el);
  });

  /* iOS: системного события нет — показываем инструкцию сами */
  if (isIOS && isSafari && !isStandalone) setTimeout(showIOS, 3000);

  /* ручной вызов: CollegePWA.install() */
  global.CollegePWA = {
    canInstall: function () { return !!deferred; },
    isInstalled: function () { return isStandalone; },
    install: function () {
      try { localStorage.removeItem(KEY_HIDE); } catch (e) { /* noop */ }
      if (deferred) showAndroid();
      else if (isIOS) showIOS();
      else bar('<div class="h"><span class="ic">📲</span><h4>Установка приложения</h4>'
        + '<button class="x" aria-label="Закрыть">✕</button></div>'
        + '<p>Откройте сайт в Chrome на Android или Safari на iPhone — там появится '
        + 'кнопка установки. На компьютере нажмите значок установки в адресной строке.</p>');
    }
  };

})(window);
