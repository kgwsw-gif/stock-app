// phase16-stats.js - 통계 대시보드 v0.1.0
(function() {
  const VERSION = '0.1.1';
  const PERIODS = [
    { key: '1m', label: '1개월', days: 30 },
    { key: '3m', label: '3개월', days: 90 },
    { key: '6m', label: '6개월', days: 180 }
  ];
  const TONE_THRESHOLD = 5;

  // ─────────────────────────────────────────────
  // 의존성 대기
  // ─────────────────────────────────────────────
  function waitForDeps(maxWait = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.__phase16?.getAllVideos && window.__phase16?.getAllReports && window.__phase16Outcomes) return resolve();
        if (Date.now() - start > maxWait) return reject(new Error('timeout'));
        setTimeout(check, 100);
      };
      check();
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function normalizeOutcomes(o) {
    if (!o || Array.isArray(o)) return {};
    if (typeof o !== 'object') return {};
    return o;
  }

  function normalizeTone(tone) {
    const t = (tone || '').toString();
    if (/강세|상승|매수|bullish|buy/i.test(t)) return '강세';
    if (/약세|하락|매도|bearish|sell/i.test(t)) return '약세';
    if (/중립|hold|neutral/i.test(t)) return '중립';
    return '기타';
  }

  function evaluateTone(tone, returnPct) {
    if (returnPct == null || isNaN(returnPct)) return null;
    const t = (tone || '').toString();
    if (/강세|상승|매수|bullish|buy/i.test(t)) return returnPct >= TONE_THRESHOLD ? '적중' : '미적중';
    if (/약세|하락|매도|bearish|sell/i.test(t)) return returnPct <= -TONE_THRESHOLD ? '적중' : '미적중';
    if (/중립|hold|neutral/i.test(t)) return (returnPct >= -TONE_THRESHOLD && returnPct <= TONE_THRESHOLD) ? '적중' : '미적중';
    return null;
  }

  // ─────────────────────────────────────────────
  // 통계 계산
  // ─────────────────────────────────────────────
  async function computeStats() {
    const [videos, reports] = await Promise.all([
      window.__phase16.getAllVideos(),
      window.__phase16.getAllReports()
    ]);

    // 1. 채널별 적중률
    const channelStats = {}; // name -> { total, hits, evaluations }
    videos.forEach(v => {
      const outcomes = normalizeOutcomes(v.outcomes);
      const ch = v.channelName || '(unknown)';
      if (!channelStats[ch]) channelStats[ch] = { name: ch, total: 0, hits: 0, videoCount: 0 };
      channelStats[ch].videoCount++;
      const tickers = v.tickers || [];
      if (!tickers.length && v.overallTone) tickers.push({ code: '', tone: v.overallTone });
      PERIODS.forEach(p => {
        const periodData = outcomes[p.key];
        if (!periodData) return;
        tickers.forEach(t => {
          const data = periodData[t.code || ''];
          if (!data || data.basePrice == null || data.price == null) return;
          const ret = (data.price - data.basePrice) / data.basePrice * 100;
          const hit = evaluateTone(t.tone, ret);
          if (hit) {
            channelStats[ch].total++;
            if (hit === '적중') channelStats[ch].hits++;
          }
        });
      });
    });

    // 2. 애널리스트별 적중률
    const analystStats = {};
    reports.forEach(r => {
      const outcomes = normalizeOutcomes(r.outcomes);
      const key = `${r.analyst || '(unknown)'} | ${r.firm || ''}`;
      if (!analystStats[key]) analystStats[key] = { name: key, total: 0, hits: 0, reportCount: 0 };
      analystStats[key].reportCount++;
      PERIODS.forEach(p => {
        const data = outcomes[p.key]?.[r.ticker];
        if (!data || data.basePrice == null || data.price == null) return;
        const ret = (data.price - data.basePrice) / data.basePrice * 100;
        const hit = evaluateTone(r.rating, ret);
        if (hit) {
          analystStats[key].total++;
          if (hit === '적중') analystStats[key].hits++;
        }
      });
    });

    // 3. 가장 많이 언급된 종목
    const tickerCount = {}; // code -> { code, name, count, videoCount, reportCount, tones: {강세, 중립, 약세} }
    videos.forEach(v => {
      (v.tickers || []).forEach(t => {
        if (!t.code) return;
        if (!tickerCount[t.code]) tickerCount[t.code] = { code: t.code, name: t.name || t.code, count: 0, videoCount: 0, reportCount: 0, tones: { 강세:0, 중립:0, 약세:0, 기타:0 } };
        tickerCount[t.code].count++;
        tickerCount[t.code].videoCount++;
        tickerCount[t.code].tones[normalizeTone(t.tone)]++;
      });
    });
    reports.forEach(r => {
      if (!r.ticker) return;
      if (!tickerCount[r.ticker]) tickerCount[r.ticker] = { code: r.ticker, name: r.tickerName || r.ticker, count: 0, videoCount: 0, reportCount: 0, tones: { 강세:0, 중립:0, 약세:0, 기타:0 } };
      tickerCount[r.ticker].count++;
      tickerCount[r.ticker].reportCount++;
      tickerCount[r.ticker].tones[normalizeTone(r.rating)]++;
    });

    // 4. 톤 분포
    const videoTones = { 강세:0, 중립:0, 약세:0, 기타:0 };
    const reportTones = { 강세:0, 중립:0, 약세:0, 기타:0 };
    videos.forEach(v => {
      if (v.overallTone) videoTones[normalizeTone(v.overallTone)]++;
    });
    reports.forEach(r => {
      if (r.rating) reportTones[normalizeTone(r.rating)]++;
    });

    // 5. 기간별 적중률
    const periodStats = {};
    PERIODS.forEach(p => { periodStats[p.key] = { label: p.label, total: 0, hits: 0 }; });
    videos.forEach(v => {
      const outcomes = normalizeOutcomes(v.outcomes);
      const tickers = v.tickers || [];
      if (!tickers.length && v.overallTone) tickers.push({ code: '', tone: v.overallTone });
      PERIODS.forEach(p => {
        const periodData = outcomes[p.key];
        if (!periodData) return;
        tickers.forEach(t => {
          const data = periodData[t.code || ''];
          if (!data || data.basePrice == null || data.price == null) return;
          const ret = (data.price - data.basePrice) / data.basePrice * 100;
          const hit = evaluateTone(t.tone, ret);
          if (hit) {
            periodStats[p.key].total++;
            if (hit === '적중') periodStats[p.key].hits++;
          }
        });
      });
    });
    reports.forEach(r => {
      const outcomes = normalizeOutcomes(r.outcomes);
      PERIODS.forEach(p => {
        const data = outcomes[p.key]?.[r.ticker];
        if (!data || data.basePrice == null || data.price == null) return;
        const ret = (data.price - data.basePrice) / data.basePrice * 100;
        const hit = evaluateTone(r.rating, ret);
        if (hit) {
          periodStats[p.key].total++;
          if (hit === '적중') periodStats[p.key].hits++;
        }
      });
    });

    // 6. 시간대별 등록 추이 (월별)
    const monthlyStats = {}; // 'YYYY-MM' -> { videos, reports }
    videos.forEach(v => {
      const date = v.watchedAt || v.createdAt;
      if (!date) return;
      const ym = String(date).slice(0, 7);
      if (!monthlyStats[ym]) monthlyStats[ym] = { ym, videos: 0, reports: 0 };
      monthlyStats[ym].videos++;
    });
    reports.forEach(r => {
      const date = r.reportDate || r.createdAt;
      if (!date) return;
      const ym = String(date).slice(0, 7);
      if (!monthlyStats[ym]) monthlyStats[ym] = { ym, videos: 0, reports: 0 };
      monthlyStats[ym].reports++;
    });

    // 7. 요약 통계
    const totalEvaluated = Object.values(channelStats).reduce((s, c) => s + c.total, 0) +
                           Object.values(analystStats).reduce((s, a) => s + a.total, 0);
    const totalHits = Object.values(channelStats).reduce((s, c) => s + c.hits, 0) +
                      Object.values(analystStats).reduce((s, a) => s + a.hits, 0);
    const totalPending = videos.length + reports.length;
    const overallAccuracy = totalEvaluated > 0 ? (totalHits / totalEvaluated * 100) : null;

    // 최고 신뢰 채널/애널리스트
    const channelArr = Object.values(channelStats).filter(c => c.total > 0).sort((a,b) => (b.hits/b.total) - (a.hits/a.total));
    const analystArr = Object.values(analystStats).filter(a => a.total > 0).sort((a,b) => (b.hits/b.total) - (a.hits/a.total));

    return {
      summary: {
        videoCount: videos.length,
        reportCount: reports.length,
        totalEvaluated,
        totalPending,
        overallAccuracy,
        topChannel: channelArr[0] || null,
        topAnalyst: analystArr[0] || null
      },
      channelStats: Object.values(channelStats).sort((a,b) => {
        const ar = a.total > 0 ? a.hits/a.total : -1;
        const br = b.total > 0 ? b.hits/b.total : -1;
        if (br !== ar) return br - ar;
        return b.total - a.total;
      }).slice(0, 10),
      analystStats: Object.values(analystStats).sort((a,b) => {
        const ar = a.total > 0 ? a.hits/a.total : -1;
        const br = b.total > 0 ? b.hits/b.total : -1;
        if (br !== ar) return br - ar;
        return b.total - a.total;
      }).slice(0, 10),
      tickerStats: Object.values(tickerCount).sort((a,b) => b.count - a.count).slice(0, 10),
      videoTones,
      reportTones,
      periodStats,
      monthlyStats: Object.values(monthlyStats).sort((a,b) => a.ym.localeCompare(b.ym))
    };
  }

  // ─────────────────────────────────────────────
  // 시각화 헬퍼
  // ─────────────────────────────────────────────
  function barChart(items, maxValue, opts = {}) {
    // items: [{ label, value, sub, color }]
    if (!items.length) return '<div style="color:#9ca3af;text-align:center;padding:20px;">데이터 없음</div>';
    const max = maxValue || Math.max(...items.map(i => i.value), 1);
    return items.map(item => {
      const pct = Math.max(2, (item.value / max) * 100);
      const color = item.color || '#3b82f6';
      return `
        <div style="margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
            <span style="color:#374151;font-weight:500;">${escapeHtml(item.label)}</span>
            <span style="color:#6b7280;">${escapeHtml(item.sub || '')}</span>
          </div>
          <div style="background:#f3f4f6;border-radius:4px;height:18px;position:relative;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width 0.3s;"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  function donutChart(data, size = 140) {
    // data: { 강세: n, 중립: n, 약세: n, 기타: n }
    const colors = { 강세:'#10b981', 중립:'#6b7280', 약세:'#ef4444', 기타:'#d1d5db' };
    const total = Object.values(data).reduce((s,v) => s+v, 0);
    if (total === 0) return '<div style="color:#9ca3af;text-align:center;padding:20px;">데이터 없음</div>';

    const r = size/2 - 10;
    const cx = size/2;
    const cy = size/2;
    const circumference = 2 * Math.PI * r;
    let offset = 0;
    const segments = [];

    Object.entries(data).forEach(([key, val]) => {
      if (val === 0) return;
      const pct = val / total;
      const length = circumference * pct;
      segments.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colors[key]}" stroke-width="20" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`);
      offset += length;
    });

    const legend = Object.entries(data).filter(([_,v]) => v>0).map(([k,v]) => `
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;">
        <span style="width:10px;height:10px;background:${colors[k]};border-radius:2px;display:inline-block;"></span>
        <span>${k}: ${v} (${(v/total*100).toFixed(0)}%)</span>
      </div>
    `).join('');

    return `
      <div style="display:flex;align-items:center;gap:16px;justify-content:center;">
        <svg width="${size}" height="${size}">
          ${segments.join('')}
          <text x="${cx}" y="${cy+5}" text-anchor="middle" font-size="18" font-weight="600" fill="#111">${total}</text>
        </svg>
        <div style="display:flex;flex-direction:column;gap:6px;">${legend}</div>
      </div>
    `;
  }

  function lineChart(items, opts = {}) {
    // items: [{ label, video, report }]
    if (!items.length) return '<div style="color:#9ca3af;text-align:center;padding:20px;">데이터 없음</div>';
    const w = 600, h = 180, pad = 30;
    const maxVal = Math.max(...items.map(i => Math.max(i.video, i.report)), 1);
    const stepX = items.length > 1 ? (w - pad*2) / (items.length - 1) : 0;
    const yScale = (v) => h - pad - (v / maxVal) * (h - pad*2);

    const videoPoints = items.map((it, i) => `${pad + i*stepX},${yScale(it.video)}`).join(' ');
    const reportPoints = items.map((it, i) => `${pad + i*stepX},${yScale(it.report)}`).join(' ');

    const xLabels = items.map((it, i) => `<text x="${pad + i*stepX}" y="${h - pad + 15}" text-anchor="middle" font-size="11" fill="#6b7280">${escapeHtml(it.label)}</text>`).join('');

    return `
      <div style="overflow-x:auto;">
        <svg width="${w}" height="${h}" style="min-width:${w}px;">
          <line x1="${pad}" y1="${h-pad}" x2="${w-pad}" y2="${h-pad}" stroke="#e5e7eb"/>
          <polyline points="${videoPoints}" fill="none" stroke="#3b82f6" stroke-width="2"/>
          <polyline points="${reportPoints}" fill="none" stroke="#10b981" stroke-width="2"/>
          ${items.map((it, i) => `
            <circle cx="${pad + i*stepX}" cy="${yScale(it.video)}" r="3" fill="#3b82f6"/>
            <circle cx="${pad + i*stepX}" cy="${yScale(it.report)}" r="3" fill="#10b981"/>
          `).join('')}
          ${xLabels}
        </svg>
        <div style="display:flex;gap:12px;justify-content:center;font-size:12px;margin-top:4px;">
          <span><span style="display:inline-block;width:10px;height:10px;background:#3b82f6;border-radius:2px;"></span> 영상</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:#10b981;border-radius:2px;"></span> 리포트</span>
        </div>
      </div>
    `;
  }

  function accuracyColor(pct) {
    if (pct >= 70) return '#10b981';
    if (pct >= 50) return '#3b82f6';
    if (pct >= 30) return '#f59e0b';
    return '#ef4444';
  }

  // ─────────────────────────────────────────────
  // 대시보드 렌더링
  // ─────────────────────────────────────────────
  async function openStatsModal() {
    const existing = document.getElementById('p16-stats-modal');
    if (existing) existing.remove();

    const stats = await computeStats();

    const modal = document.createElement('div');
    modal.id = 'p16-stats-modal';
    modal.style.cssText = `
      position:fixed;top:0;left:0;width:100%;height:100%;
      background:rgba(0,0,0,0.55);z-index:100000;
      display:flex;align-items:center;justify-content:center;padding:20px;
    `;

    const s = stats.summary;
    const accPct = s.overallAccuracy != null ? s.overallAccuracy.toFixed(1) + '%' : '-';

    // 채널 막대
    const channelBars = barChart(
      stats.channelStats.map(c => ({
        label: c.name,
        value: c.total > 0 ? (c.hits / c.total * 100) : 0,
        sub: c.total > 0 ? `${c.hits}/${c.total} (${(c.hits/c.total*100).toFixed(0)}%) · 영상 ${c.videoCount}개` : `평가 대기 · 영상 ${c.videoCount}개`,
        color: c.total > 0 ? accuracyColor(c.hits/c.total*100) : '#d1d5db'
      })),
      100
    );

    // 애널리스트 막대
    const analystBars = barChart(
      stats.analystStats.map(a => ({
        label: a.name,
        value: a.total > 0 ? (a.hits / a.total * 100) : 0,
        sub: a.total > 0 ? `${a.hits}/${a.total} (${(a.hits/a.total*100).toFixed(0)}%) · 리포트 ${a.reportCount}개` : `평가 대기 · 리포트 ${a.reportCount}개`,
        color: a.total > 0 ? accuracyColor(a.hits/a.total*100) : '#d1d5db'
      })),
      100
    );

    // 종목 막대
    const tickerBars = barChart(
      stats.tickerStats.map(t => {
        const dominant = Object.entries(t.tones).filter(([k,_]) => k !== '기타').sort((a,b) => b[1]-a[1])[0];
        const toneText = dominant && dominant[1] > 0 ? `(주요: ${dominant[0]})` : '';
        return {
          label: `${t.name} (${t.code})`,
          value: t.count,
          sub: `${t.count}회 · 영상 ${t.videoCount} / 리포트 ${t.reportCount} ${toneText}`,
          color: '#6366f1'
        };
      })
    );

    // 기간 막대
    const periodBars = barChart(
      PERIODS.map(p => {
        const ps = stats.periodStats[p.key];
        return {
          label: p.label,
          value: ps.total > 0 ? (ps.hits/ps.total*100) : 0,
          sub: ps.total > 0 ? `${ps.hits}/${ps.total} (${(ps.hits/ps.total*100).toFixed(0)}%)` : '평가 대기',
          color: ps.total > 0 ? accuracyColor(ps.hits/ps.total*100) : '#d1d5db'
        };
      }),
      100
    );

    // 월별 추이
    const monthlyLine = lineChart(
      stats.monthlyStats.map(m => ({ label: m.ym.slice(2), video: m.videos, report: m.reports }))
    );

    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:24px;max-width:900px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,0.3);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
          <div>
            <h2 style="margin:0;font-size:20px;color:#111;">📊 통계 대시보드</h2>
            <div style="font-size:13px;color:#6b7280;margin-top:4px;">정보 노트 데이터 종합 분석</div>
          </div>
          <button id="p16-stats-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:#666;">×</button>
        </div>

        <!-- 요약 카드 -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:10px;margin-bottom:20px;">
          <div style="background:#dbeafe;border-radius:8px;padding:12px;">
            <div style="font-size:11px;color:#1e40af;margin-bottom:4px;">📺 영상</div>
            <div style="font-size:22px;font-weight:700;color:#1e3a8a;">${s.videoCount}<span style="font-size:12px;font-weight:400;">개</span></div>
          </div>
          <div style="background:#d1fae5;border-radius:8px;padding:12px;">
            <div style="font-size:11px;color:#065f46;margin-bottom:4px;">📄 리포트</div>
            <div style="font-size:22px;font-weight:700;color:#064e3b;">${s.reportCount}<span style="font-size:12px;font-weight:400;">개</span></div>
          </div>
          <div style="background:#fef3c7;border-radius:8px;padding:12px;">
            <div style="font-size:11px;color:#92400e;margin-bottom:4px;">✅ 평가 완료</div>
            <div style="font-size:22px;font-weight:700;color:#78350f;">${s.totalEvaluated}<span style="font-size:12px;font-weight:400;">건</span></div>
          </div>
          <div style="background:#fce7f3;border-radius:8px;padding:12px;">
            <div style="font-size:11px;color:#9f1239;margin-bottom:4px;">🎯 전체 적중률</div>
            <div style="font-size:22px;font-weight:700;color:#831843;">${accPct}</div>
          </div>
        </div>

        ${(s.topChannel || s.topAnalyst) ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px;">
            ${s.topChannel ? `
              <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px;">
                <div style="font-size:11px;color:#0369a1;margin-bottom:4px;">🏆 최고 신뢰 채널</div>
                <div style="font-size:14px;font-weight:600;color:#0c4a6e;">${escapeHtml(s.topChannel.name)}</div>
                <div style="font-size:12px;color:#0c4a6e;">${s.topChannel.hits}/${s.topChannel.total} 적중 (${(s.topChannel.hits/s.topChannel.total*100).toFixed(0)}%)</div>
              </div>
            ` : '<div></div>'}
            ${s.topAnalyst ? `
              <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:12px;">
                <div style="font-size:11px;color:#047857;margin-bottom:4px;">🏆 최고 신뢰 애널리스트</div>
                <div style="font-size:14px;font-weight:600;color:#064e3b;">${escapeHtml(s.topAnalyst.name)}</div>
                <div style="font-size:12px;color:#064e3b;">${s.topAnalyst.hits}/${s.topAnalyst.total} 적중 (${(s.topAnalyst.hits/s.topAnalyst.total*100).toFixed(0)}%)</div>
              </div>
            ` : '<div></div>'}
          </div>
        ` : ''}

        <!-- 섹션 1: 채널별 적중률 -->
        <section style="margin-bottom:24px;">
          <h3 style="font-size:15px;color:#111;margin:0 0 10px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">📺 채널별 적중률 TOP 10</h3>
          ${channelBars}
        </section>

        <!-- 섹션 2: 애널리스트별 적중률 -->
        <section style="margin-bottom:24px;">
          <h3 style="font-size:15px;color:#111;margin:0 0 10px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">💼 애널리스트별 적중률 TOP 10</h3>
          ${analystBars}
        </section>

        <!-- 섹션 3: 종목 언급 횟수 -->
        <section style="margin-bottom:24px;">
          <h3 style="font-size:15px;color:#111;margin:0 0 10px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">🏷️ 가장 많이 언급된 종목 TOP 10</h3>
          ${tickerBars}
        </section>

        <!-- 섹션 4: 톤 분포 -->
        <section style="margin-bottom:24px;">
          <h3 style="font-size:15px;color:#111;margin:0 0 10px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">🎨 톤 분포</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
            <div>
              <div style="text-align:center;font-size:13px;color:#374151;margin-bottom:8px;font-weight:500;">📺 영상</div>
              ${donutChart(stats.videoTones)}
            </div>
            <div>
              <div style="text-align:center;font-size:13px;color:#374151;margin-bottom:8px;font-weight:500;">📄 리포트</div>
              ${donutChart(stats.reportTones)}
            </div>
          </div>
        </section>

        <!-- 섹션 5: 기간별 적중률 -->
        <section style="margin-bottom:24px;">
          <h3 style="font-size:15px;color:#111;margin:0 0 10px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">⏱️ 기간별 적중률 비교</h3>
          ${periodBars}
        </section>

        <!-- 섹션 6: 월별 추이 -->
        <section style="margin-bottom:8px;">
          <h3 style="font-size:15px;color:#111;margin:0 0 10px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;">📈 월별 등록 추이</h3>
          ${monthlyLine}
        </section>

        <div style="display:flex;justify-content:flex-end;margin-top:16px;">
          <button id="p16-stats-refresh" style="padding:8px 16px;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;margin-right:8px;">🔄 새로고침</button>
          <button id="p16-stats-close2" style="padding:8px 16px;background:#f3f4f6;border:none;border-radius:6px;cursor:pointer;color:#333;">닫기</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('#p16-stats-close').addEventListener('click', close);
    modal.querySelector('#p16-stats-close2').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('#p16-stats-refresh').addEventListener('click', async () => {
      close();
      await openStatsModal();
    });
  }

  async function init() {
    try {
      await waitForDeps();
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📊 Phase 16 통계 대시보드 v${VERSION}`);
      console.log(`   채널/애널리스트/종목/톤/기간/시간 6개 섹션`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } catch(e) {
      console.error('[Phase16-stats] 초기화 실패:', e);
    }
  }
