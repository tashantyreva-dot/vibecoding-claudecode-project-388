#!/usr/bin/env node
'use strict';

/*
 * extract.js — извлекает объявления о продаже MINI Countryman со страницы источника.
 *
 * Запуск:   node scripts/extract.js <URL>
 * Вывод:    JSON-массив в stdout, например
 *           [{ "price": 1100000, "year": 2012, "mileage": 142632, "url": "https://..." }]
 *
 * Только объявления с ценой < MAX_PRICE (1 200 000 ₽) и только модель Countryman.
 *
 * Коды выхода:
 *   0  — успех (в т.ч. пустой массив [], если подходящих объявлений нет);
 *   1  — ошибка использования (не передан URL и т.п.);
 *   2  — страница не загрузилась (сеть/таймаут/навигация);
 *   3  — источник заблокировал доступ (антибот / капча / 403 / карточки не найдены).
 *
 * Ошибки уровня 2/3 пишутся в stderr понятным текстом — чтобы вызывающий скилл
 * tracker не принял пустой результат за «ничего не нашлось».
 */

const { chromium } = require('playwright');

const MAX_PRICE = 1200000; // строго меньше — порог из products.yaml
const TARGET_MODEL = 'countryman';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

// Признаки того, что источник отдал заглушку/блок, а не список объявлений.
const BLOCK_MARKERS = [
  'не робот', // ловит и «Вы не робот?», и «Я не робот», и «подтвердите, что вы не робот»
  'проверка безопасности',
  'доступ ограничен',
  'доступ заблокирован',
  'не предназначен для вашего региона',
  'captcha',
  'smartcaptcha',
  'checking your browser',
  'ddos',
];

// Признаки честно пустого списка (объявлений действительно нет).
const EMPTY_MARKERS = [
  'ничего не найдено',
  'нет объявлений',
  'по вашему запросу ничего',
  'не найдено ни одного',
];

/**
 * Конфигурация парсинга по хосту. Каждая запись описывает:
 *   waitSelector — селектор карточки, появления которого ждём (для JS-рендера);
 *   scrape       — функция, исполняемая в контексте страницы, возвращает массив
 *                  «сырых» записей { url, priceText, metaText, model }.
 */
const SITES = [
  {
    match: 'rolf.ru',
    waitSelector: 'article.car-card-new',
    scrape: () => {
      const out = [];
      document.querySelectorAll('article.car-card-new').forEach((card) => {
        const a = card.querySelector('a[href*="/cars/used/mini/"]');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/mini\/([a-z0-9-]+)\//i);
        const priceEl = card.querySelector('.car-card-new__price--price');
        out.push({
          url: a.href,
          priceText: priceEl ? priceEl.textContent : '',
          metaText: card.innerText || '',
          model: m ? m[1] : '',
        });
      });
      return out;
    },
  },
  {
    match: 'avtodom.ru',
    waitSelector: '.card',
    scrape: () => {
      const out = [];
      document.querySelectorAll('.card').forEach((card) => {
        const a = card.querySelector('a[href*="/catalog/"]');
        if (!a) return;
        const title = card.querySelector('.card__title');
        const priceEl = card.querySelector('.card__price');
        const descEl = card.querySelector('.card__description');
        out.push({
          url: a.href,
          priceText: priceEl ? priceEl.textContent : '',
          metaText: descEl ? descEl.textContent : card.innerText || '',
          model: title ? title.textContent : '',
        });
      });
      return out;
    },
  },
  {
    match: 'major-expert.ru',
    waitSelector: 'a.car-card',
    scrape: () => {
      const out = [];
      document.querySelectorAll('a.car-card').forEach((card) => {
        const href = card.getAttribute('href') || '';
        const m = href.match(/\/mini\/([a-z0-9-]+)\//i);
        const priceEl = card.querySelector('.car-card__price');
        const metaEl = card.querySelector('.title-content');
        out.push({
          url: card.href,
          priceText: priceEl ? priceEl.textContent : '',
          metaText: metaEl ? metaEl.textContent : card.innerText || '',
          model: m ? m[1] : '',
        });
      });
      return out;
    },
  },
  {
    match: 'auto.ru',
    // ссылки на карточки — стабильный якорь, классы у auto.ru хешированные
    waitSelector: 'a[href*="/sale/mini/countryman/"]',
    scrape: () => {
      const out = [];
      const seen = new Set();
      document
        .querySelectorAll('a[href*="/sale/mini/countryman/"]')
        .forEach((a) => {
          const card =
            a.closest('[class*="ListingItemUniversal__snippet"]') ||
            a.closest('[class*="ListingItem"]');
          if (!card || seen.has(card)) return;
          seen.add(card);
          // Цена у большинства карточек auto.ru есть только в общем тексте карточки.
          // Берём первую цену «N ₽» ПОСЛЕ пробега (км) — это цена продавца;
          // так мы не ловим «… ₽ со скидками» и суммы кредита/трейд-ина, идущие ниже.
          const text = card.innerText || '';
          const kmIdx = text.search(/км/);
          const after = kmIdx >= 0 ? text.slice(kmIdx) : text;
          const pm = after.match(/([0-9][0-9\s  ]*[0-9]|[0-9])\s*₽/);
          out.push({
            url: a.href,
            priceText: pm ? pm[1] : '',
            metaText: text,
            model: 'countryman', // отфильтровано уже самим URL источника
          });
        });
      return out;
    },
  },
];

// Универсальный фолбэк, если хост незнаком: пытаемся найти хоть что-то.
const GENERIC = {
  match: '*',
  waitSelector: 'a',
  scrape: () => {
    const out = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!/countryman/i.test(href)) return;
      const card = a.closest('article, li, div');
      if (!card) return;
      out.push({
        url: a.href,
        priceText: card.innerText || '',
        metaText: card.innerText || '',
        model: 'countryman',
      });
    });
    return out;
  },
};

