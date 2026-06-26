/* ========================================
 * Phase 14 v1.0 - 자동 데이터 정합성 보정
 * - 앱 로드 시 자동 검사 및 보정
 * - 문자열 가격 → 숫자 변환
 * - 중복 스냅샷 자동 제거
 * - holdings ↔ snapshots 동기화
 * - 1시간 쿨다운
 * ======================================== */
(() => {
  if (window.__phase14) return;

  const VERSION = '1.0';
  const COOLDOWN_MS = 60 * 60 * 1000;

  const openDB = () => new Promise((res, rej) => {
    const req = indexedDB.open('StockJournalDB');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

  const inspect = async () => {
    const db = await openDB();
    const snapshots = await new Promise(r => {
      db.transaction('daily_snapshots').objectStore('daily_snapshots').getAll().onsuccess = e => r(e.target.result);
    });
    const holdings = await new Promise(r => {
      db.transaction('holdings').objectStore('holdings').getAll().onsuccess = e => r(e.target.result);
    });

    const issues = {
      stringPrices: [], duplicates: [], missingPrices: [],
      invalidQuantity: [], orphanSnapshots: [], staleHoldings: [],
    };

    for (const s of snapshots) {
      for (const field of ['currentPriceKRW', 'currentValueKRW', 'closePrice']) {
        if (typeof s[field] === 'string') {
          issues.stringPrices.push({ id: s.id, field, value: s[field] });
        }
      }
    }

    const groups = new Map();
    for (const s of snapshots) {
      const key = `${s.date}_${s.ticker}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    for (const [key, items] of groups) {
      if (items.length > 1) {
        issues.duplicates.push({ key, count: items.length, ids: items.map(i => i.id) });
      }
    }

    for (const s of snapshots) {
      const price = Number(s.currentPriceKRW);
      if (!price || price <= 0) {
        issues.missingPrices.push({ id: s.id, date: s.date, ticker: s.ticker });
      }
    }

    for (const s of snapshots) {
      const qty = Number(s.quantity);
      if (isNaN(qty) || qty < 0) {
        issues.invalidQuantity.push({ id: s.id, quantity: s.quantity });
      }
    }

    const tickers = new Set(holdings.map(h => h.ticker || h.symbol));
    for (const s of snapshots) {
      if (!tickers.has(s.ticker)) {
        issues.orphanSnapshots.push({ id: s.id, ticker: s.ticker });
      }
    }

    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    for (const h of holdings) {
      if (h.lastPriceUpdate) {
        const lastUpdate = new Date(h.lastPriceUpdate).getTime();
        if (now - lastUpdate > oneDayMs * 3) {
          issues.staleHoldings.push({
            ticker: h.ticker, name: h.name, lastUpdate: h.lastPriceUpdate
          });
        }
      }
    }

    return {
      issues,
      summary: {
        totalSnapshots: snapshots.length,
        totalHoldings: holdings.length,
        stringPrices: issues.stringPrices.length,
        duplicates: issues.duplicates.length,
        missingPrices: issues.missingPrices.length,
        invalidQuantity: issues.invalidQuantity.length,
        orphanSnapshots: issues.orphanSnapshots.length,
        staleHoldings: issues.staleHoldings.length,
      }
    };
  };

  const repair = async (options = {}) => {
    const { 
      fixStringPrices = true, removeDuplicates = true,
      syncHoldings = true, silent = false 
    } = options;

    if (!silent) console.log(`🔧 Phase 14 v${VERSION} 보정 시작...`);
    
    const db = await openDB();
    const stats = { stringFixed: 0, duplicatesRemoved: 0, holdingsSynced: 0 };

    if (fixStringPrices) {
      const all = await new Promise(r => {
        db.transaction('daily_snapshots').objectStore('daily_snapshots').getAll().onsuccess = e => r(e.target.result);
      });
      for (const s of all) {
        let updated = { ...s };
        let needsUpdate = false;
        for (const field of ['currentPriceKRW', 'currentValueKRW', 'closePrice']) {
          if (typeof s[field] === 'string') {
            const num = parseFloat(s[field].replace(/,/g, ''));
            if (!isNaN(num)) {
              updated[field] = num;
              needsUpdate = true;
            }
          }
        }
        if (needsUpdate) {
          await new Promise((res, rej) => {
            const tx = db.transaction('daily_snapshots', 'readwrite');
            const req = tx.objectStore('daily_snapshots').put(updated);
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
          });
          stats.stringFixed++;
        }
      }
      if (!silent && stats.stringFixed > 0) {
        console.log(`  ✅ 문자열→숫자 변환: ${stats.stringFixed}건`);
      }
    }

    if (removeDuplicates) {
      const all = await new Promise(r => {
        db.transaction('daily_snapshots').objectStore('daily_snapshots').getAll().onsuccess = e => r(e.target.result);
      });
      const groups = new Map();
      for (const s of all) {
        const key = `${s.date}_${s.ticker}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }
      for (const [key, items] of groups) {
        if (items.length <= 1) continue;
        items.sort((a, b) => {
          const score = (s) => {
            if (s.id?.endsWith('_auto')) return 3;
            if (s.source === 'phase13_backfill') return 1;
            return 2;
          };
          return score(b) - score(a);
        });
        for (const r of items.slice(1)) {
          await new Promise((res, rej) => {
            const tx = db.transaction('daily_snapshots', 'readwrite');
            const req = tx.objectStore('daily_snapshots').delete(r.id);
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
          });
          stats.duplicatesRemoved++;
        }
      }
      if (!silent && stats.duplicatesRemoved > 0) {
        console.log(`  ✅ 중복 제거: ${stats.duplicatesRemoved}건`);
      }
    }

    if (syncHoldings) {
      const allSnaps = await new Promise(r => {
        db.transaction('daily_snapshots').objectStore('daily_snapshots').getAll().onsuccess = e => r(e.target.result);
      });
      const holdings = await new Promise(r => {
        db.transaction('holdings').objectStore('holdings').getAll().onsuccess = e => r(e.target.result);
      });

      for (const h of holdings) {
        const ticker = h.ticker || h.symbol;
        const tickerSnaps = allSnaps
          .filter(s => s.ticker === ticker)
          .sort((a, b) => b.date.localeCompare(a.date));
        if (tickerSnaps.length === 0) continue;
        const latest = tickerSnaps[0];
        const newPrice = Number(latest.currentPriceKRW);
        if (!newPrice || newPrice <= 0) continue;
        const qty = Number(h.currentQuantity || 0);
        const totalBuy = Number(h.totalBuyAmountKRW || 0);
        const newValue = newPrice * qty;
        if (h.currentPrice !== newPrice) {
          const updated = {
            ...h,
            currentPrice: newPrice,
            currentValue: newValue,
            profitLoss: newValue - totalBuy,
            profitRate: totalBuy ? ((newValue - totalBuy) / totalBuy * 100) : 0,
            lastPriceUpdate: new Date().toISOString()
          };
          await new Promise((res, rej) => {
            const tx = db.transaction('holdings', 'readwrite');
            const req = tx.objectStore('holdings').put(updated);
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
          });
          stats.holdingsSynced++;
        }
      }
      if (!silent && stats.holdingsSynced > 0) {
        console.log(`  ✅ holdings 동기화: ${stats.holdingsSynced}건`);
      }
    }

    const totalFixed = stats.stringFixed + stats.duplicatesRemoved + stats.holdingsSynced;
    if (window.__phase11?.writeLog) {
      window.__phase11.writeLog({
        phase: '14',
        status: totalFixed > 0 ? 'fixed' : 'no-issue',
        message: `보정: 문자열 ${stats.stringFixed}, 중복 ${stats.duplicatesRemoved}, 동기화 ${stats.holdingsSynced}`
      });
    }

    if (totalFixed > 0 && window.__phase12?.push) {
      try {
        await window.__phase12.push();
        if (!silent) console.log('  ☁️ Firestore 동기화 완료');
      } catch (e) {
        if (!silent) console.warn('  ⚠️ Firestore 동기화 실패:', e.message);
      }
    }

    if (!silent) {
      if (totalFixed === 0) {
        console.log('  ✨ 정합성 완벽 — 보정할 항목 없음');
      } else {
        console.log(`\n✅ 보정 완료 (총 ${totalFixed}건 처리)`);
      }
    }

    return stats;
  };

  const autoRun = async () => {
    const lastRun = localStorage.getItem('phase14_last_run');
    const now = Date.now();
    if (lastRun && (now - parseInt(lastRun)) < COOLDOWN_MS) return;

    try {
      const result = await inspect();
      const totalIssues = result.summary.stringPrices 
        + result.summary.duplicates 
        + result.summary.missingPrices
        + result.summary.invalidQuantity;

      if (totalIssues === 0) {
        localStorage.setItem('phase14_last_run', now.toString());
        return;
      }

      console.log(`🔧 Phase 14: 정합성 이슈 ${totalIssues}건 감지, 자동 보정 시작...`);
      const stats = await repair({ silent: false });
      localStorage.setItem('phase14_last_run', now.toString());

      const totalFixed = stats.stringFixed + stats.duplicatesRemoved + stats.holdingsSynced;
      if (totalFixed > 0) showToast(`🔧 데이터 정합성 ${totalFixed}건 자동 보정 완료`);
    } catch (e) {
      console.warn('[Phase 14] 자동 실행 실패:', e.message);
    }
  };

  const showToast = (message) => {
    const toast = document.createElement('div');
    toast.style.cssText = `position:fixed;bottom:80px;right:20px;background:rgba(34,197,94,0.95);color:white;padding:12px 20px;border-radius:8px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.2);z-index:99999;opacity:0;transition:opacity 0.3s;`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  };

  window.__phase14 = { version: VERSION, inspect, repair, autoRun };

  const init = () => {
    // 앱 로드 10초 후 자동 검사/보정 (다른 Phase 초기화 완료 대기)
    setTimeout(() => { autoRun(); }, 10000);
    console.log(`✅ Phase 14 v${VERSION} 로드 완료`);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
