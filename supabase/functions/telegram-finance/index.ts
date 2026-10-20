const SITE_ORIGIN = "https://khrmnvccc.github.io";
const TABLE = "finance_accounts";
const REMINDERS = "debt_reminder_deliveries";
const REFERRAL_CODES = "finance_referral_codes";
const REFERRALS = "finance_referrals";
const REFERRAL_ADMINS = "finance_referral_payout_admins";
const APP_URL = Deno.env.get("APP_URL") || "https://khrmnvccc.github.io/asliddin/";
const LOGIN_DOMAIN = "khrmnvccc.github.io";
const REFERRAL_REWARD = 10000;
const DEFAULT_STATE = { tx: [], debts: [], cats: [], rate: 12500, init: 0, name: "", theme: "" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const enc = new TextEncoder();

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": SITE_ORIGIN,
      "Access-Control-Allow-Headers": "apikey, content-type, authorization, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
    },
  });
}

function validState(state: unknown) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const value = state as Record<string, unknown>;
  return Array.isArray(value.tx) && value.tx.length <= 10000 &&
    Array.isArray(value.debts) && value.debts.length <= 10000 &&
    Array.isArray(value.cats) && value.cats.length <= 100 &&
    JSON.stringify(value).length <= 750_000;
}

async function hmacHex(keyBytes: Uint8Array, message: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(value: string) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function unb64url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
}

async function signReferralTicket(payload: Record<string, unknown>, serviceKey: string) {
  const body = b64url(JSON.stringify(payload));
  const signature = await hmacHex(enc.encode(serviceKey), body);
  return `${body}.${signature}`;
}

async function readReferralTicket(ticket: unknown, serviceKey: string) {
  if (typeof ticket !== "string" || ticket.length > 2048) return null;
  const [body, signature, extra] = ticket.split(".");
  if (!body || !signature || extra) return null;
  const expected = await hmacHex(enc.encode(serviceKey), body);
  if (signature.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff) return null;
  try {
    const value = JSON.parse(unb64url(body));
    const issuedAt = Number(value.issuedAt);
    if (!/^[A-Z2-9]{8}$/.test(value.code) || !Number.isFinite(issuedAt) || Date.now() - issuedAt > 30 * 86400000 || issuedAt > Date.now() + 60000) return null;
    return { code: value.code as string, issuedAt };
  } catch { return null; }
}

async function restJson(url: string, headers: Record<string, string>, init?: RequestInit) {
  const r = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  if (!r.ok) throw new Error("Database request failed");
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function captureReferral(ticketValue: unknown, serviceKey: string, dbUrl: string, dbHeaders: Record<string, string>, userId: string, username: string, createdAt: string, expiresAt: string | null, subscriptionPaidAt: string | null) {
  const ticket = await readReferralTicket(ticketValue, serviceKey);
  if (!ticket) return;
  const codes = await restJson(`${dbUrl.replace(/\/finance_accounts$/, "")}/${REFERRAL_CODES}?code=eq.${encodeURIComponent(ticket.code)}&select=user_id`, dbHeaders);
  const referrerId = codes?.[0]?.user_id;
  if (!referrerId || referrerId === userId) return;
  const paid = !!subscriptionPaidAt && ticket.issuedAt <= Date.parse(subscriptionPaidAt) && !!expiresAt && Date.parse(expiresAt) > Date.now();
  if (!paid && ticket.issuedAt >= Date.parse(createdAt)) return;
  const inserted = await restJson(`${dbUrl.replace(/\/finance_accounts$/, "")}/${REFERRALS}`, dbHeaders, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ referrer_user_id: referrerId, referred_user_id: userId, invitee_username: username, clicked_at: new Date(ticket.issuedAt).toISOString(), ...(paid ? { subscription_paid_at: subscriptionPaidAt } : {}) }),
  });
  return paid && inserted?.length ? referrerId as string : null;
}

