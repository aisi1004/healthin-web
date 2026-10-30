/* 건강인 2.0 — 병원·약국·응급실 찾기 / 약·건강 / 즐겨찾기 / 설정 (프레임워크 없는 단일 파일) */
(function () {
'use strict';

/* ---------- 유틸 ---------- */
var $ = function (s, r) { return (r || document).querySelector(s); };
var view = $('#view'), titleEl = $('#title'), backBtn = $('#btnBack');
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function store(k, v) {
  try { if (v === undefined) { var r = localStorage.getItem('hi.' + k); return r ? JSON.parse(r) : null; } localStorage.setItem('hi.' + k, JSON.stringify(v)); } catch (e) { return null; }
}
var toastT;
function toast(m) { var t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 2200); }
var REMOTE = 'https://healthin.imeji.com/';
var NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
function fetchJson(url, ms) {
  var c = window.AbortController && ms ? new AbortController() : null, t = c && setTimeout(function () { c.abort(); }, ms);
  return fetch(url, { cache: 'no-cache', signal: c ? c.signal : undefined }).then(function (r) { clearTimeout(t); if (!r.ok) throw new Error(url); return r.json(); });
}
/* 앱: 사이트의 최신 데이터를 먼저 받고(6초), 안 되면 앱에 들어 있는 데이터로 */
function jget(url) { return NATIVE ? fetchJson(REMOTE + url, 6000).catch(function () { return fetchJson(url); }) : fetchJson(url); }
function rad(d) { return d * Math.PI / 180; }
function dist(lat1, lon1, lat2, lon2) {
  var a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
function fmtDist(km) { return km < 1 ? Math.round(km * 1000 / 10) * 10 + 'm' : km.toFixed(1) + 'km'; }
function mapLink(it) { return 'https://map.kakao.com/link/to/' + encodeURIComponent(it.n) + ',' + it.y + ',' + it.x; }
/* 길찾기: 지도 앱을 고르고(기억함) 해당 앱·웹으로 연다 */
var NAVS = [
  { k: 'kakao', n: '카카오맵', u: function (it) { return mapLink(it); } },
  { k: 'naver', n: '네이버지도', u: function (it) { return 'https://map.naver.com/p/search/' + encodeURIComponent(it.n); } },
  { k: 'google', n: '구글 지도', u: function (it) { return 'https://www.google.com/maps/dir/?api=1&destination=' + it.y + ',' + it.x + '&destination_place_id=&travelmode=transit'; } },
  { k: 'geo', n: '기기 기본 지도', u: function (it) { return 'geo:' + it.y + ',' + it.x + '?q=' + it.y + ',' + it.x + '(' + encodeURIComponent(it.n) + ')'; } }
];
function navOpen(k, it) {
  var m = NAVS.filter(function (x) { return x.k === k; })[0] || NAVS[0]; var u = m.u(it);
  if (/^geo:/.test(u)) { location.href = u; return; }
  var Br = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
  openExt(u);
}
function navTo(it) {
  var pref = store('nav') || 'kakao'; /* 기본은 카카오맵, 설정에서 변경 */
  if (pref === 'ask') return navChoose(it);
  navOpen(pref, it);
}
function navChoose(it) {
  openSheet('길찾기 지도 선택', '<div class="mu" style="margin-bottom:10px">' + esc(it.n) + '까지 길을 찾을 지도를 골라 주세요.</div><div class="menu">' + NAVS.map(function (m) { return '<button class="m" data-nv="' + m.k + '">' + m.n + '<small>›</small></button>'; }).join('') + '</div>', function (m) {
    m.querySelectorAll('[data-nv]').forEach(function (b) { b.onclick = function () { var k = b.getAttribute('data-nv'); m.close(); navOpen(k, it); }; });
  });
}
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('[data-nav]'); if (!b) return;
  e.preventDefault();
  navTo({ n: b.getAttribute('data-n'), y: b.getAttribute('data-y'), x: b.getAttribute('data-x'), a: b.getAttribute('data-a') || '' });
});
function telHref(t) { return 'tel:' + String(t || '').replace(/[^0-9+]/g, ''); }

/* ---------- 상태 ---------- */
var S = {
  tab: 'hospital', sub: 'h', type: '전체', q: '', limit: 30,
  pos: store('pos'), regions: null, cache: {}, er: null, dis: null, posts: null,
  favs: store('favs') || [], sample: false,
};
var stack = []; // 상세 화면 스택

