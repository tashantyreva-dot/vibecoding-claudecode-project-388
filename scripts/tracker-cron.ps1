# tracker-cron.ps1 — ежедневный автозапуск трекера цен через Claude Code (headless).
#
# Запускается Планировщиком заданий Windows (Task Scheduler) раз в день.
# Дёргает `claude -p` в headless-режиме: Claude по скиллу tracker читает конфиг из
# репозитория vibecoding-claudecode-project-388 и прошлый прогон из tracker-data через
# scripts/github-sync.js, запускает scripts/run-tracker.js (обход источников + diff +
# Telegram) и пишет новый прогон обратно в tracker-data тем же github-sync.js.
#
# ВАЖНО про секреты: headless-сессия Claude Code блокирует любую Bash/PowerShell-команду,
# в тексте которой видна подстановка переменной окружения ($VAR, ${...}, $env:VAR) — это
# защита от утечки секретов через shell, и её не обходит --dangerously-skip-permissions.
# Поэтому GITHUB_PAT и TELEGRAM_BOT_TOKEN читаются НЕ из текста команд, а изнутри Node-кода
# (process.env) — headless-агент просто вызывает `node scripts/github-sync.js ...` и
# `node scripts/run-tracker.js ...` без единого символа `$` в командной строке.
#
# ВАЖНО: токен Telegram-бота НЕ хранится здесь. Он должен быть в переменной
# окружения TELEGRAM_BOT_TOKEN пользователя (задать один раз: setx TELEGRAM_BOT_TOKEN "...").
# GitHub PAT — аналогично, в переменной GITHUB_PAT (setx GITHUB_PAT "...").
# Если какого-то токена нет — скрипт не запускает прогон и пишет об этом в лог.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Корень репозитория = родитель папки scripts/, где лежит этот файл.
$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo

# Логи (папка logs/ игнорируется git — см. .gitignore, *.log).
$logDir = Join-Path $repo 'logs'
if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$log   = Join-Path $logDir "tracker_$stamp.log"

function Write-Log([string]$msg) {
  "[{0}] {1}" -f (Get-Date -Format o), $msg | Add-Content -LiteralPath $log -Encoding utf8
}

Write-Log "Старт автозапуска трекера. repo=$repo"

if ([string]::IsNullOrWhiteSpace($env:TELEGRAM_BOT_TOKEN)) {
  Write-Log "ОШИБКА: TELEGRAM_BOT_TOKEN не задан в окружении задачи. Прогон не запускаю."
  exit 2
}

if ([string]::IsNullOrWhiteSpace($env:GITHUB_PAT)) {
  Write-Log "ОШИБКА: GITHUB_PAT не задан в окружении задачи. Прогон не запускаю."
  exit 2
}

# Инструкция для headless-агента. Явно называем скилл и ключевые шаги, чтобы прогон
# был воспроизводимым без интерактива.
$prompt = @'
Ты запущен автоматически (cron), интерактивного пользователя НЕТ. НЕ описывай план, НЕ спрашивай подтверждений, НЕ пересказывай SKILL.md — СРАЗУ ВЫПОЛНЯЙ каждый шаг реальными вызовами инструментов (Bash). Задача не считается сделанной, пока ты не вызвал инструменты и не увидел их результат.

ВАЖНО: НЕ используй GitHub MCP (в т.ч. "claude.ai Github") — не работает в headless-режиме.
НЕ пиши в Bash-командах ничего вида $GITHUB_PAT, $TELEGRAM_BOT_TOKEN, $env:..., ${...} —
такие команды блокируются защитой от утечки секретов ещё до выполнения. Все обращения к
GitHub и Telegram уже реализованы в scripts/github-sync.js и scripts/run-tracker.js — они
сами читают токены из process.env изнутри Node-кода. Твоя задача — вызывать эти скрипты
голыми командами (без единого символа `$` в команде) и передавать между ними пути файлов.

Сделай сегодняшний прогон трекера цен MINI Countryman по .claude/skills/tracker/SKILL.md:
1) `node scripts/github-sync.js get-config <products.yaml> <notify.yaml>` — скачает конфиг
   из tashantyreva-dot/vibecoding-claudecode-project-388 во временные файлы, которые ты укажешь. Код выхода 2 =
   GITHUB_PAT не задан/невалиден — в этом случае сразу останови выполнение (см. п.5).
2) `node scripts/github-sync.js get-prev-run <outFile>` — скачает самый свежий прошлый
   прогон из tashantyreva-dot/tracker-data в outFile и напечатает в stdout его дату; если
   прошлого прогона нет, напечатает ровно "NONE" и файл не создаст — тогда флаг --prev в
   шаге 3 не передавай.
3) `node scripts/run-tracker.js --products <из шага 1> --notify <из шага 1> --out <новый файл> [--prev <из шага 2, если не NONE>]` — БЕЗ --dry-run. Дождись завершения (обход сайтов занимает несколько минут). При значимых изменениях скрипт сам отправит Telegram (токен читает из process.env сам).
4) `node scripts/github-sync.js put-run <файл --out из шага 3>` — запишет его в
   runs/<сегодняшняя дата>.json репозитория tracker-data (сам разберётся с перезаписью).
5) Если любой из скриптов вышел с кодом 2 (это его ошибка авторизации/токена) — немедленно
   останови выполнение и выведи в точности то сообщение об ошибке, что он напечатал.
   Не пытайся обойти это другим способом (curl, MCP и т.п.).
6) В конце выведи ФАКТИЧЕСКИЙ результат: статусы источников (ok/error), число значимых
   изменений и был ли отправлен Telegram.
'@

$claude = 'C:\Users\Tatyana\AppData\Roaming\npm\claude.cmd'

Write-Log "Вызываю claude headless..."
# --dangerously-skip-permissions: задача неинтерактивная, подтверждать разрешения
# некому; окружение доверенное (локальная машина, единственная цель — этот прогон).
# Вывод собираем и пишем в лог как UTF-8 (иначе PowerShell пишет UTF-16 и лог нечитаем).
$claudeOut = & $claude -p $prompt --dangerously-skip-permissions --verbose 2>&1 | Out-String
$code = $LASTEXITCODE
Add-Content -LiteralPath $log -Value $claudeOut -Encoding utf8
Write-Log "claude завершился с кодом $code."
exit $code
