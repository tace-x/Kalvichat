import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChat } from './hooks/useChat';
import { useSession } from './hooks/useSession';
import { useTypingPresence } from './hooks/useTypingPresence';
import { firebaseMode } from './firebase';
import AuthPage from './components/AuthPage';
import AccountState from './components/AccountState';
import Confirm from './components/Confirm';
import { logout } from './services/authService';
import './styles.css';
import './authAdmin.css';
import './polish.css';

const AdminApp=lazy(()=>import('./components/AdminApp'));
const REACTIONS=['👍','❤️','😂','😮','😢','🔥','👏','🎉','😍'];
const timeFmt=new Intl.DateTimeFormat([], {hour:'numeric',minute:'2-digit'});
const dayFmt=new Intl.DateTimeFormat([], {weekday:'long',month:'short',day:'numeric'});
const minuteKey=d=>{const x=new Date(d);return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}-${x.getHours()}-${x.getMinutes()}`};
const initialTheme=()=>{try{return localStorage.getItem('mj-theme')||'light'}catch{return 'light'}};
const persistTheme=(theme)=>{try{localStorage.setItem('mj-theme',theme)}catch{/* Theme remains usable when storage is blocked. */}};

function Icon({name}) { const icons={sun:'☼',moon:'◐',down:'↓',back:'←',send:'➤',more:'•••',reply:'↩'}; return <span aria-hidden="true">{icons[name]}</span> }

const Header=memo(function Header({theme,setTheme,anyoneOnline,onLogout}){
  return <header className="header glass">
    <div className="brand-mark" aria-hidden="true">M</div>
    <div className="title-wrap"><h1>MALLU JAABI</h1><span className="handshake">🤝</span></div>
    <div className="header-actions">{anyoneOnline&&<span className="presence-dot" title="Friends are online" />}
      <button className="icon-button" aria-label={`Switch to ${theme==='light'?'dark':'light'} mode`} onClick={()=>setTheme(theme==='light'?'dark':'light')}><Icon name={theme==='light'?'moon':'sun'}/></button>
      {onLogout&&<button className="icon-button logout-icon" aria-label="Logout" onClick={onLogout}>↪</button>}
    </div>
  </header>
});

function ReplyPreview({reply,compact=false}){
  if(!reply)return null;
  return <div className={`reply-preview ${compact?'reply-compose':''}`}><span className="reply-line"/>
    <div><b>{compact?'Replying to message':'Reply'}</b><p>{reply.deleted?'This message was deleted.':reply.text}</p></div></div>
}
function MentionText({text}){
  const bits=(text||'').split(/(@[\w.]+)/g);
  return bits.map((b,i)=>b[0]==='@'?<mark key={i}>{b}</mark>:b);
}
function Status({message}){
  if(message.status==='queued'||message.status==='sending')return <span className="queued" title="Waiting to send">◷</span>;
  const s=message.status==='read'?'✓✓ Read':message.status==='delivered'?'✓✓ Delivered':'✓ Sent';
  return <span>{s}</span>;
}

const Message= memo(function Message({message,firstInStreak,showTime,onReact,onAction,currentUserId,muted}){
  const own=message.senderId===currentUserId, deleted=Boolean(message.deleted || message.deletedAt);
  const translation=message.detectedLanguage==='manglish'?message.hinglishText:message.manglishText;
  return <article className={`message-row ${own?'own':''} ${firstInStreak?'streak-start':''}`} data-message-id={message.id} data-created-at={new Date(message.createdAt).getTime()}>
    {!own&&<div className="avatar-slot">{firstInStreak&&<img src={message.senderAvatar||message.avatar} alt={`${message.senderName}'s avatar`}/>}</div>}
    <div className="message-stack">
      {showTime&&<time className="minute-time">{timeFmt.format(new Date(message.createdAt))}</time>}
      {firstInStreak&&<span className="sender-name" style={{color:message.senderColor||message.color}}>{own?'You':message.senderName}</span>}
      <div className="bubble-shell">
        <div className={`bubble ${deleted?'deleted':''}`} style={!own?{'--sender':message.senderColor||message.color}:undefined}>
          {message.replyTo&&<ReplyPreview reply={message.replyTo}/>} 
          {deleted?<p className="deleted-copy"><span>⊘</span> {message.deletedByAdmin?'This message was deleted by admin.':'This message was deleted.'}</p>:<>
            <p className="original"><MentionText text={message.originalText}/></p>
            {['pending','processing'].includes(message.translationStatus)&&<p className="translation pending">Translating<span className="dots">…</span></p>}
            {message.translationStatus==='failed'&&<p className="translation unavailable">Translation unavailable</p>}
            {translation&&message.translationStatus==='complete'&&<p className="translation">{translation}</p>}
          </>}
          {!deleted&&<div className="meta">{message.editedAt&&<span>edited</span>}{own&&<Status message={message}/>}</div>}
        </div>
        {!deleted&&!muted&&<button className="message-menu" aria-label="Message actions" onClick={e=>onAction(message,e.currentTarget)}><Icon name="more"/></button>}
      </div>
      {!deleted&&Object.entries(message.reactions||{}).some(([,n])=>n>0)&&<div className="reaction-counts">{Object.entries(message.reactions).filter(([,n])=>n>0).map(([r,n])=><button disabled={muted} className={message.myReaction===r?'mine':''} onClick={()=>onReact(message.id,r)} key={r}>{r} <small>{n}</small></button>)}</div>}
    </div>
    {own&&<div className="avatar-slot">{firstInStreak&&<img src={message.senderAvatar||message.avatar} alt={`${message.senderName}'s avatar`}/>}</div>}
  </article>
});

