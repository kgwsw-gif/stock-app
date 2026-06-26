// phase15.js - 자동 복구 시스템 v1.2 (대시보드 후킹 + 상단 수치 정정)
(function() {
const VERSION = '1.4';
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

  /**
 * v1.4: 당일손익 자동 보정
 * holdings에 prevClose 필드가 없어 당일손익이 ₩0으로 표시되는 문제를 해결.
 * daily_snapshots의 어제 자산 총액과 holdings의 오늘 총액을 비교하여 정확한 값 표시.
 */
async function refreshDailyPL() {
  try {
    const modal = document.querySelector('#dashboard-modal');
    if (!modal) return { ok: false, reason: 'modal_not_found' };

    // 어제 날짜 (YYYY-MM-DD)
    const today = new Date();
    const y = new Date(today.getTime() - 86400000);
    const ymd = y.getFullYear() + '-' +
      String(y.getMonth() + 1).padStart(2, '0') + '-' +
      String(y.getDate()).padStart(2, '0');

    // IndexedDB 조회
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('StockJournalDB');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });

    const snaps = await new Promise(res => {
      const r = db.transaction(['daily_snapshots'], 'readonly')
        .objectStore('daily_snapshots').getAll();
      r.onsuccess = () => res(r.result);
    });
    const holdings = await new Promise(res => {
      const r = db.transaction(['holdings'], 'readonly')
        .objectStore('holdings').getAll();
      r.onsuccess = () => res(r.result);
    });

    // 어제 자산이 없으면 가장 가까운 영업일 사용
    let yTotal = snaps.filter(s => s.date === ymd)
      .reduce((a, s) => a + (Number(s.currentValue) || Number(s.totalValue) || 0), 0);

    if (yTotal === 0) {
      // 최근 7일 내 가장 최근 스냅샷 사용
      const recent = snaps
        .filter(s => s.date < ymd)
        .sort((a, b) => b.date.localeCompare(a.date));
      if (recent.length > 0) {
        const latestDate = recent[0].date;
        yTotal = snaps.filter(s => s.date === latestDate)
          .reduce((a, s) => a + (Number(s.currentValue) || Number(s.totalValue) || 0), 0);
      }
    }

    const tTotal = holdings.filter(h => h.status !== 'closed')
      .reduce((a, h) => a + (Number(h.currentValue) || 0), 0);

    if (yTotal === 0) return { ok: false, reason: 'no_yesterday_data' };

    const pl = tTotal - yTotal;
    const rate = (pl / yTotal * 100);

    // 화면의 '당일손익 ₩0' 찾아서 교체
    let patched = 0;
    modal.querySelectorAll('*').forEach(el => {
      if (el.children.length > 0) return;
      const txt = el.textContent.trim();
      // ₩0 또는 +₩0 또는 이미 보정된 값 모두 대상
      if (!/^[+\-]?₩-?[\d,]+$/.test(txt)) return;
      const pt = el.parentElement?.textContent || '';
      if (pt.includes('당일') || pt.includes('금일')) {
        el.textContent = (pl >= 0 ? '+' : '') + '₩' + pl.toLocaleString();
        el.style.color = pl >= 0 ? '#e74c3c' : '#3498db';
        el.style.fontWeight = 'bold';
        patched++;
      }
    });

    if (patched > 0) {
      console.log(`[Phase15 v1.4] 당일손익 보정: ₩${pl.toLocaleString()} (${rate.toFixed(2)}%) - ${patched}곳`);
    }
    return { ok: true, pl, rate, patched, yTotal, tTotal };
  } catch (e) {
    console.warn('[Phase15 v1.4] refreshDailyPL 실패:', e.message);
    return { ok: false, error: e.message };
  }
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
    [100, 500, 1000, 2000].forEach(delay => {
      setTimeout(async () => {
        await refreshAllCharts();
        await refreshDailyPL();
      }, delay);
    });
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
    refreshDailyPL,
    calcByDate,
    autoRun,
    installPhase7Guard,
    installDashboardHook
  };

      // ===== 초기화 (v1.3 강화) =====
  function ensureDashboardHook() {
    if (!window.showDashboardModal) return false;
    const isOurHook = window.showDashboardModal === window.__p15_dashboard_wrapper;
    if (!isOurHook) {
      window.__p15_dashboard_hooked = false;
      const orig = window.showDashboardModal;
      window.__p15_dashboard_orig = orig;
      const wrapper = async function(...args) {
        const result = await window.__p15_dashboard_orig(...args);
            [100, 500, 1000, 2000].forEach(delay => {
      setTimeout(async () => {
        await refreshAllCharts();
        await refreshDailyPL();
      }, delay);
    });

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

  // 차트가 이미 열려있으면 즉시 갱신
  async function refreshIfDashboardOpen() {
    if (document.getElementById('dashboard-modal')) {
      const patched = await refreshAllCharts();
      await refreshTopStats();
      if (patched > 0) log(`초기 자동 갱신: 차트 ${patched}개 정정`, 'ok');
    }
  }

  setTimeout(() => {
    installPhase7Guard();
    ensureDashboardHook();
    
    // 앱 로드 직후 대시보드가 열려있으면 자동 갱신
    setTimeout(refreshIfDashboardOpen, 2000);
    setTimeout(refreshIfDashboardOpen, 4000);
    setTimeout(refreshIfDashboardOpen, 6000);
    
    setTimeout(autoRun, 5000);
    setInterval(autoRun, 60 * 60 * 1000);
    
    // 30초 동안 2초마다 후킹 점검 (다른 패치가 덮어쓸 수 있음)
    let checkCount = 0;
    const hookChecker = setInterval(() => {
      ensureDashboardHook();
      checkCount++;
      if (checkCount >= 15) clearInterval(hookChecker);
    }, 2000);
    setInterval(ensureDashboardHook, 30000);
    
    log(`Phase 15 v${VERSION} 초기화 완료`, 'ok');
  }, 3000);
})();
