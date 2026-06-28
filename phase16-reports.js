// phase16-reports.js - 애널리스트 리포트 v0.1.0
(function() {
  const VERSION = '0.1.0';
  const INSIGHT_DB = 'StockJournalInsightsDB';
  const MAIN_DB = 'StockJournalDB';
  const STORE = 'analyst_reports';

  function waitForPhase16(maxWait = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.__phase16?.getAllReports) return resolve();
        if (Date.now() - start > maxWait) return reject(new Error('timeout'));
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
    const diff = Math.floor((new Date() - d) / 86400000);
    if (diff === 0) return '오늘';
    if (diff === 1) return '어제';
    if (diff < 7) return `${diff}일 전`;
    if (diff < 30) return `${Math.floor(diff/7)}주 전`;
    return dateStr;
  }

  function uuid() {
    return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function openInsightDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(INSIGHT_DB, 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  // ─────────────────────────────────────────────
  // 메인 DB에서 보유 종목 + 현재가 읽기
  // ─────────────────────────────────────────────
  async function getHoldingsWithPrice() {
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
        price: h.currentPrice ?? h.lastPrice ?? h.price ?? null
      })).filter(x => x.code);
    } catch (e) {
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // CRUD
  // ─────────────────────────────────────────────
  async function saveReport(record) {
    const db = await openInsightDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(record);
      req.onsuccess = () => { db.close(); res(record); };
      req.onerror = () => { db.close(); rej(req.error); };
    });
  }

  async function deleteReport(id) {
    const db = await openInsightDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = () => { db.close(); res(); };
      req.onerror = () => { db.close(); rej(req.error); };
    });
  }

  // ─────────────────────────────────────────────
  // 리포트 입력 모달
  // ─────────────────────────────────────────────
  async function openReportModal(editRecord = null) {
    const holdings = await getHoldingsWithPrice();
    const existing = editRecord || {};
    const today = new Date(Date.now() + 9*3600000).toISOString().slice(0, 10);

    const modal = document.createElement('div');
    modal.id = 'phase16-report-modal';
    modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999999;display:flex;align-items:center;justify-content:center;padding:20px;`;
    modal.innerHTML = `
      <div style="background:white;border-radius:12px;max-width:680px;width:100%;max-height:90vh;overflow-y:auto;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <h2 style="margin:0;font-size:20px;">📄 ${editRecord ? '리포트 수정' : '새 애널리스트 리포트'}</h2>
          <button id="pr16-close" style="border:none;background:none;font-size:24px;cursor:pointer;">✕</button>
        </div>

        <div style="display:grid;gap:14px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <label style="font-weight:600;font-size:13px;">애널리스트 *
              <input id="pr16-analyst" type="text" placeholder="예: 홍길동" value="${existing.analyst || ''}"
                style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
            </label>
            <label style="font-weight:600;font-size:13px;">증권사
              <input id="pr16-firm" type="text" placeholder="예: OO증권" value="${existing.firm || ''}"
                style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
            </label>
          </div>

          <label style="font-weight:600;font-size:13px;">리포트 작성일
            <input id="pr16-date" type="date" value="${existing.reportDate || today}"
              style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
          </label>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <label style="font-weight:600;font-size:13px;">종목코드 *
              <input id="pr16-ticker" type="text" list="pr16-holdings-list" placeholder="예: 005930" value="${existing.ticker || ''}"
                style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
            </label>
            <label style="font-weight:600;font-size:13px;">종목명
              <input id="pr16-tname" type="text" placeholder="예: 삼성전자" value="${existing.tickerName || ''}"
                style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
            </label>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
            <label style="font-weight:600;font-size:13px;">등급
              <select id="pr16-rating" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
                <option value="buy" ${existing.rating==='buy'?'selected':''}>🔼 매수</option>
                <option value="hold" ${(!existing.rating||existing.rating==='hold')?'selected':''}>➖ 중립</option>
                <option value="sell" ${existing.rating==='sell'?'selected':''}>🔽 매도</option>
              </select>
            </label>
            <label style="font-weight:600;font-size:13px;">목표가
              <input id="pr16-target" type="number" placeholder="원" value="${existing.targetPrice || ''}"
                style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
            </label>
            <label style="font-weight:600;font-size:13px;">현재가
              <input id="pr16-current" type="number" placeholder="자동" value="${existing.currentPrice || ''}"
                style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
            </label>
          </div>

          <div id="pr16-return-preview" style="display:none;padding:10px;background:#f0f9ff;border-radius:6px;font-size:13px;color:#0369a1;"></div>

          <label style="font-weight:600;font-size:13px;">핵심 근거
            <textarea id="pr16-summary" rows="3" placeholder="리포트의 핵심 논리를 요약..."
              style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;resize:vertical;box-sizing:border-box;">${existing.summary || ''}</textarea>
          </label>

          <label style="font-weight:600;font-size:13px;">리포트 URL (선택)
            <input id="pr16-url" type="url" placeholder="https://..." value="${existing.reportUrl || ''}"
              style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
          </label>

          <label style="font-weight:600;font-size:13px;">내 메모 (선택)
            <textarea id="pr16-note" rows="2" placeholder="이 리포트에 대한 내 판단..."
              style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;resize:vertical;box-sizing:border-box;">${existing.myNote || ''}</textarea>
          </label>

          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px;">
            <button id="pr16-cancel" style="padding:10px 20px;border:1px solid #ddd;background:white;border-radius:6px;cursor:pointer;">취소</button>
            <button id="pr16-save" style="padding:10px 24px;background:#10b981;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">저장</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // 보유 종목 datalist
    const dl = document.createElement('datalist');
    dl.id = 'pr16-holdings-list';
    dl.innerHTML = holdings.map(h => `<option value="${h.code}">${h.name}</option>`).join('');
    modal.appendChild(dl);

    // 종목 자동완성 + 현재가 자동 채움
    const tickerInput = modal.querySelector('#pr16-ticker');
    const tnameInput = modal.querySelector('#pr16-tname');
    const currentInput = modal.querySelector('#pr16-current');

    function autofillTicker() {
      const v = tickerInput.value.trim();
      const match = holdings.find(h => h.code === v || h.name === v);
      if (match) {
        tickerInput.value = match.code;
        if (!tnameInput.value) tnameInput.value = match.name;
        if (!currentInput.value && match.price) currentInput.value = match.price;
        updateReturnPreview();
      }
    }
    tickerInput.addEventListener('change', autofillTicker);
    tickerInput.addEventListener('blur', autofillTicker);

    // 수익률 미리보기
    const targetInput = modal.querySelector('#pr16-target');
    const previewDiv = modal.querySelector('#pr16-return-preview');
    function updateReturnPreview() {
      const target = parseFloat(targetInput.value);
      const current = parseFloat(currentInput.value);
      if (target > 0 && current > 0) {
        const ret = ((target - current) / current * 100).toFixed(2);
        const sign = ret > 0 ? '+' : '';
        const color = ret > 0 ? '#dc2626' : ret < 0 ? '#2563eb' : '#525252';
        previewDiv.style.display = 'block';
        previewDiv.style.color = color;
        previewDiv.innerHTML = `📊 예상 수익률: <strong>${sign}${ret}%</strong> (${current.toLocaleString()} → ${target.toLocaleString()}원)`;
      } else {
        previewDiv.style.display = 'none';
      }
    }
    targetInput.addEventListener('input', updateReturnPreview);
    currentInput.addEventListener('input', updateReturnPreview);
    updateReturnPreview();

    modal.querySelector('#pr16-close').onclick = () => modal.remove();
    modal.querySelector('#pr16-cancel').onclick = () => modal.remove();

    modal.querySelector('#pr16-save').onclick = async () => {
      const analyst = modal.querySelector('#pr16-analyst').value.trim();
      const ticker = tickerInput.value.trim();
      const summary = modal.querySelector('#pr16-summary').value.trim();

      if (!analyst) { alert('애널리스트 이름을 입력해주세요.'); return; }
      if (!ticker) { alert('종목코드를 입력해주세요.'); return; }
      if (!summary) { alert('핵심 근거를 입력해주세요.'); return; }

      const now = new Date().toISOString();
      const record = {
        id: existing.id || uuid(),
        analyst,
        firm: modal.querySelector('#pr16-firm').value.trim(),
        reportDate: modal.querySelector('#pr16-date').value,
        ticker,
        tickerName: tnameInput.value.trim(),
        rating: modal.querySelector('#pr16-rating').value,
        targetPrice: parseInt(targetInput.value) || null,
        currentPrice: parseInt(currentInput.value) || null,
        summary,
        reportUrl: modal.querySelector('#pr16-url').value.trim(),
        myNote: modal.querySelector('#pr16-note').value.trim(),
        outcomes: existing.outcomes || [],
        createdAt: existing.createdAt || now,
        updatedAt: now
      };

      try {
        await saveReport(record);
        console.log(`[Phase16-reports] ✅ 저장: ${record.id}`);
        modal.remove();
        alert('✅ 저장되었습니다.');
        if (window.__phase16Reports?.refreshList) window.__phase16Reports.refreshList();
      } catch (e) {
        console.error('[Phase16-reports] 저장 실패:', e);
        alert('저장 실패: ' + e.message);
      }
    };
  }

  // ─────────────────────────────────────────────
  // 리포트 목록 화면
  // ─────────────────────────────────────────────
  let listModalEl = null;
  let filterState = { search: '', ticker: '', rating: 'all' };

  const RATING_LABELS = {
    buy: { text: '🔼 매수', color: '#dc2626', bg: '#fee2e2' },
    hold: { text: '➖ 중립', color: '#525252', bg: '#f5f5f5' },
    sell: { text: '🔽 매도', color: '#2563eb', bg: '#dbeafe' }
  };

  function renderReportCard(r) {
    const rate = RATING_LABELS[r.rating] || RATING_LABELS.hold;
    let returnHtml = '';
    if (r.targetPrice && r.currentPrice) {
      const ret = ((r.targetPrice - r.currentPrice) / r.currentPrice * 100).toFixed(1);
      const sign = ret > 0 ? '+' : '';
      const color = ret > 0 ? '#dc2626' : ret < 0 ? '#2563eb' : '#525252';
      returnHtml = `<span style="color:${color};font-weight:600;">목표 ${sign}${ret}%</span>`;
    }

    return `
      <div class="pr16-card" data-id="${r.id}" style="background:white;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;gap:10px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="font-weight:700;color:#111;">📄 ${escapeHtml(r.analyst)}</span>
              ${r.firm ? `<span style="font-size:12px;color:#6b7280;">${escapeHtml(r.firm)}</span>` : ''}
              <span style="font-size:11px;color:#9ca3af;">${daysAgo(r.reportDate)}</span>
              <span style="padding:2px 8px;border-radius:10px;background:${rate.bg};color:${rate.color};font-size:11px;font-weight:600;">${rate.text}</span>
            </div>
            <div style="margin-top:6px;font-size:14px;">
              <strong>${escapeHtml(r.tickerName || r.ticker)}</strong>
              <span style="color:#6b7280;font-size:12px;">(${escapeHtml(r.ticker)})</span>
              ${r.targetPrice ? `<span style="margin-left:10px;color:#374151;font-size:13px;">목표 <strong>${r.targetPrice.toLocaleString()}원</strong></span>` : ''}
              ${r.currentPrice ? `<span style="margin-left:6px;color:#9ca3af;font-size:12px;">(현재 ${r.currentPrice.toLocaleString()}원)</span>` : ''}
              ${returnHtml ? `<span style="margin-left:10px;font-size:13px;">${returnHtml}</span>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:5px;flex-shrink:0;">
            <button class="pr16-edit" data-id="${r.id}" style="border:1px solid #ddd;background:white;padding:4px 9px;border-radius:5px;cursor:pointer;font-size:12px;">수정</button>
            <button class="pr16-del" data-id="${r.id}" style="border:1px solid #fecaca;background:#fef2f2;color:#dc2626;padding:4px 9px;border-radius:5px;cursor:pointer;font-size:12px;">삭제</button>
          </div>
        </div>
        ${r.summary ? `<div style="font-size:13px;color:#374151;margin:8px 0;padding-left:8px;border-left:2px solid #e5e7eb;">${escapeHtml(r.summary)}</div>` : ''}
        ${r.myNote ? `<div style="margin-top:8px;padding:8px;background:#fffbeb;border-left:3px solid #f59e0b;font-size:12px;color:#78350f;">💭 ${escapeHtml(r.myNote)}</div>` : ''}
        ${r.reportUrl ? `<div style="margin-top:8px;"><a href="${escapeHtml(r.reportUrl)}" target="_blank" rel="noopener" style="padding:4px 10px;background:#f0fdf4;color:#10b981;border:1px solid #bbf7d0;border-radius:5px;font-size:12px;text-decoration:none;">📄 리포트 원문</a></div>` : ''}
      </div>
    `;
  }

  async function openReportList() {
    if (listModalEl) listModalEl.remove();

    const modal = document.createElement('div');
    listModalEl = modal;
    modal.id = 'phase16-report-list';
    modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px;`;
    modal.innerHTML = `
      <div style="background:#f9fafb;border-radius:14px;max-width:900px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 25px 70px rgba(0,0,0,0.3);">
        <div style="padding:18px 22px;border-bottom:1px solid #e5e7eb;background:white;border-radius:14px 14px 0 0;display:flex;justify-content:space-between;align-items:center;">
          <h2 style="margin:0;font-size:18px;display:flex;align-items:center;gap:8px;">📄 애널리스트 리포트 <span id="pr16-count" style="font-size:13px;color:#6b7280;font-weight:400;"></span></h2>
          <div style="display:flex;gap:8px;">
            <button id="pr16-new" style="padding:8px 14px;background:#10b981;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;">+ 새 리포트</button>
            <button id="pr16-list-close" style="border:none;background:none;font-size:24px;cursor:pointer;color:#6b7280;">✕</button>
          </div>
        </div>
        <div style="padding:14px 22px;background:white;border-bottom:1px solid #e5e7eb;">
          <div style="display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:8px;">
            <input id="pr16-f-search" type="search" placeholder="🔍 검색 (애널리스트/근거/메모)" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
            <input id="pr16-f-ticker" type="search" placeholder="🏷️ 종목" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
            <select id="pr16-f-rating" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;background:white;">
              <option value="all">모든 등급</option>
              <option value="buy">🔼 매수</option>
              <option value="hold">➖ 중립</option>
              <option value="sell">🔽 매도</option>
            </select>
          </div>
        </div>
        <div id="pr16-body" style="flex:1;overflow-y:auto;padding:18px 22px;">
          <div style="text-align:center;color:#9ca3af;padding:60px 0;">로딩 중...</div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#pr16-list-close').onclick = () => { modal.remove(); listModalEl = null; };
    modal.addEventListener('click', (e) => {
      if (e.target === modal) { modal.remove(); listModalEl = null; }
    });

    modal.querySelector('#pr16-new').onclick = async () => {
      await openReportModal();
      // 저장 후 새로고침
      const before = (await window.__phase16.getAllReports()).length;
      const poll = setInterval(async () => {
        const list = await window.__phase16.getAllReports();
        if (list.length !== before) { clearInterval(poll); refreshList(); }
      }, 500);
      setTimeout(() => clearInterval(poll), 30000);
    };

    let timer;
    const onFilter = () => {
      filterState.search = modal.querySelector('#pr16-f-search').value.trim();
      filterState.ticker = modal.querySelector('#pr16-f-ticker').value.trim();
      filterState.rating = modal.querySelector('#pr16-f-rating').value;
      refreshList();
    };
    modal.querySelector('#pr16-f-search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(onFilter, 200); });
    modal.querySelector('#pr16-f-ticker').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(onFilter, 200); });
    modal.querySelector('#pr16-f-rating').addEventListener('change', onFilter);

    await refreshList();
  }

  async function refreshList() {
    if (!listModalEl) return;
    const body = listModalEl.querySelector('#pr16-body');
    const countEl = listModalEl.querySelector('#pr16-count');

    try {
      const all = await window.__phase16.getAllReports();
      all.sort((a, b) => (b.reportDate || '').localeCompare(a.reportDate || ''));

      // 필터링
      const q = filterState.search.toLowerCase();
      const tq = filterState.ticker.toLowerCase();
      const filtered = all.filter(r => {
        if (q) {
          const hay = [r.analyst, r.firm, r.summary, r.myNote, r.tickerName].filter(Boolean).join(' ').toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (tq) {
          const t = ((r.ticker || '') + ' ' + (r.tickerName || '')).toLowerCase();
          if (!t.includes(tq)) return false;
        }
        if (filterState.rating !== 'all' && r.rating !== filterState.rating) return false;
        return true;
      });

      countEl.textContent = filtered.length === all.length ? `(${all.length}개)` : `(${filtered.length} / 전체 ${all.length}개)`;

      if (all.length === 0) {
        body.innerHTML = `
          <div style="text-align:center;padding:60px 20px;color:#9ca3af;">
            <div style="font-size:48px;margin-bottom:12px;">📭</div>
            <div style="font-size:15px;margin-bottom:8px;">아직 저장된 리포트가 없습니다</div>
            <div style="font-size:13px;">상단 [+ 새 리포트] 버튼으로 첫 리포트를 등록해보세요.</div>
          </div>
        `;
        return;
      }
      if (filtered.length === 0) {
        body.innerHTML = `<div style="text-align:center;padding:60px 20px;color:#9ca3af;"><div style="font-size:36px;margin-bottom:12px;">🔍</div><div style="font-size:14px;">조건에 맞는 리포트가 없습니다</div></div>`;
        return;
      }

      body.innerHTML = filtered.map(renderReportCard).join('');

      body.querySelectorAll('.pr16-del').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          const r = all.find(x => x.id === id);
          if (!confirm(`정말 삭제할까요?\n\n${r?.analyst || ''} - ${r?.tickerName || ''}`)) return;
          try {
            await deleteReport(id);
            await refreshList();
          } catch (err) { alert('삭제 실패: ' + err.message); }
        };
      });

      body.querySelectorAll('.pr16-edit').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          const r = all.find(x => x.id === id);
          if (!r) return;
          const oldUpdated = r.updatedAt;
          await openReportModal(r);
          const poll = setInterval(async () => {
            const list = await window.__phase16.getAllReports();
            const updated = list.find(x => x.id === id);
            if (updated && updated.updatedAt !== oldUpdated) { clearInterval(poll); refreshList(); }
          }, 500);
          setTimeout(() => clearInterval(poll), 30000);
        };
      });

    } catch (e) {
      body.innerHTML = `<div style="color:#dc2626;padding:20px;">조회 실패: ${escapeHtml(e.message)}</div>`;
    }
  }

  async function init() {
    try {
      await waitForPhase16();
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📄 Phase 16 애널리스트 리포트 v${VERSION}`);
      console.log(`   사용: window.__phase16Reports.openList()`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    } catch (e) {
      console.error('[Phase16-reports] 초기화 실패:', e);
    }
  }

  window.__phase16Reports = {
    version: VERSION,
    openModal: openReportModal,
    openList: openReportList,
    refreshList,
    save: saveReport,
    delete: deleteReport
  };

  setTimeout(init, 4000);
})();
