// phase16-ticker-integration.js v0.1.0
// 종목별 정보 노트 통합 - TOP 종목 클릭 → 종목 전용 모달
(function() {
  'use strict';
  const VERSION = '0.1.0';

  // ===== 종목 데이터 조회 =====
  async function getTickerData(code) {
    const allVideos = await window.__phase16.getAllVideos();
    const allReports = await window.__phase16.getAllReports();
    
    const videos = allVideos.filter(v => {
      const tickers = v.tickers || [];
      return tickers.some(t => t.code === code);
    });
    
    const reports = allReports.filter(r => r.ticker === code);
    
    return { videos, reports, code };
  }

  // ===== 종목 모달 열기 =====
  async function openTickerModal(code, name) {
    const data = await getTickerData(code);
    
    // 기존 모달 제거
    document.getElementById('p16-ticker-modal')?.remove();
    
    const modal = document.createElement('div');
    modal.id = 'p16-ticker-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:100010;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
    
    modal.innerHTML = `
      <div style="background:white;border-radius:12px;padding:20px;max-width:600px;width:100%;max-height:80vh;overflow-y:auto;box-shadow:0 8px 30px rgba(0,0,0,0.2);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <h2 style="margin:0;font-size:18px;font-weight:bold;color:#1f2937;">🏷️ ${name || code}</h2>
          <button id="p16-ticker-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:#6b7280;">×</button>
        </div>
        <div style="font-size:13px;color:#6b7280;margin-bottom:16px;">종목 코드: ${code}</div>
        
        <div style="background:#f3f4f6;border-radius:8px;padding:12px;margin-bottom:16px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <div style="font-size:11px;color:#6b7280;">📺 관련 영상</div>
            <div style="font-size:20px;font-weight:bold;color:#1f2937;">${data.videos.length}건</div>
          </div>
          <div>
            <div style="font-size:11px;color:#6b7280;">📄 관련 리포트</div>
            <div style="font-size:20px;font-weight:bold;color:#1f2937;">${data.reports.length}건</div>
          </div>
        </div>
        
        ${data.videos.length > 0 ? `
        <h3 style="font-size:14px;font-weight:bold;color:#374151;margin:16px 0 8px 0;">📺 영상 (${data.videos.length})</h3>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${data.videos.map(v => renderVideoCard(v, code)).join('')}
        </div>
        ` : ''}
        
        ${data.reports.length > 0 ? `
        <h3 style="font-size:14px;font-weight:bold;color:#374151;margin:16px 0 8px 0;">📄 리포트 (${data.reports.length})</h3>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${data.reports.map(r => renderReportCard(r)).join('')}
        </div>
        ` : ''}
        
        ${data.videos.length === 0 && data.reports.length === 0 ? `
        <div style="text-align:center;padding:30px;color:#9ca3af;font-size:14px;">
          이 종목에 대한 정보 노트가 없습니다.
        </div>
        ` : ''}
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // 닫기 이벤트
    document.getElementById('p16-ticker-close').onclick = () => modal.remove();
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
  }

  function renderVideoCard(v, code) {
    const ticker = v.tickers?.find(t => t.code === code);
    const tone = ticker?.tone || v.overallTone || '-';
    const toneColor = {'강세':'#16a34a','약세':'#dc2626','중립':'#6b7280'}[tone] || '#6b7280';
    
    return `
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px;">
        <div style="font-size:13px;font-weight:600;color:#1f2937;margin-bottom:4px;">${escape(v.videoTitle || '(제목 없음)')}</div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">📺 ${escape(v.channelName || '-')}</div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span style="background:${toneColor};color:white;font-size:10px;padding:2px 8px;border-radius:10px;">${tone}</span>
          ${ticker?.toneHit ? `<span style="font-size:11px;color:${ticker.toneHit==='적중'?'#16a34a':'#dc2626'};">${ticker.toneHit}</span>` : ''}
        </div>
      </div>
    `;
  }

  function renderReportCard(r) {
    const ratingColor = {'매수':'#16a34a','매도':'#dc2626','중립':'#6b7280','보유':'#f59e0b'}[r.rating] || '#6b7280';
    
    return `
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px;">
        <div style="font-size:13px;font-weight:600;color:#1f2937;margin-bottom:4px;">${escape(r.analyst || '-')} | ${escape(r.firm || '-')}</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <span style="background:${ratingColor};color:white;font-size:10px;padding:2px 8px;border-radius:10px;">${r.rating || '-'}</span>
          ${r.targetPrice ? `<span style="font-size:11px;color:#6b7280;">목표가 ${r.targetPrice.toLocaleString()}원</span>` : ''}
        </div>
      </div>
    `;
  }

  function escape(s) {
    return String(s || '').replace(/[<>&"']/g, c => ({
      '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ===== TOP 종목 클릭 이벤트 부착 =====
  function attachTopTickerClicks() {
    const statsModal = document.getElementById('p16-stats-modal');
    if (!statsModal) return;
    
    const topSection = Array.from(statsModal.querySelectorAll('h3')).find(h =>
      h.textContent?.includes('가장 많이 언급된')
    )?.parentElement;
    
    if (!topSection) return;
    
    // 종목 행들 찾기 (코드 포함)
    const rows = topSection.querySelectorAll('div');
    rows.forEach(row => {
      if (row.dataset.p16TickerAttached === '1') return;
      const txt = row.textContent || '';
      const match = txt.match(/^(.+?)\s*\((\d{6})\)/);
      if (!match) return;
      
      // 직접 코드를 가진 행만 처리 (자식 div는 제외)
      const childWithCode = Array.from(row.children).find(c => 
        /\(\d{6}\)/.test(c.textContent || '')
      );
      if (childWithCode) return; // 부모 행은 스킵
      
      const name = match[1].trim();
      const code = match[2];
      
      row.style.cursor = 'pointer';
      row.style.transition = '0.15s';
      row.dataset.p16TickerAttached = '1';
      
      row.onmouseenter = () => row.style.background = '#f3f4f6';
      row.onmouseleave = () => row.style.background = '';
      row.onclick = () => openTickerModal(code, name);
    });
  }

  // ===== 자동 감지 =====
  setInterval(() => {
    if (document.getElementById('p16-stats-modal')) {
      attachTopTickerClicks();
    }
  }, 1500);

  window.__phase16Ticker = {
    version: VERSION,
    openTicker: openTickerModal,
    getTickerData
  };
  
  console.log(`[phase16-ticker-integration ${VERSION}] ✅ 로드됨`);
})();
