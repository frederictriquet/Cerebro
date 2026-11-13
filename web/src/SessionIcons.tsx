import type { ReactNode } from 'react';

/** Pictos des actions de la vue session, au trait comme l'épingle et le cadenas. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Commit puis push : un point de commit sur sa ligne, une flèche vers le haut. */
export function CommitPushIcon() {
  return (
    <Icon>
      <circle cx="9" cy="14" r="3" />
      <path d="M9 3v8M9 17v4" />
      <path d="M18 21V9M14.5 12.5 18 9l3.5 3.5" />
    </Icon>
  );
}

/** Réajuster le terminal : quatre coins tirés vers l'extérieur. */
export function ResizeIcon() {
  return (
    <Icon>
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </Icon>
  );
}

export function StopIcon() {
  return (
    <Icon>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </Icon>
  );
}

export function ResumeIcon() {
  return (
    <Icon>
      <path d="M7 4.5v15l12-7.5Z" />
    </Icon>
  );
}

export function TrashIcon() {
  return (
    <Icon>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3" />
    </Icon>
  );
}

/** Code review : loupe sur une page. */
export function ReviewIcon() {
  return (
    <Icon>
      <path d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h5M13 3l5 5v2M13 3v5h5" />
      <circle cx="16" cy="16" r="3" />
      <path d="m18.2 18.2 2.8 2.8" />
    </Icon>
  );
}

/** Council : trois conseillers. */
export function CouncilIcon() {
  return (
    <Icon>
      <circle cx="12" cy="7" r="2.5" />
      <circle cx="5" cy="10" r="2" />
      <circle cx="19" cy="10" r="2" />
      <path d="M7.5 20v-2.5a4.5 4.5 0 0 1 9 0V20M2 19v-1.5A3 3 0 0 1 5.5 15M22 19v-1.5a3 3 0 0 0-3.5-2.5" />
    </Icon>
  );
}

/** Nom de pair de la session, à copier : arobase. */
export function PeerNameIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7" />
    </Icon>
  );
}

export function CheckIcon() {
  return (
    <Icon>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}
