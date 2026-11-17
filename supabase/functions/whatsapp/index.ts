// Assistente do WhatsApp: recebe as mensagens do casal, entende o gasto com a IA,
// grava no banco e responde com quanto falta em cada limite.
//
// Segredos (configurados no Supabase, nunca no código):
//   WA_VERIFY_TOKEN      texto combinado com a Meta para validar o webhook
//   WA_APP_SECRET        "App secret" do app na Meta (confere que a mensagem veio da Meta)
//   WA_ACCESS_TOKEN      token permanente do WhatsApp Cloud API
//   WA_PHONE_NUMBER_ID   id do número do assistente
//   ANTHROPIC_API_KEY    chave da IA
//   CLAUDE_MODEL         opcional, modelo da IA (padrão claude-opus-5-5)
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem em toda função do Supabase.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk/helpers/zod";
import { z } from "npm:zod";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const GRAPH = `https://graph.facebook.com/${env("WA_GRAPH_VERSION", "v23.0")}`;
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
type Member = { id: string; household_id: string; name: string; phone: string | null };
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
/* WhatsApp                                                            */
/* ------------------------------------------------------------------ */
async function sendText(to: string, body: string) {
  const r = await fetch(`${GRAPH}/${env("WA_PHONE_NUMBER_ID")}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("WA_ACCESS_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
  });
  if (!r.ok) console.error("whatsapp send failed", r.status, await r.text());
  return r.ok;
}

async function downloadMedia(mediaId: string): Promise<{ data: string; mime: string } | null> {
  const auth = { Authorization: `Bearer ${env("WA_ACCESS_TOKEN")}` };
  const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: auth });
  if (!meta.ok) return null;
  const { url, mime_type } = await meta.json();
  const file = await fetch(url, { headers: auth });
  if (!file.ok) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), mime: mime_type };
}

async function validSignature(raw: string, header: string | null) {
  const secret = env("WA_APP_SECRET");
  if (!secret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

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
  return `Você é o assistente financeiro do casal Danilo e Mikeli (Mi), que vão ser pais. Você recebe mensagens de WhatsApp em português e decide o que a pessoa quer.

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
    `📊 *Resumo do mês*`,
    ...cards.map((c) => cardLine(c, expenses)),
    ``,
    `Renda: ${brl(income)}`,
    `Contas fixas: ${brl(fixed)}`,
    `Gastos: ${brl(spent)}`,
    `*Sobra prevista: ${brl(income - fixed - spent)}*`,
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
  return [`🧾 *Contas fixas*`, ...lines, ``, `Falta pagar: ${brl(open)}`].join("\n");
}

const HELP = `Oi! Eu anoto os gastos de vocês. É só mandar:
• "mercado 120" (vai no seu cartão)
• "farmácia 45 no c6"
• uma foto da nota ou do comprovante
• "resumo" para ver limites e sobra do mês
• "contas" para ver as contas fixas
• "apagar" para desfazer o último lançamento`;

/* ------------------------------------------------------------------ */
/* Processar uma mensagem                                              */
/* ------------------------------------------------------------------ */
// deno-lint-ignore no-explicit-any
async function handleMessage(msg: any) {
  const from: string = msg.from;
  const { data: member } = await db.from("members").select("id,household_id,name,phone").eq("phone", from).maybeSingle();
  if (!member) {
    console.warn("mensagem de número não cadastrado ignorada");
    return;
  }

  if (msg.type === "audio") {
    await sendText(from, "Ainda não consigo ouvir áudio 🙈. Use o microfone do teclado para ditar, que chega como texto.");
    return;
  }

  let text = "";
  let image: { data: string; mime: string } | undefined;
  if (msg.type === "text") text = msg.text?.body ?? "";
  else if (msg.type === "image") {
    text = msg.image?.caption ?? "";
    image = (await downloadMedia(msg.image.id)) ?? undefined;
  } else if (msg.type === "document" && String(msg.document?.mime_type).startsWith("image/")) {
    text = msg.document?.caption ?? "";
    image = (await downloadMedia(msg.document.id)) ?? undefined;
  } else {
    await sendText(from, HELP);
    return;
  }

  const { settings, cards, expenses } = await loadHousehold(member.household_id);
  const own = cards.find((c) => c.owner === member.name);
  const defaultCard = own?.id ?? "c6";

  let intent: IntentT | null = null;
  try {
    intent = await understand(member, cards, defaultCard, text, image);
  } catch (err) {
    console.error("erro na IA", err);
  }
  if (!intent) {
    await sendText(from, "Não consegui entender agora. Tente de novo em formato simples, ex: \"mercado 120\".");
    return;
  }

  switch (intent.acao) {
    case "registrar_gasto": {
      const valid = intent.gastos.filter((g) => g.valor > 0);
      if (!valid.length) {
        await sendText(from, "Não achei o valor. Mande assim: \"mercado 120\".");
        return;
      }
      const rows = valid.map((g, i) => ({
        id: `wa_${msg.id}_${i}`,
        household_id: member.household_id,
        text: g.descricao,
        amount: Math.round(g.valor * 100) / 100,
        category: g.categoria,
        card: g.cartao === "nenhum" ? null : g.cartao,
        person: member.name,
        date: new Date(Number(msg.timestamp) * 1000 || Date.now()).toISOString(),
        source: "whatsapp",
      }));
      // a Meta pode reenviar a mesma mensagem: o id evita lançar duas vezes
      const { data: inserted, error } = await db.from("expenses").upsert(rows, { onConflict: "id", ignoreDuplicates: true }).select("id");
      if (error) {
        console.error("erro ao gravar", error);
        await sendText(from, "Tive um problema para salvar. Tente de novo daqui a pouco.");
        return;
      }
      if (!inserted?.length) return; // repetida

      const all = [...expenses, ...rows.map((r) => ({ ...r }))];
      const lines = rows.map((r) => {
        const c = cards.find((x) => x.id === r.card);
        return `✅ ${r.text} · ${brl(r.amount)}${c ? ` · ${c.name}` : ""} · ${r.category}`;
      });
      const touched = cards.filter((c) => rows.some((r) => r.card === c.id));
      const status = touched.map((c) => cardLine(c, all));
      const alerts = await crossedAlerts(member.household_id, cards, settings, all);
      await sendText(from, [...lines, ...status, ...(alerts.length ? ["", ...alerts] : [])].join("\n"));

      // avisa a outra pessoa da compra (só chega se ela falou com o assistente nas últimas 24h)
      const { data: others } = await db.from("members").select("phone,name")
        .eq("household_id", member.household_id).neq("id", member.id).not("phone", "is", null);
      for (const o of others ?? []) {
        const note = rows.map((r) => `${r.text} ${brl(r.amount)}`).join(", ");
        await sendText(o.phone, `🛍️ ${member.name} lançou: ${note}${alerts.length ? "\n" + alerts.join("\n") : ""}`);
      }
      return;
    }
    case "resumo":
      await sendText(from, summaryText(settings, cards, expenses));
      return;
    case "contas":
      await sendText(from, await billsText(member.household_id, settings));
      return;
    case "apagar_ultimo": {
      const since = new Date(Date.now() - 86400e3).toISOString();
      const { data: last } = await db.from("expenses").select("id,text,amount")
        .eq("household_id", member.household_id).eq("person", member.name).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!last) {
        await sendText(from, "Não achei nenhum lançamento seu nas últimas 24 horas para apagar.");
        return;
      }
      await db.from("expenses").delete().eq("id", last.id);
      await sendText(from, `🗑️ Apaguei: ${last.text} · ${brl(num(last.amount))}`);
      return;
    }
    case "ajuda":
      await sendText(from, HELP);
      return;
    default:
      await sendText(from, intent.resposta || HELP);
  }
}

/* ------------------------------------------------------------------ */
/* Entrada da função                                                   */
/* ------------------------------------------------------------------ */
Deno.serve(async (req) => {
  const url = new URL(req.url);

  // A Meta chama com GET uma vez para confirmar o endereço.
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === env("WA_VERIFY_TOKEN") && env("WA_VERIFY_TOKEN") !== "";
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "") : new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256")))) {
    return new Response("invalid signature", { status: 401 });
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }

  const messages = (body.entry ?? []).flatMap((e: any) => (e.changes ?? []).flatMap((c: any) => c.value?.messages ?? []));
  const work = Promise.all(messages.map((m: unknown) => handleMessage(m).catch((err) => console.error("falha", err))));

  // Responde rápido para a Meta e termina o trabalho em segundo plano.
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work); else await work;
  return new Response("ok");
});
