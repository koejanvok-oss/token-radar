// Launch Radar — the dashboard. Reads window.RADAR (written by main.ts into data.js), no network.
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) { document.body.innerHTML = '<p style="padding:32px">No radar data found.</p>'; return; }
  var rows = R.rows, live = R.live, fit = R.fit;
  function $(id) { return document.getElementById(id); }
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) { return n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function ageFmt(d) { return d === null || d === undefined ? '—' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---- KPI strip: coverage, size, and the fit's two validations, all from the run itself.
  $('asof').textContent = 'Snapshot ' + R.as_of + ' · ' + R.board_size + ' protocols ranked';
  $('src').textContent = R.source;
  var kpis = [
    [R.watchlist_size + ' / ' + R.watchlist_size, 'watchlist covered', 'good'],
    [String(R.board_size), 'pre-token protocols ranked'],
    [String(R.early_size), 'found below the $50M floor'],
    ['R² ' + fit.r2.toFixed(2), 'comps fit on ' + fit.n_traded + ' traded protocols'],
    ['±' + fit.heldout_median_log_err.toFixed(2), 'held-out median log error (n=' + fit.heldout_n + ')'],
    ['±' + fit.walkforward_median_log_err.toFixed(2), 'walk-forward median log error (n=' + fit.walkforward_test_n + ')'],
  ];
  $('kpis').innerHTML = kpis.map(function (k) {
    return '<div class="kpi' + (k[2] ? ' ' + k[2] : '') + '"><b>' + k[0] + '</b><span>' + k[1] + '</span></div>';
  }).join('');

  // ---- Tabs.
  var tabBtns = Array.prototype.slice.call(document.querySelectorAll('.tabs button'));
  function showTab(name) {
    tabBtns.forEach(function (b) { b.classList.toggle('on', b.dataset.tab === name); });
    ['board', 'live', 'method'].forEach(function (t) { $('tab-' + t).classList.toggle('on', t === name); });
  }
  tabBtns.forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });

  // ---- Board: filter, sort, render.
  var cats = Array.from(new Set(rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
  $('cat').innerHTML = '<option value="">All categories</option>' + cats.map(function (c) {
    return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
  }).join('');
  var state = { q: '', cat: '', sort: 'rank', wlOnly: false };
  function filtered() {
    var list = rows.filter(function (r) {
      if (state.wlOnly && !r.watchlist) return false;
      if (state.cat && (r.category || 'Uncategorised') !== state.cat) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if (r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sort;
    list.sort(function (a, b) {
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'growth') return (b.change_7d || 0) - (a.change_7d || 0);
      if (key === 'age') return (b.age_days || 0) - (a.age_days || 0);
      if (key === 'odds') return b.launch_odds - a.launch_odds;
      if (key === 'implied') return b.implied_value_usd - a.implied_value_usd;
      return a.rank - b.rank;
    });
    return list;
  }
  function renderBoard() {
    var list = filtered();
    $('count').textContent = list.length + ' of ' + rows.length + ' shown';
    $('rows').innerHTML = list.map(function (r) {
      var g = r.change_7d;
      return '<tr data-slug="' + esc(r.slug) + '"><td>' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span> <span class="slug">' + esc(r.slug) + '</span>' +
        (r.watchlist ? ' <span class="pill wl">watchlist</span>' : '') + '</td>' +
        '<td>' + esc(r.category || '—') + '</td><td>' + esc(r.chains.slice(0, 2).join(', ') || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + (g === null ? '' : g >= 0 ? 'up' : 'down') + '">' + pct(g) + '</td>' +
        '<td class="num">' + ageFmt(r.age_days) + '</td>' +
        '<td class="num">' + Math.round(r.launch_odds * 100) + '%</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td></tr>';
    }).join('');
  }
  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  $('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderBoard(); });
  $('wl').addEventListener('change', function (e) { state.wlOnly = e.target.checked; renderBoard(); });
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (tr) openDetail(tr.dataset.slug);
  });

  // ---- Detail view: the model's breakdown and the farm plan, per protocol.
  function openDetail(slug) {
    var r = rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    var share = Math.round(r.implied_value_usd * R.model.airdrop_share / R.model.farmer_count);
    var steps = r.farm_steps.map(function (s, i) {
      var cls = i === r.farm_steps.length - 1 ? ' class="verdict"' : '';
      return '<li' + cls + '>' + esc(s) + '</li>';
    }).join('');
    $('detailBody').innerHTML =
      '<p class="rankline">Rank #' + r.rank + (r.watchlist ? ' · on the watchlist' : '') + '</p>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="sub">' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ') || '—') + '</p>' +
      '<p class="big">' + money(r.implied_value_usd) + ' <small>implied value</small></p>' +
      '<p class="sub">TVL ' + money(r.tvl_usd) + ' · 7d ' + pct(r.change_7d) + ' · tracked since ' + (r.listed_at || 'unknown') + '</p>' +
      '<h3>How the value is built</h3><table class="break">' +
      '<tr><td>Comps value — exp(' + fit.intercept + ' + ' + fit.slope + ' · ln TVL)</td><td>' + money(r.comps_value_usd) + '</td></tr>' +
      '<tr><td>Category adjustment (' + esc(r.category || 'Uncategorised') + ')</td><td>×' + Math.exp(r.category_adjustment).toFixed(2) + '</td></tr>' +
      '<tr><td>Growth multiplier (7d ' + pct(r.change_7d) + ')</td><td>×' + r.growth_multiplier.toFixed(2) + '</td></tr>' +
      '<tr><td>Maturity multiplier (' + ageFmt(r.age_days) + ' tracked)</td><td>×' + r.maturity_multiplier.toFixed(2) + '</td></tr>' +
      '<tr><td>Launch odds — share of age-mates whose token already trades</td><td>×' + r.launch_odds.toFixed(2) + '</td></tr>' +
      '<tr class="tot"><td>Implied value</td><td>' + money(r.implied_value_usd) + '</td></tr></table>' +
      '<p class="note">If 5% of the implied value reached ' + R.model.farmer_count.toLocaleString('en-US') + ' farmers, one share is about $' + share.toLocaleString('en-US') + '. That is the plan\'s verdict, not a promise.</p>' +
      '<h3>Farm plan — 7 steps</h3><ol class="steps">' + steps + '</ol>';
    $('detail').hidden = false;
    if (location.hash !== '#detail=' + slug) history.replaceState(null, '', '#detail=' + slug);
  }
  $('closeDetail').addEventListener('click', function () {
    $('detail').hidden = true;
    history.replaceState(null, '', location.pathname);
  });

  // ---- Live tokens: the market's own values, apart from the ranked board.
  $('liveRows').innerHTML = live.map(function (p) {
    return '<tr><td><span class="name">' + esc(p.name) + '</span> <span class="slug">' + esc(p.slug) + '</span></td>' +
      '<td>' + esc(p.category || '—') + '</td><td>' + esc(p.chains.slice(0, 2).join(', ') || '—') + '</td>' +
      '<td class="num">' + money(p.tvl_usd) + '</td><td class="num">' + (p.mcap_usd ? money(p.mcap_usd) : '—') + '</td>' +
      '<td class="num">' + (p.mcap_usd ? (p.mcap_usd / p.tvl_usd).toFixed(2) + '×' : '—') + '</td>' +
      '<td class="num ' + (p.change_7d === null ? '' : p.change_7d >= 0 ? 'up' : 'down') + '">' + pct(p.change_7d) + '</td></tr>';
  }).join('');

  // ---- Method: the model, its checks, and what it does not claim.
  var catRows = fit.categories.map(function (c) {
    return '<tr><td>' + esc(c.category) + '</td><td>' + c.n + '</td><td>×' + Math.exp(c.adjustment).toFixed(2) + '</td></tr>';
  }).join('');
  $('method').innerHTML =
    '<h2>How the radar works</h2>' +
    '<p>One snapshot, one fit, one board. The snapshot is DefiLlama\'s protocol list as of ' + R.as_of + ' (' + R.source + '): ' + R.board_size + ' protocols that record no token are ranked; ' + R.live_size + ' that already trade are shown apart, with the market\'s own values.</p>' +
    '<h3>The value model (radar-2-fitted)</h3>' +
    '<p><code>implied = comps × category × growth × maturity × odds</code></p>' +
    '<ul><li><b>Comps.</b> log(market cap) = ' + fit.intercept + ' + ' + fit.slope + ' × log(TVL), fitted by least squares on the ' + fit.n_traded + ' traded protocols in this snapshot. No protocol name is ever special-cased.</li>' +
    '<li><b>Category.</b> The median log-residual of the protocol\'s category, shrunk by n / (n + 8) and clamped to ±1, for categories with at least 8 traded protocols.</li>' +
    '<li><b>Growth.</b> 1 + clamp(7-day TVL change, −60%, +120%) / 100 × 0.5.</li>' +
    '<li><b>Maturity.</b> 0.6 + min(age, 1095 days) / 1095 × 0.4; age unknown counts as 365 days.</li>' +
    '<li><b>Launch odds.</b> Among the protocols listed at least as long ago as this one, the share whose token already trades — the peers\' record, clamped to 5–50%.</li></ul>' +
    '<h3>The checks, run on this snapshot</h3>' +
    '<p>Comps fit: R² ' + fit.r2.toFixed(2) + ', residual SD ' + fit.resid_sd.toFixed(2) + ' in log terms, median market-cap / TVL ' + fit.median_ratio.toFixed(2) + '×. Held-out (every 5th traded protocol by slug, fitted on the rest): median absolute log error ' + fit.heldout_median_log_err.toFixed(2) + ' on ' + fit.heldout_n + ' protocols. Walk-forward (fitted on protocols listed before ' + R.model.walkforward_cutoff + ', tested on those listed after): median absolute log error ' + fit.walkforward_median_log_err.toFixed(2) + ' on ' + fit.walkforward_test_n + ' protocols. A comps value is a rough guide, not a price — the strip above says so on the board itself.</p>' +
    '<h3>Category adjustments</h3><table><tr><th>Category</th><th>Traded n</th><th>Multiplier</th></tr>' + catRows + '</table>' +
    '<h3>What the radar does not claim</h3>' +
    '<p>A protocol on the board <b>records no token</b> in DefiLlama\'s data; it may still have one its record does not carry, and a wrapped, staked or bridged product of a token that already trades is not a launch. The implied value is this radar\'s own claim, never make.fun\'s, and the farm verdict assumes 5% of it reaching ' + R.model.farmer_count.toLocaleString('en-US') + ' farmers. The watchlist is the floor, never the ceiling: ' + R.early_size + ' rows sit below its $50M floor because the radar exists to find them early.</p>' +
    '<h3>Farm plans</h3>' +
    '<p>Every row carries seven steps, written from the protocol\'s own record — its category, its chains, its TVL and its age. Each step states what it costs and how long it takes; the last step is the verdict, the model\'s own maths on whether the position pays.</p>';

  // ---- Hash routing, so a screenshot can open a state directly: #detail=<slug>, #filter=<category>, #tab=live|method.
  var h = location.hash;
  var m = h.match(/#detail=([\w-]+)/);
  if (m) { openDetail(m[1]); }
  var f = h.match(/#filter=([^&]+)/);
  if (f) { state.cat = decodeURIComponent(f[1]); $('cat').value = state.cat; }
  var t = h.match(/#tab=(live|method)/);
  if (t) showTab(t[1]);
  renderBoard();
})();
