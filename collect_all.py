"""
한국 증시 외국인/기관 매매동향 수집기 v3
- 네이버 금융 모바일 (인증 불필요)
- pykrx 대체
"""
from datetime import datetime, timezone, timedelta
import json
import os
import re
import traceback
import requests

KST = timezone(timedelta(hours=9))
now_kst = datetime.now(KST)
today_str = now_kst.strftime("%Y%m%d")
print(f"현재(KST): {now_kst.strftime('%Y-%m-%d %H:%M:%S')}")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Referer": "https://m.stock.naver.com/",
}


def parse_num(s):
    """문자열에서 숫자만 추출. 콤마/공백 제거. 음수 처리."""
    if s is None:
        return 0
    s = str(s).strip().replace(",", "").replace(" ", "")
    if not s or s == "-":
        return 0
    try:
        return int(float(s))
    except ValueError:
        return 0


def fetch_naver_investor():
    """
    네이버 금융 모바일 API에서 외국인/기관 매매 동향 수집
    엔드포인트: https://m.stock.naver.com/api/index/{code}/investor/daily
    KOSPI: KOSPI, KOSDAQ: KOSDAQ
    """
    print("=" * 60)
    print("Source 1: 네이버 금융 모바일 (외국인/기관 일별)")
    print("=" * 60)

    result = {}
    base_date = None

    for market_code, market_key in [("KOSPI", "kospi"), ("KOSDAQ", "kosdaq")]:
        url = f"https://m.stock.naver.com/api/index/{market_code}/investor/daily"
        print(f"\n   [{market_code}] {url}")

        try:
            res = requests.get(url, headers=HEADERS, timeout=15)
            print(f"   HTTP {res.status_code}, {len(res.content)} bytes")

            if res.status_code != 200:
                print(f"   응답 본문 (처음 200자): {res.text[:200]}")
                return None

            data = res.json()
            # data 구조: 보통 {"datas":[{...}], ...} 또는 [{...}]
            if isinstance(data, dict):
                items = data.get("datas") or data.get("data") or data.get("result") or []
            elif isinstance(data, list):
                items = data
            else:
                items = []

            if not items:
                print(f"   빈 데이터: {str(data)[:300]}")
                return None

            print(f"   {len(items)}건 수신, 첫 항목 키: {list(items[0].keys()) if items else '(없음)'}")

            # 가장 최근 일자
            latest = items[0]
            print(f"   첫 항목 내용 (처음 500자): {str(latest)[:500]}")

            # 날짜 키 찾기
            date_val = latest.get("bizdate") or latest.get("date") or latest.get("localTradedAt") or latest.get("dt") or ""
            date_val = str(date_val).replace("-", "").replace(".", "")[:8]
            if date_val:
                base_date = date_val

            # 외국인/기관 키 후보들
            foreign = parse_num(
                latest.get("foreignerPureBuyQuant") or
                latest.get("foreignPureBuyAmt") or
                latest.get("foreignerNetBuy") or
                latest.get("foreign") or 0
            )
            inst = parse_num(
                latest.get("organPureBuyQuant") or
                latest.get("organPureBuyAmt") or
                latest.get("organNetBuy") or
                latest.get("organ") or
                latest.get("institution") or 0
            )
            indiv = parse_num(
                latest.get("individualPureBuyQuant") or
                latest.get("individualPureBuyAmt") or
                latest.get("individualNetBuy") or
                latest.get("individual") or 0
            )

            result[market_key] = {
                "date": base_date or today_str,
                "외국인합계": foreign,
                "기관합계": inst,
                "개인": indiv,
                "금융투자": 0,
                "연기금등": 0,
            }
            print(f"   {market_code}: 외국인 {foreign:>15,}, 기관 {inst:>15,}, 개인 {indiv:>15,}")

        except Exception as e:
            print(f"   {market_code} 예외: {type(e).__name__}: {e}")
            print(traceback.format_exc())
            return None

    if not result or len(result) < 2:
        return None

    return {"source": "naver", "data": result, "base_date": base_date or today_str}


def use_mock():
    print("\n" + "=" * 60)
    print("Fallback: MOCK 데이터")
    print("=" * 60)
    return {
        "source": "mock",
        "base_date": today_str,
        "data": {
            "kospi": {"date": today_str, "외국인합계": -2775400000000, "기관합계": 1234500000000,
                      "개인": 1540900000000, "금융투자": 567800000000, "연기금등": -89000000000},
            "kosdaq": {"date": today_str, "외국인합계": 297400000000, "기관합계": -123400000000,
                       "개인": -174000000000, "금융투자": 34500000000, "연기금등": 5600000000}
        }
    }


# 실행
data = fetch_naver_investor() or use_mock()


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

output = {
    "updated_at": now_kst.isoformat(),
    "updated_at_kst": now_kst.strftime("%Y-%m-%d %H:%M:%S"),
    "source": data["source"],
    "base_date": data["base_date"],
    "kospi": data["data"]["kospi"],
    "kosdaq": data["data"]["kosdaq"],
}

os.makedirs("data", exist_ok=True)
with open("data/krx_investor.json", "w", encoding="utf-8") as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

print("\n" + "=" * 60)
print(f"저장 완료 (source: {output['source']})")
print("=" * 60)
