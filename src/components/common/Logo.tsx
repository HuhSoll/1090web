export function Logo() {
  return (
    <div className="logo">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="12.5" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.2" />
        <path d="M5 19 C 11 6, 21 6, 27 13" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M7 23 C 13 15, 20 15, 25 21" fill="none" stroke="var(--accent)" strokeOpacity="0.55" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="5" cy="19" r="1.8" fill="var(--accent-warm)" />
        <circle cx="27" cy="13" r="1.8" fill="var(--accent)" />
      </svg>
      <span className="logo-text">
        1090<span>web</span>
      </span>
    </div>
  );
}
