/* =====================================================================
   CLOUDFLARE WORKER — прокси для Telegram Bot API
   ---------------------------------------------------------------------
   Сайт (GitHub Pages) отправляет сюда только результат теста.
   Токен бота хранится в переменных окружения Worker'а и на сайт не попадает.

   Переменные окружения (Settings → Variables):
     BOT_TOKEN        (Secret)  — токен от @BotFather
     CHAT_ID          (Secret)  — ваш chat_id
     ALLOWED_ORIGINS  (Text)    — через запятую, например:
                                  https://USERNAME.github.io
     CLIENT_KEY       (Secret, необязательно) — должен совпадать
                                  с TELEGRAM_CLIENT_KEY в config.js
   ===================================================================== */

const MAX_BODY = 32 * 1024;          // 32 КБ
const MAX_NAME = 80;
const MAX_TEST_ID = 40;
const MAX_OPEN_ANSWERS = 15;
const MAX_ANSWER_CHARS = 700;

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';
        const cors = corsHeaders(origin, env);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }
        if (request.method !== 'POST') {
            return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
        }
        if (!isOriginAllowed(origin, env)) {
            return json({ ok: false, error: 'origin_not_allowed' }, 403, cors);
        }
        if (env.CLIENT_KEY && request.headers.get('X-Test-Key') !== env.CLIENT_KEY) {
            return json({ ok: false, error: 'bad_key' }, 401, cors);
        }

        const len = Number(request.headers.get('Content-Length') || 0);
        if (len > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413, cors);

        let raw;
        try { raw = await request.text(); }
        catch { return json({ ok: false, error: 'bad_body' }, 400, cors); }
        if (raw.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413, cors);

        let data;
        try { data = JSON.parse(raw); }
        catch { return json({ ok: false, error: 'bad_json' }, 400, cors); }

        const clean = validate(data);
        if (!clean.ok) return json({ ok: false, error: clean.error }, 400, cors);

        if (!env.BOT_TOKEN || !env.CHAT_ID) {
            return json({ ok: false, error: 'not_configured' }, 500, cors);
        }

        const messages = buildMessages(clean.value)
            .concat(buildOpenAnswersMessages(clean.value, clean.openAnswers));

        try {
            for (const text of messages) {
                const res = await sendTelegram(env, text);
                if (!res.ok) {
                    return json({ ok: false, error: 'telegram_failed', detail: res.description || '' }, 502, cors);
                }
            }
        } catch (e) {
            return json({ ok: false, error: 'telegram_unreachable' }, 502, cors);
        }

        return json({ ok: true }, 200, cors);
    }
};

/* ------------------------- CORS ------------------------- */

function allowedList(env) {
    return String(env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function isOriginAllowed(origin, env) {
    const list = allowedList(env);
    if (!list.length) return true;              // список не задан — не ограничиваем
    if (!origin) return true;                   // запрос не из браузера
    return list.includes(origin) || list.includes('*');
}

function corsHeaders(origin, env) {
    const list = allowedList(env);
    const allow = (!list.length || list.includes('*')) ? (origin || '*')
        : (list.includes(origin) ? origin : list[0] || '*');
    return {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Test-Key',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    };
}

function json(obj, status, headers) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
    });
}

/* ------------------------- Валидация ------------------------- */

function str(v, max) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}
function int(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
}

