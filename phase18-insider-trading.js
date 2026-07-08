/* phase18-insider-trading.js — 임원 장내매수 정밀 트래커 v0.3.5
 * 
 * v0.3.5 개선사항 (2026-07-08):
 *  - 종목별 인사이트 카드 추가 (CORP_INSIGHTS 데이터베이스)
 *  - 3개 종목 원문 검증 결과 내장 (삼성전자/SK하이닉스/NAVER)
 *  - 유형 분류: 대형주 활발형 / 경영진 동반 매수형 / CEO 단독 확신형
 *  - 동적 요약: 반복 매수자(3회+) 자동 탐지, 활동 날짜 분석
 *
 * v0.3.4 개선사항:
 *  - callAPI 프록시 폴백 로직 (corsproxy.io 실패 시 cors.sh, codetabs 자동 재시도)
 *
 * v0.3.0~v0.3.3 개선사항 (2026-07-09):
 *  - 리브랜딩: "임원 지분변동 트래커" → "임원 장내매수 정밀 트래커"
 *  - DART 정정공시 상세 파싱: 보고사유(취득유형)·변동일·매수단가 추출
 *  - 취득유형 배지: 🟢장내매수 / ⚪자사주상여금 / 🔵신규선임 / ⚫유형미상
 *  - 노이즈 별도 섹션: 자사주상여금 카드는 별도 접힘 섹션으로 분리
 *  - 명시적 파싱 상태 표시: 로딩중 / 실패 시 회색 처리
 *  - 실거래일 파싱 유지 (v0.2.1): 보고의무발생일 우선, 정정공시는 변동일 사용
 */
