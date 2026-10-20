-- Applied 2026-10-20: reminder fixes, subscription reminders and the admin panel.

-- More reminder kinds: 1 day before, overdue follow-ups and subscription expiry.
alter table public.debt_reminder_deliveries
  drop constraint if exists debt_reminder_deliveries_reminder_type_check;
alter table public.debt_reminder_deliveries
  add constraint debt_reminder_deliveries_reminder_type_check
  check (reminder_type ~ '^(before_3_days|before_1_day|due_today|overdue_[0-9]{1,4}|sub_[0-9]_days)$');

-- The hourly cron job authenticates with the key saved in Vault. The Edge Function asks the
-- database to compare it, so the Vault key and the function's own key don't have to match.
create or replace function public.verify_reminder_cron_token(token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(token) > 20 and exists (
    select 1 from vault.decrypted_secrets
     where name = 'reminder_service_role_key' and decrypted_secret = token
  ), false);
$$;
revoke execute on function public.verify_reminder_cron_token(text) from public, anon, authenticated;
grant execute on function public.verify_reminder_cron_token(text) to service_role;
