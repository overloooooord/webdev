# 🚀 Шпаргалка и полное руководство к собеседованию: Ubisoft Ticket Automation

Этот документ содержит **полный разбор всех модулей и файлов проекта**, логику работы API, обход защит, и **ответы на технические вопросы**, которые могут задать на собеседовании.

---

## 📌 1. Общий смысл и архитектура проекта (High-Level Overview)

### Зачем нужен этот проект?
Проект представляет собой **автоматизированную систему восстановления аккаунтов Ubisoft** (Ticket Automation System). 
Когда аккаунт утерян/взломан, система автоматически:
1. Авторизуется в Ubisoft API от имени аккаунта (через Basic Auth или Xbox Live OAuth).
2. Повышает уровень сессии (Session Elevation) до прикладного скоупа поддержки (`TICKET_APP_ID`).
3. Генерирует релевантный запрос на восстановление в Ubisoft CSHelp API (`/v1/applications/global/cshelp/cases/api/account-recovery-cases`).
4. Обходит защиты (двухфакторную аутентификацию Microsoft через IMAP OTP и антибот-защиту reCAPTCHA Enterprise v3).
5. Мониторит статус обращений и ответы техподдержки в реальном времени через вебсокеты и SQLite.

---

## 📂 2. Разбор всех файлов проекта (File-by-File Breakdown)

### 🐍 Python-составляющая (`code_snippet.py` & бэкенд)
- **`code_snippet.py`**:
  - Содержит асинхронный класс `Ubisoft_Api` на базе библиотеки `aiohttp`.
  - **`authenticate()`**: Формирует заголовок `Authorization: Basic Base64(email:password)`, отправляет POST-запрос на `https://public-ubiservices.ubi.com/v3/profiles/sessions` с базовым AppId (`2c2d31af-...`). Возвращает `ticket` (Ubisoft JWT-токен), `sessionId`, `profileId`, `userId`.
  - **`refresh_token()`**: Обновляет сессию, у которой истекает срок действия, отправляя заголовок `Authorization: ubi_v1 t=<ticket>`.

---

### 🟢 Node.js Бэкенд и Модули (`ticket-manager/server/`)

#### 1. `index.js` - Точка входа сервера
- **Технологии**: Express, `ws` (WebSocket), `better-sqlite3`, CORS.
- **Назначение**: Поднимает HTTP-сервер (порт `3950`) и WebSocket (`/ws`) для Live-обновлений дашборда.
- **Основные эндпоинты**:
  - `GET /api/accounts` - список аккаунтов и их статусов.
  - `POST /api/accounts/import-csv` - импорт аккаунтов из файлов CSV.
  - `POST /api/tickets/create/:accountId` - запуск пайплайна создания тикета.
  - `POST /api/tokens/refresh-all` - принудительное обновление всех токенов.

#### 2. `database.js` - Слой работы с БД
- **Технология**: SQLite (`better-sqlite3`).
- **Таблицы**:
  - `accounts`: Хранит учетные данные (логин, пароль, прокси, статус, ubisoft_token, platform).
  - `tickets`: Информацию о созданных тикетах (`case_number`, `status`, `contact_email`).
  - `messages`: Историю переписки с агентами поддержки Ubisoft.
  - `settings`: Настройки системы (прокси, ключи API, пути к браузерам).

#### 3. `ubisoft-api.js` - Низкоуровневый клиент Ubisoft CSHelp API
- **`authenticate(email, password, proxy)`**: Базовый вход в Ubisoft.
- **`elevateSession(ticket, proxy)`**: Выполняет повторный вызов `/v3/profiles/sessions` с `Ubi-AppId: 4391c956-8943-48eb-8859-07b0778f47b9` (`TICKET_APP_ID`). Без этого шага сервер отвечает `401 Unauthorized` при попытке создать тикет.
- **`createTicket(params)`**: Отправляет POST на `/v1/applications/global/cshelp/cases/api/account-recovery-cases` со специальным заголовком `Ubi-GenomeId: 1a6f2698-1350-416e-b8e8-29d77fb86437` и токеном reCAPTCHA в теле запроса.

#### 4. `xbox-oauth.js` - OAuth-авторизация Microsoft/Xbox + IMAP OTP
- **Зачем нужен**: Часть аккаунтов привязана к Xbox. Xbox OAuth позволяет войти без прямого пароля Ubisoft.
- **Цепочка (OAuth Chain)**:
  1. Логин на `login.live.com` (POST с логином/паролем Microsoft).
  2. Перехват редиректов и получения кода авторизации.
  3. Если Microsoft запрашивает подтверждение безопасности (`identity/confirm`) - задействуется **`handleIdentityConfirmOTP`**, который триггерит отправку одноразового кода на почту, подключается по **IMAP** через `imapflow`, парсит код с помощью регулярных выражений и отправляет его обратно в Microsoft.
  4. Обмен MS токена на Xbox Live токен (`user.auth.xboxlive.com`).
  5. Получение XSTS токена (`xsts.auth.xboxlive.com`).
  6. Обмен XSTS токена на сессию Ubisoft с правом создания тикетов.

