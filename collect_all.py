"""
한국 증시 외국인/기관 매매동향 통합 수집기
- 1순위: pykrx (KRX 공식)
- 2순위: 네이버 금융 순매수 상위 종목 페이지 (집계용)
- 3순위: MOCK (테스트용)
"""
from datetime import datetime, timezone, timedelta
import json
import time
import requests
from bs4 import BeautifulSoup

KST = timezone(timedelta(hours=9))
now_kst = datetime.now(KST)
today_str = now_kst.strftime("%Y%m%d")
print(f"🕐 현재(KST): {now_kst.strftime('%Y-%m-%d %H:%M:%S')}\n")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Referer": "https://finance.naver.com/",
    "Accept-Language": "ko-KR,ko;q=0.9",
}

# ====================================================================
# Source 1: pykrx
# ====================================================================
def try_pykrx():
    print("=" * 60)
    print("🥇 Source 1: pykrx (KRX 공식)")
    print("=" * 60)
    try:
        from pykrx import stock

        # 영업일 탐색
        d = datetime.strptime(today_str, "%Y%m%d")
        last_bday = None
        for i in range(10):
            ds = d.strftime("%Y%m%d")
            try:
                df = stock.get_market_ohlcv(ds, market="KOSPI")
                if df is not None and not df.empty:
                    last_bday = ds
                    break
            except Exception:
                pass
            d -= timedelta(days=1)
            time.sleep(0.5)

        if not last_bday:
            print("   ❌ 영업일 탐색 실패 (KRX 점검 중일 가능성)")
            return None

        print(f"   📅 영업일: {last_bday}")

        def safe(df, idx, col):
            try:
                return int(df.loc[idx, col])
            except Exception:
                return 0

        result = {}
        for market in ("KOSPI", "KOSDAQ"):
            df = stock.get_market_trading_value_by_investor(last_bday, last_bday, market)
            if df is None or df.empty:
                print(f"   ❌ {market} 빈 응답")
                return None
            result[market.lower()] = {
                "date": last_bday,
                "외국인합계": safe(df, "외국인합계", "순매수"),
                "기관합계":   safe(df, "기관합계", "순매수"),
                "개인":       safe(df, "개인", "순매수"),
                "금융투자":   safe(df, "금융투자", "순매수"),
                "연기금등":   safe(df, "연기금등", "순매수"),
            }
            print(f"   ✅ {market}: 외국인 {result[market.lower()]['외국인합계']:>15,} 원")

        return {"source": "pykrx", "data": result, "base_date": last_bday}

    except Exception as e:
        print(f"   ❌ pykrx 실패: {e}")
        return None

# ====================================================================
# Source 2: 네이버 금융 (외국인 순매수 상위 종목 페이지에서 집계 합산)
# ====================================================================
def try_naver():
    print("\n" + "=" * 60)
    print("🥈 Source 2: 네이버 금융")
    print("=" * 60)
    try:
        # 네이버 코스피 지수 페이지 - 투자자별 정보 들어있음
        url = "https://finance.naver.com/sise/sise_index.naver?code=KOSPI"
        print(f"   📡 {url}")
        res = requests.get(url, headers=HEADERS, timeout=10)
        res.encoding = "euc-kr"
        soup = BeautifulSoup(res.text, "html.parser")

        # 투자자별 매매동향 영역 찾기
        # 이 페이지에서 "외국인", "기관계" 텍스트 주변 숫자 추출
        result = {}
        text = soup.get_text()
        print(f"   ✅ 페이지 로드 성공 ({len(res.text)} bytes)")

        # 페이지 내 투자자 박스 찾기 (실제 구조에 따라 조정 필요)
        boxes = soup.find_all("table", class_="type_5")
        for box in boxes:
            box_text = box.get_text()
            if "외국인" in box_text or "기관" in box_text:
                print(f"   🔍 투자자 박스 발견")
                print(f"   {box_text[:300]}")
                break

        # 일단 페이지 로드만 성공으로 표시 (구조 분석은 별도 진행)
        return None  # 추후 정확한 셀렉터 확정 후 활성화

    except Exception as e:
        print(f"   ❌ 네이버 실패: {e}")
        return None

# ====================================================================
# Source 3: MOCK (파이프라인 검증용)
# ====================================================================
def use_mock():
    print("\n" + "=" * 60)
    print("🥉 Source 3: MOCK 데이터 (파이프라인 검증)")
    print("=" * 60)
    print("   ⚠️ 실제 데이터 수집 실패. MOCK 데이터로 진행합니다.")
    print("   💡 KST 07:30 이후 다시 실행하면 실제 데이터 수집됩니다.")
    return {
        "source": "mock",
        "base_date": today_str,
        "data": {
            "kospi": {
                "date": today_str,
                "외국인합계": -2775400000000,
                "기관합계":    1234500000000,
                "개인":        1540900000000,
                "금융투자":     567800000000,
                "연기금등":     -89000000000,
            },
            "kosdaq": {
                "date": today_str,
                "외국인합계":  297400000000,
                "기관합계":   -123400000000,
                "개인":      -174000000000,
                "금융투자":    34500000000,
                "연기금등":     5600000000,
            }
        }
    }

# ====================================================================
# 실행
# ====================================================================
data = try_pykrx() or try_naver() or use_mock()

# 단위 변환 (원 → 억원)
def to_eok(v):
    return round(v / 1e8, 1)

for market_key in ("kospi", "kosdaq"):
    m = data["data"].get(market_key, {})
    eok = {}
    for k, v in m.items():
        if isinstance(v, (int, float)) and k != "date":
            eok[k] = to_eok(v)
        else:
            eok[k] = v
    data["data"][market_key]["eok"] = eok

# 최종 출력 구조
output = {
    "updated_at": now_kst.isoformat(),
    "updated_at_kst": now_kst.strftime("%Y-%m-%d %H:%M:%S"),
    "source": data["source"],
    "base_date": data["base_date"],
    "kospi": data["data"]["kospi"],
    "kosdaq": data["data"]["kosdaq"],
}

import os
os.makedirs("data", exist_ok=True)
with open("data/krx_investor.json", "w", encoding="utf-8") as f:
json.dump(output, f, ensure_ascii=False, indent=2)

print("\n" + "=" * 60)
print(f"💾 저장 완료: krx_investor.json (source: {output['source']})")
print("=" * 60)
print(f"\n📊 KOSPI 요약 (억원)")
for k, v in output["kospi"].get("eok", {}).items():
    if isinstance(v, (int, float)):
        print(f"   {k:<10}: {v:>12,.1f}")
print(f"\n📊 KOSDAQ 요약 (억원)")
for k, v in output["kosdaq"].get("eok", {}).items():
    if isinstance(v, (int, float)):
        print(f"   {k:<10}: {v:>12,.1f}")
