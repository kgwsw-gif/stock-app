// phase16-enhancements.js - 톤 한글화 + 수익률 자동갱신 + 백업/복원 v0.1.0
(function() {
  const VERSION = '0.1.0';
  const INSIGHT_DB = 'StockJournalInsightsDB';

  function waitForDeps(maxWait = 12000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.__phase16Outcomes && window.__phase16) return resolve();
        if (Date.now() - start > maxWait) return reject(new Error('timeout'));
        setTimeout(check, 100);
      };
      check();
    });
  }

  // ─────────────────────────────────────────────
  // 톤 한글화 매핑
  // ─────────────────────────────────────────────
  function toneToKorean(tone) {
    const t = (tone || '').toString();
    if (/강세|상승|매수|bullish|buy/i.test(t)) return '매수';
    if (/약세|하락|매도|bearish|sell/i.test(t)) return '매도';
    if (/중립|hold|neutral/i.test(t)) return '중립';
    return tone || '-';
  }

  function toneColor(tone) {
    const k = toneToKorean(tone);
    if (k === '매수') return '#10b981';
    if (k === '매도') return '#ef4444';
    if (k === '중립') return '#6b7280';
    return '#9ca3af';
  }

  // ─────────────────────────────────────────────
  // 1. 톤 표시 한글화 - 카드/모달의 영문 톤을 한글로 자동 변환
  // ─────────────────────────────────────────────
  function normalizeToneText(rootEl) {
    // 영문 톤이 들어간 텍스트 노드 찾아 한글로 치환
    if (!rootEl) return;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    const replacements = [
      { pat: /\bbullish\b/gi, rep: '매수' },
      { pat: /\bbearish\b/gi, rep: '매도' },
      { pat: /\bneutral\b/gi, rep: '중립' },
      { pat: /\bhold\b/gi, rep: '중립' },
      { pat: /(^|[\s\[(>:])buy([\s\])<.,!?]|$)/gi, rep: (m, p1, p2) => `${p1}매수${p2 || ''}` },
      { pat: /(^|[\s\[(>:])sell([\s\])<.,!?]|$)/gi, rep: (m, p1, p2) => `${p1}매도${p2 || ''}` }
    ];
    const nodes = [];
    let n;
    while (n = walker.nextNode()) {
      const txt = n.textContent || '';
      if (/\b(bullish|bearish|neutral|hold|buy|sell)\b/i.test(txt)) {
        // input/textarea 값은 건드리지 않음
        if (n.parentElement?.closest('input, textarea')) continue;
        nodes.push(n);
      }
    }
    nodes.forEach(n => {
      let txt = n.textContent;
      replacements.forEach(r => {
        txt = txt.replace(r.pat, r.rep);
      });
      n.textContent = txt;
    });
  }

  function observeToneText() {
    let timer = null;
    const debounced = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // 정보 노트 관련 모달만 대상으로
        document.querySelectorAll(
          '[id^="phase16-"], [id^="p16-"], #phase16-video-modal, [class*="p16-"]'
        ).forEach(el => normalizeToneText(el));
      }, 150);
    };
    const observer = new MutationObserver(debounced);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ─────────────────────────────────────────────
  // 2. 수익률 자동 갱신 - 추적 모달의 input 변경 시 우측 수익률 실시간 업데이트
  // ─────────────────────────────────────────────
  function formatPercent(n) {
    if (n == null || isNaN(n)) return '-';
    const v = Number(n);
    const sign = v > 0 ? '+' : '';
    return sign + v.toFixed(1) + '%';
  }

  function formatPrice(n) {
    if (n == null || isNaN(n)) return '-';
    return Math.round(Number(n)).toLocaleString() + '원';
  }

  const TONE_THRESHOLD = 5;
  const TARGET_PROXIMITY = 10;

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

  function updateReturnDisplay(rowEl) {
    if (!rowEl) return;
    const basePrice = parseFloat(rowEl.querySelector('.p16-base-price')?.value || '');
    const price = parseFloat(rowEl.querySelector('.p16-price')?.value || '');

    // 예상 톤/목표가 추출 (예상: xxx / 목표가 yyy원)
    const headerText = rowEl.querySelector('div[style*="justify-content:space-between"] > div:nth-child(2)')?.textContent || '';
    const toneMatch = headerText.match(/예상:\s*([^/]+?)(?:\s*\/|$)/);
    const targetMatch = headerText.match(/목표가\s*([\d,]+)/);
    const tone = toneMatch ? toneMatch[1].trim() : '';
    const target = targetMatch ? parseFloat(targetMatch[1].replace(/,/g, '')) : null;

    // 우측 결과 영역 찾기 (3번째 컬럼)
    const grid = rowEl.querySelector('div[style*="grid-template-columns"]');
    if (!grid) return;
    const cols = grid.children;
    if (cols.length < 3) return;
    const resultCol = cols[2];

    if (!basePrice || !price) {
      resultCol.innerHTML = '<div style="color:#9ca3af;">-</div>';
      return;
    }
    const returnPct = ((price - basePrice) / basePrice * 100);
    const toneHit = evaluateTone(tone, returnPct);
    const targetHit = (target && price) ? evaluateTargetPrice(target, price) : null;
    const color = returnPct > 0 ? '#10b981' : returnPct < 0 ? '#ef4444' : '#6b7280';

    resultCol.innerHTML = `
      <div style="font-weight:600;color:${color};">${formatPercent(returnPct)}</div>
      ${toneHit ? `<div style="font-size:11px;">톤: ${toneHit === '적중' ? '✅' : '❌'} ${toneHit}</div>` : ''}
      ${targetHit ? `<div style="font-size:11px;">목표: ${targetHit === '도달' ? '🎯' : '⚪'} ${targetHit}</div>` : ''}
    `;
  }

  function attachInputListeners() {
    const modal = document.getElementById('p16-outcomes-modal');
    if (!modal) return;
    if (modal.dataset.enhancedListeners === '1') return;
    modal.dataset.enhancedListeners = '1';

    modal.querySelectorAll('[data-period]').forEach(rowEl => {
      const baseInput = rowEl.querySelector('.p16-base-price');
      const priceInput = rowEl.querySelector('.p16-price');
      const handler = () => updateReturnDisplay(rowEl);
      baseInput?.addEventListener('input', handler);
      priceInput?.addEventListener('input', handler);
    });

    // 대기중 입력칸도 활성화 (테스트/조기 입력 허용)
    modal.querySelectorAll('input[disabled]').forEach(el => {
      el.disabled = false;
      el.placeholder = el.placeholder.replace('대기중', '입력 (조기)');
      el.style.background = '#fffbeb';
    });
  }

  function observeOutcomesModal() {
    const observer = new MutationObserver(() => {
      if (document.getElementById('p16-outcomes-modal')) {
        attachInputListeners();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─────────────────────────────────────────────
  // 3. 데이터 백업/복원 (JSON)
  // ─────────────────────────────────────────────
  function openInsightDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(INSIGHT_DB);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllFromStore(storeName) {
    const db = await openInsightDB();
    if (!db.objectStoreNames.contains(storeName)) { db.close(); return []; }
    return new Promise((resolve, reject) => {
      const r = db.transaction(storeName).objectStore(storeName).getAll();
      r.onsuccess = () => { db.close(); resolve(r.result); };
      r.onerror = () => { db.close(); reject(r.error); };
    });
  }

  async function putToStore(storeName, items) {
    const db = await openInsightDB();
    if (!db.objectStoreNames.contains(storeName)) { db.close(); return 0; }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      let count = 0;
      items.forEach(item => {
        try { store.put(item); count++; } catch(_) {}
      });
      tx.oncomplete = () => { db.close(); resolve(count); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async function exportBackup() {
    const [videos, reports, channels] = await Promise.all([
      getAllFromStore('video_insights'),
      getAllFromStore('analyst_reports'),
      getAllFromStore('youtube_channels')
    ]);
    const data = {
      _meta: {
        app: 'stock-app phase16',
        version: VERSION,
        exportedAt: new Date().toISOString(),
        counts: {
          videos: videos.length,
          reports: reports.length,
          channels: channels.length
        }
      },
      video_insights: videos,
      analyst_reports: reports,
      youtube_channels: channels
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `phase16-backup-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    return data._meta.counts;
  }

  async function importBackup(file, mode = 'merge') {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { throw new Error('유효한 JSON 파일이 아닙니다.'); }
    if (!data._meta || !data.video_insights) throw new Error('Phase 16 백업 파일이 아닙니다.');

    // 모드: 'merge' = 기존 + 새 데이터 (id 중복은 새 데이터로 덮어쓰기), 'replace' = 전체 삭제 후 새 데이터로
    if (mode === 'replace') {
      const db = await openInsightDB();
      ['video_insights', 'analyst_reports', 'youtube_channels'].forEach(name => {
        if (!db.objectStoreNames.contains(name)) return;
        try {
          const tx = db.transaction(name, 'readwrite');
          tx.objectStore(name).clear();
        } catch(_) {}
      });
      db.close();
      await new Promise(r => setTimeout(r, 200));
    }

    const results = {
      videos: await putToStore('video_insights', data.video_insights || []),
      reports: await putToStore('analyst_reports', data.analyst_reports || []),
      channels: await putToStore('youtube_channels', data.youtube_channels || [])
    };
    return results;
  }

  function openBackupModal() {
    const existing = document.getElementById('p16-backup-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'p16-backup-modal';
    modal.style.cssText = `
      position:fixed;top:0;left:0;width:100%;height:100%;
      background:rgba(0,0,0,0.55);z-index:100001;
      display:flex;align-items:center;justify-content:center;padding:20px;
    `;
    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:24px;max-width:500px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,0.3);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h2 style="margin:0;font-size:18px;">💾 정보 노트 백업 / 복원</h2>
          <button id="p16-backup-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:#666;">×</button>
        </div>

        <div style="background:#fef3c7;padding:10px 12px;border-radius:6px;font-size:12px;color:#78350f;margin-bottom:16px;">
          💡 영상 인사이트, 애널리스트 리포트, 유튜브 채널 데이터를 JSON 파일로 백업/복원합니다.
          기존 stock-app 데이터(보유종목/일지 등)와는 별개입니다.
        </div>

        <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:12px;">
          <div style="font-weight:600;margin-bottom:8px;">📤 내보내기 (백업)</div>
          <div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
            현재 저장된 모든 정보 노트 데이터를 JSON 파일로 다운로드합니다.
          </div>
          <button id="p16-backup-export" style="padding:8px 16px;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">📥 백업 파일 다운로드</button>
          <div id="p16-backup-export-result" style="margin-top:8px;font-size:12px;color:#059669;"></div>
        </div>

        <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;">
          <div style="font-weight:600;margin-bottom:8px;">📥 가져오기 (복원)</div>
          <div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
            백업 파일을 선택해서 데이터를 복원합니다.
          </div>
          <input type="file" id="p16-backup-file" accept=".json" style="margin-bottom:10px;display:block;">
          <div style="margin-bottom:10px;">
            <label style="font-size:12px;display:block;margin-bottom:4px;">복원 방식:</label>
            <label style="font-size:12px;margin-right:12px;">
              <input type="radio" name="p16-backup-mode" value="merge" checked> 병합 (기존 유지 + 새 데이터 추가)
            </label>
            <label style="font-size:12px;">
              <input type="radio" name="p16-backup-mode" value="replace"> 전체 교체 (기존 삭제 ⚠️)
            </label>
          </div>
          <button id="p16-backup-import" style="padding:8px 16px;background:#10b981;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">🔄 복원하기</button>
          <div id="p16-backup-import-result" style="margin-top:8px;font-size:12px;color:#059669;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('#p16-backup-close').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    modal.querySelector('#p16-backup-export').addEventListener('click', async () => {
      try {
        const counts = await exportBackup();
        modal.querySelector('#p16-backup-export-result').innerHTML =
          `✅ 다운로드 완료: 영상 ${counts.videos}개 / 리포트 ${counts.reports}개 / 채널 ${counts.channels}개`;
      } catch(e) {
        modal.querySelector('#p16-backup-export-result').innerHTML = `❌ ${e.message}`;
      }
    });

    modal.querySelector('#p16-backup-import').addEventListener('click', async () => {
      const fileInput = modal.querySelector('#p16-backup-file');
      const file = fileInput.files[0];
      if (!file) {
        modal.querySelector('#p16-backup-import-result').innerHTML = '❌ 파일을 선택해 주세요.';
        return;
      }
      const mode = modal.querySelector('input[name="p16-backup-mode"]:checked').value;
      if (mode === 'replace' && !confirm('⚠️ 전체 교체 모드입니다. 기존 정보 노트 데이터가 모두 삭제됩니다. 진행하시겠습니까?')) return;

      try {
        const r = await importBackup(file, mode);
        modal.querySelector('#p16-backup-import-result').innerHTML =
          `✅ 복원 완료: 영상 ${r.videos}개 / 리포트 ${r.reports}개 / 채널 ${r.channels}개<br>새로고침(Ctrl+Shift+R) 후 확인하세요.`;
      } catch(e) {
        modal.querySelector('#p16-backup-import-result').innerHTML = `❌ ${e.message}`;
      }
    });
  }

  // ─────────────────────────────────────────────
  // 통계 모달에 백업 버튼 추가 (하단 영역)
  // ─────────────────────────────────────────────
  function injectBackupButton() {
    const statsModal = document.getElementById('p16-stats-modal');
    if (!statsModal) return;
    const refresh = statsModal.querySelector('#p16-stats-refresh');
    if (!refresh) return;
    if (statsModal.querySelector('#p16-backup-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'p16-backup-btn';
    btn.textContent = '💾 백업/복원';
    btn.style.cssText = 'padding:8px 16px;background:#8b5cf6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;margin-right:8px;';
    btn.addEventListener('click', () => openBackupModal());
    refresh.parentElement.insertBefore(btn, refresh);
  }

  function observeStatsModal() {
    const observer = new MutationObserver(() => {
      injectBackupButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─────────────────────────────────────────────
  // 초기화
  // ─────────────────────────────────────────────
  async function init() {
    try {
      await waitForDeps();
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`✨ Phase 16 개선 v${VERSION}`);
      console.log('   1. 톤 한글화 (buy→매수, hold→중립, sell→매도)');
      console.log('   2. 추적 모달 수익률 자동 갱신');
      console.log('   3. JSON 백업/복원 (통계 모달에서 접근)');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      observeToneText();
      observeOutcomesModal();
      observeStatsModal();
    } catch(e) {
      console.error('[Phase16-enhancements] 초기화 실패:', e);
    }
  }

  window.__phase16Enhance = {
    version: VERSION,
    toneToKorean,
    toneColor,
    exportBackup,
    importBackup,
    openBackupModal,
    refreshTones: () => {
      document.querySelectorAll('[id^="phase16-"], [id^="p16-"]').forEach(el => normalizeToneText(el));
    }
  };

  setTimeout(init, 6500);
})();
