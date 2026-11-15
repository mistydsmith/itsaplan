// A bead on a commit line: the mark the Beads (bd) source carries, drawn in the
// current text color so it sits like the other source marks on a tab or job card.
export default function SettingsImportExportBdLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none">
      <path d="M3 12h6m3 0h9" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="15" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}
