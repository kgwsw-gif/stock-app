// phase16-menu.js - 정보 노트 메뉴 항목 추가 v0.2.0
(function() {
  const VERSION = '0.2.0';
  const ITEM_ID = 'p16-menu-info-note';
  const ITEM_TEXT = '정보 노트';
  const ITEM_ICON = '📝';
  const ANCHOR_FN = 'showWagTheDog';  // 이 버튼 다음에 삽입

  function waitForPhase16(maxWait = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.__phase16List?.open) return resolve();
        if (Date.now() - start > maxWait) return reject(new Error('timeout'));
        setTimeout(check, 100);
      };
      check();
    });
  }

  function findAnchor() {
    // data-fn 속성으로 정확히 매칭
    return document.querySelector(`button.menu-item[data-fn="${ANCHOR_FN}"]`);
  }

  function insertMenuItem() {
    if (document.getElementById(ITEM_ID)) return true;

    const anchor = findAnchor();
    if (!anchor) return false;

    // 앵커 복제
    const newItem = anchor.cloneNode(true);
    newItem.id = ITEM_ID;
    newItem.removeAttribute('data-fn');  // 원본 함수 호출 방지
    newItem.setAttribute('data-fn', 'p16InfoNote');  // 새 식별자

    // innerHTML 교체 (아이콘 + 텍스트)
    newItem.innerHTML = newItem.innerHTML
      .replace(/🐶/g, ITEM_ICON)
      .replace(/왝더독\s*분석/g, ITEM_TEXT);

    // 클릭 이벤트 (cloneNode가 inline 이벤트 복사 못하지만 안전을 위해 명시적 등록)
    newItem.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      console.log('[Phase16-menu] 정보 노트 클릭');
      window.__phase16List.open();
    }, true);

    // 앵커 바로 다음에 삽입
    anchor.parentNode.insertBefore(newItem, anchor.nextSibling);

    console.log(`[Phase16-menu v${VERSION}] ✅ "${ITEM_ICON} ${ITEM_TEXT}" 항목 추가`);
    return true;
  }

  function observeMenu() {
    const observer = new MutationObserver(() => {
      if (document.getElementById(ITEM_ID)) return;
      const anchor = findAnchor();
      if (anchor) {
        const rect = anchor.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          insertMenuItem();
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function init() {
    try {
      await waitForPhase16();
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📝 Phase 16 메뉴 통합 v${VERSION}`);
      console.log(`   data-fn="${ANCHOR_FN}" 다음에 자동 삽입`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      insertMenuItem();
      observeMenu();
    } catch (e) {
      console.error('[Phase16-menu] 초기화 실패:', e);
    }
  }

  window.__phase16Menu = {
    version: VERSION,
    insert: insertMenuItem,
    findAnchor
  };

  setTimeout(init, 4500);
})();
