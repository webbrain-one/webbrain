// Loaded in both the isolated content world and the background agent.
(() => {
  const clean = value => String(value ?? '').normalize('NFKC').trim().replace(/[\u200e\u200f]/g, '');
  const canonical = (value, allowBare = false) => {
    const text = clean(value).replace(/[ ().-]/g, '');
    const digits = text.replace(/^(?:\+|00)/, '');
    return (allowBare || digits !== text) && /^[1-9]\d{7,14}$/.test(digits) ? '+' + digits : '';
  };
  const fromComposerLabel = value => {
    // The destination can appear anywhere in a translated label. Reject
    // other numbers, including extensions, rather than choosing a substring.
    const number = /^[^+\d]*((?:\+|00)[\d ().-]*\d)[^+\d]*$/.exec(clean(value));
    return number ? canonical(number[1]) : '';
  };
  const needsCountryCode = value => /^\d{7,15}$/.test(clean(value).replace(/[ ().-]/g, '')) && !canonical(value);
  globalThis.__wbWhatsappPhone = Object.freeze({ canonical, fromComposerLabel, needsCountryCode });
})();
