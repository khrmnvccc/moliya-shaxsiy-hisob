const SITE_ORIGIN = "https://khrmnvccc.github.io";
const TABLE = "finance_accounts";
const REMINDERS = "debt_reminder_deliveries";
const REFERRAL_CODES = "finance_referral_codes";
const REFERRALS = "finance_referrals";
const REFERRAL_ADMINS = "finance_referral_payout_admins";
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
  await restJson(`${dbUrl.replace(/\/finance_accounts$/, "")}/${REFERRALS}`, dbHeaders, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ referrer_user_id: referrerId, referred_user_id: userId, invitee_username: username, clicked_at: new Date(ticket.issuedAt).toISOString(), ...(paid ? { subscription_paid_at: subscriptionPaidAt } : {}) }),
  });
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

function dateTashkent() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function sendDebtReminders(supabaseUrl: string, serviceKey: string, botToken: string) {
  const db = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const accountsResponse = await fetch(`${db}/${TABLE}?telegram_chat_id=not.is.null&reminders_enabled=eq.true&select=user_id,state,telegram_chat_id`, { headers });
  if (!accountsResponse.ok) throw new Error("Reminder accounts could not be loaded");
  const accounts = await accountsResponse.json();
  const today = dateTashkent();
  const todayUtc = new Date(`${today}T00:00:00Z`);
  let sent = 0;
  for (const account of accounts) {
    const prefs = account.state?.reminderPrefs || {};
    const localHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tashkent", hour: "2-digit", hourCycle: "h23" }).format(new Date());
    if ((prefs.time || "09:00").slice(0, 2) !== localHour) continue;
    for (const debt of account.state?.debts || []) {
      if (!debt?.due || !Array.isArray(debt.pays)) continue;
      const remaining = Number(debt.amt) - debt.pays.reduce((total: number, payment: any) => total + Number(payment?.a || 0), 0);
      if (!(remaining > 0)) continue;
      const dueUtc = new Date(`${debt.due}T00:00:00Z`);
      const daysLeft = Math.round((dueUtc.getTime() - todayUtc.getTime()) / 86400000);
      const reminderType = daysLeft === 3 && prefs.before !== false ? "before_3_days" : daysLeft === 0 && prefs.due !== false ? "due_today" : "";
      if (!reminderType) continue;
      const prior = await fetch(`${db}/${REMINDERS}?user_id=eq.${encodeURIComponent(account.user_id)}&debt_id=eq.${encodeURIComponent(debt.id)}&due_date=eq.${debt.due}&reminder_type=eq.${reminderType}&select=id`, { headers });
      if (!prior.ok) continue;
      if ((await prior.json()).length) continue;
      const body = reminderType === "before_3_days"
        ? `Eslatma: ${debt.kind === "t" ? "sizning" : "sizga qaytarilishi kerak bo'lgan"} “${String(debt.name).slice(0, 80)}” qarzining muddatiga 3 kun qoldi. Qolgan summa: ${Math.round(remaining).toLocaleString("uz-UZ")} so'm. Muddat: ${debt.due}.`
        : `Bugun “${String(debt.name).slice(0, 80)}” qarzining to'lash/qaytarish kuni. Qolgan summa: ${Math.round(remaining).toLocaleString("uz-UZ")} so'm.`;
      const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: account.telegram_chat_id, text: body }) });
      if (!telegramResponse.ok) continue;
      const insert = await fetch(`${db}/${REMINDERS}`, { method: "POST", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify({ user_id: account.user_id, debt_id: debt.id, due_date: debt.due, reminder_type: reminderType }) });
      if (insert.ok) sent++;
    }
  }
  return sent;
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
      if (origin || !serviceKey || (req.headers.get("authorization") || "") !== `Bearer ${serviceKey}`) return response({ ok: false, error: "Forbidden" }, 403);
      if (!supabaseUrl || !botToken) return response({ ok: false, error: "Reminder secrets are not configured" }, 503);
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

    const accountResponse = await fetch(`${dbUrl}?user_id=eq.${encodeURIComponent(userId)}&select=expires_at,subscription_paid_at,telegram_chat_id,state`, { headers: dbHeaders });
    if (!accountResponse.ok) return response({ ok: false, error: "Could not check subscription" }, 500);
    const accountRows = await accountResponse.json();
    const expiresAt = accountRows[0]?.expires_at;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      return response({ ok: false, error: "Obuna muddati tugagan. Yangilash uchun Telegram orqali yozing: @khrmnvccc" }, 402);
    }

    if (body.action === "load") {
      try {
        await captureReferral(body.referralTicket, serviceKey, dbUrl, dbHeaders, userId, String(authUser.email || "").split("@")[0], String(authUser.created_at || new Date().toISOString()), expiresAt || null, accountRows[0]?.subscription_paid_at || null);
      } catch { /* Referral attribution must not block account access. */ }
      const r = await fetch(`${dbUrl}?user_id=eq.${encodeURIComponent(userId)}&select=state`, { headers: dbHeaders });
      if (!r.ok) return response({ ok: false, error: "Could not load account" }, 500);
      const rows = await r.json();
      return response({ ok: true, state: rows[0]?.state ?? DEFAULT_STATE, telegramLinked: !!accountRows[0]?.telegram_chat_id });
    }
    if (body.action === "referrals") {
      const root = dbUrl.replace(/\/finance_accounts$/, "");
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
      const admins = await restJson(`${root}/${REFERRAL_ADMINS}?user_id=eq.${encodeURIComponent(userId)}&select=user_id`, dbHeaders);
      const leaderboard = await restJson(`${root}/rpc/get_referral_leaderboard`, dbHeaders, { method: "POST", body: "{}" });
      return response({ ok: true, code: own[0].code, referrals: rows || [], leaderboard: leaderboard || [], canManagePayouts: !!admins?.length, rewardPerPaidInvite: 10000 });
    }
    if (body.action === "mark_referral_paid") {
      const referredUserId = String(body.referredUserId || "");
      if (!UUID_RE.test(referredUserId)) return response({ ok: false, error: "Foydalanuvchi aniqlanmadi." }, 400);
      const root = dbUrl.replace(/\/finance_accounts$/, "");
      const admins = await restJson(`${root}/${REFERRAL_ADMINS}?user_id=eq.${encodeURIComponent(userId)}&select=user_id`, dbHeaders);
      if (!admins?.length) return response({ ok: false, error: "Bu amal faqat boshqaruvchiga ruxsat etilgan." }, 403);
      const payout = await fetch(`${root}/${REFERRALS}?referrer_user_id=eq.${encodeURIComponent(userId)}&referred_user_id=eq.${encodeURIComponent(referredUserId)}&subscription_paid_at=not.is.null&reward_paid_at=is.null&select=referred_user_id`, {
        method: "PATCH",
        headers: { ...dbHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ reward_paid_at: new Date().toISOString() }),
      });
      if (!payout.ok) return response({ ok: false, error: "To‘lov holatini saqlab bo‘lmadi." }, 500);
      if (!(await payout.json()).length) return response({ ok: false, error: "Bu taklif topilmadi, obunasi tasdiqlanmagan yoki mukofot avval belgilangan." }, 409);
      return response({ ok: true });
    }
    if (body.action === "link_telegram") {
      if (!botToken) return response({ ok: false, error: "Telegram bot serverda sozlanmagan." }, 503);
      const chatId = await telegramUser(String(body.initData || ""), botToken);
      const permissionCheck = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: "Qarz eslatmalari ulandi. Endi muddatdan 3 kun oldin va to'lash kuni xabar olasiz." }) });
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

