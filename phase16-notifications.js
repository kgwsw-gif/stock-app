// phase16-notifications.js v0.1.0
// 평가일 알림: 영상/리포트의 1m/3m/6m 평가 대기 항목 자동 감지 + 메뉴 배지 + 통계 배너
(function() {
  'use strict';
  const VERSION =  '0.1.5'
  const PERIODS = [
    { key: '1m', days: 30, label: '1개월' },
    { key: '3m', days: 90, label: '3개월' },
    { key: '6m', days: 180, label: '6개월' }
  ];
  // 놓친 평가일 표시 기간 (일 단위)
  const OVERDUE_WINDOW = 7;

  // ============ 유틸 ============
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function daysBetween(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d)) return null;
    const now = new Date();
    return Math.floor((now - d) / (1000 * 60 * 60 * 24));
  }

  function normalizeOutcomes(o) {
    if (!o) return {};
    if (Array.isArray(o)) return {};
    return o;
  }

  function waitForDeps(cb, retries = 50) {
    if (window.__phase16?.version) return cb();
    if (retries <= 0) {
      console.warn('[phase16-notifications] __phase16 의존성 로드 실패');
      return;
    }
    setTimeout(() => waitForDeps(cb, retries - 1), 200);
  }

  // ============ 평가 대기 항목 추출 ============
  async function getPendingEvaluations() {
    const videos = await window.__phase16.getAllVideos();
    const reports = await window.__phase16.getAllReports();
    const pending = { videos: [], reports: [], total: 0, overdue: 0 };

    // 영상 검사
    videos.forEach(v => {
      const daysSince = daysBetween(v.createdAt || v.date);
      if (daysSince == null) return;
      const outcomes = normalizeOutcomes(v.outcomes);
      PERIODS.forEach(p => {
        const overdue = daysSince - p.days;
        if (overdue < 0) return; // 아직 평가일 이전
        // 이미 outcomes에 해당 period 데이터가 있으면 스킵
        const periodData = outcomes[p.key];
        const hasData = periodData && Object.keys(periodData).length > 0;
        if (hasData) return;
        pending.videos.push({
          type: 'video',
          id: v.id,
          title: v.videoTitle || v.title || '(제목 없음)',
          channelName: v.channelName || v.channel || '(미지정)',
          createdAt: v.createdAt || v.date,
          period: p.key,
          periodLabel: p.label,
          daysSince,
          overdue,
          isToday: overdue === 0,
          isRecent: overdue >= 0 && overdue <= OVERDUE_WINDOW
        });
        pending.total++;
        if (overdue > 0) pending.overdue++;
      });
    });

    // 리포트 검사
    reports.forEach(r => {
      const daysSince = daysBetween(r.createdAt || r.date);
      if (daysSince == null) return;
      const outcomes = normalizeOutcomes(r.outcomes);
      PERIODS.forEach(p => {
        const overdue = daysSince - p.days;
        if (overdue < 0) return;
        const periodData = outcomes[p.key];
        const hasData = periodData && Object.keys(periodData).length > 0;
        if (hasData) return;
        pending.reports.push({
          type: 'report',
          id: r.id,
          title: `${r.analyst || '?'} | ${r.firm || ''} (${r.tickerName || r.ticker || '?'})`,
          analyst: r.analyst,
          firm: r.firm,
          ticker: r.ticker,
          createdAt: r.createdAt || r.date,
          period: p.key,
          periodLabel: p.label,
          daysSince,
          overdue,
          isToday: overdue === 0,
          isRecent: overdue >= 0 && overdue <= OVERDUE_WINDOW
        });
        pending.total++;
        if (overdue > 0) pending.overdue++;
      });
    });

    return pending;
  }

  // ============ 알림 배너 (통계 대시보드 상단) ============
  async function injectStatsBanner() {
    // ✅ 정확한 ID로 통계 모달 찾기
    const statsModal = document.getElementById('p16-stats-modal');
    if (!statsModal) return;

    const pending = await getPendingEvaluations();
    
    // 기존 배너 제거 (갱신 + 0건일 때 제거를 위해)
    statsModal.querySelectorAll('.p16-notif-banner').forEach(b => b.remove());
    
    if (pending.total === 0) return; // 대기 항목 없으면 배너 표시 안 함

    const banner = document.createElement('div');
    banner.className = 'p16-notif-banner';
        banner.style.cssText = `
      background: linear-gradient(90deg, #fef3c7, #fde68a);
      border: 1px solid #f59e0b;
      border-radius: 8px;
      padding: 12px 16px;
      margin: 0 0 14px 0;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      transition: 0.15s;
      width: 100%;
      box-sizing: border-box;
    `;
    banner.innerHTML = `
      <span style="font-size:22px;">🔔</span>
      <div style="flex:1;">
        <div style="font-weight:bold;font-size:14px;color:#78350f;">
          평가 대기 ${pending.total}건 (영상 ${pending.videos.length} · 리포트 ${pending.reports.length})
        </div>
        <div style="font-size:12px;color:#92400e;margin-top:2px;">
          ${pending.overdue > 0 ? `⚠️ 지난 평가일 ${pending.overdue}건` : '오늘 평가 가능'} · 클릭하여 목록 보기
        </div>
      </div>
      <span style="color:#92400e;font-size:18px;">→</span>
    `;
    banner.onmouseenter = () => banner.style.transform = 'translateY(-1px)';
    banner.onmouseleave = () => banner.style.transform = 'translateY(0)';
    banner.onclick = () => openPendingList();

        // ✅ "영상", "리포트", "평가 완료" 카드 그리드 찾아서 그 위에 배치
    const allDivs = Array.from(statsModal.querySelectorAll('div'));
    const cardGrid = allDivs.find(d => {
      if (d.offsetParent === null) return false;
      const style = getComputedStyle(d);
      if (style.display !== 'grid') return false;
      const children = d.children.length;
      if (children < 2 || children > 5) return false;
      const text = d.textContent || '';
      return text.includes('영상') && text.includes('리포트') && text.includes('평가 완료');
    });
    
    if (cardGrid?.parentElement) {
      // 카드 그리드 바로 위에 삽입
      cardGrid.parentElement.insertBefore(banner, cardGrid);
    } else {
      // 폴백: 모달 최상단
      statsModal.insertBefore(banner, statsModal.firstChild);
    }
  }

  // ============ 평가 대기 항목 목록 모달 ============
  async function openPendingList() {
    document.getElementById('p16-notif-modal')?.remove();
    const pending = await getPendingEvaluations();

    const overlay = document.createElement('div');
    overlay.id = 'p16-notif-modal';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100003;
      display:flex;align-items:center;justify-content:center;padding:20px;
    `;

    const renderItem = (item) => {
      const overdueMsg = item.overdue === 0
        ? `<span style="color:#16a34a;font-weight:bold;">📍 오늘 평가일</span>`
        : item.overdue <= OVERDUE_WINDOW
          ? `<span style="color:#ca8a04;">⏰ ${item.overdue}일 지남</span>`
          : `<span style="color:#dc2626;">⚠️ ${item.overdue}일 지남</span>`;
      const icon = item.type === 'video' ? '📺' : '📄';
      return `
        <div class="p16-notif-item" data-id="${item.id}" data-type="${item.type}" data-period="${item.period}"
             style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:8px;background:#fafafa;cursor:pointer;transition:0.15s;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:bold;font-size:14px;color:#111;">${icon} ${escapeHtml(item.title)}</div>
              <div style="font-size:12px;color:#6b7280;margin-top:3px;">
                ${item.type === 'video' ? escapeHtml(item.channelName) : escapeHtml(item.firm || '')}
                · 등록 ${item.daysSince}일 전
              </div>
              <div style="margin-top:6px;">
                <span style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:bold;">
                  ${item.periodLabel} 평가
                </span>
                <span style="margin-left:8px;font-size:12px;">${overdueMsg}</span>
              </div>
            </div>
            <div style="flex-shrink:0;">
              <button class="p16-notif-track" style="background:#3b82f6;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold;">
                📊 추적 입력
              </button>
            </div>
          </div>
        </div>
      `;
    };

    const allItems = [...pending.videos, ...pending.reports]
      .sort((a, b) => b.overdue - a.overdue); // 가장 오래된 것 먼저

    const itemsHtml = allItems.length === 0
      ? '<div style="text-align:center;padding:40px;color:#999;">평가 대기 항목이 없습니다.</div>'
      : allItems.map(renderItem).join('');

    overlay.innerHTML = `
      <div style="background:white;border-radius:12px;max-width:680px;width:100%;max-height:85vh;overflow:auto;padding:20px;box-shadow:0 10px 25px rgba(0,0,0,0.2);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h2 style="margin:0;font-size:18px;">🔔 평가 대기 항목 (${pending.total}건)</h2>
          <button id="p16-notif-close" style="border:none;background:transparent;font-size:22px;cursor:pointer;color:#666;">×</button>
        </div>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:#1e40af;">
          💡 각 항목을 클릭하면 추적 입력 모달이 열립니다. 평가일이 지난 항목은 우선 처리하세요.
        </div>
        ${itemsHtml}
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.querySelector('#p16-notif-close').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    // 항목 클릭 시 추적 모달 자동 오픈
    overlay.querySelectorAll('.p16-notif-item, .p16-notif-track').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        const itemEl = el.closest('.p16-notif-item');
        const id = itemEl?.dataset.id;
        const type = itemEl?.dataset.type;
        if (!id) return;
        overlay.remove();
        // phase16-outcomes의 openModal 호출
        if (window.__phase16Outcomes?.openModal) {
          window.__phase16Outcomes.openModal(id, type);
        } else {
          alert('추적 모듈을 찾을 수 없습니다.');
        }
      };
      el.onmouseenter = () => {
        const target = el.classList.contains('p16-notif-item') ? el : null;
        if (target) target.style.background = '#f0f9ff';
      };
      el.onmouseleave = () => {
        const target = el.classList.contains('p16-notif-item') ? el : null;
        if (target) target.style.background = '#fafafa';
      };
    });
  }

    // ============ 메뉴 배지 (📋 메뉴 버튼에 빨간 점) ============
  async function updateMenuBadge() {
    try {
      const getFn = window.__phase16Notif?.getPendingEvaluations;
      if (!getFn) return;
      const pending = await getFn();
    // 페이지의 메뉴 버튼 찾기 (텍스트 "메뉴" 포함)
    const menuBtns = Array.from(document.querySelectorAll('button')).filter(b => {
      if (b.offsetParent === null) return false;
      const txt = b.textContent.trim();
      return txt === '메뉴' || /^📋?\s*메뉴$/.test(txt);
    });

    menuBtns.forEach(btn => {
      let badge = btn.querySelector('.p16-notif-badge');
      if (pending.total === 0) {
        badge?.remove();
        return;
      }
      if (!badge) {
        // 부모 position relative 보장
        if (getComputedStyle(btn).position === 'static') {
          btn.style.position = 'relative';
        }
        badge = document.createElement('span');
        badge.className = 'p16-notif-badge';
        badge.style.cssText = `
          position: absolute;
          top: -4px;
          right: -4px;
          background: #dc2626;
          color: white;
          border-radius: 10px;
          padding: 2px 6px;
          font-size: 10px;
          font-weight: bold;
          min-width: 18px;
          text-align: center;
          line-height: 1.2;
          z-index: 10;
          box-shadow: 0 1px 3px rgba(0,0,0,0.2);
          pointer-events: none;
        `;
        btn.appendChild(badge);
      }
      badge.textContent = pending.total > 99 ? '99+' : String(pending.total);
    });
  }

  // ============ 통계 모달 감시 (배너 자동 삽입) ============
  function watchStatsModal() {
    setInterval(async () => {
      try {
        await injectStatsBanner();
      } catch (e) {
        // 무시
      }
    }, 1500);
  }

  // ============ 메뉴 배지 주기적 업데이트 ============
  function startMenuBadgeUpdater() {
    setInterval(async () => {
      try {
        await updateMenuBadge();
      } catch (e) {
        // 무시
      }
    }, 5000);
    setTimeout(updateMenuBadge, 2000);
  }

  // ============ 테스트 함수 (디버그용) ============
  async function test() {
    const pending = await getPendingEvaluations();
    console.log('━━━ 평가 대기 항목 ━━━');
    console.log('총:', pending.total, '(영상', pending.videos.length, '+ 리포트', pending.reports.length + ')');
    console.log('지난 평가일:', pending.overdue);
    console.log('영상:', pending.videos);
    console.log('리포트:', pending.reports);
    return pending;
  }

  // ============ 초기화 ============
  function init() {
    console.log(`🔔 Phase 16 알림 v${VERSION} 로드됨`);
    watchStatsModal();
    startMenuBadgeUpdater();
    window.__phase16Notif = {
      version: VERSION,
      getPendingEvaluations,
      openPendingList,
      updateMenuBadge,
      test,
      PERIODS
    };
  }

  waitForDeps(init);
})();
