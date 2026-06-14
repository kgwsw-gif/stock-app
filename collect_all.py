"""
한국 증시 외국인/기관 매매동향 수집기 v5
- 네이버 금융 PC: 일별 투자자 매매동향
- bizdate 파라미터 필수 (오늘 날짜 자동 입력)
- 단위: 억원 → 원으로 변환 저장
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
    """억원 단위 문자열 → 정수. 콤마, +/-, 공백 처리. 음수 인식."""
    if s is None:
        return 0
    s = str(s).strip().replace(",", "").replace(" ", "").replace("+", "")
    if not s or s in ("-", "--"):
        return 0
    # 음수 부호와 숫자, 점만 남기기
    s = re.sub(r"[^\d\-\.]", "", s)
    if not s or s == "-":
        return 0
    try:
        return int(float(s))
    except ValueError:
        return 0


def fetch_naver_investor_market(sosok_code, market_name):
    """
    네이버 금융 일별 투자자 매매동향
    sosok_code: '01'=KOSPI, '02'=KOSDAQ
    """
    # bizdate를 오늘로 명시 (필수!)
    url = f"https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate={today_str}&sosok={sosok_code}&page=1"
    print(f"\n   [{market_name}] {url}")

    try:
        res = requests.get(url, headers=HEADERS, timeout=15)
        print(f"   HTTP {res.status_code}, {len(res.content)} bytes")

        if res.status_code != 200:
            print(f"   응답 본문 (처음 300자): {res.text[:300]}")
            return None

        res.encoding = "euc-kr"
        soup = BeautifulSoup(res.text, "html.parser")

        table = soup.find("table", summary=re.compile("일자별 순매수"))
        if table is None:
            print(f"   테이블 없음")
            return None

        rows = table.find_all("tr")
        print(f"   테이블 행 수: {len(rows)}")

        # 데이터 행 탐색 (날짜 형식 26.06.12 또는 2026.06.12)
        data_row = None
        for tr in rows:
            tds = tr.find_all("td")
            if len(tds) >= 10:
                first_text = tds[0].get_text(strip=True)
                # 날짜 패턴: YY.MM.DD 또는 YYYY.MM.DD
                if re.match(r"^\d{2,4}[.\-/]\d{1,2}[.\-/]\d{1,2}$", first_text):
                    data_row = tds
                    break

        if not data_row:
            print(f"   데이터 행 없음. tr 수: {len(rows)}")
            for i, tr in enumerate(rows[:8]):
                tds = tr.find_all("td")
                print(f"   행 {i} (td {len(tds)}개): {tr.get_text(strip=True)[:120]}")
            return None

        # 날짜 정규화 (26.06.12 → 20260612)
        date_str = data_row[0].get_text(strip=True)
        date_clean = re.sub(r"[^\d]", "", date_str)
        if len(date_clean) == 6:  # YYMMDD
            date_norm = "20" + date_clean
        else:
            date_norm = date_clean

        # 컬럼 인덱스
        # 0:날짜 1:개인 2:외국인 3:기관계 4:금융투자 5:보험 6:투신 7:은행 8:기타금융 9:연기금등 10:기타법인
        indiv = parse_int(data_row[1].get_text(strip=True))
        foreign = parse_int(data_row[2].get_text(strip=True))
        inst = parse_int(data_row[3].get_text(strip=True))
        finance = parse_int(data_row[4].get_text(strip=True))
        pension = parse_int(data_row[9].get_text(strip=True)) if len(data_row) > 9 else 0

        print(f"   날짜: {date_norm}")
        print(f"   개인:    {indiv:>10,} 억")
        print(f"   외국인:  {foreign:>10,} 억")
        print(f"   기관계:  {inst:>10,} 억")
        print(f"   금융투자:{finance:>10,} 억")
        print(f"   연기금등:{pension:>10,} 억")

        # 억원 → 원 (1억 = 1e8 원)
        return {
            "date": date_norm,
            "외국인합계": foreign * 100000000,
            "기관합계": inst * 100000000,
            "개인": indiv * 100000000,
            "금융투자": finance * 100000000,
            "연기금등": pension * 100000000,
        }

    except Exception as e:
        print(f"   {market_name} 예외: {type(e).__name__}: {e}")
        print(traceback.format_exc())
        return None


def fetch_naver_investor():
    print("=" * 60)
    print("Source 1: 네이버 금융 (투자자별 일별 매매동향)")
    print("=" * 60)

    kospi = fetch_naver_investor_market("01", "KOSPI")
    kosdaq = fetch_naver_investor_market("02", "KOSDAQ")

    if not kospi or not kosdaq:
        return None

    base_date = kospi.get("date") or kosdaq.get("date") or today_str
    return {
        "source": "naver",
        "base_date": base_date,
        "data": {"kospi": kospi, "kosdaq": kosdaq},
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
                       "개인": -174000000000, "금융투자": 34500000000, "연기금등": 5600000000}
        }
    }


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

if output["source"] == "naver":
    print(f"\n📊 KOSPI 요약 (억원)")
    for k, v in output["kospi"]["eok"].items():
        if isinstance(v, (int, float)):
            print(f"   {k:<10}: {v:>12,.1f}")
    print(f"\n📊 KOSDAQ 요약 (억원)")
    for k, v in output["kosdaq"]["eok"].items():
        if isinstance(v, (int, float)):
            print(f"   {k:<10}: {v:>12,.1f}")
