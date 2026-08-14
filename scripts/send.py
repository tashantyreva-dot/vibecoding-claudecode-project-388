#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
send.py — отправка текстового сообщения в Telegram.

Только стандартная библиотека (urllib), без внешних зависимостей.

Токен и chat_id берутся из переменных окружения, а если их там нет —
из файла .env рядом с этим скриптом (строки вида KEY=VALUE):
    TELEGRAM_BOT_TOKEN — токен бота (СЕКРЕТ, в репозиторий не коммитить);
    TELEGRAM_CHAT_ID   — id чата получателя (секретом не является).

Запуск:
    python send.py "текст сообщения"

Вывод при успехе — строка «Отправлено.» (код выхода 0).
При любой ошибке — понятное сообщение в stderr и код выхода 1
(не задан токен/chat_id/текст, Telegram отклонил запрос, нет сети).
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.telegram.org/bot{token}/sendMessage"


def load_dotenv(path):
    """Простейший парсер .env: KEY=VALUE построчно, # — комментарий."""
    values = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        val = val.strip().strip('"').strip("'")
        values[key.strip()] = val
    return values


def get_config(name, dotenv):
    """Значение из окружения, иначе из .env; None, если нигде нет."""
    val = os.environ.get(name)
    if val is not None and val.strip() != "":
        return val.strip()
    val = dotenv.get(name)
    return val.strip() if val and val.strip() != "" else None


def fail(message):
    sys.stderr.write("[send.py] ОШИБКА: " + message + "\n")
    sys.exit(1)


def main():
    # Гарантируем UTF-8 вывод независимо от кодовой страницы консоли Windows,
    # чтобы «Отправлено.» и тексты ошибок читались в терминале и в логах задачи.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    if len(sys.argv) < 2 or sys.argv[1].strip() == "":
        fail('не передан текст. Использование: python send.py "текст сообщения"')
    text = sys.argv[1]

    dotenv = load_dotenv(Path(__file__).resolve().parent / ".env")
    token = get_config("TELEGRAM_BOT_TOKEN", dotenv)
    chat_id = get_config("TELEGRAM_CHAT_ID", dotenv)

    if not token:
        fail("TELEGRAM_BOT_TOKEN не задан (ни в окружении, ни в .env рядом со скриптом).")
    if not chat_id:
        fail("TELEGRAM_CHAT_ID не задан (ни в окружении, ни в .env рядом со скриптом).")

    payload = json.dumps({
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": False,
    }).encode("utf-8")

    req = urllib.request.Request(
        API.format(token=token),
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # Telegram присылает тело с описанием даже на 4xx — покажем его.
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8")).get("description", "")
        except Exception:
            pass
        fail("Telegram вернул HTTP {}{}".format(e.code, ": " + detail if detail else ""))
    except urllib.error.URLError as e:
        fail(
            "нет связи с api.telegram.org ({}). ".format(e.reason)
            + "Если это облачное окружение — добавьте api.telegram.org в разрешённые "
            + "домены (Network access → Custom) и начните новую сессию."
        )

    if not body.get("ok"):
        fail("Telegram отклонил отправку: " + str(body.get("description", body)))

    print("Отправлено.")


if __name__ == "__main__":
    main()