function pickSite(url) {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* оставим как есть */
  }
  return SITES.find((s) => host.includes(s.match)) || GENERIC;
}

// Разделители внутри числа — пробел и его неразрывные варианты, НО НЕ перевод
// строки (иначе год и пробег, стоящие на соседних строках, склеятся в одно число).
const INNUM_SPACE = /(\d)[\u0020\u00a0\u202f\u2009\u2007\u2008\u2002\u2003](?=\d)/g;

/** «1 295 000 ₽» / «от 5 397 000 руб.» / «2 600 000 ₽ 2 550 000 ₽» -> число. */
function parsePrice(text) {
  if (!text) return null;
  const glued = text.replace(INNUM_SPACE, '$1');
  const groups = glued.match(/\d{5,8}/g); // цена авто — 5–8 значащих цифр
  if (!groups || !groups.length) return null;
  // если есть две цены (старая зачёркнутая + актуальная) — берём последнюю (актуальную)
  return parseInt(groups[groups.length - 1], 10);
}

/**
 * Год выпуска и пробег из текста карточки. Пробег — число перед «км».
 * Год — последнее 19xx/20xx, стоящее ПЕРЕД пробегом (так модельный год не путается
 * с годами поколения вроде «Cooper (01.2016 — 12.2019)», которые идут раньше в тексте).
 */
function parseYearMileage(text) {
  if (!text) return { year: null, mileage: null };
  const glued = text.replace(INNUM_SPACE, '$1');
  const mm = glued.match(/(\d{2,7})\s*км/i);
  const mileage = mm ? parseInt(mm[1], 10) : null;
  const scope = mm ? glued.slice(0, mm.index) : glued;
  const years = scope.match(/19[89]\d|20[0-4]\d/g);
  let year = null;
  if (years && years.length) {
    year = parseInt(years[years.length - 1], 10);
  } else {
    const any = glued.match(/19[89]\d|20[0-4]\d/);
    if (any) year = parseInt(any[0], 10);
  }
  return { year, mileage };
}

function containsAny(haystack, markers) {
  const low = haystack.toLowerCase();
  return markers.some((m) => low.includes(m));
}

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

async function launchBrowser() {
  // Сначала пробуем системный Chrome (channel), при отсутствии — встроенный chromium.
  const args = ['--disable-blink-features=AutomationControlled'];
  try {
    return await chromium.launch({ channel: 'chrome', headless: true, args });
  } catch {
    return await chromium.launch({ headless: true, args });
  }
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    fail(1, 'Использование: node scripts/extract.js <URL>');
  }
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    fail(1, `Некорректный URL: ${url}`);
  }

  const site = pickSite(url);
  const browser = await launchBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'ru-RU',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
  });
  // прячем navigator.webdriver — иначе часть сайтов сразу отдаёт 403
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  let raw = [];
  try {
    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    } catch (e) {
      await browser.close();
      fail(2, `Не удалось загрузить страницу (${site.match}): ${e.message}`);
    }

    const status = response ? response.status() : 0;
    if (status === 403 || status === 429 || status === 503) {
      await browser.close();
      fail(3, `Источник ${site.match} вернул HTTP ${status} — вероятно, антибот-блокировка.`);
    }

    // На auto.ru может быть заглушка «сайт не предназначен для вашего региона»
    // с кнопкой согласия / cookie-consent — пробуем нажать, если она есть.
    for (const label of ['Я согласен', 'Я согласна', 'Принять', 'Продолжить']) {
      try {
        const btn = page.getByText(label, { exact: false }).first();
        if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(1500);
          break;
        }
      } catch {
        /* нет такой кнопки — идём дальше */
      }
    }

    // Проверяем на блок/капчу до ожидания карточек.
    let bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (containsAny(bodyText, BLOCK_MARKERS)) {
      await browser.close();
      fail(3, `Источник ${site.match} показал заглушку/капчу вместо списка объявлений.`);
    }

    // Ждём появления карточек (учитываем JS-рендер).
    try {
      await page.waitForSelector(site.waitSelector, { timeout: 30000 });
    } catch {
      // карточек нет — это либо честно пусто, либо блок/смена вёрстки
      bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      if (containsAny(bodyText, EMPTY_MARKERS)) {
        await browser.close();
        process.stdout.write('[]\n');
        return;
      }
      if (containsAny(bodyText, BLOCK_MARKERS)) {
        await browser.close();
        fail(3, `Источник ${site.match} показал заглушку/капчу вместо списка объявлений.`);
      }
      await browser.close();
      fail(
        3,
        `Карточки не найдены на ${site.match} (селектор "${site.waitSelector}"). ` +
          'Возможна блокировка или изменение вёрстки — пустой результат не отдаём.'
      );
    }

    // Небольшая пауза на дорисовку ленивого контента.
    await page.waitForTimeout(1500);

    raw = await page.evaluate(site.scrape);
  } finally {
    await browser.close();
  }

  // Разбор, фильтрация по модели и цене.
  const results = [];
  const seenUrls = new Set();
  for (const item of raw) {
    const model = (item.model || '').toLowerCase();
    if (!model.includes(TARGET_MODEL)) continue;

    const price = parsePrice(item.priceText);
    if (price == null || price >= MAX_PRICE) continue;

    const url2 = item.url;
    if (!url2 || seenUrls.has(url2)) continue;
    seenUrls.add(url2);

    const { year, mileage } = parseYearMileage(item.metaText);
    results.push({ price, year, mileage, url: url2 });
  }

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
}

main().catch((e) => {
  fail(2, `Непредвиденная ошибка: ${e && e.stack ? e.stack : e}`);
});
