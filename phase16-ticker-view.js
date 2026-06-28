// phase16-ticker-view.js - 종목별 인사이트 보기 v0.1.0
// phase16-insights.js, phase16-list.js 이후에 로드
(function() {
  const VERSION = '0.1.0';
  const MAIN_DB = 'StockJournalDB';

  // phase16 로드 대기
  function waitForPhase16(maxWait = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.__phase16?.getAllVideos && window.__phase16List?.open) return resolve();
        if (Date.now() - start > maxWait) return reject(new Error('phase16 로드 실패'));
        setTimeout(check, 100);
      };
      check();
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function daysAgo(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const today = new Date();
    const diff = Math.floor((today - d) / 86400000);
    if (diff === 0) return '오늘';
    if (diff === 1) return '어제';
    if (diff < 7) return `${diff}일 전`;
    if (diff < 30) return `${Math.floor(diff/7)}주 전`;
    return dateStr;
  }

  // ─────────────────────────────────────────────
  // 보유 종목 읽기 (메인 DB에서 읽기만)
  // ─────────────────────────────────────────────
  async function getHoldings() {
    try {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(MAIN_DB);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        setTimeout(() => rej(new Error('timeout')), 3000);
      });
      if (!db.objectStoreNames.contains('holdings')) {
        db.close();
        return [];
      }
      const list = await new Promise((res) => {
        const r = db.transaction('holdings').objectStore('holdings').getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => res([]);
      });
      db.close();
      return list.map(h => ({
        code: h.ticker || h.code,
        name: h.name || h.tickerName || h.ticker,
        quantity: h.currentQuantity ?? h.quantity ?? 0
      })).filter(x => x.code);
    } catch (e) {
      console.warn('[Phase16-ticker] 보유 종목 조회 실패:', e.message);
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // 종목별 인사이트 그룹화
  // ─────────────────────────────────────────────
  async function buildTickerGroups() {
    const [holdings, videos] = await Promise.all([
      getHoldings(),
      window.__phase16.getAllVideos()
    ]);

    // 보유 종목 맵
    const holdingMap = new Map();
    holdings.forEach(h => {
      if (h.code) holdingMap.set(h.code, h);
      if (h.name) holdingMap.set(h.name, h);  // 이름으로도 매칭 가능
    });

    // 종목별로 영상 그룹화
    const groups = new Map();  // key: 종목코드(또는 이름), value: { code, name, isHolding, videos, counts }

    videos.forEach(v => {
      (v.tickers || []).forEach(t => {
        const key = t.code || t.name;
        if (!key) return;

        // 보유 종목과 매칭 (코드 또는 이름)
        const holding = holdingMap.get(t.code) || holdingMap.get(t.name);

        if (!groups.has(key)) {
          groups.set(key, {
            code: t.code || (holding?.code) || '',
            name: t.name || (holding?.name) || key,
            isHolding: !!holding,
            quantity: holding?.quantity || 0,
            videos: [],
            counts: { buy: 0, hold: 0, sell: 0 }
          });
        }
        const g = groups.get(key);
        g.videos.push({ ...v, _ticker: t });
        if (t.tone === 'buy') g.counts.buy++;
        else if (t.tone === 'sell') g.counts.sell++;
        else g.counts.hold++;
      });
    });

    // 보유 종목 중 인사이트가 없는 것 찾기
    const mentionedKeys = new Set([...groups.keys()]);
    const noInsightHoldings = holdings.filter(h => {
      return !mentionedKeys.has(h.code) && !mentionedKeys.has(h.name);
    });

    // 분류
    const holdingWithInsight = [];
    const nonHoldingWithInsight = [];
    groups.forEach(g => {
      if (g.isHolding) holdingWithInsight.push(g);
      else nonHoldingWithInsight.push(g);
    });

    // 옵션 1: 보유 종목 우선, 그 다음 인사이트 개수 순
    holdingWithInsight.sort((a, b) => b.videos.length - a.videos.length);
    nonHoldingWithInsight.sort((a, b) => b.videos.length - a.videos.length);

    // 각 종목의 영상은 최신순 정렬
    [...holdingWithInsight, ...nonHoldingWithInsight].forEach(g => {
      g.videos.sort((a, b) => {
        const da = a.watchedAt || a.createdAt || '';
        const db = b.watchedAt || b.createdAt || '';
        return db.localeCompare(da);
      });
    });

    return { holdingWithInsight, nonHoldingWithInsight, noInsightHoldings, totalVideos: videos.length };
  }

  // ─────────────────────────────────────────────
  // 종목 카드 렌더링
  // ─────────────────────────────────────────────
  function renderTickerCard(g) {
    const latest = g.videos[0];
    const latestTone = latest._ticker.tone;
    const toneColors = {
      buy: { text: '매수', color: '#dc2626', bg: '#fee2e2' },
      hold: { text: '중립', color: '#525252', bg: '#f5f5f5' },
      sell: { text: '매도', color: '#2563eb', bg: '#dbeafe' }
    };

    // 카운트 배지
    const countBadges = [];
    if (g.counts.buy > 0) countBadges.push(`<span style="color:#dc2626;font-weight:600;">매수 ${g.counts.buy}</span>`);
    if (g.counts.hold > 0) countBadges.push(`<span style="color:#525252;font-weight:600;">중립 ${g.counts.hold}</span>`);
    if (g.counts.sell > 0) countBadges.push(`<span style="color:#2563eb;font-weight:600;">매도 ${g.counts.sell}</span>`);
    const countsHtml = countBadges.join(' · ');

    // 종합 톤 판단 (매수>매도 = 긍정, 매도>매수 = 부정, 같음 = 중립)
    let overallBg = '#fafafa', overallBorder = '#e5e7eb';
    if (g.counts.buy > g.counts.sell) { overallBg = '#fff5f5'; overallBorder = '#fecaca'; }
    else if (g.counts.sell > g.counts.buy) { overallBg = '#f0f7ff'; overallBorder = '#bfdbfe'; }

    const latestTC = toneColors[latestTone] || toneColors.hold;

    return `
      <div class="p16t-ticker-card" data-code="${escapeHtml(g.code)}" data-name="${escapeHtml(g.name)}"
        style="background:${overallBg};border:1px solid ${overallBorder};border-radius:10px;padding:14px;margin-bottom:10px;cursor:pointer;transition:transform 0.1s;"
        onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform='translateY(0)'">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
              <span style="font-weight:700;font-size:15px;color:#111;">${escapeHtml(g.name)}</span>
              ${g.code ? `<span style="font-size:12px;color:#6b7280;">(${escapeHtml(g.code)})</span>` : ''}
              ${g.isHolding ? `<span style="padding:2px 7px;border-radius:10px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:600;">보유</span>` : ''}
            </div>
            <div style="font-size:12px;color:#4b5563;margin-bottom:6px;">${countsHtml}</div>
            <div style="font-size:12px;color:#6b7280;">
              최근: ${daysAgo(latest.watchedAt)} · ${escapeHtml(latest.channelName || '?')} 
              <span style="padding:1px 6px;border-radius:8px;background:${latestTC.bg};color:${latestTC.color};font-size:11px;font-weight:600;margin-left:4px;">${latestTC.text}</span>
            </div>
            ${latest.summary?.[0] ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;font-style:italic;">"${escapeHtml(latest.summary[0].slice(0, 60))}${latest.summary[0].length > 60 ? '...' : ''}"</div>` : ''}
          </div>
          <div style="flex-shrink:0;text-align:right;">
            <div style="font-size:18px;font-weight:700;color:#111;">${g.videos.length}</div>
            <div style="font-size:11px;color:#6b7280;">건</div>
            <div style="font-size:11px;color:#4a7eff;margin-top:8px;">보기 →</div>
          </div>
        </div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // 종목별 보기 화면
  // ─────────────────────────────────────────────
  let tickerModalEl = null;

  async function openTickerView() {
    if (tickerModalEl) tickerModalEl.remove();

    const modal = document.createElement('div');
    tickerModalEl = modal;
    modal.id = 'phase16-ticker-modal';
    modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px;`;
    modal.innerHTML = `
      <div style="background:#f9fafb;border-radius:14px;max-width:900px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 25px 70px rgba(0,0,0,0.3);">
        <div style="padding:18px 22px;border-bottom:1px solid #e5e7eb;background:white;border-radius:14px 14px 0 0;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h2 style="margin:0;font-size:18px;">🏷️ 종목별 인사이트</h2>
            <button id="p16t-close" style="border:none;background:none;font-size:24px;cursor:pointer;color:#6b7280;">✕</button>
          </div>
          <div style="display:flex;gap:6px;">
            <button id="p16t-tab-videos" style="padding:7px 14px;border:1px solid #e5e7eb;background:white;border-radius:6px;cursor:pointer;font-size:13px;color:#6b7280;">📋 영상 목록</button>
            <button id="p16t-tab-tickers" style="padding:7px 14px;border:1px solid #4a7eff;background:#4a7eff;color:white;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">🏷️ 종목별 보기</button>
          </div>
        </div>
        <div style="padding:12px 22px;background:white;border-bottom:1px solid #e5e7eb;">
          <input id="p16t-search" type="search" placeholder="🔍 종목명 또는 코드로 검색"
            style="width:100%;padding:9px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;box-sizing:border-box;">
        </div>
        <div id="p16t-body" style="flex:1;overflow-y:auto;padding:18px 22px;">
          <div style="text-align:center;color:#9ca3af;padding:60px 0;">로딩 중...</div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#p16t-close').onclick = () => { modal.remove(); tickerModalEl = null; };
    modal.addEventListener('click', (e) => {
      if (e.target === modal) { modal.remove(); tickerModalEl = null; }
    });

    // 영상 목록 탭으로 전환
    modal.querySelector('#p16t-tab-videos').onclick = () => {
      modal.remove();
      tickerModalEl = null;
      window.__phase16List.open();
    };

    // 검색
    let searchTimer;
    modal.querySelector('#p16t-search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => refreshTickerView(e.target.value.trim()), 200);
    });

    await refreshTickerView('');
  }

  async function refreshTickerView(query = '') {
    if (!tickerModalEl) return;
    const body = tickerModalEl.querySelector('#p16t-body');

    try {
      const data = await buildTickerGroups();

      if (data.totalVideos === 0) {
        body.innerHTML = `
          <div style="text-align:center;padding:60px 20px;color:#9ca3af;">
            <div style="font-size:48px;margin-bottom:12px;">📭</div>
            <div style="font-size:15px;margin-bottom:8px;">아직 인사이트가 없습니다</div>
            <div style="font-size:13px;">영상 목록 탭에서 첫 영상을 등록해보세요.</div>
          </div>
        `;
        return;
      }

      // 검색 필터
      const q = query.toLowerCase();
      const matchQuery = (g) => !q || (g.code.toLowerCase().includes(q) || g.name.toLowerCase().includes(q));
      const holdingFiltered = data.holdingWithInsight.filter(matchQuery);
      const nonHoldingFiltered = data.nonHoldingWithInsight.filter(matchQuery);
      const noInsightFiltered = data.noInsightHoldings.filter(h =>
        !q || (h.code?.toLowerCase().includes(q) || h.name?.toLowerCase().includes(q))
      );

      let html = '';

      // 1) 보유 종목 + 인사이트
      if (holdingFiltered.length > 0) {
        html += `<div style="font-size:13px;font-weight:700;color:#92400e;margin:4px 0 10px;display:flex;align-items:center;gap:6px;">
          ⭐ 보유 종목 중 인사이트 있음 <span style="font-weight:400;color:#9ca3af;">(${holdingFiltered.length})</span>
        </div>`;
        html += holdingFiltered.map(renderTickerCard).join('');
      }

      // 2) 비보유 + 인사이트
      if (nonHoldingFiltered.length > 0) {
        html += `<div style="font-size:13px;font-weight:700;color:#374151;margin:20px 0 10px;display:flex;align-items:center;gap:6px;">
          ⚪ 비보유 종목 중 언급됨 <span style="font-weight:400;color:#9ca3af;">(${nonHoldingFiltered.length})</span>
        </div>`;
        html += nonHoldingFiltered.map(renderTickerCard).join('');
      }

      // 3) 보유 + 인사이트 없음 (접혀있음)
      if (noInsightFiltered.length > 0) {
        html += `
          <details style="margin-top:24px;">
            <summary style="cursor:pointer;font-size:13px;color:#6b7280;padding:8px 0;">
              💬 인사이트가 없는 보유 종목 (${noInsightFiltered.length}) — 펼치기
            </summary>
            <div style="margin-top:8px;padding:12px;background:white;border:1px solid #e5e7eb;border-radius:8px;">
              ${noInsightFiltered.map(h => `
                <div style="padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px;color:#4b5563;">
                  <span style="font-weight:600;">${escapeHtml(h.name)}</span>
                  <span style="color:#9ca3af;font-size:12px;">(${escapeHtml(h.code)})</span>
                </div>
              `).join('')}
            </div>
          </details>
        `;
      }

      // 검색 결과 0
      if (q && holdingFiltered.length + nonHoldingFiltered.length + noInsightFiltered.length === 0) {
        html = `
          <div style="text-align:center;padding:60px 20px;color:#9ca3af;">
            <div style="font-size:36px;margin-bottom:12px;">🔍</div>
            <div style="font-size:14px;">"${escapeHtml(query)}" 검색 결과가 없습니다</div>
          </div>
        `;
      }

      body.innerHTML = html;

      // 카드 클릭 → 영상 목록 탭으로 이동하면서 필터링
      body.querySelectorAll('.p16t-ticker-card').forEach(card => {
        card.onclick = () => {
          const code = card.dataset.code;
          const name = card.dataset.name;
          // 영상 목록 화면 열고 종목 필터 적용
          tickerModalEl.remove();
          tickerModalEl = null;
          window.__phase16List.open();
          // 약간 지연 후 필터 입력
          setTimeout(() => {
            const filterInput = document.querySelector('#p16-filter-ticker');
            if (filterInput) {
              filterInput.value = code || name;
              filterInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }, 100);
        };
      });

    } catch (e) {
      body.innerHTML = `<div style="color:#dc2626;padding:20px;">조회 실패: ${escapeHtml(e.message)}</div>`;
      console.error('[Phase16-ticker] refresh 실패:', e);
    }
  }

  // ─────────────────────────────────────────────
  // 영상 목록 화면에 "종목별 보기" 탭 버튼 자동 주입
  // ─────────────────────────────────────────────
  function injectTabIntoList() {
    // phase16-list 모달이 열릴 때 헤더에 탭 버튼 추가
    const observer = new MutationObserver(() => {
      const listModal = document.getElementById('phase16-list-modal');
      if (!listModal) return;
      if (listModal.querySelector('#p16-tab-tickers')) return;  // 이미 있으면 패스

      const header = listModal.querySelector('h2');
      if (!header) return;

      // 헤더의 텍스트를 탭으로 변경
      const headerParent = header.parentElement;
      if (!headerParent || headerParent.querySelector('#p16-tab-bar')) return;

      // 헤더 위에 탭 바 추가
      const tabBar = document.createElement('div');
      tabBar.id = 'p16-tab-bar';
      tabBar.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
      tabBar.innerHTML = `
        <button id="p16-tab-videos-active" style="padding:7px 14px;border:1px solid #4a7eff;background:#4a7eff;color:white;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">📋 영상 목록</button>
        <button id="p16-tab-tickers" style="padding:7px 14px;border:1px solid #e5e7eb;background:white;color:#6b7280;border-radius:6px;cursor:pointer;font-size:13px;">🏷️ 종목별 보기</button>
      `;

      // 헤더 컨테이너 찾기 (제목 + 버튼들이 있는 div의 부모)
      const titleRow = header.closest('div');
      if (titleRow && titleRow.parentElement) {
        titleRow.parentElement.appendChild(tabBar);
        tabBar.querySelector('#p16-tab-tickers').onclick = () => {
          listModal.remove();
          openTickerView();
        };
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─────────────────────────────────────────────
  // 초기화
  // ─────────────────────────────────────────────
  async function init() {
    try {
      await waitForPhase16();
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`🏷️ Phase 16 종목별 보기 v${VERSION}`);
      console.log(`   사용: window.__phase16Ticker.open()`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      injectTabIntoList();
    } catch (e) {
      console.error('[Phase16-ticker] 초기화 실패:', e);
    }
  }

  window.__phase16Ticker = {
    version: VERSION,
    open: openTickerView,
    refresh: () => refreshTickerView('')
  };

  setTimeout(init, 4000);  // phase16-list (3.5초) 이후
})();
