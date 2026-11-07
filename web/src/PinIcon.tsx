/** Punaise des épingles de session et de projet, pleine quand l'élément est épinglé. */
export function PinIcon({ filled }: { filled: boolean }) {
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
      <path d="M12 17v5" />
      <path
        d="M5 17h14v-1.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.7a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2Z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  );
}
