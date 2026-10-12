// PROTOTYPE (#267): ← / → cycle the language-switcher variants. Throwaway.
document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    const which = e.key === 'ArrowLeft' ? 'prev' : e.key === 'ArrowRight' ? 'next' : null;
    if (!which) return;
    const link = document.querySelector(`[data-prototype-${which}]`);
    if (link instanceof HTMLAnchorElement) window.location.assign(link.href);
});