#### 5. `ticket-creator.js` - Оркестратор пайплайна создания тикетов
- Связывает авторизацию, рефреш сессии, решение капчи и вызов API.
- Содержит логику обработки ошибок Ubisoft API (например, `6010` - ограда reCAPTCHA, `6020` - аккаунт не найден, `7050` - rate limit).

#### 6. `captcha-solver.js` & `captcha-browser.js` - Обход reCAPTCHA Enterprise
- **`captcha-solver.js`**: Интеграция с API Capsolver (`ReCaptchaV3EnterpriseTaskProxyLess`).
- **`captcha-browser.js`**: Включает headless Chrome с плагином `puppeteer-extra-plugin-stealth`, перехватывает сетевые запросы и выполняет `grecaptcha.enterprise.render()` на домене `ubisoft.com` с `recaptcha.net` для получения чистого токена с высоким доверием (high score).

#### 7. `ticket-monitor.js` - Фоновый мониторинг ответов
- Каждые 45 секунд опрашивает Ubisoft API на предмет изменения статуса кейсов (`Open`, `In Progress`, `Waiting for Customer Response`).
- Игнорирует тестовые тикеты (с префиксом `CS-`).

#### 8. `camofox-launcher.js` & `form-bot.js` - Резервные антидетект-инструменты
- **`camofox-launcher.js`**: Запускает внешние инстансы браузера CamoFox с прокси для ручной проверки или допредоставления доказательств владельца аккаунта.

---

## 🧠 3. Важнейшие технические концепты для ответа на собеседовании

### 🔑 1. Что такое Session Elevation в Ubisoft API?
> **Ответ:** Ubisoft использует разные `AppId` для разграничения прав доступа. Для обычного входа используется клиентский `Ubi-AppId` (`2c2d31af-...`). Однако методы обращения в поддержку (`CSHelpAPI`) требуют привилегированного токена. Мы передаем действующий токен авторизации в повторный POST-запрос на `/v3/profiles/sessions`, но уже с `Ubi-AppId: 4391c956-8943-48eb-8859-07b0778f47b9`. Сервер возвращает новый `ticket`, сфокусированный под права работы с тикетами support-системы.

### 🛡️ 2. Почему возникает ошибка 6010 и как она обходится?
> **Ответ:** Ошибка `6010` генерируется сервером Ubisoft, когда капча-токен не проходит валидацию Google reCAPTCHA Enterprise. Мы **полностью обходим капчу** для большинства аккаунтов (Xbox/PSN), используя **Xbox OAuth Flow**. Авторизуясь через Microsoft, мы получаем валидный `accessToken`, который Ubisoft принимает напрямую, минуя проверку капчи.

### 📧 3. Как устроена работа с IMAP OTP для Microsoft/Xbox?
> **Ответ:** У учетных записей Microsoft часто срабатывает шаг проверки безопасности (`identity/confirm`). Наш Python бэкенд автоматизировал его:
> 1. Скрипт кликает кнопку отправки кода на резервный e-mail (или через SendOtt API).
> 2. Подключается к IMAP-серверу (например, mail.notlettersmail.com).
> 3. Ищет письмо от Microsoft, извлекает 4-7 значный код через регулярные выражения.
> 4. Отправляет код в форму подтверждения и завершает OAuth-авторизацию.

---

## 🎯 4. Топ вопросов и ответов на собеседовании (Interview Cheat Sheet)

#### ❓ Вопрос 1: "Почему бэкенд переведен полностью на Python?"
> **Ответ:** Раньше мы использовали смешанный стек (Node.js + Python), но это создавало нестабильность и дублирование логики. Переход на чистый **Python (FastAPI + aiohttp)** позволил объединить сложный Xbox OAuth флоу, работу с IMAP, асинхронные HTTP запросы и вебсокеты в единую, производительную и легко поддерживаемую архитектуру. Python идеально подходит для сложных бот-сетей и автоматизации.

#### ❓ Вопрос 2: "Как устроена работа с базой данных и многопоточностью?"
> **Ответ:** Используется **SQLite3** с библиотекой `sqlite3` в синхронном режиме с WAL (Write-Ahead Logging). Это обеспечивает максимальную скорость чтения/записи и защищает от блокировок при частых опросах статусов тикетов асинхронными фоновыми тасками (`ticket-monitor`).

#### ❓ Вопрос 3: "Зачем нужен заголовок Ubi-GenomeId?"
> **Ответ:** `Ubi-GenomeId` (значение `1a6f2698-1350-416e-b8e8-29d77fb86437`) - это внутренний идентификатор веб-платформы Ubisoft Help в crm-системе Ubisoft (Railyard/Genome). Без него бэкенд не сможет сопоставить тикет с правильным веб-регионом (EMEA/NCSA).

#### ❓ Вопрос 4: "Как система защищена от банов по IP (Rate Limits / IP Bans)?"
> **Ответ:** Все сетевые запросы (как к Ubisoft API, так и к Microsoft OAuth и IMAP) ротируются через резидентские HTTP/HTTPS прокси (`proxy_us`), которые настраиваются динамически в таблице `settings` и передаются в aiohttp сессии.

---
