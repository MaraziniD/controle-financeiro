-- Assistente do Telegram: liga cada pessoa à sua conversa com o bot
-- e agenda o lembrete diário das contas.

alter table public.members
  add column if not exists telegram_chat_id bigint unique,
  add column if not exists telegram_link_code text unique;

-- O app chama esta função para gerar o código do botão "Conectar Telegram".
create or replace function public.telegram_link_code()
returns text language plpgsql security definer set search_path = public as $$
declare code text := replace(gen_random_uuid()::text, '-', '');
begin
  update public.members set telegram_link_code = code where user_id = auth.uid();
  if not found then raise exception 'pessoa não cadastrada'; end if;
  return code;
end $$;
revoke all on function public.telegram_link_code() from public, anon;
grant execute on function public.telegram_link_code() to authenticated;

-- Lembrete diário às 8h (horário de Brasília = 11h UTC).
-- Troque SENHA_DO_TELEGRAM pelo mesmo valor do segredo TG_WEBHOOK_SECRET
-- e ENDERECO_DO_PROJETO pelo endereço do Supabase.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('lembrete-contas', '0 11 * * *', $cron$
  select net.http_post(
    url := 'https://ENDERECO_DO_PROJETO.supabase.co/functions/v1/telegram?cron=SENHA_DO_TELEGRAM',
    body := '{}'::jsonb
  );
$cron$);
