# 🔗 Frontend ↔ Backend Integration

> Что изменено, как всё связано, и как запускать.

---

## Архитектура

```
┌---------------------------------┐
│  FRONTEND (Vite SPA)            │
│  ticket-manager/src/            │
│  ├-- index.html                 │
│  ├-- main.js (2200+ строк)      │
│  └-- styles/index.css           │
│                                 │
│  Port: 5173 (dev) или dist/     │
└-----------┬---------------------┘
            │ HTTP API + WebSocket
            ▼
┌---------------------------------┐
│  BACKEND (FastAPI + Python)     │
│  ticket-manager/backend/        │
│  ├-- server.py      (API)       │
│  ├-- database.py    (SQLite)    │
│  ├-- ticket_pipeline.py         │
│  │   ├-- create_ticket_for_account() │
│  │   ├-- _token_refresh_loop() ←-- каждые 50 мин │
│  │   ├-- _ticket_monitor_loop() ←-- каждые 45 сек │
│  │   └-- AI auto-reply (Yunwu)  │
│  └-- ubisoft_api.py (Ubi HTTP)  │
│                                 │
│  Port: 3950                     │
│  WebSocket: ws://localhost:3950/ws │
│  DB: ticket-manager/data/tickets.db │
└---------------------------------┘
```

---

## Что было изменено

### 1. `backend/server.py` - AI Suggest endpoint
```diff
- # OpenRouter / DeepSeek Chat v3
- await session.post("https://openrouter.ai/api/v1/chat/completions", ...)
+ # Yunwu / DeepSeek V4 Flash  
+ from openai import OpenAI
+ client = OpenAI(api_key=api_key, base_url="https://yunwu.ai/v1")
+ response = client.chat.completions.create(model="deepseek-v4-flash:floor", ...)
```

Добавлены endpoints:
- `POST /api/tickets/{id}/ai-toggle` - включить/выключить AI auto-reply
- `POST /api/ai/test` - проверить соединение с Yunwu

### 2. `backend/database.py` - AI auto-reply storage
```diff
+ ALTER TABLE tickets ADD COLUMN ai_auto_reply INTEGER DEFAULT 0
+ def set_ticket_ai_auto(ticket_id, enabled)
+ def get_ai_auto_tickets() -> list
+ settings: ai_api_key, ai_model (default Yunwu)
```

### 3. `backend/ticket_pipeline.py` - AI auto-reply в мониторинге
Когда мониторинг находит новое сообщение от агента И `ai_auto_reply = 1`:
```python
# 1. Берёт API ключ из settings
# 2. Генерирует ответ через Yunwu
# 3. Отправляет через Ubisoft API (send_comment)
# 4. Сохраняет в messages (created_by = "AI Auto-Reply")
# 5. Обновляет статус тикета на "Awaiting Response"
# 6. Отправляет WebSocket event "ai_auto_replied"
```

### 4. `src/main.js` - Frontend UI
- **AI Auto-Reply toggle** - переключатель в чат-сайдбаре каждого тикета
- **WebSocket handler** - `ai_auto_replied` показывает тост + обновляет чат
- **`toggleAiAuto(ticketId, enabled)`** - JS функция вызова API

---

## 🔄 Token Refresh - что это и есть ли оно

### Зачем?
Ubisoft token (JWT) живёт **~1 час**. После этого API возвращает `401 Unauthorized`. 
Если не рефрешить - мониторинг и отправка ответов перестают работать.

### Есть ли у нас?
**✅ ДА, уже реализовано** в `backend/ticket_pipeline.py`:

```python
async def _token_refresh_loop():
    """Refresh tokens for all authenticated accounts periodically."""
    while True:
        interval = int(get_setting("token_refresh_minutes") or 50) * 60
        await asyncio.sleep(30)  # initial delay
        
        accounts = get_authenticated_accounts()
        for acc in accounts:
            if _needs_refresh(acc.get("token_expiry")):
                ref = await refresh_token(auth_data, proxy)
                # ... обновляет token в БД
```

### Как работает:
1. **Запускается автоматически** при старте сервера (`start_token_manager()`)
2. Каждые **50 минут** (настраивается в Settings -> Token Refresh Interval)
3. Проходит по всем authenticated аккаунтам
4. Если token истекает в ближайшие 15 минут -> рефрешит
5. Если refresh не сработал -> пытается re-login
6. Обновлённый token сохраняется в БД

### Настройка:
В GUI -> Settings -> Automation Thresholds -> TOKEN REFRESH INTERVAL (слайдер 10-55 мин)

---

## 🤖 AI Auto-Reply - как работает

### По умолчанию: ВЫКЛЮЧЕН
По ТЗ - "response SHOULD NOT auto send without user approval". 
Поэтому AI авто-ответ **выключен** для всех тикетов. 

