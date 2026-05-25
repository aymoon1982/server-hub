import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';

const UICtx = createContext(null);

function UIProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [modal, setModal] = useState(null); // { node, key }
  const toastSeq = useRef(0);
  const modalSeq = useRef(0);

  const toast = useCallback((opts) => {
    const id = ++toastSeq.current;
    const t = {
      id,
      kind: opts.kind || 'info', // info | ok | warn | err
      title: opts.title || '',
      body: opts.body || '',
      ttl: opts.ttl ?? 4000,
      action: opts.action, // { label, onClick }
    };
    setToasts(arr => [...arr, t]);
    if (t.ttl) {
      setTimeout(() => setToasts(arr => arr.filter(x => x.id !== id)), t.ttl);
    }
    return id;
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts(arr => arr.filter(x => x.id !== id));
  }, []);

  const openModal = useCallback((node) => {
    const key = ++modalSeq.current;
    setModal({ node, key });
    return key;
  }, []);

  const closeModal = useCallback(() => setModal(null), []);

  const confirm = useCallback((opts) => {
    return new Promise((resolve) => {
      openModal(
        <ConfirmModal
          title={opts.title}
          body={opts.body}
          confirmLabel={opts.confirmLabel || 'Confirm'}
          cancelLabel={opts.cancelLabel || 'Cancel'}
          dangerous={opts.dangerous}
          icon={opts.icon}
          onResolve={(v) => { setModal(null); resolve(v); }}
        />
      );
    });
  }, [openModal]);

  // expose globally
  useEffect(() => {
    window.UI = { toast, confirm, modal: openModal, closeModal, dismissToast };
  }, [toast, confirm, openModal, closeModal, dismissToast]);

  // Escape closes top modal
  useEffect(() => {
    if (!modal) return;
    const onKey = (e) => { if (e.key === 'Escape') setModal(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  return (
    <UICtx.Provider value={{ toast, confirm, openModal, closeModal }}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {modal && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
          {modal.node}
        </div>
      )}
    </UICtx.Provider>
  );
}

function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="toast-stack">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.kind}`} role="status">
          <span className="toast-icon">{({info:'◔', ok:'✓', warn:'!', err:'×'})[t.kind] || '◔'}</span>
          <div className="toast-body">
            {t.title && <div className="toast-title">{t.title}</div>}
            {t.body && <div className="toast-msg">{t.body}</div>}
          </div>
          {t.action && (
            <button className="toast-action" onClick={() => { t.action.onClick(); onDismiss(t.id); }}>
              {t.action.label}
            </button>
          )}
          <button className="toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}

function ConfirmModal({ title, body, confirmLabel, cancelLabel, dangerous, icon, onResolve }) {
  const confirmRef = useRef(null);
  useEffect(() => { confirmRef.current?.focus(); }, []);
  return (
    <div className={`modal modal-confirm ${dangerous ? 'is-dangerous' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-head">
        <div className={`modal-icon ${dangerous ? 'danger' : ''}`}>{icon || (dangerous ? '!' : '?')}</div>
        <div className="modal-titles">
          <h2>{title}</h2>
          {typeof body === 'string' ? <p className="modal-body-text">{body}</p> : body}
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn-ghost" onClick={() => onResolve(false)}>{cancelLabel}</button>
        <button
          ref={confirmRef}
          className={dangerous ? 'btn-danger' : 'btn-accent'}
          onClick={() => onResolve(true)}
          onKeyDown={(e) => e.key === 'Enter' && onResolve(true)}
        >{confirmLabel}</button>
      </div>
    </div>
  );
}

function Modal({ title, subtitle, children, footer, onClose, size = 'md', icon }) {
  return (
    <div className={`modal modal-${size}`} onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-head">
        {icon && <div className="modal-icon">{icon}</div>}
        <div className="modal-titles">
          <h2>{title}</h2>
          {subtitle && <p className="modal-sub">{subtitle}</p>}
        </div>
        <button className="modal-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  );
}

export { UIProvider, Modal, ConfirmModal, ToastStack, UICtx };
