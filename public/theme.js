// Thema vóór de eerste weergave toepassen (geen flits). Standaard licht; per apparaat te kiezen:
// licht, donker of het systeem volgen.
(function () {
  var pref = 'light';
  try { pref = localStorage.getItem('weekmand-theme') || 'light'; } catch (e) { /* privévenster */ }
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function apply() {
    var dark = pref === 'dark' || (pref === 'system' && !!media && media.matches);
    document.documentElement.toggleAttribute('data-dark', dark);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#1b1e1b' : '#2f5a43');
  }
  apply();
  if (media && media.addEventListener) media.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', apply);
  window.weekmandTheme = {
    get: function () { return pref; },
    set: function (value) {
      pref = value;
      try { localStorage.setItem('weekmand-theme', value); } catch (e) { /* niet bewaard */ }
      apply();
    },
  };
})();
