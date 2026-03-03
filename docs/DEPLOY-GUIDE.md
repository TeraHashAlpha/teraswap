# TeraSwap — Deploy Guide (Vercel + Supabase)

Guia passo a passo para colocar o TeraSwap online com persistência de analytics.

---

## Parte 1: Deploy no Vercel (Frontend)

### 1.1 Preparar o repositório

```bash
# Se ainda não tens Git inicializado:
cd dex-aggregator
git init
git add .
git commit -m "Initial commit — TeraSwap DEX meta-aggregator"
```

### 1.2 Criar conta no GitHub (se necessário)

1. Vai a https://github.com e cria uma conta
2. Cria um novo repositório (botão "+", "New repository")
3. Nome sugerido: `teraswap` (pode ser privado)
4. NÃO inicializes com README (já temos código)

### 1.3 Push para GitHub

```bash
git remote add origin https://github.com/TEU_USERNAME/teraswap.git
git branch -M main
git push -u origin main
```

### 1.4 Deploy no Vercel

1. Vai a https://vercel.com e faz Sign Up com a conta GitHub
2. Clica "Add New..." → "Project"
3. Seleciona o repositório `teraswap`
4. O Vercel detecta automaticamente que é Next.js
5. **Environment Variables** — adiciona as seguintes (copiar do `.env.local`):

| Variable | Valor |
|---|---|
| `NEXT_PUBLIC_ONEINCH_API_KEY` | (a tua key da 1inch) |
| `NEXT_PUBLIC_ZEROX_API_KEY` | (a tua key do 0x) |
| `NEXT_PUBLIC_ALCHEMY_KEY` | (a tua key do Alchemy) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | (a tua key do WalletConnect/Reown) |
| `NEXT_PUBLIC_FEE_RECIPIENT` | (o teu endereço Ethereum para fees) |

6. Clica "Deploy"
7. Em ~2 minutos terás um URL tipo: `https://teraswap-xxx.vercel.app`

### 1.5 Configurar domínio personalizado (opcional)

1. No dashboard do Vercel → Settings → Domains
2. Adiciona o teu domínio (ex: `teraswap.xyz`)
3. Configura os DNS records conforme indicado pelo Vercel

---

## Parte 2: Supabase (Persistência de Analytics)

### ⚠️ Nota importante

Neste momento o Analytics Dashboard funciona com **localStorage** (dados no browser).
Isto significa que os dados persistem entre sessões no mesmo browser, mas:
- Não estão disponíveis noutros dispositivos
- Perdem-se se o browser limpar dados
- Não tens acesso quando o PC está desligado

Para resolver isso, o passo seguinte é migrar para **Supabase** (base de dados PostgreSQL gratuita na cloud).

### 2.1 Criar conta no Supabase

1. Vai a https://supabase.com e faz Sign Up (pode ser com GitHub)
2. Clica "New project"
3. Nome: `teraswap-analytics`
4. Região: escolhe a mais perto de ti (ex: `eu-west-1` para Europa)
5. Define uma password para a base de dados (guarda-a!)
6. Clica "Create new project" — espera ~2 minutos

### 2.2 Criar a tabela de eventos

No dashboard do Supabase, vai a **SQL Editor** e executa:

```sql
-- Tabela principal de eventos de trade
CREATE TABLE trade_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('swap', 'dca_buy', 'limit_fill', 'sltp_trigger')),
  wallet TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  hour INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
  token_in TEXT NOT NULL,
  token_in_address TEXT NOT NULL,
  token_out TEXT NOT NULL,
  token_out_address TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  amount_out TEXT NOT NULL,
  volume_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  fee_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  tx_hash TEXT NOT NULL DEFAULT '',
  chain_id INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para queries rápidas
CREATE INDEX idx_trade_events_timestamp ON trade_events (timestamp DESC);
CREATE INDEX idx_trade_events_wallet ON trade_events (wallet);
CREATE INDEX idx_trade_events_source ON trade_events (source);
CREATE INDEX idx_trade_events_type ON trade_events (type);

-- Row Level Security (RLS) — permitir insert público, read público
ALTER TABLE trade_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public insert" ON trade_events
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public read" ON trade_events
  FOR SELECT USING (true);
```

### 2.3 Obter credenciais

No dashboard do Supabase:
1. Vai a **Settings** → **API**
2. Copia:
   - **Project URL** (ex: `https://xxxxx.supabase.co`)
   - **anon public key** (começa com `eyJ...`)

### 2.4 Adicionar ao Vercel

No dashboard do Vercel → Settings → Environment Variables, adiciona:

| Variable | Valor |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xxxxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJ...` (a anon key) |

### 2.5 Próximo passo: migração do código

Na próxima sessão de desenvolvimento, vou:
1. Instalar `@supabase/supabase-js`
2. Criar `lib/supabase.ts` com o client
3. Modificar `analytics-tracker.ts` para:
   - Write: enviar eventos para Supabase em vez de localStorage
   - Read: fetch dashboard data via Supabase queries
   - Fallback: manter localStorage como cache/offline backup
4. O dashboard continuará igual — apenas a source de dados muda

---

## Parte 3: Verificação

### Checklist pós-deploy

- [ ] Site carrega no URL do Vercel
- [ ] Wallet connect funciona (RainbowKit)
- [ ] Quotes aparecem ao inserir valores
- [ ] Tab "Analytics" mostra o dashboard (inicialmente vazio)
- [ ] Após um swap, o trade aparece em "Recent Trades"
- [ ] "Export Snapshot" descarrega JSON com dados de wallets

### Troubleshooting comum

| Problema | Solução |
|---|---|
| Build falha no Vercel | Verificar que todas as env vars estão configuradas |
| Quotes não aparecem | API keys podem estar erradas ou em falta |
| "Module not found" | Correr `npm install` localmente e fazer push |
| Analytics vazio | Normal se ainda não houve trades; faz um swap de teste |

---

## Custos estimados

| Serviço | Plano | Custo |
|---|---|---|
| Vercel | Hobby (free) | $0/mês |
| Supabase | Free tier | $0/mês (500MB DB, 1GB storage) |
| Alchemy | Free tier | $0/mês (300M compute units) |
| GitHub | Free (privado) | $0/mês |

**Total: $0/mês** para começar. Os free tiers são mais que suficientes para a fase inicial.
