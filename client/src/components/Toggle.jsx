/** Small on/off switch used by forms and option lists. */
export default function Toggle({ on, onChange, disabled = false }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onChange}
      className={`relative w-9 h-5 rounded-full shrink-0 transition-colors disabled:opacity-40 ${
        on ? 'bg-brand' : 'bg-bg-hover border border-line'
      }`}
      aria-pressed={on}
    >
      <span
        className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white transition-all ${
          on ? 'left-[19px]' : 'left-[3px]'
        }`}
      />
    </button>
  );
}