### Как включить:
1. Открой тикет (нажми на тикет -> чат)
2. В правом сайдбаре -> **⚡ Quick Actions** -> **🤖 AI Auto-Reply** toggle
3. Когда включён:
   - Мониторинг обнаруживает новое сообщение агента
   - Yunwu AI генерирует ответ (2-4 предложения, на языке агента)
   - Ответ отправляется автоматически
   - Пользователю показывается тост: "🤖 AI auto-replied..."

### Когда выключён (по умолчанию):
- Мониторинг обнаруживает сообщение агента
- Пользователю показывается уведомление: "🔔 Agent replied!"
- Пользователь сам нажимает **🤖 AI Suggest** -> получает предложение
- Может нажать **✓ Accept & Send**, **✏️ Edit**, или **🔄 New**

---

## 🚀 Как запускать

### Шаг 1: Установить зависимости
```bash
cd "/home/caterinw/Downloads/Project Files/ticket-manager"

# Backend
pip install fastapi uvicorn openai

# Frontend
npm install
```

### Шаг 2: Собрать фронтенд
```bash
npm run build
```

### Шаг 3: Запустить
```bash
# Вариант A: Продакшн (собранный фронтенд обслуживается бэкендом)
python3 -m backend.server
# -> http://localhost:3950

# Вариант B: Dev режим (hot reload)
npm run dev
# -> Frontend: http://localhost:5173
# -> Backend: http://localhost:3950
```

### Что запускается автоматически:
При старте `server.py`:
1. ✅ **SQLite инициализация** + миграции (ai_auto_reply колонка)
2. ✅ **Token Manager** - рефрешит токены каждые 50 мин
3. ✅ **Ticket Monitor** - проверяет тикеты каждые 45 сек
4. ✅ **WebSocket** - живые уведомления в браузере
5. ✅ **AI Auto-Reply** - отвечает если включён для тикета

### Для тестирования (не убивай все аккаунты):
```bash
# Импортируй CSV через GUI -> Import CSV
# Или используй auto_ticket.py с --accounts 2:
cd "/home/caterinw/Downloads/Project Files/ticket-manager-py"
python3 auto_ticket.py --accounts 2
```

---

## API Endpoints (полный список)

| Method | Path | Описание |
|--------|------|----------|
| GET | `/api/dashboard` | Статистика |
| GET | `/api/tickets?platform=XBL&status=Open` | Список тикетов с фильтрами |
| GET | `/api/tickets/{id}` | Детали тикета |
| GET | `/api/tickets/{id}/messages` | Переписка |
| POST | `/api/tickets/{id}/reply` | Отправить ответ |
| POST | `/api/tickets/{id}/suggest` | AI предложение (Yunwu) |
| POST | `/api/tickets/{id}/ai-toggle` | Вкл/выкл AI авто-ответ |
| POST | `/api/tickets/{id}/close` | Закрыть тикет |
| POST | `/api/tickets/{id}/regenerate` | Закрыть + создать новый |
| POST | `/api/tickets/{id}/poll` | Принудительно обновить |
| DELETE | `/api/tickets/{id}` | Удалить тикет |
| GET | `/api/accounts` | Список аккаунтов |
| POST | `/api/accounts/{id}/login` | Авто-логин |
| POST | `/api/accounts/{id}/manual-auth` | Ручной токен |
| POST | `/api/accounts/{id}/browser/{platform}` | Открыть браузер |
| GET | `/api/stats/weekly?year=2026` | Недельная статистика |
| GET/PUT | `/api/settings` | Настройки |
| WS | `/ws` | WebSocket для live-уведомлений |

---

## WebSocket Events

| Event | Когда | Действие на фронте |
|-------|-------|--------------------|
| `new_agent_message` | Агент ответил | 🔔 Тост + звук + browser notification |
| `ai_auto_replied` | AI автоматически ответил | 🤖 Тост + обновление чата |
| `ticket_created` | Тикет создан | Обновить список |
| `ticket_closed` | Тикет закрыт | Обновить список |
| `ticket_status_changed` | Статус изменился | Обновить бейджи |
| `account_authenticated` | Аккаунт залогинен | Обновить таблицу |
| `ticket_agent_closed` | Агент закрыл тикет | ⚠️ Предупреждение |

---

## Файлы которые были изменены

| Файл | Что изменено |
|------|-------------|
| `backend/server.py` | OpenRouter -> Yunwu, AI toggle endpoint |
| `backend/database.py` | `ai_auto_reply` колонка + миграция + AI default settings |
| `backend/ticket_pipeline.py` | AI auto-reply в мониторе + `get_messages_by_ticket` import |
| `src/main.js` | AI toggle UI в чат-сайдбаре + `toggleAiAuto()` + WS handler |
