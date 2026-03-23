# Supabase Setup — TeraSwap Analytics

Tempo total: ~5 minutos. Plano gratuito (500MB, 50k rows).

---

## 1. Criar projecto no Supabase (2 min)

- Vai a **https://supabase.com** → "Start your project" → Sign in com GitHub
- **New Project**:
  - Nome: `teraswap`
  - Password: gera uma qualquer (guarda-a)
  - Region: **EU West (Frankfurt)**
  - Plano: **Free**
- Espera ~1 minuto até o projecto ficar ready

## 2. Copiar as credenciais (30 sec)

- No dashboard do projecto: **Settings → API**
- Copia o **Project URL** (algo como `https://abc123.supabase.co`)
- Copia a **anon public** key (começa com `eyJ...`)

## 3. Criar a tabela (1 min)

- No dashboard: **SQL Editor → New query**
- Abre o ficheiro `docs/supabase-schema.sql` deste projecto
- Copia tudo, cola no editor SQL do Supabase
- Clica **Run** — deve dizer "Success. No rows returned" (é normal, só cria a tabela)
- Verifica: **Table Editor** → deve aparecer `trade_events`

## 4. Adicionar ao .env.local (30 sec)

Abre o `.env.local` na raiz do projecto e adiciona no final:

```env
# ── Supabase ─────────────────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL=https://teu-projecto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...a-tua-anon-key
```

## 5. Testar (1 min)

```bash
npm run dev
```

- Abre o admin (`/admin?key=teraswap-alpha-2026`)
- Em development, o botão "Seed Demo Data" aparece — clica para gerar 350 trades
- Volta ao Supabase dashboard: **Table Editor → trade_events** → devem aparecer os 350 trades
- Refresca a página do admin → os dados devem carregar do Supabase

## Como funciona

O sistema é **dual-mode**:

- **Sem Supabase** (env vars vazias): tudo funciona em localStorage como antes
- **Com Supabase**: cada trade é salvo em localStorage + Supabase. No load, faz sync do Supabase → localStorage. Isto permite monitoring 24/7 sem PC ligado

Ficheiros relevantes:
- `src/lib/supabase.ts` — cliente singleton
- `src/lib/analytics-tracker.ts` — persistência dual (localStorage + Supabase)
- `src/hooks/useAnalytics.ts` — sync automático no mount
- `docs/supabase-schema.sql` — schema SQL completo

## Limites do plano gratuito

| Recurso | Limite |
|---------|--------|
| Base de dados | 500 MB |
| Rows | 50.000 |
| API requests | 500.000/mês |
| Storage | 1 GB |
| Edge Functions | 500.000 invocações/mês |

Para o TeraSwap analytics, 50k rows = ~50.000 trades antes de precisar do plano pago ($25/mês).
