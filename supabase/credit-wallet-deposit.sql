-- Atomic and idempotent crediting for verified Malykzm wallet deposits.
-- Run this in the Supabase SQL Editor after deploying the backend code.

create or replace function public.credit_wallet_deposit(p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tx public.wallet_transactions%rowtype;
begin
  select *
    into tx
    from public.wallet_transactions
   where reference = p_reference
     and type = 'deposit'
   for update;

  if not found then
    raise exception 'Deposit reference not found';
  end if;

  if tx.status = 'successful' then
    return jsonb_build_object(
      'credited', false,
      'already_credited', true
    );
  end if;

  if tx.status <> 'pending' then
    raise exception 'Deposit is not pending';
  end if;

  insert into public.wallets (user_id, balance_kobo)
  values (tx.user_id, tx.amount_kobo)
  on conflict (user_id)
  do update
     set balance_kobo = public.wallets.balance_kobo + excluded.balance_kobo,
         updated_at = now();

  update public.wallet_transactions
     set status = 'successful'
   where id = tx.id;

  return jsonb_build_object(
    'credited', true,
    'already_credited', false
  );
end;
$$;

revoke all on function public.credit_wallet_deposit(text) from public, anon, authenticated;
grant execute on function public.credit_wallet_deposit(text) to service_role;
