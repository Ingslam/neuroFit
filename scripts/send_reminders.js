/**
 * Скрипт умных напоминаний о тренировках для Telegram-бота NeuroFit.
 *
 * Логика:
 * 1. Загружает пользователей из Supabase (reminders_enabled = true).
 * 2. Игнорирует веб-тестеров (username = web_tester), незарегистрированные tg_id и тех, кто уже завершил программу.
 * 3. Считает локальное время каждого атлета (tz_offset_min, по умолчанию UTC+3 / Москва) и проверяет 18:00.
 * 4. Не отправляет уведомление, если сегодня уже отмечена тренировка (last_workout_date) или уже было напоминание.
 * 5. При блокировке бота пользователем (403 / blocked / chat not found) автоматически отключает reminders_enabled.
 *
 * Запуск: node scripts/send_reminders.js
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "https://tckwnjwbawyykrkmrjzt.supabase.co";
const FALLBACK_PUBLIC_KEY = "sb_publishable_O6u1FFuGZTUJcw_eDtgQNA__Hfpj7xu";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || FALLBACK_PUBLIC_KEY;

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const MINI_APP_URL = process.env.MINI_APP_URL || "https://ingslam.github.io/neuroFit/";
const TARGET_HOUR = Number.isFinite(Number(process.env.REMINDER_HOUR)) ? Number(process.env.REMINDER_HOUR) : 18;
const FORCE_SEND = process.env.FORCE_SEND === "1";
const STRICT_BOT_TOKEN = process.env.STRICT_BOT_TOKEN === "1";

const WORKOUT_DAYS_BY_PLAN = {
  2: new Set([1, 4]), // Пн, Чт
  3: new Set([1, 3, 5]), // Пн, Ср, Пт
  4: new Set([1, 2, 4, 6]), // Пн, Вт, Чт, Сб
};

function getLocalClock(tzOffsetMin) {
  const offset = typeof tzOffsetMin === "number" && Number.isFinite(tzOffsetMin) ? tzOffsetMin : 180;
  const local = new Date(Date.now() + offset * 60_000);
  return {
    day: local.getUTCDay(), // 0 = Вс .. 6 = Сб
    hour: local.getUTCHours(),
    dateStr: local.toISOString().slice(0, 10),
  };
}

function supabaseHeaders(extra = {}) {
  const h = { apikey: SUPABASE_KEY, ...extra };
  // Новые ключи Supabase (sb_secret_ / sb_publishable_) передаются только через apikey; Authorization нужен только для legacy JWT (eyJ...)
  if (SUPABASE_KEY && SUPABASE_KEY.startsWith("eyJ")) {
    h.Authorization = `Bearer ${SUPABASE_KEY}`;
  }
  return h;
}

async function patchUser(tgId, patch) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/neurofit_users?tg_id=eq.${tgId}`, {
      method: "PATCH",
      headers: supabaseHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(patch),
    });
  } catch {
    /* тихо игнорируем, если политика RLS или колонка ещё не настроены */
  }
}

async function run() {
  if (!BOT_TOKEN || BOT_TOKEN.includes("ТВОЙ_ТОКЕН")) {
    const msg = "Переменная окружения BOT_TOKEN не задана.";
    if (STRICT_BOT_TOKEN) {
      console.error(`[NeuroFit Reminders] ${msg}`);
      process.exit(1);
    }
    console.warn(`[NeuroFit Reminders] Режим сухого прогона: ${msg}`);
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("[NeuroFit Reminders] Используется клиентский ключ вместо SUPABASE_SERVICE_ROLE_KEY.");
  }

  console.log(`[NeuroFit Reminders] Запуск проверки (FORCE_SEND=${FORCE_SEND ? 1 : 0}).`);

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/neurofit_users?reminders_enabled=eq.true&select=*`, {
      headers: supabaseHeaders(),
    });

    if (!res.ok) {
      console.error("Ошибка запроса к Supabase:", res.status, await res.text());
      process.exitCode = 1;
      return;
    }

    const users = await res.json();
    console.log(`Найдено атлетов с активными уведомлениями: ${users.length}`);

    let sentCount = 0;
    let skippedDoneToday = 0;
    let skippedTimezone = 0;

    for (const u of users) {
      if (!u.tg_id || u.tg_id === 0) continue;
      if (u.username === "web_tester") continue;
      if (u.program_finished === true) continue;

      const { day, hour, dateStr } = getLocalClock(u.tz_offset_min);

      if (!FORCE_SEND && hour !== TARGET_HOUR) {
        skippedTimezone++;
        continue;
      }

      const planDays = WORKOUT_DAYS_BY_PLAN[u.plan_days] ? u.plan_days : 3;
      if (!WORKOUT_DAYS_BY_PLAN[planDays].has(day)) continue;

      if (u.last_workout_date === dateStr || u.last_reminder_date === dateStr) {
        skippedDoneToday++;
        continue;
      }

      const name = u.first_name || "Атлет";
      const week = u.current_week || 1;
      const text =
        `Привет, ${name}! Сегодня день тренировки (Неделя ${week}).\n\n` +
        `Программа готова: 35–40 минут работы — и ты ещё на шаг ближе к цели.`;

      if (BOT_TOKEN && !BOT_TOKEN.includes("ТВОЙ_ТОКЕН")) {
        try {
          const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: u.tg_id,
              text,
              reply_markup: {
                inline_keyboard: [[{ text: "Открыть тренировку", web_app: { url: MINI_APP_URL } }]],
              },
            }),
          });
          const tgData = await tgRes.json();

          if (tgData.ok) {
            console.log(`Отправлено напоминание для @${u.username || u.tg_id}`);
            sentCount++;
            await patchUser(u.tg_id, { last_reminder_date: dateStr });
          } else {
            const desc = String(tgData.description || "");
            console.warn(`Не удалось отправить пользователю ${u.tg_id}: ${desc}`);
            if (
              tgData.error_code === 403 ||
              /blocked|deactivated|chat not found|user is deleted/i.test(desc)
            ) {
              await patchUser(u.tg_id, { reminders_enabled: false });
            }
          }
        } catch (err) {
          console.error(`Ошибка отправки пользователю ${u.tg_id}:`, err.message);
        }
      } else {
        console.log(`[Тест] Уведомление для @${u.username || u.tg_id}: "${text.replace(/\n+/g, " ")}"`);
        sentCount++;
      }
    }

    console.log(
      `[NeuroFit Reminders] Завершено. Отправлено: ${sentCount}, пропущено (уже закрыта/напомнено): ${skippedDoneToday}, не в 18:00 по локальному времени: ${skippedTimezone}.`
    );
  } catch (err) {
    console.error("Ошибка выполнения скрипта:", err);
    process.exitCode = 1;
  }
}

run();