async function telegramUser(initData: string, botToken: string) {
  if (!initData || initData.length > 8192) throw new Error("Telegramni bot ichida oching va qayta urinib ko'ring.");
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";
  const fields = [...params.entries()].filter(([key]) => key !== "hash").sort(([a], [b]) => a.localeCompare(b));
  const check = fields.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(botToken)));
  const expectedHash = await hmacHex(secret, check);
  if (!receivedHash || expectedHash.length !== receivedHash.length) throw new Error("Telegram tasdig'i noto'g'ri.");
  let difference = 0;
  for (let i = 0; i < expectedHash.length; i++) difference |= expectedHash.charCodeAt(i) ^ receivedHash.toLowerCase().charCodeAt(i);
  const authDate = Number(params.get("auth_date"));
  if (difference !== 0 || !Number.isFinite(authDate) || Date.now() / 1000 - authDate > 86400 || authDate > Date.now() / 1000 + 60) throw new Error("Telegram tasdig'i eskirgan yoki noto'g'ri. Bot ichidan qayta oching.");
  const user = JSON.parse(params.get("user") || "null");
  if (!user?.id) throw new Error("Telegram akkaunti aniqlanmadi.");
  return String(user.id);
}

function tashkentParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function som(value: number) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " so'm";
}

function dmy(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

async function sendTelegram(botToken: string, chatId: string | null | undefined, text: string, withAppButton = true) {
  if (!chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        ...(withAppButton ? { reply_markup: { inline_keyboard: [[{ text: "📒 Ilovani ochish", web_app: { url: APP_URL } }]] } } : {}),
      }),
    });
    return r.ok;
  } catch { return false; }
}

