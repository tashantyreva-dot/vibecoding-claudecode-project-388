#!/usr/bin/env node
'use strict';

/*
 * run-tracker.js — оркестратор трекера цен поверх готового extract-price.
 *
 * Что делает:
 *   1. Читает products.yaml (источники, max_price) и notify.yaml (chat_id).
 *   2. Для каждого источника вызывает `node scripts/extract.js <url>` и собирает
 *      объявления. Сохраняет status: "ok" / "error" по источнику (по коду выхода
 *      extract.js), чтобы упавший источник не выглядел как «всё пропало».
 *   3. Собирает единый прогон и пишет его в --out (локальный файл). В GitHub этот
 *      файл кладёт вызывающий скилл tracker через GitHub MCP — Node не умеет MCP.
 *   4. Сравнивает с прошлым прогоном (--prev) и определяет значимые изменения:
 *        • новый url                 → 🆕 значимо
 *        • тот же url, цена ниже      → 📉 значимо
 *        • тот же url, цена выросла   → не значимо
 *        • url пропал                 → не значимо (логируем)
 *      Диффать источник можно, только если в ОБОИХ прогонах у него status "ok".
 *   5. Если прошлого прогона нет вообще — это fresh-старт: все найденные объявления
 *      показываются как есть, с пометкой «первый прогон».
 *   6. При наличии значимых изменений — шлёт сообщение в Telegram (формат из
 *      KNOWLEDGE.md). Токен — только из env TELEGRAM_BOT_TOKEN, не из репозитория.
 *
 * Запуск (пути — локальные файлы, которые скилл заранее выкачал через GitHub MCP):
 *   node scripts/run-tracker.js \
 *     --products <products.yaml> \
 *     --notify   <notify.yaml> \
 *     --prev     <прошлый-прогон.json | ""> \
 *     --out      <куда-записать-новый-прогон.json> \
 *     [--date YYYY-MM-DD]      (по умолчанию — сегодня)
 *     [--extract scripts/extract.js]
 *     [--send scripts/send.py]  (скрипт доставки в Telegram)
 *     [--dry-run]              (посчитать и собрать сообщение, но НЕ слать Telegram)
 *
 * В stdout печатается JSON-сводка (diff + результат Telegram + путь к прогону) —
 * её читает скилл, чтобы решить, что писать в GitHub и что показать пользователю.
 * Ход выполнения по-человечески пишется в stderr.
 *
 * Коды выхода:
 *   0  — прогон отработал (в т.ч. когда часть источников упала — это не фатально);
 *   1  — фатальная ошибка вызова/конфига (нет аргументов, битый products.yaml);
 *   2  — нужно было отправить Telegram, но TELEGRAM_BOT_TOKEN не задан / ошибка сети.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ─────────────────────────── аргументы ───────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--products': args.products = argv[++i]; break;
      case '--notify': args.notify = argv[++i]; break;
      case '--prev': args.prev = argv[++i]; break;
      case '--out': args.out = argv[++i]; break;
      case '--date': args.date = argv[++i]; break;
      case '--extract': args.extract = argv[++i]; break;
      case '--send': args.send = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      default:
        die(1, `Неизвестный аргумент: ${a}`);
    }
  }
  return args;
}

function die(code, message) {
  process.stderr.write(`[run-tracker] ОШИБКА: ${message}\n`);
  process.exit(code);
}

function log(message) {
  process.stderr.write(`[run-tracker] ${message}\n`);
}

// ───────────────────── минимальный YAML под наши файлы ─────────────────────
// Полноценный YAML нам не нужен: products.yaml — это map с ключами search/sources,
// где sources — список map'ов; notify.yaml — map telegram.chat_id. Парсим ровно
// это, игнорируя комментарии и пустые строки. Значения — строки/числа/null.

function stripComment(line) {
  // убираем хвостовой комментарий, не трогая '#' внутри кавычек
  let inStr = false;
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inStr) {
      if (c === quote) inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function coerce(raw) {
  let v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/** Разбирает products.yaml → { max_price, sources: [{id,label,url,site,...}] }. */
