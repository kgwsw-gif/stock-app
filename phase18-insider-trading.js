/* phase18-insider-trading.js — 임원 지분변동 트래커 v0.2.0
 * DART OpenAPI 기반 임원·주요주주 소유변동 조회
 *
 * v0.2.0 개선사항 (2026-07-07):
 *  - 리브랜딩: "임원 장내매수 트래커" → "임원 지분변동 트래커"
 *  - 실거래일 파싱: DART 원문 표지에서 "보고의무발생일" 추출
 *  - 원문 링크: 각 시그널에 📄 DART 원문 열기 버튼
 *  - 노이즈 필터: 정기공시성 클러스터(100명+ 동일접수) 자동 분리
 *  - 100주 미만 소량 매수 필터 옵션
 *  - 강한매수 재정의: 사장급 + 5,000주 + 같은 날 10명 이하
 *  - 메뉴 버튼 주입 안정화 (Phase16 앵커 방식)
 *
 * 알려진 한계: DART OpenAPI는 취득유형(장내매수/스톡옵션/상여)을 구분하지 않음
 * → 사용자가 📄 원문 링크로 직접 확인해야 함
 */
(function(){
  'use strict';

  const VERSION = '0.2.0';
  const MODAL_ID = 'p18-insider-modal';
  const KEY_MODAL_ID = 'p18-apikey-modal';
  const MENU_BTN_ID = 'p18-menu-insider';
  const STORAGE_KEY = 'dart_api_key';

  // ─────────────────────────────────────────────
  // 종목 매핑 (DART 고유번호)
  // ─────────────────────────────────────────────
  const CORP_MAP = {
    '005930': { name: '삼성전자', corp: '00126380' },
    '000660': { name: 'SK하이닉스', corp: '00164779' },
    '005380': { name: '현대차', corp: '00164742' },
    '066570': { name: 'LG전자', corp: '00373220' },
    '035420': { name: 'NAVER', corp: '00266961' },
    '035720': { name: '카카오', corp: '00258801' },
    '000270': { name: '기아', corp: '00190321' },
    '051910': { name: 'LG화학', corp: '00356361' },
    '006400': { name: '삼성SDI', corp: '00126362' },
    '028260': { name: '삼성물산', corp: '00126308' }
  };

  // ─────────────────────────────────────────────
  // CORS 프록시
  // ─────────────────────────────────────────────
  const PROXIES = [
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://thingproxy.freeboard.io/fetch/${u}`
  ];

  async function fetchViaProxy(url, timeoutMs = 8000){
    for(const proxy of PROXIES){
      try{
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const r = await fetch(proxy(url), { signal: ctrl.signal });
        clearTimeout(t);
        if(!r.ok) continue;
        return r;
      }catch(e){ /* 다음 프록시 */ }
    }
    throw new Error('모든 프록시 실패');
  }

  // ─────────────────────────────────────────────
  // DART OpenAPI 호출 (임원 소유상황)
  // ─────────────────────────────────────────────
  async function callAPI(corpCode){
    const apiKey = localStorage.getItem(STORAGE_KEY);
    if(!apiKey) throw new Error('API 키가 설정되지 않았습니다');
    const url = `https://opendart.fss.or.kr/api/elestock.json?crtfc_key=${apiKey}&corp_code=${corpCode}`;
    const r = await fetchViaProxy(url);
    return await r.json();
  }

  // ─────────────────────────────────────────────
  // v0.2.0 신규: 실거래일 파싱 (표지 페이지에서)
  // rcept_no로 DART 표지 페이지를 가져와 "보고의무발생일" 추출
  // 결과 캐싱 (같은 rcept_no 재조회 방지)
  // ─────────────────────────────────────────────
  const realDateCache = new Map();

  async function fetchRealTradeDate(rcept_no){
    if(realDateCache.has(rcept_no)) return realDateCache.get(rcept_no);
    try{
      const mainUrl = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcept_no}`;
      const r = await fetchViaProxy(mainUrl, 5000);
      const html = await r.text();

      // viewDoc 파라미터 추출
      const m = html.match(/viewDoc\(\s*["'](\d+)["']\s*,\s*["'](\d+)["']\s*,\s*["'](\d*)["']\s*,\s*["'](\d+)["']\s*,\s*["'](\d+)["']\s*,\s*["']([^"']+)["']/);
      if(!m){
        realDateCache.set(rcept_no, null);
        return null;
      }
      const [, rcp, dcm, ele, off, len, dtd] = m;
      const viewerUrl = `https://dart.fss.or.kr/report/viewer.do?rcpNo=${rcp}&dcmNo=${dcm}&eleId=${ele||1}&offset=${off}&length=${len}&dtd=${dtd}`;
      const rr = await fetchViaProxy(viewerUrl, 5000);
      const doc = await rr.text();

      // "보고의무발생일 : YYYY년 MM월 DD일" 패턴 추출
      const dateMatch = doc.match(/보고의무발생일\s*[:：]\s*(\d{4})[년\.\-\/\s]+(\d{1,2})[월\.\-\/\s]+(\d{1,2})/);
      if(dateMatch){
        const [, y, mo, d] = dateMatch;
        const isoDate = `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
        realDateCache.set(rcept_no, isoDate);
        return isoDate;
      }
      realDateCache.set(rcept_no, null);
      return null;
    }catch(e){
      realDateCache.set(rcept_no, null);
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // 시그널 분석 v0.2.0
  //  - 강한매수 재정의: 사장급 이상 + 5,000주+ + 같은날 10명 이하 (단독)
  //  - 클러스터: 같은 rcept_dt에 3명 이상, 하지만 100명 이상은 "정기공시성"으로 분리
  //  - 100주 미만 필터 옵션 지원
  // ─────────────────────────────────────────────
  function analyze(list, opts = {}){
    const { hideSmall = true, hidePeriodic = true } = opts;

    const now = Date.now();
    const days = ms => (now - new Date(ms).getTime()) / 86400000;

    // 접수일별 그룹핑
    const byDate = {};
    list.forEach(it => {
      const dt = it.rcept_dt || '';
      if(!byDate[dt]) byDate[dt] = [];
      byDate[dt].push(it);
    });

    // 매수·매도 분리
    const parseQty = s => parseInt(String(s || '0').replace(/,/g, '').replace(/[^\-0-9]/g, '')) || 0;
    const isRegistered = it => (it.isu_exctv_rgist_at || '').includes('등기');
    const isPresidentTier = it => {
      const p = (it.isu_exctv_ofcps || '');
      return p.includes('사장') || p.includes('회장') || p.includes('부회장') || p.includes('대표');
    };

    const buys = [], sells = [];
    list.forEach(it => {
      const qty = parseQty(it.sp_stock_lmp_irds_cnt);
      if(hideSmall && Math.abs(qty) < 100) return;
      if(qty > 0) buys.push({ ...it, _qty: qty });
      else if(qty < 0) sells.push({ ...it, _qty: qty });
    });

    // 최근 30일 매수·매도 카운트
    const recent30Buys = buys.filter(it => days(it.rcept_dt) <= 30);
    const recent30Sells = sells.filter(it => days(it.rcept_dt) <= 30);

    // 강한매수: 사장급+ AND 5,000주+ AND 같은날 10명 이하 (단독성)
    const strong = buys.filter(it => {
      if(!isPresidentTier(it)) return false;
      if(it._qty < 5000) return false;
      if(days(it.rcept_dt) > 90) return false;
      const sameDate = byDate[it.rcept_dt].length;
      if(sameDate > 10) return false; // 정기공시성 제외
      return true;
    });

    // 주목매수: 등기임원 + 1,000주+ + 180일 이내 + 같은날 50명 이하
    const notable = buys.filter(it => {
      if(!isRegistered(it)) return false;
      if(it._qty < 1000) return false;
      if(days(it.rcept_dt) > 180) return false;
      const sameDate = byDate[it.rcept_dt].length;
      if(sameDate > 50) return false;
      return true;
    });

    // 클러스터: 같은날 3명+ 매수
    const clusters = [];
    const periodicClusters = []; // 정기공시성 (100명+)
    Object.entries(byDate).forEach(([dt, items]) => {
      const dayBuys = items.filter(it => parseQty(it.sp_stock_lmp_irds_cnt) > 0);
      if(dayBuys.length < 3) return;
      const total = dayBuys.reduce((s, it) => s + parseQty(it.sp_stock_lmp_irds_cnt), 0);
      const cluster = { date: dt, count: dayBuys.length, total, items: dayBuys };
      if(dayBuys.length >= 100) periodicClusters.push(cluster);
      else clusters.push(cluster);
    });
    clusters.sort((a, b) => b.date.localeCompare(a.date));
    periodicClusters.sort((a, b) => b.date.localeCompare(a.date));

    return {
      total: list.length,
      strong, notable,
      clusters: clusters.slice(0, 10),
      periodicClusters: hidePeriodic ? [] : periodicClusters.slice(0, 5),
      periodicCount: periodicClusters.length,
      recent30Buys: recent30Buys.length,
      recent30Sells: recent30Sells.length
    };
  }

  // ─────────────────────────────────────────────
  // 유틸: DART 원문 URL 생성
  // ─────────────────────────────────────────────
  function dartOriginalUrl(rcept_no){
    return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcept_no}`;
  }

  // ─────────────────────────────────────────────
  // 아이템 렌더링 (원문 링크 포함)
  // ─────────────────────────────────────────────
  function renderItem(it, opts = {}){
    const { showRealDate = false } = opts;
    const qty = parseInt(String(it.sp_stock_lmp_irds_cnt || '0').replace(/,/g, ''));
    const qtySign = qty > 0 ? '+' : '';
    const qtyColor = qty > 0 ? '#10b981' : '#ef4444';
    const name = it.repror || '(이름없음)';
    const pos = it.isu_exctv_ofcps || '';
    const reg = (it.isu_exctv_rgist_at || '').includes('등기') ? '📌' : '';
    const url = dartOriginalUrl(it.rcept_no);
    const realDateSlot = showRealDate ? `<span class="p18-realdate" data-rcept="${it.rcept_no}" style="font-size:10px;color:#94a3b8;margin-left:6px;">⏳</span>` : '';
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #f1f5f9;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;color:#64748b;">
            접수 ${it.rcept_dt} ${realDateSlot}
            <a href="${url}" target="_blank" rel="noopener" title="DART 원문 열기 (취득유형 직접 확인)" style="margin-left:6px;text-decoration:none;color:#3b82f6;">📄</a>
          </div>
          <div style="font-size:13px;margin-top:2px;">
            <b>${name}</b>
            <span style="color:#f59e0b;font-size:11px;margin-left:6px;">${pos}</span>
            <span style="margin-left:4px;">${reg}</span>
          </div>
        </div>
        <div style="font-weight:700;color:${qtyColor};font-size:14px;">${qtySign}${qty.toLocaleString()}주</div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // 결과 렌더링
  // ─────────────────────────────────────────────
  function renderResult(container, corpInfo, result){
    const { strong, notable, clusters, periodicCount, recent30Buys, recent30Sells } = result;

    let html = `
      <div style="background:#f8fafc;border-radius:8px;padding:12px;margin-bottom:12px;">
        <div style="font-size:15px;font-weight:700;">${corpInfo.name} <span style="color:#94a3b8;font-weight:400;">${corpInfo.code}</span></div>
        <div style="font-size:12px;color:#64748b;margin-top:4px;">총 ${result.total.toLocaleString()}건 · 임원 지분변동 시그널 분석</div>
      </div>

      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:11px;color:#92400e;line-height:1.5;">
        ⚠️ <b>데이터 안내</b>: 표시된 날짜는 DART 보고 접수일이며 실제 거래일과 3~5일 차이가 있을 수 있습니다.
        취득유형(장내매수 / 스톡옵션 / 상여 등)은 DART OpenAPI에서 제공되지 않으므로,
        📄 아이콘을 클릭해 DART 원문에서 직접 확인하세요.
      </div>

      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:16px;">
        ${statCard('🔥 강한매수', strong.length, '#ef4444', '사장급≥5,000주·단독')}
        ${statCard('⭐ 주목매수', notable.length, '#f59e0b', '등기≥1,000주·180일')}
        ${statCard('💎 클러스터', clusters.length, '#a855f7', '3~99명 동시매수')}
        ${statCard('📈 30일 매수', recent30Buys, '#10b981', '')}
        ${statCard('📉 30일 매도', recent30Sells, '#ef4444', '')}
      </div>
    `;

    if(periodicCount > 0){
      html += `
        <div style="background:#f1f5f9;border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:11px;color:#475569;">
          ℹ️ 정기공시성 대량 클러스터(100명 이상 동일 접수) ${periodicCount}건은 자동으로 제외되었습니다.
          이는 자사주 상여·성과급 배정일 가능성이 높아 개인의 자발적 매수 시그널과 구분됩니다.
        </div>
      `;
    }

    if(strong.length > 0){
      html += `<div style="font-size:14px;font-weight:700;color:#ef4444;margin:12px 0 6px;">🔥 강한 매수 시그널</div>`;
      html += `<div style="background:#fef2f2;border-radius:6px;overflow:hidden;">`;
      strong.forEach(it => { html += renderItem(it, { showRealDate: true }); });
      html += `</div>`;
    }

    if(notable.length > 0){
      html += `<div style="font-size:14px;font-weight:700;color:#f59e0b;margin:16px 0 6px;">⭐ 주목 매수 (상위 15건)</div>`;
      html += `<div style="background:#fffbeb;border-radius:6px;overflow:hidden;">`;
      notable.slice(0, 15).forEach(it => { html += renderItem(it, { showRealDate: true }); });
      html += `</div>`;
      if(notable.length > 15){
        html += `<div style="font-size:11px;color:#94a3b8;padding:6px 10px;">... 외 ${notable.length - 15}건</div>`;
      }
    }

    if(clusters.length > 0){
      html += `<div style="font-size:14px;font-weight:700;color:#a855f7;margin:16px 0 6px;">💎 클러스터 매수 (3~99명 동시)</div>`;
      clusters.slice(0, 3).forEach(c => {
        html += `<div style="background:#faf5ff;border-radius:6px;overflow:hidden;margin-bottom:8px;">
          <div style="background:#e9d5ff;padding:6px 10px;font-size:12px;font-weight:600;color:#6b21a8;">
            📅 ${c.date} · ${c.count.toLocaleString()}명 · 총 +${c.total.toLocaleString()}주
          </div>`;
        c.items.slice(0, 8).forEach(it => { html += renderItem(it); });
        if(c.items.length > 8){
          html += `<div style="font-size:11px;color:#94a3b8;padding:6px 10px;">... 외 ${c.items.length - 8}건</div>`;
        }
        html += `</div>`;
      });
    }

    if(strong.length === 0 && notable.length === 0 && clusters.length === 0){
      html += `
        <div style="text-align:center;padding:40px 20px;color:#94a3b8;">
          <div style="font-size:32px;">🔍</div>
          <div style="margin-top:8px;font-size:13px;">해당 종목에서 유의미한 임원 매수 시그널이 감지되지 않았습니다.</div>
        </div>
      `;
    }

    container.innerHTML = html;

    // 실거래일 비동기 로드 (시그널 항목만)
    const slots = container.querySelectorAll('.p18-realdate');
    slots.forEach(async slot => {
      const rcept = slot.dataset.rcept;
      const realDate = await fetchRealTradeDate(rcept);
      if(realDate) slot.innerHTML = `→ 실거래 ${realDate}`;
      else slot.innerHTML = '';
    });
  }

  function statCard(label, val, color, sub){
    return `
      <div style="background:white;border:1px solid #e2e8f0;border-left:3px solid ${color};border-radius:6px;padding:8px;">
        <div style="font-size:11px;color:#64748b;">${label}</div>
        <div style="font-size:20px;font-weight:800;color:${color};margin-top:2px;">${val.toLocaleString()}</div>
        ${sub ? `<div style="font-size:9px;color:#94a3b8;margin-top:2px;">${sub}</div>` : ''}
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // 메인 모달 UI
  // ─────────────────────────────────────────────
  function openModal(){
    let modal = document.getElementById(MODAL_ID);
    if(modal){ modal.style.display = 'flex'; return; }

    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100000;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow-y:auto;';

    const options = Object.entries(CORP_MAP).map(([code, info]) =>
      `<option value="${code}">${info.name} (${code})</option>`).join('');

    modal.innerHTML = `
      <div style="background:white;border-radius:12px;max-width:720px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <div style="padding:14px 16px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:8px;">
          <div style="font-size:16px;font-weight:700;">📊 임원 지분변동 트래커</div>
          <div style="font-size:11px;color:#94a3b8;">v${VERSION}</div>
          <div style="flex:1;"></div>
          <button id="p18-key-btn" title="DART API 키 설정" style="background:none;border:none;font-size:16px;cursor:pointer;">🔑</button>
          <button id="p18-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8;">×</button>
        </div>
        <div style="padding:14px 16px;">
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:14px;">
            <select id="p18-corp-select" style="flex:1;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;">
              ${options}
            </select>
            <input id="p18-corp-code" placeholder="또는 종목코드 직접입력" style="width:180px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;"/>
            <button id="p18-search" style="background:#3b82f6;color:white;border:none;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer;">🔍 조회</button>
          </div>
          <div id="p18-result"></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('#p18-close').onclick = () => modal.style.display = 'none';
    modal.querySelector('#p18-key-btn').onclick = openKeyModal;
    modal.querySelector('#p18-search').onclick = doSearch;
    modal.addEventListener('click', e => { if(e.target === modal) modal.style.display = 'none'; });
  }

  async function doSearch(){
    const container = document.getElementById('p18-result');
    if(!localStorage.getItem(STORAGE_KEY)){
      container.innerHTML = '<div style="padding:20px;text-align:center;color:#ef4444;">먼저 우측 상단 🔑 버튼으로 DART API 키를 설정하세요.</div>';
      return;
    }

    const direct = document.getElementById('p18-corp-code').value.trim();
    const selected = document.getElementById('p18-corp-select').value;
    const code = direct || selected;
    const info = CORP_MAP[code];

    if(!info){
      container.innerHTML = '<div style="padding:20px;text-align:center;color:#ef4444;">지원하지 않는 종목코드입니다. 드롭다운에서 선택해주세요.</div>';
      return;
    }

    container.innerHTML = `<div style="padding:20px;text-align:center;color:#64748b;">🔄 DART 조회 중...</div>`;

    try{
      const data = await callAPI(info.corp);
      if(data.status !== '000'){
        container.innerHTML = `<div style="padding:20px;text-align:center;color:#ef4444;">DART 오류: ${data.status} - ${data.message}</div>`;
        return;
      }
      const result = analyze(data.list || []);
      renderResult(container, { name: info.name, code }, result);
    }catch(e){
      container.innerHTML = `<div style="padding:20px;text-align:center;color:#ef4444;">조회 실패: ${e.message}</div>`;
    }
  }

  // ─────────────────────────────────────────────
  // API 키 설정 모달
  // ─────────────────────────────────────────────
  function openKeyModal(){
    let m = document.getElementById(KEY_MODAL_ID);
    if(m){ m.style.display = 'flex'; refreshKeyDisplay(); return; }

    m = document.createElement('div');
    m.id = KEY_MODAL_ID;
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100001;display:flex;align-items:center;justify-content:center;padding:20px;';
    m.innerHTML = `
      <div style="background:white;border-radius:12px;max-width:440px;width:100%;padding:16px;">
        <div style="display:flex;align-items:center;margin-bottom:12px;">
          <div style="font-size:15px;font-weight:700;">🔑 DART API 키 설정</div>
          <div style="flex:1;"></div>
          <button id="p18-key-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8;">×</button>
        </div>
        <div style="background:#f0f9ff;border-radius:6px;padding:10px;font-size:12px;color:#0369a1;line-height:1.6;margin-bottom:12px;">
          📝 <b>발급 방법</b><br>
          1. <a href="https://opendart.fss.or.kr" target="_blank" rel="noopener" style="color:#0284c7;">opendart.fss.or.kr</a> 접속<br>
          2. 회원가입 → 인증키 신청<br>
          3. 40자리 키 발급 (즉시)<br>
          💡 키는 브라우저 localStorage에 저장되며, 외부로 전송되지 않습니다.
        </div>
        <div style="font-size:12px;color:#64748b;margin-bottom:4px;">현재 키: <span id="p18-cur-key">(미설정)</span></div>
        <input id="p18-key-input" placeholder="40자리 인증키 입력" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;box-sizing:border-box;"/>
        <div style="display:flex;gap:6px;margin-top:10px;">
          <button id="p18-key-save" style="flex:1;background:#3b82f6;color:white;border:none;border-radius:6px;padding:9px;font-weight:600;cursor:pointer;">💾 저장</button>
          <button id="p18-key-del" style="background:#ef4444;color:white;border:none;border-radius:6px;padding:9px 14px;font-weight:600;cursor:pointer;">🗑️ 삭제</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);

    m.querySelector('#p18-key-close').onclick = () => m.style.display = 'none';
    m.addEventListener('click', e => { if(e.target === m) m.style.display = 'none'; });
    m.querySelector('#p18-key-save').onclick = () => {
      const v = m.querySelector('#p18-key-input').value.trim();
      if(v.length !== 40){ alert('40자리 키를 정확히 입력하세요'); return; }
      localStorage.setItem(STORAGE_KEY, v);
      refreshKeyDisplay();
      alert('✅ 저장 완료');
    };
    m.querySelector('#p18-key-del').onclick = () => {
      if(!confirm('저장된 키를 삭제하시겠습니까?')) return;
      localStorage.removeItem(STORAGE_KEY);
      refreshKeyDisplay();
    };
    refreshKeyDisplay();
  }

  function refreshKeyDisplay(){
    const el = document.getElementById('p18-cur-key');
    if(!el) return;
    const k = localStorage.getItem(STORAGE_KEY);
    el.textContent = k ? `${k.substring(0, 10)}... (${k.length}자)` : '(미설정)';
  }

  // ─────────────────────────────────────────────
  // 메뉴 버튼 주입 (Phase16 앵커 방식 - 안정화)
  // ─────────────────────────────────────────────
  function injectMenuButton(){
    if(document.getElementById(MENU_BTN_ID)) return true;

    // Phase16의 기존 버튼을 앵커로 삼아 부모 그리드 발견
    const anchors = ['p16-menu-stats', 'p16-menu-channels', 'p16-menu-info-note', 'p17-menu-draft'];
    let grid = null;
    for(const id of anchors){
      const el = document.getElementById(id);
      if(el && el.parentElement){ grid = el.parentElement; break; }
    }
    if(!grid) return false;

    const btn = document.createElement('button');
    btn.id = MENU_BTN_ID;
    btn.type = 'button';
    btn.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:12px 8px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:white;border:none;border-radius:10px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(59,130,246,0.3);';
    btn.innerHTML = '<span style="font-size:20px;">📊</span><span>지분변동</span>';
    btn.onclick = openModal;
    grid.appendChild(btn);
    console.log(`[Phase18] 메뉴 버튼 주입 완료 (앵커: ${grid.id || 'unnamed grid'})`);
    return true;
  }

  // Phase16 준비 대기 (최대 30초)
  function scheduleMenuInjection(){
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if(injectMenuButton() || tries > 60){ clearInterval(iv); }
    }, 500);
  }

  // ─────────────────────────────────────────────
  // 초기화
  // ─────────────────────────────────────────────
  window.p18OpenInsiderModal = openModal;
  window.p18OpenKeyModal = openKeyModal;

  window.__phase18Insider = {
    version: VERSION,
    open: openModal,
    openKey: openKeyModal,
    callAPI,
    analyze,
    fetchRealTradeDate,
    corpMap: CORP_MAP,
    injectMenuButton
  };

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', scheduleMenuInjection);
  } else {
    scheduleMenuInjection();
  }

  console.log(`[Phase18] 임원 지분변동 트래커 v${VERSION} 로드 완료`);
})();
