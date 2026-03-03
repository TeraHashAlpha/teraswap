'use client'

import { useEffect } from 'react'

type LegalType = 'privacy' | 'terms'

interface Props {
  type: LegalType
}

const LAST_UPDATED = 'February 25, 2026'

/* ────────────────────────────────────────────────────────────────
   PRIVACY POLICY
   ──────────────────────────────────────────────────────────────── */
function PrivacyPolicy() {
  return (
    <>
      <SectionTitle id="pp-intro">1. Introduction</SectionTitle>
      <P>
        TeraSwap (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) operates a decentralized exchange
        meta-aggregator interface (the &ldquo;Interface&rdquo;) that enables users to access optimal
        swap rates across multiple decentralized exchange protocols on the Ethereum network.
        This Privacy Policy explains how we collect, use, disclose, and safeguard your information
        when you visit our Interface.
      </P>
      <P>
        By accessing or using the Interface, you agree to this Privacy Policy. If you do not agree
        with the terms of this Privacy Policy, please do not access the Interface.
      </P>

      <SectionTitle id="pp-architecture">2. Non-Custodial Architecture</SectionTitle>
      <P>
        TeraSwap is a non-custodial, client-side interface. We do not take custody of your digital
        assets at any time. All transactions are executed directly between your wallet and the
        underlying smart contracts of third-party protocols (including but not limited to Uniswap,
        1inch, 0x/Matcha, ParaSwap, Odos, KyberSwap, CoW Protocol, OpenOcean, SushiSwap, and
        Balancer). Your private keys never leave your device.
      </P>

      <SectionTitle id="pp-collect">3. Information We Collect</SectionTitle>
      <SubTitle>3.1 On-Chain Data</SubTitle>
      <P>
        When you connect your non-custodial wallet and interact with the Interface, we access
        publicly-available blockchain data, including your wallet address and transaction history.
        Blockchain addresses are publicly-available data that are not, by themselves, personally
        identifiable. We may screen wallet addresses using third-party blockchain analytics
        providers to detect and prevent illicit activity.
      </P>

      <SubTitle>3.2 Automatically Collected Data</SubTitle>
      <P>
        When you access the Interface, we may automatically collect certain technical information,
        including device type, operating system, browser type and version, and general usage patterns.
        We use this data solely to improve Interface performance, debug errors, and enhance user experience.
        We do not collect or store your name, email address, IP address, home address, or date of birth.
      </P>

      <SubTitle>3.3 Local Storage</SubTitle>
      <P>
        The Interface uses your browser&rsquo;s local storage to remember your preferences, such as
        imported tokens, slippage settings, swap history, theme preferences, and active approvals.
        This data remains exclusively on your device and is never transmitted to our servers.
      </P>

      <SectionTitle id="pp-use">4. How We Use Your Information</SectionTitle>
      <P>We use the limited information we collect to:</P>
      <UL>
        <li>Provide, maintain, and improve the Interface</li>
        <li>Fetch and compare swap quotes from multiple decentralized exchange protocols</li>
        <li>Validate transaction pricing against Chainlink oracle feeds for your protection</li>
        <li>Screen wallets for compliance with applicable sanctions and anti-money laundering regulations</li>
        <li>Analyze usage patterns to improve Interface design and performance</li>
        <li>Detect and prevent fraud, security breaches, and other harmful activities</li>
      </UL>

      <SectionTitle id="pp-sharing">5. Data Sharing &amp; Third Parties</SectionTitle>
      <P>
        When you request a swap quote, the Interface sends your wallet address and transaction
        parameters to the APIs of third-party aggregator and DEX protocols. Each of these protocols
        has its own privacy policy. We encourage you to review them.
      </P>
      <P>
        We may share wallet addresses with blockchain analytics providers to comply with applicable
        laws and regulations. We do not sell, rent, or trade your personal information to any
        third party for marketing purposes.
      </P>
      <P>
        Third-party infrastructure providers (such as RPC node providers) may process your requests
        as part of normal blockchain operations. These providers may have access to your wallet
        address and transaction data.
      </P>

      <SectionTitle id="pp-chainlink">6. Chainlink Oracle Verification</SectionTitle>
      <P>
        TeraSwap queries Chainlink price oracle smart contracts to verify that swap prices are
        within acceptable deviation thresholds. This verification occurs on-chain and involves
        publicly-available data. No personal data is transmitted as part of this process.
      </P>

      <SectionTitle id="pp-cookies">7. Cookies &amp; Tracking</SectionTitle>
      <P>
        The Interface does not use cookies for tracking or advertising purposes. We do not employ
        any third-party analytics or advertising scripts. Any data stored in your browser
        (via localStorage) is used solely for your convenience and remains on your device.
      </P>

      <SectionTitle id="pp-security">8. Data Security</SectionTitle>
      <P>
        We implement reasonable technical safeguards to protect the limited data we process.
        However, no method of electronic transmission or storage is 100% secure. You are
        responsible for the security of your wallet, private keys, and seed phrases. We will never
        ask for your private keys or seed phrases.
      </P>

      <SectionTitle id="pp-retention">9. Data Retention</SectionTitle>
      <P>
        We retain automatically collected technical data only for as long as necessary to fulfill
        the purposes outlined in this Privacy Policy. On-chain data exists permanently on public
        blockchains, which we cannot modify or delete.
      </P>

      <SectionTitle id="pp-rights">10. Your Rights</SectionTitle>
      <P>
        Depending on your jurisdiction, you may have the right to access, correct, or delete your
        personal data. Because the Interface collects minimal personal data and most data is stored
        locally on your device, you can exercise most of these rights by clearing your browser&rsquo;s
        local storage. For any data-related requests, please contact us at the address below.
      </P>
      <P>
        We cannot edit or delete information stored on a public blockchain, including transaction
        data and wallet addresses, as these are immutable by design.
      </P>

      <SectionTitle id="pp-children">11. Children&rsquo;s Privacy</SectionTitle>
      <P>
        The Interface is not intended for individuals under the age of 18. We do not knowingly
        collect personal information from children. If you believe that a child has provided us
        with personal information, please contact us so we can take appropriate action.
      </P>

      <SectionTitle id="pp-changes">12. Changes to This Policy</SectionTitle>
      <P>
        We may update this Privacy Policy from time to time. Changes will be posted on this page
        with an updated &ldquo;Last Updated&rdquo; date. Your continued use of the Interface after
        any changes constitutes your acceptance of the revised Privacy Policy.
      </P>

      <SectionTitle id="pp-contact">13. Contact</SectionTitle>
      <P>
        If you have questions about this Privacy Policy or wish to exercise your data rights,
        please contact us at <span className="text-cream-65 font-medium">legal@teraswap.io</span>.
      </P>
    </>
  )
}

