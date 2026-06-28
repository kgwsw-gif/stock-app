// phase16-outcomes.js - 결과 추적 & 신뢰도 점수 v0.1.1
(function() {
  const VERSION = '0.1.1';
  const INSIGHT_DB = 'StockJournalInsightsDB';
  const MAIN_DB = 'StockJournalDB';

  const PERIODS = [
    { key: '1m', label: '1개월', days: 30 },
    { key: '3m', label: '3개월', days: 90 },
    { key: '6m', label: '6개월', days: 180 }
  ];

  const TONE_THRESHOLD = 5;
  const TARGET_PROXIMITY = 10;

  function waitForDeps(maxWait = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.__phase16?.getAllVideos && window.__phase16?.getAllReports) return resolve();
        if (Date.now() - start > maxWait) return reject(new Error('timeout'));
        setTimeout(check, 100);
      };
      check();
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function daysSince(dateStr) {
    if (!dateStr) return 0;
    const d = new Date(dateStr);
    return Math.floor((new Date() - d) / 86400000);
  }

  function formatPrice(n) {
    if (n == null || isNaN(n)) return '-';
    return Math.round(Number(n)).toLocaleString() + '원';
  }

  function formatPercent(n) {
    if (n == null || isNaN(n)) return '-';
    const v = Number(n);
    const sign = v > 0 ? '+' : '';
    return sign + v.toFixed(1) + '%';
  }

  function getRegisteredDate(record) {
    return record.reportDate || record.watchedAt || record.createdAt || new Date().toISOString();
  }

  // outcomes가 배열이거나 null이면 객체로 정규화
  function normalizeOutcomes(o) {
    if (!o || Array.isArray(o)) return {};
    if (typeof o !== 'object') return {};
    return o;
  }

  function openMainDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(MAIN_DB);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getPriceFromSnapshot(ticker, targetDate) {
    try {
      const db = await openMainDB();
      if (!db.objectStoreNames.contains('daily_snapshots')) { db.close(); return null; }
      const list = await new Promise((res, rej) => {
        const r = db.transaction('daily_snapshots').objectStore('daily_snapshots').getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      db.close();
      const target = new Date(targetDate).getTime();
      const candidates = [];
      list.forEach(snap => {
        const date = snap.date || snap.snapshot_date || snap.createdAt;
        if (!date) return;
        const dt = new Date(date).getTime();
        const holdings = snap.holdings || snap.data || [];
        if (!Array.isArray(holdings)) return;
        const h = holdings.find(x => x.code === ticker || x.ticker === ticker);
        if (h) {
          const price = Number(h.currentPrice || h.current_price || h.price || h.close || 0);
          if (price > 0) candidates.push({ date: dt, price, diff: Math.abs(dt - target) });
        }
      });
      if (!candidates.length) return null;
      candidates.sort((a, b) => a.diff - b.diff);
      if (candidates[0].diff > 3 * 86400000) return null;
      return candidates[0].price;
    } catch(e) {
      return null;
    }
  }

  function evaluateTone(tone, returnPct) {
    if (returnPct == null || isNaN(returnPct)) return null;
    const t = (tone || '').toString();
    if (/강세|상승|매수|bullish|buy/i.test(t)) return returnPct >= TONE_THRESHOLD ? '적중' : '미적중';
    if (/약세|하락|매도|bearish|sell/i.test(t)) return returnPct <= -TONE_THRESHOLD ? '적중' : '미적중';
    if (/중립|hold|neutral/i.test(t)) return (returnPct >= -TONE_THRESHOLD && returnPct <= TONE_THRESHOLD) ? '적중' : '미적중';
    return null;
  }

  function evaluateTargetPrice(targetPrice, actualPrice) {
    if (!targetPrice || !actualPrice) return null;
    const diff = Math.abs(actualPrice - targetPrice) / targetPrice * 100;
    return diff <= TARGET_PROXIMITY ? '도달' : '미도달';
  }

  function openInsightDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(INSIGHT_DB);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveOutcomes(recordType, recordId, outcomes) {
    const storeName = recordType === 'video' ? 'video_insights' : 'analyst_reports';
    const db = await openInsightDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const getReq = store.get(recordId);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (!rec) { db.close(); return reject(new Error('record not found')); }
        rec.outcomes = outcomes;
        rec.outcomesUpdatedAt = new Date().toISOString();
        const putReq = store.put(rec);
        putReq.onsuccess = () => { db.close(); resolve(rec); };
        putReq.onerror = () => { db.close(); reject(putReq.error); };
      };
      getReq.onerror = () => { db.close(); reject(getReq.error); };
    });
  }

  async function openOutcomesModal(recordType, record) {
    const existing = document.getElementById('p16-outcomes-modal');
    if (existing) existing.remove();

    const registeredDate = getRegisteredDate(record);
    const registeredDays = daysSince(registeredDate);

    let trackTickers = [];
    if (recordType === 'video') {
      trackTickers = (record.tickers || []).map(t => ({
        code: t.code, name: t.name || t.code, tone: t.tone, target: t.target
      }));
      if (!trackTickers.length && record.overallTone) {
        trackTickers = [{ code: '', name: '(종목 미지정)', tone: record.overallTone }];
      }
    } else {
      trackTickers = [{
        code: record.ticker, name: record.tickerName || record.ticker,
        tone: record.rating, target: record.targetPrice
      }];
    }

    const existingOutcomes = normalizeOutcomes(record.outcomes);

    const periodData = await Promise.all(PERIODS.map(async (period) => {
      const targetDate = new Date(new Date(registeredDate).getTime() + period.days * 86400000);
      const elapsed = registeredDays >= period.days;
      const result = {
        ...period,
        targetDate: targetDate.toISOString().slice(0, 10),
        elapsed,
        tickers: []
      };
      for (const t of trackTickers) {
        if (!t.code) {
          result.tickers.push({ ...t, price: null, basePrice: null, autoFilled: false });
          continue;
        }
        const saved = existingOutcomes?.[period.key]?.[t.code];
        let price = saved?.price ?? null;
        let basePrice = saved?.basePrice ?? null;
        let autoFilled = false;
        if (price == null && elapsed) {
          price = await getPriceFromSnapshot(t.code, targetDate);
          if (price != null) autoFilled = true;
        }
        if (basePrice == null) {
          basePrice = await getPriceFromSnapshot(t.code, registeredDate);
          if (basePrice == null && recordType === 'report' && record.currentPrice) {
            basePrice = Number(record.currentPrice);
          }
          if (basePrice != null) autoFilled = true;
        }
        result.tickers.push({ ...t, price, basePrice, autoFilled });
      }
      return result;
    }));

    const modal = document.createElement('div');
    modal.id = 'p16-outcomes-modal';
    modal.style.cssText = `
      position:fixed;top:0;left:0;width:100%;height:100%;
      background:rgba(0,0,0,0.55);z-index:100000;
      display:flex;align-items:center;justify-content:center;padding:20px;
    `;

    const titleText = recordType === 'video'
      ? `📺 ${escapeHtml(record.channelName || '')} - ${escapeHtml((record.videoTitle || '').slice(0, 30))}`
      : `📄 ${escapeHtml(record.analyst || '')} / ${escapeHtml(record.tickerName || record.ticker || '')}`;

    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:24px;max-width:720px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,0.3);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
          <div>
            <h2 style="margin:0;font-size:18px;color:#111;">📊 결과 추적</h2>
            <div style="font-size:13px;color:#555;margin-top:4px;">${titleText}</div>
            <div style="font-size:12px;color:#888;margin-top:2px;">등록일: ${registeredDate.slice(0,10)} (${registeredDays}일 경과)</div>
          </div>
          <button id="p16-outcomes-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:#666;">×</button>
        </div>

        ${trackTickers.length === 0 ? `
          <div style="padding:24px;text-align:center;color:#888;background:#f9fafb;border-radius:8px;">
            추적할 종목 정보가 없습니다.
          </div>
        ` : `
          <div style="margin-bottom:12px;font-size:13px;color:#666;background:#fef3c7;padding:10px 12px;border-radius:6px;">
            💡 자동 조회된 값은 회색으로 표시됩니다. 직접 입력하면 우선 적용됩니다.
            <br>판정 기준: 강세 ≥ +${TONE_THRESHOLD}%, 약세 ≤ -${TONE_THRESHOLD}%, 중립 ±${TONE_THRESHOLD}%, 목표가 도달 ±${TARGET_PROXIMITY}%
          </div>

          ${periodData.map(p => `
            <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:12px;${p.elapsed ? '' : 'opacity:0.55;'}">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <div style="font-weight:600;color:#111;">📅 ${p.label} (${p.targetDate})</div>
                <div style="font-size:12px;${p.elapsed ? 'color:#10b981;' : 'color:#9ca3af;'}">${p.elapsed ? '✅ 평가 가능' : '⏰ 대기중'}</div>
              </div>
              ${p.tickers.map((t) => {
                const returnPct = (t.basePrice && t.price) ? ((t.price - t.basePrice) / t.basePrice * 100) : null;
                const toneHit = evaluateTone(t.tone, returnPct);
                const targetHit = (t.target && t.price) ? evaluateTargetPrice(t.target, t.price) : null;
                return `
                  <div style="background:#f9fafb;border-radius:6px;padding:10px;margin-top:6px;" data-period="${p.key}" data-ticker="${escapeHtml(t.code)}">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                      <div style="font-weight:500;">${escapeHtml(t.name)} ${t.code ? `<span style="color:#888;font-size:12px;">(${escapeHtml(t.code)})</span>` : ''}</div>
                      <div style="font-size:12px;color:#555;">예상: ${escapeHtml(t.tone || '-')}${t.target ? ` / 목표가 ${formatPrice(t.target)}` : ''}</div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;align-items:end;">
                      <div>
                        <label style="font-size:11px;color:#666;display:block;">기준가 (등록시)</label>
                        <input type="number" class="p16-base-price" value="${t.basePrice || ''}" placeholder="-" style="width:100%;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:13px;${t.autoFilled && t.basePrice ? 'color:#6b7280;' : ''}">
                      </div>
                      <div>
                        <label style="font-size:11px;color:#666;display:block;">${p.label} 시점 주가</label>
                        <input type="number" class="p16-price" value="${t.price || ''}" placeholder="${p.elapsed ? '입력' : '대기중'}" style="width:100%;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:13px;${t.autoFilled && t.price ? 'color:#6b7280;' : ''}">
                      </div>
                      <div style="font-size:13px;">
                        ${returnPct != null ? `
                          <div style="font-weight:600;color:${returnPct > 0 ? '#10b981' : returnPct < 0 ? '#ef4444' : '#6b7280'};">${formatPercent(returnPct)}</div>
                          ${toneHit ? `<div style="font-size:11px;">톤: ${toneHit === '적중' ? '✅' : '❌'} ${toneHit}</div>` : ''}
                          ${targetHit ? `<div style="font-size:11px;">목표: ${targetHit === '도달' ? '🎯' : '⚪'} ${targetHit}</div>` : ''}
                        ` : '<div style="color:#9ca3af;">-</div>'}
                      </div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          `).join('')}

          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
            <button id="p16-outcomes-cancel" style="padding:8px 16px;background:#f3f4f6;border:none;border-radius:6px;cursor:pointer;color:#333;">취소</button>
            <button id="p16-outcomes-save" style="padding:8px 16px;background:#10b981;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">💾 저장</button>
          </div>
        `}
      </div>
    `;

    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('#p16-outcomes-close').addEventListener('click', close);
    const cancelBtn = modal.querySelector('#p16-outcomes-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    const saveBtn = modal.querySelector('#p16-outcomes-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const outcomes = normalizeOutcomes(record.outcomes);
        modal.querySelectorAll('[data-period]').forEach(el => {
          const periodKey = el.getAttribute('data-period');
          const ticker = el.getAttribute('data-ticker');
          const basePrice = parseFloat(el.querySelector('.p16-base-price')?.value || '');
          const price = parseFloat(el.querySelector('.p16-price')?.value || '');
          if (!outcomes[periodKey]) outcomes[periodKey] = {};
          if (!isNaN(basePrice) || !isNaN(price)) {
            outcomes[periodKey][ticker] = {
              basePrice: isNaN(basePrice) ? null : basePrice,
              price: isNaN(price) ? null : price,
              evaluatedAt: new Date().toISOString()
            };
          }
        });

        try {
          await saveOutcomes(recordType, record.id, outcomes);
          alert('✅ 결과가 저장되었습니다.');
          close();
          try { window.__phase16List?.refresh?.(); } catch(_) {}
          try { window.__phase16Reports?.refreshList?.(); } catch(_) {}
        } catch(e) {
          alert('❌ 저장 실패: ' + e.message);
        }
      });
    }
  }

  async function calculateTrustScores() {
    const videos = await window.__phase16.getAllVideos();
    const reports = await window.__phase16.getAllReports();

    const channelScores = {};
    const analystScores = {};

    videos.forEach(v => {
      const outcomes = normalizeOutcomes(v.outcomes);
      if (!Object.keys(outcomes).length) return;
      const ch = v.channelName || '(unknown)';
      if (!channelScores[ch]) channelScores[ch] = { total: 0, hits: 0, evaluations: [] };
      const tickers = v.tickers || [];
      if (!tickers.length && v.overallTone) tickers.push({ code: '', tone: v.overallTone });
      PERIODS.forEach(p => {
        const periodData = outcomes[p.key];
        if (!periodData) return;
        tickers.forEach(t => {
          const data = periodData[t.code || ''];
          if (!data || data.basePrice == null || data.price == null) return;
          const ret = (data.price - data.basePrice) / data.basePrice * 100;
          const hit = evaluateTone(t.tone, ret);
          if (hit) {
            channelScores[ch].total++;
            if (hit === '적중') channelScores[ch].hits++;
            channelScores[ch].evaluations.push({ period: p.key, ticker: t.code, tone: t.tone, return: ret, hit });
          }
        });
      });
    });

    reports.forEach(r => {
      const outcomes = normalizeOutcomes(r.outcomes);
      if (!Object.keys(outcomes).length) return;
      const key = `${r.analyst || '(unknown)'} | ${r.firm || ''}`;
      if (!analystScores[key]) analystScores[key] = { total: 0, hits: 0, evaluations: [] };
      PERIODS.forEach(p => {
        const data = outcomes[p.key]?.[r.ticker];
        if (!data || data.basePrice == null || data.price == null) return;
        const ret = (data.price - data.basePrice) / data.basePrice * 100;
        const toneHit = evaluateTone(r.rating, ret);
        const targetHit = r.targetPrice ? evaluateTargetPrice(r.targetPrice, data.price) : null;
        if (toneHit) {
          analystScores[key].total++;
          if (toneHit === '적중') analystScores[key].hits++;
          analystScores[key].evaluations.push({ period: p.key, return: ret, toneHit, targetHit });
        }
      });
    });

    return { channelScores, analystScores };
  }

  // 영상과 리포트 카드 모두에서 추적 버튼 삽입
  // 영상: button.p16-edit[data-id^="v_"]
  // 리포트: button.pr16-edit[data-id^="r_"]
  async function injectTrackButtons() {
    const editButtons = document.querySelectorAll('button.p16-edit[data-id], button.pr16-edit[data-id]');
    let added = 0;
    editButtons.forEach(btn => {
      const parent = btn.parentElement;
      if (!parent) return;
      // 이미 추적 버튼이 있으면 스킵
      if (parent.querySelector('.p16-track-btn')) return;

      const dataId = btn.dataset.id || '';
      const isReport = btn.classList.contains('pr16-edit') || dataId.startsWith('r_');

      const trackBtn = document.createElement('button');
      trackBtn.className = 'p16-track-btn';
      trackBtn.textContent = '📊 추적';
      trackBtn.dataset.recordId = dataId;
      trackBtn.dataset.recordType = isReport ? 'report' : 'video';
      trackBtn.style.cssText = `
        background:#dbeafe;color:#1e40af;border:none;border-radius:4px;
        padding:4px 8px;font-size:12px;cursor:pointer;margin-right:4px;
      `;
      trackBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          const [videos, reports] = await Promise.all([
            window.__phase16.getAllVideos(),
            window.__phase16.getAllReports()
          ]);
          let record, type;
          if (isReport) {
            record = reports.find(r => r.id === dataId);
            type = 'report';
          } else {
            record = videos.find(v => v.id === dataId);
            type = 'video';
          }
          if (!record) {
            alert('❌ 해당 카드의 레코드를 찾을 수 없습니다. ID: ' + dataId);
            return;
          }
          await openOutcomesModal(type, record);
        } catch(err) {
          alert('❌ 오류: ' + err.message);
        }
      });
      parent.insertBefore(trackBtn, btn);
      added++;
    });
    return added;
  }

  function observe() {
    let timer = null;
    const debounced = () => {
      clearTimeout(timer);
      timer = setTimeout(() => injectTrackButtons(), 100);
    };
    const observer = new MutationObserver(debounced);
    observer.observe(document.body, { childList: true, subtree: true });
    // 주기적으로도 재시도 (카드 재렌더링 대비)
    setInterval(() => {
      const editBtns = document.querySelectorAll('button.p16-edit[data-id], button.pr16-edit[data-id]');
      const hasUntracked = Array.from(editBtns).some(b => {
        const parent = b.parentElement;
        return parent && !parent.querySelector('.p16-track-btn');
      });
      if (hasUntracked) injectTrackButtons();
    }, 1500);
  }

  async function init() {
    try {
      await waitForDeps();
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📊 Phase 16 결과 추적 v${VERSION}`);
      console.log(`   추적 기간: ${PERIODS.map(p => p.label).join(' / ')}`);
      console.log(`   판정 기준: 톤 ±${TONE_THRESHOLD}%, 목표가 ±${TARGET_PROXIMITY}%`);
      console.log(`   대상: 영상(p16-edit) + 리포트(pr16-edit)`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      observe();
    } catch(e) {
      console.error('[Phase16-outcomes] 초기화 실패:', e);
    }
  }

  window.__phase16Outcomes = {
    version: VERSION,
    openModal: openOutcomesModal,
    calculateTrustScores,
    injectButtons: injectTrackButtons,
    PERIODS,
    TONE_THRESHOLD,
    TARGET_PROXIMITY
  };

  setTimeout(init, 5500);
})();
