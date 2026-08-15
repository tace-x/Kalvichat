# MALLU JAABI — Full Project Report

**Report scope:** all application, server, security, deployment, and asset files currently in the repository.  
**Current code status:** production build passes locally; Firestore Rules compile in the emulator; no real Firebase or Vercel project is connected in this workspace.

---

## 1. Executive summary

MALLU JAABI is a private, approval-only group chat with:

- Username/password registration and login backed by Firebase Authentication
- Pending, approved, rejected, banned, and muted account handling
- A separate cookie-authenticated admin panel
- Firestore-backed realtime chat with 20-message pagination
- Hinglish/Manglish translation through server-only AI providers
- Reactions, replies, mentions, editing, deletion, read receipts, typing, and presence
- Admin message deletion and generation-based Clear Chat
- Responsive Liquid Glass UI with mobile, dark mode, accessibility, and reduced-motion support
- Vercel server functions for all privileged and secret-bearing operations

The repository is **code-complete for deployment**, but it is **not yet a live production installation**. Firebase/Vercel credentials, deployment, real multi-user testing, and actual mobile-browser validation must be completed manually.

---

## 2. Implemented features

### 2.1 User authentication

- Single Login/Register screen with a glass-morphing switch
- Login fields: Username and Password
- Registration fields: Name, Phone Number, Username, Password, Confirm Password, Language
- Hinglish/Manglish language selection
- No visible email field
- Internal Firebase email identity remains an implementation detail in the UI
- Server resolves username to Firebase Authentication identity
- Password verification uses Firebase Authentication's Identity Toolkit endpoint—not Firebase Admin password verification
- Firebase custom token establishes the browser session after successful server verification
- Browser-session persistence; permanent login persistence is not used
- Passwords are never written to Firestore
- Generic valid-username login failure message to reduce account enumeration

### 2.2 Registration and identity reservations

- Every application starts as `pending`
- Server-side username normalization and validation
- Server-side phone normalization and validation
- Atomic Firestore username reservation
- Hashed phone reservation document ID
- Simultaneous duplicate username/phone registrations are transactionally prevented
- Rejected applications release username and phone reservations
- Pending, approved, and banned accounts retain reservations
- Firebase Auth/Firestore failure rollback is implemented where practical
- Immutable random illustrated avatar assignment
- Permanent system color assignment using least-used curated color families
- Registration history is retained

### 2.3 Account states

- `pending`: pending screen; no chat listeners
- `approved`: chat access
- `rejected`: rejection screen and optional reason; Register Again action
- `banned`: banned screen; no chat access
- `approved + muted`: read-only chat
- Account state is enforced by Firestore Rules, not only React routing
- Existing sessions react to member state changes in realtime
- Ban revokes Firebase refresh tokens

### 2.4 Chat

- Initial newest-20 realtime query
- Older messages loaded in 20-message pages
- Every query is restricted to the current chat generation
- Exact-bottom autoscroll behavior
- New Messages indicator away from the bottom
- Scroll-position preservation during history insertion
- Optimistic local sending
- Firestore offline queue support
- Deterministic message IDs to reduce duplicate sends
- Queued old-generation messages rebase safely after reconnect
- Sender streak grouping
- Illustrated avatars and permanent sender colors
- First-message-per-minute timestamps
- Multiline composer; Enter/Return creates a newline
- Original text always appears above translation
- Reply previews
- Mentions
- Reactions: 👍 ❤️ 😂 😮 😢 🔥 👏 🎉 😍
- One reaction per user/message
- Ten-minute edit/delete enforcement in both UI and Firestore Rules
- User and admin tombstones
- Unread divider
- Sent, Delivered, and Read states visible only to the sender
- Approximately 500 ms visibility requirement for read marking
- Muted users still count toward read receipts
- Banned/blocked users are excluded through the eligible-member state

### 2.5 Typing and presence