/* ---------- 위치 ---------- */
function getPos(force) {
  return new Promise(function (res) {
    if (!force && S.pos) return res(S.pos);
    if (!navigator.geolocation) return res(S.pos);
    navigator.geolocation.getCurrentPosition(function (p) {
      S.pos = { lat: p.coords.latitude, lon: p.coords.longitude, t: Date.now() };
      store('pos', S.pos); res(S.pos);
    }, function () { toast('위치를 가져올 수 없어요. 위치 권한을 확인해 주세요.'); res(S.pos); }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  });
}

/* ---------- 데이터 ---------- */
function loadRegions() { return S.regions ? Promise.resolve(S.regions) : jget('data/regions.json').then(function (r) { S.regions = r.regions; S.sample = !!r.sample; return S.regions; }); }
function loadShard(kind, code) {
  var k = kind + code;
  if (S.cache[k]) return Promise.resolve(S.cache[k]);
  return jget('data/' + kind + '/' + code + '.json').then(function (d) { S.cache[k] = d; return d; }).catch(function () { return []; });
}
/* 상비약 판매점(s)은 지역 구분 체계가 달라 자기 지역 목록(data/s/index.json)을 쓴다 */
function loadRegionsS() { return S.regionsS ? Promise.resolve(S.regionsS) : jget('data/s/index.json').then(function (r) { S.regionsS = r.regions; return S.regionsS; }); }
function nearbyItems(kind) {
  return Promise.all([kind === 's' ? loadRegionsS() : loadRegions(), getPos(false)]).then(function (a) {
    var regs = a[0], pos = a[1];
    if (!pos) return { items: [], pos: null };
    var near = regs.map(function (r) { return { r: r, d: dist(pos.lat, pos.lon, r.lat, r.lon) }; }).sort(function (x, y) { return x.d - y.d; }).slice(0, 4);
    return Promise.all(near.map(function (n) { return loadShard(kind, n.r.code); })).then(function (lists) {
      var all = [].concat.apply([], lists);
      all.forEach(function (it) { it._d = dist(pos.lat, pos.lon, it.y, it.x); });
      all.sort(function (x, y) { return x._d - y._d; });
      return { items: all, pos: pos };
    });
  });
}

/* ---------- 즐겨찾기 ---------- */
function isFav(id) { return S.favs.some(function (f) { return f.id === id; }); }
function toggleFav(it) {
  if (isFav(it.id)) { S.favs = S.favs.filter(function (f) { return f.id !== it.id; }); toast('즐겨찾기에서 뺐어요'); }
  else { S.favs.unshift({ id: it.id, n: it.n, t: it.t || it.c || '', a: it.a, p: it.p || '', x: it.x, y: it.y }); toast('즐겨찾기에 담았어요'); }
  store('favs', S.favs);
}

/* ---------- 렌더 공통 ---------- */
function setTitle(t, back) { titleEl.textContent = t; backBtn.hidden = !back; }
/* 약국 영업 상태: it.o = "0900-1800|…"(월~일, 공휴일 순 8칸, 빈칸=휴무). 공휴일은 따로 보지 않는다 */
function hhmm(m) { m = m % 1440; return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
function openState(it) {
  if (!it.o) return null;
  var n = new Date(), seg = it.o.split('|')[(n.getDay() + 6) % 7];
  if (!seg) return { open: false, text: '오늘 휴무' };
  var a = seg.split('-'), s = (+a[0].slice(0, 2)) * 60 + (+a[0].slice(2)), c = (+a[1].slice(0, 2)) * 60 + (+a[1].slice(2)), m = n.getHours() * 60 + n.getMinutes();
  if (c <= s) c += 1440;
  var open = m >= s && m < c;
  return open ? { open: true, text: '영업 중 · ' + hhmm(c) + '까지' } : { open: false, text: '영업 종료 · 오늘 ' + hhmm(s) + '~' + hhmm(c) };
}
function card(it, opts) {
  opts = opts || {};
  var d = it._d != null ? '<span class="dist">' + fmtDist(it._d) + '</span>' : '';
  var badge = it.t ? '<span class="badge">' + esc(it.t) + '</span>' : '';
  if (it.c) badge = '<span class="badge red">' + esc(it.c) + '</span>';
  var os = openState(it);
  if (os) badge += '<span class="badge ' + (os.open ? 'on' : 'off') + '">' + esc(os.text) + '</span>';
  var dep = it.d && it.d.length ? '<div class="mu">' + esc(it.d.join(', ')) + '</div>' : '';
  var tel = it.p ? '<a class="btn sm" href="' + telHref(it.p) + '">전화 ' + esc(it.p) + '</a>' : '';
  var er = it.e ? '<a class="btn sm red" href="' + telHref(it.e) + '">응급실 ' + esc(it.e) + '</a>' : '';
  return '<div class="card" data-id="' + esc(it.id) + '"><div class="row"><div style="flex:1;min-width:0"><h3>' + esc(it.n) + '</h3>' + badge + '</div>' + d +
    '<button class="star" data-fav="' + esc(it.id) + '" aria-label="즐겨찾기">' + (isFav(it.id) ? '⭐' : '☆') + '</button></div>' +
    '<div class="mu" style="margin:6px 0 8px">' + esc(it.a) + '</div>' + dep +
    '<div class="row wrap" style="margin-top:8px">' + er + tel + '<button class="btn sm sub" data-nav="1" data-n="' + esc(it.n) + '" data-y="' + it.y + '" data-x="' + it.x + '" data-a="' + esc(it.a || '') + '">길찾기</button></div></div>';
}
function bindFav(list) {
  view.querySelectorAll('[data-fav]').forEach(function (b) {
    b.onclick = function () {
      var id = b.getAttribute('data-fav');
      var it = list.filter(function (x) { return x.id === id; })[0] || S.favs.filter(function (x) { return x.id === id; })[0];
      if (!it) return; toggleFav(it); b.textContent = isFav(id) ? '⭐' : '☆';
      if (S.tab === 'my') renderMy();
    };
  });
}
function locBar() {
  var txt = S.pos ? '내 위치 기준으로 가까운 순' : '위치를 켜면 가까운 곳부터 보여드려요';
  return '<div class="loc"><div class="mu">' + txt + '</div><button class="btn sm" id="btnLoc">' + (S.pos ? '위치 새로고침' : '내 위치 사용') + '</button></div>';
}
function sampleWarn() { return S.sample ? '<div class="warn">⚠ 지금은 <b>가상 샘플 데이터</b>입니다(실제 기관 아님). 공공데이터 수집이 연결되면 실제 정보로 바뀝니다.</div>' : ''; }

/* ---------- 병원·약국 ---------- */
var H_TYPES = ['전체', '소아과', '의원', '병원', '종합병원', '치과', '한의원'];
/* 달빛어린이병원(야간·주말 소아 진료)은 공식 목록 사이트로 연결한다. options.json 의 moonlight 로 교체·숨김 가능 */
var DEFAULT_MOON = { show: true, title: '달빛어린이병원', desc: '밤이나 주말에 아이가 아플 때 가는 소아 진료기관이에요. 지역별 공식 목록은 중앙응급의료센터(E-GEN)에서 확인하세요.', btn: '공식 목록 보기', url: 'https://www.e-gen.or.kr/moonlight/main.do', open: 'inapp' };
function moonCard() {
  var m = Object.assign({}, DEFAULT_MOON, (store('opt') || {}).moonlight || {});
  if (m.show === false) return '';
  /* 평소에는 한 줄로 접어 두고, 누르면 가까운 병원 목록과 공식 목록 버튼이 펼쳐진다 */
  return '<div class="card moon"><button class="moonHead" id="moonHead"><span>🌙 <b>' + esc(m.title) + '</b> <small class="mu">야간·주말 소아 진료</small></span><span class="mu" id="moonArr">' + (S.moonOpen ? '▴' : '▾') + '</span></button>' +
    '<div id="moonBody"' + (S.moonOpen ? '' : ' hidden') + '><div class="mu" style="margin:8px 0">' + esc(m.desc) + '</div><div id="moonList"></div><button class="btn sm sub" id="moonBtn">' + esc(m.btn) + '</button></div></div>';
}
/* 우리가 관리하는 달빛어린이병원 목록(data/moonlight.json)이 있으면 가까운 순으로 보여준다 */
function drawMoon(pos) {
  var el = $('#moonList'); if (!el || !pos) return;
  (S.moonData ? Promise.resolve(S.moonData) : jget('data/moonlight.json').then(function (d) { S.moonData = d; return d; })).then(function (d) {
    if (!d || !d.items || !d.items.length) return;
    var l = d.items.map(function (it) { it._d = dist(pos.lat, pos.lon, it.y, it.x); return it; }).sort(function (a, b) { return a._d - b._d; }).slice(0, 3);
    el.innerHTML = l.map(function (it) {
      return '<div style="border-top:1px solid var(--ln);padding:8px 0"><div class="row"><b style="flex:1">' + esc(it.n) + '</b><span class="dist" style="font-size:13px">' + fmtDist(it._d) + '</span></div><div class="mu">' + esc(it.a) + '</div>' + (it.h ? '<div class="mu">🕘 ' + esc(it.h) + '</div>' : '') +
        '<div class="row wrap" style="margin-top:6px">' + (it.p ? '<a class="btn sm" href="' + telHref(it.p) + '">전화 ' + esc(it.p) + '</a>' : '') + '<button class="btn sm sub" data-nav="1" data-n="' + esc(it.n) + '" data-y="' + it.y + '" data-x="' + it.x + '" data-a="' + esc(it.a || '') + '">길찾기</button></div></div>';
    }).join('') + '<div class="note" style="margin:6px 0 8px">' + esc(d.note || '') + (d.updated ? ' (기준 ' + esc(d.updated) + ')' : '') + '</div>';
  }).catch(function () {});
}
function typeMatch(it) {
  if (S.type === '전체') return true;
  if (S.type === '소아과') return !!(it.d && it.d.indexOf('소아청소년과') >= 0);
  if (S.type === '치과') return /치과/.test(it.t || '');
  return (it.t || '').indexOf(S.type) >= 0;
}
function renderHospital() {
  setTitle(S.sub === 'h' ? '병원 찾기' : S.sub === 'p' ? '약국 찾기' : '상비약 판매점', false);
  view.innerHTML = '<div class="seg"><button data-s="h" class="' + (S.sub === 'h' ? 'on' : '') + '">병원·의원</button><button data-s="p" class="' + (S.sub === 'p' || S.sub === 's' ? 'on' : '') + '">약국</button></div>' +
    '<div id="hb"><div class="empty">불러오는 중…</div></div>';
  view.querySelectorAll('.seg button').forEach(function (b) { b.onclick = function () { S.sub = b.getAttribute('data-s'); S.limit = 30; renderHospital(); }; });
  nearbyItems(S.sub).then(function (r) { drawHospital(r); }).catch(function () { $('#hb').innerHTML = '<div class="empty">데이터를 불러오지 못했어요.</div>'; });
}
/* 가로로 넘기는 칩 줄: 양쪽 화살표, 다시 그려도 스크롤 위치 유지 */
function chipWrap(inner) { return '<div class="chipwrap"><button class="arr l" hidden aria-label="왼쪽">‹</button><div class="chips">' + inner + '</div><button class="arr r" hidden aria-label="오른쪽">›</button></div>'; }
function bindChipWrap(root, keepLeft) {
  root.querySelectorAll('.chipwrap').forEach(function (w) {
    var c = w.querySelector('.chips'), l = w.querySelector('.arr.l'), r = w.querySelector('.arr.r');
    function upd() { l.hidden = c.scrollLeft < 4; r.hidden = c.scrollLeft + c.clientWidth > c.scrollWidth - 4; }
    if (keepLeft) c.scrollLeft = keepLeft;
    l.onclick = function () { c.scrollLeft = c.scrollLeft - Math.max(160, c.clientWidth * 0.6); upd(); };
    r.onclick = function () { c.scrollLeft = c.scrollLeft + Math.max(160, c.clientWidth * 0.6); upd(); };
    c.addEventListener('scroll', upd); upd(); setTimeout(upd, 60);
  });
}
function drawHospital(r) {
  var hb = $('#hb'); if (!hb) return;
  var html = sampleWarn() + locBar();
  if (!r.pos) { hb.innerHTML = html + '<div class="empty">내 위치를 켜면 주변 ' + (S.sub === 'h' ? '병원' : S.sub === 'p' ? '약국' : '상비약 판매점') + '을 보여드려요.</div>'; bindLoc(); return; }
  if (S.sub === 's') html += '<div class="warn">편의점 등에서 파는 <b>안전상비의약품</b>(해열진통제·감기약·소화제·파스 등 일부 품목)만 살 수 있고 약사 상담은 안 됩니다. 영업시간 정보가 없어 <b>24시간 영업 여부는 방문 전 확인</b>해 주세요.</div>';
  var items = r.items;
  if (S.sub === 'h') html += chipWrap(H_TYPES.map(function (t) { return '<button class="chip' + (S.type === t ? ' on' : '') + '" data-t="' + t + '">' + t + '</button>'; }).join(''));
  if (S.sub === 'p' || S.sub === 's') html += chipWrap('<button class="chip' + (S.sub === 'p' && !S.openNow ? ' on' : '') + '" data-o="0">전체</button><button class="chip' + (S.sub === 'p' && S.openNow ? ' on' : '') + '" data-o="1">지금 영업 중</button><button class="chip' + (S.sub === 's' ? ' on' : '') + '" data-o="s">편의점 상비약</button>');
  html += '<input class="search" id="q" placeholder="' + (S.sub === 'h' ? '병원 이름·진료과 검색' : S.sub === 'p' ? '약국 이름 검색' : '판매점 이름 검색') + '" value="' + esc(S.q) + '">';
  if (S.sub === 'h') html += moonCard();
  var f = items.filter(function (it) {
    if (S.sub === 'h' && !typeMatch(it)) return false;
    if (S.sub === 'p' && S.openNow) { var os = openState(it); if (!os || !os.open) return false; }
    if (!S.q) return true; var q = S.q.toLowerCase();
    return (it.n + ' ' + (it.d || []).join(' ') + ' ' + it.a).toLowerCase().indexOf(q) >= 0;
  });
  html += '<div id="list">' + (f.length ? f.slice(0, S.limit).map(card).join('') : '<div class="empty">조건에 맞는 곳이 없어요.</div>') + '</div>';
  if (f.length > S.limit) html += '<button class="btn sub big" id="more">더 보기 (' + (f.length - S.limit) + ')</button>';
  html += S.sub === 's'
    ? '<div class="note">출처: 행정안전부(안전상비의약품 판매업소, 영업/정상 기준). 판매점이 모두 실려 있지는 않을 수 있어요.</div>'
    : '<div class="note">출처: 건강보험심사평가원(병원·약국 정보)' + (S.sub === 'p' ? ', 국립중앙의료원(약국 영업시간)' : '') + '. 영업·진료 시간은 변동될 수 있고 공휴일은 다를 수 있으니 방문 전 전화로 확인하세요.</div>';
  var oldChips = hb.querySelector('.chips'), keepLeft = oldChips ? oldChips.scrollLeft : 0, keepTop = view.scrollTop;
  hb.innerHTML = html; bindLoc(); bindChipWrap(hb, keepLeft); view.scrollTop = keepTop;
  hb.querySelectorAll('.chip').forEach(function (c) { c.onclick = function () { S.limit = 30; if (c.hasAttribute('data-o')) { var v = c.getAttribute('data-o'), was = S.sub; if (v === 's') { S.sub = 's'; return renderHospital(); } S.sub = 'p'; S.openNow = v === '1'; if (was === 's') return renderHospital(); } else S.type = c.getAttribute('data-t'); drawHospital(r); }; });
  drawMoon(r.pos);
  var mh = $('#moonHead'); if (mh) mh.onclick = function () { S.moonOpen = !S.moonOpen; $('#moonBody').hidden = !S.moonOpen; $('#moonArr').textContent = S.moonOpen ? '▴' : '▾'; };
  var mb = $('#moonBtn'); if (mb) mb.onclick = function () { openTarget(Object.assign({}, DEFAULT_MOON, (store('opt') || {}).moonlight || {})); };
  var q = $('#q'); q.oninput = function () { S.q = q.value; S.limit = 30; var pos = q.selectionStart; drawHospital(r); var nq = $('#q'); nq.focus(); nq.setSelectionRange(pos, pos); };
  var more = $('#more'); if (more) more.onclick = function () { S.limit += 30; drawHospital(r); };
  bindFav(items);
}
function bindLoc() { var b = $('#btnLoc'); if (b) b.onclick = function () { getPos(true).then(function () { (S.tab === 'er' ? renderEr : renderHospital)(); }); }; }

/* ---------- 응급실 ---------- */
function renderEr() {
  setTitle('응급실 찾기', false);
  view.innerHTML = '<div class="warn red"><b>생명이 위급하면 먼저 119</b>에 전화하세요.</div><a class="btn red big" href="tel:119" style="margin-bottom:12px">119 전화하기</a>' + ecardHtml() + '<div id="eb"><div class="empty">불러오는 중…</div></div>';
  Promise.all([S.er ? S.er : jget('data/er.json').then(function (d) { return d && d.items && d.items.length ? d : fetchJson('data/er.json'); }), getPos(false)]).then(function (a) {
    S.er = a[0]; S.sample = !!a[0].sample; var pos = a[1], items = a[0].items.slice();
    if (pos) { items.forEach(function (it) { it._d = dist(pos.lat, pos.lon, it.y, it.x); }); items.sort(function (x, y) { return x._d - y._d; }); }
    var html = sampleWarn() + locBar() + items.slice(0, 40).map(card).join('');
    html += '<div class="note">출처: 국립중앙의료원(전국 응급의료기관 정보). 병상·진료 가능 여부는 수시로 달라지므로 가기 전 전화로 확인하세요.</div>';
    $('#eb').innerHTML = html; bindLoc(); bindFav(items); bindEcard();
  }).catch(function () { $('#eb').innerHTML = '<div class="empty">데이터를 불러오지 못했어요.</div>'; });
}

/* ---------- 공통: 아래서 올라오는 입력 창 ---------- */
/* 앱 안 확인 창 (기기 기본 confirm 대신) */
function askConfirm(title, msg, yesLabel, onYes) {
  openSheet(title, '<div class="mu" style="margin-bottom:12px">' + esc(msg) + '</div><div class="row"><button class="btn sub" id="cNo" style="flex:1">취소</button><button class="btn red" id="cYes" style="flex:1">' + esc(yesLabel || '삭제') + '</button></div>', function (m) {
    $('#cNo', m).onclick = function () { m.close(); };
    $('#cYes', m).onclick = function () { m.close(); onYes(); };
  });
}
function openSheet(title, bodyHtml, mount) {
  var m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = '<div class="sheet"><h3>' + esc(title) + '</h3><div class="sbody" style="margin-top:8px">' + bodyHtml + '</div></div>';
  m.onclick = function (e) { if (e.target === m) m.remove(); };
  document.body.appendChild(m);
  m.close = function () { m.remove(); };
  if (mount) mount(m);
  return m;
}
function LNP() { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications; }

/* ---------- 알림: 복약 · 검진/접종 (기기 안에서만 저장·알림) ---------- */
function rems() { return store('rem') || []; }
function newRid() { return Math.floor(Date.now() / 1000) % 100000000; }
function remIds(r) { var a = []; for (var i = 0; i <= 8; i++) a.push({ id: r.id * 10 + i }); return a; }
var WD = ['일', '월', '화', '수', '목', '금', '토'];
function schedRem(r) {
  var P = LNP(); if (!P) return Promise.resolve(false);
  var hm = (r.time || '09:00').split(':'), H = +hm[0], M = +hm[1], list = [];
  if (r.kind === 'med') {
    var days = r.days && r.days.length && r.days.length < 7 ? r.days : null;
    if (!days) list.push({ id: r.id * 10, title: '💊 ' + r.title, body: '약 먹을 시간이에요', schedule: { on: { hour: H, minute: M }, allowWhileIdle: true } });
    else days.forEach(function (d) { list.push({ id: r.id * 10 + d, title: '💊 ' + r.title, body: '약 먹을 시간이에요', schedule: { on: { weekday: d, hour: H, minute: M }, allowWhileIdle: true } }); });
  } else {
    var p = r.date.split('-'), at = new Date(+p[0], +p[1] - 1, +p[2], H, M), now = new Date();
    if (at > now) list.push({ id: r.id * 10, title: '🩺 ' + r.title, body: '오늘 예정한 검진·접종 날이에요', schedule: { at: at, allowWhileIdle: true } });
    var b = new Date(at.getTime() - 3 * 864e5);
    if (b > now) list.push({ id: r.id * 10 + 1, title: '🩺 ' + r.title, body: '3일 뒤 예정이에요', schedule: { at: b, allowWhileIdle: true } });
  }
  return list.length ? P.schedule({ notifications: list }).then(function () { return true; }) : Promise.resolve(false);
}
function unschedRem(r) { var P = LNP(); if (P) P.cancel({ notifications: remIds(r) }).catch(function () {}); }
function ensurePerm() {
  var P = LNP(); if (!P) return Promise.resolve(false);
  return P.checkPermissions().then(function (s) { return s.display === 'granted' ? true : P.requestPermissions().then(function (r) { return r.display === 'granted'; }); }).catch(function () { return false; });
}
function remSub(r) {
  if (r.kind === 'med') return (r.days && r.days.length && r.days.length < 7 ? r.days.map(function (d) { return WD[d - 1]; }).join('·') : '매일') + ' ' + r.time;
  var p = r.date.split('-'); return (+p[1]) + '월 ' + (+p[2]) + '일 ' + r.time;
}
function drawRem() {
  var tb = $('#tb'), list = rems(), prof = store('prof') || {};
  tb.innerHTML = '<div class="row" style="margin-bottom:10px"><button class="btn" id="aMed" style="flex:1">+ 복약 알림</button><button class="btn sub" id="aChk" style="flex:1">+ 검진·접종 알림</button></div>' +
    (list.length ? list.map(function (r) { return '<div class="card"><div class="row"><div style="flex:1;min-width:0"><h3>' + (r.kind === 'med' ? '💊 ' : '🩺 ') + esc(r.title) + '</h3><div class="mu">' + esc(remSub(r)) + '</div></div><button class="btn sm sub" data-del="' + r.id + '">삭제</button></div></div>'; }).join('') : '<div class="empty">추가한 알림이 없어요.<br>복약 시간이나 검진 날짜를 넣으면 알려 드려요.</div>') +
    (LNP() ? '' : '<div class="note">알림은 앱에서만 울려요(웹 화면에서는 목록만 저장).</div>') +
    '<h2>내게 해당하는 검진·접종</h2><div class="card"><div class="row wrap"><input class="search" id="pby" type="number" inputmode="numeric" placeholder="출생연도 (예: 1975)" style="flex:1 1 55%;margin:0" value="' + (prof.by || '') + '"><div class="seg" style="margin:0;flex:1 1 35%"><button data-pg="f" class="' + (prof.sex === 'f' ? 'on' : '') + '">여</button><button data-pg="m" class="' + (prof.sex === 'm' ? 'on' : '') + '">남</button></div></div><div class="note" style="margin:8px 0 0">입력한 정보는 이 기기에만 저장돼요.</div></div><div id="scr"></div>';
  $('#aMed').onclick = function () { remSheet('med'); };
  $('#aChk').onclick = function () { remSheet('chk'); };
  tb.querySelectorAll('[data-del]').forEach(function (b) { b.onclick = function () { var id = +b.getAttribute('data-del'); var all = rems(); var r = all.filter(function (x) { return x.id === id; })[0]; if (r) unschedRem(r); store('rem', all.filter(function (x) { return x.id !== id; })); drawRem(); }; });
  /* 안드로이드 12+ 는 '알람 및 리마인더' 권한이 있어야 정해진 시각에 울린다. 없으면 최대 1시간까지 늦을 수 있어 안내한다 */
  var XP = LNP();
  if (XP && XP.checkExactNotificationSetting) XP.checkExactNotificationSetting().then(function (s) {
    if (s.exact_alarm === 'granted') {
      if (!store('exactDone') && rems().length) rems().forEach(function (r) { unschedRem(r); schedRem(r); });
      store('exactDone', true); return;
    }
    store('exactDone', false);
    if ($('#exw')) return;
    tb.insertAdjacentHTML('afterbegin', '<div class="warn" id="exw">⏰ 지금은 정해진 시각보다 <b>최대 1시간까지 늦게</b> 울릴 수 있어요. 정확한 시각에 알리려면 \'알람 및 리마인더\'를 허용해 주세요.<br><button class="btn sm" id="exb" style="margin-top:6px">정확한 시각에 알리기</button></div>');
    $('#exb').onclick = function () { XP.changeExactNotificationSetting().then(function () { drawRem(); }).catch(function () {}); };
  }).catch(function () {});
  var pby = $('#pby'); pby.onchange = function () { var p = store('prof') || {}; p.by = +pby.value || null; store('prof', p); drawScr(); };
  tb.querySelectorAll('[data-pg]').forEach(function (b) { b.onclick = function () { var p = store('prof') || {}; p.sex = b.getAttribute('data-pg'); store('prof', p); drawRem(); }; });
  drawScr();
}
function drawScr() {
  var el = $('#scr'); if (!el) return; var p = store('prof') || {};
  if (!p.by || p.by < 1900 || p.by > new Date().getFullYear()) { el.innerHTML = '<div class="empty" style="padding:14px 0">출생연도를 입력하면 해당 검진을 알려 드려요.</div>'; return; }
  (S.scr ? Promise.resolve(S.scr) : jget('screening.json').then(function (d) { S.scr = d; return d; })).then(function (d) {
    var y = new Date().getFullYear(), age = y - p.by;
    var f = d.items.filter(function (x) {
      if (x.sex && p.sex !== x.sex) return false;
      if (x.ages) return x.ages.indexOf(age) >= 0;
      if (x.min && age < x.min) return false; if (x.max && age > x.max) return false;
      if (x.parity && (p.by % 2) !== (y % 2)) return false;
      return true;
    });
    el.innerHTML = '<div class="mu" style="margin:0 2px 8px">만 ' + age + '세 기준 (' + y + '년)' + (p.sex ? '' : ' · 성별을 고르면 더 정확해요') + '</div>' +
      (f.length ? f.map(function (x) { return '<div class="card"><h3>' + esc(x.title) + '</h3><div class="mu" style="margin:4px 0 8px">' + esc(x.desc) + '</div><button class="btn sm sub" data-s="' + x.id + '">알림 추가</button></div>'; }).join('') : '<div class="empty" style="padding:14px 0">올해 해당하는 항목이 없어요.</div>') +
      '<div class="note">' + esc(d.note) + '</div>';
    el.querySelectorAll('[data-s]').forEach(function (b) { b.onclick = function () { var it = d.items.filter(function (x) { return x.id === b.getAttribute('data-s'); })[0]; remSheet('chk', it.title); }; });
  }).catch(function () { el.innerHTML = '<div class="empty">정보를 불러오지 못했어요.</div>'; });
}
function remSheet(kind, preTitle) {
  var today = new Date().toISOString().slice(0, 10);
  var body = kind === 'med'
    ? '<input class="search" id="rt" placeholder="약 이름 (예: 혈압약)" value="' + esc(preTitle || '') + '"><div class="mu" style="margin:4px 2px">먹는 시간</div><input class="search" id="rm" type="time" value="08:00"><div class="mu" style="margin:4px 2px">요일 (선택 안 하면 매일)</div><div class="chips" id="rd">' + WD.map(function (w, i) { return '<button class="chip" data-d="' + (i + 1) + '">' + w + '</button>'; }).join('') + '</div>'
    : '<input class="search" id="rt" placeholder="검진·접종 이름" value="' + esc(preTitle || '') + '"><div class="mu" style="margin:4px 2px">예정 날짜</div><input class="search" id="rdt" type="date" min="' + today + '"><div class="mu" style="margin:4px 2px">알림 시간</div><input class="search" id="rm" type="time" value="09:00"><div class="note" style="margin:0 2px 8px">예정일 3일 전과 당일에 알려 드려요.</div>';
  openSheet(kind === 'med' ? '복약 알림 추가' : '검진·접종 알림 추가', body + '<button class="btn big" id="rsave">저장</button>', function (m) {
    m.querySelectorAll('#rd .chip').forEach(function (c) { c.onclick = function () { c.classList.toggle('on'); }; });
    $('#rsave', m).onclick = function () {
      var t = $('#rt', m).value.trim(); if (!t) return toast('이름을 적어 주세요');
      var r = { id: newRid(), kind: kind, title: t, time: $('#rm', m).value || '09:00' };
      if (kind === 'med') r.days = [].slice.call(m.querySelectorAll('#rd .chip.on')).map(function (c) { return +c.getAttribute('data-d'); });
      else { r.date = $('#rdt', m).value; if (!r.date) return toast('날짜를 골라 주세요'); }
      ensurePerm().then(function (ok) {
        var all = rems(); all.push(r); store('rem', all);
        if (ok) schedRem(r).then(function () { toast('알림을 저장했어요'); }).catch(function () { toast('알림 예약에 실패했어요'); });
        else toast(LNP() ? '기기 설정에서 알림을 허용해 주세요(목록에는 저장했어요)' : '저장했어요(알림은 앱에서만 울려요)');
        m.close(); drawRem();
      });
    };
  });
}

/* ---------- 응급 카드 · 내 위치 알리기 (응급실 탭) ---------- */
function ecardHtml() {
  var e = store('emg');
  var head = '<div class="card"><h3>🆘 내 응급 정보</h3>';
  if (!e) return head + '<div class="mu" style="margin:4px 0 8px">혈액형·알레르기·보호자 번호를 미리 적어 두면 급할 때 바로 보여줄 수 있어요. 이 기기에만 저장돼요.</div><div class="row wrap"><button class="btn sm" id="eEdit">등록하기</button><button class="btn sm sub" id="eLoc">내 위치 알리기</button></div></div>';
  var line = function (k, v) { return v ? '<div style="margin:3px 0"><span class="mu">' + k + '</span> <b>' + esc(v) + '</b></div>' : ''; };
  return head + line('이름', e.name) + line('혈액형', e.blood) + line('알레르기·질환', e.cond) + line('복용 약', e.meds) + line('보호자', (e.gname || '') + (e.gtel ? ' ' + e.gtel : '')) +
    '<div class="row wrap" style="margin-top:8px">' + (e.gtel ? '<a class="btn sm red" href="' + telHref(e.gtel) + '">보호자 전화</a>' : '') + '<button class="btn sm sub" id="eLoc">내 위치 알리기</button><button class="btn sm sub" id="eEdit">수정</button><button class="btn sm sub" id="eDel">삭제</button></div></div>';
}
function bindEcard() {
  var ed = $('#eEdit'), lc = $('#eLoc');
  if (ed) ed.onclick = function () {
    var e = store('emg') || {};
    openSheet('내 응급 정보', '<input class="search" id="en" placeholder="이름" value="' + esc(e.name || '') + '"><input class="search" id="ebl" placeholder="혈액형 (예: A형 Rh+)" value="' + esc(e.blood || '') + '"><input class="search" id="ec" placeholder="알레르기·지병" value="' + esc(e.cond || '') + '"><input class="search" id="em" placeholder="복용 중인 약" value="' + esc(e.meds || '') + '"><input class="search" id="egn" placeholder="보호자 이름" value="' + esc(e.gname || '') + '"><input class="search" id="egt" type="tel" placeholder="보호자 전화번호" value="' + esc(e.gtel || '') + '"><button class="btn big" id="esv">저장</button><div class="note" style="margin-top:8px">이 정보는 서버로 보내지 않고 기기에만 저장돼요.</div>', function (m) {
      $('#esv', m).onclick = function () {
        store('emg', { name: $('#en', m).value.trim(), blood: $('#ebl', m).value.trim(), cond: $('#ec', m).value.trim(), meds: $('#em', m).value.trim(), gname: $('#egn', m).value.trim(), gtel: $('#egt', m).value.trim() });
        m.close(); toast('저장했어요'); if (S.tab === 'er') renderEr();
      };
    });
  };
  if (lc) lc.onclick = function () { locShare(); };
  var dl = $('#eDel');
  if (dl) dl.onclick = function () { askConfirm('내 응급 정보 삭제', '이름·혈액형·알레르기·복용 약·보호자 번호가 이 기기에서 모두 지워져요. 삭제할까요?', '삭제', function () { store('emg', null); toast('삭제했어요'); if (S.tab === 'er') renderEr(); }); };
}
function locShare() {
  toast('위치를 확인하는 중…');
  getPos(true).then(function (pos) {
    if (!pos) return toast('위치를 가져오지 못했어요');
    return nearbyItems('p').then(function (r) {
      var near = r.items && r.items[0]; var e = store('emg') || {};
      var lat = pos.lat.toFixed(5), lon = pos.lon.toFixed(5);
      var land = near ? '근처: ' + near.n + ' (' + near.a + ') 약 ' + fmtDist(near._d) : '';
      var text = '[건강인] 내 위치\n' + (land ? land + '\n' : '') + '좌표: ' + lat + ', ' + lon + '\n지도: https://map.kakao.com/link/map/내위치,' + lat + ',' + lon +
        (e.blood || e.cond ? '\n' + (e.blood ? '혈액형 ' + e.blood + ' ' : '') + (e.cond ? '알레르기·지병 ' + e.cond : '') : '');
      openSheet('내 위치 알리기', '<div class="mu" style="margin-bottom:8px">119에 말할 때 아래 주변 장소와 좌표를 알려 주세요. 위급하면 먼저 119에 전화하세요.</div><div class="card" style="user-select:text"><div style="white-space:pre-line;line-height:1.7;font-size:14px">' + esc(text) + '</div></div><div class="row"><button class="btn" id="lcp" style="flex:1">복사</button><button class="btn sub" id="lsh" style="flex:1">공유</button></div>', function (m) {
        $('#lcp', m).onclick = function () { try { navigator.clipboard.writeText(text).then(function () { toast('복사했어요'); }); } catch (x) { toast('복사하지 못했어요'); } };
        $('#lsh', m).onclick = function () {
          var SH = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
          if (SH) SH.share({ title: '내 위치', text: text, dialogTitle: '위치 공유' }).catch(function () {}); else if (navigator.share) navigator.share({ text: text }).catch(function () {}); else toast('공유를 쓸 수 없어요');
        };
      });
    });
  });
}

/* ---------- 약·건강 (약 정보 / 건강 계산기) ---------- */
function renderTools() {
  var ts = S.tsub || '';
  if (ts) {
    var names = { drug: '약 정보', rem: '복약·검진 알림', calc: '건강 계산기' };
    setTitle(names[ts] || '약·건강', true);
    view.innerHTML = '<div id="tb"></div>';
    if (ts === 'calc') drawCalc(); else if (ts === 'rem') drawRem(); else drawDrug();
    return;
  }
  setTitle('약·건강', false);
  var tiles = [['drug', '💊', '약 정보', '약 이름·증상으로 효능, 사용법, 주의사항 찾기'], ['rem', '⏰', '복약·검진 알림', '약 먹을 시간, 검진·접종 날짜 알려 주기'], ['calc', '🧮', '건강 계산기', '체질량지수, 기초대사량, 출산 예정일']];
  view.innerHTML = '<div class="tiles">' + tiles.map(function (t) {
    return '<button class="tile" data-t="' + t[0] + '"><i>' + t[1] + '</i><span><b>' + t[2] + '</b><small>' + t[3] + '</small></span><em>›</em></button>';
  }).join('') + '</div>' + moreLinks();
  view.querySelectorAll('.tile[data-t]').forEach(function (b) { b.onclick = function () { S.tsub = b.getAttribute('data-t'); stack.push('tools-home'); view.scrollTop = 0; renderTools(); }; });
  bindLinks(view);
}
/* 약 정보: data/drug/index.json = {items:[[id,이름,업체,효능요약]]}, data/drug/{id%40}.json = {id:{e,u,w,a,i,s,d}} (식약처 e약은요) */
function drawDrug() {
  var tb = $('#tb');
  tb.innerHTML = '<input class="search" id="dq" placeholder="약 이름·증상 검색 (예: 타이레놀, 두통)" value="' + esc(S.dq || '') + '"><div id="dl"></div>';
  (S.drugs ? Promise.resolve(S.drugs) : jget('data/drug/index.json').then(function (d) { S.drugs = d; return d; })).then(function (d) {
    var q = $('#dq');
    function draw() {
      S.dq = q.value; var k = q.value.trim().toLowerCase();
      if (!k) { $('#dl').innerHTML = '<div class="empty">약 이름이나 증상을 검색해 보세요.</div>' + drugNote(); return; }
      var f = d.items.filter(function (x) { return (x[1] + ' ' + x[2] + ' ' + x[3]).toLowerCase().indexOf(k) >= 0; }).slice(0, 40);
      $('#dl').innerHTML = (f.length ? f.map(function (x) {
        return '<div class="card" data-d="' + x[0] + '"><h3>' + esc(x[1]) + '</h3><div class="mu">' + esc(x[3]) + '</div><div style="margin-top:6px"><span class="badge">' + esc(x[2]) + '</span></div></div>';
      }).join('') : '<div class="empty">검색 결과가 없어요.</div>') + drugNote();
      view.querySelectorAll('[data-d]').forEach(function (c) { c.onclick = function () { openDrug(c.getAttribute('data-d')); }; });
    }
    q.oninput = draw; draw();
  }).catch(function () { $('#dl').innerHTML = '<div class="empty">약 정보를 준비 중이에요.</div>'; });
}
function drugNote() { return '<div class="note">출처: 식품의약품안전처 의약품개요정보(e약은요). 일반의약품의 주요 정보이며 복용 전 약사·의사와 상담하세요. 이 앱은 의료 조언을 제공하지 않습니다.</div>'; }
/* 약 사진: 불러오면 보여주고, 실패하면 사진 칸을 없앤다 */
window.picOk = function (img) { img.style.display = 'block'; var l = document.getElementById('picLoad'); if (l) l.remove(); };
window.picFail = function (img) { if (img.parentNode) img.parentNode.remove(); };
function openDrug(id) {
  var it = S.drugs.items.filter(function (x) { return String(x[0]) === String(id); })[0]; if (!it) return;
  stack.push(S.tab); setTitle(it[1].replace(/\(.*$/, '').slice(0, 16), true); view.scrollTop = 0;
  view.innerHTML = '<div class="empty">불러오는 중…</div>';
  jget('data/drug/' + (Number(id) % 40) + '.json').then(function (m) {
    var x = m[id] || {};
    function sec(t, v) { return v ? '<h2>' + t + '</h2><div class="card"><div class="body">' + esc(v).split('\n').map(function (l) { return '<p>' + l + '</p>'; }).join('') + '</div></div>' : ''; }
    var pic = x.m && /^https:\/\//.test(x.m) ? '<div class="card" style="text-align:center"><div class="mu" id="picLoad" style="padding:18px 0">사진 불러오는 중…</div><img src="' + esc(x.m) + '" alt="' + esc(it[1]) + ' 사진" style="display:none;max-width:100%;max-height:240px;margin:0 auto;border-radius:10px" onload="picOk(this)" onerror="picFail(this)"><div class="mu" style="margin-top:6px">약 사진 · 식품의약품안전처 의약품안전나라 (실제와 다를 수 있어요)</div></div>' : '';
    view.innerHTML = '<div class="card"><h3>' + esc(it[1]) + '</h3><span class="badge">' + esc(it[2]) + '</span></div>' + pic +
      sec('효능·효과', x.e) + sec('사용법', x.u) + sec('먹기 전 알아둘 것(경고)', x.w) + sec('주의사항', x.a) + sec('함께 먹으면 안 되는 약·음식', x.i) + sec('이상반응(부작용)', x.s) + sec('보관법', x.d) + drugNote();
  }).catch(function () { view.innerHTML = '<div class="empty">상세 정보를 불러오지 못했어요.</div>'; });
}
/* 건강 계산기 (기기 안에서만 계산) */
function numv(id) { var v = parseFloat(($('#' + id) || {}).value); return isFinite(v) ? v : NaN; }
function drawCalc() {
  var today = new Date().toISOString().slice(0, 10);
  $('#tb').innerHTML =
    '<div class="card"><h3>체질량지수(BMI)·적정 체중</h3><div class="row wrap" style="margin:8px 0"><input class="search" id="bh" type="number" inputmode="decimal" placeholder="키 (cm)" style="flex:1;margin:0"><input class="search" id="bw" type="number" inputmode="decimal" placeholder="몸무게 (kg)" style="flex:1;margin:0"></div><button class="btn sm" id="bgo">계산</button><div id="bout" class="note" style="margin-top:8px"></div></div>' +
    '<div class="card"><h3>기초대사량·하루 권장 열량</h3><div class="seg" style="margin:8px 0"><button data-g="m" class="on">남성</button><button data-g="f">여성</button></div><div class="row wrap" style="margin:8px 0"><input class="search" id="ma" type="number" inputmode="numeric" placeholder="나이" style="flex:1 1 30%;margin:0"><input class="search" id="mh" type="number" inputmode="decimal" placeholder="키 (cm)" style="flex:1 1 30%;margin:0"><input class="search" id="mw" type="number" inputmode="decimal" placeholder="몸무게 (kg)" style="flex:1 1 30%;margin:0"></div>' +
    '<select class="search" id="mact"><option value="1.2">활동 거의 없음</option><option value="1.375">가벼운 운동(주 1~3회)</option><option value="1.55">보통 운동(주 3~5회)</option><option value="1.725">활발한 운동(주 6~7회)</option></select><button class="btn sm" id="mgo">계산</button><div id="mout" class="note" style="margin-top:8px"></div></div>' +
    '<div class="card"><h3>출산 예정일·임신 주수</h3><div class="mu" style="margin:6px 0">마지막 생리 시작일을 선택하세요.</div><input class="search" id="pd" type="date" max="' + today + '"><button class="btn sm" id="pgo">계산</button><div id="pout" class="note" style="margin-top:8px"></div></div>' +
    '<div class="note">계산 결과는 일반적인 참고용이며 진단이 아닙니다. 건강 상담은 의료진과 하세요. 입력한 값은 저장되거나 전송되지 않습니다.</div>';
  var g = 'm';
  document.querySelectorAll('[data-g]').forEach(function (b) { b.onclick = function () { g = b.getAttribute('data-g'); document.querySelectorAll('[data-g]').forEach(function (x) { x.classList.toggle('on', x === b); }); }; });
  $('#bgo').onclick = function () {
    var h = numv('bh') / 100, w = numv('bw'); if (!(h > 0.5 && h < 2.5 && w > 10 && w < 400)) return toast('키와 몸무게를 확인해 주세요');
    var b = w / (h * h), c = b < 18.5 ? '저체중' : b < 23 ? '정상' : b < 25 ? '과체중(비만 전 단계)' : b < 30 ? '1단계 비만' : b < 35 ? '2단계 비만' : '3단계 비만';
    $('#bout').innerHTML = 'BMI <b>' + b.toFixed(1) + '</b> · ' + c + '<br>BMI 22 기준 적정 체중 약 <b>' + (22 * h * h).toFixed(1) + 'kg</b><br><span class="mu">대한비만학회 아시아-태평양 기준</span>';
  };
  $('#mgo').onclick = function () {
    var a = numv('ma'), h = numv('mh'), w = numv('mw'); if (!(a > 0 && a < 120 && h > 50 && h < 250 && w > 10 && w < 400)) return toast('나이·키·몸무게를 확인해 주세요');
    var bmr = 10 * w + 6.25 * h - 5 * a + (g === 'm' ? 5 : -161), t = bmr * parseFloat($('#mact').value);
    $('#mout').innerHTML = '기초대사량 약 <b>' + Math.round(bmr) + 'kcal</b><br>하루 권장 열량 약 <b>' + Math.round(t) + 'kcal</b><br><span class="mu">Mifflin-St Jeor 공식 기준 추정치</span>';
  };
  $('#pgo').onclick = function () {
    var v = $('#pd').value; if (!v) return toast('날짜를 선택해 주세요');
    var lmp = new Date(v + 'T00:00:00'), due = new Date(lmp.getTime() + 280 * 864e5), now = new Date(), days = Math.floor((now - lmp) / 864e5);
    if (days < 0 || days > 300) return toast('날짜를 확인해 주세요');
    $('#pout').innerHTML = '출산 예정일 <b>' + due.getFullYear() + '년 ' + (due.getMonth() + 1) + '월 ' + due.getDate() + '일</b><br>현재 임신 <b>' + Math.floor(days / 7) + '주 ' + (days % 7) + '일</b><br><span class="mu">마지막 생리 시작일 + 280일 기준(네겔레 법칙)이며 실제와 다를 수 있어요.</span>';
  };
}

/* ---------- 내 건강 ---------- */
function renderMy() {
  setTitle('즐겨찾기', false);
  var html = '';
  html += S.favs.length ? S.favs.map(card).join('') : '<div class="empty">☆를 눌러 자주 가는 병원·약국을 담아두세요.</div>';
  html += '<div class="note">즐겨찾기는 이 기기에만 저장되며 서버로 전송되지 않습니다.</div>';
  view.innerHTML = html; bindFav(S.favs);
}

/* ---------- 설정 (⚙) ---------- */
var VERSION = '2.0.0', PLAY_URL = 'https://play.google.com/store/apps/details?id=com.imeji.healthin';
function openExt(u) { try { window.open(u, '_blank'); } catch (e) { location.href = u; } }
function openSettings() {
  if (stack.length === 0) stack.push(S.tab);
  setTitle('설정', true); view.scrollTop = 0;
  view.innerHTML = '<div class="sec" style="margin-top:4px">공지·알림</div><div id="posts" class="card"><div class="mu">불러오는 중…</div></div>' +
    (NATIVE ? '<div class="menu" style="margin-top:10px"><button class="m" id="mPush">공지 알림 받기<small>' + (store('push') ? '켜짐' : '꺼짐') + '</small></button></div><div class="note" style="margin-top:6px">새 소식을 푸시 알림으로 받아요. 언제든 끌 수 있어요.</div>' : '') +
    '<div class="sec">내 기기</div><div class="menu">' +
    '<button class="m" id="mNav">길찾기 기본 지도<small>' + (store('nav') === 'ask' ? '매번 선택' : (NAVS.filter(function (x) { return x.k === (store('nav') || 'kakao'); })[0] || {}).n) + '</small></button>' +
    '<button class="m" id="mLoc">저장된 내 위치 지우기<small>' + (S.pos ? '저장됨' : '없음') + '</small></button>' +
    '<button class="m" id="mFav">즐겨찾기 모두 삭제<small>' + S.favs.length + '개</small></button></div>' +
    '<div class="note" style="margin-top:6px">위치와 즐겨찾기는 이 기기에만 저장되며 서버로 전송되지 않습니다.</div>' +
    '<div class="sec">안내</div><div class="warn"><b>의료 안내</b><br>이 앱의 정보는 일반적인 참고용이며 의사의 진단·치료를 대신하지 않습니다. 증상이 있거나 응급 상황이면 의료기관을 방문하거나 119에 연락하세요.</div>' +
    '<div class="card"><h3>데이터 출처</h3><ul class="l"><li>건강보험심사평가원 병원·약국 정보</li><li>국립중앙의료원 전국 응급의료기관 정보</li><li>공공데이터포털(data.go.kr)</li></ul><div class="mu" style="margin-top:6px">각 기관이 공개한 자료를 가공해 제공하며 해당 기관과 무관한 민간 앱입니다.</div></div>' +
    (tabCfg.footnote ? '<div class="note">' + esc(tabCfg.footnote) + '</div>' : '') +
    '<div class="sec">약관·정책</div><div class="menu"><a class="m" href="privacy.html" target="_blank">개인정보처리방침<small>›</small></a><a class="m" href="terms.html" target="_blank">이용약관<small>›</small></a></div>' +
    '<div class="sec">앱</div><div class="menu"><button class="m" id="mShare">친구에게 앱 공유<small>›</small></button><button class="m" id="mRate">앱 평가하기<small>›</small></button><div class="m"><span>버전</span><small>' + VERSION + '</small></div></div>' +
    '<div class="note">건강인 · imeji</div>';
  var mp = $('#mPush');
  if (mp) mp.onclick = function () {
    var FM = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseMessaging;
    if (!FM) return toast('이 기기에서는 알림을 쓸 수 없어요');
    if (store('push')) { FM.unsubscribeFromTopic({ topic: 'notice' }).catch(function () {}); store('push', false); toast('공지 알림을 껐어요'); return openSettings(); }
    FM.requestPermissions().then(function (r) {
      if (r.receive !== 'granted') return toast('기기 설정에서 알림을 허용해 주세요');
      return FM.subscribeToTopic({ topic: 'notice' }).then(function () { store('push', true); toast('공지 알림을 켰어요'); openSettings(); });
    }).catch(function () { toast('알림을 켜지 못했어요'); });
  };
  $('#mNav').onclick = function () {
    openSheet('길찾기 기본 지도', '<div class="menu">' + NAVS.map(function (m) { return '<button class="m" data-nv="' + m.k + '">' + m.n + '<small>' + ((store('nav') || 'kakao') === m.k ? '✓' : '') + '</small></button>'; }).join('') + '<button class="m" data-nv="ask">매번 선택<small>' + (store('nav') === 'ask' ? '✓' : '') + '</small></button></div>', function (m) {
      m.querySelectorAll('[data-nv]').forEach(function (b) { b.onclick = function () { store('nav', b.getAttribute('data-nv')); m.close(); openSettings(); }; });
    });
  };
  $('#mLoc').onclick = function () { S.pos = null; store('pos', null); toast('내 위치를 지웠어요'); openSettings(); };
  $('#mFav').onclick = function () { if (!S.favs.length) return toast('삭제할 즐겨찾기가 없어요'); askConfirm('즐겨찾기 모두 삭제', '저장한 병원·약국 즐겨찾기가 모두 지워져요. 삭제할까요?', '삭제', function () { S.favs = []; store('favs', S.favs); toast('삭제했어요'); openSettings(); }); };
  $('#mShare').onclick = function () {
    var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share, d = { title: '건강인', text: '내 주변 병원·약국·응급실을 찾아주는 건강인', url: PLAY_URL, dialogTitle: '건강인 공유' };
    if (P) P.share(d).catch(function () {}); else if (navigator.share) navigator.share(d).catch(function () {}); else toast(PLAY_URL);
  };
  $('#mRate').onclick = function () { openExt(PLAY_URL); };
  (S.posts ? Promise.resolve(S.posts) : jget('posts.json')).then(function (p) {
    S.posts = p; var el = $('#posts'); if (!el) return;
    el.outerHTML = p.posts.length ? p.posts.map(function (x) {
      var body = esc(x.body || '').split('\n').map(function (l) { return l.indexOf('## ') === 0 ? '<h2>' + l.slice(3) + '</h2>' : l.indexOf('- ') === 0 ? '<div class="mu">• ' + l.slice(2) + '</div>' : l ? '<p>' + l + '</p>' : ''; }).join('');
      return '<div class="card"><span class="badge">' + esc(x.tag || '') + '</span> <span class="mu">' + esc(x.date || '') + '</span><h3 style="margin-top:4px">' + esc(x.title) + '</h3><div class="body">' + body + '</div></div>';
    }).join('') : '<div class="card"><div class="mu">새 공지가 없어요.</div></div>';
  }).catch(function () { var el = $('#posts'); if (el) el.innerHTML = '<div class="mu">공지를 불러오지 못했어요.</div>'; });
}

/* ---------- 라우팅 ---------- */
var R = { hospital: renderHospital, er: renderEr, tools: renderTools, my: renderMy };
function go(tab) {
  S.tab = tab; stack = []; if (tab !== 'tools') S.tsub = '';
  document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); });
  view.scrollTop = 0; R[tab]();
}
document.querySelectorAll('#tabs button').forEach(function (b) { b.onclick = function () { if (b.classList.contains('ins')) return; go(b.getAttribute('data-tab')); }; });
$('#btnSet').onclick = openSettings;
function back() {
  if (!stack.length) return false;
  var t = stack.pop();
  if (t === 'tools-home') { S.tsub = ''; go('tools'); return true; }
  var rest = stack.slice(); go(t); stack = rest; return true;
}

