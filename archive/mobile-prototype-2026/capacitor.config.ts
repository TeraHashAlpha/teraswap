import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.teraswap.dex',
  appName: 'TeraSwap',
  webDir: 'out',
  // Use the live production URL as the server (no local build needed)
  // For development, comment this out and use `npx next export` → `out/`
  server: {
    url: 'https://teraswap.app',
    cleartext: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#080B10',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#080B10',
    },
  },
  ios: {
    contentInset: 'automatic',
    allowsLinkPreview: false,
    scrollEnabled: true,
    // WalletConnect / deep linking
    scheme: 'teraswap',
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    // WalletConnect / deep linking
    // scheme: 'teraswap',
  },
}

export default config
