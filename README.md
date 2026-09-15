### Hexlet tests and linter status:
[![Actions Status](https://github.com/tashantyreva-dot/vibecoding-claudecode-project-388/actions/workflows/hexlet-check.yml/badge.svg)](https://github.com/tashantyreva-dot/vibecoding-claudecode-project-388/actions)

---

# tracker-data

Хранилище данных для «Трекера цен на Claude-скиллах».

**Текущая задача:** поиск MINI Cooper Countryman (б/у) дешевле 1 200 000 ₽ для покупки —
не общий мониторинг рынка, а точечный поиск конкретной машины. Источники: rolf.ru,
avtodom.ru, major-expert.ru, auto.ru.

## Структура репозитория

- `products.yaml` — параметры поиска (марка/модель/бюджет) и список источников (URL)
- `KNOWLEDGE.md` — правила значимости изменений (что считается поводом написать в Telegram)

История прогонов (`runs/YYYY-MM-DD.json`) в этом репозитории не хранится — она лежит в
отдельном приватном репозитории `tracker-data`, куда пишет `scripts/github-sync.js`.

`chat_id` и токен Telegram-бота в репозитории не хранятся — задаются только через
переменные окружения (`TELEGRAM_CHAT_ID`, `TELEGRAM_BOT_TOKEN`) или локальный `.env`
рядом с `send.py`.

## Как это работает

Скилл `tracker` (запускается по расписанию через Claude Code Desktop scheduled task) обходит источники из
`products.yaml`, вызывает скилл `extract-price` для каждого — тот собирает со страницы
все объявления, подходящие по цене, и возвращает список `{ price, year, mileage, url }`.
Tracker сравнивает список с последним прошлым прогоном (по `url`), находит новые и
подешевевшие объявления по правилам из `KNOWLEDGE.md` и шлёт уведомление в Telegram.

## Статус

Трекер рабочий, подтверждено несколькими реальными прогонами (см. `runs/`). rolf.ru, avtodom.ru и auto.ru
стабильно отдают данные; major-expert.ru пока не давал объявлений под бюджет в проверенные даты.
