// Assistente do Telegram: recebe as mensagens do casal, entende o gasto com a IA,
// grava no banco e responde com quanto falta em cada limite. Também avisa a outra
// pessoa de cada compra, manda os alertas de limite e o lembrete diário das contas.
//
// Segredos (configurados no Supabase em Edge Functions > Secrets, nunca no código):
//   TG_BOT_TOKEN         token do bot, dado pelo @BotFather
//   TG_WEBHOOK_SECRET    senha combinada (letras e números) para o Telegram e o lembrete diário
//   ANTHROPIC_API_KEY    chave da IA
//   CLAUDE_MODEL         opcional, modelo da IA (padrão claude-opus-5-5)
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem em toda função do Supabase.
//
// Endereços desta função:
//   POST (do Telegram)              mensagens recebidas pelo bot
//   GET  ?setup=<TG_WEBHOOK_SECRET> liga o bot a esta função (abrir uma vez no navegador)
//   POST ?cron=<TG_WEBHOOK_SECRET>  lembrete diário das contas (chamado pelo agendador do banco)
//   POST com login do app           o app avisa no Telegram sobre gastos lançados por ele

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk/helpers/zod";
import { z } from "npm:zod";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const TG = `https://api.telegram.org/bot${env("TG_BOT_TOKEN")}`;
const MODEL = env("CLAUDE_MODEL", "claude-opus-5-5");
const TZ_OFFSET_H = -3; // Santa Catarina (sem horário de verão)

const db: SupabaseClient = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
const ai = new Anthropic();

const CATEGORIES = ["Mercado", "Alimentação", "Bebê", "Saúde", "Transporte", "Casa", "Lazer", "Contas", "Outros"] as const;
const CARD_IDS = ["c6", "croma", "violeta", "nenhum"] as const;
const THRESHOLDS = [70, 90, 100];

type Card = { id: string; name: string; owner: string; limit: number; closingDay: number | null };
type Bill = { id: string; name: string; amount: number; dueDay: number | null; who: string };
type Settings = { incomes?: Record<string, number>; cards?: Card[]; catLimits?: Record<string, number>; fixedBills?: Bill[] };
type Member = { id: string; household_id: string; name: string; telegram_chat_id: number | null };
type Expense = { id: string; text: string; amount: number; category: string; card: string | null; person: string | null; date: string };

const DEFAULT_CARDS: Card[] = [
  { id: "c6", name: "C6", owner: "Casal", limit: 0, closingDay: null },
  { id: "croma", name: "Nubank Croma", owner: "Danilo", limit: 0, closingDay: null },
  { id: "violeta", name: "Nubank Violeta", owner: "Mikeli", limit: 0, closingDay: null },
];

/* ------------------------------------------------------------------ */
/* Datas no horário local                                              */
/* ------------------------------------------------------------------ */
// "Relógio local": um Date deslocado para que os getUTC* deem a hora de SC.
const toLocal = (d: Date) => new Date(d.getTime() + TZ_OFFSET_H * 3600e3);
const nowLocal = () => toLocal(new Date());
const monthKey = (l: Date) => `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, "0")}`;
const utcDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

function cardCycle(card: Card, ref = nowLocal()) {
  const cd = Number(card.closingDay);
  if (!cd || cd < 1 || cd > 31) {
    return { start: utcDay(ref.getUTCFullYear(), ref.getUTCMonth(), 1), end: utcDay(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1), key: monthKey(ref) };
  }
  const closing = (y: number, m: number) => {
    const last = utcDay(y, m + 1, 0).getUTCDate();
    return utcDay(y, m, Math.min(cd, last));
  };
  const thisClose = closing(ref.getUTCFullYear(), ref.getUTCMonth());
  const [start, end] = ref >= thisClose
    ? [thisClose, closing(ref.getUTCFullYear(), ref.getUTCMonth() + 1)]
    : [closing(ref.getUTCFullYear(), ref.getUTCMonth() - 1), thisClose];
  return { start, end, key: monthKey(end) };
}

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0").replace(",", "."))) || 0;

