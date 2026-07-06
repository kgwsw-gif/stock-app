/* phase18-insider-trading.js — 임원 장내매수 트래커 v0.1.0
 * DART OpenAPI 기반 임원·주요주주 소유보고 조회
 * 시그널 분석: 강한매수/주목매수/클러스터매수/일반
 */
(function(){
  'use strict';
  const VERSION = '0.1.0';
  const MODAL_ID = 'p18-insider-modal';
  const KEY_MODAL_ID = 'p18-apikey-modal';
  const MENU_BTN_ID = 'p18-menu-insider';
  const LS_KEY = 'p18_dart_apikey';

  // ===== 종목코드 ↔ DART 고유번호 매핑 (주요 종목 30개) =====
  const CORP_MAP = {
    '005930': { name: '삼성전자',        dart: '00126380' },
    '000660': { name: 'SK하이닉스',      dart: '00164779' },
    '373220': { name: 'LG에너지솔루션',  dart: '01515323' },
    '207940': { name: '삼성바이오로직스', dart: '00877059' },
    '005380': { name: '현대차',          dart: '00164742' },
    '000270': { name: '기아',            dart: '00256598' },
    '068270': { name: '셀트리온',        dart: '00421045' },
    '035420': { name: 'NAVER',           dart: '00266961' },
    '035720': { name: '카카오',          dart: '00918444' },
    '005490': { name: '포스코홀딩스',    dart: '00434003' },
    '051910': { name: 'LG화학',          dart: '00356361' },
    '006400': { name: '삼성SDI',         dart: '00126186' },
    '105560': { name: 'KB금융',          dart: '00688996' },
    '055550': { name: '신한지주',        dart: '00382199' },
    '086790': { name: '하나금융지주',    dart: '00547583' },
    '316140': { name: '우리금융지주',    dart: '01133217' },
    '066570': { name: 'LG전자',          dart: '00401731' },
    '011200': { name: 'HMM',             dart: '00164788' },
    '096770': { name: 'SK이노베이션',    dart: '00631518' },
    '034020': { name: '두산에너빌리티',  dart: '00159102' },
    '079550': { name: 'LIG넥스원',       dart: '00860332' },
    '042700': { name: '한미반도체',      dart: '00266961' },
    '295310': { name: '에이치브이엠',    dart: '01615016' },
    '015760': { name: '한국전력',        dart: '00159193' },
    '017670': { name: 'SK텔레콤',        dart: '00159168' },
    '030200': { name: 'KT',              dart: '00434456' },
    '032830': { name: '삼성생명',        dart: '00126380' },
    '028260': { name: '삼성물산',        dart: '00149655' },
    '009150': { name: '삼성전기',        dart: '00126186' },
    '028050': { name: '삼성엔지니어링',  dart: '00164776' },
  };

  // ===== 유틸리티 =====
  const parseNum = (v) => {
    if(v === null || v === undefined || v === '' || v === '-') return 0;
    const n = Number(String(v).replace(/[,\s]/g, ''));
    return isNaN(n) ? 0 : n;
  };
  const daysAgo = (d) => new Date(Date.now() - d * 86400000);
  const fmtNum = (n) => n.toLocaleString();

  // ===== API 키 관리 =====
  function getApiKey(){
    return localStorage.getItem(LS_KEY) || '';
  }
  function saveApiKey(key){
    if(!key || key.length !== 40){
      throw new Error('DART API 키는 40자리여야 합니다.');
    }
    localStorage.setItem(LS_KEY, key);
  }
  function clearApiKey(){
    localStorage.removeItem(LS_KEY);
  }

  // ===== DART API 호출 (CORS 프록시 우회) =====
  async function callDartAPI(corpCode){
    const apiKey = getApiKey();
    if(!apiKey) throw new Error('API_KEY_MISSING');

    const originalUrl = `https://opendart.fss.or.kr/api/elestock.json?crtfc_key=${apiKey}&corp_code=${corpCode}`;
    const proxies = [
      (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
      (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    ];

    let lastError = null;
    for(const buildProxy of proxies){
      try {
        const res = await fetch(buildProxy(originalUrl));
        if(!res.ok){ lastError = `HTTP ${res.status}`; continue; }
        const text = await res.text();
        const data = JSON.parse(text);
        return data;
      } catch(e){
        lastError = e.message;
      }
    }
    throw new Error('프록시 실패: ' + lastError);
  }

  // ===== 시그널 분석 =====
  function analyzeSignals(rawList){
    const items = rawList.map(x => ({
      raw: x,
      date: new Date(x.rcept_dt),
      name: x.repror || '',
      position: x.isu_exctv_ofcps || '',
      isRegistered: (x.isu_exctv_rgist_at || '').includes('등기'),
      change: parseNum(x.sp_stock_lmp_irds_cnt),
      own: parseNum(x.sp_stock_lmp_cnt),
      ratio: parseFloat(x.sp_stock_lmp_rate) || 0,
    })).sort((a,b) => b.date - a.date);

    const now90 = daysAgo(90);
    const now180 = daysAgo(180);
    const now30 = daysAgo(30);

    // 클러스터 매수 감지 (같은 주에 3명 이상)
    const clusters = {};
    items.forEach(x => {
      if(x.change <= 0) return;
      const weekKey = getWeekKey(x.date);
      if(!clusters[weekKey]) clusters[weekKey] = [];
      clusters[weekKey].push(x);
    });
    const clusterWeeks = Object.entries(clusters)
      .filter(([w, arr]) => arr.length >= 3)
      .map(([w, arr]) => ({ week: w, count: arr.length, totalShares: arr.reduce((s,x) => s+x.change, 0), items: arr }))
      .sort((a,b) => b.totalShares - a.totalShares);

    return {
      total: items.length,
      strong: items.filter(x => x.isRegistered && x.change >= 5000 && x.date >= now90),
      notable: items.filter(x => x.isRegistered && x.change >= 1000 && x.date >= now180),
      recent30Buys: items.filter(x => x.change > 0 && x.date >= now30),
      recent30Sells: items.filter(x => x.change < 0 && x.date >= now30),
      clusters: clusterWeeks.slice(0, 5),
      topBuys: items.filter(x => x.change > 0).sort((a,b) => b.change - a.change).slice(0, 10),
      allItems: items,
    };
  }
  function getWeekKey(date){
    const d = new Date(date);
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    return monday.toISOString().split('T')[0];
  }

  // ===== API 키 입력 모달 =====
  function openApiKeyModal(){
    const existing = document.getElementById(KEY_MODAL_ID);
    if(existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = KEY_MODAL_ID;
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;display:flex;align-items:center;justify-content:center;padding:12px;';

    const currentKey = getApiKey();
    const masked = currentKey ? currentKey.slice(0, 6) + '...' + currentKey.slice(-4) : '(미설정)';

    overlay.innerHTML = `
      <div style="background:white;border-radius:16px;max-width:500px;width:100%;padding:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h2 style="margin:0;font-size:17px;font-weight:700;">🔑 DART API 키 설정</h2>
          <button id="p18-key-close" style="background:#f3f4f6;border:none;border-radius:8px;width:30px;height:30px;font-size:16px;cursor:pointer;">×</button>
        </div>
        <div style="background:#f9fafb;padding:12px;border-radius:8px;font-size:12px;color:#4b5563;margin-bottom:16px;line-height:1.6;">
          <div style="font-weight:700;margin-bottom:4px;">📝 발급 방법</div>
          1. <a href="https://opendart.fss.or.kr" target="_blank" style="color:#3b82f6;">opendart.fss.or.kr</a> 접속<br>
          2. 회원가입 → 인증키 신청<br>
          3. 40자리 키 발급 (즉시)<br>
          <div style="margin-top:8px;color:#6b7280;">💡 키는 브라우저 localStorage에 저장되며, 외부로 전송되지 않습니다.</div>
        </div>
        <div style="font-size:12px;color:#6b7280;margin-bottom:6px;">현재 키: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${masked}</code></div>
        <input id="p18-key-input" type="password" placeholder="40자리 인증키 입력" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;font-family:monospace;margin-bottom:12px;">
        <div style="display:flex;gap:8px;">
          <button id="p18-key-save" style="flex:1;padding:10px;background:#3b82f6;color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer;">💾 저장</button>
          <button id="p18-key-clear" style="padding:10px 16px;background:#ef4444;color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer;">🗑️ 삭제</button>
        </div>
        <div id="p18-key-msg" style="font-size:12px;text-align:center;margin-top:8px;color:#6b7280;"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const msg = (t, c) => { overlay.querySelector('#p18-key-msg').textContent = t; overlay.querySelector('#p18-key-msg').style.color = c || '#6b7280'; };
    overlay.querySelector('#p18-key-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.remove(); });
    overlay.querySelector('#p18-key-save').addEventListener('click', () => {
      const k = overlay.querySelector('#p18-key-input').value.trim();
      try { saveApiKey(k); msg('✅ 저장 완료!', '#059669'); setTimeout(() => overlay.remove(), 800); }
      catch(e){ msg('❌ ' + e.message, '#dc2626'); }
    });
    overlay.querySelector('#p18-key-clear').addEventListener('click', () => {
      if(confirm('저장된 API 키를 삭제하시겠습니까?')){
        clearApiKey();
        msg('🗑️ 삭제됨', '#dc2626');
        setTimeout(() => overlay.remove(), 800);
      }
    });
  }

  // ===== 임원 매수 조회 모달 =====
  function openInsiderModal(){
    if(!getApiKey()){
      alert('먼저 DART API 키를 설정해주세요.');
      openApiKeyModal();
      return;
    }
    const existing = document.getElementById(MODAL_ID);
    if(existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:12px;';

    const stockOptions = Object.entries(CORP_MAP)
      .map(([code, info]) => `<option value="${code}">${info.name} (${code})</option>`)
      .join('');

    overlay.innerHTML = `
      <div style="background:white;border-radius:16px;max-width:900px;width:100%;max-height:92vh;overflow-y:auto;">
        <div style="padding:16px 20px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:white;z-index:1;">
          <h2 style="margin:0;font-size:18px;font-weight:700;">👔 임원 장내매수 트래커 <span style="font-size:11px;color:#9ca3af;font-weight:400;">v${VERSION}</span></h2>
          <div style="display:flex;gap:8px;">
            <button id="p18-open-key" title="API 키 설정" style="background:#f3f4f6;border:none;border-radius:8px;width:32px;height:32px;font-size:14px;cursor:pointer;">🔑</button>
            <button id="p18-close" style="background:#f3f4f6;border:none;border-radius:8px;width:32px;height:32px;font-size:18px;cursor:pointer;">×</button>
          </div>
        </div>
        <div style="padding:20px;">
          <div style="display:flex;gap:8px;margin-bottom:16px;">
            <select id="p18-stock-select" style="flex:1;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;">
              <option value="">-- 종목 선택 --</option>
              ${stockOptions}
            </select>
            <input id="p18-custom-code" placeholder="또는 종목코드 직접입력" style="width:180px;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;">
            <button id="p18-query" style="padding:10px 20px;background:#3b82f6;color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer;">🔍 조회</button>
          </div>
          <div id="p18-result" style="min-height:200px;">
            <div style="text-align:center;padding:40px;color:#9ca3af;font-size:14px;">종목을 선택하고 조회 버튼을 눌러주세요.</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#p18-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.remove(); });
    overlay.querySelector('#p18-open-key').addEventListener('click', openApiKeyModal);

    overlay.querySelector('#p18-query').addEventListener('click', async () => {
      const selectVal = overlay.querySelector('#p18-stock-select').value;
      const customVal = overlay.querySelector('#p18-custom-code').value.trim();
      const stockCode = customVal || selectVal;
      if(!stockCode){ alert('종목을 선택하거나 종목코드를 입력하세요.'); return; }

      let corpCode = CORP_MAP[stockCode]?.dart;
      let stockName = CORP_MAP[stockCode]?.name || stockCode;
      if(!corpCode){
        alert(`종목코드 ${stockCode}의 DART 매핑이 없습니다. 지원 종목: 삼성전자, SK하이닉스 등 30개.`);
        return;
      }

      const resultEl = overlay.querySelector('#p18-result');
      resultEl.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280;">⏳ DART API 조회 중...</div>';

      try {
        const data = await callDartAPI(corpCode);
        if(data.status === '013'){
          resultEl.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280;">ℹ️ 조회된 임원 매매 내역이 없습니다.</div>';
          return;
        }
        if(data.status !== '000'){
          resultEl.innerHTML = `<div style="text-align:center;padding:40px;color:#dc2626;">❌ API 오류: ${data.status} - ${data.message}</div>`;
          return;
        }
        const signals = analyzeSignals(data.list);
        renderSignals(resultEl, stockName, stockCode, signals);
      } catch(e){
        resultEl.innerHTML = `<div style="text-align:center;padding:40px;color:#dc2626;">❌ ${e.message}</div>`;
      }
    });
  }

  // ===== 시그널 렌더링 =====
  function renderSignals(container, stockName, stockCode, s){
    const summaryCard = (label, count, color, subtext) => `
      <div style="flex:1;min-width:140px;background:${color}15;border-left:4px solid ${color};padding:12px;border-radius:8px;">
        <div style="font-size:11px;color:#6b7280;font-weight:600;">${label}</div>
        <div style="font-size:22px;font-weight:800;color:${color};margin-top:2px;">${count}</div>
        <div style="font-size:10px;color:#9ca3af;margin-top:2px;">${subtext || ''}</div>
      </div>`;

    const itemRow = (x) => {
      const posColor = x.isRegistered ? '#dc2626' : '#6b7280';
      const chgColor = x.change > 0 ? '#059669' : (x.change < 0 ? '#dc2626' : '#6b7280');
      const chgSign = x.change > 0 ? '+' : '';
      return `
        <div style="padding:8px 12px;border-bottom:1px solid #f3f4f6;display:flex;justify-content:space-between;align-items:center;font-size:13px;">
          <div style="flex:1;">
            <span style="color:#6b7280;font-size:11px;">${x.raw.rcept_dt}</span>
            <span style="margin-left:8px;font-weight:600;">${x.name}</span>
            <span style="margin-left:6px;color:${posColor};font-size:11px;">${x.position}${x.isRegistered ? ' 📌' : ''}</span>
          </div>
          <div style="color:${chgColor};font-weight:700;">${chgSign}${fmtNum(x.change)}주</div>
        </div>`;
    };

    let html = `
      <div style="margin-bottom:16px;padding:12px;background:#eff6ff;border-radius:10px;">
        <div style="font-size:16px;font-weight:800;">${stockName} <span style="color:#6b7280;font-size:12px;font-weight:400;">${stockCode}</span></div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px;">총 ${s.total}건 · 등기임원 매수 시그널 분석</div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
        ${summaryCard('🔥 강한매수', s.strong.length, '#dc2626', '등기≥5,000주·90일')}
        ${summaryCard('⭐ 주목매수', s.notable.length, '#f59e0b', '등기≥1,000주·180일')}
        ${summaryCard('💎 클러스터', s.clusters.length, '#8b5cf6', '주간 3명↑ 동시매수')}
        ${summaryCard('📈 최근30일 매수', s.recent30Buys.length, '#059669')}
        ${summaryCard('📉 최근30일 매도', s.recent30Sells.length, '#6b7280')}
      </div>`;

    if(s.strong.length > 0){
      html += `<div style="margin-bottom:16px;"><div style="font-weight:700;font-size:13px;margin-bottom:6px;color:#dc2626;">🔥 강한 매수 시그널</div><div style="background:#fef2f2;border-radius:8px;overflow:hidden;">${s.strong.map(itemRow).join('')}</div></div>`;
    }

    if(s.clusters.length > 0){
      html += `<div style="margin-bottom:16px;"><div style="font-weight:700;font-size:13px;margin-bottom:6px;color:#8b5cf6;">💎 클러스터 매수 (같은 주 3명 이상 동시 매수)</div>`;
      s.clusters.slice(0, 3).forEach(c => {
        html += `<div style="background:#faf5ff;border-radius:8px;padding:10px;margin-bottom:6px;">
          <div style="font-size:12px;color:#6b21a8;font-weight:700;margin-bottom:4px;">📅 ${c.week} 주간 · ${c.count}명 · 총 +${fmtNum(c.totalShares)}주</div>
          ${c.items.map(itemRow).join('')}
        </div>`;
      });
      html += `</div>`;
    }

    if(s.topBuys.length > 0){
      html += `<div style="margin-bottom:16px;"><div style="font-weight:700;font-size:13px;margin-bottom:6px;">🏆 역대 매수 TOP 10</div><div style="background:#f9fafb;border-radius:8px;overflow:hidden;">${s.topBuys.map(itemRow).join('')}</div></div>`;
    }

    if(s.recent30Buys.length > 0 || s.recent30Sells.length > 0){
      html += `<div><div style="font-weight:700;font-size:13px;margin-bottom:6px;">📅 최근 30일 활동</div>
        <div style="display:flex;gap:12px;">
          <div style="flex:1;background:#f0fdf4;border-radius:8px;padding:10px;">
            <div style="font-size:11px;color:#059669;font-weight:700;margin-bottom:6px;">매수 ${s.recent30Buys.length}건</div>
            ${s.recent30Buys.slice(0, 8).map(itemRow).join('') || '<div style="color:#9ca3af;font-size:12px;text-align:center;padding:8px;">없음</div>'}
          </div>
          <div style="flex:1;background:#fef2f2;border-radius:8px;padding:10px;">
            <div style="font-size:11px;color:#dc2626;font-weight:700;margin-bottom:6px;">매도 ${s.recent30Sells.length}건</div>
            ${s.recent30Sells.slice(0, 8).map(itemRow).join('') || '<div style="color:#9ca3af;font-size:12px;text-align:center;padding:8px;">없음</div>'}
          </div>
        </div>
      </div>`;
    }

    container.innerHTML = html;
  }

  // ===== 메뉴 버튼 주입 =====
  function injectMenuButton(){
    if(document.getElementById(MENU_BTN_ID)) return true;
    const anchor = document.getElementById('p16-menu-stats') || document.getElementById('p16-menu-channels');
    if(!anchor) return false;
    const menuGrid = anchor.parentElement;
    if(!menuGrid) return false;

    const btn = anchor.cloneNode(false);
    btn.id = MENU_BTN_ID;
    btn.dataset.fn = 'p18OpenInsiderModal';
    btn.removeAttribute('onclick');
    btn.textContent = '';
    btn.innerHTML = '👔<br><span style="font-size:12px;">임원매수</span>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openInsiderModal();
    }, true);
    menuGrid.appendChild(btn);
    console.log('[Phase18] 메뉴 버튼 주입 완료');
    return true;
  }

  setInterval(() => {
    if(document.getElementById('p16-menu-stats')) injectMenuButton();
  }, 1200);

  // ===== 전역 노출 =====
  window.p18OpenInsiderModal = openInsiderModal;
  window.p18OpenApiKeyModal = openApiKeyModal;
  window.__phase18Insider = {
    version: VERSION,
    open: openInsiderModal,
    openKey: openApiKeyModal,
    callAPI: callDartAPI,
    analyze: analyzeSignals,
    corpMap: CORP_MAP,
  };

  console.log(`[Phase18] Insider Trading Tracker v${VERSION} 로드 완료.`);
})();