function ActionPopover({data,onClose,onReply,onReact,onEdit,onDelete,currentUserId,muted}){
  const [picker,setPicker]=useState(false),[now,setNow]=useState(Date.now());
  useEffect(()=>{setPicker(false);setNow(Date.now());if(!data)return undefined;const remaining=new Date(data.message.createdAt).getTime()+600000-Date.now();if(remaining<=0)return undefined;const timer=setTimeout(()=>setNow(Date.now()),remaining+5);return()=>clearTimeout(timer)},[data?.message?.id]);
  if(!data)return null; const m=data.message, own=m.senderId===currentUserId;
  const age=now-new Date(m.createdAt).getTime();
  const editable=own&&age>=0&&age<600000&&!m.deleted&&!m.deletedAt;
  return <><button className="popover-scrim" aria-label="Close actions" onClick={onClose}/><div className="action-popover" style={{top:Math.min(data.rect.bottom+6,innerHeight-210),left:Math.max(12,Math.min(data.rect.left-150,innerWidth-230))}}>
    {picker?<div className="reaction-grid">{REACTIONS.map(r=><button key={r} onClick={()=>{onReact(m.id,r);onClose()}} aria-label={`React ${r}`}>{r}</button>)}</div>:<>
      {!muted&&<button onClick={()=>{onReply(m);onClose()}}><Icon name="reply"/> Reply</button>}
      {!muted&&<button onClick={()=>setPicker(true)}>♡ React</button>}
      {editable&&<button onClick={()=>{onEdit(m);onClose()}}>✎ Edit</button>}
      {editable&&<button className="danger" onClick={()=>{onDelete(m);onClose()}}>⌫ Delete for everyone</button>}
    </>}
  </div></>
}

