// Where a Chromium-based browser that can draw diagrams and print to PDF is usually installed.

/** Well-known paths of Chrome, Edge, Chromium and Brave for a platform, most common first. */
export function browserCandidates(platform: string, env: Record<string, string | undefined>, home: string): string[] {
  if (platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Chromium.app/Contents/MacOS/Chromium',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    return ['/Applications', `${home}/Applications`].flatMap((root) => apps.map((app) => `${root}/${app}`));
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    const apps = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ];
    return apps.flatMap((app) => roots.map((root) => `${root.replace(/\\+$/, '')}\\${app}`));
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/brave-browser',
    '/usr/bin/brave',
    '/snap/bin/brave',
  ];
}

/**
 * Arguments for a headless Chromium-based browser that is driven over the DevTools pipe.
 * They are fixed: no path of a document is ever part of the command line.
 */
export function browserArgs(profileDir: string): string[] {
  return [
    '--headless',
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--mute-audio',
    '--hide-scrollbars',
    'about:blank',
  ];
}

/** True when the bytes are a whole PDF file: the header is there and so is the end marker. */
export function isCompletePdf(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  return text(0, 5) === '%PDF-' && text(Math.max(0, bytes.length - 1024), bytes.length).includes('%%EOF');
}