function parseProducts(text) {
  const lines = text.split(/\r?\n/);
  const result = { search: {}, sources: [] };
  let section = null; // 'search' | 'sources'
  let current = null; // текущий элемент списка sources

  for (const rawLine of lines) {
    const line = stripComment(rawLine).replace(/\s+$/, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (indent === 0) {
      const m = body.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!m) continue;
      section = m[1];
      if (section === 'search') result.search = {};
      if (section === 'sources') { result.sources = []; current = null; }
      continue;
    }

    if (section === 'search') {
      const m = body.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (m) result.search[m[1]] = coerce(m[2]);
      continue;
    }

    if (section === 'sources') {
      if (body.startsWith('- ')) {
        current = {};
        result.sources.push(current);
        const rest = body.slice(2);
        const m = rest.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (m && current) current[m[1]] = coerce(m[2]);
      } else if (current) {
        const m = body.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (m) current[m[1]] = coerce(m[2]);
      }
    }
  }
  return result;
}

/** Разбирает notify.yaml → { chat_id }. */
function parseNotify(text) {
  const lines = text.split(/\r?\n/);
  const out = {};
  for (const rawLine of lines) {
    const line = stripComment(rawLine);
    const m = line.match(/^\s*chat_id:\s*(.+?)\s*$/);
    if (m) out.chat_id = coerce(m[1]);
  }
  return out;
}

// ───────────────────────── вызов extract-price ─────────────────────────

/**
 * Запускает `node <extract> <url>` и приводит результат к
 * { status, listings, error }. Опирается на КОД ВЫХОДА extract.js:
 *   0 → ok (stdout = JSON-массив, в т.ч. пустой);
 *   1/2/3 → error (текст причины берём из stderr).
 */
function runExtract(extractPath, url) {
  const res = spawnSync(process.execPath, [extractPath, url], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) {
    return { status: 'error', listings: [], error: `не удалось запустить extract.js: ${res.error.message}` };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || '').trim();
    return {
      status: 'error',
      listings: [],
      error: stderr || `extract.js завершился с кодом ${res.status}`,
    };
  }

  let listings;
  try {
    listings = JSON.parse((res.stdout || '').trim() || '[]');
  } catch (e) {
    return { status: 'error', listings: [], error: `не удалось разобрать вывод extract.js: ${e.message}` };
  }
  if (!Array.isArray(listings)) {
    return { status: 'error', listings: [], error: 'extract.js вернул не массив' };
  }
  return { status: 'ok', listings, error: null };
}

// ───────────────────────────── diff ─────────────────────────────

function indexByUrl(listings) {
  const map = new Map();
  for (const l of listings || []) {
    if (l && l.url) map.set(l.url, l);
  }
  return map;
}

/**
 * Сравнивает текущий прогон с прошлым.
 * Возвращает { firstRun, changes: [{type, source, listing, oldPrice?}], disappeared, skipped }.
 *   type: 'fresh' | 'new' | 'drop'
 * Диффать источник можно, только если он "ok" и в текущем, и в прошлом прогоне.
 */
function computeDiff(currentRun, prevRun) {
  const changes = [];
  const disappeared = [];
  const skipped = [];

  if (!prevRun) {
    // fresh-старт: показываем все объявления из успешных источников как есть
    for (const src of currentRun.sources) {
      if (src.status !== 'ok') continue;
      for (const listing of src.listings) {
        changes.push({ type: 'fresh', source: src.id, url: src.url, listing });
      }
    }
    return { firstRun: true, changes, disappeared, skipped };
  }

  const prevById = new Map(prevRun.sources.map((s) => [s.id, s]));

  for (const src of currentRun.sources) {
    const prev = prevById.get(src.id);
    // Диффать можно только если статус ok в обоих прогонах.
    if (src.status !== 'ok' || !prev || prev.status !== 'ok') {
      skipped.push({
        source: src.id,
        reason: src.status !== 'ok'
          ? `текущий прогон: ${src.status}`
          : !prev
            ? 'источника не было в прошлом прогоне'
            : `прошлый прогон: ${prev.status}`,
      });
      continue;
    }

    const prevByUrl = indexByUrl(prev.listings);
    const curByUrl = indexByUrl(src.listings);

    for (const [url, listing] of curByUrl) {
      const before = prevByUrl.get(url);
      if (!before) {
        changes.push({ type: 'new', source: src.id, url: src.url, listing });
      } else if (
        typeof listing.price === 'number' &&
        typeof before.price === 'number' &&
        listing.price < before.price
      ) {
        changes.push({
          type: 'drop', source: src.id, url: src.url, listing, oldPrice: before.price,
        });
      }
      // цена та же или выросла → не значимо
    }

    for (const [url, listing] of prevByUrl) {
      if (!curByUrl.has(url)) {
        disappeared.push({ source: src.id, url, listing });
      }
    }
  }

  return { firstRun: false, changes, disappeared, skipped };
}