/* ------------------------------------------------------------------ */
/* IA: entender a mensagem                                             */
/* ------------------------------------------------------------------ */
const Intent = z.object({
  acao: z.enum(["registrar_gasto", "resumo", "contas", "apagar_ultimo", "ajuda", "conversa"]),
  gastos: z.array(z.object({
    descricao: z.string(),
    valor: z.number(),
    categoria: z.enum(CATEGORIES),
    cartao: z.enum(CARD_IDS),
  })),
  resposta: z.string(),
});
type IntentT = z.infer<typeof Intent>;

function systemPrompt(member: Member, cards: Card[], defaultCard: string) {
  const cardList = cards.map((c) => `- ${c.id}: ${c.name} (de ${c.owner})`).join("\n");
  return `Você é o assistente financeiro do casal Danilo e Mikeli (Mi), que vão ser pais. Você recebe mensagens de Telegram em português e decide o que a pessoa quer.

Quem está escrevendo: ${member.name}.

Ações:
- registrar_gasto: a pessoa contou uma compra ("mercado 120", "gastei 45 na farmácia no c6", foto de nota fiscal ou comprovante). Preencha "gastos" com uma entrada por compra. Valor em reais, como número (1.080,50 vira 1080.5). Descrição curta, com a primeira letra maiúscula, sem o valor e sem o nome do cartão.
- resumo: quer saber como estão os gastos, os limites ou quanto sobra.
- contas: quer saber das contas fixas ou do que falta pagar.
- apagar_ultimo: quer desfazer ou apagar o último lançamento.
- ajuda: pergunta o que você faz.
- conversa: qualquer outra coisa. Responda em "resposta" em uma ou duas frases.

Cartões:
${cardList}
Se a pessoa não disser o cartão, use "${defaultCard}". Use "nenhum" só para Pix, dinheiro ou débito.
Palavras como "ultravioleta" e "roxinho da Mi" significam violeta. "Croma" e "meu Nubank" (quando for o Danilo) significam croma.

Categorias: ${CATEGORIES.join(", ")}. "Bebê" para fralda, enxoval, pediatra, ultrassom, pré-natal etc. "Mercado" para supermercado e feira; "Alimentação" para restaurante, lanche e delivery.

Em "resposta", escreva uma frase curta e simpática só quando a ação for ajuda ou conversa; nas outras ações, deixe vazio. Se for foto de algo que não é compra, use conversa.`;
}

async function understand(member: Member, cards: Card[], defaultCard: string, text: string, image?: { data: string; mime: string }): Promise<IntentT | null> {
  const content: Anthropic.ContentBlockParam[] = [];
  if (image) {
    content.push({ type: "image", source: { type: "base64", media_type: image.mime as "image/jpeg", data: image.data } });
  }
  content.push({ type: "text", text: text || "(foto sem legenda)" });

  const res = await ai.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(Intent) },
    system: systemPrompt(member, cards, defaultCard),
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal") return null;
  return res.parsed_output ?? null;
}

/* ------------------------------------------------------------------ */
/* Regras: limites, avisos, resumo                                     */
/* ------------------------------------------------------------------ */
async function loadHousehold(householdId: string) {
  const { data: house } = await db.from("households").select("settings").eq("id", householdId).single();
  const settings: Settings = house?.settings ?? {};
  const saved = new Map((settings.cards ?? []).map((c) => [c.id, c]));
  const cards = DEFAULT_CARDS.map((c) => ({ ...c, ...(saved.get(c.id) ?? {}) }));

  // gastos dos últimos 70 dias bastam para o mês e para qualquer ciclo de fatura
  const since = new Date(Date.now() - 70 * 86400e3).toISOString();
  const { data: exps } = await db.from("expenses").select("id,text,amount,category,card,person,date")
    .eq("household_id", householdId).gte("date", since);
  const expenses: Expense[] = (exps ?? []).map((e) => ({ ...e, amount: num(e.amount) }));
  return { settings, cards, expenses };
}

function cardSpent(card: Card, expenses: Expense[]) {
  const cyc = cardCycle(card);
  return expenses.filter((e) => {
    const d = toLocal(new Date(e.date));
    return e.card === card.id && d >= cyc.start && d < cyc.end;
  }).reduce((s, e) => s + e.amount, 0);
}

function monthExpenses(expenses: Expense[]) {
  const mk = monthKey(nowLocal());
  return expenses.filter((e) => monthKey(toLocal(new Date(e.date))) === mk);
}

