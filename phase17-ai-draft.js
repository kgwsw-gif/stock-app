/* phase17-ai-draft.js — AI 인사이트 초안 생성 워크플로 v0.1.0
 * 동작: 유튜브 자막 또는 리포트 텍스트 → AI 프롬프트 생성 → JSON 응답 파싱 → 인사이트 등록
 * 의존성: phase16 IndexedDB (StockJournalInsightsDB)
 */
(function(){
  'use strict';
  const VERSION = '0.1.2';
  const DB_NAME = 'StockJournalInsightsDB';
  const MODAL_ID = 'p17-ai-draft-modal';
  const MENU_BTN_ID = 'p17-menu-ai-draft';

  // ===== 외부 자막 추출 사이트 목록 =====
  const TRANSCRIPT_SITES = [
    { name: 'youtubetranscript.com', url: 'https://youtubetranscript.com/' },
    { name: 'tactiq.io', url: 'https://tactiq.io/tools/youtube-transcript' },
    { name: 'notegpt.io', url: 'https://notegpt.io/youtube-transcript-generator' },
  ];

  // ===== IndexedDB 헬퍼 =====
  function openDB(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveVideoInsight(data){
    const db = await openDB();
    const tx = db.transaction(['video_insights','youtube_channels'], 'readwrite');
    const id = 'vid_' + Date.now();
    const now = new Date().toISOString();
    const record = {
      id, channelName: data.channelName, videoTitle: data.videoTitle,
      videoUrl: data.sourceUrl || '', ticker: data.ticker, stockName: data.stockName,
      opinion: data.opinion, targetPrice: data.targetPrice, basePrice: data.basePrice,
      tone: data.tone, summary: data.summary,
      watchedAt: now, createdAt: now,
      evaluation: { status: 'pending' },
      aiDraft: true, keyPoints: data.keyPoints || []
    };
    tx.objectStore('video_insights').put(record);
    // 채널 자동 등록
    const chStore = tx.objectStore('youtube_channels');
    const chId = 'ch_' + data.channelName.replace(/\s+/g,'_').toLowerCase();
    chStore.put({ id: chId, name: data.channelName, type: 'youtube', createdAt: now });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
    return id;
  }

  async function saveReportInsight(data){
    const db = await openDB();
    const tx = db.transaction('analyst_reports', 'readwrite');
    const id = 'rpt_' + Date.now();
    const now = new Date().toISOString();
    const record = {
      id, brokerage: data.brokerage, analyst: data.analyst,
      analystTitle: data.analystTitle || '',
      reportTitle: data.reportTitle, ticker: data.ticker, stockName: data.stockName,
      opinion: data.opinion, targetPrice: data.targetPrice, basePrice: data.basePrice,
      tone: data.tone, summary: data.summary,
      reportDate: now.split('T')[0], createdAt: now,
      evaluation: { status: 'pending' },
      aiDraft: true, keyPoints: data.keyPoints || []
    };
    tx.objectStore('analyst_reports').put(record);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
    return id;
  }

  // ===== 프롬프트 생성기 =====
  function buildPrompt(type, meta, content){
    const header = type === 'video'
      ? `다음은 한국 주식 유튜브 영상의 자막입니다.\n채널명: ${meta.channelName || '(미입력)'}\n영상 제목: ${meta.title || '(미입력)'}`
      : `다음은 증권사 애널리스트 리포트입니다.\n증권사: ${meta.brokerage || '(미입력)'}\n분석가: ${meta.analyst || '(미입력)'}\n리포트 제목: ${meta.title || '(미입력)'}`;

    return `${header}

본 내용에서 다루는 한국 주식 종목과 투자 의견을 정확히 분석해서, 아래 JSON 형식으로만 응답해주세요. 추가 설명·인사말·코드블록 없이 순수 JSON만 출력하세요.

내용:
"""
${content}
"""

응답 형식 (JSON only):
{
  "stocks": [
    {
      "stockName": "정확한 종목명 (예: 삼성전자)",
      "ticker": "6자리 종목코드 (예: 005930). 모르면 빈 문자열",
      "opinion": "매수|중립|매도 중 택1 (리포트면 BUY|HOLD|SELL)",
      "targetPrice": 목표가_숫자_only_원단위,
      "basePrice": 현재가_또는_매수가_숫자_only,
      "tone": "positive|neutral|negative",
      "summary": "투자 논리 한 문장 요약 (50자 이내)",
      "keyPoints": ["핵심 근거 1", "핵심 근거 2", "핵심 근거 3"]
    }
  ],
  "confidence": "high|medium|low",
  "warning": "주의사항 (없으면 빈 문자열)"
}

규칙:
- 종목이 여러 개면 stocks 배열에 모두 포함
- 목표가/현재가가 명시되지 않으면 0
- 매수/매도 의견이 불분명하면 "중립"
- 한국 종목 우선, 미국·해외 종목은 ticker를 빈 문자열로`;
  }

  // ===== JSON 파싱 (관대한 모드) =====
  function tryParseJSON(text){
    if(!text || !text.trim()) return null;
    let s = text.trim();
    // 코드블록 제거
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/,'').trim();
    // 첫 { 부터 마지막 } 까지
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if(first >= 0 && last > first) s = s.slice(first, last + 1);
    try { return JSON.parse(s); }
    catch(e){
      console.warn('[Phase17] JSON 파싱 실패:', e.message);
      return null;
    }
  }

  // ===== 모달 UI =====
  function openDraftModal(){
    const existing = document.getElementById(MODAL_ID);
    if(existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:12px;';

    overlay.innerHTML = `
      <div style="background:white;border-radius:16px;max-width:720px;width:100%;max-height:92vh;overflow-y:auto;box-shadow:0 25px 60px rgba(0,0,0,0.3);">
        <div style="padding:16px 20px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:white;z-index:1;">
          <h2 style="margin:0;font-size:18px;font-weight:700;color:#111827;">🤖 AI 인사이트 초안 생성 <span style="font-size:11px;color:#9ca3af;font-weight:400;">v${VERSION}</span></h2>
          <button id="p17-close" style="background:#f3f4f6;border:none;border-radius:8px;width:32px;height:32px;font-size:18px;cursor:pointer;">×</button>
        </div>

        <div style="padding:20px;">
          <!-- 타입 선택 -->
          <div style="display:flex;gap:8px;margin-bottom:20px;">
            <button class="p17-type-btn" data-type="video" style="flex:1;padding:12px;border-radius:10px;border:2px solid #3b82f6;background:#eff6ff;color:#1d4ed8;font-weight:600;cursor:pointer;">🎥 유튜브 영상</button>
            <button class="p17-type-btn" data-type="report" style="flex:1;padding:12px;border-radius:10px;border:2px solid #e5e7eb;background:white;color:#6b7280;font-weight:600;cursor:pointer;">📑 리포트</button>
          </div>

          <!-- 1단계: 메타 정보 -->
          <div style="background:#f9fafb;border-radius:12px;padding:16px;margin-bottom:16px;">
            <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:10px;">1️⃣ 메타 정보</div>
            <div id="p17-meta-fields"></div>
          </div>

          <!-- 2단계: 자막/본문 수집 -->
          <div style="background:#f9fafb;border-radius:12px;padding:16px;margin-bottom:16px;">
            <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:10px;">2️⃣ 자막 / 본문 텍스트</div>
            <div id="p17-transcript-helper" style="margin-bottom:10px;">
              <div style="font-size:12px;color:#6b7280;margin-bottom:6px;">유튜브 자막 추출 도우미 (새 탭으로 열기):</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                ${TRANSCRIPT_SITES.map(s => `<a href="${s.url}" target="_blank" rel="noopener" style="font-size:12px;padding:6px 10px;background:#dbeafe;color:#1d4ed8;border-radius:6px;text-decoration:none;">🔗 ${s.name}</a>`).join('')}
              </div>
            </div>
            <textarea id="p17-content" placeholder="자막 텍스트 또는 리포트 본문을 붙여넣으세요..." style="width:100%;min-height:140px;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;font-family:inherit;resize:vertical;"></textarea>
            <div style="font-size:11px;color:#9ca3af;margin-top:4px;">💡 팁: 영상 자막은 최소 300자 이상이면 분석 정확도가 높아집니다.</div>
          </div>

          <!-- 3단계: AI 프롬프트 생성 -->
          <div style="background:#fef3c7;border-radius:12px;padding:16px;margin-bottom:16px;">
            <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:10px;">3️⃣ AI 프롬프트 생성 & 복사</div>
            <button id="p17-gen-prompt" style="width:100%;padding:12px;background:#f59e0b;color:white;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:14px;">🪄 프롬프트 생성 + 클립보드 복사</button>
            <div style="display:flex;gap:6px;margin-top:8px;">
              <a href="https://chatgpt.com" target="_blank" rel="noopener" style="flex:1;text-align:center;font-size:12px;padding:8px;background:#10a37f;color:white;border-radius:6px;text-decoration:none;font-weight:600;">ChatGPT 열기</a>
              <a href="https://claude.ai" target="_blank" rel="noopener" style="flex:1;text-align:center;font-size:12px;padding:8px;background:#d97706;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Claude 열기</a>
              <a href="https://gemini.google.com" target="_blank" rel="noopener" style="flex:1;text-align:center;font-size:12px;padding:8px;background:#4285f4;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Gemini 열기</a>
            </div>
          </div>

          <!-- 4단계: JSON 응답 -->
          <div style="background:#ecfdf5;border-radius:12px;padding:16px;margin-bottom:16px;">
            <div style="font-size:13px;font-weight:700;color:#065f46;margin-bottom:10px;">4️⃣ AI 응답(JSON) 붙여넣기</div>
            <textarea id="p17-json-response" placeholder='{"stocks":[...], "confidence":"high"}' style="width:100%;min-height:120px;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;font-family:monospace;resize:vertical;"></textarea>
            <button id="p17-parse" style="width:100%;margin-top:8px;padding:10px;background:#10b981;color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer;">✅ 파싱 후 미리보기</button>
          </div>

          <!-- 5단계: 미리보기 -->
          <div id="p17-preview" style="display:none;background:#eff6ff;border-radius:12px;padding:16px;margin-bottom:16px;"></div>

          <!-- 상태 메시지 -->
          <div id="p17-status" style="font-size:13px;color:#6b7280;text-align:center;padding:8px;"></div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // 상태 변수
    let currentType = 'video';
    let parsedData = null;

    // 메타 필드 렌더링
    function renderMetaFields(){
      const container = overlay.querySelector('#p17-meta-fields');
      const inputStyle = 'width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:8px;';
      if(currentType === 'video'){
        container.innerHTML = `
          <input id="p17-meta-channel" placeholder="채널명 (예: 815머니톡)" style="${inputStyle}">
          <input id="p17-meta-title" placeholder="영상 제목" style="${inputStyle}">
          <input id="p17-meta-url" placeholder="영상 URL (선택)" style="${inputStyle}">
        `;
      } else {
        container.innerHTML = `
          <input id="p17-meta-brokerage" placeholder="증권사 (예: 키움증권)" style="${inputStyle}">
          <input id="p17-meta-analyst" placeholder="분석가 이름 (예: 김장열)" style="${inputStyle}">
          <input id="p17-meta-analyst-title" placeholder="직책 (예: 센터장)" style="${inputStyle}">
          <input id="p17-meta-title" placeholder="리포트 제목" style="${inputStyle}">
        `;
      }
    }
    renderMetaFields();

    function getMeta(){
      if(currentType === 'video'){
        return {
          channelName: (overlay.querySelector('#p17-meta-channel')?.value || '').trim(),
          title: (overlay.querySelector('#p17-meta-title')?.value || '').trim(),
          sourceUrl: (overlay.querySelector('#p17-meta-url')?.value || '').trim(),
        };
      }
      return {
        brokerage: (overlay.querySelector('#p17-meta-brokerage')?.value || '').trim(),
        analyst: (overlay.querySelector('#p17-meta-analyst')?.value || '').trim(),
        analystTitle: (overlay.querySelector('#p17-meta-analyst-title')?.value || '').trim(),
        title: (overlay.querySelector('#p17-meta-title')?.value || '').trim(),
      };
    }

    function setStatus(msg, color){
      const el = overlay.querySelector('#p17-status');
      el.textContent = msg;
      el.style.color = color || '#6b7280';
    }

    // 타입 버튼
    overlay.querySelectorAll('.p17-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentType = btn.dataset.type;
        overlay.querySelectorAll('.p17-type-btn').forEach(b => {
          if(b.dataset.type === currentType){
            b.style.cssText = 'flex:1;padding:12px;border-radius:10px;border:2px solid #3b82f6;background:#eff6ff;color:#1d4ed8;font-weight:600;cursor:pointer;';
          } else {
            b.style.cssText = 'flex:1;padding:12px;border-radius:10px;border:2px solid #e5e7eb;background:white;color:#6b7280;font-weight:600;cursor:pointer;';
          }
        });
        renderMetaFields();
        overlay.querySelector('#p17-preview').style.display = 'none';
        parsedData = null;
      });
    });

    // 닫기
    overlay.querySelector('#p17-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.remove(); });

    // 프롬프트 생성
        overlay.querySelector('#p17-gen-prompt').addEventListener('click', async () => {
      const content = overlay.querySelector('#p17-content').value.trim();
      if(!content || content.length < 50){
        setStatus('⚠️ 자막/본문을 50자 이상 입력해주세요. (현재 ' + content.length + '자)', '#dc2626');
        return;
      }
      const meta = getMeta();
      const prompt = buildPrompt(currentType, meta, content);

      // 3중 안전장치: clipboard API → execCommand → 수동 복사 UI
      let copied = false;
      let errorMsg = '';

      // 시도 1: 모던 Clipboard API
      try {
        if(navigator.clipboard?.writeText && window.isSecureContext){
          await navigator.clipboard.writeText(prompt);
          copied = true;
        }
      } catch(e){
        errorMsg = 'Clipboard API: ' + e.message;
        console.warn('[Phase17] Clipboard API 실패:', e);
      }

      // 시도 2: 레거시 execCommand
      if(!copied){
        try {
          const ta = document.createElement('textarea');
          ta.value = prompt;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          ta.setSelectionRange(0, prompt.length);
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          if(ok) copied = true;
          else errorMsg += ' | execCommand 반환 false';
        } catch(e){
          errorMsg += ' | execCommand: ' + e.message;
          console.warn('[Phase17] execCommand 실패:', e);
        }
      }

      // 시도 3 (폴백): 프롬프트 textarea를 모달에 직접 표시 + 사용자가 수동 복사
      // 항상 표시함 → 사용자가 결과를 검증 가능
      showManualCopyArea(prompt, copied, errorMsg);

      if(copied){
        setStatus('✅ 프롬프트 복사 완료! 아래 ChatGPT/Claude 버튼 클릭 후 붙여넣으세요.', '#059669');
      } else {
        setStatus('⚠️ 자동 복사 실패. 아래 박스의 텍스트를 직접 선택해서 복사하세요.', '#d97706');
      }
    });

    // 수동 복사용 영역 표시 함수
    function showManualCopyArea(prompt, autoCopied, errorMsg){
      let area = overlay.querySelector('#p17-manual-copy-area');
      if(!area){
        area = document.createElement('div');
        area.id = 'p17-manual-copy-area';
        area.style.cssText = 'margin-top:10px;padding:10px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:8px;';
        const promptBox = overlay.querySelector('#p17-gen-prompt').parentElement;
        promptBox.appendChild(area);
      }
      const statusLabel = autoCopied 
        ? '<span style="color:#059669;font-weight:700;">✅ 자동 복사됨</span> · 확인용 (수동 복사도 가능)'
        : '<span style="color:#dc2626;font-weight:700;">❌ 자동 복사 실패</span> · 아래 텍스트를 전체 선택(Ctrl+A) 후 복사(Ctrl+C)하세요';
      area.innerHTML = `
        <div style="font-size:11px;color:#92400e;margin-bottom:6px;">${statusLabel}</div>
        <textarea readonly style="width:100%;height:120px;font-family:monospace;font-size:11px;padding:8px;border:1px solid #d1d5db;border-radius:6px;background:white;resize:vertical;">${prompt.replace(/</g,'&lt;')}</textarea>
        <button id="p17-manual-copy-btn" style="margin-top:6px;width:100%;padding:8px;background:#f59e0b;color:white;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;">📋 위 텍스트 전체 선택</button>
      `;
      // 텍스트 자동 전체 선택
      const ta = area.querySelector('textarea');
      const selectBtn = area.querySelector('#p17-manual-copy-btn');
      selectBtn.addEventListener('click', () => {
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
      });
      // 자동 복사 실패 시 즉시 텍스트 선택
      if(!autoCopied){
        setTimeout(() => { ta.focus(); ta.select(); }, 100);
      }
    }

    // JSON 파싱
    overlay.querySelector('#p17-parse').addEventListener('click', () => {
      const raw = overlay.querySelector('#p17-json-response').value;
      const data = tryParseJSON(raw);
      if(!data || !Array.isArray(data.stocks) || data.stocks.length === 0){
        setStatus('❌ JSON 파싱 실패. stocks 배열이 비어있거나 형식이 잘못되었습니다.', '#dc2626');
        return;
      }
      parsedData = data;
      renderPreview(data);
      setStatus(`✅ ${data.stocks.length}개 종목 파싱 완료. 신뢰도: ${data.confidence || 'N/A'}`, '#059669');
    });

    // 미리보기 렌더링
    function renderPreview(data){
      const preview = overlay.querySelector('#p17-preview');
      const meta = getMeta();
      const warning = data.warning ? `<div style="background:#fef2f2;color:#991b1b;padding:8px;border-radius:6px;font-size:12px;margin-bottom:10px;">⚠️ ${data.warning}</div>` : '';
      const stocksHtml = data.stocks.map((s, i) => {
        const toneColor = s.tone === 'positive' ? '#10b981' : (s.tone === 'negative' ? '#ef4444' : '#6b7280');
        const upside = (s.basePrice && s.targetPrice && s.basePrice > 0)
          ? `${(((s.targetPrice - s.basePrice) / s.basePrice) * 100).toFixed(1)}%`
          : '-';
        const keyPointsHtml = (s.keyPoints || []).map(kp => `<li style="margin-bottom:2px;">${kp}</li>`).join('');
        return `
          <div style="background:white;border-radius:8px;padding:12px;margin-bottom:8px;border-left:4px solid ${toneColor};">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <div style="font-weight:700;font-size:14px;">${s.stockName} <span style="font-size:11px;color:#9ca3af;">${s.ticker || '(코드없음)'}</span></div>
              <div style="font-size:11px;color:${toneColor};font-weight:700;">${s.opinion} · 상승여력 ${upside}</div>
            </div>
            <div style="font-size:12px;color:#374151;margin-bottom:6px;">💡 ${s.summary || ''}</div>
            <div style="font-size:11px;color:#6b7280;display:flex;gap:10px;margin-bottom:6px;">
              <span>현재가: ${(s.basePrice || 0).toLocaleString()}</span>
              <span>목표가: ${(s.targetPrice || 0).toLocaleString()}</span>
            </div>
            ${keyPointsHtml ? `<ul style="font-size:11px;color:#4b5563;padding-left:18px;margin:4px 0;">${keyPointsHtml}</ul>` : ''}
            <button class="p17-register-btn" data-idx="${i}" style="margin-top:6px;width:100%;padding:8px;background:#3b82f6;color:white;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;">💾 이 종목 인사이트 등록</button>
          </div>
        `;
      }).join('');

      preview.innerHTML = `
        <div style="font-size:13px;font-weight:700;color:#1e40af;margin-bottom:10px;">5️⃣ 추출 결과 미리보기 (${data.stocks.length}개 종목)</div>
        ${warning}
        ${stocksHtml}
        <button id="p17-register-all" style="width:100%;margin-top:8px;padding:12px;background:#1d4ed8;color:white;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:14px;">📦 전체 ${data.stocks.length}개 일괄 등록</button>
      `;
      preview.style.display = 'block';

      // 개별 등록
      preview.querySelectorAll('.p17-register-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const idx = parseInt(btn.dataset.idx);
          await registerStock(data.stocks[idx], meta);
          btn.textContent = '✅ 등록 완료';
          btn.style.background = '#9ca3af';
          btn.disabled = true;
        });
      });

      // 일괄 등록
      preview.querySelector('#p17-register-all').addEventListener('click', async () => {
        let success = 0;
        for(const stock of data.stocks){
          try { await registerStock(stock, meta); success++; }
          catch(e){ console.error('[Phase17] 등록 실패:', e); }
        }
        setStatus(`✅ 일괄 등록 완료: ${success}/${data.stocks.length}건`, '#059669');
        // phase16 통계 자동 갱신
        try { window.__phase16Notif?.updateMenuBadge?.(); } catch(_){}
      });
    }

    async function registerStock(stock, meta){
      if(currentType === 'video'){
        if(!meta.channelName){ alert('채널명을 입력해주세요.'); throw new Error('no channel'); }
        return saveVideoInsight({
          channelName: meta.channelName,
          videoTitle: meta.title || '(제목 없음)',
          sourceUrl: meta.sourceUrl,
          ticker: stock.ticker || '',
          stockName: stock.stockName,
          opinion: stock.opinion,
          targetPrice: Number(stock.targetPrice) || 0,
          basePrice: Number(stock.basePrice) || 0,
          tone: stock.tone || 'neutral',
          summary: stock.summary || '',
          keyPoints: stock.keyPoints || []
        });
      } else {
        if(!meta.brokerage || !meta.analyst){ alert('증권사와 분석가를 입력해주세요.'); throw new Error('no analyst'); }
        return saveReportInsight({
          brokerage: meta.brokerage,
          analyst: meta.analyst,
          analystTitle: meta.analystTitle,
          reportTitle: meta.title || '(제목 없음)',
          ticker: stock.ticker || '',
          stockName: stock.stockName,
          opinion: stock.opinion,
          targetPrice: Number(stock.targetPrice) || 0,
          basePrice: Number(stock.basePrice) || 0,
          tone: stock.tone || 'neutral',
          summary: stock.summary || '',
          keyPoints: stock.keyPoints || []
        });
      }
    }
  }

  // ===== 메뉴 버튼 주입 =====
  let menuInjectFlag = false;
    function injectMenuButton(){
    if(document.getElementById(MENU_BTN_ID)) return true;

    // phase16 기존 버튼을 앵커로 사용해서 같은 그리드를 찾음
    const anchor = document.getElementById('p16-menu-stats')
                || document.getElementById('p16-menu-channels')
                || document.getElementById('p16-menu-info-note');
    if(!anchor) return false;

    const menuGrid = anchor.parentElement;
    if(!menuGrid) return false;

    // 이미 같은 그리드에 추가되었는지 재확인
    if(menuGrid.querySelector('#' + MENU_BTN_ID)) return true;

    // 앵커 버튼의 스타일·클래스를 그대로 복제하여 UI 일관성 유지
    const btn = anchor.cloneNode(false); // 자식 없이 복제
    btn.id = MENU_BTN_ID;
    btn.dataset.fn = 'p17OpenDraftModal';
    btn.removeAttribute('onclick');
    btn.innerHTML = anchor.innerHTML
      ? anchor.innerHTML.replace(/[^<]*$/, '') // 기존 텍스트 제거 시도
      : '';
    // 안전하게 라벨 직접 설정
    btn.textContent = '';
    btn.innerHTML = '🤖<br><span style="font-size:12px;">AI 초안</span>';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openDraftModal();
    }, true);

    menuGrid.appendChild(btn);
    console.log('[Phase17] 메뉴 버튼 주입 완료 (앵커: #' + anchor.id + ')');
    return true;
  }

  // 메뉴 모달이 열릴 때마다 버튼 존재 확인
    setInterval(() => {
    // 메뉴가 열려있을 때만 phase16 버튼이 DOM에 존재함
    if(document.getElementById('p16-menu-stats')){
      injectMenuButton();
    }
  }, 1200);

  // ===== 전역 노출 =====
  window.p17OpenDraftModal = openDraftModal;
  window.__phase17AIDraft = {
    version: VERSION,
    open: openDraftModal,
    buildPrompt,
    tryParseJSON,
    saveVideoInsight,
    saveReportInsight
  };

  console.log(`[Phase17] AI Draft v${VERSION} 로드 완료. window.p17OpenDraftModal() 호출 가능.`);
})();
