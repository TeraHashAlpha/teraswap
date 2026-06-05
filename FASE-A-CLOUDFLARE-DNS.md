# Fase A — Hardening de Domínio (Cloudflare Registrar + Registry Lock + DNSSEC + YubiKey)

**Status:** pendente
**Urgência:** 🔴 MÁXIMA (executar esta semana)
**Custo:** ~$20/ano (Cloudflare at-cost) + $50 one-off (segunda YubiKey)
**Tempo estimado:** 2h trabalho activo + 5-7 dias aguardando transferência ICANN
**Motivação:** Incidente CoW Swap (14 Abr 2026) — DNS hijack no registrar. Este manual elimina a mesma classe de ataque para `teraswap.app`.

---

## Pré-requisitos (antes de começar)

- [ ] Acesso admin ao registrar actual do `teraswap.app` (verificar onde está: Namecheap, GoDaddy, Google Domains, etc.)
- [ ] YubiKey primária em mãos (já usada em GitHub/Vercel — serve)
- [ ] Email de admin do domínio acessível e com 2FA activo
- [ ] Cartão de crédito para Cloudflare (débito não aceite em alguns casos)
- [ ] **Segunda YubiKey comprada** (encomendar ANTES de começar se ainda não tens — chega em 2-5 dias, alinha com janela de transferência)

---

## Passo 1 — Comprar segunda YubiKey (se ainda não tens)

**Porquê:** ponto único de falha inaceitável. Se perdes a única YubiKey, perdes acesso ao domínio, GitHub, Vercel, Cloudflare. Game over.

**Onde comprar:**
- Oficial Yubico: https://www.yubico.com/store/ — YubiKey 5 NFC (~€55)
- Amazon EU: ~€55-65, entrega em 1-3 dias

**Modelo recomendado:** YubiKey 5 NFC (idêntica à que tens). Evita ter modelos diferentes — reduz complexidade.

**Onde guardar a backup:**
- Cofre físico em casa, OU
- Casa de familiar de confiança (pais, irmão), OU
- Safety deposit box (se já tens)

**NÃO guardar:**
- No mesmo sítio que a primária
- No escritório se partilhas espaço
- Em casa de colega de trabalho

---

## Passo 2 — Criar conta Cloudflare e preparar ambiente

1. Ir a https://dash.cloudflare.com/sign-up
2. Usar email dedicado para infra (recomendado: `ops@teraswap.app` ou similar — não email pessoal)
3. Activar 2FA **imediatamente após criar a conta**:
   - Settings → Authentication
   - Escolher "Security Key (WebAuthn)" como método primário
   - Registar YubiKey primária → dar-lhe nome "YubiKey-Primary-2026"
   - Registar YubiKey backup → dar-lhe nome "YubiKey-Backup-2026"
   - **NÃO usar TOTP/app autenticadora como método primário** — só como fallback de emergência
4. Gravar códigos de recovery num password manager seguro (1Password, Bitwarden)

**Verificação:** fazer logout e voltar a entrar usando a YubiKey. Se correr bem, avança.

---

## Passo 3 — Desbloquear domínio no registrar actual

Cada registrar chama este processo de forma diferente, mas o objectivo é o mesmo:
1. **Desactivar Domain Lock / Transfer Lock** no painel do registrar actual
2. **Pedir o EPP/Auth Code** (código de transferência — string alfanumérica ~16 chars)
3. **Desactivar WHOIS Privacy temporariamente** (alguns registrars bloqueiam transferência se privacy estiver on)
4. **Confirmar que o email de contacto admin está acessível** — vão ser enviados emails de verificação

**Nota crítica:** o `.app` TLD é gerido pela Google Registry e **requer HTTPS sempre**. A transferência não afecta isto.

---

## Passo 4 — Iniciar transferência para Cloudflare Registrar

1. Cloudflare Dashboard → Domain Registration → Transfer Domains
2. Inserir `teraswap.app`
3. Introduzir EPP/Auth Code obtido no Passo 3
4. Verificar WHOIS contact info (nome, email, endereço)
   - **Usar endereço comercial**, não residencial. Se não tens, usar PO Box ou serviço de proxy. **NUNCA** publicar endereço de casa.
5. Confirmar pricing — `.app` no Cloudflare custa ~$14/ano at-cost
6. Pagar. A transferência inicia.

**Tempo de espera:** 5-7 dias (ICANN exige este período mínimo). Podes fazer os próximos passos em paralelo à espera.

---

## Passo 5 — Durante a espera: preparar DNSSEC

Enquanto a transferência está pendente, prepara a configuração DNSSEC para activar assim que possível.

- DNSSEC cria uma cadeia criptográfica verificável do TLD até ao teu domínio
- Cloudflare faz isto automaticamente uma vez o domínio transferido
- Vais precisar de ir ao registrar (agora Cloudflare) → DNS → DNSSEC → Enable
- Copiar o DS record que Cloudflare gera

**Acção:** nada agora. Só anotar que este passo fica para depois da transferência completar.

---

## Passo 6 — Transferência completa: activar DNSSEC

Quando receberes email "Domain transfer completed":

1. Cloudflare Dashboard → `teraswap.app` → DNS → Settings
2. DNSSEC → Enable
3. Cloudflare mostra os valores de DS record (algorithm, key tag, digest)
4. Porque o domínio já está no Cloudflare Registrar, a activação é automática — não precisa de copiar para lado nenhum
5. Verificar em https://dnssec-analyzer.verisignlabs.com/teraswap.app que a cadeia está verde