async function crossedAlerts(householdId: string, cards: Card[], settings: Settings, expenses: Expense[]) {
  const checks: { key: string; pct: number; msg: (t: number) => string }[] = [];
  for (const c of cards) {
    const lim = num(c.limit);
    if (lim <= 0) continue;
    const spent = cardSpent(c, expenses);
    checks.push({
      key: `card:${c.id}:${cardCycle(c).key}`,
      pct: (spent / lim) * 100,
      msg: (t) => t >= 100
        ? `🚨 ${c.name} passou do limite: ${brl(spent)} de ${brl(lim)}.`
        : `⚠️ ${c.name} chegou a ${Math.floor((spent / lim) * 100)}% do limite. Restam ${brl(lim - spent)}.`,
    });
  }
  const month = monthExpenses(expenses);
  for (const [cat, limRaw] of Object.entries(settings.catLimits ?? {})) {
    const lim = num(limRaw);
    if (lim <= 0) continue;
    const spent = month.filter((e) => e.category === cat).reduce((s, e) => s + e.amount, 0);
    checks.push({
      key: `cat:${cat}:${monthKey(nowLocal())}`,
      pct: (spent / lim) * 100,
      msg: (t) => t >= 100
        ? `🚨 ${cat} passou do limite do mês: ${brl(spent)} de ${brl(lim)}.`
        : `⚠️ ${cat} chegou a ${Math.floor((spent / lim) * 100)}% do limite do mês. Restam ${brl(lim - spent)}.`,
    });
  }
  if (!checks.length) return [];

  const { data: sentRows } = await db.from("alerts_sent").select("key,level")
    .eq("household_id", householdId).in("key", checks.map((c) => c.key));
  const sent = new Map((sentRows ?? []).map((r) => [r.key, r.level]));

  const out: string[] = [];
  for (const c of checks) {
    const reached = THRESHOLDS.filter((t) => c.pct >= t).pop() ?? 0;
    if (reached > (sent.get(c.key) ?? 0)) {
      await db.from("alerts_sent").upsert({ household_id: householdId, key: c.key, level: reached });
      out.push(c.msg(reached));
    }
  }
  return out;
}

function cardLine(c: Card, expenses: Expense[]) {
  const spent = cardSpent(c, expenses);
  const lim = num(c.limit);
  if (lim <= 0) return `💳 ${c.name}: ${brl(spent)}`;
  const pct = Math.round((spent / lim) * 100);
  const dot = pct >= 100 ? "🔴" : pct >= 90 ? "🟠" : pct >= 70 ? "🟡" : "🟢";
  return `${dot} ${c.name}: ${brl(spent)} de ${brl(lim)} (${pct}%)`;
}

function summaryText(settings: Settings, cards: Card[], expenses: Expense[]) {
  const income = Object.values(settings.incomes ?? {}).reduce((s, v) => s + num(v), 0);
  const fixed = (settings.fixedBills ?? []).reduce((s, b) => s + num(b.amount), 0);
  const spent = monthExpenses(expenses).reduce((s, e) => s + e.amount, 0);
  const lines = [
    `📊 Resumo do mês`,
    ...cards.map((c) => cardLine(c, expenses)),
    ``,
    `Renda: ${brl(income)}`,
    `Contas fixas: ${brl(fixed)}`,
    `Gastos: ${brl(spent)}`,
    `Sobra prevista: ${brl(income - fixed - spent)}`,
  ];
  return lines.join("\n");
}

async function billsText(householdId: string, settings: Settings) {
  const l = nowLocal();
  const mk = monthKey(l);
  const { data: paidRows } = await db.from("bills_paid").select("bill_id").eq("household_id", householdId).eq("month", mk);
  const paid = new Set((paidRows ?? []).map((r) => r.bill_id));
  const bills = [...(settings.fixedBills ?? [])].sort((a, b) => (a.dueDay ?? 99) - (b.dueDay ?? 99));
  if (!bills.length) return "Nenhuma conta fixa cadastrada ainda. Cadastre na aba Contas do app.";
  const today = l.getUTCDate();
  const lines = bills.map((b) => {
    if (paid.has(b.id)) return `✅ ${b.name}: ${brl(num(b.amount))}`;
    const when = !b.dueDay ? "" : b.dueDay < today ? ` · ⚠️ venceu dia ${b.dueDay}` : b.dueDay === today ? " · vence hoje" : ` · dia ${b.dueDay}`;
    return `⬜ ${b.name}: ${brl(num(b.amount))}${when}`;
  });
  const open = bills.filter((b) => !paid.has(b.id)).reduce((s, b) => s + num(b.amount), 0);
  return [`🧾 Contas fixas`, ...lines, ``, `Falta pagar: ${brl(open)}`].join("\n");
}

