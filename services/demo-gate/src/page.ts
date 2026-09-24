export const LOGIN_PATH = '/__gate/login';

const MAX_RETURN_PATH = 2048;

/**
 * Where to send the visitor after a correct passphrase. Only a path on this
 * same host: anything that a browser could read as another origin --
 * `//evil`, `/\evil`, a scheme -- or that carries a control character falls
 * back to the root.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || value.length > MAX_RETURN_PATH) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return '/';
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The passphrase form. The strings are placeholders: visitor-facing copy is
 * written separately, and the page carries no script so it needs no policy
 * exception at the edge.
 */
export function passphrasePage(returnPath: string, message: string | null): string {
  const notice = message ? `<p role="alert">${escapeHtml(message)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>DEMO_GATE_TITLE</title></head>
<body>
<main>
<h1>DEMO_GATE_HEADING</h1>
${notice}
<form method="post" action="${LOGIN_PATH}">
<input type="hidden" name="r" value="${escapeHtml(safeReturnPath(returnPath))}">
<label for="passphrase">DEMO_GATE_PASSPHRASE_LABEL</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required maxlength="256">
<button type="submit">DEMO_GATE_SUBMIT</button>
</form>
</main>
</body>
</html>
`;
}