// ─────────────────────── формат Telegram-сообщения ───────────────────────

function sourceName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function fmtNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?';
  // разряды разделяем неразрывным пробелом: «1 100 000»
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** «1 100 000 ₽, 2012 г., 142 632 км» — части с null опускаются. */
function fmtMeta(listing) {
  const parts = [`${fmtNum(listing.price)} ₽`];
  if (typeof listing.year === 'number') parts.push(`${listing.year} г.`);
  if (typeof listing.mileage === 'number') parts.push(`${fmtNum(listing.mileage)} км`);
  return parts.join(', ');
}

function buildMessage(diff, date) {
  if (diff.changes.length === 0) return null;

  const d = formatDateRu(date);
  const lines = [];

  if (diff.firstRun) {
    lines.push(`🚗 Первый прогон трекера MINI Countryman (${d}). Найденные объявления под бюджет:`);
  } else {
    lines.push(`🚗 Значимые изменения — MINI Countryman (${d}):`);
  }
  lines.push('');

  // сначала новые (🆕 / fresh), затем подешевевшие (📉)
  const news = diff.changes.filter((c) => c.type === 'new' || c.type === 'fresh');
  const drops = diff.changes.filter((c) => c.type === 'drop');

  for (const c of news) {
    lines.push(`🆕 ${sourceName(c.url)} — ${fmtMeta(c.listing)}`);
    lines.push(`   ${c.listing.url}`);
    lines.push('');
  }
  for (const c of drops) {
    lines.push(
      `📉 ${sourceName(c.url)} — ${fmtNum(c.listing.price)} ₽ (было ${fmtNum(c.oldPrice)} ₽)` +
        `${typeof c.listing.year === 'number' ? `, ${c.listing.year} г.` : ''}` +
        `${typeof c.listing.mileage === 'number' ? `, ${fmtNum(c.listing.mileage)} км` : ''}`
    );
    lines.push(`   ${c.listing.url}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

function formatDateRu(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

// ───────────────────────────── Telegram ─────────────────────────────
// Доставка вынесена в отдельный Python-скрипт send.py (только stdlib): tracker
// не дублирует HTTP-логику, а вызывает `python send.py <текст>`. chat_id берём
// из notify.yaml и передаём через окружение (TELEGRAM_CHAT_ID); токен —
// TELEGRAM_BOT_TOKEN — наследуется из окружения процесса.

/** Находит доступный интерпретатор Python. Возвращает имя или null. */
function findPython() {
  for (const cand of ['python', 'py', 'python3']) {
    const r = spawnSync(cand, ['--version'], { encoding: 'utf8', timeout: 15000 });
    if (!r.error && r.status === 0 && /Python\s+3\./.test((r.stdout || '') + (r.stderr || ''))) {
      return cand;
    }
  }
  return null;
}

/**
 * Отправляет текст через send.py. Бросает Error с понятным текстом, если Python
 * не найден или send.py завершился ненулевым кодом (нет токена/сети/Telegram отклонил).
 */
function sendViaSendPy(sendScript, chatId, text) {
  const py = findPython();
  if (!py) {
    throw new Error('не найден интерпретатор Python (python/py/python3) для запуска send.py');
  }
  const r = spawnSync(py, [sendScript, text], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, TELEGRAM_CHAT_ID: String(chatId) },
  });
  if (r.error) {
    throw new Error(`не удалось запустить send.py: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || `send.py завершился с кодом ${r.status}`).trim());
  }
  return (r.stdout || '').trim();
}

