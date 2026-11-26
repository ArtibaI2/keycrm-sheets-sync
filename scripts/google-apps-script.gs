/**
 * Google Apps Script для автозапуску синхронізації (Google Таблиця -> GitHub Actions -> KeyCRM + Shopify)
 *
 * Як підключити:
 * 1. У Google Таблиці відкрийте: Розширення -> Apps Script.
 * 2. Вставте цей код замість стандартного.
 * 3. Заповніть GITHUB_OWNER, GITHUB_REPO і GITHUB_TOKEN у функції saveGithubSettings() або через Script Properties.
 * 4. Один раз запустіть функцію saveGithubSettings() (та надайте дозволи).
 * 5. Оновіть сторінку таблиці: зʼявиться меню "🔄 Синхронізація", де можна запускати синк вручну
 *    або увімкнути автозапуск при редагуванні.
 */

const WORKFLOW_FILE = "sync.yml";
const DEFAULT_BRANCH = "main";
// Затримка після останнього редагування (мс), щоб не запускати синк на кожну окрему клітинку
const EDIT_DEBOUNCE_MS = 2 * 60 * 1000;

// GID вкладок, зміни на яких мають запускати автооновлення
const WATCHED_SHEET_GIDS = new Set([
  1934858652,
  1441866253,
  1265295383,
  1829566062,
  0,
  588886751,
]);

function notify_(message) {
  Logger.log(message);
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (_) {
    // Runs safely from Apps Script editor IDE where getUi() is unavailable
  }
}

/**
 * Запустіть один раз вручну, щоб зберегти налаштування GitHub.
 */
function saveGithubSettings() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    GITHUB_OWNER: "YOUR_GITHUB_USERNAME",
    GITHUB_REPO: "keycrm-sheets-sync",
    GITHUB_TOKEN: "github_pat_REPLACE_ME", // Fine-grained PAT з правами Actions: Read & write
  });
  notify_("Налаштування GitHub збережено!");
}

function setupAll() {
  saveGithubSettings();
  setupEditTrigger();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🔄 Синхронізація")
    .addItem("🚀 Оновити KeyCRM і Shopify зараз", "menuRunSync")
    .addItem("🧪 Перевірка (Dry Run)", "menuRunDryRun")
    .addSeparator()
    .addItem("⚡ Увімкнути автозапуск при редагуванні", "setupEditTrigger")
    .addItem("⏸ Вимкнути автозапуск при редагуванні", "removeEditTriggers")
    .addToUi();
}

function menuRunSync() {
  triggerGithubSync(false);
  notify_(
    "Синхронізацію запущено на GitHub Actions!\nОновлення в KeyCRM і Shopify займе ~1–2 хвилини."
  );
}

function menuRunDryRun() {
  triggerGithubSync(true);
  notify_("Тестовий прогін (Dry Run) запущено в GitHub Actions.");
}

/**
 * Встановлює інстальований тригер onEdit (звичайний onEdit не має прав на UrlFetchApp).
 */
function setupEditTrigger() {
  removeEditTriggers();
  ScriptApp.newTrigger("onSheetEditInstallable")
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();
  notify_(
    "Автозапуск увімкнено! Після завершення правок у таблиці синк запуститься автоматично через 2 хвилини."
  );
}

function removeEditTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    const fn = t.getHandlerFunction();
    if (fn === "onSheetEditInstallable" || fn === "runDebouncedSync") {
      ScriptApp.deleteTrigger(t);
    }
  }
}

/**
 * Інстальований обробник змін у таблиці (debounce 2 хвилини).
 */
function onSheetEditInstallable(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (!WATCHED_SHEET_GIDS.has(sheet.getSheetId())) return;

  // Видаляємо попередній відкладений запуск і ставимо новий через 2 хв
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === "runDebouncedSync") {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger("runDebouncedSync")
    .timeBased()
    .after(EDIT_DEBOUNCE_MS)
    .create();
}

function runDebouncedSync() {
  // Прибираємо одноразові time-based тригери
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === "runDebouncedSync") {
      ScriptApp.deleteTrigger(t);
    }
  }
  triggerGithubSync(false);
}

function triggerGithubSync(dryRun) {
  const props = PropertiesService.getScriptProperties();
  const owner = props.getProperty("GITHUB_OWNER");
  const repo = props.getProperty("GITHUB_REPO");
  const token = props.getProperty("GITHUB_TOKEN");

  if (!owner || !repo || !token || token.includes("REPLACE_ME")) {
    throw new Error("Спочатку заповніть GITHUB_OWNER, GITHUB_REPO та GITHUB_TOKEN у saveGithubSettings().");
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    payload: JSON.stringify({
      ref: DEFAULT_BRANCH,
      inputs: {
        dry_run: Boolean(dryRun),
        sku: "",
      },
    }),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`GitHub dispatch failed (${code}): ${resp.getContentText()}`);
  }
}