const HELP = `Oi! Eu anoto os gastos de vocês. É só mandar:
• "mercado 120" (vai no seu cartão)
• "farmácia 45 no c6"
• uma foto da nota ou do comprovante
• "resumo" para ver limites e sobra do mês
• "contas" para ver as contas fixas
• "apagar" para desfazer o último lançamento`;

/* ------------------------------------------------------------------ */
/* Telegram                                                            */
/* ------------------------------------------------------------------ */
async function tg(method: string, payload: Record<string, unknown>) {
  const r = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) console.error("telegram", method, r.status, JSON.stringify(j).slice(0, 300));
  return j;
}

const sendText = (chatId: number, text: string) =>
  tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });

async function downloadPhoto(fileId: string): Promise<{ data: string; mime: string } | null> {
  const info = await tg("getFile", { file_id: fileId });
  const path = info?.result?.file_path;
  if (!path) return null;
  const file = await fetch(`https://api.telegram.org/file/bot${env("TG_BOT_TOKEN")}/${path}`);
  if (!file.ok) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const ext = path.split(".").pop()?.toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return { data: btoa(bin), mime };
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function householdChats(householdId: string, exceptMemberId?: string) {
  let q = db.from("members").select("id,telegram_chat_id").eq("household_id", householdId).not("telegram_chat_id", "is", null);
  if (exceptMemberId) q = q.neq("id", exceptMemberId);
  const { data } = await q;
  return (data ?? []).map((m) => m.telegram_chat_id as number);
}

/* ------------------------------------------------------------------ */
/* Processar uma mensagem                                              */
/* ------------------------------------------------------------------ */
// deno-lint-ignore no-explicit-any
async function handleMessage(msg: any) {
  const chatId: number = msg.chat?.id;
  if (!chatId || msg.chat?.type !== "private") return;
  const text0: string = msg.text ?? msg.caption ?? "";

  // "/start CODIGO" vem do botão "Conectar Telegram" do app e liga a conversa à pessoa.
  if (text0.startsWith("/start")) {
    const code = text0.split(/\s+/)[1];
    if (code) {
      const { data: m } = await db.from("members").update({ telegram_chat_id: chatId, telegram_link_code: null })
        .eq("telegram_link_code", code).select("name").maybeSingle();
      if (m) {
        await sendText(chatId, `Prontinho, ${m.name}! Agora é só me mandar os gastos.\n\n${HELP}`);
        return;
      }
    }
  }

  const { data: member } = await db.from("members").select("id,household_id,name,telegram_chat_id").eq("telegram_chat_id", chatId).maybeSingle();
  if (!member) {
    await sendText(chatId, "Oi! Para eu saber quem é você, abra o app de finanças, vá em ⚙️ Ajustes e toque em “Conectar Telegram”.");
    return;
  }

  if (msg.voice || msg.audio || msg.video_note) {
    await sendText(chatId, "Ainda não consigo ouvir áudio 🙈. Use o microfone do teclado para ditar, que chega como texto.");
    return;
  }

  let image: { data: string; mime: string } | undefined;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    image = (await downloadPhoto(msg.photo[msg.photo.length - 1].file_id)) ?? undefined;
  } else if (msg.document && String(msg.document.mime_type).startsWith("image/")) {
    image = (await downloadPhoto(msg.document.file_id)) ?? undefined;
  }
  const lower = text0.trim().toLowerCase();
  if (!image && !text0.trim()) { await sendText(chatId, HELP); return; }

  const { settings, cards, expenses } = await loadHousehold(member.household_id);

  // atalhos que não precisam da IA
  if (!image && ["/resumo", "resumo"].includes(lower)) { await sendText(chatId, summaryText(settings, cards, expenses)); return; }
  if (!image && ["/contas", "contas"].includes(lower)) { await sendText(chatId, await billsText(member.household_id, settings)); return; }
  if (!image && ["/ajuda", "/help", "ajuda", "/start"].includes(lower)) { await sendText(chatId, HELP); return; }

  const own = cards.find((c) => c.owner === member.name);
  const defaultCard = own?.id ?? "c6";

  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  let intent: IntentT | null = null;
  try {
    intent = await understand(member as Member, cards, defaultCard, lower === "/apagar" ? "apagar o último" : text0, image);
  } catch (err) {
    console.error("erro na IA", err);
  }
  if (!intent) {
    await sendText(chatId, "Não consegui entender agora. Tente de novo em formato simples, ex: \"mercado 120\".");
    return;
  }

  switch (intent.acao) {
    case "registrar_gasto": {
      const valid = intent.gastos.filter((g) => g.valor > 0);
      if (!valid.length) {
        await sendText(chatId, "Não achei o valor. Mande assim: \"mercado 120\".");
        return;
      }
      const rows = valid.map((g, i) => ({
        id: `tg_${chatId}_${msg.message_id}_${i}`,
        household_id: member.household_id,
        text: g.descricao,
        amount: Math.round(g.valor * 100) / 100,
        category: g.categoria,
        card: g.cartao === "nenhum" ? null : g.cartao,
        person: member.name,
        date: new Date((Number(msg.date) || Date.now() / 1000) * 1000).toISOString(),
        source: "telegram",
      }));
      // o Telegram pode reenviar a mesma mensagem: o id evita lançar duas vezes
      const { data: inserted, error } = await db.from("expenses").upsert(rows, { onConflict: "id", ignoreDuplicates: true }).select("id");
      if (error) {
        console.error("erro ao gravar", error);
        await sendText(chatId, "Tive um problema para salvar. Tente de novo daqui a pouco.");
        return;
      }
      if (!inserted?.length) return;

      const all = [...expenses, ...rows];
      const lines = rows.map((r) => {
        const c = cards.find((x) => x.id === r.card);
        return `✅ ${r.text} · ${brl(r.amount)}${c ? ` · ${c.name}` : ""} · ${r.category}`;
      });
      const touched = cards.filter((c) => rows.some((r) => r.card === c.id));
      const alerts = await crossedAlerts(member.household_id, cards, settings, all);
      await sendText(chatId, [...lines, ...touched.map((c) => cardLine(c, all)), ...(alerts.length ? ["", ...alerts] : [])].join("\n"));

      const note = rows.map((r) => `${r.text} ${brl(r.amount)}`).join(", ");
      for (const other of await householdChats(member.household_id, member.id)) {
        await sendText(other, `🛍️ ${member.name} lançou: ${note}${alerts.length ? "\n\n" + alerts.join("\n") : ""}`);
      }
      return;
    }
    case "resumo":
      await sendText(chatId, summaryText(settings, cards, expenses));
      return;
    case "contas":
      await sendText(chatId, await billsText(member.household_id, settings));
      return;
    case "apagar_ultimo": {
      const since = new Date(Date.now() - 86400e3).toISOString();
      const { data: last } = await db.from("expenses").select("id,text,amount")
        .eq("household_id", member.household_id).eq("person", member.name).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!last) {
        await sendText(chatId, "Não achei nenhum lançamento seu nas últimas 24 horas para apagar.");
        return;
      }
      await db.from("expenses").delete().eq("id", last.id);
      await sendText(chatId, `🗑️ Apaguei: ${last.text} · ${brl(num(last.amount))}`);
      return;
    }
    case "ajuda":
      await sendText(chatId, HELP);
      return;
    default:
      await sendText(chatId, intent.resposta || HELP);
  }
}

