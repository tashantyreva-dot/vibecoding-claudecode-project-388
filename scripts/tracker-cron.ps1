# tracker-cron.ps1 — ежедневный автозапуск трекера цен через Claude Code (headless).
#
# Запускается Планировщиком заданий Windows (Task Scheduler) раз в день.
# Дёргает `claude -p` в headless-режиме и отсылает его к скиллу
# .claude/skills/tracker/SKILL.md — там описан весь порядок работы (git, обход
# источников, diff, Telegram). Шаги специально не дублируются здесь: если процесс
# изменится, обновлять нужно только SKILL.md, а не ещё и этот файл.
#
# ВАЖНО про секреты: headless-сессия Claude Code блокирует любую Bash/PowerShell-команду,
# в тексте которой видна подстановка переменной окружения ($VAR, ${...}, $env:VAR) — это
# защита от утечки секретов через shell, и её не обходит --dangerously-skip-permissions.
# Поэтому:
#   - TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID читает изнутри send.py (Python, process.env) —
#     агент вызывает `python send.py "<текст>"` без единого символа `$` в команде;
#   - доступ к обоим GitHub-репозиториям идёт через обычный `git` — аутентификация должна
#     быть настроена заранее через credential helper / Git Credential Manager (использует
#     сохранённый GITHUB_PAT из хранилища учётных данных, а не из текста команды); токен в
#     саму команду `git` попадать не должен.
#
# ВАЖНО: ни токен Telegram-бота, ни chat_id здесь не хранятся — оба должны быть в
# переменных окружения пользователя (задать один раз: setx TELEGRAM_BOT_TOKEN "...",
# setx TELEGRAM_CHAT_ID "..."). GITHUB_PAT нужен один раз — чтобы настроить git credential
# helper (см. выше); если он уже настроен, отдельно передавать токен не требуется.

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

if ([string]::IsNullOrWhiteSpace($env:TELEGRAM_CHAT_ID)) {
  Write-Log "ОШИБКА: TELEGRAM_CHAT_ID не задан в окружении задачи. Прогон не запускаю."
  exit 2
}

# Инструкция для headless-агента — специально короткая: весь порядок работы описан
# в .claude/skills/tracker/SKILL.md, здесь его не дублируем.
$prompt = @'
Ты запущен автоматически (cron), интерактивного пользователя НЕТ. НЕ описывай план, НЕ
спрашивай подтверждений, НЕ пересказывай SKILL.md — СРАЗУ ВЫПОЛНЯЙ каждый шаг реальными
вызовами инструментов (git, Bash). Задача не считается сделанной, пока ты не вызвал
инструменты и не увидел их результат.

ВАЖНО: НЕ используй GitHub MCP (в т.ч. "claude.ai Github") — не работает в headless-режиме.
Работай с GitHub напрямую через `git` (учётные данные уже настроены заранее). НЕ пиши в
Bash/git-командах ничего вида $TELEGRAM_BOT_TOKEN, $TELEGRAM_CHAT_ID, $GITHUB_PAT, $env:...,
${...} — такие команды блокируются защитой от утечки секретов ещё до выполнения. Доставка в
Telegram уже реализована в send.py — он сам читает токен и chat_id из process.env, вызывай
его голой командой `python send.py "<текст>"`.

Сделай сегодняшний прогон трекера цен MINI Countryman строго по
.claude/skills/tracker/SKILL.md — выполни все шаги оттуда по порядку (синхронизация обоих
репозиториев через git, чтение products.yaml, обход источников через extract-price, поиск
прошлого прогона, запись нового прогона в tracker-data, diff по правилам из KNOWLEDGE.md,
уведомление в Telegram). Если что-то в SKILL.md непонятно или git/GitHub возвращает ошибку
авторизации — останови выполнение и выведи в точности сообщение об ошибке, не пытайся
обойти это другим способом (curl, MCP и т.п.).

В конце выведи ФАКТИЧЕСКИЙ результат: статусы источников (ok/error), число значимых
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
