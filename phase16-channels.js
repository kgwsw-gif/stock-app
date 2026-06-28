// phase16-channels.js v0.1.0
// 채널 관리: 등록/수정/삭제 + 영상 입력 자동완성 + 채널별 통계
(function() {
  'use strict';
  const VERSION = '0.1.1';
  const INSIGHT_DB = 'StockJournalInsightsDB';
  const CHANNEL_STORE = 'youtube_channels';
  const VIDEO_STORE = 'video_insights';

  // ============ 유틸 ============
  function genId() {
    return 'ch_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function waitForDeps(cb, retries = 50) {
    if (window.__phase16?.version) return cb();
    if (retries <= 0) {
      console.warn('[phase16-channels] __phase16 의존성 로드 실패');
      return;
    }
    setTimeout(() => waitForDeps(cb, retries - 1), 200);
  }

  // ============ DB 헬퍼 ============
  function openInsightDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(INSIGHT_DB);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllChannels() {
    const db = await openInsightDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(CHANNEL_STORE, 'readonly');
        const store = tx.objectStore(CHANNEL_STORE);
        const req = store.getAll();
        req.onsuccess = () => { resolve(req.result || []); db.close(); };
        req.onerror = () => { reject(req.error); db.close(); };
      } catch (e) {
        console.warn('[phase16-channels] CHANNEL_STORE 없음', e);
        resolve([]);
        db.close();
      }
    });
  }

  async function saveChannel(channel) {
    const db = await openInsightDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHANNEL_STORE, 'readwrite');
      const store = tx.objectStore(CHANNEL_STORE);
      const req = store.put(channel);
      req.onsuccess = () => { resolve(req.result); db.close(); };
      req.onerror = () => { reject(req.error); db.close(); };
    });
  }

  async function deleteChannel(id) {
    const db = await openInsightDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHANNEL_STORE, 'readwrite');
      const store = tx.objectStore(CHANNEL_STORE);
      const req = store.delete(id);
      req.onsuccess = () => { resolve(); db.close(); };
      req.onerror = () => { reject(req.error); db.close(); };
    });
  }

  async function getAllVideos() {
    if (typeof window.__phase16?.getAllVideos === 'function') {
      return await window.__phase16.getAllVideos();
    }
    return [];
  }

  // ============ 채널별 통계 계산 ============
  async function getChannelStats() {
    const videos = await getAllVideos();
    const stats = {};
    videos.forEach(v => {
      const ch = v.channelName || v.channel || '(미지정)';
      if (!stats[ch]) stats[ch] = { count: 0, lastDate: null, hits: 0, total: 0 };
      stats[ch].count++;
      const d = v.createdAt || v.date;
      if (d && (!stats[ch].lastDate || d > stats[ch].lastDate)) stats[ch].lastDate = d;
      // outcomes 적중률
      const outcomes = v.outcomes;
      if (outcomes && typeof outcomes === 'object' && !Array.isArray(outcomes)) {
        ['1m', '3m', '6m'].forEach(p => {
          const o = outcomes[p];
          if (o && Array.isArray(o.tickers)) {
            o.tickers.forEach(t => {
              if (t.toneHit === '적중' || t.toneHit === '미적중') {
                stats[ch].total++;
                if (t.toneHit === '적중') stats[ch].hits++;
              }
            });
          }
        });
      }
    });
    return stats;
  }

  // ============ 채널 관리 모달 ============
  async function openChannelManager() {
    // 기존 모달 제거
    document.getElementById('p16-channel-modal')?.remove();

    const channels = await getAllChannels();
    const videoStats = await getChannelStats();

    // 영상에서 사용된 채널 중 등록되지 않은 것
    const registered = new Set(channels.map(c => c.name));
    const unregistered = Object.keys(videoStats).filter(n => !registered.has(n) && n !== '(미지정)');

    const overlay = document.createElement('div');
    overlay.id = 'p16-channel-modal';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100000;
      display:flex;align-items:center;justify-content:center;padding:20px;
    `;

    const channelsHtml = channels.length === 0
      ? '<div style="text-align:center;padding:40px;color:#999;">등록된 채널이 없습니다.<br>아래에서 새 채널을 추가하거나, 영상에서 사용 중인 채널을 자동 등록할 수 있습니다.</div>'
      : channels.map(c => {
          const s = videoStats[c.name] || { count: 0, lastDate: null, hits: 0, total: 0 };
          const rate = s.total > 0 ? `${(s.hits / s.total * 100).toFixed(0)}%` : '-';
          const rateColor = s.total === 0 ? '#999' : (s.hits / s.total >= 0.7 ? '#16a34a' : s.hits / s.total >= 0.4 ? '#ca8a04' : '#dc2626');
          return `
            <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:8px;background:#fafafa;">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:bold;font-size:15px;color:#111;">📺 ${escapeHtml(c.name)}</div>
                  ${c.category ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">🏷️ ${escapeHtml(c.category)}</div>` : ''}
                  ${c.url ? `<div style="font-size:12px;margin-top:2px;"><a href="${escapeHtml(c.url)}" target="_blank" style="color:#3b82f6;text-decoration:none;">🔗 ${escapeHtml(c.url.slice(0, 50))}</a></div>` : ''}
                  ${c.memo ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">${escapeHtml(c.memo)}</div>` : ''}
                  <div style="display:flex;gap:12px;margin-top:6px;font-size:12px;">
                    <span style="color:#374151;">영상 <b>${s.count}</b>건</span>
                    <span style="color:${rateColor};">적중 <b>${rate}</b> (${s.hits}/${s.total})</span>
                    ${s.lastDate ? `<span style="color:#9ca3af;">최근 ${s.lastDate.slice(0, 10)}</span>` : ''}
                  </div>
                </div>
                <div style="display:flex;gap:5px;flex-shrink:0;">
                  <button class="p16-ch-edit" data-id="${c.id}" style="border:1px solid #ddd;background:white;padding:4px 9px;border-radius:5px;cursor:pointer;font-size:12px;">수정</button>
                  <button class="p16-ch-delete" data-id="${c.id}" style="border:1px solid #fca5a5;background:white;color:#dc2626;padding:4px 9px;border-radius:5px;cursor:pointer;font-size:12px;">삭제</button>
                </div>
              </div>
            </div>
          `;
        }).join('');

    const unregHtml = unregistered.length === 0 ? '' : `
      <div style="margin-top:14px;padding:10px;background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;">
        <div style="font-weight:bold;font-size:13px;color:#92400e;margin-bottom:6px;">⚠️ 미등록 채널 (${unregistered.length}개)</div>
        <div style="font-size:12px;color:#78350f;margin-bottom:8px;">영상에 입력되었지만 채널 관리에 등록되지 않은 채널입니다.</div>
        ${unregistered.map(n => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;">
            <span style="font-size:13px;">${escapeHtml(n)} <span style="color:#9ca3af;font-size:11px;">(영상 ${videoStats[n].count}건)</span></span>
            <button class="p16-ch-quickadd" data-name="${escapeHtml(n)}" style="border:1px solid #f59e0b;background:white;color:#b45309;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;">+ 등록</button>
          </div>
        `).join('')}
      </div>
    `;

    overlay.innerHTML = `
      <div style="background:white;border-radius:12px;max-width:700px;width:100%;max-height:90vh;overflow:auto;padding:20px;box-shadow:0 10px 25px rgba(0,0,0,0.2);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h2 style="margin:0;font-size:18px;">📺 채널 관리</h2>
          <button id="p16-ch-close" style="border:none;background:transparent;font-size:22px;cursor:pointer;color:#666;">×</button>
        </div>

        <div style="background:#f3f4f6;border-radius:8px;padding:12px;margin-bottom:14px;">
          <div style="font-size:13px;color:#374151;margin-bottom:8px;font-weight:bold;">➕ 새 채널 추가</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
            <input id="p16-ch-name" placeholder="채널명 (필수)" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
            <input id="p16-ch-category" placeholder="카테고리 (예: 주식분석)" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
          </div>
          <input id="p16-ch-url" placeholder="URL (선택)" style="width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:8px;box-sizing:border-box;">
          <input id="p16-ch-memo" placeholder="메모 (선택)" style="width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:8px;box-sizing:border-box;">
          <button id="p16-ch-add" style="background:#3b82f6;color:white;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:bold;">+ 추가</button>
        </div>

        <div style="margin-bottom:8px;font-size:13px;color:#6b7280;">📋 등록된 채널 (${channels.length}개)</div>
        <div id="p16-ch-list">${channelsHtml}</div>
        ${unregHtml}
      </div>
    `;

    document.body.appendChild(overlay);

    // 이벤트
    overlay.querySelector('#p16-ch-close').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    overlay.querySelector('#p16-ch-add').onclick = async () => {
      const name = overlay.querySelector('#p16-ch-name').value.trim();
      if (!name) { alert('채널명은 필수입니다.'); return; }
      const dup = channels.find(c => c.name === name);
      if (dup) { alert('이미 등록된 채널입니다.'); return; }
      const channel = {
        id: genId(),
        name,
        category: overlay.querySelector('#p16-ch-category').value.trim(),
        url: overlay.querySelector('#p16-ch-url').value.trim(),
        memo: overlay.querySelector('#p16-ch-memo').value.trim(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await saveChannel(channel);
      overlay.remove();
      openChannelManager();
    };

    overlay.querySelectorAll('.p16-ch-quickadd').forEach(btn => {
      btn.onclick = async () => {
        const name = btn.dataset.name;
        const channel = {
          id: genId(),
          name,
          category: '',
          url: '',
          memo: '(자동 등록)',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await saveChannel(channel);
        overlay.remove();
        openChannelManager();
      };
    });

    overlay.querySelectorAll('.p16-ch-edit').forEach(btn => {
      btn.onclick = () => {
        const ch = channels.find(c => c.id === btn.dataset.id);
        if (!ch) return;
        openChannelEditor(ch);
      };
    });

    overlay.querySelectorAll('.p16-ch-delete').forEach(btn => {
      btn.onclick = async () => {
        const ch = channels.find(c => c.id === btn.dataset.id);
        if (!ch) return;
        if (!confirm(`'${ch.name}' 채널을 삭제하시겠습니까?\n(영상 데이터는 보존됩니다)`)) return;
        await deleteChannel(ch.id);
        overlay.remove();
        openChannelManager();
      };
    });
  }

  // ============ 채널 수정 모달 ============
  function openChannelEditor(channel) {
    document.getElementById('p16-ch-edit-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'p16-ch-edit-modal';
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100001;display:flex;align-items:center;justify-content:center;padding:20px;`;
    overlay.innerHTML = `
      <div style="background:white;border-radius:12px;max-width:500px;width:100%;padding:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h3 style="margin:0;font-size:16px;">📺 채널 수정</h3>
          <button id="p16-che-close" style="border:none;background:transparent;font-size:22px;cursor:pointer;">×</button>
        </div>
        <label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">채널명</label>
        <input id="p16-che-name" value="${escapeHtml(channel.name)}" style="width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:10px;box-sizing:border-box;">
        <label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">카테고리</label>
        <input id="p16-che-category" value="${escapeHtml(channel.category || '')}" style="width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:10px;box-sizing:border-box;">
        <label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">URL</label>
        <input id="p16-che-url" value="${escapeHtml(channel.url || '')}" style="width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:10px;box-sizing:border-box;">
        <label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">메모</label>
        <textarea id="p16-che-memo" style="width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:14px;box-sizing:border-box;min-height:60px;">${escapeHtml(channel.memo || '')}</textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="p16-che-cancel" style="border:1px solid #d1d5db;background:white;padding:6px 14px;border-radius:6px;cursor:pointer;">취소</button>
          <button id="p16-che-save" style="background:#16a34a;color:white;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-weight:bold;">저장</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#p16-che-close').onclick = () => overlay.remove();
    overlay.querySelector('#p16-che-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#p16-che-save').onclick = async () => {
      const updated = {
        ...channel,
        name: overlay.querySelector('#p16-che-name').value.trim() || channel.name,
        category: overlay.querySelector('#p16-che-category').value.trim(),
        url: overlay.querySelector('#p16-che-url').value.trim(),
        memo: overlay.querySelector('#p16-che-memo').value.trim(),
        updatedAt: new Date().toISOString()
      };
      await saveChannel(updated);
      overlay.remove();
      document.getElementById('p16-channel-modal')?.remove();
      openChannelManager();
    };
  }

  // ============ 영상 입력 모달 자동완성 ============
  async function attachAutocomplete(input) {
    if (!input || input.dataset.p16ChAttached) return;
    input.dataset.p16ChAttached = '1';

    let channels = await getAllChannels();
    let dropdown = null;

    function closeDropdown() {
      dropdown?.remove();
      dropdown = null;
    }

    function showDropdown() {
      closeDropdown();
      const query = input.value.trim().toLowerCase();
      const filtered = query
        ? channels.filter(c => c.name.toLowerCase().includes(query))
        : channels;
      if (filtered.length === 0) return;

      const rect = input.getBoundingClientRect();
      dropdown = document.createElement('div');
      dropdown.style.cssText = `
        position:fixed;left:${rect.left}px;top:${rect.bottom + 2}px;width:${rect.width}px;
        max-height:200px;overflow-y:auto;background:white;border:1px solid #d1d5db;
        border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.1);z-index:100002;
      `;
      filtered.slice(0, 20).forEach(c => {
        const item = document.createElement('div');
        item.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:13px;border-bottom:1px solid #f3f4f6;';
        item.innerHTML = `<b>${escapeHtml(c.name)}</b>${c.category ? ` <span style="color:#9ca3af;font-size:11px;">${escapeHtml(c.category)}</span>` : ''}`;
        item.onmouseenter = () => item.style.background = '#f3f4f6';
        item.onmouseleave = () => item.style.background = 'white';
        item.onmousedown = (e) => {
          e.preventDefault();
          input.value = c.name;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          closeDropdown();
        };
        dropdown.appendChild(item);
      });
      document.body.appendChild(dropdown);
    }

    input.addEventListener('focus', async () => {
      channels = await getAllChannels();
      showDropdown();
    });
    input.addEventListener('input', showDropdown);
    input.addEventListener('blur', () => setTimeout(closeDropdown, 200));
  }

  function watchVideoInputModal() {
    // 영상 입력 모달이 열릴 때마다 채널명 input에 자동완성 부착
    const observer = new MutationObserver(() => {
      // 다양한 가능성 - "채널" 텍스트 근처 input
      document.querySelectorAll('input').forEach(input => {
        if (input.dataset.p16ChAttached) return;
        const placeholder = (input.placeholder || '').toLowerCase();
        const name = (input.name || '').toLowerCase();
        const id = (input.id || '').toLowerCase();
        const label = input.closest('label')?.textContent || '';
        const prevLabel = input.previousElementSibling?.textContent || '';
        const combined = (placeholder + ' ' + name + ' ' + id + ' ' + label + ' ' + prevLabel).toLowerCase();
        if (combined.includes('채널') || combined.includes('channel')) {
          attachAutocomplete(input);
        }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ============ 메뉴 통합 (메뉴 모달에 "채널 관리" 버튼 추가) ============
  function injectMenuButton() {
    const tryInject = () => {
      // phase16-menu가 생성하는 모달을 찾음
      const menuModals = document.querySelectorAll('[id*="phase16-menu"], [id*="p16-menu"]');
      menuModals.forEach(modal => {
        if (modal.dataset.p16ChInjected) return;
        // 모달이 보이는 경우만
        if (modal.offsetParent === null) return;
        // 기존 버튼 중 하나를 찾아 복제해 채널 관리 버튼 생성
        const buttons = modal.querySelectorAll('button');
        const refBtn = Array.from(buttons).find(b => 
          /정보 노트|📝|영상 목록/.test(b.textContent)
        );
        if (!refBtn) return;
        modal.dataset.p16ChInjected = '1';
        const newBtn = refBtn.cloneNode(true);
        newBtn.textContent = '📺 채널 관리';
        newBtn.onclick = () => {
          modal.remove();
          openChannelManager();
        };
        refBtn.parentNode.insertBefore(newBtn, refBtn.nextSibling);
      });
    };
    const observer = new MutationObserver(tryInject);
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(tryInject, 2000);
  }

  // ============ 초기화 ============
  function init() {
    console.log(`📺 Phase 16 채널 관리 v${VERSION} 로드됨`);
    watchVideoInputModal();
    injectMenuButton();
    window.__phase16Channels = {
      version: VERSION,
      openManager: openChannelManager,
      getAll: getAllChannels,
      save: saveChannel,
      delete: deleteChannel,
      getStats: getChannelStats
    };
  }

  waitForDeps(init);
})();
