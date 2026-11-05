import { useEffect } from 'react';

export default function Modal({ open, onClose, title, children, wide = false }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      {/* tall dialogs (a transfer summary, a long form) scroll inside the
          card instead of running off the screen */}
      <div
        className={`card p-6 w-full max-h-[calc(100vh-2rem)] overflow-y-auto ${wide ? 'max-w-2xl' : 'max-w-md'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h2 className="text-white font-semibold mb-5">{title}</h2>}
        {children}
      </div>
    </div>
  );
}