// ────────────────────────────── main ──────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (!args.products) die(1, 'не задан --products <path>');
  if (!args.out) die(1, 'не задан --out <path>');

  const date = args.date || new Date().toISOString().slice(0, 10);
  const extractPath = args.extract || path.join(__dirname, 'extract.js');
  if (!fs.existsSync(extractPath)) die(1, `не найден extract.js: ${extractPath}`);

  // 1. Конфиг источников
  let products;
  try {
    products = parseProducts(fs.readFileSync(args.products, 'utf8'));
  } catch (e) {
    die(1, `не удалось прочитать products.yaml: ${e.message}`);
  }
  if (!products.sources.length) die(1, 'в products.yaml нет источников (sources)');

  // 2. Обход источников
  // products.yaml — авторитетный источник бюджета: extract.js фильтрует по своему
  // порогу, но окончательный отсев по max_price делаем здесь, чтобы изменение
  // products.yaml применялось без правки extract.js.
  const maxPrice = typeof products.search.max_price === 'number' ? products.search.max_price : null;
  log(`Прогон за ${date}. Источников: ${products.sources.length}.` +
    (maxPrice != null ? ` Бюджет < ${maxPrice} ₽.` : ''));
  const sources = [];
  for (const s of products.sources) {
    if (!s.id || !s.url) {
      log(`пропущен источник без id/url: ${JSON.stringify(s)}`);
      continue;
    }
    log(`→ ${s.id}: ${s.url}`);
    const r = runExtract(extractPath, s.url);
    if (r.status === 'ok' && maxPrice != null) {
      const before = r.listings.length;
      r.listings = r.listings.filter((l) => typeof l.price === 'number' && l.price < maxPrice);
      if (r.listings.length !== before) {
        log(`  (по бюджету отсеяно ${before - r.listings.length})`);
      }
    }
    if (r.status === 'ok') {
      log(`  ok: объявлений под бюджет — ${r.listings.length}`);
    } else {
      log(`  error: ${r.error}`);
    }
    sources.push({
      id: s.id,
      url: s.url,
      status: r.status,
      ...(r.status === 'error' ? { error: r.error } : {}),
      listings: r.listings,
    });
  }

  const run = { date, sources };

  // 3. Пишем прогон в локальный файл (в GitHub его положит скилл через MCP)
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(run, null, 2) + '\n', 'utf8');
  log(`Прогон записан: ${args.out}`);

  // 4. Прошлый прогон + diff
  let prevRun = null;
  if (args.prev && args.prev.trim() !== '') {
    try {
      prevRun = JSON.parse(fs.readFileSync(args.prev, 'utf8'));
    } catch (e) {
      die(1, `не удалось прочитать прошлый прогон (--prev ${args.prev}): ${e.message}`);
    }
  }
  const diff = computeDiff(run, prevRun);

  log(
    `Diff: firstRun=${diff.firstRun}, значимых=${diff.changes.length} ` +
      `(новых=${diff.changes.filter((c) => c.type !== 'drop').length}, ` +
      `подешевевших=${diff.changes.filter((c) => c.type === 'drop').length}), ` +
      `пропало=${diff.disappeared.length}, источников-пропущено=${diff.skipped.length}`
  );

  const message = buildMessage(diff, date);

  // 5. Telegram
  const telegram = { willSend: !!message, sent: false, dryRun: !!args.dryRun, message: message || null };
  if (message && !args.dryRun) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token.trim() === '') {
      // Значимые изменения есть, но токена нет — это не «тихо пропустить», а явный отказ.
      process.stdout.write(JSON.stringify({ date, runPath: args.out, run, diff, telegram }, null, 2) + '\n');
      die(2, 'TELEGRAM_BOT_TOKEN не задан — есть значимые изменения, но отправить в Telegram нечем. ' +
        'Задайте переменную окружения TELEGRAM_BOT_TOKEN и повторите запуск.');
    }
    let notify;
    try {
      notify = parseNotify(fs.readFileSync(args.notify, 'utf8'));
    } catch (e) {
      die(1, `не удалось прочитать notify.yaml: ${e.message}`);
    }
    if (notify.chat_id == null) die(1, 'в notify.yaml нет telegram.chat_id');

    const sendScript = args.send || path.join(__dirname, 'send.py');
    if (!fs.existsSync(sendScript)) die(1, `не найден send.py: ${sendScript}`);

    try {
      const out = sendViaSendPy(sendScript, notify.chat_id, message);
      telegram.sent = true;
      log(`Telegram (send.py): ${out || 'отправлено'} → chat_id ${notify.chat_id}.`);
    } catch (e) {
      process.stdout.write(JSON.stringify({ date, runPath: args.out, run, diff, telegram }, null, 2) + '\n');
      die(2, e.message);
    }
  } else if (!message) {
    log('Значимых изменений нет — Telegram не шлём (это ожидаемо, не ошибка).');
  } else {
    log('Dry-run: сообщение собрано, но НЕ отправлено (--dry-run).');
  }

  // 6. Машиночитаемая сводка для скилла
  process.stdout.write(JSON.stringify({ date, runPath: args.out, run, diff, telegram }, null, 2) + '\n');
}

main().catch((e) => die(1, `непредвиденная ошибка: ${e && e.stack ? e.stack : e}`));
