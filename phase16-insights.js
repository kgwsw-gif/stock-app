// phase16-insights.js - 인사이트 시스템 v0.2.0 (Phase 1: 수동 입력, 별도 DB)
(function() {
  const VERSION = '0.2.0';
  const INSIGHT_DB = 'StockJournalInsightsDB';  // 별도 DB
  const MAIN_DB = 'StockJournalDB';              // 기존 DB (읽기 전용)
  const STORES = {
    channels: 'youtube_channels',
    videos: 'video_insights',
    reports: 'analyst_reports'
  };

  let dbReady = false;
  let dbInitPromise = null;

  // ─────────────────────────────────────────────
  // 인사이트 DB 초기화 (사용자 첫 클릭 시에만)
  // ─────────────────────────────────────────────
  function initInsightDB() {
    if (dbReady) return Promise.resolve();
    if (dbInitPromise) return dbInitPromise;

    dbInitPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('DB 초기화 5초 타임아웃'));
      }, 5000);

      const req = indexedDB.open(INSIGHT_DB, 1);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        Object.values(STORES).forEach(name => {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: 'id' });
            if (name === STORES.videos) {
              store.createIndex('watchedAt', 'watchedAt');
              store.createIndex('channelName', 'channelName');
            }
            if (name === STORES.reports) {
              store.createIndex('reportDate', 'reportDate');
              store.createIndex('ticker', 'ticker');
            }
          }
        });
      };

      req.onblocked = () => {
        clearTimeout(timeout);
        reject(new Error('DB 차단됨 - 다른 탭 확인'));
      };

      req.onsuccess = () => {
        clearTimeout(timeout);
        req.result.close();
        dbReady = true;
        console.log(`[Phase16 v${VERSION}] ✅ 인사이트 DB 준비 완료`);
        resolve();
      };

      req.onerror = () => {
        clearTimeout(timeout);
        reject(req.error);
      };
    });

    return dbInitPromise;
  }

  function openInsightDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(INSIGHT_DB, 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  // ─────────────────────────────────────────────
  // 메인 DB에서 보유 종목 읽기만 (쓰기 안 함)
  // ─────────────────────────────────────────────
  async function getHoldingsTickers() {
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
        name: h.name || h.tickerName || h.ticker
      })).filter(x => x.code);
    } catch (e) {
      console.warn('[Phase16] 보유 종목 조회 실패 (계속 진행):', e.message);
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // CRUD 헬퍼
  // ─────────────────────────────────────────────
  async function putRecord(storeName, record) {
    const db = await openInsightDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put(record);
      req.onsuccess = () => { db.close(); res(record); };
      req.onerror = () => { db.close(); rej(req.error); };
    });
  }

  async function getAllRecords(storeName) {
    if (!dbReady) {
      try { await initInsightDB(); } catch (e) { return []; }
    }
    const db = await openInsightDB();
    return new Promise((res) => {
      const req = db.transaction(storeName).objectStore(storeName).getAll();
      req.onsuccess = () => { db.close(); res(req.result || []); };
      req.onerror = () => { db.close(); res([]); };
    });
  }

  async function deleteRecord(storeName, id) {
    const db = await openInsightDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).delete(id);
      req.onsuccess = () => { db.close(); res(); };
      req.onerror = () => { db.close(); rej(req.error); };
    });
  }

  function uuid() {
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  // ─────────────────────────────────────────────
  // 영상 입력 모달
  // ─────────────────────────────────────────────
  async function openVideoModal(editRecord = null) {
    try {
      await initInsightDB();
    } catch (e) {
      alert(`인사이트 DB 초기화 실패: ${e.message}\n\n다른 탭을 모두 닫고 다시 시도해주세요.`);
      console.error('[Phase16] DB 초기화 실패:', e);
      return;
    }

    const holdings = await getHoldingsTickers();
    const existing = editRecord || {};
    const today = new Date(Date.now() + 9*3600000).toISOString().slice(0, 10);

    const modal = document.createElement('div');
    modal.id = 'phase16-video-modal';
    modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999999;display:flex;align-items:center;justify-content:center;padding:20px;`;
    modal.innerHTML = `
      <div style="background:white;border-radius:12px;max-width:680px;width:100%;max-height:90vh;overflow-y:auto;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <h2 style="margin:0;font-size:20px;">📺 ${editRecord ? '영상 수정' : '새 YouTube 영상 입력'}</h2>
          <button id="p16-close" style="border:none;background:none;font-size:24px;cursor:pointer;">✕</button>
        </div>
        <div style="display:grid;gap:14px;">
          <label style="font-weight:600;font-size:13px;">영상 URL
            <input id="p16-url" type="url" placeholder="https://youtube.com/watch?v=..." value="${existing.videoUrl || ''}" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <label style="font-weight:600;font-size:13px;">채널명
              <input id="p16-channel" type="text" placeholder="예: 슈카월드" value="${existing.channelName || ''}" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
            </label>
            <label style="font-weight:600;font-size:13px;">영상 제목
              <input id="p16-title" type="text" placeholder="(선택)" value="${existing.videoTitle || ''}" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <label style="font-weight:600;font-size:13px;">영상 업로드일
              <input id="p16-pub" type="date" value="${existing.publishedAt || today}" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
            </label>
            <label style="font-weight:600;font-size:13px;">시청일
              <input id="p16-watch" type="date" value="${existing.watchedAt || today}" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
            </label>
          </div>
          <div>
            <div style="font-weight:600;font-size:13px;margin-bottom:6px;">핵심 요약 (3줄 권장)</div>
            <input id="p16-sum1" type="text" placeholder="핵심 1" value="${(existing.summary && existing.summary[0]) || ''}" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-bottom:6px;font-size:14px;box-sizing:border-box;">
            <input id="p16-sum2" type="text" placeholder="핵심 2" value="${(existing.summary && existing.summary[1]) || ''}" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-bottom:6px;font-size:14px;box-sizing:border-box;">
            <input id="p16-sum3" type="text" placeholder="핵심 3" value="${(existing.summary && existing.summary[2]) || ''}" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;box-sizing:border-box;">
          </div>
          <div>
            <div style="font-weight:600;font-size:13px;margin-bottom:6px;">언급 종목</div>
            <div id="p16-tickers" style="display:flex;flex-direction:column;gap:8px;"></div>
            <button id="p16-add-ticker" type="button" style="margin-top:8px;padding:8px 14px;background:#f0f4ff;border:1px dashed #4a7eff;border-radius:6px;cursor:pointer;font-size:13px;color:#4a7eff;">+ 종목 추가</button>
          </div>
          <label style="font-weight:600;font-size:13px;">영상 전체 톤
            <select id="p16-tone" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;box-sizing:border-box;">
              <option value="bullish" ${existing.overallTone==='bullish'?'selected':''}>🔼 강세 (Bullish)</option>
              <option value="neutral" ${(!existing.overallTone||existing.overallTone==='neutral')?'selected':''}>➖ 중립 (Neutral)</option>
              <option value="bearish" ${existing.overallTone==='bearish'?'selected':''}>🔽 약세 (Bearish)</option>
            </select>
          </label>
          <label style="font-weight:600;font-size:13px;">내 메모 (선택)
            <textarea id="p16-note" rows="2" placeholder="개인적인 판단/감상..." style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;resize:vertical;box-sizing:border-box;">${existing.myNote || ''}</textarea>
          </label>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px;">
            <button id="p16-cancel" style="padding:10px 20px;border:1px solid #ddd;background:white;border-radius:6px;cursor:pointer;">취소</button>
            <button id="p16-save" style="padding:10px 24px;background:#4a7eff;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">저장</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const tickersDiv = modal.querySelector('#p16-tickers');
    function addTickerRow(data = {}) {
      const row = document.createElement('div');
      row.className = 'p16-ticker-row';
      row.style.cssText = 'display:grid;grid-template-columns:1.3fr 1fr 0.9fr 1fr auto;gap:6px;align-items:center;';
      row.innerHTML = `
        <input class="p16-tk-code" type="text" list="p16-holdings-list" placeholder="종목코드/명" value="${data.code || ''}" style="padding:8px;border:1px solid #ddd;border-radius:5px;font-size:13px;box-sizing:border-box;">
        <input class="p16-tk-name" type="text" placeholder="종목명" value="${data.name || ''}" style="padding:8px;border:1px solid #ddd;border-radius:5px;font-size:13px;box-sizing:border-box;">
        <select class="p16-tk-tone" style="padding:8px;border:1px solid #ddd;border-radius:5px;font-size:13px;">
          <option value="buy" ${data.tone==='buy'?'selected':''}>매수</option>
          <option value="hold" ${(!data.tone||data.tone==='hold')?'selected':''}>중립</option>
          <option value="sell" ${data.tone==='sell'?'selected':''}>매도</option>
        </select>
        <input class="p16-tk-target" type="number" placeholder="목표가" value="${data.target || ''}" style="padding:8px;border:1px solid #ddd;border-radius:5px;font-size:13px;box-sizing:border-box;">
        <button type="button" class="p16-tk-del" style="border:none;background:#fee;color:#c33;padding:6px 10px;border-radius:5px;cursor:pointer;">✕</button>
      `;
      row.querySelector('.p16-tk-del').onclick = () => row.remove();
      row.querySelector('.p16-tk-code').addEventListener('change', (e) => {
        const v = e.target.value.trim();
        const match = holdings.find(h => h.code === v || h.name === v);
        if (match) {
          row.querySelector('.p16-tk-code').value = match.code;
          if (!row.querySelector('.p16-tk-name').value) {
            row.querySelector('.p16-tk-name').value = match.name;
          }
        }
      });
      tickersDiv.appendChild(row);
    }

    const dl = document.createElement('datalist');
    dl.id = 'p16-holdings-list';
    dl.innerHTML = holdings.map(h => `<option value="${h.code}">${h.name}</option>`).join('');
    modal.appendChild(dl);

    if (existing.tickers && existing.tickers.length) {
      existing.tickers.forEach(t => addTickerRow(t));
    } else {
      addTickerRow();
    }

    modal.querySelector('#p16-add-ticker').onclick = () => addTickerRow();
    modal.querySelector('#p16-close').onclick = () => modal.remove();
    modal.querySelector('#p16-cancel').onclick = () => modal.remove();

    modal.querySelector('#p16-save').onclick = async () => {
      const channelName = modal.querySelector('#p16-channel').value.trim();
      const url = modal.querySelector('#p16-url').value.trim();
      const summary = [
        modal.querySelector('#p16-sum1').value.trim(),
        modal.querySelector('#p16-sum2').value.trim(),
        modal.querySelector('#p16-sum3').value.trim()
      ].filter(Boolean);

      if (!channelName && !url) { alert('채널명 또는 영상 URL은 입력해주세요.'); return; }
      if (summary.length === 0) { alert('핵심 요약을 최소 1줄 입력해주세요.'); return; }

      const tickers = [];
      modal.querySelectorAll('.p16-ticker-row').forEach(row => {
        const code = row.querySelector('.p16-tk-code').value.trim();
        const name = row.querySelector('.p16-tk-name').value.trim();
        if (!code && !name) return;
        tickers.push({
          code, name,
          tone: row.querySelector('.p16-tk-tone').value,
          target: parseInt(row.querySelector('.p16-tk-target').value) || null,
          reason: ''
        });
      });

      const now = new Date().toISOString();
      const record = {
        id: existing.id || uuid(),
        channelId: existing.channelId || null,
        channelName,
        videoUrl: url,
        videoTitle: modal.querySelector('#p16-title').value.trim(),
        publishedAt: modal.querySelector('#p16-pub').value,
        watchedAt: modal.querySelector('#p16-watch').value,
        summary,
        tickers,
        overallTone: modal.querySelector('#p16-tone').value,
        myNote: modal.querySelector('#p16-note').value.trim(),
        source: 'manual',
        outcomes: existing.outcomes || [],
        createdAt: existing.createdAt || now,
        updatedAt: now
      };

      try {
        await putRecord(STORES.videos, record);
        console.log(`[Phase16] ✅ 영상 저장: ${record.id}`);
        modal.remove();
        alert('✅ 저장되었습니다.');
      } catch (e) {
        console.error('[Phase16] 저장 실패:', e);
        alert('저장 실패: ' + e.message);
      }
    };
  }

  // ─────────────────────────────────────────────
  // 메뉴 클릭 후킹 (기존 "📰 인사이트" 버튼이 이미 있으면 재사용)
  // ─────────────────────────────────────────────
  function hookInsightButton() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button, a, div');
      if (!btn) return;
      const txt = btn.textContent || '';
      // "📰 인사이트" 텍스트를 정확히 매칭 (다른 인사이트 단어 오인 방지)
      if (/📰\s*인사이트/.test(txt) && txt.length < 20) {
        e.preventDefault();
        e.stopPropagation();
        openVideoModal();
      }
    }, true);
  }

  // ─────────────────────────────────────────────
  // 초기화 (DB 안 건드림, 메뉴 후킹만)
  // ─────────────────────────────────────────────
  function init() {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📰 Phase 16 인사이트 시스템 v${VERSION}`);
    console.log(`   별도 DB: ${INSIGHT_DB}`);
    console.log(`   메인 DB 영향 없음 (읽기만)`);
    console.log(`   사용: window.__phase16.openVideoModal()`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    hookInsightButton();
  }

  window.__phase16 = {
    version: VERSION,
    openVideoModal,
    getAllVideos: () => getAllRecords(STORES.videos),
    getAllReports: () => getAllRecords(STORES.reports),
    getAllChannels: () => getAllRecords(STORES.channels),
    deleteVideo: (id) => deleteRecord(STORES.videos, id),
    initInsightDB,
    _internal: { openInsightDB, STORES, INSIGHT_DB }
  };

  setTimeout(init, 3000);
})();
