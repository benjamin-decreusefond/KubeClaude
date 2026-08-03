/**
 * A hexagon (a nod to Kubernetes) with a clock hand pointing to twelve (a nod
 * to "on a schedule") instead of a two-letter monogram. Renders in
 * `currentColor` so it picks up whatever the surrounding `.brand-mark` sets.
 */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.5 20.5 7.5V16.5L12 21.5 3.5 16.5V7.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 12V6.75" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" />
    </svg>
  );
}
