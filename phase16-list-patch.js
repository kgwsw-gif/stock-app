// phase16-list-patch.js - 영상 목록에 리포트 탭 추가 v0.1.0
(function() {
  const VERSION = '0.1.0';
  const TAB_ID = 'p16-tab-reports';

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
    // 영상 목록 모달 내의 탭 버튼들이 들어있는 부모 컨테이너 찾기
    // 영상 목록 탭과 종목별 보기 탭이 형제로 있는 컨테이너
    const buttons = Array.from(document.querySelectorAll('button'));
    const videoTab = buttons.find(b => /📋\s*영상\s*목록/.test(b.textContent || ''));
    const tickerTab = buttons.find(b => /🏷️\s*종목별\s*보기/.test(b.textContent || ''));
    if (videoTab && tickerTab && videoTab.parentElement === tickerTab.parentElement) {
      return { container: videoTab.parentElement, refTab: tickerTab };
    }
    return null;
  }

  function insertReportTab() {
    if (document.getElementById(TAB_ID)) return true;
    const found = findTabContainer();
    if (!found) return false;

    const { container, refTab } = found;
    const newTab = refTab.cloneNode(true);
    newTab.id = TAB_ID;
    newTab.textContent = '📄 애널리스트 리포트';

    // 클릭 시: 영상 목록 모달을 닫고 리포트 목록을 열기
    newTab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      console.log('[Phase16-list-patch] 리포트 탭 클릭');
      // 현재 영상 목록 모달 닫기 (가장 위에 있는 phase16 모달 찾아 제거)
      const listModal = document.querySelector('[id^="phase16-list-modal"], [id^="phase16-video-list"], [id^="p16-list"]');
      if (listModal) listModal.remove();
      // 약간의 지연 후 리포트 목록 열기
      setTimeout(() => window.__phase16Reports.openList(), 50);
    }, true);

    // 종목별 보기 탭 바로 뒤에 삽입
    if (refTab.nextSibling) {
      container.insertBefore(newTab, refTab.nextSibling);
    } else {
      container.appendChild(newTab);
    }
    console.log(`[Phase16-list-patch v${VERSION}] ✅ "📄 애널리스트 리포트" 탭 추가됨`);
    return true;
  }

  function observe() {
    // 영상 목록 모달이 열릴 때마다 자동으로 탭 추가
    const observer = new MutationObserver(() => {
      if (document.getElementById(TAB_ID)) return;
      insertReportTab();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function init() {
    try {
      await waitForDeps();
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📄 Phase 16 목록 패치 v${VERSION}`);
      console.log('   영상 목록에 "애널리스트 리포트" 탭 자동 추가');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      observe();
    } catch(e) {
      console.error('[Phase16-list-patch] 초기화 실패:', e);
    }
  }

  window.__phase16ListPatch = {
    version: VERSION,
    insert: insertReportTab
  };

  setTimeout(init, 5000);
})();
