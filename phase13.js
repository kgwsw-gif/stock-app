/* ========================================
 * Phase 13 v1.3 - 자동 백필 (수정판)
 * - UI 호환 필드명 (currentPriceKRW)
 * - 숫자 타입 보장
 * - 중복 방지 강화
 * ======================================== */
(() => {
  if (window.__phase13) return;

  const VERSION = '1.3';
  const BACKFILL_DAYS = 90;
  const REQUEST_DELAY = 250;
  const MAX_PAGES = 12;
  const COOLDOWN_MS = 6 * 60 * 60 * 1000;

  const HOLIDAYS_2026 = new Set([
    '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18',
    '2026-03-02', '2026-05-01', '2026-05-05', '2026-05-25',
    '2026-06-03', '2026-06-06', '2026-08-17', '2026-09-24',
    '2026-09-25', '2026-09-26', '2026-10-05', '2026-10-09',
    '2026-12-25', '2026-12-31',
  ]);

  const openDB = () => new Promise((res, rej) => {
    const req = indexedDB.open('StockJournalDB');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

  const isBusinessDay = (date) => {
    const day = date.getDay();
    if (day === 0 || day === 6) return false;
    return !HOLIDAYS_2026.has(date.toISOString().slice(0, 10));
  };

  const getBusinessDays = (days) => {
    const result = [];
    const today = new Date();
    for (let i = 1; i <= days * 1.5; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      if (isBusinessDay(d)) result.push(d.toISOString().slice(0, 10));
      if (result.length >= days) break;
    }
    return result;
  };

  const fetchAllPagesForTicker = async (ticker) => {
    const priceMap = new Map();
    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const url = `https://finance.naver.com/item/sise_day.naver?code=${ticker}&page=${page}`;
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const decoded = new TextDecoder('euc-kr').decode(buffer);
        const parser = new DOMParser();
        const doc = parser.parseFromString(decoded, 'text/html');
        const rows = doc.querySelectorAll('table.type2 tr');
        let foundInPage = 0;
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length < 2) continue;
          const dateText = cells[0]?.textContent?.trim();
          if (!dateText || !/^\d{4}\.\d{2}\.\d{2}$/.test(dateText)) continue;
          const closeText = cells[1]?.textContent?.trim().replace(/,/g, '');
          const close = parseInt(closeText);
          if (isNaN(close) || close <= 0) continue;
          priceMap.set(dateText.replace(/\./g, '-'), close);
          foundInPage++;
        }
        if (foundInPage === 0) break;
        await new Promise(r => setTimeout(r, REQUEST_DELAY));
      } catch (e) {
        console.warn(`[Phase 13] ${ticker} page ${page} 실패:`, e.message);
        break;
      }
    }
    return priceMap;
  };

  const analyzeMissing = async () => {
    const db = await openDB();
    const tx = db.transaction(['daily_snapshots', 'holdings'], 'readonly');
    const holdings = await new Promise((res) => {
      const req = tx.objectStore('holdings').getAll();
      req.onsuccess = () => res(req.result);
    });
    const snapshots = await new Promise((res) => {
      const req = tx.objectStore('daily_snapshots').getAll();
      req.onsuccess = () => res(req.result);
    });
    const businessDays = getBusinessDays(BACKFILL_DAYS);
    const missingByTicker = new Map();
    for (const date of businessDays) {
      for (const holding of holdings) {
        const ticker = holding.ticker || holding.symbol;
        const exists = snapshots.some(s => 
          s.date === date && 
          (s.ticker === ticker || s.holdingId === holding.id)
        );
        if (!exists) {
          if (!missingByTicker.has(ticker)) missingByTicker.set(ticker, []);
          missingByTicker.get(ticker).push({ date, holding });
        }
      }
    }
    return { missingByTicker, holdings, totalDays: businessDays.length };
  };

  const runBackfill = async (options = {}) => {
    const { silent = false } = options;
    if (!silent) console.log(`🔄 Phase 13 v${VERSION} 백필 시작...`);
    const { missingByTicker, holdings } = await analyzeMissing();
    const totalMissing = [...missingByTicker.values()].reduce((s, a) => s + a.length, 0);
    if (!silent) console.log(`📊 보유 ${holdings.length}종목, 누락 ${totalMissing}건`);
    if (totalMissing === 0) {
      if (!silent) console.log('✅ 누락 데이터 없음');
      return { added: 0, failed: 0 };
    }
    let added = 0, failed = 0;
    const db = await openDB();
    const tickerEntries = [...missingByTicker.entries()];
    for (let i = 0; i < tickerEntries.length; i++) {
      const [ticker, items] = tickerEntries[i];
      const sampleName = items[0].holding.name;
      if (!silent) console.log(`[${i+1}/${tickerEntries.length}] ${sampleName} (${ticker}) - 누락 ${items.length}건`);
      const priceMap = await fetchAllPagesForTicker(ticker);
      for (const { date, holding } of items) {
        const close = priceMap.get(date);
        if (typeof close === 'number' && close > 0) {
          const quantity = Number(holding.currentQuantity || holding.quantity || 0);
          const avgBuyKRW = Number(holding.avgBuyPriceKRW || holding.avgBuyPriceOriginal || 0);
          const closeNum = Number(close);
          
          // ⭐ UI 호환 필드명 + 숫자 타입 보장
          const snapshot = {
            id: `s_${date.replace(/-/g, '')}_${ticker}_backfill`,
            date, ticker,
            name: holding.name,
            holdingId: holding.id,
            currentPriceKRW: closeNum,
            currentValueKRW: closeNum * quantity,
            quantity,
            avgBuyPriceKRW: avgBuyKRW,
            exchangeRate: 1,
            currency: 'KRW',
            source: 'phase13_backfill',
            createdAt: new Date().toISOString()
          };
          try {
            const tx = db.transaction('daily_snapshots', 'readwrite');
            await new Promise((res, rej) => {
              const req = tx.objectStore('daily_snapshots').put(snapshot);
              req.onsuccess = () => res();
              req.onerror = () => rej(req.error);
            });
            added++;
          } catch (e) { failed++; }
        } else { failed++; }
      }
    }
    if (!silent) console.log(`✅ 백필 완료: 추가 ${added}건, 실패 ${failed}건`);
    if (window.__phase11?.writeLog) {
      window.__phase11.writeLog({
        phase: '13',
        status: added > 0 ? 'success' : 'no-data',
        message: `백필 v${VERSION}: ${added}건 추가, ${failed}건 실패`
      });
    }
    if (added > 0 && window.__phase12?.push) {
      try {
        await window.__phase12.push();
        if (!silent) console.log('☁️ Firestore 동기화 완료');
      } catch (e) {
        console.warn('⚠️ Firestore 동기화 실패:', e.message);
      }
    }
    return { added, failed };
  };

  const autoRun = async () => {
    const lastRun = localStorage.getItem('phase13_last_run');
    const now = Date.now();
    if (lastRun && (now - parseInt(lastRun)) < COOLDOWN_MS) return;
    try {
      const { missingByTicker } = await analyzeMissing();
      const total = [...missingByTicker.values()].reduce((s, a) => s + a.length, 0);
      if (total === 0) {
        localStorage.setItem('phase13_last_run', now.toString());
        return;
      }
      console.log(`🔄 Phase 13 자동 백필 시작 (누락 ${total}건)...`);
      const result = await runBackfill({ silent: false });
      localStorage.setItem('phase13_last_run', now.toString());
      if (result.added > 0) {
        showToast(`📊 누락 데이터 ${result.added}건 자동 보완 완료`);
      }
    } catch (e) {
      console.warn('[Phase 13] 자동 실행 실패:', e.message);
    }
  };

  const showToast = (message) => {
    const toast = document.createElement('div');
    toast.style.cssText = `position:fixed;bottom:80px;right:20px;background:rgba(59,130,246,0.95);color:white;padding:12px 20px;border-radius:8px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.2);z-index:99999;opacity:0;transition:opacity 0.3s;`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  };

  const injectButton = () => {
    if (document.getElementById('phase13-backfill-btn')) return;
    const referenceBtn = document.querySelector('[data-phase11-btn]') 
      || [...document.querySelectorAll('button')].find(b => b.textContent.includes('모니터링') || b.textContent.includes('클라우드'));
    if (!referenceBtn) { setTimeout(injectButton, 1000); return; }
    const btn = referenceBtn.cloneNode(false);
    btn.id = 'phase13-backfill-btn';
    btn.removeAttribute('data-phase11-btn');
    btn.innerHTML = '🔄 데이터 보완';
    btn.addEventListener('click', async (e) => {
      e.stopImmediatePropagation();
      if (!confirm('최근 90일 누락 데이터를 자동으로 보완합니다.\n진행하시겠습니까?')) return;
      btn.disabled = true;
      const originalText = btn.innerHTML;
      btn.innerHTML = '⏳ 진행 중...';
      try {
        const result = await runBackfill();
        alert(`✅ 데이터 보완 완료\n\n추가: ${result.added}건\n실패: ${result.failed}건`);
      } catch (err) {
        alert(`❌ 오류: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    }, true);
    referenceBtn.parentNode.insertBefore(btn, referenceBtn.nextSibling);
  };

  window.__phase13 = {
    version: VERSION,
    analyzeMissing, runBackfill, autoRun,
    fetchAllPagesForTicker, getBusinessDays, HOLIDAYS_2026
  };

  const init = () => {
    injectButton();
    setTimeout(() => { autoRun(); }, 5000);
    console.log(`✅ Phase 13 v${VERSION} 로드 완료`);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
