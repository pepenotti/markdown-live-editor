// Where a Chromium-based browser that can print to PDF is usually installed.

/** Well-known paths of Chrome, Edge and Chromium for a platform, most common first. */
export function browserCandidates(platform: string, env: Record<string, string | undefined>, home: string): string[] {
  if (platform === 'darwin') {
    const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Chromium.app/Contents/MacOS/Chromium'];
    return ['/Applications', `${home}/Applications`].flatMap((root) => apps.map((app) => `${root}/${app}`));
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    const apps = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'Chromium\\Application\\chrome.exe'];
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
  ];
}

/** Arguments that make a Chromium-based browser print a page to a PDF file and exit. */
export function printToPdfArgs(pageUrl: string, pdfPath: string, profileDir: string, waitForScripts: boolean): string[] {
  return [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    // Only a page that loads Mermaid has scripts to wait for.
    ...(waitForScripts ? ['--virtual-time-budget=15000'] : []),
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    pageUrl,
  ];
}

/** True when the bytes are a whole PDF file: the header is there and so is the end marker. */
export function isCompletePdf(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  return text(0, 5) === '%PDF-' && text(Math.max(0, bytes.length - 1024), bytes.length).includes('%%EOF');
}