// ===== 메뉴 버튼 추가 (v0.1.1) =====
window.p16OpenStatsDashboard = function() {
  // 열려있는 메뉴 모달 닫기
  document.querySelectorAll('[id*="menu-modal"],[id*="menu-panel"]').forEach(m => {
    if (m.style.display !== 'none') m.style.display = 'none';
  });
  // 통계 모달 열기
  if (window.__phase16Stats?.openModal) {
    window.__phase16Stats.openModal();
  } else {
    console.warn('[phase16-stats] openModal 함수를 찾을 수 없음');
  }
};

let p16StatsBtnInjected = false;
let p16StatsBtnTries = 0;

function injectStatsMenuButton() {
  if (p16StatsBtnInjected || p16StatsBtnTries++ > 100) return;
  
  // "정보 노트" 메뉴 버튼을 기준으로 그 옆에 추가
  const infoBtn = document.getElementById('p16-menu-info-note');
  if (!infoBtn) return;
  
  // 이미 추가됐는지 체크
  if (document.querySelector('.p16-stats-menu-btn')) {
    p16StatsBtnInjected = true;
    return;
  }
  
  const btn = document.createElement('button');
  btn.className = (infoBtn.className || '') + ' p16-stats-menu-btn';
  btn.type = 'button';
  btn.id = 'p16-menu-stats';
  btn.style.cssText = infoBtn.style.cssText;
  btn.innerHTML = '<span style="font-size:18px;">📊</span><span>인사이트 통계</span>';
  btn.onclick = () => window.p16OpenStatsDashboard();
  
  infoBtn.parentElement.appendChild(btn);
  p16StatsBtnInjected = true;
  console.log('[phase16-stats v0.1.1] ✅ 메뉴 버튼 추가됨');
}

// 자동 감지 (메뉴가 동적으로 생성되므로 주기적 확인)
setInterval(injectStatsMenuButton, 2000);
[500, 1500, 3000, 5000].forEach(t => setTimeout(injectStatsMenuButton, t));
  
  window.__phase16Stats = {
    version: VERSION,
    openModal: openStatsModal,
    compute: computeStats
  };

  setTimeout(init, 6000);
})();
