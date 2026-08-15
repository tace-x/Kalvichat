export default function AccountState({status,account,onLogout,onRegisterAgain}){
  const pending=status==='pending',rejected=status==='rejected',banned=status==='banned';
  return <div className="auth-page"><section className="state-card glass">
    <div className={`state-icon ${status}`}>{pending?'◷':rejected?'×':'!'}</div>
    <h1>{pending?'Registration submitted':rejected?'Registration not approved':'Account Banned'}</h1>
    {pending&&<><p>Your account is waiting for verification.</p><div className="status-box"><small>Status</small><strong>Pending Verification</strong></div></>}
    {rejected&&<><p>Your registration was not approved.</p>{account?.rejectionReason&&<div className="reason-box"><small>Reason</small><p>{account.rejectionReason}</p></div>}</>}
    {banned&&<p>This account cannot access KALVI CHAT 🤍. Contact the administrator if you believe this is a mistake.</p>}
    <div className="state-actions">{rejected&&<button className="auth-submit" onClick={onRegisterAgain}>Register Again</button>}<button className="secondary-state" onClick={onLogout}>Logout</button></div>
  </section></div>
}
