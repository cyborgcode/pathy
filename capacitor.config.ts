import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android packaging.
 *
 * The web build is bundled into the APK rather than pointed at a hosted URL.
 * A Trusted Web Activity would have been less code, but it loads the app over
 * the network on first launch and needs a verified domain — both of which are
 * absurd for a tool whose entire premise is moving files between devices with
 * no network path between them. Bundled assets mean the app works from a
 * factory-fresh, never-online phone.
 *
 * `androidScheme: 'https'` matters more than it looks: it serves the bundled
 * assets from `https://localhost`, which is a secure context. `getUserMedia`
 * is stripped from insecure origins, so on the default `http` scheme the
 * receiver could never open the camera.
 */
const config: CapacitorConfig = {
  appId: 'com.cyborgcode.photon',
  appName: 'Photon',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    // The transmit page paints a full-screen colour field; a WebView that
    // dims or shifts it costs the receiver frames.
    backgroundColor: '#0a0a0a',
  },
};

export default config;
