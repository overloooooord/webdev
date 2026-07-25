# 🔧 Ubisoft Ticket Manager - Полное Руководство по Отладке

> **Проект:** `Project Files/ticket-manager` (Node.js/Express + Vite)
> **Рабочие референсы:** `grand grant` (Python) и `Auto_Xbox_Linker_fixed` (Python)
> **Дата:** 19 июля 2026

---

## 📋 Оглавление

1. [Обзор архитектуры проекта](#1-обзор-архитектуры)
2. [Ошибка #1 - Капча (Error 6010)](#2-ошибка-1--капча-error-6010)
3. [Ошибка #2 - IMAP / Почта не интегрирована](#3-ошибка-2--imap--почта)
4. [Ошибка #3 - Session Elevation неполная](#4-ошибка-3--session-elevation)
5. [Ошибка #4 - Xbox OAuth не используется для тикетов](#5-ошибка-4--xbox-oauth)
6. [Ошибка #5 - Ubi-GenomeId рандомный вместо фиксированного](#6-ошибка-5--ubi-genomeid)
7. [Ошибка #6 - Capsolver вместо рабочего решения](#7-ошибка-6--capsolver)
8. [Сводная таблица: Сломано vs Рабочее](#8-сводная-таблица)
9. [Пошаговый план исправлений](#9-пошаговый-план)

---

## 1. Обзор архитектуры

### Наш проект (ИСПРАВЛЕНО!) - `Project Files/ticket-manager`

```
ticket-manager/
├-- backend/                  - ПОЛНОСТЬЮ НОВЫЙ БЭКЕНД НА PYTHON
│   ├-- server.py             - FastAPI сервер
│   ├-- ticket_pipeline.py    - Оркестратор пайплайна
│   ├-- ubisoft_api.py        - aiohttp клиент Ubisoft
│   ├-- database.py           - SQLite WAL 
│   ├-- csv_parser.py         - Загрузка данных
│   ├-- xbox_auth.py          - Обертка для MS OAuth
│   └-- xbox_linker/          - Скопированные файлы из рабочих референсов (IMAP, Proxy, etc.)
└-- src/                      - Vite фронтенд
```

### Рабочий референс #1 - `grand grant/ubisoft-xbox-linker` (Python)

```
ubisoft-xbox-linker/
├-- main.py                    - Полный флоу: MS OAuth -> Xbox -> Ubisoft
├-- ms_auth.py                 - ✅ Microsoft OAuth (полный, с consent, proofs, KMSI)
├-- backup_email.py            - ✅ Backup email + верификация
├-- imap_helper.py             - ✅ IMAP чтение кодов верификации
├-- ubisoft_exchange.py        - ✅ Обмен кода на Ubisoft токен
├-- xbox_profile.py            - ✅ Создание Xbox профиля
├-- config.py                  - Конфигурация (API ключи, URL-ы)
└-- proxy_utils.py             - Прокси-сессии
```

### Рабочий референс #2 - `Auto_Xbox_Linker_fixed` (Python)

```
Auto_Xbox_Linker/
├-- main.py                    - Массовый линкер с IMAP
└-- utils/
    ├-- imap_helper.py         - ✅ Продвинутый IMAP (IDLE, UID, spam-папки)
    ├-- ubisoft_api.py         - ✅ Ubisoft API + Xbox linking
    ├-- ms_auth.py             - ✅ MS Auth (identity verification)
    ├-- backup_email.py        - ✅ Backup email management
    ├-- xbox_profile.py        - ✅ Xbox профили
    └-- config.py              - Конфигурация
```

---

## 2. Ошибка #1 - Капча (Error 6010)

### Симптом

При создании тикета Ubisoft API возвращает `errorCode: 6010`.

### Причина

Наш проект использует **Capsolver** (`captcha-solver.js`), который генерирует токены reCAPTCHA v3 Enterprise. Но Google Enterprise server-side валидация **отклоняет** эти токены как "low score" - Capsolver не может обойти Enterprise-уровень защиты.

### Что в нашем СЛОМАННОМ коде

```js
// captcha-solver.js - СЛОМАНО
const CAPSOLVER_API = 'https://api.capsolver.com';

// Capsolver НЕ ПРОХОДИТ Enterprise валидацию Google
export async function solveCaptcha() {
  const createRes = await fetch(`${CAPSOLVER_API}/createTask`, {
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'ReCaptchaV3EnterpriseTaskProxyLess',  // ❌ Enterprise отклоняет
        websiteURL: SITE_URL,
        websiteKey: SITE_KEY,
        pageAction: 'AccountRecovery',
        minScore: 0.7,
      },
    }),
  });
  // ... токен получается, но Ubisoft его ОТКЛОНЯЕТ -> 6010
}
```

### Как работает в рабочем проекте

В рабочем проекте (`grand grant`) капча **вообще не нужна**, потому что используется **Xbox OAuth flow**. Из mitmproxy дампа (`create_ticket` файл) видно, что успешный запрос на создание тикета (status 201) использует:

1. **Токен авторизации** полученный через Xbox OAuth (`ubi_v1 t=...` с `AID = 4391c956-...`)
2. **reCAPTCHA токен** в поле `token` - но этот токен получен **в реальном браузере**, не через Capsolver

### Исправление

**Вариант А - Убрать капчу, использовать Xbox OAuth токен напрямую (ВЫБРАНО И РЕАЛИЗОВАНО):**

Рабочий mitmproxy дамп показывает что при использовании правильного `ubi_v1` токена с `Ubi-AppId: 4391c956-8943-48eb-8859-07b0778f47b9`, капча проходит. 

**Исправлено в `ticket_pipeline.py`:** 
Вместо Capsolver для XBL аккаунтов теперь используется `xbox_auth.py`, который генерирует Xbox accessToken. Этот токен работает без капчи!

**Вариант Б - Заменить Capsolver на 2Captcha/AntiCaptcha с прокси:**

Если капча всё-таки нужна, заменить провайдера и использовать `ReCaptchaV3TaskProxyOn` с реальным US прокси.

---

## 3. Ошибка #2 - IMAP / Почта

### Симптом

В ticket-manager **полностью отсутствует** IMAP-интеграция. При Microsoft OAuth, когда нужна верификация email (need_proofs, need_verify_existing), процесс просто **ломается**.

### Что в нашем СЛОМАННОМ коде

В `xbox-oauth.js` при встрече страницы proofs:

```js
// xbox-oauth.js - СЛОМАНО
async function trySkipProofs(proofsUrl, html, session) {
  // Просто пытается найти кнопку "skip" или "later"
  // Если нет - возвращает { success: false }
  // НИКАКОЙ работы с email/IMAP!
  return { success: false };
}
```

### Как работает в рабочем проекте

В `Auto_Xbox_Linker_fixed/utils/imap_helper.py` - полноценный IMAP клиент:

```python
class IMAPCodeReader:
    def __init__(self, imap_email, imap_password, imap_host=None, imap_port=None):
        # Авто-определение хоста по домену
        auto_host, auto_port, self.use_ssl = get_imap_config(imap_email)
        self.host = imap_host or auto_host
        self.port = imap_port or auto_port

    def connect(self):
        # SSL или обычное подключение
        if self.use_ssl:
            self.connection = imaplib.IMAP4_SSL(self.host, self.port, timeout=15)
        else:
            self.connection = imaplib.IMAP4(self.host, self.port, timeout=15)
        self.connection.login(self.email, self.password)
        # Проверка поддержки IDLE
        self._supports_idle = "IDLE" in cap_str
        # Автоматическое определение папок (INBOX + Spam/Junk)
        self._detect_folders()

    def get_verification_code(self, sender_filter="microsoft",
                              max_wait=60, poll_interval=3,
                              not_before=None, min_uid=None):
        # 1. Сканирует ВСЕ папки (INBOX + Spam)
        # 2. Использует IDLE для мгновенных уведомлений
        # 3. Фильтрует по UID (только новые после min_uid)
        # 4. Фильтрует по дате (not_before)
        # 5. Пропускает уведомления (unusual sign-in, password changed)
        # 6. Извлекает 4-7 значный код regex-ами
```

**Ключевые фичи рабочего IMAP:**

| Фича | grand grant (базовый) | Auto_Xbox_Linker (продвинутый) |
|------|----------------------|-------------------------------|
| SSL/TLS | ✅ | ✅ |
| Авто-определение хоста | ✅ | ✅ |
| IDLE поддержка | ❌ | ✅ |
| UID фильтрация | ❌ | ✅ |
| Сканирование Spam папок | ❌ | ✅ |
| Пропуск уведомлений | ✅ | ✅ |
| Reconnect при обрыве | ❌ | ✅ |
| AnonAddy заголовки | ❌ | ✅ |

### Исправление (РЕАЛИЗОВАНО в `xbox_auth.py` + `imap_helper.py`)

Мы портировали `IMAPCodeReader` из `Auto_Xbox_Linker_fixed` напрямую в Python бэкенд (в папку `backend/xbox_linker/imap_helper.py`).

Теперь, когда при логине Microsoft требуется OTP:
```python
imap = IMAPCodeReader(imap_target_email, imap_target_password, imap_target_host)
imap.connect()
code = imap.get_verification_code(max_wait=120)
if code:
    # Отправка кода в Microsoft API
```

---

## 4. Ошибка #3 - Session Elevation

### Симптом

Token elevation в `ticket-creator.js` делается но **не гарантирует** правильный AppId scope.

### Что в нашем коде

```js
// ticket-creator.js
const elevResult = await elevateSession(freshToken, proxy);
if (elevResult?.success) {
  freshToken = elevResult.token;  // Используем elevated token
} else {
  // ⚠️ "non-fatal" - продолжаем со старым токеном
  console.warn('Session elevation failed (non-fatal)');
}
```

### Что показывает mitmproxy дамп

Успешный запрос на создание тикета (status 201) использовал:
- `Ubi-AppId: 4391c956-8943-48eb-8859-07b0778f47b9` (TICKET_APP_ID)
- `Authorization: ubi_v1 t=...` - токен с **AID = 4391c956** внутри JWT

Это значит что токен ДОЛЖЕН быть получен именно с этим AppId. Обычный LOGIN_APP_ID (`2c2d31af-...`) **не подходит**.

### Исправление

Elevation должна быть **обязательной**, не optional:

```js
// ticket-creator.js - ИСПРАВЛЕНИЕ
const elevResult = await elevateSession(freshToken, proxy);
if (!elevResult?.success) {
  return { success: false, error: 'Session elevation to TICKET scope failed - cannot create ticket' };
}
freshToken = elevResult.token;
freshSessionId = elevResult.sessionId;
```

---

## 5. Ошибка #4 - Xbox OAuth не используется для тикетов

### Симптом

`xbox-oauth.js` существует и работает (MS login -> Xbox token -> Ubisoft token), но `ticket-creator.js` его **не использует**. Вместо этого тикеты создаются через Basic Auth токен + Capsolver капчу.

### Рабочий flow из mitmproxy

Из дампа `create_ticket` видно что успешный запрос на `account-recovery-cases` использовал токен полученный через **браузерный OAuth flow** (AppId `4391c956`), а не через Basic Auth (AppId `2c2d31af`).

### Исправление

Интегрировать `xboxOAuthLogin` в `ticket-creator.js` как альтернативный путь авторизации:

```js
// ticket-creator.js - добавить Xbox OAuth путь
import { xboxOAuthLogin } from './xbox-oauth.js';

// Если у аккаунта есть Microsoft credentials (platform_login_email/password):
if (account.platform_login_email && account.platform_login_password) {
  const xboxResult = await xboxOAuthLogin(
    account.platform_login_email,
    account.platform_login_password,
    proxy
  );
  if (xboxResult.success) {
    // Используем Xbox OAuth token - капча НЕ нужна
    freshToken = xboxResult.accessToken;
    isXboxToken = true;
  }
}
```

---

## 6. Ошибка #5 - Ubi-GenomeId

### Симптом

В `createTicket()` генерируется **рандомный UUID** для `Ubi-GenomeId`, но mitmproxy дамп показывает **фиксированное** значение.

### Что в нашем СЛОМАННОМ коде

```js
// ubisoft-api.js - СЛОМАНО
headers: {
  'Ubi-GenomeId': generateUUID(),  // ❌ Рандомный каждый раз!
}
```

### Что в mitmproxy дампе (рабочий запрос)

```
Ubi-GenomeId: 1a6f2698-1350-416e-b8e8-29d77fb86437  // Фиксированный!
```

### Исправление

```js
// ubisoft-api.js - ИСПРАВЛЕНИЕ
headers: {
  'Ubi-GenomeId': '1a6f2698-1350-416e-b8e8-29d77fb86437',  // Фиксированный из Ubisoft Help
}
```

> [!NOTE]
> В функции `getAuthHeaders()` уже используется фиксированный GenomeId (строка 99), но в `createTicket()` (строка 319) он переопределяется рандомным. Это баг.

---

## 7. Ошибка #6 - Capsolver vs рабочее решение

### Детальное сравнение подходов

| Аспект | Наш проект (СЛОМАН) | Рабочий проект |
|--------|---------------------|----------------|
| Капча-провайдер | Capsolver | Нет (Xbox OAuth) |
| Тип задачи | ReCaptchaV3EnterpriseTaskProxyLess | N/A |
| Результат | ❌ Error 6010 | ✅ Status 201 |
| Авторизация | Basic Auth -> ubi_v1 | Xbox OAuth -> ubi_v1 |
| AppId в токене | 2c2d31af (LOGIN) | 4391c956 (TICKET) |
| GenomeId | Рандомный UUID | Фиксированный |
| IMAP для 2FA | ❌ Отсутствует | ✅ Полный (IDLE+UID) |
| Backup email | ❌ Отсутствует | ✅ Полный |

---

## 8. Сводная таблица

| # | Ошибка | Файл | Критичность | Исправление |
|---|--------|------|-------------|-------------|
| 1 | Capsolver не проходит Enterprise | `captcha-solver.js` | 🔴 Блокер | Убрать, использовать Xbox OAuth |
| 2 | IMAP отсутствует | нет файла | 🔴 Блокер | Портировать из Auto_Xbox_Linker |
| 3 | Session elevation optional | `ticket-creator.js` | 🟡 Высокая | Сделать обязательной |
| 4 | Xbox OAuth не в ticket flow | `ticket-creator.js` | 🔴 Блокер | Интегрировать xboxOAuthLogin |
| 5 | GenomeId рандомный | `ubisoft-api.js:319` | 🟡 Высокая | Заменить на фиксированный |
| 6 | Нет backup email flow | `xbox-oauth.js` | 🟠 Средняя | Портировать из grand grant |
| 7 | Нет identity verification | `xbox-oauth.js` | 🟠 Средняя | Портировать из grand grant |

---

## 9. Пошаговый план исправлений

### Шаг 1: Портировать IMAP Reader

Взять логику из `Auto_Xbox_Linker_fixed/utils/imap_helper.py` и создать `server/imap-reader.js`:

- Авто-определение IMAP хоста по домену
- SSL/TLS поддержка
- Сканирование INBOX + Spam/Junk папок
- UID-based фильтрация (только новые письма)
- IDLE поддержка для мгновенных уведомлений
- Regex извлечение 4-7 значных кодов
- Пропуск уведомительных писем

**Карта regex-ов для кодов из рабочего проекта:**

```python
# Из Auto_Xbox_Linker_fixed/utils/imap_helper.py
patterns = [
    r'(?:security\s*code|verification\s*code|code)\s*(?:is|:)?\s*(\d{4,7})',
    r'(\d{4,7})\s*(?:is your)',
    r'<td[^>]*>(\d{4,7})</td>',
    r'(?:^|\n)\s*(\d{4,7})\s*(?:\n|$)',
    r'(?:code|código|код)[:\s]*?(\d{4,7})',
    r'style="[^"]*font-size[^"]*"[^>]*>(\d{4,7})<',
]
# + фильтр годов: if re.match(r'^20[2-3]\d$', candidate): continue
```

### Шаг 2: Интегрировать IMAP в Xbox OAuth

В `xbox-oauth.js`, заменить `trySkipProofs` на полноценную обработку:

```js
async function handleProofs(proofsUrl, html, session, imapConfig) {
  // 1. Попробовать skip
  // 2. Если не получилось - добавить backup email
  // 3. Запросить код верификации через API
  // 4. Прочитать код через IMAP
  // 5. Подтвердить верификацию
  // 6. Продолжить OAuth flow
}
```

### Шаг 3: Исправить GenomeId

В `ubisoft-api.js` строка 319 - заменить `generateUUID()` на фиксированный ID:

```diff
- 'Ubi-GenomeId': generateUUID(),
+ 'Ubi-GenomeId': '1a6f2698-1350-416e-b8e8-29d77fb86437',
```

### Шаг 4: Сделать elevation обязательной

В `ticket-creator.js` - elevation должна быть required, не optional.

### Шаг 5: Интегрировать Xbox OAuth в ticket creation

Добавить в `ticket-creator.js` возможность использовать Xbox OAuth токен:

```js
// Новый flow:
// 1. Получить Xbox OAuth token (xboxOAuthLogin)
// 2. Elevate session с TICKET_APP_ID
// 3. Создать тикет с elevated token
// 4. НЕ нужна капча при Xbox OAuth token
```

### Шаг 6: Добавить конфигурацию IMAP хостов

В настройки (`database.js` / settings) добавить IMAP конфигурацию из рабочего `config.py`:

```js
const IMAP_HOSTS = {
  'rambler.ru':         { host: 'imap.rambler.ru',          port: 993, tls: true },
  'mail.ru':            { host: 'imap.mail.ru',             port: 993, tls: true },
  'firstmail.ltd':      { host: 'imap.firstmail.ltd',       port: 993, tls: true },
  'streetwormail.com':  { host: 'mail.streetwormail.com',   port: 993, tls: true },
  'vargosmail.com':     { host: 'imap.firstmail.ltd',       port: 993, tls: true },
  'notlettersmail.com': { host: 'mail.notlettersmail.com',  port: 143, tls: false },
  'belettersmail.com':  { host: 'mail.belettersmail.com',   port: 143, tls: false },
  'onelettersmail.com': { host: 'mail.onelettersmail.com',  port: 143, tls: false },
};
```

---

## Приложение: Ключевые API endpoints из mitmproxy

Из файла `create_ticket` (успешный запрос, status 201):

```
POST /v1/applications/global/cshelp/cases/api/account-recovery-cases
Host: public-ubiservices.ubi.com
Authorization: ubi_v1 t=<JWT с AID=4391c956-8943-48eb-8859-07b0778f47b9>
Ubi-AppId: 4391c956-8943-48eb-8859-07b0778f47b9
Ubi-GenomeId: 1a6f2698-1350-416e-b8e8-29d77fb86437
Ubi-SessionId: 9dc9c701-c314-4ed1-8319-f22fe9684cae
Content-Type: application/json; charset=utf-8
Origin: https://www.ubisoft.com
Referer: https://www.ubisoft.com/

{
  "Case": {
    "accountRecoveryReason": "accountHackedOrTakenOver",
    "ubiCategoryId": "420",
    "platformId": "29",
    "productInstallmentId": "50003",
    "locale": "en-us",
    "contactChannel": "Email",
    "origin": "API",
    "emailAddress": "<контактный email>",
    "lostEmailAddress": "<потерянный email>",
    "description": "",
    "pcActivationKey": "",
    "usernameVariations": ["<username>"],
    "linkedAccounts": [{"platform": "", "username": ""}]
  },
  "attachments": [],
  "token": "<reCAPTCHA token>"
}

-> Response 201:
{"item": "500Rm00001V4jQuIAJ|26363162", "errorMessage": null, "statusCode": null}
```

Сразу после создания - запрос support-id:

```
GET /v1/profiles/me/global/cshelp/cases/api/support-id
-> {"supportId": "001Rl00000l9vTqIAI"}
```

И feedback:

```
POST https://help.akin.ubisoft.com/api/v1/feedback/ticket
{"sessionId": "...", "ticket": "500Rm00001V4jQuIAJ", "form": "AccountRecovery"}
-> 202 null
```
