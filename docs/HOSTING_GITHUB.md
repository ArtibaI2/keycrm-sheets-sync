# Хостинг автооновлення на GitHub Actions + тригер із Google Таблиці

Синхронізація налаштована так, щоб запускатися:
1. **Автоматично 1 раз на день** (о 06:00 UTC / 08:00–09:00 за Києвом) через GitHub Actions.
2. **По кнопці прямо в Google Таблиці** (меню `🔄 Синхронізація -> 🚀 Оновити KeyCRM і Shopify зараз`).
3. **Автоматично при редагуванні таблиці** (із затримкою 2 хвилини після останньої правки, щоб не спамити запусками при введенні кількох розмірів підряд).

---

## Крок 1. Створити приватний репозиторій на GitHub і залити код

1. На [github.com](https://github.com/new) створіть **Private** репозиторій (наприклад, `keycrm-sheets-sync`).
2. У папці `keycrm-sheets-sync` виконайте:

```powershell
git init -b main
git add .
git commit -m "Initial KeyCRM + Shopify sync"
git remote add origin https://github.com/<ВАШ_ЛОГІН>/keycrm-sheets-sync.git
git push -u origin main
```

> Файл `.env` автоматично ігнорується через `.gitignore` і **ніколи** не потрапляє в GitHub.

---

## Крок 2. Додати секрети в GitHub Actions

Відкрийте у вашому репозиторії:  
**Settings → Secrets and variables → Actions**

### У вкладку `Secrets` (New repository secret):
Скопіюйте значення з локального `.env`:
- `KEYCRM_API_KEY` — токен KeyCRM
- `GOOGLE_SHEET_ID` — ID таблиці (`1_QE5yU5OJ5nBtAE5e11xLJjegedvGJjql5dtLLShDyU`)
- `SHOPIFY_CLIENT_ID` — Client ID застосунку Shopify
- `SHOPIFY_CLIENT_SECRET` — Client Secret застосунку Shopify
- *(лише якщо таблиця закрита за доступом)* `GOOGLE_SERVICE_ACCOUNT_JSON` — вміст JSON-ключа сервісного акаунта

### У вкладку `Variables` *(необов'язково — значення нижче вже стоять за замовчуванням у workflow)*:
- `GOOGLE_SHEET_GIDS` = `1934858652,1441866253,1265295383,1829566062,0,588886751`
- `KEYCRM_WAREHOUSE_KYIV_ID` = `1`
- `KEYCRM_WAREHOUSE_LUTSK_ID` = `1`
- `SHOPIFY_ENABLED` = `true`
- `SHOPIFY_STORE_DOMAIN` = `tnwtdg-rm.myshopify.com`
- `SHOPIFY_LOCATION_KYIV_ID` = `75696504907`
- `RESERVE_MODE` = `ignore`

Перевірити можна одразу: вкладка **Actions → Sync Google Sheets to KeyCRM & Shopify → Run workflow** (`dry_run: true`).

---

## Крок 3. Підключити кнопку й автозапуск у Google Таблиці

1. Створіть персональний токен GitHub ([Personal access tokens → Fine-grained tokens](https://github.com/settings/tokens?type=beta)):
   - **Repository access:** Only select repositories → `keycrm-sheets-sync`
   - **Permissions → Repository permissions → Actions:** `Read and write`
2. Відкрийте вашу Google Таблицю → **Розширення → Apps Script**.
3. Вставте код із [scripts/google-apps-script.gs](../scripts/google-apps-script.gs).
4. У функції `saveGithubSettings()` вкажіть свої `GITHUB_OWNER`, `GITHUB_REPO` та створений `GITHUB_TOKEN`, натисніть **Виконати (`saveGithubSettings`)** і дайте дозвіл скрипту.
5. Перезавантажте вкладку з Google Таблицею — у верхньому меню з'явиться пункт **🔄 Синхронізація**:
   - Натисніть **⚡ Увімкнути автозапуск при редагуванні**, щоб після правок у будь-якій із 6 вкладок синхронізація запускалася сама через 2 хвилини.
   - Або запускайте вручну пунктом **🚀 Оновити KeyCRM і Shopify зараз**.
