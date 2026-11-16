// SoSoValue Research Desk dashboard. Reads window.SOSO (data.js, written
// beside this directory by main.ts) and renders four views: the ranked
// research board, the dip-bounce signal engine's backtest, US ETF flow
// history, and the SoSoValue index constituents. No network and no fetch:
// every figure comes from that one dataset, and the research score is
// recomputed in the page from each row's own inputs so a reader can check
// the board's arithmetic against the model that states it.
//
// Adapted from the Launch Radar dashboard (same shell, helpers and
// detail-sheet pattern) for the SoSoValue data model.
(function () {
  'use strict';

  var DATA = window.SOSO;
  if (!DATA) return;
  var M = DATA.model;
  var root = document.getElementById('app');
  var state = { q: '', stance: 'all', index: 'all', tab: 'board', etf: 'BTC', sig: null, selected: null };

  // ---------- formatting ----------
  var whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  function usd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var sign = n < 0 ? '-' : '';
    var a = Math.abs(n);
    if (a >= 1e12) return sign + '$' + (a / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(1) + 'K';
    return sign + '$' + a.toFixed(a < 10 ? 2 : 0);
  }
  function price(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (n >= 1000) return '$' + whole.format(Math.round(n));
    if (n >= 1) return '$' + n.toFixed(2);
    return '$' + n.toFixed(4);
  }
  function pct(n, digits) {
    if (n === null || n === undefined) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(digits === undefined ? 2 : digits) + '%';
  }
  function dayText(t) { return new Date(t).toISOString().slice(0, 10); }

  // ---------- the model, restated ----------
  // The same arithmetic lib/model.ts runs. Momentum is recomputed from the
  // row's raw 7d/30d returns; position and liquidity are the row's stored
  // parts (their raw inputs live in the API snapshot). If the recomputed
  // score and the stored score ever disagreed, the detail sheet says so.
  function round4(n) { return Math.round(n * 1e4) / 1e4; }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function scoreOf(row) {
    var blended = (row.ret_30d_pct || 0) * M.momentum_w30 + (row.ret_7d_pct || 0) * M.momentum_w7;
    var momentum = round4(clamp(blended, -M.momentum_clamp_pct, M.momentum_clamp_pct) / M.momentum_clamp_pct);
    var total = M.base + M.momentum_weight * momentum +
      M.position_weight * (2 * row.score.position - 1) + M.liquidity_weight * row.score.liquidity;
    return { momentum: momentum, score: Math.round(clamp(total, 0, 100)) };
  }

  // ---------- tiny DOM helper ----------
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }
  function svgEl(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  // ---------- hash state ----------
  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    ['q', 'stance', 'index', 'tab', 'etf', 'sig'].forEach(function (k) { if (params.get(k)) state[k] = params.get(k); });
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.stance !== 'all') params.set('stance', state.stance);
    if (state.index !== 'all') params.set('index', state.index);
    if (state.tab !== 'board') params.set('tab', state.tab);
    if (state.etf !== 'BTC') params.set('etf', state.etf);
    if (state.sig) params.set('sig', state.sig);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  // ---------- charts ----------
  function sparkline(closes, w, h, stroke) {
    if (!closes || closes.length < 2) return el('span', { class: 'sub', text: 'no history' });
    var min = Math.min.apply(null, closes), max = Math.max.apply(null, closes);
    var span = max - min || 1;
    var pts = closes.map(function (c, i) {
      return (i / (closes.length - 1) * (w - 4) + 2).toFixed(1) + ',' + (h - 3 - (c - min) / span * (h - 6)).toFixed(1);
    }).join(' ');
    var svg = svgEl('svg', { class: 'spark', width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, 'aria-hidden': 'true' });
    svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: stroke || '#2dd4bf', 'stroke-width': '1.6' }));
    return svg;
  }
  function lineChart(series, opts) {
    // series: [{values, color, label}]; returns an SVG element.
    var w = opts.w, h = opts.h, padL = 64, padR = 10, padT = 10, padB = 22;
    var all = [];
    series.forEach(function (s) { all = all.concat(s.values); });
    var min = Math.min.apply(null, all), max = Math.max.apply(null, all);
    var span = max - min || 1;
    min -= span * 0.06; max += span * 0.06; span = max - min;
    var n = series[0].values.length;
    function X(i) { return padL + i / (n - 1) * (w - padL - padR); }
    function Y(v) { return padT + (1 - (v - min) / span) * (h - padT - padB); }
    var svg = svgEl('svg', { viewBox: '0 0 ' + w + ' ' + h, role: 'img', 'aria-label': opts.label || 'chart' });
    [0, 0.5, 1].forEach(function (f) {
      var v = min + span * f;
      svg.appendChild(svgEl('line', { x1: padL, x2: w - padR, y1: Y(v), y2: Y(v), stroke: '#1f2a37', 'stroke-width': '1' }));
      var t = svgEl('text', { x: padL - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis' });
      t.textContent = opts.format ? opts.format(v) : v.toFixed(0);
      svg.appendChild(t);
    });
    series.forEach(function (s) {
      var pts = s.values.map(function (v, i) { return X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join(' ');
      svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': '1.8' }));
    });
    if (opts.markers) {
      opts.markers.forEach(function (mk) {
        var cx = X(mk.index), cy = Y(mk.value);
        var c = svgEl('circle', { cx: cx, cy: cy, r: '4.5', fill: mk.buy ? '#2dd4bf' : '#f26d6d', stroke: '#0a0e13', 'stroke-width': '1.5' });
        svg.appendChild(c);
      });
    }
    return { svg: svg, X: X, Y: Y };
  }

  // ---------- page sections ----------
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'radar-dot', 'aria-hidden': 'true' }),
        el('div', null,
          el('div', { class: 'brand-name', text: 'SOSOVALUE RESEARCH DESK' }),
          el('div', { class: 'brand-sub', text: 'smart research dashboard + signal-to-execution' })
        )
      ),
      el('div', { class: 'top-meta' },
        el('span', null, 'Built ', el('b', { text: dayText(Date.parse(DATA.generated_at)) })),
        el('span', null, 'Data ', el('b', { text: DATA.source === 'live' ? 'SoSoValue OpenAPI' : DATA.source })),
        el('span', null, 'Model ', el('b', { text: DATA.model_version }))
      )
    );
  }

  function hero() {
    var mk = DATA.market || {};
    var bts = DATA.backtests || [];
    var totalRT = bts.reduce(function (s, b) { return s + b.roundTrips; }, 0);
    var traded = bts.filter(function (b) { return b.roundTrips > 0; }).length;
    function kpi(label, value, small) {
      return el('div', { class: 'kpi' }, el('span', { text: label }), el('b', { text: value }), small ? el('small', { text: small }) : null);
    }
    return el('section', null,
      el('section', { class: 'hero' },
        el('div', null,
          el('h1', null, 'Major crypto assets, ranked by ', el('em', { text: 'what the data says today' }), '.'),
          el('p', { text: 'One transparent score per asset, built only from SoSoValue API fields: kline momentum, position between cycle low and all-time high, and turnover liquidity. Below the board, a dip-bounce signal engine \u2014 extracted from a live trading bot \u2014 runs the same rules over every tracked asset\u2019s daily klines as paper-execution backtests, next to the ETF flow tape that often explains the moves.' })
        ),
        el('div', { class: 'kpis' },
          kpi('Total market cap', mk.total_market_cap ? usd(Number(mk.total_market_cap)) : 'n/a', mk.total_market_cap_change_pct ? pct(Number(mk.total_market_cap_change_pct), 1) + ' 24h' : ''),
          kpi('Volume 24h', mk.total_volume_24h ? usd(Number(mk.total_volume_24h)) : 'n/a', 'all assets'),
          kpi('Assets ranked', String(DATA.rows.length), DATA.indices.length + ' indices tracked'),
          kpi('Signal engine', bts.length ? String(totalRT) + ' round trips' : 'n/a', bts.length ? traded + ' of ' + bts.length + ' assets traded' : '')
        )
      ),
      DATA.source !== 'live'
        ? el('div', { class: 'src-banner', text: DATA.source_note })
        : el('div', { class: 'src-banner live', text: DATA.source_note })
    );
  }

  function modelStrip() {
    function step(title, body, fx) {
      return el('div', { class: 'step' }, el('b', { text: title }), el('span', { text: body }), fx ? el('div', { class: 'fx', text: fx }) : null);
    }
    return el('section', { class: 'model-strip' },
      el('h2', { text: 'How a score is made' }),
      el('p', { text: 'No name is hand-picked and no score is typed in. Three documented inputs, one weighted sum; open any asset to see its three numbers and watch the page recompute its score. The scale is absolute, not relative to the other rows: in a market-wide sell-off the whole board can read weak at once. That is the model reporting the market \u2014 the rank still orders the assets, but nothing is promoted just for falling less.' }),
      el('div', { class: 'steps' },
        step('1. Momentum', 'The 30-day kline return, tempered by the 7-day, clamped so one wild month cannot carry the board.', '0.6 x ret30 + 0.4 x ret7, clamp \u00b160%'),
        step('2. Position', 'Where the price sits between its cycle low and its all-time high, both from the market snapshot.', '(price \u2212 low) / (ATH \u2212 low)'),
        step('3. Liquidity', 'The snapshot\u2019s own turnover rate: how much of the market cap actually changed hands in 24h.', 'turnover rate, cap 0.5'),
        step('4. One sum', 'A neutral 45 base, moved by the three inputs. 65+ reads strong, under 35 weak.', '45 + 30\u00b7mom + 15\u00b7pos + 10\u00b7liq')
      )
    );
  }

  function tabs() {
    function tab(id, label) {
      return el('button', { type: 'button', 'aria-pressed': state.tab === id ? 'true' : 'false', text: label, onclick: function () { state.tab = id; writeHash(); render(); } });
    }
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'View' }),
        el('div', { class: 'tabs', role: 'group', 'aria-label': 'Dashboard views' },
          tab('board', 'Research board'), tab('signals', 'Signals & backtest'), tab('etf', 'ETF flows'), tab('indices', 'Indices')
        )
      )
    );
  }

  // ---------- board view ----------
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.stance !== 'all' && r.stance !== state.stance) return false;
      if (state.index !== 'all' && !r.indices.some(function (ix) { return ix.ticker === state.index; })) return false;
      if (!q) return true;
      return (r.name + ' ' + r.symbol).toLowerCase().indexOf(q) >= 0;
    });
  }

  function boardControls() {
    var search = el('input', { type: 'search', placeholder: 'Search asset', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    function select(id, label, values, current, onPick) {
      var s = el('select', { id: id, 'aria-label': label },
        values.map(function (v) { return el('option', { value: v[0], text: v[1], selected: v[0] === current ? 'selected' : null }); })
      );
      s.addEventListener('change', function () { onPick(s.value); writeHash(); render(); });
      return el('div', { class: 'field' }, el('label', { for: id, text: label }), s);
    }
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      select('f-stance', 'Stance', [['all', 'All stances'], ['strong', 'Strong'], ['constructive', 'Constructive'], ['neutral', 'Neutral'], ['weak', 'Weak']], state.stance, function (v) { state.stance = v; }),
      select('f-index', 'Index', [['all', 'All assets']].concat(DATA.indices.map(function (ix) { return [ix.ticker, 'In ' + ix.ticker]; })), state.index, function (v) { state.index = v; }),
      el('span', { class: 'count', text: visibleRows().length + ' of ' + DATA.rows.length + ' assets' })
    );
  }

  function boardTable() {
    var list = visibleRows();
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('div', { text: 'No asset matches those filters.' }),
        el('button', { type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.stance = 'all'; state.index = 'all'; writeHash(); render(); } })
      ));
    }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var rankCell = r.rank <= 3
        ? el('td', null, el('span', { class: 'rank-chip', text: String(r.rank) }))
        : el('td', { class: 'rank', text: String(r.rank) });
      tbody.appendChild(el('tr', {
        'data-selected': state.selected === r.symbol ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.symbol); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.symbol); } }
      },
        rankCell,
        el('td', null, el('div', { class: 'pname' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: r.symbol.toUpperCase() + (r.indices.length ? ' \u00b7 ' + r.indices.map(function (ix) { return ix.ticker; }).join(', ') : '') })
        )),
        el('td', { class: 'num', text: price(r.price) }),
        el('td', { class: 'num ' + (r.change_24h_pct === null ? '' : r.change_24h_pct >= 0 ? 'pos' : 'neg'), text: pct(r.change_24h_pct) }),
        el('td', { class: 'num ' + (r.ret_30d_pct === null ? '' : r.ret_30d_pct >= 0 ? 'pos' : 'neg'), text: pct(r.ret_30d_pct) }),
        el('td', null, sparkline(r.closes_30d, 110, 28, r.ret_30d_pct !== null && r.ret_30d_pct < 0 ? '#f26d6d' : '#2dd4bf')),
        el('td', { class: 'num', text: usd(r.marketcap) }),
        el('td', { class: 'bar-cell' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(2, r.score.score) + '%' })),
          el('span', { class: 'bar-val', text: String(r.score.score) })
        ),
        el('td', null,
          el('span', { class: 'tag stance-' + r.stance, text: r.stance }),
          el('span', { class: 'conf ' + r.confidence, text: r.confidence + ' confidence' })
        )
      ));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { text: 'Ranked by the research score. Select a row for its score breakdown and index peers.' }),
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: '#' }), el('th', { scope: 'col', text: 'Asset' }),
          el('th', { scope: 'col', text: 'Price' }), el('th', { scope: 'col', text: '24h' }),
          el('th', { scope: 'col', text: '30d' }), el('th', { scope: 'col', text: 'Trend (30d)' }),
          el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Score' }),
          el('th', { scope: 'col', text: 'Stance' })
        )),
        tbody
      )
    ));
  }

  // ---------- signals view ----------
  // The same unmodified dip-bounce rules run over every tracked asset.
  // Assets that traded show their trades; assets that did not show the
  // signal diagnostics instead — how many bars the entry predicate was
  // evaluated on, how often it fired, and the bars that came closest —
  // so "no trades" reads as the engine standing aside in a one-way
  // market, not as an empty or broken page.
  function currentBacktest() {
    var bts = DATA.backtests || [];
    if (!bts.length) return null;
    if (state.sig) {
      var hit = null;
      bts.forEach(function (b) { if (b.symbol === state.sig) hit = b; });
      if (hit) return hit;
    }
    var first = null;
    bts.forEach(function (b) { if (!first && b.roundTrips > 0) first = b; });
    if (first) return first;
    var btc = null;
    bts.forEach(function (b) { if (b.symbol === 'BTC') btc = b; });
    return btc || bts[0];
  }

  function signalsView() {
    var bts = DATA.backtests || [];
    if (!bts.length) return el('div', { class: 'panel' }, el('div', { class: 'empty', text: 'Not enough kline history in this build to run the backtests.' }));
    var bt = currentBacktest();
    var p = bt.params;
    var dg = bt.diagnostics;
    function stat(label, value, small) {
      return el('div', { class: 'kpi' }, el('span', { text: label }), el('b', { text: value }), small ? el('small', { text: small }) : null);
    }
    var wrap = el('div', null);

    // Asset switcher.
    wrap.appendChild(el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'Backtest asset' }),
        el('div', { class: 'tabs', role: 'group', 'aria-label': 'Backtest asset' },
          bts.map(function (b) {
            return el('button', { type: 'button', 'aria-pressed': bt.symbol === b.symbol ? 'true' : 'false', text: b.symbol, onclick: function () { state.sig = b.symbol; writeHash(); render(); } });
          })
        )
      ),
      el('span', { class: 'count', text: 'same rules, same parameters, every asset' })
    ));

    // All-assets summary: proof the engine ran on everything.
    var sumBody = el('tbody');
    bts.forEach(function (b) {
      var d = b.diagnostics;
      sumBody.appendChild(el('tr', {
        'data-selected': bt.symbol === b.symbol ? 'true' : 'false', tabindex: '0',
        onclick: function () { state.sig = b.symbol; writeHash(); render(); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.sig = b.symbol; writeHash(); render(); } }
      },
        el('td', null, el('b', { text: b.symbol })),
        el('td', { class: 'num ' + (b.totalReturn >= 0 ? 'pos' : 'neg'), text: pct(b.totalReturn * 100) }),
        el('td', { class: 'num ' + (b.buyHoldReturn >= 0 ? 'pos' : 'neg'), text: pct(b.buyHoldReturn * 100) }),
        el('td', { class: 'num', text: String(b.roundTrips) }),
        el('td', { class: 'num', text: String(d.predicateHits) + ' / ' + d.evaluatedBars }),
        el('td', { class: 'num', text: d.deepestDip ? pct(d.deepestDip.lookbackReturn * 100, 1) : 'n/a' }),
        el('td', { text: b.roundTrips > 0 ? 'traded' : (d.predicateHits > 0 ? 'signals fired, no fill' : 'no signal \u2014 stood aside') })
      ));
    });
    wrap.appendChild(el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { text: 'Every tracked asset, one rule set. "Signals fired" counts the bars where the entry predicate read true, before position and cooldown state.' }),
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Asset' }), el('th', { scope: 'col', text: 'Strategy' }),
          el('th', { scope: 'col', text: 'Buy & hold' }), el('th', { scope: 'col', text: 'Round trips' }),
          el('th', { scope: 'col', text: 'Signals fired / bars' }), el('th', { scope: 'col', text: 'Deepest ' + p.lookback + 'd dip' }),
          el('th', { scope: 'col', text: 'Outcome' })
        )),
        sumBody
      )
    )));

    // Selected asset: headline stats.
    wrap.appendChild(el('div', { class: 'stat-grid' },
      stat('Strategy return (' + bt.symbol + ')', pct(bt.totalReturn * 100), 'after fees'),
      stat('Buy & hold', pct(bt.buyHoldReturn * 100), 'same window'),
      stat('Max drawdown', pct(-bt.maxDrawdown * 100), 'equity curve'),
      stat('Round trips', String(bt.roundTrips), bt.winRate === null ? '' : 'win rate ' + Math.round(bt.winRate * 100) + '%')
    ));

    // No-trade honesty panel: what the engine saw instead.
    if (bt.roundTrips === 0) {
      var facts = el('div', { class: 'vals' });
      function fact(label, value) { facts.appendChild(el('div', { class: 'val' }, el('span', { text: label }), el('b', { text: value }))); }
      fact('Bars evaluated', String(dg.evaluatedBars));
      fact('Entry signals fired', String(dg.predicateHits));
      if (dg.deepestDip) {
        fact('Deepest ' + p.lookback + 'd dip', pct(dg.deepestDip.lookbackReturn * 100, 1) + ' on ' + dayText(dg.deepestDip.t));
        fact('Turn at that bar (' + p.turnBars + 'd)', pct(dg.deepestDip.turnReturn * 100) + ' \u2014 entry needs > ' + pct(p.turnUp * 100));
      }
      if (dg.closestMiss) {
        var cm = dg.closestMiss;
        var dipGap = cm.lookbackReturn - p.dip, turnGap = p.turnUp - cm.turnReturn;
        fact('Closest miss', dayText(cm.t) + ': dip ' + pct(cm.lookbackReturn * 100, 1) + ', turn ' + pct(cm.turnReturn * 100));
        fact('Binding gap', (dipGap >= turnGap ? 'dip short by ' + pct(dipGap * 100, 1).replace('+', '') + ' pts' : 'turn short by ' + pct(turnGap * 100).replace('+', '') + ' pts'));
      }
      wrap.appendChild(el('div', { class: 'panel note-box' },
        el('h3', { text: 'No trades on ' + bt.symbol + ' in this window \u2014 the engine ran and stood aside' }),
        el('p', { text: dg.predicateHits === 0
          ? 'The entry rule needs two things at once: a close at least ' + Math.abs(p.dip * 100).toFixed(0) + '% below the close ' + p.lookback + ' days earlier, and the last ' + p.turnBars + ' days already turning up. In a one-way drawdown the first condition is met again and again while the second never is \u2014 prices keep falling and the bounce the rule waits for has not happened. Standing aside is the strategy working as specified, not missing data: the scan below covers every evaluable bar of the window.'
          : 'The entry predicate fired on ' + dg.predicateHits + ' bar(s), but position state (an open trade or the post-exit cooldown) or the minimum-notional rule kept the engine out each time, so no round trip completed.' }),
        facts
      ));
    }

    var markers = bt.trades.map(function (t) { return { index: t.index, value: bt.closes[t.index], buy: t.side === 'buy' }; });
    var priceChart = lineChart([{ values: bt.closes, color: '#dce6ee' }], { w: 960, h: 250, markers: markers, format: function (v) { return '$' + whole.format(Math.round(v)); }, label: bt.symbol + ' price with trade markers' });
    var eqChart = lineChart([{ values: bt.equityCurve, color: '#2dd4bf' }], { w: 960, h: 170, format: function (v) { return '$' + whole.format(Math.round(v)); }, label: 'Backtest equity curve' });
    wrap.appendChild(el('div', { class: 'chart-box' },
      el('h3', { text: bt.symbol + ' daily price \u2014 signal markers' }),
      el('p', { text: 'Entry: close at least ' + Math.abs(p.dip * 100).toFixed(0) + '% below the close ' + p.lookback + ' days earlier, with the last ' + p.turnBars + ' days turning up. Exit: +' + (p.takeProfit * 100).toFixed(0) + '% take profit, ' + (p.stopLoss * 100).toFixed(0) + '% stop loss, or ' + p.maxHold + ' days held; then ' + p.cooldown + ' days flat. Stake ' + Math.round(p.stakeFraction * 100) + '% of cash, fees ' + p.feeBpsPerSide + ' bps per side. Paper execution at the signal bar\u2019s close.' }),
      priceChart.svg,
      el('div', { class: 'legend' },
        el('span', null, el('i', { style: 'background:#2dd4bf' }), 'buy'),
        el('span', null, el('i', { style: 'background:#f26d6d' }), 'sell'),
        el('span', { text: 'Exposure ' + Math.round(bt.exposure * 100) + '% of days in position' })
      )
    ));
    wrap.appendChild(el('div', { class: 'chart-box' },
      el('h3', { text: 'Equity curve' }),
      el('p', { text: 'Paper account starting at ' + usd(bt.initialCash) + '. The strategy extracted from the race bot is a pure function of the bars: same bars, same trades, every run.' }),
      eqChart.svg
    ));
    if (bt.trades.length) {
      var tbody = el('tbody');
      bt.trades.forEach(function (t) {
        tbody.appendChild(el('tr', null,
          el('td', { class: 'num', text: dayText(t.t) }),
          el('td', null, el('span', { class: 'tag ' + (t.side === 'buy' ? 'watch' : 'early'), text: t.side.toUpperCase() })),
          el('td', { class: 'num', text: price(t.price) }),
          el('td', { class: 'num', text: usd(t.notional) }),
          el('td', { text: t.reason }),
          el('td', { class: 'num ' + (t.gainPct === null ? '' : t.gainPct >= 0 ? 'pos' : 'neg'), text: t.gainPct === null ? '\u2014' : pct(t.gainPct * 100) })
        ));
      });
      wrap.appendChild(el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Every trade the engine took on this series.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Date' }), el('th', { scope: 'col', text: 'Side' }),
            el('th', { scope: 'col', text: 'Price' }), el('th', { scope: 'col', text: 'Notional' }),
            el('th', { scope: 'col', text: 'Reason' }), el('th', { scope: 'col', text: 'Round-trip' })
          )),
          tbody
        )
      )));
    }
    return wrap;
  }

  // ---------- ETF view ----------
  function etfView() {
    var days = (DATA.etf[state.etf] || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var wrap = el('div', null);
    var toggle = el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'US spot ETF complex' }),
        el('div', { class: 'tabs', role: 'group', 'aria-label': 'ETF asset' },
          ['BTC', 'ETH'].map(function (s) {
            return el('button', { type: 'button', 'aria-pressed': state.etf === s ? 'true' : 'false', text: s, onclick: function () { state.etf = s; writeHash(); render(); } });
          })
        )
      ),
      days.length ? el('span', { class: 'count', text: days.length + ' trading days \u00b7 net assets ' + usd(Number(days[days.length - 1].total_net_assets)) }) : null
    );
    wrap.appendChild(toggle);
    if (days.length === 0) {
      wrap.appendChild(el('div', { class: 'panel' }, el('div', { class: 'empty', text: 'No ETF summary history in this build.' })));
      return wrap;
    }
    // Inflow bars, oldest to newest, zero-centred.
    var w = 960, h = 190, mid = h / 2;
    var maxAbs = Math.max.apply(null, days.map(function (d) { return Math.abs(Number(d.total_net_inflow)); })) || 1;
    var svg = svgEl('svg', { viewBox: '0 0 ' + w + ' ' + h, role: 'img', 'aria-label': 'Daily net inflow bars' });
    svg.appendChild(svgEl('line', { x1: 0, x2: w, y1: mid, y2: mid, stroke: '#1f2a37' }));
    var bw = w / days.length;
    days.forEach(function (d, i) {
      var v = Number(d.total_net_inflow);
      var bh = Math.abs(v) / maxAbs * (mid - 8);
      svg.appendChild(svgEl('rect', {
        x: (i * bw + 1).toFixed(1), y: v >= 0 ? mid - bh : mid, width: Math.max(1, bw - 2).toFixed(1), height: Math.max(1, bh).toFixed(1),
        fill: v >= 0 ? '#4ade80' : '#f26d6d'
      }));
    });
    wrap.appendChild(el('div', { class: 'chart-box' },
      el('h3', { text: state.etf + ' ETF daily net inflow (USD)' }),
      el('p', { text: 'Aggregate of all US-listed spot ' + state.etf + ' ETFs, from the SoSoValue ETF summary history. Persistent inflow is demand the spot market must absorb; persistent outflow is supply.' }),
      svg
    ));
    var tbody = el('tbody');
    days.slice().reverse().slice(0, 14).forEach(function (d) {
      var inflow = Number(d.total_net_inflow);
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: d.date }),
        el('td', { class: 'num ' + (inflow >= 0 ? 'flow-pos' : 'flow-neg'), text: usd(inflow) }),
        el('td', { class: 'num', text: usd(Number(d.total_value_traded)) }),
        el('td', { class: 'num', text: usd(Number(d.total_net_assets)) }),
        el('td', { class: 'num', text: usd(Number(d.cum_net_inflow)) })
      ));
    });
    wrap.appendChild(el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { text: 'Most recent trading days first.' }),
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Date' }), el('th', { scope: 'col', text: 'Net inflow' }),
          el('th', { scope: 'col', text: 'Value traded' }), el('th', { scope: 'col', text: 'Net assets' }),
          el('th', { scope: 'col', text: 'Cumulative inflow' })
        )),
        tbody
      )
    )));
    return wrap;
  }

  // ---------- indices view ----------
  function indicesView() {
    var grid = el('div', { class: 'idx-grid' });
    DATA.indices.forEach(function (ix) {
      var byId = {};
      DATA.rows.forEach(function (r) { byId[r.currency_id] = r; });
      var tbody = el('tbody');
      ix.constituents.slice().sort(function (a, b) { return b.weight - a.weight; }).forEach(function (c) {
        var row = byId[c.currency_id];
        tbody.appendChild(el('tr', null,
          el('td', null, el('b', { text: c.symbol.toUpperCase() }), row ? el('span', { class: 'sub', text: ' ' + row.name }) : null),
          el('td', null, el('div', { class: 'weight-bar' }, el('i', { style: 'width:' + Math.round(c.weight * 100) + '%' }))),
          el('td', { class: 'num', text: (c.weight * 100).toFixed(1) + '%' }),
          el('td', { class: 'num', text: row ? String(row.score.score) : 'n/a' })
        ));
      });
      grid.appendChild(el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: ix.ticker + ' \u00b7 ' + ix.constituents.length + ' constituents \u00b7 last column is this board\u2019s research score' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Constituent' }), el('th', { scope: 'col', text: 'Weight' }),
            el('th', { scope: 'col', text: '' }), el('th', { scope: 'col', text: 'Score' })
          )),
          tbody
        )
      )));
    });
    return grid;
  }

  // ---------- detail sheet ----------
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(symbol) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.symbol === symbol) row = r; });
    if (!row) return;
    state.selected = symbol;
    writeHash();
    var check = scoreOf(row);
    var box = el('div', { class: 'detail-in' });
    box.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'tag stance-' + row.stance, text: row.stance + ' \u00b7 rank ' + row.rank + ' of ' + DATA.rows.length }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: row.symbol.toUpperCase() + (row.indices.length ? ' \u00b7 in ' + row.indices.map(function (ix) { return ix.ticker + ' (' + (ix.weight * 100).toFixed(1) + '%)'; }).join(', ') : ' \u00b7 not in a tracked index') })
      ),
      el('button', { class: 'close', type: 'button', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    box.appendChild(el('h3', { text: 'Score breakdown' }));
    function val(label, value, heroVal) {
      return el('div', { class: 'val' + (heroVal ? ' hero-val' : '') }, el('span', { text: label }), el('b', { text: value }));
    }
    box.appendChild(el('div', { class: 'vals' },
      val('Momentum', (check.momentum >= 0 ? '+' : '') + check.momentum.toFixed(2)),
      val('Position', row.score.position.toFixed(2)),
      val('Liquidity', row.score.liquidity.toFixed(2)),
      val('Score', String(row.score.score), true),
      val('30d return', pct(row.ret_30d_pct)),
      val('7d return', pct(row.ret_7d_pct)),
      val('Volatility 30d', row.volatility_30d_pct === null ? 'n/a' : row.volatility_30d_pct.toFixed(2) + '% / day'),
      val('Page recomputes', String(check.score) + (check.score === row.score.score ? ' \u2014 matches' : ' \u2014 DIFFERS'))
    ));
    box.appendChild(el('h3', { text: 'Market snapshot' }));
    box.appendChild(el('div', { class: 'vals' },
      val('Price', price(row.price)),
      val('24h', pct(row.change_24h_pct)),
      val('Market cap', usd(row.marketcap)),
      val('FDV', usd(row.fdv)),
      val('Turnover 24h', usd(row.turnover_24h)),
      val('Turnover rate', row.turnover_rate === null ? 'n/a' : row.turnover_rate.toFixed(3)),
      val('Down from ATH', row.down_from_ath_pct === null ? 'n/a' : row.down_from_ath_pct.toFixed(1) + '%'),
      val('Confidence', row.confidence)
    ));
    box.appendChild(el('h3', { text: 'Trend, last 30 days' }));
    box.appendChild(sparkline(row.closes_30d, 760, 90, row.ret_30d_pct !== null && row.ret_30d_pct < 0 ? '#f26d6d' : '#2dd4bf'));
    if (row.indices.length) {
      box.appendChild(el('h3', { text: 'Index peers' }));
      var peers = [];
      DATA.rows.forEach(function (r) {
        if (r.symbol === row.symbol) return;
        var shared = r.indices.filter(function (ix) { return row.indices.some(function (a) { return a.ticker === ix.ticker; }); });
        if (shared.length) peers.push({ r: r, via: shared.map(function (s) { return s.ticker; }).join(', ') });
      });
      if (peers.length) {
        var tbody = el('tbody');
        peers.forEach(function (p) {
          tbody.appendChild(el('tr', null,
            el('td', { text: p.r.name + ' (' + p.r.symbol.toUpperCase() + ')' }),
            el('td', { text: p.via }),
            el('td', { class: 'num', text: usd(p.r.marketcap) }),
            el('td', { class: 'num', text: String(p.r.score.score) })
          ));
        });
        box.appendChild(el('table', { class: 'peers' },
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Shares an index with ' + row.name }), el('th', { scope: 'col', text: 'Index' }),
            el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Score' })
          )),
          tbody
        ));
      }
    }
    box.appendChild(el('p', { class: 'note', text: 'Read this right: the score is a research triage device, not a price target and not investment advice. It says where a researcher\u2019s hour is best spent today, given only what the SoSoValue API reports.' }));
    dialog.textContent = '';
    dialog.appendChild(box);
    if (!dialog.isConnected) root.appendChild(dialog);
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }

  function footer() {
    return el('footer', { class: 'foot' },
      el('div', null,
        el('b', { text: 'Method. ' }),
        'Every figure is built from SoSoValue OpenAPI payloads: currency list, market snapshots and daily klines; US ETF summary history; index lists and constituents; and the market overview. The score uses only those fields, with the constants printed above the board. The signal engine is the dip-bounce strategy of a live race bot, extracted as a pure function and re-parameterised for daily bars (the API serves no intraday klines); the race parameters are preserved in the source for comparison.'
      ),
      el('div', null,
        el('b', { text: 'Limits. ' }),
        'The backtest fills at the signal bar\u2019s close with a flat fee and no slippage or market impact, over at most ~90 daily bars \u2014 it demonstrates the execution loop, it does not prove an edge. ' + (DATA.source === 'live' ? '' : 'This build ran on the bundled sample snapshot: payload shapes are the documented ones, values are synthetic, and no figure here is market data.')
      )
    );
  }

  function render() {
    root.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(hero());
    if (state.tab === 'board') {
      shell.appendChild(modelStrip());
      shell.appendChild(tabs());
      shell.appendChild(boardControls());
      shell.appendChild(boardTable());
    } else if (state.tab === 'signals') {
      shell.appendChild(tabs());
      shell.appendChild(signalsView());
    } else if (state.tab === 'etf') {
      shell.appendChild(tabs());
      shell.appendChild(etfView());
    } else {
      shell.appendChild(tabs());
      shell.appendChild(indicesView());
    }
    shell.appendChild(footer());
    root.appendChild(shell);
    root.setAttribute('aria-busy', 'false');
    if (state.selected && state.tab === 'board') openDetail(state.selected);
  }

  readHash();
  render();
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
