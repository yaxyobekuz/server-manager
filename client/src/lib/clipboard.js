/**
 * Copy text to the clipboard.
 *
 * `navigator.clipboard` only exists in a secure context, so a panel opened
 * over plain http (or at http://<ip>:4500) would have no copy at all — hence
 * the execCommand fallback, which still works everywhere.
 */
export async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
