/* ============================================================
   Phase 12 v1.0 - Firestore 멀티 디바이스 동기화
   - Google 로그인 / 로그아웃
   - Push/Pull/FullSync (Last-write-wins)
   - 자동 동기화 (Phase 6-B, 7 후킹)
   - ☁️ 클라우드 메뉴 버튼 + 모달 UI
   ============================================================ */

(async function installPhase12() {
  console.log('🚀 Phase 12 v1.0 로드 시작');
  
  // ===== 0. 기존 인스턴스 정리 =====
  if (window.__phase12?.cleanup) {
    try { window.__phase12.cleanup(); } catch (e) {}
  }
  
  // ===== 1. Firebase SDK 로드 =====
  async function loadFirebase() {
    if (window.firebase && window.firebase.auth) return;
    const modules = [
      'https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js',
      'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth-compat.js',
      'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore-compat.js'
    ];
    for (const src of modules) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    }
  }
  
  try {
    await loadFirebase();
  } catch (err) {
    console.error('❌ Firebase SDK 로드 실패:', err);
    return;
  }
  
  const firebaseConfig = {
    apiKey: "AIzaSyCtQmRwcvnupYTY1niQGZXZue1DT9UVn4c",
    authDomain: "stock-journal-sync.firebaseapp.com",
    projectId: "stock-journal-sync",
    storageBucket: "stock-journal-sync.firebasestorage.app",
    messagingSenderId: "278079542390",
    appId: "1:278079542390:web:bb145e77ec16d1185d7b57",
    measurementId: "G-BBT6WYDH7B"
  };
  
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  
  // ===== 2. 데이터 매핑 =====
  const STORE_MAP = [
    { idb: 'transactions',    fs: 'transactions', idField: 'id' },
    { idb: 'holdings',        fs: 'holdings',     idField: 'stockCode' },
    { idb: 'daily_snapshots', fs: 'snapshots',    idField: 'id' },
    { idb: 'dividends',       fs: 'dividends',    idField: 'id' },
    { idb: 'diary_entries',   fs: 'diary',        idField: 'date' }
  ];
  
  // ===== 3. IndexedDB 헬퍼 =====
  function openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('StockJournalDB');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  
  async function idbReadAll(storeName) {
    const idb = await openIDB();
    if (!idb.objectStoreNames.contains(storeName)) { idb.close(); return []; }
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => { idb.close(); resolve(req.result || []); };
      req.onerror = () => { idb.close(); reject(req.error); };
    });
  }
  
  async function idbPut(storeName, item) {
    const idb = await openIDB();
    if (!idb.objectStoreNames.contains(storeName)) { idb.close(); return false; }
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(item);
      req.onsuccess = () => { idb.close(); resolve(true); };
      req.onerror = () => { idb.close(); reject(req.error); };
    });
  }
  
  // ===== 4. 상태 =====
  const state = {
    user: null,
    syncing: false,
    autoSyncEnabled: localStorage.getItem('phase12_autoSync') !== 'false',
    lastSync: localStorage.getItem('phase12_lastSync') || null,
    pushTimer: null
  };
  
  // ===== 5. Push =====
  async function push() {
    if (!state.user) { console.warn('⚠️ Phase 12: 로그인 필요'); return null; }
    if (state.syncing) { console.warn('⏸️ Phase 12: 이미 동기화 중'); return null; }
    
    state.syncing = true;
    const results = {};
    const startTime = Date.now();
    
    try {
      for (const { idb, fs, idField } of STORE_MAP) {
        const items = await idbReadAll(idb);
        if (items.length === 0) { results[idb] = { uploaded: 0 }; continue; }
        
        const collRef = db.collection('users').doc(state.user.uid).collection(fs);
        const BATCH_SIZE = 500;
        let uploaded = 0;
        
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const chunk = items.slice(i, i + BATCH_SIZE);
          const batch = db.batch();
          
          chunk.forEach(item => {
            let docId = idField && item[idField] != null
              ? String(item[idField]).replace(/[\/]/g, '_')
              : collRef.doc().id;
            const data = {
              ...item,
              _syncedAt: firebase.firestore.FieldValue.serverTimestamp(),
              _updatedAt: item._updatedAt || new Date().toISOString()
            };
            batch.set(collRef.doc(docId), data, { merge: true });
          });
          
          await batch.commit();
          uploaded += chunk.length;
        }
        results[idb] = { uploaded };
      }
      
      await db.collection('users').doc(state.user.uid).set({
        lastSync: firebase.firestore.FieldValue.serverTimestamp(),
        email: state.user.email,
        displayName: state.user.displayName,
        devices: firebase.firestore.FieldValue.arrayUnion(navigator.userAgent.substring(0, 80))
      }, { merge: true });
      
      state.lastSync = new Date().toISOString();
      localStorage.setItem('phase12_lastSync', state.lastSync);
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const total = Object.values(results).reduce((s, r) => s + r.uploaded, 0);
      console.log(`✅ Phase 12 Push 완료: ${total}건 / ${elapsed}초`);
      return { results, total, elapsed };
    } catch (err) {
      console.error('❌ Phase 12 Push 실패:', err);
      return { error: err.message };
    } finally {
      state.syncing = false;
    }
  }
  
  // ===== 6. Pull (Last-write-wins) =====
  async function pull() {
    if (!state.user) { console.warn('⚠️ Phase 12: 로그인 필요'); return null; }
    if (state.syncing) { console.warn('⏸️ Phase 12: 이미 동기화 중'); return null; }
    
    state.syncing = true;
    const results = {};
    const startTime = Date.now();
    
    try {
      for (const { idb, fs, idField } of STORE_MAP) {
        const snap = await db.collection('users').doc(state.user.uid).collection(fs).get();
        if (snap.empty) { results[idb] = { downloaded: 0, skipped: 0 }; continue; }
        
        const localItems = await idbReadAll(idb);
        const localMap = new Map();
        localItems.forEach(item => {
          const key = idField && item[idField] != null ? String(item[idField]) : null;
          if (key) localMap.set(key, item);
        });
        
        let downloaded = 0, skipped = 0;
        for (const doc of snap.docs) {
          const fsData = doc.data();
          delete fsData._syncedAt;
          
          const key = doc.id;
          const local = localMap.get(key);
          if (local) {
            const localTime = new Date(local._updatedAt || 0).getTime();
            const remoteTime = new Date(fsData._updatedAt || 0).getTime();
            if (localTime >= remoteTime) { skipped++; continue; }
          }
          
          try {
            await idbPut(idb, fsData);
            downloaded++;
          } catch (e) {
            skipped++;
          }
        }
        results[idb] = { downloaded, skipped };
      }
      
      state.lastSync = new Date().toISOString();
      localStorage.setItem('phase12_lastSync', state.lastSync);
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const total = Object.values(results).reduce((s, r) => s + r.downloaded, 0);
      console.log(`✅ Phase 12 Pull 완료: ${total}건 / ${elapsed}초`);
      return { results, total, elapsed };
    } catch (err) {
      console.error('❌ Phase 12 Pull 실패:', err);
      return { error: err.message };
    } finally {
      state.syncing = false;
    }
  }
  
  async function fullSync() {
    const pullResult = await pull();
    const pushResult = await push();
    return { pull: pullResult, push: pushResult };
  }
  
  function scheduleAutoPush() {
    if (!state.autoSyncEnabled || !state.user) return;
    if (state.pushTimer) clearTimeout(state.pushTimer);
    state.pushTimer = setTimeout(() => push(), 5000);
  }
  
  // ===== 7. 인증 =====
  async function signIn() {
    const provider = new firebase.auth.GoogleAuthProvider();
    const result = await auth.signInWithPopup(provider);
    return result.user;
  }
  
  async function signOut() {
    await auth.signOut();
    state.user = null;
  }
  
  auth.onAuthStateChanged(user => {
    state.user = user;
    if (user) {
      console.log('🔵 Phase 12: 로그인됨 -', user.email);
      if (!sessionStorage.getItem('phase12_initialPull_' + user.uid)) {
        sessionStorage.setItem('phase12_initialPull_' + user.uid, '1');
        setTimeout(() => pull(), 1500);
      }
    } else {
      console.log('⚪ Phase 12: 로그아웃');
    }
  });
  
  // ===== 8. UI =====
  function createModal() {
    if (document.getElementById('phase12-modal')) return;
    
    const modal = document.createElement('div');
    modal.id = 'phase12-modal';
    modal.style.cssText = 'display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:360px;max-width:90vw;background:#1a1f2a;border:1px solid #3a4250;border-radius:12px;padding:20px;z-index:10000;color:#e0e6ed;font-family:system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    modal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;font-size:16px;">☁️ 클라우드 동기화</h3>
        <button id="p12-close" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;">×</button>
      </div>
      <div id="p12-user-info" style="margin-bottom:16px;padding:12px;background:#222936;border-radius:8px;font-size:13px;"></div>
      <div id="p12-buttons" style="display:flex;flex-direction:column;gap:8px;"></div>
      <div id="p12-status" style="margin-top:12px;padding:8px;background:#222936;border-radius:6px;font-size:11px;color:#888;min-height:20px;"></div>
    `;
    document.body.appendChild(modal);
    
    const overlay = document.createElement('div');
    overlay.id = 'phase12-overlay';
    overlay.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;';
    overlay.addEventListener('click', closeModal);
    document.body.appendChild(overlay);
    
    document.getElementById('p12-close').addEventListener('click', closeModal);
  }
  
  function openModal() {
    createModal();
    document.getElementById('phase12-modal').style.display = 'block';
    document.getElementById('phase12-overlay').style.display = 'block';
    renderModal();
  }
  
  function closeModal() {
    const m = document.getElementById('phase12-modal');
    const o = document.getElementById('phase12-overlay');
    if (m) m.style.display = 'none';
    if (o) o.style.display = 'none';
  }
  
  function renderModal() {
    const info = document.getElementById('p12-user-info');
    const btns = document.getElementById('p12-buttons');
    const status = document.getElementById('p12-status');
    if (!info || !btns) return;
    
    const btnStyle = 'padding:10px 14px;background:#2a2f3a;color:#e0e6ed;border:1px solid #3a4250;border-radius:6px;cursor:pointer;font-size:13px;text-align:left;transition:background 0.2s;';
    
    if (state.user) {
      const lastSync = state.lastSync ? new Date(state.lastSync).toLocaleString('ko-KR') : '없음';
      info.innerHTML = `
        <div>👤 <b>${state.user.displayName || state.user.email}</b></div>
        <div style="font-size:11px;color:#888;margin-top:4px;">${state.user.email}</div>
        <div style="font-size:11px;color:#888;margin-top:4px;">마지막 동기화: ${lastSync}</div>
        <div style="font-size:11px;color:#888;margin-top:4px;">자동 동기화: ${state.autoSyncEnabled ? '🟢 ON' : '🔴 OFF'}</div>
      `;
      btns.innerHTML = `
        <button id="p12-push" style="${btnStyle}">⬆️ 업로드 (로컬 → 클라우드)</button>
        <button id="p12-pull" style="${btnStyle}">⬇️ 다운로드 (클라우드 → 로컬)</button>
        <button id="p12-full" style="${btnStyle}">🔄 전체 동기화</button>
        <button id="p12-auto" style="${btnStyle}">${state.autoSyncEnabled ? '🔴' : '🟢'} 자동 동기화 ${state.autoSyncEnabled ? 'OFF' : 'ON'}</button>
        <button id="p12-signout" style="${btnStyle}background:#3a2a2a;">🚪 로그아웃</button>
      `;
      
      document.getElementById('p12-push').addEventListener('click', async () => {
        status.textContent = '⏳ 업로드 중...';
        const r = await push();
        status.textContent = r?.error ? '❌ ' + r.error : `✅ 업로드 완료: ${r.total}건 (${r.elapsed}초)`;
        renderModal();
      });
      document.getElementById('p12-pull').addEventListener('click', async () => {
        status.textContent = '⏳ 다운로드 중...';
        const r = await pull();
        status.textContent = r?.error ? '❌ ' + r.error : `✅ 다운로드 완료: ${r.total}건 (${r.elapsed}초)`;
        renderModal();
      });
      document.getElementById('p12-full').addEventListener('click', async () => {
        status.textContent = '⏳ 전체 동기화 중...';
        const r = await fullSync();
        status.textContent = `✅ 전체 동기화 완료 (Pull: ${r.pull?.total||0}, Push: ${r.push?.total||0})`;
        renderModal();
      });
      document.getElementById('p12-auto').addEventListener('click', () => {
        state.autoSyncEnabled = !state.autoSyncEnabled;
        localStorage.setItem('phase12_autoSync', state.autoSyncEnabled);
        renderModal();
      });
      document.getElementById('p12-signout').addEventListener('click', async () => {
        await signOut();
        renderModal();
      });
    } else {
      info.innerHTML = `<div>로그인이 필요합니다.</div>`;
      btns.innerHTML = `<button id="p12-signin" style="${btnStyle}background:#1a4080;">🔐 Google 계정으로 로그인</button>`;
      document.getElementById('p12-signin').addEventListener('click', async () => {
        try {
          status.textContent = '⏳ 로그인 중...';
          await signIn();
          status.textContent = '✅ 로그인 성공';
          setTimeout(renderModal, 500);
        } catch (err) {
          status.textContent = '❌ ' + err.message;
        }
      });
    }
  }
  
  // ===== 9. 메뉴 버튼 추가 =====
  function injectMenuButton() {
    const menuPanel = document.querySelector('#menu-panel') || document.querySelector('[id*="menu"]');
    if (!menuPanel) return false;
    if (menuPanel.querySelector('[data-act="cloud-sync"]')) return true;
    
    const refBtn = menuPanel.querySelector('[data-act="monitoring"]') ||
                   menuPanel.querySelector('[data-act="krx-v4"]') ||
                   menuPanel.querySelector('[data-act="krx"]');
    if (!refBtn) return false;
    
    const cloudBtn = refBtn.cloneNode(true);
    cloudBtn.setAttribute('data-act', 'cloud-sync');
    cloudBtn.innerHTML = refBtn.innerHTML
      .replace(/모니터링/g, '클라우드')
      .replace(/KRX 박스/g, '클라우드')
      .replace(/📊/g, '☁️')
      .replace(/KR/g, '☁️')
      .replace(/🇰🇷/g, '☁️');
    
    const dots = cloudBtn.querySelectorAll('[class*="dot"], [style*="border-radius: 50%"], [style*="border-radius:50%"]');
    dots.forEach(d => d.remove());
    
    refBtn.parentNode.insertBefore(cloudBtn, refBtn.nextSibling);
    
    if (!menuPanel.__cloud_intercept) {
      menuPanel.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act="cloud-sync"]');
        if (btn) {
          e.stopImmediatePropagation();
          e.stopPropagation();
          e.preventDefault();
          openModal();
        }
      }, true);
      menuPanel.__cloud_intercept = true;
    }
    return true;
  }
  
  // ===== 10. 자동 Push 후킹 =====
  function hookAutoPush() {
    if (window.Phase6?.B?.run && !window.Phase6.B.__p12_hooked) {
      const orig = window.Phase6.B.run;
      window.Phase6.B.run = async function(...args) {
        const r = await orig.apply(this, args);
        scheduleAutoPush();
        return r;
      };
      window.Phase6.B.__p12_hooked = true;
    }
    if (window.__phase7?.run && !window.__phase7.__p12_hooked) {
      const orig = window.__phase7.run;
      window.__phase7.run = async function(...args) {
        const r = await orig.apply(this, args);
        scheduleAutoPush();
        return r;
      };
      window.__phase7.__p12_hooked = true;
    }
  }
  
  // ===== 11. 전역 노출 =====
  window.__phase12 = {
    version: '1.0',
    auth, db, state,
    push, pull, fullSync,
    signIn, signOut,
    openModal, closeModal,
    injectMenuButton,
    scheduleAutoPush,
    cleanup() {
      closeModal();
      ['phase12-modal', 'phase12-overlay'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.remove();
      });
      const b = document.querySelector('[data-act="cloud-sync"]');
      if (b) b.remove();
    }
  };
  
  // ===== 12. 초기화 (지연 실행) =====
  setTimeout(() => { injectMenuButton(); hookAutoPush(); }, 2000);
  setTimeout(() => { injectMenuButton(); hookAutoPush(); }, 5000);
  
  console.log('🎉 Phase 12 v1.0 준비 완료');
})().catch(err => console.error('❌ Phase 12 설치 실패:', err));
