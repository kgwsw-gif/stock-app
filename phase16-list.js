// phase16-list.js - 인사이트 목록·검색·필터 화면 v0.1.0
// phase16-insights.js v0.2.0 이상 필요 (window.__phase16 사용)
(function() {
  const VERSION = '0.1.0';

  // phase16-insights.js 로드 대기
  function waitForPhase16(maxWait = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.__phase16?.getAllVideos) return resolve();
        if (Date.now() - start > maxWait) return reject(new Error('phase16-insights.js 로드 실패'));
        setTimeout(check, 100);
      };
      check();
    });
  }

  // ─────────────────────────────────────────────
  // 유틸: 톤 라벨/색상
  // ─────────────────────────────────────────────
  const TONE_LABELS = {
    bullish: { text: '🔼 강세', color: '#dc2626', bg: '#fee2e2' },
    neutral: { text: '➖ 중립', color: '#525252', bg: '#f5f5f5' },
    bearish: { text: '🔽 약세', color: '#2563eb', bg: '#dbeafe' }
  };
  const TICKER_TONE = {
    buy: { text: '매수', color: '#dc2626', bg: '#fee2e2' },
    hold: { text: '중립', color: '#525252', bg: '#f5f5f5' },
    sell: { text: '매도', color: '#2563eb', bg: '#dbeafe' }
  };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function daysAgo(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const today = new Date();
    const diff = Math.floor((today - d) / 86400000);
    if (diff === 0) return '오늘';
    if (diff === 1) return '어제';
    if (diff < 7) return `${diff}일 전`;
    if (diff < 30) return `${Math.floor(diff/7)}주 전`;
    return dateStr;
  }

  // ─────────────────────────────────────────────
  // 필터 상태
  // ─────────────────────────────────────────────
  let filterState = {
    search: '',
    tone: 'all',       // all | bullish | neutral | bearish
    ticker: '',
    period: 'all'      // all | week | month | 3month
  };

  function applyFilter(videos) {
    return videos.filter(v => {
      // 검색어 (채널명, 제목, 요약, 종목명/코드 모두 대상)
      if (filterState.search) {
        const q = filterState.search.toLowerCase();
        const hay = [
          v.channelName, v.videoTitle,
          ...(v.summary || []),
          v.myNote,
          ...(v.tickers || []).flatMap(t => [t.code, t.name])
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      // 톤
      if (filterState.tone !== 'all' && v.overallTone !== filterState.tone) return false;
      // 종목 코드/명
      if (filterState.ticker) {
        const q = filterState.ticker.toLowerCase();
        const found = (v.tickers || []).some(t =>
          (t.code || '').toLowerCase().includes(q) ||
          (t.name || '').toLowerCase().includes(q)
        );
        if (!found) return false;
      }
      // 기간 (시청일 기준)
      if (filterState.period !== 'all' && v.watchedAt) {
        const watched = new Date(v.watchedAt);
        const today = new Date();
        const diff = (today - watched) / 86400000;
        const limit = { week: 7, month: 30, '3month': 90 }[filterState.period];
        if (diff > limit) return false;
      }
      return true;
    });
  }

  // ─────────────────────────────────────────────
  // 카드 렌더링
  // ─────────────────────────────────────────────
  function renderCard(v) {
    const tone = TONE_LABELS[v.overallTone] || TONE_LABELS.neutral;
    const tickersHtml = (v.tickers || []).map(t => {
      const tt = TICKER_TONE[t.tone] || TICKER_TONE.hold;
      const target = t.target ? ` 🎯${t.target.toLocaleString()}원` : '';
      return `<span style="display:inline-block;padding:3px 8px;border-radius:12px;background:${tt.bg};color:${tt.color};font-size:12px;margin:2px 4px 2px 0;font-weight:500;">
        ${escapeHtml(t.name || t.code)} [${tt.text}]${target}
      </span>`;
    }).join('');

    const summaryHtml = (v.summary || []).map(s =>
      `<div style="font-size:13px;color:#374151;margin:3px 0;padding-left:8px;border-left:2px solid #e5e7eb;">${escapeHtml(s)}</div>`
    ).join('');

    const noteHtml = v.myNote
      ? `<div style="margin-top:8px;padding:8px;background:#fffbeb;border-left:3px solid #f59e0b;font-size:12px;color:#78350f;">💭 ${escapeHtml(v.myNote)}</div>`
      : '';

    const urlBtn = v.videoUrl
      ? `<a href="${escapeHtml(v.videoUrl)}" target="_blank" rel="noopener" style="padding:5px 10px;background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:5px;font-size:12px;text-decoration:none;">▶ 영상 보기</a>`
      : '';

    return `
      <div class="p16-card" data-id="${v.id}" style="background:white;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;gap:10px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="font-weight:700;color:#111;">📺 ${escapeHtml(v.channelName || '(채널 미입력)')}</span>
              <span style="font-size:11px;color:#9ca3af;">${daysAgo(v.watchedAt)}</span>
              <span style="padding:2px 8px;border-radius:10px;background:${tone.bg};color:${tone.color};font-size:11px;font-weight:600;">${tone.text}</span>
            </div>
            ${v.videoTitle ? `<div style="font-size:13px;color:#6b7280;margin-top:3px;">${escapeHtml(v.videoTitle)}</div>` : ''}
          </div>
          <div style="display:flex;gap:5px;flex-shrink:0;">
            <button class="p16-edit" data-id="${v.id}" style="border:1px solid #ddd;background:white;padding:4px 9px;border-radius:5px;cursor:pointer;font-size:12px;">수정</button>
            <button class="p16-del" data-id="${v.id}" style="border:1px solid #fecaca;background:#fef2f2;color:#dc2626;padding:4px 9px;border-radius:5px;cursor:pointer;font-size:12px;">삭제</button>
          </div>
        </div>

        ${summaryHtml ? `<div style="margin:8px 0;">${summaryHtml}</div>` : ''}

        ${tickersHtml ? `<div style="margin-top:8px;">${tickersHtml}</div>` : ''}

        ${noteHtml}

        ${urlBtn ? `<div style="margin-top:10px;">${urlBtn}</div>` : ''}
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // 목록 화면 열기
  // ─────────────────────────────────────────────
  let listModalEl = null;

  async function openListView() {
    // 기존 열려있으면 닫기
    if (listModalEl) listModalEl.remove();

    const modal = document.createElement('div');
    listModalEl = modal;
    modal.id = 'phase16-list-modal';
    modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px;`;
    modal.innerHTML = `
      <div style="background:#f9fafb;border-radius:14px;max-width:900px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 25px 70px rgba(0,0,0,0.3);">
        <!-- 헤더 -->
        <div style="padding:18px 22px;border-bottom:1px solid #e5e7eb;background:white;border-radius:14px 14px 0 0;display:flex;justify-content:space-between;align-items:center;">
          <h2 style="margin:0;font-size:18px;display:flex;align-items:center;gap:8px;">📰 인사이트 <span id="p16-count" style="font-size:13px;color:#6b7280;font-weight:400;"></span></h2>
          <div style="display:flex;gap:8px;">
            <button id="p16-new-video" style="padding:8px 14px;background:#4a7eff;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;">+ 새 영상</button>
            <button id="p16-list-close" style="border:none;background:none;font-size:24px;cursor:pointer;color:#6b7280;">✕</button>
          </div>
        </div>

        <!-- 필터 -->
        <div style="padding:14px 22px;background:white;border-bottom:1px solid #e5e7eb;">
          <div style="display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:8px;">
            <input id="p16-filter-search" type="search" placeholder="🔍 검색 (채널/제목/요약/메모)" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
            <input id="p16-filter-ticker" type="search" placeholder="🏷️ 종목 (코드/명)" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
            <select id="p16-filter-tone" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;background:white;">
              <option value="all">모든 톤</option>
              <option value="bullish">🔼 강세</option>
              <option value="neutral">➖ 중립</option>
              <option value="bearish">🔽 약세</option>
            </select>
            <select id="p16-filter-period" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;background:white;">
              <option value="all">전체 기간</option>
              <option value="week">최근 1주</option>
              <option value="month">최근 1개월</option>
              <option value="3month">최근 3개월</option>
            </select>
          </div>
        </div>

        <!-- 목록 -->
        <div id="p16-list-body" style="flex:1;overflow-y:auto;padding:18px 22px;">
          <div style="text-align:center;color:#9ca3af;padding:60px 0;">로딩 중...</div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // 이벤트: 닫기
    modal.querySelector('#p16-list-close').onclick = () => { modal.remove(); listModalEl = null; };
    modal.addEventListener('click', (e) => {
      if (e.target === modal) { modal.remove(); listModalEl = null; }
    });

    // 이벤트: 새 영상 추가
    modal.querySelector('#p16-new-video').onclick = async () => {
      await window.__phase16.openVideoModal();
      // 모달 저장 후 자동 새로고침을 위해 폴링
      const startCount = (await window.__phase16.getAllVideos()).length;
      const poll = setInterval(async () => {
        const list = await window.__phase16.getAllVideos();
        if (list.length !== startCount) {
          clearInterval(poll);
          refresh();
        }
      }, 500);
      // 30초 후 폴링 강제 종료
      setTimeout(() => clearInterval(poll), 30000);
    };

    // 이벤트: 필터 변경
    const onFilterChange = () => {
      filterState.search = modal.querySelector('#p16-filter-search').value.trim();
      filterState.ticker = modal.querySelector('#p16-filter-ticker').value.trim();
      filterState.tone = modal.querySelector('#p16-filter-tone').value;
      filterState.period = modal.querySelector('#p16-filter-period').value;
      refresh();
    };
    modal.querySelector('#p16-filter-search').addEventListener('input', debounce(onFilterChange, 200));
    modal.querySelector('#p16-filter-ticker').addEventListener('input', debounce(onFilterChange, 200));
    modal.querySelector('#p16-filter-tone').addEventListener('change', onFilterChange);
    modal.querySelector('#p16-filter-period').addEventListener('change', onFilterChange);

    await refresh();
  }

  function debounce(fn, ms) {
    let t;
    return function(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ─────────────────────────────────────────────
  // 목록 새로고침
  // ─────────────────────────────────────────────
  async function refresh() {
    if (!listModalEl) return;
    const body = listModalEl.querySelector('#p16-list-body');
    const countEl = listModalEl.querySelector('#p16-count');

    try {
      const all = await window.__phase16.getAllVideos();
      // 최신순 (watchedAt 우선, 없으면 createdAt)
      all.sort((a, b) => {
        const da = a.watchedAt || a.createdAt || '';
        const db = b.watchedAt || b.createdAt || '';
        return db.localeCompare(da);
      });
      const filtered = applyFilter(all);

      countEl.textContent = filtered.length === all.length
        ? `(${all.length}개)`
        : `(${filtered.length} / 전체 ${all.length}개)`;

      if (all.length === 0) {
        body.innerHTML = `
          <div style="text-align:center;padding:60px 20px;color:#9ca3af;">
            <div style="font-size:48px;margin-bottom:12px;">📭</div>
            <div style="font-size:15px;margin-bottom:8px;">아직 저장된 인사이트가 없습니다</div>
            <div style="font-size:13px;">상단 [+ 새 영상] 버튼으로 첫 영상을 등록해보세요.</div>
          </div>
        `;
        return;
      }
      if (filtered.length === 0) {
        body.innerHTML = `
          <div style="text-align:center;padding:60px 20px;color:#9ca3af;">
            <div style="font-size:36px;margin-bottom:12px;">🔍</div>
            <div style="font-size:14px;">조건에 맞는 인사이트가 없습니다</div>
          </div>
        `;
        return;
      }

      body.innerHTML = filtered.map(renderCard).join('');

      // 이벤트 바인딩
      body.querySelectorAll('.p16-del').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          const video = all.find(v => v.id === id);
          if (!confirm(`정말 삭제할까요?\n\n${video?.channelName || ''}\n${video?.summary?.[0] || ''}`)) return;
          try {
            await window.__phase16.deleteVideo(id);
            console.log(`[Phase16-list] 삭제 완료: ${id}`);
            await refresh();
          } catch (err) {
            alert('삭제 실패: ' + err.message);
          }
        };
      });

      body.querySelectorAll('.p16-edit').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          const video = all.find(v => v.id === id);
          if (!video) return;
          await window.__phase16.openVideoModal(video);
          // 저장 후 새로고침 (수정은 개수 안 늘어남, updatedAt으로 감지)
          const oldUpdated = video.updatedAt;
          const poll = setInterval(async () => {
            const list = await window.__phase16.getAllVideos();
            const updated = list.find(v => v.id === id);
            if (updated && updated.updatedAt !== oldUpdated) {
              clearInterval(poll);
              refresh();
            }
          }, 500);
          setTimeout(() => clearInterval(poll), 30000);
        };
      });

    } catch (e) {
      body.innerHTML = `<div style="color:#dc2626;padding:20px;">조회 실패: ${escapeHtml(e.message)}</div>`;
      console.error('[Phase16-list] refresh 실패:', e);
    }
  }

  // ─────────────────────────────────────────────
  // 메뉴 후킹 ("📰 인사이트" 클릭 시 목록 열기)
  // ─────────────────────────────────────────────
  function hookListButton() {
    // phase16-insights.js의 버튼 후킹보다 먼저 캡처
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button, a, div');
      if (!btn) return;
      const txt = btn.textContent || '';
      if (/📰\s*인사이트/.test(txt) && txt.length < 20) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();  // phase16-insights.js의 후킹 차단
        openListView();
      }
    }, true);  // capture 단계
  }

  // ─────────────────────────────────────────────
  // 초기화
  // ─────────────────────────────────────────────
  async function init() {
    try {
      await waitForPhase16();
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📋 Phase 16 목록·필터 UI v${VERSION}`);
      console.log(`   사용: window.__phase16List.open()`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      hookListButton();
    } catch (e) {
      console.error('[Phase16-list] 초기화 실패:', e);
    }
  }

  // 공개 API
  window.__phase16List = {
    version: VERSION,
    open: openListView,
    refresh
  };

  setTimeout(init, 3500);  // phase16-insights.js (3초) 이후에 실행
})();
