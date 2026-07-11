"""
Klever image scraper — версия «со всего интернета»
--------------------------------------------------
Для каждого товара без фото ищет картинку по названию через Google Custom Search
(searchType=image), берёт лучший результат, заливает в Supabase Storage и пишет
public URL в товар. Плюс генерит report.html для визуальной проверки матчинга.

Устойчивость:
  - пропускает товары, у которых фото уже есть (перезапускаемо)
  - DRY_RUN: прогон без записи, только собрать report.html и посмотреть что нашлось
  - вежливые паузы, лог промахов в not_found.csv

Запуск:
  pip install requests supabase
  python klever_image_scraper_web.py

--- НАСТРОЙКА GOOGLE (5 минут, разово) ---
1. https://console.cloud.google.com/ -> создай проект -> включи "Custom Search API".
2. Там же -> "Credentials" -> создай API key -> вставь в GOOGLE_API_KEY.
3. https://programmablesearchengine.google.com/ -> "Add" -> в настройках включи
   "Search the entire web" и "Image search" (ON). Скопируй "Search engine ID" (cx)
   -> вставь в GOOGLE_CX.
Бесплатно 100 запросов/день; сверх — ~$5 за 1000 (весь каталог ~$4).
"""

import csv
import re
import time
import html
import requests
from urllib.parse import quote
from supabase import create_client

# ============================================================
# КОНФИГ
# ============================================================

SUPABASE_URL = "https://ТВОЙ-ПРОЕКТ.supabase.co"
SUPABASE_KEY = "ТВОЙ-SERVICE-ROLE-KEY"    # service_role (нужны права на запись + storage)
BUCKET       = "product-images"           # публичный бакет, создай заранее

TABLE     = "products"
COL_ID    = "id"
COL_NAME  = "name"
COL_IMAGE = "image_url"

GOOGLE_API_KEY = "ТВОЙ-GOOGLE-API-KEY"
GOOGLE_CX      = "ТВОЙ-SEARCH-ENGINE-ID"

DELAY      = 1.0      # пауза между товарами (сек)
DRY_RUN    = True     # True = не пишем в БД/Storage, только собираем report.html
LIMIT      = 10       # None = все; начни с 10 для проверки
CANDIDATES = 3        # сколько вариантов фото показывать в отчёте на каждый товар

# ============================================================
# ПОИСК ФОТО ПО ВСЕМУ ВЕБУ (Google Custom Search, image mode)
# ============================================================

def clean_query(name):
    """Чистим название под поиск: убираем скобки с фасовкой, режем до сути."""
    q = re.sub(r"\([^)]*\)", " ", name)          # выкинуть (50 шт.), (430) и т.п.
    q = re.sub(r"[^\w\s./-]", " ", q, flags=re.U)
    q = re.sub(r"\s+", " ", q).strip()
    return " ".join(q.split()[:8])               # первые ~8 слов — самое важное

def image_search(query, num=5):
    """Возвращает список прямых URL картинок (лучшие сначала)."""
    url = (
        "https://www.googleapis.com/customsearch/v1"
        f"?key={GOOGLE_API_KEY}&cx={GOOGLE_CX}"
        f"&searchType=image&num={num}&safe=off&imgType=photo"
        f"&q={quote(query)}"
    )
    r = requests.get(url, timeout=20)
    r.raise_for_status()
    items = r.json().get("items", [])
    return [it["link"] for it in items if it.get("link")]

# ============================================================
# ЯДРО — скачать, залить в Storage, записать URL
# ============================================================

def slugify(text):
    text = re.sub(r"[^\w\-]+", "-", text.strip().lower())
    return re.sub(r"-+", "-", text).strip("-")[:80] or "item"

def download_image(img_url):
    r = requests.get(img_url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    ct = r.headers.get("Content-Type", "image/jpeg")
    ext = ".png" if "png" in ct else ".webp" if "webp" in ct else ".jpg"
    return r.content, ct, ext

def upload_to_supabase(sb, img_bytes, ct, path):
    sb.storage.from_(BUCKET).upload(path, img_bytes, {"content-type": ct, "upsert": "true"})
    return sb.storage.from_(BUCKET).get_public_url(path)

def update_product(sb, pid, public_url):
    sb.table(TABLE).update({COL_IMAGE: public_url}).eq(COL_ID, pid).execute()

# ============================================================
# ОТЧЁТ — HTML-галерея для проверки глазами
# ============================================================

def write_report(rows):
    """rows: list of dict(name, chosen, candidates[], status)"""
    cards = []
    for r in rows:
        thumbs = "".join(
            f'<img src="{html.escape(u)}" style="height:90px;margin:2px;'
            f'border:{"3px solid #2a7" if u==r["chosen"] else "1px solid #ccc"};'
            f'border-radius:6px;object-fit:contain;background:#fff">'
            for u in r["candidates"]
        ) or '<span style="color:#c33">— ничего не найдено —</span>'
        cards.append(
            f'<div style="border-bottom:1px solid #eee;padding:12px 0">'
            f'<div style="font-size:14px;margin-bottom:6px">{html.escape(r["name"])}</div>'
            f'<div style="display:flex;flex-wrap:wrap;align-items:center">{thumbs}</div>'
            f'</div>'
        )
    doc = (
        '<!doctype html><meta charset="utf-8"><title>Проверка фото</title>'
        '<div style="font-family:system-ui;max-width:900px;margin:20px auto">'
        '<h2>Проверка подобранных фото</h2>'
        '<p style="color:#666">Зелёная рамка — что уйдёт в каталог. '
        'Если выбрано не то — поправь название товара или подставь фото вручную.</p>'
        + "".join(cards) + '</div>'
    )
    with open("report.html", "w", encoding="utf-8") as f:
        f.write(doc)
    print("Отчёт: report.html")

# ============================================================
# MAIN
# ============================================================

def main():
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    res = (sb.table(TABLE)
             .select(f"{COL_ID},{COL_NAME},{COL_IMAGE}")
             .is_(COL_IMAGE, "null")
             .execute())
    products = res.data or []
    if LIMIT:
        products = products[:LIMIT]

    print(f"К обработке: {len(products)} товаров. DRY_RUN={DRY_RUN}\n")

    report_rows, not_found, ok = [], [], 0

    for i, p in enumerate(products, 1):
        pid, name = p[COL_ID], p[COL_NAME]
        try:
            candidates = image_search(clean_query(name), num=CANDIDATES)
            if not candidates:
                print(f"[{i}] ✗ не найдено: {name}")
                not_found.append((pid, name, "no_results"))
                report_rows.append({"name": name, "chosen": None, "candidates": []})
                continue

            chosen = candidates[0]
            print(f"[{i}] ✓ {name}\n       -> {chosen}")
            report_rows.append({"name": name, "chosen": chosen, "candidates": candidates})

            if not DRY_RUN:
                img_bytes, ct, ext = download_image(chosen)
                path = f"{pid}-{slugify(name)}{ext}"
                public_url = upload_to_supabase(sb, img_bytes, ct, path)
                update_product(sb, pid, public_url)

            ok += 1

        except Exception as e:
            print(f"[{i}] ! ошибка на «{name}»: {e}")
            not_found.append((pid, name, f"error: {e}"))

        time.sleep(DELAY)

    write_report(report_rows)

    if not_found:
        with open("not_found.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["id", "name", "reason"])
            w.writerows(not_found)
        print(f"Промахи ({len(not_found)}) -> not_found.csv")

    print(f"\nГотово. Успешно: {ok} / {len(products)}")

if __name__ == "__main__":
    main()
