import { useEffect, useRef } from 'react';

export default function Confirm({title,body,confirmLabel,onConfirm,onClose}){
  const cancelRef=useRef(null);
  useEffect(()=>{
    const previous=document.activeElement;
    const frame=requestAnimationFrame(()=>cancelRef.current?.focus());
    const keydown=(event)=>{if(event.key==='Escape')onClose();};
    document.addEventListener('keydown',keydown);
    return()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',keydown);previous?.focus?.();};
  },[onClose]);
  return <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body"><button className="modal-scrim" onClick={onClose} aria-label="Cancel"/><div className="confirm glass"><div className="confirm-icon" aria-hidden="true">!</div><h2 id="confirm-title">{title}</h2><p id="confirm-body">{body}</p><div><button ref={cancelRef} className="secondary" onClick={onClose}>Cancel</button><button className="destructive" onClick={onConfirm}>{confirmLabel}</button></div></div></div>;
}