/* ────────────────────────────────────────────────────────────────
   TERMS OF SERVICE
   ──────────────────────────────────────────────────────────────── */
function TermsOfService() {
  return (
    <>
      <SectionTitle id="tos-acceptance">1. Acceptance of Terms</SectionTitle>
      <P>
        By accessing or using the TeraSwap Interface (the &ldquo;Interface&rdquo;), you agree to
        be bound by these Terms of Service (&ldquo;Terms&rdquo;). If you do not agree to these
        Terms, you must not access or use the Interface. These Terms constitute a legally binding
        agreement between you and TeraSwap (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;).
      </P>

      <SectionTitle id="tos-description">2. Description of the Interface</SectionTitle>
      <P>
        TeraSwap is a decentralized exchange meta-aggregator that provides a client-side interface
        for comparing and executing token swaps across multiple decentralized exchange protocols
        on the Ethereum network. The Interface queries third-party protocols including, but not
        limited to, Uniswap V3, 1inch, 0x/Matcha, ParaSwap, Odos, KyberSwap, CoW Protocol,
        OpenOcean, SushiSwap, and Balancer.
      </P>
      <P>
        The Interface is a front-end application only. We do not operate, control, or have custody
        over any of the underlying smart contracts, liquidity pools, or blockchain networks. All
        swaps are executed directly between your wallet and the relevant smart contracts.
      </P>

      <SectionTitle id="tos-eligibility">3. Eligibility</SectionTitle>
      <P>To use the Interface, you must:</P>
      <UL>
        <li>Be at least 18 years old or the age of majority in your jurisdiction</li>
        <li>Not be a resident of, or located in, any jurisdiction where the use of decentralized exchange services is prohibited</li>
        <li>Not be subject to any sanctions administered by OFAC, the United Nations, the European Union, or any other applicable governmental authority</li>
        <li>Not use the Interface for any unlawful purpose, including money laundering, terrorist financing, or sanctions evasion</li>
      </UL>

      <SectionTitle id="tos-non-custodial">4. Non-Custodial Nature</SectionTitle>
      <P>
        The Interface is entirely non-custodial. You retain full control of your digital assets
        at all times. We do not hold, manage, or have access to your private keys, seed phrases,
        or funds. You are solely responsible for the security of your wallet and credentials.
      </P>
      <P>
        Transactions initiated through the Interface are executed on-chain through third-party
        smart contracts. Once submitted to the blockchain, transactions are irreversible. We
        cannot cancel, reverse, or modify any transaction on your behalf.
      </P>

      <SectionTitle id="tos-third-party">5. Third-Party Protocols &amp; Services</SectionTitle>
      <P>
        The Interface aggregates quotes from third-party decentralized exchange protocols. Each
        protocol has its own smart contracts, terms of service, and risk profile. We do not
        control, audit, endorse, or guarantee the security or accuracy of any third-party protocol.
      </P>
      <P>
        By using the Interface to interact with third-party protocols, you acknowledge that you
        are subject to the terms and conditions of those protocols. Any issues arising from
        interactions with third-party smart contracts are between you and the relevant protocol.
      </P>

      <SectionTitle id="tos-oracle">6. Chainlink Oracle Verification</SectionTitle>
      <P>
        The Interface uses Chainlink decentralized oracle price feeds to verify swap pricing. While
        this provides an additional layer of protection against manipulated prices, oracle feeds
        are not infallible. Price data may be delayed, inaccurate, or temporarily unavailable.
        Oracle verification does not guarantee the accuracy of any swap price.
      </P>

      <SectionTitle id="tos-fees">7. Fees</SectionTitle>
      <P>
        TeraSwap may charge a protocol fee on swaps executed through the Interface. The current
        fee rate is displayed in the Interface before you confirm any transaction. Fees are
        subject to change. In addition, you will incur network gas fees payable to Ethereum
        validators, which are not set or collected by TeraSwap.
      </P>

      <SectionTitle id="tos-approvals">8. Token Approvals</SectionTitle>
      <P>
        Certain swaps require you to approve a third-party smart contract to spend your tokens.
        TeraSwap defaults to exact-amount approvals (rather than infinite approvals) where
        technically feasible, reducing the risk of residual token allowances. Some protocols
        (such as CoW Protocol) may require broader approvals. The Interface will notify you of
        the approval type before you confirm.
      </P>
      <P>
        You are responsible for monitoring and revoking token approvals as you see fit. The
        Interface provides an &ldquo;Active Approvals&rdquo; panel for your convenience, but
        managing your approvals remains your sole responsibility.
      </P>

      <SectionTitle id="tos-risks">9. Risks</SectionTitle>
      <P>
        Using decentralized exchange protocols involves significant risks, including but not
        limited to:
      </P>
      <UL>
        <li><strong>Smart Contract Risk:</strong> Third-party smart contracts may contain bugs, vulnerabilities, or exploits that could result in loss of funds</li>
        <li><strong>Market Risk:</strong> Digital asset prices are highly volatile. The value of your assets may decrease significantly</li>
        <li><strong>Slippage Risk:</strong> The actual execution price of a swap may differ from the quoted price due to market movements between quote and execution</li>
        <li><strong>MEV Risk:</strong> Transactions may be subject to front-running, sandwich attacks, or other forms of miner/maximal extractable value (MEV) exploitation</li>
        <li><strong>Network Risk:</strong> The Ethereum network may experience congestion, high gas fees, outages, or forks that affect transaction execution</li>
        <li><strong>Oracle Risk:</strong> Price feeds may be delayed, inaccurate, or manipulated</li>
        <li><strong>Regulatory Risk:</strong> The legal status of decentralized finance may change in your jurisdiction</li>
        <li><strong>Impermanent Loss:</strong> Liquidity providers in underlying pools may experience impermanent loss</li>
      </UL>
      <P>
        You acknowledge that you understand these risks and accept full responsibility for any
        losses incurred through use of the Interface.
      </P>

      <SectionTitle id="tos-no-advice">10. No Financial Advice</SectionTitle>
      <P>
        Nothing on the Interface constitutes financial, investment, legal, or tax advice. The
        Interface displays information from third-party sources for informational purposes only.
        You should consult qualified professionals before making any financial decisions.
      </P>

      <SectionTitle id="tos-disclaimers">11. Disclaimers</SectionTitle>
      <P>
        THE INTERFACE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT
        WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY. WE DISCLAIM ALL WARRANTIES,
        INCLUDING BUT NOT LIMITED TO MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
        NON-INFRINGEMENT, AND ACCURACY.
      </P>
      <P>
        WE DO NOT WARRANT THAT THE INTERFACE WILL BE UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE
        OF VIRUSES OR OTHER HARMFUL COMPONENTS. WE DO NOT WARRANT THE ACCURACY, COMPLETENESS,
        OR TIMELINESS OF ANY QUOTES, PRICES, OR DATA DISPLAYED THROUGH THE INTERFACE.
      </P>

      <SectionTitle id="tos-liability">12. Limitation of Liability</SectionTitle>
      <P>
        TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL TERASWAP, ITS
        AFFILIATES, DIRECTORS, OFFICERS, EMPLOYEES, OR AGENTS BE LIABLE FOR ANY INDIRECT,
        INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING LOSS OF PROFITS,
        DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES, RESULTING FROM:
      </P>
      <UL>
        <li>Your access to, use of, or inability to use the Interface</li>
        <li>Any conduct or content of third-party protocols accessed through the Interface</li>
        <li>Any unauthorized access, use, or alteration of your wallet or transactions</li>
        <li>Smart contract failures, exploits, or vulnerabilities in third-party protocols</li>
        <li>Oracle inaccuracies or failures</li>
        <li>Network congestion, outages, or forks</li>
      </UL>
      <P>
        OUR TOTAL LIABILITY TO YOU FOR ALL CLAIMS ARISING FROM USE OF THE INTERFACE SHALL NOT
        EXCEED $100 USD.
      </P>

      <SectionTitle id="tos-indemnification">13. Indemnification</SectionTitle>
      <P>
        You agree to indemnify, defend, and hold harmless TeraSwap and its affiliates from and
        against any claims, liabilities, damages, losses, and expenses (including reasonable
        attorneys&rsquo; fees) arising from your use of the Interface, your violation of these
        Terms, or your violation of any applicable law or regulation.
      </P>

      <SectionTitle id="tos-prohibited">14. Prohibited Activities</SectionTitle>
      <P>You agree not to:</P>
      <UL>
        <li>Use the Interface for any illegal purpose or in violation of applicable laws</li>
        <li>Attempt to exploit, hack, or interfere with the Interface or any connected systems</li>
        <li>Use automated systems (bots, scrapers) to access the Interface without authorization</li>
        <li>Misrepresent your identity or affiliation with TeraSwap</li>
        <li>Use the Interface to launder money, finance terrorism, or evade sanctions</li>
        <li>Circumvent any security or access controls</li>
      </UL>

      <SectionTitle id="tos-ip">15. Intellectual Property</SectionTitle>
      <P>
        The Interface, including its design, code, and branding, is protected by intellectual
        property laws. The underlying smart contracts of third-party protocols are governed by
        their respective licenses. You may not copy, modify, distribute, or create derivative
        works of the Interface without our prior written consent.
      </P>

      <SectionTitle id="tos-termination">16. Termination</SectionTitle>
      <P>
        We reserve the right to restrict, suspend, or terminate your access to the Interface at
        any time, without notice, for any reason, including suspected violation of these Terms or
        applicable laws. You may discontinue your use of the Interface at any time. Sections 9
        through 13 shall survive any termination.
      </P>

      <SectionTitle id="tos-governing">17. Governing Law &amp; Dispute Resolution</SectionTitle>
      <P>
        These Terms shall be governed by and construed in accordance with the laws of the
        applicable jurisdiction, without regard to conflict of law principles. Any disputes arising
        from these Terms or the Interface shall be resolved through binding arbitration, except
        where prohibited by law. You waive any right to participate in class action lawsuits or
        class-wide arbitration.
      </P>

      <SectionTitle id="tos-severability">18. Severability &amp; Entire Agreement</SectionTitle>
      <P>
        If any provision of these Terms is found to be unenforceable, the remaining provisions
        shall remain in full force and effect. These Terms, together with our Privacy Policy,
        constitute the entire agreement between you and TeraSwap regarding the Interface.
      </P>

      <SectionTitle id="tos-changes">19. Changes to These Terms</SectionTitle>
      <P>
        We may modify these Terms at any time by posting the revised Terms on the Interface with
        an updated &ldquo;Last Updated&rdquo; date. Your continued use of the Interface after any
        changes constitutes your acceptance of the revised Terms.
      </P>

      <SectionTitle id="tos-contact">20. Contact</SectionTitle>
      <P>
        If you have questions about these Terms of Service, please contact us
        at <span className="text-cream-65 font-medium">legal@teraswap.io</span>.
      </P>
    </>
  )
}

