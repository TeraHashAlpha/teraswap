'use client'

import './landing.css'
import { v2FontClassNames } from '../font-loader'
import { PHOTOS } from '../photos/photos'
import { HelpFab, MusicToggle } from '../shell/Fabs'
import { Footer } from '../shell/Footer'
import { V2ToastProvider } from '../shell/toasts'
import { Hero } from './Hero'
import { LandingHeader } from './LandingHeader'
import { BottomCtaSection, DifferentSection, DocsSection, ExperienceSection, FeaturesSection, PerformanceSection, SecuritySection } from './Sections'

/** The landing's photos, in page order — the footer names each author once. */
const LANDING_PHOTOS = [PHOTOS.trails, PHOTOS['arch-night']] as const

/**
 * [ADR-025] The v2 landing (pack 10 / 10a / m01; landing-a hero, landing-b rhythm): ten sections — header, hero,
 * performance, why, security, experience, features, roadmap, bottom CTA, docs — then the shell footer (section 10).
 * Shown at `/` for a visitor who has not launched the app (HomeV2 holds the same landing-vs-app state v1 does). Every
 * CTA calls `onLaunchApp`, v1's `handleLaunchApp`.
 */
export function LandingV2({ onLaunchApp }: { onLaunchApp: () => void }) {
  return (
    <V2ToastProvider>
      <div data-ts-ui="v2" data-ts-landing="" className={`ts-v2 relative min-h-screen ${v2FontClassNames}`}>
        <LandingHeader onLaunchApp={onLaunchApp} />
        <main>
          <Hero onLaunchApp={onLaunchApp} />
          <PerformanceSection />
          <DifferentSection />
          <SecuritySection />
          <ExperienceSection onLaunchApp={onLaunchApp} />
          <FeaturesSection />
          <BottomCtaSection onLaunchApp={onLaunchApp} />
          <DocsSection />
        </main>
        <Footer photos={LANDING_PHOTOS} />
        <MusicToggle />
        <HelpFab />
      </div>
    </V2ToastProvider>
  )
}