const History=memo(function History({messages,loadOlder,hasOlder,loadingOlder,onBottom,onNewCount,newCount,onRead,unreadAfter,currentUserId,onReact,onAction,muted}){
  const ref=useRef(), beforeHeight=useRef(0), prevFirst=useRef(), prevLast=useRef(), prevCount=useRef(0), atBottom=useRef(true);
  const observationKey=messages.map((message)=>message.id).join('|');
  const isBottom=()=>{const el=ref.current; return el&&Math.abs(el.scrollHeight-el.scrollTop-el.clientHeight)<=1};
  useEffect(()=>{ const el=ref.current;if(el&&messages.length&&!prevCount.current){el.scrollTop=el.scrollHeight;prevCount.current=messages.length;prevFirst.current=messages[0]?.id}},[messages]);
  useLayoutEffect(()=>{const el=ref.current;if(!el)return; if(prevFirst.current&&messages[0]?.id!==prevFirst.current&&beforeHeight.current){el.scrollTop+=el.scrollHeight-beforeHeight.current;beforeHeight.current=0} prevFirst.current=messages[0]?.id},[messages]);
  useEffect(()=>{
    const root=ref.current;if(!root||!onRead)return undefined;const timers=new Map();
    const observer=new IntersectionObserver((entries)=>entries.forEach((entry)=>{
      const id=entry.target.dataset.messageId;
      if(entry.isIntersecting&&entry.intersectionRatio>=.6&&!timers.has(id)){
        timers.set(id,setTimeout(()=>{onRead(Number(entry.target.dataset.createdAt));timers.delete(id)},500));
      }else if(!entry.isIntersecting||entry.intersectionRatio<.6){clearTimeout(timers.get(id));timers.delete(id)}
    }),{root,threshold:[0,.6,1]});
    root.querySelectorAll('[data-message-id]').forEach((node)=>observer.observe(node));
    return()=>{observer.disconnect();timers.forEach(clearTimeout)};
  },[observationKey,onRead]);
  useEffect(()=>{const el=ref.current;if(!el)return; const last=messages.at(-1)?.id, appended=prevLast.current&&last!==prevLast.current;
    if(appended&&atBottom.current)requestAnimationFrame(()=>{el.scrollTop=el.scrollHeight;onBottom()});
    else if(appended&&!atBottom.current)onNewCount(n=>n+Math.max(1,messages.length-prevCount.current));
    prevLast.current=last; prevCount.current=messages.length
  },[messages,onBottom,onNewCount]);
  const scroll=()=>{const el=ref.current;atBottom.current=isBottom();if(atBottom.current)onBottom();if(el.scrollTop===0&&hasOlder&&!loadingOlder){beforeHeight.current=el.scrollHeight;loadOlder()}};
  const jump=()=>{ref.current.scrollTo({top:ref.current.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});onBottom()};
  let lastDay='';
  const unreadIndex=unreadAfter===null?-1:messages.findIndex((message)=>message.senderId!==currentUserId&&new Date(message.createdAt).getTime()>unreadAfter);
  return <main className="history" ref={ref} onScroll={scroll} aria-live="polite">
    <div className="history-inner">
      {hasOlder&&<button className="load-older" disabled={loadingOlder} onClick={()=>{beforeHeight.current=ref.current.scrollHeight;loadOlder()}}>{loadingOlder?<><span className="spinner"/> Loading older messages</>:'↑ Load older messages'}</button>}
      {messages.map((m,i)=>{const prev=messages[i-1], day=dayFmt.format(new Date(m.createdAt)),showDay=day!==lastDay;lastDay=day;
        const first=!prev||prev.senderId!==m.senderId; const showTime=!prev||minuteKey(prev.createdAt)!==minuteKey(m.createdAt);
        return <div key={m.id}>{showDay&&<div className="date-marker"><span>{day}</span></div>}{i===unreadIndex&&<div className="unread-divider"><span>Unread</span></div>}<Message message={m} firstInStreak={first} showTime={showTime} currentUserId={currentUserId} muted={muted} onReact={onReact} onAction={onAction}/></div>})}
    </div>
    {newCount>0&&<button className="new-messages" onClick={jump}>{newCount>1?`${newCount} new messages`:'New message'} <Icon name="down"/></button>}
  </main>
});

const Composer=memo(function Composer({onSend,reply,onCancelReply,editing,onCancelEdit,onTyping,muted}){
  const [text,setText]=useState(''); const area=useRef();
  useEffect(()=>{if(editing){setText(editing.originalText);area.current?.focus()}},[editing]);
  const submit=()=>{const clean=text.trim();if(!clean)return;onSend(clean);setText('');onTyping?.(false);area.current.style.height='auto'};
  const input=e=>{setText(e.target.value);onTyping?.(Boolean(e.target.value.trim()));e.target.style.height='auto';e.target.style.height=`${Math.min(e.target.scrollHeight,140)}px`};
  return <div className="composer-zone glass">
    {(reply||editing)&&<div className="compose-context"><ReplyPreview compact reply={reply||{text:editing.originalText}}/><button onClick={editing?onCancelEdit:onCancelReply} aria-label="Cancel">×</button></div>}
    <div className="composer"><textarea ref={area} value={text} onChange={input} rows="1" placeholder={muted?'Muted — you can read messages':'Message…'} aria-label="Message" disabled={muted} onKeyDown={()=>{}}/><button className="send" disabled={muted||!text.trim()} onClick={submit} aria-label={editing?'Save edit':'Send message'}><Icon name="send"/></button></div>
    <p className="enter-hint">{muted?'An admin has muted your account':'Return adds a new line'}</p>
  </div>
});

function SessionState({status,error}){
  return <div className="session-state"><div className="brand-mark">M</div><h1>MALLU JAABI</h1>{status==='loading'?<><span className="spinner"/><p>Verifying your session…</p></>:<p>{error||'Authentication is temporarily unavailable.'}</p>}</div>
}

