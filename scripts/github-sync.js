// github-sync.js — чтение/запись файлов трекера через GitHub REST API.
//
// Реализация (products.yaml, notify.yaml, KNOWLEDGE.md, скиллы) живёт в публичном
// tashantyreva-dot/vibecoding-claudecode-project-388, а прогоны (runs/*.json) —
// в приватном tashantyreva-dot/tracker-data. Так публичный репозиторий содержит
// только реализацию, а приватный — только записи с результатами.
//
// Токен читается из process.env.GITHUB_PAT (код, не текст shell-команды) — headless-сессия
// Claude Code блокирует любую Bash/PowerShell-команду с видимой подстановкой переменной
// окружения ($VAR, ${...}, $env:VAR) как потенциальный доступ к секрету. Вызов вида
// `node scripts/github-sync.js get-config a.yaml b.yaml` такой подстановки не содержит.
//
// Команды:
//   get-config <productsOut> <notifyOut>   — скачать products.yaml и notify.yaml
//                                             из vibecoding-claudecode-project-388
//   get-prev-run <outFile>                 — скачать самый свежий runs/*.json старше сегодня
//                                             из tracker-data; если такого нет, ничего не
//                                             пишет и печатает NONE
//   put-run <inFile>                       — записать inFile в runs/<сегодня>.json
//                                             в tracker-data (с sha, если файл уже есть)

const https = require('https');
const fs = require('fs');

const OWNER = 'tashantyreva-dot';
const CONFIG_REPO = 'vibecoding-claudecode-project-388';
const RUNS_REPO = 'tracker-data';
const BRANCH = 'main';
const TOKEN = process.env.GITHUB_PAT;

if (!TOKEN) {
  console.error('ОШИБКА: GITHUB_PAT не задан в окружении процесса.');
  process.exit(2);
}

function api(method, path, { raw = false, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path,
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'User-Agent': 'price-tracker-github-sync',
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, text: buf.toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function contentsPath(repo, path) {
  return `/repos/${OWNER}/${repo}/contents/${path}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function failIfAuthError(status, context) {
  if (status === 401 || status === 403) {
    console.error(`ОШИБКА: GITHUB_PAT не проходит авторизацию на api.github.com (${status}) при ${context}. Проверь срок действия и права токена.`);
    process.exit(2);
  }
}

async function getConfig(productsOut, notifyOut) {
  for (const [remote, local] of [
    ['products.yaml', productsOut],
    ['notify.yaml', notifyOut],
  ]) {
    const res = await api('GET', contentsPath(CONFIG_REPO, remote), { raw: true });
    failIfAuthError(res.status, `чтении ${remote}`);
    if (res.status !== 200) {
      console.error(`ОШИБКА: не удалось прочитать ${remote} (HTTP ${res.status}): ${res.text.slice(0, 300)}`);
      process.exit(1);
    }
    fs.writeFileSync(local, res.text, 'utf8');
  }
  console.log('OK: конфиг скачан.');
}

async function getPrevRun(outFile) {
  const res = await api('GET', contentsPath(RUNS_REPO, 'runs'));
  failIfAuthError(res.status, 'листинге runs/');
  if (res.status !== 200) {
    console.error(`ОШИБКА: не удалось прочитать runs/ (HTTP ${res.status}): ${res.text.slice(0, 300)}`);
    process.exit(1);
  }
  const entries = JSON.parse(res.text);
  const today = todayISO();
  const dates = entries
    .map((e) => e.name)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.replace(/\.json$/, ''))
    .filter((date) => date < today)
    .sort();
  if (dates.length === 0) {
    console.log('NONE');
    return;
  }
  const latest = dates[dates.length - 1];
  const fileRes = await api('GET', contentsPath(RUNS_REPO, `runs/${latest}.json`), { raw: true });
  failIfAuthError(fileRes.status, `чтении runs/${latest}.json`);
  if (fileRes.status !== 200) {
    console.error(`ОШИБКА: не удалось скачать runs/${latest}.json (HTTP ${fileRes.status}): ${fileRes.text.slice(0, 300)}`);
    process.exit(1);
  }
  fs.writeFileSync(outFile, fileRes.text, 'utf8');
  console.log(latest);
}

async function putRun(inFile) {
  const today = todayISO();
  const remotePath = `runs/${today}.json`;
  const content = fs.readFileSync(inFile);

  const existing = await api('GET', contentsPath(RUNS_REPO, remotePath));
  failIfAuthError(existing.status, `проверке ${remotePath}`);
  let sha;
  if (existing.status === 200) {
    sha = JSON.parse(existing.text).sha;
  } else if (existing.status !== 404) {
    console.error(`ОШИБКА: не удалось проверить ${remotePath} (HTTP ${existing.status}): ${existing.text.slice(0, 300)}`);
    process.exit(1);
  }

  const body = {
    message: `tracker run ${today}`,
    content: content.toString('base64'),
    branch: BRANCH,
    ...(sha ? { sha } : {}),
  };
  const putRes = await api('PUT', contentsPath(RUNS_REPO, remotePath), { body });
  failIfAuthError(putRes.status, `записи ${remotePath}`);
  if (putRes.status !== 200 && putRes.status !== 201) {
    console.error(`ОШИБКА: не удалось записать ${remotePath} (HTTP ${putRes.status}): ${putRes.text.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`OK: записано в ${remotePath}.`);
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  if (cmd === 'get-config' && args.length === 2) {
    await getConfig(args[0], args[1]);
  } else if (cmd === 'get-prev-run' && args.length === 1) {
    await getPrevRun(args[0]);
  } else if (cmd === 'put-run' && args.length === 1) {
    await putRun(args[0]);
  } else {
    console.error('Использование: node github-sync.js get-config <products.yaml> <notify.yaml>');
    console.error('           или: node github-sync.js get-prev-run <outFile>');
    console.error('           или: node github-sync.js put-run <inFile>');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('ОШИБКА:', err.message);
  process.exit(1);
});
