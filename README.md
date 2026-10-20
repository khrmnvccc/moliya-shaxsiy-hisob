# Pulim — shaxsiy moliya (Telegram Mini App)

- `index.html` — Telegram bot ichida ochiladigan ilova (hozir `https://khrmnvccc.github.io/asliddin/` da ishlaydi).
- `supabase/functions/telegram-finance/index.ts` — server (Supabase Edge Function): ma’lumotlarni saqlash, qarz eslatmalari, do‘st taklif mukofoti va admin panel.
- `supabase/*.sql` — bazaga qo‘llangan SQL o‘zgarishlar.
- `moliya-shaxsiy-hisob/` — eski, faqat brauzerda ishlaydigan versiya (ishlatilmaydi).

## Admin panel
`finance_referral_payout_admins` jadvalidagi foydalanuvchilarga **Ko‘proq → Admin panel** ko‘rinadi: yangi foydalanuvchi yaratish, obuna tugash sanasini belgilash/uzaytirish/to‘xtatish, parolni almashtirish va taklif mukofotlarini “To‘landi” deb belgilash.

## Eslatmalar
Supabase Cron har soat `send_reminders` chaqiradi. Qarz: 3 va 1 kun oldin, muddat kuni, kechikkanda 1, 3, 7 kundan keyin va so‘ng har hafta. Obuna: tugashiga 3 va 1 kun qolganda.