/* ------------------------------------------------------------------ */
/* Lembrete diário das contas                                          */
/* ------------------------------------------------------------------ */
async function dailyReminders() {
  const l = nowLocal();
  const mk = monthKey(l);
  const today = l.getUTCDate();
  const { data: houses } = await db.from("households").select("id,settings");
  let sent = 0;
  for (const h of houses ?? []) {
    const bills: Bill[] = (h.settings as Settings)?.fixedBills ?? [];
    const { data: paidRows } = await db.from("bills_paid").select("bill_id").eq("household_id", h.id).eq("month", mk);
    const paid = new Set((paidRows ?? []).map((r) => r.bill_id));
    const due = bills.filter((b) => b.dueDay && !paid.has(b.id) && b.dueDay - today <= 3)
      .sort((a, b) => (a.dueDay ?? 0) - (b.dueDay ?? 0));
    if (!due.length) continue;
    const lines = due.map((b) => {
      const d = (b.dueDay ?? 0) - today;
      const when = d < 0 ? `venceu dia ${b.dueDay}` : d === 0 ? "vence hoje" : d === 1 ? "vence amanhã" : `vence dia ${b.dueDay}`;
      return `• ${b.name}: ${brl(num(b.amount))} · ${when}`;
    });
    const text = [`🧾 Contas para pagar`, ...lines, ``, `Quando pagar, marque no app (aba Contas).`].join("\n");
    for (const chat of await householdChats(h.id)) { await sendText(chat, text); sent++; }
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* Aviso de gastos lançados pelo app                                   */
/* ------------------------------------------------------------------ */
async function notifyFromApp(req: Request) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(jwt);
  if (!u?.user) return new Response("unauthorized", { status: 401 });
  const { data: member } = await db.from("members").select("id,household_id,name").eq("user_id", u.user.id).maybeSingle();
  if (!member) return new Response("forbidden", { status: 403 });

  // deno-lint-ignore no-explicit-any
  const body: any = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body.expenseIds) ? body.expenseIds.slice(0, 50).map(String) : [];
  const alerts: string[] = Array.isArray(body.alerts) ? body.alerts.slice(0, 10).map((a: unknown) => String(a).slice(0, 300)) : [];

  const parts: string[] = [];
  if (ids.length) {
    const { data: rows } = await db.from("expenses").select("text,amount,card").eq("household_id", member.household_id).in("id", ids);
    if (rows?.length) parts.push(`🛍️ ${member.name} lançou: ` + rows.map((r) => `${r.text} ${brl(num(r.amount))}`).join(", "));
  }
  if (parts.length) for (const chat of await householdChats(member.household_id, member.id)) await sendText(chat, parts.join("\n"));
  // alertas de limite vão para os dois
  if (alerts.length) for (const chat of await householdChats(member.household_id)) await sendText(chat, alerts.join("\n"));
  return new Response("ok");
}

