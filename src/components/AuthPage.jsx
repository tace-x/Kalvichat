import { useState } from 'react';
import { login, register } from '../services/authService';

const empty={name:'',phone:'',username:'',password:'',confirmPassword:'',language:'Manglish'};
export default function AuthPage({initialMode='login',onAccountState}){
  const[mode,setMode]=useState(initialMode),[form,setForm]=useState(empty),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const change=(event)=>setForm((old)=>({...old,[event.target.name]:event.target.value}));
  const switchMode=(next)=>{setMode(next);setError('')};
  const submit=async(event)=>{
    event.preventDefault();setError('');
    if(mode==='register'&&form.password!==form.confirmPassword){setError('Passwords do not match.');return;}
    setBusy(true);
    try{
      const result=mode==='login'?await login(form.username,form.password):await register(form);
      if(result.status==='banned')onAccountState?.({status:'banned'});
    }catch(reason){setError(reason.message);}finally{setBusy(false)}
  };
  return <div className="auth-page"><section className="auth-card glass" aria-labelledby="auth-title">
    <div className="auth-brand"><div className="brand-mark">M</div><div><h1 id="auth-title">KALVI CHAT 🤍</h1><span>Private friends chat</span></div></div>
    <div className={`auth-switch ${mode}`} role="tablist" aria-label="Authentication mode"><span className="switch-glass"/>
      <button type="button" role="tab" aria-selected={mode==='login'} onClick={()=>switchMode('login')}>Login</button>
      <button type="button" role="tab" aria-selected={mode==='register'} onClick={()=>switchMode('register')}>Register</button>
    </div>
    <form onSubmit={submit} className={`auth-form auth-${mode}`}>
      {mode==='register'&&<>
        <label>Name<input name="name" value={form.name} onChange={change} autoComplete="name" minLength="2" maxLength="60" required/></label>
        <label>Phone Number<input name="phone" value={form.phone} onChange={change} autoComplete="tel" inputMode="tel" placeholder="+91…" required/></label>
      </>}
      <label>Username<input name="username" value={form.username} onChange={change} autoCapitalize="none" autoCorrect="off" autoComplete="username" pattern="[A-Za-z0-9_]{3,20}" required/></label>
      <label>Password<input name="password" type="password" value={form.password} onChange={change} autoComplete={mode==='login'?'current-password':'new-password'} minLength="8" maxLength="128" required/></label>
      {mode==='register'&&<>
        <label>Confirm Password<input name="confirmPassword" type="password" value={form.confirmPassword} onChange={change} autoComplete="new-password" minLength="8" maxLength="128" required/></label>
        <label>Language<select name="language" value={form.language} onChange={change}><option>Hinglish</option><option>Manglish</option></select></label>
      </>}
      {error&&<p className="form-error" role="alert">{error}</p>}
      <button className="auth-submit" disabled={busy}>{busy?<><span className="spinner"/> Please wait…</>:mode==='login'?'Login':'Submit registration'}</button>
    </form>
  </section></div>
}
