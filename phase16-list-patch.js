// phase16-list-patch.js - 영상 목록에 리포트/통계 탭 추가 v0.2.0
(function() {
  const VERSION = '0.2.0';
  const REPORT_TAB_ID = 'p16-tab-reports';
  const STATS_TAB_ID = 'p16-tab-stats';

  function waitForDeps(maxWait = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.__phase16List?.open && window.__phase16Reports?.openList) return resolve();
        if (Date.now() - start > maxWait) return reject(new Error('timeout'));
        setTimeout(check, 100);
      };
      check();
    });
  }

  function findTabContainer() {
    const buttons = Array.from(document.querySelectorAll('button'));
    const videoTab = buttons.find(b => /📋\s*영상\s*목록/.test(b.textContent || ''));
    const tickerTab = buttons.find(b => /🏷️\s*종목별\s*보기/.test(b.textContent || ''));
    if (videoTab && tickerTab && videoTab.parentElement === tickerTab.parentElement) {
      return { container: videoTab.parentElement, refTab: tickerTab };
    }
    return null;
  }

  function findLastTab(container) {
    // 컨테이너 안에 있는 마지막 형제 버튼
    const buttons = Array.from(container.children).filter(c => c.tagName === 'BUTTON');
    return buttons[buttons.length - 1];
  }

  function closeCurrentListModal() {
    const listModal = document.querySelector('[id^="phase16-list-modal"], [id^="phase16-video-list"], [id^="p16-list"]');
    if (listModal) listModal.remove();
  }

  function insertTabs() {
    const found = findTabContainer();
    if (!found) return false;
    const { container, refTab } = found;

    let inserted = 0;

    // 1. 리포트 탭 (기존)
    if (!document.getElementById(REPORT_TAB_ID)) {
      const newTab = refTab.cloneNode(true);
      newTab.id = REPORT_TAB_ID;
      newTab.textContent = '📄 애널리스트 리포트';
      newTab.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        closeCurrentListModal();
        setTimeout(() => window.__phase16Reports.openList(), 50);
      }, true);
      const last = findLastTab(container);
      if (last && last.nextSibling) container.insertBefore(newTab, last.nextSibling);
      else container.appendChild(newTab);
      inserted++;
    }

    // 2. 통계 탭 (신규)
    if (!document.getElementById(STATS_TAB_ID) && window.__phase16Stats?.openModal) {
      const statsTab = refTab.cloneNode(true);
      statsTab.id = STATS_TAB_ID;
      statsTab.textContent = '📊 통계';
      statsTab.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        closeCurrentListModal();
        setTimeout(() => window.__phase16Stats.openModal(), 50);
      }, true);
      const last = findLastTab(container);
      if (last && last.nextSibling) container.insertBefore(statsTab, last.nextSibling);
      else container.appendChild(statsTab);
      inserted++;
    }

    if (inserted > 0) console.log(`[Phase16-list-patch v${VERSION}] ✅ 탭 ${inserted}개 추가`);
    return inserted > 0;
  }

  function observe() {
    const observer = new MutationObserver(() => {
      const reportExists = document.getElementById(REPORT_TAB_ID);
      const statsExists = document.getElementById(STATS_TAB_ID);
      if (reportExists && statsExists) return;
      insertTabs();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function init() {
    try {
      await waitForDeps();
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📄 Phase 16 목록 패치 v${VERSION}`);
      console.log('   "애널리스트 리포트" + "통계" 탭 자동 추가');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      observe();
    } catch(e) {
      console.error('[Phase16-list-patch] 초기화 실패:', e);
    }
  }

  window.__phase16ListPatch = {
    version: VERSION,
    insert: insertTabs
  };

  setTimeout(init, 5500);
})();