function UserApp(){
  const session=useSession();
  const [theme,setTheme]=useState(initialTheme);
  const chat=useChat(session.user);
  const presence=useTypingPresence(session.user);
  const [reply,setReply]=useState(),[editing,setEditing]=useState(),[confirm,setConfirm]=useState(),[popover,setPopover]=useState(),[newCount,setNewCount]=useState(0),[authMode,setAuthMode]=useState('login'),[accountOverride,setAccountOverride]=useState(null);
  useEffect(()=>{document.documentElement.dataset.theme=theme;persistTheme(theme);const meta=document.querySelector('meta[name=theme-color]');if(meta)meta.content=theme==='light'?'#f5f2eb':'#111816'},[theme]);
  const askLogout=useCallback(()=>setConfirm({title:'Logout?',body:'You will need to enter your username and password to return.',label:'Logout',run:async()=>{await logout();setAccountOverride(null);setAuthMode('login')}}),[]);
  const registerAgain=useCallback(async()=>{await logout();setAccountOverride(null);setAuthMode('register')},[]);
  const send=useCallback((text)=>{if(editing){setConfirm({title:'Save this edit?',body:'The translation will be regenerated. The original 10-minute timer will not change.',label:'Save edit',run:()=>{if(Date.now()-new Date(editing.createdAt).getTime()<600000)chat.edit(editing.id,text);setEditing();}})}else{chat.send(text,reply&&{id:reply.id,text:reply.originalText,deleted:Boolean(reply.deleted||reply.deletedAt)});setReply()}},[editing,reply,chat.edit,chat.send]);
  const askDelete=useCallback((message)=>setConfirm({title:'Delete for everyone?',body:'This message will be replaced for everyone. This action cannot be undone.',label:'Delete message',run:()=>{if(Date.now()-new Date(message.createdAt).getTime()<600000)chat.remove(message.id)}}),[chat.remove]);
  const showMessageActions=useCallback((message,element)=>setPopover({message,rect:element.getBoundingClientRect()}),[]);
  const cancelReply=useCallback(()=>setReply(),[]),cancelEdit=useCallback(()=>setEditing(),[]),closePopover=useCallback(()=>setPopover(),[]),closeConfirm=useCallback(()=>setConfirm(),[]);
  const bottom=useCallback(()=>setNewCount(0),[]);
  const acceptConfirm=useCallback(()=>{confirm?.run();setConfirm()},[confirm]);
  const accountStatus=accountOverride?.status||session.status;
  if(['loading','error','blocked'].includes(session.status))return <div className="app-shell"><SessionState status={session.status} error={session.error}/></div>;
  if(accountStatus==='signed-out')return <AuthPage key={authMode} initialMode={authMode} onAccountState={setAccountOverride}/>;
  if(['pending','rejected','banned'].includes(accountStatus))return <><AccountState status={accountStatus} account={session.account||accountOverride} onLogout={askLogout} onRegisterAgain={registerAgain}/>{confirm&&<Confirm title={confirm.title} body={confirm.body} confirmLabel={confirm.label} onClose={closeConfirm} onConfirm={acceptConfirm}/>}</>;
  return <div className="app-shell"><div className="chat-app"><Header theme={theme} setTheme={setTheme} anyoneOnline={firebaseMode==='demo'||presence.anyoneOnline} onLogout={firebaseMode==='demo'?null:askLogout}/>
    {chat.error&&<div className="connection-toast" role="status">{chat.error}</div>}
    <History {...chat} muted={session.user.muted} currentUserId={session.user.id} onRead={chat.markRead} onReact={chat.react} onAction={showMessageActions} onNewCount={setNewCount} newCount={newCount} onBottom={bottom}/>
    <div className={`typing ${presence.typingText?'':'typing-empty'}`} aria-live="polite">{presence.typingText&&<><span/><span/><span/> {presence.typingText}</>}</div>
    <Composer muted={session.user.muted} onSend={send} onTyping={presence.signalTyping} reply={reply} onCancelReply={cancelReply} editing={editing} onCancelEdit={cancelEdit}/>
    <ActionPopover muted={session.user.muted} data={popover} currentUserId={session.user.id} onClose={closePopover} onReply={setReply} onReact={chat.react} onEdit={setEditing} onDelete={askDelete}/>
    {confirm&&<Confirm title={confirm.title} body={confirm.body} confirmLabel={confirm.label} onClose={closeConfirm} onConfirm={acceptConfirm}/>}
  </div></div>
}

export default function App(){return window.location.pathname.startsWith('/admin')?<Suspense fallback={<div className="admin-boot"><span className="spinner"/><p>Loading admin panel…</p></div>}><AdminApp/></Suspense>:<UserApp/>}