function validate(d) {
    if (!d || typeof d !== 'object') return { ok: false, error: 'bad_payload' };

    const test = str(d.test, MAX_TEST_ID);
    if (!/^[a-z0-9_-]{2,40}$/i.test(test)) return { ok: false, error: 'bad_test' };

    const studentName = str(d.studentName, MAX_NAME);
    if (studentName.length < 2) return { ok: false, error: 'bad_name' };

    const score = int(d.score);
    if (score === null || score < 0 || score > 100) return { ok: false, error: 'bad_score' };

    const total = int(d.total);
    if (total === null || total < 1 || total > 500) return { ok: false, error: 'bad_total' };

    const correct = int(d.correct);
    if (correct === null || correct < 0 || correct > total) return { ok: false, error: 'bad_correct' };

    const duration = int(d.duration);

    let openAnswers = [];
    if (Array.isArray(d.openAnswers)) {
        openAnswers = d.openAnswers.slice(0, MAX_OPEN_ANSWERS).map(a => ({
            n: int(a && a.n) || 0,
            question: str(a && a.question, 300),
            answer: str(a && a.answer, MAX_ANSWER_CHARS),
            manual: !!(a && a.manual)
        })).filter(a => a.answer);
    }

    return {
        ok: true,
        value: {
            attemptId: str(d.attemptId, 60),
            test,
            testName: str(d.testName, 60) || test,
            studentName,
            score,
            correct,
            total,
            questionsTotal: int(d.questionsTotal) || total,
            errors: Math.max(0, int(d.errors) === null ? (total - correct) : int(d.errors)),
            manual: Math.max(0, int(d.manual) || 0),
            unanswered: Math.max(0, int(d.unanswered) || 0),
            passed: !!d.passed,
            passPercent: int(d.passPercent),
            duration: duration === null || duration < 0 ? 0 : Math.min(duration, 86400)
        },
        openAnswers
    };
}

/* ------------------------- Сообщение ------------------------- */

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function fmtDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return `${s} сек`;
    return `${m} мин ${String(s).padStart(2, '0')} сек`;
}

function moscowParts() {
    // Время в часовом поясе Europe/Moscow
    const f = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    });
    const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
    return { date: `${p.day}.${p.month}.${p.year}`, time: `${p.hour}:${p.minute}` };
}

function buildMessages(v) {
    const t = moscowParts();
    const status = v.passed ? '✅ ПРОЙДЕНО' : '📘 ТРЕБУЕТСЯ ДОРАБОТКА';

    let msg = '🎓 <b>НОВОЕ ТЕСТИРОВАНИЕ</b>\n\n';
    msg += `📚 Тема: <b>${esc(v.testName)}</b>\n`;
    msg += `👩‍🎓 Ученица: <b>${esc(v.studentName)}</b>\n\n`;
    msg += `📊 Результат: <b>${v.score}%</b>\n`;
    msg += `✅ Правильных: ${v.correct}/${v.total}\n`;
    msg += `❌ Ошибок: ${v.errors}\n`;
    if (v.manual > 0) msg += `📝 Открытых ответов на проверку: ${v.manual}\n`;
    if (v.unanswered > 0) msg += `⚠️ Без ответа: ${v.unanswered}\n`;
    msg += `\n🏆 Статус: <b>${status}</b>`;
    if (v.passPercent !== null) msg += ` (порог ${v.passPercent}%)`;
    msg += '\n';
    msg += `⏱ Время прохождения: ${fmtDuration(v.duration)}\n\n`;
    msg += `📅 Дата: ${t.date}\n🕐 Время: ${t.time}\n`;
    if (v.attemptId) msg += `\n🆔 <code>${esc(v.attemptId)}</code>`;

    return [msg];
}

function buildOpenAnswersMessages(v, openAnswers) {
    if (!openAnswers.length) return [];
    const header = `📝 <b>Открытые ответы</b>\n${esc(v.studentName)} · ${esc(v.testName)}\n\n`;
    const chunks = [];
    let cur = header;
    for (const a of openAnswers) {
        const block = `<b>Вопрос ${a.n}</b>\n<i>${esc(a.question)}</i>\n${esc(a.answer)}\n\n`;
        if (cur.length + block.length > 3800) { chunks.push(cur); cur = header; }
        cur += block;
    }
    if (cur.trim() !== header.trim()) chunks.push(cur);
    return chunks;
}

/* ------------------------- Telegram ------------------------- */

async function sendTelegram(env, text) {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: env.CHAT_ID,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        })
    });
    try { return await res.json(); }
    catch { return { ok: res.ok }; }
}