function html(value: unknown) {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

// Overdue debts are reminded 1, 3 and 7 days after the due date, then every 7 days.
function overdueStep(daysLate: number) {
  return daysLate === 1 || daysLate === 3 || (daysLate >= 7 && daysLate % 7 === 0);
}

function debtReminderText(debt: any, remaining: number, daysLeft: number) {
  const mine = debt.kind === "t";
  const who = html(String(debt.name || "").slice(0, 80));
  const lines = [
    mine ? `Siz <b>${who}</b>ga qarzdorsiz.` : `<b>${who}</b> sizga qarzni qaytarishi kerak.`,
    `Qolgan summa: <b>${som(remaining)}</b>`,
    `Muddat: ${dmy(debt.due)}`,
  ];
  if (daysLeft > 0) return `⏰ <b>Qarz muddatiga ${daysLeft} kun qoldi</b>\n\n${lines.join("\n")}`;
  if (daysLeft === 0) return `📅 <b>Bugun qarz muddati</b>\n\n${lines.join("\n")}`;
  return `⚠️ <b>Qarz muddati ${-daysLeft} kun o'tib ketdi</b>\n\n${lines.join("\n")}\n\n${mine ? "To'lovni qilgan bo'lsangiz, ilovada belgilab qo'ying." : "Pul qaytarilgan bo'lsa, ilovada to'lovni belgilab qo'ying."}`;
}

async function sendDebtReminders(supabaseUrl: string, serviceKey: string, botToken: string) {
  const db = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const accounts = await restJson(`${db}/${TABLE}?telegram_chat_id=not.is.null&select=user_id,state,telegram_chat_id,reminders_enabled,expires_at`, headers);
  const now = tashkentParts();
  const todayUtc = Date.parse(`${now.day}T00:00:00Z`);
  let sent = 0;
  for (const account of accounts || []) {
    const prefs = account.state?.reminderPrefs || {};
    const deliveries = new Set<string>();
    const loadDeliveries = async () => {
      const since = new Date(todayUtc - 400 * 86400000).toISOString().slice(0, 10);
      const rows = await restJson(`${db}/${REMINDERS}?user_id=eq.${encodeURIComponent(account.user_id)}&due_date=gte.${since}&select=debt_id,due_date,reminder_type`, headers);
      for (const row of rows || []) deliveries.add(`${row.debt_id}|${row.due_date}|${row.reminder_type}`);
    };
    let loaded = false;
    const deliver = async (debtId: string, dueDate: string, type: string, text: string) => {
      if (!loaded) { await loadDeliveries(); loaded = true; }
      if (deliveries.has(`${debtId}|${dueDate}|${type}`)) return;
      // Claim the slot first so a slow or repeated cron run cannot send the same reminder twice.
      const claim = await fetch(`${db}/${REMINDERS}?on_conflict=user_id,debt_id,due_date,reminder_type`, { method: "POST", headers: { ...headers, Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ user_id: account.user_id, debt_id: debtId, due_date: dueDate, reminder_type: type }) });
      if (!claim.ok || !(await claim.json()).length) return;
      deliveries.add(`${debtId}|${dueDate}|${type}`);
      if (await sendTelegram(botToken, account.telegram_chat_id, text)) sent++;
      else await fetch(`${db}/${REMINDERS}?user_id=eq.${encodeURIComponent(account.user_id)}&debt_id=eq.${encodeURIComponent(debtId)}&due_date=eq.${dueDate}&reminder_type=eq.${type}`, { method: "DELETE", headers });
    };

    // Subscription ending soon: 3 days and 1 day before, sent at 10:00 Tashkent or later.
    if (account.expires_at && now.hour >= 10) {
      const expiresDay = tashkentParts(new Date(account.expires_at)).day;
      const daysLeft = Math.round((Date.parse(`${expiresDay}T00:00:00Z`) - todayUtc) / 86400000);
      if (daysLeft === 3 || daysLeft === 1) {
        await deliver("subscription", expiresDay, `sub_${daysLeft}_days`, `🔔 <b>Obunangiz ${daysLeft} kundan keyin tugaydi</b> (${dmy(expiresDay)}).\n\nUzaytirish uchun yozing: @khrmnvccc`);
      }
    }

    if (!account.reminders_enabled || !prefs.enabled) continue;
    // Send at the chosen hour, or later the same day if that hourly run was missed.
    if (now.hour < Number(String(prefs.time || "09:00").slice(0, 2))) continue;
    for (const debt of account.state?.debts || []) {
      if (!debt?.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(debt.due || "")) || !Array.isArray(debt.pays)) continue;
      const remaining = Number(debt.amt) - debt.pays.reduce((total: number, payment: any) => total + Number(payment?.a || 0), 0);
      if (!(remaining > 0.009)) continue;
      const daysLeft = Math.round((Date.parse(`${debt.due}T00:00:00Z`) - todayUtc) / 86400000);
      let type = "";
      if (daysLeft === 3 && prefs.before !== false) type = "before_3_days";
      else if (daysLeft === 1 && prefs.before !== false) type = "before_1_day";
      else if (daysLeft === 0 && prefs.due !== false) type = "due_today";
      else if (daysLeft < 0 && prefs.overdue !== false && overdueStep(-daysLeft)) type = `overdue_${-daysLeft}`;
      if (!type) continue;
      await deliver(String(debt.id), debt.due, type, debtReminderText(debt, remaining, daysLeft));
    }
  }
  return sent;
}