**Verificação externa:** em ~2 horas após activação, testar em https://dnsviz.net/d/teraswap.app/ — devem aparecer todos os records assinados.

---

## Passo 7 — Activar Registry Lock

Este é o passo MAIS importante. Registry Lock = qualquer mudança DNS requer intervenção humana no registrar, não pode ser feita via API ou painel comprometido.

1. Cloudflare Dashboard → `teraswap.app` → Settings → Registry Lock
2. Se a opção estiver visível → activar directamente
3. Se não estiver visível → abrir ticket de suporte:
   - **Título:** "Enable Registry Lock for teraswap.app"
   - **Mensagem modelo (copia-cola):**
     ```
     Hello,

     I would like to enable Registry Lock on teraswap.app.
     This domain hosts a DeFi application and I want the
     strongest protection against DNS hijacking attacks.

     Please confirm the process and any additional verification
     required. I have 2FA enabled with hardware security keys.

     Thank you.
     ```
4. Aguardar resposta (normalmente 24-48h)
5. Seguir os passos de verificação que Cloudflare enviar (podem incluir verificação telefónica)

**Após activação:** qualquer alteração DNS futura vai exigir:
- 2FA com hardware key
- Possivelmente confirmação out-of-band (email secundário, SMS)
- Delay de 24-48h antes da mudança propagar

Isto é PROPOSITAL. Inconveniência > risco.

---

## Passo 8 — Validar setup completo

Checklist final:

- [ ] `teraswap.app` aparece em Cloudflare Registrar → Domains
- [ ] 2FA com YubiKey primária + backup na conta Cloudflare
- [ ] DNSSEC activo e validável em dnsviz.net
- [ ] Registry Lock confirmado por Cloudflare support
- [ ] WHOIS Privacy re-activado
- [ ] Password manager tem: credenciais Cloudflare, códigos recovery, serial numbers das 2 YubiKeys
- [ ] Documento de emergência criado (ver Passo 9)

---

## Passo 9 — Documento de emergência

Criar ficheiro **offline** (não no git, não no cloud público):

```
TERASWAP DOMAIN RECOVERY — CONFIDENTIAL

Registrar: Cloudflare Registrar
Account email: ops@teraswap.app
Password: [em 1Password, vault "TeraSwap-Infra"]
2FA: YubiKey-Primary + YubiKey-Backup (hardware)
Recovery codes: [em 1Password, separate entry]

DNSSEC: enabled
Registry Lock: enabled
DS record: [copy from Cloudflare dashboard]

If primary YubiKey is lost:
1. Use YubiKey-Backup (stored at [location])
2. Remove lost key from Cloudflare account
3. Order replacement within 48h

If both YubiKeys are lost:
1. Use recovery codes to disable 2FA
2. Re-enable with new hardware keys IMMEDIATELY
3. Do NOT leave account without 2FA for more than 30 min

If account is compromised:
1. Contact Cloudflare support IMMEDIATELY: https://support.cloudflare.com
2. Request Registry Lock prevents any DNS changes
3. Escalate to "emergency security incident"
```

Guardar em:
- Password manager (encrypted)
- Impresso em papel, dentro de envelope selado, em cofre
- NUNCA em Google Drive, Dropbox público, email

---

## Passo 10 — Adicionar `teraswap.app` ao scope do H2 (monitor TLS/DNS)

Quando o Sprint 5A for implementado, o H2 TLS/DNS watcher deve monitorizar **os 11 aggregators + o próprio teraswap.app**. Auto-detecção do próprio domínio é crítica — se um dia o nosso domínio for atacado, queremos saber em 30 segundos, não em 90 minutos como o CoW.

**Lembrete:** confirmar com o code agent no Sprint 5A que `teraswap.app` está incluído na lista de endpoints monitorizados em `data/source-fingerprints.json`.

---

## FAQ / Erros comuns

**"A transferência falhou com 'Authorization Code invalid'"**
→ Pedir novo EPP code ao registrar antigo. Códigos expiram em 5-14 dias.

**"O `.app` requer HTTPS — isto afecta a transferência?"**
→ Não. HSTS preload do `.app` é a nível TLD, mantido mesmo com mudança de registrar. Site continua acessível durante a transferência.

**"Posso transferir sem downtime?"**
→ Sim, se não alterares nameservers. Cloudflare Registrar usa os Cloudflare nameservers por default. Se o site já estava em Cloudflare (DNS), zero downtime. Se estava noutro DNS provider, configura os novos nameservers ANTES de iniciar transferência.

**"E o email? Vou perder emails em `@teraswap.app`?"**
→ Depende. Se usas Google Workspace ou similar, os MX records ficam. Mas a mudança de DNS pode causar 15-60 min de lag. Recomendação: aviso aos utilizadores + testar com email de teste antes da transferência.

---

## Timeline realista

| Dia | Acção |
|---|---|
| **Hoje** | Comprar segunda YubiKey, criar conta Cloudflare |
| **Dia 1-2** | YubiKey backup chega, desbloquear domínio, iniciar transferência |
| **Dia 3-7** | Aguardar ICANN (5-7d), transferência automática |
| **Dia 8** | DNSSEC activo, abrir ticket Registry Lock |
| **Dia 9-10** | Registry Lock confirmado |
| **Dia 10** | Documento de emergência criado, Fase A fechada ✅ |

---

## Próximo passo após Fase A completa

Sprint 5A começa: implementação de H1 + H2 + contenção. Plano em [SPRINT5A-PLAN.md](./SPRINT5A-PLAN.md).
