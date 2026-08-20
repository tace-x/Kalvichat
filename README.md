# KALVI CHAT 🤍

Private friends-only chat built with React, Vite, Firebase Authentication, Firestore, and Vercel server functions. It includes the production chat, username/password registration and login, approval states, and a separate server-authorized moderator panel at `/admin`.

No email address is shown to users. The server creates an internal Firebase Authentication identity and resolves usernames without exposing that implementation in the UI. Passwords are sent only to the authentication endpoint/Firebase Authentication and are never written to Firestore.

## Requirements

- Node.js 20+
- Firebase project on the Spark/free plan
- Vercel Hobby/personal deployment
- Optional translation-provider free-tier key(s)

No Firebase Storage, SMS, paid authentication, paid analytics, or paid database is required.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Use `vercel dev` instead of plain Vite when locally testing endpoints under `/api`.

If no public Firebase variables exist, `/` retains the chat UI's explicit local demo mode. Complete Firebase configuration activates real authentication. Partial Firebase configuration displays a configuration error and never silently activates demo mode.

## Public client variables

```dotenv
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

The Storage Bucket value is part of Firebase's standard web-app configuration; this project does not use Firebase Storage.

## Server-only variables

Configure these only in Vercel. Never prefix them with `VITE_`.

```dotenv
FIREBASE_SERVICE_ACCOUNT_JSON=
# Optional; server falls back to VITE_FIREBASE_STORAGE_BUCKET
FIREBASE_STORAGE_BUCKET=
ADMIN_USERNAME=
ADMIN_PASSWORD=
ADMIN_SESSION_SECRET=
```

`ADMIN_SESSION_SECRET` must be at least 32 cryptographically random characters. The admin password and session secret never enter the browser bundle.

Optional translation providers:

```dotenv
OPENROUTER_API_KEY=
GEMMA_MODEL=google/gemma-4-31b-it:free
GEMINI_API_KEY=
GROQ_API_KEY=
NVIDIA_API_KEY=
TRANSLATION_PROVIDER_TIMEOUT_MS=10000
TRANSLATION_PROVIDER_BUDGET_MS=18000
TRANSLATION_DATASET_MAX_BYTES=2097152
TRANSLATION_DATASET_MAX_ENTRIES=1000
TRANSLATION_DATASET_MAX_LOOKUP_KEYS=5000
GEMINI_MODEL=gemini-3.5-flash
GROQ_MODEL=llama-3.3-70b-versatile
NVIDIA_MODEL=meta/llama-3.3-70b-instruct
```

Run `node scripts/test-gemma.mjs` or `node scripts/test-gemini.mjs` in a server-only environment without printing API keys. Gemma uses OpenRouter at `https://openrouter.ai/api/v1/chat/completions`; `GEMMA_MODEL` defaults to `google/gemma-4-31b-it:free`.

## Firebase setup

1. Create a Firebase project and web app.
2. Enable **Authentication → Email/Password**. Users still see only Username and Password; the server manages the internal identity.
3. Create a Firestore database.
4. Create a service account with only the required Authentication and Firestore privileges. Serialize its JSON onto one line for `FIREBASE_SERVICE_ACCOUNT_JSON`.
5. Install the Firebase CLI, select the project, and deploy rules/indexes:

   ```bash
   firebase login
   firebase use YOUR_PROJECT_ID
   firebase deploy --only firestore:rules,firestore:indexes
   ```

6. Add local and production domains to Firebase Authentication → Authorized domains.

Do not manually create normal user documents. The registration endpoint atomically reserves normalized usernames/phones, assigns immutable avatars/colors, creates the Firebase Auth identity, and creates the pending member/application records.

## Authentication flow

- `Register` validates and normalizes username/phone server-side.
- A Firestore transaction atomically reserves both identifiers, preventing simultaneous duplicate registrations.
- Firebase Authentication securely stores the password.
- Every application starts as `pending`.
- The authenticated user sees Pending Verification until an admin acts.
- Approval creates the safe `chatMembers/{uid}` profile and immediately enables chat.
- Rejection retains history but releases username/phone reservations for another attempt.
- Banning retains account identity and reservations while Firestore rules immediately deny chat.
- Muting leaves read access enabled but blocks messages, replies, reactions, and typing both in UI and Firestore rules.
- Authentication persistence is browser-session-only.

## Admin panel

Open `/admin`. The route is not the security boundary: every admin endpoint requires a signed, HTTP-only, Secure, SameSite session cookie generated from server-only credentials.

Sections:

- Dashboard counts
- Pending registrations
- Approved users
- Rejected history
- Banned users

All approve/reject/mute/unmute/ban/unban, message-delete, and clear-chat operations run in trusted server functions, use confirmation UI, and write minimal `moderationAudit` records. Message deletion creates an irreversible admin tombstone and removes associated reaction/reply-preview data. Clear Chat atomically increments `system/chatState.activeGeneration`; it never downloads, rewrites, or deletes historical generations. Admin credentials and passwords are never returned by APIs or stored in Firestore.

## Firestore collections

- `members/{uid}` — private account, phone, state, immutable assignment
- `chatMembers/{uid}` — safe chat-facing profile only
- `registrations/{registrationId}` — application/history record
- `usernameReservations/{normalizedUsername}` — atomic username ownership
- `phoneReservations/{sha256(normalizedPhone)}` — atomic phone ownership without phone numbers in paths
- `moderationAudit/{id}` — action, target user, timestamp
- `system/assignments` — compact color-use counters
- `system/chatMeta` — compact eligible-member ID set used for aggregate read receipts
- `system/chatState` — server-controlled active chat generation and bounded recent deletion IDs
- `chatMessages/{messageId}` — chat messages, each assigned to one immutable generation
- `chatReactions/{messageId_uid}` — one reaction per user/message
- `chatReadState/{uid}` — read/delivery watermarks
- `typing/{uid}` and `presence/{uid}` — throttled ephemeral state
- `translationMemory/{hash}` — trusted server-only memory

Admin list pages perform status-filtered, 20-record paginated queries. Dashboard uses aggregation counts instead of downloading whole collections. Chat retains newest-20 realtime listening and 20-message backward pagination.

## Build and deploy

```bash
npm install
npm run build
npm run preview
```

Then:

1. Push to GitHub without `.env.local`, `node_modules`, or `dist`.
2. Import the repository into Vercel.
3. Add public Firebase variables and server-only secrets to Vercel.
4. Deploy. `vercel.json` configures Vite output, functions, and `/admin` SPA routing.
5. Deploy Firestore rules/indexes and verify the production domain is authorized in Firebase.
6. Test with two user registrations and a separate admin browser session.

## Security notes

- Normal clients cannot approve, reject, ban, mute, assign roles, reserve identifiers, or write profile state.
- Admin SDK bypasses Firestore rules, so every privileged endpoint verifies the admin cookie independently.
- Banned/pending/rejected users never initialize chat, typing, presence, read, or message listeners.
- Firestore rules enforce approved state and mute restrictions even if browser UI is altered.
- Important admin actions are audited with minimal, non-duplicated data.
- In-memory endpoint throttles provide basic abuse resistance at ₹0 cost. For public/high-risk deployment, enable Firebase App Check or platform rate controls without moving secrets into the client.
