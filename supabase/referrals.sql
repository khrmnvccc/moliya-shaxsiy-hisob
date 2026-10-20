-- Run once in Supabase Dashboard > SQL Editor, after reviewing the entire script.
-- Referral attribution is private to the server role; browser users cannot read or edit it.

alter table public.finance_accounts
  add column if not exists subscription_paid_at timestamptz;

create table if not exists public.finance_referral_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique check (code ~ '^[A-Z2-9]{8}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.finance_referrals (
  referred_user_id uuid primary key references auth.users(id) on delete cascade,
  referrer_user_id uuid not null references auth.users(id) on delete cascade,
  invitee_username text not null default '',
  clicked_at timestamptz not null,
  subscription_paid_at timestamptz,
  reward_paid_at timestamptz,
  created_at timestamptz not null default now(),
  constraint finance_referrals_no_self_referral check (referrer_user_id <> referred_user_id)
);

create index if not exists finance_referrals_referrer_idx
  on public.finance_referrals (referrer_user_id, clicked_at desc);

alter table public.finance_referral_codes enable row level security;
alter table public.finance_referrals enable row level security;
revoke all on table public.finance_referral_codes from public, anon, authenticated;
revoke all on table public.finance_referrals from public, anon, authenticated;
grant all on table public.finance_referral_codes to service_role;
grant all on table public.finance_referrals to service_role;
grant all on table public.finance_accounts to service_role;

create or replace function public.mark_referral_subscription_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.expires_at is not null
     and new.expires_at > now()
     and (tg_op = 'INSERT' or old.expires_at is distinct from new.expires_at) then
    new.subscription_paid_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists finance_accounts_mark_subscription_paid on public.finance_accounts;
create trigger finance_accounts_mark_subscription_paid
before insert or update of expires_at on public.finance_accounts
for each row execute function public.mark_referral_subscription_paid();

create or replace function public.credit_referral_after_subscription()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.subscription_paid_at is not null
     and (tg_op = 'INSERT' or old.subscription_paid_at is distinct from new.subscription_paid_at) then
    update public.finance_referrals
       set subscription_paid_at = new.subscription_paid_at
     where referred_user_id = new.user_id
       and subscription_paid_at is null
       and clicked_at <= new.subscription_paid_at;
  end if;
  return new;
end;
$$;

drop trigger if exists finance_accounts_credit_referral on public.finance_accounts;
create trigger finance_accounts_credit_referral
after insert or update on public.finance_accounts
for each row execute function public.credit_referral_after_subscription();

-- These are trigger-only routines, not public RPC endpoints.
revoke execute on function public.mark_referral_subscription_paid() from public, anon, authenticated;
revoke execute on function public.credit_referral_after_subscription() from public, anon, authenticated;
revoke execute on function public.backup_finance_account_before_update() from public, anon, authenticated;

-- If referral attribution was captured after account activation, credit it only
-- when the signed link click predates that recorded paid activation.

-- Referral payout marking and public-to-app leaderboard.
alter table public.finance_referral_codes
  add column if not exists display_name text not null default '';

update public.finance_referral_codes c
   set display_name = coalesce(nullif(split_part(u.email, '@', 1), ''), 'Ishtirokchi')
  from auth.users u
 where u.id = c.user_id
   and (c.display_name = '' or c.display_name is null);

create table if not exists public.finance_referral_payout_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.finance_referral_payout_admins enable row level security;
revoke all on table public.finance_referral_payout_admins from public, anon, authenticated;
grant all on table public.finance_referral_payout_admins to service_role;
grant select on public.finance_referral_codes, public.finance_referrals to service_role;

-- Make the confirmed site owner the only payout manager.
insert into public.finance_referral_payout_admins(user_id)
select user_id
  from public.finance_referral_codes
 where code = 'P8AQV4BT'
on conflict (user_id) do nothing;

create or replace function public.get_referral_leaderboard()
returns table(display_name text, paid_invites bigint, earned_amount bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(nullif(btrim(c.display_name), ''), 'Ishtirokchi') as display_name,
         count(*)::bigint as paid_invites,
         (count(*) * 10000)::bigint as earned_amount
    from public.finance_referral_codes c
    join public.finance_referrals r on r.referrer_user_id = c.user_id
   where r.reward_paid_at is not null
   group by c.user_id, c.display_name
   order by count(*) desc, c.display_name asc
   limit 50;
$$;
revoke execute on function public.get_referral_leaderboard() from public, anon, authenticated;
grant execute on function public.get_referral_leaderboard() to service_role;

