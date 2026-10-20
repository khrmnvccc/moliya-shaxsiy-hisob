-- Run once in Supabase SQL Editor after deploying the updated Edge Function.
alter table public.finance_accounts
  add column if not exists telegram_chat_id text,
  add column if not exists reminders_enabled boolean not null default false;

create table if not exists public.debt_reminder_deliveries (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  debt_id text not null,
  due_date date not null,
  reminder_type text not null check (reminder_type in ('before_3_days', 'due_today')),
  sent_at timestamptz not null default now(),
  unique (user_id, debt_id, due_date, reminder_type)
);

alter table public.debt_reminder_deliveries enable row level security;
revoke all on table public.debt_reminder_deliveries from public, anon, authenticated;
grant all on table public.debt_reminder_deliveries to service_role;

create extension if not exists supabase_vault with schema vault;

-- Add the project URL, publishable key, and service_role key to Supabase Vault.
-- Replace each placeholder below with the value from your own Supabase project.
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'reminder_project_url');
select vault.create_secret('sb_publishable_YOUR_KEY', 'reminder_publishable_key');
select vault.create_secret('YOUR_SERVICE_ROLE_SECRET', 'reminder_service_role_key');
-- Also add TELEGRAM_BOT_TOKEN under Edge Functions -> Secrets.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname = 'debt-reminders-hourly';

select cron.schedule(
  'debt-reminders-hourly',
  '0 * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'reminder_project_url') || '/functions/v1/telegram-finance',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'reminder_publishable_key'),
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'reminder_service_role_key')
      ),
      body := '{"action":"send_reminders"}'::jsonb,
      timeout_milliseconds := 10000
    );
  $$
);

