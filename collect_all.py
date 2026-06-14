"""
한국 증시 외국인/기관 매매동향 수집기 v6
- 네이버 금융: 현물(KOSPI/KOSDAQ) + 선물(KOSPI200) 통합 수집
- 왝더독 분석용 외국인 선물 데이터 포함
"""
from datetime import datetime, timezone, timedelta
import json
import os
import re
import traceback
import requests
from bs4 import BeautifulSoup

KST = timezone(timedelta(hours=9))
now_kst = datetime.now(KST)
today_str = now_kst.strftime("%Y%m%d")
print(f"현재(KST): {now_kst.strftime('%Y-%m-%d %H:%M:%S')}")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "Referer": "https://finance.naver.com/sise/sise_trans_style.naver",
}


def parse_int(s):
    if s is None:
        return 0
    s = str(s).strip().replace(",", "").replace(" ", "").replace("+", "")
    if not s or s in ("-", "--"):
        return 0
    s = re.sub(r"[^\d\-\.]", "", s)
    if not s or s == "-":
        return 0
    try:
        return int(float(s))
    except ValueError:
        return 0


def fetch_naver_market(sosok_code, market_name):
    """
    sosok_code: '01'=KOSPI, '02'=KOSDAQ, '03'=선물(KOSPI200)
    단위: 현물=억원, 선물=계약
    """
    url = f"https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate={today_str}&sosok={sosok_code}&page=1"
    print(f"\n   [{market_name}] {url}")

    try:
        res = requests.get(url, headers=HEADERS, timeout=15)
        print(f"   HTTP {res.status_code}, {len(res.content)} bytes")

        if res.status_code != 200:
            return None

        res.encoding = "euc-kr"
        soup = BeautifulSoup(res.text, "html.parser")

        table = soup.find("table", summary=re.compile("일자별 순매수"))
        if table is None:
            print(f"   테이블 없음")
            return None

        rows = table.find_all("tr")
        data_row = None
        for tr in rows:
            tds = tr.find_all("td")
            if len(tds) >= 10:
                first_text = tds[0].get_text(strip=True)
                if re.match(r"^\d{2,4}[.\-/]\d{1,2}[.\-/]\d{1,2}$", first_text):
                    data_row = tds
                    break

        if not data_row:
            print(f"   데이터 행 없음")
            return None

        date_str = data_row[0].get_text(strip=True)
        date_clean = re.sub(r"[^\d]", "", date_str)
        date_norm = "20" + date_clean if len(date_clean) == 6 else date_clean

        indiv = parse_int(data_row[1].get_text(strip=True))
        foreign = parse_int(data_row[2].get_text(strip=True))
        inst = parse_int(data_row[3].get_text(strip=True))
        finance = parse_int(data_row[4].get_text(strip=True))
        pension = parse_int(data_row[9].get_text(strip=True)) if len(data_row) > 9 else 0

        unit = "계약" if sosok_code == "03" else "억"
        print(f"   날짜: {date_norm}")
        print(f"   개인:    {indiv:>10,} {unit}")
        print(f"   외국인:  {foreign:>10,} {unit}")
        print(f"   기관계:  {inst:>10,} {unit}")
        print(f"   금융투자:{finance:>10,} {unit}")
        print(f"   연기금등:{pension:>10,} {unit}")

        # 현물(01,02)는 억→원 환산, 선물(03)은 계약수 그대로
        multiplier = 1 if sosok_code == "03" else 100000000
        return {
            "date": date_norm,
            "외국인합계": foreign * multiplier,
            "기관합계": inst * multiplier,
            "개인": indiv * multiplier,
            "금융투자": finance * multiplier,
            "연기금등": pension * multiplier,
            "unit": unit,
        }

    except Exception as e:
        print(f"   {market_name} 예외: {type(e).__name__}: {e}")
        print(traceback.format_exc())
        return None


def fetch_naver_all():
    print("=" * 60)
    print("Source: 네이버 금융 (현물 + 선물 매매동향)")
    print("=" * 60)

    kospi = fetch_naver_market("01", "KOSPI")
    kosdaq = fetch_naver_market("02", "KOSDAQ")
    futures = fetch_naver_market("03", "KOSPI200 선물")

    if not kospi or not kosdaq:
        return None

    base_date = kospi.get("date") or kosdaq.get("date") or today_str
    return {
        "source": "naver",
        "base_date": base_date,
        "data": {
            "kospi": kospi,
            "kosdaq": kosdaq,
            "futures": futures or {
                "date": base_date,
                "외국인합계": 0, "기관합계": 0, "개인": 0,
                "금융투자": 0, "연기금등": 0, "unit": "계약"
            },
        },
    }


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
                       "개인": -174000000000, "금융투자": 34500000000, "연기금등": 5600000000},
            "futures": {"date": today_str, "외국인합계": 887, "기관합계": -2276,
                        "개인": 1319, "금융투자": -5624, "연기금등": 34, "unit": "계약"}
        }
    }


data = fetch_naver_all() or use_mock()


def to_eok(v):
    return round(v / 1e8, 1)


# kospi, kosdaq은 억 단위 변환, futures는 계약수 그대로
for market_key in ("kospi", "kosdaq"):
    m = data["data"].get(market_key, {})
    eok = {}
    for k, v in m.items():
        if isinstance(v, (int, float)) and k != "date":
            eok[k] = to_eok(v)
        else:
            eok[k] = v
    data["data"][market_key]["eok"] = eok

# futures는 그대로 (단위가 계약수)
if "futures" in data["data"]:
    fut = data["data"]["futures"]
    fut["계약"] = {k: v for k, v in fut.items() if k != "unit"}

output = {
    "updated_at": now_kst.isoformat(),
    "updated_at_kst": now_kst.strftime("%Y-%m-%d %H:%M:%S"),
    "source": data["source"],
    "base_date": data["base_date"],
    "kospi": data["data"]["kospi"],
    "kosdaq": data["data"]["kosdaq"],
    "futures": data["data"].get("futures", {}),
}

os.makedirs("data", exist_ok=True)
with open("data/krx_investor.json", "w", encoding="utf-8") as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

print("\n" + "=" * 60)
print(f"저장 완료 (source: {output['source']})")
print("=" * 60)

if output["source"] == "naver":
    print(f"\n📊 KOSPI 요약 (억원)")
    for k, v in output["kospi"]["eok"].items():
        if isinstance(v, (int, float)):
            print(f"   {k:<10}: {v:>12,.1f}")
    print(f"\n📊 KOSDAQ 요약 (억원)")
    for k, v in output["kosdaq"]["eok"].items():
        if isinstance(v, (int, float)):
            print(f"   {k:<10}: {v:>12,.1f}")
    print(f"\n🎯 KOSPI200 선물 요약 (계약)")
    fut = output.get("futures", {})
    for k in ["외국인합계", "기관합계", "개인", "금융투자", "연기금등"]:
        v = fut.get(k, 0)
        if isinstance(v, (int, float)):
            print(f"   {k:<10}: {v:>12,}")
