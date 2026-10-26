/* ==========================================================================
   General/badges.js — ЗНАЧКИ ПРОФИЛЯ «Колледж·ID»
   --------------------------------------------------------------------------
   Рисует выданные значки рядом с именем пользователя.

   Поддерживает любые изображения: PNG, JPG, WEBP, SVG и анимированные GIF.
   GIF вставляется тегом <img>, поэтому анимация сохраняется и в виде
   маленького значка рядом с ником.

     CollegeBadges.html(list)        → HTML-строка со значками
     CollegeBadges.render(el, list)  → нарисовать в элемент
     CollegeBadges.mine()            → значки текущего пользователя
     CollegeBadges.of(login)         → значки пользователя из каталога
   ========================================================================== */

(function (global) {
  'use strict';

  function css() {
    if (document.getElementById('badges-css')) return;
    var st = document.createElement('style');
    st.id = 'badges-css';
    st.textContent = [
      '.cb-row{display:inline-flex;align-items:center;gap:4px;vertical-align:middle;flex-wrap:wrap}',
      '.cb{display:inline-flex;align-items:center;justify-content:center;flex:none;',
      ' width:var(--cb-size,20px);height:var(--cb-size,20px);border-radius:6px;overflow:hidden;',
      ' background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);',
      ' transition:transform .18s;position:relative}',
      '.cb:hover{transform:scale(1.18);z-index:2}',
      '.cb img{width:100%;height:100%;object-fit:contain;display:block;image-rendering:auto}',
      '.cb.anim{border-color:rgba(var(--glow,99,102,241),.45);',
      ' box-shadow:0 0 10px -2px rgba(var(--glow,99,102,241),.55)}',
      '.cb-lg{--cb-size:28px}',
      '.cb-sm{--cb-size:16px}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /** HTML со значками. size: 'sm' | '' | 'lg' */
  function html(list, size) {
    css();
    if (!list || !list.length) return '';
    var cls = size === 'lg' ? ' cb-lg' : (size === 'sm' ? ' cb-sm' : '');
    return '<span class="cb-row">' + list.map(function (b) {
      if (!b || !b.image) return '';
      var anim = b.animated || /^data:image\/gif/.test(b.image);
      return '<span class="cb' + cls + (anim ? ' anim' : '') + '" title="' + esc(b.name) + '">'
        + '<img src="' + esc(b.image) + '" alt="' + esc(b.name) + '" loading="lazy">'
        + '</span>';
    }).join('') + '</span>';
  }

  function render(el, list, size) {
    if (!el) return;
    el.innerHTML = html(list, size);
  }

  /** Значки текущего пользователя (уже пришли в bootstrap) */
  function mine() {
    try { return global.CollegeDB && CollegeDB.myBadges ? CollegeDB.myBadges() : []; }
    catch (e) { return []; }
  }

  /** Значки произвольного пользователя — требует каталог */
  function of(login) {
    if (!global.CollegeDB || !CollegeDB.loadBadgeCatalog) return Promise.resolve([]);
    var u = CollegeDB.findByLogin ? CollegeDB.findByLogin(login) : null;
    var ids = (u && Array.isArray(u.badges)) ? u.badges : [];
    if (!ids.length) return Promise.resolve([]);
    return CollegeDB.loadBadgeCatalog().then(function (cat) {
      return ids.map(function (id) {
        for (var i = 0; i < cat.length; i++) if (cat[i].id === id) return cat[i];
        return null;
      }).filter(Boolean);
    });
  }

  css();
  global.CollegeBadges = { html: html, render: render, mine: mine, of: of };

})(window);
