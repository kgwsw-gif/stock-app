// phase16-ticker-integration.js v0.1.0
// 종목별 정보 노트 통합 - TOP 종목 클릭 → 종목 전용 모달
(function() {
  'use strict';
  const VERSION =  '0.2.0'
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

  // ===== 채널/분석가 클릭 이벤트 부착 =====
function attachChannelAnalystClicks() {
  const statsModal = document.getElementById('p16-stats-modal');
  if (!statsModal) return;
  
  // 채널별 적중률 섹션
  const channelSection = Array.from(statsModal.querySelectorAll('h3')).find(h =>
    h.textContent?.includes('채널별 적중률')
  )?.parentElement;
  
  if (channelSection && channelSection.dataset.p16ChannelDelegationAttached !== '1') {
    channelSection.dataset.p16ChannelDelegationAttached = '1';
    channelSection.addEventListener('click', e => {
      let t = e.target;
      while (t && t !== channelSection) {
        const txt = (t.textContent || '').trim();
        // 채널명 패턴: "815머니톡" 으로 시작하고 "n/m (xx%)" 형식 포함
        const m = txt.match(/^([^\d\n]+?)\s*\d+\/\d+\s*\(\d+%\)/);
        if (m && txt.length < 100 && !/적중률|TOP/.test(txt)) {
          e.preventDefault(); e.stopPropagation();
          openChannelModal(m[1].trim());
          return;
        }
        t = t.parentElement;
      }
    }, true);
  }
  
  // 채널 행에 cursor:pointer
  channelSection?.querySelectorAll('div').forEach(d => {
    if (d.dataset.p16ChannelCursor === '1') return;
    const txt = (d.textContent || '').trim();
    if (/^[^\d\n]+?\s*\d+\/\d+\s*\(\d+%\)/.test(txt) && txt.length < 100 && !/적중률|TOP/.test(txt)) {
      d.style.cursor = 'pointer';
      d.style.transition = '0.15s';
      d.dataset.p16ChannelCursor = '1';
      d.addEventListener('mouseenter', () => d.style.background = '#f3f4f6');
      d.addEventListener('mouseleave', () => d.style.background = '');
    }
  });
  
  // 애널리스트별 적중률 섹션
  const analystSection = Array.from(statsModal.querySelectorAll('h3')).find(h =>
    h.textContent?.includes('애널리스트별 적중률')
  )?.parentElement;
  
  if (analystSection && analystSection.dataset.p16AnalystDelegationAttached !== '1') {
    analystSection.dataset.p16AnalystDelegationAttached = '1';
    analystSection.addEventListener('click', e => {
      let t = e.target;
      while (t && t !== analystSection) {
        const txt = (t.textContent || '').trim();
        // 분석가 패턴: "김선우 | 메리츠증권" 형식
        const m = txt.match(/^([^|]+?)\s*\|\s*([^\d\n]+?)\s*\d+\/\d+/);
        if (m && txt.length < 100) {
          e.preventDefault(); e.stopPropagation();
          openAnalystModal(m[1].trim(), m[2].trim());
          return;
        }
        t = t.parentElement;
      }
    }, true);
  }
  
  // 분석가 행에 cursor:pointer
  analystSection?.querySelectorAll('div').forEach(d => {
    if (d.dataset.p16AnalystCursor === '1') return;
    const txt = (d.textContent || '').trim();
    if (/^[^|]+?\s*\|\s*[^\d\n]+?\s*\d+\/\d+/.test(txt) && txt.length < 100) {
      d.style.cursor = 'pointer';
      d.style.transition = '0.15s';
      d.dataset.p16AnalystCursor = '1';
      d.addEventListener('mouseenter', () => d.style.background = '#f3f4f6');
      d.addEventListener('mouseleave', () => d.style.background = '');
    }
  });
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

    // ===== TOP 종목 클릭 이벤트 부착 (이벤트 위임 방식) =====
  function attachTopTickerClicks() {
    const statsModal = document.getElementById('p16-stats-modal');
    if (!statsModal) return;
    
    const topSection = Array.from(statsModal.querySelectorAll('h3')).find(h =>
      h.textContent?.includes('가장 많이 언급된')
    )?.parentElement;
    
    if (!topSection) return;
    
    // 이벤트 위임 부착 (한 번만)
    if (topSection.dataset.p16DelegationAttached !== '1') {
      topSection.dataset.p16DelegationAttached = '1';
      
      // capture 단계로 등록 → 다른 핸들러보다 먼저 실행
      topSection.addEventListener('click', (e) => {
        let target = e.target;
        while (target && target !== topSection) {
          const txt = target.textContent || '';
          const match = txt.match(/^([^(]+?)\s*\((\d{6})\)/);
          if (match && txt.length < 100) {
            const name = match[1].trim();
            const code = match[2];
            e.preventDefault();
            e.stopPropagation();
            openTickerModal(code, name);
            return;
          }
          target = target.parentElement;
        }
      }, true);
    }
    
    // 시각적 힌트: 코드 행에 커서 스타일 적용
    const allDivs = Array.from(topSection.querySelectorAll('div'));
    allDivs.forEach(d => {
      if (d.dataset.p16CursorApplied === '1') return;
      const txt = d.textContent || '';
      if (/\(\d{6}\)/.test(txt) && txt.length < 100) {
        d.style.cursor = 'pointer';
        d.style.transition = '0.15s';
        d.dataset.p16CursorApplied = '1';
        d.addEventListener('mouseenter', () => d.style.background = '#f3f4f6');
        d.addEventListener('mouseleave', () => d.style.background = '');
      }
    });
  }

  // ===== 자동 감지 =====
  setInterval(() => {
  if (document.getElementById('p16-stats-modal')) {
    attachTopTickerClicks();
    attachChannelAnalystClicks();  // C-2 추가
  }
}, 1500);

  window.__phase16Ticker = {
  version: VERSION,
  openTicker: openTickerModal,
  openChannel: openChannelModal,    // C-2 추가
  openAnalyst: openAnalystModal,    // C-2 추가
  getTickerData,
  getChannelData,
  getAnalystData
};
  
  console.log(`[phase16-ticker-integration ${VERSION}] ✅ 로드됨`);
})();
