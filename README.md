### Hexlet tests and linter status:
[![Actions Status](https://github.com/tashantyreva-dot/vibecoding-claudecode-project-388/actions/workflows/hexlet-check.yml/badge.svg)](https://github.com/tashantyreva-dot/vibecoding-claudecode-project-388/actions)

---

# tracker-data

Хранилище данных для «Трекера цен на Claude-скиллах».

**Текущая задача:** поиск MINI Cooper Countryman (б/у) дешевле 1 200 000 ₽ для покупки —
не общий мониторинг рынка, а точечный поиск конкретной машины. Источники: rolf.ru,
avtodom.ru, major-expert.ru, auto.ru.

## Структура репозитория

- `runs/YYYY-MM-DD.json` — ежедневные прогоны трекера: список найденных объявлений по каждому источнику
- `products.yaml` — параметры поиска (марка/модель/бюджет) и список источников (URL)
- `KNOWLEDGE.md` — правила значимости изменений (что считается поводом написать в Telegram)
- `notify.yaml` — chat_id для Telegram-уведомлений (токен бота хранится отдельно, не в гите)

## Как это работает

Скилл `tracker` (запускается по расписанию через Claude Code Desktop scheduled task) обходит источники из
`products.yaml`, вызывает скилл `extract-price` для каждого — тот собирает со страницы
все объявления, подходящие по цене, и возвращает список `{ price, year, mileage, url }`.
Tracker сравнивает список с последним прошлым прогоном (по `url`), находит новые и
подешевевшие объявления по правилам из `KNOWLEDGE.md` и шлёт уведомление в Telegram.

## Статус

Трекер рабочий, подтверждено несколькими реальными прогонами (см. `runs/`). rolf.ru, avtodom.ru и auto.ru
стабильно отдают данные; major-expert.ru пока не давал объявлений под бюджет в проверенные даты.