// The cron job sends the key stored in Vault. It may be a different (but valid) server key
// than the one this function receives, so the database compares it against Vault itself.
async function cronAllowed(authorization: string, supabaseUrl: string, serviceKey: string) {
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  if (token === serviceKey) return true;
  try {
    const ok = await restJson(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/verify_reminder_cron_token`, { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify({ token }) });
    return ok === true;
  } catch { return false; }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return response({}, 200);
  if (req.method !== "POST") return response({ ok: false, error: "Method not allowed" }, 405);

  try {
    const raw = await req.text();
    if (raw.length > 1_000_000) return response({ ok: false, error: "Request too large" }, 413);
    const body = JSON.parse(raw);
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const isCron = body.action === "send_reminders";
    if (isCron) {
      if (origin || !serviceKey || !supabaseUrl) return response({ ok: false, error: "Forbidden" }, 403);
      if (!(await cronAllowed(req.headers.get("authorization") || "", supabaseUrl, serviceKey))) return response({ ok: false, error: "Forbidden" }, 403);
      if (!botToken) return response({ ok: false, error: "Reminder secrets are not configured" }, 503);
      return response({ ok: true, sent: await sendDebtReminders(supabaseUrl, serviceKey, botToken) });
    }
    if (origin !== SITE_ORIGIN) return response({ ok: false, error: "Forbidden" }, 403);
    if (body.action === "referral_click") {
      if (!supabaseUrl || !serviceKey) return response({ ok: false, error: "Server is not configured" }, 503);
      const code = String(body.code || "").toUpperCase();
      if (!/^[A-Z2-9]{8}$/.test(code)) return response({ ok: false, error: "Taklif havolasi noto‘g‘ri" }, 400);
      const root = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
      const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
      const codes = await restJson(`${root}/${REFERRAL_CODES}?code=eq.${encodeURIComponent(code)}&select=code`, headers);
      if (!codes?.length) return response({ ok: false, error: "Taklif havolasi topilmadi" }, 404);
      const ticket = await signReferralTicket({ code, issuedAt: Date.now() }, serviceKey);
      return response({ ok: true, ticket });
    }
    const publishableKey = req.headers.get("apikey") || "";
    const accessToken = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!supabaseUrl || !serviceKey) return response({ ok: false, error: "Server is not configured" }, 503);
    if (!publishableKey || !accessToken) return response({ ok: false, error: "Login required" }, 401);

    const authResponse = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}` },
    });
    if (!authResponse.ok) return response({ ok: false, error: "Login expired. Please sign in again." }, 401);
    const authUser = await authResponse.json();
    const userId = typeof authUser?.id === "string" && UUID_RE.test(authUser.id) ? authUser.id : "";
    if (!userId) return response({ ok: false, error: "Invalid account" }, 401);

    const dbUrl = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/${TABLE}`;
    const dbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
    const root = dbUrl.replace(/\/finance_accounts$/, "");
    const isAdmin = async () => !!(await restJson(`${root}/${REFERRAL_ADMINS}?user_id=eq.${encodeURIComponent(userId)}&select=user_id`, dbHeaders))?.length;
    const chatIdOf = async (id: string) => (await restJson(`${dbUrl}?user_id=eq.${encodeURIComponent(id)}&select=telegram_chat_id`, dbHeaders))?.[0]?.telegram_chat_id || null;

    const accountResponse = await fetch(`${dbUrl}?user_id=eq.${encodeURIComponent(userId)}&select=expires_at,subscription_paid_at,telegram_chat_id,state`, { headers: dbHeaders });
    if (!accountResponse.ok) return response({ ok: false, error: "Could not check subscription" }, 500);
    const accountRows = await accountResponse.json();
    const expiresAt = accountRows[0]?.expires_at;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      return response({ ok: false, error: "Obuna muddati tugagan. Yangilash uchun Telegram orqali yozing: @khrmnvccc" }, 402);
    }

    if (body.action === "load") {
      try {
        const credited = await captureReferral(body.referralTicket, serviceKey, dbUrl, dbHeaders, userId, String(authUser.email || "").split("@")[0], String(authUser.created_at || new Date().toISOString()), expiresAt || null, accountRows[0]?.subscription_paid_at || null);
        if (credited && botToken) await sendTelegram(botToken, await chatIdOf(credited), `🎉 <b>Taklifingiz ishladi!</b>\n\n${html(String(authUser.email || "").split("@")[0])} obuna bo'ldi. Sizga ${som(REFERRAL_REWARD)} mukofot hisoblandi — tez orada kartangizga o'tkaziladi.`);
      } catch { /* Referral attribution must not block account access. */ }
      const r = await fetch(`${dbUrl}?user_id=eq.${encodeURIComponent(userId)}&select=state`, { headers: dbHeaders });
      if (!r.ok) return response({ ok: false, error: "Could not load account" }, 500);
      const rows = await r.json();
      return response({ ok: true, state: rows[0]?.state ?? DEFAULT_STATE, telegramLinked: !!accountRows[0]?.telegram_chat_id, isAdmin: await isAdmin() });
    }
    if (body.action === "referrals") {
      let own = await restJson(`${root}/${REFERRAL_CODES}?user_id=eq.${encodeURIComponent(userId)}&select=code`, dbHeaders);
      if (!own?.length) {
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => alphabet[n % alphabet.length]).join("");
        try {
          await restJson(`${root}/${REFERRAL_CODES}`, dbHeaders, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ user_id: userId, code }) });
        } catch { /* Another session may have created the code first. */ }
        own = await restJson(`${root}/${REFERRAL_CODES}?user_id=eq.${encodeURIComponent(userId)}&select=code`, dbHeaders);
      }
      if (!own?.length) return response({ ok: false, error: "Taklif havolasini yaratib bo‘lmadi. SQL sozlamasini tekshiring." }, 500);
      const displayName = String(authUser.email || "").split("@")[0].slice(0, 40) || "Ishtirokchi";
      await restJson(`${root}/${REFERRAL_CODES}?user_id=eq.${encodeURIComponent(userId)}`, dbHeaders, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ display_name: displayName }) });
      const rows = await restJson(`${root}/${REFERRALS}?referrer_user_id=eq.${encodeURIComponent(userId)}&select=referred_user_id,invitee_username,clicked_at,subscription_paid_at,reward_paid_at&order=clicked_at.desc&limit=500`, dbHeaders);
      const leaderboard = await restJson(`${root}/rpc/get_referral_leaderboard`, dbHeaders, { method: "POST", body: "{}" });
      return response({ ok: true, code: own[0].code, referrals: rows || [], leaderboard: leaderboard || [], canManagePayouts: await isAdmin(), rewardPerPaidInvite: REFERRAL_REWARD });
    }
    if (body.action === "mark_referral_paid") {
      const referredUserId = String(body.referredUserId || "");
      if (!UUID_RE.test(referredUserId)) return response({ ok: false, error: "Foydalanuvchi aniqlanmadi." }, 400);
      if (!(await isAdmin())) return response({ ok: false, error: "Bu amal faqat boshqaruvchiga ruxsat etilgan." }, 403);
      const payout = await fetch(`${root}/${REFERRALS}?referred_user_id=eq.${encodeURIComponent(referredUserId)}&subscription_paid_at=not.is.null&reward_paid_at=is.null&select=referrer_user_id,invitee_username`, {
        method: "PATCH",
        headers: { ...dbHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ reward_paid_at: new Date().toISOString() }),
      });
      if (!payout.ok) return response({ ok: false, error: "To‘lov holatini saqlab bo‘lmadi." }, 500);
      const paidRows = await payout.json();
      if (!paidRows.length) return response({ ok: false, error: "Bu taklif topilmadi, obunasi tasdiqlanmagan yoki mukofot avval belgilangan." }, 409);
      if (botToken) {
        const chat = await chatIdOf(paidRows[0].referrer_user_id);
        await sendTelegram(botToken, chat, `💸 <b>Mukofot yuborildi!</b>\n\n${html(paidRows[0].invitee_username || "Do'stingiz")}ni taklif qilganingiz uchun ${som(REFERRAL_REWARD)} kartangizga o'tkazildi. Rahmat!`);
      }
      return response({ ok: true });
    }
    if (String(body.action || "").startsWith("admin_")) {
      if (!(await isAdmin())) return response({ ok: false, error: "Bu bo‘lim faqat admin uchun." }, 403);
      const authAdmin = `${supabaseUrl.replace(/\/$/, "")}/auth/v1/admin/users`;
      const authHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
      const loginOf = (email: unknown) => String(email || "").split("@")[0];
      const listUsers = async () => {
        const users: any[] = [];
        for (let page = 1; page <= 20; page++) {
          const d = await restJson(`${authAdmin}?page=${page}&per_page=200`, authHeaders);
          users.push(...(d?.users || []));
          if (!d?.users || d.users.length < 200) break;
        }
        return users;
      };
      const expiryFrom = (value: unknown) => {
        if (value === null || value === "") return null;
        const day = String(value || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new Error("Sana noto‘g‘ri.");
        return `${day}T23:59:59+05:00`;
      };
      const referralOf = async (id: string) => (await restJson(`${root}/${REFERRALS}?referred_user_id=eq.${encodeURIComponent(id)}&select=referrer_user_id,invitee_username,subscription_paid_at`, dbHeaders))?.[0] || null;
      // Writes expires_at; the database triggers then credit the inviter's referral.
      const setExpiry = async (id: string, expires: string | null, extra: Record<string, unknown> = {}) => {
        const before = await referralOf(id);
        await restJson(`${dbUrl}?on_conflict=user_id`, dbHeaders, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ user_id: id, expires_at: expires, updated_at: new Date().toISOString(), ...extra }) });
        if (!botToken) return;
        if (expires && Date.parse(expires) > Date.now()) {
          await sendTelegram(botToken, await chatIdOf(id), `✅ <b>Obunangiz faollashtirildi</b>\n\nAmal qilish muddati: ${dmy(tashkentParts(new Date(expires)).day)} gacha.`);
        }
        const after = await referralOf(id);
        if (after && !before?.subscription_paid_at && after.subscription_paid_at) {
          await sendTelegram(botToken, await chatIdOf(after.referrer_user_id), `🎉 <b>Taklifingiz ishladi!</b>\n\n${html(after.invitee_username || "Do'stingiz")} obuna bo'ldi. Sizga ${som(REFERRAL_REWARD)} mukofot hisoblandi — tez orada kartangizga o'tkaziladi.`);
        }
      };
      try {
        if (body.action === "admin_overview") {
          const [users, accounts, referrals, admins] = await Promise.all([
            listUsers(),
            restJson(`${dbUrl}?select=user_id,expires_at,telegram_chat_id,updated_at`, dbHeaders),
            restJson(`${root}/${REFERRALS}?select=referrer_user_id,referred_user_id,invitee_username,clicked_at,subscription_paid_at,reward_paid_at&order=subscription_paid_at.desc.nullslast&limit=1000`, dbHeaders),
            restJson(`${root}/${REFERRAL_ADMINS}?select=user_id`, dbHeaders),
          ]);
          const byId = new Map<string, any>((accounts || []).map((a: any) => [a.user_id, a]));
          const loginById = new Map<string, string>(users.map((u: any) => [u.id, loginOf(u.email)]));
          const refById = new Map<string, any>((referrals || []).map((r: any) => [r.referred_user_id, r]));
          const adminIds = new Set((admins || []).map((a: any) => a.user_id));
          return response({
            ok: true,
            reward: REFERRAL_REWARD,
            users: users.map((u: any) => ({
              id: u.id,
              login: loginOf(u.email),
              createdAt: u.created_at,
              lastSignInAt: u.last_sign_in_at || null,
              expiresAt: byId.get(u.id)?.expires_at || null,
              telegram: !!byId.get(u.id)?.telegram_chat_id,
              invitedBy: refById.has(u.id) ? loginById.get(refById.get(u.id).referrer_user_id) || "" : "",
              admin: adminIds.has(u.id),
            })).sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt))),
            payouts: (referrals || []).filter((r: any) => r.subscription_paid_at && !r.reward_paid_at).map((r: any) => ({
              referredUserId: r.referred_user_id,
              invitee: loginById.get(r.referred_user_id) || r.invitee_username,
              referrer: loginById.get(r.referrer_user_id) || "",
              paidAt: r.subscription_paid_at,
            })),
          });
        }
        if (body.action === "admin_create_user") {
          const login = String(body.username || "").trim().toLowerCase();
          const password = String(body.password || "");
          if (!/^[a-z0-9_-]{3,32}$/.test(login)) return response({ ok: false, error: "Login 3–32 belgi: lotin harflari, raqam, _ yoki -." }, 400);
          if (password.length < 6 || password.length > 72) return response({ ok: false, error: "Parol kamida 6 belgi bo‘lsin." }, 400);
          const expires = expiryFrom(body.expiresAt);
          const inviter = String(body.referrer || "").trim().toLowerCase();
          let referrerId = "";
          if (inviter) {
            const found = (await listUsers()).find((u: any) => loginOf(u.email) === inviter);
            if (!found) return response({ ok: false, error: `“${inviter}” loginli taklifchi topilmadi.` }, 404);
            referrerId = found.id;
          }
          const created = await fetch(authAdmin, { method: "POST", headers: authHeaders, body: JSON.stringify({ email: `${login}@${LOGIN_DOMAIN}`, password, email_confirm: true }) });
          const createdBody = await created.json().catch(() => ({}));
          if (!created.ok) return response({ ok: false, error: /already|exists|registered/i.test(JSON.stringify(createdBody)) ? "Bu login band." : "Foydalanuvchini yaratib bo‘lmadi." }, 400);
          const newId = createdBody.id || createdBody.user?.id;
          if (referrerId && referrerId !== newId) {
            await restJson(`${root}/${REFERRALS}`, dbHeaders, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ referrer_user_id: referrerId, referred_user_id: newId, invitee_username: login, clicked_at: new Date().toISOString() }) });
          }
          await setExpiry(newId, expires, { state: { ...DEFAULT_STATE, name: login } });
          return response({ ok: true, id: newId, login });
        }
        if (body.action === "admin_set_expiry") {
          const target = String(body.targetUserId || "");
          if (!UUID_RE.test(target)) return response({ ok: false, error: "Foydalanuvchi aniqlanmadi." }, 400);
          await setExpiry(target, body.block ? new Date().toISOString() : expiryFrom(body.expiresAt));
          return response({ ok: true });
        }
        if (body.action === "admin_set_password") {
          const target = String(body.targetUserId || "");
          const password = String(body.password || "");
          if (!UUID_RE.test(target)) return response({ ok: false, error: "Foydalanuvchi aniqlanmadi." }, 400);
          if (password.length < 6 || password.length > 72) return response({ ok: false, error: "Parol kamida 6 belgi bo‘lsin." }, 400);
          const r = await fetch(`${authAdmin}/${target}`, { method: "PUT", headers: authHeaders, body: JSON.stringify({ password }) });
          if (!r.ok) return response({ ok: false, error: "Parolni o‘zgartirib bo‘lmadi." }, 500);
          return response({ ok: true });
        }
      } catch (e) {
        return response({ ok: false, error: e instanceof Error && /Sana/.test(e.message) ? e.message : "Admin amalini bajarib bo‘lmadi." }, 400);
      }
      return response({ ok: false, error: "Invalid request" }, 400);
    }
    if (body.action === "link_telegram") {
      if (!botToken) return response({ ok: false, error: "Telegram bot serverda sozlanmagan." }, 503);
      const chatId = await telegramUser(String(body.initData || ""), botToken);
      const permissionCheck = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: "✅ Qarz eslatmalari ulandi. Endi muddatdan 3 va 1 kun oldin, to'lash kuni va muddat o'tib ketsa xabar olasiz." }) });
      if (!permissionCheck.ok) return response({ ok: false, error: "Bot sizga xabar yubora olmadi. Telegram ruxsatini yoqing va botga /start yuboring." }, 400);
      const state = accountRows[0]?.state ?? DEFAULT_STATE;
      const r = await fetch(`${dbUrl}?on_conflict=user_id`, { method: "POST", headers: { ...dbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ user_id: userId, state, telegram_chat_id: chatId, updated_at: new Date().toISOString() }) });
      if (!r.ok) return response({ ok: false, error: "Telegram akkauntini saqlab bo'lmadi." }, 500);
      return response({ ok: true, linked: true });
    }
    if (body.action === "save" && validState(body.state)) {
      const r = await fetch(`${dbUrl}?on_conflict=user_id`, {
        method: "POST",
        headers: { ...dbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id: userId, state: body.state, reminders_enabled: !!body.state.reminderPrefs?.enabled, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return response({ ok: false, error: "Could not save account" }, 500);
      return response({ ok: true });
    }
    return response({ ok: false, error: "Invalid request" }, 400);
  } catch {
    return response({ ok: false, error: "Request failed" }, 400);
  }
});