/* ------------------------------------------------------------------ */
/* Entrada da função                                                   */
/* ------------------------------------------------------------------ */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const secret = env("TG_WEBHOOK_SECRET");
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  // Ligar o bot: abrir ?setup=SENHA uma vez no navegador.
  if (url.searchParams.has("setup")) {
    if (!safeEqual(url.searchParams.get("setup") ?? "", secret)) return new Response("senha errada", { status: 403 });
    const hook = `${env("SUPABASE_URL")}/functions/v1/telegram`;
    const r1 = await tg("setWebhook", { url: hook, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true });
    await tg("setMyCommands", { commands: [
      { command: "resumo", description: "Limites dos cartões e sobra do mês" },
      { command: "contas", description: "Contas fixas e o que falta pagar" },
      { command: "apagar", description: "Apagar o último lançamento" },
      { command: "ajuda", description: "Como usar" },
    ] });
    const me = await tg("getMe", {});
    return new Response(r1.ok ? `Tudo certo! O bot @${me?.result?.username} está ligado.` : `Não deu certo: ${r1.description ?? "erro"}`,
      { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  // Lembrete diário (agendado no banco).
  if (url.searchParams.has("cron")) {
    if (!safeEqual(url.searchParams.get("cron") ?? "", secret)) return new Response("forbidden", { status: 403 });
    return new Response(`enviados: ${await dailyReminders()}`);
  }

  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // Mensagens do Telegram trazem a senha combinada neste cabeçalho.
  const tgSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (tgSecret !== null) {
    if (!safeEqual(tgSecret, secret)) return new Response("forbidden", { status: 403 });
    // deno-lint-ignore no-explicit-any
    const update: any = await req.json().catch(() => ({}));
    const msg = update.message;
    if (msg) {
      const work = handleMessage(msg).catch((err) => console.error("falha", err));
      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(work); else await work;
    }
    return new Response("ok");
  }

  // Chamada do app (com o login da pessoa).
  const res = await notifyFromApp(req);
  return new Response(res.body, { status: res.status, headers: CORS });
});