(function(){
  'use strict';
  const VERSION = '0.3.5';
  
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

  // v0.3.5: 종목별 축적 인사이트 (원문 검증 기반)
  const CORP_INSIGHTS = {
    '005930': {
      type: '대형주 활발형',
      typeColor: '#2563eb',
      keyPeople: ['노태문 사장 (반복매수 24.09~26.01)', '한종희 부회장'],
      strengths: [
        '풍부한 임원 매수 데이터 (2,612건)',
        '노태문 사장의 장기 반복 매수 패턴 (다회 확인)'
      ],
      cautions: [
        '26.02.02·26.02.06 대량 정기공시(800+건) 자사주 성과급',
        '한종희 부회장 24.09 매수는 실적발표 직전 - 재료 관련성 검증 필요'
      ],
      framework: '노이즈 필터링 후 남는 개인 매수, 특히 반복 매수 시계열에 주목'
    },
    '000660': {
      type: '경영진 동반 매수형',
      typeColor: '#059669',
      keyPeople: ['곽노정 대표이사', '차선용', '안현'],
      strengths: [
        '26.04.07 경영진 3인 동시 매수 (유사 수량 2,329~2,360주)',
        '곽노정 사장 26.05.04 5,878주 후속 확신 매수'
      ],
      cautions: [
        '26.01.07 38명 클러스터는 인당 300주대 - 정기공시성 가능성',
        '경영진 동반 매수는 사전 조율 신호로 개인 판단보다 집단 의사로 해석'
      ],
      framework: '경영진 3~5명 동일 날짜·유사 수량 매수 패턴에 최상위 가중치'
    },
    '035420': {
      type: 'CEO 단독 확신형',
      typeColor: '#7c3aed',
      keyPeople: ['최수연 대표이사 (취임 후 4년 누적 7억원 매수)'],
      strengths: [
        'CEO 지속적 책임경영 매수 (22년 취임~현재)',
        '26.02.09 C레벨 6인 동반 매수 (언론 확인)'
      ],
      cautions: [
        '주목매수 0건 - 등기임원층 자발적 매수 부재',
        'RSU 제도 운영 중이라 소액 클러스터는 정산일 가능성',
        '임원층 확산 없음이 리스크 요인'
      ],
      framework: 'CEO 개인 확신에 베팅하는 종목. 강한매수 1건의 무게가 다른 종목 대비 크게 부각'
    }
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
        category: 'unknown'
      };

      details.isCorrection = text.includes('정 정 신 고') || text.includes('정정신고');
      if(details.isCorrection){
        const shortReasonMatch = text.match(/정정사유\s*정\s*정\s*전\s*정\s*정\s*후\s*([^0-9]{2,30}?)(?:\s*\d|\s*-|\s*보고사유)/);
        if(shortReasonMatch){
          details.shortReason = shortReasonMatch[1].trim().replace(/\s+/g, ' ');
        }
        if(!details.shortReason){
          const altMatch = text.match(/특정증권\s*소유상황\s+([가-힣\s]{5,40}?)(?:\s*\d|주\s|\s\d)/);
          if(altMatch) details.shortReason = altMatch[1].trim().replace(/\s+/g,' ');
        }
      }

      const oblMatch = text.match(/보고의무발생일\s*[:：]\s*(\d{4})[\.\-\/년\s]+(\d{1,2})[\.\-\/월\s]+(\d{1,2})/);
      if(oblMatch){
        details.realDate = oblMatch[1] + '-' + oblMatch[2].padStart(2,'0') + '-' + oblMatch[3].padStart(2,'0');
      }

      if(details.isCorrection){
        const reasonMatches = Array.from(text.matchAll(/보고사유\s*[:：]\s*([^\-()]{2,20}?)\s*[\(\+\-]/g));
        details.reasons = Array.from(new Set(reasonMatches.map(function(m){ return m[1].trim(); })));

        const dateMatches = Array.from(text.matchAll(/변동일\s*[:：]\s*(\d{4})[\.\-\/년\s]+(\d{1,2})[\.\-\/월\s]+(\d{1,2})/g));
        details.dates = dateMatches.map(function(m){ return m[1] + '-' + m[2].padStart(2,'0') + '-' + m[3].padStart(2,'0'); });

        const priceMatches = Array.from(text.matchAll(/취득\/처분단가\s*[:：]\s*([\d,]+)/g));
        details.prices = priceMatches.map(function(m){ return m[1]; });

        if(!details.realDate && details.dates.length > 0){
          details.realDate = details.dates[details.dates.length - 1];
        }

        if(details.reasons.length > 0){
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
        if(e.message && e.message.includes('API 오류')) throw e;
      }
    }
    throw new Error('모든 프록시 실패: ' + lastErr);
  }

  function analyze(list){
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

    const cleaned = list.filter(function(item){
      if(!noisyDates.has(item.rcept_dt)) return true;
      const irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
      return item.isu_exctv_rgist_at === '등기임원' && irds >= 1000;
    });

    const buys = cleaned.filter(function(item){
      const irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
      return irds >= 100;
    });
    const sells = cleaned.filter(function(item){
      const irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
      return irds <= -100;
    });

    const strong = buys.filter(function(item){
      const title = item.isu_exctv_ofcps || '';
      const irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
      const isRegistered = item.isu_exctv_rgist_at === '등기임원';
      const isSenior = /사장|CEO|대표이사|회장|부회장/.test(title);
      if(!isRegistered || !isSenior || irds < 5000) return false;
      if(noisyDates.has(item.rcept_dt)) return true;
      const sameDay = byDate[item.rcept_dt] || [];
      const sameDayBuys = sameDay.filter(function(x){
        const v = parseInt(String(x.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
        return v >= 100;
      });
      return sameDayBuys.length <= 5;
    });

    const now = new Date();
    const cutoff180 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 180);
    const notable = buys.filter(function(item){
      const isRegistered = item.isu_exctv_rgist_at === '등기임원';
      const irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
      const dt = new Date(item.rcept_dt);
      return isRegistered && irds >= 1000 && dt >= cutoff180;
    }).sort(function(a,b){ return b.rcept_dt.localeCompare(a.rcept_dt); }).slice(0, 15);

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
      recent30sells: recent30sells.length,
      rawList: list  // v0.3.5: 인사이트 계산용
    };
  }

  function fmtDate(rcept_dt){
    if(!rcept_dt) return '';
    if(rcept_dt.indexOf('-') >= 0) return rcept_dt;
    return rcept_dt.slice(0,4) + '-' + rcept_dt.slice(4,6) + '-' + rcept_dt.slice(6,8);
  }

  function fmtNum(n){
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function dartLink(rcpNo){
    return 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + rcpNo;
  }

  // v0.3.5: 종목별 인사이트 카드 렌더링
  function renderInsightCard(stockCode, list){
    const insight = CORP_INSIGHTS[stockCode];
    
    // 동적 요약 계산 (모든 종목 공통)
    const total = list.length;
    const byDate = {};
    list.forEach(function(item){
      if(!byDate[item.rcept_dt]) byDate[item.rcept_dt] = 0;
      byDate[item.rcept_dt]++;
    });
    const noiseDates = Object.entries(byDate).filter(function(p){ return p[1] >= 100; }).length;
    const activeDates = Object.keys(byDate).length;
    const dateRange = Object.keys(byDate).sort();
    const firstDate = dateRange[0] ? fmtDate(dateRange[0]) : '-';
    const lastDate = dateRange[dateRange.length-1] ? fmtDate(dateRange[dateRange.length-1]) : '-';
    
    // 반복 매수자 탐지 (동일 인물 3회 이상 매수)
    const buyerCount = {};
    list.forEach(function(item){
      const irds = parseInt(String(item.sp_stock_lmp_irds_cnt || '0').replace(/,/g,''));
      if(irds >= 100){
        const name = item.repror;
        if(name) buyerCount[name] = (buyerCount[name] || 0) + 1;
      }
    });
    const repeatBuyers = Object.entries(buyerCount)
      .filter(function(p){ return p[1] >= 3; })
      .sort(function(a,b){ return b[1]-a[1]; })
      .slice(0, 5);
    
    let html = '<div style="background:linear-gradient(135deg,#f8fafc 0%,#eef2ff 100%);border:1px solid #c7d2fe;border-radius:8px;padding:12px;margin:12px 0;">';
    html += '<div style="font-size:13px;color:#4338ca;font-weight:700;margin-bottom:8px;">📊 종목 인사이트 요약</div>';
    
    if(insight){
      html += '<div style="display:inline-block;background:' + insight.typeColor + ';color:white;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;margin-bottom:8px;">' + insight.type + '</div>';
      
      html += '<div style="margin:6px 0;font-size:12px;">';
      html += '<div style="color:#374151;font-weight:600;margin-bottom:3px;">🎯 주요 인물</div>';
      html += '<div style="color:#6b7280;padding-left:8px;line-height:1.5;">' + insight.keyPeople.map(function(p){ return '• ' + p; }).join('<br>') + '</div>';
      html += '</div>';
      
      html += '<div style="margin:6px 0;font-size:12px;">';
      html += '<div style="color:#059669;font-weight:600;margin-bottom:3px;">✅ 강점 시그널</div>';
      html += '<div style="color:#6b7280;padding-left:8px;line-height:1.5;">' + insight.strengths.map(function(s){ return '• ' + s; }).join('<br>') + '</div>';
      html += '</div>';
      
      html += '<div style="margin:6px 0;font-size:12px;">';
      html += '<div style="color:#dc2626;font-weight:600;margin-bottom:3px;">⚠️ 주의 사항</div>';
      html += '<div style="color:#6b7280;padding-left:8px;line-height:1.5;">' + insight.cautions.map(function(c){ return '• ' + c; }).join('<br>') + '</div>';
      html += '</div>';
      
      html += '<div style="margin:8px 0 4px;padding:8px;background:#fef3c7;border-radius:6px;font-size:12px;">';
      html += '<div style="color:#92400e;font-weight:600;">💡 판단 프레임</div>';
      html += '<div style="color:#78350f;margin-top:2px;line-height:1.5;">' + insight.framework + '</div>';
      html += '</div>';
    } else {
      html += '<div style="padding:8px;background:#fef3c7;border-radius:6px;font-size:12px;color:#78350f;margin-bottom:8px;">';
      html += '💡 이 종목은 아직 인사이트 데이터베이스에 등록되지 않았습니다. 아래 동적 요약을 참고하세요.';
      html += '</div>';
    }
    
    // 동적 요약 (모든 종목 공통)
    html += '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #c7d2fe;font-size:12px;">';
    html += '<div style="color:#374151;font-weight:600;margin-bottom:4px;">📈 현재 조회 요약</div>';
    html += '<div style="color:#6b7280;line-height:1.6;padding-left:4px;">';
    html += '• 전체 <strong>' + fmtNum(total) + '</strong>건 · 활동 날짜 <strong>' + activeDates + '</strong>일 · 노이즈 날짜 <strong>' + noiseDates + '</strong>일 (100명+)<br>';
    html += '• 조회 범위: ' + firstDate + ' ~ ' + lastDate + '<br>';
    if(repeatBuyers.length > 0){
      html += '• 🔁 반복 매수자 (3회+): ';
      html += repeatBuyers.map(function(p){
        return '<strong>' + p[0] + '</strong>(' + p[1] + '회)';
      }).join(', ');
    } else {
      html += '• 반복 매수자 없음 (3회+ 기준)';
    }
    html += '</div></div>';
    
    html += '</div>';
    return html;
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

    // v0.3.5: 인사이트 카드 HTML 생성
    const insightHtml = renderInsightCard(stockCode, analysis.rawList || []);

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
      insightHtml +
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

    // 비동기 상세 파싱 (순차 처리)
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
            if(details.realDate){
              slot.textContent = '실거래 ' + details.realDate;
              slot.style.color = '#059669';
            } else {
              slot.textContent = '';
            }

            if(badgeEl){
              const badgeStyles = {
                'buy': {bg:'#059669', text:'🟢 장내매수', color:'#fff', title:'정정공시에서 장내매수 확인'},
                'bonus': {bg:'#9ca3af', text:'⚪ 자사주상여금', color:'#fff', title:'자사주 상여 또는 스톡옵션'},
                'appointment': {bg:'#2563eb', text:'🔵 신규선임', color:'#fff', title:'선임 시 보유주식 보고'},
                'other': {bg:'#6b7280', text:'⚫ ' + (details.primaryReason || '기타'), color:'#fff', title:details.primaryReason || '기타 사유'}
              };

              if(details.category !== 'unknown'){
                const b = badgeStyles[details.category];
                badgeEl.innerHTML = '<span title="' + b.title + '" style="background:' + b.bg + ';color:' + b.color + ';padding:1px 5px;border-radius:2px;font-size:10px;">' + b.text + '</span>';
              } else if(details.isCorrection){
                const reasonText = details.shortReason 
                  ? '📝 정정: ' + details.shortReason.slice(0, 20)
                  : '📝 정정공시';
                const title = details.shortReason || '정정공시 (상세는 📄 원문 확인)';
                badgeEl.innerHTML = '<span title="' + title.replace(/"/g,'&quot;') + '" style="background:#f59e0b;color:#fff;padding:1px 5px;border-radius:2px;font-size:10px;">' + reasonText + '</span>';
              } else {
                badgeEl.innerHTML = '<span title="원문 확인 필요 (📄 아이콘 클릭)" style="background:#e5e7eb;color:#4b5563;padding:1px 5px;border-radius:2px;font-size:10px;">⚫ 원문 확인</span>';
              }
            }

            if(priceEl && details.prices.length > 0){
              priceEl.textContent = '@' + details.prices[details.prices.length-1] + '원';
            }

            if(details.category === 'bonus'){
              const card = slot.closest('.p18-card');
              if(card){
                card.style.opacity = '0.5';
                card.setAttribute('data-noise', 'true');
              }
            }
          } else {
            slot.textContent = '';
            if(badgeEl){
              badgeEl.innerHTML = '<span title="파싱 실패 (프록시 오류 또는 접근 불가)" style="background:#e5e7eb;color:#9ca3af;padding:1px 5px;border-radius:2px;font-size:10px;">❌ 파싱실패</span>';
            }
          }
        } catch(e){
          slot.textContent = '';
        }

        await new Promise(function(r){ setTimeout(r, 200); });
      }

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

    const observer = new MutationObserver(function(){
      if(!document.getElementById('p18-menu-insider')){
        injectMenuButton();
      }
    });
    observer.observe(document.body, {childList: true, subtree: true});
  }

  window.__phase18Insider = {
    version: VERSION,
    open: openModal,
    openKey: openKey,
    callAPI: callAPI,
    analyze: analyze,
    corpMap: CORP_MAP,
    corpInsights: CORP_INSIGHTS,  // v0.3.5: 인사이트 DB 노출
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
