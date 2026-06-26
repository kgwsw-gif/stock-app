// phase15.js - 자동 복구 시스템 v1.2 (대시보드 후킹 + 상단 수치 정정)
(function() {
  const VERSION = '1.3';
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

  // ===== 1. 일자별 자산 계산 (공용) =====
  async function calcByDate() {
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
    return byDate;
  }

  // ===== 2. 차트 강제 패치 =====
  async function refreshAllCharts() {
    if (!window.Chart) return 0;
    const byDate = await calcByDate();
    let patched = 0;
    Object.values(Chart.instances).forEach(c => {
      const labels = c.data?.labels || [];
      if (!labels[0]?.startsWith?.('2026')) return;
      const dsLabel = c.data.datasets[0]?.label || '';
      if (c.config.type === 'line' && dsLabel.includes('자산')) {
        c.data.datasets[0].data = labels.map(d => byDate[d] || 0);
        patched++;
      } else if (c.config.type === 'line' && dsLabel.includes('수익률')) {
        c.data.datasets[0].data = labels.map(d => ((byDate[d] || 0) / START_ASSET - 1) * 100);
        patched++;
      } else if (c.config.type === 'bar' && dsLabel.includes('손익')) {
        const pnl = labels.map((d, i) => i === 0 ? 0 : (byDate[d] || 0) - (byDate[labels[i-1]] || 0));
        c.data.datasets[0].data = pnl;
        c.data.datasets[0].backgroundColor = pnl.map(v => v >= 0 ? '#e74c3c' : '#3498db');
        patched++;
      }
      c.update();
    });
    return patched;
  }

  // ===== 3. 상단 수치 박스 정정 (v1.2 신규) =====
  async function refreshTopStats() {
    const byDate = await calcByDate();
    const dates = Object.keys(byDate).sort();
    if (dates.length === 0) return;

    // 현재 활성 기간 필터 찾기 (1주/1개월/3개월/6개월/1년/전체)
    const activeBtn = document.querySelector('button.active, button.selected, [aria-pressed="true"]');
    const filterText = activeBtn?.textContent?.trim() || '1주';
    
    let periodDays = 7;
    if (filterText.includes('1개월')) periodDays = 30;
    else if (filterText.includes('3개월')) periodDays = 90;
    else if (filterText.includes('6개월')) periodDays = 180;
    else if (filterText.includes('1년')) periodDays = 365;
    else if (filterText.includes('전체')) periodDays = 99999;

    const lastDate = dates[dates.length - 1];
    const lastAsset = byDate[lastDate];
    
    // 기간 시작점 찾기
    const cutoff = new Date(lastDate);
    cutoff.setDate(cutoff.getDate() - periodDays);
    const periodDates = dates.filter(d => new Date(d) >= cutoff);
    const startDate = periodDates[0];
    const startAsset = byDate[startDate];

    // 기간 수익률
    const periodReturn = ((lastAsset - startAsset) / startAsset * 100).toFixed(2);

    // 일별 손익 계산
    const pnls = [];
    for (let i = 1; i < periodDates.length; i++) {
      pnls.push({
        date: periodDates[i],
        pnl: byDate[periodDates[i]] - byDate[periodDates[i-1]]
      });
    }

    const maxGain = pnls.reduce((a, b) => b.pnl > a.pnl ? b : a, { pnl: -Infinity, date: '' });
    const maxLoss = pnls.reduce((a, b) => b.pnl < a.pnl ? b : a, { pnl: Infinity, date: '' });
    const wins = pnls.filter(p => p.pnl > 0).length;
    const losses = pnls.filter(p => p.pnl < 0).length;
    const winRate = pnls.length > 0 ? (wins / pnls.length * 100).toFixed(1) : 0;

    // 누적 수익률 (시작자산 기준)
    const totalReturn = ((lastAsset / START_ASSET - 1) * 100).toFixed(2);

    // DOM에서 박스 찾아 갱신
    const boxes = document.querySelectorAll('[class*="stat"], [class*="card"], [class*="box"]');
    let updated = 0;
    boxes.forEach(box => {
      const text = box.textContent || '';
      // 기간 수익률 박스
      if (text.includes('기간 수익률') || text.includes('기간수익률')) {
        const valEl = box.querySelector('[class*="value"], [class*="number"], strong, b, h3, h4, .text-2xl, .text-xl, .text-lg');
        if (valEl) {
          valEl.textContent = `${periodReturn >= 0 ? '+' : ''}${periodReturn}%`;
          updated++;
        }
      }
      // 최고 수익일
      if (text.includes('최고 수익일') || text.includes('최고수익일')) {
        const valEls = box.querySelectorAll('[class*="value"], [class*="number"], strong, b, h3, h4, .text-2xl, .text-xl, .text-lg, span');
        valEls.forEach(el => {
          if (el.textContent.includes('₩')) {
            el.textContent = `+₩${maxGain.pnl.toLocaleString()}`;
          } else if (el.textContent.match(/\d{4}-\d{2}-\d{2}/)) {
            el.textContent = maxGain.date;
          }
        });
        updated++;
      }
      // 최대 손실일
      if (text.includes('최대 손실일') || text.includes('최대손실일')) {
        const valEls = box.querySelectorAll('[class*="value"], [class*="number"], strong, b, h3, h4, .text-2xl, .text-xl, .text-lg, span');
        valEls.forEach(el => {
          if (el.textContent.includes('₩')) {
            el.textContent = `₩${maxLoss.pnl.toLocaleString()}`;
          } else if (el.textContent.match(/\d{4}-\d{2}-\d{2}/)) {
            el.textContent = maxLoss.date;
          }
        });
        updated++;
      }
      // 승률
      if (text.includes('승률') && text.includes('%')) {
        const valEl = box.querySelector('[class*="value"], [class*="number"], strong, b, h3, h4, .text-2xl, .text-xl, .text-lg');
        if (valEl && valEl.textContent.includes('%')) {
          valEl.textContent = `${winRate}%`;
          updated++;
        }
      }
    });

    if (updated > 0) log(`상단 수치 ${updated}개 정정 (기간 ${periodReturn}%, 승률 ${winRate}%)`, 'ok');
  }

  // ===== 4. 대시보드 후킹 (v1.2 핵심) =====
  function installDashboardHook() {
    if (!window.showDashboardModal) {
      log('showDashboardModal 미발견 - 후킹 보류', 'warn');
      return false;
    }
    if (window.__p15_dashboard_hooked) {
      log('이미 후킹됨', 'info');
      return true;
    }
    window.__p15_dashboard_orig = window.showDashboardModal;
    window.showDashboardModal = async function(...args) {
      const result = await window.__p15_dashboard_orig(...args);
      // 100ms, 500ms, 1초, 2초 4회 정정 시도
      setTimeout(() => refreshAllCharts(), 100);
      setTimeout(() => refreshAllCharts(), 500);
      setTimeout(() => { refreshAllCharts(); refreshTopStats(); }, 1000);
      setTimeout(() => { refreshAllCharts(); refreshTopStats(); }, 2000);
      return result;
    };
    window.__p15_dashboard_hooked = true;
    log('대시보드 후킹 완료', 'ok');
    return true;
  }

  // ===== 5. 네이버 종가 백필 =====
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

  // ===== 6. 전일 복사본 탐지 =====
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

  // ===== 7. 특정 날짜 복구 =====
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

    if (window.__phase12?.push && window.__phase12?.auth?.currentUser) {
      try {
        await window.__phase12.push();
        log('Firestore Push 완료', 'ok');
      } catch (e) {
        log(`Firestore Push 실패: ${e.message}`, 'error');
      }
    }
    await refreshAllCharts();
    await refreshTopStats();
    return { success: true, updated };
  }

  // ===== 8. Phase 7 가드 =====
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

  // ===== 9. 자동 실행 =====
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
    refreshTopStats,
    calcByDate,
    autoRun,
    installPhase7Guard,
    installDashboardHook
  };

    // ===== 초기화 (v1.3 강화) =====
  function ensureDashboardHook() {
    if (!window.showDashboardModal) return false;
    
    // 후킹이 풀렸는지 검사 (다른 패치가 덮어쓴 경우)
    const isOurHook = window.showDashboardModal === window.__p15_dashboard_wrapper;
    
    if (!isOurHook) {
      // 후킹 다시 설치
      window.__p15_dashboard_hooked = false;
      const orig = window.showDashboardModal;
      window.__p15_dashboard_orig = orig;
      
      const wrapper = async function(...args) {
        const result = await window.__p15_dashboard_orig(...args);
        setTimeout(() => refreshAllCharts(), 100);
        setTimeout(() => refreshAllCharts(), 500);
        setTimeout(() => { refreshAllCharts(); refreshTopStats(); }, 1000);
        setTimeout(() => { refreshAllCharts(); refreshTopStats(); }, 2000);
        return result;
      };
      window.__p15_dashboard_wrapper = wrapper;
      window.showDashboardModal = wrapper;
      window.__p15_dashboard_hooked = true;
      log('대시보드 후킹 (재)설치 완료', 'ok');
      return true;
    }
    return true;
  }

  // 초기 설치 + 주기적 재후킹 (다른 패치가 덮어써도 자동 복구)
  setTimeout(() => {
    installPhase7Guard();
    ensureDashboardHook();
    setTimeout(autoRun, 5000);
    setInterval(autoRun, 60 * 60 * 1000);
    
    // 매 2초마다 후킹 상태 점검 (처음 30초 동안만)
    let checkCount = 0;
    const hookChecker = setInterval(() => {
      ensureDashboardHook();
      checkCount++;
      if (checkCount >= 15) clearInterval(hookChecker);  // 30초 후 중단
    }, 2000);
    
    // 그 이후엔 30초마다 점검
    setInterval(ensureDashboardHook, 30000);
    
    log(`Phase 15 v${VERSION} 초기화 완료`, 'ok');
  }, 3000);
})();

