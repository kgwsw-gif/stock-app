// phase15.js - 자동 복구 시스템 v1.1 (차트 자동 갱신 추가)
(function() {
  const VERSION = '1.1';
  const NAVER_DATE_RE = /<span[^>]*class="tah[^"]*"[^>]*>(\d{4}\.\d{2}\.\d{2})<\/span>[\s\S]{0,500}?<span[^>]*class="tah[^"]*"[^>]*>([\d,]+)<\/span>/g;
  const START_ASSET = 13530000;

  // ===== 유틸 =====
  const openDB = () => new Promise((res, rej) => {
    const r = indexedDB.open('StockJournalDB');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

  const getAll = async (storeName) => {
    const db = await openDB();
    return new Promise(res => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => res(req.result);
    });
  };

  const getQty = (h) => Number(h?.currentQuantity ?? h?.quantity ?? 0);
  const getPrice = (s) => Number(s?.currentPriceKRW ?? s?.closePrice ?? s?.currentPrice ?? 0);

  const log = (msg, level = 'info') => {
    const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'ok' ? '✅' : 'ℹ️';
    console.log(`[Phase15] ${tag} ${msg}`);
    if (window.__phase11?.writeLog) {
      window.__phase11.writeLog({ phase: 'phase15', level, message: msg });
    }
  };

  // ===== 1. 전일 복사본 탐지 =====
  async function detectDuplicateDays() {
    const snaps = await getAll('daily_snapshots');
    const dates = [...new Set(snaps.map(s => s.date))].sort().slice(-5);
    const issues = [];

    for (let i = 1; i < dates.length; i++) {
      const today = dates[i], yest = dates[i-1];
      const todaySnaps = snaps.filter(s => s.date === today);
      const yestSnaps = snaps.filter(s => s.date === yest);
      if (todaySnaps.length === 0 || todaySnaps.length !== yestSnaps.length) continue;

      let identical = 0;
      todaySnaps.forEach(t => {
        const y = yestSnaps.find(x => x.ticker === t.ticker);
        if (y && getPrice(t) === getPrice(y)) identical++;
      });

      if (identical === todaySnaps.length && todaySnaps.length >= 3) {
        issues.push({ date: today, prevDate: yest, count: identical });
        log(`전일 복사본 의심: ${today} (${yest}와 ${identical}종목 100% 동일)`, 'warn');
      }
    }
    return issues;
  }

  // ===== 2. 네이버 종가 백필 =====
  async function fetchNaverPrices(tickers) {
    const collected = {};
    for (const ticker of tickers) {
      try {
        const url = `https://finance.naver.com/item/sise_day.naver?code=${ticker}&page=1`;
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const html = new TextDecoder('euc-kr').decode(buf);
        const re = new RegExp(NAVER_DATE_RE.source, 'g');
        let m;
        while ((m = re.exec(html)) !== null) {
          const date = m[1].replace(/\./g, '-');
          const price = parseInt(m[2].replace(/,/g, ''));
          if (!collected[date]) collected[date] = {};
          collected[date][ticker] = price;
        }
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        log(`네이버 수집 실패 ${ticker}: ${e.message}`, 'error');
      }
    }
    return collected;
  }

  // ===== 3. 특정 날짜 복구 =====
  async function repairDate(targetDate) {
    log(`${targetDate} 복구 시작...`);
    const holdings = await getAll('holdings');
    const tickers = holdings.map(h => h.ticker);
    const collected = await fetchNaverPrices(tickers);

    if (!collected[targetDate]) {
      log(`${targetDate} 네이버 데이터 없음 (휴장일 가능)`, 'warn');
      return { success: false, reason: 'no_data' };
    }

    const db = await openDB();
    const tx = db.transaction('daily_snapshots', 'readwrite');
    const store = tx.objectStore('daily_snapshots');
    const prices = collected[targetDate];
    let updated = 0;

    for (const [ticker, price] of Object.entries(prices)) {
      const h = holdings.find(x => x.ticker === ticker);
      if (!h) continue;
      const qty = getQty(h);
      const ymd = targetDate.replace(/-/g, '');
      store.put({
        id: `s_${ymd}_${ticker}`,
        date: targetDate, ticker, name: h.name,
        currentPriceKRW: price, closePrice: price, currentPrice: price,
        quantity: qty, currentQuantity: qty,
        avgBuyPriceKRW: h.avgBuyPriceKRW,
        currentValueKRW: price * qty, currentValue: price * qty,
        currency: 'KRW',
        source: 'phase15_auto_repair',
        _updatedAt: new Date().toISOString()
      });
      updated++;
    }
    await new Promise(res => { tx.oncomplete = res; });
    log(`${targetDate} ${updated}건 복구 완료`, 'ok');

    // Firestore Push
    if (window.__phase12?.push && window.__phase12?.auth?.currentUser) {
      try {
        await window.__phase12.push();
        log('Firestore Push 완료', 'ok');
      } catch (e) {
        log(`Firestore Push 실패: ${e.message}`, 'error');
      }
    }

    // 차트 자동 갱신 (v1.1 신규)
    await refreshAllCharts();

    return { success: true, updated };
  }

  // ===== 4. 차트 강제 갱신 (v1.1 신규) =====
  async function refreshAllCharts() {
    if (!window.Chart) return;
    const snaps = await getAll('daily_snapshots');
    const holdings = await getAll('holdings');
    const byDate = {};
    snaps.forEach(s => {
      const h = holdings.find(x => x.ticker === s.ticker);
      if (!h) return;
      const qty = getQty(h);
      const price = getPrice(s);
      if (!byDate[s.date]) byDate[s.date] = 0;
      byDate[s.date] += price * qty;
    });

    let updated = 0;
    Object.values(Chart.instances).forEach(c => {
      const labels = c.data?.labels || [];
      if (!labels[0]?.startsWith?.('2026')) return;
      const dsLabel = c.data.datasets[0]?.label || '';

      if (c.config.type === 'line' && dsLabel.includes('자산')) {
        c.data.datasets[0].data = labels.map(d => byDate[d] || 0);
        updated++;
      } else if (c.config.type === 'line' && dsLabel.includes('수익률')) {
        c.data.datasets[0].data = labels.map(d => ((byDate[d] || 0) / START_ASSET - 1) * 100);
        updated++;
      } else if (c.config.type === 'bar' && dsLabel.includes('손익')) {
        const pnl = labels.map((d, i) => i === 0 ? 0 : (byDate[d] || 0) - (byDate[labels[i-1]] || 0));
        c.data.datasets[0].data = pnl;
        c.data.datasets[0].backgroundColor = pnl.map(v => v >= 0 ? '#e74c3c' : '#3498db');
        updated++;
      }
      c.update();
    });
    if (updated > 0) log(`차트 ${updated}개 갱신 완료`, 'ok');
  }

  // ===== 5. Phase 7 가드 =====
  function installPhase7Guard() {
    if (!window.__phase7?.run) {
      log('Phase 7 미발견 - 가드 설치 보류', 'warn');
      return false;
    }
    if (window.__phase7.__p15_guarded) return true;

    const origRun = window.__phase7.run.bind(window.__phase7);
    window.__phase7.run = async function(...args) {
      const result = await origRun(...args);

      const today = new Date().toISOString().slice(0, 10);
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const yesterday = d.toISOString().slice(0, 10);

      const afterSnaps = await getAll('daily_snapshots');
      const todayAfter = afterSnaps.filter(s => s.date === today);
      const yestAfter = afterSnaps.filter(s => s.date === yesterday);

      if (todayAfter.length >= 3 && todayAfter.length === yestAfter.length) {
        let identical = 0;
        todayAfter.forEach(t => {
          const y = yestAfter.find(x => x.ticker === t.ticker);
          if (y && getPrice(t) === getPrice(y)) identical++;
        });
        if (identical === todayAfter.length) {
          log(`Phase 7 입력값이 전일과 100% 동일 - 롤백 및 백필 트리거`, 'warn');
          const db = await openDB();
          const tx = db.transaction('daily_snapshots', 'readwrite');
          const store = tx.objectStore('daily_snapshots');
          todayAfter.forEach(s => store.delete(s.id));
          await new Promise(res => { tx.oncomplete = res; });
          await repairDate(today);
        }
      }
      return result;
    };
    window.__phase7.__p15_guarded = true;
    log('Phase 7 가드 설치 완료', 'ok');
    return true;
  }

  // ===== 6. 자동 실행 =====
  let lastAutoRun = 0;
  async function autoRun() {
    const now = Date.now();
    if (now - lastAutoRun < 60 * 60 * 1000) {
      log('쿨다운 중 (1시간) - autoRun 스킵');
      return;
    }
    lastAutoRun = now;

    log('자동 정합성 점검 시작');
    const issues = await detectDuplicateDays();
    if (issues.length === 0) {
      log('전일 복사본 없음 - 데이터 정상', 'ok');
      // 그래도 차트는 갱신 (DB와 동기화)
      await refreshAllCharts();
      return;
    }

    for (const issue of issues) {
      log(`${issue.date} 자동 복구 시도...`);
      await repairDate(issue.date);
    }
    log(`총 ${issues.length}일 복구 완료`, 'ok');
  }

  // ===== 공개 API =====
  window.__phase15 = {
    version: VERSION,
    detectDuplicateDays,
    repairDate,
    fetchNaverPrices,
    refreshAllCharts,
    autoRun,
    installPhase7Guard
  };

  // ===== 초기화 =====
  setTimeout(() => {
    installPhase7Guard();
    setTimeout(autoRun, 5000);
    setInterval(autoRun, 60 * 60 * 1000);
    log(`Phase 15 v${VERSION} 초기화 완료`, 'ok');
  }, 3000);
})();