backBtn.onclick = back;
window.addEventListener('popstate', back);
try {
  var A = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (A) A.addListener('backButton', function () { if (back()) return; if (S.tab !== 'hospital') go('hospital'); else A.exitApp(); });
} catch (e) {}

/* 마지막 탭(내보험찾기)은 options.json 으로 앱 업데이트 없이 바꾼다. tab:
     show   false 면 숨김
     label·icon  탭 글자·이모지
     url    연결 주소. https:// · market:// · tel: · mailto: 허용
     open   url 을 여는 방식: "system"(기기 브라우저/스토어/전화앱, 기본) | "inapp"(앱 안 브라우저 창)
     link   앱 안 이동 'app:tab/(hospital|er|tools|my|settings)' (있으면 url 보다 우선) */
var DEFAULT_TAB = { show: true, label: '내보험찾기', icon: '🛡️', url: 'https://play.google.com/store/apps/details?id=com.imeji.muffin', open: 'system' };
var tabCfg = DEFAULT_TAB;
/* 더 알아보기 링크: options.json 의 links[] = {title, desc, url, open}. 앱 안 브라우저로 열고 사용자 정보는 보내지 않는다 */
var linksCfg = [
  { icon: '🎗️', title: '국가암지식센터', desc: '국립암센터가 운영하는 암 정보·검진 안내', url: 'https://www.cancer.go.kr/lay1/program/S1T211C223/cancer/list.do', open: 'inapp' },
  { icon: '🏛️', title: '국가건강정보포털', desc: '질병관리청의 건강·질병 정보', url: 'https://health.kdca.go.kr', open: 'inapp' },
  { icon: '📖', title: '위키백과', desc: '질병 목록으로 찾아보는 백과사전(참고용)', url: 'https://ko.wikipedia.org/wiki/%EC%A7%88%EB%B3%91_%EB%AA%A9%EB%A1%9D', open: 'inapp' }
];
function moreLinks() {
  if (!linksCfg || !linksCfg.length) return '';
  return '<div class="tiles" style="margin-top:10px">' + linksCfg.map(function (l, i) { return '<button class="tile ext" data-lk="' + i + '"><i>' + esc(l.icon || '🔗') + '</i><span><b>' + esc(l.title) + '</b><small>' + esc(l.desc || '') + '</small></span><em>↗</em></button>'; }).join('') + '</div><div class="note">아래 링크 카드는 외부 사이트로 연결돼요. 이동 후에는 해당 사이트의 정책이 적용되며, 건강인은 내 정보를 전달하지 않아요. 정보는 참고용이니 진단·치료는 의료진과 상담하세요.</div>';
}
function bindLinks(root) {
  (root || view).querySelectorAll('[data-lk]').forEach(function (b) { b.onclick = function () { var l = linksCfg[Number(b.getAttribute('data-lk'))]; if (l) openTarget(l); }; });
}
function applyTab(o) {
  var b = $('#tabs .ins'); if (!b || !o || !o.tab) return; var t = tabCfg = Object.assign({}, DEFAULT_TAB, o.tab);
  if (Array.isArray(o.links)) linksCfg = o.links;
  b.hidden = t.show === false;
  b.innerHTML = '<i>' + esc(t.icon) + '</i>' + esc(t.label);
}
function openTarget(t) {
  if (t.link && /^app:tab\/(hospital|er|tools|my|settings)$/.test(t.link)) { var k = t.link.split('/')[1]; return k === 'settings' ? openSettings() : go(k); }
  var u = String(t.url || ''); if (!/^(https:\/\/|market:\/\/|tel:|mailto:)/.test(u)) return toast('열 수 없는 주소예요');
  var Br = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
  if (t.open === 'inapp' && Br && /^https:/.test(u)) return Br.open({ url: u }).catch(function () { openExt(u); });
  if (/^https:/.test(u)) return openExt(u);
  location.href = u;
}
function noticeHtml(n) {
  return (n.lead ? '<p>' + esc(n.lead) + '</p>' : '') + '<ul class="l">' + (n.lines || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' + (n.footer ? '<div class="mu" style="margin-top:8px"><b>' + esc(n.footer) + '</b></div>' : '');
}
function showNotice(t) {
  var n = t.notice, m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = '<div class="sheet"><h3>' + esc(n.title || '안내') + '</h3><div class="sbody">' + noticeHtml(n) + '</div><div class="row" style="margin-top:12px"><button class="btn sub" data-x="0" style="flex:1">취소</button><button class="btn" data-x="1" style="flex:2">' + esc(n.confirm || '확인') + '</button></div></div>';
  m.onclick = function (e) { var x = e.target.getAttribute && e.target.getAttribute('data-x'); if (x === null && e.target !== m) return; m.remove(); if (x === '1') openTarget(t); };
  document.body.appendChild(m);
}
$('#tabs .ins').onclick = function () { if (tabCfg.notice) showNotice(tabCfg); else openTarget(tabCfg); };
applyTab(store('opt'));
jget('options.json').then(function (o) { store('opt', o); applyTab(o); }).catch(function () {});

try {
  var FM0 = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseMessaging;
  if (FM0 && FM0.addListener) FM0.addListener('notificationReceived', function (e) { var n = e && e.notification; if (n && (n.title || n.body)) toast((n.title || '') + (n.body ? ' ' + n.body : '')); });
} catch (e) {}

go('hospital');
})();
