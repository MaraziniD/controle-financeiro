# Banco de dados na nuvem (Supabase)

Com o banco ligado, o app pede login por e-mail (sem senha) e o casal vê os mesmos dados em tempo real.

## Ligar o banco

1. Crie um projeto em supabase.com, na região South America (São Paulo).
2. No **SQL Editor**, rode `migrations/20261117000000_inicial.sql`. Depois, cadastre a casa e as pessoas:
   ```sql
   with casa as (insert into public.households (name) values ('Nossa casa') returning id)
   insert into public.members (household_id, name, email)
   select id, 'Danilo', 'EMAIL_DO_DANILO' from casa union all
   select id, 'Mikeli', 'EMAIL_DA_MIKELI' from casa;
   ```
   Os nomes precisam ser `Danilo` e `Mikeli`, iguais aos do app.
3. Em **Authentication → URL Configuration**, coloque o endereço do app em *Site URL* e em *Redirect URLs*.
4. Em **Project Settings → API**, copie o *Project URL* e a chave *anon public* para o `config.js`.

Nenhum e-mail, telefone ou valor real deve ser salvo neste repositório: ele é público.

## Assistente do WhatsApp (opcional, para depois)

A função `functions/whatsapp` recebe as mensagens, usa a IA para entender o gasto e grava no banco.
Ela precisa de um número de WhatsApp só para o assistente e destes segredos no Supabase
(Edge Functions → Secrets): `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `WA_ACCESS_TOKEN`,
`WA_PHONE_NUMBER_ID` e `ANTHROPIC_API_KEY`. O telefone de cada pessoa vai na coluna
`members.phone` (só números, com 55 e DDD).
