// Login page participates in the SPA build — SSR disabled consistent with root layout.
// CSR must remain enabled: the page uses reactive $state bindings, form submission
// via goto(), and reads auth state from the browser. Setting csr = false would
// produce a non-interactive static shell with no form handling.
export const ssr = false;
export const prerender = false;