- Throttled typing writes, not one write per keypress
- Typing expiration
- Group typing text for one, two, or multiple users
- Coarse presence heartbeat rather than polling
- Adaptive UI expiration timer:
  - Fast only while typing exists
  - Slow while only presence exists
  - Off when neither exists
- Muted and banned users cannot update presence/typing
- Admin mute/ban clears active presence and typing state

### 2.6 Translation

- Server-only `/api/translate`
- Approved, non-muted authenticated member required
- Message ID only; arbitrary text/provider URLs are not accepted
- Active-generation validation
- Deleted-message rejection
- 8,000-character server limit
- Pure English bypasses providers
- Curated Hinglish/Manglish language markers
- Exact trusted translation memory
- Curated high-confidence phrase memory
- Configurable Gemini, Groq, and NVIDIA providers
- Works with any one configured provider
- Missing provider keys are skipped
- Configurable model names
- Eight-second provider timeout
- Provider health cooldown
- Provider fallback
- JSON/output validation
- Emoji-preservation validation
- Thirty-second translation lease prevents duplicate concurrent calls
- Abandoned leases expire and can be retried
- Final transactional check prevents translation from restoring admin-deleted or cleared messages
- Provider failure leaves the original message visible

### 2.7 Admin panel

- Separate `/admin` route
- Admin is not a Firebase chat member
- Server-only admin username/password/session secret
- Signed HTTP-only admin cookie
- `SameSite=Strict`
- `Secure` in Vercel environments
- Eight-hour expiration
- Same-origin checks on mutations
- In-memory login throttling without paid Redis
- Desktop collapsible sidebar
- Mobile slide-out navigation
- Dashboard aggregation counts
- Pending, Approved, Rejected, and Banned sections
- Twenty-record cursor pagination
- Approve/reject
- Optional rejection reason
- Mute/unmute
- Ban/unban
- Active-generation message moderation view
- Admin message tombstones
- Reaction cleanup and reply-preview sanitation
- Clear Chat with typed `CLEAR` confirmation
- Minimal moderation audit records

### 2.8 Clear Chat generations

- Server-controlled `system/chatState.activeGeneration`
- Every new message receives the active generation
- Clear Chat atomically increments generation
- No full-history download
- No historical message rewrites
- No mass deletion
- Connected clients receive the generation change through one lightweight document listener
- Old client state is invalidated immediately
- Admin moderation view follows the active generation
- Historical data remains stored but inaccessible to normal active-generation queries

### 2.9 UI, responsiveness, and accessibility

- Light and dark themes
- Mobile, tablet, laptop, and desktop layouts
- 320 px viewport refinements
- `100dvh` mobile layout handling
- Safe-area composer padding
- iOS momentum scrolling
- Mobile input sizing that prevents focus zoom
- Focus-visible states
- Escape-to-close confirmations
- Focus restoration after dialogs
- Desktop centered modal and mobile bottom sheet
- Touch-action optimization
- High-contrast preference support
- Full reduced-motion fallbacks
- Transform/opacity-only decorative animations
- Reduced blur cost on mobile
- Memoized chat header, history, composer, and message rows
- Lazy-loaded admin JavaScript chunk

---

## 3. Security model

### Browser users cannot directly

- Approve or reject registrations
- Ban or unban users
- Mute or unmute users
- Assign roles
- Modify avatar/color/account state
- Reserve usernames/phone numbers
- Write moderation audit records
- Modify `system/chatState`
- Choose a different message generation
- Create `deletedByAdmin` messages
- Delete another user's message
- Read historical generations
- React to deleted/historical messages
- Call translation without an approved, non-muted Firebase session

### Server-only secrets

- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`
- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `NVIDIA_API_KEY`

A production client-bundle scan was run and these secret identifiers/data were not found in generated client assets.

---

## 4. Firestore collections and documents

| Path | Purpose | Browser write access |
|---|---|---|
| `members/{uid}` | Private account, phone, moderation state | None |
| `chatMembers/{uid}` | Safe chat-facing profile | None |
| `registrations/{id}` | Application and decision history | None |
| `usernameReservations/{username}` | Atomic username ownership | None |
| `phoneReservations/{hash}` | Atomic phone ownership | None |
| `moderationAudit/{id}` | Minimal admin action audit | None |
| `system/assignments` | Color usage counters | None |
| `system/chatMeta` | Eligible member IDs for aggregate reads | Read-only to active members |
| `system/chatState` | Active generation and recent delete mask | Read-only to active members |
| `chatMessages/{id}` | Current and historical messages | Limited user create/own update |
| `chatReactions/{messageId_uid}` | One reaction per user/message | Own active reaction only |
| `chatReadState/{uid}` | Delivery/read watermarks | Own state only |
| `typing/{uid}` | Expiring typing state | Own active non-muted state |
| `presence/{uid}` | Coarse online heartbeat | Own active non-muted state |
| `translationMemory/{hash}` | Trusted server-side exact memory | None |

---

## 5. Known drawbacks and limitations

### High priority before launch

1. **No real Firebase project is connected in this workspace.** Real Authentication, Firestore, deployed Rules, deployed indexes, and multi-account behavior have not been tested against your production project.
2. **No Vercel deployment exists here.** Production cookies, functions, domains, and environment variables still require validation on the deployed HTTPS URL.
3. **No automated unit/integration test suite is committed.** Rules compile, APIs import, and builds pass, but regression tests are not part of `npm test`.
4. **Existing legacy messages require a `generation` field.** If you already have production message documents created before generation support, they will not match generation queries. Migrate them to generation `1` before deploying this version, or intentionally clear into a new generation.

### Architecture trade-offs

5. **In-memory API throttling is instance-local.** It is free and avoids Firestore writes, but resets when a Vercel function instance restarts and is not a globally strict distributed rate limiter.
6. **Single shared admin credential.** The current design supports one logical admin session identity (`primary-admin`), not multiple named admins or MFA.
7. **Admin password is an environment secret, not a hash.** This is acceptable inside encrypted Vercel environment variables, but a pre-hashed password would reduce exposure if environment values were leaked.
8. **No Firebase App Check enforcement.** Authentication and Rules protect data, but public registration endpoints can still receive automated traffic within platform limits.
9. **Translation detection is heuristic.** The included Hinglish/Manglish marker sets cover common speech and supplied examples, but unusual spelling, slang, or code-switching can still be misclassified.
10. **Translation memory is primarily exact-match.** It deliberately avoids aggressively learning uncertain similarity patterns, which is safer but may use more provider calls.
11. **AI free tiers are not guaranteed.** Provider/model availability, quotas, names, and pricing can change. Models are configurable, but you must monitor provider policy.
12. **Historical generations still consume Firestore storage.** Clear Chat hides them at constant write cost; it intentionally does not physically erase history.
13. **Previously downloaded content cannot be cryptographically revoked from a user's device.** Admin deletion removes server content and masks active client state, but any data a user already saw or copied cannot be made unknown again.
14. **No full DOM virtualization.** Messages load progressively, but a user who manually loads hundreds of pages can eventually create many DOM nodes.
15. **Firebase client bundle is relatively large.** The production bundle is roughly 254 KB gzip because Firebase Authentication and Firestore are substantial dependencies. Vite reports a non-blocking chunk-size advisory.
16. **`system/chatMeta` stores eligible IDs in one document.** This is efficient for a small private group but is not intended for tens of thousands of users.
17. **Read, typing, and presence state listeners cover their small group collections.** This is reasonable for a private friend group but would need a different architecture for a large public community.
18. **Reaction/reply cleanup is best-effort after the atomic tombstone.** Security Rules and UI masking prevent display even if cleanup encounters a temporary server error, but orphan reaction documents may remain until manually cleaned.
19. **No push notifications, email, SMS, media, attachments, or password reset UI.** These are intentionally excluded, not implementation bugs.
20. **No telemetry/monitoring dashboard.** This preserves the ₹0 architecture but means operational failures must be inspected through Firebase/Vercel logs.

---

## 6. Manual work you must complete

### 6.1 Firebase project

1. Create/select the real Firebase project.
2. Register a Firebase Web App.
3. Enable **Authentication → Email/Password**.
4. Create Firestore on the Spark/free plan.
5. Create a least-privilege service account for the server functions.
6. Serialize the service-account JSON onto one line for Vercel.
7. Bind Firebase CLI to the correct project:

   ```bash
   firebase login
   firebase use --add
   ```

8. Deploy Rules and indexes:

   ```bash
   firebase deploy --only firestore:rules,firestore:indexes
   ```

9. Add the actual production Vercel domain to Firebase Authentication → Authorized domains.
10. Do not enable Firebase Storage, SMS, paid Identity Platform features, or billing-dependent services unless you intentionally change the cost plan.

### 6.2 Legacy-data check

If any real `chatMessages` already exist, inspect them for `generation`.

- No existing messages: no action required.
- Existing messages without generation: assign them generation `1` once using a trusted migration script, then initialize:

  ```text
  system/chatState.activeGeneration = 1
  ```

Do not run an unreviewed migration against production.

### 6.3 Vercel

1. Push the repository to GitHub.
2. Import the GitHub repository into Vercel.
3. Use Node.js 20 or newer.
4. Configure public variables:

   ```dotenv
   VITE_FIREBASE_API_KEY=
   VITE_FIREBASE_AUTH_DOMAIN=
   VITE_FIREBASE_PROJECT_ID=
   VITE_FIREBASE_STORAGE_BUCKET=
   VITE_FIREBASE_MESSAGING_SENDER_ID=
   VITE_FIREBASE_APP_ID=
   ```

5. Configure server-only variables:

   ```dotenv
   FIREBASE_SERVICE_ACCOUNT_JSON=
   ADMIN_USERNAME=
   ADMIN_PASSWORD=
   ADMIN_SESSION_SECRET=
   ```

6. Generate `ADMIN_SESSION_SECRET` with at least 32 cryptographically random characters.
7. Add optional translation keys only for providers you intend to use:

   ```dotenv
   GEMINI_API_KEY=
   GROQ_API_KEY=
   NVIDIA_API_KEY=
   ```

8. Optionally override model names if configured defaults become unavailable.
9. Deploy and verify Secure/HTTP-only admin cookies on HTTPS.
10. Verify direct navigation to `/`, `/admin`, and `/admin/`.

### 6.4 Real smoke tests

Use at least two normal browser sessions plus one separate admin session.

- Register two users
- Verify both start pending
- Approve one and reject/re-register the other
- Test username and phone race/duplicate handling
- Confirm no Firestore document contains a password
- Test approved/pending/rejected/banned/muted login states
- Send more than 40 messages
- Verify newest-20 loading and two older pages
- Verify exact-bottom and away-from-bottom behavior
- Test offline queue and reconnect ordering
- Test replies, mentions, reactions, edit/delete, and ten-minute expiration
- Test English, Hinglish, Manglish, and mixed-language translations
- Verify provider-memory hits in server logs
- Verify Sent/Delivered/Read with approved, muted, and banned members
- Test admin message deletion, reply sanitation, reaction removal, and audit
- Test Clear Chat generation change without historical reads
- Test ban from another active browser session
- Test unban identity preservation
- Test mute/unmute read-only behavior
- Attempt every privileged API from a normal user browser
- Test on actual iOS Safari and Android Chrome
- Test light/dark mode, keyboard resizing, reduced motion, and 320 px width

### 6.5 Operational maintenance

- Monitor Firebase quota dashboards
- Monitor Vercel function errors and execution duration
- Monitor AI-provider quota/model deprecations
- Rotate service-account/admin/provider secrets periodically
- Review `moderationAudit` access and retention
- Periodically inspect for orphaned reactions from interrupted cleanup
- Back up Firestore before migrations or destructive maintenance

---

## 7. Environment-variable reference

### Public browser values

| Variable | Required | Notes |
|---|---:|---|
| `VITE_FIREBASE_API_KEY` | Yes | Firebase web config; not a server secret |
| `VITE_FIREBASE_AUTH_DOMAIN` | Yes | Firebase Auth domain |
| `VITE_FIREBASE_PROJECT_ID` | Yes | Firestore project |
| `VITE_FIREBASE_STORAGE_BUCKET` | Config field | Storage is not used by this app |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Config field | Messaging is not implemented |
| `VITE_FIREBASE_APP_ID` | Yes | Firebase web app ID |

### Server-only values

| Variable | Required | Notes |
|---|---:|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Yes | Never expose through `VITE_` |
| `ADMIN_USERNAME` | Yes | Server-only admin credential |
| `ADMIN_PASSWORD` | Yes | Store only in Vercel encrypted environment settings |
| `ADMIN_SESSION_SECRET` | Yes | At least 32 random characters |
| `GEMINI_API_KEY` | Optional | Skipped when absent |
| `GROQ_API_KEY` | Optional | Skipped when absent |
| `NVIDIA_API_KEY` | Optional | Skipped when absent |
| `GEMINI_MODEL` | Optional | Configurable model override |
| `GROQ_MODEL` | Optional | Configurable model override |
| `NVIDIA_MODEL` | Optional | Configurable model override |

---

## 8. File-by-file report

### Root files

| File | Purpose | Notes / manual responsibility |
|---|---|---|
| `index.html` | Vite HTML entry and React mount | Correct root entry; theme metadata included |
| `package.json` | Scripts and dependencies | Node 20+ required; no test/lint script currently |
| `package-lock.json` | Reproducible dependency versions | Commit this file |
| `vite.config.js` | Vite/React configuration | Development host enabled; Vercel uses production build |
| `vercel.json` | Vite output, API functions, `/admin` rewrites | Vercel project/env setup remains manual |
| `firebase.json` | Rules/index deployment mapping | Bind to the real Firebase project manually |
| `firestore.rules` | Browser authorization policy | Compiles in emulator; deploy manually |
| `firestore.indexes.json` | Generation/admin/presence indexes | Deploy manually; wait for index build completion |
| `.env.example` | Public/server variable template | Copy to `.env.local`; never add real values to Git |
| `.gitignore` | Excludes dependencies, builds, secrets, local tools | `.config/` was added to prevent Firebase CLI local metadata commits |
| `README.md` | Setup, architecture, deployment, security | Follow before production deployment |
| `FULL_PROJECT_REPORT.md` | This complete report | Keep as handover/reference documentation |

### Client bootstrap and Firebase

| File | Purpose | Notes |
|---|---|---|
| `src/main.jsx` | Mounts React with Strict Mode | Minimal and correct |
| `src/firebase.js` | Firebase app/auth/Firestore initialization | Session persistence and multi-tab cache; partial config shows error rather than demo fallback |
| `src/App.jsx` | Route selection and chat composition | Chat/admin routing without React Router; admin code lazy-loaded |

### Client components

| File | Purpose | Notes |
|---|---|---|
| `src/components/AuthPage.jsx` | Combined login/register UI | Password exists only in transient component state/request |
| `src/components/AccountState.jsx` | Pending/rejected/banned screens | Rejected reason shown only when present |
| `src/components/AdminApp.jsx` | Admin login/dashboard/moderation UI | Lists are cursor-paginated; actions use server APIs |
| `src/components/Confirm.jsx` | Shared confirmation UI | Focus restoration, Escape support, mobile bottom sheet through CSS |

### Client hooks

| File | Purpose | Notes |
|---|---|---|
| `src/hooks/useSession.js` | Firebase session and member-state gate | Chat user is created only after approved state is verified |
| `src/hooks/useChat.js` | Chat state, generation, pagination, sending, actions | Largest client module; preserve tests around generation/offline behavior |
| `src/hooks/useTypingPresence.js` | Presence and typing listeners/writes | Adaptive timers and muted-user enforcement |

### Client services

| File | Purpose | Notes |
|---|---|---|
| `src/services/authService.js` | Browser calls to auth/admin APIs | Uses same-origin requests; no server secret included |
| `src/services/chatService.js` | Firestore queries/listeners/writes | Newest-20 and generation filters are critical; do not remove them |

### Styling

| File | Purpose | Notes |
|---|---|---|
| `src/styles.css` | Core chat layout and visual system | Minified formatting makes manual editing harder |
| `src/authAdmin.css` | Authentication/admin visual system | Minified formatting makes manual editing harder |
| `src/polish.css` | Final motion, mobile, interaction, and performance polish | Loaded last as an override layer; reduced-motion included |

### Server APIs

| File | Purpose | Security boundary |
|---|---|---|
| `api/auth-register.js` | Atomic registration and Firebase Auth creation | Public endpoint with validation and lightweight throttling |
| `api/auth-login.js` | Username/password verification and custom token | Uses Firebase Identity Toolkit for legitimate password verification |
| `api/admin-login.js` | Admin credential verification | Server env only; sets signed cookie |
| `api/admin-session.js` | Admin cookie check | Rejects invalid/expired sessions |
| `api/admin-logout.js` | Clears admin cookie | Same-origin endpoint |
| `api/admin-data.js` | Counts and 20-record admin pages | Requires valid admin session |
| `api/admin-action.js` | Approve/reject/mute/ban/delete/clear | Requires signed admin session and same-origin mutation |
| `api/translate.js` | Translation orchestration | Requires approved non-muted Firebase user and active message |

### Server helpers

| File | Purpose | Notes |
|---|---|---|
| `server/firebaseAdmin.js` | Firebase Admin initialization/token checks | Service account remains server-only |
| `server/adminSession.js` | HMAC admin session and cookie helpers | Single logical admin; eight-hour expiration |
| `server/translationProviders.js` | Provider abstraction/router | Hardcoded trusted provider endpoints; configurable models |
| `server/validators.js` | Username/phone/registration validation and palettes | Phone reservation uses SHA-256 hash |

### Assets

| File/path | Purpose | Notes |
|---|---|---|
| `public/avatars/*.svg` | Stable production avatar URLs | Used by stored profile paths |
| `src/assets/avatars/*.svg` | Bundled demo avatar imports | Duplicates public assets intentionally for demo bundling |
| `public/.gitkeep` | Keeps public directory in Git | Harmless |

---

## 9. Current verification results

| Verification | Result |
|---|---|
| Clean dependency install | Pass |
| Vite production build | Pass |
| Server API module imports | Pass |
| Client secret scan | Pass |
| Firestore Rules compilation | Pass |
| `/` production preview | Pass |
| `/admin` production preview | Pass |
| `/admin/` production preview | Pass |
| Real Firebase Authentication | Not run—credentials unavailable |
| Real Firestore deployment | Not run—project unavailable |
| Real Vercel deployment | Not run—account/project unavailable |
| Two-user production chat | Not run—deployment unavailable |
| Actual mobile browser | Not run—production URL unavailable |

The Vite build reports a non-blocking large-chunk advisory caused mainly by Firebase client libraries.

---

## 10. Recommended release decision

**Code readiness:** Ready for staging deployment.  
**Production readiness:** Conditional on completing the manual Firebase/Vercel setup, any legacy generation migration, and the real smoke-test matrix above.

Do not invite real users until the following are confirmed on the deployed HTTPS site:

1. Rules and indexes are deployed to the correct Firebase project.
2. Real registration/approval/login works.
3. Two-user realtime chat and offline recovery work.
4. Ban/mute enforcement works from an already-open browser.
5. Admin delete and Clear Chat work with audit records.
6. No password exists in Firestore.
7. Mobile keyboard, scrolling, and confirmations work on actual devices.
8. Firebase/Vercel/AI quotas remain within the intended free tiers.
