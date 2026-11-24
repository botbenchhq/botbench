/**
 * The Botbench mark, two interlocking corner brackets that meet at a seam, in two tones: the first bracket in the
 * colour of the text around it (`currentColor`), the second in the brand cyan (`--brand-cyan`, web/src/styles/theme.css,
 * one value for dark and one for light). One drawing serves both modes and both interfaces. Its box is cropped to the
 * artwork with one unit of padding (the artwork sits on whole units of a 24 grid, from 4 to 20), so at `size` its ink
 * is 8/9 of `size`. Decorative: the name is written beside it. The brand cyan belongs to the mark alone; no status,
 * agent or control uses it.
 */
export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="3 3 18 18" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M13 4H6A2 2 0 0 0 4 6V17A2 2 0 0 0 6 19H8V9H13Z" />
      <path d="M11 20H18A2 2 0 0 0 20 18V7A2 2 0 0 0 18 5H16V15H11Z" fill="var(--brand-cyan)" />
    </svg>
  );
}
