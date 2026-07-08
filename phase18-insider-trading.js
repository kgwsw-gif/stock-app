/* phase18-insider-trading.js — 임원 장내매수 정밀 트래커 v0.3.0
 * 
 * v0.3.0 개선사항 (2026-07-09):
 *  - 리브랜딩: "임원 지분변동 트래커" → "임원 장내매수 정밀 트래커"
 *  - DART 정정공시 상세 파싱: 보고사유(취득유형)·변동일·매수단가 추출
 *  - 취득유형 배지: 🟢장내매수 / ⚪자사주상여금 / 🔵신규선임 / ⚫유형미상
 *  - 노이즈 별도 섹션: 자사주상여금 카드는 별도 접힘 섹션으로 분리
 *  - 명시적 파싱 상태 표시: 로딩중 / 실패 시 회색 처리
 *  - 실거래일 파싱 유지 (v0.2.1): 보고의무발생일 우선, 정정공시는 변동일 사용
 */
(function(){
  'use strict';
  const VERSION = '0.3.3';
  
  const CORP_MAP = {
    '005930': {code: '00126380', name: '삼성전자'},
    '000660': {code: '00164779', name: 'SK하이닉스'},
    '005380': {code: '00164742', name: '현대차'},
    '005490': {code: '00155319', name: 'POSCO홀딩스'},
    '035420': {code: '00266961', name: 'NAVER'},
    '035720': {code: '00258801', name: '카카오'},
    '051910': {code: '00356361', name: 'LG화학'},
    '006400': {code: '00126362', name: '삼성SDI'},
    '028260': {code: '00149655', name: '삼성물산'},
    '105560': {code: '00149655', name: 'KB금융'}
  };

  const realDateCache = new Map();
  const parseDetailCache = new Map();

  function getApiKey(){
    return localStorage.getItem('dart_api_key') || localStorage.getItem('DART_API_KEY') || '';
  }

  async function fetchViaProxy(url, timeoutMs){
    const ctrl = new AbortController();
    const t = setTimeout(function(){ ctrl.abort(); }, timeoutMs || 8000);
    try {
      const proxied = 'https://corsproxy.io/?' + encodeURIComponent(url);
      const res = await fetch(proxied, {signal: ctrl.signal});
      clearTimeout(t);
      return res;
    } catch(e){
      clearTimeout(t);
      throw e;
    }
  }

  async function fetchDartText(rcpNo){
    const mainUrl = 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + rcpNo;
    const r = await fetchViaProxy(mainUrl, 8000);
    const html = await r.text();
    const m = html.match(/viewDoc\(\s*["'](\d+)["']\s*,\s*["'](\d+)["']\s*,\s*["'](\d*)["']\s*,\s*["'](\d+)["']\s*,\s*["'](\d+)["']\s*,\s*["']([^"']+)["']/);
    if(!m) return null;
    const rcp = m[1], dcm = m[2], ele = m[3] || '1', off = m[4], len = m[5], dtd = m[6];
    const viewerUrl = 'https://dart.fss.or.kr/report/viewer.do?rcpNo=' + rcp + '&dcmNo=' + dcm + '&eleId=' + ele + '&offset=' + off + '&length=' + len + '&dtd=' + dtd;
    const rr = await fetchViaProxy(viewerUrl, 8000);
    const doc = await rr.text();
    const text = doc.replace(/<script[\s\S]*?<\/script>/g,'').replace(/<style[\s\S]*?<\/style>/g,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
    return {text: text, mainHtml: html};
  }

  // 실거래일 및 상세 정보 통합 파싱
  async function fetchTransactionDetails(rcpNo){
    const cached = parseDetailCache.get(rcpNo);
    if(cached) return cached;

    try {
      const result = await fetchDartText(rcpNo);
      if(!result) return null;
      const text = result.text;

      const details = {
        realDate: null,
        isCorrection: false,
        reasons: [],
        dates: [],
        prices: [],
        primaryReason: null,
        category: 'unknown' // 'buy' | 'bonus' | 'appointment' | 'other' | 'unknown'
      };

      // 1. 정정공시 여부
      details.isCorrection = text.includes('정 정 신 고') || text.includes('정정신고');
      // v0.3.3: 짧은 정정사유 추출 (표지 요약형 정정공시용)
      if(details.isCorrection){
        // "정정사유" 컬럼 다음의 텍스트를 최대 30자까지 추출
        const shortReasonMatch = text.match(/정정사유\s*정\s*정\s*전\s*정\s*정\s*후\s*([^0-9]{2,30}?)(?:\s*\d|\s*-|\s*보고사유)/);
        if(shortReasonMatch){
          details.shortReason = shortReasonMatch[1].trim().replace(/\s+/g, ' ');
        }
        // 대체 패턴: "특정증권 소유상황" 다음의 한글 텍스트
        if(!details.shortReason){
          const altMatch = text.match(/특정증권\s*소유상황\s+([가-힣\s]{5,40}?)(?:\s*\d|주\s|\s\d)/);
          if(altMatch) details.shortReason = altMatch[1].trim().replace(/\s+/g,' ');
        }
      }

      // 2. 보고의무발생일 (표지 - 모든 문서 공통)
      const oblMatch = text.match(/보고의무발생일\s*[:：]\s*(\d{4})[\.\-\/년\s]+(\d{1,2})[\.\-\/월\s]+(\d{1,2})/);
      if(oblMatch){
        details.realDate = oblMatch[1] + '-' + oblMatch[2].padStart(2,'0') + '-' + oblMatch[3].padStart(2,'0');
      }

      // 3. 정정공시 상세 파싱
      if(details.isCorrection){
        // 보고사유
        const reasonMatches = Array.from(text.matchAll(/보고사유\s*[:：]\s*([^\-()]{2,20}?)\s*[\(\+\-]/g));
        details.reasons = Array.from(new Set(reasonMatches.map(function(m){ return m[1].trim(); })));

        // 변동일 (실거래일 대체 정보로도 사용)
        const dateMatches = Array.from(text.matchAll(/변동일\s*[:：]\s*(\d{4})[\.\-\/년\s]+(\d{1,2})[\.\-\/월\s]+(\d{1,2})/g));
        details.dates = dateMatches.map(function(m){ return m[1] + '-' + m[2].padStart(2,'0') + '-' + m[3].padStart(2,'0'); });

        // 취득/처분단가
        const priceMatches = Array.from(text.matchAll(/취득\/처분단가\s*[:：]\s*([\d,]+)/g));
        details.prices = priceMatches.map(function(m){ return m[1]; });

        // 실거래일이 표지에 없고 변동일이 있으면 가장 최근 변동일 사용
        if(!details.realDate && details.dates.length > 0){
          details.realDate = details.dates[details.dates.length - 1];
        }

        // 4. 주요 취득유형 분류 (가장 빈번한 사유 우선)
        if(details.reasons.length > 0){
          // 우선순위: 장내매수 > 기타 매수 > 상여 > 선임 > 기타
          const priorityMap = {'장내매수': 4, '장내매도': -1, '자사주상여금': 2, '스톡옵션행사': 2, '신규선임': 1, '증여': 3, '상속': 3};
          const sorted = details.reasons.slice().sort(function(a,b){
            return (priorityMap[b]||0) - (priorityMap[a]||0);
          });
          details.primaryReason = sorted[0];

          if(details.primaryReason.includes('장내매수')) details.category = 'buy';
          else if(details.primaryReason.includes('상여') || details.primaryReason.includes('스톡옵션')) details.category = 'bonus';
          else if(details.primaryReason.includes('선임')) details.category = 'appointment';
          else details.category = 'other';
        }
      }

      parseDetailCache.set(rcpNo, details);
      return details;
    } catch(e){
      return null;
    }
  }

  async function fetchRealTradeDate(rcpNo){
    const cached = realDateCache.get(rcpNo);
    if(cached && typeof cached === 'string') return cached;

    const details = await fetchTransactionDetails(rcpNo);
    if(details && details.realDate){
      realDateCache.set(rcpNo, details.realDate);
      return details.realDate;
    }
    return null;
  }

      async function callAPI(corpCode){
    const key = getApiKey();
    if(!key) throw new Error('DART API 키가 없습니다');
    const target = 'https://opendart.fss.or.kr/api/elestock.json?crtfc_key=' + key + '&corp_code=' + corpCode;
    
    const proxies = [
      'https://corsproxy.io/?' + encodeURIComponent(target),
      'https://proxy.cors.sh/' + target,
      'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(target)
    ];
    
    let lastErr = null;
    for(let i = 0; i < proxies.length; i++){
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(function(){ ctrl.abort(); }, 15000);
        const res = await fetch(proxies[i], {signal: ctrl.signal});
        clearTimeout(timer);
        if(!res.ok){ lastErr = 'HTTP ' + res.status; continue; }
        const text = await res.text();
        if(!text.trim().startsWith('{')){ lastErr = 'Non-JSON'; continue; }
        const data = JSON.parse(text);
        if(data.status !== '000') throw new Error(data.message || 'API 오류');
        if(i > 0) console.log('[Phase18] Fallback proxy ' + i + ' succeeded');
        return data.list || [];
      } catch(e){
        lastErr = e.message;
        if(e.message && e.message.includes('API 오류')) throw e; // API 자체 에러는 즉시 중단
      }
    }
    throw new Error('모든 프록시 실패: ' + lastErr);
  }

      function analyze(list){
    // 노이즈 클러스터(100명 이상 동일 접수일) 자동 제외
    const byDate = {};
    list.forEach(function(item){
      const d = item.rcept_dt;
      if(!byDate[d]) byDate[d] = [];
      byDate[d].push(item);
    });

    const noisyDates = new Set();
    Object.entries(byDate).forEach(function(pair){
      if(pair[1].length >= 100) noisyDates.add(pair[0]);
    });

    // v0.3.2: 노이즈 날짜여도 등기임원+1000주+ 매수는 예외적으로 유지 (개인 매수 가능성)
    const cleaned = list.filter(function(item){
      if(!noisyDates.has(item.rcept_dt)) return true;
      const irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
      return item.isu_exctv_rgist_at === '등기임원' && irds >= 1000;
    });

    // 매수/매도 분리 (100주 이상만)
    const buys = cleaned.filter(function(item){
      const irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
      return irds >= 100;
    });
    const sells = cleaned.filter(function(item){
      const irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
      return irds <= -100;
    });

    // v0.3.2: 강한매수는 등기임원 필터 추가 + 노이즈 날짜의 사장급 대량매수도 인정
    const strong = buys.filter(function(item){
      const title = item.isu_exctv_ofcps || '';
      const irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
      const isRegistered = item.isu_exctv_rgist_at === '등기임원';
      const isSenior = /사장|CEO|대표이사|회장|부회장/.test(title);
      if(!isRegistered || !isSenior || irds < 5000) return false;
      // 노이즈 날짜(정기공시)에도 사장급 5000주+ 매수는 진짜 시그널로 인정
      if(noisyDates.has(item.rcept_dt)) return true;
      // 일반 날짜는 단독성 체크 (같은 날 매수 5명 이하)
      const sameDay = byDate[item.rcept_dt] || [];
      const sameDayBuys = sameDay.filter(function(x){
        const v = parseInt(String(x.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
        return v >= 100;
      });
      return sameDayBuys.length <= 5;
    });

    // 주목매수: 등기임원 + 1,000주+, 최근 180일
    const now = new Date();
    const cutoff180 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 180);
    const notable = buys.filter(function(item){
      const isRegistered = item.isu_exctv_rgist_at === '등기임원';
      const irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
      const dt = new Date(item.rcept_dt);
      return isRegistered && irds >= 1000 && dt >= cutoff180;
    }).sort(function(a,b){ return b.rcept_dt.localeCompare(a.rcept_dt); }).slice(0, 15);

    // 클러스터: 3~99명 동시매수 (노이즈 날짜는 원래대로 제외)
    const clusters = [];
    Object.entries(byDate).forEach(function(pair){
      const date = pair[0];
      const items = pair[1];
      if(items.length >= 3 && items.length < 100){
        const buyItems = items.filter(function(item){
          const irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
          return irds >= 100;
        });
        if(buyItems.length >= 3){
          const total = buyItems.reduce(function(s,i){
            return s + parseInt(String(i.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
          }, 0);
          clusters.push({date: date, count: buyItems.length, total: total, items: buyItems});
        }
      }
    });
    clusters.sort(function(a,b){ return b.date.localeCompare(a.date); });

    // 최근 30일 매수/매도
    const cutoff30 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
    const recent30buys = buys.filter(function(item){
      const dt = new Date(item.rcept_dt);
      return dt >= cutoff30;
    });
    const recent30sells = sells.filter(function(item){
      const dt = new Date(item.rcept_dt);
      return dt >= cutoff30;
    });

    return {
      total: list.length,
      cleaned: cleaned.length,
      excludedClusters: noisyDates.size,
      strong: strong,
      notable: notable,
      clusters: clusters.slice(0, 10),
      recent30buys: recent30buys.length,
      recent30sells: recent30sells.length
    };
  }

    function fmtDate(rcept_dt){
    if(!rcept_dt) return '';
    // 이미 하이픈 포함된 형식이면 그대로 반환
    if(rcept_dt.indexOf('-') >= 0) return rcept_dt;
    // 8자리 숫자 형식이면 변환
    return rcept_dt.slice(0,4) + '-' + rcept_dt.slice(4,6) + '-' + rcept_dt.slice(6,8);
  }

  function fmtNum(n){
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function dartLink(rcpNo){
    return 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + rcpNo;
  }

    function signalCard(item, options){
    options = options || {};
    var irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
    var isRegistered = item.isu_exctv_rgist_at === '등기임원';
    var sign = irds >= 0 ? '+' : '';
    var color = irds >= 0 ? '#059669' : '#dc2626';

    return '<div class="p18-card" style="padding:8px;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:6px;background:#fff;">' +
      '<div style="font-size:11px;color:#6b7280;">' +
        '접수 ' + fmtDate(item.rcept_dt) + 
        ' <a href="' + dartLink(item.rcept_no) + '" target="_blank" style="text-decoration:none;" title="DART 원문 열기">📄</a>' +
        ' <span class="p18-realdate" data-rcept="' + item.rcept_no + '" style="font-size:10px;color:#94a3b8;margin-left:6px;"></span>' +
        ' <span class="p18-badge" data-rcept="' + item.rcept_no + '" style="font-size:10px;margin-left:6px;"></span>' +
      '</div>' +
      '<div style="font-size:13px;font-weight:600;margin-top:2px;">' + item.repror + (isRegistered ? ' 📌' : '') + '</div>' +
      '<div style="font-size:13px;color:' + color + ';font-weight:700;">' + sign + fmtNum(irds) + '주' +
        ' <span class="p18-price" data-rcept="' + item.rcept_no + '" style="font-size:11px;color:#6b7280;font-weight:400;margin-left:4px;"></span>' +
      '</div>' +
    '</div>';
  }

  function renderResult(analysis, stockCode, stockName){
    const container = document.getElementById('p18-result');
    if(!container) return;

    const strongHtml = analysis.strong.length > 0 
      ? analysis.strong.slice(0,10).map(function(i){ return signalCard(i); }).join('')
      : '<div style="font-size:12px;color:#9ca3af;padding:8px;">해당 시그널 없음</div>';

    const notableHtml = analysis.notable.length > 0
      ? analysis.notable.map(function(i){ return signalCard(i); }).join('')
      : '<div style="font-size:12px;color:#9ca3af;padding:8px;">해당 시그널 없음</div>';

    const clustersHtml = analysis.clusters.length > 0
      ? analysis.clusters.map(function(c){
          return '<div style="margin-bottom:10px;padding:6px;background:#f9fafb;border-radius:4px;">' +
            '<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:4px;">📅 ' + fmtDate(c.date) + ' · ' + c.count + '명 · 총 +' + fmtNum(c.total) + '주</div>' +
            c.items.map(function(i){ return signalCard(i); }).join('') +
          '</div>';
        }).join('')
      : '<div style="font-size:12px;color:#9ca3af;padding:8px;">해당 시그널 없음</div>';

    container.innerHTML = 
      '<div style="margin-bottom:12px;font-size:13px;color:#374151;">' +
        '<strong>' + stockName + ' ' + stockCode + '</strong>' +
        '<span style="color:#6b7280;margin-left:8px;">총 ' + fmtNum(analysis.total) + '건 · 임원 지분변동 시그널 분석</span>' +
      '</div>' +
      '<div style="background:#fef3c7;border-left:3px solid #f59e0b;padding:8px 10px;margin-bottom:12px;border-radius:4px;font-size:11px;color:#78350f;">' +
        '⚠️ <strong>데이터 안내:</strong> 접수일 기준. 취득유형 배지: 🟢장내매수 / ⚪자사주상여금 / 🔵신규선임 / 📝정정공시(사유 축약) / ⚫원문 확인 필요. 상세는 📄 DART 원문 참고.' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:12px;">' +
        '<div style="padding:8px;background:#fee2e2;border-radius:4px;text-align:center;"><div style="font-size:11px;color:#7f1d1d;">🔥 강한매수</div><div style="font-size:20px;font-weight:700;color:#b91c1c;">' + analysis.strong.length + '</div><div style="font-size:9px;color:#7f1d1d;">사장급≥5,000주</div></div>' +
        '<div style="padding:8px;background:#fef3c7;border-radius:4px;text-align:center;"><div style="font-size:11px;color:#78350f;">⭐ 주목매수</div><div style="font-size:20px;font-weight:700;color:#d97706;">' + analysis.notable.length + '</div><div style="font-size:9px;color:#78350f;">등기≥1,000주</div></div>' +
        '<div style="padding:8px;background:#dbeafe;border-radius:4px;text-align:center;"><div style="font-size:11px;color:#1e3a8a;">💎 클러스터</div><div style="font-size:20px;font-weight:700;color:#1d4ed8;">' + analysis.clusters.length + '</div><div style="font-size:9px;color:#1e3a8a;">3~99명</div></div>' +
        '<div style="padding:8px;background:#d1fae5;border-radius:4px;text-align:center;"><div style="font-size:11px;color:#064e3b;">📈 30일 매수</div><div style="font-size:20px;font-weight:700;color:#059669;">' + analysis.recent30buys + '</div></div>' +
        '<div style="padding:8px;background:#fee2e2;border-radius:4px;text-align:center;"><div style="font-size:11px;color:#7f1d1d;">📉 30일 매도</div><div style="font-size:20px;font-weight:700;color:#dc2626;">' + analysis.recent30sells + '</div></div>' +
      '</div>' +
      (analysis.excludedClusters > 0 
        ? '<div style="background:#e0f2fe;border-left:3px solid #0284c7;padding:8px 10px;margin-bottom:12px;border-radius:4px;font-size:11px;color:#075985;">ℹ️ 정기공시성 대량 클러스터(100명+ 동일 접수) ' + analysis.excludedClusters + '건 자동 제외됨</div>'
        : '') +
      '<div style="background:#f0fdf4;border:1px solid #bbf7d0;padding:6px 10px;margin-bottom:8px;border-radius:4px;font-size:11px;color:#166534;">' +
        '🟢 <strong>장내매수 검증</strong>: 아래 카드에 <span style="background:#059669;color:#fff;padding:1px 4px;border-radius:2px;">장내매수</span> 배지가 있으면 정정공시에서 확인된 진짜 매수 시그널입니다.' +
      '</div>' +
      '<h3 style="font-size:13px;margin:12px 0 6px;color:#7f1d1d;">🔥 강한매수 (상위 10건)</h3>' + strongHtml +
      '<h3 style="font-size:13px;margin:12px 0 6px;color:#d97706;">⭐ 주목매수 (상위 15건)</h3>' + notableHtml +
      '<h3 style="font-size:13px;margin:12px 0 6px;color:#1d4ed8;">💎 클러스터 매수 (3~99명 동시)</h3>' + clustersHtml +
      '<div id="p18-bonus-section" style="margin-top:16px;"></div>';

        // 비동기 상세 파싱 (순차 처리) - v0.3.3
    setTimeout(async function(){
      const slots = container.querySelectorAll('.p18-realdate');

      for(let i = 0; i < slots.length; i++){
        const slot = slots[i];
        const rcpNo = slot.dataset.rcept;
        if(!rcpNo) continue;

        const badgeEl = container.querySelector('.p18-badge[data-rcept="' + rcpNo + '"]');
        const priceEl = container.querySelector('.p18-price[data-rcept="' + rcpNo + '"]');
        slot.textContent = '로딩...';
        slot.style.color = '#cbd5e1';

        try {
          const details = await fetchTransactionDetails(rcpNo);
          if(details){
            // 실거래일
            if(details.realDate){
              slot.textContent = '실거래 ' + details.realDate;
              slot.style.color = '#059669';
            } else {
              slot.textContent = '';
            }

            // v0.3.3: 취득유형 배지 (확장)
            if(badgeEl){
              const badgeStyles = {
                'buy': {bg:'#059669', text:'🟢 장내매수', color:'#fff', title:'정정공시에서 장내매수 확인'},
                'bonus': {bg:'#9ca3af', text:'⚪ 자사주상여금', color:'#fff', title:'자사주 상여 또는 스톡옵션'},
                'appointment': {bg:'#2563eb', text:'🔵 신규선임', color:'#fff', title:'선임 시 보유주식 보고'},
                'other': {bg:'#6b7280', text:'⚫ ' + (details.primaryReason || '기타'), color:'#fff', title:details.primaryReason || '기타 사유'}
              };

              if(details.category !== 'unknown'){
                // 파싱 성공: 취득유형 배지
                const b = badgeStyles[details.category];
                badgeEl.innerHTML = '<span title="' + b.title + '" style="background:' + b.bg + ';color:' + b.color + ';padding:1px 5px;border-radius:2px;font-size:10px;">' + b.text + '</span>';
              } else if(details.isCorrection){
                // 정정공시지만 취득유형 파싱 실패: 정정 아이콘 + 짧은 사유
                const reasonText = details.shortReason 
                  ? '📝 정정: ' + details.shortReason.slice(0, 20)
                  : '📝 정정공시';
                const title = details.shortReason || '정정공시 (상세는 📄 원문 확인)';
                badgeEl.innerHTML = '<span title="' + title.replace(/"/g,'&quot;') + '" style="background:#f59e0b;color:#fff;padding:1px 5px;border-radius:2px;font-size:10px;">' + reasonText + '</span>';
              } else {
                // 원본 보고서: 취득유형 확인 불가
                badgeEl.innerHTML = '<span title="원문 확인 필요 (📄 아이콘 클릭)" style="background:#e5e7eb;color:#4b5563;padding:1px 5px;border-radius:2px;font-size:10px;">⚫ 원문 확인</span>';
              }
            }

            // 매수단가
            if(priceEl && details.prices.length > 0){
              priceEl.textContent = '@' + details.prices[details.prices.length-1] + '원';
            }

            // 노이즈 카드 수집 (자사주상여금)
            if(details.category === 'bonus'){
              const card = slot.closest('.p18-card');
              if(card){
                card.style.opacity = '0.5';
                card.setAttribute('data-noise', 'true');
              }
            }
          } else {
            slot.textContent = '';
            // 파싱 자체 실패: 회색 배지
            if(badgeEl){
              badgeEl.innerHTML = '<span title="파싱 실패 (프록시 오류 또는 접근 불가)" style="background:#e5e7eb;color:#9ca3af;padding:1px 5px;border-radius:2px;font-size:10px;">❌ 파싱실패</span>';
            }
          }
        } catch(e){
          slot.textContent = '';
        }

        await new Promise(function(r){ setTimeout(r, 200); });
      }

      // 노이즈 카드 별도 섹션으로 이동
      const noiseCards = container.querySelectorAll('.p18-card[data-noise="true"]');
      if(noiseCards.length > 0){
        const bonusSection = document.getElementById('p18-bonus-section');
        if(bonusSection){
          bonusSection.innerHTML = 
            '<details style="border:1px solid #e5e7eb;border-radius:6px;padding:8px;background:#f9fafb;">' +
              '<summary style="cursor:pointer;font-size:12px;font-weight:600;color:#6b7280;">⚪ 자사주상여금 · 스톡옵션 (' + noiseCards.length + '건) — 개인 매수 아님 · 클릭하여 펼치기</summary>' +
              '<div id="p18-bonus-list" style="margin-top:8px;"></div>' +
            '</details>';
          const bonusList = document.getElementById('p18-bonus-list');
          noiseCards.forEach(function(card){
            card.style.opacity = '1';
            bonusList.appendChild(card);
          });
        }
      }
    }, 100);
  }

  function openModal(){
    let modal = document.getElementById('p18-modal');
    if(modal){ modal.style.display = 'flex'; return; }

    modal = document.createElement('div');
    modal.id = 'p18-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:flex-start;justify-content:center;z-index:10000;padding:20px;overflow-y:auto;';
    
    const options = Object.entries(CORP_MAP).map(function(pair){
      return '<option value="' + pair[0] + '">' + pair[1].name + ' (' + pair[0] + ')</option>';
    }).join('');

    modal.innerHTML = 
      '<div style="background:#fff;border-radius:8px;padding:16px;max-width:720px;width:100%;max-height:90vh;overflow-y:auto;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
          '<div style="font-size:16px;font-weight:700;">📊 임원 장내매수 정밀 트래커 <span style="font-size:11px;color:#6b7280;font-weight:400;">v' + VERSION + '</span></div>' +
          '<div><button id="p18-key-btn" style="background:transparent;border:none;cursor:pointer;font-size:16px;margin-right:8px;">🔑</button><button id="p18-close" style="background:transparent;border:none;cursor:pointer;font-size:20px;">×</button></div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:12px;">' +
          '<select id="p18-select" style="flex:1;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:13px;">' + options + '</select>' +
          '<input id="p18-manual" type="text" placeholder="또는 종목코드 직접입력" style="flex:1;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:13px;">' +
          '<button id="p18-search" style="padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600;">🔍 조회</button>' +
        '</div>' +
        '<div id="p18-result"></div>' +
      '</div>';

    document.body.appendChild(modal);

    modal.querySelector('#p18-close').onclick = function(){ modal.style.display = 'none'; };
    modal.querySelector('#p18-key-btn').onclick = openKey;
    modal.querySelector('#p18-search').onclick = doSearch;
    modal.querySelector('#p18-manual').addEventListener('keypress', function(e){
      if(e.key === 'Enter') doSearch();
    });
  }

  async function doSearch(){
    const manual = document.getElementById('p18-manual').value.trim();
    const stockCode = manual || document.getElementById('p18-select').value;
    const info = CORP_MAP[stockCode];
    const container = document.getElementById('p18-result');

    if(!info && !manual){
      container.innerHTML = '<div style="color:#dc2626;font-size:12px;">알 수 없는 종목코드</div>';
      return;
    }

    const corpCode = info ? info.code : null;
    const stockName = info ? info.name : stockCode;

    if(!corpCode){
      container.innerHTML = '<div style="color:#dc2626;font-size:12px;">이 종목의 DART 고유번호가 등록되어 있지 않습니다.</div>';
      return;
    }

    container.innerHTML = '<div style="color:#6b7280;font-size:12px;">🔄 조회 중...</div>';

    try {
      const list = await callAPI(corpCode);
      const analysis = analyze(list);
      renderResult(analysis, stockCode, stockName);
    } catch(e){
      container.innerHTML = '<div style="color:#dc2626;font-size:12px;">❌ ' + e.message + '</div>';
    }
  }

  function openKey(){
    const cur = getApiKey();
    const key = prompt('DART API 키를 입력하세요 (40자):', cur);
    if(key && key.length === 40){
      localStorage.setItem('dart_api_key', key);
      alert('✅ API 키 저장됨');
    } else if(key !== null){
      alert('❌ 40자 키만 저장 가능');
    }
  }

  function injectMenuButton(){
    if(document.getElementById('p18-menu-insider')) return true;

    const anchors = ['p16-menu-stats', 'p16-menu-channels', 'p16-menu-info-note', 'p17-menu-ai-draft'];
    let grid = null;
    for(let i = 0; i < anchors.length; i++){
      const el = document.getElementById(anchors[i]);
      if(el && el.parentElement){ grid = el.parentElement; break; }
    }
    if(!grid) return false;

    const btn = document.createElement('button');
    btn.id = 'p18-menu-insider';
    btn.textContent = '📊 임원매수';
    btn.style.cssText = 'padding:10px;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;';
    btn.onclick = openModal;
    grid.appendChild(btn);
    return true;
  }

  function scheduleMenuInjection(){
    let attempts = 0;
    const maxAttempts = 60;
    const timer = setInterval(function(){
      attempts++;
      if(injectMenuButton() || attempts >= maxAttempts){
        clearInterval(timer);
      }
    }, 1000);

    // 메뉴 모달 열림 감지 (MutationObserver)
    const observer = new MutationObserver(function(){
      if(!document.getElementById('p18-menu-insider')){
        injectMenuButton();
      }
    });
    observer.observe(document.body, {childList: true, subtree: true});
  }

  // 전역 노출
  window.__phase18Insider = {
    version: VERSION,
    open: openModal,
    openKey: openKey,
    callAPI: callAPI,
    analyze: analyze,
    corpMap: CORP_MAP,
    fetchRealTradeDate: fetchRealTradeDate,
    fetchTransactionDetails: fetchTransactionDetails,
    injectMenuButton: injectMenuButton,
    realDateCache: realDateCache,
    parseDetailCache: parseDetailCache
  };
  window.p18OpenInsiderModal = openModal;

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', scheduleMenuInjection);
  } else {
    scheduleMenuInjection();
  }
  console.log('[Phase18] 임원 장내매수 정밀 트래커 v' + VERSION + ' 로드 완료');
})();
