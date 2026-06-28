// phase15.js - 자동 복구 시스템 v1.7.6 (휴장일 자동 청소 + 기간 버튼 active 감지 강화)
(function() {
  const VERSION = '1.7.6';
  const NAVER_DATE_RE = /<span[^>]*class="tah[^"]*"[^>]*>(\d{4}\.\d{2}\.\d{2})<\/span>[\s\S]{0,500}?<span[^>]*class="tah[^"]*"[^>]*>([\d,]+)<\/span>/g;
  const START_ASSET = 13530000;
  const MODAL_SELECTORS = '#dashboard-modal, #validation-dashboard, #chart-modal';

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
    console.log('[Phase15] ' + tag + ' ' + msg);
    if (window.__phase11?.writeLog) {
      window.__phase11.writeLog({ phase: 'phase15', level, message: msg });
    }
  };

  // ===== 1. 일자별 자산 계산 (보간 포함) =====
  async function calcByDate(targetDates = null) {
    const snaps = await getAll('daily_snapshots');
    const holdings = await getAll('holdings');
    const byDate = {};
    
    const priceByTicker = {};
    snaps.forEach(s => {
      if (!priceByTicker[s.ticker]) priceByTicker[s.ticker] = {};
      priceByTicker[s.ticker][s.date] = getPrice(s);
    });
    
    const allDates = targetDates || [...new Set(snaps.map(s => s.date))].sort();
    
    allDates.forEach(date => {
      let total = 0;
      holdings.forEach(h => {
        const qty = getQty(h);
        if (qty === 0) return;
        const prices = priceByTicker[h.ticker] || {};
        let price = prices[date];
        if (!price) {
          const earlierDates = Object.keys(prices).filter(d => d < date).sort();
          if (earlierDates.length > 0) {
            price = prices[earlierDates[earlierDates.length - 1]];
          }
        }
        if (price) total += price * qty;
      });
      byDate[date] = total;
    });
    return byDate;
  }

  // ===== 2. 차트 강제 패치 =====
  async function refreshAllCharts() {
    if (!window.Chart) return 0;
    const canvases = document.querySelectorAll('canvas[id^="chart-"]');
    if (canvases.length === 0) return 0;
    
    const allCharts = [];
    canvases.forEach(canvas => {
      const chart = Chart.getChart?.(canvas);
      if (chart) allCharts.push(chart);
    });
    if (allCharts.length === 0) return 0;
    
    const allDateLabels = new Set();
    allCharts.forEach(c => {
      const labels = c.data?.labels || [];
      labels.forEach(l => {
        if (typeof l === 'string' && /^2\d{3}-\d{2}-\d{2}$/.test(l)) {
          allDateLabels.add(l);
        }
      });
    });
    
    const byDate = await calcByDate([...allDateLabels]);
    cachedByDate = byDate;
    cachedTimestamp = Date.now();
    
    let patched = 0;
    allCharts.forEach(c => {
      const canvasId = c.canvas?.id || '';
      const labels = c.data?.labels || [];
      const isDateChart = labels[0]?.match?.(/^2\d{3}-\d{2}-\d{2}$/);
      if (!isDateChart) return;
      
      if (canvasId === 'chart-total') {
        c.data.datasets[0].data = labels.map(d => byDate[d] || 0);
        patched++;
      } else if (canvasId === 'chart-profit') {
        const pnl = labels.map((d, i) => {
          if (i === 0) return 0;
          const today = byDate[d] || 0;
          const yest = byDate[labels[i-1]] || 0;
          if (today === 0 || yest === 0) return 0;
          return today - yest;
        });
        c.data.datasets[0].data = [...pnl];
        c.data.datasets[0].backgroundColor = pnl.map(v => v >= 0 ? '#e74c3c' : '#3498db');
        c.data.datasets[0].borderColor = pnl.map(v => v >= 0 ? '#e74c3c' : '#3498db');
        patched++;
      } else if (canvasId === 'chart-cumreturn') {
        c.data.datasets[0].data = labels.map(d => {
          const v = byDate[d] || 0;
          return v ? ((v / START_ASSET - 1) * 100) : 0;
        });
        patched++;
      }
      c.update();
    });
    return patched;
  }

  // ===== 2-2. Chart.js 생성자 후킹 =====
  let chartConstructorHooked = false;
  let cachedByDate = null;
  let cachedTimestamp = 0;
  
  async function getByDate(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedByDate && (now - cachedTimestamp < 10000)) {
      return cachedByDate;
    }
    cachedByDate = await calcByDate();
    cachedTimestamp = now;
    return cachedByDate;
  }
  
  function patchChartInstance(chart) {
    try {
      const canvasId = chart?.canvas?.id || '';
      if (!canvasId.startsWith('chart-')) return false;
      const labels = chart.data?.labels || [];
      const isDateChart = labels[0] && /^2\d{3}-\d{2}-\d{2}$/.test(labels[0]);
      if (!isDateChart) return false;
      
      const byDate = cachedByDate;
      if (!byDate) return false;
      
      let patched = false;
      if (canvasId === 'chart-total') {
        chart.data.datasets[0].data = labels.map(d => byDate[d] || 0);
        patched = true;
      } else if (canvasId === 'chart-profit') {
        const pnl = labels.map((d, i) => {
          if (i === 0) return 0;
          const today = byDate[d] || 0;
          const yest = byDate[labels[i-1]] || 0;
          if (today === 0 || yest === 0) return 0;
          return today - yest;
        });
        chart.data.datasets[0].data = pnl;
        chart.data.datasets[0].backgroundColor = pnl.map(v => v >= 0 ? '#e74c3c' : '#3498db');
        patched = true;
      } else if (canvasId === 'chart-cumreturn') {
        chart.data.datasets[0].data = labels.map(d => {
          const v = byDate[d] || 0;
          return v ? ((v / START_ASSET - 1) * 100) : 0;
        });
        patched = true;
      }
      return patched;
    } catch (e) {
      console.warn('[Phase15] patchChartInstance 실패:', e.message);
      return false;
    }
  }
  
  function hookChartConstructor() {
    if (chartConstructorHooked) return true;
    if (!window.Chart) return false;
    
    const OrigChart = window.Chart;
    
    function HookedChart(ctx, config) {
      const instance = new OrigChart(ctx, config);
      getByDate().then(() => {
        if (patchChartInstance(instance)) {
          instance.update('none');
          log('Chart 생성 직후 정정: #' + (instance.canvas?.id || '?'), 'ok');
        }
      });
      return instance;
    }
    
    Object.setPrototypeOf(HookedChart, OrigChart);
    Object.keys(OrigChart).forEach(key => {
      try { HookedChart[key] = OrigChart[key]; } catch(e) {}
    });
    HookedChart.prototype = OrigChart.prototype;
    HookedChart.__p15_orig = OrigChart;
    
    window.Chart = HookedChart;
    chartConstructorHooked = true;
    log('Chart.js 생성자 후킹 완료', 'ok');
    return true;
  }

  // ===== 2-3. 당일손익 자동 보정 =====
  async function refreshDailyPL() {
    try {
      const modal = document.querySelector(MODAL_SELECTORS);
      if (!modal) return { ok: false, reason: 'modal_not_found' };

      const t = new Date();
      const y = new Date(t.getTime() - 86400000);
      const ymd = y.getFullYear() + '-' +
        String(y.getMonth() + 1).padStart(2, '0') + '-' +
        String(y.getDate()).padStart(2, '0');

      const snaps = await getAll('daily_snapshots');
      const holdings = await getAll('holdings');

      let yTotal = snaps.filter(s => s.date === ymd)
        .reduce((a, s) => a + (Number(s.currentValue) || Number(s.totalValue) || 0), 0);

      if (yTotal === 0) {
        const recent = snaps.filter(s => s.date < ymd)
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

      let patched = 0;
      modal.querySelectorAll('*').forEach(el => {
        if (el.children.length > 0) return;
        const txt = el.textContent.trim();
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
        log('당일손익 보정: ₩' + pl.toLocaleString() + ' (' + rate.toFixed(2) + '%) - ' + patched + '곳', 'ok');
      }
      return { ok: true, pl, rate, patched, yTotal, tTotal };
    } catch (e) {
      console.warn('[Phase15] refreshDailyPL 실패:', e.message);
      return { ok: false, error: e.message };
    }
  }

  // ===== 3. 상단 수치 박스 정정 (v1.7.3: 인라인 스타일 박스 지원) =====
  async function refreshTopStats() {
    const byDate = await calcByDate();
    const dates = Object.keys(byDate).sort();
    if (dates.length === 0) return 0;

        // v1.7.6: active 버튼 감지 강화 (인라인 스타일 + class + aria 모두 지원)
    const periodLabels = ['1주', '1개월', '3개월', '6개월', '1년', '전체'];
    let filterText = '1주';
    
    // 우선순위 1: chart-modal 내 버튼 중 인라인 스타일이 active처럼 보이는 것
    const modalButtons = document.querySelectorAll('#chart-modal button, #dashboard-modal button');
    for (const btn of modalButtons) {
      const txt = btn.textContent.trim();
      if (!periodLabels.includes(txt)) continue;
      const style = btn.getAttribute('style') || '';
      const cls = btn.className || '';
      // active 판정: background에 색상 지정 or active/selected class or aria-pressed
      const hasActiveBg = /background[^;]*:\s*(?!transparent|none|white|#fff|rgb\(255)/i.test(style);
      const hasActiveClass = /active|selected|on\b/i.test(cls);
      const hasAriaPressed = btn.getAttribute('aria-pressed') === 'true';
      if (hasActiveBg || hasActiveClass || hasAriaPressed) {
        filterText = txt;
        break;
      }
    }
    
    let periodDays = 7;
    if (filterText.includes('1개월')) periodDays = 30;
    else if (filterText.includes('3개월')) periodDays = 90;
    else if (filterText.includes('6개월')) periodDays = 180;
    else if (filterText.includes('1년')) periodDays = 365;
    else if (filterText.includes('전체')) periodDays = 99999;

    const lastDate = dates[dates.length - 1];
    const lastAsset = byDate[lastDate];
    
    const cutoff = new Date(lastDate);
    cutoff.setDate(cutoff.getDate() - periodDays);
    const periodDates = dates.filter(d => new Date(d) >= cutoff);
    const startDate = periodDates[0];
    const startAsset = byDate[startDate];

    const periodReturn = ((lastAsset - startAsset) / startAsset * 100);

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
    const losses = pnls.length - wins;
    const winRate = pnls.length > 0 ? (wins / pnls.length * 100) : 0;

    // 인라인 스타일 박스를 라벨 텍스트로 찾기
    const findBoxByLabel = (labelText) => {
      const all = document.querySelectorAll('div');
      for (const div of all) {
        const labelChild = Array.from(div.children).find(c => 
          c.tagName === 'DIV' && c.textContent.includes(labelText) && c.textContent.length < 50
        );
        if (labelChild) return div;
      }
      return null;
    };

    let updated = 0;

    // 1) 기간 수익률
    const periodBox = findBoxByLabel('기간 수익률');
    if (periodBox && periodBox.children.length >= 2 && isFinite(periodReturn)) {
      const valueDiv = periodBox.children[1];
      const detailDiv = periodBox.children[2];
      const sign = periodReturn >= 0 ? '+' : '';
      valueDiv.textContent = sign + periodReturn.toFixed(2) + '%';
      valueDiv.style.color = periodReturn >= 0 ? '#e74c3c' : '#3498db';
      if (detailDiv) {
        detailDiv.textContent = '₩' + startAsset.toLocaleString() + ' → ₩' + lastAsset.toLocaleString();
      }
      updated++;
    }

    // 2) 최고 수익일
    const maxGainBox = findBoxByLabel('최고 수익일');
    if (maxGainBox && maxGainBox.children.length >= 2 && isFinite(maxGain.pnl)) {
      const valueDiv = maxGainBox.children[1];
      const detailDiv = maxGainBox.children[2];
      valueDiv.textContent = '+₩' + maxGain.pnl.toLocaleString();
      valueDiv.style.color = '#e74c3c';
      if (detailDiv) detailDiv.textContent = maxGain.date;
      updated++;
    }

    // 3) 최대 손실일
    const maxLossBox = findBoxByLabel('최대 손실일');
    if (maxLossBox && maxLossBox.children.length >= 2 && isFinite(maxLoss.pnl)) {
      const valueDiv = maxLossBox.children[1];
      const detailDiv = maxLossBox.children[2];
      valueDiv.textContent = '₩' + maxLoss.pnl.toLocaleString();
      valueDiv.style.color = '#3498db';
      if (detailDiv) detailDiv.textContent = maxLoss.date;
      updated++;
    }

    // 4) 승률
    const winBox = findBoxByLabel('승률');
    if (winBox && winBox.children.length >= 2 && pnls.length > 0) {
      const valueDiv = winBox.children[1];
      const detailDiv = winBox.children[2];
      valueDiv.textContent = winRate.toFixed(1) + '%';
      if (detailDiv) detailDiv.textContent = '수익 ' + wins + '일 / 손실 ' + losses + '일';
      updated++;
    }

    if (updated > 0) log('상단 수치 ' + updated + '개 정정 (기간 ' + periodReturn.toFixed(2) + '%, 승률 ' + winRate.toFixed(1) + '%)', 'ok');
    return updated;
  }

  // ===== 4. 대시보드 후킹 (v1.7.4: refreshTopStats 자동 호출 추가) =====
  function hookFunction(funcName) {
    const orig = window[funcName];
    if (typeof orig !== 'function') return false;
    if (orig.__p15_hooked) return true;
    
    const wrapper = async function(...args) {
      hookChartConstructor();
      await getByDate(true);
      
      const result = await orig.apply(this, args);
      
      [50, 200, 500, 1000, 2000, 3000].forEach(delay => {
        setTimeout(async () => {
          await refreshAllCharts();
          await refreshDailyPL();
          await refreshTopStats();
        }, delay);
      });
      return result;
    };
    wrapper.__p15_hooked = true;
    wrapper.__p15_orig = orig;
    window[funcName] = wrapper;
    log(funcName + ' 후킹 완료', 'ok');
    return true;
  }
  
  function installDashboardHook() {
    let success = 0;
    if (hookFunction('showDashboardModal')) success++;
    if (hookFunction('showValidationDashboard')) success++;
    return success > 0;
  }

  function ensureDashboardHook() {
    let ok = false;
    ['showDashboardModal', 'showValidationDashboard'].forEach(fn => {
      if (typeof window[fn] === 'function' && !window[fn].__p15_hooked) {
        hookFunction(fn);
        ok = true;
      } else if (window[fn]?.__p15_hooked) {
        ok = true;
      }
    });
    return ok;
  }

  // ===== 4-2. 기간 버튼 클릭 감지 (1주/1개월/3개월 전환 시 자동 재계산) =====
  let periodButtonsHooked = false;
  function installPeriodButtonHook() {
    if (periodButtonsHooked) return;
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const text = btn.textContent.trim();
      if (!/^(1주|1개월|3개월|6개월|1년|전체)$/.test(text)) return;
      // 약간 대기 후 재계산 (active 상태가 갱신되도록)
      setTimeout(async () => {
        await refreshTopStats();
      }, 100);
      setTimeout(async () => {
        await refreshAllCharts();
        await refreshTopStats();
      }, 500);
    }, true);
    periodButtonsHooked = true;
    log('기간 버튼 클릭 감지 설치 완료', 'ok');
  }

  // ===== 5. 네이버 종가 백필 =====
  async function fetchNaverPrices(tickers) {
    const collected = {};
    for (const ticker of tickers) {
      try {
        const url = 'https://finance.naver.com/item/sise_day.naver?code=' + ticker + '&page=1';
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
        log('네이버 수집 실패 ' + ticker + ': ' + e.message, 'error');
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
        log('전일 복사본 의심: ' + today + ' (' + yest + '와 ' + identical + '종목 100% 동일)', 'warn');
      }
    }
    return issues;
  }

  // ===== 7. 특정 날짜 복구 =====
  async function repairDate(targetDate) {
    log(targetDate + ' 복구 시작...');
    const holdings = await getAll('holdings');
    const tickers = holdings.map(h => h.ticker);
    const collected = await fetchNaverPrices(tickers);
    if (!collected[targetDate]) {
      log(targetDate + ' 네이버 데이터 없음 (휴장일 가능)', 'warn');
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
        id: 's_' + ymd + '_' + ticker,
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
    log(targetDate + ' ' + updated + '건 복구 완료', 'ok');

    if (window.__phase12?.push && window.__phase12?.auth?.currentUser) {
      try {
        await window.__phase12.push();
        log('Firestore Push 완료', 'ok');
      } catch (e) {
        log('Firestore Push 실패: ' + e.message, 'error');
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
    if (window.__phase7.__p15_guarded_v172) return true;
    
    const origRun = window.__phase7.run.bind(window.__phase7);
    
    const isMarketClosed = () => {
      const now = new Date();
      const kstOffset = 9 * 60;
      const kst = new Date(now.getTime() + (kstOffset - now.getTimezoneOffset()) * 60000);
      const day = kst.getDay();
      if (day === 0 || day === 6) return { closed: true, reason: '주말' };
      
      const md = String(kst.getMonth()+1).padStart(2,'0') + '-' + String(kst.getDate()).padStart(2,'0');
      const holidays2026 = ['01-01','02-16','02-17','02-18','03-01','03-02','05-05','05-25',
                            '06-06','08-15','08-17','09-24','09-25','09-26','10-03','10-05',
                            '10-09','12-25'];
      if (holidays2026.includes(md)) return { closed: true, reason: '공휴일' };
      
      return { closed: false };
    };
    
    window.__phase7.run = async function(...args) {
      const market = isMarketClosed();
      if (market.closed) {
        log('Phase 7 자동 실행 차단: 오늘은 ' + market.reason, 'warn');
        return { skipped: true, reason: market.reason };
      }
      
      const result = await origRun(...args);
      
      const today = new Date().toISOString().slice(0, 10);
      const allSnaps = await getAll('daily_snapshots');
      const futureSnaps = allSnaps.filter(s => s.date > today);
      if (futureSnaps.length > 0) {
        log('미래 날짜 스냅샷 ' + futureSnaps.length + '건 발견 - 자동 삭제', 'warn');
        const db = await openDB();
        const tx = db.transaction('daily_snapshots', 'readwrite');
        const store = tx.objectStore('daily_snapshots');
        futureSnaps.forEach(s => store.delete(s.id));
        await new Promise(res => { tx.oncomplete = res; });
      }
      
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
          log('Phase 7 입력값이 전일과 100% 동일 - 롤백', 'warn');
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
    window.__phase7.__p15_guarded_v172 = true;
    
    // v1.7.5: run 함수 봉인 (다른 스크립트가 덮어쓰지 못하게)
    try {
      const guardedRun = window.__phase7.run;
      Object.defineProperty(window.__phase7, 'run', {
        value: guardedRun,
        writable: false,
        configurable: false,
        enumerable: true
      });
      log('Phase 7 run 함수 봉인 완료 (불변)', 'ok');
    } catch (e) {
      log('run 함수 봉인 실패: ' + e.message, 'warn');
    }
    
    log('Phase 7 가드 설치 완료 (휴장일 차단 + 미래 날짜 자동 삭제)', 'ok');
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
      log(issue.date + ' 자동 복구 시도...');
      await repairDate(issue.date);
    }
    log('총 ' + issues.length + '일 복구 완료', 'ok');
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
    installDashboardHook,
    ensureDashboardHook,
    installPeriodButtonHook,
    hookFunction,
    hookChartConstructor,
    patchChartInstance,
    getByDate
  };

  // ===== 자동 갱신 (모달 열려있을 때) =====
  async function refreshIfDashboardOpen() {
    const opened = document.querySelector(MODAL_SELECTORS);
    if (opened) {
      const patched = await refreshAllCharts();
      await refreshDailyPL();
      const statsUpdated = await refreshTopStats();
      if (patched > 0 || statsUpdated > 0) {
        log('초기 자동 갱신: 차트 ' + patched + '개 / 통계 ' + statsUpdated + '개 정정', 'ok');
      }
    }
  }

  // ===== 초기화 =====
      // 즉시 한 번 청소 (페이지 로드 직후)
  cleanupFutureSnapshots().catch(e => console.warn('초기 cleanup 실패:', e));
  
  setTimeout(async () => {
    await cleanupFutureSnapshots();
    installPhase7Guard();
    hookChartConstructor();
    ensureDashboardHook();
    installPeriodButtonHook();
    
    setTimeout(refreshIfDashboardOpen, 2000);
    setTimeout(refreshIfDashboardOpen, 4000);
    setTimeout(refreshIfDashboardOpen, 6000);
    
    setTimeout(autoRun, 5000);
    setInterval(autoRun, 60 * 60 * 1000);
    
    let checkCount = 0;
    const hookChecker = setInterval(() => {
      ensureDashboardHook();
      checkCount++;
      if (checkCount >= 15) clearInterval(hookChecker);
    }, 2000);
    setInterval(ensureDashboardHook, 30000);
    
    log('Phase 15 v' + VERSION + ' 초기화 완료', 'ok');
  }, 3000);
})();
async function cleanupFutureSnapshots() {
  try {
    // KST 기준 오늘 날짜
    const now = new Date();
    const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60000);
    const TODAY = kst.getFullYear() + '-' +
      String(kst.getMonth() + 1).padStart(2, '0') + '-' +
      String(kst.getDate()).padStart(2, '0');
    
    const HOLIDAYS_2026 = ['2026-01-01','2026-02-16','2026-02-17','2026-02-18',
      '2026-03-01','2026-03-02','2026-05-05','2026-05-25','2026-06-06',
      '2026-08-15','2026-08-17','2026-09-24','2026-09-25','2026-09-26',
      '2026-10-03','2026-10-05','2026-10-09','2026-12-25'];
    
    const isMarketClosedDate = (dateStr) => {
      // 'YYYY-MM-DD'를 직접 파싱 (타임존 무관)
      const [y, m, d] = dateStr.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      const day = dt.getDay();
      if (day === 0 || day === 6) return true; // 일/토
      if (HOLIDAYS_2026.includes(dateStr)) return true;
      return false;
    };
    
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('StockJournalDB');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = await new Promise(res => {
      const r = db.transaction('daily_snapshots').objectStore('daily_snapshots').getAll();
      r.onsuccess = () => res(r.result);
    });
    
    // 청소 대상: 미래 날짜 OR 휴장일(주말/공휴일)
    const targets = all.filter(x => {
      if (!x.date) return true; // 날짜 없는 손상 데이터도 제거
      if (x.date > TODAY) return true; // 미래
      if (isMarketClosedDate(x.date)) return true; // 휴장일
      return false;
    });
    
    if (targets.length === 0) {
      console.log('[Phase15 v1.7.6] 청소 대상 없음 (오늘=' + TODAY + ')');
      return 0;
    }
    
    const tx = db.transaction('daily_snapshots', 'readwrite');
    const store = tx.objectStore('daily_snapshots');
    for (const r of targets) store.delete(r.id);
    await new Promise(res => tx.oncomplete = res);
    
    // 청소 사유별 통계
    const futureCnt = targets.filter(x => x.date && x.date > TODAY).length;
    const closedCnt = targets.filter(x => x.date && isMarketClosedDate(x.date)).length;
    console.log(`[Phase15 v1.7.6] 청소 완료: 미래 ${futureCnt}건, 휴장일 ${closedCnt}건 (총 ${targets.length}건)`);
    return targets.length;
  } catch (e) {
    console.warn('[Phase15 v1.7.6] cleanup 실패:', e);
    return -1;
  }
}

