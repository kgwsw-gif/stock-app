// phase16-outcomes.js - 결과 추적 & 신뢰도 점수 v0.1.0
(function() {
  const VERSION = '0.1.0';
  const INSIGHT_DB = 'StockJournalInsightsDB';
  const MAIN_DB = 'StockJournalDB';

  // 추적 기간 (일 단위)
  const PERIODS = [
    { key: '1m', label: '1개월', days: 30 },
    { key: '3m', label: '3개월', days: 90 },
    { key: '6m', label: '6개월', days: 180 }
  ];

  // 적중 판정 기준
  const TONE_THRESHOLD = 5;        // 강세/약세 판정 ±5%
  const TARGET_PROXIMITY = 10;     // 목표가 도달 판정 ±10%

  // ─────────────────────────────────────────────
  // 의존성 대기
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // 유틸
  // ─────────────────────────────────────────────
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
    // 영상은 watchedAt, 리포트는 reportDate 우선
    return record.reportDate || record.watchedAt || record.createdAt || new Date().toISOString();
  }

  // ─────────────────────────────────────────────
  // 주가 자동 조회 (stock-app 메인 DB)
  // ─────────────────────────────────────────────
  function openMainDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(MAIN_DB);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getCurrentPrice(ticker) {
    try {
      const db = await openMainDB();
      if (!db.objectStoreNames.contains('holdings')) { db.close(); return null; }
      const list = await new Promise((res, rej) => {
        const r = db.transaction('holdings').objectStore('holdings').getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      db.close();
      const holding = list.find(h => h.code === ticker || h.ticker === ticker);
      if (!holding) return null;
      return Number(holding.currentPrice || holding.current_price || holding.price || 0) || null;
    } catch(e) {
      console.warn('[Outcomes] 현재가 조회 실패:', e);
      return null;
    }
  }

  async function getPriceFromSnapshot(ticker, targetDate) {
    // daily_snapshots에서 targetDate에 가장 가까운 (이전) 종가 조회
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
      // 스냅샷 구조가 다양할 수 있어 안전하게 검색
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
      // 3일 이내 데이터만 인정
      if (candidates[0].diff > 3 * 86400000) return null;
      return candidates[0].price;
    } catch(e) {
      console.warn('[Outcomes] 스냅샷 조회 실패:', e);
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // 적중 판정 로직
  // ─────────────────────────────────────────────
  function evaluateTone(tone, returnPct) {
    // tone: '강세' | '중립' | '약세' (또는 한글 변형)
    if (returnPct == null || isNaN(returnPct)) return null;
    const t = (tone || '').toString();
    if (/강세|상승|매수|bullish|buy/i.test(t)) return returnPct >= TONE_THRESHOLD ? '적중' : '미적중';
    if (/약세|하락|매도|bearish|sell/i.test(t)) return returnPct <= -TONE_THRESHOLD ? '적중' : '미적중';
    if (/중립|hold|neutral/i.test(t)) return (returnPct > -TONE_THRESHOLD && returnPct < TONE_THRESHOLD) ? '적중' : '미적중';
    return null;
  }

  function evaluateTargetPrice(targetPrice, actualPrice) {
    if (!targetPrice || !actualPrice) return null;
    const diff = Math.abs(actualPrice - targetPrice) / targetPrice * 100;
    return diff <= TARGET_PROXIMITY ? '도달' : '미도달';
  }

  // ─────────────────────────────────────────────
  // 결과 데이터 저장 (대상 레코드의 outcomes 필드 갱신)
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // 결과 추적 모달 UI
  // ─────────────────────────────────────────────
  async function openOutcomesModal(recordType, record) {
    const existing = document.getElementById('p16-outcomes-modal');
    if (existing) existing.remove();

    const registeredDate = getRegisteredDate(record);
    const registeredDays = daysSince(registeredDate);

    // 추적 대상 종목 추출
    let trackTickers = [];
    if (recordType === 'video') {
      trackTickers = (record.tickers || []).map(t => ({
        code: t.code,
        name: t.name || t.code,
        tone: t.tone,
        target: t.target
      }));
      // 전체 톤만 있고 종목별 톤이 없는 경우 첫 종목에 전체 톤 적용
      if (!trackTickers.length && record.overallTone) {
        trackTickers = [{ code: '', name: '(종목 미지정)', tone: record.overallTone }];
      }
    } else {
      // 리포트
      trackTickers = [{
        code: record.ticker,
        name: record.tickerName || record.ticker,
        tone: record.rating,
        target: record.targetPrice
      }];
    }

    // 기존 outcomes 데이터
    const existingOutcomes = record.outcomes || {};

    // 각 기간별 자동 조회 시도
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
        // 기존 저장된 값 우선
        const saved = existingOutcomes?.[period.key]?.[t.code];
        let price = saved?.price ?? null;
        let basePrice = saved?.basePrice ?? null;
        let autoFilled = false;
        if (price == null && elapsed) {
          // 자동 조회: 평가일 기준 스냅샷 → 최후엔 현재가
          price = await getPriceFromSnapshot(t.code, targetDate);
          if (price == null && registeredDays >= period.days) {
            // 기간이 충분히 지났지만 스냅샷 없음 - 현재가는 사용 안 함 (정확하지 않음)
            price = null;
          } else {
            autoFilled = true;
          }
        }
        if (basePrice == null) {
          // 기준가 자동 조회: 등록일 시점
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
              ${p.tickers.map((t, idx) => {
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
                        <input type="number" class="p16-price" value="${t.price || ''}" placeholder="${p.elapsed ? '입력' : '대기중'}" ${p.elapsed ? '' : 'disabled'} style="width:100%;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:13px;${t.autoFilled && t.price ? 'color:#6b7280;' : ''}">
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
        // 모든 기간/종목 데이터 수집
        const outcomes = { ...(record.outcomes || {}) };
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
          // 목록 새로고침 시도
          try { window.__phase16List?.refresh?.(); } catch(_) {}
          try { window.__phase16Reports?.refreshList?.(); } catch(_) {}
        } catch(e) {
          alert('❌ 저장 실패: ' + e.message);
        }
      });
    }
  }

  // ─────────────────────────────────────────────
  // 신뢰도 점수 계산 (채널/애널리스트별)
  // ─────────────────────────────────────────────
  async function calculateTrustScores() {
    const videos = await window.__phase16.getAllVideos();
    const reports = await window.__phase16.getAllReports();

    const channelScores = {}; // channelName → { total, hits, periods: {...} }
    const analystScores = {}; // "analyst|firm" → { ... }

    videos.forEach(v => {
      if (!v.outcomes) return;
      const ch = v.channelName || '(unknown)';
      if (!channelScores[ch]) channelScores[ch] = { total: 0, hits: 0, evaluations: [] };
      const tickers = v.tickers || [];
      if (!tickers.length && v.overallTone) tickers.push({ code: '', tone: v.overallTone });
      PERIODS.forEach(p => {
        const periodData = v.outcomes[p.key];
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
      if (!r.outcomes) return;
      const key = `${r.analyst || '(unknown)'} | ${r.firm || ''}`;
      if (!analystScores[key]) analystScores[key] = { total: 0, hits: 0, evaluations: [] };
      PERIODS.forEach(p => {
        const data = r.outcomes[p.key]?.[r.ticker];
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

  // ─────────────────────────────────────────────
  // 기존 카드에 "📊 결과 추적" 버튼 자동 삽입
  // ─────────────────────────────────────────────
  async function injectTrackButtons() {
    // 영상 카드 및 리포트 카드의 [수정] 버튼 옆에 추가
    // 카드의 data 속성이나 ID로 구분이 어려우므로, [수정] 버튼 옆에 일괄 추가
    const editButtons = document.querySelectorAll('button');
    let added = 0;
    editButtons.forEach(btn => {
      const txt = (btn.textContent || '').trim();
      if (txt !== '수정') return;
      // 이미 옆에 결과 추적 버튼이 있는지 확인
      const next = btn.nextElementSibling;
      if (next && next.classList.contains('p16-track-btn')) return;
      const prev = btn.previousElementSibling;
      if (prev && prev.classList.contains('p16-track-btn')) return;

      const trackBtn = document.createElement('button');
      trackBtn.className = 'p16-track-btn';
      trackBtn.textContent = '📊 추적';
      trackBtn.style.cssText = `
        background:#dbeafe;color:#1e40af;border:none;border-radius:4px;
        padding:4px 8px;font-size:12px;cursor:pointer;margin-right:4px;
      `;
      trackBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 카드 컨텍스트에서 record 식별
        const card = btn.closest('[data-id]') || btn.closest('div');
        const recordId = card?.getAttribute('data-id');
        // 영상인지 리포트인지 판별: getAllReports에서 id 일치 확인
        try {
          const [videos, reports] = await Promise.all([
            window.__phase16.getAllVideos(),
            window.__phase16.getAllReports()
          ]);
          let record, type;
          if (recordId) {
            record = videos.find(v => v.id === recordId);
            if (record) type = 'video';
            else {
              record = reports.find(r => r.id === recordId);
              if (record) type = 'report';
            }
          }
          if (!record) {
            // fallback: 카드 텍스트에서 추정
            const cardText = card?.textContent || '';
            record = videos.find(v => cardText.includes(v.channelName || '') && cardText.includes((v.summary?.[0] || '').slice(0, 10)));
            if (record) type = 'video';
            else {
              record = reports.find(r => cardText.includes(r.analyst || '') && cardText.includes(r.tickerName || r.ticker || ''));
              if (record) type = 'report';
            }
          }
          if (!record) {
            alert('❌ 해당 카드의 레코드를 찾을 수 없습니다.');
            return;
          }
          await openOutcomesModal(type, record);
        } catch(err) {
          alert('❌ 오류: ' + err.message);
        }
      });
      btn.parentElement.insertBefore(trackBtn, btn);
      added++;
    });
    return added;
  }

  function observe() {
    let timer = null;
    const debounced = () => {
      clearTimeout(timer);
      timer = setTimeout(() => injectTrackButtons(), 200);
    };
    const observer = new MutationObserver(debounced);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─────────────────────────────────────────────
  // 초기화
  // ─────────────────────────────────────────────
  async function init() {
    try {
      await waitForDeps();
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📊 Phase 16 결과 추적 v${VERSION}`);
      console.log(`   추적 기간: ${PERIODS.map(p => p.label).join(' / ')}`);
      console.log(`   판정 기준: 톤 ±${TONE_THRESHOLD}%, 목표가 ±${TARGET_PROXIMITY}%`);
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
