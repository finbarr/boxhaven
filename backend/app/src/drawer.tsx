import { X } from "lucide-react";
import { ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

// Right-side overlay panel used for "Add" forms and row detail/edit across the
// console. Closes on Escape or a backdrop click.
export function Drawer({ open, onClose, eyebrow, title, children, footer, wide = false }: {
  open: boolean;
  onClose: () => void;
  eyebrow?: string;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="drawer-overlay" onClick={onClose}>
      <aside className={wide ? "drawer-panel wide" : "drawer-panel"} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <div className="panel-heading small">
            {eyebrow ? <span>{eyebrow}</span> : null}
            <h2>{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close" aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer ? <footer className="drawer-foot">{footer}</footer> : null}
      </aside>
    </div>,
    document.body,
  );
}
