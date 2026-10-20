# Qarz eslatmalarini Telegramga ulash

Saytdagi qarzlar oynasida **Eslatmalar → Sozlash** tugmasi bor. Har bir qarz uchun “Qaytarish muddati” sanasini kiriting. Telegram bot xabariga ruxsat olgandan so‘ng qarzning turi, ismi, qolgan summasi va muddati sizga yuboriladi.

## Supabase’da bir martalik sozlash

Bu o‘zgarishlar hozircha Supabase serveriga qo‘lda chiqarilishi kerak. GitHub Pages faqat sayt fayllarini yangilaydi; u Edge Function va ma’lumotlar bazasini avtomatik joylamaydi.

1. Supabase → **Edge Functions → telegram-finance → Code** bo‘limida `supabase/functions/telegram-finance/index.ts` faylining to‘liq kodini joylang va **Deploy updates** bosing.
2. Supabase → **Edge Functions → Secrets** bo‘limida `TELEGRAM_BOT_TOKEN` nomli secret yarating. Tokenni faqat shu maxfiy oynaga kiriting; HTML yoki GitHubga qo‘ymang.
3. Supabase → **SQL Editor** bo‘limida `supabase/debt-reminders.sql` ni oching. `YOUR_PROJECT_REF`, `sb_publishable_YOUR_KEY`, `YOUR_SERVICE_ROLE_SECRET` yozilgan joylarni o‘z loyihangiz qiymatlari bilan almashtirib, SQLni bir marta ishga tushiring. Service role kalitini hech kimga yubormang.
4. Saytni Telegram bot ichidan oching → **Qarzlar → Eslatmalar → Sozlash → Telegramni ulash**. Telegram ruxsat so‘rasa, **Ruxsat berish**ni bosing, keyin eslatmalarni yoqing va saqlang.

Soatlik jadval har bir foydalanuvchining tanlagan vaqtida (Toshkent vaqti) tekshiradi va 3 kun oldin hamda to‘lash kuni xabar yuboradi. Bir xil qarzga bir xil eslatma qayta yuborilmaydi. To‘liq qaytarilgan qarz haqida xabar yuborilmaydi.

SQL fayli Supabase Vault, Cron va HTTP kengaytmalarini yoqadi. Agar kengaytma loyihada mavjud bo‘lmasa yoki SQL xato qaytarsa, xato matnini ko‘rib, alohida sozlash kerak bo‘lishi mumkin.

