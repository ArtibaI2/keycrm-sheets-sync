# Google Sheets → KeyCRM (→ Shopify) Sync

Скрипт на Node.js для синхронізації товарів, розмірних варіантів (`Offer`) та залишків по складах **Київ** і **Луцьк** з Google-таблиці в **KeyCRM** (з опціональним прямим створенням нових товарів у **Shopify**).

## Можливості
- Парсинг комбінованих розмірів і кількостей із однієї клітинки: `"1XS 1S"`, `"2M, 3L"`, `"1 2XL"`, `"XS:1 S:2"`, `"5"` (для товарів без розмірів).
- Окреме оновлення залишків по складах Київ та Луцьк через `PUT /offers/stocks`.
- Захист від подвійного списання резерву (`RESERVE_MODE=ignore | subtract_kyiv | subtract_lutsk | subtract_proportional`).
- Контроль ліміту KeyCRM OpenAPI (до 20 запитів/хв) + автоматичний retry при `429`/`5xx`.
- Безпечний режим перевірки: `--dry-run` та тест на одному артикулі `--sku=...`.

## Швидкий старт

1. Скопіюйте конфігураційні файли:
   ```bash
   cp .env.example .env
   cp config.example.json config.json
   ```
2. Вкажіть `KEYCRM_API_KEY` у `.env` і знайдіть ID складів Київ / Луцьк:
   ```bash
   npm run discover
   ```
   Запишіть отримані ID у `KEYCRM_WAREHOUSE_KYIV_ID` та `KEYCRM_WAREHOUSE_LUTSK_ID`.
3. Налаштуйте доступ до Google-таблиці в `.env` (Service Account JSON для приватної таблиці або CSV-URL) і перевірте назви колонок у `config.json`.
4. Перевірте на тестовому файлі або на одному артикулі без змін у CRM (`--dry-run`):
   ```bash
   npm run dry-run -- --file=examples/sample-sheet.csv
   npm run dry-run -- --sku=EZRA-XS
   ```
5. Запустіть реальну синхронізацію спочатку для 1 артикула, потім для всієї таблиці:
   ```bash
   npm run sync -- --sku=EZRA
   npm run sync
   ```

## Про Shopify
- Вбудована інтеграція **KeyCRM → Shopify** оновлює **лише залишки** для товарів, які вже є на Shopify і прив'язані в розділі «Каталог → Публікації» за артикулом (`sku`).
- Якщо потрібно, щоб скрипт також **одразу створював нові картки товарів у Shopify**, встановіть `SHOPIFY_ENABLED=true` і заповніть `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_LOCATION_KYIV_ID`, `SHOPIFY_LOCATION_LUTSK_ID` у `.env`.
