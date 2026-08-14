# tracker-cron.ps1 — ежедневный автозапуск трекера цен через Claude Code (headless).
#
# Запускается Планировщиком заданий Windows (Task Scheduler) раз в день.
# Дёргает `claude -p` в headless-режиме: Claude по скиллу tracker читает конфиг и
# прошлый прогон из репозитория tracker-data через GitHub MCP, запускает
# scripts/run-tracker.js (обход источников + diff + Telegram) и пишет новый прогон
# обратно в GitHub.
#
# ВАЖНО: токен Telegram-бота НЕ хранится здесь. Он должен быть в переменной
# окружения TELEGRAM_BOT_TOKEN пользователя (задать один раз: setx TELEGRAM_BOT_TOKEN "...").
# Если токена нет — скрипт не запускает прогон и пишет об этом в лог.

$ErrorActionPreference = 'Stop'

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

# Инструкция для headless-агента. Явно называем скилл и ключевые шаги, чтобы прогон
# был воспроизводимым без интерактива.
$prompt = @'
Запусти скилл tracker и выполни сегодняшний прогон трекера цен MINI Countryman строго по .claude/skills/tracker/SKILL.md:
1) прочитай products.yaml и notify.yaml из репозитория tashantyreva-dot/tracker-data через GitHub MCP;
2) найди последний прошлый прогон в runs/ (файл с самой поздней датой строго раньше сегодняшней; .gitkeep игнорируй);
3) запусти scripts/run-tracker.js с этими локальными файлами (--products/--notify/--prev/--out), БЕЗ флага --dry-run — при значимых изменениях он сам отправит Telegram (токен уже в окружении);
4) запиши получившийся прогон в runs/<сегодня>.json в tracker-data через GitHub MCP (если файл за сегодня уже есть — перезапиши с его sha);
5) кратко отчитайся: статусы источников, число значимых изменений, был ли отправлен Telegram.
'@

$claude = 'C:\Users\Tatyana\AppData\Roaming\npm\claude.cmd'

Write-Log "Вызываю claude headless..."
# --dangerously-skip-permissions: задача неинтерактивная, подтверждать разрешения
# некому; окружение доверенное (локальная машина, единственная цель — этот прогон).
& $claude -p $prompt --dangerously-skip-permissions *>> $log
$code = $LASTEXITCODE
Write-Log "claude завершился с кодом $code."
exit $code
