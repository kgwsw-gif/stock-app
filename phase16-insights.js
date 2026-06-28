// phase16-insights.js - 인사이트 관리 시스템 v0.1 (Phase 1: 수동 입력)
(function() {
  const VERSION = '0.1.0';
  const DB_NAME = 'StockJournalDB';
  const STORES = {
    channels: 'youtube_channels',
    videos: 'video_insights',
    reports: 'analyst_reports'
  };

  // ─────────────────────────────────────────────
  // DB 초기화: 기존 DB에 새 store 3개 추가
  // ─────────────────────────────────────────────
  async function ensureStores() {
    return new Promise((resolve, reject) => {
      const openReq = indexedDB.open(DB_NAME);
      openReq.onsuccess = () => {
        const db = openReq.result;
        const existing = Array.from(db.objectStoreNames);
        const needed = Object.values(STORES);
        const missing = needed.filter(s => !existing.includes(s));
        if (missing.length === 0) {
          db.close();
          resolve({ created: [], existing: needed });
          return;
        }
        const newVersion = db.version + 1;
        db.close();
        const upgradeReq = indexedDB.open(DB_NAME, newVersion);
        upgradeReq.onupgradeneeded = (e) => {
          const udb = e.target.result;
          missing.forEach(name => {
            if (!udb.objectStoreNames.contains(name)) {
              const store = udb.createObjectStore(name, { keyPath: 'id' });
              if (name === STORES.videos) {
                store.createIndex('watchedAt', 'watchedAt');
                store.createIndex('channelId', 'channelId');
              }
              if (name === STORES.reports) {
                store.createIndex('reportDate', 'reportDate');
                store.createIndex('ticker', 'ticker');
              }
            }
          });
        };
        upgradeReq.onsuccess = () => {
          upgradeReq.result.close();
          console.log(`[Phase16 v${VERSION}] ✅ 신규 store 생성: ${missing.join(', ')}`);
          resolve({ created: missing, existing });
        };
        upgradeReq.onerror = () => reject(upgradeReq.error);
      };
      openReq.onerror = () => reject(openReq.error);
    });
  }

  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  // ─────────────────────────────────────────────
  // CRUD 헬퍼
  // ─────────────────────────────────────────────
  async function putRecord(storeName, record) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put(record);
      req.onsuccess = () => res(record);
      req.onerror = () => rej(req.error);
    });
  }

  async function getAllRecords(storeName) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(storeName).objectStore(storeName).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  async function deleteRecord(storeName, id) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).delete(id);
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  }

  function uuid() {
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  // ─────────────────────────────────────────────
  // 보유 종목 가져오기 (자동완성용)
  // ─────────────────────────────────────────────
  async function getHoldingsTickers() {
    try {
      const db = await openDB();
      if (!db.objectStoreNames.contains('holdings')) return [];
      const list = await new Promise((res) => {
        const r = db.transaction('holdings').objectStore('holdings').getAll();
        r.onsuccess = () => res(r.result || []);
      });
      return list.map(h => ({
        code: h.ticker || h.code,
        name: h.name || h.tickerName || h.ticker
      })).filter(x => x.code);
    } catch (e) { return []; }
  }

  // ─────────────────────────────────────────────
  // YouTube URL 파싱
  // ─────────────────────────────────────────────
  function parseYouTubeUrl(url) {
    if (!url) return null;
    const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  // ─────────────────────────────────────────────
  // 영상 입력 모달
  // ─────────────────────────────────────────────
  async function openVideoModal(editRecord = null) {
    const holdings = await getHoldingsTickers();
    const existing = editRecord || {};
    const today = new Date(Date.now() + 9*3600000).toISOString().slice(0, 10);

    const modal = document.createElement('div');
    modal.id = 'phase16-video-modal';
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100000;
      display:flex;align-items:center;justify-content:center;padding:20px;
    `;
    modal.innerHTML = `
      <div style="background:white;border-radius:12px;max-width:680px;width:100%;
                  max-height:90vh;overflow-y:auto;padding:24px;
                  box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <h2 style="margin:0;font-size:20px;">📺 ${editRecord ? '영상 수정' : '새 YouTube 영상 입력'}</h2>
          <button id="p16-close" style="border:none;background:none;font-size:24px;cursor:pointer;">✕</button>
        </div>

        <div style="display:grid;gap:14px;">
          <label style="font-weight:600;font-size:13px;">영상 URL
            <input id="p16-url" type="url" placeholder="https://youtube.com/watch?v=..."
              value="${existing.videoUrl || ''}"
              style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;">
          </label>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <label style="font-weight:600;font-size:13px;">채널명
              <input id="p16-channel" type="text" placeholder="예: 슈카월드"
                value="${existing.channelName || ''}"
                style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;">
            </label>
            <label style="font-weight:600;font-size:13px;">영상 제목
              <input id="p16-title" type="text" placeholder="(선택)"
                value="${existing.videoTitle || ''}"
                style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;">
            </label>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <label style="font-weight:600;font-size:13px;">영상 업로드일
              <input id="p16-pub" type="date" value="${existing.publishedAt || today}"
                style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;">
            </label>
            <label style="font-weight:600;font-size:13px;">시청일
              <input id="p16-watch" type="date" value="${existing.watchedAt || today}"
                style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;">
            </label>
          </div>

          <div>
            <div style="font-weight:600;font-size:13px;margin-bottom:6px;">핵심 요약 (3줄 권장)</div>
            <input id="p16-sum1" type="text" placeholder="핵심 1"
              value="${(existing.summary && existing.summary[0]) || ''}"
              style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-bottom:6px;font-size:14px;">
            <input id="p16-sum2" type="text" placeholder="핵심 2"
              value="${(existing.summary && existing.summary[1]) || ''}"
              style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-bottom:6px;font-size:14px;">
            <input id="p16-sum3" type="text" placeholder="핵심 3"
              value="${(existing.summary && existing.summary[2]) || ''}"
              style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;">
          </div>

          <div>
            <div style="font-weight:600;font-size:13px;margin-bottom:6px;">언급 종목</div>
            <div id="p16-tickers" style="display:flex;flex-direction:column;gap:8px;"></div>
            <button id="p16-add-ticker" type="button"
              style="margin-top:8px;padding:8px 14px;background:#f0f4ff;border:1px dashed #4a7eff;
                     border-radius:6px;cursor:pointer;font-size:13px;color:#4a7eff;">
              + 종목 추가
            </button>
          </div>

          <label style="font-weight:600;font-size:13px;">영상 전체 톤
            <select id="p16-tone" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;">
              <option value="bullish" ${existing.overallTone==='bullish'?'selected':''}>🔼 강세 (Bullish)</option>
              <option value="neutral" ${(!existing.overallTone||existing.overallTone==='neutral')?'selected':''}>➖ 중립 (Neutral)</option>
              <option value="bearish" ${existing.overallTone==='bearish'?'selected':''}>🔽 약세 (Bearish)</option>
            </select>
          </label>

          <label style="font-weight:600;font-size:13px;">내 메모 (선택)
            <textarea id="p16-note" rows="2" placeholder="개인적인 판단/감상..."
              style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:14px;resize:vertical;">${existing.myNote || ''}</textarea>
          </label>

          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px;">
            <button id="p16-cancel" style="padding:10px 20px;border:1px solid #ddd;background:white;border-radius:6px;cursor:pointer;">취소</button>
            <button id="p16-save" style="padding:10px 24px;background:#4a7eff;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">저장</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // 종목 행 추가 함수
    const tickersDiv = modal.querySelector('#p16-tickers');
    function addTickerRow(data = {}) {
      const row = document.createElement('div');
      row.className = 'p16-ticker-row';
      row.style.cssText = 'display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr auto;gap:6px;align-items:center;';
      row.innerHTML = `
        <input class="p16-tk-code" type="text" list="p16-holdings-list" placeholder="종목코드/명"
          value="${data.code || ''}" style="padding:8px;border:1px solid #ddd;border-radius:5px;font-size:13px;">
        <input class="p16-tk-name" type="text" placeholder="종목명"
          value="${data.name || ''}" style="padding:8px;border:1px solid #ddd;border-radius:5px;font-size:13px;">
        <select class="p16-tk-tone" style="padding:8px;border:1px solid #ddd;border-radius:5px;font-size:13px;">
          <option value="buy" ${data.tone==='buy'?'selected':''}>매수</option>
          <option value="hold" ${(!data.tone||data.tone==='hold')?'selected':''}>중립</option>
          <option value="sell" ${data.tone==='sell'?'selected':''}>매도</option>
        </select>
        <input class="p16-tk-target" type="number" placeholder="목표가"
          value="${data.target || ''}" style="padding:8px;border:1px solid #ddd;border-radius:5px;font-size:13px;">
        <button type="button" class="p16-tk-del" style="border:none;background:#fee;color:#c33;padding:6px 10px;border-radius:5px;cursor:pointer;">✕</button>
      `;
      row.querySelector('.p16-tk-del').onclick = () => row.remove();
      // 종목코드 입력 시 보유종목명 자동완성
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

    // 보유종목 datalist
    const dl = document.createElement('datalist');
    dl.id = 'p16-holdings-list';
    dl.innerHTML = holdings.map(h => `<option value="${h.code}">${h.name}</option>`).join('');
    modal.appendChild(dl);

    // 기존 데이터 로드 또는 빈 행 1개
    if (existing.tickers && existing.tickers.length) {
      existing.tickers.forEach(t => addTickerRow(t));
    } else {
      addTickerRow();
    }

    modal.querySelector('#p16-add-ticker').onclick = () => addTickerRow();
    modal.querySelector('#p16-close').onclick = () => modal.remove();
    modal.querySelector('#p16-cancel').onclick = () => modal.remove();

    // 저장
    modal.querySelector('#p16-save').onclick = async () => {
      const url = modal.querySelector('#p16-url').value.trim();
      const channelName = modal.querySelector('#p16-channel').value.trim();
      const title = modal.querySelector('#p16-title').value.trim();
      const summary = [
        modal.querySelector('#p16-sum1').value.trim(),
        modal.querySelector('#p16-sum2').value.trim(),
        modal.querySelector('#p16-sum3').value.trim()
      ].filter(Boolean);

      if (!channelName && !url) {
        alert('채널명 또는 영상 URL은 입력해주세요.');
        return;
      }
      if (summary.length === 0) {
        alert('핵심 요약을 최소 1줄 입력해주세요.');
        return;
      }

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
        videoTitle: title,
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
        alert('저장되었습니다.');
        // 목록 화면 열려있으면 새로고침 (2단계에서 구현)
        if (window.__phase16?.refreshList) window.__phase16.refreshList();
      } catch (e) {
        console.error('[Phase16] 저장 실패:', e);
        alert('저장 실패: ' + e.message);
      }
    };
  }

  // ─────────────────────────────────────────────
  // 메뉴에 "📰 인사이트" 항목 추가
  // ─────────────────────────────────────────────
  function installMenuItem() {
    // 분석 그룹 찾기 (왝더독 분석 항목 근처에 삽입)
    const tryInsert = () => {
      // "왝더독" 텍스트를 포함한 항목 찾기
      const items = document.querySelectorAll('button, a, div');
      let anchor = null;
      items.forEach(el => {
        if (el.children.length === 0 && /왝더독/.test(el.textContent)) {
          anchor = el.closest('button, a, div[role="menuitem"], li') || el;
        }
      });
      if (!anchor) return false;
      if (document.getElementById('p16-menu-insight')) return true;

      const newItem = anchor.cloneNode(true);
      newItem.id = 'p16-menu-insight';
      newItem.innerHTML = newItem.innerHTML
        .replace(/🐶/g, '📰')
        .replace(/왝더독\s*분석/g, '인사이트');
      newItem.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openVideoModal();  // Phase 1: 일단 영상 입력 모달 바로 열기
      };
      anchor.parentNode.insertBefore(newItem, anchor.nextSibling);
      console.log('[Phase16] ✅ "📰 인사이트" 메뉴 항목 추가');
      return true;
    };

    // 메뉴가 동적으로 열릴 수 있으므로 여러 번 시도
    if (tryInsert()) return;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (tryInsert() || attempts >= 20) clearInterval(interval);
    }, 500);

    // 메뉴가 열릴 때마다 재삽입 시도
    document.addEventListener('click', () => setTimeout(tryInsert, 100));
  }

  // ─────────────────────────────────────────────
  // 초기화
  // ─────────────────────────────────────────────
  async function init() {
    try {
      const result = await ensureStores();
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📰 Phase 16 인사이트 시스템 v${VERSION}`);
      console.log(`   DB store: ${result.created.length}개 신규 / ${result.existing.length}개 기존`);
      console.log(`   사용법: window.__phase16.openVideoModal()`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      installMenuItem();
    } catch (e) {
      console.error('[Phase16] 초기화 실패:', e);
    }
  }

  // 공개 API
  window.__phase16 = {
    version: VERSION,
    openVideoModal,
    getAllVideos: () => getAllRecords(STORES.videos),
    getAllReports: () => getAllRecords(STORES.reports),
    getAllChannels: () => getAllRecords(STORES.channels),
    deleteVideo: (id) => deleteRecord(STORES.videos, id),
    _internal: { ensureStores, openDB, STORES }
  };

  // 3초 후 초기화 (다른 시스템 로드 후)
  setTimeout(init, 3000);
})();