/* ────────────────────────────────────────────────────────────────
   SHARED COMPONENTS
   ──────────────────────────────────────────────────────────────── */
function SectionTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="mb-3 mt-10 text-lg font-bold text-cream first:mt-0 sm:text-xl"
    >
      {children}
    </h2>
  )
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 mt-6 text-sm font-semibold text-cream-80 sm:text-base">
      {children}
    </h3>
  )
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-sm leading-relaxed text-cream-65">
      {children}
    </p>
  )
}

function UL({ children }: { children: React.ReactNode }) {
  return (
    <ul className="mb-4 ml-5 list-disc space-y-1.5 text-sm leading-relaxed text-cream-65">
      {children}
    </ul>
  )
}

/* ────────────────────────────────────────────────────────────────
   MAIN COMPONENT
   ──────────────────────────────────────────────────────────────── */
export default function LegalPage({ type }: Props) {
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [type])

  const title = type === 'privacy' ? 'Privacy Policy' : 'Terms of Service'

  return (
    <section className="mx-auto w-full max-w-3xl px-4 pb-20 pt-28 sm:px-6 md:pt-32">
      {/* Header */}
      <div className="mb-10">
        <span className="mb-2 inline-block rounded-full border border-cream-15 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-cream-50">
          Legal
        </span>
        <h1 className="font-display text-3xl font-extrabold text-cream sm:text-4xl">
          {title}
        </h1>
        <p className="mt-2 text-sm text-cream-35">
          Last updated: {LAST_UPDATED}
        </p>
      </div>

      {/* Content */}
      <div className="rounded-2xl border border-cream-08 bg-surface-secondary/60 px-5 py-8 backdrop-blur-lg sm:px-8 sm:py-10">
        {type === 'privacy' ? <PrivacyPolicy /> : <TermsOfService />}
      </div>
    </section>
  )
}
