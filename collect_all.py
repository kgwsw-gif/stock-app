"""
한국 증시 외국인/기관 매매동향 통합 수집기 v2
"""
from datetime import datetime, timezone, timedelta
import json
import time
import os
import traceback

KST = timezone(timedelta(hours=9))
now_kst = datetime.now(KST)
today_str = now_kst.strftime("%Y%m%d")
print(f"현재(KST): {now_kst.strftime('%Y-%m-%d %H:%M:%S')}")


def find_row(df, candidates):
    for name in candidates:
        if name in df.index:
            return name
    return None


def find_col(df, candidates):
    for name in candidates:
        if name in df.columns:
            return name
    return None


def try_pykrx():
    print("=" * 60)
    print("Source 1: pykrx (KRX 공식)")
    print("=" * 60)
    try:
        from pykrx import stock
        print("   pykrx import 성공")

        d = datetime.strptime(today_str, "%Y%m%d")
        last_bday = None
        for i in range(15):
            ds = d.strftime("%Y%m%d")
            try:
                df_test = stock.get_market_ohlcv(ds, market="KOSPI")
                if df_test is not None and not df_test.empty:
                    last_bday = ds
                    break
            except Exception as e:
                print(f"   {ds} OHLCV 시도 실패: {type(e).__name__}: {e}")
            d -= timedelta(days=1)
            time.sleep(0.3)

        if not last_bday:
            print("   영업일 탐색 실패")
            return None

        print(f"   영업일: {last_bday}")

        result = {}
        for market in ("KOSPI", "KOSDAQ"):
            print(f"\n   [{market}] 투자자별 매매 조회...")
            df = stock.get_market_trading_value_by_investor(last_bday, last_bday, market)

            if df is None or df.empty:
                print(f"   {market} 빈 응답")
                return None

            print(f"   DataFrame shape: {df.shape}")
            print(f"   인덱스: {list(df.index)}")
            print(f"   컬럼: {list(df.columns)}")

            col_buy = find_col(df, ["순매수", "순매수거래대금", "거래대금"])
            if col_buy is None:
                print(f"   순매수 컬럼 없음")
                return None

            row_foreign = find_row(df, ["외국인합계", "외국인", "기타외국인"])
            row_inst = find_row(df, ["기관합계", "기관"])
            row_indiv = find_row(df, ["개인"])
            row_finance = find_row(df, ["금융투자"])
            row_pension = find_row(df, ["연기금등", "연기금", "연기금 등"])

            def get(row):
                if row is None or row not in df.index:
                    return 0
                try:
                    return int(df.loc[row, col_buy])
                except Exception:
                    return 0

            foreign_total = get(row_foreign)
            if row_foreign == "외국인" and "기타외국인" in df.index:
                try:
                    foreign_total += int(df.loc["기타외국인", col_buy])
                except Exception:
                    pass

            result[market.lower()] = {
                "date": last_bday,
                "외국인합계": foreign_total,
                "기관합계": get(row_inst),
                "개인": get(row_indiv),
                "금융투자": get(row_finance),
                "연기금등": get(row_pension),
            }
            print(f"   {market}: 외국인 {foreign_total:>15,} 원, 기관 {get(row_inst):>15,} 원")

        return {"source": "pykrx", "data": result, "base_date": last_bday}

    except ImportError as e:
        print(f"   pykrx import 실패: {e}")
        return None
    except Exception as e:
        print(f"   pykrx 예외: {type(e).__name__}: {e}")
        print(traceback.format_exc())
        return None


def use_mock():
    print("\n" + "=" * 60)
    print("Source 3: MOCK 데이터")
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


data = try_pykrx() or use_mock()


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
