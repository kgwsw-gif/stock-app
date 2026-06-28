// phase15.js - 자동 복구 시스템 v1.7.8
// === v1.7.8 보완 사항 ===
// 1. START_ASSET 동적 계산 (보유 종목/수량 변경 자동 대응)
// 2. HOLIDAYS 2026~2030 사전 등록 + DB 보조 검증
// 3. holdings 변경 감지 → 캐시 자동 무효화
// 4. 버전 정보 콘솔 명확 출력
// 5. window.__phase15.diag() 자가 진단 명령
(function() {
  const VERSION = '1.7.8';
  const BUILD_DATE = '2026-06-28';
  const NAVER_DATE_RE = /<span[^>]*class="tah[^"]*"[^>]*>(\d{4}\.\d{2}\.\d{2})<\/span>[\s\S]{0,500}?<span[^>]*class="tah[^"]*"[^>]*>([\d,]+)<\/span>/g;
  const MODAL_SELECTORS = '#dashboard-modal, #validation-dashboard, #chart-modal';
  
  // v1.7.8: 한국 공휴일 2026~2030 (필요 시 갱신)
  const HOLIDAYS = [
    // 2026
    '2026-01-01','2026-02-16','2026-02-17','2026-02-18','2026-03-01','2026-03-02',
    '2026-05-05','2026-05-25','2026-06-06','2026-08-15','2026-08-17',
    '2026-09-24','2026-09-25','2026-09-26','2026-10-03','2026-10-05','2026-10-09','2026-12-25',
    // 2027
    '2027-01-01','2027-02-06','2027-02-07','2027-02-08','2027-02-09',
    '2027-03-01','2027-05-05','2027-05-13','2027-06-06','2027-08-15','2027-08-16',
    '2027-09-14','2027-09-15','2027-09-16','2027-10-03','2027-10-04','2027-10-09','2027-12-25',
    // 2028
    '2028-01-01','2028-01-26','2028-01-27','2028-01-28','2028-03-01',
    '2028-05-02','2028-05-05','2028-06-06','2028-08-15',
    '2028-10-02','2028-10-03','2028-10-04','2028-10-09','2028-12-25',
    // 2029
    '2029-01-01','2029-02-12','2029-02-13','2029-02-14','2029-03-01',
    '2029-05-05','2029-05-20','2029-06-06','2029-08-15',
    '2029-09-21','2029-09-22','2029-09-23','2029-10-03','2029-10-09','2029-12-25',
    // 2030
    '2030-01-01','2030-02-02','2030-02-03','2030-02-04','2030-03-01',
    '2030-05-05','2030-05-09','2030-06-06','2030-08-15',
    '2030-09-11','2030-09-12','2030-09-13','2030-10-03','2030-10-09','2030-12-25'
  ];
  
  let START_ASSET_CACHE = null;
  let HOLDINGS_HASH = null;
  let DB_DATE_SET = null;

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

  const todayKST = () => {
    const n = new Date();
    const k = new Date(n.getTime() + (9 * 60 + n.getTimezoneOffset()) * 60000);
    return k.getFullYear() + '-' + String(k.getMonth() + 1).padStart(2, '0') + '-' + String(k.getDate()).padStart(2, '0');
  };

  const isClosedDate = (ds) => {
    if (!ds || typeof ds !== 'string') return false;
    const [y, m, d] = ds.split('-').map(Number);
    if (!y || !m || !d) return false;
    const day = new Date(y, m - 1, d).getDay();
    if (day === 0 || day === 6) return true;
    return HOLIDAYS.includes(ds);
  };

  const log = (msg, level = 'info') => {
    const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'ok' ? '✅' : 'ℹ️';
    console.log('[Phase15] ' + tag + ' ' + msg);
    if (window.__phase11?.writeLog) {
      window.__phase11.writeLog({ phase: 'phase15', level, message: msg });
    }
  };

  // ===== v1.7.8: holdings 해시 (변경 감지용) =====
  const computeHoldingsHash = (holdings) => {
    return holdings
      .map(h => `${h.ticker}:${getQty(h)}`)
      .sort()
      .join('|');
  };

  const invalidateCacheIfHoldingsChanged = async () => {
    const holdings = await getAll('holdings');
    const newHash = computeHoldingsHash(holdings);
    if (HOLDINGS_HASH !== null && HOLDINGS_HASH !== newHash) {
      log('보유 종목/수량 변경 감지 - 캐시 무효화', 'warn');
      START_ASSET_CACHE = null;
      cachedByDate = null;
      cachedTimestamp = 0;
    }
    HOLDINGS_HASH = newHash;
  };

  // ===== v1.7.8: START_ASSET 동적 계산 =====
  async function computeStartAsset() {
    if (START_ASSET_CACHE !== null) return START_ASSET_CACHE;
    try {
      const snaps = await getAll('daily_snapshots');
      if (snaps.length === 0) {
        START_ASSET_CACHE = 1; // 0 나눗셈 방지
        return START_ASSET_CACHE;
      }
      // 가장 오래된 날짜를 시작 자산 기준으로 사용
      const dates = [...new Set(snaps.map(s => s.date))].filter(Boolean).sort();
      const firstDate = dates[0];
      const holdings = await getAll('holdings');
      
      // 첫 날짜의 자산 합산 (해당 날짜에 없으면 0)
      let total = 0;
      holdings.forEach(h => {
        const qty = getQty(h);
        if (qty === 0) return;
        const snap = snaps.find(s => s.date === firstDate && s.ticker === h.ticker);
        if (snap) total += getPrice(snap) * qty;
      });
      
      // 백업: 첫 날짜에 데이터가 부족하면 모든 종목 평단가 × 수량
      if (total === 0) {
        holdings.forEach(h => {
          const qty = getQty(h);
          const avg = Number(h?.avgBuyPriceKRW || 0);
          if (qty > 0 && avg > 0) total += qty * avg;
        });
      }
      
      START_ASSET_CACHE = total > 0 ? total : 1;
      log(`START_ASSET 동적 계산: ₩${START_ASSET_CACHE.toLocaleString()} (기준일: ${firstDate})`, 'ok');
      return START_ASSET_CACHE;
    } catch (e) {
      console.warn('[Phase15] START_ASSET 계산 실패:', e);
      START_ASSET_CACHE = 1;
      return START_ASSET_CACHE;
    }
  }

  // ===== v1.7.8: DB 보조 검증 (DB에 없는 평일이면 실제로는 휴장일일 수 있음) =====
  async function buildDateSet() {
    const snaps = await getAll('daily_snapshots');
    DB_DATE_SET = new Set(snaps.map(s => s.date).filter(Boolean));
  }

  // ===== 0. 미래/휴장일 데이터 자동 청소 =====
  async function cleanupFutureSnapshots() {
    try {
      const TODAY = todayKST();
      const all = await getAll('daily_snapshots');
      
      const targets = all.filter(x => {
        if (!x.date) return true;
        if (x.date > TODAY) return true;
        if (isClosedDate(x.date)) return true;
        return false;
      });
      
      if (targets.length === 0) {
        console.log(`[Phase15 v${VERSION}] 청소 대상 없음 (오늘=${TODAY})`);
        return 0;
      }
      
      const db = await openDB();
      const tx = db.transaction('daily_snapshots', 'readwrite');
      const store = tx.objectStore('daily_snapshots');
      for (const r of targets) store.delete(r.id);
      await new Promise(res => { tx.oncomplete = res; });
      
      const futureCnt = targets.filter(x => x.date && x.date > TODAY).length;
      const closedCnt = targets.filter(x => x.date && isClosedDate(x.date)).length;
      console.log(`[Phase15 v${VERSION}] 청소 완료: 미래 ${futureCnt}건, 휴장일 ${closedCnt}건 (총 ${targets.length}건)`);
      return targets.length;
    } catch (e) {
      console.warn(`[Phase15 v${VERSION}] cleanup 실패:`, e);
      return -1;
    }
  }

  // ===== 1. 일자별 자산 계산 =====
  async function calcByDate(targetDates = null) {
    await invalidateCacheIfHoldingsChanged();
    
    const snaps = await getAll('daily_snapshots');
    const holdings = await getAll('holdings');
    const byDate = {};
    const TODAY = todayKST();
    
    const priceByTicker = {};
    snaps.forEach(s => {
      if (!priceByTicker[s.ticker]) priceByTicker[s.ticker] = {};
      priceByTicker[s.ticker][s.date] = getPrice(s);
    });
    
    let allDates = targetDates || [...new Set(snaps.map(s => s.date))].sort();
    allDates = allDates.filter(d => d && d <= TODAY && !isClosedDate(d));
    
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
    
    const TODAY = todayKST();
    const START_ASSET = await computeStartAsset();
    
    // 차트 라벨에서 미래/휴장일 제거
    allCharts.forEach(c => {
      const labels = c.data?.labels || [];
      const validIndices = [];
      labels.forEach((l, i) => {
        if (typeof l !== 'string' || !/^2\d{3}-\d{2}-\d{2}$/.test(l)) {
          validIndices.push(i);
          return;
        }
        if (l > TODAY || isClosedDate(l)) return;
        validIndices.push(i);
      });
      if (validIndices.length < labels.length) {
        c.data.labels = validIndices.map(i => labels[i]);
        c.data.datasets.forEach(ds => {
          ds.data = validIndices.map(i => ds.data[i]);
          if (Array.isArray(ds.backgroundColor)) ds.backgroundColor = validIndices.map(i => ds.backgroundColor[i]);
          if (Array.isArray(ds.borderColor)) ds.borderColor = validIndices.map(i => ds.borderColor[i]);
        });
      }
    });
    
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
  
  async function patchChartInstance(chart) {
    try {
      const canvasId = chart?.canvas?.id || '';
      if (!canvasId.startsWith('chart-')) return false;
      let labels = chart.data?.labels || [];
      const isDateChart = labels[0] && /^2\d{3}-\d{2}-\d{2}$/.test(labels[0]);
      if (!isDateChart) return false;
      
      const TODAY = todayKST();
      const validIndices = [];
      labels.forEach((l, i) => {
        if (typeof l === 'string' && /^2\d{3}-\d{2}-\d{2}$/.test(l) && (l > TODAY || isClosedDate(l))) return;
        validIndices.push(i);
      });
      if (validIndices.length < labels.length) {
        chart.data.labels = validIndices.map(i => labels[i]);
        chart.data.datasets.forEach(ds => {
          ds.data = validIndices.map(i => ds.data[i]);
          if (Array.isArray(ds.backgroundColor)) ds.backgroundColor = validIndices.map(i => ds.backgroundColor[i]);
          if (Array.isArray(ds.borderColor)) ds.borderColor = validIndices.map(i => ds.borderColor[i]);
        });
        labels = chart.data.labels;
      }
      
      const byDate = cachedByDate;
      if (!byDate) return false;
      const START_ASSET = await computeStartAsset();
      
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
        patchChartInstance(instance).then(ok => {
          if (ok) {
            instance.update('none');
            log('Chart 생성 직후 정정: #' + (instance.canvas?.id || '?'), 'ok');
          }
        });
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

  // ===== 3. 상단 수치 박스 정정 =====
  async function refreshTopStats() {
    const byDate = await calcByDate();
    const dates = Object.keys(byDate).sort();
    if (dates.length === 0) return 0;

    const periodLabels = ['1주', '1개월', '3개월', '6개월', '1년', '전체'];
    let filterText = '1주';
    
    const periodBtns = document.querySelectorAll('#chart-period button, .period-btn');
    for (const btn of periodBtns) {
      const txt = btn.textContent.trim();
      if (!periodLabels.includes(txt)) continue;
      const bg = (btn.style.background || btn.style.backgroundColor || '').trim().toLowerCase();
      const isActive = bg && 
        bg !== 'white' && 
        bg !== 'transparent' &&
        !/^#fff/i.test(bg) &&
        !/^rgb\(\s*255\s*,\s*255\s*,\s*255/.test(bg);
      if (isActive) {
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
    const losses = pnls.filter(p => p.pnl < 0).length;
    const winRate = (wins + losses) > 0 ? (wins / (wins + losses) * 100) : 0;

    const findBoxByLabel = (labelText) => {
      const modal = document.querySelector('#chart-modal') || document;
      const styledBoxes = modal.querySelectorAll('[style*="border-left"]');
      for (const box of styledBoxes) {
        if (box.children.length < 2) continue;
        const firstChild = box.children[0];
        if (firstChild && firstChild.textContent.includes(labelText) && firstChild.textContent.length < 80) {
          return box;
        }
      }
      const all = modal.querySelectorAll('div');
      for (const div of all) {
        if (div.children.length < 2) continue;
        const firstChild = div.children[0];
        if (firstChild && firstChild.textContent.trim().includes(labelText) && firstChild.textContent.length < 80) {
          return div;
        }
      }
      return null;
    };

    let updated = 0;

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

    const maxGainBox = findBoxByLabel('최고 수익일');
    if (maxGainBox && maxGainBox.children.length >= 2 && isFinite(maxGain.pnl)) {
      const valueDiv = maxGainBox.children[1];
      const detailDiv = maxGainBox.children[2];
      valueDiv.textContent = '+₩' + maxGain.pnl.toLocaleString();
      valueDiv.style.color = '#e74c3c';
      if (detailDiv) detailDiv.textContent = maxGain.date;
      updated++;
    }

    const maxLossBox = findBoxByLabel('최대 손실일');
    if (maxLossBox && maxLossBox.children.length >= 2 && isFinite(maxLoss.pnl)) {
      const valueDiv = maxLossBox.children[1];
      const detailDiv = maxLossBox.children[2];
      valueDiv.textContent = '₩' + maxLoss.pnl.toLocaleString();
      valueDiv.style.color = '#3498db';
      if (detailDiv) detailDiv.textContent = maxLoss.date;
      updated++;
    }

    const winBox = findBoxByLabel('승률');
    if (winBox && winBox.children.length >= 2 && pnls.length > 0) {
      const valueDiv = winBox.children[1];
      const detailDiv = winBox.children[2];
      valueDiv.textContent = winRate.toFixed(1) + '%';
      if (detailDiv) detailDiv.textContent = '수익 ' + wins + '일 / 손실 ' + losses + '일';
      updated++;
    }

    if (updated > 0) log('상단 수치 ' + updated + '개 정정 (활성=' + filterText + ', 기간 ' + periodReturn.toFixed(2) + '%, 승률 ' + winRate.toFixed(1) + '%)', 'ok');
    return updated;
  }

  // ===== 4. 대시보드 후킹 =====
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

  // ===== 4-2. 기간 버튼 클릭 감지 =====
  let periodButtonsHooked = false;
  function installPeriodButtonHook() {
    if (periodButtonsHooked) return;
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const text = btn.textContent.trim();
      if (!/^(1주|1개월|3개월|6개월|1년|전체)$/.test(text)) return;
      setTimeout(async () => { await refreshTopStats(); }, 150);
      setTimeout(async () => { 
        await refreshAllCharts(); 
        await refreshTopStats(); 
      }, 600);
      setTimeout(async () => { await refreshTopStats(); }, 1200);
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
    START_ASSET_CACHE = null;
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
      const ds = kst.getFullYear() + '-' + String(kst.getMonth()+1).padStart(2,'0') + '-' + String(kst.getDate()).padStart(2,'0');
      if (HOLIDAYS.includes(ds)) return { closed: true, reason: '공휴일' };
      return { closed: false };
    };
    
    window.__phase7.run = async function(...args) {
      const market = isMarketClosed();
      if (market.closed) {
        log('Phase 7 자동 실행 차단: 오늘은 ' + market.reason, 'warn');
        return { skipped: true, reason: market.reason };
      }
      
      const result = await origRun(...args);
      
      const today = todayKST();
      const allSnaps = await getAll('daily_snapshots');
      const futureSnaps = allSnaps.filter(s => s.date > today || isClosedDate(s.date));
      if (futureSnaps.length > 0) {
        log('미래/휴장일 스냅샷 ' + futureSnaps.length + '건 발견 - 자동 삭제', 'warn');
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
      log(issue.date + ' 자동 복구 시도...');
      await repairDate(issue.date);
    }
    log('총 ' + issues.length + '일 복구 완료', 'ok');
  }

  // ===== v1.7.8: 자가 진단 명령 =====
  async function diag() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📋 Phase 15 v${VERSION} 자가 진단`);
    console.log(`📅 Build: ${BUILD_DATE} | KST: ${todayKST()}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const snaps = await getAll('daily_snapshots');
    const holdings = await getAll('holdings');
    const dates = [...new Set(snaps.map(s => s.date))].filter(Boolean).sort();
    const startAsset = await computeStartAsset();
    
    // 1) DB 상태
    console.log('\n🗄️ DB 상태');
    console.log(`  스냅샷: ${snaps.length}건`);
    console.log(`  날짜수: ${dates.length}건`);
    console.log(`  보유종목: ${holdings.length}건 [${holdings.map(h => h.ticker).join(', ')}]`);
    console.log(`  최근 5일: ${dates.slice(-5).join(', ')}`);
    
    // 2) 이상 데이터 검사
    const TODAY = todayKST();
    const future = snaps.filter(s => s.date > TODAY);
    const closedDays = snaps.filter(s => s.date && isClosedDate(s.date));
    const damaged = snaps.filter(s => !s.date || !s.ticker || !getPrice(s));
    console.log('\n🔍 이상 데이터 검사');
    console.log(`  미래 데이터: ${future.length}건 ${future.length === 0 ? '✅' : '❌'}`);
    console.log(`  휴장일 데이터: ${closedDays.length}건 ${closedDays.length === 0 ? '✅' : '❌'}`);
    console.log(`  손상 데이터: ${damaged.length}건 ${damaged.length === 0 ? '✅' : '❌'}`);
    
    // 3) START_ASSET
    console.log('\n💰 START_ASSET (누적 수익률 분모)');
    console.log(`  값: ₩${startAsset.toLocaleString()}`);
    console.log(`  기준일: ${dates[0] || '없음'}`);
    
    // 4) Phase 7 가드
    console.log('\n🛡️ Phase 7 가드');
    console.log(`  Phase 7 존재: ${!!window.__phase7 ? '✅' : '❌'}`);
    console.log(`  가드 설치: ${window.__phase7?.__p15_guarded_v172 ? '✅' : '❌'}`);
    const desc = window.__phase7 ? Object.getOwnPropertyDescriptor(window.__phase7, 'run') : null;
    console.log(`  run 봉인: ${desc?.writable === false ? '✅' : '❌'}`);
    
    // 5) 차트 인스턴스
    console.log('\n📊 차트 인스턴스');
    const modalOpen = !!document.querySelector('#chart-modal');
    console.log(`  차트 모달: ${modalOpen ? '열림' : '닫힘'}`);
    if (modalOpen) {
      for (const id of ['chart-total', 'chart-profit', 'chart-cumreturn']) {
        const c = window.Chart?.getChart?.(id);
        if (c) {
          const lastLabel = c.data.labels[c.data.labels.length - 1];
          const ok = lastLabel <= TODAY && !isClosedDate(lastLabel);
          console.log(`  ${id}: ${c.data.labels.length}개, 마지막=${lastLabel} ${ok ? '✅' : '❌'}`);
        }
      }
    }
    
    // 6) 후킹 상태
    console.log('\n🔗 후킹 상태');
    console.log(`  showDashboardModal: ${window.showDashboardModal?.__p15_hooked ? '✅' : '❌'}`);
    console.log(`  showValidationDashboard: ${window.showValidationDashboard?.__p15_hooked ? '✅' : '❌'}`);
    console.log(`  Chart 생성자: ${chartConstructorHooked ? '✅' : '❌'}`);
    console.log(`  기간 버튼: ${periodButtonsHooked ? '✅' : '❌'}`);
    
    // 7) 보유종목 해시
    console.log('\n📌 보유종목 해시');
    console.log(`  현재: ${HOLDINGS_HASH || '미설정'}`);
    
    // 8) 종합 판정
    const issues = [];
    if (future.length > 0) issues.push('미래 데이터');
    if (closedDays.length > 0) issues.push('휴장일 데이터');
    if (damaged.length > 0) issues.push('손상 데이터');
    if (window.__phase7 && !window.__phase7.__p15_guarded_v172) issues.push('Phase 7 가드 미설치');
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (issues.length === 0) {
      console.log('✅ 모든 항목 정상');
    } else {
      console.log('⚠️ 발견된 이슈: ' + issues.join(', '));
      console.log('💡 자동 복구: window.__phase15.cleanupFutureSnapshots()');
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    return { snaps: snaps.length, holdings: holdings.length, dates: dates.length, startAsset, issues };
  }

  // ===== 공개 API =====
  window.__phase15 = {
    version: VERSION,
    buildDate: BUILD_DATE,
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
    getByDate,
    cleanupFutureSnapshots,
    computeStartAsset,
    diag,
    // 진단/디버그
    _internal: {
      get cachedByDate() { return cachedByDate; },
      get startAssetCache() { return START_ASSET_CACHE; },
      get holdingsHash() { return HOLDINGS_HASH; },
      resetCaches() {
        START_ASSET_CACHE = null;
        cachedByDate = null;
        cachedTimestamp = 0;
        HOLDINGS_HASH = null;
        log('모든 캐시 초기화', 'ok');
      }
    }
  };

  // ===== 자동 갱신 =====
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

  // ===== v1.7.8: 시작 시 명확한 버전 출력 =====
  console.log(
    `%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Phase 15 자동 복구 시스템\n` +
    `   Version: ${VERSION}\n` +
    `   Build: ${BUILD_DATE}\n` +
    `   Diag: window.__phase15.diag()\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    'color: #3498db; font-weight: bold'
  );

  // ===== 초기화 =====
  cleanupFutureSnapshots().catch(e => console.warn('초기 cleanup 실패:', e));
  
  // holdings 해시 초기화
  getAll('holdings').then(h => { HOLDINGS_HASH = computeHoldingsHash(h); });
  
  setTimeout(async () => {
    await cleanupFutureSnapshots();
    installPhase7Guard();
    hookChartConstructor();
    ensureDashboardHook();
    installPeriodButtonHook();
    
    // START_ASSET 미리 계산
    computeStartAsset().catch(e => console.warn('START_ASSET 초기화 실패:', e));
    
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
    
    // 5분마다 holdings 변경 감지
    setInterval(invalidateCacheIfHoldingsChanged, 5 * 60 * 1000);
    
    log(`Phase 15 v${VERSION} 초기화 완료`, 'ok');
  }, 3000);
})();
